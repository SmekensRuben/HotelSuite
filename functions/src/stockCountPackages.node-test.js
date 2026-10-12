const test = require("node:test"), assert = require("node:assert/strict");
const { memoryDatabase } = require("./inventoryTestHelpers");
const { getHotelStockCountPackageOptionsHandler, packageOptions } = require("./stockCountPackages");
const { SAAS_RULES_VERSION } = require("./saasRollout");
const base = "hotels/hotel-a", actor = "counter";
const request = (patch = {}) => ({ auth: { uid: actor, token: { email_verified: true } }, data: { hotelUid: "hotel-a", stockCountId: "count", locationId: "store", catalogProductId: "juice", afterSupplierProductId: null, ...patch } });
const reviewed = (patch = {}) => ({ productPolicyVersion: 1, active: true, supplierId: "vendor", catalogProductId: "juice", supplierProductName: "Orange juice case",
  baseUnit: "ml", baseUnitsPerPurchaseUnit: 6000, purchaseUnit: "Case", pricePerPurchaseUnit: null, priceBasis: "unknown", currency: "EUR", purchaseOptions: [], ...patch });
function fixture() { return memoryDatabase({
  [`${base}/members/${actor}`]: { permissions: ["stockcounts.read", "stockcounts.update"] },
  "hotelSubscriptions/hotel-a": { status: "active", validUntil: null, modules: ["procurement"], modulePolicyVersion: 1 },
  "platformConfiguration/saasProcurement": { enabled: true, rulesVersion: SAAS_RULES_VERSION },
  [`${base}/stockCounts/count`]: { inventoryPolicyVersion: 1, status: "In Progress", currency: "EUR", businessDate: "2026-10-12", locations: [{ locationId: "store" }] },
  [`${base}/stockCounts/count/locations/store`]: { inventoryPolicyVersion: 1, status: "Not Started", currency: "EUR", businessDate: "2026-10-12", stockTemplate: { items: [{ catalogProductId: "juice", catalogProductName: "Frozen orange juice", baseUnit: "l" }] }, countedItems: [] },
  [`${base}/catalogproducts/juice`]: { name: "Current orange juice", baseUnit: "l", active: true, inventoryTracked: true },
  [`${base}/supplierproducts/case`]: reviewed(), [`${base}/suppliers/vendor`]: { name: "Vendor", accountNumber: "SECRET" },
  "hotels/hotel-b/supplierproducts/case": reviewed({ baseUnitsPerPurchaseUnit: 99000 }),
}); }
const service = (db, extra = {}) => ({ firestore: db, auth: { getUser: async () => ({ emailVerified: true, disabled: false }) }, ...extra });
const load = (db, patch, extra) => getHotelStockCountPackageOptionsHandler(request(patch), service(db, extra));

test("ordinary counters get exact compatible physical packages without directory rights or prices", async () => {
  const db = fixture(), before = structuredClone([...db.records]);
  const data = await load(db);
  assert.equal(data.catalogBaseUnit, "l"); assert.equal(data.options[0].catalogUnitsPerPackage, 6);
  assert.equal(data.options[0].supplierName, "Vendor"); assert.equal(data.options[0].id, '["case","default"]');
  assert.equal(JSON.stringify(data).includes("price"), false); assert.equal(JSON.stringify(data).includes("SECRET"), false);
  assert.deepEqual([...db.records], before); assert.equal(data.nextCursor, null);
});

test("counter access rechecks current identity, permissions, subscription, hotel and Rules in the read-only transaction", async () => {
  for (const permissions of [[], ["stockcounts.read"], ["stockcounts.update"], ["catalogproducts.read", "supplierproducts.read"]]) {
    const db = fixture(); db.records.set(`${base}/members/${actor}`, { permissions }); await assert.rejects(load(db), { code: "permission-denied" });
  }
  await assert.rejects(load(fixture(), { hotelUid: "hotel-b" }), { code: "permission-denied" });
  await assert.rejects(load(fixture(), {}, { auth: { getUser: async () => ({ disabled: true, emailVerified: true }) } }), { code: "permission-denied" });
  for (const marker of [{ enabled: false, rulesVersion: SAAS_RULES_VERSION }, { enabled: true, rulesVersion: "saas-platform-v4" }]) {
    const db = fixture(); db.records.set("platformConfiguration/saasProcurement", marker); await assert.rejects(load(db), { code: "failed-precondition" });
  }
  const db = fixture(); db.records.set("hotelSubscriptions/hotel-a", { status: "suspended", modules: ["procurement"], modulePolicyVersion: 1 }); await assert.rejects(load(db), { code: "permission-denied" });
});

