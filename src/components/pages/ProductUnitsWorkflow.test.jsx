import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SupplierProductFormFields from "./SupplierProductFormFields";
import ProductFormFields from "./ProductFormFields";
import OrderCreatePage from "./OrderCreatePage";

const mocks = vi.hoisted(() => ({ hotel: "hotel-a", suppliers: vi.fn(), catalog: vi.fn(), products: vi.fn(), add: vi.fn(), cart: vi.fn(), readCart: vi.fn(), navigate: vi.fn() }));
vi.mock("../../contexts/HotelContext", () => ({ useHotelContext: () => ({ hotelUid: mocks.hotel }) }));
vi.mock("../../services/firebaseSuppliers", () => ({ getSuppliers: mocks.suppliers }));
vi.mock("../../services/firebaseProducts", () => ({ getCatalogProducts: mocks.catalog, getSupplierProducts: mocks.products, uploadCatalogProductImage: vi.fn() }));
vi.mock("../../services/firebaseSettings", () => ({ getOutlets: async () => [], getCatalogTaxonomy: async () => ({ categories: [], subcategories: [] }) }));
vi.mock("../../services/firebaseShoppingCarts", () => ({ addSupplierProductToShoppingCart: mocks.add, getOrCreateShoppingCart: mocks.cart, getPendingCartCommand: () => null, retryPendingCartCommand: vi.fn(), getShoppingCart: mocks.readCart }));
vi.mock("../../firebaseConfig", () => ({ auth: { currentUser: { uid: "user" } }, signOut: vi.fn() }));
vi.mock("react-router-dom", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key) => key }) }));
vi.mock("../layout/HeaderBar", () => ({ default: () => null }));
const validOffer = { supplierId: "supplier", supplierSku: "sku", supplierProductName: "Milk", currency: "EUR", purchaseUnit: "case", baseUnit: "l", baseUnitsPerPurchaseUnit: 6, pricePerPurchaseUnit: 12, priceBasis: "net", catalogProductId: "milk" };

function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { resolve, promise }; }

