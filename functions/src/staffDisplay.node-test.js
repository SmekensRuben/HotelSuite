const test = require("node:test");
const assert = require("node:assert/strict");
const { memoryDatabase } = require("./inventoryTestHelpers");
const { getHotelUserDisplayNamesHandler } = require("./staffDisplay");
const hotelUid = "hotel-a", auth = { getUser: async () => ({ emailVerified: true, disabled: false }) };
const request = (patch = {}) => ({ auth: { uid: "counter", token: { email_verified: true } }, data: { hotelUid, userIds: ["one", "two", "one", "foreign", "legacy@example.test"], ...patch } });
function fixture() {
  return memoryDatabase({
    [`hotelSubscriptions/${hotelUid}`]: { status: "active", validUntil: null, modules: ["procurement"], modulePolicyVersion: 1 },
    [`hotels/${hotelUid}/members/counter`]: { permissions: ["stockcounts.read"] },
    [`hotels/${hotelUid}/members/one`]: { firstName: "Ada", lastName: "Lovelace", permissions: [] },
    [`hotels/${hotelUid}/members/two`]: { permissions: [] },
    "users/two": { firstName: "Grace", lastName: "Hopper", hotelUid: [hotelUid], email: "private@example.test" },
    "users/foreign": { firstName: "Other", lastName: "Hotel", hotelUid: ["hotel-b"] },
  });
}
test("batch staff names use local names then consistent assigned profiles, deduplicate and expose no global directory or IDs as names", async () => {
  const db = fixture(), response = await getHotelUserDisplayNamesHandler(request(), { firestore: db, auth });
  assert.deepEqual(response, { hotelUid, users: [
    { userId: "one", displayName: "Ada Lovelace" }, { userId: "two", displayName: "Grace Hopper" },
    { userId: "foreign", displayName: null }, { userId: "legacy@example.test", displayName: null }] });
  assert.equal(JSON.stringify(response).includes("private@example.test"), false);
  db.records.set(`hotels/${hotelUid}/members/two`, { permissions: [] });
  db.records.get("users/two").hotelUid = ["hotel-b"];
  assert.equal((await getHotelUserDisplayNamesHandler(request({ userIds: ["two"] }), { firestore: db, auth })).users[0].displayName, null);
});
test("completed private same-hotel seed receipt proves an operator author without granting arbitrary profile lookups", async () => {
  const db = fixture(); db.records.set("users/platform", { firstName: "Platform", lastName: "Operator", hotelUid: [], email: "private-platform@example.test" });
  const lookup = () => getHotelUserDisplayNamesHandler(request({ userIds: ["platform", "foreign"] }), { firestore: db, auth });
  assert.equal((await lookup()).users[0].displayName, null);
  db.records.set(`hotels/${hotelUid}/demoDataSeeds/procurement-demo-v1`, { datasetId: "procurement-demo-v1", status: "complete", actorUid: "platform" });
  assert.deepEqual((await lookup()).users, [{ userId: "platform", displayName: "Platform Operator" }, { userId: "foreign", displayName: null }]);
  for (const data of [{ datasetId: "wrong", status: "complete", actorUid: "platform" }, { datasetId: "procurement-demo-v1", status: "pending", actorUid: "platform" },
    { datasetId: "procurement-demo-v1", status: "complete", actorUid: "another" }]) {
    db.records.set(`hotels/${hotelUid}/demoDataSeeds/procurement-demo-v1`, data); assert.equal((await lookup()).users[0].displayName, null);
  }
  db.records.delete(`hotels/${hotelUid}/demoDataSeeds/procurement-demo-v1`);
  db.records.set("hotels/hotel-b/demoDataSeeds/procurement-demo-v1", { datasetId: "procurement-demo-v1", status: "complete", actorUid: "platform" });
  assert.equal((await lookup()).users[0].displayName, null);
});
test("batch projection checks live actor, selected hotel membership and license, including empty requests", async () => {
  const db = fixture();
  assert.deepEqual(await getHotelUserDisplayNamesHandler(request({ userIds: [] }), { firestore: db, auth }), { hotelUid, users: [] });
  await assert.rejects(getHotelUserDisplayNamesHandler(request({ hotelUid: "hotel-b" }), { firestore: db, auth }), { code: "permission-denied" });
  await assert.rejects(getHotelUserDisplayNamesHandler(request(), { firestore: db, auth: { getUser: async () => ({ emailVerified: true, disabled: true }) } }), { code: "permission-denied" });
  db.records.get(`hotelSubscriptions/${hotelUid}`).status = "canceled";
  await assert.rejects(getHotelUserDisplayNamesHandler(request(), { firestore: db, auth }), { code: "permission-denied" });
});
test("batch rejects oversized or malformed requests before any data reads", async () => {
  for (const patch of [{ userIds: Array(101).fill("one") }, { userIds: "one" }, { userIds: [null] }, { userIds: ["x".repeat(255)] }, { permissions: ["users.read"] }]) {
    await assert.rejects(getHotelUserDisplayNamesHandler(request(patch), { firestore: { doc: () => { throw new Error("No reads allowed"); } }, auth }), { code: "invalid-argument" });
  }
});
