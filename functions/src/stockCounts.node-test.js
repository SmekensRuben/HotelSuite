const test = require("node:test");
const assert = require("node:assert/strict");
const { createHotelStockCountHandler, mutateHotelStockCountHandler, listHotelStockCountSourcesHandler, countsInput } = require("./stockCounts");
const { getHotelUserDisplayNameHandler } = require("./staffDisplay");
const { requireCurrentVerifiedUser } = require("./validation");
const { requirePlatformAdministrator } = require("./subscriptions");
const { claimDispatch } = require("./deliveryState");
const { updateUserAccessHandler } = require("./userAccess");

const { memoryDatabase } = require("./inventoryTestHelpers");
const hotel = "hotel-a";
const currentAuth = { getUser: async () => ({ emailVerified: true, disabled: false, customClaims: {} }) };
const request = (data, auth = { uid: "counter", token: { email_verified: true } }) => ({ auth, data });
function fixture(permissions = ["stockcounts.create", "stockcounts.update", "stockcounts.read", "locations.update"]) {
  return memoryDatabase({
    [`hotels/${hotel}`]: { currency: "EUR", timeZone: "Europe/Brussels" },
    [`hotels/${hotel}/members/counter`]: { permissions },
    [`hotelSubscriptions/${hotel}`]: { modules: ["procurement", "contracts", "frontoffice", "groups", "revenue"], modulePolicyVersion: 1, status: "active", validUntil: null },
    [`hotels/${hotel}/locations/store`]: { name: "Store" },
    [`hotels/${hotel}/locations/store/stockTemplates/template`]: { name: "Weekly", items: [{ supplierProductId: "coffee", outletId: "bar" }] },
    [`hotels/${hotel}/supplierproducts/coffee`]: { name: "Coffee", pricePerPurchaseUnit: 12.5, catalogProductId: "coffee", baseUnit: "kg" },
    [`hotels/${hotel}/supplierproducts/milk`]: { name: "Milk", pricePerPurchaseUnit: 2, catalogProductId: "milk", baseUnit: "l" },
    [`hotels/${hotel}/outlets/bar`]: { name: "Bar" },
    [`hotels/${hotel}/catalogproducts/coffee`]: { name: "Coffee", baseUnit: "kg", inventoryTracked: true, active: true },
    [`hotels/${hotel}/catalogproducts/milk`]: { name: "Milk", baseUnit: "l", inventoryTracked: true, active: true },
  });
}
async function create(db, overrides = {}) {
  return createHotelStockCountHandler(request({ hotelUid: hotel, name: "Weekly inventory", type: "Weekly",
    locations: [{ locationId: "store", stockTemplateId: "template" }], requestId: "request-a", ...overrides }), { firestore: db, auth: currentAuth });
}
const counted = (patch = {}) => ({ catalogProductId: "coffee", quantity: 3, isCounted: true, unitCost: 12.5, ...patch });
const mutate = (db, id, patch = {}, auth = currentAuth) => {
  const input = { hotelUid: hotel, stockCountId: id, expectedRevision: 0, action: "save-location", locationId: "store", countedItems: [counted()], ...patch };
  if (input.action === "finish-count") { delete input.locationId; delete input.countedItems; }
  if (input.action === "set-location-status") delete input.countedItems;
  return mutateHotelStockCountHandler(request(input), { firestore: db, auth });
};

function locationCommand(db, stockCountId, locationId, quantity, expectedLocationRevision = 0, options = {}) {
  const { actorUid = "counter", ...overrides } = options;
  return mutateHotelStockCountHandler(request({ hotelUid: hotel, stockCountId, locationId,
    action: "save-location", expectedLocationRevision, countedItems: [counted({ quantity })], ...overrides },
  { uid: actorUid, token: { email_verified: true } }), { firestore: db, auth: currentAuth });
}
async function createTwoLocations(db) {
  db.records.set(`hotels/${hotel}/members/second-counter`, { permissions: ["stockcounts.update", "stockcounts.read"] });
  db.records.set(`hotels/${hotel}/locations/kitchen`, { name: "Kitchen" });
  db.records.set(`hotels/${hotel}/locations/kitchen/stockTemplates/template`, { name: "Kitchen count", items: [{ catalogProductId: "coffee" }] });
  return create(db, { locations: [{ locationId: "store", stockTemplateId: "template" }, { locationId: "kitchen", stockTemplateId: "template" }] });
}

