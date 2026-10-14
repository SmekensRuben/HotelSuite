const test = require("node:test");
const assert = require("node:assert/strict");
const { getHotelSupplierPriceInsightsHandler } = require("./supplierPriceInsights");
const { pricingTerms } = require("./supplierPricePolicy");
const { SAAS_RULES_VERSION } = require("./saasRollout");

function database(initial) {
  const records = new Map(Object.entries(initial)), seen = [];
  const snapshot = (path) => ({ id: path.split("/").at(-1), exists: records.has(path), data: () => records.get(path) });
  const db = { records, seen, doc: (path) => ({ path }), collection: (path) => {
    const build = (filter = null, order = "id", direction = "asc", after = null, limit = Infinity) => ({ isQuery: true,
      where: (key, operator, value) => { assert.equal(operator, "=="); return build([key, value], order, direction, after, limit); },
      orderBy: (key, nextDirection = "asc") => build(filter, typeof key === "string" ? key : "id", nextDirection, after, limit),
      startAfter: (value) => build(filter, order, direction, value, limit), limit: (value) => build(filter, order, direction, after, value),
      get: async () => { seen.push(path); const value = (entry) => order === "id" ? entry[0].split("/").at(-1) : entry[1][order];
        const matching = [...records].filter(([key, data]) => key.startsWith(path + "/") && !key.slice(path.length + 1).includes("/") && (!filter || data[filter[0]] === filter[1]))
          .sort((left, right) => (value(left) < value(right) ? -1 : value(left) > value(right) ? 1 : 0) * (direction === "desc" ? -1 : 1))
          .filter((entry) => after === null || (direction === "desc" ? value(entry) < after : value(entry) > after)).slice(0, limit);
        return { docs: matching.map(([key]) => snapshot(key)) }; } }); return build();
  }, runTransaction: async (fn) => fn({ get: async (ref) => ref.isQuery ? ref.get() : snapshot(ref.path), getAll: async (...refs) => refs.map((ref) => snapshot(ref.path)) }) };
  return db;
}
const auth = { getUser: async () => ({ emailVerified: true, disabled: false }) };
const request = (data) => ({ auth: { uid: "buyer", token: { email_verified: true } }, data: { hotelUid: "a", ...data } });
const permissions = ["catalogproducts.read", "supplierproducts.read", "suppliers.read"];
const catalog = { name: "Orange juice", baseUnit: "l", active: true, productPolicyVersion: 1 };
const offer = (patch = {}) => ({ supplierId: "s", supplierSku: "sku", supplierProductName: "Juice", catalogProductId: "juice", productPolicyVersion: 1,
  active: true, currency: "EUR", priceBasis: "gross", vatRate: 0.06, baseUnit: "ml", baseUnitsPerPurchaseUnit: 6000,
  purchaseUnit: "Case", pricePerPurchaseUnit: 15.9, purchaseOptions: [], ...patch });
const fixture = () => database({ "hotels/a/members/buyer": { permissions }, "hotelSubscriptions/a": { status: "active", modules: ["procurement"], modulePolicyVersion: 1, validUntil: null },
  "hotels/a": { timeZone: "Europe/Brussels" },
  "platformConfiguration/saasProcurement": { enabled: true, rulesVersion: SAAS_RULES_VERSION }, "hotels/a/catalogproducts/juice": catalog,
  "hotels/a/suppliers/s": { name: "Supplier" }, "hotels/a/supplierproducts/one": offer(), "hotels/b/supplierproducts/foreign": offer() });
const call = (db, data, extra = {}) => getHotelSupplierPriceInsightsHandler(request(data), { firestore: db, auth, ...extra });

