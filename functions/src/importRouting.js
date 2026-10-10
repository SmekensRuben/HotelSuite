const { randomUUID } = require("node:crypto");
const { extractEmailAddress, normalizeFileType } = require("./common");
const { stableId, requireSegment, receiverId, importProjectionId, syncImportProjection, PROJECTION_VERSION } = require("./importIdentity");

const RECEIVER_COLLECTION = "importReceivingIdentities";
async function resolveImportRoute(db, { fromEmail, toEmails, subject }) {
  const recipients = [...new Set(toEmails.map(extractEmailAddress).filter(Boolean))];
  const bindings = await Promise.all(recipients.map(async (receiver) => {
    const id = receiverId(receiver);
    const snapshot = await db.doc(`${RECEIVER_COLLECTION}/${id}`).get();
    if (!snapshot.exists) return null;
    const data = snapshot.data();
    if (data.schemaVersion !== 1 || data.provider !== "resend" || data.receiver !== receiver || data.enabled !== true) return null;
    return { ...data, receiverId: id, hotelUid: requireSegment(data.hotelUid, "receiving hotel") };
  }));
  const owned = bindings.filter(Boolean);
  if (owned.length !== 1) {
    const error = new Error(owned.length ? "Ambiguous receiving identity" : "Unowned receiving identity");
    error.status = owned.length ? 409 : 404;
    throw error;
  }
  const binding = owned[0];
  const settings = await db.collection(`hotels/${binding.hotelUid}/fileImportSettings`).get();
  const matched = settings.docs.filter((snapshot) => {
    const setting = snapshot.data() || {};
    const pattern = String(setting.subjectContains || setting.subject || "").trim().toLowerCase();
    return setting.enabled !== false && pattern && extractEmailAddress(setting.fromEmail) === fromEmail
      && extractEmailAddress(setting.toEmail) === binding.receiver
      && (!setting.receiverId || setting.receiverId === binding.receiverId)
      && subject.includes(pattern);
  });
  if (matched.length !== 1) {
    const error = new Error(matched.length ? "Ambiguous file import settings" : "No matching owned file import setting");
    error.status = matched.length ? 409 : 404;
    throw error;
  }
  return { hotelUid: binding.hotelUid, receiver: binding.receiver, receiverId: binding.receiverId,
    settingId: matched[0].id, fileType: normalizeFileType(matched[0].data().fileType) };
}

// Receipts fence concurrent workers. An expired worker cannot finish after another
// attempt acquires its lease; deterministic external objects remain create-only.
async function claimReceipt(db, ref, descriptor, { now = Date.now(), leaseMs = 300000, initialData = {} } = {}) {
  const owner = randomUUID();
  const descriptorHash = stableId(descriptor);
  return db.runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    const existing = snapshot.exists ? snapshot.data() : null;
    if (existing && existing.descriptorHash !== descriptorHash) throw new Error("Import receipt identity conflict");
    if (existing?.state === "complete") return { state: "complete", descriptor: existing.descriptor, result: existing.result };
    if (existing?.leaseUntil > now) return { state: "busy" };
    tx.set(ref, { ...initialData, ...(existing || {}), schemaVersion: 1, descriptor, descriptorHash,
      state: "processing", owner, leaseUntil: now + leaseMs, updatedAt: now });
    return { state: "claimed", owner, descriptor, configuration: existing?.configuration || initialData.configuration };
  });
}
async function finishReceipt(db, ref, owner, result) {
  await db.runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    if (!snapshot.exists || snapshot.data().owner !== owner) throw new Error("Import receipt lease lost");
    tx.update(ref, { state: "complete", result, leaseUntil: 0, updatedAt: Date.now() });
  });
}
async function releaseReceipt(db, ref, owner) {
  await db.runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    if (snapshot.exists && snapshot.data().owner === owner && snapshot.data().state !== "complete") {
      tx.update(ref, { leaseUntil: 0, updatedAt: Date.now() });
    }
  });
}
module.exports = { PROJECTION_VERSION, RECEIVER_COLLECTION, stableId, receiverId, requireSegment,
  importProjectionId, syncImportProjection, resolveImportRoute, claimReceipt, finishReceipt, releaseReceipt };
