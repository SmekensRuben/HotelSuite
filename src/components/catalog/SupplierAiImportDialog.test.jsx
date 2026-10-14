import React from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ actor: null, hotel: "hotel-a", permissions: [], availability: vi.fn(), start: vi.fn(), get: vi.fn(), review: vi.fn(), correction: vi.fn(), confirm: vi.fn(), catalog: vi.fn(), suppliers: vi.fn() }));
vi.mock("../../firebaseConfig", () => ({ auth: { get currentUser() { return mocks.actor; } } }));
vi.mock("../../contexts/HotelContext", () => ({ useHotelContext: () => ({ hotelUid: mocks.hotel, permissions: mocks.permissions, subscriptionActive: true, subscription: { modules: ["procurement"], modulePolicyVersion: 1, status: "active", validUntil: null } }) }));
vi.mock("../../services/firebaseSuppliers", () => ({ getSuppliers: mocks.suppliers }));
vi.mock("../../services/firebaseProducts", () => ({ getCatalogProducts: mocks.catalog }));
vi.mock("../../services/firebaseSupplierAiImports", () => ({ SUPPLIER_AI_IMPORT_ACCEPT: ".csv,.xlsx,.pdf,.docx,.eml,.txt", validateSupplierAiImportFile: (file) => { if (!file?.size || file.size > 10485760) throw new Error("Choose a file between 1 byte and 10 MiB."); if (!/\.(csv|xlsx|pdf|docx|eml|txt)$/i.test(file.name)) throw new Error("Unsupported file."); }, getSupplierAiImportAvailability: mocks.availability, startSupplierAiImport: mocks.start, getSupplierAiImport: mocks.get, getSupplierAiImportReview: mocks.review, saveSupplierAiImportReview: mocks.correction, confirmSupplierAiImport: mocks.confirm, supplierAiImportVatFraction: (value) => { if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) || (value.split(".")[1] || "").replace(/0+$/, "").length > 4 || Number(value) > 100) throw new Error("Invalid VAT"); return Number((Number(value) / 100).toFixed(6)); }, normalizeSupplierAiImportSettings: (value) => { if (value.policyVersion !== 2 || !["net", "gross", "unknown"].includes(value.priceBasis) || !/^[A-Z]{3}$/.test(value.currency) || (value.vatRate !== null && (value.vatRate < 0 || value.vatRate > 1))) throw new Error("Invalid import price settings"); return value; } }));
import SupplierAiImportDialog from "./SupplierAiImportDialog";
const product = { supplierSku: "001", supplierProductName: "Coffee", baseUnit: "kg", purchaseUnit: "bag", baseUnitsPerPurchaseUnit: 1, pricePerPurchaseUnit: 12, priceBasis: "net", currency: "EUR", pricingModel: "Per Purchase Unit", purchaseOptions: [], active: false, catalogProductId: null };
const row = (rowId = "r1", patch = {}) => ({ rowId, category: "new", product: { ...product }, previousProduct: null, reviewRevision: 1, issues: [], changes: [], sourceAnchors: [{ sourceId: "page-1", anchor: "Page 1, row 2", quote: "001 Coffee 1kg EUR12", verified: true }], committed: null, ...patch });
const settings = { policyVersion: 2, priceBasis: "net", currency: "EUR", vatRate: null };
const recurringSettings = { assortmentMode: "partial", documentPurpose: "price-list", sourceIssuedOn: null, priceValidFrom: null, priceValidUntil: null };
const job = { hotelUid: "hotel-a", jobId: "job", supplierId: "supplier", ownerUid: "manager", status: "review", importSettings: settings, summary: null, source: { fileName: "supplier.csv" }, usage: { attempts: 1, actualCostUsd: 0.001, unknownCalls: 0 }, expiresAtMillis: 1900000000000 };
const props = () => ({ open: true, onClose: vi.fn(), hotelUid: mocks.hotel, suppliers: [{ id: "supplier", name: "Coffee Supplier" }], initialSupplierId: "supplier", onImported: vi.fn() });
const upload = (file = new File(["Supplier data"], "supplier.csv", { type: "text/csv" })) => { const basis = screen.getByLabelText("Document price basis"); if (!basis.value) fireEvent.change(basis, { target: { value: "net" } }); return fireEvent.change(screen.getByLabelText("Supplier document"), { target: { files: [file] } }); };
const prepare = async (properties = props()) => { const view = render(wrap(<SupplierAiImportDialog {...properties} />)); await screen.findByLabelText("Supplier document"); upload(); fireEvent.click(screen.getByRole("button", { name: "Prepare AI import review" })); await screen.findByRole("button", { name: "Open import review" }); return { view, properties }; };
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
beforeEach(() => {
  vi.clearAllMocks(); sessionStorage.clear(); mocks.hotel = "hotel-a"; mocks.actor = { uid: "manager" };
  mocks.permissions = ["supplierproducts.read", "supplierproducts.create", "supplierproducts.update", "suppliers.read", "catalogproducts.read"];
  mocks.availability.mockResolvedValue({ available: true, importPolicyVersion: 2, reviewWorkspaceVersion: 1, recurringImportVersion: 1, sourceFormatProfileVersion: 1, fallbackEnabled: false, limits: { maxFileBytes: 10485760, maxPages: 50, maxProducts: 1000, maxCostPerImportUsd: 0.25 }, defaults: { currency: "EUR" } });
  mocks.start.mockResolvedValue(job); mocks.get.mockResolvedValue(job); mocks.review.mockResolvedValue({ hotelUid: "hotel-a", jobId: "job", rows: [row()], totalRows: 1, nextCursor: null });
  mocks.suppliers.mockResolvedValue([{ id: "supplier", name: "Coffee Supplier" }]);
  mocks.catalog.mockResolvedValue({ products: [{ id: "ingredient", name: "Coffee beans", baseUnit: "kg" }], cursor: null, hasMore: false });
});
afterEach(() => { vi.useRealTimers(); });
const wrap = (children) => <MemoryRouter><Routes><Route path="*" element={children} /><Route path="/catalog/supplier-products/imports/:jobId" element={<p>Dedicated product review</p>} /></Routes></MemoryRouter>;

