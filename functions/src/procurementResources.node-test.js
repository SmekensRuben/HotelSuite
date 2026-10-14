const test = require("node:test");
const assert = require("node:assert/strict");
const { memoryDatabase } = require("./inventoryTestHelpers");
const { mutateHotelProcurementResourceHandler, prepareInventoryStockPoint, getHotelLocationOutletChoicesHandler } = require("./procurementResources");
const { getHotelStockTemplateDisplayHandler, mutateHotelStockTemplateHandler } = require("./stockTemplates");
const { createHotelStockCountHandler, mutateHotelStockCountHandler, listHotelStockCountSourcesHandler } = require("./stockCounts");
const { listHotelInventoryLocationsHandler } = require("./inventoryReports");
const { prepareReceiptMovement, prepareReversalMovement } = require("./inventoryMovements");
const { canonicalLines } = require("./orders");
const { requireHotelImportTarget } = require("./fileImportTypes");
const { SAAS_RULES_VERSION } = require("./saasRollout");

const hotelUid = "hotel-a", actorUid = "operator";
const request = (data) => ({ auth: { uid: actorUid, token: { email_verified: true } }, data });
const auth = { getUser: async () => ({ emailVerified: true, disabled: false }) };
const services = (db) => ({ firestore: db, auth, now: () => Date.parse("2026-10-12T12:00:00Z") });
function fixture() {
  return memoryDatabase({
    [`hotels/${hotelUid}`]: { currency: "EUR", timeZone: "Europe/Brussels" },
    [`hotels/${hotelUid}/members/${actorUid}`]: { permissions: ["locations.*", "outlets.*", "stockcounts.*"] },
    [`hotelSubscriptions/${hotelUid}`]: { status: "active", validUntil: null, modules: ["procurement"], modulePolicyVersion: 1 },
    "platformConfiguration/saasProcurement": { enabled: true, rulesVersion: SAAS_RULES_VERSION },
    [`hotels/${hotelUid}/locations/store`]: { name: "Store" },
    [`hotels/${hotelUid}/locations/store/stockTemplates/t`]: { name: "Weekly", items: [{ catalogProductId: "juice" }] },
    [`hotels/${hotelUid}/catalogproducts/juice`]: { name: "Orange juice", baseUnit: "l", inventoryTracked: true, active: true },
    [`hotels/${hotelUid}/supplierproducts/juice-case`]: { supplierId: "vendor", supplierProductName: "Orange juice six-pack", catalogProductId: "juice", active: true,
      baseUnit: "ml", baseUnitsPerPurchaseUnit: 6000, pricePerPurchaseUnit: 12, currency: "EUR", priceBasis: "net", purchaseUnit: "Case" },
    [`hotels/${hotelUid}/suppliers/vendor`]: { name: "Vendor" },
    [`hotels/${hotelUid}/outlets/bar`]: { name: "Bar" },
    [`hotels/${hotelUid}/outlets/bar/approvers/${actorUid}`]: { email: "private@example.test" },
    [`hotels/${hotelUid}/supplierOutletAccounts/account`]: { outletId: "bar", supplierId: "vendor", accountNumber: "SECRET-ACCOUNT" },
  });
}
const archive = (db, collection = "locations", resourceId = "store", patch = {}) => mutateHotelProcurementResourceHandler(request({ hotelUid,
  collection, resourceId, action: "archive", expectedRevision: 0, requestId: `archive-${collection}`, ...patch }), services(db));
const createCount = (db, requestId = "before") => createHotelStockCountHandler(request({ hotelUid, name: "Weekly", type: "Weekly", businessDate: "2026-10-10",
  requestId, locations: [{ locationId: "store", stockTemplateId: "t" }] }), services(db));

test("archive retains identities, template rows, approvers, account references and history and replays once", async () => {
  const db = fixture();
  db.records.set(`hotels/${hotelUid}/orders/history`, { outletId: "bar", outletName: "Old name", products: [{ catalogProductId: "juice" }] });
  const before = structuredClone(db.records.get(`hotels/${hotelUid}/orders/history`));
  const first = await archive(db); assert.equal(first.archived, true); assert.equal(first.revision, 1);
  assert.deepEqual(await archive(db), first);
  const saved = db.records.get(`hotels/${hotelUid}/locations/store`);
  assert.equal(saved.name, "Store"); assert.equal(saved.archivedBy, actorUid); assert.equal(saved.active, false);
  assert.deepEqual(db.records.get(`hotels/${hotelUid}/locations/store/stockTemplates/t`).items, [{ catalogProductId: "juice" }]);
  await archive(db, "outlets", "bar");
  assert.deepEqual(db.records.get(`hotels/${hotelUid}/orders/history`), before);
  assert.ok(db.records.has(`hotels/${hotelUid}/outlets/bar/approvers/${actorUid}`));
  assert.ok(db.records.has(`hotels/${hotelUid}/supplierOutletAccounts/account`));
  assert.equal([...db.records.keys()].filter((path) => path.includes("/procurementResourceAudit/")).length, 2);
});

