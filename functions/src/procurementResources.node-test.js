const test = require("node:test");
const assert = require("node:assert/strict");
const { memoryDatabase } = require("./inventoryTestHelpers");
const { mutateHotelProcurementResourceHandler } = require("./procurementResources");
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

test("the old v4 release marker cannot activate archiving before the tightened v5 Rules rollout", async () => {
  const db = fixture(); db.records.set("platformConfiguration/saasProcurement", { enabled: true, rulesVersion: "saas-platform-v4" });
  await assert.rejects(archive(db), (error) => error.code === "failed-precondition" && !error.details?.resourceRequestUncommitted);
  assert.equal(db.records.get(`hotels/${hotelUid}/locations/store`).archived, undefined);
  db.records.set("platformConfiguration/saasProcurement", { enabled: true, rulesVersion: "saas-platform-v5" });
  assert.equal((await archive(db)).archived, true);
});

test("archived locations are excluded from new sources while frozen counts finish and historical reports remain addressable", async () => {
  const db = fixture(), before = await createCount(db); await archive(db);
  assert.deepEqual((await listHotelStockCountSourcesHandler(request({ hotelUid }), services(db))).locations, []);
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

test("archived outlets cannot supply a new order contract even when the selected supplier and catalog are active", async () => {
  const db = fixture(); await archive(db, "outlets", "bar");
  await assert.rejects(db.runTransaction(async (tx) => canonicalLines(db, tx, hotelUid, [{ supplierProductId: "juice-case", outletId: "bar", qtyPurchaseUnits: 1 }])), { code: "failed-precondition" });
});

test("template display resolves same-hotel names for a locations-only reader without prices and keeps missing identities explicit", async () => {
  const db = fixture(); db.records.set(`hotels/${hotelUid}/members/${actorUid}`, { permissions: ["locations.read"] });
  db.records.set(`hotels/${hotelUid}/locations/store/stockTemplates/t`, { name: "Weekly", items: [
    { catalogProductId: "juice" }, { catalogProductId: "missing" }, { supplierProductId: "juice-case", outletId: "bar" }] });
  const response = await getHotelStockTemplateDisplayHandler(request({ hotelUid, locationId: "store", templateId: "t" }), services(db));
  assert.deepEqual(response.items, [
    { catalogProductId: "juice", catalogProductName: "Orange juice", baseUnit: "l", available: true },
    { catalogProductId: "missing", catalogProductName: null, baseUnit: null, available: false },
    { supplierProductId: "juice-case", outletId: "bar", supplierProductName: "Orange juice six-pack", outletName: "Bar", available: true }]);
  assert.equal(JSON.stringify(response).includes("SECRET-ACCOUNT"), false); assert.equal(JSON.stringify(response).includes("pricePerPurchaseUnit"), false);
  await assert.rejects(getHotelStockTemplateDisplayHandler(request({ hotelUid: "hotel-b", locationId: "store", templateId: "t" }), services(db)), { code: "permission-denied" });
  db.records.set(`hotels/${hotelUid}/locations/store/stockTemplates/t`, { name: "Too large", items: Array.from({ length: 251 }, (_, index) => ({ catalogProductId: `id${index}` })) });
  await assert.rejects(getHotelStockTemplateDisplayHandler(request({ hotelUid, locationId: "store", templateId: "t" }), services(db)), { code: "invalid-argument" });
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
