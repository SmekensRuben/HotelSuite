const { HttpsError } = require("firebase-functions/v2/https");
const { requireDocumentId } = require("./subscriptions");
const { text } = require("./validation");
const { dateOnly } = require("./orders");

const RECEIVING_POLICY_VERSION = 1;
const LIMIT = 100000;
function milli(value, label, zero = true, code = "invalid-argument") {
  if (typeof value !== "number") throw new HttpsError(code, `${label} must be a number, with up to three decimals.`);
  const scaled = value * 1000;
  if (!Number.isFinite(value) || value < 0 || value > LIMIT
    || !zero && Math.round(scaled) <= 0 || Math.abs(scaled - Math.round(scaled)) > 1e-7) {
    throw new HttpsError(code, `${label} must be ${zero ? "non-negative" : "positive"}, at most ${LIMIT}, with up to three decimals.`);
  }
  return Math.round(scaled);
}
const quantity = (units) => units / 1000;
const stateOf = (lines) => lines.every((line) => line.acceptedQuantity >= line.orderedQuantity) ? "complete"
  : lines.some((line) => line.acceptedQuantity > 0 || line.rejectedQuantity > 0) ? "partial" : "awaiting";
function sourceLines(order) {
  if (!Array.isArray(order.products) || !order.products.length || order.products.length > 100) {
    throw new HttpsError("failed-precondition", "The order has no bounded, canonical product snapshot. Review this historical order.");
  }
  const seen = new Set();
  return order.products.map((product) => {
    if (!product || typeof product !== "object" || Array.isArray(product)) throw new HttpsError("failed-precondition", "An order product snapshot needs review.");
    if (typeof product.purchaseUnit !== "string" || !product.purchaseUnit.trim() || product.purchaseUnit.length > 200) {
      throw new HttpsError("failed-precondition", "The ordered purchase unit is unknown. Review this source snapshot.");
    }
    const supplierProductId = requireDocumentId(product.supplierProductId, "Order product ID");
    if (seen.has(supplierProductId)) throw new HttpsError("failed-precondition", "Duplicate order product IDs need review.");
    seen.add(supplierProductId);
    return { supplierProductId, orderedQuantity: quantity(milli(product.qtyPurchaseUnits, "Ordered quantity", false, "failed-precondition")),
      productName: String(product.supplierProductName || supplierProductId).slice(0, 200), purchaseUnit: String(product.purchaseUnit || "").slice(0, 200),
      acceptedQuantity: 0, rejectedQuantity: 0 };
  });
}
function receivingState(order) {
  const lines = sourceLines(order), receiving = order.receiving;
  if (!Object.hasOwn(order, "receiving")) {
    if (order.status !== "Ordered" || order.dispatchStatus !== "sent" || Object.hasOwn(order, "articles")
      || order.products.some((product) => Object.hasOwn(product, "received") || Object.hasOwn(product, "qtyReceivedPurchaseUnits"))) {
      throw new HttpsError("failed-precondition", "Historical receiving data has no verified opening baseline. Review it before receiving or closing this order.");
    }
    return { policyVersion: RECEIVING_POLICY_VERSION, state: "awaiting", eventCount: 0, lines };
  }
  if (!receiving || typeof receiving !== "object" || Array.isArray(receiving)
    || receiving.policyVersion !== RECEIVING_POLICY_VERSION || !Array.isArray(receiving.lines) || receiving.lines.length !== lines.length
    || !Number.isSafeInteger(receiving.eventCount) || receiving.eventCount < 1 || receiving.eventCount > 1000) {
    throw new HttpsError("failed-precondition", "The receiving policy or aggregate needs review.");
  }
  if (receiving.lines.some((line) => !line || typeof line !== "object" || Array.isArray(line))) throw new HttpsError("failed-precondition", "A receiving line needs review.");
  const stored = new Map(receiving.lines.map((line) => [line.supplierProductId, line]));
  if (stored.size !== lines.length) throw new HttpsError("failed-precondition", "Duplicate receiving product IDs need review.");
  for (const line of lines) {
    const previous = stored.get(line.supplierProductId);
    if (!previous || previous.orderedQuantity !== line.orderedQuantity) throw new HttpsError("failed-precondition", "The receiving aggregate no longer matches the ordered quantities.");
    line.acceptedQuantity = quantity(milli(previous.acceptedQuantity, "Stored accepted quantity", true, "failed-precondition"));
    line.rejectedQuantity = quantity(milli(previous.rejectedQuantity, "Stored rejected quantity", true, "failed-precondition"));
  }
  const state = stateOf(lines);
  if (order.status === "Finalized") {
    if (receiving.state !== "closed" || typeof receiving.finalizationReason !== "string") throw new HttpsError("failed-precondition", "Finalization evidence needs review.");
  } else if (!["Ordered", "Received"].includes(order.status) || receiving.state !== state
    || order.status !== (state === "complete" ? "Received" : "Ordered")) {
    throw new HttpsError("failed-precondition", "Order and receiving status disagree. Review this record.");
  }
  return { ...receiving, lines };
}
function normalizeReceipt(input) {
  const receivedOn = dateOnly(input.receivedOn);
  const deliveryReference = text(input.deliveryReference, "Delivery reference", 120, true);
  if (/[\r\n]/.test(deliveryReference)) throw new HttpsError("invalid-argument", "Use a single-line delivery reference.");
  const note = text(input.note ?? "", "Receipt note", 1000);
  if (!Array.isArray(input.lines) || !input.lines.length || input.lines.length > 100) throw new HttpsError("invalid-argument", "Choose 1–100 receipt lines.");
  const seen = new Set();
  const lines = input.lines.map((line) => {
    if (!line || typeof line !== "object" || Array.isArray(line)
      || Object.keys(line).some((key) => !["supplierProductId", "acceptedQuantity", "rejectedQuantity", "reason"].includes(key))) {
      throw new HttpsError("invalid-argument", "Unsupported receipt line field.");
    }
    const supplierProductId = requireDocumentId(line.supplierProductId, "supplierProductId");
    if (seen.has(supplierProductId)) throw new HttpsError("invalid-argument", "Merge duplicate receipt product lines.");
    seen.add(supplierProductId);
    const accepted = milli(line.acceptedQuantity, "Accepted quantity"), rejected = milli(line.rejectedQuantity, "Rejected quantity");
    if (accepted + rejected === 0) throw new HttpsError("invalid-argument", "Each receipt line needs an accepted or rejected quantity.");
    const reason = text(line.reason ?? "", "Line discrepancy reason", 300);
    if (rejected > 0 && !reason) throw new HttpsError("invalid-argument", "Explain rejected goods.");
    return { supplierProductId, acceptedQuantity: quantity(accepted), rejectedQuantity: quantity(rejected), reason };
  }).sort((a, b) => a.supplierProductId.localeCompare(b.supplierProductId));
  return { receivedOn, deliveryReference, note, lines };
}
function applyReceipt(previous, receipt) {
  const lines = previous.lines.map((line) => ({ ...line }));
  for (const incoming of receipt.lines) {
    const line = lines.find((item) => item.supplierProductId === incoming.supplierProductId);
    if (!line) throw new HttpsError("invalid-argument", "Receive only products in the frozen order.");
    const accepted = milli(line.acceptedQuantity, "Accepted total") + milli(incoming.acceptedQuantity, "Accepted quantity");
    const rejected = milli(line.rejectedQuantity, "Rejected total") + milli(incoming.rejectedQuantity, "Rejected quantity");
    if (accepted > milli(line.orderedQuantity, "Ordered quantity") && !incoming.reason) throw new HttpsError("invalid-argument", "Explain accepted overdelivery.");
    line.acceptedQuantity = quantity(accepted); line.rejectedQuantity = quantity(rejected);
    milli(line.acceptedQuantity, "Accepted total"); milli(line.rejectedQuantity, "Rejected total");
  }
  return nextState(previous, lines);
}
function applyReversal(previous, original) {
  if (original.kind !== "receipt" || original.policyVersion !== RECEIVING_POLICY_VERSION || !Array.isArray(original.lines)
    || !original.lines.length || original.lines.length > 100 || original.lines.some((line) => !line || typeof line !== "object")
    || new Set(original.lines.map((line) => line.supplierProductId)).size !== original.lines.length) {
    throw new HttpsError("failed-precondition", "Only a verified receipt can be reversed.");
  }
  const lines = previous.lines.map((line) => ({ ...line }));
  for (const incoming of original.lines) {
    const line = lines.find((item) => item.supplierProductId === incoming.supplierProductId);
    if (!line) throw new HttpsError("failed-precondition", "Receipt and order products disagree.");
    const accepted = milli(line.acceptedQuantity, "Accepted total") - milli(incoming.acceptedQuantity, "Original accepted quantity");
    const rejected = milli(line.rejectedQuantity, "Rejected total") - milli(incoming.rejectedQuantity, "Original rejected quantity");
    if (accepted < 0 || rejected < 0) throw new HttpsError("failed-precondition", "The receiving totals cannot reconcile with this reversal.");
    line.acceptedQuantity = quantity(accepted); line.rejectedQuantity = quantity(rejected);
  }
  return nextState(previous, lines);
}
function nextState(previous, lines) {
  if (previous.state === "closed") throw new HttpsError("failed-precondition", "Finalized receiving history is immutable.");
  if (previous.eventCount >= 1000) throw new HttpsError("resource-exhausted", "This order reached the receiving-event limit. Review its history.");
  return { policyVersion: RECEIVING_POLICY_VERSION, lines, state: stateOf(lines), eventCount: previous.eventCount + 1 };
}
function summary(state) {
  return state.lines.map((line) => ({ ...line,
    outstandingQuantity: quantity(Math.max(0, milli(line.orderedQuantity, "Ordered quantity") - milli(line.acceptedQuantity, "Accepted quantity"))),
    excessQuantity: quantity(Math.max(0, milli(line.acceptedQuantity, "Accepted quantity") - milli(line.orderedQuantity, "Ordered quantity"))) }));
}
function finalizeState(previous, { acceptShortfall, reason }) {
  if (typeof acceptShortfall !== "boolean") throw new HttpsError("invalid-argument", "Confirm whether outstanding goods are being closed.");
  reason = text(reason ?? "", "Finalization reason", 1000);
  const lines = summary(previous), shortfall = lines.some((line) => line.outstandingQuantity > 0);
  if (shortfall && !acceptShortfall) throw new HttpsError("failed-precondition", "Explicitly acknowledge the outstanding quantities before closing this order.");
  if (lines.some((line) => line.outstandingQuantity > 0 || line.excessQuantity > 0 || line.rejectedQuantity > 0) && !reason) {
    throw new HttpsError("invalid-argument", "Explain the receiving discrepancies before finalizing.");
  }
  return { ...nextState(previous, previous.lines), state: "closed", finalizationReason: reason, closedWithShortfall: shortfall };
}
module.exports = { RECEIVING_POLICY_VERSION, milli, receivingState, normalizeReceipt, applyReceipt, applyReversal, finalizeState, summary };
