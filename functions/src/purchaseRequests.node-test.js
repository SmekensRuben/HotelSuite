const test = require("node:test");
const assert = require("node:assert/strict");
const { memoryDatabase } = require("./inventoryTestHelpers");
const api = require("./purchaseRequests");
const { SAAS_RULES_VERSION } = require("./saasRollout");
const { pricingTerms } = require("./supplierPricePolicy");
const { purchaseTerms } = require("./supplierPriceVersions");
const { digest } = require("./validation");
const base = "hotels/hotel-a";
const permissions = ["purchaserequests.read", "purchaserequests.create", "purchaserequests.update", "purchaserequests.submit", "purchaserequests.approve", "purchaserequests.cancel", "purchasebudgets.read", "purchasebudgets.update", "purchasebudgets.settings"];
const authority = (uid, stepIds, extra = false) => ({ uid, stepIds, limitMinor: 100000000, canApproveOverBudget: extra });
function settings(patch = {}) {
  return { currency: "EUR", costCentres: [{ id: "kitchen", name: "Kitchen" }], budgetCategories: [{ id: "maintenance", name: "Maintenance" }, { id: "china", name: "Chinaware" }],
    approvalSteps: [{ id: "manager", name: "Manager approval", thresholdMinor: 0 }, { id: "finance", name: "Finance approval", thresholdMinor: 10000 }],
    approvers: [authority("manager", ["manager"]), authority("finance", ["finance"]), authority("director", ["finance"], true)], overBudgetMode: "block", ...patch };
}
function fixture(patch = {}) {
  const db = memoryDatabase({ [base]: { name: "Hotel A", timeZone: "Europe/Brussels" }, [`${base}/settings/purchaseRequests`]: { ...settings(patch), revision: 1, policyVersion: 1, ledgerRevision: 0, usedCategoryIds: [], usedCostCentreIds: [], currencyLocked: false },
    [`${base}/suppliers/vendor`]: { name: "Vendor", active: true, priceDateBasis: "order-date" },
    [`${base}/purchaseBudgets/2026-10__maintenance`]: { policyVersion: 1, month: "2026-10", categoryId: "maintenance", year: 2026, revision: 1, budgetMinor: 50000, openingUsedMinor: 0, pendingMinor: 0, committedMinor: 0 },
    [`${base}/purchaseBudgets/2026-11__china`]: { policyVersion: 1, month: "2026-11", categoryId: "china", year: 2026, revision: 1, budgetMinor: 50000, openingUsedMinor: 0, pendingMinor: 0, committedMinor: 0 },
    "hotelSubscriptions/hotel-a": { status: "active", validUntil: null, modules: ["procurement"], modulePolicyVersion: 1 },
    "platformConfiguration/saasProcurement": { enabled: true, rulesVersion: SAAS_RULES_VERSION } });
  for (const uid of ["buyer", "manager", "finance", "director"]) {
    db.records.set(`${base}/members/${uid}`, { permissions, displayName: uid });
    db.records.set(`users/${uid}`, { displayName: uid, email: `${uid}@example.com` });
  }
  return db;
}
const auth = { getUser: async (uid) => ({ uid, emailVerified: true, disabled: false, displayName: uid, email: `${uid}@example.com` }) };
const request = (data, uid = "buyer") => ({ auth: { uid, token: { email_verified: true, auth_time: 9999 } }, data: { hotelUid: "hotel-a", ...data } });
const services = (db, extra = {}) => ({ firestore: db, auth, now: () => Date.UTC(2026, 9, 15, 23), ...extra });
const draft = (price = 150, patch = {}) => ({ supplierId: "vendor", title: "Freezer repair", description: "Repair the freezer", motivation: "The freezer is broken", costCentreId: "kitchen", budgetCategoryId: "maintenance", budgetMonth: "2026-10",
  lines: [{ id: "line-1", kind: "free", description: "Repair", quantity: 1, unitPrice: price, unit: "service" }], attachmentIds: [], ...patch });
const create = (db, input = draft(), key = "create") => api.mutateHotelPurchaseRequestHandler(request({ action: "create", requestId: key, expectedRevision: 0, draft: input }), services(db));
const command = (db, value, action, extra = {}, uid = "buyer", key = `${action}-${value.revision}`) => api.mutateHotelPurchaseRequestHandler(request({ action, requestId: key, purchaseRequestId: value.purchaseRequestId, expectedRevision: value.revision, ...extra }, uid), services(db));
const submit = (db, value, extra = {}) => command(db, value, "submit", { approverUid: "manager", ...extra });
const budget = (db, id = "2026-10__maintenance") => db.records.get(`${base}/purchaseBudgets/${id}`);
const current = (db, value) => db.records.get(`${base}/purchaseRequests/${value.purchaseRequestId}`);
const get = (db, value, uid = "buyer") => api.getHotelPurchaseRequestHandler(request({ purchaseRequestId: value.purchaseRequestId }, uid), services(db));
const requesterOnlySettings = (patch = {}) => settings({ approvers: [authority("buyer", ["manager"]), authority("finance", ["finance"]), authority("director", [], true)], ...patch });

function recoveryFixture(patch = {}) {
  const db = fixture({ approvers: [authority("manager", ["manager"]), authority("finance", ["finance"]), authority("director", ["manager", "finance"], true)], ...patch });
  db.records.set(`${base}/members/recovery`, { permissions: ["purchaserequests.read", "purchaserequests.recover"] });
  return db;
}
const recoveryInput = async (db, value, approverUid = "director") => ({ approverUid, reason: "The assigned approver is unavailable; assign the authorized substitute.", expectedApprovalRouteFingerprint: (await get(db, value, "recovery")).recoveryApprovalRoute.fingerprint });

