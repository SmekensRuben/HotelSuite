// Privileged release preflight and credential relocation. No claims or access are granted.
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import { getSecurityRules } from "firebase-admin/security-rules";
import { Firestore } from "@google-cloud/firestore";
import { OAuth2Client } from "google-auth-library";
import { publishReviewedRules, verifyPublishedRules } from "./saas-rules-release.mjs";

const args = process.argv.slice(2);
const mode = args[0];
if (!["preflight", "pause", "deploy-rules", "migrate", "enable"].includes(mode) || args.some((v, i) => i > 0 && !["--emulator", "--rules-verified"].includes(v))) throw new Error("Use a supported mode with explicit rollout options.");
const emulator = args.includes("--emulator");
const projectId = emulator ? "demo-hotel-suite-a00" : "hotel-toolkit";
if (emulator && (!/^(127\.0\.0\.1|localhost):8080$/.test(process.env.FIRESTORE_EMULATOR_HOST || "")
  || !/^(127\.0\.0\.1|localhost):9099$/.test(process.env.FIREBASE_AUTH_EMULATOR_HOST || ""))) throw new Error("Local Firestore and Auth emulator hosts are required.");
if (!emulator && (process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_AUTH_EMULATOR_HOST)) throw new Error("Remove emulator configuration before a production preflight.");
if (["migrate", "enable"].includes(mode) && !args.includes("--rules-verified")) throw new Error("Deploy and verify the reviewed Rules before migration or activation.");
let operator = "emulator-operator";
let credential;
let oauth;
if (!emulator) {
  const number = execFileSync("gcloud", ["projects", "describe", projectId, "--format=value(projectNumber)"], { encoding: "utf8" }).trim();
  if (number !== "358734544002") throw new Error("Project number mismatch. No mutation was made.");
  operator = execFileSync("gcloud", ["auth", "list", "--filter=status:ACTIVE", "--format=value(account)"], { encoding: "utf8" }).trim();
  if (operator !== "bestsmekens@gmail.com") throw new Error("Use the reviewed release operator bestsmekens@gmail.com.");
  // Short-lived gcloud OAuth is used in memory; no key or token is written or printed.
  let accessToken;
  try { accessToken = execFileSync("gcloud", ["auth", "print-access-token"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
  catch { throw new Error("The release operator's short-lived OAuth could not be obtained. No token was printed or saved."); }
  oauth = new OAuth2Client();
  oauth.setCredentials({ access_token: accessToken, expiry_date: Date.now() + 3000000 });
  credential = { getAccessToken: async () => ({ access_token: accessToken, expires_in: 3000 }) };
}
const app = initializeApp({ projectId, ...(credential ? { credential } : {}) });
// Admin SDK Firestore requires ADC or a certificate. Use the Cloud client with the
// same short-lived operator OAuth instead of creating a persistent credential.
const db = emulator ? getFirestore(app) : new Firestore({ projectId, preferRest: true, authClient: oauth });
const auth = getAuth(app);
const catalog = JSON.parse(await readFile(new URL("../../functions/src/permissionCatalog.json", import.meta.url), "utf8"));
const moduleCatalog = JSON.parse(await readFile(new URL("../../functions/src/moduleCatalog.json", import.meta.url), "utf8"));
const allowedPermissions = new Set(Object.entries(catalog).flatMap(([feature, actions]) => [...actions, "*"].map((action) => `${feature}.${action}`.toLowerCase())));
const privateFields = ["username", "password", "sftpAddress", "sftpProtocol", "sftpPort", "sftpUser", "sftpPassword", "sftpHostKey"];
const issues = [];
const validId = (id) => typeof id === "string" && id.length > 0 && id.length <= 128 && !id.includes("/") && ![".", ".."].includes(id);
try {
  const rolloutRef = db.doc("platformConfiguration/saasProcurement");
  if (mode === "pause") {
    await rolloutRef.set({ enabled: false, pausedBy: operator, pausedAt: FieldValue.serverTimestamp() }, { merge: true });
    console.log("SaaS writes paused. Existing subscriptions and memberships were preserved.");
    process.exitCode = 0;
  } else if (mode === "deploy-rules") {
    if (emulator) throw new Error("Use the emulator suite to load test Rules.");
    if ((await rolloutRef.get()).data()?.enabled !== false) throw new Error("Pause SaaS writes before publishing Rules.");
    if (!process.env.SAAS_RULES_BACKUP_FILE) throw new Error("An operator-local Rules backup path is required.");
    const sources = await Promise.all(["firestore", "storage"].map((name) => readFile(new URL(`../../firebase/${name}.rules`, import.meta.url), "utf8")));
    const rulesets = await publishReviewedRules(getSecurityRules(app), sources,
      (backup) => writeFile(process.env.SAAS_RULES_BACKUP_FILE, JSON.stringify(backup, null, 2), { mode: 0o600, flag: "wx" }));
    await rolloutRef.set({ enabled: false, publishedRulesets: rulesets, rulesPublishedAt: FieldValue.serverTimestamp() }, { merge: true });
    console.log("Both reviewed Rules releases published and verified. The pilot remains paused during propagation.");
  } else {
  if (!emulator && ["migrate", "enable"].includes(mode)) {
    const sources = await Promise.all(["firestore", "storage"].map((name) => readFile(new URL(`../../firebase/${name}.rules`, import.meta.url), "utf8")));
    await verifyPublishedRules(getSecurityRules(app), sources);
    if (mode === "enable") {
      const publishedAt = (await rolloutRef.get()).data()?.rulesPublishedAt?.toMillis?.();
      if (!Number.isFinite(publishedAt) || Date.now() - publishedAt < 600000) throw new Error("Wait ten minutes after publishing Rules before activation.");
    }
  }
  const [hotels, profiles] = await Promise.all([db.collection("hotels").limit(501).get(), db.collection("users").limit(1001).get()]);
  if (hotels.size > 500 || profiles.size > 1000) throw new Error("The bounded rollout needs an operator review for larger datasets.");
  const hotelIds = new Set(hotels.docs.map((h) => h.id));
  const profileById = new Map(profiles.docs.map((p) => [p.id, p]));
  for (const profile of profiles.docs) {
    const assignments = profile.data().hotelUid;
    if (!Array.isArray(assignments) || assignments.some((id) => !validId(id) || !hotelIds.has(id))) {
      issues.push({ uid: profile.id, issue: "Review invalid or unknown hotel assignments." }); continue;
    }
    let user;
    try { user = await auth.getUser(profile.id); }
    catch (error) {
      if (error.code !== "auth/user-not-found") throw error;
      issues.push({ uid: profile.id, issue: "Auth account is missing." }); continue;
    }
    if (user.disabled || user.customClaims?.platformAdmin === true) continue;
    for (const hotelUid of assignments) {
      const member = await db.doc(`hotels/${hotelUid}/members/${profile.id}`).get();
      if (!member.exists) issues.push({ uid: profile.id, hotelUid, issue: "Canonical membership is missing. Review and assign access through User Management." });
    }
  }
  let supplierCredentials = 0, memberships = 0, pendingDeliveries = 0, subscriptions = 0;
  const legacySuppliers = [];
  const normalizations = [];
  for (const hotel of hotels.docs) {
    const [subscription, members, suppliers, orders] = await Promise.all([
      db.doc(`hotelSubscriptions/${hotel.id}`).get(), db.collection(`hotels/${hotel.id}/members`).limit(501).get(),
      db.collection(`hotels/${hotel.id}/suppliers`).limit(1001).get(), db.collection(`hotels/${hotel.id}/orders`).limit(1001).get(),
    ]);
    if (members.size > 500 || suppliers.size > 1000 || orders.size > 1000) throw new Error(`Hotel ${hotel.id} exceeds the bounded migration size.`);
    if (!subscription.exists) issues.push({ hotelUid: hotel.id, issue: "Assign an explicit subscription before rollout. No automatic activation is performed." });
    else {
      subscriptions++;
      const data = subscription.data();
      if (data.modulePolicyVersion !== moduleCatalog.policyVersion || !Array.isArray(data.modules)
        || data.modules.some((id) => !Object.hasOwn(moduleCatalog.modules, id)) || new Set(data.modules).size !== data.modules.length
        || (data.seatLimit !== null && (!Number.isSafeInteger(data.seatLimit) || data.seatLimit < 1 || data.seatLimit > 10000))) {
        issues.push({ hotelUid: hotel.id, issue: "Review and migrate explicit module entitlements and assigned-user limits before activation." });
      }
      if (!["active", "trialing", "suspended", "canceled"].includes(data.status)
        || (data.validUntil != null && !Number.isFinite(data.validUntil?.toMillis?.()))
        || (data.status === "trialing" && data.validUntil == null)
        || data.billingMode !== "manual") issues.push({ hotelUid: hotel.id, issue: "Review the subscription format. No automatic activation is performed." });
    }
    for (const member of members.docs) {
      memberships++;
      const permissions = member.data().permissions;
      if (!Array.isArray(permissions) || permissions.length > 200 || permissions.some((p) => typeof p !== "string" || !allowedPermissions.has(p.toLowerCase()))) {
        issues.push({ hotelUid: hotel.id, uid: member.id, issue: "Review invalid membership permissions." }); continue;
      }
      const profile = profileById.get(member.id);
      if (!profile || !profile.data().hotelUid?.includes(hotel.id)) issues.push({ hotelUid: hotel.id, uid: member.id, issue: "Membership and user profile disagree." });
      if (permissions.some((p) => p !== p.toLowerCase())) normalizations.push(member.ref);
    }
    for (const supplier of suppliers.docs) if (privateFields.some((key) => Object.hasOwn(supplier.data(), key))) {
      supplierCredentials++; legacySuppliers.push(supplier.ref);
    }
    for (const order of orders.docs) if (["pending", "processing"].includes(order.data().dispatchStatus)) {
      pendingDeliveries++;
      issues.push({ hotelUid: hotel.id, orderId: order.id, issue: "Reconcile the in-flight delivery before changing dispatch workers." });
    }
  }
  const summary = { projectId, mode, hotels: hotels.size, subscriptions, memberships, legacySupplierRecords: supplierCredentials,
    permissionNormalizations: normalizations.length, pendingDeliveries, issues };
  console.log(JSON.stringify(summary, null, 2));
  if (issues.length) throw new Error("Preflight failed. Resolve the listed records; no access or claims were changed.");
  if (mode === "migrate") {
    for (const ref of legacySuppliers) await db.runTransaction(async (tx) => {
      const privateRef = db.doc(`hotels/${ref.parent.parent.id}/supplierSecrets/${ref.id}`);
      const [supplier, secret] = await Promise.all([tx.get(ref), tx.get(privateRef)]);
      if (!supplier.exists) return;
      const source = supplier.data(), existing = secret.data() || {}, publicUpdate = {}, privateUpdate = {};
      for (const field of privateFields) if (Object.hasOwn(source, field)) {
        if (!Object.hasOwn(existing, field)) privateUpdate[field] = source[field];
        publicUpdate[field] = FieldValue.delete();
      }
      if (!Object.keys(publicUpdate).length) return;
      publicUpdate.credentialsConfigured = Boolean(existing.password || existing.sftpPassword || privateUpdate.password || privateUpdate.sftpPassword);
      tx.set(privateRef, { ...privateUpdate, migratedBy: operator, migratedAt: FieldValue.serverTimestamp() }, { merge: true });
      tx.update(ref, publicUpdate);
    });
    for (const ref of normalizations) await db.runTransaction(async (tx) => {
      const current = await tx.get(ref);
      const permissions = current.data()?.permissions;
      if (!Array.isArray(permissions) || permissions.some((p) => typeof p !== "string" || !allowedPermissions.has(p.toLowerCase()))) throw new Error("Membership changed during normalization. Review it before continuing.");
      tx.update(ref, { permissions: [...new Set(permissions.map((p) => p.toLowerCase()))], normalizedBy: operator, normalizedAt: FieldValue.serverTimestamp() });
    });
    console.log("Credential relocation and permission case normalization completed. Existing private passwords, claims and subscriptions were preserved.");
  }
  if (mode === "enable") {
    if (legacySuppliers.length || normalizations.length) throw new Error("Complete migration before activating the pilot.");
    const releaseSha = process.env.SAAS_RELEASE_SHA;
    if (!emulator && !/^[a-f0-9]{40}$/.test(releaseSha || "")) throw new Error("An exact reviewed SAAS_RELEASE_SHA is required.");
    await rolloutRef.set({ enabled: true, rulesVersion: "saas-modules-v2", releaseSha: releaseSha || "emulator",
      reviewedBy: operator, reviewedAt: FieldValue.serverTimestamp() }, { merge: true });
    console.log("Verified SaaS procurement pilot enabled.");
  }
  }
} finally { await db.terminate(); await deleteApp(app); }
