const test = require("node:test"), assert = require("node:assert/strict");
const { memoryDatabase } = require("./inventoryTestHelpers");
const { listHotelStockCountProductsHandler } = require("./stockCountProducts");
const { SAAS_RULES_VERSION } = require("./saasRollout");
const base = "hotels/hotel-a";
const request = (patch = {}) => ({ auth: { uid: "counter", token: { email_verified: true } }, data: {
  hotelUid: "hotel-a", stockCountId: "count", locationId: "outlet:bar", search: "", barcode: "", afterProductId: null, ...patch,
} });
function fixture() { return memoryDatabase({
  [`${base}/members/counter`]: { permissions: ["stockcounts.read", "stockcounts.update"] },
  "hotelSubscriptions/hotel-a": { modules: ["procurement"], modulePolicyVersion: 1, status: "active", validUntil: null },
  "platformConfiguration/saasProcurement": { enabled: true, rulesVersion: SAAS_RULES_VERSION },
  [`${base}/stockCounts/count`]: { inventoryPolicyVersion: 1, status: "Started", currency: "EUR", businessDate: "2026-10-12", locations: [{ locationId: "outlet:bar" }] },
  [`${base}/stockCounts/count/locations/outlet:bar`]: { inventoryPolicyVersion: 1, status: "Not Started", currency: "EUR", businessDate: "2026-10-12", stockTemplate: { items: [] } },
  [`${base}/catalogproducts/juice`]: { name: "Orange juice", nameLower: "orange juice", internalSku: "FRUIT-1", gtin: "000123", baseUnit: "l", inventoryTracked: true, active: true },
  [`${base}/catalogproducts/milk`]: { name: "Milk", nameLower: "milk", baseUnit: "l", inventoryTracked: true, active: true },
  [`${base}/catalogproducts/untracked`]: { name: "Not inventory", baseUnit: "each", inventoryTracked: false, active: true },
  [`${base}/supplierproducts/juice-case`]: { productPolicyVersion: 1, catalogProductId: "juice", active: true, baseUnit: "ml", gtin: "036000291452", pricePerPurchaseUnit: 999,
    purchaseOptions: [{ id: "bottle", gtin: "06291041500213", pricePerPurchaseUnit: 123 }] },
  "hotels/hotel-b/catalogproducts/foreign": { name: "Secret article", baseUnit: "each", inventoryTracked: true },
}); }
const services = (db, extra = {}) => ({ firestore: db, auth: { getUser: async () => ({ emailVerified: true, disabled: false }) }, ...extra });
const load = (db, patch, extra) => listHotelStockCountProductsHandler(request(patch), services(db, extra));

