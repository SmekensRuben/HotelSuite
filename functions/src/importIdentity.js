const { createHash } = require("node:crypto");
function canonicalValue(value) {
  if (value && typeof value.toJSON === "function") return canonicalValue(value.toJSON());
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  return value;
}
function stableId(...parts) {
  return createHash("sha256").update(JSON.stringify(canonicalValue(parts))).digest("hex");
}
function requireSegment(value, label) {
  if (typeof value !== "string" || !value || value.length > 128 || /[\/\u0000-\u001f]/.test(value) || [".", ".."].includes(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}
function normalizeReceiver(receiver) {
  if (typeof receiver !== "string") throw new Error("Invalid receiving email address");
  const normalized = receiver.trim().toLowerCase();
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(normalized)) throw new Error("Invalid receiving email address");
  return normalized;
}
function receiverId(receiver) { return stableId("resend", normalizeReceiver(receiver)); }
function importProjectionId(hotelUid, localId) {
  return stableId(requireSegment(hotelUid, "hotelUid"), requireSegment(localId, "import source ID"));
}
const PROJECTION_VERSION = 2;
// Always reread the authoritative source in the same transaction as the projection.
// A delayed create/update/delete event must reflect today's source, never its stale payload.
async function syncImportProjection(db, { hotelUid, localId, sourceCollection, indexCollection }) {
  const sourcePath = `hotels/${requireSegment(hotelUid, "hotelUid")}/${sourceCollection}/${requireSegment(localId, "import source ID")}`;
  const sourceRef = db.doc(sourcePath);
  const indexRef = db.doc(`${indexCollection}/${importProjectionId(hotelUid, localId)}`);
  return db.runTransaction(async (tx) => {
    const [source, projection] = await Promise.all([tx.get(sourceRef), tx.get(indexRef)]);
    if (projection.exists && (projection.data().sourcePath !== sourcePath || projection.data().hotelUid !== hotelUid)) {
      throw new Error("Import projection ownership mismatch");
    }
    if (!source.exists) {
      if (projection.exists) tx.delete(indexRef);
      return;
    }
    tx.set(indexRef, { ...source.data(), id: localId, hotelUid, sourcePath,
      projectionVersion: PROJECTION_VERSION, sourceUpdateTime: source.updateTime || null });
  });
}

module.exports = { syncImportProjection, PROJECTION_VERSION, stableId, requireSegment, normalizeReceiver, receiverId, importProjectionId };
