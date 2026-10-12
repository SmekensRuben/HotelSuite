import { functions, httpsCallable } from "../firebaseConfig";

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
export async function getInventoryPeriod(hotelUid, locationId, openingStockCountId, closingStockCountId) {
  requireScope(hotelUid, locationId);
  if (!openingStockCountId || !closingStockCountId || openingStockCountId === closingStockCountId) throw new Error("Select two different completed counts.");
  const result = await httpsCallable(functions, "getHotelInventoryPeriod")({ hotelUid, locationId, openingStockCountId, closingStockCountId });
  const data = result.data;
  if (data?.hotelUid !== hotelUid || data?.locationId !== locationId || data.inventoryPolicyVersion !== 1
      || data.opening?.stockCountId !== openingStockCountId || data.closing?.stockCountId !== closingStockCountId
      || !Array.isArray(data.postClosureIssues) || typeof data.currentlyComplete !== "boolean"
      || !Array.isArray(data.items) || !data.coverage || !Array.isArray(data.coverage.issues)) throw new Error("Inventory period response scope or policy is invalid.");
  return data;
}
