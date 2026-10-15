import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ actor: { uid: "manager" }, call: vi.fn() }));
vi.mock("../firebaseConfig", () => ({ auth: { get currentUser() { return mocks.actor; } }, functions: {}, httpsCallable: (_functions, endpoint) => (input) => mocks.call(endpoint, input) }));
import { getCatalogSkuSettings, getPendingCatalogSkuSettings, retryCatalogSkuSettings, saveCatalogSkuSettings } from "./firebaseCatalogSkuSettings";
import { invalidateProcurementReads } from "./procurementReadPool";
const settings = { enabled: true, prefix: "CAT-", padding: 6, nextNumber: 1 };
const response = (input = {}, patch = {}) => ({ data: { hotelUid: "hotel-a", policyVersion: 1, revision: 0, ...settings, ...input, ...patch } });
beforeEach(() => { vi.clearAllMocks(); sessionStorage.clear(); mocks.actor = { uid: "manager" }; invalidateProcurementReads(); mocks.call.mockImplementation((_name, input) => Promise.resolve(response(input))); });
describe("protected hotel SKU settings", () => {
  it("projects the current hotel's settings without exposing private counter index data", async () => {
    mocks.call.mockResolvedValueOnce(response({}, { legacyIndex: "private", updatedBy: "hidden" }));
    expect(await getCatalogSkuSettings("hotel-a")).toEqual({ hotelUid: "hotel-a", policyVersion: 1, revision: 0, ...settings });
  });
  it("retains an uncertain save across remount and replays the original request exactly", async () => {
    mocks.call.mockRejectedValueOnce(new Error("Network interrupted"));
    await expect(saveCatalogSkuSettings("hotel-a", settings, { expectedRevision: 0 })).rejects.toThrow("Network interrupted");
    const original = mocks.call.mock.calls[0][1];
    expect(getPendingCatalogSkuSettings("hotel-a").requestId).toBe(original.requestId);
    await expect(saveCatalogSkuSettings("hotel-a", { ...settings, prefix: "OTHER-" }, { expectedRevision: 0 })).rejects.toThrow("original");
    mocks.call.mockImplementationOnce((_name, input) => Promise.resolve(response(input.settings, { requestId: input.requestId, revision: 1 })));
    await retryCatalogSkuSettings("hotel-a");
    expect(mocks.call).toHaveBeenLastCalledWith("saveHotelCatalogSkuSettings", original);
    expect(getPendingCatalogSkuSettings("hotel-a")).toBeNull();
  });
  it("requires a matching receipt before releasing the saved request", async () => {
    mocks.call.mockResolvedValueOnce(response(settings, { requestId: "wrong", revision: 1 }));
    await expect(saveCatalogSkuSettings("hotel-a", settings, { expectedRevision: 0 })).rejects.toThrow("could not be verified");
    expect(getPendingCatalogSkuSettings("hotel-a")).not.toBeNull();
  });
  it("only a server-proven uncommitted result releases a pending change", async () => {
    mocks.call.mockRejectedValueOnce(Object.assign(new Error("Rights changed"), { code: "permission-denied" }));
    await expect(saveCatalogSkuSettings("hotel-a", settings, { expectedRevision: 0 })).rejects.toThrow("Rights changed");
    expect(getPendingCatalogSkuSettings("hotel-a")).not.toBeNull();
    mocks.call.mockRejectedValueOnce(Object.assign(new Error("Settings changed"), { code: "aborted", details: { catalogSkuRequestUncommitted: true } }));
    await expect(retryCatalogSkuSettings("hotel-a")).rejects.toThrow("Settings changed");
    expect(getPendingCatalogSkuSettings("hotel-a")).toBeNull();
  });
  it("partitions pending changes by hotel and authenticated actor", async () => {
    mocks.call.mockRejectedValueOnce(new Error("Interrupted"));
    await expect(saveCatalogSkuSettings("hotel-a", settings, { expectedRevision: 0 })).rejects.toThrow();
    expect(getPendingCatalogSkuSettings("hotel-b")).toBeNull();
    mocks.actor = { uid: "other" };
    expect(getPendingCatalogSkuSettings("hotel-a")).toBeNull();
  });
  it("discards a response after the authenticated session changes", async () => {
    mocks.call.mockImplementationOnce(async () => { mocks.actor = { uid: "manager" }; return response(); });
    await expect(getCatalogSkuSettings("hotel-a")).rejects.toThrow("access changed");
  });
});
