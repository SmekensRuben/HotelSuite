const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { admin } = require("./config");
const { requireHotelPermission } = require("./authorization");
const { requireDocumentId, requireHotelSubscription } = require("./subscriptions");
const { gated, enforceRequestRollout } = require("./saasRollout");
const { digest } = require("./validation");
const { checkpointId } = require("./inventoryMovements");
const policy = require("./inventoryPolicy");
const MAX_MOVEMENTS = 1000;
function inputObject(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !fields.includes(key))) throw new HttpsError("invalid-argument", "Unsupported inventory report input.");
  return value;
}
async function authorize(db, tx, request, hotelUid, services) {
  await requireHotelPermission(db, { ...request }, hotelUid, "stockcounts", "read", tx, services.auth);
  await requireHotelSubscription(db, hotelUid, tx, "procurement");
  await enforceRequestRollout(db, request, tx);
}
function checkpointView(snapshot) {
  const row = snapshot.data();
  return { id: snapshot.id, stockCountId: row.stockCountId, stockCountName: row.stockCountName,
    businessDate: row.businessDate, sequence: row.sequence, currency: row.currency,
    coverageIssues: row.coverageIssues || [], finishedAtMillis: row.finishedAt?.toMillis?.() ?? null };
}
async function listHotelInventoryLocationsHandler(request, services = {}) {
  const input = inputObject(request.data, ["hotelUid", "afterLocationId"]), hotelUid = requireDocumentId(input.hotelUid, "hotelUid");
  const db = services.firestore || admin.firestore();
  return db.runTransaction(async (tx) => {
    await authorize(db, tx, request, hotelUid, services);
    let query = db.collection(`hotels/${hotelUid}/locations`).orderBy(admin.firestore.FieldPath.documentId());
    if (input.afterLocationId != null) query = query.startAfter(requireDocumentId(input.afterLocationId, "afterLocationId"));
    const snapshot = await tx.get(query.limit(51)), page = snapshot.docs.slice(0, 50);
    return { hotelUid, locations: page.map((doc) => ({ id: doc.id, locationId: doc.id, name: typeof doc.data().name === "string" ? doc.data().name.slice(0, 200) : doc.id })),
      nextCursor: snapshot.docs.length > 50 ? page.at(-1).id : null };
  }, { readOnly: true });
}
async function listHotelInventoryCheckpointsHandler(request, services = {}) {
  const input = inputObject(request.data, ["hotelUid", "locationId", "afterCheckpointId"]);
  const hotelUid = requireDocumentId(input.hotelUid, "hotelUid"), locationId = requireDocumentId(input.locationId, "locationId");
  const db = services.firestore || admin.firestore();
  return db.runTransaction(async (tx) => {
    await authorize(db, tx, request, hotelUid, services);
    let query = db.collection(`hotels/${hotelUid}/inventoryCheckpoints`).where("locationId", "==", locationId).orderBy("sequence", "desc");
    if (input.afterCheckpointId != null) {
      const after = await tx.get(db.doc(`hotels/${hotelUid}/inventoryCheckpoints/${requireDocumentId(input.afterCheckpointId, "afterCheckpointId")}`));
      if (!after.exists || after.data().locationId !== locationId) throw new HttpsError("invalid-argument", "The inventory checkpoint cursor has a different location.");
      query = query.startAfter(after);
    }
    const snapshot = await tx.get(query.limit(26)), page = snapshot.docs.slice(0, 25);
    const parents = await Promise.all(page.map((item) => tx.get(db.doc(`hotels/${hotelUid}/stockCounts/${item.data().stockCountId}`))));
    return { hotelUid, locationId, checkpoints: page.filter((item, index) => item.data().inventoryPolicyVersion === 1 && parents[index].data()?.status === "Finished").map(checkpointView),
      nextCursor: snapshot.docs.length > 25 ? page.at(-1).id : null };
  }, { readOnly: true });
}
async function getHotelInventoryPeriodHandler(request, services = {}) {
  const input = inputObject(request.data, ["hotelUid", "locationId", "openingStockCountId", "closingStockCountId"]);
  const hotelUid = requireDocumentId(input.hotelUid, "hotelUid"), locationId = requireDocumentId(input.locationId, "locationId");
  const openingId = requireDocumentId(input.openingStockCountId, "openingStockCountId"), closingId = requireDocumentId(input.closingStockCountId, "closingStockCountId");
  if (openingId === closingId) throw new HttpsError("invalid-argument", "Choose two different finished stock counts.");
  const db = services.firestore || admin.firestore();
  const reportRef = db.doc(`hotels/${hotelUid}/inventoryPeriodReports/p-${digest(locationId, openingId, closingId, 1).slice(0, 48)}`);
  return db.runTransaction(async (tx) => {
    await authorize(db, tx, request, hotelUid, services);
    const [openingDoc, closingDoc, openingCount, closingCount, prior] = await Promise.all([
      tx.get(db.doc(`hotels/${hotelUid}/inventoryCheckpoints/${checkpointId(openingId, locationId)}`)),
      tx.get(db.doc(`hotels/${hotelUid}/inventoryCheckpoints/${checkpointId(closingId, locationId)}`)),
      tx.get(db.doc(`hotels/${hotelUid}/stockCounts/${openingId}`)), tx.get(db.doc(`hotels/${hotelUid}/stockCounts/${closingId}`)), tx.get(reportRef),
    ]);
    if (!openingDoc.exists || !closingDoc.exists || openingCount.data()?.status !== "Finished" || closingCount.data()?.status !== "Finished") throw new HttpsError("failed-precondition", "Period reports require two finished catalog counts. Historical supplier counts are not silently converted.");
    const opening = openingDoc.data(), closing = closingDoc.data();
    if (opening.inventoryPolicyVersion !== 1 || closing.inventoryPolicyVersion !== 1 || opening.hotelUid !== hotelUid || closing.hotelUid !== hotelUid
      || opening.locationId !== locationId || closing.locationId !== locationId) throw new HttpsError("failed-precondition", "Checkpoint scope needs reconciliation.");
    // A separate bounded source-date query exposes late postings without changing
    // the immutable posting-sequence calculation saved for this period.
    const late = await tx.get(db.collection(`hotels/${hotelUid}/inventoryMovements`).where("locationId", "==", locationId)
      .where("receivedOn", ">=", opening.businessDate).where("receivedOn", "<=", closing.businessDate).orderBy("receivedOn").limit(MAX_MOVEMENTS + 1));
    if (late.docs.length > MAX_MOVEMENTS) throw new HttpsError("resource-exhausted", "This source-date window exceeds 1,000 inventory postings. The report is unavailable rather than truncated.");
    const postClosureIssues = late.docs.filter((doc) => doc.data().sequence > closing.sequence).map((doc) => ({ code: "late-posting-after-closing", detail: doc.id }));
    let result;
    if (prior.exists) {
      result = prior.data();
      if (result.inventoryPolicyVersion !== 1 || result.hotelUid !== hotelUid || result.locationId !== locationId
        || result.opening?.stockCountId !== openingId || result.closing?.stockCountId !== closingId || result.currency !== opening.currency
        || !Array.isArray(result.items) || !result.coverage) throw new HttpsError("failed-precondition", "The saved inventory report needs reconciliation.");
    }
    else {
      const movementSnapshot = await tx.get(db.collection(`hotels/${hotelUid}/inventoryMovements`).where("locationId", "==", locationId)
        .where("sequence", ">", opening.sequence).where("sequence", "<", closing.sequence).orderBy("sequence").limit(MAX_MOVEMENTS + 1));
      if (movementSnapshot.docs.length > MAX_MOVEMENTS) throw new HttpsError("resource-exhausted", "This period exceeds 1,000 inventory postings. The report is unavailable rather than truncated.");
      const intermediateCheckpoints = await tx.get(db.collection(`hotels/${hotelUid}/inventoryCheckpoints`).where("locationId", "==", locationId)
        .where("sequence", ">", opening.sequence).where("sequence", "<", closing.sequence).orderBy("sequence").limit(MAX_MOVEMENTS + 1));
      if (intermediateCheckpoints.docs.length > MAX_MOVEMENTS || closing.sequence - opening.sequence > MAX_MOVEMENTS + 1) throw new HttpsError("resource-exhausted", "This period exceeds the supported posting reconciliation window.");
      const sequences = [...movementSnapshot.docs, ...intermediateCheckpoints.docs].map((doc) => doc.data().sequence).sort((a, b) => a - b);
      if (sequences.length !== closing.sequence - opening.sequence - 1 || sequences.some((value, index) => value !== opening.sequence + index + 1)) throw new HttpsError("failed-precondition", "Inventory posting sequence has missing or duplicate evidence. Reconcile before using this report.");
      const calculated = policy.period(opening, closing, movementSnapshot.docs.map((doc) => ({ ...doc.data(), id: doc.id })));
      result = { id: reportRef.id, inventoryPolicyVersion: 1, hotelUid, locationId, currency: opening.currency,
        opening: checkpointView(openingDoc), closing: checkpointView(closingDoc), ...calculated,
        recordedReceiptCount: movementSnapshot.docs.length, computedAtMillis: services.now?.() ?? Date.now(),
        movementIds: movementSnapshot.docs.map((doc) => doc.id), intermediateCheckpointIds: intermediateCheckpoints.docs.map((doc) => doc.id),
        costBasis: "Period estimate from explicit opening costs and frozen net order prices; not invoice cost or live on-hand stock." };
      if (Buffer.byteLength(JSON.stringify(result), "utf8") > 750000) throw new HttpsError("resource-exhausted", "The period report exceeds the supported snapshot size.");
      tx.create(reportRef, result);
    }
    return { ...result, postClosureIssues, currentlyComplete: result.coverage.quantityComplete && postClosureIssues.length === 0 };
  });
}
const options = { region: "us-central1", cors: true, maxInstances: 5, concurrency: 8, timeoutSeconds: 120 };
module.exports = { listHotelInventoryLocationsHandler, listHotelInventoryCheckpointsHandler, getHotelInventoryPeriodHandler,
  listHotelInventoryLocations: onCall(options, gated(listHotelInventoryLocationsHandler)),
  listHotelInventoryCheckpoints: onCall(options, gated(listHotelInventoryCheckpointsHandler)),
  getHotelInventoryPeriod: onCall(options, gated(getHotelInventoryPeriodHandler)) };