test("recovery replaces an approver who lost access without changing the frozen request or reservation", async () => {
  const db = recoveryFixture(), pending = await submit(db, await create(db));
  db.records.get(`${base}/members/manager`).permissions = ["purchaserequests.read"];
  const budgetBefore = structuredClone(budget(db)), input = await recoveryInput(db, pending);
  const recovered = await command(db, pending, "reassign", input, "recovery");
  assert.equal(recovered.request.status, "pending"); assert.equal(recovered.request.currentApproverUid, "director");
  assert.deepEqual(recovered.request.approvalSteps, pending.request.approvalSteps); assert.deepEqual(recovered.request.lines, pending.request.lines);
  assert.deepEqual(recovered.request.reservation, pending.request.reservation); assert.deepEqual(structuredClone(budget(db)), budgetBefore);
  assert.deepEqual(await command(db, pending, "reassign", input, "recovery"), recovered, "the original command returns its committed receipt");
  const history = (await get(db, recovered)).history;
  assert.equal(history[0].event, "reassign"); assert.equal(history[0].reason, input.reason);
  assert.equal(history[0].snapshot.lastRecovery.fromApproverUid, "manager"); assert.equal(history[0].snapshot.lastRecovery.toApproverUid, "director");
  assert.equal(history.find((row) => row.event === "submit").snapshot.currentApproverUid, "manager");
  await assert.rejects(command(db, recovered, "approve", {}, "manager"), { code: "permission-denied" });
  const next = await command(db, recovered, "approve", {}, "director"); assert.equal(next.request.currentApproverUid, "finance");
  assert.equal((await command(db, next, "approve", {}, "finance")).request.status, "approved");
});
test("recovery cancellation closes a request after both requester and approver leave and releases budget exactly once", async () => {
  const db = recoveryFixture(), pending = await submit(db, await create(db));
  db.records.delete(`${base}/members/buyer`); db.records.delete(`${base}/members/manager`);
  const canceled = await command(db, pending, "recovercancel", { reason: "Both responsible staff members left; purchase is no longer needed." }, "recovery");
  assert.equal(canceled.request.status, "canceled"); assert.equal(canceled.request.currentApproverUid, null);
  assert.equal(budget(db).pendingMinor, 0); assert.equal(budget(db).committedMinor, 0); assert.equal(budget(db).revision, 3);
  assert.deepEqual(await command(db, pending, "recovercancel", { reason: "Both responsible staff members left; purchase is no longer needed." }, "recovery"), canceled);
  assert.equal(budget(db).revision, 3); assert.equal((await get(db, canceled, "recovery")).history[0].snapshot.lastRecovery.fromApproverUid, "manager");
  const recipients = [...db.records.values()].filter((row) => row.event === "recovercancel" && row.type === "purchase-request").map((row) => row.recipientUid).sort();
  assert.deepEqual(recipients, ["buyer", "manager", "recovery"]);
});
test("recovery cancellation releases the retained reservation of an edited returned request", async () => {
  const db = recoveryFixture(), pending = await submit(db, await create(db)), returned = await command(db, pending, "return", { reason: "Review quote" }, "manager");
  const edited = await command(db, returned, "save", { draft: draft(90) });
  assert.equal(edited.request.totalMinor, 9000); assert.equal(edited.request.reservation.amountMinor, 15000);
  await command(db, edited, "recovercancel", { reason: "Requester left before resubmission" }, "recovery");
  assert.equal(budget(db).pendingMinor, 0);
});
test("recovery preserves completed approvals and refuses reusing their approver", async () => {
  const db = recoveryFixture(), pending = await submit(db, await create(db)), finance = await command(db, pending, "approve", { nextApproverUid: "finance" }, "manager");
  const input = await recoveryInput(db, finance), recovered = await command(db, finance, "reassign", input, "recovery");
  assert.deepEqual(recovered.request.approvals, finance.request.approvals); assert.equal(recovered.request.currentStepIndex, 1);
  assert.deepEqual(recovered.request.approvalSteps, finance.request.approvalSteps);
  const route = (await get(db, finance, "recovery")).recoveryApprovalRoute;
  assert.ok(!route.plan?.[0]?.candidates.some((person) => person.uid === "manager"));
});
test("recovery requires explicit authority and a reason without granting approval, self-approval or committed cancellation", async () => {
  for (const granted of [["purchaserequests.read"], ["purchaserequests.*"], permissions]) {
    const db = recoveryFixture(), pending = await submit(db, await create(db)), input = await recoveryInput(db, pending);
    db.records.get(`${base}/members/recovery`).permissions = granted;
    assert.equal((await get(db, pending, "recovery")).recoveryApprovalRoute, null);
    await assert.rejects(command(db, pending, "reassign", input, "recovery"), { code: "permission-denied" });
    await assert.rejects(command(db, pending, "recovercancel", { reason: "Abandoned request" }, "recovery"), { code: "permission-denied" });
  }
  const db = recoveryFixture(), pending = await submit(db, await create(db)), input = await recoveryInput(db, pending);
  for (const action of ["reassign", "recovercancel"]) await assert.rejects(command(db, pending, action, { ...(action === "reassign" ? input : {}), reason: " " }, "recovery"), { code: "invalid-argument" });
  await assert.rejects(command(db, pending, "reassign", { ...input, expectedApprovalRouteFingerprint: undefined }, "recovery"), { code: "invalid-argument" });
  await assert.rejects(command(db, pending, "approve", {}, "recovery"), { code: "permission-denied" });
  const next = await command(db, pending, "approve", { nextApproverUid: "finance" }, "manager"), approved = await command(db, next, "approve", {}, "finance");
  await assert.rejects(command(db, approved, "recovercancel", { reason: "Cannot erase a commitment" }, "recovery"), { code: "failed-precondition" });
  assert.equal(budget(db).committedMinor, 15000);
});
test("replacement authorization enforces department, full amount, membership, account and requester separation", async () => {
  for (const variant of ["department", "limit", "membership", "permission", "requester", "same-approver", "disabled", "unverified"]) {
    const db = recoveryFixture(), pending = await submit(db, await create(db)), input = await recoveryInput(db, pending), live = db.records.get(`${base}/settings/purchaseRequests`);
    let overriddenAuth = auth;
    if (variant === "department") live.costCentres[0].approverUids = ["manager"];
    if (variant === "limit") live.approvers.find((row) => row.uid === "director").limitMinor = 14999;
    if (variant === "membership") db.records.delete(`${base}/members/director`);
    if (variant === "permission") db.records.get(`${base}/members/director`).permissions = ["purchaserequests.read"];
    if (variant === "requester") { live.approvers.push(authority("buyer", ["manager"])); input.approverUid = "buyer"; }
    if (variant === "same-approver") input.approverUid = "manager";
    if (["disabled", "unverified"].includes(variant)) overriddenAuth = { getUser: async (uid) => ({ ...await auth.getUser(uid), ...(uid === "director" ? { disabled: variant === "disabled", emailVerified: variant !== "unverified" } : {}) }) };
    const original = structuredClone([...db.records]);
    await assert.rejects(api.mutateHotelPurchaseRequestHandler(request({ action: "reassign", requestId: `invalid-${variant}`, purchaseRequestId: pending.purchaseRequestId, expectedRevision: pending.revision, ...input }, "recovery"), services(db, { auth: overriddenAuth })));
    assert.deepEqual(structuredClone([...db.records]), original, variant);
  }
});
test("recovery refuses a replacement who would consume the only person for a later mandatory step", async () => {
  const db = recoveryFixture({ approvers: [authority("manager", ["manager"]), authority("director", ["manager", "finance"])] }), pending = await submit(db, await create(db));
  const preview = (await get(db, pending, "recovery")).recoveryApprovalRoute;
  assert.ok(preview.error); assert.match(preview.error.message, /different authorized people/);
  await assert.rejects(command(db, pending, "reassign", { approverUid: "director", reason: "Replacement", expectedApprovalRouteFingerprint: "a".repeat(64) }, "recovery"), { code: "permission-denied" });
});
test("recovery retains self-approval evidence and all independent and over-budget controls", async () => {
  const db = allowSelf(recoveryFixture({ overBudgetMode: "approval", approvalSteps: settings().approvalSteps.map((step) => ({ ...step, independentRequired: step.id === "finance" })),
    approvers: [authority("finance", ["finance"]), authority("director", ["finance"]), authority("manager", [], true)] }));
  budget(db).budgetMinor = 0;
  const pending = await command(db, await create(db), "selfapprove", { reason: "Own authority with separate independent controls", approverUid: "finance" });
  const recovered = await command(db, pending, "reassign", await recoveryInput(db, pending), "recovery");
  assert.deepEqual(recovered.request.selfApproval, pending.request.selfApproval);
  assert.deepEqual(recovered.request.approvalSteps.map((step) => step.id), ["finance", "over-budget"]);
  const extra = await command(db, recovered, "approve", {}, "director"); assert.equal(extra.request.currentApproverUid, "manager");
  assert.equal(budget(db).committedMinor, 0); assert.equal((await command(db, extra, "approve", {}, "manager")).request.status, "approved");
});
test("concurrent approval and reassignment commit exactly one revision in either ordering", async () => {
  for (const recoveryFirst of [false, true]) {
    const db = recoveryFixture(), pending = await submit(db, await create(db)), input = await recoveryInput(db, pending);
    const attempts = [() => command(db, pending, "approve", { nextApproverUid: "finance" }, "manager"), () => command(db, pending, "reassign", input, "recovery")];
    if (recoveryFirst) attempts.reverse();
    const results = await Promise.allSettled(attempts.map((attempt) => attempt()));
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.find((result) => result.status === "rejected").reason.code, "aborted");
    assert.equal(current(db, pending).revision, pending.revision + 1); assert.equal(budget(db).pendingMinor, 15000); assert.equal(budget(db).committedMinor, 0);
    assert.equal(current(db, pending).approvals.length, recoveryFirst ? 0 : 1);
    assert.equal(current(db, pending).currentApproverUid, recoveryFirst ? "director" : "finance");
  }
});
test("concurrent repeated recovery commands return one receipt and enqueue one notification per participant", async () => {
  const db = recoveryFixture(), pending = await submit(db, await create(db)), input = await recoveryInput(db, pending);
  const results = await Promise.all([command(db, pending, "reassign", input, "recovery"), command(db, pending, "reassign", input, "recovery")]);
  assert.deepEqual(results[0], results[1]);
  assert.equal([...db.records.values()].filter((row) => row.type === "purchase-request" && row.event === "reassign").length, 4);
  assert.equal(current(db, pending).revision, 3);
});

