require("../testSupport/productionEnvironment").activateProductionTestEnvironment();
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildSearchRequest, searchHotelProductsHandler } = require("./productSearch");
const { productSearchId, buildCatalogProductDocument } = require("./common");

function fixture() {
  const reads = [];
  const records = {
    "hotels/hotel-a/members/employee-a": { permissions: ["catalogproducts.read"] },
    "hotelSubscriptions/hotel-a": { modules: ["procurement", "contracts", "frontoffice", "groups", "revenue"], modulePolicyVersion: 1, status: "active", validUntil: null },
    "hotels/hotel-a/catalogproducts/product-a": { name: "Canonical coffee" },
  };
  const firestore = { doc: (path) => ({ path, get: async () => {
    reads.push(path);
    return { id: path.split("/").at(-1), exists: !!records[path], data: () => records[path] };
  } }), getAll: (...refs) => Promise.all(refs.map((ref) => ref.get())) };
  return { firestore, reads, records, auth: { getUser: async () => ({ emailVerified: true, disabled: false }) } };
}
const request = { auth: { uid: "employee-a", token: { email_verified: true } }, data: { hotelUid: "hotel-a", collection: "catalogproducts", criteria: {}, pageSize: 20 } };

test("search uses tenant filters with quoted values and bounded pagination", () => {
  const query = buildSearchRequest({ ...request.data, criteria: { category: 'x" OR hotelUid = "hotel-b' } });
  assert.deepEqual(query.body.filter, ['hotelUid = "hotel-a"', 'category = "x\\" OR hotelUid = \\"hotel-b"']);
  for (const data of [{ ...request.data, collection: "users" }, { ...request.data, pageSize: 1000 }, { ...request.data, hotelUid: "a/b" }]) {
    assert.throws(() => buildSearchRequest(data), (error) => error.code === "invalid-argument");
  }
});

test("search authorizes the hotel before contacting Meilisearch", async () => {
  const fixtureData = fixture(); let calls = 0;
  await assert.rejects(searchHotelProductsHandler({ ...request, data: { ...request.data, hotelUid: "hotel-b" } }, {
    ...fixtureData, search: async () => { calls += 1; },
  }), (error) => error.code === "permission-denied");
  assert.equal(calls, 0);
});

test("product selectors accept the 100-item search boundary and reject oversized pages without a provider request", async () => {
  const maximum = buildSearchRequest({ ...request.data, pageSize: 100, offset: 9900 });
  assert.equal(maximum.body.limit, 100); assert.equal(maximum.body.offset, 9900);
  for (const pageSize of [101, 200, 250, 0, -1, "100", 1.5]) {
    const data = { ...request.data, pageSize }, fixtureData = fixture(); let providerCalls = 0;
    await assert.rejects(searchHotelProductsHandler({ ...request, data }, { ...fixtureData,
      search: async () => { providerCalls++; return { hits: [] }; } }), (error) => error.code === "invalid-argument");
    assert.equal(providerCalls, 0); assert.equal(fixtureData.reads.length, 0);
  }
});

test("canonical search hydration batches document reads and makes no batch call for an empty result", async () => {
  const fixtureData = fixture(); let batches = 0;
  const batch = fixtureData.firestore.getAll;
  fixtureData.firestore.getAll = (...refs) => { batches++; return batch(...refs); };
  await searchHotelProductsHandler(request, { ...fixtureData, search: async () => ({ hits: [], estimatedTotalHits: 0 }) });
  assert.equal(batches, 0);
  const result = await searchHotelProductsHandler(request, { ...fixtureData, search: async () => ({
    hits: [{ hotelUid: "hotel-a", documentId: "product-a" }, { hotelUid: "hotel-a", documentId: "product-a" }], estimatedTotalHits: 2 }) });
  assert.equal(batches, 1); assert.equal(result.products.length, 1);
});

test("search ignores foreign and deleted hits and returns canonical hotel documents", async () => {
  const fixtureData = fixture();
  const result = await searchHotelProductsHandler(request, { ...fixtureData, search: async () => ({
    hits: [
      { hotelUid: "hotel-b", id: "private-product", secret: "foreign data" },
      { hotelUid: "hotel-a", id: "index-id", documentId: "product-a", name: "stale name" },
      { hotelUid: "hotel-a", id: "deleted-product" },
      { hotelUid: "hotel-a", id: "../../users/other" },
    ], estimatedTotalHits: 4,
  }) });
  assert.deepEqual(result.products, [{ id: "product-a", name: "Canonical coffee" }]);
  assert.equal(fixtureData.reads.some((path) => path.includes("hotel-b") || path.includes("../")), false);
});

test("search fails closed for a canceled subscription", async () => {
  const fixtureData = fixture(); fixtureData.records["hotelSubscriptions/hotel-a"].status = "canceled";
  await assert.rejects(searchHotelProductsHandler(request, { ...fixtureData, search: async () => { throw new Error("must not search"); } }), (error) => error.code === "permission-denied");
});

test("indexed product IDs cannot collide across hotels with identical local IDs", () => {
  assert.notEqual(productSearchId("hotel-a", "same-id"), productSearchId("hotel-b", "same-id"));
  assert.equal(buildCatalogProductDocument("same-id", "hotel-a").documentId, "same-id");
});
