import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ actor: null, hotel: "hotel-a", permissions: [], availability: vi.fn(), start: vi.fn(), get: vi.fn(), review: vi.fn(), correction: vi.fn(), confirm: vi.fn(), catalog: vi.fn(), suppliers: vi.fn() }));
vi.mock("../../firebaseConfig", () => ({ auth: { get currentUser() { return mocks.actor; } } }));
vi.mock("../../contexts/HotelContext", () => ({ useHotelContext: () => ({ hotelUid: mocks.hotel, permissions: mocks.permissions, subscriptionActive: true, subscription: { modules: ["procurement"], modulePolicyVersion: 1, status: "active", validUntil: null } }) }));
vi.mock("../../services/firebaseSuppliers", () => ({ getSuppliers: mocks.suppliers }));
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
  mocks.suppliers.mockResolvedValue([{ id: "supplier", name: "Coffee Supplier" }]);
  mocks.catalog.mockResolvedValue({ products: [{ id: "ingredient", name: "Coffee beans", baseUnit: "kg" }], cursor: null, hasMore: false });
});
afterEach(() => { vi.useRealTimers(); });
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
  it("resumes only an opaque job reference without displaying provider costs or starting a new run", async () => {
    sessionStorage.setItem("supplier-ai-import:hotel-a:manager", JSON.stringify({ jobId: "job" })); mocks.get.mockResolvedValue({ ...job, status: "response_unknown", usage: { attempts: 1, actualCostUsd: null, unknownCalls: 1, knownCostUsd: 0.001, reservedCostUsd: 0.25 } });
    render(<SupplierAiImportDialog {...props()} />); expect(await screen.findByText("The import result could not be confirmed. Contact your hotel administrator before starting another import.")).toBeInTheDocument(); expect(screen.queryByText(/Estimated cost/)).not.toBeInTheDocument(); expect(screen.queryByText(/Known cost|Reserved budget/)).not.toBeInTheDocument(); expect(mocks.start).not.toHaveBeenCalled();
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

describe("background import dialog", () => {
  it("never displays operator costs, provider models or accounting limits in the customer review", async () => {
    mocks.start.mockResolvedValue({ ...job, model: "gpt-6-luna", configuration: { maxCostPerImportUsd: 0.25 }, usage: { attempts: 5, actualCostUsd: 0.1234, knownCostUsd: 0.1111, reservedCostUsd: 0.2222, inputTokens: 12345 } });
    await prepare();
    const text = screen.getByRole("dialog").textContent;
    for (const forbidden of ["gpt-6-luna", "Estimated cost", "Known cost", "Reserved budget", "Maximum AI budget", "AI calls", "0.1234", "0.1111", "0.2222", "12345"]) expect(text).not.toContain(forbidden);
    expect(text).toContain("12 EUR");
  });
  it("closes five seconds after the upload acknowledgement and keeps its tracked job", async () => {
    const properties = { ...props(), backgroundManaged: true, onJobChange: vi.fn() }, queued = { ...job, status: "queued", progress: { completedChunks: 0, totalChunks: 3 } };
    mocks.start.mockResolvedValue(queued); render(<SupplierAiImportDialog {...properties} />); await screen.findByLabelText("Supplier document"); upload(); vi.useFakeTimers(); await act(async () => fireEvent.click(screen.getByRole("button", { name: "Prepare AI import review" })));
    expect(screen.getByText(/This dialog closes in 5 seconds/)).toBeInTheDocument(); expect(properties.onJobChange).toHaveBeenCalledWith(queued); expect(screen.getByText("0 of 3 document sections processed.")).toBeInTheDocument();
    for (let index = 0; index < 4; index += 1) await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(properties.onClose).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(properties.onClose).toHaveBeenCalledTimes(1); expect(mocks.get).not.toHaveBeenCalled();
  });
  it("does not start the countdown for an unconfirmed upload and allows keeping an acknowledged job open", async () => {
    const acknowledgement = deferred(), properties = { ...props(), backgroundManaged: true, onJobChange: vi.fn() };
    mocks.start.mockReturnValue(acknowledgement.promise); render(<SupplierAiImportDialog {...properties} />); await screen.findByLabelText("Supplier document"); upload(); fireEvent.click(screen.getByRole("button", { name: "Prepare AI import review" }));
    vi.useFakeTimers(); await act(async () => { await vi.advanceTimersByTimeAsync(6000); }); expect(properties.onClose).not.toHaveBeenCalled(); expect(screen.queryByText(/This dialog closes in/)).not.toBeInTheDocument();
    await act(async () => acknowledgement.resolve({ ...job, status: "processing" })); expect(screen.getByText(/This dialog closes in 5 seconds/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Keep open" })); await act(async () => { await vi.advanceTimersByTimeAsync(6000); }); expect(properties.onClose).not.toHaveBeenCalled();
  });
  it("cancels the countdown when background processing ends or a different job is opened", async () => {
    const properties = { ...props(), backgroundManaged: true, onJobChange: vi.fn() }, queued = { ...job, status: "queued" };
    mocks.start.mockResolvedValue(queued); const view = render(<SupplierAiImportDialog {...properties} />); await screen.findByLabelText("Supplier document"); upload(); fireEvent.click(screen.getByRole("button", { name: "Prepare AI import review" })); await screen.findByText(/This dialog closes in 5 seconds/);
    vi.useFakeTimers(); view.rerender(<SupplierAiImportDialog {...properties} trackedJobId="job" trackedJob={{ ...job, status: "failed", error: { code: "processing-failed", message: "The document needs correction." } }} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); }); expect(properties.onClose).not.toHaveBeenCalled(); expect(screen.queryByText(/This dialog closes in/)).not.toBeInTheDocument();
    view.rerender(<SupplierAiImportDialog {...properties} trackedJobId="other-job" trackedJob={{ ...queued, jobId: "other-job", source: { fileName: "other.csv" } }} />); expect(screen.getByText("other.csv")).toBeInTheDocument(); expect(mocks.get).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); }); expect(properties.onClose).not.toHaveBeenCalled();
  });
  it("opens a background draft ready for review without starting another upload or displaying imported-product success", async () => {
    render(<SupplierAiImportDialog {...props()} backgroundManaged trackedJobId="job" trackedJob={job} onJobChange={vi.fn()} />);
    await screen.findByRole("article", { name: "Import row r1" }); expect(screen.getByText("Review the proposed products before importing.")).toBeInTheDocument(); expect(mocks.start).not.toHaveBeenCalled(); expect(mocks.confirm).not.toHaveBeenCalled(); expect(mocks.get).not.toHaveBeenCalled();
  });
});