test("cost centre routing isolates department heads and automatically assigns the only complete route", async () => {
  const db = fixture({ costCentres: [{ id: "kitchen", name: "Kitchen", approverUids: ["manager"] }, { id: "bar", name: "Bar", approverUids: ["director"] }],
    approvers: [authority("manager", ["manager"]), authority("director", ["manager"]), authority("finance", ["finance"])] });
  const kitchen = await create(db), bar = await create(db, draft(50, { costCentreId: "bar" }), "bar");
  assert.deepEqual((await get(db, kitchen)).submissionApprovalRoute.approvers.map((person) => person.uid), ["manager"]);
  assert.deepEqual((await get(db, bar)).submissionApprovalRoute.approvers.map((person) => person.uid), ["director"]);
  await assert.rejects(submit(db, bar), { code: "permission-denied" });
  assert.equal((await command(db, bar, "submit")).request.currentApproverUid, "director");
  const pending = await command(db, kitchen, "submit", {}, "buyer", "submit-kitchen");
  assert.equal((await command(db, pending, "approve", {}, "manager")).request.currentApproverUid, "finance");
});
test("an explicitly unstaffed department never inherits another department's head", async () => {
  const db = fixture({ costCentres: [{ id: "kitchen", name: "Kitchen", approverUids: [] }] }), created = await create(db);
  assert.ok((await get(db, created)).submissionApprovalRoute.error);
  await assert.rejects(submit(db, created), { code: "permission-denied" });
  assert.equal(budget(db).pendingMinor, 0);
});
test("full routing reserves the only later authority instead of greedily assigning them first", async () => {
  const db = fixture({ approvers: [authority("manager", ["manager", "finance"]), authority("finance", ["manager"])] }), created = await create(db);
  const route = (await get(db, created)).submissionApprovalRoute;
  assert.deepEqual(route.approvers.map((person) => person.uid), ["finance"]);
  assert.deepEqual(route.plan[1].candidates.map((person) => person.uid), ["manager"]);
  await assert.rejects(submit(db, created), { code: "permission-denied" });
  const pending = await command(db, created, "submit"), finalStep = await command(db, pending, "approve", {}, "finance");
  assert.equal(finalStep.request.currentApproverUid, "manager");
  assert.equal((await command(db, finalStep, "approve", {}, "manager")).request.status, "approved");
});
test("a requester assigned only to a later control blocks submission before any reservation", async () => {
  const db = fixture({ approvers: [authority("manager", ["manager"]), authority("buyer", ["finance"])] }), created = await create(db);
  const before = structuredClone([...db.records]), route = (await get(db, created)).submissionApprovalRoute;
  assert.match(route.error.message, /Finance approval/);
  await assert.rejects(submit(db, created), { code: "permission-denied" });
  assert.deepEqual(structuredClone([...db.records]), before);
});
test("explicit substitutes can perform a later requester control and are recorded in the immutable decision", async () => {
  const db = fixture({ approvalSteps: settings().approvalSteps.map((step) => step.id === "finance" ? { ...step, substituteUids: ["director"] } : step),
    approvers: [authority("manager", ["manager"]), authority("buyer", ["finance"]), authority("director", [])] });
  const pending = await submit(db, await create(db)), next = await command(db, pending, "approve", {}, "manager");
  assert.equal(next.request.currentApproverUid, "director"); assert.equal(next.request.currentAssignment.kind, "substitute");
  const approved = await command(db, next, "approve", {}, "director");
  assert.equal(approved.request.approvals[1].kind, "substitute");
  assert.equal((await get(db, approved)).history[0].snapshot.approvals[1].kind, "substitute");
});
test("a configured higher level performs a control without silently deleting any other required control", async () => {
  const db = fixture({ approvalSteps: [...settings().approvalSteps.map((step) => step.id === "finance" ? { ...step, fallbackStepId: "gm" } : step), { id: "gm", name: "General Manager", thresholdMinor: 50000 }],
    approvers: [authority("manager", ["manager"]), authority("buyer", ["finance"]), authority("director", ["gm"])] });
  const low = await create(db), route = (await get(db, low)).submissionApprovalRoute;
  assert.deepEqual(route.steps.map((step) => step.id), ["manager", "finance"]);
  assert.equal(route.plan[1].candidates[0].kind, "higher-level");
  const pending = await submit(db, low), finance = await command(db, pending, "approve", {}, "manager");
  assert.equal((await command(db, finance, "approve", {}, "director")).request.approvals[1].authorityStepId, "gm");
  const high = await create(db, draft(500), "high");
  assert.ok((await get(db, high)).submissionApprovalRoute.error, "the same director cannot perform Finance and GM controls");
});
test("a department substitute is used before the legacy requester-only escalation", async () => {
  const db = fixture(requesterOnlySettings({ costCentres: [{ id: "kitchen", name: "Kitchen", approverUids: ["buyer"], substituteUids: ["manager"] }],
    approvers: [authority("buyer", ["manager"]), authority("manager", []), authority("finance", ["finance"])] }));
  const created = await create(db, draft(50)), route = (await get(db, created)).submissionApprovalRoute;
  assert.equal(route.escalation, null); assert.equal(route.plan[0].candidates[0].kind, "substitute");
  assert.equal((await command(db, created, "submit")).request.currentApproverUid, "manager");
});
test("changed later access blocks the current approval atomically and remains readable for repair", async () => {
  const db = fixture({ approvers: [authority("manager", ["manager"]), authority("finance", ["finance"])] }), pending = await submit(db, await create(db));
  db.records.get(`${base}/members/finance`).permissions = ["purchaserequests.read"];
  const before = structuredClone([...db.records]);
  assert.ok((await get(db, pending, "manager")).decisionApprovalRoute.error);
  await assert.rejects(command(db, pending, "approve", {}, "manager"), { code: "permission-denied" });
  assert.deepEqual(structuredClone([...db.records]), before);
});
function allowSelf(db, limitMinor = 50000) {
  db.records.get(`${base}/members/buyer`).permissions = [...permissions, "purchaserequests.selfapprove"];
  db.records.get(`${base}/settings/purchaseRequests`).approvers.push({ ...authority("buyer", []), selfApprovalLimitMinor: limitMinor });
  return db;
}
test("explicit GM self-approval registers exactly once with actor time reason coverage and notification", async () => {
  const db = allowSelf(fixture()), created = await create(db), route = (await get(db, created)).selfApprovalRoute;
  assert.equal(route.error, null); assert.deepEqual(route.steps, []);
  const input = { reason: "GM replacement within delegated authority", expectedApprovalRouteFingerprint: route.fingerprint };
  const approved = await command(db, created, "selfapprove", input);
  assert.equal(approved.request.status, "approved"); assert.equal(budget(db).pendingMinor, 0); assert.equal(budget(db).committedMinor, 15000);
  assert.equal(approved.request.selfApproval.approverUid, "buyer"); assert.equal(approved.request.selfApproval.approvedAtMillis, services(db).now());
  assert.equal(approved.request.selfApproval.reason, input.reason); assert.equal(approved.request.selfApproval.limitMinor, 50000);
  assert.deepEqual(approved.request.selfApproval.coveredSteps.map((step) => step.id), ["manager", "finance"]);
  assert.deepEqual(await command(db, created, "selfapprove", input), approved);
  assert.equal((await get(db, approved)).history[0].event, "selfapproved");
  const mail = [...db.records.values()].find((row) => row.type === "purchase-request");
  assert.equal(mail.event, "selfapproved"); assert.equal(mail.recipientUid, "buyer");
  const delivered = await require("./purchaseRequestNotifications").resolvePurchaseRequestNotification({ get: (ref) => db.runTransaction((tx) => tx.get(ref)) }, db, "hotel-a", mail, { auth, appBaseUrl: "https://hotel.example.test" });
  assert.match(delivered.text, /Self-approved by: buyer/);
});
test("self-approval respects an independent Finance control before transferring pending to committed", async () => {
  const db = allowSelf(fixture({ approvalSteps: settings().approvalSteps.map((step) => step.id === "finance" ? { ...step, independentRequired: true } : step), approvers: [authority("finance", ["finance"])] }));
  const created = await create(db), route = (await get(db, created)).selfApprovalRoute;
  assert.deepEqual(route.steps.map((step) => step.id), ["finance"]);
  const pending = await command(db, created, "selfapprove", { reason: "Delegated GM authority" });
  assert.equal(pending.request.currentApproverUid, "finance"); assert.equal(pending.request.status, "pending");
  assert.equal(budget(db).pendingMinor, 15000); assert.equal(budget(db).committedMinor, 0);
  await assert.rejects(command(db, pending, "approve", {}, "buyer"), { code: "permission-denied" });
  const approved = await command(db, pending, "approve", {}, "finance");
  assert.equal(approved.request.status, "approved"); assert.equal(budget(db).pendingMinor, 0); assert.equal(budget(db).committedMinor, 15000);
  assert.equal(approved.request.selfApproval.reason, "Delegated GM authority");
});
test("self-approval cannot bypass explicit zero budgets or independent additional budget authority", async () => {
  const blocked = allowSelf(fixture()), created = await create(blocked); budget(blocked).budgetMinor = 0;
  await assert.rejects(command(blocked, created, "selfapprove", { reason: "GM" }), { code: "failed-precondition" });
  assert.equal(budget(blocked).committedMinor, 0);
  const db = allowSelf(fixture({ overBudgetMode: "approval" })), second = await create(db); budget(db).budgetMinor = 0;
  const pending = await command(db, second, "selfapprove", { reason: "Urgent repair; independent budget review required" });
  assert.deepEqual(pending.request.approvalSteps.map((step) => step.id), ["over-budget"]); assert.equal(pending.request.currentApproverUid, "director");
  assert.equal(budget(db).pendingMinor, 15000); assert.equal(budget(db).committedMinor, 0);
  const final = await command(db, pending, "approve", {}, "director");
  assert.equal(final.request.status, "approved"); assert.equal(budget(db).pendingMinor, 0); assert.equal(budget(db).committedMinor, 15000);
});
test("self-approval fails closed without its explicit permission, sufficient limit, owner or reason", async () => {
  for (const variant of ["wildcard", "normal-approve", "limit", "no-limit", "foreign-owner", "reason"]) {
    const db = allowSelf(fixture()), created = await create(db);
    if (variant === "wildcard") db.records.get(`${base}/members/buyer`).permissions = ["purchaserequests.*"];
    if (variant === "normal-approve") db.records.get(`${base}/members/buyer`).permissions = permissions;
    if (variant === "limit") db.records.get(`${base}/settings/purchaseRequests`).approvers.at(-1).selfApprovalLimitMinor = 14999;
    if (variant === "no-limit") delete db.records.get(`${base}/settings/purchaseRequests`).approvers.at(-1).selfApprovalLimitMinor;
    if (variant === "foreign-owner") db.records.get(`${base}/members/manager`).permissions = [...permissions, "purchaserequests.selfapprove"];
    const before = structuredClone([...db.records]);
    await assert.rejects(command(db, created, "selfapprove", { reason: variant === "reason" ? "" : "GM authority" }, variant === "foreign-owner" ? "manager" : "buyer"), { code: variant === "reason" ? "invalid-argument" : "permission-denied" });
    assert.deepEqual(structuredClone([...db.records]), before, variant);
  }
});
test("a returned self-approved version credits its old reservation once and retains original evidence", async () => {
  const db = allowSelf(fixture({ approvalSteps: settings().approvalSteps.map((step) => step.id === "finance" ? { ...step, independentRequired: true } : step), approvers: [authority("finance", ["finance"])] }));
  const pending = await command(db, await create(db), "selfapprove", { reason: "Original GM authority" });
  const returned = await command(db, pending, "return", { reason: "Adjust estimate" }, "finance");
  assert.equal(returned.request.selfApproval, null); assert.equal(budget(db).pendingMinor, 15000);
  const saved = await command(db, returned, "save", { draft: draft(90) });
  const approved = await command(db, saved, "selfapprove", { reason: "Corrected GM estimate" });
  assert.equal(approved.request.status, "approved"); assert.equal(budget(db).pendingMinor, 0); assert.equal(budget(db).committedMinor, 9000);
  const history = (await get(db, approved)).history;
  assert.equal(history.find((row) => row.revision === pending.revision).snapshot.selfApproval.reason, "Original GM authority");
});
test("self-approval cannot supply its own independent or over-budget control", async () => {
  const db = allowSelf(fixture({ overBudgetMode: "approval", approvers: [] }));
  db.records.get(`${base}/settings/purchaseRequests`).approvers[0].canApproveOverBudget = true;
  budget(db).budgetMinor = 0;
  const created = await create(db), route = (await get(db, created)).selfApprovalRoute;
  assert.ok(route.error); assert.match(route.error.message, /Additional budget approval/);
  await assert.rejects(command(db, created, "selfapprove", { reason: "GM" }), { code: "permission-denied" });
});

