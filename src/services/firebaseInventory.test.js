import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("../firebaseConfig", () => ({ auth: { currentUser: { uid: "counter" } }, functions: {}, httpsCallable: (_functions, name) => async (input) => ({ data: await mocks.call(name, input) }) }));
import { getInventoryCheckpoints, getInventoryLocations, getInventoryPeriod } from "./firebaseInventory";
beforeEach(() => { mocks.call.mockReset(); });
describe("hotel-scoped inventory evidence adapter", () => {
  it("loads every location and checkpoint page with strict tenant scope", async () => {
    mocks.call.mockImplementation(async (name, input) => name === "listHotelInventoryLocations"
      ? { hotelUid: input.hotelUid, locations: [{ locationId: input.afterLocationId ? "kitchen" : "store" }], nextCursor: input.afterLocationId ? null : "store" }
      : { hotelUid: input.hotelUid, locationId: input.locationId, checkpoints: [{ id: input.afterCheckpointId ? "second" : "first" }], nextCursor: input.afterCheckpointId ? null : "first" });
    await expect(getInventoryLocations("hotel-a")).resolves.toHaveLength(2);
    await expect(getInventoryCheckpoints("hotel-a", "store")).resolves.toHaveLength(2);
    expect(mocks.call).toHaveBeenCalledWith("listHotelInventoryCheckpoints", { hotelUid: "hotel-a", locationId: "store", afterCheckpointId: "first" });
  });
  it("rejects cross-hotel results and repeated cursors", async () => {
    mocks.call.mockResolvedValue({ hotelUid: "hotel-b", locations: [] });
    await expect(getInventoryLocations("hotel-a")).rejects.toThrow("scope");
    mocks.call.mockResolvedValue({ hotelUid: "hotel-a", locationId: "store", checkpoints: [], nextCursor: "same" });
    await expect(getInventoryCheckpoints("hotel-a", "store")).rejects.toThrow("did not advance");
  });
  it("preserves unknown costs and rejects a swapped count response", async () => {
    const data = { inventoryPolicyVersion: 1, postClosureIssues: [], currentlyComplete: true, hotelUid: "hotel-a", locationId: "store", opening: { stockCountId: "opening" }, closing: { stockCountId: "closing" }, items: [{ inferredUsageQuantity: 50, periodUnitCost: null, inferredUsageValue: null }], coverage: { issues: [], quantityComplete: true, costComplete: false } };
    mocks.call.mockResolvedValue(data);
    await expect(getInventoryPeriod("hotel-a", "store", "opening", "closing")).resolves.toEqual(data);
    mocks.call.mockResolvedValue({ ...data, closing: { stockCountId: "other" } });
    await expect(getInventoryPeriod("hotel-a", "store", "opening", "closing")).rejects.toThrow("scope or policy");
    await expect(getInventoryPeriod("hotel-a", "store", "same", "same")).rejects.toThrow("different completed");
  });
  it("selects V2 explicitly, preserves unknown source values, and rejects a substituted V1 report", async () => {
    const item = { openingQuantity: 10, netReceiptQuantity: 4, transferInQuantity: 1, transferOutQuantity: 2, wasteQuantity: 1, breakageQuantity: 0, physicalReturnQuantity: 1, closingQuantity: 3, residualQuantity: 8,
      openingValue: null, receiptValue: 20, transferInValue: null, transferOutValue: null, wasteValue: null, breakageValue: 0, physicalReturnValue: null, closingValue: null, residualValue: null };
    const data = { inventoryPolicyVersion: 1, reportPolicyVersion: 2, hotelUid: "hotel-a", locationId: "store", opening: { stockCountId: "opening" }, closing: { stockCountId: "closing" }, items: [item], coverage: { issues: [], quantityComplete: true, costComplete: false }, postClosureIssues: [], currentlyComplete: true };
    mocks.call.mockResolvedValue(data);
    await expect(getInventoryPeriod("hotel-a", "store", "opening", "closing", 2)).resolves.toEqual(data);
    expect(mocks.call).toHaveBeenLastCalledWith("getHotelInventoryPeriod", { hotelUid: "hotel-a", locationId: "store", openingStockCountId: "opening", closingStockCountId: "closing", reportPolicyVersion: 2 });
    mocks.call.mockResolvedValue({ ...data, reportPolicyVersion: 1 });
    await expect(getInventoryPeriod("hotel-a", "store", "opening", "closing", 2)).rejects.toThrow("scope or policy");
  });
  it("does not substitute missing V2 quantities or values with zero", async () => {
    mocks.call.mockResolvedValue({ inventoryPolicyVersion: 1, reportPolicyVersion: 2, hotelUid: "hotel-a", locationId: "store", opening: { stockCountId: "opening" }, closing: { stockCountId: "closing" }, items: [{}], coverage: { issues: [] }, postClosureIssues: [], currentlyComplete: false });
    await expect(getInventoryPeriod("hotel-a", "store", "opening", "closing", 2)).rejects.toThrow("explicitly unavailable");
    await expect(getInventoryPeriod("hotel-a", "store", "opening", "closing", 3)).rejects.toThrow("supported");
  });
});