test("archives authorize exact hotel/action, current identity, subscription and release on every replay", async () => {
  const db = fixture(); await archive(db);
  await assert.rejects(archive(db, "locations", "store", { hotelUid: "hotel-b" }), { code: "permission-denied" });
  db.records.set(`hotels/${hotelUid}/members/${actorUid}`, { permissions: ["locations.update"] });
  await assert.rejects(archive(db), { code: "permission-denied" });
  const blocked = fixture(); blocked.records.set("platformConfiguration/saasProcurement", { enabled: false, rulesVersion: SAAS_RULES_VERSION });
  await assert.rejects(archive(blocked), (error) => error.code === "failed-precondition" && !error.details?.resourceRequestUncommitted);
  const unlicensed = fixture(); unlicensed.records.set(`hotelSubscriptions/${hotelUid}`, { status: "active", validUntil: null, modules: ["revenue"], modulePolicyVersion: 1 });
  await assert.rejects(archive(unlicensed), { code: "permission-denied" });
  await assert.rejects(mutateHotelProcurementResourceHandler(request({ hotelUid, collection: "locations", resourceId: "store", action: "archive", requestId: "bad", expectedRevision: 0 }),
    { firestore: fixture(), auth: { getUser: async () => ({ emailVerified: true, disabled: true }) } }), { code: "permission-denied" });
});

test("resource command rejects changed retries, stale revisions and copied server fields without committing", async () => {
  const db = fixture(); await archive(db);
  await assert.rejects(archive(db, "outlets", "bar", { requestId: "archive-locations" }), (error) => error.code === "already-exists" && !error.details?.resourceRequestUncommitted);
  await assert.rejects(archive(db, "locations", "store", { requestId: "new" }), (error) => error.code === "aborted" && error.details?.resourceRequestUncommitted);
  for (const patch of [{ action: "delete" }, { collection: "members" }, { archivedBy: "someone-else" }, { resourceId: "a/b" }]) {
    await assert.rejects(archive(fixture(), "locations", "store", patch), { code: "invalid-argument" });
  }
});

test("old release markers cannot activate protected resources before the stock-point Rules rollout", async () => {
  const db = fixture();
  for (const rulesVersion of ["saas-platform-v4", "saas-platform-v5"]) {
    db.records.set("platformConfiguration/saasProcurement", { enabled: true, rulesVersion });
    await assert.rejects(archive(db), (error) => error.code === "failed-precondition" && !error.details?.resourceRequestUncommitted);
  }
  assert.equal(db.records.get(`hotels/${hotelUid}/locations/store`).archived, undefined);
  db.records.set("platformConfiguration/saasProcurement", { enabled: true, rulesVersion: SAAS_RULES_VERSION });
  assert.equal((await archive(db)).archived, true);
});

test("archived locations are excluded from new sources while frozen counts finish and historical reports remain addressable", async () => {
  const db = fixture(), before = await createCount(db); await archive(db);
  assert.deepEqual((await listHotelStockCountSourcesHandler(request({ hotelUid }), services(db))).locations.map((location) => location.locationId), ["outlet:bar"]);
  await assert.rejects(createCount(db, "after"), { code: "failed-precondition" });
  await assert.rejects(mutateHotelStockTemplateHandler(request({ hotelUid, locationId: "store", templateId: "new", action: "create", name: "New", requestId: "template", expectedRevision: 0 }), services(db)), { code: "failed-precondition" });
  await mutateHotelStockCountHandler(request({ hotelUid, stockCountId: before.stockCountId, action: "finish-location", locationId: "store", expectedRevision: 0,
    countedItems: [{ catalogProductId: "juice", quantity: 10, isCounted: true, unitCost: null }] }), services(db));
  await mutateHotelStockCountHandler(request({ hotelUid, stockCountId: before.stockCountId, action: "finish-count", expectedRevision: 1 }), services(db));
  assert.equal(db.records.get(`hotels/${hotelUid}/stockCounts/${before.stockCountId}`).status, "Finished");
  assert.deepEqual((await listHotelInventoryLocationsHandler(request({ hotelUid }), services(db))).locations.map((location) => location.id), ["store"]);
});

