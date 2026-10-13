import { functions, httpsCallable } from "../firebaseConfig";
import { poolProcurementRead } from "./procurementReadPool";

const identifier = (value) => typeof value === "string" && Boolean(value.trim()) && value.length <= 128 && !value.includes("/");
const currency = (value) => value === null || typeof value === "string" && /^[A-Z]{3}$/.test(value);
const units = ["g", "kg", "ml", "l", "each"];
const date = (value) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const nullableNumber = (value) => value === null || finite(value) && Math.abs(value) <= 1000000000;
const sourceNumberKeys = ["openingQuantity", "openingNetValue", "recordedMovementQuantity", "recordedMovementNetValue", "weightedSourceQuantity", "weightedSourceNetValue"];

// A protected, read-only estimate. Only an explicit Apply writes its numeric value
// into the current draft; existing dated count and movement snapshots are untouched.
export function getInventoryCostProposal(input, expected = {}) {
  if (!input || !identifier(input.hotelUid) || !identifier(input.locationId) || !identifier(input.catalogProductId)
    || !["stockcount", "movement"].includes(input.purpose)
    || input.purpose === "stockcount" && !identifier(input.stockCountId)
    || input.purpose === "movement" && !date(input.businessDate)) throw new Error("Choose a valid article, physical location and business date before requesting a stock-cost estimate.");
  const payload = { hotelUid: input.hotelUid, purpose: input.purpose, locationId: input.locationId, catalogProductId: input.catalogProductId,
    ...(input.purpose === "stockcount" ? { stockCountId: input.stockCountId } : { businessDate: input.businessDate }) };
  return poolProcurementRead(input.hotelUid, `inventory-cost:${JSON.stringify(payload)}:${JSON.stringify([expected.baseUnit, expected.currency, expected.businessDate])}`, async () => {
    const { data } = await httpsCallable(functions, "getHotelInventoryCostProposal")(payload);
    const source = data?.source;
    if (data?.hotelUid !== payload.hotelUid || data.locationId !== payload.locationId || data.catalogProductId !== payload.catalogProductId
      || data.purpose !== payload.purpose || data.stockCountId !== (payload.stockCountId || null) || data.costProposalPolicyVersion !== 1
      || !["available", "unavailable"].includes(data.status) || data.available !== (data.status === "available")
      || !(data.baseUnit === null || units.includes(data.baseUnit)) || !currency(data.currency) || !date(data.businessDate)
      || !finite(data.asOfMillis) || data.asOfMillis < 0 || typeof data.costBasis !== "string" || !data.costBasis.trim() || data.costBasis.length > 2000
      || !Array.isArray(data.reasons) || data.reasons.length > 50 || data.reasons.some((reason) => typeof reason.code !== "string" || !reason.code.trim()
        || typeof reason.detail !== "string" || !reason.detail.trim() || reason.detail.length > 2000)
      || data.netUnitCost !== null && (!finite(data.netUnitCost) || data.netUnitCost < 0 || data.netUnitCost > 1000000 || !/^\d+(\.\d{1,6})?$/.test(String(data.netUnitCost)))
      || source !== null && (!source || typeof source !== "object" || Array.isArray(source)
        || ["anchorStockCountId", "anchorCheckpointId", "openingBusinessDate"].some((key) => !(source[key] === null || typeof source[key] === "string" && source[key].length <= 200))
        || sourceNumberKeys.some((key) => !nullableNumber(source[key]))
        || !(source.postingCutoffSequence === null || Number.isSafeInteger(source.postingCutoffSequence) && source.postingCutoffSequence >= 0)
        || !Number.isSafeInteger(source.movementCount) || source.movementCount < 0 || source.movementCount > 1000)
      || data.available && (data.netUnitCost === null || data.baseUnit === null || data.currency === null || !source || data.reasons.length
        || !identifier(source.anchorStockCountId) || !identifier(source.anchorCheckpointId) || !date(source.openingBusinessDate)
        || !Number.isSafeInteger(source.postingCutoffSequence) || sourceNumberKeys.some((key) => !finite(source[key])) || source.weightedSourceQuantity <= 0)
      || !data.available && (data.netUnitCost !== null || !data.reasons.length)) throw new Error("The stock-cost estimate returned incomplete or invalid scoped evidence. Keep the cost unknown or enter a reviewed manual estimate.");
    if (data.businessDate !== (payload.businessDate || expected.businessDate)
      || data.available && (expected.baseUnit !== undefined && data.baseUnit !== expected.baseUnit || expected.currency !== undefined && data.currency !== expected.currency)) {
      throw new Error("The stock-cost estimate no longer matches this draft's date, unit or currency. Review the selected context before applying it.");
    }
    return data;
  });
}
