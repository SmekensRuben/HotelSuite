const { test } = require("node:test");
const assert = require("node:assert/strict");
const { milli, receivingState, normalizeReceipt, applyReceipt, applyReversal, finalizeState, summary } = require("./orderReceivingPolicy");
const { compileMemberAccess } = require("./modulePolicy");
const { dispatchOrderHandler } = require("./sftpDispatch");
const order = () => ({ status: "Ordered", dispatchStatus: "sent", products: [
  { supplierProductId: "coffee", qtyPurchaseUnits: 2.5, supplierProductName: "Coffee", purchaseUnit: "box" },
  { supplierProductId: "milk", qtyPurchaseUnits: 3, supplierProductName: "Milk", purchaseUnit: "case" },
] });
const receipt = (accepted = 1.25, rejected = 0, reason = "") => normalizeReceipt({ receivedOn: "2026-10-12", deliveryReference: "DN-1",
  lines: [{ supplierProductId: "coffee", acceptedQuantity: accepted, rejectedQuantity: rejected, reason }] });
const throwsCode = (callback, code) => assert.throws(callback, (error) => error.code === code);
test("partial deliveries keep rejected goods separate and integer thousandths exact", () => {
  const opening = receivingState(order());
  const first = applyReceipt(opening, receipt(1.25, 0.25, "Damaged packaging"));
  assert.equal(first.state, "partial");
  assert.deepEqual(summary(first).map(({ acceptedQuantity, rejectedQuantity, outstandingQuantity }) =>
    ({ acceptedQuantity, rejectedQuantity, outstandingQuantity })), [
    { acceptedQuantity: 1.25, rejectedQuantity: 0.25, outstandingQuantity: 1.25 },
    { acceptedQuantity: 0, rejectedQuantity: 0, outstandingQuantity: 3 }]);
  const complete = applyReceipt(first, normalizeReceipt({ receivedOn: "2026-10-13", deliveryReference: "DN-2", lines: [
    { supplierProductId: "coffee", acceptedQuantity: 1.25, rejectedQuantity: 0 },
    { supplierProductId: "milk", acceptedQuantity: 3, rejectedQuantity: 0 } ] }));
  assert.equal(complete.state, "complete");
  assert.equal(complete.lines[0].rejectedQuantity, 0.25);
  assert.equal(opening.lines[0].acceptedQuantity, 0);
});
test("three decimal additions and reversal reconcile without floating-point drift", () => {
  let state = receivingState(order());
  for (const amount of [0.1, 0.2, 0.001]) state = applyReceipt(state, receipt(amount));
  assert.equal(state.lines[0].acceptedQuantity, 0.301);
  const reversed = applyReversal(state, { kind: "receipt", policyVersion: 1, lines: receipt(0.2).lines });
  assert.equal(reversed.lines[0].acceptedQuantity, 0.101);
});
test("overdelivery needs an explicit line reason and is retained for supervisor review", () => {
  const state = receivingState(order());
  throwsCode(() => applyReceipt(state, receipt(3)), "invalid-argument");
  const over = applyReceipt(state, receipt(3, 0, "Accepted extra box"));
  assert.equal(summary(over)[0].excessQuantity, 0.5);
  throwsCode(() => finalizeState(over, { acceptShortfall: true, reason: "" }), "invalid-argument");
});
test("closing an incomplete order requires explicit shortfall acknowledgement and a reason", () => {
  const partial = applyReceipt(receivingState(order()), receipt());
  throwsCode(() => finalizeState(partial, { acceptShortfall: false, reason: "Supplier cannot complete" }), "failed-precondition");
  throwsCode(() => finalizeState(partial, { acceptShortfall: true, reason: "" }), "invalid-argument");
  const closed = finalizeState(partial, { acceptShortfall: true, reason: "Supplier cannot complete" });
  assert.equal(closed.state, "closed"); assert.equal(closed.closedWithShortfall, true);
  assert.equal(summary(closed)[0].outstandingQuantity, 1.25);
  throwsCode(() => applyReceipt(closed, receipt()), "failed-precondition");
});
test("complete clean receiving can finalize without inventing discrepancies", () => {
  const one = order(); one.products = one.products.slice(0, 1);
  const state = applyReceipt(receivingState(one), receipt(2.5));
  const finalized = finalizeState(state, { acceptShortfall: false, reason: "" });
  assert.equal(finalized.closedWithShortfall, false);
});
test("unknown, non-numeric, zero source and out-of-bound quantities cannot silently become zero", () => {
  for (const value of [undefined, null, "1", true, { valueOf: "invalid", toString: null }, NaN, Infinity, -1, 100001, 0.0001]) throwsCode(() => milli(value, "Quantity"), "invalid-argument");
  for (const value of [0, 1e-12]) { const bad = order(); bad.products[0].qtyPurchaseUnits = value; throwsCode(() => receivingState(bad), "failed-precondition"); }
  throwsCode(() => receipt(0), "invalid-argument");
});
test("foreign IDs, duplicate lines, spoofed fields and impossible dates are rejected", () => {
  const valid = { receivedOn: "2026-10-12", deliveryReference: "DN-1", lines: receipt().lines };
  throwsCode(() => normalizeReceipt({ ...valid, receivedOn: "2026-02-31" }), "invalid-argument");
  throwsCode(() => normalizeReceipt({ ...valid, lines: [...valid.lines, ...valid.lines] }), "invalid-argument");
  throwsCode(() => normalizeReceipt({ ...valid, lines: [{ ...valid.lines[0], actorUid: "spoof" }] }), "invalid-argument");
  throwsCode(() => applyReceipt(receivingState(order()), { ...valid, lines: [{ ...valid.lines[0], supplierProductId: "foreign" }] }), "invalid-argument");
  throwsCode(() => normalizeReceipt({ ...valid, deliveryReference: "" }), "invalid-argument");
});
test("historical receipts and submitted-but-unconfirmed dispatch have no invented opening baseline", () => {
  for (const patch of [{ status: "Received" }, { status: "Finalized" }, { status: "Created" }, { dispatchStatus: "needs-review" }, { articles: [] }, { receiving: null }, { receiving: 0 }]) {
    throwsCode(() => receivingState({ ...order(), ...patch }), "failed-precondition");
  }
  const bad = order(); bad.products[0].received = 1;
  throwsCode(() => receivingState(bad), "failed-precondition");
});
test("persisted aggregates must reconcile with source quantities, IDs, policy and status", () => {
  const base = order(), state = applyReceipt(receivingState(base), receipt());
  assert.equal(receivingState({ ...base, receiving: state }).state, "partial");
  for (const patch of [{ policyVersion: 99 }, { eventCount: 0 }, { state: "complete" }, { lines: [] }, { lines: [null, null] }]) {
    throwsCode(() => receivingState({ ...base, receiving: { ...state, ...patch } }), "failed-precondition");
  }
  const changed = order(); changed.products[0].qtyPurchaseUnits = 4;
  throwsCode(() => receivingState({ ...changed, receiving: state }), "failed-precondition");
});
test("reversal cannot produce negative totals or reverse a non-receipt", () => {
  const state = applyReceipt(receivingState(order()), receipt());
  throwsCode(() => applyReversal(state, { kind: "receipt", policyVersion: 1, lines: receipt(2).lines }), "failed-precondition");
  throwsCode(() => applyReversal(state, { kind: "finalization", policyVersion: 1, lines: [] }), "failed-precondition");
});
test("explicit new roles grant receiving rights; legacy manager/buyer/admin roles do not silently gain them", () => {
  const subscription = { modules: ["procurement"], modulePolicyVersion: 1 };
  const receiver = compileMemberAccess({ moduleRoles: { procurement: ["receiver"] } }, subscription);
  assert.ok(receiver.permissions.includes("orders.receive")); assert.ok(!receiver.permissions.includes("orders.finalize"));
  const supervisor = compileMemberAccess({ moduleRoles: { procurement: ["receiving-supervisor"] } }, subscription);
  assert.ok(supervisor.permissions.includes("orders.receive") && supervisor.permissions.includes("orders.finalize"));
  for (const role of ["buyer", "module-manager", "stock-controller"]) {
    const access = compileMemberAccess({ hotelAdmin: true, moduleRoles: { procurement: [role] } }, subscription);
    assert.equal(access.permissions.includes("orders.receive"), false); assert.equal(access.permissions.includes("orders.finalize"), false);
  }
});
test("receiving-only order updates cannot restart an already-confirmed supplier dispatch", async () => {
  const source = { ...order(), dispatchRequestId: "confirmed-dispatch" };
  await dispatchOrderHandler({ params: { hotelUid: "hotel-a", orderId: "order" }, data: {
    before: { exists: true, data: () => source }, after: { exists: true, data: () => ({ ...source, status: "Received", receiving: { eventCount: 1 } }) },
  } }, { firestore: { doc: () => { throw new Error("Unexpected supplier dispatch after receiving"); } } });
});