test("archived destinations reject new receiving but a historical receipt can still be reversed at its original location", async () => {
  const db = fixture();
  const input = { hotelUid, locationId: "store", movementId: "receipt", orderId: "order", receiptId: "receipt", receivedOn: "2026-10-10", actorUid,
    lines: [{ catalogProductId: "juice", catalogProductName: "Orange juice", baseUnit: "l", quantity: 6, netUnitCost: 2, netValue: 12, currency: "EUR" }] };
  await db.runTransaction(async (tx) => { (await prepareReceiptMovement(db, tx, input)).write(); });
  await archive(db);
  await assert.rejects(db.runTransaction(async (tx) => prepareReceiptMovement(db, tx, { ...input, movementId: "after" })), { code: "failed-precondition" });
  await db.runTransaction(async (tx) => { (await prepareReversalMovement(db, tx, { hotelUid, movementId: "reverse", originalMovementId: "receipt", orderId: "order", actorUid })).write(); });
  assert.equal(db.records.get(`hotels/${hotelUid}/inventoryMovements/reverse`).lines[0].quantity, -6);
});
test("receiving can choose an outlet stock point before its first count and preserves the destination context", async () => {
  const db = fixture();
  db.records.set(`hotels/${hotelUid}/outlets/bar`, { name: "Central cellar", inventoryRole: "central_storage" });
  const input = { hotelUid, locationId: "outlet:bar", movementId: "outlet-receipt", orderId: "order", receiptId: "receipt", receivedOn: "2026-10-10", actorUid,
    lines: [{ catalogProductId: "juice", catalogProductName: "Orange juice", baseUnit: "l", quantity: 6, netUnitCost: 2, netValue: 12, currency: "EUR" }] };
  await db.runTransaction(async (tx) => { (await prepareReceiptMovement(db, tx, input)).write(); });
  const receipt = db.records.get(`hotels/${hotelUid}/inventoryMovements/outlet-receipt`);
  assert.equal(receipt.stockPointType, "outlet"); assert.equal(receipt.outletName, "Central cellar"); assert.equal(receipt.inventoryRole, "central_storage");
  assert.equal(db.records.get(`hotels/${hotelUid}/locations/outlet:bar`).stockPointType, "outlet");
  await archive(db, "outlets", "bar");
  await assert.rejects(db.runTransaction((tx) => prepareReceiptMovement(db, tx, { ...input, movementId: "after" })), { code: "failed-precondition" });
});

test("archived outlets cannot supply a new order contract even when the selected supplier and catalog are active", async () => {
  const db = fixture(); await archive(db, "outlets", "bar");
  await assert.rejects(db.runTransaction(async (tx) => canonicalLines(db, tx, hotelUid, [{ supplierProductId: "juice-case", outletId: "bar", qtyPurchaseUnits: 1 }])), { code: "failed-precondition" });
});

test("template display resolves same-hotel names for a locations-only reader without prices and keeps missing identities explicit", async () => {
  const db = fixture(); db.records.set(`hotels/${hotelUid}/members/${actorUid}`, { permissions: ["locations.read"] });
  db.records.set(`hotels/${hotelUid}/locations/store/stockTemplates/t`, { name: "Weekly", items: [
    { catalogProductId: "juice" }, { catalogProductId: "missing" }, { supplierProductId: "juice-case", outletId: "bar" }] });
  const response = await getHotelStockTemplateDisplayHandler(request({ hotelUid, locationId: "store", templateId: "t" }), services(db));
  assert.deepEqual(response.location, { id: "store", name: "Store", archived: false });
  assert.deepEqual(response.template, { id: "t", name: "Weekly", revision: 0, archived: false,
    items: [{ catalogProductId: "juice" }, { catalogProductId: "missing" }, { supplierProductId: "juice-case", outletId: "bar" }] });
  assert.deepEqual(response.items, [
    { catalogProductId: "juice", catalogProductName: "Orange juice", baseUnit: "l", available: true },
    { catalogProductId: "missing", catalogProductName: null, baseUnit: null, available: false },
    { supplierProductId: "juice-case", outletId: "bar", supplierProductName: "Orange juice six-pack", outletName: "Bar", available: true }]);
  assert.equal(JSON.stringify(response).includes("SECRET-ACCOUNT"), false); assert.equal(JSON.stringify(response).includes("pricePerPurchaseUnit"), false);
  await assert.rejects(getHotelStockTemplateDisplayHandler(request({ hotelUid: "hotel-b", locationId: "store", templateId: "t" }), services(db)), { code: "permission-denied" });
  db.records.set(`hotels/${hotelUid}/locations/store/stockTemplates/t`, { name: "Too large", items: Array.from({ length: 251 }, (_, index) => ({ catalogProductId: `id${index}` })) });
  await assert.rejects(getHotelStockTemplateDisplayHandler(request({ hotelUid, locationId: "store", templateId: "t" }), services(db)), { code: "invalid-argument" });
});

