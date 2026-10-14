import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: { currentUser: { uid: "manager" } }, hotel: { hotelUid: "hotel-a" }, permissions: { create: true, update: true }, read: vi.fn(), decide: vi.fn(), complete: vi.fn(), job: vi.fn(), confirm: vi.fn(), pending: vi.fn(), updateJob: vi.fn() }));
vi.mock("../../firebaseConfig", () => ({ auth: mocks.auth }));
vi.mock("../../contexts/HotelContext", () => ({ useHotelContext: () => mocks.hotel }));
vi.mock("../../hooks/usePermission", () => ({ usePermission: (feature, action) => feature === "supplierproducts" && action !== "read" ? mocks.permissions[action] : true }));
vi.mock("../../hooks/useSupplierProductAuthority", () => ({ useSupplierProductAuthority: () => JSON.stringify([mocks.hotel.hotelUid, mocks.auth.currentUser, mocks.permissions]) }));
vi.mock("../../contexts/SupplierAiImportProgressContext", () => ({ useSupplierAiImportProgress: () => ({ updateJob: mocks.updateJob }) }));
vi.mock("../../services/firebaseSupplierAiImports", () => ({ getSupplierAiImport: (...args) => mocks.job(...args), confirmSupplierAiImport: (...args) => mocks.confirm(...args), getPendingSupplierAiImportCommit: (...args) => mocks.pending(...args) }));
vi.mock("../../services/firebaseSupplierImportWorkspace", () => ({ readSupplierImportWorkspace: (...args) => mocks.read(...args), decideSupplierImportRows: (...args) => mocks.decide(...args), completeSupplierImportReview: (...args) => mocks.complete(...args) }));
vi.mock("../layout/PageShell", () => ({ default: ({ children }) => <main>{children}</main> }));
vi.mock("../shared/Modal", () => ({ default: ({ open, title, children }) => open ? <div role="dialog" aria-label={title}>{children}</div> : null }));
vi.mock("../catalog/SupplierImportMappingsPanel", () => ({ default: () => null }));
vi.mock("../catalog/SupplierImportProductReview", () => ({ default: ({ row, locked, onApprove, onSkip, onLater, onCorrected }) => <article aria-label="Current product"><h3>{row.product.supplierProductName}</h3><button disabled={locked} onClick={() => onApprove(row)}>Approve product</button><button disabled={locked} onClick={() => onSkip(row)}>Skip product</button><button disabled={locked} onClick={() => onLater(row)}>Save for later</button><button disabled={locked} onClick={() => { data.rows.find((entry) => entry.rowId === row.rowId).reviewRevision++; data.index.find((entry) => entry.rowId === row.rowId).reviewRevision++; data.index.find((entry) => entry.rowId === row.rowId).reviewStatus = "pending"; reconcile(); onCorrected({ ...row, reviewRevision: row.reviewRevision + 1 }); }}>Save correction</button></article> }));
import SupplierAiImportReviewPage from "./SupplierAiImportReviewPage";

