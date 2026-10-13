const { HttpsError } = require("firebase-functions/v2/https");
const { admin } = require("./config");
const { requireHotelPermission } = require("./authorization");
const { requireDocumentId } = require("./subscriptions");
const { text, revision, digest } = require("./validation");
const { isArchived } = require("./procurementResources");

async function saveSupplierOutletAccountHandler(request, services = {}) {
  const db = services.firestore || admin.firestore(), input = request.data || {};
  const hotelUid = requireDocumentId(input.hotelUid, "hotelUid");
  const supplierId = requireDocumentId(input.supplierId, "supplierId");
  const outletId = requireDocumentId(input.outletId, "outletId");
  const accountNumber = text(input.accountNumber, "Account number", 100, true);
  const accountId = input.accountId === undefined ? null : requireDocumentId(input.accountId, "accountId");
  const expected = accountId ? revision(input.expectedRevision) : revision(input.expectedRevision ?? 0);
  if (!accountId && expected !== 0) throw new HttpsError("invalid-argument", "A new account must start at revision zero.");
  const requestId = input.requestId === undefined ? null : requireDocumentId(input.requestId, "requestId");
  if (input.expectedActorUid !== undefined && input.expectedActorUid !== request.auth?.uid) throw new HttpsError("permission-denied", "The signed-in account changed. Reload this view.");
  const ref = db.doc(`hotels/${hotelUid}/supplierOutletAccounts/${accountId || digest(supplierId, outletId)}`);
  const operationId = requestId ? digest(request.auth?.uid, requestId) : null;
  const operationRef = operationId ? db.doc(`hotels/${hotelUid}/supplierAccountOperations/${operationId}`) : null;
  const fingerprint = digest(accountId, supplierId, outletId, accountNumber, expected);
  const auditCollection = db.collection(`hotels/${hotelUid}/supplierAudit`);
  const auditRef = operationId ? auditCollection.doc(operationId) : auditCollection.doc();
  const stamp = () => admin.firestore.FieldValue.serverTimestamp();
  return db.runTransaction(async (tx) => {
    // Recheck current Auth, canonical membership and subscription on every retry and replay.
    await requireHotelPermission(db, { ...request }, hotelUid, "suppliers", "update", tx, services.auth);
    if (operationRef) {
      const receipt = await tx.get(operationRef);
      if (receipt.exists) {
        if (receipt.data().fingerprint !== fingerprint) throw new HttpsError("already-exists", "This request was already used for a different account change.");
        return receipt.data().result;
      }
    }
    const [supplier, outlet, target, existing] = await Promise.all([
      tx.get(db.doc(`hotels/${hotelUid}/suppliers/${supplierId}`)),
      tx.get(db.doc(`hotels/${hotelUid}/outlets/${outletId}`)), tx.get(ref),
      tx.get(db.collection(`hotels/${hotelUid}/supplierOutletAccounts`).where("supplierId", "==", supplierId).where("outletId", "==", outletId).limit(2)),
    ]);
    if (!supplier.exists || !outlet.exists) throw new HttpsError("not-found", "Choose a supplier and outlet belonging to this hotel.");
    if (isArchived(outlet.data())) throw new HttpsError("failed-precondition", "Choose an active outlet for this account assignment.");
    if (existing.size > 1) throw new HttpsError("failed-precondition", "Duplicate account assignments need review.");
    if (!accountId && (target.exists || existing.size)) throw new HttpsError("already-exists", "This supplier already has an account for this outlet. Edit that account instead.");
    if (accountId) {
      if (!target.exists) throw new HttpsError("not-found", "Supplier outlet account not found. Refresh the list.");
      if (target.data().supplierId !== supplierId || target.data().outletId !== outletId || existing.docs[0]?.id !== accountId) throw new HttpsError("failed-precondition", "The supplier or outlet assignment changed. Refresh the list.");
      const storedRevision = target.data().revision ?? 0;
      if (!Number.isSafeInteger(storedRevision) || storedRevision < 0) throw new HttpsError("failed-precondition", "This account's revision needs administrative review.");
      if (storedRevision !== expected) throw new HttpsError("aborted", "This account changed. Refresh the list and review the latest number before editing again.");
    }
    const result = { id: ref.id, revision: expected + 1 };
    const value = { supplierId, outletId, supplierName: supplier.data().name || supplierId,
      outletName: outlet.data().name || outletId, accountNumber, revision: result.revision,
      updatedAt: stamp(), updatedBy: request.auth.uid };
    if (accountId) tx.update(ref, value);
    else tx.create(ref, { ...value, createdAt: stamp(), createdBy: request.auth.uid });
    tx.create(auditRef, { action: accountId ? "outlet-account-updated" : "outlet-account-created", accountId: ref.id,
      supplierId, outletId, revision: result.revision, actorUid: request.auth.uid, createdAt: stamp() });
    if (operationRef) tx.create(operationRef, { fingerprint, result, actorUid: request.auth.uid, createdAt: stamp() });
    return result;
  });
}
module.exports = { saveSupplierOutletAccountHandler };