test("template projection keeps canonical context, revision and item order without exposing unrelated metadata", async () => {
  const db = fixture();
  db.records.set(`hotels/${hotelUid}/locations/store`, { id: "wrong-location", name: "Cold room", secret: "DO-NOT-PROJECT" });
  db.records.set(`hotels/${hotelUid}/locations/store/stockTemplates/t`, { id: "wrong-template", name: "Frozen ordering", revision: 7,
    notes: "DO-NOT-PROJECT", archived: true, items: [{ catalogProductId: "missing" }, { catalogProductId: "juice" }] });
  const result = await getHotelStockTemplateDisplayHandler(request({ hotelUid, locationId: "store", templateId: "t" }), services(db));
  assert.deepEqual(result.template, { id: "t", name: "Frozen ordering", revision: 7, archived: true,
    items: [{ catalogProductId: "missing" }, { catalogProductId: "juice" }] });
  assert.deepEqual(result.location, { id: "store", name: "Cold room", archived: false });
  assert.deepEqual(result.items.map((item) => item.catalogProductId), ["missing", "juice"]);
  assert.equal(JSON.stringify(result).includes("DO-NOT-PROJECT"), false);
  db.records.get(`hotels/${hotelUid}/locations/store/stockTemplates/t`).revision = "7";
  await assert.rejects(getHotelStockTemplateDisplayHandler(request({ hotelUid, locationId: "store", templateId: "t" }), services(db)), { code: "failed-precondition" });
});

test("template projection rechecks current Authentication on transaction retry", async () => {
  const db = fixture(), run = db.runTransaction.bind(db);
  let disabled = false, checks = 0;
  db.runTransaction = async (handler) => { await run(handler); disabled = true; return run(handler); };
  await assert.rejects(getHotelStockTemplateDisplayHandler(request({ hotelUid, locationId: "store", templateId: "t" }), {
    firestore: db, auth: { getUser: async () => { checks += 1; return { emailVerified: true, disabled }; } },
  }), { code: "permission-denied" });
  assert.equal(checks, 2);
});

test("generic imports cannot restore archived locations or forge resource command evidence", () => {
  for (const path of ["locations/store", "locations/store/stockTemplates/t", "procurementResourceOperations/forged", "procurementResourceAudit/forged"]) {
    assert.throws(() => requireHotelImportTarget(`hotels/${hotelUid}/${path}`, hotelUid));
  }
});

test("template display retains names but flags inactive, untracked, unsupported and unlinked count sources", async () => {
  const lookup = (db) => getHotelStockTemplateDisplayHandler(request({ hotelUid, locationId: "store", templateId: "t" }), services(db));
  for (const patch of [{ archived: true }, { active: false }, { inventoryTracked: false }, { baseUnit: "litres" }]) {
    const db = fixture(); db.records.set(`hotels/${hotelUid}/catalogproducts/juice`, { ...db.records.get(`hotels/${hotelUid}/catalogproducts/juice`), ...patch });
    const response = await lookup(db); assert.equal(response.items[0].catalogProductName, "Orange juice"); assert.equal(response.items[0].available, false);
  }
  for (const patch of [{ catalogProductId: null }, { catalogProductId: "missing" }, { catalogProductId: "foreign/path" }, { baseUnit: "g" }]) {
    const db = fixture(); db.records.set(`hotels/${hotelUid}/locations/store/stockTemplates/t`, { name: "Legacy", items: [{ supplierProductId: "juice-case", outletId: "bar" }] });
    db.records.set(`hotels/${hotelUid}/supplierproducts/juice-case`, { ...db.records.get(`hotels/${hotelUid}/supplierproducts/juice-case`), ...patch });
    const response = await lookup(db); assert.equal(response.items[0].supplierProductName, "Orange juice six-pack"); assert.equal(response.items[0].available, false);
  }
});

