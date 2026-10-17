// Staging-only release gate. Production rollout scripts deliberately stay separate.
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectPrivateWorkflows } from "./private-workflows-migration.mjs";

export const STAGING_PROJECT = "hotel-toolkit-staging";
export const STAGING_BUCKET = `${STAGING_PROJECT}.firebasestorage.app`;
export const RULES_PROPAGATION_MS = 600000;
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const RELEASE_PATH = "_staging/release";
const SAAS_PATH = "platformConfiguration/saasProcurement";
const PRIVATE_PATH = "platformConfiguration/privateWorkflows";
const PRIVATE_FIELDS = ["username", "password", "sftpAddress", "sftpProtocol", "sftpPort", "sftpUser", "sftpPassword", "sftpHostKey"];
const INPUTS = ["firebase/firestore.rules", "firebase/storage.rules", "firebase/firestore.indexes.json",
  "functions/src/platformReleasePolicy.json", "functions/src/permissionCatalog.json", "functions/src/moduleCatalog.json"];

export function requireStagingTarget({ projectId, projectNumber, expectedProjectNumber, sha, env = process.env }) {
  if (projectId !== STAGING_PROJECT) throw new Error("Activation is restricted to the exact hotel-toolkit-staging project.");
  if (!/^[1-9][0-9]{5,19}$/.test(expectedProjectNumber || "") || expectedProjectNumber === "358734544002"
    || projectNumber !== expectedProjectNumber) throw new Error("The staging project number must match STAGING_PROJECT_NUMBER and cannot be production.");
  if (!/^[a-f0-9]{40}$/.test(sha || "")) throw new Error("An exact reviewed 40-character release SHA is required.");
  for (const key of ["FIRESTORE_EMULATOR_HOST", "FIREBASE_AUTH_EMULATOR_HOST", "FIREBASE_STORAGE_EMULATOR_HOST", "STORAGE_EMULATOR_HOST"]) {
    if (env[key]) throw new Error("Remove emulator configuration before a staging activation.");
  }
  for (const key of ["GCLOUD_PROJECT", "GOOGLE_CLOUD_PROJECT"]) {
    if (env[key] && env[key] !== STAGING_PROJECT) throw new Error("The ambient Google project differs from the explicit staging target.");
  }
}

