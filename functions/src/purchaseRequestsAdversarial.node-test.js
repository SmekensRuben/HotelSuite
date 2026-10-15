const { test } = require("node:test");
const assert = require("node:assert/strict");
const { memoryDatabase } = require("./inventoryTestHelpers");
const { SAAS_RULES_VERSION } = require("./saasRollout");
const api = require("./purchaseRequests");

const permissions = ["purchaserequests.read", "purchaserequests.create", "purchaserequests.update", "purchaserequests.submit", "purchaserequests.approve", "purchaserequests.cancel", "purchasebudgets.read", "purchasebudgets.update", "purchasebudgets.settings"];
const settings = (patch = {}) => ({ currency: "EUR", costCentres: [{ id: "kitchen", name: "Kitchen" }], budgetCategories: [{ id: "maintenance", name: "Maintenance" }, { id: "chinaware", name: "Chinaware" }], approvalSteps: [{ id: "manager", name: "Manager", thresholdMinor: 0 }], approvers: [
  { uid: "manager", stepIds: ["manager"], limitMinor: 1000000, canApproveOverBudget: false },
  { uid: "finance", stepIds: ["manager"], limitMinor: 1000000, canApproveOverBudget: true },
  { uid: "director", stepIds: ["manager"], limitMinor: 1000000, canApproveOverBudget: true },
], overBudgetMode: "block", ...patch });
const draft = (amount = "150", patch = {}) => ({ supplierId: "supplier", title: "Freezer repair", description: "Replace compressor", motivation: "The freezer is broken", costCentreId: "kitchen", budgetCategoryId: "maintenance", budgetMonth: "2026-10", lines: [{ id: "repair", kind: "free", description: "Repair", quantity: "1", unitPrice: amount, unit: "service" }], attachmentIds: [], ...patch });

async function fixture(configuration = settings()) {
  const users = new Map(["requester", "manager", "finance", "director"].map((uid) => [uid, { uid, email: `${uid}@example.test`, emailVerified: true, disabled: false }]));
  const db = memoryDatabase({
    "platformConfiguration/saasProcurement": { enabled: true, rulesVersion: SAAS_RULES_VERSION },
    "hotels/hotel-a": { hotelName: "Fictional hotel", timeZone: "Europe/Brussels" },
    "hotelSubscriptions/hotel-a": { status: "active", validUntil: null, modules: ["procurement"], modulePolicyVersion: 1 },
    "hotels/hotel-a/suppliers/supplier": { name: "Fictional repair company", active: true },
    ...Object.fromEntries([...users.keys()].map((uid) => [`hotels/hotel-a/members/${uid}`, { permissions }])),
  });
  let sequence = 0;
  const services = { firestore: db, auth: { getUser: async (uid) => { if (!users.has(uid)) throw new Error("missing user"); return users.get(uid); } }, now: () => Date.parse("2026-10-15T10:00:00Z") };
  const request = (data, uid = "requester") => ({ auth: { uid, token: { email_verified: true, auth_time: 2000000000 } }, data });
  const nextId = () => `adversarial-${++sequence}`;
  const run = (handler, data, uid) => handler(request({ hotelUid: "hotel-a", ...data }, uid), services);
  const configure = (value, expectedRevision = 1) => run(api.saveHotelPurchaseRequestSettingsHandler, { requestId: nextId(), expectedRevision, settings: value });
  await configure(configuration, 0);
  const budgets = async (rows) => run(api.saveHotelPurchaseBudgetsHandler, { requestId: nextId(), budgets: rows });
  await budgets([{ month: "2026-10", categoryId: "maintenance", budgetMinor: 50000, openingUsedMinor: 0, expectedRevision: 0 }, { month: "2026-11", categoryId: "chinaware", budgetMinor: 50000, openingUsedMinor: 0, expectedRevision: 0 }]);
  const mutate = (action, previous, fields = {}, uid = "requester") => run(api.mutateHotelPurchaseRequestHandler, { requestId: nextId(), action, expectedRevision: previous?.revision || 0, ...(previous ? { purchaseRequestId: previous.purchaseRequestId } : {}), ...fields }, uid);
  const create = (amount = "150", patch) => mutate("create", null, { draft: draft(amount, patch) });
  const read = (previous) => run(api.getHotelPurchaseRequestHandler, { purchaseRequestId: previous.purchaseRequestId });
  const budget = (id = "2026-10__maintenance") => structuredClone(db.records.get(`hotels/hotel-a/purchaseBudgets/${id}`));
  return { db, users, services, request, run, nextId, configure, budgets, mutate, create, read, budget };
}

function reordered(value) {
  if (Array.isArray(value)) return value.map(reordered);
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return value;
  return Object.fromEntries(Object.keys(value).sort().reverse().map((key) => [key, reordered(value[key])]));
}
const evidence = (db) => JSON.stringify([...db.records]);

