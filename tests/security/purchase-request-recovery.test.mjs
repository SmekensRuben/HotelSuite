import { before, beforeEach, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { initializeTestEnvironment, assertFails } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, updateDoc, deleteDoc } from "firebase/firestore";

const projectId = "demo-hotel-suite-a00";
for (const key of ["FIRESTORE_EMULATOR_HOST", "FIREBASE_AUTH_EMULATOR_HOST", "FIREBASE_STORAGE_EMULATOR_HOST"]) {
  if (!/^(127\.0\.0\.1|localhost):\d+$/.test(process.env[key] || "")) throw new Error("Only real local emulators are allowed.");
}
process.env.FIREBASE_CONFIG = JSON.stringify({ projectId, storageBucket: `${projectId}.appspot.com` });
const require = createRequire(import.meta.url);
const { admin } = require("../../functions/src/config");
const { SAAS_RULES_VERSION } = require("../../functions/src/saasRollout");
const api = () => require("../../functions/src/purchaseRequests");
const db = admin.firestore(), auth = admin.auth();
const services = { firestore: db, auth, now: () => Date.parse("2026-10-16T10:00:00Z"), appBaseUrl: "https://hotel.example.test" };
const ordinaryGrants = ["purchaserequests.read", "purchaserequests.create", "purchaserequests.update", "purchaserequests.submit", "purchaserequests.approve", "purchaserequests.cancel", "purchasebudgets.read", "purchasebudgets.update", "purchasebudgets.settings"];
const recoveryGrants = ["purchaserequests.read", "purchaserequests.recover", "purchasebudgets.read"];
const identities = Object.fromEntries(["requester", "manager", "finance", "backup", "recovery", "wildcard", "foreign", "operator"].map((uid) => [uid, {
  uid, token: { email: `${uid}@example.test`, email_verified: true, auth_time: Math.floor(Date.now() / 1000), ...(uid === "operator" ? { platformAdmin: true } : {}) },
}]));
let environment, sequence = 0;
const next = () => `purchase-recovery-${++sequence}`;
const request = (data, actor = "requester") => ({ auth: identities[actor], data });
const rejected = (promise, code) => assert.rejects(promise, (error) => code ? error.code === code : ["permission-denied", "failed-precondition", "aborted"].includes(error.code));
const draft = (amount = 150) => ({ supplierId: "supplier", title: "Fictional freezer repair", description: "Replace a broken part", motivation: "Keep the kitchen operational", costCentreId: "kitchen", budgetCategoryId: "maintenance", budgetMonth: "2026-10", lines: [{ id: "repair", kind: "free", description: "Replacement part", quantity: 1, unitPrice: amount, unit: "service" }], attachmentIds: [] });
const mutate = (action, fields = {}, actor = "requester") => api().mutateHotelPurchaseRequestHandler(request({ hotelUid: "hotel-a", requestId: next(), action, ...fields }, actor), services);
const transition = (action, result, fields = {}, actor = "requester") => mutate(action, { purchaseRequestId: result.purchaseRequestId, expectedRevision: result.revision, ...fields }, actor);
const detail = (result, actor = "recovery") => api().getHotelPurchaseRequestHandler(request({ hotelUid: "hotel-a", purchaseRequestId: result.purchaseRequestId }, actor), services);
const budget = async () => (await db.doc("hotels/hotel-a/purchaseBudgets/2026-10__maintenance").get()).data();
const history = async (result) => (await db.collection(`hotels/hotel-a/purchaseRequests/${result.purchaseRequestId}/history`).orderBy("revision").get()).docs.map((row) => [row.id, row.data()]);
const authority = (uid, stepIds, patch = {}) => ({ uid, stepIds, limitMinor: 1000000, canApproveOverBudget: false, ...patch });
const settings = () => ({ currency: "EUR", costCentres: [{ id: "kitchen", name: "Kitchen", approverUids: ["manager", "backup"] }, { id: "rooms", name: "Rooms", approverUids: ["finance"] }], budgetCategories: [{ id: "maintenance", name: "Maintenance" }],
  approvalSteps: [{ id: "department", name: "Department approval", thresholdMinor: 0 }, { id: "finance", name: "Finance approval", thresholdMinor: 100000 }],
  approvers: [authority("manager", ["department"]), authority("backup", ["department", "finance"]), authority("finance", ["department", "finance"]), authority("requester", ["department", "finance"])], overBudgetMode: "block" });
