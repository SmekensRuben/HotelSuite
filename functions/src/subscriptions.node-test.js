const test = require("node:test");
const assert = require("node:assert/strict");
const { subscriptionIsActive, setHotelSubscriptionHandler, requireHotelSubscription } = require("./subscriptions");
const expiry = (millis) => ({ toMillis: () => millis });

test("subscription access expires at the boundary and fails closed", () => {
  assert.equal(subscriptionIsActive(null, 100), false);
  assert.equal(subscriptionIsActive({ status: "active", validUntil: null }, 100), true);
  assert.equal(subscriptionIsActive({ status: "trialing", validUntil: null }, 100), false);
  assert.equal(subscriptionIsActive({ status: "active", validUntil: expiry(100) }, 100), false);
  assert.equal(subscriptionIsActive({ status: "trialing", validUntil: expiry(101) }, 100), true);
  assert.equal(subscriptionIsActive({ status: "suspended", validUntil: expiry(200) }, 100), false);
});

test("subscription state cannot be set by a hotel administrator", async () => {
  await assert.rejects(setHotelSubscriptionHandler({ auth: { uid: "hotel-admin", token: {} } }), (error) => error.code === "permission-denied");
});

test("subscription updates validate IDs, revision and trial expiry before writing", async () => {
  const auth = { uid: "platform", token: { platformAdmin: true } };
  for (const data of [
    { hotelUid: "a/b", status: "active", planId: "standard", expectedRevision: 0 },
    { hotelUid: "hotel-a", status: "trialing", planId: "standard", expectedRevision: 0 },
    { hotelUid: "hotel-a", status: "active", planId: "standard" },
  ]) await assert.rejects(setHotelSubscriptionHandler({ auth, data }), (error) => error.code === "invalid-argument");
});

test("subscription changes and audit records are committed together; stale saves are rejected", async () => {
  const writes = [];
  const db = { doc: (path) => ({ path }), collection: () => ({ doc: () => ({ path: "audit" }) }),
    runTransaction: (callback) => callback({
      get: async (ref) => ({ exists: true, data: () => ref.path.startsWith("hotelSubscriptions/") ? { revision: 2, status: "active" } : {} }),
      set: (ref, data) => writes.push({ path: ref.path, data }),
    }) };
  const request = { auth: { uid: "platform", token: { platformAdmin: true } }, data: { hotelUid: "hotel-a", status: "suspended", planId: "standard", expectedRevision: 1 } };
  await assert.rejects(setHotelSubscriptionHandler(request, { firestore: db }), (error) => error.code === "aborted");
  assert.equal(writes.length, 0);
  request.data.expectedRevision = 2;
  assert.equal((await setHotelSubscriptionHandler(request, { firestore: db })).revision, 3);
  assert.equal(writes.length, 2);
  assert.equal(writes[0].data.billingMode, "manual");
});

test("backend rejects missing or inactive subscription records", async () => {
  for (const snapshot of [{ exists: false }, { exists: true, data: () => ({ status: "canceled", validUntil: null }) }]) {
    await assert.rejects(requireHotelSubscription({ doc: () => ({ get: async () => snapshot }) }, "hotel-a"), (error) => error.code === "permission-denied");
  }
});
