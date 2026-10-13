import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import SupplierProductCreatePage from "./SupplierProductCreatePage";
import SupplierProductEditPage from "./SupplierProductEditPage";

const mocks = vi.hoisted(() => ({ actor: { uid: "manager" }, hotel: "hotel-a", canUpload: true, navigate: vi.fn(), create: vi.fn(), update: vi.fn(), upload: vi.fn(), read: vi.fn(), pending: null, reconcile: vi.fn() }));
vi.mock("../../firebaseConfig", () => ({ auth: { get currentUser() { return mocks.actor; } }, signOut: vi.fn() }));
vi.mock("../../contexts/HotelContext", () => ({ useHotelContext: () => ({ hotelUid: mocks.hotel, permissions: ["supplierproducts.read", "supplierproducts.create", "catalogproducts.read", ...(mocks.canUpload ? ["supplierproducts.update"] : [])], subscriptionActive: true, subscription: { modules: ["procurement"], modulePolicyVersion: 1, status: "active", validUntil: null } }) }));
vi.mock("react-router-dom", () => ({ useNavigate: () => mocks.navigate, useParams: () => ({ productId: "saved-offer" }) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key) => key }) }));
vi.mock("../layout/HeaderBar", () => ({ default: () => null }));
vi.mock("../../services/firebaseProducts", () => ({ createSupplierProduct: mocks.create, updateSupplierProduct: mocks.update,
  getSupplierProduct: mocks.read, getCatalogProducts: async () => [], getPendingProductCommand: () => mocks.pending, retryPendingProductCommand: mocks.reconcile }));
vi.mock("../../services/firebaseSuppliers", () => ({ getSuppliers: async () => [{ id: "supplier", name: "Supplier A" }] }));
vi.mock("../../services/firebaseSupplierProductImages", () => ({ uploadSupplierProductImage: mocks.upload, getSupplierProductImage: async () => new Blob(["webp"], { type: "image/webp" }),
  validateSupplierImageFile: (file) => { if (file.type !== "image/png") throw new Error("Choose PNG"); } }));