test("ordinary stock users discover products and exact package barcodes without purchasing privileges or prices", async () => {
  const db = fixture(), before = structuredClone([...db.records]);
  const page = await load(db);
  assert.deepEqual(page.products, [{ id: "juice", name: "Orange juice", baseUnit: "l", barcodes: ["000123"] },
    { id: "milk", name: "Milk", baseUnit: "l", barcodes: [] }]);
  assert.equal(page.nextCursor, null);
  assert.equal(JSON.stringify(page).includes("price"), false); assert.equal(JSON.stringify(page).includes("Secret"), false);
  assert.deepEqual([...db.records], before);
  assert.deepEqual((await load(db, { search: "ORANGE" })).products.map((row) => row.id), ["juice"]);
  for (const barcode of ["000123", "036000291452", "06291041500213"]) assert.deepEqual((await load(db, { barcode })).products.map((row) => row.id), ["juice"]);
  assert.deepEqual((await load(db, { barcode: "6291041500213" })).products, []);
});
test("multiple products sharing a barcode remain separate choices, with unavailable offers excluded", async () => {
  const db = fixture(); db.records.set(`${base}/catalogproducts/milk`, { ...db.records.get(`${base}/catalogproducts/milk`), gtin: "000123" });
  assert.deepEqual((await load(db, { barcode: "000123" })).products.map((row) => row.id), ["juice", "milk"]);
  for (const patch of [{ active: false }, { archived: true }, { baseUnit: "kg" }, { productPolicyVersion: null }]) {
    const sample = fixture(); sample.records.set(`${base}/supplierproducts/juice-case`, { ...sample.records.get(`${base}/supplierproducts/juice-case`), ...patch });
    assert.deepEqual((await load(sample, { barcode: "036000291452" })).products, []);
  }
});
test("projection rejects unrelated hotel/count/destination and rechecks account, permissions, subscription and rollout", async () => {
  for (const patch of [{ hotelUid: "hotel-b" }, { stockCountId: "other" }, { locationId: "other" }]) {
    await assert.rejects(load(fixture(), patch), { code: patch.hotelUid ? "permission-denied" : "not-found" });
  }
  for (const permissions of [[], ["stockcounts.read"], ["stockcounts.update"], ["catalogproducts.read"]]) {
    const db = fixture(); db.records.set(`${base}/members/counter`, { permissions }); await assert.rejects(load(db), { code: "permission-denied" });
  }
  await assert.rejects(load(fixture(), {}, { auth: { getUser: async () => ({ emailVerified: true, disabled: true }) } }), { code: "permission-denied" });
  for (const path of [`${base}/stockCounts/count`, `${base}/stockCounts/count/locations/outlet:bar`]) {
    const db = fixture(); db.records.set(path, { ...db.records.get(path), status: "Finished" }); await assert.rejects(load(db), { code: "failed-precondition" });
  }
  const subscription = fixture(); subscription.records.set("hotelSubscriptions/hotel-a", { status: "suspended" });
  await assert.rejects(load(subscription), { code: "permission-denied" });
  const gate = fixture(); gate.records.set("platformConfiguration/saasProcurement", { enabled: false });
  await assert.rejects(load(gate), { code: "failed-precondition" });
});
test("barcode pages reconcile optional packages beyond the first page without assuming uniqueness", async () => {
  const db = fixture();
  for (let i = 0; i < 101; i++) db.records.set(`${base}/supplierproducts/a${String(i).padStart(3, "0")}`, { catalogProductId: "juice", productPolicyVersion: 1, active: true, baseUnit: "l", purchaseOptions: [] });
  db.records.set(`${base}/supplierproducts/z-milk`, { catalogProductId: "milk", productPolicyVersion: 1, active: true, baseUnit: "l", purchaseOptions: [{ id: "extra", gtin: "06291041500213" }] });
  const first = await load(db, { barcode: "06291041500213" }); assert.deepEqual(first.products, []); assert.equal(first.nextCursor, "barcode:YTA5OQ");
  const second = await load(db, { barcode: "06291041500213", afterProductId: first.nextCursor });
  assert.deepEqual(second.products.map((row) => row.id), ["juice", "milk"]); assert.equal(second.nextCursor, null);
  await assert.rejects(load(db, { afterProductId: "missing" }), { code: "failed-precondition" });
  await assert.rejects(load(db, { barcode: "06291041500213", afterProductId: "barcode:Li4" }), { code: "invalid-argument" });
});
test("name-prefix search finds a product beyond 500 earlier IDs without reading unrelated supplier offers", async () => {
  const db = fixture();
  for (let i = 0; i < 501; i++) db.records.set(`${base}/catalogproducts/a${String(i).padStart(3, "0")}`, { name: `Early ${i}`, nameLower: `early ${i}`, baseUnit: "each", inventoryTracked: true });
  const collection = db.collection;
  db.collection = (path) => { assert.equal(path.includes("supplierproducts"), false, "Browsing and name search never hydrate supplier offers"); return collection(path); };
  const result = await load(db, { search: "mil" });
  assert.deepEqual(result.products.map((row) => row.id), ["milk"]); assert.equal(result.nextCursor, null);
  const browse = await load(db); assert.equal(browse.products.length, 25); assert.equal(browse.nextCursor, "a024");
});
