export const supplierResponseLabels = { accepted: "Supplier accepted", "changes-proposed": "Supplier proposed changes", rejected: "Supplier rejected" };
export function supplierConfirmationStatus(order) {
  const value = order.supplierConfirmation;
  if (value === undefined) return { label: ["Ordered", "Received", "Finalized"].includes(order.status) ? "No response recorded" : "Awaiting dispatch", attention: order.status === "Ordered" };
  if (!value || value.policyVersion !== 1 || !Object.hasOwn(supplierResponseLabels, value.responseType)
    || !Number.isSafeInteger(value.eventCount) || value.eventCount < 1 || value.eventCount > 500
    || typeof value.responseId !== "string" || !value.responseId || value.responseId.includes("/")
    || !["not-required", "pending", "accepted", "follow-up"].includes(value.reviewState)
    || value.responseType === "accepted" && (value.reviewState !== "not-required" || value.reviewId !== null)
    || value.responseType !== "accepted" && value.reviewState === "not-required"
    || ["accepted", "follow-up"].includes(value.reviewState) && (typeof value.reviewId !== "string" || !value.reviewId)
    || value.reviewState === "pending" && value.reviewId !== null
    || value.responseType === "rejected" && value.reviewState === "accepted"
    || value.requiresAttention !== (value.responseType !== "accepted" && value.reviewState !== "accepted")) return { label: "Confirmation needs review", attention: true, invalid: true };
  const suffix = value.reviewState === "pending" ? " · needs review" : value.reviewState === "accepted" ? " · hotel accepted" : value.reviewState === "follow-up" ? " · follow up" : "";
  return { label: `${supplierResponseLabels[value.responseType]}${suffix}`, attention: value.requiresAttention && !["Finalized", "Canceled"].includes(order.status) };
}