test("comparison is bounded, name-only scoped and does not disclose another hotel's offer", async () => {
  const db = fixture(); db.records.set("hotels/a/supplierproducts/two", offer({ pricePerPurchaseUnit: 12 }));
  const first = await call(db, { mode: "comparison", catalogProductId: "juice", pageSize: 1 });
  assert.equal(first.products[0].id, "one"); assert.equal(first.nextProductId, "one");
  assert.equal(first.products[0].options[0].netPricePerCatalogUnit, 2.5);
  const second = await call(db, { mode: "comparison", catalogProductId: "juice", pageSize: 1, afterProductId: first.nextProductId });
  assert.deepEqual(second.products.map((product) => product.id), ["two"]); assert.equal(second.nextProductId, null);
  assert.ok(db.seen.every((path) => path.startsWith("hotels/a/")));
});
test("inactive suppliers and archived/unreviewed offers never become eligible purchases", async () => {
  const db = fixture(); db.records.set("hotels/a/suppliers/s", { name: "Supplier", archived: true });
  assert.equal((await call(db, { mode: "comparison", catalogProductId: "juice" })).products[0].active, false);
  db.records.set("hotels/a/suppliers/s", { name: "Supplier" }); db.records.set("hotels/a/supplierproducts/one", offer({ productPolicyVersion: null }));
  assert.equal((await call(db, { mode: "comparison", catalogProductId: "juice" })).products[0].options[0].available, false);
});
test("history uses immutable frozen source terms, explicit unknown dates and descending bounded revisions", async () => {
  const db = fixture();
  for (const [revision, price] of [[1, 1.06], [3, 3.18], [9, 9.54]]) db.records.set(`hotels/a/supplierPriceHistory/one/entries/${revision}`, {
    supplierPricePolicyVersion: 1, supplierProductId: "one", revision, observation: "terms-changed", terms: pricingTerms(offer({ pricePerPurchaseUnit: price }), catalog),
    previousTerms: pricingTerms(offer({ pricePerPurchaseUnit: 6.36 }), catalog), observedAt: { seconds: 1700000000 }, });
  db.records.set("hotels/a/catalogproducts/juice", { ...catalog, baseUnit: "kg" });
  const first = await call(db, { mode: "history", supplierProductId: "one", pageSize: 2 });
  assert.deepEqual(first.entries.map((entry) => entry.revision), [9, 3]); assert.equal(first.nextRevision, 3);
  assert.equal(first.entries[0].catalogBaseUnit, "l"); assert.equal(first.entries[0].options[0].netPricePerCatalogUnit, 1.5);
  assert.equal(first.entries[0].previous.options[0].netPricePerCatalogUnit, 1);
  assert.equal(first.entries[0].previousObservationDate, null); assert.equal(first.entries[0].contractualValidUntil, null);
  assert.deepEqual((await call(db, { mode: "history", supplierProductId: "one", beforeRevision: 3 })).entries.map((entry) => entry.revision), [1]);
});
test("history is honestly empty for pre-feature products and malformed immutable evidence fails explicitly", async () => {
  const db = fixture(); assert.deepEqual((await call(db, { mode: "history", supplierProductId: "one" })).entries, []);
  db.records.set("hotels/a/supplierPriceHistory/one/entries/bad", { supplierPricePolicyVersion: 1, supplierProductId: "foreign", revision: 1 });
  await assert.rejects(call(db, { mode: "history", supplierProductId: "one" }), /evidence needs review/);
});
test("all three permissions, current identity, selected hotel module and gate are checked on every transaction retry", async () => {
  for (const missing of permissions) { const db = fixture(); db.records.set("hotels/a/members/buyer", { permissions: permissions.filter((permission) => permission !== missing) });
    await assert.rejects(call(db, { mode: "comparison", catalogProductId: "juice" }), (error) => error.code === "permission-denied"); }
  const db = fixture();
  await assert.rejects(call(db, { hotelUid: "b", mode: "comparison", catalogProductId: "juice" }), (error) => error.code === "permission-denied");
  await assert.rejects(call(db, { mode: "history", supplierProductId: "one" }, { auth: { getUser: async () => ({ emailVerified: true, disabled: true }) } }), (error) => error.code === "permission-denied");
  db.records.set("hotelSubscriptions/a", { status: "active", modules: ["frontoffice"], modulePolicyVersion: 1 });
  await assert.rejects(call(db, { mode: "history", supplierProductId: "one" }), (error) => error.code === "permission-denied");
  const gated = fixture(); gated.records.set("platformConfiguration/saasProcurement", { enabled: false, rulesVersion: SAAS_RULES_VERSION });
  await assert.rejects(call(gated, { mode: "history", supplierProductId: "one" }), (error) => error.code === "failed-precondition");
  const retry = fixture(), original = retry.runTransaction;
  retry.runTransaction = async (fn) => { await original(fn); retry.records.set("hotels/a/members/buyer", { permissions: [] }); return original(fn); };
  await assert.rejects(call(retry, { mode: "history", supplierProductId: "one" }), (error) => error.code === "permission-denied");
});
test("unsupported modes, pagination, cross-mode identifiers and path injection are rejected", async () => {
  const db = fixture(); for (const patch of [{ pageSize: 0 }, { pageSize: 51 }, { catalogProductId: "foreign/path" }, { supplierProductId: "one" }, { beforeRevision: 1 }])
    await assert.rejects(call(db, { mode: "comparison", catalogProductId: "juice", ...patch }), (error) => error.code === "invalid-argument");
  await assert.rejects(call(db, { mode: "history", supplierProductId: "one", beforeRevision: 0 }), (error) => error.code === "invalid-argument");
});
test("current contract validity uses the configured hotel calendar date and stays unavailable without a time zone", async () => {
  const db = fixture(); db.records.set("hotels/a/supplierproducts/one", offer({ priceValidFrom: "2026-10-13", priceValidUntil: "2026-10-13" }));
  const now = () => Date.parse("2026-10-12T22:30:00Z");
  const within = await call(db, { mode: "comparison", catalogProductId: "juice" }, { now });
  assert.equal(within.assessmentDate, "2026-10-13"); assert.equal(within.timeZone, "Europe/Brussels");
  assert.equal(within.products[0].priceValidity, "current"); assert.equal(within.products[0].contractualValidUntil, "2026-10-13");
  const expired = await call(db, { mode: "comparison", catalogProductId: "juice" }, { now: () => Date.parse("2026-10-14T12:00:00Z") });
  assert.equal(expired.products[0].priceValidity, "expired");
  db.records.set("hotels/a", {});
  const unknown = await call(db, { mode: "comparison", catalogProductId: "juice" }, { now });
  assert.equal(unknown.assessmentDate, null); assert.equal(unknown.products[0].priceValidity, "unavailable");
});