describe("supplier AI upload and navigation", () => {
  it("bounds uploads before starting an AI run", async () => {
    render(wrap(<SupplierAiImportDialog {...props()} />)); await screen.findByLabelText("Supplier document"); upload({ name: "huge.pdf", size: 10485761 }); expect(screen.getByRole("alert")).toHaveTextContent("10 MiB"); expect(mocks.start).not.toHaveBeenCalled();

  });
  it("shows a disabled global feature without exposing a file upload or starting a run", async () => {
    mocks.availability.mockResolvedValue({ available: false, fallbackEnabled: false });
    render(wrap(<SupplierAiImportDialog {...props()} />));
    expect(await screen.findByText("AI supplier imports are disabled. Ask the platform operator to enable the global AI import settings.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Supplier document")).not.toBeInTheDocument(); expect(mocks.start).not.toHaveBeenCalled();
  });
  it("does not expose uploads for revoked permissions or display a late same-UID Auth response", async () => {
    const pending = deferred(); mocks.start.mockReturnValue(pending.promise);
    const properties = props(), view = render(wrap(<SupplierAiImportDialog {...properties} />)); await screen.findByLabelText("Supplier document"); upload(); fireEvent.click(screen.getByRole("button", { name: "Prepare AI import review" }));
    mocks.actor = { uid: "manager" }; view.rerender(wrap(<SupplierAiImportDialog {...properties} />)); await act(async () => pending.resolve(job)); expect(screen.queryByText("Product review")).not.toBeInTheDocument(); expect(mocks.review).not.toHaveBeenCalled();
    mocks.permissions = ["supplierproducts.read"]; view.rerender(wrap(<SupplierAiImportDialog {...properties} />)); expect(screen.getByRole("alert")).toHaveTextContent("create permissions"); expect(screen.queryByLabelText("Supplier document")).not.toBeInTheDocument(); await act(async () => {});
  });
  it("resumes only an opaque job reference without displaying provider costs or starting a new run", async () => {
    sessionStorage.setItem("supplier-ai-import:hotel-a:manager", JSON.stringify({ jobId: "job" })); mocks.get.mockResolvedValue({ ...job, status: "response_unknown", usage: { attempts: 1, actualCostUsd: null, unknownCalls: 1, knownCostUsd: 0.001, reservedCostUsd: 0.25 } });
    render(wrap(<SupplierAiImportDialog {...props()} />)); expect(await screen.findByText("The import result could not be confirmed. Contact your hotel administrator before starting another import.")).toBeInTheDocument(); expect(screen.queryByText(/Estimated cost/)).not.toBeInTheDocument(); expect(screen.queryByText(/Known cost|Reserved budget/)).not.toBeInTheDocument(); expect(mocks.start).not.toHaveBeenCalled();
    expect(JSON.parse(sessionStorage.getItem("supplier-ai-import:hotel-a:manager"))).toEqual({ jobId: "job" });
  });
  it("clears private review data and its browser reference when the draft has expired", async () => {
    await prepare();
    mocks.get.mockRejectedValueOnce(Object.assign(new Error("Private draft expired"), { code: "failed-precondition" }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh import status" }));
    expect(await screen.findByText("This private draft is no longer available. Start a new document when you are ready.")).toBeInTheDocument();
    expect(screen.queryByRole("article", { name: "Import row r1" })).not.toBeInTheDocument(); expect(screen.queryByText("supplier.csv")).not.toBeInTheDocument(); expect(sessionStorage.getItem("supplier-ai-import:hotel-a:manager")).toBeNull();
  });
  it("never displays operator costs, provider models or accounting limits in the customer review", async () => {
    mocks.start.mockResolvedValue({ ...job, model: "gpt-6-luna", configuration: { maxCostPerImportUsd: 0.25 }, usage: { attempts: 5, actualCostUsd: 0.1234, knownCostUsd: 0.1111, reservedCostUsd: 0.2222, inputTokens: 12345 } });
    await prepare();
    const text = screen.getByRole("dialog").textContent;
    for (const forbidden of ["gpt-6-luna", "Estimated cost", "Known cost", "Reserved budget", "Maximum AI budget", "AI calls", "0.1234", "0.1111", "0.2222", "12345"]) expect(text).not.toContain(forbidden);
    expect(mocks.review).not.toHaveBeenCalled(); expect(mocks.confirm).not.toHaveBeenCalled();
  });
  it("closes five seconds after the upload acknowledgement and keeps its tracked job", async () => {
    const properties = { ...props(), backgroundManaged: true, onJobChange: vi.fn() }, queued = { ...job, status: "queued", progress: { completedChunks: 0, totalChunks: 3 } };
    mocks.start.mockResolvedValue(queued); render(wrap(<SupplierAiImportDialog {...properties} />)); await screen.findByLabelText("Supplier document"); upload(); vi.useFakeTimers(); await act(async () => fireEvent.click(screen.getByRole("button", { name: "Prepare AI import review" })));
    expect(screen.getByText(/This dialog closes in 5 seconds/)).toBeInTheDocument(); expect(properties.onJobChange).toHaveBeenCalledWith(queued); expect(screen.getByText("0 of 3 document sections processed.")).toBeInTheDocument();
    for (let index = 0; index < 4; index += 1) await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(properties.onClose).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(properties.onClose).toHaveBeenCalledTimes(1); expect(mocks.get).not.toHaveBeenCalled();
  });
  it("does not start the countdown for an unconfirmed upload and allows keeping an acknowledged job open", async () => {
    const acknowledgement = deferred(), properties = { ...props(), backgroundManaged: true, onJobChange: vi.fn() };
    mocks.start.mockReturnValue(acknowledgement.promise); render(wrap(<SupplierAiImportDialog {...properties} />)); await screen.findByLabelText("Supplier document"); upload(); fireEvent.click(screen.getByRole("button", { name: "Prepare AI import review" }));
    vi.useFakeTimers(); await act(async () => { await vi.advanceTimersByTimeAsync(6000); }); expect(properties.onClose).not.toHaveBeenCalled(); expect(screen.queryByText(/This dialog closes in/)).not.toBeInTheDocument();
    await act(async () => acknowledgement.resolve({ ...job, status: "processing" })); expect(screen.getByText(/This dialog closes in 5 seconds/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Keep open" })); await act(async () => { await vi.advanceTimersByTimeAsync(6000); }); expect(properties.onClose).not.toHaveBeenCalled();
  });
  it("cancels the countdown when background processing ends or a different job is opened", async () => {
    const properties = { ...props(), backgroundManaged: true, onJobChange: vi.fn() }, queued = { ...job, status: "queued" };
    mocks.start.mockResolvedValue(queued); const view = render(wrap(<SupplierAiImportDialog {...properties} />)); await screen.findByLabelText("Supplier document"); upload(); fireEvent.click(screen.getByRole("button", { name: "Prepare AI import review" })); await screen.findByText(/This dialog closes in 5 seconds/);
    vi.useFakeTimers(); view.rerender(wrap(<SupplierAiImportDialog {...properties} trackedJobId="job" trackedJob={{ ...job, status: "failed", error: { code: "processing-failed", message: "The document needs correction." } }} />));
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); }); expect(properties.onClose).not.toHaveBeenCalled(); expect(screen.queryByText(/This dialog closes in/)).not.toBeInTheDocument();
    view.rerender(wrap(<SupplierAiImportDialog {...properties} trackedJobId="other-job" trackedJob={{ ...queued, jobId: "other-job", source: { fileName: "other.csv" } }} />)); expect(screen.getByText("other.csv")).toBeInTheDocument(); expect(mocks.get).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); }); expect(properties.onClose).not.toHaveBeenCalled();
  });
  it("opens a background draft ready for review without starting another upload or displaying imported-product success", async () => {
    render(wrap(<SupplierAiImportDialog {...props()} backgroundManaged trackedJobId="job" trackedJob={job} onJobChange={vi.fn()} />));
    await screen.findByRole("button", { name: "Open import review" }); expect(screen.getByText("Review the proposed products before importing.")).toBeInTheDocument(); expect(mocks.start).not.toHaveBeenCalled(); expect(mocks.confirm).not.toHaveBeenCalled(); expect(mocks.get).not.toHaveBeenCalled();
  });
  it("opens a fresh upload form for another document while the first acknowledged job keeps processing", async () => {
    const properties = { ...props(), backgroundManaged: true, onJobChange: vi.fn() }, first = { ...job, status: "processing" };
    const view = render(wrap(<SupplierAiImportDialog {...properties} trackedJobId="job" trackedJob={first} />));
    expect(await screen.findByText("Reading the document and preparing a review…")).toBeInTheDocument();
    view.rerender(wrap(<SupplierAiImportDialog {...properties} open={false} trackedJobId="job" trackedJob={first} />));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await act(async () => { await new Promise(requestAnimationFrame); });
    view.rerender(wrap(<SupplierAiImportDialog {...properties} trackedJobId={null} trackedJob={null} />));
    await screen.findByLabelText("Supplier document"); expect(screen.queryByText("Reading the document and preparing a review…")).not.toBeInTheDocument(); expect(mocks.start).not.toHaveBeenCalled();
    mocks.start.mockResolvedValue({ ...first, jobId: "second-job", source: { fileName: "second.csv" } }); upload(); fireEvent.click(screen.getByRole("button", { name: "Prepare AI import review" }));
    expect(await screen.findByText("second.csv")).toBeInTheDocument(); expect(properties.onJobChange).toHaveBeenCalledWith(expect.objectContaining({ jobId: "second-job" }));
  });
  it("loads current hotel suppliers despite a stale empty page-loading snapshot", async () => {
    const directory = deferred(); mocks.suppliers.mockReturnValue(directory.promise);
    render(wrap(<SupplierAiImportDialog {...props()} suppliers={[]} suppliersLoading backgroundManaged onJobChange={vi.fn()} />));
    await screen.findByLabelText("Supplier document"); upload(); expect(screen.getByRole("button", { name: "Prepare AI import review" })).toBeDisabled();
    await act(async () => directory.resolve([{ id: "supplier", name: "Fresh supplier name" }])); expect(screen.getByRole("combobox", { name: "AI import supplier" })).toHaveValue("Fresh supplier name"); expect(screen.getByRole("button", { name: "Prepare AI import review" })).toBeEnabled(); expect(mocks.suppliers).toHaveBeenCalledWith("hotel-a");
  });
  it("can start another document from a recovered draft on any route without page-owned supplier props", async () => {
    const properties = { ...props(), suppliers: [], initialSupplierId: "", backgroundManaged: true, onNewDocument: vi.fn(), onJobChange: vi.fn() };
    const view = render(wrap(<SupplierAiImportDialog {...properties} trackedJobId="job" trackedJob={job} />)); await screen.findByRole("button", { name: "Open import review" });
    fireEvent.click(screen.getByRole("button", { name: "Start another document" })); view.rerender(wrap(<SupplierAiImportDialog {...properties} trackedJobId={null} trackedJob={null} />));
    await screen.findByLabelText("Supplier document"); await waitFor(() => expect(mocks.suppliers).toHaveBeenCalledWith("hotel-a"));
    fireEvent.focus(screen.getByRole("combobox", { name: "AI import supplier" })); fireEvent.change(screen.getByRole("combobox", { name: "AI import supplier" }), { target: { value: "Coffee" } }); fireEvent.click(await screen.findByRole("option", { name: "Coffee Supplier" })); upload(); expect(screen.getByRole("button", { name: "Prepare AI import review" })).toBeEnabled();
  });
  it("discards a supplier response after the actor changes and offers an explicit directory retry", async () => {
    const directory = deferred(), properties = { ...props(), backgroundManaged: true }; mocks.suppliers.mockReturnValue(directory.promise);
    const view = render(wrap(<SupplierAiImportDialog {...properties} />)); await screen.findByLabelText("Supplier document"); mocks.actor = { uid: "manager" }; mocks.suppliers.mockRejectedValue(new Error("Directory unavailable")); view.rerender(wrap(<SupplierAiImportDialog {...properties} />));
    await screen.findByText(/The supplier directory could not be loaded/); await act(async () => directory.resolve([{ id: "supplier", name: "Stale supplier" }])); expect(screen.getByRole("combobox", { name: "AI import supplier" })).not.toHaveValue("Stale supplier");
    mocks.suppliers.mockResolvedValue([{ id: "supplier", name: "Fresh supplier" }]); fireEvent.click(screen.getByRole("button", { name: "Retry supplier directory" })); await waitFor(() => expect(screen.getByRole("combobox", { name: "AI import supplier" })).toHaveValue("Fresh supplier"));
  });
  it("requires a price-basis choice while using only the validated hotel currency default", async () => {
    render(wrap(<SupplierAiImportDialog {...props()} />)); await screen.findByLabelText("Supplier document");
    fireEvent.change(screen.getByLabelText("Supplier document"), { target: { files: [new File(["supplier rows"], "prices.csv")] } });
    expect(screen.getByLabelText("Document price basis")).toHaveValue(""); expect(screen.getByRole("combobox", { name: "Document currency" }).value).toMatch(/^EUR/); expect(screen.getByRole("button", { name: "Prepare AI import review" })).toBeDisabled(); expect(mocks.start).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Document price basis"), { target: { value: "net" } }); fireEvent.click(screen.getByRole("button", { name: "Prepare AI import review" }));
    await waitFor(() => expect(mocks.start).toHaveBeenCalledWith("hotel-a", "supplier", expect.any(File), { ...settings, ...recurringSettings }));
  });
  it("keeps missing or invalid hotel currency unknown and requires a searched currency choice", async () => {
    mocks.availability.mockResolvedValue({ available: true, importPolicyVersion: 2, reviewWorkspaceVersion: 1, recurringImportVersion: 1, sourceFormatProfileVersion: 1, defaults: { currency: "ZZZ" } }); render(wrap(<SupplierAiImportDialog {...props()} />)); await screen.findByLabelText("Supplier document"); upload();
    const currency = screen.getByRole("combobox", { name: "Document currency" }); expect(currency).toHaveValue(""); expect(screen.getByRole("button", { name: "Prepare AI import review" })).toBeDisabled();
    fireEvent.focus(currency); fireEvent.change(currency, { target: { value: "EUR" } }); fireEvent.click(await screen.findByRole("option", { name: /^EUR/ })); expect(screen.getByRole("button", { name: "Prepare AI import review" })).toBeEnabled();
  });
  it("supports gross prices without guessing VAT and snapshots an explicitly supplied uniform percentage", async () => {
    render(wrap(<SupplierAiImportDialog {...props()} />)); await screen.findByLabelText("Supplier document"); fireEvent.change(screen.getByLabelText("Document price basis"), { target: { value: "gross" } }); upload();
    expect(screen.getByText(/No tax rate is guessed/)).toBeInTheDocument(); expect(screen.queryByLabelText("Shared VAT rate (%)")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: /Use one shared VAT rate/ })); expect(screen.getByRole("button", { name: "Prepare AI import review" })).toBeDisabled(); fireEvent.change(screen.getByLabelText("Shared VAT rate (%)"), { target: { value: "106" } }); expect(screen.getByRole("button", { name: "Prepare AI import review" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Shared VAT rate (%)"), { target: { value: "6" } }); fireEvent.click(screen.getByRole("button", { name: "Prepare AI import review" }));
    await waitFor(() => expect(mocks.start).toHaveBeenCalledWith("hotel-a", "supplier", expect.any(File), { ...settings, ...recurringSettings, priceBasis: "gross", vatRate: 0.06 }));
  });
  it("permits explicit unknown basis and optional unknown VAT without presenting purchase prices as reliable", async () => {
    mocks.start.mockResolvedValue({ ...job, importSettings: { ...settings, priceBasis: "unknown" } }); render(wrap(<SupplierAiImportDialog {...props()} />)); await screen.findByLabelText("Supplier document"); fireEvent.change(screen.getByLabelText("Document price basis"), { target: { value: "unknown" } }); upload();
    expect(screen.getByText(/Prices without a documented net or gross basis/)).toBeInTheDocument(); fireEvent.click(screen.getByRole("button", { name: "Prepare AI import review" })); await screen.findByRole("button", { name: "Open import review" });
    expect(mocks.start).toHaveBeenCalledWith("hotel-a", "supplier", expect.any(File), { ...settings, ...recurringSettings, priceBasis: "unknown" }); expect(screen.getByText(/Unknown price basis — requires review/)).toBeInTheDocument();
  });
  it("locks and restores the original settings for an unknown upload acknowledgement", async () => {
    const original = { policyVersion: 2, priceBasis: "gross", currency: "EUR", vatRate: 0.06 };
    mocks.start.mockRejectedValueOnce(Object.assign(new Error("Original price settings restored"), { code: "import-settings-changed", importSettings: original })).mockResolvedValueOnce({ ...job, importSettings: original });
    render(wrap(<SupplierAiImportDialog {...props()} />)); await screen.findByLabelText("Supplier document"); upload(); fireEvent.click(screen.getByRole("button", { name: "Prepare AI import review" })); await screen.findByText("Original price settings restored");
    expect(screen.getByLabelText("Document price basis")).toHaveValue("gross"); expect(screen.getByLabelText("Document price basis")).toBeDisabled(); expect(screen.getByRole("combobox", { name: "Document currency" })).toBeDisabled(); expect(screen.getByLabelText("Shared VAT rate (%)")).toHaveValue(6); expect(screen.getByLabelText("Shared VAT rate (%)")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Recover original upload" })); await screen.findByRole("button", { name: "Open import review" }); expect(mocks.start.mock.calls[1][3]).toEqual(original);
  });
});
it("snapshots fractional VAT percentages canonically and blocks unsupported precision before an AI request", async () => {
  render(wrap(<SupplierAiImportDialog {...props()} />)); await screen.findByLabelText("Supplier document"); fireEvent.change(screen.getByLabelText("Document price basis"), { target: { value: "gross" } }); upload(); fireEvent.click(screen.getByRole("checkbox", { name: /Use one shared VAT rate/ }));
  fireEvent.change(screen.getByLabelText("Shared VAT rate (%)"), { target: { value: "5.60001" } }); expect(screen.getByRole("button", { name: "Prepare AI import review" })).toBeDisabled(); expect(mocks.start).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Shared VAT rate (%)"), { target: { value: "5.6" } }); fireEvent.click(screen.getByRole("button", { name: "Prepare AI import review" })); await waitFor(() => expect(mocks.start.mock.calls[0][3].vatRate).toBe(0.056));
});
it("shows a service upgrade notice and offers retry without exposing the new-upload form against an older backend", async () => {
  mocks.availability.mockResolvedValueOnce({ available: true, limits: { maxProducts: 1000 } }); render(wrap(<SupplierAiImportDialog {...props()} />)); await screen.findByText("Import service update is in progress. Try again after it finishes."); expect(screen.queryByLabelText("Supplier document")).not.toBeInTheDocument(); expect(mocks.start).not.toHaveBeenCalled();
  mocks.availability.mockResolvedValueOnce({ available: true, importPolicyVersion: 2, reviewWorkspaceVersion: 1, recurringImportVersion: 1, sourceFormatProfileVersion: 1, defaults: { currency: "EUR" } }); fireEvent.click(screen.getByRole("button", { name: "Retry access check" })); await screen.findByLabelText("Supplier document");
});

