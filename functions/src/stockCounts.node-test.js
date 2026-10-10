const test = require("node:test");
const assert = require("node:assert/strict");
const { createHotelStockCountHandler, mutateHotelStockCountHandler, countsInput } = require("./stockCounts");
const { getHotelUserDisplayNameHandler } = require("./staffDisplay");
const { requireCurrentVerifiedUser } = require("./validation");
const { requirePlatformAdministrator } = require("./subscriptions");
const { claimDispatch } = require("./deliveryState");
const { updateUserAccessHandler } = require("./userAccess");

function memoryDatabase(initial) {
  const records = new Map(Object.entries(initial));
  const snapshot = (path) => ({ exists: records.has(path), data: () => structuredClone(records.get(path)), id: path.split("/").at(-1) });
  let serial = Promise.resolve();
  const db = { records, doc: (path) => ({ path, get: async () => snapshot(path) }),
    collection: (path) => ({ doc: () => ({ path: `${path}/test-audit` }) }),
    runTransaction(fn) {
      const run = serial.then(async () => {
        const writes = [];
        const tx = { get: async (ref) => snapshot(ref.path),
          create: (ref, data) => writes.push(["create", ref.path, data]),
          set: (ref, data, options) => writes.push([options?.merge ? "update" : "set", ref.path, data]),
          update: (ref, data) => writes.push(["update", ref.path, data]),
          delete: (ref) => writes.push(["delete", ref.path]) };
        const result = await fn(tx);
        for (const [kind, path, data] of writes) {
          if (kind === "create") assert.equal(records.has(path), false);
          if (kind === "delete") records.delete(path);
          else records.set(path, kind === "update" ? { ...records.get(path), ...data } : data);
        }
        return result;
      });
      serial = run.catch(() => {});
      return run;
    } };
  return db;
}
const hotel = "hotel-a";
const currentAuth = { getUser: async () => ({ emailVerified: true, disabled: false, customClaims: {} }) };
const request = (data, auth = { uid: "counter", token: { email_verified: true } }) => ({ auth, data });
function fixture(permissions = ["stockcounts.create", "stockcounts.update", "stockcounts.read", "locations.update"]) {
  return memoryDatabase({
    [`hotels/${hotel}/members/counter`]: { permissions },
    [`hotelSubscriptions/${hotel}`]: { status: "active", validUntil: null },
    [`hotels/${hotel}/locations/store`]: { name: "Store" },
    [`hotels/${hotel}/locations/store/stockTemplates/template`]: { name: "Weekly", items: [{ supplierProductId: "coffee", outletId: "bar" }] },
    [`hotels/${hotel}/supplierproducts/coffee`]: { name: "Coffee", pricePerPurchaseUnit: 12.5 },
    [`hotels/${hotel}/supplierproducts/milk`]: { name: "Milk", pricePerPurchaseUnit: 2 },
    [`hotels/${hotel}/outlets/bar`]: { name: "Bar" },
  });
}
async function create(db, overrides = {}) {
  return createHotelStockCountHandler(request({ hotelUid: hotel, name: "Weekly inventory", type: "Weekly",
    locations: [{ locationId: "store", stockTemplateId: "template" }], requestId: "request-a", ...overrides }), { firestore: db, auth: currentAuth });
}
const counted = (patch = {}) => ({ supplierProductId: "coffee", outletId: "bar", quantity: 3, isCounted: true, ...patch });
const mutate = (db, id, patch = {}, auth = currentAuth) => {
  const input = { hotelUid: hotel, stockCountId: id, expectedRevision: 0, action: "save-location", locationId: "store", countedItems: [counted()], ...patch };
  if (input.action === "finish-count") { delete input.locationId; delete input.countedItems; }
  if (input.action === "set-location-status") delete input.countedItems;
  return mutateHotelStockCountHandler(request(input), { firestore: db, auth });
};

