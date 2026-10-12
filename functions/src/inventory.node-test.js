const test = require("node:test");
const assert = require("node:assert/strict");
const policy = require("./inventoryPolicy");
const movements = require("./inventoryMovements");
const { createHotelStockCountHandler, mutateHotelStockCountHandler } = require("./stockCounts");
const { getHotelInventoryPeriodHandler, listHotelInventoryCheckpointsHandler, listHotelInventoryLocationsHandler } = require("./inventoryReports");
const { memoryDatabase } = require("./inventoryTestHelpers");
const hotel = "hotel-a", auth = { getUser: async () => ({ emailVerified: true, disabled: false, customClaims: {} }) };
const request = (data) => ({ auth: { uid: "counter", token: { email_verified: true } }, data });
function fixture(permissions = ["stockcounts.create", "stockcounts.update", "stockcounts.read"]) {
  return memoryDatabase({
    [`hotels/${hotel}`]: { currency: "EUR", timeZone: "Europe/Brussels" },
    [`hotels/${hotel}/members/counter`]: { permissions },
    [`hotelSubscriptions/${hotel}`]: { modules: ["procurement"], modulePolicyVersion: 1, status: "active", validUntil: null },
    [`hotels/${hotel}/locations/store`]: { name: "Store" },
    [`hotels/${hotel}/locations/store/stockTemplates/template`]: { name: "Monthly", items: [
      { supplierProductId: "milk-case", outletId: "bar" }, { supplierProductId: "milk-bottle", outletId: "kitchen" }] },
    [`hotels/${hotel}/outlets/bar`]: { name: "Bar" }, [`hotels/${hotel}/outlets/kitchen`]: { name: "Kitchen" },
    [`hotels/${hotel}/supplierproducts/milk-case`]: { catalogProductId: "milk", baseUnit: "ml", pricePerPurchaseUnit: 24, currency: "EUR" },
    [`hotels/${hotel}/supplierproducts/milk-bottle`]: { catalogProductId: "milk", baseUnit: "l", pricePerPurchaseUnit: 2, currency: "USD" },
    [`hotels/${hotel}/catalogproducts/milk`]: { name: "Milk", baseUnit: "l", inventoryTracked: true, active: true },
    [`hotels/${hotel}/catalogproducts/coffee`]: { name: "Coffee", baseUnit: "g", inventoryTracked: true, active: true },
  });
}
const services = (db) => ({ firestore: db, auth, now: () => Date.parse("2026-10-12T10:00:00Z") });
const create = (db, id = "opening", date = "2026-10-01") => createHotelStockCountHandler(request({ hotelUid: hotel, name: id, type: "Month-End",
  locations: [{ locationId: "store", stockTemplateId: "template" }], requestId: id, businessDate: date }), services(db));
const mutate = (db, id, action, quantity = 0, unitCost = null, expectedRevision = 0, items) => mutateHotelStockCountHandler(request({ hotelUid: hotel,
  stockCountId: id, action, expectedRevision, ...(action === "finish-count" ? {} : { locationId: "store" }),
  ...(["save-location", "finish-location"].includes(action) ? { countedItems: items || [{ catalogProductId: "milk", quantity, unitCost, isCounted: true }] } : {}) }), services(db));
async function finish(db, name, quantity, date, unitCost = 2) {
  const { stockCountId } = await create(db, name, date); await mutate(db, stockCountId, "finish-location", quantity, unitCost);
  await mutate(db, stockCountId, "finish-count", 0, null, 1); return stockCountId;
}
async function receipt(db, id = "r1", quantity = 30, netValue = 60, receivedOn = "2026-10-05", coverageGaps = []) {
  return db.runTransaction(async (tx) => { const prepared = await movements.prepareReceiptMovement(db, tx, { hotelUid: hotel,
    locationId: "store", movementId: id, orderId: "order", receiptId: id, receivedOn, actorUid: "counter",
    lines: [{ catalogProductId: "milk", catalogProductName: "Milk", baseUnit: "l", quantity, netUnitCost: netValue == null ? null : 2, netValue, currency: "EUR" }], coverageGaps });
    prepared.write(); return prepared; });
}
const report = (db, openingStockCountId, closingStockCountId) => getHotelInventoryPeriodHandler(request({ hotelUid: hotel, locationId: "store", openingStockCountId, closingStockCountId }), services(db));

