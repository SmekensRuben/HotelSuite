import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SupplierProductDetailPage from "./SupplierProductDetailPage";
import SupplierProductFormFields from "./SupplierProductFormFields";

const mocks = vi.hoisted(() => ({ hotel: "hotel-a", permissions: ["catalogproducts.read"], detail: vi.fn(), catalog: vi.fn(), catalogList: vi.fn(), suppliers: vi.fn() }));
vi.mock("../../contexts/HotelContext", () => ({ useHotelContext: () => ({ hotelUid: mocks.hotel, permissions: mocks.permissions, subscriptionActive: true, subscription: { modules: ["procurement"], modulePolicyVersion: 1, status: "active", validUntil: null } }) }));
vi.mock("react-router-dom", () => ({ useParams: () => ({ productId: "orange-offer" }), useNavigate: () => vi.fn() }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key) => key }) }));
vi.mock("../layout/HeaderBar", () => ({ default: () => null }));
vi.mock("../catalog/SupplierProductImage", () => ({ default: ({ product }) => <span>Image for {product.supplierProductName}</span> }));
vi.mock("../catalog/SupplierProductImageUpload", () => ({ default: () => <button type="button">Upload product image</button> }));
vi.mock("../../firebaseConfig", () => ({ auth: { currentUser: { uid: "employee" } }, signOut: vi.fn() }));
vi.mock("../../services/firebaseProducts", () => ({ getSupplierProduct: mocks.detail, getCatalogProduct: mocks.catalog, getCatalogProducts: mocks.catalogList, deleteSupplierProduct: vi.fn(), getPendingProductCommand: () => null, retryPendingProductCommand: vi.fn() }));
vi.mock("../../services/firebaseSuppliers", () => ({ getSuppliers: mocks.suppliers }));
vi.mock("../../hooks/useStaffDisplayNames", () => ({ useStaffDisplayNames: () => ({ createdByName: "Ruben Smekens", updatedByName: "Ela Parane" }) }));
const offer = { id: "orange-offer", supplierId: "supplier", supplierSku: "juice", supplierProductName: "Orange juice carton", baseUnit: "ml", purchaseUnit: "carton", baseUnitsPerPurchaseUnit: 1000, catalogProductId: "catalog-orange", currency: "EUR", priceBasis: "net", pricePerPurchaseUnit: 2 };
const catalog = { id: "catalog-orange", name: "Orange juice", baseUnit: "l", active: true, inventoryTracked: true };
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { resolve, promise }; };

