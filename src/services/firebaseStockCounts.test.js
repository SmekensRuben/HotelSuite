import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ call: vi.fn(), getDoc: vi.fn(), getDocs: vi.fn() }));
vi.mock("../firebaseConfig", () => ({ db: {}, functions: {}, collection: (_db, path) => ({ path }),
  doc: (_db, path, id) => ({ path: id ? `${path}/${id}` : path }), getDoc: mocks.getDoc, getDocs: mocks.getDocs,
  httpsCallable: (_functions, name) => async (data) => ({ data: await mocks.call(name, data) }) }));
import { createStockCount, finishStockCount, finishStockCountLocation, getStockCountSources, updateStockCountLocationCounts } from "./firebaseStockCounts";
import { getHotelUserDisplayName } from "./firebaseUserManagement";
beforeEach(() => {
  mocks.call.mockReset(); mocks.getDoc.mockReset(); mocks.getDocs.mockReset();
  sessionStorage.clear();
  mocks.call.mockResolvedValue({ stockCountId: "stock-a", revision: 1, displayName: "Ada Lovelace" });
});
describe("server-owned stock mutation adapter", () => {
  it("sends identities and quantities without client actor, price or calculated total", async () => {
    await updateStockCountLocationCounts("hotel-a", "stock-a", "store", [{ supplierProductId: "coffee", outletId: "bar",
      quantity: 2, pricePerPurchaseUnit: 999, totalValue: 1998, countedBy: "spoof", countedAt: new Date(), isCounted: true }], "spoof", 4);
    expect(mocks.call).toHaveBeenCalledWith("mutateHotelStockCount", { hotelUid: "hotel-a", stockCountId: "stock-a",
      locationId: "store", expectedRevision: 4, action: "save-location", countedItems: [
        { supplierProductId: "coffee", outletId: "bar", quantity: 2, isCounted: true }] });
    expect(mocks.getDoc).not.toHaveBeenCalled();
  });
  it("uses loaded revision for location and parent finish without a fresh read hiding stale UI state", async () => {
    await finishStockCountLocation("hotel-a", "stock-a", "store", [], [{ supplierProductId: "p", outletId: "o", countedBy: "fake" }], "spoof", 3);
    await finishStockCount("hotel-a", "stock-a", "spoof", 4);
    expect(mocks.call.mock.calls[0][1]).toEqual({ hotelUid: "hotel-a", stockCountId: "stock-a", locationId: "store",
      action: "finish-location", expectedRevision: 3, countedItems: [], templateItemsToAdd: [{ supplierProductId: "p", outletId: "o" }] });
    expect(mocks.call.mock.calls[1][1]).toEqual({ hotelUid: "hotel-a", stockCountId: "stock-a", action: "finish-count", expectedRevision: 4 });
  });
  it("reuses creation identity after a lost response without submitting client snapshots", async () => {
    const input = { name: "Weekly", type: "Weekly", createdBy: "spoof",
      locations: [{ locationId: "store", stockTemplateId: "template", stockTemplate: { items: [{ pricePerPurchaseUnit: 0 }] }, locationName: "fake" }] };
    mocks.call.mockRejectedValueOnce(new Error("Lost response"));
    await expect(createStockCount("hotel-a", input)).rejects.toThrow("Lost response");
    await createStockCount("hotel-a", input);
    expect(mocks.call.mock.calls[1][1]).toEqual(mocks.call.mock.calls[0][1]);
    expect(mocks.call.mock.calls[0][1]).toEqual({ hotelUid: "hotel-a", name: "Weekly", type: "Weekly",
      locations: [{ locationId: "store", stockTemplateId: "template" }], requestId: expect.any(String) });
    await createStockCount("hotel-a", input);
    expect(mocks.call.mock.calls[2][1].requestId).not.toEqual(mocks.call.mock.calls[0][1].requestId);
  });
  it("looks up staff names through a hotel-scoped callable without global profile reads", async () => {
    await expect(getHotelUserDisplayName("hotel-a", "person")).resolves.toBe("Ada Lovelace");
    expect(mocks.call).toHaveBeenCalledWith("getHotelUserDisplayName", { hotelUid: "hotel-a", userId: "person" });
    expect(mocks.getDoc).not.toHaveBeenCalled(); expect(mocks.getDocs).not.toHaveBeenCalled();
    await expect(getHotelUserDisplayName("", "person")).rejects.toThrow("hotelUid is required");
  });
  it("loads later source pages and fails explicitly when a cursor repeats", async () => {
    mocks.call.mockImplementation(async (_name, input) => input.afterLocationId
      ? { locations: [{ locationId: "later" }], nextCursor: null }
      : { locations: [{ locationId: "early" }], nextCursor: "early" });
    await expect(getStockCountSources("hotel-a")).resolves.toEqual([{ locationId: "early" }, { locationId: "later" }]);
    expect(mocks.call.mock.calls[1]).toEqual(["listHotelStockCountSources", { hotelUid: "hotel-a", afterLocationId: "early" }]);
    mocks.call.mockResolvedValue({ locations: [], nextCursor: "repeat" });
    await expect(getStockCountSources("hotel-a")).rejects.toThrow("pagination did not advance");
  });
});
