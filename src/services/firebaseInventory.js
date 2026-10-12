import { functions, httpsCallable } from "../firebaseConfig";
import { poolProcurementRead } from "./procurementReadPool";

function requireScope(hotelUid, locationId) {
  if (!hotelUid || !locationId) throw new Error("Hotel and physical location are required.");
}
export async function getInventoryLocations(hotelUid) {
  if (!hotelUid) throw new Error("Hotel is required.");
  const locations = [], seen = new Set();
  let afterLocationId = null;
  while (true) {
    const result = await httpsCallable(functions, "listHotelInventoryLocations")({ hotelUid, afterLocationId });
    const data = result.data;
    if (data?.hotelUid !== hotelUid || !Array.isArray(data.locations)) throw new Error("Inventory location response scope is invalid.");
    locations.push(...data.locations);
    if (locations.length > 1000) throw new Error("More than 1,000 inventory locations require operator review.");
    if (!data.nextCursor) return locations;
    if (seen.has(data.nextCursor)) throw new Error("Inventory location pagination did not advance.");
    seen.add(data.nextCursor); afterLocationId = data.nextCursor;
  }
}
export async function getInventoryCheckpoints(hotelUid, locationId) {
  requireScope(hotelUid, locationId);
  const checkpoints = [], seen = new Set();
  let afterCheckpointId = null;
  while (true) {
    const result = await httpsCallable(functions, "listHotelInventoryCheckpoints")({ hotelUid, locationId, afterCheckpointId });
    const data = result.data;
    if (data?.hotelUid !== hotelUid || data?.locationId !== locationId || !Array.isArray(data.checkpoints)) throw new Error("Inventory checkpoint response scope is invalid.");
    checkpoints.push(...data.checkpoints);
    if (checkpoints.length > 1000) throw new Error("More than 1,000 count checkpoints require a narrower selection.");
    if (!data.nextCursor) return checkpoints;
    if (seen.has(data.nextCursor)) throw new Error("Inventory checkpoint pagination did not advance.");
    seen.add(data.nextCursor); afterCheckpointId = data.nextCursor;
  }
}
export async function getInventoryPeriod(hotelUid, locationId, openingStockCountId, closingStockCountId, reportPolicyVersion = 1) {
  requireScope(hotelUid, locationId);
  if (!openingStockCountId || !closingStockCountId || openingStockCountId === closingStockCountId) throw new Error("Select two different completed counts.");
  if (![1, 2].includes(reportPolicyVersion)) throw new Error("Select an explicitly supported inventory report policy.");
  return poolProcurementRead(hotelUid, `period:${locationId}:${openingStockCountId}:${closingStockCountId}:v${reportPolicyVersion}`, async () => {
    const input = { hotelUid, locationId, openingStockCountId, closingStockCountId, reportPolicyVersion };
    const { data } = await httpsCallable(functions, "getHotelInventoryPeriod")(input);
    if (data?.hotelUid !== hotelUid || data?.locationId !== locationId || data.inventoryPolicyVersion !== 1
      || (data.reportPolicyVersion ?? 1) !== reportPolicyVersion
      || data.opening?.stockCountId !== openingStockCountId || data.closing?.stockCountId !== closingStockCountId
      || !Array.isArray(data.postClosureIssues) || typeof data.currentlyComplete !== "boolean"
      || !Array.isArray(data.items) || !data.coverage || !Array.isArray(data.coverage.issues)) throw new Error("Inventory period response scope or policy is invalid.");
    if (reportPolicyVersion === 2 && data.items.some((item) => ["openingQuantity", "netReceiptQuantity", "transferInQuantity", "transferOutQuantity", "wasteQuantity", "breakageQuantity", "physicalReturnQuantity", "closingQuantity", "residualQuantity"]
      .some((key) => item[key] !== null && (typeof item[key] !== "number" || !Number.isFinite(item[key])))
      || ["openingValue", "receiptValue", "transferInValue", "transferOutValue", "wasteValue", "breakageValue", "physicalReturnValue", "closingValue", "residualValue"]
        .some((key) => item[key] !== null && (typeof item[key] !== "number" || !Number.isFinite(item[key]))))) {
      throw new Error("The classified inventory period is incomplete. Missing values must remain explicitly unavailable.");
    }
    return data;
  });
}