test("catalog quantities count one bottle exactly instead of rounding one twenty-fourth of a case", () => {
  assert.deepEqual(policy.countItems([{ catalogProductId: "bottle", quantity: 1, isCounted: true, unitCost: null }])[0].quantity, 1);
  for (const quantity of [null, "1", NaN, Infinity, -1, 1.0000001, 1000001]) assert.throws(() => policy.countItems([{ catalogProductId: "bottle", quantity, isCounted: true }]));
  assert.equal(policy.countItems([{ catalogProductId: "bottle", quantity: 0.000001, isCounted: true, unitCost: 0 }])[0].unitCost, 0);
});
test("supplier templates resolve same catalog once across suppliers and outlets, without importing supplier currencies or prices", async () => {
  const db = fixture(), { stockCountId } = await create(db);
  const location = db.records.get(`hotels/${hotel}/stockCounts/${stockCountId}/locations/store`);
  assert.equal(location.stockTemplate.items.length, 1); assert.equal(location.stockTemplate.items[0].baseUnit, "l");
  assert.equal(location.stockTemplate.items[0].currency, "EUR"); assert.equal(location.stockTemplate.items[0].unitCost, null);
  await mutate(db, stockCountId, "finish-location", 1, null); await mutate(db, stockCountId, "finish-count", 0, null, 1);
  assert.equal(db.records.get(`hotels/${hotel}/stockCounts/${stockCountId}`).countedValue, null);
});
test("an actual newly onboarded hotel counts using canonical bootstrap currency without requiring invented root currency", async () => {
  const db = fixture(); db.records.delete(`hotels/${hotel}`); db.records.delete(`hotelSubscriptions/${hotel}`);
  const platformRequest = { auth: { uid: "platform", token: { email_verified: true, platformAdmin: true } }, data: {
    hotelUid: hotel, name: "New hotel", timeZone: "Europe/Brussels", status: "active", modules: ["procurement"], requestId: "new-hotel" } };
  await require("./onboarding").createHotelHandler(platformRequest, { firestore: db, auth: { getUser: async () => ({ emailVerified: true, disabled: false, customClaims: { platformAdmin: true } }) } });
  assert.equal(db.records.get(`hotels/${hotel}`).currency, undefined);
  assert.equal(db.records.get(`hotels/${hotel}/settings/bootstrap`).currency, "EUR");
  const { stockCountId } = await create(db); assert.equal(db.records.get(`hotels/${hotel}/stockCounts/${stockCountId}`).currency, "EUR");
  db.records.set(`hotels/${hotel}`, { ...db.records.get(`hotels/${hotel}`), currency: "USD" });
  await assert.rejects(create(db, "conflict"), (error) => error.code === "failed-precondition");
});
test("empty or archived templates cannot start an apparently complete canonical count", async () => {
  for (const data of [{ name: "Empty", items: [] }, { name: "Archived", items: [{ catalogProductId: "milk" }], archived: true }]) {
    const db = fixture(); db.records.set(`hotels/${hotel}/locations/store/stockTemplates/template`, data);
    await assert.rejects(create(db), (error) => ["invalid-argument", "failed-precondition"].includes(error.code));
  }
});
test("unresolved links, incompatible units, untracked catalogs, invalid currencies and future dates never silently drop sources", async () => {
  for (const patch of [{ catalogProductId: null, baseUnit: "l" }, { catalogProductId: "foreign", baseUnit: "l" }, { catalogProductId: "milk", baseUnit: "g" }]) {
    const db = fixture(); db.records.set(`hotels/${hotel}/supplierproducts/milk-case`, patch);
    await assert.rejects(create(db), (error) => error.code === "failed-precondition" && error.details.countRequestUncommitted === true);
    assert.equal([...db.records.keys()].some((path) => path.includes("/stockCounts/")), false);
  }
  const db = fixture(); db.records.set(`hotels/${hotel}/catalogproducts/milk`, { name: "Milk", baseUnit: "l", inventoryTracked: false });
  await assert.rejects(create(db), (error) => error.code === "failed-precondition");
  const currency = fixture(); currency.records.set(`hotels/${hotel}`, { currency: null, timeZone: "Europe/Brussels" });
  await assert.rejects(create(currency), (error) => error.code === "failed-precondition");
  await assert.rejects(create(fixture(), "future", "2026-10-13"), (error) => error.code === "invalid-argument");
});
test("new counts require every included catalog product explicitly counted, with zero valid and quantities not tied to valuation", async () => {
  const db = fixture(), { stockCountId } = await create(db);
  await assert.rejects(mutate(db, stockCountId, "finish-location", 0, null, 0, []), (error) => error.code === "failed-precondition");
  await assert.rejects(mutate(db, stockCountId, "finish-location", 0, null, 0, [{ catalogProductId: "milk", quantity: 0, isCounted: false }]), (error) => error.code === "failed-precondition");
  await mutate(db, stockCountId, "finish-location", 0, null); assert.equal(db.records.get(`hotels/${hotel}/stockCounts/${stockCountId}`).countedValue, 0);
});
test("additional catalog rows keep their frozen unit and cannot disappear after first save", async () => {
  const db = fixture(), { stockCountId } = await create(db);
  const items = [{ catalogProductId: "milk", quantity: 1, unitCost: 2, isCounted: true }, { catalogProductId: "coffee", quantity: 100, unitCost: 0.01, isCounted: true }];
  await mutate(db, stockCountId, "save-location", 0, null, 0, items);
  db.records.set(`hotels/${hotel}/catalogproducts/coffee`, { name: "Changed", baseUnit: "kg", inventoryTracked: true });
  await assert.rejects(mutate(db, stockCountId, "finish-location", 1, 2, 1), (error) => error.code === "failed-precondition");
  await mutate(db, stockCountId, "finish-location", 0, null, 1, items);
  assert.equal(db.records.get(`hotels/${hotel}/stockCounts/${stockCountId}/locations/store`).countedItems[1].baseUnit, "g");
});
test("unfinished historical counts keep frozen purchase valuation but cannot finish empty; finished historical snapshots stay immutable", async () => {
  const db = fixture(), id = "legacy", item = { supplierProductId: "legacy", outletId: "bar", pricePerPurchaseUnit: 12.5 };
  db.records.set(`hotels/${hotel}/stockCounts/${id}`, { name: "Legacy", status: "Started", revision: 0, locations: [{ locationId: "store" }] });
  db.records.set(`hotels/${hotel}/stockCounts/${id}/locations/store`, { locationId: "store", status: "Not Started", stockTemplate: { items: [item] }, countedItems: [] });
  const legacy = (items, revision = 0) => mutateHotelStockCountHandler(request({ hotelUid: hotel, stockCountId: id, action: "finish-location", locationId: "store", expectedRevision: revision, countedItems: items }), services(db));
  await assert.rejects(legacy([]), (error) => error.code === "failed-precondition");
  await legacy([{ supplierProductId: "legacy", outletId: "bar", quantity: 2, isCounted: true }]);
  assert.equal(db.records.get(`hotels/${hotel}/stockCounts/${id}`).countedValue, 25);
  await mutate(db, id, "finish-count", 0, null, 1);
  await assert.rejects(legacy([], 2), (error) => error.code === "failed-precondition");
  assert.equal(db.records.get(`hotels/${hotel}/stockCounts/${id}`).countedValue, 25);
});
test("100 opening + 30 receipts - 80 closing gives 50 inferred usage with recorded period cost estimate", async () => {
  const db = fixture(), opening = await finish(db, "opening", 100, "2026-10-01"), movement = await receipt(db);
  assert.equal(movement.sequence, 2);
  const closing = await finish(db, "closing", 80, "2026-10-10"), result = await report(db, opening, closing);
  assert.equal(result.items[0].inferredUsageQuantity, 50); assert.equal(result.items[0].periodUnitCost, 2);
  assert.equal(result.items[0].inferredUsageValue, 100); assert.equal(result.coverage.quantityComplete, true);
  assert.equal(result.coverage.costComplete, true); assert.match(result.costBasis, /not invoice/);
});
test("receipt reversals negate exact frozen quantities and values, serialize with checkpoints and prevent duplicates", async () => {
  const db = fixture(), opening = await finish(db, "opening", 100, "2026-10-01"); await receipt(db);
  await db.runTransaction(async (tx) => { const reversal = await movements.prepareReversalMovement(db, tx, { hotelUid: hotel, movementId: "rev", originalMovementId: "r1", orderId: "order", actorUid: "counter" }); reversal.write(); });
  const reversal = db.records.get(`hotels/${hotel}/inventoryMovements/rev`);
  assert.equal(reversal.lines[0].quantity, -30); assert.equal(reversal.lines[0].netValue, -60); assert.equal(reversal.locationId, "store");
  await assert.rejects(receipt(db), (error) => error.code === "already-exists");
  await assert.rejects(db.runTransaction(async (tx) => movements.prepareReversalMovement(db, tx, { hotelUid: hotel, movementId: "rev2", originalMovementId: "r1", orderId: "order" })), (error) => error.code === "already-exists");
  const closing = await finish(db, "closing", 80, "2026-10-10"), result = await report(db, opening, closing);
  assert.equal(result.items[0].netReceiptQuantity, 0); assert.equal(result.items[0].inferredUsageQuantity, 20);
});
test("unknown receipt costs and gaps remain unknown, and tiny positive receipt value is not rounded into free inventory", async () => {
  const db = fixture(), opening = await finish(db, "opening", 0, "2026-10-01", null); await receipt(db, "tiny", 100000, 0.01);
  const closing = await finish(db, "closing", 0, "2026-10-10", null), result = await report(db, opening, closing);
  assert.equal(result.items[0].periodUnitCost, 0.0000001); assert.equal(result.items[0].inferredUsageValue, 0.01);
  const unknown = fixture(), start = await finish(unknown, "opening", 100, "2026-10-01"); await receipt(unknown, "r", 30, null);
  const end = await finish(unknown, "closing", 80, "2026-10-10"), absent = await report(unknown, start, end);
  assert.equal(absent.items[0].periodUnitCost, null); assert.equal(absent.coverage.costComplete, false);
  const gaps = fixture(), first = await finish(gaps, "opening", 100, "2026-10-01"); await receipt(gaps, "gap", 30, 60, "2026-10-05", [{ reason: "missing catalog link" }]);
  const last = await finish(gaps, "closing", 80, "2026-10-10"), missing = await report(gaps, first, last);
  assert.equal(missing.coverage.quantityComplete, false); assert.equal(missing.items[0].periodUnitCost, null);
});
test("postings during counting and late same-day entries are visible without rewriting an immutable report", async () => {
  const db = fixture(), opening = await finish(db, "opening", 100, "2026-10-01"), closingDraft = await create(db, "closing", "2026-10-10");
  await receipt(db);
  await mutate(db, closingDraft.stockCountId, "finish-location", 80, 2); await mutate(db, closingDraft.stockCountId, "finish-count", 0, null, 1);
  const ambiguous = await report(db, opening, closingDraft.stockCountId);
  assert.equal(ambiguous.coverage.quantityComplete, false); assert.equal(ambiguous.coverage.issues[0].code, "postings-during-count");
  const clean = fixture(), a = await finish(clean, "opening", 100, "2026-10-01"), b = await finish(clean, "closing", 80, "2026-10-10");
  const before = await report(clean, a, b); await receipt(clean, "late", 30, 60, "2026-10-10");
  const after = await report(clean, a, b);
  assert.equal(after.items[0].inferredUsageQuantity, before.items[0].inferredUsageQuantity);
  assert.equal(after.computedAtMillis, before.computedAtMillis); assert.equal(after.currentlyComplete, false);
  assert.equal(after.postClosureIssues[0].detail, "late");
  assert.equal(clean.records.get(`hotels/${hotel}/inventoryMovements/late`).backdatedAgainstCheckpoint, true);
});
test("missing movement sequences, changed units, missing checkpoint products and different currencies do not produce a valid complete report", async () => {
  const db = fixture(), opening = await finish(db, "opening", 100, "2026-10-01"); await receipt(db);
  const closing = await finish(db, "closing", 80, "2026-10-10"); db.records.delete(`hotels/${hotel}/inventoryMovements/r1`);
  await assert.rejects(report(db, opening, closing), (error) => error.code === "failed-precondition");
  const a = { locationId: "store", sequence: 1, currency: "EUR", businessDate: "2026-10-01", items: [{ catalogProductId: "milk", baseUnit: "l", quantity: 100, unitCost: 2 }] };
  const b = { ...a, sequence: 2, businessDate: "2026-10-10", items: [{ catalogProductId: "coffee", baseUnit: "g", quantity: 0, unitCost: null }] };
  const incomplete = policy.period(a, b, []); assert.equal(incomplete.items.find((item) => item.catalogProductId === "milk").closingQuantity, null); assert.equal(incomplete.items.find((item) => item.catalogProductId === "milk").inferredUsageQuantity, null);
  assert.equal(incomplete.coverage.quantityComplete, false);
  assert.throws(() => policy.period(a, { ...b, currency: "USD" }, []));
  assert.throws(() => policy.period(a, { ...b, items: [{ ...a.items[0], baseUnit: "ml" }] }, []));
});
test("checkpoint dates cannot go backwards and bounded posting windows are rejected instead of truncated", async () => {
  const db = fixture(); await finish(db, "first", 100, "2026-10-10"); const older = await create(db, "older", "2026-10-09");
  await assert.rejects(mutate(db, older.stockCountId, "finish-location", 80, 2), (error) => error.code === "failed-precondition");
  const large = fixture(), opening = await finish(large, "opening", 0, "2026-10-01");
  for (let index = 0; index < 1001; index++) large.records.set(`hotels/${hotel}/inventoryMovements/r${index}`, { locationId: "store", sequence: index + 2, receivedOn: "2026-10-05" });
  large.records.set(`hotels/${hotel}/inventoryLocationStates/store`, { sequence: 1002, latestCheckpointBusinessDate: "2026-10-01" });
  const closing = await finish(large, "closing", 0, "2026-10-10");
  await assert.rejects(report(large, opening, closing), (error) => error.code === "resource-exhausted");
});
test("ordinary read-only hotel users can list minimal locations and finished checkpoints but cannot cross hotel or suspended entitlement", async () => {
  const db = fixture(), opening = await finish(db, "opening", 100, "2026-10-01");
  db.records.set(`hotels/${hotel}/members/counter`, { permissions: ["stockcounts.read"] });
  const locations = await listHotelInventoryLocationsHandler(request({ hotelUid: hotel }), services(db));
  assert.deepEqual(locations.locations, [{ id: "store", locationId: "store", name: "Store" }]);
  const checkpoints = await listHotelInventoryCheckpointsHandler(request({ hotelUid: hotel, locationId: "store" }), services(db));
  assert.equal(checkpoints.checkpoints[0].stockCountId, opening);
  await assert.rejects(listHotelInventoryLocationsHandler(request({ hotelUid: "hotel-b" }), services(db)), (error) => error.code === "permission-denied");
  db.records.set(`hotelSubscriptions/${hotel}`, { status: "suspended", modules: ["procurement"], modulePolicyVersion: 1 });
  await assert.rejects(listHotelInventoryLocationsHandler(request({ hotelUid: hotel }), services(db)), (error) => error.code === "permission-denied");
});
