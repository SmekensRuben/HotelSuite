import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ call: vi.fn(), getDocs: vi.fn(), auth: { currentUser: { uid: "buyer" } } }));
vi.mock("../firebaseConfig", () => ({ auth: mocks.auth, functions: {}, db: {}, collection: (_db, path) => ({ path }),
  query: (reference, ...constraints) => ({ ...reference, constraints }), where: (...values) => ({ where: values }),
  orderBy: (...values) => ({ orderBy: values }), limit: (count) => ({ limit: count }), startAfter: (cursor) => ({ startAfter: cursor }), documentId: () => "__name__",
  getDocs: mocks.getDocs, httpsCallable: (_functions, endpoint) => async (input) => ({ data: await mocks.call(endpoint, input) }) }));
vi.mock("./firebaseSuppliers", () => ({ getSuppliers: vi.fn() }));
import { getCatalogProducts, getSupplierProducts, updateCatalogProduct } from "./firebaseProducts";
import { collectPaginatedProducts } from "./paginatedExport";
import { invalidateProcurementReads } from "./procurementReadPool";

beforeEach(() => {
  vi.clearAllMocks(); sessionStorage.clear(); invalidateProcurementReads(); mocks.auth.currentUser = { uid: "buyer" };
  mocks.getDocs.mockResolvedValue({ docs: [] });
  mocks.call.mockImplementation(async (_endpoint, input) => {
    if (!Number.isInteger(input.pageSize) || input.pageSize < 1 || input.pageSize > 100) throw new Error("Invalid search pagination.");
    return { products: [{ id: "item" }], cursor: null, hasMore: false };
  });
});

describe("bounded canonical product reads", () => {
  it.each([["catalog", getCatalogProducts, { searchTerm: "milk" }], ["supplier", getSupplierProducts, { supplierId: "supplier" }]])("%s requests respect the callable's maximum rather than sending the export size", async (_label, fetch, filters) => {
    expect((await fetch("hotel-a", { ...filters, pageSize: 250 })).products).toEqual([{ id: "item" }]);
    expect(mocks.call).toHaveBeenCalledWith("searchHotelProducts", expect.objectContaining({ hotelUid: "hotel-a", pageSize: 100, offset: 0 }));
  });

  it("collects every later filtered export page while requesting at most 100 rows", async () => {
    const rows = Array.from({ length: 121 }, (_, index) => ({ id: `product-${index}` }));
    mocks.call.mockImplementation(async (_endpoint, input) => {
      if (input.pageSize > 100) throw new Error("Invalid search pagination.");
      const next = input.offset + input.pageSize;
      return { products: rows.slice(input.offset, next), cursor: next < rows.length ? { offset: next } : null, hasMore: next < rows.length };
    });
    expect(await collectPaginatedProducts((options) => getSupplierProducts("hotel-a", options), { supplierId: "supplier" })).toEqual(rows);
    expect(mocks.call.mock.calls.map(([, input]) => [input.pageSize, input.offset])).toEqual([[100, 0], [100, 100]]);
  });

  it("loads an unfiltered supplier page directly from authorized Firestore without a search cold start", async () => {
    const rows = Array.from({ length: 50 }, (_, index) => ({ id: String(index), ref: { path: `supplierproducts/${index}` }, data: () => ({ supplierProductName: "Milk" }) }));
    mocks.getDocs.mockResolvedValue({ docs: rows });
    const page = await getSupplierProducts("hotel-a", { pageSize: 50 });
    expect(page.products).toHaveLength(50); expect(page.hasMore).toBe(true);
    expect(page.cursor).toBe(rows.at(-1)); expect(mocks.call).not.toHaveBeenCalled();
    expect(mocks.getDocs).toHaveBeenCalledWith(expect.objectContaining({ path: "hotels/hotel-a/supplierproducts" }));
  });

  it("shares simultaneous option-source reads and reloads after settlement", async () => {
    const rows = [{ id: "milk", data: () => ({ name: "Milk" }) }];
    mocks.getDocs.mockResolvedValue({ docs: rows });
    await Promise.all([getCatalogProducts("hotel-a"), getCatalogProducts("hotel-a")]);
    expect(mocks.getDocs).toHaveBeenCalledTimes(1);
    rows.push({ id: "bread", data: () => ({ name: "Bread" }) });
    expect(await getCatalogProducts("hotel-a")).toHaveLength(2);
    expect(mocks.getDocs).toHaveBeenCalledTimes(2);
  });

  it("invalidates an older read even when a mutation response is uncertain", async () => {
    let resolve;
    mocks.getDocs.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const old = getCatalogProducts("hotel-a");
    const rejectedOld = expect(old).rejects.toThrow("Hotel access changed");
    mocks.call.mockRejectedValueOnce(new Error("Mutation response lost"));
    await expect(updateCatalogProduct("hotel-a", "milk", { name: "Updated milk" })).rejects.toThrow("Mutation response lost");
    resolve({ docs: [{ id: "milk", data: () => ({ name: "Obsolete milk" }) }] });
    await rejectedOld;
  });

  it.each([-1, 1.5, "wrong"])("rejects invalid requested page size %s before transport", async (pageSize) => {
    await expect(getSupplierProducts("hotel-a", { pageSize, supplierId: "supplier" })).rejects.toThrow("positive whole number");
    expect(mocks.call).not.toHaveBeenCalled(); expect(mocks.getDocs).not.toHaveBeenCalled();
  });

  it("does not hide permission failures or accept repeated search offsets", async () => {
    mocks.call.mockRejectedValueOnce(Object.assign(new Error("Denied"), { code: "functions/permission-denied" }));
    await expect(getSupplierProducts("hotel-a", { pageSize: 100, supplierId: "supplier" })).rejects.toThrow("Denied");
    expect(mocks.getDocs).not.toHaveBeenCalled();
    mocks.call.mockResolvedValue({ products: [{ id: "milk" }], cursor: { offset: 100 }, hasMore: true });
    await expect(getSupplierProducts("hotel-a", { pageSize: 100, supplierId: "supplier", cursor: { offset: 100 } })).rejects.toThrow("pagination is invalid");
  });

  it("does not present SDK memory-cache data as a freshly authorized hotel read", async () => {
    mocks.getDocs.mockResolvedValueOnce({ metadata: { fromCache: true }, docs: [{ id: "stale", data: () => ({ name: "Previously authorized product" }) }] });
    await expect(getCatalogProducts("hotel-a", { pageSize: 50 })).rejects.toThrow("verified with the server");
    mocks.getDocs.mockResolvedValueOnce({ metadata: { fromCache: false }, docs: [] });
    await expect(getCatalogProducts("hotel-a", { pageSize: 50 })).resolves.toMatchObject({ products: [] });
  });
});
