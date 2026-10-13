import { functions, httpsCallable } from "../firebaseConfig";
import { poolProcurementRead } from "./procurementReadPool";
import { supplierConfirmationStatus } from "../utils/supplierConfirmationDisplay";
const id = (value) => typeof value === "string" && Boolean(value.trim()) && value.length <= 128 && !value.includes("/");
const text = (value, max) => typeof value === "string" && value.length <= max;
const date = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const number = (value, max) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max;
const price = (value) => value === null || number(value, 1000000);
const key = (line) => line?.orderLineId || line?.supplierProductId;
function validLine(line) {
  return line && id(line.supplierProductId) && (line.orderLineId === undefined || id(line.orderLineId))
    && text(line.productName, 200) && Boolean(line.productName.trim()) && text(line.purchaseUnit, 200) && Boolean(line.purchaseUnit.trim())
    && number(line.orderedQuantity, 100000) && line.orderedQuantity > 0 && price(line.orderedPrice)
    && date(line.deliveryDate) && typeof line.currency === "string" && /^[A-Z]{3}$/.test(line.currency)
    && ["net", "gross", "unknown"].includes(line.priceBasis) && (line.vatRate === null || number(line.vatRate, 1));
}
function validResponse(response) {
  if (!response || !["accepted", "changes-proposed", "rejected"].includes(response.responseType)
    || !["email", "sftp", "portal", "phone", "other"].includes(response.channel)
    || !text(response.supplierReference, 120) || !response.supplierReference.trim() || !date(response.respondedOn)
    || !text(response.note, 1000) || !text(response.sourceDigest, 64) || !/^[a-f0-9]{64}$/.test(response.sourceDigest)
    || !Array.isArray(response.lines) || response.lines.length > 100 || new Set(response.lines.map(key)).size !== response.lines.length) return false;
  if (response.responseType === "rejected") return response.lines.length === 0 && Boolean(response.note.trim());
  return response.lines.length > 0 && response.lines.every((line) => validLine(line) && number(line.confirmedQuantity, 100000)
    && (line.confirmedDeliveryDate === null || date(line.confirmedDeliveryDate)) && ["as-ordered", "quoted", "unknown"].includes(line.priceMode)
    && price(line.pricePerPurchaseUnit) && price(line.netPricePerPurchaseUnit) && text(line.reason, 300)
    && (line.priceMode !== "unknown" || line.pricePerPurchaseUnit === null && line.netPricePerPurchaseUnit === null)
    && (line.priceMode !== "quoted" || line.pricePerPurchaseUnit !== null)
    && (line.priceMode !== "as-ordered" || line.pricePerPurchaseUnit === line.orderedPrice)
    && (line.priceBasis !== "unknown" || line.netPricePerPurchaseUnit === null)
    && (line.substitute === null || line.substitute && ["description", "supplierSku", "purchaseUnit"].every((field) => text(line.substitute[field], 200) && line.substitute[field].trim()))
    && Array.isArray(line.deviations) && line.deviations.every((reason) => ["quantity", "delivery-date", "price", "replacement"].includes(reason))
    && (!line.deviations.length || Boolean(line.reason.trim())))
    && (response.responseType === "accepted" ? response.lines.every((line) => !line.deviations.length && line.confirmedQuantity === line.orderedQuantity
      && line.confirmedDeliveryDate === line.deliveryDate && line.pricePerPurchaseUnit === line.orderedPrice && !line.substitute)
      : response.lines.some((line) => line.deviations.length));
}
const validReview = (review) => review && id(review.responseId) && ["accept", "follow-up"].includes(review.decision) && text(review.reason, 1000) && Boolean(review.reason.trim());
const validSummary = (summary) => summary && id(summary.responseId) && (summary.reviewId === null || id(summary.reviewId)) && date(summary.respondedOn)
  && !supplierConfirmationStatus({ supplierConfirmation: summary }).invalid;
export function getSupplierConfirmations(input) {
  if (!id(input?.hotelUid) || !id(input?.orderId) || input.afterEventId != null && !id(input.afterEventId)) throw new Error("Choose a valid hotel and order before loading supplier responses.");
  return poolProcurementRead(input.hotelUid, `supplier-confirmations:${JSON.stringify(input)}`, async () => {
    const { data } = await httpsCallable(functions, "getHotelSupplierConfirmations")(input);
    if (!data || data.hotelUid !== input.hotelUid || data.orderId !== input.orderId || data.policyVersion !== 1
      || !Number.isSafeInteger(data.orderRevision) || data.orderRevision < 0 || typeof data.releaseReady !== "boolean"
      || !["Created", "Ordered", "Received", "Finalized", "Canceled"].includes(data.status)
      || !["available", "not-dispatched", "review-required"].includes(data.availability)
      || !(data.reason === null || text(data.reason, 2000)) || !(data.today === null || date(data.today))
      || !Array.isArray(data.submittedLines) || data.submittedLines.length > 100 || !data.submittedLines.every(validLine)
      || new Set(data.submittedLines.map(key)).size !== data.submittedLines.length
      || data.availability === "available" && !data.submittedLines.length
      || data.current !== null && (!validSummary(data.current) || !validResponse(data.current.response)
        || data.current.responseType !== data.current.response.responseType || data.current.respondedOn !== data.current.response.respondedOn
        || (data.current.reviewId === null ? data.current.review !== null
          : !validReview(data.current.review) || data.current.review.responseId !== data.current.responseId
            || data.current.reviewState !== (data.current.review.decision === "accept" ? "accepted" : "follow-up")))
      || data.availability !== "available" && (data.current !== null || !data.reason)
      || !Array.isArray(data.events) || data.events.length > 25 || data.events.some((event) => !id(event?.id) || !["response", "review"].includes(event.kind)
        || !Number.isSafeInteger(event.revision) || event.revision < 1 || event.revision > data.orderRevision
        || !(event.actorName === null || text(event.actorName, 161)) || !(event.createdAtMillis === null || number(event.createdAtMillis, Number.MAX_SAFE_INTEGER))
        || (event.kind === "response" ? !validResponse(event.response) || event.review !== null : !validReview(event.review) || event.response !== null))
      || !(data.nextCursor === null || id(data.nextCursor))) throw new Error("Supplier response data is incomplete or belongs to another hotel/order. Refresh before making changes.");
    if (data.current?.response.responseType !== "rejected" && data.current && (data.current.response.lines.length !== data.submittedLines.length
      || data.current.response.lines.some((line) => !data.submittedLines.some((original) => key(original) === key(line)
        && original.supplierProductId === line.supplierProductId && original.orderedQuantity === line.orderedQuantity && original.purchaseUnit === line.purchaseUnit
        && original.currency === line.currency && original.priceBasis === line.priceBasis && original.vatRate === line.vatRate)))) throw new Error("Supplier response lines disagree with this submitted order.");
    return data;
  });
}
async function command(name, input) {
  const { data } = await httpsCallable(functions, name)(input);
  if (!data || data.hotelUid !== input.hotelUid || data.orderId !== input.orderId || data.requestId !== input.requestId || data.actorUid !== input.expectedActorUid
    || !id(data.eventId) || data.revision !== input.expectedRevision + 1 || !validSummary(data.supplierConfirmation)) {
    throw new Error("The supplier response result could not be verified. Retry the exact saved request.");
  }
  return data;
}
export const recordSupplierConfirmation = (input) => command("recordHotelSupplierConfirmation", input);
export const reviewSupplierConfirmation = (input) => command("reviewHotelSupplierConfirmation", input);
