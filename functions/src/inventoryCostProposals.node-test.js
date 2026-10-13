const test = require("node:test"), assert = require("node:assert/strict");
const { memoryDatabase } = require("./inventoryTestHelpers");
const { checkpointId } = require("./inventoryMovements");
const { getHotelInventoryCostProposalHandler: handler } = require("./inventoryCostProposals");
const { recordHotelOrderReceiptHandler: receive, reverseHotelOrderReceiptHandler: reverseReceipt } = require("./orderReceiving");
const { recordHotelInventoryAdjustmentHandler: record, reverseHotelInventoryAdjustmentHandler: reverseManual } = require("./inventoryAdjustments");
const HOTEL = "hotel-a", ROOT = `hotels/${HOTEL}`, NOW = Date.parse("2026-10-12T12:00:00Z");
const permissions = ["stockcounts.read", "stockcounts.update", "inventorymovements.create", "inventorymovements.reverse", "orders.receive", "orders.finalize"];
const request = (data, uid = "operator") => ({ auth: { uid, token: { email_verified: true } }, data });
const svc = (db, patch = {}) => ({ firestore: db, auth: { getUser: async () => ({ emailVerified: true, disabled: false }) }, now: () => NOW, ...patch });
const proposalInput = (patch = {}) => ({ hotelUid: HOTEL, purpose: "movement", locationId: "store", catalogProductId: "juice", businessDate: "2026-10-12", ...patch });
const load = (db, patch = {}, services = {}) => handler(request(proposalInput(patch)), svc(db, services));
function checkpoint(db, id = "opening", { date = "2026-10-01", seq = 1, quantity = 10, cost = 2 } = {}) {
  const checkpoint = { id: checkpointId(id, "store"), hotelUid: HOTEL, locationId: "store", stockCountId: id, inventoryPolicyVersion: 1,
    sequence: seq, businessDate: date, currency: "EUR", coverageIssues: [],
    items: [{ catalogProductId: "juice", catalogProductName: "Juice", baseUnit: "l", quantity, unitCost: cost }] };
  db.records.set(`${ROOT}/inventoryCheckpoints/${checkpoint.id}`, checkpoint);
  db.records.set(`${ROOT}/stockCounts/${id}`, { inventoryPolicyVersion: 1, status: "Finished", businessDate: date, currency: "EUR", locations: [{ locationId: "store" }] });
  db.records.set(`${ROOT}/stockCounts/${id}/locations/store`, { inventoryPolicyVersion: 1, status: "Finished", businessDate: date,
    currency: "EUR", checkpointId: checkpoint.id, checkpointSequence: seq, countingStartedSequence: seq - 1,
    countedItems: checkpoint.items.map((item) => ({ ...item, isCounted: true })) });
  db.records.set(`${ROOT}/inventoryLocationStates/store`, { inventoryPolicyVersion: 1, sequence: seq, latestCheckpointBusinessDate: date, latestCheckpointId: checkpoint.id });
  return checkpoint;
}
function fixture() {
  const db = memoryDatabase({
    [ROOT]: { currency: "EUR", timeZone: "Europe/Brussels" }, [`${ROOT}/members/operator`]: { permissions },
    [`hotelSubscriptions/${HOTEL}`]: { status: "active", modules: ["procurement"], modulePolicyVersion: 1 },
    "platformConfiguration/saasProcurement": { enabled: true, rulesVersion: require("./platformReleasePolicy.json").saasRulesVersion },
    [`${ROOT}/locations/store`]: { name: "Store" }, [`${ROOT}/locations/bar`]: { name: "Bar" },
    [`${ROOT}/catalogproducts/juice`]: { name: "Juice", baseUnit: "l", active: true, inventoryTracked: true },
    [`${ROOT}/orders/order`]: { status: "Ordered", dispatchStatus: "sent", revision: 0, products: [{ supplierProductId: "offer", purchaseUnit: "Case",
      qtyPurchaseUnits: 20, supplierProductName: "Juice case", netPricePerPurchaseUnit: 3,
      inventoryTerms: { inventoryPolicyVersion: 1, inventoryTracked: true, catalogProductId: "juice", catalogProductName: "Juice",
        catalogBaseUnit: "l", catalogUnitsPerPurchaseUnit: 1, netUnitCost: 3, currency: "EUR" } }] },
  }); checkpoint(db); return db;
}
async function receipt(db, patch = {}) {
  return receive(request({ hotelUid: HOTEL, orderId: "order", requestId: "receipt", expectedRevision: 0, receivedOn: "2026-10-05",
    deliveryReference: "Delivery 1", note: "Received goods", inventoryLocationId: "store", lines: [{ supplierProductId: "offer", acceptedQuantity: 20, rejectedQuantity: 0 }], ...patch }), svc(db));
}
function countTarget(db) {
  const sequence = db.records.get(`${ROOT}/inventoryLocationStates/store`).sequence;
  db.records.set(`${ROOT}/stockCounts/target`, { inventoryPolicyVersion: 1, status: "Started", businessDate: "2026-10-12", currency: "EUR", locations: [{ locationId: "store" }] });
  db.records.set(`${ROOT}/stockCounts/target/locations/store`, { inventoryPolicyVersion: 1, status: "Not Started", businessDate: "2026-10-12",
    currency: "EUR", countingStartedSequence: sequence, countedItems: [], stockTemplate: { items: [{ catalogProductId: "juice", baseUnit: "l" }] } });
}
const unknown = (result, code) => { assert.equal(result.status, "unavailable"); assert.equal(result.netUnitCost, null); assert(result.reasons.some((row) => row.code === code), JSON.stringify(result.reasons)); };

