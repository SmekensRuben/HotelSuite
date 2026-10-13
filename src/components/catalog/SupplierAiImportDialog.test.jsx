import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ actor: null, hotel: "hotel-a", permissions: [], availability: vi.fn(), start: vi.fn(), get: vi.fn(), review: vi.fn(), correction: vi.fn(), confirm: vi.fn(), catalog: vi.fn() }));
vi.mock("../../firebaseConfig", () => ({ auth: { get currentUser() { return mocks.actor; } } }));
vi.mock("../../contexts/HotelContext", () => ({ useHotelContext: () => ({ hotelUid: mocks.hotel, permissions: mocks.permissions, subscriptionActive: true, subscription: { modules: ["procurement"], modulePolicyVersion: 1, status: "active", validUntil: null } }) }));
vi.mock("../../services/firebaseProducts", () => ({ getCatalogProducts: mocks.catalog }));
vi.mock("../../services/firebaseSupplierAiImports", () => ({ SUPPLIER_AI_IMPORT_ACCEPT: ".csv,.xlsx,.pdf,.docx,.eml,.txt", validateSupplierAiImportFile: (file) => { if (!file?.size || file.size > 10485760) throw new Error("Choose a file between 1 byte and 10 MiB."); if (!/\.(csv|xlsx|pdf|docx|eml|txt)$/i.test(file.name)) throw new Error("Unsupported file."); }, getSupplierAiImportAvailability: mocks.availability, startSupplierAiImport: mocks.start, getSupplierAiImport: mocks.get, getSupplierAiImportReview: mocks.review, saveSupplierAiImportReview: mocks.correction, confirmSupplierAiImport: mocks.confirm }));
import SupplierAiImportDialog from "./SupplierAiImportDialog";
const product = { supplierSku: "001", supplierProductName: "Coffee", baseUnit: "kg", purchaseUnit: "bag", baseUnitsPerPurchaseUnit: 1, pricePerPurchaseUnit: 12, priceBasis: "net", currency: "EUR", pricingModel: "Per Purchase Unit", purchaseOptions: [], active: false, catalogProductId: null };
const row = (rowId = "r1", patch = {}) => ({ rowId, category: "new", product: { ...product }, previousProduct: null, reviewRevision: 1, issues: [], changes: [], sourceAnchors: [{ sourceId: "page-1", anchor: "Page 1, row 2", quote: "001 Coffee 1kg EUR12", verified: true }], committed: null, ...patch });
const job = { hotelUid: "hotel-a", jobId: "job", supplierId: "supplier", ownerUid: "manager", status: "review", source: { fileName: "supplier.csv" }, usage: { attempts: 1, actualCostUsd: 0.001, unknownCalls: 0 }, expiresAtMillis: 1900000000000 };
const props = () => ({ open: true, onClose: vi.fn(), hotelUid: mocks.hotel, suppliers: [{ id: "supplier", name: "Coffee Supplier" }], initialSupplierId: "supplier", onImported: vi.fn() });
const upload = (file = new File(["Supplier data"], "supplier.csv", { type: "text/csv" })) => fireEvent.change(screen.getByLabelText("Supplier document"), { target: { files: [file] } });
const prepare = async (properties = props()) => { const view = render(<SupplierAiImportDialog {...properties} />); await screen.findByLabelText("Supplier document"); upload(); fireEvent.click(screen.getByRole("button", { name: "Prepare AI import review" })); await screen.findByRole("article", { name: "Import row r1" }); return { view, properties }; };
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
beforeEach(() => {
  vi.clearAllMocks(); sessionStorage.clear(); mocks.hotel = "hotel-a"; mocks.actor = { uid: "manager" };
  mocks.permissions = ["supplierproducts.read", "supplierproducts.create", "supplierproducts.update", "suppliers.read", "catalogproducts.read"];
  mocks.availability.mockResolvedValue({ available: true, fallbackEnabled: false, limits: { maxFileBytes: 10485760, maxPages: 50, maxProducts: 1000, maxCostPerImportUsd: 0.25 } });
  mocks.start.mockResolvedValue(job); mocks.get.mockResolvedValue(job); mocks.review.mockResolvedValue({ hotelUid: "hotel-a", jobId: "job", rows: [row()], totalRows: 1, nextCursor: null });
  mocks.catalog.mockResolvedValue({ products: [{ id: "ingredient", name: "Coffee beans", baseUnit: "kg" }], cursor: null, hasMore: false });
});
describe("reviewed supplier AI import", () => {
  it("has one close button, explicit review and source evidence without injected HTML", async () => {
    mocks.review.mockResolvedValue({ rows: [row("r1", { sourceAnchors: [{ anchor: "Page 1", quote: '<img src=x onerror="alert(1)">', verified: false }] })], totalRows: 1, nextCursor: null });
    await prepare(); const dialog = screen.getByRole("dialog", { name: "AI supplier-product import" }); expect(within(dialog).getAllByRole("button", { name: "Close dialog" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Confirm 0 reviewed rows" })).toBeDisabled(); expect(mocks.confirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Review details" })); expect(await screen.findByText('<img src=x onerror="alert(1)">')).toBeInTheDocument(); expect(dialog.querySelector("img")).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "I reviewed this row and its source; include it in the import." })); expect(screen.getByRole("button", { name: "Confirm 1 reviewed rows" })).toBeEnabled();
  });
  it("shows the independent source excerpt and flags missing or truncated document context", async () => {
    mocks.review.mockResolvedValue({ rows: [row("r1", { sourceAnchors: [{ anchor: "CSV row 2", quote: "Coffee 12 EUR", sourceExcerpt: "001;Coffee;6 x 1 kg;12 EUR gross;VAT 6%", excerptTruncated: true, verified: true }] })], totalRows: 1 });
    await prepare(); fireEvent.click(screen.getByRole("button", { name: "Review details" }));
    expect(screen.getByText("Extracted source row:")).toBeInTheDocument(); expect(screen.getByText("001;Coffee;6 x 1 kg;12 EUR gross;VAT 6%")).toBeInTheDocument(); expect(screen.getByText("The source excerpt is truncated. Check the original document.")).toBeInTheDocument();
  });
  it("lets a create-only user correct a blocked new row and select only the server-validated correction", async () => {
    mocks.permissions = ["supplierproducts.read", "supplierproducts.create", "suppliers.read", "catalogproducts.read"];
    mocks.review.mockResolvedValue({ rows: [row("r1", { category: "blocked", product: { ...product, baseUnitsPerPurchaseUnit: null }, issues: [{ field: "baseUnitsPerPurchaseUnit", message: "Package content is missing", severity: "error" }] })], totalRows: 1 });
    mocks.correction.mockResolvedValue({ hotelUid: "hotel-a", jobId: "job", row: row("r1", { reviewRevision: 2, product: { ...product, baseUnitsPerPurchaseUnit: 6 } }) });
    await prepare(); expect(screen.getByRole("checkbox", { name: /I reviewed/ })).toBeDisabled(); fireEvent.click(screen.getByRole("button", { name: "Review details" }));
    expect(screen.getByRole("button", { name: "Save correction" })).toBeEnabled(); fireEvent.change(screen.getByLabelText("Package content"), { target: { value: "6" } }); fireEvent.click(screen.getByRole("button", { name: "Save correction" }));
    await waitFor(() => expect(mocks.correction).toHaveBeenCalledWith("hotel-a", expect.objectContaining({ jobId: "job", rowId: "r1", expectedReviewRevision: 1, patch: expect.objectContaining({ baseUnitsPerPurchaseUnit: 6 }) })));
    await waitFor(() => expect(screen.getByRole("checkbox", { name: /I reviewed/ })).toBeEnabled()); expect(screen.getByRole("checkbox", { name: /I reviewed/ })).not.toBeChecked();
  });
  it("requires saving edits before acknowledging a changed existing row and preserves established units", async () => {
    mocks.review.mockResolvedValue({ rows: [row("r1", { category: "changed", previousProduct: { ...product, catalogProductId: "ingredient" }, product: { ...product, catalogProductId: "ingredient" }, productId: "existing", changes: [{ field: "pricePerPurchaseUnit", before: 10, after: 12 }] })], totalRows: 1 });
    await prepare(); fireEvent.click(screen.getByRole("button", { name: "Review details" }));
    expect(screen.getByLabelText("Content unit")).toBeDisabled(); expect(screen.getByLabelText("Supplier SKU")).toBeDisabled(); expect(screen.getByRole("combobox", { name: "Catalog product for r1" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Package price"), { target: { value: "13" } }); expect(screen.getByRole("checkbox", { name: /I reviewed/ })).toBeDisabled(); expect(screen.getByText("Save and validate your corrections before selecting this row.")).toBeInTheDocument(); await act(async () => {});
  });
  it("shows actual partial outcomes and recovers an uncertain confirmation with the same selected revisions", async () => {
    const properties = props(); mocks.review.mockResolvedValue({ rows: [row(), row("r2", { category: "changed", previousProduct: product })], totalRows: 2 });
    mocks.confirm.mockRejectedValueOnce(new Error("Acknowledgement lost")).mockResolvedValueOnce({ hotelUid: "hotel-a", jobId: "job", complete: true, outcomes: [{ rowId: "r1", status: "created", productId: "new" }, { rowId: "r2", status: "blocked", error: { message: "Product changed since review" } }] });
    await prepare(properties); screen.getAllByRole("checkbox", { name: /I reviewed/ }).forEach((input) => fireEvent.click(input)); fireEvent.click(screen.getByRole("button", { name: "Confirm 2 reviewed rows" }));
    expect(await screen.findByText("Acknowledgement lost")).toBeInTheDocument(); expect(screen.getAllByRole("checkbox", { name: /I reviewed/ }).every((input) => input.disabled)).toBe(true); expect(properties.onImported).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Recover original confirmation" })); expect(await screen.findByText("1 created · 0 updated · 0 unchanged · 1 blocked")).toBeInTheDocument(); expect(screen.getByText("r2: Product changed since review")).toBeInTheDocument(); expect(mocks.confirm.mock.calls[0]).toEqual(mocks.confirm.mock.calls[1]); expect(properties.onImported).toHaveBeenCalledTimes(1);
  });
  it("bounds uploads before starting an AI run", async () => {
    render(<SupplierAiImportDialog {...props()} />); await screen.findByLabelText("Supplier document"); upload({ name: "huge.pdf", size: 10485761 }); expect(screen.getByRole("alert")).toHaveTextContent("10 MiB"); expect(mocks.start).not.toHaveBeenCalled();

  });
  it("shows a disabled global feature without exposing a file upload or starting a run", async () => {
    mocks.availability.mockResolvedValue({ available: false, fallbackEnabled: false });
    render(<SupplierAiImportDialog {...props()} />);
    expect(await screen.findByText("AI supplier imports are disabled. Ask the platform operator to enable the global AI import settings.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Supplier document")).not.toBeInTheDocument(); expect(mocks.start).not.toHaveBeenCalled();
  });
  it("does not expose uploads for revoked permissions or display a late same-UID Auth response", async () => {
    const pending = deferred(); mocks.start.mockReturnValue(pending.promise);
    const properties = props(), view = render(<SupplierAiImportDialog {...properties} />); await screen.findByLabelText("Supplier document"); upload(); fireEvent.click(screen.getByRole("button", { name: "Prepare AI import review" }));
    mocks.actor = { uid: "manager" }; view.rerender(<SupplierAiImportDialog {...properties} />); await act(async () => pending.resolve(job)); expect(screen.queryByText("Product review")).not.toBeInTheDocument(); expect(mocks.review).not.toHaveBeenCalled();
    mocks.permissions = ["supplierproducts.read"]; view.rerender(<SupplierAiImportDialog {...properties} />); expect(screen.getByRole("alert")).toHaveTextContent("create permissions"); expect(screen.queryByLabelText("Supplier document")).not.toBeInTheDocument(); await act(async () => {});
  });
  it("resumes only an opaque job reference, displays unavailable provider cost and never starts a new run", async () => {
    sessionStorage.setItem("supplier-ai-import:hotel-a:manager", JSON.stringify({ jobId: "job" })); mocks.get.mockResolvedValue({ ...job, status: "response_unknown", usage: { attempts: 1, actualCostUsd: null, unknownCalls: 1, knownCostUsd: 0.001, reservedCostUsd: 0.25 } });
    render(<SupplierAiImportDialog {...props()} />); expect(await screen.findByText("The provider response is uncertain. A further AI call will not start automatically.")).toBeInTheDocument(); expect(screen.getByText(/Estimated cost: Unavailable/)).toBeInTheDocument(); expect(screen.getByText(/Known cost: \$0.0010 · Reserved budget: \$0.2500/)).toBeInTheDocument(); expect(mocks.start).not.toHaveBeenCalled();
    expect(JSON.parse(sessionStorage.getItem("supplier-ai-import:hotel-a:manager"))).toEqual({ jobId: "job" });
  });
  it("refreshes stale review revisions and removes the old acknowledgement before confirmation", async () => {
    await prepare(); fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed/ }));
    mocks.review.mockResolvedValueOnce({ rows: [row("r1", { reviewRevision: 2, product: { ...product, pricePerPurchaseUnit: 15 } })], totalRows: 1 });
    fireEvent.click(screen.getByRole("button", { name: "Refresh review rows" }));
    await waitFor(() => expect(screen.getByRole("checkbox", { name: /I reviewed/ })).not.toBeChecked()); expect(screen.getByRole("button", { name: "Confirm 0 reviewed rows" })).toBeDisabled(); expect(mocks.confirm).not.toHaveBeenCalled();
  });
  it("clears private review data and its browser reference when the draft has expired", async () => {
    await prepare(); fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed/ }));
    mocks.get.mockRejectedValueOnce(Object.assign(new Error("Private draft expired"), { code: "failed-precondition" }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh import status" }));
    expect(await screen.findByText("This private draft is no longer available. Start a new document when you are ready.")).toBeInTheDocument();
    expect(screen.queryByRole("article", { name: "Import row r1" })).not.toBeInTheDocument(); expect(screen.queryByText("supplier.csv")).not.toBeInTheDocument(); expect(sessionStorage.getItem("supplier-ai-import:hotel-a:manager")).toBeNull();
  });
  it("ignores an old job refresh and old review rows after starting a different document", async () => {
    const staleRefresh = deferred(), staleRows = deferred();
    await prepare(); mocks.get.mockReturnValueOnce(staleRefresh.promise); fireEvent.click(screen.getByRole("button", { name: "Refresh import status" }));
    fireEvent.click(screen.getByRole("button", { name: "Start another document" }));
    mocks.start.mockResolvedValue({ ...job, jobId: "job-two", source: { fileName: "second.csv" }, warnings: ["Mail attachments were not imported."] });
    mocks.review.mockResolvedValue({ rows: [row("r2", { product: { ...product, supplierProductName: "Second document product" } })], totalRows: 1 });
    await screen.findByLabelText("Supplier document"); upload(); fireEvent.click(screen.getByRole("button", { name: "Prepare AI import review" })); await screen.findByRole("article", { name: "Import row r2" });
    await act(async () => staleRefresh.resolve(job)); expect(screen.getByText("second.csv")).toBeInTheDocument(); expect(screen.getByText("Mail attachments were not imported.")).toBeInTheDocument(); expect(screen.queryByRole("article", { name: "Import row r1" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Start another document" }));
    mocks.start.mockResolvedValue(job); mocks.review.mockReturnValueOnce(staleRows.promise);
    await screen.findByLabelText("Supplier document"); upload(); fireEvent.click(screen.getByRole("button", { name: "Prepare AI import review" })); await screen.findByText("Loading review rows…");
    fireEvent.click(screen.getByRole("button", { name: "Start another document" }));
    mocks.start.mockResolvedValue({ ...job, jobId: "job-three", source: { fileName: "third.csv" } }); mocks.review.mockResolvedValue({ rows: [row("r3")], totalRows: 1 });
    await screen.findByLabelText("Supplier document"); upload(); fireEvent.click(screen.getByRole("button", { name: "Prepare AI import review" })); await screen.findByRole("article", { name: "Import row r3" });
    await act(async () => staleRows.resolve({ rows: [row()], totalRows: 1 })); expect(screen.getByText("third.csv")).toBeInTheDocument(); expect(screen.getByRole("article", { name: "Import row r3" })).toBeInTheDocument(); expect(screen.queryByRole("article", { name: "Import row r1" })).not.toBeInTheDocument();
  });
  it("retains selected reviewed rows across server review pages and commits exactly that explicit selection", async () => {
    mocks.review.mockResolvedValueOnce({ rows: [row()], totalRows: 2, nextCursor: "r1" }).mockResolvedValueOnce({ rows: [row("r2")], totalRows: 2, nextCursor: null }).mockResolvedValue({ rows: [], totalRows: 2 });
    mocks.confirm.mockResolvedValue({ hotelUid: "hotel-a", jobId: "job", complete: true, outcomes: [{ rowId: "r1", status: "created" }, { rowId: "r2", status: "created" }] });
    await prepare(); fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed/ })); fireEvent.click(screen.getByRole("button", { name: "Next rows" })); await screen.findByRole("article", { name: "Import row r2" }); fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed/ })); fireEvent.click(screen.getByRole("button", { name: "Confirm 2 reviewed rows" }));
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledWith("hotel-a", "job", [{ rowId: "r1", reviewRevision: 1, acknowledged: true }, { rowId: "r2", reviewRevision: 1, acknowledged: true }]));
  });
});
