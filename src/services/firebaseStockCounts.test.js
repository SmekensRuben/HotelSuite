import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ call: vi.fn(), getDoc: vi.fn(), getDocs: vi.fn() }));
vi.mock("../firebaseConfig", () => ({ db: {}, functions: {}, auth: { currentUser: { uid: "operator-a" } }, collection: (_db, path) => ({ path }),
  doc: (_db, path, id) => ({ path: id ? `${path}/${id}` : path }), getDoc: mocks.getDoc, getDocs: mocks.getDocs,
  httpsCallable: (_functions, name) => async (data) => ({ data: await mocks.call(name, data) }) }));
import { createStockCount, finishStockCount, finishStockCountLocation, getStockCountSources, getPendingCountCreation, retryPendingCountCreation, updateStockCountLocationCounts } from "./firebaseStockCounts";
import { getHotelUserDisplayName } from "./firebaseUserManagement";
beforeEach(() => {
  mocks.call.mockReset(); mocks.getDoc.mockReset(); mocks.getDocs.mockReset();
  sessionStorage.clear();
  mocks.call.mockResolvedValue({ hotelUid: "hotel-a", inventoryPolicyVersion: 1, stockCountId: "stock-a", revision: 1, displayName: "Ada Lovelace" });
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
    mocks.call.mockResolvedValue({ hotelUid: "hotel-a", users: [{ userId: "person", displayName: "Ada Lovelace" }] });
    await expect(getHotelUserDisplayName("hotel-a", "person")).resolves.toBe("Ada Lovelace");
    expect(mocks.call).toHaveBeenCalledWith("getHotelUserDisplayNames", { hotelUid: "hotel-a", userIds: ["person"] });
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

describe("catalog count boundaries", () => {
  it("creates whole-outlet counts without names/templates and submits only optional workflow metadata", async () => {
    await createStockCount("hotel-a", { type: "Ad Hoc", reason: "Event reconciliation", businessDate: "2026-10-12", locations: [{ outletId: "bar", outletName: "Spoofed" }] });
    expect(mocks.call.mock.calls[0]).toEqual(["createHotelStockCount", { hotelUid: "hotel-a", type: "Ad Hoc", reason: "Event reconciliation",
      businessDate: "2026-10-12", locations: [{ outletId: "bar" }], requestId: expect.any(String) }]);
    await createStockCount("hotel-a", { type: "Month-End", periodMonth: 9, periodYear: 2026, locations: [{ outletId: "bar", locationId: "fridge" }] });
    expect(mocks.call.mock.calls[1][1]).toMatchObject({ type: "Month-End", periodMonth: 9, periodYear: 2026, locations: [{ outletId: "bar", locationId: "fridge" }] });
  });
  it("keeps an empty quantity distinct from explicit zero across command and read normalization", async () => {
    await updateStockCountLocationCounts("hotel-a", "stock-a", "store", [{ catalogProductId: "milk", quantity: null, isCounted: false },
      { catalogProductId: "coffee", quantity: 0, isCounted: true }], "spoof", 2);
    expect(mocks.call.mock.calls[0][1].countedItems).toEqual([{ catalogProductId: "milk", quantity: null, isCounted: false, unitCost: null },
      { catalogProductId: "coffee", quantity: 0, isCounted: true, unitCost: null }]);
  });
  it("submits exact catalog quantities and optional estimate without supplier snapshots", async () => {
    await updateStockCountLocationCounts("hotel-a", "stock-a", "store", [{ catalogProductId: "milk", quantity: 1.000001, isCounted: true, unitCost: null, currency: "EUR", totalValue: 999 }], "spoof", 4);
    expect(mocks.call.mock.calls[0][1].countedItems).toEqual([{ catalogProductId: "milk", quantity: 1.000001, isCounted: true, unitCost: null }]);
    await finishStockCountLocation("hotel-a", "stock-a", "store", [{ catalogProductId: "milk", quantity: 0, unitCost: 0 }], [{ catalogProductId: "milk", supplierProductId: "fake" }], "spoof", 5);
    expect(mocks.call.mock.calls[1][1].templateItemsToAdd).toEqual([{ catalogProductId: "milk" }]);
  });
  it("preserves catalog snapshots and unknown value in count reads", async () => {
    mocks.getDoc.mockResolvedValue({ exists: () => true, id: "stock-a", data: () => ({ name: "Opening", inventoryPolicyVersion: 1, currency: "USD", businessDate: "2026-10-12" }) });
    mocks.getDocs.mockResolvedValue({ docs: [{ id: "store", data: () => ({ inventoryPolicyVersion: 1, currency: "USD", stockTemplate: { id: "t", items: [{ catalogProductId: "milk", baseUnit: "l" }] }, countedItems: [{ catalogProductId: "milk", catalogProductName: "Milk", quantity: 0, unitCost: null, totalValue: null, currency: "USD" }] }) }] });
    const { getStockCountById } = await import("./firebaseStockCounts");
    const result = await getStockCountById("hotel-a", "stock-a");
    expect(result).toMatchObject({ inventoryPolicyVersion: 1, currency: "USD", countedValue: null });
    expect(result.locations[0].countedItems[0]).toMatchObject({ catalogProductId: "milk", quantity: 0, unitCost: null, totalValue: null });
    expect(result.locations[0].stockTemplate.items).toHaveLength(1);
  });
  it("does not replace an uncertain creation with changed input", async () => {
    const input = { name: "Opening", type: "Ad Hoc", businessDate: "2026-10-12", locations: [{ locationId: "store", stockTemplateId: "t" }] };
    mocks.call.mockRejectedValueOnce(new Error("Connection lost"));
    await expect(createStockCount("hotel-a", input)).rejects.toThrow("Connection lost");
    await expect(createStockCount("hotel-a", { ...input, name: "Different" })).rejects.toThrow("awaiting confirmation");
    expect(mocks.call).toHaveBeenCalledTimes(1);
    await createStockCount("hotel-a", input);
    expect(mocks.call.mock.calls[0][1]).toEqual(mocks.call.mock.calls[1][1]);
  });
});

describe("stock count product search projection", () => {
  const page = () => ({ hotelUid: "hotel-a", stockCountId: "stock-a", locationId: "outlet:bar", inventoryPolicyVersion: 1,
    nextCursor: null, products: [{ id: "milk", name: "Milk", baseUnit: "l", barcodes: ["06291041500213"] }] });
  it("requests scoped text/barcode pages while preserving barcode leading zeroes", async () => {
    const { getStockCountProductChoices } = await import("./firebaseStockCounts"); mocks.call.mockResolvedValue(page());
    await expect(getStockCountProductChoices("hotel-a", "stock-a", "outlet:bar", { search: "milk", barcode: "06291041500213" })).resolves.toEqual(page());
    expect(mocks.call).toHaveBeenCalledWith("listHotelStockCountProducts", { hotelUid: "hotel-a", stockCountId: "stock-a", locationId: "outlet:bar",
      afterProductId: null, search: "milk", barcode: "06291041500213" });
  });
  it("rejects foreign or malformed responses and non-advancing cursors", async () => {
    const { getStockCountProductChoices } = await import("./firebaseStockCounts");
    for (const patch of [{ hotelUid: "foreign" }, { stockCountId: "other" }, { locationId: "fridge" }, { nextCursor: undefined },
      { nextCursor: "before" }, { products: [page().products[0], page().products[0]] }, { products: [{ ...page().products[0], baseUnit: "bottle" }] },
      { products: [{ ...page().products[0], barcodes: [6291041500213] }] }]) {
      mocks.call.mockResolvedValue({ ...page(), ...patch });
      await expect(getStockCountProductChoices("hotel-a", "stock-a", "outlet:bar", { afterProductId: "before" })).rejects.toThrow("invalid scope, products or pagination");
    }
  });
});

it("replays original count creation after remount and keeps corrupted storage unreconciled", async () => {
  const input = { name: "Original", type: "Weekly", locations: [{ locationId: "store", stockTemplateId: "template" }] };
  mocks.call.mockRejectedValueOnce(new Error("Response lost after commit"));
  await expect(createStockCount("hotel-a", input)).rejects.toThrow("Response lost");
  expect(getPendingCountCreation("hotel-a")).toMatchObject(input);
  await retryPendingCountCreation("hotel-a");
  expect(mocks.call.mock.calls[0][1]).toEqual(mocks.call.mock.calls[1][1]);
  expect(getPendingCountCreation("hotel-a")).toBeNull();
  const key = "hotelsuite.stockCount.create:operator-a:hotel-a";
  sessionStorage.setItem(key, "broken");
  await expect(createStockCount("hotel-a", input)).rejects.toThrow("no replacement");
  expect(sessionStorage.getItem(key)).toBe("broken");
});

// These projection assertions exercise the scope guard, not the pure arithmetic.
describe("frozen count package projection adapter", () => {
  const page = () => ({ hotelUid: "hotel-a", stockCountId: "stock-a", locationId: "store", catalogProductId: "milk", inventoryPolicyVersion: 1,
    catalogBaseUnit: "l", nextCursor: null, unavailable: [], options: [{ id: '["case","default"]', supplierProductId: "case", purchaseOptionId: "default",
      supplierProductName: "Milk six-pack", supplierName: "Vendor", purchaseUnit: "Case", baseUnit: "l", catalogUnitsPerPackage: 6 }] });
  it("requests only the actual selected hotel/count/location/article and never copies unit or price authority into the request", async () => {
    const { getStockCountPackageOptions } = await import("./firebaseStockCounts"); mocks.call.mockResolvedValue(page());
    await expect(getStockCountPackageOptions("hotel-a", "stock-a", "store", "milk", { baseUnit: "l" })).resolves.toEqual(page());
    expect(mocks.call).toHaveBeenCalledWith("getHotelStockCountPackageOptions", { hotelUid: "hotel-a", stockCountId: "stock-a", locationId: "store", catalogProductId: "milk", afterSupplierProductId: null });
    expect(mocks.getDoc).not.toHaveBeenCalled(); expect(mocks.getDocs).not.toHaveBeenCalled();
  });
  it("rejects wrong tenant, count, unit, missing pagination and malformed package projections", async () => {
    const { getStockCountPackageOptions } = await import("./firebaseStockCounts");
    for (const patch of [{ hotelUid: "foreign" }, { stockCountId: "other" }, { catalogBaseUnit: "ml" }, { nextCursor: undefined },
      { options: [{ ...page().options[0], catalogUnitsPerPackage: "6" }] }, { options: [{ ...page().options[0], baseUnit: "kg" }] },
      { options: [page().options[0], page().options[0]] }]) {
      mocks.call.mockResolvedValue({ ...page(), ...patch });
      await expect(getStockCountPackageOptions("hotel-a", "stock-a", "store", "milk", { baseUnit: "l" })).rejects.toThrow("invalid scope, unit or pagination");
    }
  });
});