async function configure(value = settings()) {
  await api().saveHotelPurchaseRequestSettingsHandler(request({ hotelUid: "hotel-a", requestId: next(), expectedRevision: 0, settings: value }), services);
  await api().saveHotelPurchaseBudgetsHandler(request({ hotelUid: "hotel-a", requestId: next(), budgets: [{ month: "2026-10", categoryId: "maintenance", budgetMinor: 1000000, openingUsedMinor: 0, expectedRevision: 0 }] }), services);
}
async function pending(amount = 150) {
  const created = await mutate("create", { expectedRevision: 0, draft: draft(amount) });
  return transition("submit", created, { approverUid: "manager" });
}
async function reassignInput(value, approverUid = "backup", reason = "The assigned approver is unavailable") {
  return { hotelUid: "hotel-a", action: "reassign", requestId: next(), purchaseRequestId: value.purchaseRequestId, expectedRevision: value.revision,
    approverUid, reason, expectedApprovalRouteFingerprint: (await detail(value)).recoveryApprovalRoute.fingerprint };
}
async function financialEvidence(value) {
  const [currentBudget, currentHistory, mail, receipt] = await Promise.all([
    budget(), history(value), db.collection("hotels/hotel-a/mailQueue").get(), db.collection("hotels/hotel-a/purchaseRequestOperations").get(),
  ]);
  return { budget: currentBudget, history: currentHistory, mail: mail.docs.map((row) => [row.id, row.data()]), receipts: receipt.docs.map((row) => [row.id, row.data()]) };
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
    await auth.setCustomUserClaims(identity.uid, identity.uid === "operator" ? { platformAdmin: true } : {});
    identity.token.auth_time = Math.floor(Date.now() / 1000);
  }
  await db.doc("platformConfiguration/saasProcurement").set({ enabled: true, rulesVersion: SAAS_RULES_VERSION });
  for (const hotelUid of ["hotel-a", "hotel-b"]) {
    await db.doc(`hotels/${hotelUid}`).set({ hotelName: hotelUid, currency: "EUR", timeZone: "Europe/Brussels" });
    await db.doc(`hotelSubscriptions/${hotelUid}`).set({ status: "active", validUntil: null, modules: ["procurement"], modulePolicyVersion: 1 });
    await db.doc(`hotels/${hotelUid}/suppliers/supplier`).set({ name: "Fictional repair company", active: true });
  }
  for (const uid of ["requester", "manager", "finance", "backup"]) await db.doc(`hotels/hotel-a/members/${uid}`).set({ permissions: ordinaryGrants, displayName: uid });
  await db.doc("hotels/hotel-a/members/recovery").set({ permissions: recoveryGrants, displayName: "Recovery manager" });
  await db.doc("hotels/hotel-a/members/wildcard").set({ permissions: ["purchaserequests.*", "purchasebudgets.*"], hotelAdmin: true });
  await db.doc("hotels/hotel-b/members/foreign").set({ permissions: recoveryGrants });
});
after(async () => environment.cleanup());

