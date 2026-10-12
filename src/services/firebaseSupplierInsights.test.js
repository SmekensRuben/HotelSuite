import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSupplierPriceComparison, getSupplierPriceHistory } from "./firebaseSupplierInsights";
import { invalidateProcurementReads } from "./procurementReadPool";
const mocks = vi.hoisted(() => ({ call: vi.fn(), auth: { currentUser: { uid: "buyer" } } }));
vi.mock("../firebaseConfig", () => ({ functions: {}, auth: mocks.auth, httpsCallable: (_functions, name) => { expect(name).toBe("getHotelSupplierPriceInsights"); return mocks.call; } }));
const option = { id: "default", purchaseUnit: "Case", available: true, reason: null, baseUnitsPerPurchaseUnit: 6000,
  pricePerPurchaseUnit: 15.9, catalogUnitsPerPurchaseUnit: 6, netPricePerPurchaseUnit: 15, netPricePerCatalogUnit: 2.5 };
const comparison = { hotelUid: "a", mode: "comparison", policyVersion: 1, catalog: { id: "juice", baseUnit: "l" }, assessmentDate: "2026-10-12", timeZone: "Europe/Brussels",
  products: [{ id: "offer", active: true, currency: "EUR", options: [option], priceValidity: "unknown", contractualValidFrom: null, contractualValidUntil: null }], nextProductId: null };
const history = { hotelUid: "a", mode: "history", policyVersion: 1, supplierProductId: "offer", entries: [{ revision: 2, observedAt: "2026-10-12T00:00:00Z", currency: "EUR", catalogBaseUnit: "l", options: [option], previous: null, contractualValidFrom: null, contractualValidUntil: null }], nextRevision: null };
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
describe("scoped supplier insight services", () => {
  beforeEach(() => { vi.clearAllMocks(); invalidateProcurementReads(); mocks.auth.currentUser = { uid: "buyer" }; });
  it("uses the scoped typed callable and explicit bounded cursors for each mode", async () => {
    mocks.call.mockResolvedValueOnce({ data: comparison }).mockResolvedValueOnce({ data: history });
    expect(await getSupplierPriceComparison("a", "juice", { pageSize: 5, afterProductId: "before" })).toEqual(comparison);
    expect(mocks.call).toHaveBeenNthCalledWith(1, { hotelUid: "a", mode: "comparison", catalogProductId: "juice", pageSize: 5, afterProductId: "before" });
    expect(await getSupplierPriceHistory("a", "offer", { beforeRevision: 10 })).toEqual(history);
    expect(mocks.call).toHaveBeenNthCalledWith(2, { hotelUid: "a", mode: "history", supplierProductId: "offer", pageSize: 25, beforeRevision: 10 });
  });
  it("rejects hotel/catalog/product scope drift, oversized pages, malformed known prices and conflicting cursors", async () => {
    for (const data of [{ ...comparison, hotelUid: "b" }, { ...comparison, catalog: { id: "other" } }, { ...comparison, catalog: { id: "juice", baseUnit: {} } }, { ...comparison, nextProductId: "foreign" },
      { ...comparison, products: [{ id: "offer", active: true, currency: "EUR", options: [{ ...option, netPricePerCatalogUnit: null }] }] }]) {
      mocks.call.mockResolvedValueOnce({ data }); await expect(getSupplierPriceComparison("a", "juice")).rejects.toThrow();
    }
    mocks.call.mockResolvedValueOnce({ data: { ...history, supplierProductId: "other" } });
    await expect(getSupplierPriceHistory("a", "offer")).rejects.toThrow(/response is invalid/);
  });
  it("rejects unordered historical evidence and malformed request bounds before Firebase", async () => {
    mocks.call.mockResolvedValueOnce({ data: { ...history, entries: [...history.entries, history.entries[0]] } });
    await expect(getSupplierPriceHistory("a", "offer")).rejects.toThrow(/order or terms/);
    expect(() => getSupplierPriceComparison("a", "bad/path")).toThrow();
    expect(() => getSupplierPriceHistory("a", "offer", { beforeRevision: 0 })).toThrow();
    await expect(getSupplierPriceComparison("a", "juice", { pageSize: 51 })).rejects.toThrow(/page size/);
  });
  it("shares concurrent reads without retaining settled hotel records", async () => {
    const pending = deferred(); mocks.call.mockReturnValueOnce(pending.promise);
    const first = getSupplierPriceComparison("a", "juice"), second = getSupplierPriceComparison("a", "juice");
    await Promise.resolve(); expect(mocks.call).toHaveBeenCalledTimes(1);
    pending.resolve({ data: comparison }); expect(await first).toEqual(await second);
    mocks.call.mockResolvedValueOnce({ data: comparison }); await getSupplierPriceComparison("a", "juice"); expect(mocks.call).toHaveBeenCalledTimes(2);
  });
  it("drops in-flight data after auth or hotel access invalidation", async () => {
    const pending = deferred(); mocks.call.mockReturnValueOnce(pending.promise);
    const request = getSupplierPriceComparison("a", "juice"); await Promise.resolve(); invalidateProcurementReads("a");
    pending.resolve({ data: comparison }); await expect(request).rejects.toThrow(/access changed/);
    const switched = deferred(); mocks.call.mockReturnValueOnce(switched.promise);
    const old = getSupplierPriceHistory("a", "offer"); await Promise.resolve(); mocks.auth.currentUser = { uid: "other" };
    switched.resolve({ data: history }); await expect(old).rejects.toThrow(/access changed/);
  });
  it("rejects missing validity qualification and malformed or inconsistent contract dates", async () => {
    for (const patch of [{ priceValidity: undefined }, { priceValidity: "unknown", contractualValidUntil: "2026-11-01" },
      { priceValidity: "current", contractualValidFrom: "2026-02-29" }, { priceValidity: "unrecognized" },
      { priceValidity: "current", contractualValidFrom: "2026-11-01" }, { priceValidity: "current", contractualValidUntil: "2026-09-01" }]) {
      mocks.call.mockResolvedValueOnce({ data: { ...comparison, products: [{ ...comparison.products[0], ...patch }] } });
      await expect(getSupplierPriceComparison("a", "juice")).rejects.toThrow(/record is invalid/);
    }
  });
});
