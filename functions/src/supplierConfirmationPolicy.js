const { HttpsError } = require("firebase-functions/v2/https");
const { requireDocumentId } = require("./subscriptions");
const { text, digest } = require("./validation");
const { dateOnly } = require("./orders");
const { decimal, netPrice } = require("./productPolicy");

const POLICY_VERSION = 1;
const EVENT_LIMIT = 500;
const lineKey = (line) => line.orderLineId ?? line.supplierProductId;
function canonical(value) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonical);
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}
// Firestore map-key order is not a commercial change (including after restore).
const stableDigest = (...values) => digest(...values.map(canonical));
const fail = (message, code = "invalid-argument") => { throw new HttpsError(code, message); };
function fields(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key))) fail(`Unsupported ${label} fields.`);
}
function quantity(value) {
  const result = decimal(value, "Confirmed quantity", { maximum: 100000 });
  if (Math.abs(result * 1000 - Math.round(result * 1000)) > 1e-7) fail("Confirmed quantities support at most three decimals.");
  return result;
}
function singleLine(value, label, max) {
  const result = text(value, label, max, true);
  if (/[\r\n]/.test(result)) fail(`${label} must fit on one line.`);
  return result;
}
function submittedContract(order) {
  if (!order || !["Ordered", "Received", "Finalized"].includes(order.status) || order.dispatchStatus !== "sent"
    || Object.hasOwn(order, "articles") || !Array.isArray(order.products) || !order.products.length || order.products.length > 100) {
    fail("Supplier confirmation requires a verified, dispatched order snapshot.", "failed-precondition");
  }
  const currency = order.currency;
  if (!/^[A-Z]{3}$/.test(currency ?? "")) fail("The submitted order currency needs review.", "failed-precondition");
  const deliveryDate = dateOnly(order.deliveryDate);
  const seen = new Set();
  const lines = order.products.map((product) => {
    if (!product || typeof product !== "object" || Array.isArray(product)) fail("The submitted product snapshot needs review.", "failed-precondition");
    const supplierProductId = requireDocumentId(product.supplierProductId, "Submitted product ID");
    const identity = product.orderLineId == null ? {} : { orderLineId: requireDocumentId(product.orderLineId, "Submitted order line ID"),
      purchaseOptionId: requireDocumentId(product.purchaseOptionId ?? "default", "Submitted purchase option ID") };
    const key = lineKey({ supplierProductId, ...identity });
    if (seen.has(key)) fail("Duplicate submitted order lines need review.", "failed-precondition");
    seen.add(key);
    const orderedQuantity = quantity(product.qtyPurchaseUnits);
    if (orderedQuantity === 0) fail("The submitted quantity must be positive.", "failed-precondition");
    if (product.currency != null && product.currency !== currency) fail("Submitted product currencies disagree.", "failed-precondition");
    const priceBasis = product.priceBasis ?? order.priceBasis ?? "unknown";
    if (!["net", "gross", "unknown"].includes(priceBasis)) fail("The submitted price basis needs review.", "failed-precondition");
    const vatRate = product.vatRate == null ? null : decimal(product.vatRate, "Submitted VAT rate", { maximum: 1 });
    const orderedPrice = product.pricePerPurchaseUnit == null ? null : decimal(product.pricePerPurchaseUnit, "Submitted price", { maximum: 1000000 });
    return { supplierProductId, ...identity, productName: text(product.supplierProductName || supplierProductId, "Product name", 200, true),
      supplierSku: typeof product.supplierSku === "string" ? product.supplierSku.slice(0, 150) : null,
      purchaseUnit: text(product.purchaseUnit, "Submitted purchase unit", 200, true), orderedQuantity, orderedPrice,
      deliveryDate, currency, priceBasis, vatRate };
  });
  return { supplierId: requireDocumentId(order.supplierId, "Submitted supplier ID"), currency, deliveryDate, lines,
    sourceDigest: stableDigest(order.supplierId, currency, deliveryDate, order.products) };
}
function normalizeResponse(input, order) {
  fields(input, ["responseType", "channel", "supplierReference", "respondedOn", "note", "lines"], "supplier response");
  const contract = submittedContract(order);
  if (!["accepted", "changes-proposed", "rejected"].includes(input.responseType)) fail("Choose acceptance, proposed changes or rejection.");
  if (!["email", "sftp", "portal", "phone", "other"].includes(input.channel)) fail("Choose where the supplier response was received.");
  const result = { responseType: input.responseType, channel: input.channel,
    supplierReference: singleLine(input.supplierReference, "Supplier response reference", 120), respondedOn: dateOnly(input.respondedOn),
    note: text(input.note ?? "", "Supplier response note", 1000, input.responseType === "rejected") };
  if (!Array.isArray(input.lines) || input.responseType === "rejected" && input.lines.length !== 0
    || input.responseType !== "rejected" && input.lines.length !== contract.lines.length) fail("Record a complete response for every submitted line; a rejected order has no proposed lines.");
  const seen = new Set();
  const lines = input.lines.map((incoming) => {
    fields(incoming, ["supplierProductId", "orderLineId", "confirmedQuantity", "deliveryDate", "priceMode", "pricePerPurchaseUnit", "substitute", "reason"], "supplier response line");
    const key = lineKey(incoming), original = contract.lines.find((line) => lineKey(line) === key);
    if (!original || original.supplierProductId !== incoming.supplierProductId || seen.has(key)) fail("Use each submitted order line exactly once, including its purchase option.");
    seen.add(key);
    if (!["as-ordered", "quoted", "unknown"].includes(incoming.priceMode)) fail("Declare whether the package price is as ordered, quoted or unknown.");
    if (incoming.priceMode !== "quoted" && Object.hasOwn(incoming, "pricePerPurchaseUnit")) fail("Only a quoted price may supply a numeric package price.");
    const confirmedQuantity = quantity(incoming.confirmedQuantity);
    const deliveryDate = incoming.deliveryDate === null ? null : dateOnly(incoming.deliveryDate);
    const pricePerPurchaseUnit = incoming.priceMode === "as-ordered" ? original.orderedPrice
      : incoming.priceMode === "unknown" ? null : decimal(incoming.pricePerPurchaseUnit, "Confirmed package price", { maximum: 1000000 });
    let substitute = null;
    if (incoming.substitute != null) {
      fields(incoming.substitute, ["description", "supplierSku", "purchaseUnit"], "replacement proposal");
      substitute = { description: singleLine(incoming.substitute.description, "Replacement description", 200),
        supplierSku: singleLine(incoming.substitute.supplierSku, "Replacement supplier SKU", 150),
        purchaseUnit: singleLine(incoming.substitute.purchaseUnit, "Replacement purchase unit", 200) };
    }
    const reasons = [confirmedQuantity !== original.orderedQuantity ? "quantity" : null,
      deliveryDate !== original.deliveryDate ? "delivery-date" : null,
      pricePerPurchaseUnit !== original.orderedPrice || incoming.priceMode === "unknown" ? "price" : null,
      substitute ? "replacement" : null].filter(Boolean);
    const reason = text(incoming.reason ?? "", "Line change explanation", 300, reasons.length > 0);
    return { ...original, confirmedQuantity, confirmedDeliveryDate: deliveryDate, priceMode: incoming.priceMode, pricePerPurchaseUnit,
      netPricePerPurchaseUnit: netPrice(pricePerPurchaseUnit, original.priceBasis, original.vatRate), substitute, reason, deviations: reasons };
  }).sort((a, b) => lineKey(a).localeCompare(lineKey(b)));
  const changes = lines.some((line) => line.deviations.length);
  if (result.responseType === "accepted" && changes) fail("A supplier acceptance must match all submitted terms. Record deviations as proposed changes.");
  if (result.responseType === "changes-proposed" && !changes) fail("Proposed changes must contain at least one actual deviation.");
  return { ...result, lines, sourceDigest: contract.sourceDigest };
}
function responseInput(response) {
  return { responseType: response.responseType, channel: response.channel, supplierReference: response.supplierReference,
    respondedOn: response.respondedOn, note: response.note, lines: response.lines.map((line) => ({ supplierProductId: line.supplierProductId,
      ...(line.orderLineId ? { orderLineId: line.orderLineId } : {}), confirmedQuantity: line.confirmedQuantity,
      deliveryDate: line.confirmedDeliveryDate, priceMode: line.priceMode,
      ...(line.priceMode === "quoted" ? { pricePerPurchaseUnit: line.pricePerPurchaseUnit } : {}), substitute: line.substitute, reason: line.reason })) };
}
function verifiedResponse(event, order, hotelUid, orderId) {
  if (!event || event.policyVersion !== POLICY_VERSION || event.kind !== "response" || event.hotelUid !== hotelUid || event.orderId !== orderId
    || typeof event.actorUid !== "string" || !Number.isSafeInteger(event.revision) || event.revision < 1 || !event.response) fail("Supplier response evidence needs reconciliation.", "failed-precondition");
  try {
    const response = normalizeResponse(responseInput(event.response), order);
    if (stableDigest(response) !== stableDigest(event.response)) fail("Supplier response and submitted terms disagree.", "failed-precondition");
    return response;
  } catch (error) { if (!(error instanceof HttpsError)) throw error; fail("Supplier response and submitted terms need reconciliation.", "failed-precondition"); }
}
function normalizeReview(input, response) {
  fields(input, ["responseId", "decision", "reason"], "supplier response review");
  const responseId = requireDocumentId(input.responseId, "Supplier response ID");
  if (!["accept", "follow-up"].includes(input.decision)) fail("Accept the proposed terms or request supplier follow-up.");
  if (response.responseType === "accepted") fail("Matching supplier acceptance does not need a change review.");
  if (input.decision === "accept" && (response.responseType === "rejected" || response.lines.some((line) => line.substitute))) {
    fail("A rejected order or replacement proposal needs supplier follow-up and a verified purchase snapshot; it cannot authorize original-product receipts.", "failed-precondition");
  }
  return { responseId, decision: input.decision, reason: text(input.reason, "Hotel review reason", 1000, true) };
}
function verifiedReview(event, response, responseId, hotelUid, orderId) {
  if (!event || event.policyVersion !== POLICY_VERSION || event.kind !== "review" || event.hotelUid !== hotelUid || event.orderId !== orderId
    || typeof event.actorUid !== "string" || !Number.isSafeInteger(event.revision) || event.revision < 1 || event.review?.responseId !== responseId) {
    fail("Supplier response review evidence needs reconciliation.", "failed-precondition");
  }
  return normalizeReview(event.review, response);
}
function receivingTerms(state, receipt, receivedLines = []) {
  if (!state.response) return null; // Historical dispatch has no invented supplier acknowledgement.
  if (!receipt.lines.some((line) => line.acceptedQuantity > 0)) return null;
  const response = state.response;
  if (response.responseType === "rejected" || response.responseType === "changes-proposed" && state.review?.decision !== "accept") {
    fail("Review the supplier response and resolve its rejection or proposed changes before accepting goods.", "failed-precondition");
  }
  if (response.lines.some((line) => line.substitute)) fail("Replacement goods need a verified purchase snapshot before recording original-product inventory.", "failed-precondition");
  for (const incoming of receipt.lines) {
    if (!(incoming.acceptedQuantity > 0)) continue;
    const confirmed = response.lines.find((line) => lineKey(line) === lineKey(incoming));
    const received = receivedLines.find((line) => lineKey(line) === lineKey(incoming))?.acceptedQuantity ?? 0;
    // Physical goods can exceed a promise, but the operator must acknowledge it.
    if (confirmed && Math.round((received + incoming.acceptedQuantity) * 1000) > Math.round(confirmed.confirmedQuantity * 1000) && !incoming.reason?.trim()) {
      fail("Explain accepted goods beyond the supplier-confirmed quantity.");
    }
  }
  return { policyVersion: POLICY_VERSION, responseId: state.responseId, reviewId: state.reviewId,
    sourceDigest: response.sourceDigest, lines: response.lines.map((line) => ({ supplierProductId: line.supplierProductId,
      ...(line.orderLineId ? { orderLineId: line.orderLineId } : {}), pricePerPurchaseUnit: line.pricePerPurchaseUnit,
      confirmedQuantity: line.confirmedQuantity, netPricePerPurchaseUnit: line.netPricePerPurchaseUnit, priceMode: line.priceMode, priceBasis: line.priceBasis, vatRate: line.vatRate, currency: line.currency })) };
}
module.exports = { POLICY_VERSION, EVENT_LIMIT, lineKey, stableDigest, submittedContract, normalizeResponse, responseInput, verifiedResponse,
  normalizeReview, verifiedReview, receivingTerms };