export function parseStagingActivationArgs(args) {
  const options = { apply: false, source: ROOT };
  const values = new Map([["--project", "projectId"], ["--sha", "sha"], ["--phase", "phase"], ["--source", "source"], ["--evidence", "evidencePath"]]);
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (seen.has(flag) || (!values.has(flag) && flag !== "--apply")) throw new Error("Use unique, supported staging activation arguments.");
    seen.add(flag);
    if (flag === "--apply") options.apply = true;
    else {
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}.`);
      options[values.get(flag)] = value;
    }
  }
  if (options.projectId !== STAGING_PROJECT || !/^[a-f0-9]{40}$/.test(options.sha || "")
    || !["preflight", "deploying", "rules", "ready"].includes(options.phase)) {
    throw new Error("Use --project hotel-toolkit-staging --sha <40-character SHA> --phase preflight|deploying|rules|ready [--source checkout] [--evidence file] [--apply].");
  }
  if (options.phase === "preflight" && options.apply) throw new Error("Preflight is always read-only.");
  if (options.phase === "ready" && !options.evidencePath) throw new Error("Ready requires the controller's release evidence file.");
  return options;
}

export function requireReleaseEvidence(evidence, sha) {
  if (!evidence || evidence.projectId !== STAGING_PROJECT || evidence.sha !== sha || evidence.backendSha !== sha || evidence.frontendSha !== sha
    || evidence.functionsVerified !== true || evidence.appHostingVerified !== true || evidence.frontendMarkerVerified !== true) {
    throw new Error("Backend, App Hosting and served frontend evidence must identify the same staging release SHA.");
  }
}

export function requirePausedRelease(release, procurement, privateWorkflows, sha) {
  if (release?.state !== "deploying" || release.sha !== sha || procurement?.enabled !== false || privateWorkflows?.enabled !== false
    || procurement.releaseSha !== sha || privateWorkflows.releaseSha !== sha) {
    throw new Error("Pause this exact staging release before publishing Rules or activating it.");
  }
}

export function requireRulesPropagation(procurement, sha, rulesets, now = Date.now()) {
  const publishedAt = procurement?.rulesPublishedAt?.toMillis?.();
  if (procurement?.rulesReleaseSha !== sha || JSON.stringify(procurement.publishedRulesets) !== JSON.stringify(rulesets)
    || !Number.isFinite(publishedAt)) throw new Error("Record verification of both deployed Rules releases for this SHA before activation.");
  if (now - publishedAt < RULES_PROPAGATION_MS || publishedAt > now) {
    const error = new Error("Wait ten minutes after recording the deployed Rules before staging activation.");
    error.code = "STAGING_RULES_PROPAGATING";
    throw error;
  }
}

export async function verifyStagingRules(rules, sources) {
  const deployed = await Promise.all([rules.getFirestoreRuleset(), rules.getStorageRuleset(STAGING_BUCKET)]);
  deployed.forEach((entry, index) => {
    if (!entry.name || entry.source?.length !== 1 || entry.source[0].content !== sources[index]) {
      throw new Error("Deployed staging Rules differ from the selected commit. Activation is blocked.");
    }
  });
  return deployed.map(entry => entry.name);
}

const normalizedFields = fields => {
  const result = fields.map(field => ({ fieldPath: field.fieldPath,
    ...(field.order ? { order: field.order } : {}), ...(field.arrayConfig ? { arrayConfig: field.arrayConfig } : {}),
  }));
  // Firestore appends __name__ using the final sort direction when it is omitted.
  if (!result.some(field => field.fieldPath === "__name__")) result.push({ fieldPath: "__name__", order: result.at(-1)?.order || "ASCENDING" });
  return result;
};

export async function requestStagingIndexPage(token, pageToken, fetchPage = fetch) {
  if (typeof token !== "string" || !token.trim()) throw new Error("A short-lived staging credential is required for index verification.");
  if (pageToken !== undefined && (typeof pageToken !== "string" || !pageToken)) throw new Error("Invalid Firestore index page token.");
  // Match the Firebase CLI's database-wide composite-index inventory request.
  // Let the service choose its supported page size and follow every page token.
  const url = new URL(`https://firestore.googleapis.com/v1/projects/${STAGING_PROJECT}/databases/(default)/collectionGroups/-/indexes`);
  if (pageToken) url.searchParams.set("pageToken", pageToken);
  let response;
  try { response = await fetchPage(url, { headers: { Authorization: `Bearer ${token}`, "X-Goog-User-Project": STAGING_PROJECT }, signal: AbortSignal.timeout(30000) }); }
  catch { throw new Error("Staging index verification failed; no credential was printed."); }
  if (!response.ok) {
    let detail = "";
    try {
      const error = (await response.json()).error;
      if (typeof error?.message === "string") {
        detail = error.message.replaceAll(token, "[redacted]");
        if (pageToken) detail = detail.replaceAll(pageToken, "[redacted]");
        detail = detail.replace(/[\r\n\t]/g, " ").slice(0, 240);
      }
    } catch { /* An unreadable error body must still block activation. */ }
    throw new Error(`Staging index verification failed (HTTP ${response.status})${detail ? `: ${detail}` : "."}`);
  }
  return response.json();
}

export async function verifyStagingIndexes(request, manifest) {
  if (!Array.isArray(manifest.indexes) || (manifest.fieldOverrides?.length ?? 0) !== 0) throw new Error("The staging index verifier requires an explicit index manifest without field overrides.");
  for (const group of new Set(manifest.indexes.map(index => index.collectionGroup))) {
    if (!/^[A-Za-z0-9_-]+$/.test(group)) throw new Error("Invalid staging index collection group.");
  }
  if (!manifest.indexes.length) return 0;
  const indexes = [];
  let pageToken;
  const seen = new Set();
  do {
    const page = await request(`projects/${STAGING_PROJECT}/databases/(default)/collectionGroups/-/indexes`, pageToken);
    if (!Array.isArray(page.indexes ?? [])) throw new Error("Invalid Firestore index response.");
    indexes.push(...(page.indexes || []));
    pageToken = page.nextPageToken;
    if (indexes.length > 2000 || seen.size >= 100 || (pageToken && (typeof pageToken !== "string" || seen.has(pageToken)))) throw new Error("Index inventory exceeded the reviewed bounds.");
    if (pageToken) seen.add(pageToken);
  } while (pageToken);
  for (const expected of manifest.indexes) {
    const match = indexes.find(index => index.name?.startsWith(`projects/${STAGING_PROJECT}/databases/(default)/collectionGroups/${expected.collectionGroup}/indexes/`)
      && index.queryScope === expected.queryScope && Array.isArray(index.fields)
      && JSON.stringify(normalizedFields(index.fields)) === JSON.stringify(normalizedFields(expected.fields)));
    if (match?.state !== "READY") throw new Error(`A reviewed staging index for ${expected.collectionGroup} is missing or not READY.`);
  }
  return manifest.indexes.length;
}

