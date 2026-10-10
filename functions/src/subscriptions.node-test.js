const test = require("node:test");
const assert = require("node:assert/strict");
const { subscriptionIsActive, setHotelSubscriptionHandler, requireHotelSubscription, listHotelSubscriptionsHandler } = require("./subscriptions");
const expiry = (millis) => ({ toMillis: () => millis });

const currentAuth = { getUser: async () => ({ emailVerified: true, disabled: false, customClaims: { platformAdmin: true } }) };
const platformAuth = { uid: "platform", token: { platformAdmin: true, email_verified: true } };
function overviewDatabase(hotels, subscriptions = {}) {
  const reads = [];
  const query = { orderBy() { return this; }, startAfter(id) { reads.push(["cursor", id]); return this; },
    limit(count) { reads.push(["limit", count]); return this; },
    async get() { reads.push(["hotels"]); return { docs: hotels }; } };
  const db = { collection(path) { assert.equal(path, "hotels"); return query; },
    doc: (path) => ({ path }),
    async getAll(...refs) { reads.push(refs.map((ref) => ref.path)); return refs.map(({ path }) => {
      const id = path.split("/")[1];
      return { id, exists: Boolean(subscriptions[id]), data: () => subscriptions[id] };
    }); } };
  return { db, reads };
}

test("subscription discovery rejects anonymous and hotel admins before reading any data", async () => {
  for (const auth of [undefined, { uid: "hotel", token: {} },
    { uid: "hotel", token: { platformAdmin: false } }, { uid: "hotel", token: { platformAdmin: "true" } }]) {
    const { db, reads } = overviewDatabase([]);
    await assert.rejects(listHotelSubscriptionsHandler({ auth }, { firestore: db, auth: currentAuth }),
      (error) => error.code === (auth ? "permission-denied" : "unauthenticated"));
    assert.deepEqual(reads, []);
  }
});

test("subscription discovery returns names, revisions and expiry without exposing audit metadata", async () => {
  const { db, reads } = overviewDatabase([
    { id: "a", data: () => ({ name: "Test Hotel", privateEmail: "private@example.com" }) },
    { id: "b", data: () => ({ hotelName: "Second Hotel" }) },
  ], { a: { status: "trialing", planId: "standard", billingMode: "manual", revision: 3,
    validUntil: expiry(2000), updatedBy: "private-uid", updatedAt: expiry(1000) } });
  assert.deepEqual(await listHotelSubscriptionsHandler({ auth: platformAuth }, { firestore: db, auth: currentAuth }), {
    hotels: [
      { hotelUid: "a", hotelName: "Test Hotel", subscription: { status: "trialing", planId: "standard", billingMode: "manual", revision: 3, validUntilMillis: 2000, modules: null, modulePolicyVersion: null, seatLimit: null, moduleMigrationRequired: true } },
      { hotelUid: "b", hotelName: "Second Hotel", subscription: null },
    ], nextCursor: null,
  });
  assert.deepEqual(reads, [["limit", 51], ["hotels"], ["hotelSubscriptions/a", "hotelSubscriptions/b"]]);
});

test("subscription discovery bounds each page and reads only subscriptions for returned hotels", async () => {
  const hotels = Array.from({ length: 51 }, (_, index) => ({ id: `hotel-${String(index).padStart(3, "0")}`, data: () => ({}) }));
  const { db, reads } = overviewDatabase(hotels);
  const page = await listHotelSubscriptionsHandler({ auth: platformAuth, data: { afterHotelUid: "previous" } }, { firestore: db, auth: currentAuth });
  assert.equal(page.hotels.length, 50);
  assert.equal(page.nextCursor, "hotel-049");
  assert.deepEqual(reads.slice(0, 3), [["cursor", "previous"], ["limit", 51], ["hotels"]]);
  assert.equal(reads[3].length, 50);
  assert.equal(reads[3].includes("hotelSubscriptions/hotel-050"), false);
});

