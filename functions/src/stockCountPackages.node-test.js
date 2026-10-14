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

function approvedPackageVersion(id, revision, patch = {}) {
  const { pricingTerms } = require("./supplierPricePolicy");
  const { purchaseTerms } = require("./supplierPriceVersions");
  const { digest } = require("./validation");
  const product = reviewed({ pricingModel: "Per Purchase Unit", pricePerPurchaseUnit: 1299, priceBasis: "net", vatRate: null,
    priceValidFrom: "2026-10-01", priceValidUntil: null, ...patch });
  const terms = pricingTerms(product, { baseUnit: "l" });
  return { id, supplierPriceVersionPolicyVersion: 1, supplierProductId: "case", supplierId: "vendor", revision,
    termsFingerprint: digest(terms), terms, productTerms: purchaseTerms(product),
    sourceKind: "supplier-list", sourceReference: "PRIVATE supplier agreement.xlsx", sourceIssuedOn: "2026-10-01",
    lastPriceChangeAt: { seconds: 1700000000 }, optionReliability: {} };
}
function countDate(db, date) {
  for (const path of [`${base}/stockCounts/count`, `${base}/stockCounts/count/locations/store`]) db.records.set(path, { ...db.records.get(path), businessDate: date });
}

test("unfinished count package entry uses approved contents at its frozen business date without financial disclosures or count mutation", async () => {
  const db = fixture();
  db.records.set(`${base}/supplierPriceVersions/case/entries/current`, approvedPackageVersion("current", 1));
  db.records.set(`${base}/supplierPriceVersions/case/entries/upcoming`, approvedPackageVersion("upcoming", 2, {
    priceValidFrom: "2026-11-01", priceValidUntil: "2026-11-15", baseUnitsPerPurchaseUnit: 3000,
    pricePerPurchaseUnit: 4999, currency: "USD", priceBasis: "gross", vatRate: 0.21,
    purchaseOptions: [{ id: "bottle", purchaseUnit: "Bottle", baseUnitsPerPurchaseUnit: 500, pricePerPurchaseUnit: 333 }],
  }));
  const before = structuredClone([...db.records]);
  const earlier = await load(db);
  assert.deepEqual(earlier.options.map((option) => option.catalogUnitsPerPackage), [6]);
  assert.deepEqual([...db.records], before);
  countDate(db, "2026-11-01");
  const activatedBefore = structuredClone([...db.records]), activated = await load(db);
  assert.deepEqual(activated.options.map((option) => option.catalogUnitsPerPackage), [3, 0.5]);
  assert.equal(activated.catalogBaseUnit, "l");
  const encoded = JSON.stringify(activated);
  for (const privateValue of ["price", "PRIVATE", "USD", "4999", "333", "0.21", "sourceReference", "confirmed"]) assert.equal(encoded.includes(privateValue), false, privateValue);
  assert.deepEqual([...db.records], activatedBefore, "package helper never rewrites rows, costs, checkpoints or supplier terms");
  assert.equal(db.records.get(`${base}/supplierproducts/case`).baseUnitsPerPurchaseUnit, 6000, "raw convenience projection may remain older while approved content resolves correctly");
  countDate(db, "2026-11-20");
  assert.deepEqual((await load(db)).options.map((option) => option.catalogUnitsPerPackage), [3, 0.5], "an expired monetary agreement does not remove known physical package content");
});

test("future-only and corrupt approved package evidence remain unavailable without exposing supplier financial sources", async () => {
  const db = fixture();
  db.records.set(`${base}/supplierPriceVersions/case/entries/upcoming`, approvedPackageVersion("upcoming", 1, { priceValidFrom: "2026-11-01" }));
  const future = await load(db);
  assert.deepEqual(future.options, []); assert.equal(future.unavailable[0].reason, "package-terms-not-effective-on-count-date");
  const broken = db.records.get(`${base}/supplierPriceVersions/case/entries/upcoming`);
  db.records.set(`${base}/supplierPriceVersions/case/entries/upcoming`, { ...broken, supplierProductId: "foreign" });
  const corrupt = await load(db);
  assert.deepEqual(corrupt.options, []); assert.equal(corrupt.unavailable[0].reason, "approved-package-evidence-needs-review");
  assert.equal(JSON.stringify(corrupt).includes("PRIVATE"), false);
});

test("catalog counts require a reconciled valid business date before dated package conversion", async () => {
  for (const date of [undefined, null, "2026-02-30", "2026-11-01T00:00:00Z"]) {
    const db = fixture(); countDate(db, date);
    await assert.rejects(load(db), { code: "failed-precondition" });
  }
});
