import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ProductsPage from "./ProductsPage";
import SupplierProductsPage from "./SupplierProductsPage";

const mocks = vi.hoisted(() => ({ hotel: "hotel-a", permissions: [], catalog: vi.fn(), supplier: vi.fn(), suppliers: vi.fn(), importCatalog: vi.fn(), importSupplier: vi.fn(), read: vi.fn(), parse: vi.fn(), rows: vi.fn(), write: vi.fn() }));
vi.mock("../../contexts/HotelContext", () => ({ useHotelContext: () => ({ hotelUid: mocks.hotel, permissions: mocks.permissions, isPlatformAdmin: false, subscriptionActive: true }) }));
vi.mock("react-router-dom", () => ({ useNavigate: () => vi.fn() }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key) => key }) }));
vi.mock("../layout/PageShell", () => ({ default: ({ children }) => <main>{children}</main> }));
vi.mock("../../services/firebaseProducts", () => ({ getCatalogProducts: mocks.catalog, getSupplierProducts: mocks.supplier, importCatalogProducts: mocks.importCatalog, importSupplierProducts: mocks.importSupplier }));
vi.mock("../../services/firebaseSuppliers", () => ({ getSuppliers: mocks.suppliers }));
vi.mock("../../services/firebaseSettings", () => ({ getCatalogTaxonomy: () => Promise.resolve({ categories: [{ id: "early", name: "Early" }, { id: "later", name: "Later" }], subcategories: [{ id: "later-sub", name: "Later subcategory", categoryId: "later" }] }) }));
vi.mock("xlsx", () => ({ read: mocks.read, utils: { sheet_to_json: mocks.parse, json_to_sheet: mocks.rows, book_new: () => ({}), book_append_sheet: vi.fn() }, writeFile: mocks.write }));
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const page = (rows) => ({ products: rows, hasMore: false, cursor: null });