describe("supplier package presentation", () => {
  beforeEach(() => {
    vi.clearAllMocks(); mocks.hotel = "hotel-a"; mocks.permissions = ["catalogproducts.read", "supplierproducts.read"];
    mocks.detail.mockResolvedValue(offer); mocks.catalog.mockResolvedValue(catalog); mocks.catalogList.mockResolvedValue([catalog]); mocks.suppliers.mockResolvedValue([{ id: "supplier", name: "Supplier A" }]);
  });
  it("shows catalog names, distinct stock units and the exact ml/l conversion without exposing document IDs", async () => {
    render(<SupplierProductDetailPage />);
    expect(await screen.findByText("1000 ml = 1 l per purchase unit for stock counts.")).toBeInTheDocument();
    expect(screen.getByText("Orange juice")).toBeInTheDocument();
    expect(screen.getByText("ml (millilitres)")).toBeInTheDocument();
    expect(screen.getByText("l (litres)")).toBeInTheDocument();
    expect(screen.queryByText("catalog-orange")).not.toBeInTheDocument();
    expect(screen.getByText("Ruben Smekens")).toBeInTheDocument();
    expect(screen.getByText("Ela Parane")).toBeInTheDocument();
  });
  it("keeps supplier details usable without catalog read permission and does not attempt the forbidden lookup", async () => {
    mocks.permissions = ["supplierproducts.read"];
    render(<SupplierProductDetailPage />);
    expect(await screen.findByText("Catalog read permission required")).toBeInTheDocument();
    expect(mocks.catalog).not.toHaveBeenCalled();
    expect(screen.queryByText(/1000 ml =/)).not.toBeInTheDocument();
    expect(screen.queryByText("catalog-orange")).not.toBeInTheDocument();
  });
  it("does not present a valid unit conversion as proof that untracked goods are included in stock reports", async () => {
    mocks.catalog.mockResolvedValue({ ...catalog, inventoryTracked: false });
    render(<SupplierProductDetailPage />);
    expect(await screen.findByText(/Catalog inventory tracking is disabled/)).toHaveTextContent("does not make receipts available to stock-count reports");
    expect(screen.getByText("Not tracked")).toBeInTheDocument();
  });
  it("qualifies an archived catalog link without changing historical package units", async () => {
    mocks.catalog.mockResolvedValue({ ...catalog, active: false, archived: true });
    render(<SupplierProductDetailPage />);
    expect(await screen.findByText(/inactive for new purchasing/)).toHaveTextContent("Existing orders keep their reviewed units");
    expect(screen.getByText("1000 ml = 1 l per purchase unit for stock counts.")).toBeInTheDocument();
  });
  it("drops catalog data when permission is revoked, including a late lookup response", async () => {
    const pending = deferred(); mocks.catalog.mockReturnValueOnce(pending.promise);
    const view = render(<SupplierProductDetailPage />);
    await waitFor(() => expect(mocks.catalog).toHaveBeenCalledWith("hotel-a", "catalog-orange"));
    mocks.permissions = ["supplierproducts.read"]; view.rerender(<SupplierProductDetailPage />);
    await act(async () => pending.resolve(catalog));
    expect(screen.getByText("Catalog read permission required")).toBeInTheDocument();
    expect(screen.queryByText("Orange juice")).not.toBeInTheDocument();
    expect(screen.queryByText(/1000 ml =/)).not.toBeInTheDocument();
  });
  it("previews the stock-count conversion and saves original supplier content units", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    render(<SupplierProductFormFields initialData={offer} onSubmit={save} submitLabel="Save" savingLabel="Saving" />);
    expect(await screen.findByText("1000 ml = 1 l per purchase unit for stock counts.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ baseUnit: "ml", baseUnitsPerPurchaseUnit: 1000, catalogProductId: "catalog-orange" })));
  });
  it("retains default and additional package barcode strings without confusing them with the catalog identity", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const product = { ...offer, gtin: "036000291452", purchaseOptions: [{ id: "single-bottle", purchaseUnit: "Bottle", gtin: "06291041500213", baseUnitsPerPurchaseUnit: 500, pricePerPurchaseUnit: null }] };
    render(<SupplierProductFormFields initialData={product} onSubmit={save} submitLabel="Save" savingLabel="Saving" />);
    await screen.findByDisplayValue("Supplier A");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ gtin: "036000291452", catalogProductId: "catalog-orange", purchaseOptions: [{ id: "single-bottle", purchaseUnit: "Bottle", gtin: "06291041500213", baseUnitsPerPurchaseUnit: 500, pricePerPurchaseUnit: null }] })));
  });
  it("requires an explicit contract currency when the saved product currency is unknown", async () => {
    const save = vi.fn();
    const view = render(<SupplierProductFormFields initialData={{ ...offer, currency: null }} onSubmit={save} submitLabel="Save" savingLabel="Saving" />);
    await screen.findByDisplayValue("Supplier A");
    const currency = screen.getByRole("combobox", { name: /Supplier contract currency/ });
    expect(currency).toHaveValue("");
    fireEvent.submit(view.container.querySelector("form"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Select a supported supplier contract currency");
    expect(save).not.toHaveBeenCalled();
    fireEvent.focus(currency); fireEvent.change(currency, { target: { value: "Euro" } });
    fireEvent.click(await screen.findByRole("option", { name: "EUR — Euro" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ currency: "EUR" })));
  });
  it("offers managed-image editing only with product-update rights", async () => {
    const view = render(<SupplierProductDetailPage />);
    await screen.findByText("Orange juice");
    expect(screen.queryByRole("button", { name: "Upload product image" })).not.toBeInTheDocument();
    mocks.permissions = ["supplierproducts.read", "supplierproducts.update", "catalogproducts.read"];
    view.rerender(<SupplierProductDetailPage />);
    expect(await screen.findByRole("button", { name: "Upload product image" })).toBeInTheDocument();
    mocks.permissions = ["supplierproducts.read"];
    view.rerender(<SupplierProductDetailPage />);
    await screen.findByText("Catalog read permission required");
    expect(screen.queryByRole("button", { name: "Upload product image" })).not.toBeInTheDocument();
  });
});