test("ordinary hotel user creates canonical snapshots and completes a stock count without admin claims", async () => {
  const db = fixture();
  const { stockCountId } = await create(db);
  const ref = `hotels/${hotel}/stockCounts/${stockCountId}`;
  const created = db.records.get(ref);
  assert.equal(created.createdBy, "counter");
  assert.equal(db.records.get(`${ref}/locations/store`).stockTemplate.items[0].pricePerPurchaseUnit, 12.5);
  // Existing snapshot valuation is stable even when the catalog changes later.
  db.records.set(`hotels/${hotel}/supplierproducts/coffee`, { name: "Coffee", pricePerPurchaseUnit: 99 });
  await mutate(db, stockCountId, { action: "finish-location" });
  assert.equal(db.records.get(ref).countedValue, 37.5);
  assert.equal(db.records.get(`${ref}/locations/store`).finishedBy, "counter");
  const finished = await mutate(db, stockCountId, { action: "finish-count", expectedRevision: 1 });
  assert.equal(finished.status, "Finished");
  assert.equal(db.records.get(ref).finishedBy, "counter");
  await assert.rejects(mutate(db, stockCountId, { expectedRevision: 2 }), (error) => error.code === "failed-precondition");
});
test("client prices, totals and actors are rejected instead of trusted", async () => {
  const db = fixture();
  await assert.rejects(create(db, { createdBy: "spoofed" }), (error) => error.code === "invalid-argument");
  const { stockCountId } = await create(db);
  for (const patch of [{ totalValue: 1 }, { pricePerPurchaseUnit: 0 }, { countedBy: "operator" }, { status: "Finished" }]) {
    await assert.rejects(mutate(db, stockCountId, { countedItems: [counted(patch)] }), (error) => error.code === "invalid-argument");
  }
  for (const quantity of [-1, "3", NaN, Infinity, 1000001, 0.0001]) assert.throws(() => countsInput([counted({ quantity })]));
  assert.throws(() => countsInput([counted(), counted()]));
  assert.throws(() => countsInput(Array.from({ length: 251 }, () => counted())));
  await assert.rejects(mutate(db, stockCountId, { action: "set-location-status", status: "Finished" }), (error) => error.code === "invalid-argument");
});
test("finished location cannot reopen, parent cannot finish prematurely, concurrent finishes have one winner", async () => {
  const db = fixture(); const { stockCountId } = await create(db);
  await assert.rejects(mutate(db, stockCountId, { action: "finish-count" }), (error) => error.code === "failed-precondition");
  const outcomes = await Promise.allSettled([mutate(db, stockCountId, { action: "finish-location" }),
    mutate(db, stockCountId, { action: "finish-location" })]);
  assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(outcomes.find((result) => result.status === "rejected").reason.code, "aborted");
  await assert.rejects(mutate(db, stockCountId, { action: "set-location-status", status: "Not Started", expectedRevision: 1 }), (error) => error.code === "failed-precondition");
});
test("stock commands protect tenant access, disabled/unverified identities, subscription and stale revisions", async () => {
  const db = fixture(); const { stockCountId } = await create(db);
  await assert.rejects(mutate(db, stockCountId, { hotelUid: "hotel-b" }), (error) => error.code === "permission-denied");
  for (const user of [{ emailVerified: true, disabled: true }, { emailVerified: false }, null]) {
    const auth = { getUser: async () => { if (!user) throw new Error("removed"); return user; } };
    await assert.rejects(mutate(db, stockCountId, {}, auth), (error) => error.code === "permission-denied");
  }
  await assert.rejects(mutate(db, stockCountId, { expectedRevision: 8 }), (error) => error.code === "aborted");
  db.records.set(`hotelSubscriptions/${hotel}`, { status: "suspended", validUntil: null });
  await assert.rejects(mutate(db, stockCountId), (error) => error.code === "permission-denied");
});
test("creation retries are idempotent and bound to exact input; unknown catalog prices remain unavailable", async () => {
  const db = fixture(); const first = await create(db); const second = await create(db);
  assert.deepEqual(first, second);
  await assert.rejects(create(db, { name: "Different" }), (error) => error.code === "already-exists");
  const missing = fixture(); missing.records.set(`hotels/${hotel}/supplierproducts/coffee`, { name: "Coffee" });
  await assert.rejects(create(missing), (error) => error.code === "failed-precondition");
  assert.equal([...missing.records.keys()].some((path) => path.includes("/stockCounts/")), false);
});
test("template additions require independent location authority and preserve live template changes", async () => {
  const db = fixture(); const { stockCountId } = await create(db);
  db.records.set(`hotels/${hotel}/locations/store/stockTemplates/template`, { name: "Weekly", items: [
    { supplierProductId: "coffee", outletId: "bar" }, { supplierProductId: "existing", outletId: "bar" }] });
  await mutate(db, stockCountId, { action: "finish-location", countedItems: [counted(), counted({ supplierProductId: "milk", quantity: 2 })],
    templateItemsToAdd: [{ supplierProductId: "milk", outletId: "bar" }] });
  const template = db.records.get(`hotels/${hotel}/locations/store/stockTemplates/template`);
  assert.deepEqual(template.items.map((item) => item.supplierProductId), ["coffee", "existing", "milk"]);
  const limited = fixture(["stockcounts.create", "stockcounts.update"]); const count = await create(limited);
  await assert.rejects(mutate(limited, count.stockCountId, { action: "finish-location", countedItems: [counted({ supplierProductId: "milk" })],
    templateItemsToAdd: [{ supplierProductId: "milk", outletId: "bar" }] }), (error) => error.code === "permission-denied");
  await assert.doesNotReject(mutate(limited, count.stockCountId, { action: "finish-location" }));
});
test("staff lookup returns only same-hotel display name and never falls back to a global email query", async () => {
  const db = fixture(["stockcounts.read"]);
  db.records.set(`hotels/${hotel}/members/person`, { permissions: [] });
  db.records.set("users/person", { firstName: "Ada", lastName: "Lovelace", email: "private@example.test", hotelUid: ["hotel-a", "hotel-b"] });
  const lookup = (userId, hotelUid = hotel) => getHotelUserDisplayNameHandler(request({ hotelUid, userId }), { firestore: db, auth: currentAuth });
  assert.deepEqual(await lookup("person"), { displayName: "Ada Lovelace" });
  db.records.set("users/foreign", { firstName: "Private" });
  assert.deepEqual(await lookup("foreign"), { displayName: "foreign" });
  assert.deepEqual(await lookup("legacy@example.test"), { displayName: "legacy@example.test" });
  assert.deepEqual(await lookup("Legacy / staff"), { displayName: "Legacy / staff" });
  await assert.rejects(lookup("person", "hotel-b"), (error) => error.code === "permission-denied");
});
test("stale platform claims, revoked sessions and copied payload fields cannot bypass current Auth", async () => {
  for (const user of [{ emailVerified: true, customClaims: {} }, { emailVerified: true, disabled: true, customClaims: { platformAdmin: true } },
    { emailVerified: false, customClaims: { platformAdmin: true } }]) {
    await assert.rejects(requirePlatformAdministrator(request({}, { uid: "platform", token: { platformAdmin: true, email_verified: true } }),
      { getUser: async () => user }), (error) => error.code === "permission-denied");
  }
  await assert.rejects(requireCurrentVerifiedUser(request({}, { uid: "counter", token: { email_verified: true, auth_time: 1000 } }),
    { getUser: async () => ({ emailVerified: true, tokensValidAfterTime: new Date(1000001).toISOString() }) }), (error) => error.code === "permission-denied");
  await assert.rejects(requireCurrentVerifiedUser({ ...request({ currentActor: { emailVerified: true } }), currentActor: { emailVerified: true } },
    { getUser: async () => ({ disabled: true, emailVerified: true }) }), (error) => error.code === "permission-denied");
});
test("access audit records exact added and removed hotel permissions", async () => {
  const db = memoryDatabase({ "users/person": { hotelUid: [hotel, "hotel-b"], accessRevision: 0 },
    [`hotels/${hotel}`]: {}, [`hotels/${hotel}/members/person`]: { permissions: ["orders.read", "orders.update"] },
    "hotels/hotel-b/members/person": { permissions: ["reservations.read"] } });
  const auth = { getUser: async (id) => id === "platform" ? { emailVerified: true, customClaims: { platformAdmin: true } } : { email: "person@example.test" } };
  await updateUserAccessHandler(request({ userId: "person", expectedAccessRevision: 0,
    profile: { hotelUid: [hotel], firstName: "Ada" }, memberships: { [hotel]: ["orders.read", "orders.approve"] } },
    { uid: "platform", token: { platformAdmin: true, email_verified: true } }), { firestore: db, auth });
  assert.deepEqual(db.records.get("userAccessAudit/test-audit").permissionDeltas, [
    { hotelUid: hotel, before: ["orders.read", "orders.update"], after: ["orders.approve", "orders.read"], added: ["orders.approve"], removed: ["orders.update"] },
    { hotelUid: "hotel-b", before: ["reservations.read"], after: [], added: [], removed: ["reservations.read"] },
  ]);
});
test("queued dispatch rechecks current enabled and verified actor in addition to membership", async () => {
  const initial = { "hotels/hotel-a/dispatches/d": { orderId: "o", status: "pending", actorUid: "counter", order: { outletId: "bar" } },
    "hotels/hotel-a/orders/o": { status: "Created", dispatchRequestId: "d", dispatchStatus: "pending" },
    "hotelSubscriptions/hotel-a": { status: "active", validUntil: null },
    "hotels/hotel-a/members/counter": { permissions: ["orders.approve"] }, "hotels/hotel-a/outlets/bar/approvers/counter": {} };
  for (const identity of [{ emailVerified: true, disabled: true }, { emailVerified: false }, null]) {
    const db = memoryDatabase(initial);
    const result = await claimDispatch(db, "hotel-a", "o", "d", { getUser: async () => { if (!identity) throw new Error("deleted"); return identity; } });
    assert.equal(result, null); assert.equal(db.records.get("hotels/hotel-a/dispatches/d").status, "blocked");
  }
  assert.equal((await claimDispatch(memoryDatabase(initial), "hotel-a", "o", "d", currentAuth)).actorUid, "counter");
});
