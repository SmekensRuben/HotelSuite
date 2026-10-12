import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("../firebaseConfig", () => ({ functions: {}, httpsCallable: (_functions, name) => async (input) => ({ data: await mocks.call(name, input) }) }));
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
});
