import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const api = () => require("../../functions/src/purchaseRequests");
const json = (value) => JSON.parse(JSON.stringify(value));
const grants = ["purchaserequests.read", "purchaserequests.create", "purchaserequests.update", "purchaserequests.submit", "purchaserequests.approve", "purchaserequests.cancel", "purchasebudgets.read", "purchasebudgets.update", "purchasebudgets.settings"];
const fixtures = [
  { hotelUid: "restore-hotel-a", currency: "EUR", suffix: "a" },
  { hotelUid: "restore-hotel-b", currency: "GBP", suffix: "b" },
];
const actors = (fixture) => ({ requester: `restore-pr-requester-${fixture.suffix}`, approver: `restore-pr-approver-${fixture.suffix}` });
function request(fixture, data, approver = false) {
  return { auth: { uid: actors(fixture)[approver ? "approver" : "requester"], token: { email_verified: true } }, data: { hotelUid: fixture.hotelUid, ...data } };
}
async function records(database, fixture) {
  const result = {};
  async function visit(reference) {
    const rows = await reference.get();
    for (const snapshot of rows.docs) {
      result[snapshot.ref.path] = json(snapshot.data());
      for (const child of await snapshot.ref.listCollections()) await visit(child);
    }
  }
  const settingsPath = `hotels/${fixture.hotelUid}/settings/purchaseRequests`;
  result[settingsPath] = json((await database.doc(settingsPath).get()).data());
  for (const name of ["purchaseRequests", "purchaseRequestOperations", "purchaseBudgets"])
    await visit(database.collection(`hotels/${fixture.hotelUid}/${name}`));
  const notifications = await database.collection(`hotels/${fixture.hotelUid}/mailQueue`).where("type", "==", "purchase-request").get();
  for (const snapshot of notifications.docs) result[snapshot.ref.path] = json(snapshot.data());
  return result;
}
function assertBudget(budget) {
  assert.equal(budget.budgetMinor, 50000);
  assert.equal(budget.openingUsedMinor, 5000);
  assert.equal(budget.committedMinor, 30000);
  assert.equal(budget.pendingMinor, 10000);
  assert.equal(budget.budgetMinor - budget.openingUsedMinor - budget.committedMinor - budget.pendingMinor, 5000);
}

export async function seedPurchaseRequestRestoreProof({ database, auth, now }) {
  const proof = {};
  const services = { firestore: database, auth, now, appBaseUrl: "https://restore.example.test" };
  for (const fixture of fixtures) {
    const { requester, approver } = actors(fixture);
    for (const uid of [requester, approver]) {
      await auth.createUser({ uid, email: `${uid}@example.test`, emailVerified: true });
      await database.doc(`hotels/${fixture.hotelUid}/members/${uid}`).set({ permissions: uid === requester ? [...grants, "purchaserequests.selfapprove"] : grants });
    }
    await database.doc(`hotels/${fixture.hotelUid}/suppliers/restore-pr-supplier`).set({ name: "Fictional restore repair supplier", active: true });
    await database.doc(`hotels/${fixture.hotelUid}/suppliers/restore-pr-second-supplier`).set({ name: "Fictional restore parts supplier", active: true });
    const settings = { requestId: "restore-pr-settings", expectedRevision: 0, settings: { currency: fixture.currency,
      costCentres: [{ id: "maintenance", name: "Maintenance department", approverUids: [approver], substituteUids: [] }], budgetCategories: [{ id: "repairs", name: "Equipment repairs" }],
      approvalSteps: [{ id: "manager", name: "Manager", thresholdMinor: 0 }],
      approvers: [{ uid: approver, stepIds: ["manager"], limitMinor: 1000000, canApproveOverBudget: false }, { uid: requester, stepIds: [], limitMinor: 0, canApproveOverBudget: false, selfApprovalLimitMinor: 20000 }], overBudgetMode: "block" } };
    await api().saveHotelPurchaseRequestSettingsHandler(request(fixture, settings), services);
    const budgets = { requestId: "restore-pr-budget", budgets: [{ month: "2026-10", categoryId: "repairs", budgetMinor: 50000, openingUsedMinor: 5000, expectedRevision: 0 }, { month: "2026-11", categoryId: "repairs", budgetMinor: 20000, openingUsedMinor: 0, expectedRevision: 0 }] };
    await api().saveHotelPurchaseBudgetsHandler(request(fixture, budgets), services);
    const replays = [];
    let mixedRequestId;
    for (const [name, amount, final] of [["approved", 300, true], ["pending", 100, false]]) {
      const create = { action: "create", requestId: `restore-pr-create-${name}`, expectedRevision: 0, draft: {
        supplierId: "restore-pr-supplier", title: `Fictional ${name} repair`, description: "Repair hotel equipment", motivation: "Keep the equipment operational",
        costCentreId: "maintenance", budgetCategoryId: "repairs", budgetMonth: "2026-10",
        lines: final ? [{ id: "service", kind: "free", description: "Repair service", quantity: 1, unitPrice: amount, unit: "service" }] : [
          { id: "service", kind: "free", supplierId: "restore-pr-supplier", description: "Repair service", quantity: 1, unitPrice: 40, unit: "service" },
          { id: "parts", kind: "free", supplierId: "restore-pr-second-supplier", description: "Replacement parts", quantity: 1, unitPrice: 60, unit: "service" },
        ], attachmentIds: [],
      } };
      const created = await api().mutateHotelPurchaseRequestHandler(request(fixture, create), services);
      const submit = { action: "submit", requestId: `restore-pr-submit-${name}`, purchaseRequestId: created.purchaseRequestId, expectedRevision: created.revision, approverUid: approver };
      const submitted = await api().mutateHotelPurchaseRequestHandler(request(fixture, submit), services);
      if (!final) {
        mixedRequestId = created.purchaseRequestId;
        assert.equal(submitted.request.supplierId, ""); assert.equal(submitted.request.supplier, null);
        assert.deepEqual(submitted.request.suppliers, [{ id: "restore-pr-supplier", name: "Fictional restore repair supplier" }, { id: "restore-pr-second-supplier", name: "Fictional restore parts supplier" }]);
        assert.deepEqual(submitted.request.lines.map((line) => line.supplier), submitted.request.suppliers);
        assert.equal(submitted.request.totalMinor, 10000);
      }
      replays.push({ command: create, result: json(created), approver: false }, { command: submit, result: json(submitted), approver: false });
      if (final) {
        const approve = { action: "approve", requestId: "restore-pr-final-approval", purchaseRequestId: created.purchaseRequestId, expectedRevision: submitted.revision };
        const approved = await api().mutateHotelPurchaseRequestHandler(request(fixture, approve, true), services);
        replays.push({ command: approve, result: json(approved), approver: true });
      }
    }
    const selfCreate = { action: "create", requestId: "restore-pr-self-create", expectedRevision: 0, draft: {
      supplierId: "restore-pr-supplier", title: "Fictional directly registered repair", description: "Self-approval recovery proof", motivation: "Delegated authority",
      costCentreId: "maintenance", budgetCategoryId: "repairs", budgetMonth: "2026-11", lines: [{ id: "repair", kind: "free", description: "Repair", quantity: 1, unitPrice: 100, unit: "service" }], attachmentIds: [],
    } };
    const selfCreated = await api().mutateHotelPurchaseRequestHandler(request(fixture, selfCreate), services);
    const selfCommand = { action: "selfapprove", requestId: "restore-pr-self-approve", purchaseRequestId: selfCreated.purchaseRequestId, expectedRevision: selfCreated.revision, reason: "Fictional GM authority for recovery verification" };
    const selfApproved = await api().mutateHotelPurchaseRequestHandler(request(fixture, selfCommand), services);
    assert.equal(selfApproved.request.status, "approved"); assert.equal(selfApproved.request.selfApproval.approverUid, requester);
    replays.push({ command: selfCreate, result: json(selfCreated), approver: false }, { command: selfCommand, result: json(selfApproved), approver: false });
    const budgetPath = `hotels/${fixture.hotelUid}/purchaseBudgets/2026-10__repairs`;
    assertBudget((await database.doc(budgetPath).get()).data());
    proof[fixture.hotelUid] = { fixture, budgetPath, mixedRequestId, selfRequestId: selfApproved.purchaseRequestId, replays, records: await records(database, fixture) };
  }
  return proof;
}

