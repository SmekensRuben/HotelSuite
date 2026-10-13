const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { admin } = require("./config");
const { requireHotelPermission } = require("./authorization");
const { requireDocumentId } = require("./subscriptions");
const { requireSaasRollout, gated } = require("./saasRollout");
const { stateRef, sequence, checkpointId } = require("./inventoryMovements");
const { validTimeZone } = require("./hotelSetupPolicy");
const { localDate } = require("./importMonitoringPolicy");
const { isArchived } = require("./procurementResources");
const inventory = require("./inventoryPolicy");
const policy = require("./inventoryCostProposalPolicy");
const { validateManualPeriodEvidence } = require("./inventoryAdjustments");
const { receiptInventoryLines } = require("./orderReceiving");
const MAX_ANCHORS = 100;
const object = (value) => value && typeof value === "object" && !Array.isArray(value);
function input(value) {
  if (!object(value) || Object.keys(value).some((key) => !["hotelUid", "purpose", "stockCountId", "locationId", "catalogProductId", "businessDate"].includes(key))
    || !["stockcount", "movement"].includes(value.purpose)) throw new HttpsError("invalid-argument", "Unsupported inventory cost proposal request.");
  const result = { hotelUid: requireDocumentId(value.hotelUid, "hotelUid"), purpose: value.purpose,
    locationId: requireDocumentId(value.locationId, "locationId"), catalogProductId: requireDocumentId(value.catalogProductId, "catalogProductId") };
  if (value.purpose === "stockcount") {
    if (value.businessDate != null) throw new HttpsError("invalid-argument", "The frozen count supplies its own business date.");
    result.stockCountId = requireDocumentId(value.stockCountId, "stockCountId");
  } else {
    if (value.stockCountId != null) throw new HttpsError("invalid-argument", "A movement estimate cannot use an unrelated stock count target.");
    result.stockCountId = null; result.businessDate = inventory.businessDate(value.businessDate);
  }
  return result;
}
async function readMany(db, tx, paths) {
  const unique = [...new Set(paths)], results = new Map();
  const batches = [];
  for (let i = 0; i < unique.length; i += 100) batches.push(unique.slice(i, i + 100));
  for (let offset = 0; offset < batches.length; offset += 10) {
    const group = batches.slice(offset, offset + 10);
    const snapshots = await Promise.all(group.map((batch) => tx.getAll(...batch.map((path) => db.doc(path)))));
    group.forEach((batch, index) => batch.forEach((path, row) => results.set(path, snapshots[index][row])));
  }
  return results;
}
function lineView(item) {
  return [item.catalogProductId, item.baseUnit, item.quantity, item.netUnitCost, item.netValue, item.currency];
}
function sameLines(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length || [...left, ...right].some((line) => !object(line))) return false;
  return JSON.stringify(left.map(lineView).sort((a, b) => String(a[0]).localeCompare(String(b[0]))))
    === JSON.stringify(right.map(lineView).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
}
// Check frozen receipts against the accepted order event rather than treating an
// arbitrary sequence-shaped record as a goods purchase. All source paths remain
// inside this authorized hotel, and batches are capped by the movement window.
async function validateReceiptEvidence(db, tx, hotelUid, sources) {
  const receipts = sources.filter((source) => ["receipt", "reversal"].includes(source.kind));
  const movementPath = (id) => `hotels/${hotelUid}/inventoryMovements/${requireDocumentId(id, "Stored receipt movement ID")}`;
  const orderPath = (id) => `hotels/${hotelUid}/orders/${requireDocumentId(id, "Stored order ID")}`;
  const eventPath = (source) => `${orderPath(source.orderId)}/receipts/${requireDocumentId(source.receiptId, "Stored receipt ID")}`;
  const originals = await readMany(db, tx, receipts.filter((row) => row.kind === "reversal").flatMap((row) => [movementPath(row.originalMovementId),
    `hotels/${hotelUid}/inventoryReversals/${requireDocumentId(row.originalMovementId, "Stored original movement ID")}`]));
  const originalRows = receipts.map((row) => row.kind === "receipt" ? row : originals.get(movementPath(row.originalMovementId))?.data());
  if (originalRows.some((row) => !row || row.kind !== "receipt" || row.hotelUid !== hotelUid || row.inventoryPolicyVersion !== 1)) {
    throw new HttpsError("failed-precondition", "Original receipt evidence needs reconciliation.");
  }
  const snapshots = await readMany(db, tx, [...receipts.flatMap((row) => [orderPath(row.orderId), eventPath(row)]), ...originalRows.map(eventPath)]);
  function receiptSource(row) {
    const event = snapshots.get(eventPath(row))?.data(), order = snapshots.get(orderPath(row.orderId))?.data();
    if (!event || !order || event.kind !== "receipt" || event.policyVersion !== 1 || event.hotelUid !== hotelUid || event.orderId !== row.orderId
      || event.receivedOn !== row.receivedOn || event.inventoryMovement?.movementId !== row.id
      || event.inventoryMovement?.locationId !== row.locationId || event.inventoryMovement?.sequence !== row.sequence
      || event.inventoryMovement?.inventoryPolicyVersion !== 1 || !Array.isArray(event.lines) || event.lines.length > 100
      || event.lines.some((line) => !object(line) || typeof line.acceptedQuantity !== "number" || !Number.isFinite(line.acceptedQuantity) || line.acceptedQuantity < 0)
      || !Array.isArray(order.products) || order.products.length > 100 || order.products.some((line) => !object(line))) {
      throw new HttpsError("failed-precondition", "Accepted receipt source or frozen order evidence needs reconciliation.");
    }
    const expected = receiptInventoryLines(order.products, event.lines);
    if (!sameLines(row.lines, expected.lines) || JSON.stringify(row.coverageGaps || []) !== JSON.stringify(expected.coverageGaps)) {
      throw new HttpsError("failed-precondition", "Frozen receipt quantities or net values disagree with the accepted source event.");
    }
  }
  for (let index = 0; index < receipts.length; index++) {
    const row = receipts[index], original = originalRows[index];
    receiptSource(original);
    if (row.kind !== "reversal") continue;
    const event = snapshots.get(eventPath(row))?.data(), pointer = originals.get(`hotels/${hotelUid}/inventoryReversals/${row.originalMovementId}`)?.data();
    if (row.orderId !== original.orderId || row.locationId !== original.locationId || row.receivedOn !== original.receivedOn
      || row.sequence <= original.sequence || pointer?.movementId !== row.id || event?.kind !== "reversal" || event.policyVersion !== 1
      || event.hotelUid !== hotelUid || event.orderId !== row.orderId || event.receiptId !== original.receiptId
      || event.inventoryMovement?.movementId !== row.id || event.inventoryMovement?.locationId !== row.locationId
      || event.inventoryMovement?.sequence !== row.sequence || event.inventoryMovement?.inventoryPolicyVersion !== 1
      || !sameLines(row.lines, original.lines.map((line) => ({ ...line, quantity: -line.quantity,
        netValue: line.netValue == null ? null : -line.netValue })))
      || JSON.stringify(row.coverageGaps || []) !== JSON.stringify(original.coverageGaps || [])) {
      throw new HttpsError("failed-precondition", "A receipt reversal does not exactly compensate its immutable source.");
    }
  }
}
async function getHotelInventoryCostProposalHandler(request, services = {}) {
  const requested = input(request.data), { hotelUid, purpose, locationId, catalogProductId } = requested;
  const db = services.firestore || admin.firestore();
  return db.runTransaction(async (tx) => {
    const actor = { ...request };
    await requireHotelPermission(db, actor, hotelUid, "stockcounts", "read", tx, services.auth);
    await requireHotelPermission(db, actor, hotelUid, purpose === "stockcount" ? "stockcounts" : "inventorymovements",
      purpose === "stockcount" ? "update" : "create", tx, services.auth);
    await requireSaasRollout(db, tx);
    const root = `hotels/${hotelUid}`;
    const [hotelDoc, bootstrap, currentLocation, catalog, state] = await tx.getAll(db.doc(root), db.doc(`${root}/settings/bootstrap`),
      db.doc(`${root}/locations/${locationId}`), db.doc(`${root}/catalogproducts/${catalogProductId}`), stateRef(db, hotelUid, locationId));
    if (!hotelDoc.exists || !currentLocation.exists || !catalog.exists) throw new HttpsError("not-found", "The hotel, location or catalog article is unavailable in this hotel.");
    const hotel = hotelDoc.data(), asOfMillis = services.now?.() ?? Date.now();
    const reasons = [], issue = (code, detail) => reasons.push(policy.reason(code, detail));
    let currentSequence = null;
    try { currentSequence = sequence(state); } catch { issue("target-cutoff-unavailable", "The current location posting sequence needs reconciliation."); }
    let businessDate = requested.businessDate, currency = bootstrap.exists ? bootstrap.data().currency : hotel.currency;
    let baseUnit = catalog.data().baseUnit, postingCutoffSequence = currentSequence;
    if (purpose === "stockcount") {
      const countPath = `${root}/stockCounts/${requested.stockCountId}`;
      const [parent, location] = await tx.getAll(db.doc(countPath), db.doc(`${countPath}/locations/${locationId}`));
      if (!parent.exists || !location.exists || !Array.isArray(parent.data().locations)
        || !parent.data().locations.some((row) => row.locationId === locationId)) throw new HttpsError("not-found", "The count location is unavailable in this hotel.");
      const count = parent.data(), frozen = location.data();
      if (count.inventoryPolicyVersion !== 1 || frozen.inventoryPolicyVersion !== 1 || count.currency !== frozen.currency || count.businessDate !== frozen.businessDate
        || !["Started", "In Progress"].includes(count.status) || !["Not Started", "In Progress"].includes(frozen.status)) {
        throw new HttpsError("failed-precondition", "Cost suggestions require an unfinished catalog count with a consistent frozen snapshot.");
      }
      const items = frozen.stockTemplate?.items, counted = frozen.countedItems || [];
      if (!Array.isArray(items) || items.length > 250 || !Array.isArray(counted) || counted.length > 250) throw new HttpsError("failed-precondition", "Frozen count rows need reconciliation.");
      const rows = [...items, ...counted].filter((item) => item?.catalogProductId === catalogProductId);
      if (!rows.length) throw new HttpsError("not-found", "This article is not included in the actual frozen count.");
      baseUnit = rows[0].baseUnit; businessDate = count.businessDate;
      if (rows.some((row) => row.baseUnit !== baseUnit)) issue("target-unit-inconsistent", "Frozen count rows disagree about their unit.");
      if (currency !== count.currency) issue("target-currency-changed", "Current hotel currency differs from this count's frozen currency.");
      currency = count.currency; postingCutoffSequence = frozen.countingStartedSequence;
      if (!Number.isSafeInteger(postingCutoffSequence) || postingCutoffSequence < 0 || postingCutoffSequence > currentSequence) {
        issue("target-cutoff-unavailable", "The frozen physical counting cutoff is unavailable or inconsistent.");
      } else if (currentSequence !== postingCutoffSequence) issue("postings-during-count", "Inventory postings occurred after this count started; verify its physical cutoff before applying a cost.");
      if (catalog.data().baseUnit !== baseUnit) issue("target-unit-changed", "The current catalog unit differs from the frozen count unit.");
    } else if (isArchived(currentLocation.data()) || isArchived(catalog.data()) || catalog.data().inventoryTracked !== true) {
      issue("target-source-inactive", "A new movement needs an active physical location and tracked catalog article.");
    }
    if (bootstrap.exists && hotel.currency != null && hotel.currency !== bootstrap.data().currency) issue("hotel-currency-inconsistent", "Hotel currency settings disagree.");
    try { currency = inventory.currency(currency); } catch { currency = null; issue("target-currency-unknown", "An explicit target hotel currency is required."); }
    try { baseUnit = inventory.unit(baseUnit); } catch { baseUnit = null; issue("target-unit-unknown", "A supported target catalog unit is required."); }
    try { businessDate = inventory.businessDate(businessDate); } catch { issue("target-date-unknown", "The target business date is unavailable."); }
    if (!validTimeZone(hotel.timeZone)) issue("hotel-timezone-unknown", "Set a valid hotel time zone before using dated cost evidence.");
    else if (businessDate > localDate(asOfMillis, hotel.timeZone)) issue("future-business-date", "Future physical inventory dates cannot be valued from current recorded evidence.");
    const context = { ...requested, businessDate, currency, baseUnit, asOfMillis, postingCutoffSequence };
    if (reasons.length) return policy.unavailable(context, reasons);
    const checkpointRows = await tx.get(db.collection(`${root}/inventoryCheckpoints`).where("locationId", "==", locationId)
      .where("sequence", "<=", postingCutoffSequence).orderBy("sequence", "desc").limit(MAX_ANCHORS + 1));
    let anchor = null;
    for (const doc of checkpointRows.docs.slice(0, MAX_ANCHORS)) {
      const row = doc.data();
      if (row.stockCountId === requested.stockCountId || row.businessDate > businessDate) continue;
      anchor = { ...row, id: doc.id }; break;
    }
    if (!anchor) {
      if (checkpointRows.docs.length > MAX_ANCHORS) issue("opening-window-exceeded", "The latest eligible opening count is beyond the supported 100 checkpoint search window.");
      return policy.proposal(context, null, [], reasons);
    }
    try {
      requireDocumentId(anchor.stockCountId, "Stored opening count ID"); inventory.businessDate(anchor.businessDate);
      if (anchor.id !== checkpointId(anchor.stockCountId, locationId)) issue("opening-count-needs-reconciliation", "The opening checkpoint identity is inconsistent.");
    } catch { issue("opening-count-needs-reconciliation", "The latest eligible opening count identity or date is malformed."); return policy.proposal(context, anchor, [], reasons); }
    const [anchorCount, anchorLocation] = await tx.getAll(db.doc(`${root}/stockCounts/${anchor.stockCountId}`), db.doc(`${root}/stockCounts/${anchor.stockCountId}/locations/${locationId}`));
    if (anchorCount.data()?.status !== "Finished" || anchorLocation.data()?.status !== "Finished"
      || anchorCount.data()?.inventoryPolicyVersion !== 1 || anchorLocation.data()?.inventoryPolicyVersion !== 1
      || anchorLocation.data()?.checkpointId !== anchor.id || anchorLocation.data()?.checkpointSequence !== anchor.sequence
      || anchorCount.data()?.businessDate !== anchor.businessDate || anchorCount.data()?.currency !== anchor.currency
      || anchorLocation.data()?.businessDate !== anchor.businessDate || anchorLocation.data()?.currency !== anchor.currency) {
      issue("opening-count-not-finished", "The latest eligible physical opening count is not fully completed or its checkpoint needs reconciliation.");
    }
    const finishedItems = anchorLocation.data()?.countedItems;
    const checkpointItem = (row) => [row?.catalogProductId, row?.baseUnit, row?.quantity, row?.unitCost ?? null];
    if (!Array.isArray(finishedItems) || finishedItems.length > 250 || finishedItems.some((row) => row?.isCounted !== true)
      || !Array.isArray(anchor.items) || anchor.items.length > 250
      || JSON.stringify(finishedItems.map(checkpointItem).sort((a, b) => String(a[0]).localeCompare(String(b[0]))))
        !== JSON.stringify(anchor.items.map(checkpointItem).sort((a, b) => String(a[0]).localeCompare(String(b[0]))))) {
      issue("opening-count-needs-reconciliation", "The opening checkpoint quantities, units or costs disagree with the finished physical count.");
    }
    if (anchorLocation.data()?.countingStartedSequence !== anchor.sequence - 1) {
      issue("opening-cutoff-unreliable", "Inventory postings occurred while the opening physical count was in progress; reconcile its cutoff first.");
    }
    if (!Number.isSafeInteger(anchor.sequence) || anchor.sequence < 1 || postingCutoffSequence - anchor.sequence > policy.MAX_SOURCES) {
      issue("source-window-exceeded", "The complete posting reconciliation window exceeds 1,000 entries or has an invalid anchor."); return policy.proposal(context, anchor, [], reasons);
    }
    const [movementRows, intermediateRows, datedRows] = await Promise.all([
      tx.get(db.collection(`${root}/inventoryMovements`).where("locationId", "==", locationId).where("sequence", ">", anchor.sequence)
        .where("sequence", "<=", postingCutoffSequence).orderBy("sequence").limit(policy.MAX_SOURCES + 1)),
      tx.get(db.collection(`${root}/inventoryCheckpoints`).where("locationId", "==", locationId).where("sequence", ">", anchor.sequence)
        .where("sequence", "<=", postingCutoffSequence).orderBy("sequence").limit(policy.MAX_SOURCES + 1)),
      tx.get(db.collection(`${root}/inventoryMovements`).where("locationId", "==", locationId).where("receivedOn", ">=", anchor.businessDate)
        .where("receivedOn", "<=", businessDate).orderBy("receivedOn").limit(policy.MAX_SOURCES + 1)),
    ]);
    if ([movementRows, intermediateRows, datedRows].some((result) => result.docs.length > policy.MAX_SOURCES)) {
      issue("source-window-exceeded", "A complete source-date or posting window exceeds the supported 1,000 records."); return policy.proposal(context, anchor, [], reasons);
    }
    const sources = movementRows.docs.map((doc) => ({ ...doc.data(), id: doc.id }));
    if (intermediateRows.docs.some((doc) => doc.data().inventoryPolicyVersion !== 1 || doc.data().hotelUid !== hotelUid
      || doc.data().locationId !== locationId || !Number.isSafeInteger(doc.data().sequence))) {
      issue("checkpoint-sequence-unverified", "An intermediate checkpoint has inconsistent scope or policy.");
    }
    const sequences = [...sources, ...intermediateRows.docs.map((doc) => doc.data())].map((row) => row.sequence).sort((a, b) => a - b);
    if (sequences.length !== postingCutoffSequence - anchor.sequence || sequences.some((value, index) => value !== anchor.sequence + index + 1)) {
      issue("posting-sequence-incomplete", "The posting cutoff contains missing or duplicate inventory evidence.");
    }
    if (datedRows.docs.some((doc) => doc.data().inventoryPolicyVersion !== 1 || doc.data().hotelUid !== hotelUid || doc.data().locationId !== locationId
      || !Number.isSafeInteger(doc.data().sequence) || doc.data().sequence < 1)) {
      issue("source-date-evidence-unverified", "Relevant dated movement evidence has no valid posting sequence, policy or hotel scope.");
    }
    if (datedRows.docs.some((doc) => doc.data().sequence > postingCutoffSequence)) issue("late-posting-after-cutoff", "Relevant business-date evidence was posted after the selected physical cutoff.");
    if (sources.some((row) => row.receivedOn > localDate(asOfMillis, hotel.timeZone))) issue("future-source-date", "A recorded movement has a future physical business date that needs reconciliation.");
    const evidenceResults = await Promise.allSettled([validateReceiptEvidence(db, tx, hotelUid, sources), validateManualPeriodEvidence(db, tx, hotelUid, sources)]);
    for (const result of evidenceResults) {
      if (result.status !== "rejected") continue;
      const error = result.reason;
      if (!(error instanceof HttpsError) || !["failed-precondition", "invalid-argument"].includes(error.code)) throw error;
      issue("movement-source-unverified", "Immutable receipt or paired manual movement evidence needs reconciliation before suggesting a cost.");
    }
    return policy.proposal(context, anchor, sources, reasons);
  }, { readOnly: true });
}
module.exports = { MAX_ANCHORS, validateReceiptEvidence, getHotelInventoryCostProposalHandler,
  getHotelInventoryCostProposal: onCall({ region: "us-central1", cors: true, maxInstances: 5, concurrency: 8, timeoutSeconds: 120 }, gated(getHotelInventoryCostProposalHandler)) };
