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
  assert.deepEqual([...db.records], before);
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