test("subscription discovery validates cursors and fails closed on corrupt expiry or revision", async () => {
  const { db, reads } = overviewDatabase([]);
  await assert.rejects(listHotelSubscriptionsHandler({ auth: platformAuth, data: { afterHotelUid: "a/b" } }, { firestore: db, auth: currentAuth }),
    (error) => error.code === "invalid-argument");
  assert.deepEqual(reads, []);
  assert.deepEqual(await listHotelSubscriptionsHandler({ auth: platformAuth }, { firestore: db, auth: currentAuth }), { hotels: [], nextCursor: null });
  assert.deepEqual(reads, [["limit", 51], ["hotels"]]);
  for (const subscription of [{ modules: ["procurement", "contracts", "frontoffice", "groups", "revenue"], modulePolicyVersion: 1, status: "active", validUntil: "invalid", revision: 1 }, { modules: ["procurement", "contracts", "frontoffice", "groups", "revenue"], modulePolicyVersion: 1, status: "active", validUntil: null, revision: -1 }]) {
    const database = overviewDatabase([{ id: "a", data: () => ({}) }], { a: subscription });
    await assert.rejects(listHotelSubscriptionsHandler({ auth: platformAuth }, { firestore: database.db, auth: currentAuth }),
      (error) => error.code === "failed-precondition");
  }
});

test("subscription access expires at the boundary and fails closed", () => {
  assert.equal(subscriptionIsActive(null, 100), false);
  assert.equal(subscriptionIsActive({ modules: ["procurement", "contracts", "frontoffice", "groups", "revenue"], modulePolicyVersion: 1, status: "active", validUntil: null }, 100), true);
  assert.equal(subscriptionIsActive({ status: "trialing", validUntil: null }, 100), false);
  assert.equal(subscriptionIsActive({ modules: ["procurement", "contracts", "frontoffice", "groups", "revenue"], modulePolicyVersion: 1, status: "active", validUntil: expiry(100) }, 100), false);
  assert.equal(subscriptionIsActive({ status: "trialing", validUntil: expiry(101) }, 100), true);
  assert.equal(subscriptionIsActive({ status: "suspended", validUntil: expiry(200) }, 100), false);
});

test("subscription state cannot be set by a hotel administrator", async () => {
  await assert.rejects(setHotelSubscriptionHandler({ auth: { uid: "hotel-admin", token: {} } }), (error) => error.code === "permission-denied");
});

test("subscription updates validate IDs, revision and trial expiry before writing", async () => {
  const auth = { uid: "platform", token: { platformAdmin: true, email_verified: true } };
  for (const data of [
    { hotelUid: "a/b", status: "active", planId: "standard", expectedRevision: 0 },
    { hotelUid: "hotel-a", status: "trialing", planId: "standard", expectedRevision: 0 },
    { hotelUid: "hotel-a", status: "active", planId: "standard" },
  ]) await assert.rejects(setHotelSubscriptionHandler({ auth, data }, { auth: currentAuth }), (error) => error.code === "invalid-argument");
});

test("subscription changes and audit records are committed together; stale saves are rejected", async () => {
  const writes = [];
  const db = { doc: (path) => ({ path }), collection: () => ({ doc: () => ({ path: "audit", id: "audit-key" }) }),
    runTransaction: (callback) => callback({
      get: async (ref) => ({ exists: true, data: () => ref.path.startsWith("hotelSubscriptions/") ? { revision: 2, status: "active" } : {} }),
      set: (ref, data) => writes.push({ path: ref.path, data }),
      create: (ref, data) => writes.push({ path: ref.path, data }),
    }) };
  const request = { auth: { uid: "platform", token: { platformAdmin: true, email_verified: true } }, data: { hotelUid: "hotel-a", status: "suspended", modules: ["procurement"], planId: "standard", expectedRevision: 1 } };
  await assert.rejects(setHotelSubscriptionHandler(request, { firestore: db, auth: currentAuth }), (error) => error.code === "aborted");
  assert.equal(writes.length, 0);
  request.data.expectedRevision = 2;
  assert.equal((await setHotelSubscriptionHandler(request, { firestore: db, auth: currentAuth })).revision, 3);
  assert.equal(writes.length, 4);
  assert.equal(writes[0].data.billingMode, "manual");
  assert.ok(writes.some((write) => write.path.startsWith("platformAudit/") && write.data.action === "subscription-updated"));
  assert.ok(writes.some((write) => write.path.startsWith("hotels/hotel-a/platformAudit/")));
});

test("backend rejects missing or inactive subscription records", async () => {
  for (const snapshot of [{ exists: false }, { exists: true, data: () => ({ status: "canceled", validUntil: null }) }]) {
    await assert.rejects(requireHotelSubscription({ doc: () => ({ get: async () => snapshot }) }, "hotel-a"), (error) => error.code === "permission-denied");
  }
});