it("keeps row details out of the upload dialog and navigates a ready legacy draft to its private review page", async () => {
  render(wrap(<SupplierAiImportDialog {...props()} backgroundManaged trackedJobId="legacy-job" trackedJob={{ ...job, jobId: "legacy-job", importSettings: null }} />));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getAllByRole("button", { name: "Close dialog" })).toHaveLength(1);
  expect(screen.queryByRole("article")).not.toBeInTheDocument();
  expect(screen.queryByText("Complete import overview")).not.toBeInTheDocument();
  expect(mocks.review).not.toHaveBeenCalled(); expect(mocks.confirm).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Open import review" }));
  expect(screen.getByText("Dedicated product review")).toBeInTheDocument(); expect(mocks.start).not.toHaveBeenCalled();
});
it("blocks a policy-v2 backend that has no review workspace capability before any paid upload", async () => {
  mocks.availability.mockResolvedValue({ available: true, importPolicyVersion: 2, defaults: { currency: "EUR" } });
  render(wrap(<SupplierAiImportDialog {...props()} />));
  expect(await screen.findByText("Import service update is in progress. Try again after it finishes.")).toBeInTheDocument();
  expect(screen.queryByLabelText("Supplier document")).not.toBeInTheDocument(); expect(mocks.start).not.toHaveBeenCalled();
});
it("keeps the accepted background state when a delayed status read returns an older queued snapshot", async () => {
  const accepted = { ...job, status: "review" }, properties = { ...props(), backgroundManaged: true, onJobChange: vi.fn(() => accepted) };
  mocks.get.mockResolvedValue({ ...job, status: "queued" });
  render(wrap(<SupplierAiImportDialog {...properties} trackedJobId="job" trackedJob={accepted} />));
  await screen.findByRole("button", { name: "Open import review" });
  fireEvent.click(screen.getByRole("button", { name: "Refresh import status" }));
  await waitFor(() => expect(properties.onJobChange).toHaveBeenCalled());
  expect(screen.getByText("Review the proposed products before importing.")).toBeInTheDocument();
  expect(screen.queryByText("Your document is queued.")).not.toBeInTheDocument();
});
it("discards a delayed private status response after a different document is acknowledged", async () => {
  const pending = deferred(); await prepare();
  mocks.get.mockReturnValueOnce(pending.promise); fireEvent.click(screen.getByRole("button", { name: "Refresh import status" }));
  fireEvent.click(screen.getByRole("button", { name: "Start another document" }));
  mocks.start.mockResolvedValue({ ...job, jobId: "second-job", source: { fileName: "second.csv" } });
  await screen.findByLabelText("Supplier document"); upload(); fireEvent.click(screen.getByRole("button", { name: "Prepare AI import review" }));
  await screen.findByText("second.csv"); await act(async () => pending.resolve(job));
  expect(screen.getByText("second.csv")).toBeInTheDocument(); expect(screen.queryByText("supplier.csv")).not.toBeInTheDocument();
  expect(mocks.review).not.toHaveBeenCalled(); expect(mocks.confirm).not.toHaveBeenCalled();
});
it("captures partial or full scope and future validity without guessing missing source dates", async () => {
  render(wrap(<SupplierAiImportDialog {...props()} />)); await screen.findByLabelText("Supplier document"); upload();
  expect(screen.getByLabelText("List scope")).toHaveValue("partial"); fireEvent.change(screen.getByLabelText("List scope"), { target: { value: "full" } });
  fireEvent.click(screen.getByText("Source date and price validity"));
  fireEvent.change(screen.getByLabelText("Prices valid from"), { target: { value: "2027-01-01" } });
  fireEvent.change(screen.getByLabelText("Prices valid until"), { target: { value: "2026-12-31" } });
  expect(screen.getByRole("button", { name: "Prepare AI import review" })).toBeDisabled(); expect(mocks.start).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Prices valid until"), { target: { value: "2027-12-31" } });
  fireEvent.click(screen.getByRole("button", { name: "Prepare AI import review" }));
  await waitFor(() => expect(mocks.start).toHaveBeenCalledWith("hotel-a", "supplier", expect.any(File), { ...settings, ...recurringSettings, assortmentMode: "full", priceValidFrom: "2027-01-01", priceValidUntil: "2027-12-31" }));
});
it("identifies statistics explicitly and locks the original recurring metadata during lost upload recovery", async () => {
  const original = { ...settings, ...recurringSettings, documentPurpose: "statistics", sourceIssuedOn: "2026-09-15" };
  mocks.start.mockRejectedValueOnce(new Error("Acknowledgement lost")).mockResolvedValueOnce({ ...job, importSettings: original });
  render(wrap(<SupplierAiImportDialog {...props()} />)); await screen.findByLabelText("Supplier document"); upload();
  fireEvent.change(screen.getByLabelText("Document purpose"), { target: { value: "statistics" } }); fireEvent.click(screen.getByText("Source date and price validity")); fireEvent.change(screen.getByLabelText("Source issued on"), { target: { value: "2026-09-15" } });
  fireEvent.click(screen.getByRole("button", { name: "Prepare AI import review" })); await screen.findByText("Acknowledgement lost");
  expect(screen.getByLabelText("Document purpose")).toBeDisabled(); expect(screen.getByLabelText("Source issued on")).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Recover original upload" })); await screen.findByRole("button", { name: "Open import review" });
  expect(mocks.start.mock.calls[0][3]).toEqual(original); expect(mocks.start.mock.calls[0]).toEqual(mocks.start.mock.calls[1]); expect(screen.getByText(/Purchase statistics — no price confirmation/)).toBeInTheDocument();
});
it("blocks fresh uploads until recurring format and pricing capabilities are available", async () => {
  mocks.availability.mockResolvedValue({ available: true, importPolicyVersion: 2, reviewWorkspaceVersion: 1, defaults: { currency: "EUR" } });
  render(wrap(<SupplierAiImportDialog {...props()} />)); await screen.findByText(/Recurring import service update is in progress/); upload();
  expect(screen.getByRole("button", { name: "Prepare AI import review" })).toBeDisabled(); fireEvent.click(screen.getByRole("button", { name: "Prepare AI import review" })); expect(mocks.start).not.toHaveBeenCalled();
  mocks.availability.mockResolvedValueOnce({ available: true, importPolicyVersion: 2, reviewWorkspaceVersion: 1, recurringImportVersion: 1, sourceFormatProfileVersion: 1, defaults: { currency: "EUR" } }); fireEvent.click(screen.getByRole("button", { name: "Retry access check" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Prepare AI import review" })).toBeEnabled());
});
it("offers recovery for a retained legacy upload reference while new recurring capabilities are absent", async () => {
  sessionStorage.setItem("supplier-ai-upload:manager:hotel-a:supplier:original-file", JSON.stringify({ requestId: "original-command" }));
  mocks.availability.mockResolvedValue({ available: true, importPolicyVersion: 2, reviewWorkspaceVersion: 1, defaults: { currency: "EUR" } });
  const original = { policyVersion: 2, priceBasis: "gross", currency: "EUR", vatRate: 0.06 };
  mocks.start.mockRejectedValueOnce(Object.assign(new Error("Original price settings restored"), { code: "import-settings-changed", importSettings: original })).mockResolvedValueOnce({ ...job, importSettings: original });
  render(wrap(<SupplierAiImportDialog {...props()} />)); await screen.findByLabelText("Supplier document"); upload();
  expect(screen.getByText(/An earlier upload reference is retained/)).toBeInTheDocument(); fireEvent.click(screen.getByRole("button", { name: "Recover original upload" })); await screen.findByText("Original price settings restored");
  fireEvent.click(screen.getByRole("button", { name: "Recover original upload" })); await screen.findByRole("button", { name: "Open import review" }); expect(mocks.start.mock.calls[1][3]).toEqual(original);
});
it("keeps confirmed CSV and XLSX import available when new document interpretation is disabled", async () => {
  mocks.availability.mockResolvedValue({ available: true, aiAvailable: false, recurringFormatsAvailable: true, importPolicyVersion: 2, reviewWorkspaceVersion: 1, recurringImportVersion: 1, sourceFormatProfileVersion: 1, defaults: { currency: "EUR" } });
  render(wrap(<SupplierAiImportDialog {...props()} />)); await screen.findByText(/CSV or XLSX files matching a previously confirmed supplier format/); upload();
  expect(screen.getByRole("button", { name: "Prepare AI import review" })).toBeEnabled(); expect(screen.queryByText(/AI supplier imports are disabled/)).not.toBeInTheDocument();
});