export async function inspectStagingAccess(db, auth, { permissions, modules }) {
  if (db.projectId !== STAGING_PROJECT) throw new Error("The Firestore client must target hotel-toolkit-staging explicitly.");
  const [hotels, profiles] = await Promise.all([db.collection("hotels").limit(501).get(), db.collection("users").limit(1001).get()]);
  if (hotels.size > 500 || profiles.size > 1000) throw new Error("The staging data inventory exceeds the reviewed bounds.");
  const ids = new Set(hotels.docs.map(doc => doc.id));
  const profileById = new Map(profiles.docs.map(doc => [doc.id, doc.data()]));
  const allowed = new Set(Object.entries(permissions).flatMap(([feature, actions]) => [...actions, "*"].map(action => `${feature}.${action}`.toLowerCase())));
  const validId = id => typeof id === "string" && id.length > 0 && id.length <= 128 && id === id.trim() && !id.includes("/") && ![".", ".."].includes(id);
  const issues = [];
  let members = 0;
  for (const profile of profiles.docs) {
    const assignments = profile.data().hotelUid;
    if (!Array.isArray(assignments) || assignments.some(id => !validId(id) || !ids.has(id)) || new Set(assignments).size !== assignments.length) {
      issues.push(`Invalid hotel assignments: users/${profile.id}`); continue;
    }
    let user;
    try { user = await auth.getUser(profile.id); }
    catch (error) {
      if (error.code !== "auth/user-not-found") throw error;
      issues.push(`Missing Auth account: users/${profile.id}`); continue;
    }
    if (user.disabled || user.customClaims?.platformAdmin === true) continue;
    for (const hotelUid of assignments) {
      if (!(await db.doc(`hotels/${hotelUid}/members/${profile.id}`).get()).exists) issues.push(`Missing canonical membership: ${hotelUid}/${profile.id}`);
    }
  }
  for (const hotel of hotels.docs) {
    if (!validId(hotel.id)) throw new Error("Invalid hotel document ID.");
    const [subscription, memberships, suppliers, orders] = await Promise.all([
      db.doc(`hotelSubscriptions/${hotel.id}`).get(), db.collection(`hotels/${hotel.id}/members`).limit(501).get(),
      db.collection(`hotels/${hotel.id}/suppliers`).limit(1001).get(), db.collection(`hotels/${hotel.id}/orders`).limit(1001).get(),
    ]);
    if (memberships.size > 500 || suppliers.size > 1000 || orders.size > 1000) throw new Error("A staging hotel exceeds the reviewed preflight bounds.");
    const data = subscription.data();
    if (!subscription.exists || data.modulePolicyVersion !== modules.policyVersion || !Array.isArray(data.modules)
      || data.modules.some(id => !Object.hasOwn(modules.modules, id)) || new Set(data.modules).size !== data.modules.length
      || (data.seatLimit !== null && (!Number.isSafeInteger(data.seatLimit) || data.seatLimit < 1 || data.seatLimit > 10000))
      || !["active", "trialing", "suspended", "canceled"].includes(data.status) || data.billingMode !== "manual"
      || (data.validUntil != null && !Number.isFinite(data.validUntil?.toMillis?.())) || (data.status === "trialing" && data.validUntil == null)) {
      issues.push(`Invalid or missing explicit subscription: hotelSubscriptions/${hotel.id}`);
    }
    for (const member of memberships.docs) {
      members++;
      const grants = member.data().permissions;
      if (!Array.isArray(grants) || grants.length > 200 || grants.some(value => typeof value !== "string" || !allowed.has(value))) {
        issues.push(`Invalid canonical permission list: ${hotel.id}/${member.id}`);
      }
      if (!profileById.get(member.id)?.hotelUid?.includes(hotel.id)) issues.push(`Membership and profile disagree: ${hotel.id}/${member.id}`);
    }
    if (suppliers.docs.some(doc => PRIVATE_FIELDS.some(field => Object.hasOwn(doc.data(), field)))) issues.push(`Legacy supplier credentials require review: ${hotel.id}`);
    if (orders.docs.some(doc => ["pending", "processing"].includes(doc.data().dispatchStatus))) issues.push(`In-flight supplier dispatch requires review: ${hotel.id}`);
  }
  if (issues.length) throw new Error(`Staging access preflight failed:\n${issues.join("\n")}`);
  return { hotels: hotels.size, profiles: profiles.size, memberships: members };
}

