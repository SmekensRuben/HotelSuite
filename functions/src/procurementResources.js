const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { admin } = require("./config");
const { requireHotelPermission } = require("./authorization");
const { requireDocumentId } = require("./subscriptions");
const { revision, digest } = require("./validation");
const { gated, requireSaasRollout } = require("./saasRollout");

const stamp = () => admin.firestore.FieldValue.serverTimestamp();
const isArchived = (resource) => resource?.archived === true || resource?.active === false;

// Retain resource identities, subcollections and historical snapshots. Archive
// removes a resource from new work without orphaning earlier orders/counts.
async function mutateHotelProcurementResourceHandler(request, services = {}) {
  const input = request.data || {};
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).some((key) => !["hotelUid", "collection", "resourceId", "action", "expectedRevision", "requestId"].includes(key))
    || !["locations", "outlets"].includes(input.collection) || input.action !== "archive") {
    throw new HttpsError("invalid-argument", "Unsupported procurement resource command.");
  }
  const hotelUid = requireDocumentId(input.hotelUid, "hotelUid");
  const resourceId = requireDocumentId(input.resourceId, "resourceId");
  const expectedRevision = revision(input.expectedRevision);
  const requestId = requireDocumentId(input.requestId, "requestId");
  const db = services.firestore || admin.firestore();
  const ref = db.doc(`hotels/${hotelUid}/${input.collection}/${resourceId}`);
  const operation = db.doc(`hotels/${hotelUid}/procurementResourceOperations/${digest(request.auth?.uid, requestId)}`);
  const audit = db.doc(`hotels/${hotelUid}/procurementResourceAudit/${digest(request.auth?.uid, requestId)}`);
  const fingerprint = digest(input);
  return db.runTransaction(async (tx) => {
    await requireHotelPermission(db, { ...request }, hotelUid, input.collection, "delete", tx, services.auth);
    await requireSaasRollout(db, tx);
    const previousOperation = await tx.get(operation);
    if (previousOperation.exists) {
      if (previousOperation.data().fingerprint !== fingerprint) {
        throw new HttpsError("already-exists", "This resource request ID was used for different details.");
      }
      return previousOperation.data().result;
    }
    try {
      const snapshot = await tx.get(ref);
      if (!snapshot.exists) throw new HttpsError("not-found", "This resource does not exist in the selected hotel.");
      const source = snapshot.data(), storedRevision = source.revision ?? 0;
      if (!Number.isSafeInteger(storedRevision) || storedRevision < 0 || storedRevision >= Number.MAX_SAFE_INTEGER) {
        throw new HttpsError("failed-precondition", "The resource revision needs review.");
      }
      if (expectedRevision !== storedRevision) throw new HttpsError("aborted", "This resource changed. Reload before archiving it.");
      if (isArchived(source)) throw new HttpsError("failed-precondition", "This resource is already archived.");
      const result = { hotelUid, collection: input.collection, resourceId, revision: storedRevision + 1, archived: true };
      tx.update(ref, { archived: true, active: false, resourcePolicyVersion: 1, revision: result.revision,
        archivedBy: request.auth.uid, archivedAt: stamp(), updatedBy: request.auth.uid, updatedAt: stamp() });
      tx.create(operation, { fingerprint, result, actorUid: request.auth.uid, createdAt: stamp() });
      tx.create(audit, { collection: input.collection, resourceId, action: "archive", actorUid: request.auth.uid,
        revision: result.revision, createdAt: stamp() });
      return result;
    } catch (error) {
      if (error instanceof HttpsError) throw new HttpsError(error.code, error.message, { resourceRequestUncommitted: true });
      throw error;
    }
  });
}

module.exports = { isArchived, mutateHotelProcurementResourceHandler,
  mutateHotelProcurementResource: onCall({ region: "us-central1", cors: true, timeoutSeconds: 120 }, gated(mutateHotelProcurementResourceHandler)) };