describe("catalog units, supplier packages and ordering workflow", () => {
  beforeEach(() => {
    vi.clearAllMocks(); mocks.hotel = "hotel-a";
    mocks.suppliers.mockResolvedValue([{ id: "supplier", name: "Supplier A" }]);
    mocks.catalog.mockResolvedValue([{ id: "milk", name: "Catalog milk", baseUnit: "ml", inventoryTracked: true }]);
    mocks.cart.mockResolvedValue({ id: "cart", revision: 0, items: [] }); mocks.add.mockResolvedValue({ revision: 1 }); mocks.readCart.mockResolvedValue({ id: "cart", revision: 1, items: [] });
    mocks.products.mockResolvedValue({ products: [{ id: "offer", ...validOffer }], hasMore: false });
  });
  it("saves a catalog's explicit inventory flag and supported unit", async () => {
    const submit = vi.fn().mockResolvedValue(undefined);
    render(<ProductFormFields hotelUid="hotel-a" onSubmit={submit} savingLabel="Saving" submitLabel="Save" />);
    fireEvent.change(screen.getByLabelText(/products.fields.name/), { target: { value: "Milk" } });
    fireEvent.change(screen.getByLabelText("products.fields.baseUnit"), { target: { value: "ml" } });
    fireEvent.click(screen.getByLabelText("Track this item in physical inventory counts"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(submit).toHaveBeenCalledWith(expect.objectContaining({ name: "Milk", baseUnit: "ml", inventoryTracked: true })));
  });
  it("keeps reviewed catalog and supplier units fixed while permitting package-content edits", async () => {
    const catalogView = render(<ProductFormFields hotelUid="hotel-a" initialData={{ id: "milk", productPolicyVersion: 1, name: "Milk", baseUnit: "ml" }} onSubmit={vi.fn()} savingLabel="Saving" submitLabel="Save" />);
    await act(async () => {});
    expect(screen.getByLabelText(/products.fields.baseUnit/)).toBeDisabled();
    catalogView.unmount();
    render(<SupplierProductFormFields initialData={{ id: "offer", ...validOffer, productPolicyVersion: 1 }} onSubmit={vi.fn()} savingLabel="Saving" submitLabel="Save" />);
    await screen.findByDisplayValue("Supplier A");
    expect(screen.getByLabelText(/Supplier content unit/)).toBeDisabled();
    expect(screen.getByLabelText(/Default package content/)).not.toBeDisabled();
  });
  it("keeps blank supplier prices unknown and permits compatible l/ml catalog links", async () => {
    const submit = vi.fn().mockResolvedValue(undefined);
    render(<SupplierProductFormFields initialData={{ ...validOffer, pricePerPurchaseUnit: null }} onSubmit={submit} savingLabel="Saving" submitLabel="Save" />);
    await screen.findByDisplayValue("Catalog milk (ml)");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(submit).toHaveBeenCalledWith(expect.objectContaining({ baseUnit: "l", catalogProductId: "milk", pricePerPurchaseUnit: null })));
  });
  it("edits the supplier's actual brand separately from the linked catalog article", async () => {
    const submit = vi.fn().mockResolvedValue(undefined);
    render(<SupplierProductFormFields initialData={{ ...validOffer, brand: "Campina" }} onSubmit={submit} savingLabel="Saving" submitLabel="Save" />);
    await screen.findByDisplayValue("Catalog milk (ml)");
    fireEvent.change(screen.getByLabelText(/Brand \(optional\)/), { target: { value: " Arla " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(submit).toHaveBeenCalledWith(expect.objectContaining({ brand: "Arla", catalogProductId: "milk" })));
  });
  it("rejects incompatible catalog dimensions before saving", async () => {
    const submit = vi.fn();
    render(<SupplierProductFormFields initialData={{ ...validOffer, baseUnit: "kg" }} onSubmit={submit} savingLabel="Saving" submitLabel="Save" />);
    await screen.findByDisplayValue("Catalog milk (ml)");
    fireEvent.submit(screen.getByRole("button", { name: "Save" }).closest("form"));
    expect(await screen.findByRole("alert")).toHaveTextContent("same dimension");
    expect(submit).not.toHaveBeenCalled();
  });
  it("requires review of legacy variants rather than silently losing them", async () => {
    const submit = vi.fn();
    render(<SupplierProductFormFields initialData={{ ...validOffer, hasVariants: true, variants: [{ perBaseUnit: 1, packages: 24 }] }} onSubmit={submit} savingLabel="Saving" submitLabel="Save" />);
    await screen.findByDisplayValue("Supplier A");
    fireEvent.submit(screen.getByRole("button", { name: "Save" }).closest("form"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Review the old variants");
    expect(submit).not.toHaveBeenCalled();
  });
  it("preserves blank gross VAT as missing rather than treating it as zero", async () => {
    const submit = vi.fn();
    render(<SupplierProductFormFields initialData={{ ...validOffer, priceBasis: "gross", vatRate: null }} onSubmit={submit} savingLabel="Saving" submitLabel="Save" />);
    await screen.findByDisplayValue("Supplier A");
    fireEvent.submit(screen.getByRole("button", { name: "Save" }).closest("form"));
    expect(await screen.findByRole("alert")).toHaveTextContent("VAT rate"); expect(submit).not.toHaveBeenCalled();
  });
  it("adds a specifically selected package with its exact option ID", async () => {
    mocks.products.mockResolvedValue({ products: [{ id: "offer", ...validOffer, purchaseOptions: [{ id: "single", purchaseUnit: "bottle", baseUnitsPerPurchaseUnit: 1, pricePerPurchaseUnit: 2.5 }] }], hasMore: false });
    render(<OrderCreatePage />);
    const select = await screen.findByRole("combobox", { name: "Purchase option for Milk" });
    fireEvent.focus(select);
    fireEvent.click(await screen.findByRole("option", { name: "bottle" }));
    expect(await screen.findByText(/2.50 EUR \/ bottle/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(mocks.add).toHaveBeenCalledWith("hotel-a", "cart", expect.objectContaining({ id: "offer", purchaseOptionId: "single" }), 1, "single", 0));
  });
  it("does not offer an unknown price as a free order", async () => {
    mocks.products.mockResolvedValue({ products: [{ id: "offer", ...validOffer, pricePerPurchaseUnit: null }], hasMore: false });
    render(<OrderCreatePage />);
    expect(await screen.findByText("Price unavailable")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled(); expect(mocks.add).not.toHaveBeenCalled();
  });
  it("ignores a previous hotel's slow product response after a scope change", async () => {
    const pending = deferred();
    mocks.products.mockImplementation((hotel) => hotel === "hotel-a" ? pending.promise : Promise.resolve({ products: [{ id: "new", ...validOffer, supplierProductName: "Hotel B product" }], hasMore: false }));
    const view = render(<OrderCreatePage />);
    mocks.hotel = "hotel-b"; view.rerender(<OrderCreatePage />);
    await screen.findByText("Hotel B product");
    await act(async () => pending.resolve({ products: [{ id: "old", ...validOffer, supplierProductName: "Hotel A stale product" }], hasMore: false }));
    expect(screen.queryByText("Hotel A stale product")).not.toBeInTheDocument();
  });
});