export async function verifyPurchaseRequestRestoreProof({ database, auth, now }, proof) {
  const services = { firestore: database, auth, now, appBaseUrl: "https://restore.example.test" };
  assert.deepEqual(Object.keys(proof).sort(), fixtures.map((fixture) => fixture.hotelUid).sort());
  for (const entry of Object.values(proof)) {
    const { fixture, replays, budgetPath } = entry;
    assert.deepEqual(await records(database, fixture), entry.records, "Restored request snapshots, histories and financial receipts differ.");
    const before = await database.doc(budgetPath).get(); assertBudget(before.data());
    for (const replay of replays) {
      const result = await api().mutateHotelPurchaseRequestHandler(request(fixture, replay.command, replay.approver), services);
      assert.deepEqual(json(result), replay.result, "Restored request commands must return their original receipt.");
    }
    assert.deepEqual(await records(database, fixture), entry.records, "Exact request replay must not change approvals, history or budgets.");
    const after = await database.doc(budgetPath).get();
    assert.equal(after.updateTime.isEqual(before.updateTime), true, "Restored request replay must not debit the budget twice.");
    const mixed = await api().getHotelPurchaseRequestHandler(request(fixture, { purchaseRequestId: entry.mixedRequestId }), services);
    assert.equal(mixed.request.status, "pending"); assert.equal(mixed.request.totalMinor, 10000);
    assert.equal(mixed.request.supplierId, ""); assert.equal(mixed.request.supplier, null);
    assert.deepEqual(mixed.request.suppliers, [{ id: "restore-pr-supplier", name: "Fictional restore repair supplier" }, { id: "restore-pr-second-supplier", name: "Fictional restore parts supplier" }]);
    assert.deepEqual(mixed.request.lines.map((line) => line.supplier), mixed.request.suppliers);
    assert.deepEqual(mixed.history.find((event) => event.event === "submit").snapshot.lines, mixed.request.lines);
    const selfApproved = await api().getHotelPurchaseRequestHandler(request(fixture, { purchaseRequestId: entry.selfRequestId }), services);
    assert.equal(selfApproved.request.status, "approved"); assert.equal(selfApproved.request.selfApproval.reason, "Fictional GM authority for recovery verification");
    assert.equal(selfApproved.history[0].event, "selfapproved");
    const selfBudget = (await database.doc(`hotels/${fixture.hotelUid}/purchaseBudgets/2026-11__repairs`).get()).data();
    assert.equal(selfBudget.committedMinor, 10000); assert.equal(selfBudget.pendingMinor, 0);
    const otherFixture = fixtures.find((other) => other.hotelUid !== fixture.hotelUid);
    const first = replays.find((replay) => replay.command.purchaseRequestId);
    await assert.rejects(api().getHotelPurchaseRequestHandler({ ...request(otherFixture, {}), data: { hotelUid: fixture.hotelUid, purchaseRequestId: first.command.purchaseRequestId } }, services), { code: "permission-denied" });
  }
}