test("different counters save independent locations from the same parent revision without losing summaries", async () => {
  const db = fixture(), { stockCountId } = await createTwoLocations(db);
  const results = await Promise.all([locationCommand(db, stockCountId, "store", 2),
    locationCommand(db, stockCountId, "kitchen", 3, 0, { actorUid: "second-counter" })]);
  assert.deepEqual(results.map((result) => result.locationRevision), [1, 1]);
  const parent = db.records.get(`hotels/${hotel}/stockCounts/${stockCountId}`);
  assert.equal(parent.revision, 2);
  assert.equal(parent.countedValue, 62.5);
  assert.deepEqual(parent.locations.map((location) => [location.status, location.revision]), [["In Progress", 1], ["In Progress", 1]]);
  assert.equal(db.records.get(`hotels/${hotel}/stockCounts/${stockCountId}/locations/kitchen`).updatedBy, "second-counter");
});

test("same-location concurrent saves reject the stale form without replacing the successful count", async () => {
  const db = fixture(), { stockCountId } = await createTwoLocations(db);
  const outcomes = await Promise.allSettled([locationCommand(db, stockCountId, "store", 2),
    locationCommand(db, stockCountId, "store", 3, 0, { actorUid: "second-counter" })]);
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  const failure = outcomes.find((outcome) => outcome.status === "rejected").reason;
  assert.equal(failure.code, "aborted");
  assert.deepEqual(failure.details, { conflictScope: "location", locationId: "store", currentLocationRevision: 1, countMutationUncommitted: true });
  assert.equal(db.records.get(`hotels/${hotel}/stockCounts/${stockCountId}/locations/store`).countedItems[0].quantity, 2);
});

test("location finish checkpoints and parent finish remain atomic, immutable and replayable", async () => {
  const db = fixture(), { stockCountId } = await createTwoLocations(db);
  const store = { action: "finish-location", requestId: "finish-store" };
  await locationCommand(db, stockCountId, "store", 2, 0, store);
  await assert.rejects(mutate(db, stockCountId, { action: "finish-count", expectedRevision: 1 }), { code: "failed-precondition" });
  await assert.rejects(locationCommand(db, stockCountId, "kitchen", null, 0,
    { action: "finish-location", countedItems: [counted({ quantity: null, isCounted: false })] }), { code: "failed-precondition" });
  await locationCommand(db, stockCountId, "kitchen", 3, 0, { action: "finish-location", actorUid: "second-counter" });
  const finished = await mutate(db, stockCountId, { action: "finish-count", expectedRevision: 2, requestId: "finish-all" });
  assert.equal(finished.status, "Finished");
  assert.deepEqual(await mutate(db, stockCountId, { action: "finish-count", expectedRevision: 2, requestId: "finish-all" }), finished);
  const replay = await locationCommand(db, stockCountId, "store", 2, 0, store);
  assert.equal(replay.locationRevision, 1);
  assert.equal(db.records.get(`hotels/${hotel}/stockCounts/${stockCountId}`).revision, 3);
  assert.equal([...db.records.keys()].filter((path) => path.startsWith(`hotels/${hotel}/inventoryCheckpoints/`)).length, 2);
  await assert.rejects(locationCommand(db, stockCountId, "store", 9, 1), { code: "failed-precondition" });
});

test("mutation receipts reject changed input and recheck current actor and tenant access on replay", async () => {
  const db = fixture(), { stockCountId } = await create(db);
  const original = await locationCommand(db, stockCountId, "store", 2, 0, { requestId: "save-a" });
  await locationCommand(db, stockCountId, "store", 3, 1, { requestId: "save-b" });
  assert.deepEqual(await locationCommand(db, stockCountId, "store", 2, 0, { requestId: "save-a" }), original);
  await assert.rejects(locationCommand(db, stockCountId, "store", 8, 0, { requestId: "save-a" }), (error) => error.code === "already-exists" && error.details?.countMutationUncommitted !== true);
  assert.equal(db.records.get(`hotels/${hotel}/stockCounts/${stockCountId}/locations/store`).countedItems[0].quantity, 3);
  db.records.set(`hotels/${hotel}/members/counter`, { permissions: [] });
  await assert.rejects(locationCommand(db, stockCountId, "store", 2, 0, { requestId: "save-a" }), (error) => error.code === "permission-denied" && error.details?.countMutationUncommitted !== true);
});

