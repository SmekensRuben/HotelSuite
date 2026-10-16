#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { open, lstat, readFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { STAGING_PROJECT, EMULATOR_PROJECT, DATASET_ID, HOTEL_IDS, MANIFEST_PATH, PROVENANCE, fixtureUsers, ownsFixture, buildStagingData } from "./staging-data-fixtures.mjs";

export function parseArguments(args, env = process.env) {
  const [action, ...flags] = args;
  if (!["seed", "reset", "scenario"].includes(action)) throw new Error("Choose seed, reset or scenario. See docs/staging-safe-releases.md for the reviewed procedure.");
  const options = { action, apply: false, emulator: false }, values = { "--project": "projectId", "--confirm-project": "confirmProject", "--credentials-file": "credentialsFile", "--business-date": "businessDate", "--subscription": "subscription" };
  const seen = new Set();
  for (let index = 0; index < flags.length; index++) {
    const flag = flags[index];
    if (seen.has(flag)) throw new Error(`Duplicate argument: ${flag}`);
    seen.add(flag);
    if (flag === "--apply" || flag === "--emulator") options[flag.slice(2)] = true;
    else if (Object.hasOwn(values, flag)) {
      const value = flags[++index];
      if (!value || value.startsWith("--")) throw new Error(`Missing value: ${flag}`);
      options[values[flag]] = value;
    } else throw new Error(`Unknown argument: ${flag}`);
  }
  const target = options.emulator ? EMULATOR_PROJECT : STAGING_PROJECT;
  if (options.projectId !== target) throw new Error(`This tool only accepts the explicit project ${target}.`);
  if (options.apply && options.confirmProject !== target) throw new Error(`Writes require --apply --confirm-project ${target}.`);
  if (options.confirmProject && options.confirmProject !== target) throw new Error("Confirmation project does not match the target.");
  if (options.businessDate && (!/^20\d{2}-\d{2}-\d{2}$/.test(options.businessDate) || new Date(`${options.businessDate}T12:00:00Z`).toISOString().slice(0, 10) !== options.businessDate)) throw new Error("Use a valid --business-date YYYY-MM-DD.");
  if (action === "scenario" && !["active", "suspended", "expired"].includes(options.subscription)) throw new Error("Scenario requires --subscription active, suspended or expired; it affects staging-hotel-b only.");
  if (action !== "scenario" && options.subscription) throw new Error("--subscription is only valid for scenario.");
  if (action !== "seed" && (options.credentialsFile || options.businessDate)) throw new Error("Credentials and business date are only valid for seed.");
  if (options.apply && action === "seed" && !options.credentialsFile) throw new Error("Seed writes require a private --credentials-file for the generated test passwords.");
  validateTargetRouting(target, options.emulator, env);
  return options;
}