test("protected resource commands create outlet stock points and validate detail ownership with exact replay and revisions", async () => {
  const db = fixture();
  const input = { hotelUid, collection: "outlets", resourceId: "cellar", action: "create", expectedRevision: 0, requestId: "new-store",
    resource: { name: "Central cellar", inventoryRole: "central_storage" } };
  const first = await mutateHotelProcurementResourceHandler(request(input), services(db));
  assert.equal(first.revision, 1); assert.equal(first.archived, false);
  assert.deepEqual(await mutateHotelProcurementResourceHandler(request(input), services(db)), first);
  assert.equal(db.records.get(`hotels/${hotelUid}/locations/outlet:cellar`).outletId, "cellar");
  assert.equal(db.records.get(`hotels/${hotelUid}/locations/outlet:cellar`).stockPointType, "outlet");
  await mutateHotelProcurementResourceHandler(request({ ...input, action: "update", expectedRevision: 1, requestId: "rename-store",
    resource: { name: "Main cellar" } }), services(db));
  assert.equal(db.records.get(`hotels/${hotelUid}/outlets/cellar`).inventoryRole, "central_storage");
  assert.equal(db.records.get(`hotels/${hotelUid}/locations/outlet:cellar`).name, "Main cellar");
  const detail = { hotelUid, collection: "locations", resourceId: "rack", action: "create", expectedRevision: 0, requestId: "new-rack", resource: { name: "Wine rack", outletId: "cellar" } };
  await mutateHotelProcurementResourceHandler(request(detail), services(db));
  assert.equal(db.records.get(`hotels/${hotelUid}/locations/rack`).outletId, "cellar");
  db.records.set(`hotels/${hotelUid}/inventoryLocationStates/rack`, { sequence: 1 });
  await assert.rejects(mutateHotelProcurementResourceHandler(request({ ...detail, action: "update", expectedRevision: 1, requestId: "move-rack",
    resource: { name: "Wine rack", outletId: "bar" } }), services(db)), { code: "failed-precondition" });
  await assert.rejects(mutateHotelProcurementResourceHandler(request({ ...detail, resourceId: "other", requestId: "foreign-rack",
    resource: { name: "Other", outletId: "foreign-outlet" } }), services(db)), { code: "failed-precondition" });
  await assert.rejects(mutateHotelProcurementResourceHandler(request({ ...detail, resourceId: "outlet:bar", requestId: "forge" }), services(db)), { code: "invalid-argument" });
});

test("outlet stock points materialize without a count, reject forged markers and remain hotel scoped", async () => {
  const db = fixture();
  const resolved = await db.runTransaction(async (tx) => {
    const point = await prepareInventoryStockPoint(db, tx, hotelUid, "outlet:bar");
    assert.equal(point.stockPointType, "outlet"); assert.equal(point.outletId, "bar");
    assert.equal(point.locationName, "Bar"); point.write(); return point.locationId;
  });
  assert.equal(resolved, "outlet:bar");
  for (const source of [{ name: "Forged", outletId: "bar", stockPointPolicyVersion: 1, stockPointType: "outlet" },
    { name: "Wrong outlet", outletId: "cellar", stockPointPolicyVersion: 1, stockPointType: "outlet", resourcePolicyVersion: 1, revision: 0 }]) {
    db.records.set(`hotels/${hotelUid}/locations/outlet:bar`, source);
    await assert.rejects(db.runTransaction((tx) => prepareInventoryStockPoint(db, tx, hotelUid, "outlet:bar")), { code: "failed-precondition" });
  }
  await assert.rejects(db.runTransaction((tx) => prepareInventoryStockPoint(db, tx, "hotel-b", "outlet:bar")), { code: "failed-precondition" });
});

test("location-only editors receive narrow active outlet choices without outlet administration access", async () => {
  const db = fixture();
  db.records.set(`hotels/${hotelUid}/members/${actorUid}`, { permissions: ["locations.create"] });
  assert.deepEqual(await getHotelLocationOutletChoicesHandler(request({ hotelUid, action: "create" }), services(db)), {
    hotelUid, outlets: [{ id: "bar", name: "Bar", inventoryRole: "outlet" }] });
  await assert.rejects(getHotelLocationOutletChoicesHandler(request({ hotelUid, action: "update" }), services(db)), { code: "permission-denied" });
  await assert.rejects(mutateHotelProcurementResourceHandler(request({ hotelUid, collection: "outlets", resourceId: "new", action: "create", expectedRevision: 0,
    requestId: "unauthorized", resource: { name: "New" } }), services(db)), { code: "permission-denied" });
});
