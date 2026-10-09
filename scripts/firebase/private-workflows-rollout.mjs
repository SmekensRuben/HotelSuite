import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getSecurityRules } from "firebase-admin/security-rules";
import { Firestore } from "@google-cloud/firestore";
import { Storage } from "@google-cloud/storage";
import { OAuth2Client } from "google-auth-library";
import { verifyPublishedRules, STORAGE_BUCKET } from "./saas-rules-release.mjs";
import { inspectPrivateWorkflows, migratePrivateWorkflows } from "./private-workflows-migration.mjs";
const args = process.argv.slice(2), mode = args[0], emulator = args.includes("--emulator");
if (!["preflight", "pause", "migrate", "enable"].includes(mode) || args.some((v, i) => i > 0 && v !== "--emulator")) throw new Error("Use preflight, pause, migrate or enable, optionally with --emulator.");
const storageHost = process.env.FIREBASE_STORAGE_EMULATOR_HOST || process.env.STORAGE_EMULATOR_HOST;
const projectId = emulator ? "demo-hotel-suite-a00" : "hotel-toolkit";
if (emulator && (!/^(127\.0\.0\.1|localhost):8080$/.test(process.env.FIRESTORE_EMULATOR_HOST || "") || !/^(127\.0\.0\.1|localhost):9199$/.test(storageHost || ""))) throw new Error("Local Firestore and Storage emulators are required.");
if (!emulator && (process.env.FIRESTORE_EMULATOR_HOST || storageHost || process.env.FIREBASE_AUTH_EMULATOR_HOST)) throw new Error("Remove emulator configuration before a production rollout.");
let operator = "emulator-operator", credential, oauth;
if (!emulator) {
  const number = execFileSync("gcloud", ["projects", "describe", projectId, "--format=value(projectNumber)"], { encoding: "utf8" }).trim();
  operator = execFileSync("gcloud", ["auth", "list", "--filter=status:ACTIVE", "--format=value(account)"], { encoding: "utf8" }).trim();
  if (number !== "358734544002" || operator !== "bestsmekens@gmail.com") throw new Error("Use the reviewed hotel-toolkit release operator.");
  const policy = JSON.parse(execFileSync("gcloud", ["projects", "get-iam-policy", projectId, "--format=json"], { encoding: "utf8" }));
  if (policy.bindings?.some((binding) => binding.members?.some((member) => ["allUsers", "allAuthenticatedUsers"].includes(member)))) throw new Error("Public project IAM needs operator review before private-file rollout.");
  let accessToken;
  try { accessToken = execFileSync("gcloud", ["auth", "print-access-token"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); } catch { throw new Error("Short-lived operator OAuth is unavailable. No token was printed or saved."); }
  oauth = new OAuth2Client(); oauth.setCredentials({ access_token: accessToken, expiry_date: Date.now() + 3000000 });
  credential = { getAccessToken: async () => ({ access_token: accessToken, expires_in: 3000 }) };
}
const app = initializeApp({ projectId, ...(credential ? { credential } : {}) });
const db = emulator ? getFirestore(app) : new Firestore({ projectId, preferRest: true, authClient: oauth });
const storage = new Storage({ projectId, ...(oauth ? { authClient: oauth } : {}), ...(emulator ? { apiEndpoint: "http://" + storageHost } : {}) });
const bucket = storage.bucket(emulator ? projectId + ".appspot.com" : STORAGE_BUCKET), flag = db.doc("platformConfiguration/privateWorkflows");
try {
  if (mode === "pause") { await flag.set({ enabled: false, pausedBy: operator, pausedAt: FieldValue.serverTimestamp() }, { merge: true }); console.log("Private workflow writes paused. No subscriptions or memberships changed."); }
  else {
    if (["migrate", "enable"].includes(mode)) {
      if ((await flag.get()).data()?.enabled !== false) throw new Error("Pause private workflows before migration or activation.");
      if (!emulator) {
        const sources = await Promise.all(["firestore", "storage"].map((name) => readFile(new URL("../../firebase/" + name + ".rules", import.meta.url), "utf8")));
        await verifyPublishedRules(getSecurityRules(app), sources);
        if (["migrate", "enable"].includes(mode)) {
          const publishedAt = (await db.doc("platformConfiguration/saasProcurement").get()).data()?.rulesPublishedAt?.toMillis?.();
          if (!Number.isFinite(publishedAt) || Date.now() - publishedAt < 600000) throw new Error("Wait ten minutes after publishing Rules before migration or activation.");
        }
      }
    }
    const inspection = await inspectPrivateWorkflows(db, bucket, { emulator });
    console.log(JSON.stringify({ projectId, mode, ...inspection.summary }, null, 2));
    if (inspection.summary.issues.length) throw new Error("Resolve the listed preflight records. Activation remains blocked.");
    if (mode === "migrate") {
      if (!emulator) {
        if (!process.env.PRIVATE_WORKFLOWS_BACKUP_FILE) throw new Error("A private operator backup path is required.");
        await writeFile(process.env.PRIVATE_WORKFLOWS_BACKUP_FILE, JSON.stringify({ contracts: inspection.contracts.map((e) => ({ path: e.snapshot.ref.path, data: e.snapshot.data() })), roomingLists: inspection.roomingLists.map((e) => ({ path: e.snapshot.ref.path, data: e.snapshot.data() })) }, null, 2), { mode: 0o600, flag: "wx" });
      }
      await migratePrivateWorkflows(db, bucket, inspection, FieldValue, operator);
      console.log("Private file copies verified, old download tokens revoked and rooming-list control fields migrated. Existing public access was not extended.");
    }
    if (mode === "enable") {
      const procurement = (await db.doc("platformConfiguration/saasProcurement").get()).data();
      if (procurement?.enabled !== true || procurement.rulesVersion !== "saas-procurement-v1") throw new Error("Enable the verified procurement pilot before private workflow activation.");
      if (inspection.summary.legacyFiles || inspection.summary.legacyUrls || inspection.summary.downloadTokens) throw new Error("Complete file migration and token revocation before activation.");
      const releaseSha = process.env.SAAS_RELEASE_SHA;
      if (!emulator && !/^[a-f0-9]{40}$/.test(releaseSha || "")) throw new Error("An exact reviewed release SHA is required.");
      await flag.set({ enabled: true, rulesVersion: "private-workflows-v1", releaseSha: releaseSha || "emulator", reviewedBy: operator, reviewedAt: FieldValue.serverTimestamp() }, { merge: true });
      console.log("Private contract files and rooming-list backend enabled.");
    }
  }
} finally { await db.terminate(); await deleteApp(app); }