test("ordinary hotel user creates canonical snapshots and completes a stock count without admin claims", async () => {
  const db = fixture();
  const { stockCountId } = await create(db);
  const ref = `hotels/${hotel}/stockCounts/${stockCountId}`;
  const created = db.records.get(ref);
  assert.equal(created.createdBy, "counter");
  assert.equal(db.records.get(`${ref}/locations/store`).stockTemplate.items[0].catalogProductId, "coffee");
  assert.equal(db.records.get(`${ref}/locations/store`).stockTemplate.items[0].unitCost, null);
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
  for (const quantity of [-1, "3", NaN, Infinity, 1000001, 0.0000001]) assert.throws(() => require("./inventoryPolicy").countItems([counted({ quantity })]));
  assert.throws(() => require("./inventoryPolicy").countItems([counted(), counted()]));
  assert.throws(() => require("./inventoryPolicy").countItems(Array.from({ length: 251 }, () => counted())));
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
test("creation retries are idempotent and bound to exact input; unresolved catalog links remain unavailable", async () => {
  const db = fixture(); const first = await create(db); const second = await create(db);
  assert.deepEqual(first, second);
  await assert.rejects(create(db, { name: "Different" }), (error) => error.code === "already-exists");
  const missing = fixture(); missing.records.set(`hotels/${hotel}/supplierproducts/coffee`, { name: "Coffee" });
  await assert.rejects(create(missing), (error) => error.code === "failed-precondition");
  assert.equal([...missing.records.keys()].some((path) => path.includes("/stockCounts/")), false);
});
test("outlet counts start without names or templates and preserve uncounted null separately from explicit zero", async () => {
  const db = fixture(["stockcounts.create", "stockcounts.read", "stockcounts.update"]);
  const created = await create(db, { name: undefined, type: "Ad Hoc", reason: "Check after event", businessDate: "2026-10-12",
    locations: [{ outletId: "bar" }] });
  const ref = `hotels/${hotel}/stockCounts/${created.stockCountId}`, locationId = "outlet:bar";
  assert.equal(db.records.get(ref).name, "Ad Hoc · 2026-10-12");
  assert.equal(db.records.get(ref).reason, "Check after event");
  assert.equal(db.records.get(`${ref}/locations/${locationId}`).stockTemplateId, null);
  assert.deepEqual(db.records.get(`${ref}/locations/${locationId}`).stockTemplate.items, []);
  assert.equal(db.records.get(`hotels/${hotel}/locations/${locationId}`).outletId, "bar");
  await assert.rejects(mutate(db, created.stockCountId, { action: "finish-location", locationId, countedItems: [] }), { code: "failed-precondition" });
  const uncounted = counted({ quantity: null, isCounted: false, unitCost: null });
  await mutate(db, created.stockCountId, { locationId, countedItems: [uncounted] });
  assert.equal(db.records.get(`${ref}/locations/${locationId}`).countedItems[0].quantity, null);
  assert.equal(db.records.get(ref).countedValue, null);
  await assert.rejects(mutate(db, created.stockCountId, { action: "finish-location", locationId, expectedRevision: 1, countedItems: [uncounted] }), { code: "failed-precondition" });
  await mutate(db, created.stockCountId, { action: "finish-location", locationId, expectedRevision: 1,
    countedItems: [counted({ quantity: 0, unitCost: null })] });
  assert.equal(db.records.get(ref).countedValue, 0);
  assert.equal(db.records.get(`${ref}/locations/${locationId}`).countedItems[0].quantity, 0);
});
test("month-end selection freezes the exact last business day including leap years and replay metadata", async () => {
  const db = fixture();
  const result = await create(db, { name: undefined, type: "Month-End", periodMonth: 2, periodYear: 2024, locations: [{ outletId: "bar" }] });
  const data = db.records.get(`hotels/${hotel}/stockCounts/${result.stockCountId}`);
  assert.equal(data.businessDate, "2024-02-29"); assert.equal(data.name, "Month-End · 2024-02");
  assert.equal(data.periodMonth, 2); assert.equal(data.periodYear, 2024);
  await assert.rejects(create(db, { name: undefined, type: "Month-End", periodMonth: 3, periodYear: 2024, locations: [{ outletId: "bar" }] }), { code: "already-exists" });
  for (const patch of [{ periodMonth: 13, periodYear: 2024 }, { periodMonth: 2, periodYear: "2024" }, { periodMonth: 2 },
    { periodMonth: 2, periodYear: 2024, businessDate: "2024-02-28" }, { reason: "Monthly" }]) {
    await assert.rejects(create(fixture(), { name: undefined, type: "Month-End", locations: [{ outletId: "bar" }], ...patch }), { code: "invalid-argument" });
  }
});
test("stock destinations validate outlet ownership, active central stores and mutually exclusive whole/detail counting", async () => {
  const db = fixture();
  db.records.set(`hotels/${hotel}/locations/fridge`, { name: "Fridge", outletId: "bar" });
  db.records.set(`hotels/${hotel}/outlets/central`, { name: "Central drinks store", inventoryRole: "central_storage" });
  const central = await create(db, { requestId: "central", locations: [{ outletId: "central" }] });
  assert.equal(db.records.get(`hotels/${hotel}/stockCounts/${central.stockCountId}/locations/outlet:central`).inventoryRole, "central_storage");
  await assert.rejects(create(db, { requestId: "both", locations: [{ outletId: "bar" }, { outletId: "bar", locationId: "fridge" }] }), { code: "invalid-argument" });
  await assert.rejects(create(db, { requestId: "wrong", locations: [{ outletId: "central", locationId: "fridge" }] }), { code: "invalid-argument" });
  const detail = await create(db, { requestId: "detail", locations: [{ outletId: "bar", locationId: "fridge" }] });
  assert.equal(db.records.get(`hotels/${hotel}/stockCounts/${detail.stockCountId}/locations/fridge`).outletId, "bar");
  db.records.set(`hotels/${hotel}/outlets/central`, { name: "Central", archived: true });
  await assert.rejects(create(db, { requestId: "archived", locations: [{ outletId: "central" }] }), { code: "failed-precondition" });
});
test("count source projection excludes archived stock points and rejects forged reserved outlet identities", async () => {
  const db = fixture();
  const load = () => listHotelStockCountSourcesHandler(request({ hotelUid: hotel }), { firestore: db, auth: currentAuth });
  assert.equal((await load()).locations[0].locationId, "outlet:bar");
  db.records.set(`hotels/${hotel}/locations/outlet:bar`, { name: "Bar", outletId: "bar", stockPointType: "outlet", stockPointPolicyVersion: 1, resourcePolicyVersion: 1, revision: 0, archived: true });
  assert.equal((await load()).locations.some((point) => point.locationId === "outlet:bar"), false);
  db.records.set(`hotels/${hotel}/locations/outlet:bar`, { name: "Forged", outletId: "bar", stockPointType: "outlet", stockPointPolicyVersion: 1 });
  await assert.rejects(load(), { code: "failed-precondition" });
});
test("template additions require independent location authority and preserve live template changes", async () => {
  const db = fixture(); const { stockCountId } = await create(db);
  db.records.set(`hotels/${hotel}/locations/store/stockTemplates/template`, { name: "Weekly", items: [
    { supplierProductId: "coffee", outletId: "bar" }, { supplierProductId: "existing", outletId: "bar" }] });
  await mutate(db, stockCountId, { action: "finish-location", countedItems: [counted(), counted({ catalogProductId: "milk", quantity: 2 })],
    templateItemsToAdd: [{ catalogProductId: "milk" }] });
  const template = db.records.get(`hotels/${hotel}/locations/store/stockTemplates/template`);
  assert.deepEqual(template.items.map((item) => item.catalogProductId || item.supplierProductId), ["coffee", "existing", "milk"]);
  const limited = fixture(["stockcounts.create", "stockcounts.update"]); const count = await create(limited);
  await assert.rejects(mutate(limited, count.stockCountId, { action: "finish-location", countedItems: [counted({ catalogProductId: "milk" })],
    templateItemsToAdd: [{ catalogProductId: "milk" }] }), (error) => error.code === "permission-denied");
  await assert.doesNotReject(mutate(limited, count.stockCountId, { action: "finish-location" }));
});
test("staff lookup returns only same-hotel display name and never falls back to a global email query", async () => {
  const db = fixture(["stockcounts.read"]);
  db.records.set(`hotels/${hotel}/members/person`, { permissions: [] });
  db.records.set("users/person", { firstName: "Ada", lastName: "Lovelace", email: "private@example.test", hotelUid: ["hotel-a", "hotel-b"] });
  const lookup = (userId, hotelUid = hotel) => getHotelUserDisplayNameHandler(request({ hotelUid, userId }), { firestore: db, auth: currentAuth });
  assert.deepEqual(await lookup("person"), { displayName: "Ada Lovelace" });
  db.records.set(`hotels/${hotel}/members/person`, { permissions: [], firstName: "Local", lastName: "Colleague" });
  assert.deepEqual(await lookup("person"), { displayName: "Local Colleague" });
  assert.equal(db.records.get("users/person").firstName, "Ada");
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
    "hotelSubscriptions/hotel-a": { modules: ["procurement", "contracts", "frontoffice", "groups", "revenue"], modulePolicyVersion: 1, status: "active", validUntil: null },
    "hotels/hotel-a/members/counter": { permissions: ["orders.approve"] }, "hotels/hotel-a/outlets/bar/approvers/counter": {} };
  for (const identity of [{ emailVerified: true, disabled: true }, { emailVerified: false }, null]) {
    const db = memoryDatabase(initial);
    const result = await claimDispatch(db, "hotel-a", "o", "d", { getUser: async () => { if (!identity) throw new Error("deleted"); return identity; } });
    assert.equal(result, null); assert.equal(db.records.get("hotels/hotel-a/dispatches/d").status, "blocked");
  }
  assert.equal((await claimDispatch(memoryDatabase(initial), "hotel-a", "o", "d", currentAuth)).actorUid, "counter");
});
