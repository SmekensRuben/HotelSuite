import React from "react";
import { MemoryRouter } from "react-router-dom";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ hotel: "hotel-a", auth: { currentUser: { uid: "owner" } }, permissions: [], list: vi.fn(), read: vi.fn(), review: vi.fn(), retry: vi.fn(), pending: vi.fn(), taxonomy: vi.fn(), suppliers: vi.fn(), catalog: vi.fn() }));
vi.mock("../../firebaseConfig", () => ({ auth: mocks.auth }));
vi.mock("../../contexts/HotelContext", () => ({ useHotelContext: () => ({ hotelUid: mocks.hotel }) }));
vi.mock("../../hooks/usePermission", () => ({ usePermission: (feature, action) => mocks.permissions.includes(`${feature}.${action}`) }));
vi.mock("../../hooks/useSupplierProductAuthority", () => ({ useSupplierProductAuthority: () => JSON.stringify([mocks.hotel, mocks.auth.currentUser, mocks.permissions]) }));
vi.mock("../../services/firebaseProductProposals", () => ({ listProductProposalBatches: mocks.list, readProductProposalBatch: mocks.read, reviewProductProposals: mocks.review, retryProductProposalReview: mocks.retry, getPendingProductProposalReview: mocks.pending }));
vi.mock("../../services/firebaseSettings", () => ({ getCatalogTaxonomy: mocks.taxonomy }));
vi.mock("../../services/firebaseSuppliers", () => ({ getSuppliers: mocks.suppliers }));
vi.mock("../../services/firebaseProducts", () => ({ getCatalogProducts: mocks.catalog }));
vi.mock("../layout/PageShell", () => ({ default: ({ children }) => <main>{children}</main> }));
vi.mock("../shared/Modal", () => ({ default: ({ open, title, children }) => open ? <section role="dialog" aria-label={title}>{children}</section> : null }));
import ProductProposalsPage from "./ProductProposalsPage";

const row = (overrides = {}) => ({ rowId: "catalog-row", kind: "catalog", action: "create", status: "ready", expectedRevision: 0, original: null, proposed: { name: "Whole milk", baseUnit: "l", active: true, inventoryTracked: true }, patch: { name: "Whole milk", baseUnit: "l", active: true, inventoryTracked: true }, issues: [], ...overrides });
let batch;
const wrap = (path = "/catalog/products/proposals?batchId=batch-1") => <MemoryRouter initialEntries={[path]}><ProductProposalsPage /></MemoryRouter>;
const article = (name = "Whole milk") => within(screen.getByRole("article", { name: `Product proposal: ${name}` }));
beforeEach(() => {
  vi.clearAllMocks(); mocks.hotel = "hotel-a"; mocks.auth.currentUser = { uid: "owner" }; mocks.permissions = ["catalogproducts.read", "catalogproducts.create", "catalogproducts.update", "supplierproducts.read", "supplierproducts.create", "supplierproducts.update", "suppliers.read"];
  batch = { hotelUid: "hotel-a", batchId: "batch-1", revision: 1, status: "review", source: { label: "Sligro list", url: "https://supplier.example/list", documentDate: "2026-10-10" }, rows: [row()], summary: { total: 1 } };
  mocks.pending.mockReturnValue(null); mocks.read.mockImplementation(async () => structuredClone(batch));
  mocks.list.mockResolvedValue({ hotelUid: "hotel-a", batches: [{ ...batch, rows: undefined }], nextCursor: null });
  mocks.taxonomy.mockResolvedValue({ categories: [{ id: "food", name: "Food" }, { id: "drinks", name: "Drinks" }], subcategories: [{ id: "dairy", name: "Dairy", categoryId: "food" }, { id: "juice", name: "Juice", categoryId: "drinks" }] });
  mocks.suppliers.mockResolvedValue([{ id: "supplier-1", name: "Sligro" }]); mocks.catalog.mockResolvedValue({ products: [], hasMore: false });
  mocks.review.mockImplementation(async (_, __, input) => { batch.revision += 1; if (input.action === "approve") batch.rows = batch.rows.map((item) => input.rowIds.includes(item.rowId) ? { ...item, status: "applied", result: { productId: `created-${item.rowId}` } } : item); if (input.action === "skip") batch.rows = batch.rows.map((item) => input.rowIds.includes(item.rowId) ? { ...item, status: "skipped" } : item); return structuredClone(batch); });
});

