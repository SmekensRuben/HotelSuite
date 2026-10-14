import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ actor: { uid: "manager" }, call: vi.fn() }));
vi.mock("../firebaseConfig", () => ({ auth: { get currentUser() { return mocks.actor; } }, functions: {}, httpsCallable: (_functions, endpoint) => (input) => mocks.call(endpoint, input) }));
import { assignCatalogSkus, getPendingCatalogSkuAssignment, retryCatalogSkuAssignment } from "./firebaseCatalogSkuAssignments";
import { invalidateProcurementReads } from "./procurementReadPool";
const selection = { expectedSettingsRevision: 4, products: [{ productId: "milk", expectedRevision: 2 }, { productId: "water", expectedRevision: 0 }] };
const receipt = (input, patch = {}) => ({ data: { hotelUid: input.hotelUid, requestId: input.requestId, settingsRevision: input.expectedSettingsRevision + 1,
  assigned: input.products.map((product, index) => ({ productId: product.productId, revision: product.expectedRevision + 1, internalSku: `CAT-${String(index + 17).padStart(6, "0")}` })), ...patch } });
beforeEach(() => { vi.clearAllMocks(); sessionStorage.clear(); mocks.actor = { uid: "manager" }; invalidateProcurementReads(); mocks.call.mockImplementation((_name, input) => Promise.resolve(receipt(input))); });
describe("explicit catalog SKU assignments", () => {
  it("sends only exact selected product revisions and the saved settings revision, then projects a private-field-free receipt", async () => {
    mocks.call.mockImplementationOnce((_name, input) => Promise.resolve(receipt(input, { counterIndex: "private", actorUid: "private", skuReservations: ["private"] })));
    const result = await assignCatalogSkus("hotel-a", { ...selection, sourceNames: ["Private hotel product name"], products: selection.products.map((product) => ({ ...product, supplierSku: "hidden" })) });
    expect(mocks.call).toHaveBeenCalledWith("assignHotelCatalogSkus", { hotelUid: "hotel-a", requestId: expect.any(String), ...selection });
    expect(result).toEqual({ hotelUid: "hotel-a", requestId: expect.any(String), settingsRevision: 5, assigned: [
      { productId: "milk", revision: 3, internalSku: "CAT-000017" }, { productId: "water", revision: 1, internalSku: "CAT-000018" },
    ] });
    expect(getPendingCatalogSkuAssignment("hotel-a")).toBeNull(); expect(JSON.stringify(result)).not.toMatch(/counterIndex|actorUid|skuReservations|private|supplierSku/);
  });
  it("keeps only scoped IDs and revisions after a lost acknowledgment and replays the immutable original command after remount", async () => {
    mocks.call.mockRejectedValueOnce(new Error("Response lost"));
    await expect(assignCatalogSkus("hotel-a", selection)).rejects.toThrow("Response lost");
    const original = mocks.call.mock.calls[0][1], saved = getPendingCatalogSkuAssignment("hotel-a");
    expect(saved.requestId).toBe(original.requestId); expect(saved.products).toEqual(selection.products);
    expect(sessionStorage.getItem("catalog-sku-assignment:manager:hotel-a")).not.toMatch(/name|internalSku|counterIndex|price/);
    await expect(assignCatalogSkus("hotel-a", { ...selection, products: [selection.products[0]] })).rejects.toThrow("original");
    await expect(assignCatalogSkus("hotel-a", { ...selection, expectedSettingsRevision: 9 })).rejects.toThrow("original");
    vi.resetModules();
    const restored = await import("./firebaseCatalogSkuAssignments");
    expect(restored.getPendingCatalogSkuAssignment("hotel-a").requestId).toBe(original.requestId);
    await restored.retryCatalogSkuAssignment("hotel-a");
    expect(mocks.call).toHaveBeenLastCalledWith("assignHotelCatalogSkus", original); expect(restored.getPendingCatalogSkuAssignment("hotel-a")).toBeNull();
  });
  it.each([
    ["wrong hotel", (input) => ({ hotelUid: "hotel-b" })], ["wrong request", () => ({ requestId: "different" })],
    ["counter increment per row", (input) => ({ settingsRevision: input.expectedSettingsRevision + input.products.length })],
    ["reversed products", (input) => ({ assigned: [...receipt(input).data.assigned].reverse() })],
    ["missing product", (input) => ({ assigned: receipt(input).data.assigned.slice(0, 1) })],
    ["wrong product revision", (input) => ({ assigned: receipt(input).data.assigned.map((row) => ({ ...row, revision: row.revision + 1 })) })],
    ["duplicate SKU", (input) => ({ assigned: receipt(input).data.assigned.map((row) => ({ ...row, internalSku: "CAT-000017" })) })],
    ["malformed generated SKU", (input) => ({ assigned: receipt(input).data.assigned.map((row) => ({ ...row, internalSku: " CAT-000017 " })) })],
    ["null row", () => ({ assigned: [null, null] })],
  ])("retains the original command when a receipt contains %s", async (_label, corrupt) => {
    mocks.call.mockImplementationOnce((_name, input) => Promise.resolve(receipt(input, corrupt(input))));
    await expect(assignCatalogSkus("hotel-a", selection)).rejects.toThrow("could not be verified");
    expect(getPendingCatalogSkuAssignment("hotel-a")).not.toBeNull();
  });
  it("only a server-proven uncommitted response releases the original assignment", async () => {
    mocks.call.mockRejectedValueOnce(Object.assign(new Error("Rights changed"), { code: "permission-denied" }));
    await expect(assignCatalogSkus("hotel-a", selection)).rejects.toThrow("Rights changed"); expect(getPendingCatalogSkuAssignment("hotel-a")).not.toBeNull();
    mocks.call.mockRejectedValueOnce(Object.assign(new Error("Settings changed before assigning anything"), { code: "aborted", details: { catalogSkuRequestUncommitted: true } }));
    await expect(retryCatalogSkuAssignment("hotel-a")).rejects.toThrow("Settings changed"); expect(getPendingCatalogSkuAssignment("hotel-a")).toBeNull();
    await assignCatalogSkus("hotel-a", { ...selection, expectedSettingsRevision: 8 });
    expect(mocks.call.mock.calls[2][1].requestId).not.toBe(mocks.call.mock.calls[0][1].requestId);
  });
  it("partitions recovery by hotel and account and rejects an actor change before accepting a response", async () => {
    mocks.call.mockImplementationOnce(async (_name, input) => { mocks.actor = { uid: "other" }; return receipt(input); });
    await expect(assignCatalogSkus("hotel-a", selection)).rejects.toThrow("access changed");
    expect(getPendingCatalogSkuAssignment("hotel-a")).toBeNull(); mocks.actor = { uid: "manager" };
    expect(getPendingCatalogSkuAssignment("hotel-a")).not.toBeNull(); expect(getPendingCatalogSkuAssignment("hotel-b")).toBeNull();
    await retryCatalogSkuAssignment("hotel-a"); expect(getPendingCatalogSkuAssignment("hotel-a")).toBeNull();
  });
  it("does not clear an unknown command after the read authorization epoch changes", async () => {
    mocks.call.mockImplementationOnce(async (_name, input) => { invalidateProcurementReads("hotel-a"); return receipt(input); });
    await expect(assignCatalogSkus("hotel-a", selection)).rejects.toThrow("access changed"); expect(getPendingCatalogSkuAssignment("hotel-a")).not.toBeNull();
  });
  it("rejects malformed, duplicated, oversized or exhausted selections before invoking a callable", async () => {
    for (const patch of [{ products: [] }, { products: [null] }, { products: [selection.products[0], selection.products[0]] },
      { products: Array.from({ length: 26 }, (_, index) => ({ productId: `p-${index}`, expectedRevision: 0 })) },
      { products: [{ productId: "../hotel-b", expectedRevision: 0 }] }, { expectedSettingsRevision: Number.MAX_SAFE_INTEGER },
      { products: [{ productId: "milk", expectedRevision: Number.MAX_SAFE_INTEGER }] }]) {
      await expect(assignCatalogSkus("hotel-a", { ...selection, ...patch })).rejects.toThrow("Select up to 25");
    }
    expect(mocks.call).not.toHaveBeenCalled(); expect(sessionStorage.length).toBe(0);
  });
  it("refuses corrupted persisted selections without inventing replacement request IDs", () => {
    for (const value of ["{broken", "null", JSON.stringify({ hotelUid: "hotel-b", actorUid: "manager", requestId: "old", ...selection })]) {
      sessionStorage.setItem("catalog-sku-assignment:manager:hotel-a", value);
      expect(() => getPendingCatalogSkuAssignment("hotel-a")).toThrow("original SKU assignment");
    }
    expect(mocks.call).not.toHaveBeenCalled();
  });
});
