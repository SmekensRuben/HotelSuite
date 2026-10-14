const test = require("node:test");
const assert = require("node:assert/strict");
const { memoryDatabase } = require("./inventoryTestHelpers");
const policy = require("./inventoryAdjustmentPolicy");
const periodPolicy = require("./inventoryPeriodPolicy");
const movements = require("./inventoryMovements");
const { getHotelInventoryPeriodHandler } = require("./inventoryReports");
const { recordHotelInventoryAdjustmentHandler: recordHandler, reverseHotelInventoryAdjustmentHandler: reverseHandler,
  listHotelInventoryAdjustmentsHandler: listHandler, listHotelInventoryAdjustmentChoicesHandler: choicesHandler } = require("./inventoryAdjustments");
const HOTEL = "hotel-a", NOW = Date.parse("2026-10-12T10:00:00Z");
const request = (data, uid = "operator") => ({ auth: { uid, token: { email_verified: true } }, data });
const auth = { getUser: async () => ({ emailVerified: true, disabled: false, customClaims: {} }) };
function fixture() {
  return memoryDatabase({
    [`hotels/${HOTEL}`]: { currency: "EUR", timeZone: "Europe/Brussels" },
    [`hotelSubscriptions/${HOTEL}`]: { status: "active", modules: ["procurement"], modulePolicyVersion: 1 },
    [`hotels/${HOTEL}/members/operator`]: { permissions: ["inventorymovements.read", "inventorymovements.create", "inventorymovements.reverse", "stockcounts.read"] },
    [`hotels/${HOTEL}/locations/store`]: { name: "Main store" }, [`hotels/${HOTEL}/locations/bar`]: { name: "Bar" },
    [`hotels/${HOTEL}/catalogproducts/juice`]: { name: "Orange juice", baseUnit: "l", inventoryTracked: true, active: true },
    "platformConfiguration/saasProcurement": { enabled: true, rulesVersion: require("./platformReleasePolicy.json").saasRulesVersion },
  });
}
const services = (db, overrides = {}) => ({ firestore: db, auth, now: () => NOW, ...overrides });
const recordInput = (overrides = {}) => ({ hotelUid: HOTEL, requestId: "transfer-1", expectedActorUid: "operator", kind: "transfer", catalogProductId: "juice", quantity: 6,
  sourceLocationId: "store", destinationLocationId: "bar", businessDate: "2026-10-05", note: "Moved two cases", reference: "Transfer ticket 42", netUnitCost: 2.5, currency: "EUR", ...overrides });
const record = (db, overrides, svc = {}) => recordHandler(request(recordInput(overrides)), services(db, svc));
const reverse = (db, adjustmentId, overrides = {}, svc = {}) => reverseHandler(request({ hotelUid: HOTEL, adjustmentId, requestId: "reverse-1", expectedActorUid: "operator",
  businessDate: "2026-10-06", note: "Entered in error", reference: "Correction ticket 42", ...overrides }), services(db, svc));
function checkpoint(db, id, locationId, quantity, date, cost = 2.5) {
  const statePath = `hotels/${HOTEL}/inventoryLocationStates/${locationId}`, state = db.records.get(statePath) || { sequence: 0 };
  const row = { id: movements.checkpointId(id, locationId), hotelUid: HOTEL, locationId, stockCountId: id, stockCountName: id,
    businessDate: date, currency: "EUR", inventoryPolicyVersion: 1, sequence: state.sequence + 1,
    items: [{ catalogProductId: "juice", catalogProductName: "Orange juice", baseUnit: "l", quantity, unitCost: cost }], coverageIssues: [] };
  db.records.set(`hotels/${HOTEL}/inventoryCheckpoints/${row.id}`, row);
  db.records.set(`hotels/${HOTEL}/stockCounts/${id}`, { status: "Finished" });
  db.records.set(statePath, { ...state, sequence: row.sequence, latestCheckpointBusinessDate: date });
  return row;
}
const report = (db, locationId = "store", version = 2) => getHotelInventoryPeriodHandler(request({ hotelUid: HOTEL, locationId,
  openingStockCountId: "opening", closingStockCountId: "closing", reportPolicyVersion: version }), services(db));
