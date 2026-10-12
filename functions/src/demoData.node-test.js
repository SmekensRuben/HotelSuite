process.env.FIREBASE_CONFIG = JSON.stringify({ projectId: "demo-hotel-suite-a00", storageBucket: "demo-hotel-suite-a00.appspot.com" });
const test = require("node:test");
const assert = require("node:assert/strict");
const { memoryDatabase } = require("./inventoryTestHelpers");
const { buildDemoData } = require("./demoDataFixtures");
const { manageHotelDemoDataHandler } = require("./demoData");
const { demoSupplierMode, TEST_HOTEL_UID, DATASET_ID, SUPPLIER_IDS, manifestPath } = require("./demoDataPolicy");
const { SAAS_RULES_VERSION } = require("./saasRollout");
const { period } = require("./inventoryPolicy");
const { requireHotelImportTarget } = require("./fileImportTypes");
const request = (action = "apply", extra = {}) => ({ auth: { uid: "operator", token: { platformAdmin: true, email_verified: true } },
  data: { hotelUid: TEST_HOTEL_UID, datasetId: DATASET_ID, action, ...extra } });
function fixture() {
  const db = memoryDatabase({
    [`hotels/${TEST_HOTEL_UID}`]: { name: "Test hotel", timeZone: "Europe/Brussels" },
    [`hotels/${TEST_HOTEL_UID}/settings/bootstrap`]: { currency: "EUR" },
    [`hotelSubscriptions/${TEST_HOTEL_UID}`]: { status: "active", validUntil: null, modules: ["procurement"], modulePolicyVersion: 1 },
    "platformConfiguration/saasProcurement": { enabled: true, rulesVersion: SAAS_RULES_VERSION },
    "hotels/real-hotel/catalogproducts/keep": { name: "Untouched real article" },
  });
  const services = { firestore: db, now: () => Date.parse("2026-10-12T21:00:00Z"),
    auth: { getUser: async (uid) => ({ uid, emailVerified: true, disabled: false, customClaims: { platformAdmin: true } }) } };
  return { db, services };
}
test("fixture uses canonical units, distinct packages, known zero/unknown prices and reconcilable evidence", () => {
  const fixture = buildDemoData({ actorUid: "operator", businessDate: "2026-10-12", currency: "EUR" });
  assert.equal(fixture.docs.length, new Set(fixture.docs.map((d) => d.path)).size);
  assert(fixture.docs.every((d) => d.path.startsWith(`hotels/${TEST_HOTEL_UID}/`) && d.data.demoData.synthetic));
  assert.equal(fixture.summary.catalogProducts, 12); assert.equal(fixture.summary.supplierProducts, 15);
  const records = new Map(fixture.docs.map((d) => [d.path, d.data]));
  const milk = records.get(`hotels/${TEST_HOTEL_UID}/supplierproducts/demo-v1-offer-milk-case`);
  assert.equal(milk.baseUnit, "ml"); assert.equal(milk.purchaseOptions[0].id, "single");
  assert.equal(records.get(`hotels/${TEST_HOTEL_UID}/supplierproducts/demo-v1-offer-free-sample`).pricePerPurchaseUnit, 0);
  assert.equal(records.get(`hotels/${TEST_HOTEL_UID}/supplierproducts/demo-v1-offer-price-needed`).pricePerPurchaseUnit, null);
  const checkpoints = fixture.docs.filter((d) => d.path.includes("/inventoryCheckpoints/")).map((d) => d.data);
  const movements = fixture.docs.filter((d) => d.path.includes("/inventoryMovements/")).map((d) => d.data);
  for (const locationId of ["demo-v1-location-1", "demo-v1-location-2", "demo-v1-location-3"]) {
    const [opening, closing] = checkpoints.filter((d) => d.locationId === locationId).sort((a, b) => a.sequence - b.sequence);
    const selected = movements.filter((d) => d.locationId === locationId);
    assert.deepEqual([opening.sequence, ...selected.map((d) => d.sequence), closing.sequence].sort((a, b) => a - b),
      Array.from({ length: closing.sequence }, (_, i) => i + 1));
    const result = period(opening, closing, selected);
    assert.equal(result.coverage.quantityComplete, true);
    if (locationId === "demo-v1-location-1") {
      const line = result.items.find((d) => d.catalogProductId === "demo-v1-catalog-milk");
      assert.equal(line.inferredUsageQuantity, 50); assert.equal(line.periodUnitCost, 290 / 130);
    }
    if (locationId === "demo-v1-location-2") {
      assert.equal(result.items.find((d) => d.catalogProductId === "demo-v1-catalog-water").netReceiptQuantity, 12);
      assert.equal(result.coverage.costComplete, false);
    }
  }
  assert.equal(fixture.docs.some((d) => /mailQueue|dispatches|invitations|\/members\//.test(d.path)), false);
});
test("preview is read-only; repeated apply preserves edits, dates and all other hotels", async () => {
  const { db, services } = fixture(), before = db.records.size;
  const preview = await manageHotelDemoDataHandler(request("preview"), services);
  assert.equal(preview.canApply, true); assert.equal(db.records.size, before);
  const created = await manageHotelDemoDataHandler(request(), services);
  const size = db.records.size;
  db.records.get(`hotels/${TEST_HOTEL_UID}/catalogproducts/demo-v1-catalog-milk`).name = "Operator edited this article";
  const repeated = await manageHotelDemoDataHandler(request(), { ...services, now: () => Date.parse("2027-01-01T00:00:00Z") });
  assert.equal(repeated.alreadyLoaded, true); assert.equal(repeated.businessDate, created.businessDate);
  assert.equal(db.records.size, size);
  assert.equal(db.records.get(`hotels/${TEST_HOTEL_UID}/catalogproducts/demo-v1-catalog-milk`).name, "Operator edited this article");
  assert.deepEqual(db.records.get("hotels/real-hotel/catalogproducts/keep"), { name: "Untouched real article" });
  assert.equal([...db.records.keys()].some((key) => /users\/|\/members\//.test(key)), false);
});
test("conflicting IDs abort the entire seed instead of overwriting or filling a partial prefix", async () => {
  const { db, services } = fixture();
  const path = `hotels/${TEST_HOTEL_UID}/supplierproducts/demo-v1-offer-flour`;
  db.records.set(path, { name: "Existing data" }); const size = db.records.size;
  const preview = await manageHotelDemoDataHandler(request("preview"), services);
  assert.equal(preview.canApply, false); assert.deepEqual(preview.conflicts, [path]);
  await assert.rejects(manageHotelDemoDataHandler(request(), services), { code: "already-exists" });
  assert.equal(db.records.size, size); assert.deepEqual(db.records.get(path), { name: "Existing data" });
});
test("authority, target, release and subscription cannot be supplied or bypassed by callers", async () => {
  const { db, services } = fixture(), size = db.records.size;
  await assert.rejects(manageHotelDemoDataHandler({ ...request(), auth: { uid: "hotel-admin", token: { email_verified: true } } }, services), { code: "permission-denied" });
  await assert.rejects(manageHotelDemoDataHandler(request("apply", { hotelUid: "real-hotel" }), services), { code: "invalid-argument" });
  await assert.rejects(manageHotelDemoDataHandler(request("apply", { docs: [] }), services), { code: "invalid-argument" });
  await assert.rejects(manageHotelDemoDataHandler(request(), { ...services, auth: { getUser: async () => ({ uid: "operator", emailVerified: true, customClaims: {} }) } }), { code: "permission-denied" });
  db.records.get("platformConfiguration/saasProcurement").rulesVersion = "saas-platform-v3";
  await assert.rejects(manageHotelDemoDataHandler(request(), services), { code: "failed-precondition" });
  db.records.get("platformConfiguration/saasProcurement").rulesVersion = SAAS_RULES_VERSION;
  db.records.get(`hotelSubscriptions/${TEST_HOTEL_UID}`).modules = [];
  await assert.rejects(manageHotelDemoDataHandler(request(), services), { code: "permission-denied" });
  assert.equal(db.records.size, size);
});
test("reserved supplier delivery is fail-closed and cannot escape through contact changes or another hotel", async () => {
  const { db, services } = fixture();
  await assert.rejects(demoSupplierMode(db, TEST_HOTEL_UID, SUPPLIER_IDS[0]), { code: "failed-precondition" });
  await manageHotelDemoDataHandler(request(), services);
  db.records.get(`hotels/${TEST_HOTEL_UID}/suppliers/${SUPPLIER_IDS[0]}`).orderEmail = "real@example.test";
  assert.equal(await demoSupplierMode(db, TEST_HOTEL_UID, SUPPLIER_IDS[0]), true);
  assert.equal(await demoSupplierMode(db, "real-hotel", SUPPLIER_IDS[0]), false);
  assert.equal(await demoSupplierMode(db, TEST_HOTEL_UID, "real-supplier"), false);
  assert.throws(() => requireHotelImportTarget(manifestPath(TEST_HOTEL_UID), TEST_HOTEL_UID));
});