const offer = { id: "saved-offer", revision: 9, imageRevision: 3, image: { assetId: "b".repeat(64), status: "ready" }, supplierId: "supplier", supplierSku: "COFFEE", supplierProductName: "Coffee", currency: "EUR", priceBasis: "net", baseUnit: "kg", purchaseUnit: "Bag", baseUnitsPerPurchaseUnit: 1, pricePerPurchaseUnit: 12 };
const result = { hotelUid: "hotel-a", productId: "saved-offer", assetId: "a".repeat(64), imageRevision: 1, status: "ready" };
beforeEach(() => {
  vi.clearAllMocks(); mocks.actor = { uid: "manager" }; mocks.hotel = "hotel-a"; mocks.canUpload = true; mocks.pending = null;
  mocks.create.mockResolvedValue("saved-offer"); mocks.update.mockResolvedValue("saved-offer"); mocks.read.mockResolvedValue(offer); mocks.upload.mockResolvedValue(result); mocks.reconcile.mockResolvedValue({ productId: "saved-offer" });
  URL.createObjectURL = vi.fn(() => "blob:selected"); URL.revokeObjectURL = vi.fn();
});
async function fillCreate() {
  const supplier = screen.getByRole("combobox", { name: /Supplier \*/ });
  fireEvent.focus(supplier); fireEvent.change(supplier, { target: { value: "Supplier" } });
  fireEvent.click(await screen.findByRole("option", { name: "Supplier A" }));
  fireEvent.change(screen.getByLabelText(/Supplier SKU \*/), { target: { value: "COFFEE" } });
  fireEvent.change(screen.getByLabelText(/Supplier product name \*/), { target: { value: "Coffee" } });
  fireEvent.change(screen.getByLabelText(/Supplier content unit \*/), { target: { value: "kg" } });
  const currency = screen.getByRole("combobox", { name: /Supplier contract currency/ });
  fireEvent.focus(currency); fireEvent.change(currency, { target: { value: "Euro" } });
  fireEvent.click(await screen.findByRole("option", { name: "EUR — Euro" }));
  fireEvent.change(screen.getByLabelText(/Default purchase unit \*/), { target: { value: "Bag" } });
  fireEvent.change(screen.getByLabelText(/Default package content/), { target: { value: "1" } });
}
function selectImage(type = "image/png") {
  const file = new File(["image"], "coffee.png", { type });
  fireEvent.change(screen.getByLabelText(/^(Product image|Replace product image) \(optional\)$/), { target: { files: [file] } }); return file;
}
const create = () => fireEvent.click(screen.getByRole("button", { name: "products.actions.create" }));
it("offers a file preview at creation, saves the product first and then uploads automatically", async () => {
  let resolve; mocks.create.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  render(<SupplierProductCreatePage />); await fillCreate(); const file = selectImage();
  expect(screen.getByAltText("Selected upload preview")).toHaveAttribute("src", "blob:selected");
  expect(screen.queryByRole("textbox", { name: /Image URL/i })).not.toBeInTheDocument();
  create(); await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
  expect(mocks.create.mock.calls[0][1]).not.toHaveProperty("imageUrl"); expect(mocks.create.mock.calls[0][1]).not.toHaveProperty("image");
  expect(mocks.upload).not.toHaveBeenCalled();
  await act(async () => resolve("saved-offer"));
  await waitFor(() => expect(mocks.upload).toHaveBeenCalledWith("hotel-a", expect.objectContaining({ id: "saved-offer", imageRevision: 0 }), file));
  await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith("/catalog/supplier-products/saved-offer"));
  expect(mocks.create).toHaveBeenCalledTimes(1); expect(URL.revokeObjectURL).toHaveBeenCalled();
});
it("keeps a confirmed product and safely retries an uncertain image without creating another product", async () => {
  mocks.upload.mockRejectedValueOnce(new Error("Connection lost")); render(<SupplierProductCreatePage />); await fillCreate(); const file = selectImage(); create();
  await screen.findByText("Connection lost"); expect(screen.getByText("Supplier product saved.")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "products.actions.create" })).not.toBeInTheDocument();
  expect(screen.getByLabelText("Upload product image")).toBeDisabled(); expect(mocks.navigate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Retry same image" }));
  await waitFor(() => expect(mocks.upload).toHaveBeenCalledTimes(2));
  expect(mocks.upload.mock.calls[1]).toEqual(mocks.upload.mock.calls[0]); expect(mocks.upload.mock.calls[1][2]).toBe(file); expect(mocks.create).toHaveBeenCalledTimes(1);
});
it.each(["pending", "failed"])("keeps %s thumbnail outcomes explicit instead of navigating as though complete", async (status) => {
  mocks.upload.mockResolvedValueOnce({ ...result, status }); render(<SupplierProductCreatePage />); await fillCreate(); selectImage(); create();
  await screen.findByText(status === "pending" ? /Thumbnail preparation is pending/ : /thumbnail preparation failed/);
  expect(mocks.navigate).not.toHaveBeenCalled(); expect(mocks.create).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "Open saved product" })).toBeInTheDocument();
});
it("carries the original file through reconciliation of an uncertain creation request", async () => {
  mocks.create.mockImplementationOnce(async () => { mocks.pending = { action: "create", product: { supplierProductName: "Coffee" } }; window.dispatchEvent(new Event("product-command-changed")); throw new Error("Create response lost"); });
  render(<SupplierProductCreatePage />); await fillCreate(); const file = selectImage(); create();
  await screen.findByText("Create response lost"); expect(screen.getByRole("button", { name: "products.actions.create" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Retry saved request" }));
  await waitFor(() => expect(mocks.upload).toHaveBeenCalledWith("hotel-a", expect.objectContaining({ id: "saved-offer" }), file));
  expect(mocks.create).toHaveBeenCalledTimes(1); expect(mocks.reconcile).toHaveBeenCalledTimes(1);
});
it("does not save a rejected file implicitly and permits an explicit choice to continue without it", async () => {
  render(<SupplierProductCreatePage />); await fillCreate(); selectImage("image/svg+xml");
  expect(screen.getByText("Choose PNG")).toBeInTheDocument(); expect(screen.getByRole("button", { name: "products.actions.create" })).toBeDisabled();
  expect(mocks.create).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole("button", { name: "Continue without an image" })); create();
  await waitFor(() => expect(mocks.navigate).toHaveBeenCalled()); expect(mocks.upload).not.toHaveBeenCalled();
});
it("allows create-only staff to save without claiming media-update rights", async () => {
  mocks.canUpload = false; render(<SupplierProductCreatePage />); await fillCreate();
  expect(screen.queryByLabelText("Product image (optional)")).not.toBeInTheDocument();
  expect(screen.getByText(/uploads require supplier-product update permission/)).toBeInTheDocument(); create();
  await waitFor(() => expect(mocks.navigate).toHaveBeenCalled()); expect(mocks.upload).not.toHaveBeenCalled();
});
it("discards a late create acknowledgement after same-UID reauthentication", async () => {
  let resolve; mocks.create.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  const view = render(<SupplierProductCreatePage />); await fillCreate(); selectImage(); create(); await waitFor(() => expect(mocks.create).toHaveBeenCalled());
  mocks.actor = { uid: "manager" }; view.rerender(<SupplierProductCreatePage />); await act(async () => resolve("saved-offer"));
  expect(mocks.upload).not.toHaveBeenCalled(); expect(mocks.navigate).not.toHaveBeenCalled();
  expect(screen.queryByAltText("Selected upload preview")).not.toBeInTheDocument();
});
it("edits product terms once and uploads the replacement using the separate media revision", async () => {
  mocks.upload.mockResolvedValueOnce({ ...result, imageRevision: 4 });
  render(<SupplierProductEditPage />); await screen.findByDisplayValue("Coffee"); await screen.findByDisplayValue("Supplier A");
  const file = selectImage(); fireEvent.click(screen.getByRole("button", { name: "products.actions.saveChanges" }));
  await waitFor(() => expect(mocks.update).toHaveBeenCalledWith("hotel-a", "saved-offer", expect.not.objectContaining({ imageUrl: expect.anything() }), undefined, { expectedRevision: 9 }));
  await waitFor(() => expect(mocks.upload).toHaveBeenCalledWith("hotel-a", expect.objectContaining({ id: "saved-offer", imageRevision: 3 }), file));
  expect(mocks.update).toHaveBeenCalledTimes(1);
});
it("keeps the existing managed image when the user discards an invalid replacement", async () => {
  render(<SupplierProductEditPage />); await screen.findByDisplayValue("Coffee"); await screen.findByDisplayValue("Supplier A");
  selectImage("image/svg+xml"); expect(screen.getByRole("button", { name: "products.actions.saveChanges" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Keep current image" }));
  fireEvent.click(screen.getByRole("button", { name: "products.actions.saveChanges" }));
  await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(1)); expect(mocks.upload).not.toHaveBeenCalled();
  expect(mocks.update.mock.calls[0][2]).not.toHaveProperty("image");
  expect(mocks.update.mock.calls[0][2]).not.toHaveProperty("imageRevision");
  expect(mocks.navigate).toHaveBeenCalledWith("/catalog/supplier-products/saved-offer");
});