describe("controlled import commands", () => {
  it("opens a fresh upload form for another document while the first acknowledged job keeps processing", async () => {
    const properties = { ...props(), backgroundManaged: true, onJobChange: vi.fn() }, first = { ...job, status: "processing" };
    const view = render(<SupplierAiImportDialog {...properties} trackedJobId="job" trackedJob={first} />);
    expect(await screen.findByText("Reading the document and preparing a review…")).toBeInTheDocument();
    view.rerender(<SupplierAiImportDialog {...properties} open={false} trackedJobId="job" trackedJob={first} />);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await act(async () => { await new Promise(requestAnimationFrame); });
    view.rerender(<SupplierAiImportDialog {...properties} trackedJobId={null} trackedJob={null} />);
    await screen.findByLabelText("Supplier document"); expect(screen.queryByText("Reading the document and preparing a review…")).not.toBeInTheDocument(); expect(mocks.start).not.toHaveBeenCalled();
    mocks.start.mockResolvedValue({ ...first, jobId: "second-job", source: { fileName: "second.csv" } }); upload(); fireEvent.click(screen.getByRole("button", { name: "Prepare AI import review" }));
    expect(await screen.findByText("second.csv")).toBeInTheDocument(); expect(properties.onJobChange).toHaveBeenCalledWith(expect.objectContaining({ jobId: "second-job" }));
  });
  it("preserves a commit's acknowledgement before switching jobs and never leaks its results into the next draft", async () => {
    const confirmation = deferred(), properties = { ...props(), backgroundManaged: true, onJobChange: vi.fn() };
    mocks.confirm.mockReturnValue(confirmation.promise); const view = render(<SupplierAiImportDialog {...properties} trackedJobId="job" trackedJob={job} />);
    await screen.findByRole("article", { name: "Import row r1" }); fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed/ })); fireEvent.click(screen.getByRole("button", { name: "Confirm 1 reviewed rows" }));
    view.rerender(<SupplierAiImportDialog {...properties} trackedJobId="second-job" trackedJob={{ ...job, jobId: "second-job", source: { fileName: "second.csv" } }} />);
    expect(screen.getByText("supplier.csv")).toBeInTheDocument();
    mocks.review.mockResolvedValue({ hotelUid: "hotel-a", jobId: "second-job", rows: [row("r2")], totalRows: 1 });
    await act(async () => confirmation.resolve({ hotelUid: "hotel-a", jobId: "job", complete: true, outcomes: [{ rowId: "r1", status: "created", productId: "new" }] }));
    await screen.findByText("second.csv"); await screen.findByRole("article", { name: "Import row r2" }); expect(screen.queryByLabelText("Import results")).not.toBeInTheDocument(); expect(screen.getByRole("checkbox", { name: /I reviewed/ })).not.toBeChecked();
  });
});

