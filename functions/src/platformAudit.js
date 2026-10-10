const { admin } = require("./config");
const { digest } = require("./validation");

// Audit is server-written metadata, never a copy of a request or customer record.
function writePlatformAudit(tx, db, { key, hotelUid, actorUid, action, targetId = null, revision = null }) {
  const id = digest(action, hotelUid, actorUid, key);
  const event = {
    schemaVersion: 1, hotelUid, actorUid, action, targetId, revision,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + 90 * 86400000),
  };
  tx.create(db.doc(`platformAudit/${id}`), event);
  if (hotelUid) tx.create(db.doc(`hotels/${hotelUid}/platformAudit/${id}`), event);
}

module.exports = { writePlatformAudit };
