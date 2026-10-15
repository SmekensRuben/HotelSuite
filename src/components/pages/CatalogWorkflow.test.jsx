import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ProductsPage from "./ProductsPage";
import SupplierProductsPage from "./SupplierProductsPage";

const mocks = vi.hoisted(() => ({ hotel: "hotel-a", actor: null, permissions: [], navigate: vi.fn(), catalog: vi.fn(), supplier: vi.fn(), suppliers: vi.fn(), importCatalog: vi.fn(), importSupplier: vi.fn(), read: vi.fn(), parse: vi.fn(), rows: vi.fn(), write: vi.fn() }));
vi.mock("../../contexts/HotelContext", () => ({ useHotelContext: () => ({ hotelUid: mocks.hotel, permissions: mocks.permissions, isPlatformAdmin: false, subscriptionActive: true, subscription: { modules: ["procurement", "contracts", "frontoffice", "groups", "revenue"], modulePolicyVersion: 1, status: "active", validUntil: null } }) }));
vi.mock("react-router-dom", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key) => key }) }));
vi.mock("../../firebaseConfig", () => ({ auth: { get currentUser() { return mocks.actor; } } }));
vi.mock("../layout/PageShell", () => ({ default: ({ children }) => <main>{children}</main> }));
vi.mock("../../services/firebaseProducts", () => ({ getCatalogProducts: mocks.catalog, getSupplierProducts: mocks.supplier, importCatalogProducts: mocks.importCatalog, importSupplierProducts: mocks.importSupplier }));
vi.mock("../../services/firebaseSuppliers", () => ({ getSuppliers: mocks.suppliers }));
vi.mock("../catalog/SupplierProductImage", () => ({ default: () => null }));
vi.mock("../../services/firebaseSettings", () => ({ getCatalogTaxonomy: () => Promise.resolve({ categories: [{ id: "early", name: "Early" }, { id: "later", name: "Later" }], subcategories: [{ id: "later-sub", name: "Later subcategory", categoryId: "later" }] }) }));
vi.mock("xlsx", () => ({ read: mocks.read, utils: { sheet_to_json: mocks.parse, json_to_sheet: mocks.rows, book_new: () => ({}), book_append_sheet: vi.fn() }, writeFile: mocks.write }));
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const page = (rows) => ({ products: rows, hasMore: false, cursor: null });
const choose = async (input, name) => {
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: name } });
  fireEvent.click(await screen.findByRole("option", { name }));
};