describe("global import supplier directory", () => {
  it("loads current hotel suppliers despite a stale empty page-loading snapshot", async () => {
    const directory = deferred(); mocks.suppliers.mockReturnValue(directory.promise);
    render(<SupplierAiImportDialog {...props()} suppliers={[]} suppliersLoading backgroundManaged onJobChange={vi.fn()} />);
    await screen.findByLabelText("Supplier document"); upload(); expect(screen.getByRole("button", { name: "Prepare AI import review" })).toBeDisabled();
    await act(async () => directory.resolve([{ id: "supplier", name: "Fresh supplier name" }])); expect(screen.getByRole("combobox", { name: "AI import supplier" })).toHaveValue("Fresh supplier name"); expect(screen.getByRole("button", { name: "Prepare AI import review" })).toBeEnabled(); expect(mocks.suppliers).toHaveBeenCalledWith("hotel-a");
  });
  it("can start another document from a recovered draft on any route without page-owned supplier props", async () => {
    const properties = { ...props(), suppliers: [], initialSupplierId: "", backgroundManaged: true, onNewDocument: vi.fn(), onJobChange: vi.fn() };
    const view = render(<SupplierAiImportDialog {...properties} trackedJobId="job" trackedJob={job} />); await screen.findByRole("article", { name: "Import row r1" });
    fireEvent.click(screen.getByRole("button", { name: "Start another document" })); view.rerender(<SupplierAiImportDialog {...properties} trackedJobId={null} trackedJob={null} />);
    await screen.findByLabelText("Supplier document"); await waitFor(() => expect(mocks.suppliers).toHaveBeenCalledWith("hotel-a"));
    fireEvent.focus(screen.getByRole("combobox", { name: "AI import supplier" })); fireEvent.change(screen.getByRole("combobox", { name: "AI import supplier" }), { target: { value: "Coffee" } }); fireEvent.click(await screen.findByRole("option", { name: "Coffee Supplier" })); upload(); expect(screen.getByRole("button", { name: "Prepare AI import review" })).toBeEnabled();
  });
  it("discards a supplier response after the actor changes and offers an explicit directory retry", async () => {
    const directory = deferred(), properties = { ...props(), backgroundManaged: true }; mocks.suppliers.mockReturnValue(directory.promise);
    const view = render(<SupplierAiImportDialog {...properties} />); await screen.findByLabelText("Supplier document"); mocks.actor = { uid: "manager" }; mocks.suppliers.mockRejectedValue(new Error("Directory unavailable")); view.rerender(<SupplierAiImportDialog {...properties} />);
    await screen.findByText(/The supplier directory could not be loaded/); await act(async () => directory.resolve([{ id: "supplier", name: "Stale supplier" }])); expect(screen.getByRole("combobox", { name: "AI import supplier" })).not.toHaveValue("Stale supplier");
    mocks.suppliers.mockResolvedValue([{ id: "supplier", name: "Fresh supplier" }]); fireEvent.click(screen.getByRole("button", { name: "Retry supplier directory" })); await waitFor(() => expect(screen.getByRole("combobox", { name: "AI import supplier" })).toHaveValue("Fresh supplier"));
  });
});

it("keeps the accepted background state when a delayed status read returns an older queued snapshot", async () => {
  const accepted = { ...job, status: "review" }, properties = { ...props(), backgroundManaged: true, onJobChange: vi.fn(() => accepted) };
  mocks.get.mockResolvedValue({ ...job, status: "queued" }); render(<SupplierAiImportDialog {...properties} trackedJobId="job" trackedJob={accepted} />); await screen.findByRole("article", { name: "Import row r1" });
  fireEvent.click(screen.getByRole("button", { name: "Refresh import status" })); await waitFor(() => expect(properties.onJobChange).toHaveBeenCalled());
  expect(screen.getByText("Review the proposed products before importing.")).toBeInTheDocument(); expect(screen.queryByText("Your document is queued.")).not.toBeInTheDocument();
});