describe("purchase request recovery with real Auth, transactions and Security Rules", () => {
  it("reassigns after approver access is revoked while preserving original assignments, controls and the reservation", async () => {
    await configure(); const submitted = await pending(), originalHistory = await history(submitted);
    await db.doc("hotels/hotel-a/members/manager").update({ permissions: ["purchaserequests.read"] });
    const route = (await detail(submitted)).recoveryApprovalRoute;
    assert.deepEqual(route.approvers.map((person) => person.uid), ["backup"]);
    const input = await reassignInput(submitted), result = await api().mutateHotelPurchaseRequestHandler(request(input, "recovery"), services);
    assert.equal(result.request.status, "pending"); assert.equal(result.request.currentApproverUid, "backup");
    assert.deepEqual(result.request.approvalSteps, submitted.request.approvalSteps); assert.deepEqual(result.request.approvals, []);
    assert.deepEqual(result.request.reservation, submitted.request.reservation);
    assert.deepEqual((await history(result)).slice(0, originalHistory.length), originalHistory);
    assert.equal(result.request.lastRecovery.actorUid, "recovery"); assert.equal(result.request.lastRecovery.reason, input.reason);
    assert.equal(result.request.lastRecovery.fromApproverUid, "manager"); assert.equal(result.request.lastRecovery.toApproverUid, "backup");
    const evidence = await financialEvidence(result);
    assert.deepEqual(await api().mutateHotelPurchaseRequestHandler(request(input, "recovery"), services), result);
    assert.deepEqual(await financialEvidence(result), evidence);
    await rejected(api().mutateHotelPurchaseRequestHandler(request({ ...input, reason: "A conflicting retry" }, "recovery"), services), "already-exists");
    const approved = await transition("approve", result, {}, "backup");
    assert.equal(approved.request.status, "approved"); assert.equal((await budget()).pendingMinor, 0); assert.equal((await budget()).committedMinor, 15000);
  });

  it("lets a recovery manager cancel an abandoned request once after requester and approver have both left", async () => {
    await configure(); const submitted = await pending(), originalHistory = await history(submitted);
    await Promise.all([auth.deleteUser("requester"), auth.deleteUser("manager"), db.doc("hotels/hotel-a/members/requester").delete(), db.doc("hotels/hotel-a/members/manager").delete()]);
    const input = { hotelUid: "hotel-a", action: "recovercancel", requestId: next(), purchaseRequestId: submitted.purchaseRequestId, expectedRevision: submitted.revision, reason: "Both responsible colleagues left; repair no longer required" };
    const canceled = await api().mutateHotelPurchaseRequestHandler(request(input, "recovery"), services);
    assert.equal(canceled.request.status, "canceled"); assert.equal(canceled.request.reservation.state, "none");
    assert.equal((await budget()).pendingMinor, 0); assert.equal((await budget()).committedMinor || 0, 0);
    assert.deepEqual((await history(canceled)).slice(0, originalHistory.length), originalHistory);
    const evidence = await financialEvidence(canceled);
    assert.deepEqual(await api().mutateHotelPurchaseRequestHandler(request(input, "recovery"), services), canceled);
    assert.deepEqual(await financialEvidence(canceled), evidence);
  });

  it("preserves earlier approvals and cannot replace the next control with a previous approver or requester", async () => {
    await configure(); const submitted = await pending(1500), handoff = await transition("approve", submitted, { nextApproverUid: "finance" }, "manager");
    await auth.updateUser("finance", { disabled: true });
    const route = (await detail(handoff)).recoveryApprovalRoute;
    assert.deepEqual(route.approvers.map((person) => person.uid), ["backup"]);
    const input = await reassignInput(handoff);
    for (const uid of ["requester", "manager", "finance"]) await rejected(api().mutateHotelPurchaseRequestHandler(request({ ...input, requestId: next(), approverUid: uid }, "recovery"), services));
    const reassigned = await api().mutateHotelPurchaseRequestHandler(request(input, "recovery"), services);
    assert.deepEqual(reassigned.request.approvals, handoff.request.approvals); assert.deepEqual(reassigned.request.approvalSteps, handoff.request.approvalSteps);
    assert.equal(reassigned.request.currentStepIndex, 1); assert.equal((await budget()).pendingMinor, 150000);
    assert.equal((await transition("approve", reassigned, {}, "backup")).request.status, "approved");
  });

  it("requires an explicit current hotel grant and cannot turn recovery into approval or cancellation of a commitment", async () => {
    await configure(); const submitted = await pending(), input = await reassignInput(submitted), evidence = await financialEvidence(submitted);
    for (const actor of ["requester", "wildcard", "foreign", "operator"]) {
      await rejected(api().mutateHotelPurchaseRequestHandler(request(input, actor), services), "permission-denied");
      await rejected(transition("recovercancel", submitted, { reason: "Abandoned request" }, actor), "permission-denied");
    }
    await rejected(api().mutateHotelPurchaseRequestHandler(request({ ...input, hotelUid: "hotel-b" }, "recovery"), services), "permission-denied");
    await rejected(transition("approve", submitted, {}, "recovery"), "permission-denied");
    await rejected(transition("selfapprove", submitted, { reason: "Urgent" }, "recovery"), "permission-denied");
    assert.deepEqual(await financialEvidence(submitted), evidence);
    const approved = await transition("approve", submitted, {}, "manager"), committed = await financialEvidence(approved);
    await rejected(transition("recovercancel", approved, { reason: "Attempt to remove commitment" }, "recovery"));
    assert.deepEqual(await financialEvidence(approved), committed);
  });

  it("rejects empty reasons and newly invalid replacement authority without altering financial history", async () => {
    await configure(); const submitted = await pending(), input = await reassignInput(submitted), evidence = await financialEvidence(submitted);
    await rejected(api().mutateHotelPurchaseRequestHandler(request({ ...input, reason: " " }, "recovery"), services), "invalid-argument");
    await rejected(transition("recovercancel", submitted, { reason: " " }, "recovery"), "invalid-argument");
    await rejected(api().mutateHotelPurchaseRequestHandler(request({ ...input, approverUid: "finance" }, "recovery"), services));
    await auth.updateUser("backup", { disabled: true });
    await rejected(api().mutateHotelPurchaseRequestHandler(request(input, "recovery"), services));
    assert.deepEqual(await financialEvidence(submitted), evidence);
  });

  it("serializes simultaneous approval and reassignment with exactly one financial outcome", async () => {
    await configure(); const submitted = await pending(), input = await reassignInput(submitted);
    const outcomes = await Promise.allSettled([
      transition("approve", submitted, {}, "manager"), api().mutateHotelPurchaseRequestHandler(request(input, "recovery"), services),
    ]);
    assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
    const failure = outcomes.find((outcome) => outcome.status === "rejected"); assert.equal(failure.reason.code, "aborted");
    const current = await detail(submitted), ledger = await budget();
    assert.equal(current.request.revision, submitted.revision + 1);
    assert.equal((await history(submitted)).length, 3);
    if (current.request.status === "approved") {
      assert.equal(ledger.pendingMinor, 0); assert.equal(ledger.committedMinor, 15000);
    } else {
      assert.equal(current.request.status, "pending"); assert.equal(current.request.currentApproverUid, "backup");
      assert.equal(ledger.pendingMinor, 15000); assert.equal(ledger.committedMinor || 0, 0);
    }
  });

  it("rechecks recovery authority on replay and protects immutable recovery history from direct clients", async () => {
    await configure(); const submitted = await pending(), input = await reassignInput(submitted);
    const reassigned = await api().mutateHotelPurchaseRequestHandler(request(input, "recovery"), services);
    const entries = await history(reassigned), paths = [
      `hotels/hotel-a/purchaseRequests/${reassigned.purchaseRequestId}`,
      `hotels/hotel-a/purchaseRequests/${reassigned.purchaseRequestId}/history/${entries.at(-1)[0]}`,
      "hotels/hotel-a/purchaseBudgets/2026-10__maintenance",
    ];
    for (const actor of ["recovery", "wildcard", "foreign", "operator"]) {
      const browser = environment.authenticatedContext(actor, identities[actor].token).firestore();
      for (const path of paths) {
        const reference = doc(browser, path);
        await assertFails(getDoc(reference)); await assertFails(setDoc(reference, { lastRecovery: null }));
        await assertFails(updateDoc(reference, { lastRecovery: null })); await assertFails(deleteDoc(reference));
      }
    }
    const evidence = await financialEvidence(reassigned);
    await db.doc("hotels/hotel-a/members/recovery").update({ permissions: ["purchaserequests.read"] });
    await rejected(api().mutateHotelPurchaseRequestHandler(request(input, "recovery"), services), "permission-denied");
    assert.deepEqual(await financialEvidence(reassigned), evidence);
  });
});