test("a sole eligible requester escalates below threshold to an independent next-step approver without self approval", async () => {
  const db = fixture(requesterOnlySettings()), created = await create(db, draft(50)), detail = await get(db, created), route = detail.submissionApprovalRoute;
  assert.deepEqual(route.steps, [{ id: "finance", name: "Finance approval" }]);
  assert.deepEqual(route.approvers, [{ uid: "finance", name: "finance" }]);
  assert.deepEqual(route.escalation, { reason: "requester-only-first-step", fromStepId: "manager", fromStepName: "Manager approval", toStepId: "finance", toStepName: "Finance approval", settingsRevision: 1 });
  assert.match(route.fingerprint, /^[a-f0-9]{64}$/); assert.equal(route.error, null);
  assert.equal((await get(db, created, "finance")).submissionApprovalRoute, null);
  const pending = await submit(db, created, { approverUid: "finance", expectedApprovalRouteFingerprint: route.fingerprint });
  assert.deepEqual(pending.request.approvalEscalation, route.escalation); assert.deepEqual(pending.request.approvalSteps, route.steps);
  assert.equal(pending.request.status, "pending"); assert.equal(budget(db).pendingMinor, 5000); assert.equal(budget(db).committedMinor, 0);
  assert.equal((await get(db, pending)).submissionApprovalRoute, null);
  const mails = [...db.records.values()].filter((value) => value.type === "purchase-request");
  assert.equal(mails.length, 1); assert.equal(mails[0].recipientUid, "finance"); assert.equal(mails[0].event, "submit");
  await assert.rejects(command(db, pending, "approve", {}, "buyer"), { code: "permission-denied" });
  const approved = await command(db, pending, "approve", {}, "finance");
  assert.equal(approved.request.status, "approved"); assert.equal(budget(db).pendingMinor, 0); assert.equal(budget(db).committedMinor, 5000);
  assert.deepEqual(approved.request.approvals.map((approval) => approval.approverUid), ["finance"]);
});
test("a promoted step already required by amount appears once and retains a separate over-budget decision", async () => {
  const db = fixture(requesterOnlySettings({ overBudgetMode: "approval" })), created = await create(db, draft(600)), pending = await submit(db, created, { approverUid: "finance" });
  assert.deepEqual(pending.request.approvalSteps.map((step) => step.id), ["finance", "over-budget"]);
  assert.equal(pending.request.approvalEscalation.toStepId, "finance");
  await assert.rejects(command(db, pending, "approve", { nextApproverUid: "finance" }, "finance"), { code: "permission-denied" });
  const extra = await command(db, pending, "approve", { nextApproverUid: "director" }, "finance");
  assert.equal(extra.request.status, "pending"); assert.equal(budget(db).committedMinor, 0); assert.equal(budget(db).pendingMinor, 60000);
  const approved = await command(db, extra, "approve", {}, "director");
  assert.equal(approved.request.status, "approved"); assert.deepEqual(approved.request.approvals.map((approval) => approval.stepId), ["finance", "over-budget"]);
});
test("another current eligible first-step approver preserves the ordinary route and cannot opt into escalation", async () => {
  const db = fixture(requesterOnlySettings({ approvers: [authority("buyer", ["manager"]), authority("manager", ["manager"]), authority("finance", ["finance"])] })), created = await create(db, draft(50));
  const route = (await get(db, created)).submissionApprovalRoute;
  assert.deepEqual(route.steps.map((step) => step.id), ["manager"]); assert.deepEqual(route.approvers.map((member) => member.uid), ["manager"]); assert.equal(route.escalation, null);
  const before = structuredClone([...db.records]);
  await assert.rejects(submit(db, created, { approverUid: "finance" }), { code: "permission-denied" });
  await assert.rejects(submit(db, created, { approverUid: "buyer" }), { code: "permission-denied" });
  await assert.rejects(command(db, created, "submit", { approverUid: "finance", skipFirstStep: true }), { code: "invalid-argument" });
  assert.deepEqual(structuredClone([...db.records]), before);
  const ordinary = await submit(db, created); assert.equal(ordinary.request.approvalEscalation, null);
});
test("no eligible first-step authority and an ineligible requester never enable escalation", async () => {
  for (const change of ["missing-authority", "insufficient-limit", "no-approve-permission"]) {
    const db = fixture(requesterOnlySettings()), created = await create(db, draft(50)), config = db.records.get(`${base}/settings/purchaseRequests`);
    if (change === "missing-authority") config.approvers = config.approvers.filter((row) => row.uid !== "buyer");
    if (change === "insufficient-limit") config.approvers.find((row) => row.uid === "buyer").limitMinor = 4999;
    if (change === "no-approve-permission") db.records.get(`${base}/members/buyer`).permissions = permissions.filter((permission) => permission !== "purchaserequests.approve");
    const route = (await get(db, created)).submissionApprovalRoute, before = structuredClone([...db.records]);
    assert.equal(route.escalation, null); assert.ok(route.error); assert.equal(route.fingerprint, null);
    await assert.rejects(submit(db, created, { approverUid: "finance" }), { code: "permission-denied" });
    assert.deepEqual(structuredClone([...db.records]), before);
  }
});
test("escalation cannot skip an unstaffed immediate successor or use insufficient or foreign authority", async () => {
  for (const change of ["no-next-step", "missing-target", "insufficient-limit", "missing-membership", "revoked-read", "foreign-hotel"]) {
    const db = fixture(requesterOnlySettings()), created = await create(db, draft(50)), config = db.records.get(`${base}/settings/purchaseRequests`);
    if (change === "no-next-step") { config.approvalSteps = config.approvalSteps.slice(0, 1); config.approvers = config.approvers.filter((row) => row.uid === "buyer"); }
    if (change === "missing-target") config.approvers = config.approvers.filter((row) => row.uid !== "finance");
    if (change === "insufficient-limit") config.approvers.find((row) => row.uid === "finance").limitMinor = 4999;
    if (change === "missing-membership") db.records.delete(`${base}/members/finance`);
    if (change === "revoked-read") db.records.get(`${base}/members/finance`).permissions = ["purchaserequests.approve"];
    if (change === "foreign-hotel") { db.records.delete(`${base}/members/finance`); db.records.set("hotels/hotel-b/members/finance", { permissions }); }
    const route = (await get(db, created)).submissionApprovalRoute, before = structuredClone([...db.records]);
    assert.ok(route.error, change); assert.equal(route.fingerprint, null);
    await assert.rejects(submit(db, created, { approverUid: "director" }), { code: "failed-precondition" });
    assert.deepEqual(structuredClone([...db.records]), before);
  }
});
test("candidate account state is current and unavailable Auth never proves a sole eligible requester", async () => {
  for (const condition of ["disabled", "unverified", "not-found", "unavailable"]) {
    const db = fixture(requesterOnlySettings()), created = await create(db, draft(50));
    const scoped = services(db, { auth: { getUser: async (uid) => {
      const user = await auth.getUser(uid); if (uid !== "finance") return user;
      if (condition === "disabled") return { ...user, disabled: true };
      if (condition === "unverified") return { ...user, emailVerified: false };
      throw Object.assign(new Error("lookup failed"), { code: condition === "not-found" ? "auth/user-not-found" : "auth/internal-error" });
    } } });
    const detail = await api.getHotelPurchaseRequestHandler(request({ purchaseRequestId: created.purchaseRequestId }), scoped), before = structuredClone([...db.records]);
    assert.ok(detail.submissionApprovalRoute.error); assert.equal(detail.submissionApprovalRoute.error.code, condition === "unavailable" ? "unavailable" : "failed-precondition");
    await assert.rejects(api.mutateHotelPurchaseRequestHandler(request({ action: "submit", requestId: "blocked", purchaseRequestId: created.purchaseRequestId, expectedRevision: 1, approverUid: "finance" }), scoped), { code: condition === "unavailable" ? "unavailable" : "failed-precondition" });
    assert.deepEqual(structuredClone([...db.records]), before);
  }
  const db = fixture(requesterOnlySettings({ approvers: [authority("buyer", ["manager"]), authority("manager", ["manager"]), authority("finance", ["finance"])] })), created = await create(db, draft(50));
  const scoped = services(db, { auth: { getUser: async (uid) => { if (uid === "manager") throw Object.assign(new Error("temporary outage"), { code: "auth/internal-error" }); return auth.getUser(uid); } } });
  const detail = await api.getHotelPurchaseRequestHandler(request({ purchaseRequestId: created.purchaseRequestId }), scoped);
  assert.equal(detail.submissionApprovalRoute.error.code, "unavailable"); assert.equal(detail.submissionApprovalRoute.escalation, null);
  await assert.rejects(api.mutateHotelPurchaseRequestHandler(request({ action: "submit", requestId: "unknown-alternate", purchaseRequestId: created.purchaseRequestId, expectedRevision: 1, approverUid: "finance" }), scoped), { code: "unavailable" });
});
test("route previews reject stale settings and candidate changes before reserving budget", async () => {
  for (const change of ["settings", "new-alternate"]) {
    const db = fixture(requesterOnlySettings()), created = await create(db, draft(50)), route = (await get(db, created)).submissionApprovalRoute, config = db.records.get(`${base}/settings/purchaseRequests`);
    if (change === "settings") { config.revision++; config.approvalSteps[1].name = "Finance review"; }
    if (change === "new-alternate") { config.approvers.push(authority("manager", ["manager"])); config.approvers.find((row) => row.uid === "finance").stepIds.push("manager"); }
    const before = structuredClone([...db.records]);
    await assert.rejects(submit(db, created, { approverUid: "finance", expectedApprovalRouteFingerprint: route.fingerprint }), { code: "aborted" });
    assert.deepEqual(structuredClone([...db.records]), before);
    const fresh = (await get(db, created)).submissionApprovalRoute;
    assert.notEqual(fresh.fingerprint, route.fingerprint);
    const pending = await submit(db, created, { approverUid: "finance", expectedApprovalRouteFingerprint: fresh.fingerprint });
    assert.equal(pending.request.currentApproverUid, "finance");
  }
});
test("a returned preview accounts for its held reservation once and recomputes routing evidence on resubmission", async () => {
  const db = fixture(requesterOnlySettings()), created = await create(db, draft(400)), route = (await get(db, created)).submissionApprovalRoute, pending = await submit(db, created, { approverUid: "finance", expectedApprovalRouteFingerprint: route.fingerprint });
  assert.deepEqual(await submit(db, created, { approverUid: "finance", expectedApprovalRouteFingerprint: route.fingerprint }), pending);
  const returned = await command(db, pending, "return", { reason: "Please add a quotation." }, "finance");
  assert.equal(returned.request.approvalEscalation, null); assert.equal(budget(db).pendingMinor, 40000);
  const detail = await get(db, returned); assert.equal(detail.submissionApprovalRoute.error, null);
  assert.equal(detail.submissionApprovalRoute.escalation.reason, "requester-only-first-step");
  assert.deepEqual(detail.history.find((event) => event.event === "submit").snapshot.approvalEscalation, pending.request.approvalEscalation);
  const saved = await command(db, returned, "save", { draft: draft(450) });
  assert.equal((await get(db, saved)).submissionApprovalRoute.error, null);
  const config = db.records.get(`${base}/settings/purchaseRequests`); config.approvers.push(authority("manager", ["manager"])); config.revision++;
  const fresh = (await get(db, saved)).submissionApprovalRoute; assert.equal(fresh.escalation, null);
  const resubmitted = await submit(db, saved, { expectedApprovalRouteFingerprint: fresh.fingerprint });
  assert.equal(resubmitted.request.approvalEscalation, null); assert.deepEqual(resubmitted.request.approvalSteps.map((step) => step.id), ["manager", "finance"]); assert.equal(budget(db).pendingMinor, 45000);
});
test("pending routes retain immutable escalation evidence after configuration changes and decisions recheck current permission", async () => {
  const db = fixture(requesterOnlySettings()), pending = await submit(db, await create(db, draft(50)), { approverUid: "finance" }), evidence = structuredClone(pending.request.approvalEscalation);
  db.records.get(`${base}/settings/purchaseRequests`).approvers.push(authority("manager", ["manager"]));
  assert.deepEqual((await get(db, pending)).request.approvalSteps.map((step) => step.id), ["finance"]); assert.deepEqual(current(db, pending).approvalEscalation, evidence);
  db.records.get(`${base}/members/finance`).permissions = ["purchaserequests.read"];
  const before = structuredClone([...db.records]); await assert.rejects(command(db, pending, "approve", {}, "finance"), { code: "permission-denied" }); assert.deepEqual(structuredClone([...db.records]), before);
  db.records.get(`${base}/members/finance`).permissions = permissions;
  const approved = await command(db, pending, "approve", {}, "finance"), revised = await command(db, approved, "revise", { reason: "A new quote is required." });
  assert.equal(revised.request.approvalEscalation, null);
  assert.deepEqual((await get(db, revised)).history.find((event) => event.event === "approved").snapshot.approvalEscalation, evidence);
});
test("incomplete drafts and missing or inconsistent route settings remain readable with a non-actionable preview", async () => {
  for (const change of ["incomplete", "missing-budget", "invalid-settings"]) {
    const db = fixture(requesterOnlySettings()), created = await create(db, change === "incomplete" ? draft(50, { motivation: "" }) : draft(50));
    if (change === "missing-budget") db.records.delete(`${base}/purchaseBudgets/2026-10__maintenance`);
    if (change === "invalid-settings") db.records.get(`${base}/settings/purchaseRequests`).approvalSteps = null;
    const detail = await get(db, created); assert.equal(detail.request.id, created.purchaseRequestId); assert.equal(detail.history.length, 1);
    assert.ok(detail.submissionApprovalRoute.error); assert.equal(detail.submissionApprovalRoute.fingerprint, null); assert.deepEqual(detail.submissionApprovalRoute.approvers, []);
  }
});
test("legacy command receipts preserve their pre-route payload fingerprints and result snapshots", async () => {
  const db = fixture(), created = await create(db, draft(), "legacy-create"), path = `${base}/purchaseRequestOperations/p-${digest("buyer", "legacy-create").slice(0, 48)}`, receipt = db.records.get(path);
  const payload = { id: created.purchaseRequestId, action: "create", expected: 0, draft: require("./purchaseRequestPolicy").normalizeDraft(draft()), approverUid: null, nextApproverUid: null, reason: "" };
  assert.equal(receipt.fingerprint, api.purchaseRequestInternals.canonicalDigest({ kind: "request", payload }));
  const legacyResult = structuredClone(receipt.result); delete legacyResult.request.approvalEscalation;
  receipt.result = legacyResult; receipt.resultFingerprint = api.purchaseRequestInternals.canonicalDigest(legacyResult);
  assert.deepEqual(await create(db, draft(), "legacy-create"), legacyResult);
});