describe("catalog loading, taxonomy and complete export", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.hotel = "hotel-a"; mocks.permissions = ["catalogproducts.read", "catalogproducts.create", "supplierproducts.read", "supplierproducts.create", "suppliers.read"]; mocks.suppliers.mockResolvedValue([{ id: "supplier", name: "Supplier" }]); mocks.catalog.mockResolvedValue(page([{ id: "early-product", name: "Early product", category: "Early" }])); mocks.supplier.mockResolvedValue(page([])); });
  afterEach(() => vi.restoreAllMocks());
  it("shows supplier products to a supplierproducts-only reader without forbidden supplier lookups or filters", async () => {
    mocks.permissions = ["supplierproducts.read"];
    mocks.suppliers.mockRejectedValue(new Error("Forbidden supplier read"));
    mocks.supplier.mockResolvedValue(page([{ id: "product", supplierId: "supplier", supplierName: "Frozen supplier", supplierProductName: "Available product" }]));
    render(<SupplierProductsPage />);
    expect(await screen.findByText("Available product")).toBeInTheDocument();
    expect(screen.getByText("Frozen supplier")).toBeInTheDocument();
    expect(mocks.suppliers).not.toHaveBeenCalled();
    expect(screen.queryByRole("combobox", { name: "Filter by supplier" })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(mocks.supplier).toHaveBeenCalledWith("hotel-a", expect.objectContaining({ supplierId: "" }));
  });
  it("removes a selected supplier filter when supplier read permission is revoked", async () => {
    mocks.supplier.mockResolvedValue(page([{ id: "product", supplierProductName: "Available product" }]));
    const view = render(<SupplierProductsPage />);
    await screen.findByRole("option", { name: "Supplier" });
    fireEvent.change(screen.getByRole("combobox", { name: "Filter by supplier" }), { target: { value: "supplier" } });
    await waitFor(() => expect(mocks.supplier).toHaveBeenLastCalledWith("hotel-a", expect.objectContaining({ supplierId: "supplier" })));
    const supplierCalls = mocks.suppliers.mock.calls.length;
    mocks.permissions = ["supplierproducts.read"];
    view.rerender(<SupplierProductsPage />);
    await waitFor(() => expect(mocks.supplier).toHaveBeenLastCalledWith("hotel-a", expect.objectContaining({ supplierId: "" })));
    expect(screen.queryByRole("combobox", { name: "Filter by supplier" })).not.toBeInTheDocument();
    expect(mocks.suppliers).toHaveBeenCalledTimes(supplierCalls);
  });
  it("loads taxonomy independently from page rows and keeps later-page categories selectable", async () => {
    render(<ProductsPage />);
    expect(await screen.findByText("Early product")).toBeInTheDocument();
    const category = screen.getByLabelText("products.filter.category");
    expect(within(category).getByRole("option", { name: "Later" })).toBeInTheDocument();
    fireEvent.change(category, { target: { value: "Later" } });
    expect(await screen.findByRole("option", { name: "Later subcategory" })).toBeInTheDocument();
    expect(within(category).getByRole("option", { name: "Early" })).toBeInTheDocument();
    await waitFor(() => expect(mocks.catalog).toHaveBeenLastCalledWith("hotel-a", expect.objectContaining({ category: "Later" })));
  });
  it("exports every page with no active view filters and writes all 51 records", async () => {
    const all = Array.from({ length: 51 }, (_, id) => ({ id: String(id), name: `Product ${id}` }));
    mocks.catalog.mockImplementation(async (_, options) => options.pageSize === 200
      ? options.cursor ? page(all.slice(50)) : { products: all.slice(0, 50), hasMore: true, cursor: "last" }
      : page(all.slice(0, 1)));
    render(<ProductsPage />);
    await screen.findByText("Product 0");
    fireEvent.change(screen.getByLabelText("products.filter.category"), { target: { value: "Later" } });
    fireEvent.click(screen.getByRole("button", { name: "products.actions.export" }));
    fireEvent.click(screen.getByRole("button", { name: "products.export.full" }));
    await waitFor(() => expect(mocks.write).toHaveBeenCalled());
    expect(mocks.rows.mock.calls[0][0]).toHaveLength(51);
    const exports = mocks.catalog.mock.calls.filter(([, options]) => options.pageSize === 200);
    expect(exports).toHaveLength(2);
    expect(exports.every(([, options]) => options.category === undefined && options.searchTerm === undefined)).toBe(true);
  });
  it.each([["catalog", ProductsPage], ["supplier", SupplierProductsPage]])("%s completes failed loading and retries", async (service, Component) => {
    mocks[service].mockRejectedValueOnce(new Error("Offline")).mockResolvedValue(page([{ id: "recovered", name: "Recovered product", supplierProductName: "Recovered product" }]));
    render(<Component />);
    expect(await screen.findByText("Offline")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Recovered product")).toBeInTheDocument();
  });
  it("ignores reversed category results", async () => {
    const early = deferred(), later = deferred();
    mocks.catalog.mockReturnValueOnce(early.promise).mockReturnValueOnce(later.promise);
    render(<ProductsPage />);
    const select = screen.getByLabelText("products.filter.category");
    await screen.findByRole("option", { name: "Later" });
    fireEvent.change(select, { target: { value: "Later" } });
    await act(async () => later.resolve(page([{ id: "new", name: "New product", category: "Later" }])));
    await act(async () => early.resolve(page([{ id: "old", name: "Obsolete product", category: "Early" }])));
    expect(screen.getByText("New product")).toBeInTheDocument();
    expect(screen.queryByText("Obsolete product")).not.toBeInTheDocument();
  });

  const mutationCases = [["catalog", ProductsPage, "importCatalog"], ["supplier", SupplierProductsPage, "importSupplier"]];
  const prepareImport = () => {
    vi.spyOn(window, "alert").mockImplementation(() => {});
    mocks.read.mockReturnValue({ SheetNames: ["Sheet"], Sheets: { Sheet: {} } });
    mocks.parse.mockReturnValue([{ name: "Parsed for hotel A", supplierProductName: "Parsed for hotel A", supplierId: "supplier", supplierSku: "sku" }]);
  };
  const upload = (view, bytes = Promise.resolve(new ArrayBuffer(1))) => fireEvent.change(view.container.querySelector('input[type="file"]'), { target: { files: [{ arrayBuffer: () => bytes }] } });

  it.each(mutationCases)("%s clears parsed imports when the selected hotel changes", async (_, Component, importer) => {
    prepareImport();
    const view = render(<Component />);
    upload(view);
    await screen.findByText("products.import.title");
    mocks.hotel = "hotel-b";
    await act(async () => view.rerender(<Component />));
    expect(screen.queryByText("products.import.title")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "products.import.overwrite" })).not.toBeInTheDocument();
    expect(mocks[importer]).not.toHaveBeenCalled();
  });

  it.each(mutationCases)("%s ignores a file parse finishing after a hotel change", async (_, Component, importer) => {
    prepareImport();
    const bytes = deferred();
    const view = render(<Component />);
    upload(view, bytes.promise);
    mocks.hotel = "hotel-b";
    view.rerender(<Component />);
    await act(async () => bytes.resolve(new ArrayBuffer(1)));
    expect(screen.queryByText("products.import.title")).not.toBeInTheDocument();
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks[importer]).not.toHaveBeenCalled();
    expect(window.alert).not.toHaveBeenCalled();
  });

  it.each(mutationCases)("%s ignores an import completion after a hotel change", async (service, Component, importer) => {
    prepareImport();
    const pending = deferred();
    mocks[importer].mockReturnValueOnce(pending.promise);
    const view = render(<Component />);
    upload(view);
    await screen.findByText("products.import.title");
    fireEvent.click(screen.getByRole("button", { name: "products.import.overwrite" }));
    await waitFor(() => expect(mocks[importer]).toHaveBeenCalledWith("hotel-a", expect.any(Array), expect.any(Object)));
    mocks.hotel = "hotel-b";
    view.rerender(<Component />);
    await act(async () => pending.resolve({ imported: 1, skipped: 0 }));
    expect(window.alert).not.toHaveBeenCalled();
    expect(mocks[service].mock.calls.filter(([hotel]) => hotel === "hotel-a")).toHaveLength(1);
    expect(screen.queryByText("products.import.title")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "products.actions.import" })).toBeEnabled();
  });

  it.each(mutationCases)("%s cancels an old hotel's export before further pages or file writing", async (service, Component) => {
    const pending = deferred();
    mocks[service].mockImplementation((_, options) => options.pageSize === 200 ? pending.promise : Promise.resolve(page([])));
    const view = render(<Component />);
    fireEvent.click(screen.getByRole("button", { name: "products.actions.export" }));
    fireEvent.click(screen.getByRole("button", { name: "products.export.full" }));
    await waitFor(() => expect(mocks[service]).toHaveBeenCalledWith("hotel-a", expect.objectContaining({ pageSize: 200 })));
    mocks.hotel = "hotel-b";
    view.rerender(<Component />);
    await act(async () => pending.resolve({ products: [{ id: "old", name: "Old hotel product" }], hasMore: true, cursor: "old-cursor" }));
    expect(mocks.write).not.toHaveBeenCalled();
    expect(mocks[service].mock.calls.filter(([, options]) => options.pageSize === 200)).toHaveLength(1);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