test("approved and scheduled source versions are scoped projections with distinct change and confirmation dates", async () => {
  const db = fixture();
  const { digest } = require("./validation");
  const { purchaseTerms } = require("./supplierPriceVersions");
  const version = (id, revision, patch, sourceReference) => {
    const product = offer(patch), terms = pricingTerms(product, catalog);
    return { supplierPriceVersionPolicyVersion: 1, id, supplierProductId: "one", supplierId: "s", revision,
      termsFingerprint: digest(terms), terms, productTerms: purchaseTerms(product), sourceReference, sourceIssuedOn: "2026-10-01", sourceKind: "supplier-list",
      approvedAt: { seconds: 1700000000 }, lastPriceChangeAt: { seconds: 1700000000 }, lastPriceConfirmedAt: { seconds: 1700000100 },
      privateProviderConfiguration: "must-not-be-projected", confirmedOptionIds: ["default"], optionReliability: {} };
  };
  db.records.set("hotels/a/suppliers/s", { name: "Supplier", priceDateBasis: "delivery-date" });
  db.records.set("hotels/a/supplierproducts/one", offer({ priceValidFrom: "2026-10-01", currentPriceVersionId: "one", priceConfirmedOn: { seconds: 1700000200 } }));
  db.records.set("hotels/a/supplierPriceVersions/one/entries/one", version("one", 1, { priceValidFrom: "2026-10-01" }, "October.xlsx · row-8"));
  db.records.set("hotels/a/supplierPriceVersions/one/entries/two", version("two", 2, { pricePerPurchaseUnit: 21.2, priceValidFrom: "2026-11-01" }, "November.xlsx · row-8"));
  db.records.set("hotels/b/supplierPriceVersions/one/entries/foreign", version("foreign", 99, { pricePerPurchaseUnit: 1 }, "Foreign supplier"));
  const result = await call(db, { mode: "history", supplierProductId: "one" }, { now: () => Date.parse("2026-10-14T12:00:00Z") });
  assert.deepEqual(result.versions.map((entry) => entry.id), ["two", "one"]);
  assert.equal(result.versions[0].priceValidity, "future"); assert.equal(result.versions[1].priceValidity, "current");
  assert.equal(result.versions[0].sourceReference, "November.xlsx · row-8");
  assert.equal(result.reliability.currentVersionId, "one"); assert.equal(result.reliability.hasScheduledVersions, true);
  assert.equal(result.reliability.pricingDateBasis, "delivery-date"); assert.equal(result.reliability.pricingAgreementKnown, true);
  assert.notEqual(result.reliability.lastPriceChangeAt, result.reliability.lastPriceConfirmedAt);
  assert.ok(!JSON.stringify(result).includes("must-not-be-projected"));
  assert.ok(!JSON.stringify(result).includes("Foreign supplier"));
});

test("comparison resolves an activated immutable price despite the retained convenience projection", async () => {
  const db = fixture();
  const { digest } = require("./validation");
  const { purchaseTerms } = require("./supplierPriceVersions");
  const future = offer({ pricePerPurchaseUnit: 21.2, baseUnitsPerPurchaseUnit: 3000, priceValidFrom: "2026-11-01" });
  const terms = pricingTerms(future, catalog);
  db.records.set("hotels/a/supplierPriceVersions/one/entries/next", {
    supplierPriceVersionPolicyVersion: 1, supplierProductId: "one", supplierId: "s", revision: 2,
    termsFingerprint: digest(terms), terms, productTerms: purchaseTerms(future), sourceReference: "November.xlsx", sourceIssuedOn: "2026-10-01", sourceKind: "supplier-list", optionReliability: {},
  });
  const result = await call(db, { mode: "comparison", catalogProductId: "juice" }, { now: () => Date.parse("2026-11-01T12:00:00Z") });
  assert.equal(result.products[0].options[0].pricePerPurchaseUnit, 21.2);
  assert.equal(result.products[0].options[0].netPricePerCatalogUnit, 6.666667);
  assert.equal(db.records.get("hotels/a/supplierproducts/one").pricePerPurchaseUnit, 15.9, "read projection does not rewrite the public offer or historic records");
});