test("Firestore map key ordering does not invalidate snapshots, history or durable command receipts", async () => {
  const context = await fixture();
  const input = { requestId: context.nextId(), action: "create", expectedRevision: 0, draft: draft("1.005") };
  const created = await context.run(api.mutateHotelPurchaseRequestHandler, input);
  assert.equal(created.request.totalMinor, 101);
  for (const [path, value] of context.db.records) context.db.records.set(path, reordered(value));
  const detail = await context.read(created);
  assert.equal(detail.request.totalMinor, 101);
  assert.equal(detail.history[0].snapshot.totalMinor, 101);
  assert.deepEqual(await context.run(api.mutateHotelPurchaseRequestHandler, input), created);
});

test("replaying an old submission after final approval and cancellation never restores its reservation", async () => {
  const context = await fixture(), created = await context.create();
  const input = { requestId: context.nextId(), action: "submit", purchaseRequestId: created.purchaseRequestId, expectedRevision: created.revision, approverUid: "manager" };
  const submitted = await context.run(api.mutateHotelPurchaseRequestHandler, input);
  const approved = await context.mutate("approve", submitted, {}, "manager");
  const canceled = await context.mutate("cancel", approved);
  const before = evidence(context.db);
  assert.deepEqual(await context.run(api.mutateHotelPurchaseRequestHandler, input), submitted);
  assert.equal(evidence(context.db), before);
  assert.equal((await context.read(canceled)).request.status, "canceled");
  assert.equal(context.budget().pendingMinor, 0);
  assert.equal(context.budget().committedMinor, 0);
});

test("a saved command receipt cannot bypass current permissions or account revocation", async () => {
  const context = await fixture(), input = { requestId: context.nextId(), action: "create", expectedRevision: 0, draft: draft() };
  await context.run(api.mutateHotelPurchaseRequestHandler, input);
  const before = evidence(context.db);
  context.db.records.set("hotels/hotel-a/members/requester", { permissions: ["purchaserequests.read"] });
  await assert.rejects(context.run(api.mutateHotelPurchaseRequestHandler, input), { code: "permission-denied" });
  context.db.records.set("hotels/hotel-a/members/requester", { permissions });
  context.users.get("requester").disabled = true;
  await assert.rejects(context.run(api.mutateHotelPurchaseRequestHandler, input), { code: "permission-denied" });
  assert.equal(evidence(context.db), before);
});

test("returning and editing preserves the old hold until resubmission atomically moves month and category", async () => {
  const context = await fixture(), created = await context.create();
  const submitted = await context.mutate("submit", created, { approverUid: "manager" });
  const frozen = JSON.stringify(context.db.records.get(`hotels/hotel-a/purchaseRequests/${created.purchaseRequestId}/history/000002`));
  const returned = await context.mutate("return", submitted, { reason: "Use the November chinaware allocation" }, "manager");
  const edited = await context.mutate("save", returned, { draft: draft("175.005", { budgetMonth: "2026-11", budgetCategoryId: "chinaware" }) });
  assert.equal(context.budget().pendingMinor, 15000);
  assert.equal(context.budget("2026-11__chinaware").pendingMinor, 0);
  const resubmitted = await context.mutate("submit", edited, { approverUid: "finance" });
  assert.equal(context.budget().pendingMinor, 0);
  assert.equal(context.budget("2026-11__chinaware").pendingMinor, 17501);
  const approved = await context.mutate("approve", resubmitted, {}, "finance");
  assert.equal(context.budget("2026-11__chinaware").pendingMinor, 0);
  assert.equal(context.budget("2026-11__chinaware").committedMinor, 17501);
  assert.equal((await context.read(approved)).request.budgetMonth, "2026-11");
  assert.equal(JSON.stringify(context.db.records.get(`hotels/hotel-a/purchaseRequests/${created.purchaseRequestId}/history/000002`)), frozen);
});

test("revising a final approval preserves consumption and requires a complete fresh approval chain", async () => {
  const configuration = settings({ approvalSteps: [{ id: "manager", name: "Manager", thresholdMinor: 0 }, { id: "finance", name: "Finance", thresholdMinor: 10000 }], approvers: [
    { uid: "manager", stepIds: ["manager"], limitMinor: 1000000, canApproveOverBudget: false },
    { uid: "finance", stepIds: ["finance"], limitMinor: 1000000, canApproveOverBudget: true },
  ] });
  const context = await fixture(configuration), created = await context.create();
  const submitted = await context.mutate("submit", created, { approverUid: "manager" });
  const intermediate = await context.mutate("approve", submitted, { nextApproverUid: "finance" }, "manager");
  const approved = await context.mutate("approve", intermediate, {}, "finance");
  const beforeAvailable = context.budget().remainingMinor;
  const revision = await context.mutate("revise", approved, { reason: "Include labour", draft: draft("175") });
  assert.equal(context.budget().remainingMinor, beforeAvailable);
  assert.equal(context.budget().pendingMinor, 15000);
  assert.equal(context.budget().committedMinor, 0);
  assert.equal(revision.request.approvals.length, 0);
  const resubmitted = await context.mutate("submit", revision, { approverUid: "manager" });
  assert.equal(context.budget().pendingMinor, 17500);
  await assert.rejects(context.mutate("approve", resubmitted, {}, "finance"), { code: "permission-denied" });
  const first = await context.mutate("approve", resubmitted, { nextApproverUid: "finance" }, "manager");
  assert.equal(first.request.status, "pending");
  assert.equal(context.budget().committedMinor, 0);
  await context.mutate("approve", first, {}, "finance");
  assert.equal(context.budget().pendingMinor, 0);
  assert.equal(context.budget().committedMinor, 17500);
});

