const test = require("node:test");
const assert = require("node:assert/strict");
const { buildSearchRequest, searchHotelProductsHandler } = require("./productSearch");
const { productSearchId, buildCatalogProductDocument } = require("./common");

function fixture() {
  const reads = [];
  const records = {
    "hotels/hotel-a/members/employee-a": { permissions: ["catalogproducts.read"] },
    "hotelSubscriptions/hotel-a": { status: "active", validUntil: null },
    "hotels/hotel-a/catalogproducts/product-a": { name: "Canonical coffee" },
  };
  const firestore = { doc: (path) => ({ get: async () => {
    reads.push(path);
    return { id: path.split("/").at(-1), exists: !!records[path], data: () => records[path] };
  } }) };
  return { firestore, reads, records };
}
const request = { auth: { uid: "employee-a", token: {} }, data: { hotelUid: "hotel-a", collection: "catalogproducts", criteria: {}, pageSize: 20 } };

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