export async function changeStagingActivation({ db, phase, sha, apply = false, operator, fieldValue, rulesVersion, rulesets, evidence, now = Date.now }) {
  if (db.projectId !== STAGING_PROJECT) throw new Error("The Firestore client must target hotel-toolkit-staging explicitly.");
  if (!["deploying", "rules", "ready"].includes(phase)) throw new Error("Unsupported staging activation mutation phase.");
  if (!/^[a-f0-9]{40}$/.test(sha || "") || !operator?.trim() || !rulesVersion?.trim()) throw new Error("Release SHA, operator and Rules version are required.");
  if (["rules", "ready"].includes(phase) && (!Array.isArray(rulesets) || rulesets.length !== 2 || rulesets.some(value => typeof value !== "string" || !value))) throw new Error("Both verified staging Rules release IDs are required.");
  if (phase === "ready") requireReleaseEvidence(evidence, sha);
  return db.runTransaction(async transaction => {
    const releaseRef = db.doc(RELEASE_PATH), procurementRef = db.doc(SAAS_PATH), privateRef = db.doc(PRIVATE_PATH);
    const [release, procurement, privateWorkflows, dataOperation] = await transaction.getAll(releaseRef, procurementRef, privateRef, db.doc("_staging/dataOperation"));
    if (dataOperation.data()?.status === "running") throw new Error("Finish or recover the active staging seed/reset before changing the release.");
    if (phase !== "deploying") requirePausedRelease(release.data(), procurement.data(), privateWorkflows.data(), sha);
    if (phase === "ready") requireRulesPropagation(procurement.data(), sha, rulesets, now());
    if (!apply) return { phase, sha, applied: false };
    const timestamp = fieldValue.serverTimestamp();
    if (phase === "deploying") {
      transaction.set(releaseRef, { state: "deploying", sha, backendSha: null, frontendSha: null, projectId: STAGING_PROJECT, startedAt: timestamp });
      for (const ref of [procurementRef, privateRef]) transaction.set(ref, { enabled: false, releaseSha: sha, pausedBy: operator, pausedAt: timestamp }, { merge: true });
      transaction.set(procurementRef, { rulesReleaseSha: null, publishedRulesets: [], rulesPublishedAt: null }, { merge: true });
    } else if (phase === "rules") {
      transaction.set(procurementRef, { enabled: false, rulesReleaseSha: sha, publishedRulesets: rulesets, rulesPublishedAt: timestamp }, { merge: true });
    } else {
      transaction.set(procurementRef, { enabled: true, rulesVersion, releaseSha: sha, reviewedBy: operator, reviewedAt: timestamp }, { merge: true });
      transaction.set(privateRef, { enabled: true, rulesVersion: "private-workflows-v1", releaseSha: sha, reviewedBy: operator, reviewedAt: timestamp }, { merge: true });
      transaction.set(releaseRef, { state: "ready", sha, backendSha: sha, frontendSha: sha, projectId: STAGING_PROJECT,
        readyAt: timestamp }, { merge: true });
    }
    transaction.create(db.collection("stagingReleaseAudit").doc(), { phase, sha, projectId: STAGING_PROJECT, actor: operator, createdAt: timestamp,
      ...(phase === "ready" ? { backendSha: sha, frontendSha: sha, rulesVersion, rulesets } : {}) });
    return { phase, sha, applied: true };
  });
}