test("requires an actual mutable count row, never an arbitrary catalog directory lookup", async () => {
  for (const patch of [{ stockCountId: "other" }, { locationId: "other" }, { catalogProductId: "other" }]) await assert.rejects(load(fixture(), patch), { code: "not-found" });
  for (const path of [`${base}/stockCounts/count`, `${base}/stockCounts/count/locations/store`]) {
    const db = fixture(); db.records.set(path, { ...db.records.get(path), status: "Finished" }); await assert.rejects(load(db), { code: "failed-precondition" });
  }
  const db = fixture(); db.records.set(`${base}/stockCounts/count/locations/store`, { ...db.records.get(`${base}/stockCounts/count/locations/store`), inventoryPolicyVersion: 0 }); await assert.rejects(load(db), { code: "failed-precondition" });
  for (const patch of [{ hotelUid: "a/b" }, { baseUnit: "kg" }, { afterSupplierProductId: "a/b" }]) await assert.rejects(load(fixture(), patch), { code: "invalid-argument" });
});

test("frozen unit remains authoritative and unavailable catalog sources do not alter counts", async () => {
  for (const patch of [{ baseUnit: "ml" }, { active: false }, { inventoryTracked: false }, { archived: true }]) {
    const db = fixture(); db.records.set(`${base}/catalogproducts/juice`, { ...db.records.get(`${base}/catalogproducts/juice`), ...patch });
    const data = await load(db); assert.equal(data.catalogBaseUnit, "l"); assert.deepEqual(data.options, []); assert.equal(data.unavailable.length, 1);
    assert.equal(db.records.get(`${base}/stockCounts/count/locations/store`).stockTemplate.items[0].baseUnit, "l");
  }
});

test("reviewed unknown-cost packages count, malformed, inactive, unknown and incompatible contents stay explicitly unavailable", async () => {
  for (const patch of [{ active: false }, { active: null }, { archived: true }, { productPolicyVersion: null }, { baseUnit: "kg" }, { baseUnit: "litre" },
    { baseUnitsPerPurchaseUnit: null }, { baseUnitsPerPurchaseUnit: "6000" }, { baseUnitsPerPurchaseUnit: 0 }, { baseUnitsPerPurchaseUnit: 0.000001 },
    { purchaseUnit: "" }, { purchaseOptions: [{ id: "default", purchaseUnit: "Bottle", baseUnitsPerPurchaseUnit: 1000 }] }, { hasVariants: true }]) {
    const db = fixture(); db.records.set(`${base}/supplierproducts/case`, reviewed(patch)); const data = await load(db);
    assert.deepEqual(data.options, [], JSON.stringify(patch)); assert.equal(data.unavailable.length, 1);
  }
  const db = fixture(); db.records.set(`${base}/supplierproducts/case`, reviewed({ purchaseOptions: [{ id: "bottle", purchaseUnit: "Bottle", baseUnitsPerPurchaseUnit: 1000, pricePerPurchaseUnit: null }] }));
  assert.deepEqual((await load(db)).options.map((option) => option.catalogUnitsPerPackage), [6, 1]);
  assert.equal(packageOptions(reviewed({ baseUnit: "g", baseUnitsPerPurchaseUnit: 2500 }), "mass", "kg", "Vendor").options[0].catalogUnitsPerPackage, 2.5);
});

test("projection is deterministic and bounded with explicit cursor pages, including unavailable sources", async () => {
  const db = fixture(); db.records.delete(`${base}/supplierproducts/case`);
  for (let i = 0; i < 31; i++) db.records.set(`${base}/supplierproducts/p${String(i).padStart(2, "0")}`, reviewed({ active: i > 0 }));
  const first = await load(db); assert.equal(first.options.length, 24); assert.equal(first.unavailable.length, 1); assert.equal(first.nextCursor, "p24");
  const second = await load(db, { afterSupplierProductId: first.nextCursor }); assert.equal(second.options.length, 6); assert.equal(second.nextCursor, null);
  assert.deepEqual(first, await load(db));
  db.records.set(`${base}/supplierproducts/other`, reviewed({ catalogProductId: "unrelated" }));
  await assert.rejects(load(db, { afterSupplierProductId: "other" }), { code: "failed-precondition" });
  await assert.rejects(load(db, { afterSupplierProductId: "missing" }), { code: "failed-precondition" });
});


test("actual transaction retries recheck Auth revocation without reusing the first callback's actor cache", async () => {
  const db = fixture(), original = db.runTransaction;
  let disabled = false, lookups = 0;
  db.runTransaction = async (callback) => { await original(callback); disabled = true; return original(callback); };
  await assert.rejects(load(db, {}, { auth: { getUser: async () => { lookups++; return { disabled, emailVerified: true }; } } }), { code: "permission-denied" });
  assert.equal(lookups, 2);
});


test("package identity remains unambiguous when legitimate document and option IDs contain colons", () => {
  const left = packageOptions(reviewed({ purchaseOptions: [{ id: "part:default", purchaseUnit: "Case", baseUnitsPerPurchaseUnit: 6 }] }), "a", "l", "Vendor");
  const right = packageOptions(reviewed(), "a:part", "l", "Vendor");
  assert.notEqual(left.options[1].id, right.options[0].id);
  assert.deepEqual(JSON.parse(left.options[1].id), ["a", "part:default"]);
});
