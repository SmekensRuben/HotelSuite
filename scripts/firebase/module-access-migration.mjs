// Explicit, reviewable module/admin migration. Dry-run is the default.
import { readFile } from "node:fs/promises";
import { initializeApp, applicationDefault, deleteApp } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import { createHash } from "node:crypto";
const catalog = JSON.parse(await readFile(new URL("../../functions/src/moduleCatalog.json", import.meta.url), "utf8"));
const ADMIN_PERMISSIONS = ["users.read", "users.create", "users.update", "users.delete"];
function validateModules(modules) {
  if (!Array.isArray(modules) || modules.length > Object.keys(catalog.modules).length || modules.some((id) => !Object.hasOwn(catalog.modules, id)) || new Set(modules).size !== modules.length) throw new Error("Review explicit, unique module IDs.");
  return modules.slice().sort();
}
function validateSeatLimit(value) {
  if (value !== null && (!Number.isSafeInteger(value) || value < 1 || value > 10000)) throw new Error("Review an explicit null or bounded assigned-user limit.");
  return value;
}
const args = process.argv.slice(2);
const flags = new Set(["--project", "--manifest", "--operator", "--apply", "--emulator"]);
const options = {};
for (let i = 0; i < args.length; i++) {
  const flag = args[i];
  if (!flags.has(flag) || Object.hasOwn(options, flag)) throw new Error("Use unique, supported migration options.");
  if (["--apply", "--emulator"].includes(flag)) options[flag] = true;
  else {
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new Error("A migration option is missing its value.");
    options[flag] = value;
  }
}
const projectId = options["--project"];
const operator = options["--operator"];
if (!/^[a-z][a-z0-9-]{4,62}$/.test(projectId || "") || !options["--manifest"] || !operator?.trim()) throw new Error("Explicit project, manifest and operator are required.");
const emulator = options["--emulator"] === true;
if (emulator && (projectId !== "demo-hotel-suite-a00" || !/^(localhost|127\.0\.0\.1):8080$/.test(process.env.FIRESTORE_EMULATOR_HOST || "") || !/^(localhost|127\.0\.0\.1):9099$/.test(process.env.FIREBASE_AUTH_EMULATOR_HOST || ""))) throw new Error("Explicit local demo Auth/Firestore emulators are required.");
if (!emulator && (process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_AUTH_EMULATOR_HOST)) throw new Error("Use --emulator explicitly for local migration tests.");
const manifest = JSON.parse(await readFile(options["--manifest"], "utf8"));
const validId = (id) => typeof id === "string" && id === id.trim() && id.length > 0 && id.length <= 128 && !id.includes("/") && ![".", ".."].includes(id);
if (!Array.isArray(manifest) || !manifest.length || manifest.length > 500 || new Set(manifest.map((entry) => entry.hotelUid)).size !== manifest.length) throw new Error("Review a manifest of 1–500 unique hotels.");
const reviewed = manifest.map((entry) => {
  if (!validId(entry.hotelUid) || !Number.isSafeInteger(entry.expectedRevision) || entry.expectedRevision < 1
    || !Array.isArray(entry.hotelAdminUids) || entry.hotelAdminUids.length > 20 || entry.hotelAdminUids.some((uid) => !validId(uid))
    || new Set(entry.hotelAdminUids).size !== entry.hotelAdminUids.length) throw new Error("Review the hotel ID, subscription revision and administrator UIDs.");
  return { hotelUid: entry.hotelUid, expectedRevision: entry.expectedRevision, modules: validateModules(entry.modules),
    seatLimit: validateSeatLimit(entry.seatLimit), hotelAdminUids: entry.hotelAdminUids.slice().sort() };
});
const app = initializeApp({ projectId, ...(emulator ? {} : { credential: applicationDefault() }) });
const db = getFirestore(app);
const auth = getAuth(app);
async function assess(entry, tx) {
  const get = (ref) => tx ? tx.get(ref) : ref.get();
  const subscriptionRef = db.doc(`hotelSubscriptions/${entry.hotelUid}`);
  const fingerprint = createHash("sha256").update(JSON.stringify(entry)).digest("hex");
  const receiptRef = db.doc(`hotels/${entry.hotelUid}/subscriptionAudit/modules-${fingerprint}`);
  const [hotel, subscription, receipt, state, admins, ...members] = await Promise.all([
    get(db.doc(`hotels/${entry.hotelUid}`)), get(subscriptionRef), get(receiptRef),
    get(db.doc(`hotels/${entry.hotelUid}/memberAdministration/state`)),
    get(db.collection(`hotels/${entry.hotelUid}/members`).where("hotelAdmin", "==", true).limit(21)),
    ...entry.hotelAdminUids.map((uid) => get(db.doc(`hotels/${entry.hotelUid}/members/${uid}`))),
  ]);
  if (!hotel.exists || !subscription.exists || members.some((member) => !member.exists || !Array.isArray(member.data().permissions)
    || !Number.isSafeInteger(member.data().revision || 0))) throw new Error(`Review missing or invalid source records for ${entry.hotelUid}.`);
  const data = subscription.data();
  if (receipt.exists) {
    if (data.revision !== entry.expectedRevision + 1 || data.modulePolicyVersion !== 1 || JSON.stringify(data.modules) !== JSON.stringify(entry.modules)
      || data.seatLimit !== entry.seatLimit || members.some((member) => member.data().hotelAdmin !== true)) throw new Error(`Applied migration changed since review: ${entry.hotelUid}.`);
    return { alreadyApplied: true };
  }
  if (data.revision !== entry.expectedRevision) throw new Error(`Subscription revision changed for ${entry.hotelUid}.`);
  if (admins.size + members.filter((member) => member.data().hotelAdmin !== true).length > 20) throw new Error("Administrator count exceeds the supported bound.");
  for (const uid of entry.hotelAdminUids) {
    const user = await auth.getUser(uid);
    if (user.disabled || !user.emailVerified || user.customClaims?.platformAdmin === true) throw new Error("Appoint enabled, verified hotel accounts; platform authority stays separate.");
  }
  const profiles = await Promise.all(entry.hotelAdminUids.map((uid) => get(db.doc(`users/${uid}`))));
  if (profiles.some((profile) => !profile.exists || !Array.isArray(profile.data().hotelUid) || !profile.data().hotelUid.includes(entry.hotelUid)
    || !Number.isSafeInteger(profile.data().accessRevision || 0)) || !Number.isSafeInteger(state.data()?.revision || 0)) throw new Error("Review administrator profile assignments and revisions.");
  return { subscriptionRef, receiptRef, members, profiles, state, fingerprint, data };
}
try {
  // Validate every selected hotel before beginning any mutation.
  for (const entry of reviewed) await assess(entry);
  console.log(`${options["--apply"] ? "APPLY" : "DRY RUN"}: project=${projectId}, operator=${operator}, hotels=${reviewed.length}`);
  for (const entry of reviewed) {
    if (!options["--apply"]) { console.log(JSON.stringify({ ...entry, action: "would assign explicit modules and appoint reviewed administrators; preserve subscription status, data and existing permissions" })); continue; }
    const applied = await db.runTransaction(async (tx) => {
      const source = await assess(entry, tx);
      if (source.alreadyApplied) return false;
      const timestamp = FieldValue.serverTimestamp();
      tx.update(source.subscriptionRef, { modules: entry.modules, modulePolicyVersion: 1, seatLimit: entry.seatLimit,
        revision: entry.expectedRevision + 1, updatedAt: timestamp, updatedBy: `module-migration:${operator}` });
      source.members.forEach((member, index) => {
        tx.update(member.ref, { hotelAdmin: true, permissions: [...new Set([...member.data().permissions, ...ADMIN_PERMISSIONS])].sort(),
          revision: (member.data().revision || 0) + 1, updatedAt: timestamp, updatedBy: `module-migration:${operator}` });
        tx.update(source.profiles[index].ref, { accessRevision: (source.profiles[index].data().accessRevision || 0) + 1 });
        tx.create(db.doc(`hotels/${entry.hotelUid}/accessAudit/modules-${source.fingerprint}-${member.id}`), {
          source: "reviewed-module-migration", operator, uid: member.id,
          previousHotelAdmin: member.data().hotelAdmin === true, hotelAdmin: true,
          previousPermissions: member.data().permissions,
          addedPermissions: ADMIN_PERMISSIONS.filter((key) => !member.data().permissions.includes(key)), createdAt: timestamp,
        });
      });
      tx.set(db.doc(`hotels/${entry.hotelUid}/memberAdministration/state`), { revision: (source.state.data()?.revision || 0) + 1, updatedAt: timestamp, updatedBy: `module-migration:${operator}` });
      tx.create(source.receiptRef, { source: "reviewed-module-migration", operator, fingerprint: source.fingerprint,
        previousModules: source.data.modules ?? null, modules: entry.modules, modulePolicyVersion: 1,
        previousSeatLimit: source.data.seatLimit ?? null, seatLimit: entry.seatLimit,
        appointedHotelAdminUids: entry.hotelAdminUids, revision: entry.expectedRevision + 1, createdAt: timestamp });
      return true;
    });
    console.log(`${entry.hotelUid}: ${applied ? "applied" : "already applied and verified"}`);
  }
} finally { await deleteApp(app); }