test("draft creation does not reserve budget and saves one immutable audited revision", async () => {
  const db = fixture(), value = await create(db);
  assert.equal(value.request.status, "draft"); assert.equal(value.request.totalMinor, 15000);
  assert.equal(budget(db).pendingMinor, 0); assert.equal(budget(db).committedMinor, 0);
  const detail = await get(db, value); assert.equal(detail.history.length, 1); assert.equal(detail.history[0].event, "create");
  assert.deepEqual(detail.history[0].snapshot.lines, value.request.lines);
  assert.equal(db.records.get(`${base}/settings/purchaseRequests`).currencyLocked, true);
});
test("the requested budget example retains 50 available through pending to final commitment", async () => {
  const db = fixture(); budget(db).committedMinor = 30000;
  const first = await create(db), pending = await submit(db, first);
  assert.equal(pending.budget.remainingMinor, 5000); assert.equal(budget(db).pendingMinor, 15000);
  const intermediate = await command(db, pending, "approve", { nextApproverUid: "finance" }, "manager");
  assert.equal(intermediate.request.status, "pending"); assert.equal(intermediate.request.currentApproverUid, "finance");
  const approved = await command(db, intermediate, "approve", {}, "finance");
  assert.equal(approved.request.status, "approved"); assert.equal(approved.budget.remainingMinor, 5000);
  assert.equal(budget(db).pendingMinor, 0); assert.equal(budget(db).committedMinor, 45000);
  assert.equal(approved.request.approvals.length, 2);
});
test("returning holds the original reservation while edits and resubmission move it exactly once", async () => {
  const db = fixture(), pending = await submit(db, await create(db));
  const returned = await command(db, pending, "return", { reason: "Use the following month's capital budget." }, "manager");
  assert.equal(budget(db).pendingMinor, 15000);
  const saved = await command(db, returned, "save", { draft: draft(180, { budgetCategoryId: "china", budgetMonth: "2026-11" }) });
  assert.equal(saved.request.totalMinor, 18000); assert.equal(saved.request.reservation.amountMinor, 15000);
  assert.equal(budget(db).pendingMinor, 15000); assert.equal(budget(db, "2026-11__china").pendingMinor, 0);
  const resubmitted = await submit(db, saved);
  assert.equal(resubmitted.request.budgetMonth, "2026-11"); assert.equal(resubmitted.budget.pendingMinor, 18000);
  assert.equal(budget(db).pendingMinor, 0); assert.equal(resubmitted.request.approvals.length, 0);
});
test("revising an approved request moves its original commitment back to pending and requires every step again", async () => {
  const db = fixture(), first = await submit(db, await create(db));
  const intermediate = await command(db, first, "approve", { nextApproverUid: "finance" }, "manager"), approved = await command(db, intermediate, "approve", {}, "finance");
  const revised = await command(db, approved, "revise", { reason: "The quote changed.", draft: draft(200) });
  assert.equal(revised.request.status, "returned"); assert.equal(budget(db).committedMinor, 0); assert.equal(budget(db).pendingMinor, 15000);
  assert.equal(revised.request.totalMinor, 20000); assert.equal(revised.request.approvals.length, 0);
  const submitted = await submit(db, revised); assert.equal(budget(db).pendingMinor, 20000);
  assert.equal(submitted.request.currentStepIndex, 0);
  const detail = await get(db, submitted); assert.equal(detail.history.find((event) => event.event === "approved").snapshot.totalMinor, 15000);
});
for (const action of ["reject", "withdraw", "cancel"]) test(`${action} releases a pending reservation and cannot release it twice`, async () => {
  const db = fixture(), value = await submit(db, await create(db));
  const actor = action === "reject" ? "manager" : "buyer", extra = action === "reject" ? { reason: "Not required." } : {};
  const result = await command(db, value, action, extra, actor);
  assert.equal(budget(db).pendingMinor, 0); assert.equal(result.request.reservation.state, "none");
  assert.deepEqual(await command(db, value, action, extra, actor), result);
  await assert.rejects(command(db, result, action, extra, actor), (error) => ["failed-precondition", "permission-denied"].includes(error.code));
});
test("canceling an approved request releases the commitment without changing historic approved evidence", async () => {
  const db = fixture(), pending = await submit(db, await create(db, draft(50))), approved = await command(db, pending, "approve", {}, "manager");
  const canceled = await command(db, approved, "cancel");
  assert.equal(budget(db).committedMinor, 0); assert.equal(canceled.request.status, "canceled");
  const detail = await get(db, canceled); assert.equal(detail.history.find((event) => event.event === "approved").snapshot.totalMinor, 5000);
});
test("self approval, the wrong first step, duplicate approvers and bypassed required steps fail atomically", async () => {
  const db = fixture({ approvers: [...settings().approvers, authority("buyer", ["manager"])] }), value = await create(db);
  await assert.rejects(submit(db, value, { approverUid: "buyer" }), { code: "permission-denied" });
  await assert.rejects(submit(db, value, { approverUid: "finance" }), { code: "permission-denied" });
  const pending = await submit(db, value);
  await assert.rejects(command(db, pending, "approve", {}, "finance"), { code: "permission-denied" });
  await assert.rejects(command(db, pending, "approve", {}, "manager"), { code: "failed-precondition" });
  await assert.rejects(command(db, pending, "approve", { nextApproverUid: "manager" }, "manager"), { code: "permission-denied" });
  assert.equal(current(db, pending).revision, 2); assert.equal(budget(db).pendingMinor, 15000);
});
test("amount limits, current membership, disabled users and authority revocation are rechecked on decisions", async () => {
  const db = fixture(), value = await submit(db, await create(db));
  const config = db.records.get(`${base}/settings/purchaseRequests`); config.approvers[0].limitMinor = 100;
  await assert.rejects(command(db, value, "approve", { nextApproverUid: "finance" }, "manager"), { code: "permission-denied" });
  config.approvers[0].limitMinor = 1000000;
  db.records.set(`${base}/members/manager`, { permissions: ["purchaserequests.read"] });
  await assert.rejects(command(db, value, "approve", { nextApproverUid: "finance" }, "manager"), { code: "permission-denied" });
  db.records.set(`${base}/members/manager`, { permissions });
  await assert.rejects(api.mutateHotelPurchaseRequestHandler(request({ action: "approve", requestId: "disabled", purchaseRequestId: value.purchaseRequestId, expectedRevision: 2, nextApproverUid: "finance" }, "manager"), services(db, { auth: { getUser: async (uid) => ({ uid, disabled: true, emailVerified: true }) } })), { code: "permission-denied" });
  assert.equal(budget(db).committedMinor, 0);
});
test("missing budgets differ from explicit zero, and over-budget submission requires a separate final authority", async () => {
  const db = fixture({ overBudgetMode: "approval" }); db.records.delete(`${base}/purchaseBudgets/2026-10__maintenance`);
  const value = await create(db, draft(50)); await assert.rejects(submit(db, value), { code: "failed-precondition" });
  db.records.set(`${base}/purchaseBudgets/2026-10__maintenance`, { policyVersion: 1, month: "2026-10", categoryId: "maintenance", year: 2026, revision: 1, budgetMinor: 0, openingUsedMinor: 0, pendingMinor: 0, committedMinor: 0 });
  const pending = await submit(db, value); assert.deepEqual(pending.request.approvalSteps.map((step) => step.id), ["manager", "over-budget"]);
  const extra = await command(db, pending, "approve", { nextApproverUid: "director" }, "manager");
  assert.equal(extra.request.status, "pending"); const approved = await command(db, extra, "approve", {}, "director");
  assert.equal(approved.request.status, "approved"); assert.equal(approved.budget.remainingMinor, -5000);
});
test("block mode concurrent submissions compete for one consistent remaining budget", async () => {
  const db = fixture(), first = await create(db, draft(300), "one"), second = await create(db, draft(300), "two");
  const results = await Promise.allSettled([submit(db, first), submit(db, second)]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(budget(db).pendingMinor, 30000); assert.equal(budget(db).committedMinor, 0);
});
test("stale revisions and altered idempotency payloads leave the ledger and history untouched", async () => {
  const db = fixture(), created = await create(db), value = await submit(db, created);
  const before = structuredClone([...db.records]);
  await assert.rejects(command(db, created, "save", { draft: draft(200) }), { code: "aborted" });
  await assert.rejects(submit(db, created, { approverUid: "director" }), { code: "already-exists" });
  assert.deepEqual(structuredClone([...db.records]), before); assert.deepEqual(await submit(db, created), value);
});
test("every replay still requires current hotel rights, active module and verified account", async () => {
  const db = fixture(), created = await create(db); await submit(db, created);
  db.records.set(`${base}/members/buyer`, { permissions: ["purchaserequests.read"] });
  await assert.rejects(submit(db, created), { code: "permission-denied" });
  await assert.rejects(api.getHotelPurchaseRequestHandler(request({ hotelUid: "hotel-b", purchaseRequestId: created.purchaseRequestId }), services(db)), { code: "permission-denied" });
  db.records.set(`${base}/members/buyer`, { permissions }); db.records.get("hotelSubscriptions/hotel-a").modules = [];
  await assert.rejects(get(db, created), { code: "permission-denied" });
});
test("normal requesters receive scoped supplier and budget choices without budget-manager or catalog read access", async () => {
  const db = fixture(); db.records.set(`${base}/members/buyer`, { permissions: ["purchaserequests.read", "purchaserequests.create"] });
  const result = await api.getHotelPurchaseRequestContextHandler(request({ budgetMonth: "2026-10", budgetCategoryId: "maintenance" }), services(db));
  assert.equal(result.suppliers[0].name, "Vendor"); assert.equal(result.budget.remainingMinor, 50000); assert.equal(result.settings.currency, "EUR");
  await assert.rejects(api.getHotelPurchaseBudgetsHandler(request({ year: 2026 }), services(db)), { code: "permission-denied" });
});
test("annual budgets preserve usage, accept deliberate zero, and reject stale or overcommitted reductions", async () => {
  const db = fixture(), pending = await submit(db, await create(db));
  const raw = budget(db), save = (rows, key = "budget-save") => api.saveHotelPurchaseBudgetsHandler(request({ requestId: key, budgets: rows }), services(db));
  const row = { month: "2026-10", categoryId: "maintenance", budgetMinor: 60000, openingUsedMinor: 10000, expectedRevision: raw.revision };
  const result = await save([row]); assert.equal(result.budgets[0].pendingMinor, 15000); assert.equal(result.budgets[0].remainingMinor, 35000);
  assert.deepEqual(await save([row]), result);
  await assert.rejects(save([{ ...row, budgetMinor: 10000, expectedRevision: result.budgets[0].revision }], "too-low"), { code: "failed-precondition" });
  await assert.rejects(save([{ ...row, budgetMinor: 70000 }], "stale"), { code: "aborted" });
  const zero = await save([{ month: "2026-12", categoryId: "china", budgetMinor: 0, openingUsedMinor: 0, expectedRevision: 0 }], "zero");
  assert.equal(zero.budgets[0].exists, true); const year = await api.getHotelPurchaseBudgetsHandler(request({ year: 2026 }), services(db));
  assert.equal(year.budgets.length, 3); assert.equal(year.vatBasis, "net"); assert.equal(current(db, pending).budgetMonth, "2026-10");
});
test("settings keep used identities and currency stable while requiring currently authorized configured approvers", async () => {
  const db = fixture(); await create(db);
  const save = (next, key = "setting-save") => api.saveHotelPurchaseRequestSettingsHandler(request({ requestId: key, expectedRevision: 1, settings: next }), services(db));
  await assert.rejects(save(settings({ currency: "USD" })), { code: "failed-precondition" });
  await assert.rejects(save(settings({ costCentres: [] }), "removed"), { code: "failed-precondition" });
  await assert.rejects(save(settings({ approvers: [authority("foreign", ["manager"])] }), "foreign"), { code: "permission-denied" });
  const updated = await save(settings({ costCentres: [{ id: "kitchen", name: "Food and beverage" }] }), "rename");
  assert.equal(updated.revision, 2); assert.equal(updated.settings.costCentres[0].id, "kitchen");
});
test("supplier lines freeze quoted price, purchase package and catalog identity without altering orders or stock", async () => {
  const db = fixture(); db.records.set(`${base}/supplierproducts/offer`, { supplierId: "vendor", supplierSku: "SKU1", supplierProductName: "Coffee", active: true, currency: "EUR", priceBasis: "net", pricePerPurchaseUnit: 10,
    purchaseUnit: "Case of six", baseUnit: "kg", baseUnitsPerPurchaseUnit: 6, purchaseOptions: [], catalogProductId: "coffee", revision: 1, productPolicyVersion: 1 });
  db.records.set(`${base}/catalogproducts/coffee`, { name: "Coffee beans", internalSku: "CAT-000001", baseUnit: "kg" });
  db.records.set(`${base}/orders/old`, { products: [{ price: 1 }] }); db.records.set(`${base}/stockCounts/old`, { quantity: 5 });
  const input = draft(0, { lines: [{ id: "coffee", kind: "supplier", supplierProductId: "offer", purchaseOptionId: "default", quantity: 2, unitPrice: 12.5 }] });
  const created = await create(db, input); db.records.get(`${base}/supplierproducts/offer`).pricePerPurchaseUnit = 99; db.records.get(`${base}/catalogproducts/coffee`).name = "Renamed";
  const pending = await submit(db, created); assert.equal(pending.request.lines[0].unitPrice, 12.5); assert.equal(pending.request.lines[0].catalogProductName, "Coffee beans");
  assert.equal(pending.request.lines[0].lineTotalMinor, 2500); assert.equal(pending.request.lines[0].unit, "Case of six");
  assert.deepEqual(db.records.get(`${base}/orders/old`), { products: [{ price: 1 }] }); assert.deepEqual(db.records.get(`${base}/stockCounts/old`), { quantity: 5 });
});
test("foreign supplier products and fabricated attachment metadata never become request evidence", async () => {
  const db = fixture(); db.records.set(`${base}/supplierproducts/foreign-offer`, { supplierId: "other", active: true });
  const before = structuredClone([...db.records]);
  await assert.rejects(create(db, draft(1, { lines: [{ id: "wrong", kind: "supplier", supplierProductId: "foreign-offer", quantity: 1, unitPrice: 1 }] })), { code: "failed-precondition" });
  await assert.rejects(create(db, draft(1, { attachmentIds: ["a".repeat(32)] })), { code: "failed-precondition" });
  assert.deepEqual(structuredClone([...db.records]), before);
});
const freeSupplierLine = (id, supplierId, unitPrice = 50) => ({ id, kind: "free", supplierId, description: `${id} service`, quantity: 1, unitPrice, unit: "service" });
const twoSupplierDraft = (patch = {}) => draft(0, { supplierId: "", lines: [freeSupplierLine("repair", "vendor", 50), freeSupplierLine("installation", "second", 75)], ...patch });
function twoSupplierFixture() {
  const db = fixture(); db.records.set(`${base}/suppliers/second`, { name: "Second supplier", active: true, priceDateBasis: "delivery-date", email: "private@example.com", internalNotes: "Private supplier notes" }); return db;
}
test("multiple line suppliers are authoritative snapshots with one request total and one budget reservation", async () => {
  const db = twoSupplierFixture(), input = twoSupplierDraft(); delete input.supplierId;
  input.lines.push(freeSupplierLine("support", "vendor", 25));
  const created = await create(db, input), snapshot = created.request;
  assert.equal(snapshot.supplierId, ""); assert.equal(snapshot.supplier, null);
  assert.deepEqual(snapshot.suppliers, [{ id: "vendor", name: "Vendor" }, { id: "second", name: "Second supplier" }]);
  assert.deepEqual(snapshot.lines.map((line) => ({ supplierId: line.supplierId, supplier: line.supplier })), [
    { supplierId: "vendor", supplier: { id: "vendor", name: "Vendor" } }, { supplierId: "second", supplier: { id: "second", name: "Second supplier" } }, { supplierId: "vendor", supplier: { id: "vendor", name: "Vendor" } },
  ]);
  assert.equal(snapshot.totalMinor, 15000); assert.equal(budget(db).pendingMinor, 0);
  const pending = await submit(db, created); assert.equal(pending.request.totalMinor, 15000); assert.equal(budget(db).pendingMinor, 15000);
  const second = await command(db, pending, "approve", { nextApproverUid: "finance" }, "manager"), approved = await command(db, second, "approve", {}, "finance");
  assert.equal(approved.request.status, "approved"); assert.equal(budget(db).pendingMinor, 0); assert.equal(budget(db).committedMinor, 15000);
  assert.deepEqual(approved.request.suppliers, snapshot.suppliers); assert.deepEqual(approved.request.lines, snapshot.lines);
});
test("common supplier summaries require every line to have the same nonblank supplier", async () => {
  const db = twoSupplierFixture(), mixed = await create(db, twoSupplierDraft());
  const common = await command(db, mixed, "save", { draft: twoSupplierDraft({ lines: [freeSupplierLine("repair", "second"), freeSupplierLine("support", "second")] }) });
  assert.equal(common.request.supplierId, "second"); assert.deepEqual(common.request.supplier, { id: "second", name: "Second supplier" }); assert.deepEqual(common.request.suppliers, [common.request.supplier]);
  const unfinished = await command(db, common, "save", { draft: twoSupplierDraft({ supplierId: "second", lines: [freeSupplierLine("repair", "second"), freeSupplierLine("support", "")] }) });
  assert.equal(unfinished.request.supplierId, ""); assert.equal(unfinished.request.supplier, null); assert.equal(unfinished.request.lines[1].supplierId, ""); assert.equal(unfinished.request.lines[1].supplier, null);
  assert.equal((await get(db, unfinished)).submissionApprovalRoute.error.code, "failed-precondition");
  const before = JSON.stringify([...db.records]); await assert.rejects(submit(db, unfinished), { code: "failed-precondition" }); assert.equal(JSON.stringify([...db.records]), before);
});
test("an explicit blank line supplier never inherits a legacy request header", async () => {
  const db = twoSupplierFixture(), created = await create(db, draft(0, { supplierId: "vendor", lines: [freeSupplierLine("repair", "")] }));
  assert.equal(created.request.lines[0].supplierId, ""); assert.equal(created.request.lines[0].supplier, null);
  await assert.rejects(submit(db, created), { code: "failed-precondition" });
  const legacy = await create(db, draft(10), "legacy-line"); assert.equal(legacy.request.lines[0].supplierId, "vendor"); assert.deepEqual(legacy.request.lines[0].supplier, { id: "vendor", name: "Vendor" });
  const extracted = api.purchaseRequestInternals.draftInputFromSnapshot(created.request); assert.equal(extracted.lines[0].supplierId, "");
});
test("line supplier selection rejects foreign, missing, inactive and archived suppliers atomically", async () => {
  for (const state of ["foreign", "missing", "inactive", "archived", "archivedAt"]) {
    const db = twoSupplierFixture();
    if (state === "foreign") { db.records.set("hotels/hotel-b/suppliers/second", db.records.get(`${base}/suppliers/second`)); db.records.delete(`${base}/suppliers/second`); }
    if (state === "missing") db.records.delete(`${base}/suppliers/second`);
    if (state === "inactive") db.records.get(`${base}/suppliers/second`).active = false;
    if (state === "archived") db.records.get(`${base}/suppliers/second`).archived = true;
    if (state === "archivedAt") db.records.get(`${base}/suppliers/second`).archivedAt = { seconds: 1 };
    const before = JSON.stringify([...db.records]); await assert.rejects(create(db, twoSupplierDraft()), { code: "failed-precondition" }); assert.equal(JSON.stringify([...db.records]), before);
  }
});
test("each supplier product must belong to its own line supplier even with an explicit quote or another valid header", async () => {
  const db = twoSupplierFixture(); db.records.set(`${base}/supplierproducts/offer`, { supplierId: "vendor", supplierProductName: "Coffee", active: true, purchaseUnit: "case", baseUnit: "kg", baseUnitsPerPurchaseUnit: 6 });
  const input = twoSupplierDraft({ supplierId: "vendor", lines: [{ id: "wrong", kind: "supplier", supplierId: "second", supplierProductId: "offer", quantity: 1, unitPrice: 10 }] }), before = JSON.stringify([...db.records]);
  await assert.rejects(create(db, input), { code: "failed-precondition" }); assert.equal(JSON.stringify([...db.records]), before);
  await assert.rejects(create(db, { ...input, lines: [{ ...input.lines[0], supplierId: "" }] }), { code: "invalid-argument" });
  db.records.set("hotels/hotel-b/supplierproducts/foreign-offer", { supplierId: "second", active: true });
  await assert.rejects(create(db, { ...input, lines: [{ ...input.lines[0], supplierProductId: "foreign-offer" }] }), { code: "failed-precondition" });
});
test("mixed supplier names, quoted prices and package identities stay frozen through submit and historical decisions", async () => {
  const db = twoSupplierFixture(); db.records.set(`${base}/supplierproducts/offer`, { supplierId: "second", supplierSku: "SECOND-1", supplierProductName: "Coffee", active: true, currency: "EUR", priceBasis: "net", pricePerPurchaseUnit: 10,
    purchaseUnit: "case", baseUnit: "kg", baseUnitsPerPurchaseUnit: 6, purchaseOptions: [{ id: "bag", purchaseUnit: "bag", baseUnitsPerPurchaseUnit: 1, pricePerPurchaseUnit: 2 }], catalogProductId: "coffee", revision: 1, productPolicyVersion: 1 });
  db.records.set(`${base}/catalogproducts/coffee`, { name: "Coffee beans", internalSku: "CAT-000001", baseUnit: "kg" });
  const input = twoSupplierDraft({ lines: [freeSupplierLine("repair", "vendor", 50), { id: "coffee", kind: "supplier", supplierId: "second", supplierProductId: "offer", purchaseOptionId: "bag", quantity: 2, unitPrice: 12.5 }] });
  const created = await create(db, input), frozen = structuredClone(created.request.lines);
  db.records.get(`${base}/suppliers/second`).name = "Renamed supplier"; db.records.get(`${base}/suppliers/second`).archived = true;
  Object.assign(db.records.get(`${base}/supplierproducts/offer`), { supplierId: "other", active: false, pricePerPurchaseUnit: 999, supplierProductName: "Replaced", purchaseOptions: [] });
  db.records.get(`${base}/catalogproducts/coffee`).name = "Renamed catalog";
  const pending = await submit(db, created), approved = await command(db, pending, "approve", {}, "manager");
  assert.deepEqual(approved.request.lines, frozen); assert.equal(approved.request.totalMinor, 7500); assert.equal(approved.request.lines[1].supplier.name, "Second supplier");
  const detail = await get(db, approved); assert.deepEqual(detail.history.find((event) => event.event === "create").snapshot.lines, frozen); assert.deepEqual(detail.history.find((event) => event.event === "approved").snapshot.lines, frozen);
});
test("saving and revising line suppliers changes only the new reviewed version and keeps a single reservation", async () => {
  const db = twoSupplierFixture(), created = await create(db, twoSupplierDraft()), pending = await submit(db, created), finance = await command(db, pending, "approve", { nextApproverUid: "finance" }, "manager"), approved = await command(db, finance, "approve", {}, "finance");
  const revised = await command(db, approved, "revise", { reason: "Different supplier and quote", draft: twoSupplierDraft({ lines: [freeSupplierLine("repair", "second", 200), freeSupplierLine("installation", "vendor", 25)] }) });
  assert.equal(revised.request.status, "returned"); assert.equal(revised.request.totalMinor, 22500); assert.equal(budget(db).pendingMinor, 12500); assert.equal(budget(db).committedMinor, 0);
  const next = await submit(db, revised); assert.equal(budget(db).pendingMinor, 22500); assert.equal(next.request.lines[0].supplierId, "second");
  const history = (await get(db, next)).history; assert.equal(history.find((event) => event.event === "approved").snapshot.lines[0].supplierId, "vendor"); assert.equal(history.find((event) => event.event === "approved").snapshot.totalMinor, 12500);
});
test("all list filters remain hotel scoped and awaiting approval selects the authenticated assignee", async () => {
  const db = fixture(), first = await submit(db, await create(db)), second = await create(db, draft(50, { budgetMonth: "2026-11", budgetCategoryId: "china" }), "second");
  const list = (input, uid = "buyer") => api.listHotelPurchaseRequestsHandler(request(input, uid), services(db));
  assert.equal((await list({ month: "2026-11" })).requests[0].id, second.purchaseRequestId);
  assert.equal((await list({ awaitingMyApproval: true }, "manager")).requests[0].id, first.purchaseRequestId);
  assert.equal((await list({ awaitingMyApproval: true })).requests.length, 0);
  assert.equal((await list({ costCentreId: "kitchen", status: "draft" })).requests.length, 1);
});
function priceFixture() {
  const db = fixture(), product = { supplierId: "vendor", supplierSku: "COFFEE", supplierProductName: "Coffee beans", active: true, productPolicyVersion: 1, catalogProductId: "coffee",
    currency: "EUR", priceBasis: "gross", vatRate: 0.06, pricingModel: "Per Purchase Unit", pricePerBaseUnit: null, pricePerPurchaseUnit: 999,
    baseUnit: "kg", purchaseUnit: "case", baseUnitsPerPurchaseUnit: 6, purchaseOptions: [{ id: "bag", purchaseUnit: "bag", baseUnitsPerPurchaseUnit: 1, pricePerPurchaseUnit: 1.06 }],
    priceValidFrom: "2026-01-01", priceValidUntil: "2026-10-31", currentPriceVersionId: "v1", latestApprovedPriceVersionId: "v2", revision: 3 };
  const catalog = { name: "Coffee beans", baseUnit: "kg", internalSku: "CAT-000001" };
  db.records.set(`${base}/supplierproducts/coffee`, product); db.records.set(`${base}/catalogproducts/coffee`, catalog);
  for (const [id, price, revision, from, until] of [["v1", 12.72, 1, "2026-01-01", "2026-10-31"], ["v2", 19.08, 2, "2026-11-01", null]]) {
    const approved = { ...product, pricePerPurchaseUnit: price, priceValidFrom: from, priceValidUntil: until }, terms = pricingTerms(approved, catalog);
    db.records.set(`${base}/supplierPriceVersions/coffee/entries/${id}`, { supplierPriceVersionPolicyVersion: 1, supplierProductId: "coffee", supplierId: "vendor", revision,
      productTerms: purchaseTerms(approved), terms, termsFingerprint: digest(terms), sourceIssuedOn: "2026-10-01", sourceReference: `List ${revision}` });
  }
  return db;
}
test("price estimates use each line supplier's date agreement and quotation currency independently", async () => {
  const db = priceFixture(); db.records.set(`${base}/suppliers/second`, { name: "Second supplier", active: true, priceDateBasis: "delivery-date" });
  db.records.set(`${base}/supplierproducts/tea`, { supplierId: "second", supplierSku: "TEA", supplierProductName: "Tea", active: true, productPolicyVersion: 1,
    currency: "USD", priceBasis: "net", pricingModel: "Per Purchase Unit", pricePerPurchaseUnit: 40, baseUnit: "kg", purchaseUnit: "box", baseUnitsPerPurchaseUnit: 2,
    purchaseOptions: [{ id: "bag", purchaseUnit: "tea bag pack", baseUnitsPerPurchaseUnit: 1, pricePerPurchaseUnit: 20 }], revision: 1 });
  const input = draft(0, { supplierId: "", lines: [{ id: "coffee", kind: "supplier", supplierId: "vendor", supplierProductId: "coffee", purchaseOptionId: "bag", quantity: 2 },
    { id: "tea", kind: "supplier", supplierId: "second", supplierProductId: "tea", purchaseOptionId: "bag", quantity: 1 }] });
  await assert.rejects(create(db, input), (error) => error.code === "failed-precondition" && /delivery date/.test(error.message));
  const quoted = { ...input, lines: [input.lines[0], { ...input.lines[1], unitPrice: 15 }] }, created = await create(db, quoted);
  assert.equal(created.request.lines[0].unitPrice, 1); assert.equal(created.request.lines[0].priceVersionId, "v1"); assert.equal(created.request.lines[0].priceSource, "supplier"); assert.equal(created.request.lines[0].unit, "bag");
  assert.equal(created.request.lines[1].unitPrice, 15); assert.equal(created.request.lines[1].priceSource, "quote"); assert.equal(created.request.lines[1].unit, "tea bag pack"); assert.equal(created.request.currency, "EUR"); assert.equal(created.request.totalMinor, 1700);
  db.records.get(`${base}/suppliers/second`).priceDateBasis = "order-date";
  await assert.rejects(create(db, input, "usd-without-quote"), (error) => error.code === "failed-precondition" && /another currency/.test(error.message));
  const explicit = await create(db, quoted, "usd-explicit-quote"); assert.equal(explicit.request.lines[1].unitPrice, 15);
});
test("legacy header-only snapshots and exact command receipts retain their original shapes until explicitly saved", async () => {
  const db = fixture(), input = draft(50), created = await create(db, input, "legacy-header"), snapshot = structuredClone(created.request);
  delete snapshot.suppliers; delete snapshot.approvalEscalation;
  for (const line of snapshot.lines) { delete line.supplierId; delete line.supplier; }
  const fingerprint = api.purchaseRequestInternals.canonicalDigest(snapshot), path = `${base}/purchaseRequests/${created.purchaseRequestId}`;
  db.records.set(path, { ...snapshot, snapshotFingerprint: fingerprint });
  const certificate = db.records.get(`${path}/history/000001`); certificate.snapshot = snapshot; certificate.snapshotFingerprint = fingerprint;
  const receipt = db.records.get(`${base}/purchaseRequestOperations/p-${digest("buyer", "legacy-header").slice(0, 48)}`), legacyResult = { ...created, request: snapshot };
  receipt.result = legacyResult; receipt.resultFingerprint = api.purchaseRequestInternals.canonicalDigest(legacyResult);
  const payload = { id: created.purchaseRequestId, action: "create", expected: 0, draft: require("./purchaseRequestPolicy").normalizeDraft(input), approverUid: null, nextApproverUid: null, reason: "" };
  assert.equal(receipt.fingerprint, api.purchaseRequestInternals.canonicalDigest({ kind: "request", payload })); assert.equal(Object.hasOwn(payload.draft.lines[0], "supplierId"), false);
  assert.deepEqual(await create(db, input, "legacy-header"), legacyResult);
  const read = await get(db, created); assert.equal(Object.hasOwn(read.request.lines[0], "supplierId"), false); assert.equal(Object.hasOwn(read.request, "suppliers"), false); assert.equal(read.submissionApprovalRoute.error, null);
  const pending = await submit(db, created); assert.equal(Object.hasOwn(pending.request.lines[0], "supplierId"), false); assert.equal(Object.hasOwn(pending.request.lines[0], "supplier"), false);
  const approved = await command(db, pending, "approve", {}, "manager"); assert.equal(Object.hasOwn(approved.request.lines[0], "supplierId"), false);
  const history = (await get(db, approved)).history; assert.deepEqual(history.find((event) => event.event === "create").snapshot, snapshot); assert.equal(Object.hasOwn(history.find((event) => event.event === "approved").snapshot.lines[0], "supplierId"), false);
  const draftInput = api.purchaseRequestInternals.draftInputFromSnapshot(approved.request); assert.equal(draftInput.supplierId, "vendor"); assert.equal(Object.hasOwn(draftInput.lines[0], "supplierId"), false);
  const revised = await command(db, approved, "revise", { reason: "Review the supplier", draft: draftInput });
  assert.equal(revised.request.lines[0].supplierId, "vendor"); assert.deepEqual(revised.request.lines[0].supplier, { id: "vendor", name: "Vendor" });
});
test("product picker and default estimates use applicable approved versions and exact net prices rather than raw projections", async () => {
  const db = priceFixture(), context = await api.getHotelPurchaseRequestContextHandler(request({ supplierId: "vendor", query: "coffee" }), services(db));
  assert.equal(context.supplierProducts[0].pricePerPurchaseUnit, 12); assert.equal(context.supplierProducts[0].purchaseOptions[0].pricePerPurchaseUnit, 1);
  assert.equal(context.supplierProducts[0].priceVersionId, "v1");
  const value = await create(db, draft(0, { lines: [{ id: "coffee", kind: "supplier", supplierProductId: "coffee", purchaseOptionId: "default", quantity: 2 }] }));
  assert.equal(value.request.lines[0].unitPrice, 12); assert.equal(value.request.lines[0].priceSource, "supplier"); assert.equal(value.request.lines[0].priceVersionId, "v1");
  assert.equal(value.request.totalMinor, 2400);
  const nextMonth = await api.getHotelPurchaseRequestContextHandler(request({ supplierId: "vendor" }), services(db, { now: () => Date.UTC(2026, 9, 31, 23, 30) }));
  assert.equal(nextMonth.supplierProducts[0].priceVersionId, "v2"); assert.equal(nextMonth.supplierProducts[0].pricePerPurchaseUnit, 18);
});
test("delivery-date suppliers and expired prices stay unavailable until the requester enters an explicit net quotation", async () => {
  const db = priceFixture(); db.records.get(`${base}/suppliers/vendor`).priceDateBasis = "delivery-date";
  const context = await api.getHotelPurchaseRequestContextHandler(request({ supplierId: "vendor" }), services(db));
  assert.equal(context.supplierProducts[0].pricePerPurchaseUnit, null); assert.equal(context.supplierProducts[0].requiresQuote, true);
  const input = draft(0, { lines: [{ id: "coffee", kind: "supplier", supplierProductId: "coffee", quantity: 1 }] });
  await assert.rejects(create(db, input), { code: "failed-precondition" });
  const quoted = await create(db, { ...input, lines: [{ ...input.lines[0], unitPrice: "13.000001" }] });
  assert.equal(quoted.request.lines[0].priceSource, "quote"); assert.equal(quoted.request.lines[0].unitPrice, 13.000001);
  const expired = priceFixture(); expired.records.delete(`${base}/supplierPriceVersions/coffee/entries/v2`); expired.records.get(`${base}/supplierproducts/coffee`).latestApprovedPriceVersionId = "v1";
  const unavailable = await api.getHotelPurchaseRequestContextHandler(request({ supplierId: "vendor" }), services(expired, { now: () => Date.UTC(2026, 10, 15) }));
  assert.equal(unavailable.supplierProducts[0].pricePerPurchaseUnit, null); assert.equal(unavailable.supplierProducts[0].priceValidity, "expired");
});
test("older immutable approvals remain available through bounded hotel-authorized history pages", async () => {
  const db = fixture(), pending = await submit(db, await create(db, draft(50))), approved = await command(db, pending, "approve", {}, "manager");
  let value = await command(db, approved, "revise", { reason: "Additional work needs another quote." });
  for (let index = 0; index < 100; index++) value = await command(db, value, "save", { draft: draft(60 + index) });
  const recent = await get(db, value);
  assert.equal(recent.history.length, 100); assert.equal(recent.history[0].revision, value.revision);
  assert.equal(recent.historyTruncated, true); assert.equal(recent.nextHistoryCursor, 5);
  const earlier = await api.getHotelPurchaseRequestHandler(request({ purchaseRequestId: value.purchaseRequestId, historyBeforeRevision: recent.nextHistoryCursor }), services(db));
  assert.deepEqual(earlier.history.map((event) => event.revision), [4, 3, 2, 1]);
  assert.equal(earlier.history.find((event) => event.event === "approved").snapshot.totalMinor, 5000);
  assert.equal(earlier.nextHistoryCursor, null); assert.equal(earlier.request.revision, value.revision);
  assert.equal(new Set([...recent.history, ...earlier.history].map((event) => event.revision)).size, 104);
  await assert.rejects(api.getHotelPurchaseRequestHandler(request({ hotelUid: "hotel-b", purchaseRequestId: value.purchaseRequestId, historyBeforeRevision: 5 }), services(db)), { code: "permission-denied" });
  for (const historyBeforeRevision of [0, -1, 1.5, "5", 10002]) await assert.rejects(api.getHotelPurchaseRequestHandler(request({ purchaseRequestId: value.purchaseRequestId, historyBeforeRevision }), services(db)), { code: "invalid-argument" });
});
test("history pages reject snapshots copied from another request even when their content fingerprint matches", async () => {
  const db = fixture(), value = await create(db), history = db.records.get(`${base}/purchaseRequests/${value.purchaseRequestId}/history/000001`);
  history.snapshot = { ...history.snapshot, hotelUid: "hotel-b" }; history.snapshotFingerprint = api.purchaseRequestInternals.canonicalDigest(history.snapshot);
  await assert.rejects(get(db, value), { code: "failed-precondition" });
});
test("missing or inconsistent latest history after a partial restore blocks financial actions without rebuilding evidence", async () => {
  const db = fixture(), pending = await submit(db, await create(db, draft(50)));
  const path = `${base}/purchaseRequests/${pending.purchaseRequestId}/history/000002`, certificate = db.records.get(path);
  db.records.delete(path); const withoutEvidence = JSON.stringify([...db.records]);
  await assert.rejects(command(db, pending, "approve", {}, "manager"), { code: "failed-precondition" });
  await assert.rejects(command(db, pending, "withdraw"), { code: "failed-precondition" });
  assert.equal(JSON.stringify([...db.records]), withoutEvidence);
  db.records.set(path, { ...certificate, snapshot: { ...certificate.snapshot, totalMinor: 999 } }); const corruptEvidence = JSON.stringify([...db.records]);
  await assert.rejects(command(db, pending, "approve", {}, "manager"), { code: "failed-precondition" });
  assert.equal(JSON.stringify([...db.records]), corruptEvidence);
  db.records.set(path, certificate); const approved = await command(db, pending, "approve", {}, "manager");
  assert.equal(approved.request.status, "approved"); assert.equal(budget(db).committedMinor, 5000);
});
test("an approval-only member without request read access cannot be assigned an actionable step", async () => {
  const db = fixture(), value = await create(db);
  db.records.set(`${base}/members/manager`, { permissions: ["purchaserequests.approve"] });
  await assert.rejects(submit(db, value), { code: "permission-denied" });
  const context = await api.getHotelPurchaseRequestContextHandler(request({}), services(db));
  assert.equal(context.approvers.find((user) => user.uid === "manager").eligible, false);
});
test("authorized invalid draft preflight reports proven absence so the user can correct the form", async () => {
  const db = fixture(), invalid = draft("0.1234567"), before = JSON.stringify([...db.records]);
  await assert.rejects(create(db, invalid, "invalid-draft"), (error) => error.code === "invalid-argument" && error.details?.purchaseRequestUncommitted === true);
  assert.equal(JSON.stringify([...db.records]), before);
  const valid = await create(db, draft("0.123456"), "corrected-draft");
  assert.equal(valid.request.totalMinor, 12);
});
test("invalid settings and budget preflight can be corrected only after authorized receipt absence is verified", async () => {
  const db = fixture();
  const saveSettings = (requestId, value) => api.saveHotelPurchaseRequestSettingsHandler(request({ requestId, expectedRevision: 1, settings: value }), services(db));
  await assert.rejects(saveSettings("invalid-settings", { ...settings(), unrecognized: true }), (error) => error.code === "invalid-argument" && error.details?.purchaseRequestUncommitted === true);
  const validSettings = await saveSettings("corrected-settings", settings()); assert.equal(validSettings.revision, 2);
  const saveBudget = (requestId, budgetMinor) => api.saveHotelPurchaseBudgetsHandler(request({ requestId, budgets: [{ month: "2026-10", categoryId: "maintenance", budgetMinor, openingUsedMinor: 0, expectedRevision: 1 }] }), services(db));
  await assert.rejects(saveBudget("invalid-budget", 100.1), (error) => error.code === "invalid-argument" && error.details?.purchaseRequestUncommitted === true);
  const validBudget = await saveBudget("corrected-budget", 10000); assert.equal(validBudget.budgets[0].budgetMinor, 10000);
});
test("existing operation IDs never claim non-commit for changed valid or malformed payloads or a corrupted receipt", async () => {
  const db = fixture(); await create(db);
  await assert.rejects(create(db, draft(200)), (error) => error.code === "already-exists" && error.details?.purchaseRequestUncommitted !== true);
  await assert.rejects(create(db, draft("0.0000001")), (error) => error.code === "invalid-argument" && error.details?.purchaseRequestUncommitted !== true);
  const receipt = [...db.records].find(([path]) => path.includes("/purchaseRequestOperations/"))[1]; receipt.resultFingerprint = "corrupted";
  await assert.rejects(create(db), (error) => error.code === "failed-precondition" && error.details?.purchaseRequestUncommitted !== true);
});
test("committed settings and budget receipts also retain uncertainty when normalization of a reused ID fails", async () => {
  const db = fixture();
  await api.saveHotelPurchaseRequestSettingsHandler(request({ requestId: "saved-settings", expectedRevision: 1, settings: settings() }), services(db));
  await assert.rejects(api.saveHotelPurchaseRequestSettingsHandler(request({ requestId: "saved-settings", expectedRevision: 1, settings: { ...settings(), forged: true } }), services(db)), (error) => error.details?.purchaseRequestUncommitted !== true);
  const row = { month: "2026-10", categoryId: "maintenance", budgetMinor: 40000, openingUsedMinor: 0, expectedRevision: 1 };
  await api.saveHotelPurchaseBudgetsHandler(request({ requestId: "saved-budget", budgets: [row] }), services(db));
  await assert.rejects(api.saveHotelPurchaseBudgetsHandler(request({ requestId: "saved-budget", budgets: [{ ...row, budgetMinor: 1.1 }] }), services(db)), (error) => error.details?.purchaseRequestUncommitted !== true);
});
test("revoked permissions or Auth cannot turn either preflight or transaction failure into a non-commit proof", async () => {
  const db = fixture(); db.records.set(`${base}/members/buyer`, { permissions: ["purchaserequests.read"] });
  await assert.rejects(create(db, draft("0.0000001"), "unproven-invalid"), (error) => error.details?.purchaseRequestUncommitted !== true);
  await assert.rejects(create(db, draft(), "unproven-valid"), (error) => error.code === "permission-denied" && error.details?.purchaseRequestUncommitted !== true);
  db.records.set(`${base}/members/buyer`, { permissions });
  await assert.rejects(api.mutateHotelPurchaseRequestHandler(request({ action: "create", requestId: "disabled-invalid", expectedRevision: 0, draft: draft("0.0000001") }), services(db, { auth: { getUser: async (uid) => ({ uid, disabled: true, emailVerified: true }) } })), (error) => error.details?.purchaseRequestUncommitted !== true);
});