test("a budget reduction while pending adds a distinct additional budget approval before committing", async () => {
  const context = await fixture(settings({ overBudgetMode: "approval" }));
  const submitted = await context.mutate("submit", await context.create(), { approverUid: "manager" });
  const budget = context.budget();
  await context.budgets([{ month: "2026-10", categoryId: "maintenance", budgetMinor: 10000, openingUsedMinor: 0, expectedRevision: budget.revision }]);
  await assert.rejects(context.mutate("approve", submitted, {}, "manager"));
  const intermediate = await context.mutate("approve", submitted, { nextApproverUid: "finance" }, "manager");
  assert.equal(intermediate.request.status, "pending");
  assert.deepEqual(intermediate.request.approvalSteps.map((step) => step.id), ["manager", "over-budget"]);
  assert.equal(context.budget().pendingMinor, 15000);
  assert.equal(context.budget().committedMinor, 0);
  const approved = await context.mutate("approve", intermediate, {}, "finance");
  assert.equal(approved.request.status, "approved");
  assert.equal(context.budget().remainingMinor, -5000);
});

test("later workflow settings cannot remove an already required approval from an in-flight version", async () => {
  const configuration = settings({ approvalSteps: [{ id: "manager", name: "Manager", thresholdMinor: 0 }, { id: "finance", name: "Finance", thresholdMinor: 10000 }], approvers: [
    { uid: "manager", stepIds: ["manager"], limitMinor: 1000000, canApproveOverBudget: false },
    { uid: "finance", stepIds: ["finance"], limitMinor: 1000000, canApproveOverBudget: true },
  ] });
  const context = await fixture(configuration);
  const submitted = await context.mutate("submit", await context.create(), { approverUid: "manager" });
  await context.configure({ ...configuration, approvalSteps: [{ id: "manager", name: "Manager", thresholdMinor: 0 }], approvers: [configuration.approvers[0]] });
  const before = evidence(context.db);
  await assert.rejects(context.mutate("approve", submitted, {}, "manager"));
  await assert.rejects(context.mutate("approve", submitted, { nextApproverUid: "finance" }, "manager"), { code: "permission-denied" });
  assert.equal(evidence(context.db), before);
  assert.equal(context.budget().pendingMinor, 15000);
  assert.equal(context.budget().committedMinor, 0);
});

test("an incomplete restored budget cannot release or approve a larger recorded reservation", async () => {
  const context = await fixture();
  const submitted = await context.mutate("submit", await context.create(), { approverUid: "manager" });
  context.db.records.get("hotels/hotel-a/purchaseBudgets/2026-10__maintenance").pendingMinor = 14999;
  const before = evidence(context.db);
  await assert.rejects(context.mutate("approve", submitted, {}, "manager"), { code: "failed-precondition" });
  await assert.rejects(context.mutate("withdraw", submitted), { code: "failed-precondition" });
  assert.equal(evidence(context.db), before);
});

test("revocation between the rejected transaction and recovery proof preserves command uncertainty", async () => {
  const context = await fixture(), created = await context.create(), input = { requestId: context.nextId(), action: "submit", purchaseRequestId: created.purchaseRequestId, expectedRevision: created.revision, approverUid: "requester" };
  const getUser = context.services.auth.getUser;
  let checked = 0;
  context.services.auth.getUser = async (uid) => {
    const user = await getUser(uid);
    return uid === "requester" && ++checked > 1 ? { ...user, disabled: true } : user;
  };
  const before = evidence(context.db);
  await assert.rejects(context.run(api.mutateHotelPurchaseRequestHandler, input), (error) => {
    assert.equal(error.code, "permission-denied");
    assert.equal(error.details?.purchaseRequestUncommitted, undefined);
    return true;
  });
  assert.ok(checked >= 2, "The proof must recheck live Auth instead of reusing the first account lookup");
  assert.equal(evidence(context.db), before);
});

test("a failed receipt absence check cannot clear a rejected command", async () => {
  const context = await fixture(), input = { requestId: context.nextId(), action: "create", expectedRevision: 0, draft: draft("not a price") };
  context.db.runTransaction = async () => { throw new Error("The database is unavailable"); };
  await assert.rejects(context.run(api.mutateHotelPurchaseRequestHandler, input), (error) => {
    assert.equal(error.code, "invalid-argument");
    assert.equal(error.details?.purchaseRequestUncommitted, undefined);
    return true;
  });
});
