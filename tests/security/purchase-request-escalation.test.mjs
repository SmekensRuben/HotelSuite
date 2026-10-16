import { before, beforeEach, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { initializeTestEnvironment } from "@firebase/rules-unit-testing";

const projectId = "demo-hotel-suite-a00";
for (const key of ["FIRESTORE_EMULATOR_HOST", "FIREBASE_AUTH_EMULATOR_HOST", "FIREBASE_STORAGE_EMULATOR_HOST"]) {
  if (!/^(127\.0\.0\.1|localhost):\d+$/.test(process.env[key] || "")) throw new Error("Only real local emulators are allowed.");
}
process.env.FIREBASE_CONFIG = JSON.stringify({ projectId, storageBucket: `${projectId}.appspot.com` });
const require = createRequire(import.meta.url);
const { admin } = require("../../functions/src/config");
const { SAAS_RULES_VERSION } = require("../../functions/src/saasRollout");
const api = () => require("../../functions/src/purchaseRequests");
const { resolvePurchaseRequestNotification } = require("../../functions/src/purchaseRequestNotifications");
const db = admin.firestore(), auth = admin.auth();
const services = { firestore: db, auth, now: () => Date.parse("2026-10-15T10:00:00Z"), appBaseUrl: "https://hotel.example.test" };
const grants = ["purchaserequests.read", "purchaserequests.create", "purchaserequests.update", "purchaserequests.submit", "purchaserequests.approve", "purchaserequests.cancel", "purchasebudgets.read", "purchasebudgets.update", "purchasebudgets.settings"];
const identities = Object.fromEntries(["requester", "finance", "gm", "alternate", "foreign"].map((uid) => [uid, {
  uid, token: { email: `${uid}@example.test`, email_verified: true, auth_time: Math.floor(Date.now() / 1000) },
}]));
let environment, sequence = 0;
const next = () => `purchase-escalation-${++sequence}`;
const request = (data, actor = "requester") => ({ auth: identities[actor], data });
const rejected = (promise, code) => assert.rejects(promise, (error) => code ? error.code === code : ["permission-denied", "failed-precondition", "aborted"].includes(error.code));
const draft = (amount = 150) => ({ supplierId: "supplier", title: "Fictional departmental repair", description: "Replace a broken part", motivation: "Keep the kitchen operational", costCentreId: "kitchen", budgetCategoryId: "maintenance", budgetMonth: "2026-10", lines: [{ id: "repair", kind: "free", description: "Replacement part", quantity: 1, unitPrice: amount, unit: "service" }], attachmentIds: [] });
const mutate = (action, fields = {}, actor = "requester") => api().mutateHotelPurchaseRequestHandler(request({ hotelUid: "hotel-a", requestId: next(), action, ...fields }, actor), services);
const create = (amount = 150) => mutate("create", { expectedRevision: 0, draft: draft(amount) });
const transition = (action, result, fields = {}, actor = "requester") => mutate(action, { purchaseRequestId: result.purchaseRequestId, expectedRevision: result.revision, ...fields }, actor);
const detail = (result, actor = "requester") => api().getHotelPurchaseRequestHandler(request({ hotelUid: "hotel-a", purchaseRequestId: result.purchaseRequestId }, actor), services);
const budget = async () => (await db.doc("hotels/hotel-a/purchaseBudgets/2026-10__maintenance").get()).data();
const authority = (uid, stepIds, patch = {}) => ({ uid, stepIds, limitMinor: 1000000, canApproveOverBudget: false, ...patch });
const stepIds = (steps) => steps.map((step) => step.id);
const baseSettings = () => ({ currency: "EUR", costCentres: [{ id: "kitchen", name: "Kitchen" }], budgetCategories: [{ id: "maintenance", name: "Maintenance" }],
  approvalSteps: [{ id: "department", name: "Department approval", thresholdMinor: 0 }, { id: "finance", name: "Finance approval", thresholdMinor: 100000 }, { id: "gm", name: "General Manager approval", thresholdMinor: 500000 }],
  approvers: [authority("requester", ["department"]), authority("finance", ["finance"]), authority("gm", ["gm"], { canApproveOverBudget: true })], overBudgetMode: "block" });
async function saveSettings(settings) {
  const previous = await db.doc("hotels/hotel-a/settings/purchaseRequests").get();
  return api().saveHotelPurchaseRequestSettingsHandler(request({ hotelUid: "hotel-a", requestId: next(), expectedRevision: previous.data()?.revision || 0, settings }), services);
}
async function configure({ settings = baseSettings(), budgetMinor = 1000000 } = {}) {
  await saveSettings(settings);
  await api().saveHotelPurchaseBudgetsHandler(request({ hotelUid: "hotel-a", requestId: next(), budgets: [{ month: "2026-10", categoryId: "maintenance", budgetMinor, openingUsedMinor: 0, expectedRevision: 0 }] }), services);
}
async function financialEvidence(result) {
  const [currentBudget, history, mail, receipt] = await Promise.all([
    budget(), db.collection(`hotels/hotel-a/purchaseRequests/${result.purchaseRequestId}/history`).get(),
    db.collection("hotels/hotel-a/mailQueue").get(), db.collection("hotels/hotel-a/purchaseRequestOperations").get(),
  ]);
  return { budget: currentBudget, history: history.docs.map((snapshot) => [snapshot.id, snapshot.data()]), mail: mail.docs.map((snapshot) => [snapshot.id, snapshot.data()]), receipts: receipt.docs.map((snapshot) => [snapshot.id, snapshot.data()]) };
}
async function route(result) {
  const value = (await detail(result)).submissionApprovalRoute;
  assert.ok(value, "The owner receives an authoritative route for a draft or returned request.");
  return value;
}

before(async () => {
  environment = await initializeTestEnvironment({ projectId,
    firestore: { host: "127.0.0.1", port: Number(process.env.FIRESTORE_EMULATOR_HOST.split(":").at(-1)), rules: await readFile("firebase/firestore.rules", "utf8") } });
});
beforeEach(async () => {
  await environment.clearFirestore();
  const users = await auth.listUsers();
  if (users.users.length) await auth.deleteUsers(users.users.map((user) => user.uid));
  for (const identity of Object.values(identities)) {
    await auth.createUser({ uid: identity.uid, email: identity.token.email, emailVerified: true, displayName: identity.uid });
    identity.token.auth_time = Math.floor(Date.now() / 1000);
  }
  await db.doc("platformConfiguration/saasProcurement").set({ enabled: true, rulesVersion: SAAS_RULES_VERSION });
  for (const hotelUid of ["hotel-a", "hotel-b"]) {
    await db.doc(`hotels/${hotelUid}`).set({ hotelName: hotelUid, currency: "EUR", timeZone: "Europe/Brussels" });
    await db.doc(`hotelSubscriptions/${hotelUid}`).set({ status: "active", validUntil: null, modules: ["procurement"], modulePolicyVersion: 1 });
    await db.doc(`hotels/${hotelUid}/suppliers/supplier`).set({ name: "Fictional repair company", active: true });
  }
  for (const uid of ["requester", "finance", "gm", "alternate"]) await db.doc(`hotels/hotel-a/members/${uid}`).set({ permissions: grants, displayName: uid });
  await db.doc("hotels/hotel-b/members/foreign").set({ permissions: grants });
});
after(async () => environment.cleanup());

describe("department routing, complete routes and direct self-approval", () => {
  it("restricts initial assignment to the selected department and auto-assigns a sole qualified person", async () => {
    const settings = baseSettings();
    settings.costCentres = [{ id: "kitchen", name: "Kitchen", approverUids: ["alternate"] }, { id: "rooms", name: "Rooms", approverUids: ["finance"] }];
    settings.approvers = [authority("alternate", ["department"]), authority("finance", ["department", "finance"]), authority("gm", ["gm"])];
    await configure({ settings });
    const created = await create(), original = await financialEvidence(created);
    assert.deepEqual((await route(created)).approvers.map((person) => person.uid), ["alternate"]);
    await rejected(transition("submit", created, { approverUid: "finance" }), "permission-denied");
    assert.deepEqual(await financialEvidence(created), original);
    const submitted = await transition("submit", created);
    assert.equal(submitted.request.currentApproverUid, "alternate");
    assert.equal((await transition("approve", submitted, {}, "alternate")).request.status, "approved");
  });
  it("blocks a later requester conflict before reservation, then uses an explicitly configured substitute", async () => {
    const settings = baseSettings();
    settings.approvers = [authority("alternate", ["department"]), authority("requester", ["finance"]), authority("gm", ["gm"])];
    await configure({ settings });
    const created = await create(1500), original = await financialEvidence(created);
    assert.match((await route(created)).error.message, /Finance approval/);
    await rejected(transition("submit", created), "permission-denied");
    assert.deepEqual(await financialEvidence(created), original);
    settings.approvalSteps[1].substituteUids = ["gm"];
    await saveSettings(settings);
    const pending = await transition("submit", created), handoff = await transition("approve", pending, {}, "alternate");
    assert.equal(handoff.request.currentApproverUid, "gm"); assert.equal(handoff.request.currentAssignment.kind, "substitute");
    const mail = (await db.collection("hotels/hotel-a/mailQueue").where("revision", "==", handoff.revision).get()).docs[0].data();
    const notification = await db.runTransaction((tx) => resolvePurchaseRequestNotification(tx, db, "hotel-a", mail, services));
    assert.deepEqual(notification.to, ["gm@example.test"]);
    const approved = await transition("approve", handoff, {}, "gm");
    assert.equal(approved.request.approvals[1].kind, "substitute");
    assert.equal((await budget()).pendingMinor, 0); assert.equal((await budget()).committedMinor, 150000);
  });
  it("filters a tempting first choice that would consume the only later approver", async () => {
    const settings = baseSettings(); settings.approvers = [authority("alternate", ["department", "finance"]), authority("finance", ["department"])];
    await configure({ settings });
    const created = await create(1500);
    assert.deepEqual((await route(created)).approvers.map((person) => person.uid), ["finance"]);
    await rejected(transition("submit", created, { approverUid: "alternate" }), "permission-denied");
    const pending = await transition("submit", created), handoff = await transition("approve", pending, {}, "finance");
    assert.equal(handoff.request.currentApproverUid, "alternate");
  });
  it("supports a higher-level replacement while keeping its separate amount-required control", async () => {
    const settings = baseSettings(); settings.approvalSteps[1].fallbackStepId = "gm";
    settings.approvers = [authority("alternate", ["department"]), authority("requester", ["finance"]), authority("gm", ["gm"])];
    await configure({ settings });
    const low = await create(1500); assert.equal((await route(low)).plan[1].candidates[0].kind, "higher-level");
    const high = await create(7500); assert.ok((await route(high)).error, "one GM cannot fill both controls");
    await rejected(transition("submit", high)); assert.equal((await budget()).pendingMinor || 0, 0);
  });
  async function enableSelf({ independent = false, budgetMinor = 50000, overBudgetMode = "block" } = {}) {
    await db.doc("hotels/hotel-a/members/requester").update({ permissions: [...grants, "purchaserequests.selfapprove"] });
    const settings = baseSettings(); settings.overBudgetMode = overBudgetMode;
    settings.approvers[0].selfApprovalLimitMinor = 100000;
    settings.approvalSteps[1].thresholdMinor = 10000; settings.approvalSteps[1].independentRequired = independent;
    await configure({ settings, budgetMinor }); return settings;
  }
  it("records direct self-approval with immutable evidence, one commitment, one notification and exact retries", async () => {
    await enableSelf(); const created = await create();
    const preview = (await detail(created)).selfApprovalRoute; assert.equal(preview.error, null); assert.deepEqual(preview.steps, []);
    const input = { hotelUid: "hotel-a", action: "selfapprove", requestId: next(), purchaseRequestId: created.purchaseRequestId, expectedRevision: created.revision, reason: "GM delegated replacement", expectedApprovalRouteFingerprint: preview.fingerprint };
    const approved = await api().mutateHotelPurchaseRequestHandler(request(input), services);
    const evidence = await financialEvidence(approved);
    assert.equal(approved.request.status, "approved"); assert.equal(approved.request.selfApproval.reason, input.reason);
    assert.equal(evidence.budget.pendingMinor || 0, 0); assert.equal(evidence.budget.committedMinor, 15000);
    assert.equal(evidence.mail.length, 1); assert.equal(evidence.mail[0][1].event, "selfapproved");
    assert.deepEqual(await api().mutateHotelPurchaseRequestHandler(request(input), services), approved);
    assert.deepEqual(await financialEvidence(approved), evidence);
    await rejected(api().mutateHotelPurchaseRequestHandler(request({ ...input, reason: "Different rationale" }), services), "already-exists");
    const notification = await db.runTransaction((tx) => resolvePurchaseRequestNotification(tx, db, "hotel-a", evidence.mail[0][1], services));
    assert.match(notification.text, /Self-approved by: requester/);
    await rejected(detail(approved, "foreign"), "permission-denied");
  });
  it("retains independent Finance and over-budget controls after self-approval with distinct actors", async () => {
    await enableSelf({ independent: true, overBudgetMode: "approval", budgetMinor: 0 });
    const pending = await transition("selfapprove", await create(), { reason: "Urgent GM repair; independent review" });
    assert.equal(pending.request.currentApproverUid, "finance"); assert.deepEqual(stepIds(pending.request.approvalSteps), ["finance", "over-budget"]);
    assert.equal((await budget()).pendingMinor, 15000); assert.equal((await budget()).committedMinor || 0, 0);
    await rejected(transition("approve", pending), "permission-denied");
    const next = await transition("approve", pending, {}, "finance"); assert.equal(next.request.currentApproverUid, "gm");
    const approved = await transition("approve", next, {}, "gm");
    assert.equal(approved.request.status, "approved"); assert.equal(approved.request.selfApproval.approverUid, "requester");
    assert.equal((await budget()).pendingMinor, 0); assert.equal((await budget()).committedMinor, 15000);
  });
  it("rechecks explicit self permission, current account, limits and budget without changing financial evidence", async () => {
    const settings = await enableSelf(), created = await create(), original = await financialEvidence(created);
    await db.doc("hotels/hotel-a/members/requester").update({ permissions: [...grants, "purchaserequests.*"] });
    await rejected(transition("selfapprove", created, { reason: "GM" }), "permission-denied");
    assert.deepEqual(await financialEvidence(created), original);
    await db.doc("hotels/hotel-a/members/requester").update({ permissions: [...grants, "purchaserequests.selfapprove"] });
    await auth.updateUser("requester", { disabled: true });
    await rejected(transition("selfapprove", created, { reason: "GM" }), "permission-denied");
    await auth.updateUser("requester", { disabled: false });
    settings.approvers[0].selfApprovalLimitMinor = 14999; await saveSettings(settings);
    await rejected(transition("selfapprove", created, { reason: "GM" }), "permission-denied");
    settings.approvers[0].selfApprovalLimitMinor = 100000; await saveSettings(settings);
    await db.doc("hotels/hotel-a/purchaseBudgets/2026-10__maintenance").update({ budgetMinor: 0 });
    await rejected(transition("selfapprove", created, { reason: "GM" }), "failed-precondition");
    assert.equal((await budget()).pendingMinor || 0, 0); assert.equal((await budget()).committedMinor || 0, 0);
    assert.equal((await detail(created)).history.length, 1);
  });
  it("serializes competing direct registrations against the same last available budget", async () => {
    await enableSelf({ budgetMinor: 20000 }); const first = await create(), second = await create();
    const outcomes = await Promise.allSettled([transition("selfapprove", first, { reason: "Repair one" }), transition("selfapprove", second, { reason: "Repair two" })]);
    assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
    assert.equal((await budget()).committedMinor, 15000); assert.equal((await budget()).pendingMinor || 0, 0);
    assert.equal((await db.collection("hotels/hotel-a/mailQueue").get()).size, 1);
  });
  it("cannot grant a self-approval limit through settings without the separate hotel permission", async () => {
    const settings = baseSettings(); settings.approvers[0].selfApprovalLimitMinor = 100000;
    await rejected(saveSettings(settings), "permission-denied");
    assert.equal((await db.doc("hotels/hotel-a/settings/purchaseRequests").get()).exists, false);
  });
});

describe("requester-only first approval escalation with real Auth and Firestore", () => {
  it("promotes the immediate next configured step below its threshold, records evidence and commits only once", async () => {
    await configure();
    const created = await create(), preview = await route(created);
    assert.equal(preview.error, null);
    assert.match(preview.fingerprint, /^[a-f0-9]{64}$/);
    assert.deepEqual(stepIds(preview.steps), ["finance"]);
    assert.deepEqual(preview.approvers.map((person) => person.uid), ["finance"]);
    assert.deepEqual(preview.escalation, { reason: "requester-only-first-step", fromStepId: "department", fromStepName: "Department approval", toStepId: "finance", toStepName: "Finance approval", settingsRevision: 1 });
    const input = { hotelUid: "hotel-a", requestId: next(), action: "submit", purchaseRequestId: created.purchaseRequestId, expectedRevision: created.revision, approverUid: "finance", expectedApprovalRouteFingerprint: preview.fingerprint };
    const submitted = await api().mutateHotelPurchaseRequestHandler(request(input), services);
    assert.equal(submitted.request.status, "pending"); assert.equal(submitted.request.currentApproverUid, "finance");
    assert.deepEqual(submitted.request.approvals, []);
    assert.deepEqual(submitted.request.approvalEscalation, preview.escalation);
    assert.deepEqual(stepIds(submitted.request.approvalSteps), ["finance"]);
    const beforeReplay = await financialEvidence(submitted);
    assert.equal(beforeReplay.budget.pendingMinor, 15000); assert.equal(beforeReplay.budget.committedMinor || 0, 0);
    assert.equal(beforeReplay.mail.length, 1); assert.equal(beforeReplay.mail[0][1].recipientUid, "finance");
    const notification = await db.runTransaction((tx) => resolvePurchaseRequestNotification(tx, db, "hotel-a", beforeReplay.mail[0][1], services));
    assert.deepEqual(notification.to, ["finance@example.test"]);
    assert.match(notification.text, /Awaiting your approval/);
    assert.deepEqual(await api().mutateHotelPurchaseRequestHandler(request(input), services), submitted);
    assert.deepEqual(await financialEvidence(submitted), beforeReplay);
    await rejected(transition("approve", submitted), "permission-denied");
    const approval = { hotelUid: "hotel-a", requestId: next(), action: "approve", purchaseRequestId: submitted.purchaseRequestId, expectedRevision: submitted.revision };
    const approved = await api().mutateHotelPurchaseRequestHandler(request(approval, "finance"), services);
    assert.equal(approved.request.status, "approved");
    assert.deepEqual(approved.request.approvals.map((entry) => entry.approverUid), ["finance"]);
    assert.equal((await budget()).pendingMinor, 0); assert.equal((await budget()).committedMinor, 15000);
    const final = await financialEvidence(approved);
    assert.deepEqual(await api().mutateHotelPurchaseRequestHandler(request(approval, "finance"), services), approved);
    assert.deepEqual(await financialEvidence(approved), final);
    const history = (await detail(approved)).history;
    assert.deepEqual(history.find((entry) => entry.event === "submit").snapshot.approvalEscalation, preview.escalation);
    assert.equal(history.find((entry) => entry.event === "create").snapshot.lines[0].unitPrice, 150);
  });

  it("deduplicates the promoted step while retaining every other amount-based approval and independent actor", async () => {
    await configure();
    const created = await create(7500), preview = await route(created);
    assert.deepEqual(stepIds(preview.steps), ["finance", "gm"]);
    await rejected(transition("submit", created, { approverUid: "gm" }));
    const submitted = await transition("submit", created, { approverUid: "finance" });
    await rejected(transition("approve", submitted, { nextApproverUid: "finance" }, "finance"));
    const intermediate = await transition("approve", submitted, { nextApproverUid: "gm" }, "finance");
    assert.equal(intermediate.request.status, "pending"); assert.equal((await budget()).pendingMinor, 750000);
    await rejected(transition("approve", intermediate, {}, "finance"));
    const approved = await transition("approve", intermediate, {}, "gm");
    assert.equal(approved.request.status, "approved"); assert.equal((await budget()).committedMinor, 750000);
    assert.deepEqual(approved.request.approvals.map((entry) => entry.approverUid), ["finance", "gm"]);
  });

  it("retains the department step whenever another currently authorized department approver exists", async () => {
    const settings = baseSettings(); settings.approvers.push(authority("alternate", ["department"]));
    await configure({ settings });
    const created = await create(), preview = await route(created);
    assert.equal(preview.escalation, null); assert.deepEqual(stepIds(preview.steps), ["department"]);
    assert.deepEqual(preview.approvers.map((person) => person.uid), ["alternate"]);
    await rejected(transition("submit", created, { approverUid: "finance" }));
    const submitted = await transition("submit", created, { approverUid: "alternate" });
    assert.deepEqual(stepIds(submitted.request.approvalSteps), ["department"]);
    assert.equal(submitted.request.approvalEscalation, null);
  });

  it("does not infer requester-only authority when the requester lacks the full request amount limit", async () => {
    const settings = baseSettings(); settings.approvers[0].limitMinor = 10000;
    await configure({ settings });
    const created = await create(), preview = await route(created);
    assert.ok(preview.error); assert.equal(preview.fingerprint, null);
    const original = await financialEvidence(created);
    await rejected(transition("submit", created, { approverUid: "finance" }));
    assert.deepEqual(await financialEvidence(created), original);
  });

  it("never bypasses an unavailable immediate higher step to use a later configured step", async () => {
    const settings = baseSettings(); settings.approvers[1].limitMinor = 10000;
    await configure({ settings });
    const created = await create(), preview = await route(created);
    assert.ok(preview.error); assert.equal(preview.fingerprint, null);
    const original = await financialEvidence(created);
    await rejected(transition("submit", created, { approverUid: "gm" }));
    assert.deepEqual(await financialEvidence(created), original);
  });

  it("blocks escalation when no higher step is configured", async () => {
    const settings = baseSettings(); settings.approvalSteps = settings.approvalSteps.slice(0, 1); settings.approvers = settings.approvers.slice(0, 1);
    await configure({ settings });
    const created = await create(), preview = await route(created);
    assert.ok(preview.error);
    await rejected(transition("submit", created, { approverUid: "requester" }));
    assert.equal((await budget()).pendingMinor || 0, 0);
  });

  it("uses live account and hotel permissions rather than stale configured authorities", async () => {
    const settings = baseSettings(); settings.approvers.push(authority("alternate", ["department"]));
    await configure({ settings });
    const created = await create();
    await auth.updateUser("alternate", { disabled: true });
    assert.deepEqual(stepIds((await route(created)).steps), ["finance"]);
    await auth.updateUser("finance", { emailVerified: false });
    assert.ok((await route(created)).error);
    await rejected(transition("submit", created, { approverUid: "finance" }));
    await auth.updateUser("finance", { emailVerified: true });
    await db.doc("hotels/hotel-a/members/finance").delete();
    assert.ok((await route(created)).error);
    await rejected(transition("submit", created, { approverUid: "foreign" }));
    await rejected(detail(created, "foreign"), "permission-denied");
    assert.equal((await detail(created, "gm")).submissionApprovalRoute, null);
    assert.equal((await budget()).pendingMinor || 0, 0);
  });

  it("recomputes the route on submission after a previewed approver loses authority", async () => {
    await configure();
    const created = await create(), preview = await route(created), original = await financialEvidence(created);
    await db.doc("hotels/hotel-a/members/finance").update({ permissions: ["purchaserequests.read"] });
    await rejected(transition("submit", created, { approverUid: "finance", expectedApprovalRouteFingerprint: preview.fingerprint }));
    assert.deepEqual(await financialEvidence(created), original);
    assert.ok((await route(created)).error);
  });

  it("does not treat an unavailable alternative account lookup as permission to skip department approval", async () => {
    const settings = baseSettings(); settings.approvers.push(authority("alternate", ["department"]));
    await configure({ settings });
    const created = await create(), original = await financialEvidence(created);
    const unavailableServices = { ...services, auth: { getUser: async (uid) => {
      if (uid === "alternate") throw Object.assign(new Error("Fictional transient Auth outage"), { code: "auth/internal-error" });
      return auth.getUser(uid);
    } } };
    const preview = await api().getHotelPurchaseRequestHandler(request({ hotelUid: "hotel-a", purchaseRequestId: created.purchaseRequestId }), unavailableServices);
    assert.equal(preview.submissionApprovalRoute.error.code, "unavailable");
    assert.deepEqual(preview.submissionApprovalRoute.steps, []);
    await rejected(api().mutateHotelPurchaseRequestHandler(request({ hotelUid: "hotel-a", requestId: next(), action: "submit", purchaseRequestId: created.purchaseRequestId, expectedRevision: created.revision, approverUid: "finance" }), unavailableServices), "unavailable");
    assert.deepEqual(await financialEvidence(created), original);
  });

  it("rejects a stale reviewed route even when the same user could approve either route", async () => {
    const settings = baseSettings(); settings.approvers[1].stepIds.push("department");
    await configure({ settings });
    const created = await create(), preview = await route(created);
    assert.deepEqual(stepIds(preview.steps), ["department"]);
    settings.approvers[1].stepIds = ["finance"];
    await saveSettings(settings);
    const fresh = await route(created); assert.deepEqual(stepIds(fresh.steps), ["finance"]);
    assert.notEqual(fresh.fingerprint, preview.fingerprint);
    const original = await financialEvidence(created);
    await rejected(transition("submit", created, { approverUid: "finance", expectedApprovalRouteFingerprint: preview.fingerprint }), "aborted");
    assert.deepEqual(await financialEvidence(created), original);
    const submitted = await transition("submit", created, { approverUid: "finance", expectedApprovalRouteFingerprint: fresh.fingerprint });
    assert.equal(submitted.request.approvalEscalation.settingsRevision, 2);
  });

  it("preserves submitted routes and immutable evidence after settings change and clears evidence for a returned draft", async () => {
    const settings = baseSettings(); await configure({ settings });
    const created = await create(), submitted = await transition("submit", created, { approverUid: "finance" });
    const submittedEvidence = (await detail(submitted)).history.find((entry) => entry.event === "submit");
    settings.approvers.push(authority("alternate", ["department"]));
    await saveSettings(settings);
    const pending = await detail(submitted);
    assert.equal(pending.submissionApprovalRoute, null);
    assert.deepEqual(stepIds(pending.request.approvalSteps), ["finance"]);
    assert.deepEqual(pending.request.approvalEscalation, submitted.request.approvalEscalation);
    const returned = await transition("return", submitted, { reason: "Please clarify the repair" }, "finance");
    assert.equal(returned.request.approvalEscalation, null);
    const preview = await route(returned); assert.equal(preview.escalation, null); assert.deepEqual(stepIds(preview.steps), ["department"]);
    const resubmitted = await transition("submit", returned, { approverUid: "alternate" });
    assert.equal((await budget()).pendingMinor, 15000);
    const historical = (await detail(resubmitted)).history.find((entry) => entry.revision === submitted.revision);
    assert.deepEqual(historical, submittedEvidence);
  });

  it("retains a separate over-budget decision after escalation and never lets one approver fill both steps", async () => {
    const settings = baseSettings(); settings.overBudgetMode = "approval"; settings.approvers[1].canApproveOverBudget = true;
    await configure({ settings, budgetMinor: 10000 });
    const created = await create(), preview = await route(created);
    assert.deepEqual(stepIds(preview.steps), ["finance", "over-budget"]);
    const submitted = await transition("submit", created, { approverUid: "finance" });
    await rejected(transition("approve", submitted, { nextApproverUid: "finance" }, "finance"));
    const intermediate = await transition("approve", submitted, {}, "finance");
    assert.equal((await budget()).pendingMinor, 15000); assert.equal((await budget()).committedMinor || 0, 0);
    const approved = await transition("approve", intermediate, {}, "gm");
    assert.deepEqual(approved.request.approvals.map((entry) => entry.stepId), ["finance", "over-budget"]);
    assert.equal((await budget()).committedMinor, 15000); assert.equal((await budget()).pendingMinor, 0);
  });

  it("serializes competing escalated submissions without reserving an exceeded budget or duplicating notifications", async () => {
    await configure({ budgetMinor: 20000 });
    const first = await create(), second = await create();
    const outcomes = await Promise.allSettled([transition("submit", first, { approverUid: "finance" }), transition("submit", second, { approverUid: "finance" })]);
    assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal((await budget()).pendingMinor, 15000);
    assert.equal((await db.collection("hotels/hotel-a/mailQueue").get()).size, 1);
    const requests = await db.collection("hotels/hotel-a/purchaseRequests").get();
    assert.deepEqual(requests.docs.map((snapshot) => snapshot.data().status).sort(), ["draft", "pending"]);
  });

  it("replays an explicit pre-escalation command receipt without changing legacy fingerprints or results", async () => {
    await configure();
    const requestId = next(), input = { hotelUid: "hotel-a", requestId, action: "create", expectedRevision: 0, draft: draft() };
    const created = await api().mutateHotelPurchaseRequestHandler(request(input), services);
    const { digest } = require("../../functions/src/validation");
    const { normalizeDraft } = require("../../functions/src/purchaseRequestPolicy");
    const { canonicalDigest } = api().purchaseRequestInternals;
    const receiptRef = db.doc(`hotels/hotel-a/purchaseRequestOperations/p-${digest("requester", requestId).slice(0, 48)}`);
    const receipt = (await receiptRef.get()).data();
    const legacyFingerprint = canonicalDigest({ kind: "request", payload: { id: created.purchaseRequestId, action: "create", expected: 0, draft: normalizeDraft(input.draft), approverUid: null, nextApproverUid: null, reason: "" } });
    assert.equal(receipt.fingerprint, legacyFingerprint);
    const legacyResult = structuredClone(created);
    delete legacyResult.request.approvalEscalation;
    await receiptRef.update({ fingerprint: legacyFingerprint, result: legacyResult, resultFingerprint: canonicalDigest(legacyResult) });
    const original = await financialEvidence(created);
    assert.deepEqual(await api().mutateHotelPurchaseRequestHandler(request(input), services), legacyResult);
    assert.deepEqual(await financialEvidence(created), original);
  });
});
