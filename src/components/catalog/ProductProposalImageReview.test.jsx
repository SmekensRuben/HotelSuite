import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: { currentUser: { uid: "owner" } }, preview: vi.fn(), pending: vi.fn(), prepare: vi.fn(), upload: vi.fn(), decide: vi.fn(), retry: vi.fn(), run: vi.fn() }));
vi.mock("../../firebaseConfig", () => ({ auth: mocks.auth }));
vi.mock("./SupplierProductImage", () => ({ default: () => <span role="img" aria-label="Managed current image" /> }));
vi.mock("../../services/firebaseSupplierProductImages", () => ({ validateSupplierImageFile: (file) => { if (file.type !== "image/png") throw new Error("Choose a supported image."); } }));
vi.mock("../../services/firebaseProductProposalImages", () => ({ getProductProposalImage: mocks.preview, getPendingProductProposalImageAction: mocks.pending, prepareProductProposalImage: mocks.prepare, uploadProductProposalImage: mocks.upload, decideProductProposalImage: mocks.decide, retryProductProposalImageAction: mocks.retry, safeProductProposalImageUrl: (value) => typeof value === "string" && value.startsWith("https://") ? value : null }));
import ProductProposalImageReview from "./ProductProposalImageReview";

const NativeURL = URL;
const image = (overrides = {}) => ({ assetId: "a".repeat(64), status: "ready", selection: "unselected", decisionRevision: 0, sourceUrl: "https://supplier.example/milk.webp", sourcePageUrl: "https://supplier.example/milk", width: 640, height: 480, currentImage: { assetId: null, status: "none", imageRevision: 0 }, attachment: { status: "none", productId: null, error: null }, ...overrides });
const row = (overrides = {}) => ({ rowId: "offer-row", kind: "supplier", action: "create", status: "ready", proposed: { supplierProductName: "Milk case" }, image: image(), ...overrides });
const view = (entry = row(), props = {}) => <ProductProposalImageReview hotelUid="hotel-a" batchId="batch-1" batchRevision={4} row={entry} canEdit onImageAction={mocks.run} {...props} />;
beforeEach(() => {
  vi.clearAllMocks(); mocks.auth.currentUser = { uid: "owner" }; mocks.pending.mockReturnValue(null); mocks.preview.mockResolvedValue(new Blob(["preview"], { type: "image/webp" })); mocks.run.mockImplementation((action) => action()); mocks.prepare.mockResolvedValue({ batchRevision: 5 }); mocks.upload.mockResolvedValue({ batchRevision: 5 }); mocks.decide.mockResolvedValue({ batchRevision: 5 });
  let number = 0; vi.stubGlobal("URL", Object.assign(class extends NativeURL {}, { createObjectURL: vi.fn(() => `blob:private-${++number}`), revokeObjectURL: vi.fn() }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("shows only an authenticated private preview and never selects a prepared image automatically", async () => {
  render(view()); const preview = await screen.findByRole("img", { name: "Proposed image for Milk case" }); expect(preview).toHaveAttribute("src", "blob:private-1"); expect(screen.getByText("Not selected")).toBeInTheDocument(); expect(mocks.decide).not.toHaveBeenCalled();
  expect(mocks.preview).toHaveBeenCalledWith("hotel-a", "batch-1", "offer-row", expect.objectContaining({ assetId: image().assetId }), "display"); expect(screen.getByRole("link", { name: "Image source" })).toHaveAttribute("rel", "noreferrer");
});
it("requires explicit replacement confirmation and sends the reviewed current image revision", async () => {
  render(view(row({ action: "update", productId: "offer-1", image: image({ currentImage: { assetId: "b".repeat(64), status: "ready", imageRevision: 7 } }) })));
  await screen.findByRole("img", { name: "Proposed image for Milk case" }); expect(screen.getByRole("button", { name: "Use this image" })).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox", { name: "Replace the current product image with this reviewed image." })); fireEvent.click(screen.getByRole("button", { name: "Use this image" }));
  await waitFor(() => expect(mocks.decide).toHaveBeenCalledWith("hotel-a", "batch-1", "offer-row", { action: "select", assetId: image().assetId, expectedBatchRevision: 4, replaceExisting: true, expectedImageRevision: 7 }));
});
it("keeps failed image preparation optional and retries the private original without resending a redacted URL", async () => {
  render(view(row({ image: image({ status: "failed", error: { message: "The source image could not be downloaded." } }) })));
  expect(screen.getByText(/Product details can be approved without an image/)).toBeInTheDocument(); fireEvent.click(screen.getByRole("button", { name: "Retry image preparation" }));
  await waitFor(() => expect(mocks.decide).toHaveBeenCalledWith("hotel-a", "batch-1", "offer-row", expect.objectContaining({ action: "retry", assetId: image().assetId }))); expect(mocks.prepare).not.toHaveBeenCalled();
});
it("keeps attachment failures visible after product approval and retries only the image", async () => {
  render(view(row({ status: "applied", result: { productId: "actual-offer" }, image: image({ selection: "selected", attachment: { status: "failed", productId: "actual-offer", error: { message: "Storage is temporarily unavailable." } } }) })));
  expect(screen.getByText(/Product details were saved, but the image was not attached/)).toBeInTheDocument(); fireEvent.click(screen.getByRole("button", { name: "Retry image attachment" }));
  await waitFor(() => expect(mocks.decide).toHaveBeenCalledWith("hotel-a", "batch-1", "offer-row", expect.objectContaining({ action: "attach" }))); expect(mocks.decide.mock.calls[0][3]).not.toHaveProperty("productId");
});
it("prepares a manually chosen file without implicitly selecting it", async () => {
  render(view(row({ image: null }))); fireEvent.click(screen.getByRole("button", { name: "Add an image" })); const file = new File(["pixels"], "milk.png", { type: "image/png" }); fireEvent.change(screen.getByLabelText("Upload proposed product image"), { target: { files: [file] } }); expect(mocks.upload).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Prepare uploaded image" })); await waitFor(() => expect(mocks.upload).toHaveBeenCalledWith("hotel-a", "batch-1", "offer-row", file)); expect(mocks.decide).not.toHaveBeenCalled();
});
it("offers a direct URL as an optional replacement source without loading it in an image element", async () => {
  render(view(row({ image: null }))); fireEvent.click(screen.getByRole("button", { name: "Add an image" })); fireEvent.change(screen.getByLabelText("Direct image URL"), { target: { value: "https://supplier.example/new.png" } }); fireEvent.change(screen.getByLabelText("Image source page"), { target: { value: "https://supplier.example/new" } }); fireEvent.click(screen.getByRole("button", { name: "Prepare image URL" }));
  await waitFor(() => expect(mocks.prepare).toHaveBeenCalledWith("hotel-a", "batch-1", "offer-row", { imageUrl: "https://supplier.example/new.png", sourcePageUrl: "https://supplier.example/new" })); expect(screen.queryByRole("img")).not.toBeInTheDocument(); expect(mocks.decide).not.toHaveBeenCalled();
});
it("revokes private object URLs when the asset changes and when the review unmounts", async () => {
  const mounted = render(view()); await screen.findByRole("img", { name: "Proposed image for Milk case" }); mounted.rerender(view(row({ image: image({ assetId: "c".repeat(64) }) }))); await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledTimes(2)); expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:private-1"); mounted.unmount(); expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:private-2");
});
it("drops delayed private previews after an authenticated identity change", async () => {
  let resolve; mocks.preview.mockReturnValueOnce(new Promise((done) => { resolve = done; })); const mounted = render(view()); await waitFor(() => expect(mocks.preview).toHaveBeenCalled()); mocks.auth.currentUser = { uid: "owner" }; await act(async () => { resolve(new Blob(["private"], { type: "image/webp" })); }); expect(URL.createObjectURL).not.toHaveBeenCalled(); mounted.unmount();
});
it("keeps image actions disabled for restricted readers and during product review operations", async () => {
  const mounted = render(view(row(), { canEdit: false })); await screen.findByRole("img", { name: "Proposed image for Milk case" }); expect(screen.getByRole("button", { name: "Use this image" })).toBeDisabled(); expect(screen.getByRole("button", { name: "Omit image" })).toBeDisabled(); mounted.rerender(view(row(), { disabled: true })); expect(screen.getByRole("button", { name: "Use this image" })).toBeDisabled(); expect(mocks.decide).not.toHaveBeenCalled();
});
it("requires supplier-product update permission when a create-only reviewer would replace an existing image", async () => {
  render(view(row({ image: image({ currentImage: { assetId: "b".repeat(64), status: "ready", imageRevision: 3 } }) }), { canReplaceExisting: false })); await screen.findByRole("img", { name: "Proposed image for Milk case" }); expect(screen.getByRole("checkbox", { name: "Replace the current product image with this reviewed image." })).toBeDisabled(); expect(screen.getByRole("button", { name: "Use this image" })).toBeDisabled(); expect(screen.getByText(/also requires supplier-product update permission/)).toBeInTheDocument(); expect(mocks.decide).not.toHaveBeenCalled();
});
it("recovers a preparing URL image after a browser reload using its private asset identity", async () => {
  render(view(row({ image: image({ status: "preparing", sourceUrl: "https://supplier.example/signed-image.webp" }) })));
  fireEvent.click(screen.getByRole("button", { name: "Retry image preparation" })); await waitFor(() => expect(mocks.decide).toHaveBeenCalledWith("hotel-a", "batch-1", "offer-row", { action: "retry", assetId: image().assetId, expectedBatchRevision: 4, replaceExisting: false }));
  expect(mocks.prepare).not.toHaveBeenCalled(); expect(mocks.decide.mock.calls[0][3]).not.toHaveProperty("imageUrl");
});
it("requires explicit re-review against the current image revision after an attachment conflict", async () => {
  render(view(row({ status: "applied", result: { productId: "actual-offer" }, image: image({ selection: "selected", decisionRevision: 1, currentImage: { assetId: "b".repeat(64), status: "ready", imageRevision: 9 }, attachment: { status: "failed", productId: "actual-offer", error: { code: "image-conflict", message: "The product image changed. Confirm replacement again." } } }) })));
  await screen.findByRole("img", { name: "Proposed image for Milk case" }); expect(screen.getByRole("button", { name: "Confirm replacement again" })).toBeDisabled(); expect(screen.queryByRole("button", { name: "Retry image attachment" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("checkbox", { name: "Replace the current product image with this reviewed image." })); fireEvent.click(screen.getByRole("button", { name: "Confirm replacement again" })); await waitFor(() => expect(mocks.decide).toHaveBeenCalledWith("hotel-a", "batch-1", "offer-row", { action: "select", assetId: image().assetId, expectedBatchRevision: 4, replaceExisting: true, expectedImageRevision: 9 }));
});
it("recovers an attaching image after a browser reload without creating another product", async () => {
  render(view(row({ status: "applied", result: { productId: "actual-offer" }, image: image({ selection: "selected", attachment: { status: "attaching", productId: "actual-offer", error: null } }) })));
  expect(screen.getByRole("button", { name: "Retry image attachment" })).toBeEnabled(); fireEvent.click(screen.getByRole("button", { name: "Retry image attachment" })); await waitFor(() => expect(mocks.decide).toHaveBeenCalledWith("hotel-a", "batch-1", "offer-row", expect.objectContaining({ action: "attach", assetId: image().assetId }))); expect(mocks.prepare).not.toHaveBeenCalled();
});