let data;
function setup(total = 2) {
  const index = Array.from({ length: total }, (_, i) => ({ rowId: `r-${String(i + 1).padStart(6, "0")}`, reviewRevision: 1, category: "new", requiresUpdate: false, name: `Product ${i + 1}`, sku: `SKU${i + 1}`, reviewStatus: "pending", committedStatus: null, needsAttention: true, bulkEligible: false }));
  return { hotelUid: "hotel-a", jobId: "job", supplierId: "supplier", status: "review", importReviewVersion: 1, totalRows: total, counts: { new: total, changed: 0, unchanged: 0, blocked: 0 }, reviewCounts: { pending: total, approved: 0, skipped: 0, applied: 0, failed: 0 }, outcomeCounts: { created: 0, updated: 0, unchanged: 0 }, index, rows: index.map((entry) => ({ rowId: entry.rowId, reviewRevision: entry.reviewRevision, category: entry.category, product: { supplierProductName: entry.name, supplierSku: entry.sku }, review: { status: "pending", reviewRevision: 1 }, canApprove: true, bulkEligible: false })), sourceFormat: "xlsx", profileId: "default", mappingGroups: [], nextCursor: null, summary: null };
}
function reconcile() {
  data.reviewCounts = { pending: 0, approved: 0, skipped: 0, applied: 0, failed: 0 }; data.outcomeCounts = { created: 0, updated: 0, unchanged: 0 };
  for (const entry of data.index) { data.reviewCounts[entry.reviewStatus]++; if (entry.committedStatus) data.outcomeCounts[entry.committedStatus]++; }
}
function acknowledgeDecision(_, __, rows) {
  for (const row of rows) { const entry = data.index.find((entry) => entry.rowId === row.rowId); entry.reviewStatus = ({ approve: "approved", skip: "skipped", reset: "pending" })[row.action]; data.rows.find((entry) => entry.rowId === row.rowId).review = { status: entry.reviewStatus, reviewRevision: row.reviewRevision }; }
  reconcile(); return Promise.resolve({ rows: structuredClone(data.rows.filter((entry) => rows.some((row) => row.rowId === entry.rowId))) });
}
const mount = () => render(<MemoryRouter initialEntries={["/catalog/supplier-products/imports/job"]}><Routes><Route path="/catalog/supplier-products/imports/:jobId" element={<SupplierAiImportReviewPage />} /></Routes></MemoryRouter>);
beforeEach(() => {
  vi.clearAllMocks(); mocks.auth.currentUser = { uid: "manager" }; mocks.hotel.hotelUid = "hotel-a"; mocks.permissions = { create: true, update: true }; data = setup();
  mocks.pending.mockReturnValue(null); mocks.job.mockImplementation(async () => ({ hotelUid: "hotel-a", jobId: "job", supplierId: "supplier", ownerUid: "manager", status: data.status, source: { fileName: "sligro.xlsx" } }));
  mocks.read.mockImplementation(async (_, __, input) => ({ ...structuredClone(data), rows: structuredClone(input?.focusRowId ? data.rows.filter((row) => row.rowId === input.focusRowId) : data.rows.slice(0, 25)) })); mocks.decide.mockImplementation(acknowledgeDecision);
  mocks.confirm.mockImplementation(async (_, __, rows) => { for (const row of rows) { const entry = data.index.find((entry) => entry.rowId === row.rowId); entry.reviewStatus = "applied"; entry.committedStatus = "created"; } reconcile(); return { outcomes: rows.map((row) => ({ rowId: row.rowId, status: "created" })) }; });
  mocks.complete.mockImplementation(async () => { const complete = data.index.every((entry) => ["applied", "skipped"].includes(entry.reviewStatus)); if (complete) data.status = "completed"; return { completed: complete }; });
});
it("shows complete 250-product totals in a compact 25-row table, with source details absent from the overview", async () => {
  data = setup(250); data.counts = { new: 200, changed: 30, unchanged: 20, blocked: 0 }; mount(); await screen.findByText("250 extracted products"); const overview = screen.getByRole("region", { name: "Import overview" }); expect(within(overview).getByText("200")).toBeInTheDocument(); expect(within(overview).getByText("30")).toBeInTheDocument(); expect(screen.getAllByRole("row")).toHaveLength(26); expect(screen.getByText("1–25 of 250")).toBeInTheDocument(); expect(screen.queryByText("Source evidence")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Next" })); expect(screen.getByText("26–50 of 250")).toBeInTheDocument();
});
it("saves approval as a durable decision and automatically opens the next product without writing supplier products", async () => {
  mount(); await screen.findByText("2 extracted products"); fireEvent.click(screen.getByRole("button", { name: "Start review" })); await screen.findByRole("article", { name: "Current product" }); fireEvent.click(screen.getByRole("button", { name: "Approve product" })); await waitFor(() => expect(within(screen.getByRole("article", { name: "Current product" })).getByText("Product 2")).toBeInTheDocument());
  expect(mocks.decide).toHaveBeenCalledWith("hotel-a", "job", [{ rowId: "r-000001", reviewRevision: 1, action: "approve", acknowledged: true }], { bulk: false }); expect(mocks.confirm).not.toHaveBeenCalled(); expect(data.reviewCounts.approved).toBe(1);
});
it("keeps unchanged proposals separate from skipped products and allows explicitly finishing an all-skipped import with zero product writes", async () => {
  data = setup(1); data.index[0].category = "unchanged"; data.index[0].requiresUpdate = true; data.rows[0].category = "unchanged"; data.counts = { new: 0, changed: 0, unchanged: 1, blocked: 0 }; mount(); await screen.findByText("1 extracted products"); fireEvent.click(screen.getByRole("button", { name: "Start review" })); await screen.findByRole("button", { name: "Skip product" }); fireEvent.click(screen.getByRole("button", { name: "Skip product" })); await screen.findByRole("button", { name: "Finish review" }); expect(data.reviewCounts.skipped).toBe(1); expect(data.counts.unchanged).toBe(1);
  fireEvent.click(screen.getByRole("button", { name: "Finish review" })); fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Confirm finish" })); await screen.findByText("Import review complete"); expect(mocks.confirm).not.toHaveBeenCalled(); expect(mocks.complete).toHaveBeenCalledTimes(1);
});
it("only bulk-approves explicitly selected warning-free products, then imports after a separate final confirmation", async () => {
  data.index.forEach((entry) => { entry.bulkEligible = true; entry.needsAttention = false; }); mount(); await screen.findByText("2 extracted products"); fireEvent.click(screen.getByRole("checkbox", { name: "Select Product 1" })); fireEvent.click(screen.getByRole("button", { name: "Approve selected (1)" })); await screen.findByText("The selected products are approved. No supplier products have been changed yet."); expect(mocks.decide.mock.calls[0][3]).toEqual({ bulk: true }); expect(mocks.confirm).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Import approved products" })); expect(mocks.confirm).not.toHaveBeenCalled(); fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Confirm import" })); await screen.findByText("Latest import result"); expect(mocks.confirm).toHaveBeenCalledWith("hotel-a", "job", [{ rowId: "r-000001", reviewRevision: 1, acknowledged: true }]); expect(data.reviewCounts.pending).toBe(1);
});
it("holds a lost decision acknowledgement and retries the exact same row/revision instead of advancing", async () => {
  mocks.decide.mockRejectedValueOnce(new Error("Connection lost")); mount(); await screen.findByText("2 extracted products"); fireEvent.click(screen.getByRole("button", { name: "Start review" })); await screen.findByRole("button", { name: "Approve product" }); fireEvent.click(screen.getByRole("button", { name: "Approve product" })); await screen.findByText("Connection lost"); expect(screen.getByRole("button", { name: "Approve product" })).toBeDisabled(); fireEvent.click(screen.getByRole("button", { name: "Retry" })); await waitFor(() => expect(mocks.decide).toHaveBeenCalledTimes(2)); expect(mocks.decide.mock.calls[0]).toEqual(mocks.decide.mock.calls[1]);
});
it("clears a known stale-revision decision and refreshes the product so the user can review its new revision", async () => {
  mocks.decide.mockImplementationOnce(async () => { data.rows[0].reviewRevision = 2; data.index[0].reviewRevision = 2; throw Object.assign(new Error("This product changed."), { code: "functions/aborted" }); }); mount(); await screen.findByText("2 extracted products"); fireEvent.click(screen.getByRole("button", { name: "Start review" })); await screen.findByRole("button", { name: "Approve product" }); fireEvent.click(screen.getByRole("button", { name: "Approve product" })); await screen.findByText("This product changed."); await waitFor(() => expect(screen.getByRole("button", { name: "Approve product" })).not.toBeDisabled()); fireEvent.click(screen.getByRole("button", { name: "Approve product" })); await waitFor(() => expect(mocks.decide).toHaveBeenCalledTimes(2)); expect(mocks.decide.mock.calls[1][2][0].reviewRevision).toBe(2);
});
it("allows a create-only user to review a blocked new product without requiring update permission", async () => {
  mocks.permissions.update = false; data.index[0].category = "blocked"; data.rows[0].category = "blocked"; mount(); await screen.findByText("2 extracted products"); fireEvent.click(screen.getByRole("button", { name: "Start review" })); await screen.findByRole("article", { name: "Current product" }); expect(within(screen.getByRole("article", { name: "Current product" })).getByText("Product 1")).toBeInTheDocument();
});
it("replays an original pending commit after reload even when some approved products are already applied", async () => {
  data.index[0].reviewStatus = "applied"; data.index[0].committedStatus = "created"; reconcile(); const original = { rows: [{ rowId: "r-000001", reviewRevision: 1, acknowledged: true }, { rowId: "r-000002", reviewRevision: 1, acknowledged: true }] }; mocks.pending.mockReturnValue(original); mount(); await screen.findByText(/previous import confirmation is awaiting verification/); fireEvent.click(screen.getAllByRole("button", { name: "Recover original confirmation" })[0]); fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Verify original confirmation" })); await waitFor(() => expect(mocks.confirm).toHaveBeenCalledWith("hotel-a", "job", original.rows));
});
it("surfaces malformed recovery references without crashing or permitting a new import confirmation", async () => {
  mocks.pending.mockImplementation(() => { throw new Error("Saved confirmation could not be verified."); }); mount(); await screen.findByText("2 extracted products"); expect(screen.getByText("Saved confirmation could not be verified.")).toBeInTheDocument(); expect(screen.getByRole("button", { name: "Import approved products" })).toBeDisabled();
});
it("lets an all-applied import finish after an unknown completion acknowledgement without sending another product commit", async () => {
  data = setup(1); data.index[0].reviewStatus = "approved"; reconcile(); mocks.complete.mockRejectedValueOnce(new Error("Completion connection lost")); mount(); await screen.findByText("1 extracted products"); fireEvent.click(screen.getByRole("button", { name: "Import approved products" })); fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Confirm import" })); await screen.findByText("Completion connection lost"); fireEvent.click(screen.getByRole("button", { name: "Retry" })); await screen.findByRole("button", { name: "Finish review" }); fireEvent.click(screen.getByRole("button", { name: "Finish review" })); fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Confirm finish" })); await screen.findByText("Import review complete"); expect(mocks.confirm).toHaveBeenCalledTimes(1); expect(mocks.complete).toHaveBeenCalledTimes(2);
});
it("discards late workspace responses when the selected hotel changes", async () => {
  let resolve; mocks.read.mockReturnValueOnce(new Promise((done) => { resolve = done; })); const view = mount(); await waitFor(() => expect(resolve).toBeDefined()); mocks.hotel.hotelUid = "hotel-b"; mocks.job.mockResolvedValueOnce({ hotelUid: "hotel-b", jobId: "job", status: "failed", ownerUid: "manager", error: { message: "No draft here." } }); view.rerender(<MemoryRouter initialEntries={["/catalog/supplier-products/imports/job"]}><Routes><Route path="/catalog/supplier-products/imports/:jobId" element={<SupplierAiImportReviewPage />} /></Routes></MemoryRouter>); await act(async () => resolve(structuredClone(data))); expect(screen.queryByText("2 extracted products")).not.toBeInTheDocument();
});
it("selects only eligible straightforward price changes and requires explicit approval before import", async () => {
  data = setup(4);
  const categories = ["price-change", "packaging-change", "exception", "price-change"];
  data.index.forEach((entry, index) => { entry.recurringReview = { category: categories[index], physicalPriceComparison: { comparable: true, before: 8, after: 10, unit: "kg", currency: "EUR", percentChange: 25 } }; entry.bulkEligible = index !== 2; entry.needsAttention = index === 2; });
  mount(); await screen.findByText("4 extracted products");
  fireEvent.click(screen.getByRole("button", { name: "Select straightforward price changes" }));
  expect(screen.getByRole("checkbox", { name: "Select Product 1" })).toBeChecked(); expect(screen.getByRole("checkbox", { name: "Select Product 4" })).toBeChecked(); expect(screen.getByRole("checkbox", { name: "Select Product 2" })).not.toBeChecked(); expect(screen.getByRole("checkbox", { name: "Select Product 3" })).not.toBeChecked();
  expect(mocks.decide).not.toHaveBeenCalled(); expect(mocks.confirm).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Approve selected (2)" })); await screen.findByText("The selected products are approved. No supplier products have been changed yet.");
  expect(mocks.decide.mock.calls[0][2].map((row) => row.rowId)).toEqual(["r-000001", "r-000004"]); expect(mocks.confirm).not.toHaveBeenCalled();
});
it("prioritizes exceptions and explicitly skips unchanged articles without confirming their preserved prices", async () => {
  data = setup(28);
  data.index.forEach((entry) => { entry.recurringReview = { category: "unchanged", confirmsUnitPrice: false }; entry.bulkEligible = false; entry.needsAttention = false; entry.category = "unchanged"; entry.requiresUpdate = true; });
  data.index[26].recurringReview = { category: "exception", confirmsUnitPrice: false }; data.index[26].needsAttention = true;
  data.index[27].recurringReview = { category: "confirmation", confirmsUnitPrice: true }; data.index[27].bulkEligible = true;
  mount(); await screen.findByText("28 extracted products");
  fireEvent.click(screen.getByRole("button", { name: "Start review" })); await waitFor(() => expect(within(screen.getByRole("article", { name: "Current product" })).getByText("Product 27")).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: "Skip unchanged articles without prices" }));
  expect(mocks.decide).not.toHaveBeenCalled(); expect(within(screen.getByRole("dialog")).getByText(/Skip 26 unchanged articles/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Confirm skip unchanged" })); await screen.findByText("Selected unchanged articles were skipped. Their existing prices, confirmation dates and packages are preserved.");
  expect(mocks.decide.mock.calls.map((call) => call[2].length)).toEqual([25, 1]); expect(mocks.decide.mock.calls.every((call) => call[2].every((row) => row.action === "skip") && call[3].bulk)).toBe(true);
  expect(data.index[26].reviewStatus).toBe("pending"); expect(data.index[27].reviewStatus).toBe("pending"); expect(mocks.confirm).not.toHaveBeenCalled();
});
it("pauses review decisions and importing while the original format application needs recovery", async () => {
  data.formatApplication = { requestId: "original-format-request", profileRevision: 2, processed: 1, totalRows: 2, complete: false }; data.index.forEach((row) => { row.bulkEligible = true; });
  data.index[0].reviewStatus = "approved"; reconcile(); mount(); await screen.findByText("2 extracted products");
  expect(screen.getByRole("button", { name: "Start review" })).toBeDisabled(); expect(screen.getByRole("button", { name: "Import approved products" })).toBeDisabled(); expect(screen.getByRole("checkbox", { name: "Select Product 2" })).toBeDisabled(); expect(mocks.decide).not.toHaveBeenCalled(); expect(mocks.confirm).not.toHaveBeenCalled();
});
