const { HttpsError } = require("firebase-functions/v2/https");
const { admin } = require("./config");
const { requireDocumentId } = require("./subscriptions");
const { digest, text } = require("./validation");
const policy = require("./inventoryPolicy");
const stamp = () => admin.firestore.FieldValue.serverTimestamp();
const stateRef = (db, hotelUid, locationId) => db.doc(`hotels/${hotelUid}/inventoryLocationStates/${locationId}`);
function sequence(snapshot) {
  const value = snapshot.exists ? snapshot.data().sequence : 0;
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) throw new HttpsError("failed-precondition", "The inventory location sequence needs reconciliation.");
  return value;
}
async function readLocationSequence(db, tx, hotelUid, locationId) {
  return sequence(await tx.get(stateRef(db, hotelUid, locationId)));
}
function checkpointId(stockCountId, locationId) { return `c-${digest(stockCountId, locationId).slice(0, 48)}`; }
async function prepareCheckpoint(db, tx, input) {
  const { hotelUid, locationId, stockCountId } = input;
  const ref = db.doc(`hotels/${hotelUid}/inventoryCheckpoints/${checkpointId(stockCountId, locationId)}`);
  const [state, existing] = await Promise.all([tx.get(stateRef(db, hotelUid, locationId)), tx.get(ref)]);
  if (existing.exists) throw new HttpsError("failed-precondition", "This count checkpoint already exists. Reconcile the count before continuing.");
  const previous = sequence(state), next = previous + 1;
  if (state.data()?.latestCheckpointBusinessDate && input.businessDate < state.data().latestCheckpointBusinessDate) throw new HttpsError("failed-precondition", "A count checkpoint cannot precede the last finalized business date for this location.");
  const checkpoint = { id: ref.id || checkpointId(stockCountId, locationId), inventoryPolicyVersion: 1,
    hotelUid, locationId, stockCountId, stockCountName: input.stockCountName,
    businessDate: policy.businessDate(input.businessDate), currency: policy.currency(input.currency), sequence: next,
    items: input.items.map((item) => ({ catalogProductId: item.catalogProductId,
      catalogProductName: item.catalogProductName, baseUnit: policy.unit(item.baseUnit),
      quantity: policy.amount(item.quantity, "Checkpoint quantity"), unitCost: policy.cost(item.unitCost) })),
    coverageIssues: previous !== input.countingStartedSequence ? [{ code: "postings-during-count", detail: "Inventory postings occurred after this count was started; verify the physical counting cutoff." }] : [],
    actorUid: input.actorUid, finishedAt: stamp() };
  return { checkpointId: checkpoint.id, sequence: next, write: () => {
    tx.create(ref, checkpoint); tx.set(stateRef(db, hotelUid, locationId), { inventoryPolicyVersion: 1, sequence: next,
      latestCheckpointId: checkpoint.id, latestCheckpointBusinessDate: checkpoint.businessDate, updatedAt: stamp() }, { merge: true });
  } };
}
function normalizedLines(lines, direction = 1) {
  if (!Array.isArray(lines) || lines.length > 100) throw new HttpsError("invalid-argument", "Inventory receipts may contain at most 100 catalog lines.");
  return lines.map((item) => ({ catalogProductId: requireDocumentId(item.catalogProductId, "catalogProductId"),
    catalogProductName: text(item.catalogProductName || item.catalogProductId, "Catalog product name", 200, true),
    baseUnit: policy.unit(item.baseUnit), quantity: policy.amount(item.quantity, "Received base quantity", { maximum: 1000000000 }) * direction,
    netUnitCost: policy.cost(item.netUnitCost, "netUnitCost"),
    netValue: item.netValue == null ? null : policy.amount(item.netValue, "Receipt net value", { maximum: 1000000000 }) * direction,
    currency: item.currency == null ? null : policy.currency(item.currency) }));
}
async function prepareReceiptMovement(db, tx, input) {
  const hotelUid = requireDocumentId(input.hotelUid, "hotelUid"), locationId = requireDocumentId(input.locationId, "inventoryLocationId");
  const movementId = requireDocumentId(input.movementId, "movementId");
  const movementRef = db.doc(`hotels/${hotelUid}/inventoryMovements/${movementId}`);
  const [location, state, existing] = await Promise.all([
    tx.get(db.doc(`hotels/${hotelUid}/locations/${locationId}`)), tx.get(stateRef(db, hotelUid, locationId)), tx.get(movementRef),
  ]);
  if (!location.exists) throw new HttpsError("failed-precondition", "Choose an inventory location in this hotel.");
  if (existing.exists) throw new HttpsError("already-exists", "An inventory movement already exists for this receiving event.");
  const lines = normalizedLines(input.lines), next = sequence(state) + 1;
  if (!Array.isArray(input.coverageGaps || []) || (input.coverageGaps || []).length > 100) throw new HttpsError("invalid-argument", "Receipt coverage gaps exceed the supported bound.");
  const coverageGaps = (input.coverageGaps || []).map((gap) => ({ reason: text(gap.reason || gap.code || "Inventory metadata unavailable", "Coverage reason", 300, true),
    supplierProductId: gap.supplierProductId == null ? null : requireDocumentId(gap.supplierProductId, "supplierProductId") }));
  const receivedOn = policy.businessDate(input.receivedOn);
  const movement = { id: movementId, inventoryPolicyVersion: 1, kind: "receipt", hotelUid, locationId,
    orderId: requireDocumentId(input.orderId, "orderId"), receiptId: requireDocumentId(input.receiptId, "receiptId"),
    receivedOn, sequence: next, actorUid: input.actorUid, lines, coverageGaps,
    backdatedAgainstCheckpoint: Boolean(state.data()?.latestCheckpointBusinessDate && receivedOn <= state.data().latestCheckpointBusinessDate),
    postedAt: stamp() };
  return { movementId, locationId, sequence: next, inventoryPolicyVersion: 1, write: () => {
    tx.create(movementRef, movement);
    tx.set(stateRef(db, hotelUid, locationId), { inventoryPolicyVersion: 1, sequence: next, updatedAt: stamp() }, { merge: true });
  } };
}
async function prepareReversalMovement(db, tx, input) {
  const hotelUid = requireDocumentId(input.hotelUid, "hotelUid"), movementId = requireDocumentId(input.movementId, "movementId");
  const originalMovementId = requireDocumentId(input.originalMovementId, "originalMovementId");
  const originalRef = db.doc(`hotels/${hotelUid}/inventoryMovements/${originalMovementId}`);
  const original = await tx.get(originalRef);
  if (!original.exists || original.data().kind !== "receipt" || original.data().inventoryPolicyVersion !== 1) throw new HttpsError("failed-precondition", "The original inventory receipt is missing or needs reconciliation.");
  const data = original.data();
  if (data.hotelUid !== hotelUid || data.orderId !== input.orderId) throw new HttpsError("failed-precondition", "Inventory reversal scope does not match the original order.");
  const locationId = requireDocumentId(data.locationId, "Stored locationId");
  const reversedRef = db.doc(`hotels/${hotelUid}/inventoryReversals/${originalMovementId}`);
  const movementRef = db.doc(`hotels/${hotelUid}/inventoryMovements/${movementId}`);
  const [state, reversed, existing] = await Promise.all([tx.get(stateRef(db, hotelUid, locationId)), tx.get(reversedRef), tx.get(movementRef)]);
  if (reversed.exists || existing.exists) throw new HttpsError("already-exists", "This inventory receipt has already been reversed.");
  const next = sequence(state) + 1;
  const reversal = { ...data, id: movementId, kind: "reversal", originalMovementId,
    receiptId: input.receiptId || movementId, actorUid: input.actorUid, sequence: next, postedAt: stamp(),
    backdatedAgainstCheckpoint: Boolean(state.data()?.latestCheckpointBusinessDate && data.receivedOn <= state.data().latestCheckpointBusinessDate),
    lines: normalizedLines(data.lines, -1), coverageGaps: data.coverageGaps || [] };
  return { movementId, locationId, sequence: next, inventoryPolicyVersion: 1, write: () => {
    tx.create(movementRef, reversal); tx.create(reversedRef, { movementId, postedAt: stamp() });
    tx.set(stateRef(db, hotelUid, locationId), { inventoryPolicyVersion: 1, sequence: next, updatedAt: stamp() }, { merge: true });
  } };
}
module.exports = { readLocationSequence, checkpointId, prepareCheckpoint, prepareReceiptMovement, prepareReversalMovement };
