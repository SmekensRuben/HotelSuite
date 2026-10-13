import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import SupplierProductImage from "./SupplierProductImage";
import SupplierProductImageUpload from "./SupplierProductImageUpload";
const mocks = vi.hoisted(() => ({ auth: { currentUser: { uid: "manager" } }, canManage: true, upload: vi.fn(), read: vi.fn(), changed: vi.fn() }));
vi.mock("../../firebaseConfig", () => ({ auth: mocks.auth }));
vi.mock("../../contexts/HotelContext", () => ({ useHotelContext: () => ({ permissions: ["supplierproducts.read", ...(mocks.canManage ? ["supplierproducts.update"] : [])], subscriptionActive: true }) }));
vi.mock("../../hooks/usePermission", () => ({ usePermission: (_feature, action) => action === "read" || mocks.canManage }));
vi.mock("../../services/firebaseSupplierProductImages", () => ({ uploadSupplierProductImage: mocks.upload, getSupplierProductImage: mocks.read,
  validateSupplierImageFile: (file) => { if (file.type !== "image/png") throw new Error("Choose PNG"); } }));
const assetId = "a".repeat(64), product = { id: "coffee", supplierProductName: "Coffee", imageRevision: 0 };
beforeEach(() => { vi.clearAllMocks(); mocks.auth.currentUser = { uid: "manager" }; mocks.canManage = true; mocks.upload.mockResolvedValue({ status: "ready" }); mocks.read.mockResolvedValue(new Blob(["webp"], { type: "image/webp" })); mocks.changed.mockResolvedValue(product); URL.createObjectURL = vi.fn(() => "blob:fictional"); URL.revokeObjectURL = vi.fn(); });
const view = (current = product) => <SupplierProductImageUpload hotelUid="hotel-a" product={current} onChanged={mocks.changed} />;
const select = () => { const image = new File(["image"], "coffee.png", { type: "image/png" }); fireEvent.change(screen.getByLabelText("Upload product image"), { target: { files: [image] } }); return image; };
it("shows a safe selection preview, upload progress and verified completion", async () => {
  render(view()); const file = select(); fireEvent.click(screen.getByRole("button", { name: "Save product image" }));
  await waitFor(() => expect(mocks.upload).toHaveBeenCalledWith("hotel-a", product, file)); expect(await screen.findByText("Product image saved with its thumbnail.")).toBeInTheDocument(); expect(mocks.changed).toHaveBeenCalledTimes(1);
});
it("does not offer managed upload without supplier product update permission", () => { mocks.canManage = false; render(view()); expect(screen.queryByLabelText("Upload product image")).not.toBeInTheDocument(); });
it("locks an uncertain request's original product revision even if props refresh before retry", async () => {
  mocks.upload.mockRejectedValueOnce(new Error("Response lost")); const mounted = render(view()); const file = select(); fireEvent.click(screen.getByRole("button", { name: "Save product image" }));
  await screen.findByText("Response lost"); expect(screen.getByLabelText("Upload product image")).toBeDisabled(); mounted.rerender(view({ ...product, imageRevision: 1 }));
  fireEvent.click(screen.getByRole("button", { name: "Retry same image" })); await waitFor(() => expect(mocks.upload).toHaveBeenCalledTimes(2));
  expect(mocks.upload.mock.calls[1]).toEqual(["hotel-a", product, file]);
});
it("separates a confirmed upload from a failed subsequent refresh", async () => {
  mocks.changed.mockRejectedValue(new Error("Read unavailable")); render(view()); select(); fireEvent.click(screen.getByRole("button", { name: "Save product image" }));
  expect(await screen.findByText("Image upload confirmed; product reload failed.")).toBeInTheDocument();
  expect(screen.getByText("Product image saved with its thumbnail.")).toBeInTheDocument(); expect(screen.queryByRole("button", { name: "Retry same image" })).not.toBeInTheDocument();
});
it("ignores an old upload after same-UID reauthentication", async () => {
  let resolve; mocks.upload.mockReturnValueOnce(new Promise((done) => { resolve = done; })); const mounted = render(view()); select(); fireEvent.click(screen.getByRole("button", { name: "Save product image" }));
  mocks.auth.currentUser = { uid: "manager" }; mounted.rerender(view()); await act(async () => resolve({ status: "ready" }));
  expect(mocks.changed).not.toHaveBeenCalled(); expect(screen.queryByText("Product image saved with its thumbnail.")).not.toBeInTheDocument();
});
it("releases private blob previews and does not fall back to an external image when managed processing fails", async () => {
  const managed = { ...product, image: { assetId, status: "ready" } };
  const mounted = render(<SupplierProductImage hotelUid="hotel-a" product={managed} />); expect(await screen.findByAltText("Coffee")).toHaveAttribute("src", "blob:fictional");
  mounted.rerender(<SupplierProductImage hotelUid="hotel-a" product={{ ...managed, image: { assetId, status: "failed" }, imageUrl: "https://external.example/coffee.png" }} />);
  expect(screen.queryByAltText("Coffee")).not.toBeInTheDocument(); expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:fictional");
});
it("loads private thumbnails only when they approach the viewport", async () => {
  let observerCallback; const disconnect = vi.fn(); vi.stubGlobal("IntersectionObserver", class { constructor(callback) { observerCallback = callback; } observe() {} disconnect() { disconnect(); } });
  try {
    render(<SupplierProductImage hotelUid="hotel-a" product={{ ...product, image: { assetId, status: "ready" } }} />);
    expect(mocks.read).not.toHaveBeenCalled(); await act(async () => observerCallback([{ isIntersecting: true }]));
    await screen.findByAltText("Coffee"); expect(mocks.read).toHaveBeenCalledTimes(1); expect(disconnect).toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); }
});
it("never displays an external image URL, even without a managed image", () => {
  render(<SupplierProductImage hotelUid="hotel-a" product={{ ...product, imageUrl: "https://external.example/coffee.png" }} />);
  expect(screen.queryByAltText("Coffee")).not.toBeInTheDocument();
  expect(screen.getByRole("img", { name: "No available image for Coffee" })).toBeInTheDocument();
  expect(mocks.read).not.toHaveBeenCalled();
});
it("automatically uploads the file selected in the product form once under Strict Mode", async () => {
  const file = new File(["image"], "coffee.png", { type: "image/png" });
  render(<React.StrictMode><SupplierProductImageUpload hotelUid="hotel-a" product={product} initialFile={file} autoUpload onChanged={mocks.changed} /></React.StrictMode>);
  await screen.findByText("Product image saved with its thumbnail.");
  expect(mocks.upload).toHaveBeenCalledTimes(1); expect(mocks.upload).toHaveBeenCalledWith("hotel-a", product, file);
  expect(mocks.changed).toHaveBeenCalledWith({ status: "ready" });
});