function validateTargetRouting(target, emulator, env) {
  for (const key of ["GCLOUD_PROJECT", "GOOGLE_CLOUD_PROJECT", "GCP_PROJECT"]) if (env[key] && env[key] !== target) throw new Error(`${key} conflicts with the explicit staging target.`);
  if (env.FIREBASE_CONFIG?.trim().startsWith("{")) {
    const config = JSON.parse(env.FIREBASE_CONFIG);
    if (config.projectId && config.projectId !== target) throw new Error("FIREBASE_CONFIG conflicts with the explicit staging target.");
  } else if (env.FIREBASE_CONFIG) throw new Error("Unset file-based FIREBASE_CONFIG; this tool sets an explicit project.");
  const loopback = /^(?:127\.0\.0\.1|localhost|\[::1\]):([1-9]\d{0,4})$/;
  for (const key of ["FIRESTORE_EMULATOR_HOST", "FIREBASE_AUTH_EMULATOR_HOST"]) {
    const host = env[key], match = host?.match(loopback);
    if (emulator && (!match || Number(match[1]) > 65535)) throw new Error(`${key} must identify a loopback emulator.`);
    if (!emulator && host) throw new Error("Remote staging cannot be mixed with emulator environment variables.");
  }
  for (const key of ["FIREBASE_STORAGE_EMULATOR_HOST", "STORAGE_EMULATOR_HOST"]) if (env[key]) {
    if (!emulator) throw new Error("Remote staging cannot be mixed with a Storage emulator.");
    const host = env[key].replace(/^https?:\/\//, ""), match = host.match(loopback);
    if (!match || Number(match[1]) > 65535) throw new Error(`${key} must identify a loopback emulator.`);
  }
}

export function assertStagingTarget(db, auth, env = process.env) {
  const projectId = db?.projectId;
  const emulator = [EMULATOR_PROJECT, "demo-hotel-suite-a00"].includes(projectId);
  if (projectId !== STAGING_PROJECT && !emulator) throw new Error("Staging data mutations require the exact staging project or a supported local demo project.");
  validateTargetRouting(projectId, emulator, env);
  if (auth && auth.app?.options?.projectId !== projectId) throw new Error("Auth and Firestore must target the same explicit staging project.");
  return projectId;
}

export async function privateCredentials(file, projectId) {
  const filePath = resolve(file), users = fixtureUsers();
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  let handle;
  try {
    handle = await open(filePath, "wx", 0o600);
    const data = { projectId, datasetId: DATASET_ID, generatedAt: new Date().toISOString(), users: users.map(({ uid, email, role, hotelUid }) => ({ uid, email, role, hotelUid, password: `${randomBytes(24).toString("base64url")}aA1!` })) };
    await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`); await handle.sync();
    return data;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const stat = await lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error("Existing credential file must be a regular private file (mode 0600).");
    let data;
    try { data = JSON.parse(await readFile(filePath, "utf8")); }
    catch { throw new Error("The private credential file is not valid readable JSON; its contents were not printed."); }
    if (data.projectId !== projectId || data.datasetId !== DATASET_ID || data.users?.length !== users.length || users.some((user) => !data.users.some((saved) => saved.uid === user.uid && saved.email === user.email && typeof saved.password === "string" && saved.password.length >= 24))) throw new Error("The credential file does not match this staging fixture. Keep it private and use the correct file.");
    return data;
  } finally { await handle?.close(); }
}

// Bind both completed and interrupted seeds to the original private password
// file. Only the digest is persisted; Auth passwords never enter Firestore.
export function stagingCredentialsFingerprint(credentials) {
  const expected = fixtureUsers();
  if (!Array.isArray(credentials?.users) || credentials.users.length !== expected.length) throw new Error("The private credentials must include every fixed staging identity exactly once.");
  const pairs = expected.map((user) => {
    const matches = credentials.users.filter((item) => item?.uid === user.uid);
    if (matches.length !== 1 || matches[0].email !== user.email || typeof matches[0].password !== "string" || matches[0].password.length < 24) throw new Error("The private credentials contain an invalid staging identity or password.");
    return [user.uid, matches[0].password];
  });
  return createHash("sha256").update(JSON.stringify(pairs)).digest("hex");
}

const authMissing = (error) => error.code === "auth/user-not-found";
const pendingOwnedUser = (user, fixture, manifest) => ["provisioning", "resetting"].includes(manifest?.status) && manifest.authProvisioningUid === fixture.uid && user?.uid === fixture.uid && user.email === fixture.email && user.displayName === fixture.displayName && !Object.keys(user.customClaims || {}).length;
async function getUser(auth, uid) { try { return await auth.getUser(uid); } catch (error) { if (authMissing(error)) return null; throw error; } }
function ownsUser(user, fixture) { return user?.uid === fixture.uid && user.email === fixture.email && user.customClaims?.stagingDataset === DATASET_ID && Object.keys(user.customClaims).length === 1; }
function assertManifest(snapshot) { if (snapshot.exists && !ownsFixture(snapshot.data())) throw new Error("The staging manifest belongs to another dataset; refusing to change it."); }

export function assertFixtureScope(fixture) {
  const expectedUsers = fixtureUsers();
  if (fixture?.datasetId !== DATASET_ID || !Array.isArray(fixture.docs) || !fixture.docs.length || fixture.docs.length > 490
    || !Array.isArray(fixture.users) || fixture.users.length !== expectedUsers.length) throw new Error("The staging fixture manifest is invalid.");
  for (const user of expectedUsers) {
    const matches = fixture.users.filter((item) => item.uid === user.uid);
    if (matches.length !== 1 || ["email", "displayName", "hotelUid", "role", "emailVerified"].some((key) => matches[0][key] !== user[key])) throw new Error("The staging fixture contains an unexpected Auth identity.");
  }
  const paths = new Set();
  for (const { path, data } of fixture.docs) {
    const segments = typeof path === "string" ? path.split("/") : [];
    const allowed = segments.length % 2 === 0 && segments.every((segment) => segment && ![".", ".."].includes(segment))
      && (segments[0] === "hotels" && HOTEL_IDS.includes(segments[1])
        || segments.length === 2 && segments[0] === "hotelSubscriptions" && HOTEL_IDS.includes(segments[1])
        || segments.length === 2 && segments[0] === "users" && expectedUsers.some((user) => user.uid === segments[1]));
    if (!allowed || paths.has(path) || !ownsFixture(data)) throw new Error("The staging fixture contains a duplicate, unowned or out-of-scope document.");
    paths.add(path);
  }
  for (const hotelUid of HOTEL_IDS) for (const path of [`hotels/${hotelUid}`, `hotelSubscriptions/${hotelUid}`]) if (!paths.has(path)) throw new Error("The staging fixture is missing an owned hotel or subscription.");
  for (const user of expectedUsers) if (!paths.has(`users/${user.uid}`)) throw new Error("The staging fixture is missing a user profile.");
}

export async function seedStagingData({ db, auth, fixture, credentials }) {
  assertStagingTarget(db, auth);
  assertFixtureScope(fixture);
  const credentialFingerprint = stagingCredentialsFingerprint(credentials);
  const manifestRef = db.doc(MANIFEST_PATH), manifest = await manifestRef.get(); assertManifest(manifest);
  if (manifest.exists && manifest.data().credentialFingerprint !== credentialFingerprint) throw new Error("The private credentials do not match the existing staging seed. Use the original credential file, or reset the owned dataset before generating new credentials.");
  if (manifest.exists && manifest.data().status === "complete") return { alreadySeeded: true, ...manifest.data().summary };
  if (manifest.exists && manifest.data().status !== "provisioning") throw new Error("A reset is in progress. Complete reset before seeding.");
  const existing = await db.getAll(...fixture.docs.map((item) => db.doc(item.path)));
  for (const snapshot of existing) if (snapshot.exists) throw new Error(`Fixture collision at ${snapshot.ref.path}; seed is create-only. Reset the owned dataset first.`);
  const priorUsers = await Promise.all(fixture.users.map((user) => getUser(auth, user.uid)));
  for (const [index, user] of priorUsers.entries()) if (user && (!manifest.exists || !ownsUser(user, fixture.users[index]) && !pendingOwnedUser(user, fixture.users[index], manifest.data()))) throw new Error(`Auth fixture collision at ${fixture.users[index].uid}; no user is overwritten.`);
  // The private manifest precedes Auth provisioning, allowing a failed multi-service
  // operation to be resumed or reset without guessing which identities it owns.
  if (!manifest.exists) await manifestRef.create({ stagingData: PROVENANCE, status: "provisioning", businessDate: fixture.businessDate, hotelIds: HOTEL_IDS,
    userIds: fixture.users.map((user) => user.uid), credentialFingerprint, createdAt: new Date(), summary: fixture.summary });
  else if (manifest.data().businessDate !== fixture.businessDate) throw new Error("Resume provisioning with the original business date, or reset first.");
  for (const [index, user] of fixture.users.entries()) {
    if (priorUsers[index]) {
      if (!ownsUser(priorUsers[index], user)) await auth.setCustomUserClaims(user.uid, { stagingDataset: DATASET_ID });
      continue;
    }
    const password = credentials.users.find((row) => row.uid === user.uid)?.password;
    if (!password) throw new Error("Missing private test password.");
    await manifestRef.update({ authProvisioningUid: user.uid });
    await auth.createUser({ uid: user.uid, email: user.email, displayName: user.displayName, emailVerified: true, password });
    await auth.setCustomUserClaims(user.uid, { stagingDataset: DATASET_ID });
    if (user.role === "revoked") await auth.revokeRefreshTokens(user.uid);
  }
  await db.runTransaction(async (tx) => {
    const current = await tx.get(manifestRef); assertManifest(current);
    if (current.data()?.status !== "provisioning" || current.data()?.credentialFingerprint !== credentialFingerprint) throw new Error("Staging seed state or credentials changed; no fixture data was written.");
    for (const item of fixture.docs) tx.create(db.doc(item.path), item.data);
    tx.update(manifestRef, { status: "complete", authProvisioningUid: null, completedAt: new Date() });
  });
  return { alreadySeeded: false, ...fixture.summary };
}

export async function resetStagingData({ db, auth }) {
  assertStagingTarget(db, auth);
  const manifestRef = db.doc(MANIFEST_PATH), manifest = await manifestRef.get(); assertManifest(manifest);
  if (!manifest.exists) return { alreadyReset: true };
  const users = fixtureUsers();
  // Check every owned boundary before the first deletion. Unrelated hotels,
  // profiles, subscriptions, Auth identities and the shared release gate survive.
  for (const hotelUid of HOTEL_IDS) for (const path of [`hotels/${hotelUid}`, `hotelSubscriptions/${hotelUid}`]) {
    const snapshot = await db.doc(path).get(); if (snapshot.exists && !ownsFixture(snapshot.data())) throw new Error(`Reset refuses unowned data at ${path}.`);
  }
  for (const user of users) {
    const profile = await db.doc(`users/${user.uid}`).get(), account = await getUser(auth, user.uid);
    if (profile.exists && (!ownsFixture(profile.data()) || !Array.isArray(profile.data().hotelUid) || profile.data().hotelUid.some((hotelUid) => !HOTEL_IDS.includes(hotelUid)))
      || account && !ownsUser(account, user) && !pendingOwnedUser(account, user, manifest.data())) throw new Error(`Reset refuses an unowned or externally assigned user at ${user.uid}.`);
  }
  await manifestRef.update({ status: "resetting", resetStartedAt: new Date() });
  for (const hotelUid of HOTEL_IDS) { await db.recursiveDelete(db.doc(`hotels/${hotelUid}`)); await db.doc(`hotelSubscriptions/${hotelUid}`).delete(); }
  for (const user of users) {
    await db.doc(`users/${user.uid}`).delete();
    try { await auth.deleteUser(user.uid); } catch (error) { if (!authMissing(error)) throw error; }
  }
  await manifestRef.delete();
  return { alreadyReset: false, hotels: HOTEL_IDS.length, users: users.length };
}

export async function setSubscriptionScenario({ db, subscription }) {
  assertStagingTarget(db);
  if (!["active", "suspended", "expired"].includes(subscription)) throw new Error("Unsupported subscription scenario.");
  const hotelUid = HOTEL_IDS[1];
  await db.runTransaction(async (tx) => {
    const manifest = await tx.get(db.doc(MANIFEST_PATH)), ref = db.doc(`hotelSubscriptions/${hotelUid}`), snapshot = await tx.get(ref);
    if (!ownsFixture(manifest.data()) || manifest.data()?.status !== "complete" || !ownsFixture(snapshot.data())) throw new Error("Load the owned staging fixture before changing its subscription scenario.");
    tx.update(ref, { status: subscription === "expired" ? "trialing" : subscription, validUntil: subscription === "expired" ? new Date("2020-01-01T00:00:00Z") : null,
      revision: snapshot.data().revision + 1, updatedAt: new Date(), updatedBy: "staging-scenario" });
  });
  return { hotelUid, subscription };
}

// Release begin reads this document and writes _staging/release in the same
// transaction. Seed/reset read that release and write this lock, so a deployment
// and destructive fixture reset cannot both enter. A crashed operation stays
// blocked for operator investigation; time passing never authorizes a reset.
export async function withStagingDataOperation(db, action, callback) {
  assertStagingTarget(db);
  const ref = db.doc("_staging/dataOperation"), token = randomBytes(16).toString("hex");
  await db.runTransaction(async (tx) => {
    const [release, current] = await Promise.all([tx.get(db.doc("_staging/release")), tx.get(ref)]);
    if (release.data()?.state === "deploying") throw new Error("A staging deployment is in progress; fixture writes are blocked.");
    if (current.data()?.status === "running") throw new Error("Another staging data operation is running. Inspect its operator/process before clearing a stale lock.");
    tx.set(ref, { status: "running", token, action, datasetId: DATASET_ID, startedAt: new Date() });
  });
  try { return await callback(); }
  finally {
    await db.runTransaction(async (tx) => {
      const current = await tx.get(ref);
      if (current.data()?.token !== token) throw new Error("The staging data operation lock changed; inspect the operation before continuing.");
      tx.update(ref, { status: "idle", finishedAt: new Date() });
    });
  }
}

export async function main(args = process.argv.slice(2), env = process.env) {
  const options = parseArguments(args, env);
  if (!options.apply) {
    console.log(JSON.stringify({ mode: "DRY RUN", projectId: options.projectId, action: options.action, datasetId: DATASET_ID, hotelIds: HOTEL_IDS,
      users: fixtureUsers().map(({ uid, role, hotelUid }) => ({ uid, role, hotelUid })), subscription: options.subscription ?? "active",
      scope: "Two reserved synthetic hotel subtrees, their subscriptions and exact fixture users. Reset also clears manually created scenarios inside those hotels. No remote reads or writes.",
      privateCredentialsRequired: options.action === "seed", storage: "No Storage objects are seeded or deleted; private-upload scenarios require separate cleanup." }, null, 2));
    return;
  }
  // No SDK or credential initialization occurs until all target guards pass.
  // Use the same installed Admin SDK as the domain fixture builders, including
  // their Timestamp/FieldValue classes and default app registry.
  const requireFunctions = createRequire(new URL("../../functions/package.json", import.meta.url));
  const { initializeApp, deleteApp, applicationDefault } = requireFunctions("firebase-admin/app");
  const { getFirestore } = requireFunctions("firebase-admin/firestore");
  const { getAuth } = requireFunctions("firebase-admin/auth");
  const app = initializeApp({ projectId: options.projectId, ...(options.emulator ? {} : { credential: applicationDefault() }) });
  try {
    const services = { db: getFirestore(app), auth: getAuth(app) };
    const result = await withStagingDataOperation(services.db, options.action, async () => {
      if (options.action === "seed") {
        const credentials = await privateCredentials(options.credentialsFile, options.projectId), fixture = buildStagingData({ businessDate: options.businessDate });
        return await seedStagingData({ ...services, fixture, credentials });
      } else if (options.action === "reset") return await resetStagingData(services);
      else return await setSubscriptionScenario({ ...services, subscription: options.subscription });
    });
    console.log(JSON.stringify({ mode: "APPLIED", projectId: options.projectId, action: options.action, ...result }, null, 2));
  } finally { await deleteApp(app); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
