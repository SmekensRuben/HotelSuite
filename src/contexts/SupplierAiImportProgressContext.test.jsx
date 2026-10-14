import React, { StrictMode } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ actor: null, hotel: {}, get: vi.fn(), success: vi.fn(), error: vi.fn(), dismiss: vi.fn(), upload: null, dialogMounts: 0, progress: null }));
vi.mock("../firebaseConfig", () => ({ auth: { get currentUser() { return mocks.actor; } } }));
vi.mock("./HotelContext", () => ({ useHotelContext: () => mocks.hotel }));
vi.mock("../services/firebaseSupplierAiImports", () => ({ getSupplierAiImport: mocks.get }));
vi.mock("react-toastify", () => ({ toast: { success: mocks.success, error: mocks.error, dismiss: mocks.dismiss } }));
vi.mock("../components/catalog/SupplierAiImportDialog", async () => {
  const { useEffect, useRef } = await import("react");
  return { default: function Dialog(props) {
    const alive = useRef(true);
    useEffect(() => { alive.current = true; mocks.dialogMounts += 1; return () => { alive.current = false; }; }, []);
    if (!props.open) return null;
    return <section role="dialog" aria-label="Tracked supplier import">
      <p>{props.trackedJob?.status || "New document"}</p>
      <output data-testid="tracked-job-reference">{props.trackedJobId || "new"}</output>
      <button onClick={props.onClose}>Close tracker dialog</button>
      <button onClick={() => mocks.upload.promise.then((value) => { if (alive.current) props.onJobChange(value); })}>Start delayed upload</button>
    </section>;
  } };
});
import { SupplierAiImportProgressProvider, supplierAiProgressMetadata, useSupplierAiImportProgress } from "./SupplierAiImportProgressContext";
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
const job = (jobId = "one", status = "queued", patch = {}) => ({ hotelUid: "hotel-a", ownerUid: "user-a", supplierId: "supplier", jobId, status, source: { fileName: `${jobId}.csv` }, ...patch });
function Page({ name }) {
  const progress = useSupplierAiImportProgress();
  mocks.progress = progress;
  return <main><h1>{name}</h1><Link to={name === "Supplier products" ? "/orders" : "/suppliers"}>Navigate to another page</Link>
    <button onClick={() => progress.watchJob(job())}>Track first job</button>
    <button onClick={() => progress.watchJob(job("two"))}>Track second job</button>
    <button onClick={() => progress.watchJob(job("one", "review"))}>Observe ready review</button>
    <button onClick={() => progress.openNew()}>Open new import</button>
    <output data-testid="safe-jobs">{JSON.stringify(progress.jobs)}</output>
  </main>;
}
const tree = (strict = false) => {
  const content = <MemoryRouter initialEntries={["/suppliers"]}><SupplierAiImportProgressProvider><Routes><Route path="/suppliers" element={<Page name="Supplier products" />} /><Route path="/orders" element={<Page name="Orders" />} /><Route path="/catalog/supplier-products/imports/:jobId" element={<Page name="Private import review" />} /></Routes></SupplierAiImportProgressProvider></MemoryRouter>;
  return strict ? <StrictMode>{content}</StrictMode> : content;
};
const advance = async (milliseconds) => { await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds); }); };
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); sessionStorage.clear(); mocks.dialogMounts = 0;
  mocks.actor = { uid: "user-a", emailVerified: true };
  mocks.hotel = { hotelUid: "hotel-a", currentUser: mocks.actor, authLoading: false, permissionsLoading: false, subscriptionLoading: false, permissions: ["supplierproducts.read", "supplierproducts.create", "suppliers.read"], subscriptionActive: true, subscription: { modulePolicyVersion: 1, modules: ["procurement"] } };
  mocks.get.mockImplementation(async (_hotel, jobId) => job(jobId, "processing")); mocks.upload = deferred();
});
afterEach(() => { vi.useRealTimers(); });
describe("persistent supplier import progress", () => {
  it("keeps two read-only background polls alive when their original page unmounts", async () => {
    render(tree()); fireEvent.click(screen.getByRole("button", { name: "Track first job" })); fireEvent.click(screen.getByRole("button", { name: "Track second job" }));
    expect(screen.getByRole("button", { name: "2 imports in progress" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("link", { name: "Navigate to another page" })); expect(screen.getByRole("heading", { name: "Orders" })).toBeInTheDocument();
    await advance(3000); expect(mocks.get).toHaveBeenCalledWith("hotel-a", "one"); expect(mocks.get).toHaveBeenCalledWith("hotel-a", "two");
    mocks.get.mockImplementation(async (_hotel, id) => job(id, id === "one" ? "review" : "failed")); await advance(3000);
    expect(mocks.success).toHaveBeenCalledTimes(1); expect(mocks.error).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "1 import needs attention" }));
    fireEvent.click(screen.getByRole("button", { name: "Open one.csv: Ready for review" })); expect(screen.getByRole("heading", { name: "Private import review" })).toBeInTheDocument(); expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await advance(30000); expect(mocks.get).toHaveBeenCalledTimes(4);
  });
  it("registers an upload acknowledgement after the dialog closes and the page changes", async () => {
    render(tree()); fireEvent.click(screen.getByRole("button", { name: "Open new import" })); fireEvent.click(screen.getByRole("button", { name: "Start delayed upload" }));
    fireEvent.click(screen.getByRole("button", { name: "Close tracker dialog" })); fireEvent.click(screen.getByRole("link", { name: "Navigate to another page" }));
    await act(async () => mocks.upload.resolve(job())); expect(screen.getByRole("button", { name: "1 import in progress" })).toBeInTheDocument(); expect(mocks.dialogMounts).toBe(1);
    await advance(3000); expect(mocks.get).toHaveBeenCalledWith("hotel-a", "one");
  });
  it("does not let another background job replace a new document being uploaded", async () => {
    render(tree()); fireEvent.click(screen.getByRole("button", { name: "Track first job" }));
    fireEvent.click(screen.getByRole("button", { name: "Open new import" })); fireEvent.click(screen.getByRole("button", { name: "Start delayed upload" }));
    await advance(3000); expect(screen.getByTestId("tracked-job-reference")).toHaveTextContent("new");
    await act(async () => mocks.upload.resolve(job("two"))); expect(screen.getByTestId("tracked-job-reference")).toHaveTextContent("two"); expect(screen.getByRole("button", { name: "2 imports in progress" })).toBeInTheDocument();
  });
  it("preserves a ready status when an older in-flight processing response arrives", async () => {
    const delayed = deferred(); mocks.get.mockReturnValue(delayed.promise);
    render(tree()); fireEvent.click(screen.getByRole("button", { name: "Track first job" })); await advance(3000);
    fireEvent.click(screen.getByRole("button", { name: "Observe ready review" })); expect(screen.getByRole("button", { name: "Import ready for review" })).toBeInTheDocument();
    await act(async () => delayed.resolve(job("one", "queued"))); expect(screen.getByRole("button", { name: "Import ready for review" })).toBeInTheDocument(); expect(mocks.success).toHaveBeenCalledTimes(1);
    await advance(30000); expect(mocks.get).toHaveBeenCalledTimes(1);
  });
  it("backs off temporary network errors without displaying a failed import or triggering a new request", async () => {
    mocks.get.mockRejectedValue(new Error("Connection lost")); render(tree()); fireEvent.click(screen.getByRole("button", { name: "Track first job" }));
    await advance(3000); expect(screen.getByRole("button", { name: "1 import in progress" })).toBeInTheDocument(); expect(screen.getByText("Reconnecting to status updates…")).toBeInTheDocument(); expect(mocks.error).not.toHaveBeenCalled();
    await advance(3000); expect(mocks.get).toHaveBeenCalledTimes(1); await advance(3000); expect(mocks.get).toHaveBeenCalledTimes(2);
    mocks.get.mockResolvedValue(job("one", "review")); await advance(12000); expect(mocks.success).toHaveBeenCalledTimes(1);
  });
  it("recovers opaque pending references under Strict Mode and notifies their terminal transition once across reloads", async () => {
    sessionStorage.setItem("supplier-ai-progress:user-a:hotel-a", JSON.stringify({ jobIds: ["one"], activeIds: ["one"], notified: [] })); mocks.get.mockResolvedValue(job("one", "review"));
    const view = render(tree(true)); await advance(0); expect(screen.getByRole("button", { name: "Import ready for review" })).toBeInTheDocument(); expect(mocks.success).toHaveBeenCalledTimes(1);
    const saved = JSON.parse(sessionStorage.getItem("supplier-ai-progress:user-a:hotel-a")); expect(saved).toEqual({ jobIds: ["one"], activeIds: ["one"], notified: [{ jobId: "one", status: "ready" }] });
    view.unmount(); render(tree()); await advance(0); expect(mocks.success).toHaveBeenCalledTimes(1);
  });
  it.each(["logout", "same UID actor", "hotel switch", "permissions", "subscription"])("fences old status and open dialogs on %s", async (change) => {
    const delayed = deferred(); mocks.get.mockReturnValue(delayed.promise); const view = render(tree()); fireEvent.click(screen.getByRole("button", { name: "Track first job" }));
    fireEvent.click(screen.getByRole("button", { name: "1 import in progress" })); await advance(3000);
    if (change === "logout") { mocks.actor = null; mocks.hotel.currentUser = null; }
    if (change === "same UID actor") { mocks.actor = { uid: "user-a", emailVerified: true }; mocks.hotel.currentUser = mocks.actor; }
    if (change === "hotel switch") mocks.hotel.hotelUid = "hotel-b";
    if (change === "permissions") mocks.hotel.permissions = ["supplierproducts.read"];
    if (change === "subscription") mocks.hotel.subscriptionActive = false;
    view.rerender(tree()); expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await act(async () => delayed.resolve(job("one", "review"))); expect(mocks.success).not.toHaveBeenCalled(); expect(screen.queryByRole("button", { name: "Import ready for review" })).not.toBeInTheDocument();
  });
  it("stores no document, provider or cost data and sanitizes legacy response details", () => {
    const value = supplierAiProgressMetadata(job("one", "failed", { usage: { actualCostUsd: 0.123, inputTokens: 900 }, model: "expensive", budget: 0.25, error: { message: "AI budget $0.25 exceeded" }, warnings: [{ message: "Estimated cost $0.123" }], counts: { new: 1, changed: 2, unchanged: 3, blocked: 4 }, progress: { completedChunks: 2, totalChunks: 3 } }), "hotel-a", "user-a");
    expect(value).not.toHaveProperty("usage"); expect(value).not.toHaveProperty("model"); expect(value).not.toHaveProperty("budget"); expect(JSON.stringify(value)).not.toMatch(/0\.123|\$0\.25|Estimated cost/);
    expect(value.counts.changed).toBe(2); expect(value.progress.completedChunks).toBe(2);
    render(tree()); fireEvent.click(screen.getByRole("button", { name: "Track first job" })); expect(sessionStorage.getItem("supplier-ai-progress:user-a:hotel-a")).not.toMatch(/fileName|\.csv|source|usage|cost|tokens|model/i);
  });
  it("projects immutable commercial settings and all-row normalization findings while keeping browser recovery opaque", () => {
    const summary = { version: 2, totalRows: 250, normalizedRows: 230, assumptionRows: 75, unknownPriceRows: 40, blockedNormalizationRows: 5, inferredPieceRows: 20, missingRequiredRows: 8, findings: [{ field: "pricingModel", code: "pricing-model-needs-review", severity: "warning", message: "Purchase pricing needs review.", count: 5, rowIds: ["r-000001"] }] };
    const counts = { new: 200, changed: 30, unchanged: 12, blocked: 8 }, importSettings = { policyVersion: 2, priceBasis: "gross", currency: "EUR", vatRate: null };
    const incoming = job("one", "review", { totalRows: 250, counts, summary: { ...summary, usage: { costUsd: 999 } }, importSettings: { ...importSettings, model: "secret" }, originalInput: { rawSourceText: "private document" } });
    const value = supplierAiProgressMetadata(incoming, "hotel-a", "user-a");
    expect(value.summary).toEqual(summary); expect(value.importSettings).toEqual(importSettings); expect(value).not.toHaveProperty("originalInput"); expect(JSON.stringify(value)).not.toMatch(/costUsd|secret|private document/);
    render(tree()); act(() => mocks.progress.watchJob(incoming));
    expect(JSON.parse(screen.getByTestId("safe-jobs").textContent)[0].summary.totalRows).toBe(250);
    const saved = sessionStorage.getItem("supplier-ai-progress:user-a:hotel-a"); expect(saved).not.toMatch(/summary|findings|currency|priceBasis|vatRate|normalization|fileName|source/i);
  });
  it("keeps legacy summaries unavailable and rejects inconsistent full-document totals", () => {
    expect(supplierAiProgressMetadata(job("one", "review"), "hotel-a", "user-a").summary).toBeNull();
    expect(supplierAiProgressMetadata(job("one", "review"), "hotel-a", "user-a").importSettings).toBeNull();
    const summary = { version: 2, totalRows: 250, normalizedRows: 0, assumptionRows: 0, unknownPriceRows: 250, blockedNormalizationRows: 0, inferredPieceRows: 0, missingRequiredRows: 0, findings: [] };
    const value = supplierAiProgressMetadata(job("one", "review", { totalRows: 100, counts: { new: 250, changed: 0, unchanged: 0, blocked: 0 }, summary }), "hotel-a", "user-a");
    expect(value.summary).toBeNull(); expect(value.counts).toBeNull();
  });
  it("ignores a stale poll, accepts a fresh unavailable overview and never regresses processed sections", async () => {
    const pending = deferred(); mocks.get.mockReturnValue(pending.promise); render(tree()); fireEvent.click(screen.getByRole("button", { name: "Track first job" })); await advance(3000);
    const summary = { version: 2, totalRows: 250, normalizedRows: 230, assumptionRows: 75, unknownPriceRows: 40, blockedNormalizationRows: 5, inferredPieceRows: 20, missingRequiredRows: 8, findings: [] };
    act(() => mocks.progress.watchJob(job("one", "review", { totalRows: 250, counts: { new: 250, changed: 0, unchanged: 0, blocked: 0 }, summary }), { fromDialog: true }));
    await act(async () => pending.resolve(job("one", "review"))); expect(JSON.parse(screen.getByTestId("safe-jobs").textContent)[0].summary).toEqual(summary);
    act(() => mocks.progress.watchJob(job("one", "review", { totalRows: 250, counts: { new: 250, changed: 0, unchanged: 0, blocked: 0 }, summary: null }))); expect(JSON.parse(screen.getByTestId("safe-jobs").textContent)[0].summary).toBeNull();
    act(() => { mocks.progress.watchJob(job("two", "processing", { progress: { completedChunks: 5, totalChunks: 8 } })); mocks.progress.watchJob(job("two", "processing", { progress: { completedChunks: 2, totalChunks: 8 } })); });
    expect(JSON.parse(screen.getByTestId("safe-jobs").textContent).find((value) => value.jobId === "two").progress.completedChunks).toBe(5);
  });
  it("bounds long-session references and notification markers and lets the user dismiss a settled card", () => {
    render(tree());
    act(() => {
      for (let index = 0; index < 30; index += 1) { mocks.progress.watchJob(job(`import-${index}`)); mocks.progress.watchJob(job(`import-${index}`, "review")); }
    });
    const saved = JSON.parse(sessionStorage.getItem("supplier-ai-progress:user-a:hotel-a")); expect(saved.jobIds).toHaveLength(8); expect(saved.activeIds).toHaveLength(8); expect(saved.notified).toHaveLength(8);
    expect(saved.notified.every((entry) => saved.jobIds.includes(entry.jobId))).toBe(true); expect(mocks.dismiss).toHaveBeenCalledTimes(22);
    act(() => { mocks.progress.jobs.slice(1).forEach((value) => mocks.progress.dismissJob(value.jobId)); });
    expect(screen.getByRole("button", { name: "Import ready for review" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Dismiss .* from progress/ })); expect(screen.queryByRole("complementary", { name: "Supplier import progress" })).not.toBeInTheDocument(); expect(sessionStorage.getItem("supplier-ai-progress:user-a:hotel-a")).toBeNull();
  });
  it("keeps denied progress cleared until the authority scope changes", async () => {
    mocks.get.mockRejectedValue(Object.assign(new Error("Access removed"), { code: "permission-denied" }));
    render(tree()); fireEvent.click(screen.getByRole("button", { name: "Track first job" })); await advance(3000);
    expect(screen.queryByRole("complementary", { name: "Supplier import progress" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Track first job" })); expect(screen.queryByRole("complementary", { name: "Supplier import progress" })).not.toBeInTheDocument();
    await advance(30000); expect(mocks.get).toHaveBeenCalledTimes(1);
  });
  it("opens a completed notification in the dedicated page while keeping an unresolved upload dialog mounted", async () => {
    render(tree()); fireEvent.click(screen.getByRole("button", { name: "Open new import" }));
    fireEvent.click(screen.getByRole("button", { name: "Start delayed upload" }));
    act(() => { mocks.progress.watchJob(job("older")); mocks.progress.watchJob(job("older", "review")); });
    act(() => mocks.success.mock.calls[0][1].onClick());
    expect(screen.getByRole("heading", { name: "Private import review" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(); expect(mocks.dialogMounts).toBe(1);
    await act(async () => mocks.upload.resolve(job("current")));
    expect(JSON.parse(screen.getByTestId("safe-jobs").textContent).some((value) => value.jobId === "current")).toBe(true);
  });
  it("allows a private cold reference to navigate but rejects path injection and revoked authority", () => {
    const view = render(tree());
    act(() => mocks.progress.openJob("../hotel-b"));
    expect(screen.getByRole("heading", { name: "Supplier products" })).toBeInTheDocument();
    act(() => mocks.progress.openJob("untracked-job"));
    expect(screen.getByRole("heading", { name: "Private import review" })).toBeInTheDocument();
    expect(mocks.get).not.toHaveBeenCalled();
    mocks.hotel.permissions = ["supplierproducts.read"]; view.rerender(tree());
    act(() => mocks.progress.openNew()); expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("hides the floating card on the review page while polling and restoring it on other routes", async () => {
    render(tree()); fireEvent.click(screen.getByRole("button", { name: "Track first job" }));
    fireEvent.click(screen.getByRole("button", { name: "Track second job" }));
    expect(screen.getByRole("complementary", { name: "Supplier import progress" })).toBeInTheDocument();
    act(() => mocks.progress.openJob("one"));
    expect(screen.getByRole("heading", { name: "Private import review" })).toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "Supplier import progress" })).not.toBeInTheDocument();
    await advance(3000);
    expect(mocks.get).toHaveBeenCalledWith("hotel-a", "one"); expect(mocks.get).toHaveBeenCalledWith("hotel-a", "two");
    expect(JSON.parse(screen.getByTestId("safe-jobs").textContent)).toHaveLength(2);
    fireEvent.click(screen.getByRole("link", { name: "Navigate to another page" }));
    expect(screen.getByRole("heading", { name: "Supplier products" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "2 imports in progress" })).toBeInTheDocument();
    expect(JSON.parse(screen.getByTestId("safe-jobs").textContent)).toHaveLength(2);
  });

});