describe("catalog loading, taxonomy and complete export", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.hotel = "hotel-a"; mocks.actor = null; mocks.permissions = ["catalogproducts.read", "catalogproducts.create", "supplierproducts.read", "supplierproducts.create", "suppliers.read"]; mocks.suppliers.mockResolvedValue([{ id: "supplier", name: "Supplier" }]); mocks.catalog.mockResolvedValue(page([{ id: "early-product", name: "Early product", category: "Early" }])); mocks.supplier.mockResolvedValue(page([])); });
  afterEach(() => vi.restoreAllMocks());
  it("opens sync from the catalog action and removes it when update access is revoked", async () => {
    mocks.permissions.push("supplierproducts.update");
    const view = render(<ProductsPage />);
    await screen.findByText("Early product");
    fireEvent.click(screen.getByRole("button", { name: "Catalog sync" }));
    expect(mocks.navigate).toHaveBeenCalledWith("/catalog/products/sync");
    mocks.permissions = mocks.permissions.filter((permission) => permission !== "supplierproducts.update");
    view.rerender(<ProductsPage />);
    expect(screen.queryByRole("button", { name: "Catalog sync" })).not.toBeInTheDocument();
    view.unmount();
    mocks.permissions.push("supplierproducts.update");
    render(<SupplierProductsPage />);
    await waitFor(() => expect(mocks.supplier).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Catalog sync" })).not.toBeInTheDocument();
  });
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
  it("qualifies raw supplier catalog prices as indicative before an effective-date order preview", async () => {
    mocks.supplier.mockResolvedValue(page([{ id: "product", supplierProductName: "Orange juice", pricePerPurchaseUnit: 12, currency: "EUR", purchaseUnit: "case", priceBasis: "net" }]));
    render(<SupplierProductsPage />);
    expect(await screen.findByText("12 EUR/case")).toBeInTheDocument();
    expect(screen.getByText("Indicative price")).toBeInTheDocument();
    expect(screen.getByText("Order preview checks applicable approved prices.")).toBeInTheDocument();
  });
  it("removes a selected supplier filter when supplier read permission is revoked", async () => {
    mocks.supplier.mockResolvedValue(page([{ id: "product", supplierProductName: "Available product" }]));
    const view = render(<SupplierProductsPage />);
    await choose(screen.getByRole("combobox", { name: "Filter by supplier" }), "Supplier");
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
    await choose(category, "Later");
    const subcategory = screen.getByLabelText("products.filter.subcategory");
    fireEvent.focus(subcategory);
    expect(await screen.findByRole("option", { name: "Later subcategory" })).toBeInTheDocument();
    fireEvent.blur(subcategory);
    fireEvent.focus(category);
    expect(screen.getByRole("option", { name: "Early" })).toBeInTheDocument();
    await waitFor(() => expect(mocks.catalog).toHaveBeenLastCalledWith("hotel-a", expect.objectContaining({ category: "Later" })));
  });
  it("exports every page with no active view filters and writes all 51 records", async () => {
    const all = Array.from({ length: 51 }, (_, id) => ({ id: String(id), name: `Product ${id}` }));
    mocks.catalog.mockImplementation(async (_, options) => options.pageSize === 200
      ? options.cursor ? page(all.slice(50)) : { products: all.slice(0, 50), hasMore: true, cursor: "last" }
      : page(all.slice(0, 1)));
    render(<ProductsPage />);
    await screen.findByText("Product 0");
    await choose(screen.getByLabelText("products.filter.category"), "Later");
    fireEvent.click(screen.getByRole("button", { name: "products.actions.export" }));
    fireEvent.click(screen.getByRole("button", { name: "products.export.full" }));
    await waitFor(() => expect(mocks.write).toHaveBeenCalled());
    expect(mocks.rows.mock.calls[0][0]).toHaveLength(51);
    const exports = mocks.catalog.mock.calls.filter(([, options]) => options.pageSize === 200);
    expect(exports).toHaveLength(2);
    expect(exports.every(([, options]) => options.category === undefined && options.searchTerm === undefined)).toBe(true);
  });
  it("offers template and AI import choices while preserving the existing workbook path", async () => {
    render(<SupplierProductsPage />);
    fireEvent.click(screen.getByRole("button", { name: "products.actions.import" }));
    const dialog = await screen.findByRole("dialog", { name: "Import supplier products" });
    expect(within(dialog).getAllByRole("button", { name: "Close dialog" })).toHaveLength(1);
    expect(within(dialog).getByRole("button", { name: "AI Import" })).toBeEnabled();
    const inputClick = vi.spyOn(HTMLInputElement.prototype, "click");
    fireEvent.click(within(dialog).getByRole("button", { name: "Template Import" }));
    expect(inputClick).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
  it("provides one close control in the supplier export dialog", async () => {
    render(<SupplierProductsPage />);
    fireEvent.click(screen.getByRole("button", { name: "products.actions.export" }));
    const dialog = await screen.findByRole("dialog", { name: "products.export.title" });
    expect(within(dialog).getAllByRole("button", { name: /close|cancel/i })).toHaveLength(1);
    fireEvent.click(within(dialog).getByRole("button", { name: "Close dialog" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
  it("exports all supplier pages with canonical contract, package and read-only provenance fields", async () => {
    const all = Array.from({ length: 51 }, (_, id) => ({ id: `offer-${id}`, revision: id, supplierId: "supplier", supplierSku: `sku-${id}`, supplierProductName: `Offer ${id}`, currency: null, priceBasis: "unknown", gtin: "036000291452", purchaseOptions: [{ id: "single", purchaseUnit: "Bottle", baseUnitsPerPurchaseUnit: 1, pricePerPurchaseUnit: null }], createdBy: "actor", image: { assetId: "asset", status: "ready", policyVersion: 1 }, imageRevision: 2 }));
    mocks.supplier.mockImplementation(async (_, options) => options.pageSize === 200
      ? options.cursor ? page(all.slice(50)) : { products: all.slice(0, 50), hasMore: true, cursor: "last" }
      : page(all.slice(0, 1)));
    render(<SupplierProductsPage />);
    await screen.findByText("Offer 0");
    await choose(screen.getByRole("combobox", { name: "Filter by supplier" }), "Supplier");
    fireEvent.click(screen.getByRole("button", { name: "products.actions.export" }));
    fireEvent.click(screen.getByRole("button", { name: "products.export.full" }));
    await waitFor(() => expect(mocks.write).toHaveBeenCalled());
    const [rows, { header }] = mocks.rows.mock.calls[0];
    expect(rows).toHaveLength(51);
    expect(rows[0]).toMatchObject({ documentId: "offer-0", revision: 0, currency: "", gtin: "036000291452", createdBy: "actor", managedImageAssetId: "asset", managedImageStatus: "ready", imageRevision: 2 });
    expect(JSON.parse(rows[0].purchaseOptions)).toEqual([{ id: "single", purchaseUnit: "Bottle", baseUnitsPerPurchaseUnit: 1, pricePerPurchaseUnit: null }]);
    expect(header).toEqual(expect.arrayContaining(["priceBasis", "priceValidFrom", "priceValidUntil", "revision", "gtin", "updatedBy", "managedImageAssetId"]));
    const exports = mocks.supplier.mock.calls.filter(([, options]) => options.pageSize === 200);
    expect(exports).toHaveLength(2);
    expect(exports.every(([, options]) => options.supplierId === undefined && options.searchTerm === undefined)).toBe(true);
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
    await choose(select, "Later");
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

  it("shows the invalid supplier row without dropping it or opening an overwrite dialog", async () => {
    prepareImport();
    mocks.parse.mockReturnValue([{ supplierId: "supplier", supplierSku: "valid", supplierProductName: "Valid row" }, { supplierId: "supplier", supplierProductName: "Missing SKU" }]);
    const view = render(<SupplierProductsPage />);
    upload(view);
    expect(await screen.findByRole("alert")).toHaveTextContent("Row 3: Supplier, SKU and product name are required");
    expect(screen.queryByText("products.import.title")).not.toBeInTheDocument();
    expect(mocks.importSupplier).not.toHaveBeenCalled();
    expect(window.alert).not.toHaveBeenCalled();
  });
  it("removes a parsed supplier workbook after permission revocation", async () => {
    prepareImport();
    const view = render(<SupplierProductsPage />); upload(view);
    await screen.findByText("products.import.title");
    mocks.permissions = ["supplierproducts.read"];
    await act(async () => view.rerender(<SupplierProductsPage />));
    expect(screen.queryByText("products.import.title")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "products.actions.import" })).toBeDisabled();
    expect(mocks.importSupplier).not.toHaveBeenCalled();
  });
  it("ignores a supplier workbook finishing after the actual Auth session changed", async () => {
    prepareImport();
    const pending = deferred();
    const actor = { uid: "same-uid" }, replacement = { uid: "same-uid" };
    mocks.actor = actor;
    const view = render(<SupplierProductsPage />); upload(view, pending.promise);
    mocks.actor = replacement;
    view.rerender(<SupplierProductsPage />);
    await act(async () => pending.resolve(new ArrayBuffer(1)));
    expect(mocks.read).not.toHaveBeenCalled();
    expect(screen.queryByText("products.import.title")).not.toBeInTheDocument();
  });

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
