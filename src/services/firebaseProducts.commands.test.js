import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ call: vi.fn(), endpoint: vi.fn(), getDoc: vi.fn(), getDocs: vi.fn(), suppliers: vi.fn(), auth: { currentUser: { uid: "hotel-user" } } }));
vi.mock("../firebaseConfig", () => ({ auth: mocks.auth, functions: {}, httpsCallable: (functions, endpoint) => { mocks.endpoint(endpoint); return mocks.call; }, db: {}, collection: (...parts) => parts.join("/"), doc: (...parts) => parts.join("/"), getDoc: mocks.getDoc, getDocs: mocks.getDocs }));
vi.mock("./firebaseSuppliers", () => ({ getSuppliers: mocks.suppliers }));
import { createCatalogProduct, createSupplierProduct, updateSupplierProduct, importCatalogProducts, importSupplierProducts } from "./firebaseProducts";
import { invalidateProcurementReads } from "./procurementReadPool";

const catalog = (name) => ({ name, baseUnit: "each", inventoryTracked: true, active: true });
describe("protected product commands and exact retry identity", () => {
  beforeEach(() => { vi.clearAllMocks(); sessionStorage.clear(); invalidateProcurementReads(); mocks.auth.currentUser = { uid: "hotel-user" }; mocks.getDoc.mockResolvedValue({ exists: () => false }); mocks.getDocs.mockResolvedValue({ docs: [] }); mocks.suppliers.mockResolvedValue([]); });
  it("preserves create identity after a lost response and blocks changed input", async () => {
    mocks.call.mockRejectedValueOnce(new Error("Offline")).mockImplementation(async (input) => ({ data: { hotelUid: input.hotelUid, productId: "stable-id", revision: 1 } }));
    await expect(createCatalogProduct("hotel-a", catalog("Milk"))).rejects.toThrow("Offline");
    const original = mocks.call.mock.calls[0][0];
    await expect(createCatalogProduct("hotel-a", catalog("Different"))).rejects.toThrow("uncertain result");
    expect(mocks.call).toHaveBeenCalledTimes(1);
    expect(await createCatalogProduct("hotel-a", catalog("Milk"))).toBe("stable-id");
    expect(mocks.call.mock.calls[1][0]).toEqual(original);
    expect(sessionStorage.length).toBe(0);
  });
  it("sends supplier SKU edits against the stable ID and explicit revision", async () => {
    mocks.call.mockResolvedValue({ data: { hotelUid: "hotel-a", productId: "stable-id", revision: 8 } });
    await updateSupplierProduct("hotel-a", "stable-id", { supplierSku: "NEW-SKU", pricePerPurchaseUnit: null }, "untrusted-actor", { expectedRevision: 7 });
    expect(mocks.endpoint).toHaveBeenCalledWith("mutateHotelSupplierProduct");
    expect(mocks.call).toHaveBeenCalledWith(expect.objectContaining({ action: "update", productId: "stable-id", expectedRevision: 7, product: { supplierSku: "NEW-SKU", pricePerPurchaseUnit: null } }));
  });
  it("allows corrected input only after the server proves non-commit", async () => {
    mocks.call.mockRejectedValueOnce(Object.assign(new Error("Invalid"), { details: { productRequestUncommitted: true } })).mockResolvedValue({ data: { hotelUid: "hotel-a", productId: "new", revision: 1 } });
    await expect(createSupplierProduct("hotel-a", { supplierSku: "BAD" })).rejects.toThrow("Invalid");
    await createSupplierProduct("hotel-a", { supplierSku: "GOOD" });
    expect(mocks.call.mock.calls[0][0].requestId).not.toBe(mocks.call.mock.calls[1][0].requestId);
  });
  it("separates pending commands between actors and hotels", async () => {
    mocks.call.mockRejectedValue(new Error("Offline"));
    await expect(createCatalogProduct("hotel-a", catalog("A"))).rejects.toThrow();
    await expect(createCatalogProduct("hotel-b", catalog("B"))).rejects.toThrow();
    mocks.auth.currentUser = { uid: "other-user" };
    await expect(createCatalogProduct("hotel-a", catalog("C"))).rejects.toThrow();
    expect(new Set(mocks.call.mock.calls.map(([input]) => input.requestId)).size).toBe(3);
  });
  it("replays a failed import suffix without duplicating successful batches or changing generated IDs", async () => {
    const products = Array.from({ length: 30 }, (_, index) => catalog(`Item ${index}`));
    mocks.call.mockImplementationOnce(async (input) => ({ data: { hotelUid: input.hotelUid, imported: 25, skipped: 0 } }))
      .mockRejectedValueOnce(Object.assign(new Error("Bad row"), { details: { productRequestUncommitted: true } }))
      .mockImplementation(async (input) => ({ data: { hotelUid: input.hotelUid, imported: input.products.length, skipped: 0 } }));
    await expect(importCatalogProducts("hotel-a", products)).rejects.toThrow("25 imported");
    const oldSuffix = mocks.call.mock.calls[1][0];
    const corrected = products.map((product, index) => index === 28 ? { ...product, name: "Corrected item" } : product);
    expect(await importCatalogProducts("hotel-a", corrected)).toEqual({ imported: 30, skipped: 0 });
    expect(mocks.call).toHaveBeenCalledTimes(3);
    expect(mocks.call.mock.calls[2][0].products.map((entry) => entry.productId)).toEqual(oldSuffix.products.map((entry) => entry.productId));
    expect(mocks.call.mock.calls[2][0].requestId).not.toBe(oldSuffix.requestId);
  });
  it("replays identical import payloads after uncertain suffix errors", async () => {
    const products = Array.from({ length: 26 }, (_, index) => catalog(`Item ${index}`));
    mocks.call.mockImplementationOnce(async () => ({ data: { hotelUid: "hotel-a", imported: 25, skipped: 0 } })).mockRejectedValueOnce(new Error("Network"))
      .mockImplementation(async () => ({ data: { hotelUid: "hotel-a", imported: 1, skipped: 0 } }));
    await expect(importCatalogProducts("hotel-a", products)).rejects.toThrow("Network");
    const pending = mocks.call.mock.calls[1][0];
    expect(await importCatalogProducts("hotel-a", products)).toEqual({ imported: 26, skipped: 0 });
    expect(mocks.call.mock.calls[2][0]).toEqual(pending);
  });
  it("does not reuse old non-commit proof after an uncertain retry", async () => {
    const products = Array.from({ length: 26 }, (_, index) => catalog(`Item ${index}`));
    mocks.call.mockImplementationOnce(async () => ({ data: { hotelUid: "hotel-a", imported: 25, skipped: 0 } }))
      .mockRejectedValueOnce(Object.assign(new Error("Validation"), { details: { productRequestUncommitted: true } }))
      .mockRejectedValueOnce(new Error("Lost retry response"));
    await expect(importCatalogProducts("hotel-a", products)).rejects.toThrow("Validation");
    await expect(importCatalogProducts("hotel-a", products)).rejects.toThrow("Lost retry response");
    const changed = products.map((product, index) => index === 25 ? catalog("Changed") : product);
    await expect(importCatalogProducts("hotel-a", changed)).rejects.toThrow("reconcile its result first");
    expect(mocks.call).toHaveBeenCalledTimes(3);
  });
  it("keeps managed image fields out of ordinary product edits while retaining editable barcode metadata", async () => {
    mocks.call.mockResolvedValue({ data: { hotelUid: "hotel-a", productId: "offer", revision: 4 } });
    await updateSupplierProduct("hotel-a", "offer", { supplierSku: "sku", gtin: "036000291452", image: { assetId: "forged" }, imageRevision: 9, purchaseOptions: [{ id: "single", gtin: "06291041500213", purchaseUnit: "Bottle", baseUnitsPerPurchaseUnit: 1, pricePerPurchaseUnit: null }] }, undefined, { expectedRevision: 3 });
    const product = mocks.call.mock.calls[0][0].product;
    expect(product).not.toHaveProperty("image"); expect(product).not.toHaveProperty("imageRevision");
    expect(product.gtin).toBe("036000291452"); expect(product.purchaseOptions[0].gtin).toBe("06291041500213");
  });
  it.each(["same-uid-session", "other-account", "access-revoked"])("stops importing after the first batch when %s changes and preserves exact recovery", async (change) => {
    const products = Array.from({ length: 26 }, (_, index) => catalog(`Item ${index}`));
    const actor = mocks.auth.currentUser;
    mocks.call.mockImplementationOnce(async () => {
      if (change === "access-revoked") invalidateProcurementReads();
      else mocks.auth.currentUser = { uid: change === "other-account" ? "other-user" : actor.uid };
      return { data: { hotelUid: "hotel-a", imported: 25, skipped: 0 } };
    });
    await expect(importCatalogProducts("hotel-a", products)).rejects.toThrow("Hotel access changed");
    expect(mocks.call).toHaveBeenCalledTimes(1);
    const original = mocks.call.mock.calls[0][0];
    const saved = JSON.parse(sessionStorage.getItem("product-command:hotel-user:hotel-a:import:catalogproducts"));
    expect(saved.offset).toBe(0); expect(saved.failedUncommitted).toBe(false);
    expect(saved.batches[0].requestId).toBe(original.requestId);
    mocks.auth.currentUser = actor;
    mocks.call.mockImplementation(async (input) => ({ data: { hotelUid: "hotel-a", imported: input.products.length, skipped: 0 } }));
    await expect(importCatalogProducts("hotel-a", products)).resolves.toEqual({ imported: 26, skipped: 0 });
    expect(mocks.call.mock.calls[1][0]).toEqual(original);
    expect(mocks.call).toHaveBeenCalledTimes(3);
  });
  it("does not prepare or send a supplier import after its supplier lookup crosses an Auth-session boundary", async () => {
    mocks.suppliers.mockImplementation(async () => { mocks.auth.currentUser = { uid: "hotel-user" }; return [{ id: "supplier", name: "Supplier" }]; });
    await expect(importSupplierProducts("hotel-a", [{ supplierId: "supplier", supplierSku: "sku", supplierProductName: "Milk" }])).rejects.toThrow("Hotel access changed");
    expect(mocks.getDocs).not.toHaveBeenCalled(); expect(mocks.call).not.toHaveBeenCalled(); expect(sessionStorage.length).toBe(0);
  });
  it("retains the original uncertain product command after a same-UID Auth replacement", async () => {
    const actor = mocks.auth.currentUser;
    mocks.call.mockImplementationOnce(async () => { mocks.auth.currentUser = { uid: actor.uid }; return { data: { hotelUid: "hotel-a", productId: "stable-id", revision: 1 } }; });
    await expect(createSupplierProduct("hotel-a", { supplierSku: "sku" })).rejects.toThrow("Hotel access changed");
    const original = mocks.call.mock.calls[0][0];
    expect(sessionStorage.getItem("product-command:hotel-user:hotel-a:supplierproducts:create")).not.toBeNull();
    mocks.auth.currentUser = actor;
    mocks.call.mockResolvedValue({ data: { hotelUid: "hotel-a", productId: "stable-id", revision: 1 } });
    await expect(createSupplierProduct("hotel-a", { supplierSku: "sku" })).resolves.toBe("stable-id");
    expect(mocks.call.mock.calls[1][0]).toEqual(original);
  });

});