function execute(command, args, purpose) {
  try { return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
  catch { throw new Error(`Could not ${purpose}. No credential or command output was printed.`); }
}

async function readSelectedSource(source, sha) {
  if (execute("git", ["-C", source, "rev-parse", "HEAD"], "read the selected checkout SHA") !== sha
    || execute("git", ["-C", source, "status", "--porcelain", "--untracked-files=no", "--", ...INPUTS], "verify reviewed activation inputs")) {
    throw new Error("Activation inputs must be unchanged files from the exact selected commit.");
  }
  const files = await Promise.all(INPUTS.map(path => readFile(resolve(source, path), "utf8")));
  return { sources: files.slice(0, 2), indexes: JSON.parse(files[2]), rulesVersion: JSON.parse(files[3]).saasRulesVersion,
    permissions: JSON.parse(files[4]), modules: JSON.parse(files[5]) };
}

async function main() {
  const options = parseStagingActivationArgs(process.argv.slice(2));
  const expectedProjectNumber = process.env.STAGING_PROJECT_NUMBER;
  // Reject wrong targets and ambient project overrides before credentials or SDK initialization.
  requireStagingTarget({ ...options, expectedProjectNumber, projectNumber: expectedProjectNumber });
  const source = await readSelectedSource(options.source, options.sha);
  const projectNumber = execute("gcloud", ["projects", "describe", STAGING_PROJECT, "--format=value(projectNumber)"], "verify staging project identity");
  requireStagingTarget({ ...options, projectNumber, expectedProjectNumber });
  const operator = execute("gcloud", ["auth", "list", "--filter=status:ACTIVE", "--format=value(account)"], "identify the staging operator");
  if (!operator || /[\r\n]/.test(operator)) throw new Error("Select exactly one authenticated staging operator.");
  const token = execute("gcloud", ["auth", "print-access-token"], "obtain short-lived staging operator OAuth");
  if (!token) throw new Error("Short-lived staging operator OAuth is unavailable.");
  const [{ initializeApp, deleteApp }, { getAuth }, { getSecurityRules }, { Firestore, FieldValue }, { Storage }, { OAuth2Client }] = await Promise.all([
    import("firebase-admin/app"), import("firebase-admin/auth"), import("firebase-admin/security-rules"), import("@google-cloud/firestore"), import("@google-cloud/storage"), import("google-auth-library"),
  ]);
  const oauth = new OAuth2Client();
  oauth.setCredentials({ access_token: token, expiry_date: Date.now() + 3000000 });
  const app = initializeApp({ projectId: STAGING_PROJECT, credential: { getAccessToken: async () => ({ access_token: token, expires_in: 3000 }) } });
  const db = new Firestore({ projectId: STAGING_PROJECT, preferRest: true, authClient: oauth });
  const bucket = new Storage({ projectId: STAGING_PROJECT, authClient: oauth }).bucket(STAGING_BUCKET);
  try {
    let rulesets;
    if (["preflight", "ready"].includes(options.phase)) {
      if (options.phase === "preflight") await requestStagingIndexPage(token);
      const projectPolicy = JSON.parse(execute("gcloud", ["projects", "get-iam-policy", STAGING_PROJECT, "--format=json"], "inspect staging project IAM"));
      if (projectPolicy.bindings?.some(binding => binding.members?.some(member => ["allUsers", "allAuthenticatedUsers"].includes(member)))) {
        throw new Error("Public staging project IAM requires review before private workflow activation.");
      }
      const summary = await inspectStagingAccess(db, getAuth(app), source);
      const privateInspection = await inspectPrivateWorkflows(db, bucket);
      if (privateInspection.summary.issues.length || privateInspection.summary.legacyFiles || privateInspection.summary.legacyUrls || privateInspection.summary.downloadTokens) {
        throw new Error("Staging contains legacy or invalid private workflows. Review them before activation; no automatic production migration is allowed.");
      }
      console.log(JSON.stringify({ projectId: STAGING_PROJECT, phase: options.phase, ...summary, privateWorkflows: privateInspection.summary }));
      if (options.phase === "preflight") return;
    }
    if (["rules", "ready"].includes(options.phase)) rulesets = await verifyStagingRules(getSecurityRules(app), source.sources);
    if (options.phase === "ready") {
      await verifyStagingIndexes((_path, pageToken) => requestStagingIndexPage(token, pageToken), source.indexes);
    }
    const evidence = options.evidencePath ? JSON.parse(await readFile(options.evidencePath, "utf8")) : undefined;
    const result = await changeStagingActivation({ ...options, db, operator, fieldValue: FieldValue, rulesVersion: source.rulesVersion, rulesets, evidence });
    console.log(JSON.stringify({ projectId: STAGING_PROJECT, ...result }));
  } finally { await db.terminate(); await deleteApp(app); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.code === "STAGING_RULES_PROPAGATING" ? `${error.code}: ${error.message}` : error.message); process.exitCode = error.code === "STAGING_RULES_PROPAGATING" ? 75 : 1; });
}