test("genuine accepted receipt and finished physical count suggest 80/30 read-only without supplier-directory access", async () => {
  const db = fixture(); await receipt(db); const before = JSON.stringify([...db.records]);
  const result = await load(db); assert.equal(result.netUnitCost, 2.666667); assert.equal(result.source.weightedSourceNetValue, 80);
  assert.equal(result.source.weightedSourceQuantity, 30); assert.equal(result.source.postingCutoffSequence, 2);
  assert.equal(JSON.stringify([...db.records]), before); assert.deepEqual(await load(db), result);
  countTarget(db); assert.equal((await load(db, { purpose: "stockcount", stockCountId: "target", businessDate: null })).netUnitCost, 2.666667);
});
test("normal membership, monetary read scope, action, current Auth, license, hotel and Rules are enforced", async () => {
  for (const rights of [[], ["inventorymovements.create"], ["stockcounts.read"], ["orders.read", "catalogproducts.read"]]) {
    const db = fixture(); db.records.set(`${ROOT}/members/operator`, { permissions: rights }); await assert.rejects(load(db), { code: "permission-denied" });
  }
  const db = fixture(); countTarget(db); db.records.set(`${ROOT}/members/operator`, { permissions: ["stockcounts.read", "inventorymovements.create"] });
  await assert.rejects(load(db, { purpose: "stockcount", stockCountId: "target", businessDate: null }), { code: "permission-denied" });
  await assert.rejects(load(fixture(), { hotelUid: "hotel-b" }), { code: "permission-denied" });
  await assert.rejects(load(fixture(), {}, { auth: { getUser: async () => ({ emailVerified: true, disabled: true }) } }), { code: "permission-denied" });
  for (const path of ["hotelSubscriptions/hotel-a", "platformConfiguration/saasProcurement"]) {
    const db = fixture(); db.records.set(path, path.startsWith("hotelSubscriptions") ? { status: "suspended", modules: ["procurement"], modulePolicyVersion: 1 } : { enabled: false });
    await assert.rejects(load(db), (error) => ["permission-denied", "failed-precondition"].includes(error.code));
  }
});
test("actual transaction retries recheck current Auth instead of retaining the first attempt's actor cache", async () => {
  const db = fixture(), execute = db.runTransaction.bind(db); let disabled = false, calls = 0;
  db.runTransaction = async (fn) => { await execute(fn); disabled = true; return execute(fn); };
  await assert.rejects(load(db, {}, { auth: { getUser: async () => { calls++; return { emailVerified: true, disabled }; } } }), { code: "permission-denied" });
  assert.equal(calls, 2);
});
test("new count proposals use their real frozen row, date and cutoff, never arbitrary rows or finished targets", async () => {
  const db = fixture(); countTarget(db);
  for (const patch of [{ stockCountId: "missing" }, { locationId: "bar" }, { catalogProductId: "missing" }]) {
    await assert.rejects(load(db, { purpose: "stockcount", stockCountId: "target", businessDate: null, ...patch }), { code: "not-found" });
  }
  await assert.rejects(load(db, { purpose: "stockcount", stockCountId: "target", businessDate: "2026-10-12" }), { code: "invalid-argument" });
  db.records.get(`${ROOT}/stockCounts/target`).status = "Finished";
  await assert.rejects(load(db, { purpose: "stockcount", stockCountId: "target", businessDate: null }), { code: "failed-precondition" });
});
test("postings while the current physical count is in progress make its estimate unavailable", async () => {
  const db = fixture(); countTarget(db); await receipt(db);
  unknown(await load(db, { purpose: "stockcount", stockCountId: "target", businessDate: null }), "postings-during-count");
});
test("the latest eligible checkpoint is not skipped for an older known cost or a missing target item", async () => {
  const db = fixture(); checkpoint(db, "latest", { date: "2026-10-10", seq: 2, cost: null });
  unknown(await load(db), "opening-cost-unknown");
  const anchor = db.records.get(`${ROOT}/inventoryCheckpoints/${checkpointId("latest", "store")}`);
  anchor.items = [{ ...anchor.items[0], catalogProductId: "other" }];
  db.records.get(`${ROOT}/stockCounts/latest/locations/store`).countedItems = anchor.items.map((row) => ({ ...row, isCounted: true }));
  unknown(await load(db), "opening-product-missing");
});
test("opening physical snapshot, completion status and posting cutoff are reconciled independently", async () => {
  for (const tamper of [
    (db) => { db.records.get(`${ROOT}/stockCounts/opening`).status = "In Progress"; },
    (db) => { db.records.get(`${ROOT}/stockCounts/opening/locations/store`).countedItems[0].quantity = 999; },
    (db) => { db.records.get(`${ROOT}/stockCounts/opening/locations/store`).countedItems[0].unitCost = 999; },
    (db) => { db.records.get(`${ROOT}/stockCounts/opening/locations/store`).countedItems[0].isCounted = false; },
    (db) => { db.records.get(`${ROOT}/stockCounts/opening/locations/store`).countingStartedSequence = 5; },
  ]) { const db = fixture(); tamper(db); assert.equal((await load(db)).available, false); }
});
test("receipt net values, pointers and reversals must match the genuine accepted frozen source", async () => {
  const db = fixture(), event = await receipt(db), path = `${ROOT}/inventoryMovements/${event.eventId}`;
  db.records.get(path).lines[0].netValue = 600; unknown(await load(db), "movement-source-unverified");
  const missing = fixture(), accepted = await receipt(missing); missing.records.delete(`${ROOT}/orders/order/receipts/${accepted.eventId}`);
  unknown(await load(missing), "movement-source-unverified");
  const reversed = fixture(), original = await receipt(reversed);
  await reverseReceipt(request({ hotelUid: HOTEL, orderId: "order", requestId: "reverse", expectedRevision: 1, receiptId: original.eventId, reason: "Wrong delivery" }), svc(reversed));
  const result = await load(reversed); assert.equal(result.netUnitCost, 2); assert.equal(result.source.recordedMovementQuantity, 0); assert.equal(result.source.recordedMovementNetValue, 0);
});
test("malformed frozen receipt or order rows produce an explicit unavailable analysis", async () => {
  for (const tamper of [
    (db, id) => { db.records.get(`${ROOT}/inventoryMovements/${id}`).lines = [null]; },
    (db, id) => { db.records.get(`${ROOT}/orders/order/receipts/${id}`).lines = [null]; },
    (db) => { db.records.get(`${ROOT}/orders/order`).products = [null]; },
  ]) {
    const db = fixture(), event = await receipt(db); tamper(db, event.eventId);
    unknown(await load(db), "movement-source-unverified");
  }
});
test("manual signed pool changes 80/30 to 74/28, exact reversal restores it and missing opposite transfer evidence blocks", async () => {
  const db = fixture(); await receipt(db);
  const adjustment = await record(request({ hotelUid: HOTEL, expectedActorUid: "operator", requestId: "waste", kind: "waste", reasonType: "waste",
    catalogProductId: "juice", quantity: 2, sourceLocationId: "store", destinationLocationId: null, businessDate: "2026-10-06", note: "Spoiled goods", reference: "Waste 1", netUnitCost: 3, currency: "EUR" }), svc(db));
  const result = await load(db); assert.equal(result.source.weightedSourceQuantity, 28); assert.equal(result.source.weightedSourceNetValue, 74); assert.equal(result.netUnitCost, 2.642857);
  await reverseManual(request({ hotelUid: HOTEL, expectedActorUid: "operator", requestId: "reverse-waste", adjustmentId: adjustment.adjustmentId,
    businessDate: "2026-10-07", note: "Entered in error", reference: "Correction" }), svc(db));
  assert.equal((await load(db)).netUnitCost, 2.666667);
  const transfer = await record(request({ hotelUid: HOTEL, expectedActorUid: "operator", requestId: "transfer", kind: "transfer", catalogProductId: "juice",
    quantity: 2, sourceLocationId: "store", destinationLocationId: "bar", businessDate: "2026-10-08", note: "Moved goods", reference: "Transfer", netUnitCost: 3, currency: "EUR" }), svc(db));
  assert.equal((await load(db)).netUnitCost, 2.642857);
  db.records.delete(`${ROOT}/inventoryMovements/${transfer.movementIds[1]}`); unknown(await load(db), "movement-source-unverified");
});
test("unknown manual costs remain unknown; no supplier current-price or live-balance fallback is invented", async () => {
  const db = fixture(); await record(request({ hotelUid: HOTEL, expectedActorUid: "operator", requestId: "waste", kind: "waste", reasonType: "breakage", catalogProductId: "juice",
    quantity: 1, sourceLocationId: "store", destinationLocationId: null, businessDate: "2026-10-06", note: "Broken", reference: "Breakage", netUnitCost: null, currency: null }), svc(db));
  unknown(await load(db), "movement-cost-unknown");
});
test("source dates, currencies, units and time zones are not guessed at horizon boundaries", async () => {
  const db = fixture(); await receipt(db, { receivedOn: "2026-10-10" });
  assert.equal((await load(db, { businessDate: "2026-10-09" })).netUnitCost, 2);
  unknown(await load(db, { businessDate: "2026-10-13" }), "future-business-date");
  const future = fixture(); await receipt(future, { receivedOn: "2026-10-13" }); unknown(await load(future), "future-source-date");
  for (const patch of [{ currency: "USD" }, { currency: null }, { timeZone: null }]) {
    const db = fixture(); db.records.set(ROOT, { ...db.records.get(ROOT), ...patch }); assert.equal((await load(db)).available, false);
  }
  const count = fixture(); countTarget(count); count.records.get(`${ROOT}/catalogproducts/juice`).baseUnit = "ml";
  unknown(await load(count, { purpose: "stockcount", stockCountId: "target", businessDate: null }), "target-unit-changed");
  const backdated = fixture(); await receipt(backdated, { receivedOn: "2026-09-30" }); unknown(await load(backdated), "backdated-source");
});
test("missing, duplicate or malformed dated sequence evidence never yields partial valid estimates", async () => {
  const missing = fixture(); await receipt(missing); missing.records.delete([...missing.records.keys()].find((path) => path.includes("/inventoryMovements/")));
  unknown(await load(missing), "posting-sequence-incomplete");
  const malformed = fixture(); await receipt(malformed); const row = [...malformed.records.entries()].find(([path]) => path.includes("/inventoryMovements/"))[1];
  row.sequence = null; unknown(await load(malformed), "source-date-evidence-unverified");
  const duplicated = fixture(); await receipt(duplicated); const [path, value] = [...duplicated.records.entries()].find(([path]) => path.includes("/inventoryMovements/"));
  duplicated.records.set(`${path}-duplicate`, structuredClone(value)); unknown(await load(duplicated), "posting-sequence-incomplete");
});
test("bounded latest-anchor and full-posting windows remain unavailable instead of silently truncating", async () => {
  const db = fixture(); db.records.get(`${ROOT}/inventoryLocationStates/store`).sequence = 1002;
  unknown(await load(db), "source-window-exceeded");
  const horizon = fixture(); horizon.records.clear(); const restored = fixture();
  for (const [path, row] of restored.records) if (!path.includes("/inventoryCheckpoints/")) horizon.records.set(path, row);
  for (let i = 0; i < 101; i++) checkpoint(horizon, `future-${i}`, { date: "2026-10-13", seq: i + 1 });
  unknown(await load(horizon), "opening-window-exceeded");
});