async function receipt(db, quantity = 10, netValue = 25) {
  return db.runTransaction(async (tx) => {
    const entry = await movements.prepareReceiptMovement(db, tx, { hotelUid: HOTEL, locationId: "store", movementId: "receipt-1", orderId: "order-1",
      receiptId: "received-1", receivedOn: "2026-10-04", actorUid: "operator", lines: [{ catalogProductId: "juice", catalogProductName: "Orange juice",
        baseUnit: "l", quantity, netValue, netUnitCost: 2.5, currency: "EUR" }] }); entry.write();
  });
}
test("manual physical commands enforce exact bounded quantities, explicit source contracts and required references", () => {
  const input = recordInput(); assert.equal(policy.record(input).netValue, 15);
  for (const quantity of [0, -1, null, "2", Infinity, NaN, 1000001, 0.0000001]) assert.throws(() => policy.record({ ...input, quantity }));
  for (const patch of [{ note: "" }, { reference: "" }, { businessDate: "2026-02-30" }, { reasonType: "breakage" },
    { destinationLocationId: "store" }, { netUnitCost: 1, currency: null }, { netUnitCost: "1" }, { extra: true }]) assert.throws(() => policy.record({ ...input, ...patch }));
  assert.equal(policy.record({ ...input, netUnitCost: null, currency: null }).netValue, null);
  assert.equal(policy.record({ ...input, netUnitCost: 0 }).netValue, 0);
  assert.throws(() => policy.record({ ...input, quantity: 0.000001, netUnitCost: 0.000001 }));
});
test("transfers atomically conserve exact canonical quantities and net values in both location sequences", async () => {
  const db = fixture(), result = await record(db, { quantity: 6.000001 });
  const legs = result.movementIds.map((id) => db.records.get(`hotels/${HOTEL}/inventoryMovements/${id}`));
  assert.equal(legs.length, 2); assert.equal(legs[0].kind, "transfer_out"); assert.equal(legs[1].kind, "transfer_in");
  assert.equal(legs[0].lines[0].quantity, -6.000001); assert.equal(legs[1].lines[0].quantity, 6.000001);
  assert.equal(legs[0].lines[0].quantity + legs[1].lines[0].quantity, 0);
  assert.equal(legs[0].lines[0].netValue + legs[1].lines[0].netValue, 0);
  for (const location of ["store", "bar"]) assert.equal(db.records.get(`hotels/${HOTEL}/inventoryLocationStates/${location}`).sequence, 1);
  assert.equal(legs[0].lines[0].baseUnit, "l"); assert.equal(db.records.get(`hotels/${HOTEL}/inventoryAdjustments/${result.adjustmentId}`).netValue, 15.000003);
});
test("central storage requisitions resolve outlet stock points without templates or previous counts", async () => {
  const db = fixture();
  db.records.set(`hotels/${HOTEL}/outlets/cellar`, { name: "Central cellar", inventoryRole: "central_storage", resourcePolicyVersion: 1, revision: 1 });
  db.records.set(`hotels/${HOTEL}/outlets/restaurant`, { name: "Restaurant" });
  const choices = await choicesHandler(request({ hotelUid: HOTEL, kind: "locations" }), services(db));
  assert.deepEqual(choices.choices.find((choice) => choice.id === "outlet:cellar"), { id: "outlet:cellar", name: "Central cellar",
    outletId: "cellar", outletName: "Central cellar", stockPointType: "outlet", inventoryRole: "central_storage" });
  assert.equal(db.records.has(`hotels/${HOTEL}/locations/outlet:cellar`), false);
  const input = { sourceLocationId: "outlet:cellar", destinationLocationId: "outlet:restaurant", movementType: "requisition" };
  const first = await record(db, input), before = db.records.size;
  assert.deepEqual(await record(db, input), first); assert.equal(db.records.size, before);
  const saved = db.records.get(`hotels/${HOTEL}/inventoryAdjustments/${first.adjustmentId}`);
  assert.equal(saved.movementType, "requisition"); assert.equal(saved.sourceOutletId, "cellar");
  for (const id of first.movementIds) assert.equal(db.records.get(`hotels/${HOTEL}/inventoryMovements/${id}`).movementType, "requisition");
  assert.equal(db.records.get(`hotels/${HOTEL}/locations/outlet:restaurant`).stockPointPolicyVersion, 1);
  db.records.set(`hotels/${HOTEL}/outlets/cellar`, { name: "Closed", archived: true });
  await assert.rejects(record(db, { ...input, requestId: "closed-requisition" }), { code: "failed-precondition" });
  const reversed = await reverse(db, first.adjustmentId);
  assert.equal(db.records.get(`hotels/${HOTEL}/inventoryAdjustments/${reversed.reversalAdjustmentId}`).movementType, "requisition");
});
test("requisition intent cannot be forged for regular outlet or same-outlet detail transfers", async () => {
  const db = fixture();
  db.records.set(`hotels/${HOTEL}/outlets/restaurant`, { name: "Restaurant" });
  await assert.rejects(record(db, { sourceLocationId: "outlet:restaurant", destinationLocationId: "bar", movementType: "requisition" }), { code: "failed-precondition" });
  db.records.set(`hotels/${HOTEL}/outlets/cellar`, { name: "Cellar", inventoryRole: "central_storage" });
  db.records.set(`hotels/${HOTEL}/locations/rack`, { name: "Rack", outletId: "cellar" });
  await assert.rejects(record(db, { sourceLocationId: "outlet:cellar", destinationLocationId: "rack", movementType: "requisition" }), { code: "failed-precondition" });
  assert.equal([...db.records.keys()].some((path) => path.includes("/inventoryMovements/")), false);
  assert.throws(() => policy.record(recordInput({ kind: "waste", destinationLocationId: null, reasonType: "waste", movementType: "requisition" })), { code: "invalid-argument" });
});
test("uncertain exact request replay is idempotent while changed details and record/reverse reuse are rejected", async () => {
  const db = fixture(), first = await record(db), before = db.records.size;
  assert.deepEqual(await record(db), first); assert.equal(db.records.size, before);
  await assert.rejects(record(db, { quantity: 7 }), (error) => error.code === "already-exists" && !error.details?.inventoryAdjustmentRequestUncommitted);
  await assert.rejects(reverse(db, first.adjustmentId, { requestId: "transfer-1" }), (error) => error.code === "already-exists");
});
test("new adjustments reject archived/missing locations, inactive/untracked catalogs, foreign tenant IDs and currency conflicts without half transfers", async () => {
  for (const patch of [{ path: `hotels/${HOTEL}/locations/bar`, row: { name: "Bar", archived: true } },
    { path: `hotels/${HOTEL}/catalogproducts/juice`, row: { name: "Juice", inventoryTracked: false, baseUnit: "l" } },
    { path: `hotels/${HOTEL}/catalogproducts/juice`, row: { name: "Juice", inventoryTracked: true, active: false, baseUnit: "l" } },
    { path: `hotels/${HOTEL}/locations/bar`, row: null }]) {
    const db = fixture(); if (patch.row) db.records.set(patch.path, patch.row); else db.records.delete(patch.path);
    const before = db.records.size;
    await assert.rejects(record(db), (error) => error.code === "failed-precondition" && error.details.inventoryAdjustmentRequestUncommitted);
    assert.equal(db.records.size, before); assert.equal([...db.records.keys()].some((key) => key.includes("/inventoryMovements/")), false);
  }
  const db = fixture(); db.records.set("hotels/hotel-b/catalogproducts/foreign", { name: "Foreign", inventoryTracked: true, baseUnit: "l" });
  await assert.rejects(record(db, { catalogProductId: "foreign" }), (error) => error.code === "failed-precondition");
  await assert.rejects(record(db, { currency: "USD" }), (error) => error.code === "failed-precondition");
  await assert.rejects(recordHandler(request({ ...recordInput(), hotelUid: "hotel-b" }), services(db)), (error) => error.code === "permission-denied");
});
test("actual transaction retries recheck current Auth, subscription, membership and gate even after attempted writes", async () => {
  for (const revoked of ["auth", "membership", "subscription", "gate"]) {
    const db = fixture(), execute = db.runTransaction.bind(db); let disabled = false;
    db.runTransaction = async (fn) => {
      const retry = new Error("Simulated Firestore retry");
      await assert.rejects(execute(async (tx) => { await fn(tx); throw retry; }), (error) => error === retry);
      if (revoked === "auth") disabled = true;
      if (revoked === "membership") db.records.set(`hotels/${HOTEL}/members/operator`, { permissions: [] });
      if (revoked === "subscription") db.records.set(`hotelSubscriptions/${HOTEL}`, { status: "suspended", modules: ["procurement"], modulePolicyVersion: 1 });
      if (revoked === "gate") db.records.set("platformConfiguration/saasProcurement", { enabled: false, rulesVersion: "saas-platform-v5" });
      return execute(fn);
    };
    await assert.rejects(record(db, {}, { auth: { getUser: async () => ({ emailVerified: true, disabled }) } }),
      (error) => ["permission-denied", "failed-precondition"].includes(error.code) && !error.details?.inventoryAdjustmentRequestUncommitted);
    assert.equal([...db.records.keys()].some((path) => path.includes("/inventoryMovements/")), false);
  }
});
test("an actual reversal transaction retry cannot compensate after the supervisor lost current authorization", async () => {
  const db = fixture(), original = await record(db), execute = db.runTransaction.bind(db);
  db.runTransaction = async (fn) => {
    const retry = new Error("Simulated Firestore retry");
    await assert.rejects(execute(async (tx) => { await fn(tx); throw retry; }), (error) => error === retry);
    db.records.set(`hotels/${HOTEL}/members/operator`, { permissions: ["inventorymovements.read", "inventorymovements.create"] });
    return execute(fn);
  };
  await assert.rejects(reverse(db, original.adjustmentId), (error) => error.code === "permission-denied" && !error.details?.inventoryAdjustmentRequestUncommitted);
  assert.equal([...db.records.keys()].some((path) => path.includes("/inventoryAdjustmentReversals/")), false);
  assert.equal([...db.records.values()].some((item) => item.kind === "adjustment_reversal"), false);
});
test("idempotent replays still require current authorization and platform administrators need real hotel membership", async () => {
  const db = fixture(); await record(db);
  db.records.set(`hotels/${HOTEL}/members/operator`, { permissions: ["inventorymovements.read"] });
  await assert.rejects(record(db), (error) => error.code === "permission-denied");
  const platform = { auth: { uid: "platform", token: { email_verified: true, platformAdmin: true } }, data: recordInput() };
  await assert.rejects(recordHandler(platform, services(db, { auth: { getUser: async () => ({ emailVerified: true, disabled: false, customClaims: { platformAdmin: true } }) } })), (error) => error.code === "permission-denied");
});
test("pending inventory commands bind the expected actor before replay or commit and acknowledgments echo the original actor/request", async () => {
  const db = fixture(); db.records.set(`hotels/${HOTEL}/members/other`, { permissions: ["inventorymovements.create", "inventorymovements.reverse"] });
  await assert.rejects(recordHandler(request(recordInput(), "other"), services(db)), (error) => error.code === "failed-precondition" && !error.details?.inventoryAdjustmentRequestUncommitted);
  assert.equal([...db.records.keys()].some((key) => key.includes("/inventoryMovements/")), false);
  const original = await record(db); assert.equal(original.actorUid, "operator"); assert.equal(original.requestId, "transfer-1");
  assert.deepEqual(await record(db), original);
  await assert.rejects(reverseHandler(request({ hotelUid: HOTEL, adjustmentId: original.adjustmentId, requestId: "reverse-other", expectedActorUid: "operator",
    businessDate: "2026-10-06", note: "Correction", reference: "42" }, "other"), services(db)), (error) => error.code === "failed-precondition");
  const reversal = await reverse(db, original.adjustmentId); assert.equal(reversal.actorUid, "operator"); assert.equal(reversal.requestId, "reverse-1");
});
test("the explicit reverse permission cannot be granted by an inventorymovements wildcard", async () => {
  const db = fixture(), result = await record(db);
  db.records.set(`hotels/${HOTEL}/members/operator`, { permissions: ["inventorymovements.*"] });
  await assert.rejects(reverse(db, result.adjustmentId), (error) => error.code === "permission-denied");
});
test("a reversal atomically negates both frozen transfer legs after original sources were archived or changed", async () => {
  const db = fixture(), original = await record(db);
  db.records.set(`hotels/${HOTEL}/catalogproducts/juice`, { name: "Changed", baseUnit: "ml", active: false });
  db.records.set(`hotels/${HOTEL}/locations/bar`, { name: "Renamed", archived: true });
  const result = await reverse(db, original.adjustmentId), second = await reverse(db, original.adjustmentId);
  assert.deepEqual(second, result);
  const reversed = result.movementIds.map((id) => db.records.get(`hotels/${HOTEL}/inventoryMovements/${id}`));
  const old = original.movementIds.map((id) => db.records.get(`hotels/${HOTEL}/inventoryMovements/${id}`));
  for (let index = 0; index < 2; index++) {
    assert.equal(reversed[index].lines[0].quantity, -old[index].lines[0].quantity);
    assert.equal(reversed[index].lines[0].netValue, -old[index].lines[0].netValue);
    assert.equal(reversed[index].lines[0].baseUnit, "l"); assert.equal(reversed[index].originalMovementId, old[index].id);
  }
  assert.equal(db.records.get(`hotels/${HOTEL}/inventoryAdjustments/${original.adjustmentId}`).kind, "transfer");
  await assert.rejects(reverse(db, original.adjustmentId, { requestId: "another-reversal" }), (error) => error.code === "already-exists");
  await assert.rejects(reverse(db, result.reversalAdjustmentId, { requestId: "reverse-the-reversal" }), (error) => error.code === "failed-precondition");
});
test("missing/corrupt original transfer evidence never permits a single-leg or phantom compensation", async () => {
  for (const mutation of ["missing-leg", "changed-id", "changed-date", "changed-value", "changed-unit", "summary-value", "same-location"]) {
    const db = fixture(), original = await record(db), path = `hotels/${HOTEL}/inventoryMovements/${original.movementIds[1]}`, row = db.records.get(path);
    if (mutation === "missing-leg") db.records.delete(path);
    if (mutation === "changed-id") row.id = "different-id";
    if (mutation === "changed-date") row.receivedOn = "2026-10-01";
    if (mutation === "changed-value") row.lines[0].netValue = 50;
    if (mutation === "changed-unit") row.lines[0].baseUnit = "ml";
    if (mutation === "summary-value") db.records.get(`hotels/${HOTEL}/inventoryAdjustments/${original.adjustmentId}`).netValue = 20;
    if (mutation === "same-location") row.locationId = "store";
    const before = db.records.size;
    await assert.rejects(reverse(db, original.adjustmentId), (error) => error.code === "failed-precondition");
    assert.equal(db.records.size, before);
    assert.equal([...db.records.values()].some((item) => item.kind === "adjustment_reversal"), false);
  }
});
test("unknown hotel currency permits physical quantity evidence but never invents a valuation", async () => {
  const db = fixture(); db.records.set(`hotels/${HOTEL}`, { timeZone: "Europe/Brussels" });
  const result = await record(db, { netUnitCost: null, currency: null });
  for (const id of result.movementIds) {
    const line = db.records.get(`hotels/${HOTEL}/inventoryMovements/${id}`).lines[0]; assert.equal(line.netValue, null); assert.equal(line.currency, null);
  }
  await assert.rejects(record(db, { requestId: "priced", netUnitCost: 1, currency: "EUR" }), (error) => error.code === "failed-precondition");
});
test("hotel-local business dates reject future entries and refuse missing time zones instead of assuming UTC", async () => {
  const db = fixture();
  await assert.rejects(record(db, { businessDate: "2026-10-13" }), (error) => error.code === "invalid-argument");
  db.records.set(`hotels/${HOTEL}`, { currency: "EUR" });
  await assert.rejects(record(db), (error) => error.code === "failed-precondition");
  db.records.set(`hotels/${HOTEL}`, { currency: "EUR", timeZone: "Europe/Brussels" });
  const localMidnight = Date.parse("2026-10-11T22:30:00Z");
  await record(db, { businessDate: "2026-10-12" }, { now: () => localMidnight });
  await assert.rejects(reverse(db, adjustmentIdFrom(db), { businessDate: "2026-10-11" }, { now: () => localMidnight }), (error) => error.code === "invalid-argument");
});
function adjustmentIdFrom(db) { return [...db.records.values()].find((item) => item.kind === "transfer")?.id; }
test("choices are scoped, bounded, active/tracked and prefix filtered with an explicit scanned-page cursor", async () => {
  const db = fixture(); db.records.set(`hotels/${HOTEL}/catalogproducts/inactive`, { name: "Orange inactive", baseUnit: "l", inventoryTracked: true, active: false });
  db.records.set(`hotels/${HOTEL}/catalogproducts/untracked`, { name: "Orange untracked", baseUnit: "l", inventoryTracked: false });
  db.records.set("hotels/hotel-b/catalogproducts/other", { name: "Orange foreign", baseUnit: "l", inventoryTracked: true });
  const page = await choicesHandler(request({ hotelUid: HOTEL, kind: "catalogproducts", query: "ORANGE" }), services(db));
  assert.deepEqual(page.choices, [{ id: "juice", name: "Orange juice", baseUnit: "l" }]); assert.equal(page.hotelCurrency, "EUR"); assert.equal(page.today, "2026-10-12");
  for (let index = 0; index < 60; index++) db.records.set(`hotels/${HOTEL}/catalogproducts/a${String(index).padStart(2, "0")}`, { name: "Other", baseUnit: "l", inventoryTracked: true });
  const empty = await choicesHandler(request({ hotelUid: HOTEL, kind: "catalogproducts", query: "Orange" }), services(db));
  assert.equal(empty.choices.length, 0); assert.equal(empty.scannedCount, 50); assert.ok(empty.nextCursor);
  const next = await choicesHandler(request({ hotelUid: HOTEL, kind: "catalogproducts", query: "Orange", afterId: empty.nextCursor }), services(db));
  assert.equal(next.choices[0].id, "juice");
  db.records.set(`hotels/${HOTEL}/members/operator`, { permissions: ["inventorymovements.create"] });
  assert.equal((await choicesHandler(request({ hotelUid: HOTEL, kind: "locations" }), services(db))).choices.length, 2);
  await assert.rejects(listHandler(request({ hotelUid: HOTEL }), services(db)), (error) => error.code === "permission-denied");
});
test("history is an immutable frozen projection with bounded pagination and explicit reversal linkage", async () => {
  const db = fixture(), first = await record(db), reversed = await reverse(db, first.adjustmentId);
  const page = await listHandler(request({ hotelUid: HOTEL }), services(db));
  assert.equal(page.adjustments.length, 2); assert.equal(page.adjustments.find((item) => item.id === first.adjustmentId).reversedByAdjustmentId, reversed.reversalAdjustmentId);
  assert.equal(page.adjustments[0].catalogProductName, "Orange juice"); assert.equal(page.adjustments[0].sourceLocationName, "Main store");
  for (let index = 0; index < 25; index++) await record(db, { requestId: `more-${index}`, kind: "waste", reasonType: "waste", destinationLocationId: null });
  const bounded = await listHandler(request({ hotelUid: HOTEL }), services(db)); assert.equal(bounded.adjustments.length, 25); assert.ok(bounded.nextCursor);
  const rest = await listHandler(request({ hotelUid: HOTEL, afterAdjustmentId: bounded.nextCursor }), services(db)); assert.equal(rest.adjustments.length, 2);
  await assert.rejects(listHandler(request({ hotelUid: HOTEL, afterAdjustmentId: "foreign" }), services(db)), (error) => error.code === "invalid-argument");
});
test("physical returns, waste and breakage are explicit outflows without claiming live on-hand availability or receipt reversal", async () => {
  const db = fixture();
  for (const [requestId, kind, reasonType] of [["return", "physical_return", null], ["waste", "waste", "waste"], ["break", "waste", "breakage"]]) {
    const result = await record(db, { requestId, kind, reasonType, destinationLocationId: null, quantity: 1000, netUnitCost: null, currency: null });
    const leg = db.records.get(`hotels/${HOTEL}/inventoryMovements/${result.movementIds[0]}`);
    assert.equal(leg.lines[0].quantity, -1000); assert.equal(leg.lines[0].netValue, null); assert.equal(leg.kind, reasonType || kind);
    assert.equal(leg.orderId, undefined); assert.equal(leg.originalMovementId, null);
  }
});
test("v2 separates exact receipt/transfer/waste/breakage/physical return evidence and residual value source equation", async () => {
  const db = fixture(); checkpoint(db, "opening", "store", 100, "2026-10-01"); checkpoint(db, "opening", "bar", 10, "2026-10-01");
  await receipt(db, 30, 75); await record(db, { quantity: 10 });
  await record(db, { requestId: "incoming", quantity: 2, sourceLocationId: "bar", destinationLocationId: "store" });
  await record(db, { requestId: "waste", kind: "waste", reasonType: "waste", quantity: 3, destinationLocationId: null });
  await record(db, { requestId: "break", kind: "waste", reasonType: "breakage", quantity: 1, destinationLocationId: null });
  await record(db, { requestId: "return", kind: "physical_return", quantity: 4, destinationLocationId: null });
  checkpoint(db, "closing", "store", 80, "2026-10-10"); checkpoint(db, "closing", "bar", 18, "2026-10-10");
  const result = await report(db), row = result.items[0];
  assert.equal(result.inventoryPolicyVersion, 1); assert.equal(result.reportPolicyVersion, 2);
  assert.equal(row.netReceiptQuantity, 30); assert.equal(row.transferInQuantity, 2); assert.equal(row.transferOutQuantity, 10);
  assert.equal(row.wasteQuantity, 3); assert.equal(row.breakageQuantity, 1); assert.equal(row.physicalReturnQuantity, 4);
  assert.equal(row.residualQuantity, 34); assert.equal(row.residualValue, 85); assert.equal(result.coverage.costComplete, true);
  assert.equal((await report(db, "bar")).items[0].residualQuantity, 0); assert.match(result.costBasis, /not invoice cost, a credit note, guaranteed sales consumption/);
});
test("v2 receipt-only physical quantities equal v1 while closing value remains explicit instead of being guessed", async () => {
  const db = fixture(); checkpoint(db, "opening", "store", 100, "2026-10-01"); await receipt(db);
  checkpoint(db, "closing", "store", 80, "2026-10-10", null);
  const a = await report(db, "store", 1), b = await report(db);
  assert.equal(b.items[0].residualQuantity, a.items[0].inferredUsageQuantity); assert.equal(b.items[0].netReceiptQuantity, a.items[0].netReceiptQuantity);
  assert.equal(b.items[0].closingValue, null); assert.equal(b.items[0].residualValue, null); assert.equal(b.coverage.costComplete, false);
  assert.notEqual(a.id, b.id); assert.equal(db.records.get(`hotels/${HOTEL}/inventoryPeriodReports/${a.id}`).reportPolicyVersion, undefined);
});
test("v2 reversals cancel exactly within their original category rather than becoming new receipts", async () => {
  const db = fixture(); checkpoint(db, "opening", "store", 100, "2026-10-01"); checkpoint(db, "opening", "bar", 0, "2026-10-01");
  const original = await record(db); await reverse(db, original.adjustmentId);
  const waste = await record(db, { requestId: "waste", kind: "waste", reasonType: "waste", quantity: 3, destinationLocationId: null });
  await reverse(db, waste.adjustmentId, { requestId: "reverse-waste" });
  checkpoint(db, "closing", "store", 100, "2026-10-10"); checkpoint(db, "closing", "bar", 0, "2026-10-10");
  const result = await report(db); assert.equal(result.items[0].transferOutQuantity, 0); assert.equal(result.items[0].wasteQuantity, 0);
  assert.equal(result.items[0].netReceiptQuantity, 0); assert.equal(result.items[0].residualQuantity, 0); assert.equal(result.items[0].residualValue, 0);
  assert.equal((await report(db, "bar")).items[0].transferInQuantity, 0);
});
test("v1 snapshots never silently change; fresh v1 intervals containing manual evidence explicitly require v2", async () => {
  const db = fixture(); checkpoint(db, "opening", "store", 100, "2026-10-01"); checkpoint(db, "closing", "store", 90, "2026-10-10");
  const original = await report(db, "store", 1), saved = structuredClone(db.records.get(`hotels/${HOTEL}/inventoryPeriodReports/${original.id}`));
  await record(db, { businessDate: "2026-10-10" });
  const replay = await report(db, "store", 1); assert.equal(replay.items[0].inferredUsageQuantity, 10); assert.equal(replay.currentlyComplete, false);
  assert.deepEqual(db.records.get(`hotels/${HOTEL}/inventoryPeriodReports/${original.id}`), saved);
  const second = await report(db); assert.notEqual(second.id, original.id); assert.equal(second.currentlyComplete, false);
  const fresh = fixture(); checkpoint(fresh, "opening", "store", 100, "2026-10-01"); await record(fresh); checkpoint(fresh, "closing", "store", 90, "2026-10-10");
  await assert.rejects(report(fresh, "store", 1), (error) => error.code === "failed-precondition" && /Choose report policy v2/.test(error.message));
});
test("backdated manual postings and movements during a count preserve explicit cutoff uncertainty", async () => {
  const db = fixture(); checkpoint(db, "opening", "store", 100, "2026-10-05");
  const entry = await record(db, { businessDate: "2026-10-04" });
  assert.equal(db.records.get(`hotels/${HOTEL}/inventoryMovements/${entry.movementIds[0]}`).backdatedAgainstCheckpoint, true);
  const closed = checkpoint(db, "closing", "store", 90, "2026-10-10"); closed.coverageIssues = [{ code: "postings-during-count", detail: "Verify cutoff" }];
  const result = await report(db); assert.equal(result.coverage.quantityComplete, false); assert.equal(result.items[0].residualValue, null);
  assert.ok(result.coverage.issues.some((item) => item.code === "backdated-or-outside-period"));
});
test("v2 detects a missing opposite transfer leg even when the selected location sequence is complete", async () => {
  const db = fixture(); checkpoint(db, "opening", "store", 100, "2026-10-01"); const entry = await record(db);
  checkpoint(db, "closing", "store", 94, "2026-10-10"); db.records.delete(`hotels/${HOTEL}/inventoryMovements/${entry.movementIds[1]}`);
  await assert.rejects(report(db), (error) => error.code === "failed-precondition");
});
test("v2 reconciles receipt and transfer posting sequences and batches immutable source evidence across many commands", async () => {
  const db = fixture(); checkpoint(db, "opening", "store", 100, "2026-10-01"); checkpoint(db, "opening", "bar", 0, "2026-10-01");
  await Promise.all([receipt(db, 20, 50), ...Array.from({ length: 20 }, (_, index) => record(db, { requestId: `bulk-${index}`, quantity: 1 }))]);
  checkpoint(db, "closing", "store", 100, "2026-10-10"); checkpoint(db, "closing", "bar", 20, "2026-10-10");
  const execute = db.runTransaction.bind(db); let bulkReads = 0;
  db.runTransaction = (fn, options) => execute((tx) => fn({ ...tx, getAll: (...refs) => { bulkReads++; return tx.getAll(...refs); } }), options);
  const result = await report(db);
  assert.equal(result.items[0].residualQuantity, 0); assert.equal(result.recordedReceiptCount, 1); assert.equal(result.recordedManualAdjustmentCount, 20);
  assert.equal(result.coverage.quantityComplete, true); assert.ok(bulkReads <= 3, "Twenty command/paired-leg proofs must use bounded bulk reads rather than a serial RPC chain.");
  const saved = structuredClone(db.records.get(`hotels/${HOTEL}/inventoryPeriodReports/${result.id}`));
  await record(db, { requestId: "late-after-report", businessDate: "2026-10-10", quantity: 1 });
  const refreshed = await report(db); assert.equal(refreshed.currentlyComplete, false); assert.equal(refreshed.items[0].residualQuantity, 0);
  assert.deepEqual(db.records.get(`hotels/${HOTEL}/inventoryPeriodReports/${result.id}`), saved);
});
test("unknown manual cost invalidates related value but quantities and explicit zero costs remain distinguishable", async () => {
  for (const netUnitCost of [null, 0]) {
    const db = fixture(); checkpoint(db, "opening", "store", 100, "2026-10-01"); await record(db, { netUnitCost, currency: netUnitCost == null ? null : "EUR" });
    checkpoint(db, "closing", "store", 90, "2026-10-10");
    const result = await report(db); assert.equal(result.items[0].residualQuantity, 4);
    assert.equal(result.items[0].transferOutValue, netUnitCost == null ? null : 0);
    assert.equal(result.items[0].residualValue, netUnitCost == null ? null : 25); assert.equal(result.coverage.costComplete, netUnitCost != null);
  }
});
test("v2 source calculations are deterministic with exact six-decimal sums and reject units/directions/duplicates", () => {
  const opening = { locationId: "store", sequence: 1, businessDate: "2026-10-01", currency: "EUR", items: [{ catalogProductId: "juice", baseUnit: "l", quantity: 1, unitCost: 1 }] };
  const closing = { ...opening, sequence: 4, businessDate: "2026-10-10" };
  const event = (sequence, quantity) => ({ inventoryPolicyVersion: 1, locationId: "store", sequence, kind: "receipt", receivedOn: "2026-10-05",
    lines: [{ catalogProductId: "juice", baseUnit: "l", quantity, netValue: quantity, currency: "EUR" }] });
  const sources = [event(2, 0.1), event(3, 0.2)];
  assert.deepEqual(periodPolicy.period(opening, closing, sources), periodPolicy.period(opening, closing, [...sources].reverse()));
  assert.equal(periodPolicy.period(opening, closing, sources).items[0].netReceiptQuantity, 0.3);
  assert.throws(() => periodPolicy.period(opening, closing, [sources[0], sources[0]]));
  assert.throws(() => periodPolicy.period(opening, { ...closing, items: [{ ...opening.items[0], baseUnit: "ml" }] }, sources));
  assert.throws(() => periodPolicy.period(opening, closing, [event(2, -1)]));
  assert.throws(() => periodPolicy.period(opening, closing, [{ ...event(2, 1), kind: "adjustment_reversal", originalKind: "receipt" }]));
});