it("lists private batches and opens the selected batch with its source", async () => {
  render(wrap("/catalog/products/proposals")); await screen.findByRole("button", { name: /Sligro list/ }); expect(mocks.read).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: /Sligro list/ })); await screen.findByRole("article", { name: "Product proposal: Whole milk" }); expect(mocks.read).toHaveBeenCalledWith("hotel-a", "batch-1"); expect(screen.getByRole("link", { name: "https://supplier.example/list" })).toHaveAttribute("rel", "noreferrer");
});
it("retains a retryable setup failure and opens the original staged batch after recovery", async () => {
  const message = "MCP setup is incomplete. Ask your operator to finish setup, then retry. Saved proposals have not been changed.";
  mocks.list.mockRejectedValueOnce(Object.assign(new Error(message), { code: "functions/failed-precondition" }));
  render(wrap("/catalog/products/proposals"));
  expect(await screen.findByRole("alert")).toHaveTextContent(message);
  expect(screen.queryByText(/No product proposals are available/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  fireEvent.click(await screen.findByRole("button", { name: /Sligro list/ }));
  await screen.findByRole("article", { name: "Product proposal: Whole milk" });
  expect(mocks.list).toHaveBeenCalledTimes(2); expect(mocks.read).toHaveBeenCalledWith("hotel-a", "batch-1");
  expect(mocks.review).not.toHaveBeenCalled();
});
it("requires explicit confirmation for individual and bulk approval and retains invalid rows", async () => {
  batch.rows.push(row({ rowId: "invalid-row", status: "invalid", proposed: { name: "Unknown package" }, patch: { name: "Unknown package" }, issues: [{ code: "unit", severity: "error", message: "Choose a supported unit." }] }));
  render(wrap()); await screen.findByRole("heading", { name: "Whole milk" }); expect(screen.getByRole("checkbox", { name: "Select invalid-row" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Select valid proposals (1)" })); fireEvent.click(screen.getByRole("button", { name: "Review approval (1)" })); expect(mocks.review).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Confirm approval" })); await screen.findByText(/Review results saved/);
  expect(mocks.review).toHaveBeenCalledWith("hotel-a", "batch-1", { expectedRevision: 1, action: "approve", rowIds: ["catalog-row"] }); expect(article("Unknown package").getByText("Choose a supported unit.", { exact: false })).toBeInTheDocument(); expect(screen.getByRole("link", { name: "Open product" })).toHaveAttribute("href", "/catalog/products/created-catalog-row");
});
it("includes eligible catalog dependencies when individually approving a supplier proposal", async () => {
  batch.rows.push(row({ rowId: "supplier-row", kind: "supplier", proposed: { supplierProductName: "Milk case" }, patch: { supplierProductName: "Milk case", supplierId: "supplier-1" }, catalogRowId: "catalog-row" }));
  render(wrap()); await screen.findByRole("heading", { name: "Milk case" }); fireEvent.click(article("Milk case").getByRole("button", { name: "Approve this proposal" }));
  expect(screen.getByRole("dialog")).toHaveTextContent("Apply 2 reviewed proposals"); fireEvent.click(screen.getByRole("button", { name: "Confirm approval" })); await waitFor(() => expect(mocks.review).toHaveBeenCalled()); expect(mocks.review.mock.calls[0][2].rowIds).toEqual(["catalog-row", "supplier-row"]);
});
it("prevents approving a supplier dependency without catalog create permission", async () => {
  mocks.permissions = mocks.permissions.filter((item) => item !== "catalogproducts.create");
  batch.rows.push(row({ rowId: "supplier-row", kind: "supplier", proposed: { supplierProductName: "Milk case" }, patch: { supplierProductName: "Milk case" }, catalogRowId: "catalog-row" }));
  render(wrap()); await screen.findByRole("heading", { name: "Milk case" }); expect(article().getByRole("button", { name: "Correct proposal" })).toBeDisabled(); expect(article("Milk case").getByRole("button", { name: "Approve this proposal" })).toBeDisabled(); expect(mocks.review).not.toHaveBeenCalled();
});
it("uses existing taxonomy comboboxes and keeps omissions separate from explicit clears", async () => {
  batch.rows[0] = row({ action: "update", productId: "catalog-1", original: { name: "Whole milk", brand: "Original", category: "Food", subcategory: "Dairy" }, patch: { name: "Whole milk", brand: "Suggested", category: "Food", subcategory: "Dairy", notes: "Source note" } });
  render(wrap()); await screen.findByRole("heading", { name: "Whole milk" }); fireEvent.click(article().getByRole("button", { name: "Correct proposal" }));
  const category = screen.getByRole("combobox", { name: "Value for Category" }); await waitFor(() => expect(category).toBeEnabled());
  fireEvent.focus(category); fireEvent.change(category, { target: { value: "Invented category" } }); expect(screen.queryByRole("option", { name: "Invented category" })).not.toBeInTheDocument(); fireEvent.change(category, { target: { value: "Drinks" } }); fireEvent.click(screen.getByRole("option", { name: "Drinks" }));
  expect(screen.getByRole("combobox", { name: "Treatment for Subcategory" })).toHaveValue("clear"); fireEvent.change(screen.getByRole("combobox", { name: "Treatment for Subcategory" }), { target: { value: "set" } }); const subcategory = screen.getByRole("combobox", { name: "Value for Subcategory" }); fireEvent.focus(subcategory); expect(screen.queryByRole("option", { name: "Dairy" })).not.toBeInTheDocument(); fireEvent.click(screen.getByRole("option", { name: "Juice" }));
  fireEvent.change(screen.getByRole("combobox", { name: "Treatment for Brand" }), { target: { value: "keep" } }); fireEvent.change(screen.getByRole("combobox", { name: "Treatment for Notes" }), { target: { value: "clear" } }); fireEvent.click(screen.getByRole("button", { name: "Save correction for review" }));
  await waitFor(() => expect(mocks.review).toHaveBeenCalled()); const patch = mocks.review.mock.calls[0][2].corrections[0].product; expect(patch).not.toHaveProperty("brand"); expect(patch.notes).toBe(""); expect(patch.category).toBe("Drinks"); expect(patch.subcategory).toBe("Juice");
});
it("requires an explicit comparison acknowledgement before reconciling a conflict", async () => {
  batch.rows[0] = row({ action: "update", productId: "catalog-1", expectedRevision: 1, status: "conflict", original: { name: "Milk old" }, current: { name: "Milk current" }, currentRevision: 3 });
  render(wrap()); await screen.findByRole("heading", { name: "Whole milk" }); expect(article().getByRole("button", { name: "Approve this proposal" })).toBeDisabled(); expect(screen.getByRole("columnheader", { name: "Current" })).toBeInTheDocument(); fireEvent.click(article().getByRole("button", { name: "Correct proposal" })); expect(screen.getByRole("button", { name: "Save correction for review" })).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox", { name: /I compared the current values/ })); fireEvent.click(screen.getByRole("button", { name: "Save correction for review" })); await waitFor(() => expect(mocks.review).toHaveBeenCalled()); expect(mocks.review.mock.calls[0][2].corrections[0]).toMatchObject({ expectedRevision: 3, acknowledgeCurrent: true });
});
it("retains a lost-response request and recovers exactly that operation before further changes", async () => {
  const pending = { requestId: "original-review", input: { batchId: "batch-1", expectedRevision: 1, action: "approve", rowIds: ["catalog-row"] } };
  mocks.review.mockImplementationOnce(async () => { mocks.pending.mockReturnValue(pending); throw new Error("Acknowledgement lost"); }); mocks.retry.mockImplementationOnce(async () => { mocks.pending.mockReturnValue(null); batch.rows[0].status = "applied"; return structuredClone(batch); });
  render(wrap()); await screen.findByRole("heading", { name: "Whole milk" }); fireEvent.click(article().getByRole("button", { name: "Approve this proposal" })); fireEvent.click(screen.getByRole("button", { name: "Confirm approval" })); await screen.findByText("Acknowledgement lost"); expect(article().getByRole("button", { name: "Correct proposal" })).toBeDisabled(); fireEvent.click(screen.getByRole("button", { name: "Retry original review" })); await waitFor(() => expect(mocks.retry).toHaveBeenCalledWith("hotel-a", "batch-1")); expect(mocks.review).toHaveBeenCalledTimes(1);
});
it("drops a delayed response when the selected hotel changes", async () => {
  let resolve; mocks.read.mockReturnValueOnce(new Promise((done) => { resolve = done; })); const view = render(wrap()); mocks.hotel = "hotel-b"; const other = { ...batch, hotelUid: "hotel-b", source: { label: "Hotel B" }, rows: [row({ proposed: { name: "Hotel B product" }, patch: { name: "Hotel B product" } })] }; mocks.read.mockResolvedValueOnce(other); view.rerender(wrap()); await screen.findByRole("heading", { name: "Hotel B product" }); await act(async () => { resolve(structuredClone(batch)); }); expect(screen.queryByText("Whole milk")).not.toBeInTheDocument();
});
it("resumes a server-reported interrupted approval before enabling other actions", async () => {
  batch.processing = true; batch.pendingReview = { requestId: "original-review", expectedRevision: 1, action: "approve", rowIds: ["catalog-row"] };
  mocks.read.mockImplementationOnce(async () => { mocks.pending.mockReturnValue({ requestId: "original-review", input: { batchId: "batch-1", expectedRevision: 1, action: "approve", rowIds: ["catalog-row"] } }); return structuredClone(batch); });
  mocks.retry.mockImplementationOnce(async () => { mocks.pending.mockReturnValue(null); batch.processing = false; batch.pendingReview = null; batch.rows[0].status = "applied"; return structuredClone(batch); });
  render(wrap()); await screen.findByRole("heading", { name: "Whole milk" }); expect(article().getByRole("button", { name: "Approve this proposal" })).toBeDisabled(); fireEvent.click(screen.getByRole("button", { name: "Retry original review" })); await waitFor(() => expect(mocks.retry).toHaveBeenCalledWith("hotel-a", "batch-1")); expect(mocks.review).not.toHaveBeenCalled();
});
it("allows invalid typed source values to be corrected without inventing defaults", async () => {
  batch.rows[0] = row({ status: "invalid", patch: { name: "Whole milk", allergens: "milk" }, issues: [{ severity: "error", code: "allergens", message: "Use allergen labels." }] });
  render(wrap()); await screen.findByRole("heading", { name: "Whole milk" }); fireEvent.click(article().getByRole("button", { name: "Correct proposal" })); fireEvent.change(screen.getByRole("textbox", { name: "Value for Allergens" }), { target: { value: "milk, lactose" } });
  expect(screen.getByRole("combobox", { name: "Treatment for Physical base unit" })).toHaveValue("keep"); fireEvent.click(screen.getByRole("button", { name: "Save correction for review" })); await waitFor(() => expect(mocks.review).toHaveBeenCalled()); const correction = mocks.review.mock.calls[0][2].corrections[0]; expect(correction.product.allergens).toEqual(["milk", "lactose"]); expect(correction.product).not.toHaveProperty("baseUnit"); expect(correction).not.toHaveProperty("catalogRowId");
});
it("links supplier-only readers back to Supplier Products", async () => {
  mocks.permissions = ["supplierproducts.read", "supplierproducts.update", "suppliers.read"];
  batch.rows = [row({ rowId: "supplier-row", kind: "supplier", proposed: { supplierProductName: "Milk case" }, patch: { supplierProductName: "Milk case" } })];
  render(wrap()); await screen.findByRole("heading", { name: "Milk case" });
  expect(screen.getByRole("link", { name: "← Supplier Products" })).toHaveAttribute("href", "/catalog/supplier-products"); expect(screen.queryByRole("link", { name: "← Catalog Products" })).not.toBeInTheDocument();
});
it("keeps existing package IDs and omitted package prices when correcting content", async () => {
  batch.rows = [row({ rowId: "supplier-row", kind: "supplier", action: "update", productId: "offer-1", proposed: { supplierProductName: "Milk case" }, original: { purchaseOptions: [{ id: "case", purchaseUnit: "Case", baseUnitsPerPurchaseUnit: 12, pricePerPurchaseUnit: 24 }, { id: "bottle", purchaseUnit: "Bottle", baseUnitsPerPurchaseUnit: 1, pricePerPurchaseUnit: 3 }] }, patch: { supplierProductName: "Milk case", purchaseOptions: [{ id: "case", baseUnitsPerPurchaseUnit: 24 }] } })];
  render(wrap()); await screen.findByRole("heading", { name: "Milk case" }); fireEvent.click(article("Milk case").getByRole("button", { name: "Correct proposal" }));
  expect(screen.queryByRole("button", { name: /Remove.*package 1/ })).not.toBeInTheDocument(); expect(screen.getByText(/Existing package retained/)).toBeInTheDocument();
  fireEvent.change(screen.getByRole("spinbutton", { name: "Package content for option 1" }), { target: { value: "30" } }); fireEvent.click(screen.getByRole("button", { name: "Save correction for review" })); await waitFor(() => expect(mocks.review).toHaveBeenCalled());
  expect(mocks.review.mock.calls[0][2].corrections[0].product.purchaseOptions).toEqual([{ id: "case", baseUnitsPerPurchaseUnit: 30 }]);
});
it("requires an explicit clear-all package action and shows its effect before saving", async () => {
  batch.rows = [row({ rowId: "supplier-row", kind: "supplier", action: "update", productId: "offer-1", proposed: { supplierProductName: "Milk case" }, original: { purchaseOptions: [{ id: "case", purchaseUnit: "Case", baseUnitsPerPurchaseUnit: 12, pricePerPurchaseUnit: 24 }] }, patch: { supplierProductName: "Milk case", purchaseOptions: [{ id: "case", baseUnitsPerPurchaseUnit: 24 }] } })];
  render(wrap()); await screen.findByRole("heading", { name: "Milk case" }); fireEvent.click(article("Milk case").getByRole("button", { name: "Correct proposal" })); fireEvent.click(screen.getByRole("button", { name: "Clear all additional options" }));
  expect(screen.getByText(/This proposal explicitly clears all additional purchase options/)).toBeInTheDocument(); expect(screen.queryByRole("spinbutton", { name: "Package content for option 1" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Save correction for review" })); await waitFor(() => expect(mocks.review).toHaveBeenCalled()); expect(mocks.review.mock.calls[0][2].corrections[0].product.purchaseOptions).toEqual([]);
});
it("drops the package patch when the last newly proposed option is removed", async () => {
  batch.rows = [row({ rowId: "supplier-row", kind: "supplier", action: "update", productId: "offer-1", proposed: { supplierProductName: "Milk case" }, original: { purchaseOptions: [{ id: "case", purchaseUnit: "Case", baseUnitsPerPurchaseUnit: 12, pricePerPurchaseUnit: 24 }] }, patch: { supplierProductName: "Milk case", purchaseOptions: [{ id: "new-package", purchaseUnit: "Pallet", baseUnitsPerPurchaseUnit: 500 }] } })];
  render(wrap()); await screen.findByRole("heading", { name: "Milk case" }); fireEvent.click(article("Milk case").getByRole("button", { name: "Correct proposal" })); fireEvent.click(screen.getByRole("button", { name: "Remove proposed package 1" })); expect(screen.getByRole("combobox", { name: "Treatment for purchase options" })).toHaveValue("keep");
  fireEvent.click(screen.getByRole("button", { name: "Save correction for review" })); await waitFor(() => expect(mocks.review).toHaveBeenCalled()); expect(mocks.review.mock.calls[0][2].corrections[0].product).not.toHaveProperty("purchaseOptions");
});
it("renders validation for malformed source names and uses readable product details", async () => {
  batch.rows = [row({ rowId: "supplier-row", kind: "supplier", productId: "technical-product-hash", status: "invalid", proposed: { supplierProductName: { text: "Malformed source name" }, brand: { unexpected: true } }, patch: { supplierProductName: { text: "Malformed source name" }, supplierSku: "SL-001", brand: "Acme", baseUnit: "l" }, original: { supplierProductName: "Existing milk" }, issues: [{ severity: "error", code: "invalid-name", message: "Supplier product name must be text." }] })];
  render(wrap()); await screen.findByRole("heading", { name: "Existing milk" });
  expect(screen.getByText("Supplier Product · SL-001 · Acme · l")).toBeInTheDocument(); expect(screen.getByText(/Supplier product name must be text/)).toBeInTheDocument(); expect(screen.queryByText("technical-product-hash")).not.toBeInTheDocument(); expect(screen.getByRole("checkbox", { name: "Select supplier-row" })).toBeDisabled(); expect(mocks.review).not.toHaveBeenCalled();
});
