export const PURCHASE_REQUEST_STATUSES = ["draft", "pending", "returned", "approved", "rejected", "withdrawn", "canceled"];
export const purchaseRequestStatusLabel = (value) => ({ draft: "Draft", pending: "Awaiting approval", returned: "Returned for changes", approved: "Approved", rejected: "Rejected", withdrawn: "Withdrawn", canceled: "Canceled" }[value] || value || "Unknown");
export function purchaseRequestMoney(minor, currency = "EUR") {
  if (!Number.isFinite(Number(minor)) || minor == null) return "Not available";
  try { return new Intl.NumberFormat("en", { style: "currency", currency }).format(Number(minor) / 100); }
  catch { return `${(Number(minor) / 100).toFixed(2)} ${currency}`; }
}
export function purchaseRequestTime(millis) {
  const date = new Date(millis);
  return millis && Number.isFinite(date.getTime()) ? date.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "—";
}
export function purchaseRequestUnitPrice(value, currency = "EUR") {
  if (value === "" || value == null || !Number.isFinite(Number(value))) return "Not available";
  return new Intl.NumberFormat("en", { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(Number(value));
}
export function purchaseRequestPriceValidity(value) {
  return ({ current: "Current", unknown: "Dates unknown", future: "Not yet valid", expired: "Expired", invalid: "Dates need correction", unavailable: "No usable price", "delivery-date-required": "Delivery date needed" })[value] || "Needs review";
}
export function purchaseRequestPriceReviewReason(value) {
  return ({ "supplier-pricing-date-agreement-unknown": "Confirm whether the supplier prices by order or delivery date.", "price-source-date-unknown": "The price source date is unknown.", "purchase-option-price-confirmation-unknown": "The purchase option price needs confirmation.", "delivery-date-required": "A delivery-date agreement needs an explicit quotation for this internal request.", "price-validity-unknown": "The price validity dates are unknown.", "price-validity-future": "The price is not yet valid.", "price-validity-expired": "The price has expired.", "price-validity-unavailable": "No current unit price is available.", "price-validity-invalid": "Correct the price validity dates before using this source." })[value] || "Confirm the current quotation with the supplier.";
}
// Historical requests predate per-line suppliers. Only an absent supplierId may
// inherit their saved header; an explicit blank is a deliberately unassigned line.
export function purchaseRequestLineSupplier(line, request) {
  const hasSupplierId = Object.prototype.hasOwnProperty.call(line || {}, "supplierId");
  const supplierId = hasSupplierId ? String(line.supplierId || "").trim() : null;
  if (hasSupplierId && !supplierId) return null;
  if (line?.supplier?.id && (!hasSupplierId || line.supplier.id === supplierId)) return { id: line.supplier.id, name: line.supplier.name || "" };
  if (hasSupplierId) return { id: supplierId, name: "" };
  return request?.supplier?.id ? { id: request.supplier.id, name: request.supplier.name || "" } : null;
}
export function purchaseRequestLineSupplierLabel(line, request) {
  const supplier = purchaseRequestLineSupplier(line, request);
  return supplier ? supplier.name || "Supplier details unavailable" : "Supplier not selected";
}
export function purchaseRequestSupplierSummary(request) {
  const lines = Array.isArray(request?.lines) ? request.lines : [];
  const suppliers = [], seen = new Set();
  let unassignedLineCount = 0;
  const candidates = lines.length ? lines.map((line) => purchaseRequestLineSupplier(line, request))
    : Array.isArray(request?.suppliers) && request.suppliers.length ? request.suppliers : request?.supplier ? [request.supplier] : [];
  for (const supplier of candidates) {
    if (!supplier?.id) { unassignedLineCount += 1; continue; }
    if (!seen.has(supplier.id)) { seen.add(supplier.id); suppliers.push({ id: supplier.id, name: supplier.name || "" }); }
  }
  const names = suppliers.map((supplier) => supplier.name || "Supplier details unavailable");
  const label = suppliers.length > 1 ? `Multiple suppliers (${suppliers.length})` : names[0] || "Supplier not selected";
  const details = [...(suppliers.length > 1 ? [names.join(" · ")] : []), ...(unassignedLineCount ? [`${unassignedLineCount} ${unassignedLineCount === 1 ? "line without a supplier" : "lines without a supplier"}`] : [])].join(" · ");
  return { suppliers, unassignedLineCount, label, details };
}
export function requestLineTotalMinor(lines) {
  const micro = (value, positive) => {
    const raw = typeof value === "number" && Number.isFinite(value) ? String(value) : value;
    if (typeof raw !== "string" || !/^\d{1,7}(\.\d{1,6})?$/.test(raw)) return null;
    const [whole, fraction = ""] = raw.split(".");
    const result = BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, "0"));
    return result > 1000000000000n || (positive && result === 0n) ? null : result;
  };
  let total = 0n;
  for (const line of lines || []) {
    const quantity = micro(line.quantity, true), price = micro(line.unitPrice, false);
    if (quantity === null || price === null) return null;
    total += (quantity * price + 5000000000n) / 10000000000n;
    if (total > 100000000000000n) return null;
  }
  return Number(total);
}
export function requestBudgetImpact(budget, totalMinor, heldMinor = 0) {
  if (!budget || budget.exists === false) return { missing: true, remainingMinor: null, afterMinor: null, overBudget: false };
  const remaining = Number(budget.remainingMinor ?? (Number(budget.budgetMinor || 0) - Number(budget.openingUsedMinor || 0) - Number(budget.pendingMinor || 0) - Number(budget.committedMinor || 0)));
  const afterMinor = remaining + Number(heldMinor || 0) - Number(totalMinor || 0);
  return { missing: false, remainingMinor: remaining, afterMinor, overBudget: afterMinor < 0 };
}
export function eligibleRequestApprovers(context, requesterUid, stepId, totalMinor, overBudget = false) {
  return (context?.approvers || []).filter((user) => user.uid !== requesterUid && user.eligible !== false && (!stepId || (user.stepIds || []).includes(stepId)) && (user.limitMinor == null || Number(user.limitMinor) >= totalMinor) && (!overBudget || user.canApproveOverBudget === true));
}
