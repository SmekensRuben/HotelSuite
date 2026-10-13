import React, { useCallback, useEffect, useRef, useState } from "react";
import { auth } from "../../firebaseConfig";
import { usePermission } from "../../hooks/usePermission";
import { useSupplierProductAuthority } from "../../hooks/useSupplierProductAuthority";
import { Combobox } from "../ui/combobox";
import Modal from "../shared/Modal";
import SupplierAiImportRow from "./SupplierAiImportRow";
import {
  SUPPLIER_AI_IMPORT_ACCEPT, validateSupplierAiImportFile, getSupplierAiImportAvailability,
  startSupplierAiImport, getSupplierAiImport, getSupplierAiImportReview, confirmSupplierAiImport,
} from "../../services/firebaseSupplierAiImports";

const processing = new Set(["queued", "processing"]);
const reviewable = new Set(["review", "partially_committed", "completed"]);
const statuses = {
  queued: "Your document is queued.", processing: "Reading the document and preparing a review…",
  review: "Review the proposed products before importing.", failed: "Document processing failed. No automatic model fallback was used.",
  response_unknown: "The provider response is uncertain. A further AI call will not start automatically.",
  partially_committed: "Some rows have been processed. Review the remaining rows.", completed: "Import processing is complete.", expired: "This private draft is no longer available. Start a new document when you are ready.",
};
export default function SupplierAiImportDialog(props) {
  const authority = useSupplierProductAuthority();
  return <ScopedSupplierAiImportDialog key={authority} {...props} />;
}
function ScopedSupplierAiImportDialog({ open, onClose, hotelUid, suppliers = [], suppliersLoading = false, initialSupplierId = "", onImported }) {
  const actor = useRef(auth.currentUser).current, alive = useRef(true);
  const current = useCallback(() => alive.current && auth.currentUser === actor, [actor]);
  const canRead = usePermission("supplierproducts", "read"), canCreate = usePermission("supplierproducts", "create"), canReadSuppliers = usePermission("suppliers", "read");
  const permitted = canRead && canCreate && canReadSuppliers;
  const storageKey = `supplier-ai-import:${hotelUid}:${actor?.uid || "anonymous"}`;
  const [availability, setAvailability] = useState(null), [availabilityLoading, setAvailabilityLoading] = useState(false);
  const [supplierId, setSupplierId] = useState(initialSupplierId), [file, setFile] = useState(null), [job, setJob] = useState(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(null), [pollError, setPollError] = useState(null), [rows, setRows] = useState([]);
  const [nextCursor, setNextCursor] = useState(null), [cursor, setCursor] = useState(null), [cursorHistory, setCursorHistory] = useState([null]);
  const [totalRows, setTotalRows] = useState(0), [reviewLoading, setReviewLoading] = useState(false), [selected, setSelected] = useState({});
  const [outcomes, setOutcomes] = useState([]), [uncertainUpload, setUncertainUpload] = useState(false), [uncertainCommit, setUncertainCommit] = useState(false);
  const pendingCommit = useRef(null), lastReviewJob = useRef(null), input = useRef(null);
  const generation = useRef(0), jobRequests = useRef(0), rowRequests = useRef(0), latestJob = useRef(job), latestRows = useRef(rows); latestJob.current = job; latestRows.current = rows;
  const [resuming, setResuming] = useState(false);
  const renderedGeneration = generation.current;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const remember = useCallback((value) => { try { sessionStorage.setItem(storageKey, JSON.stringify({ jobId: value.jobId })); } catch { /* Recovery remains available in the open view. */ } }, [storageKey]);
  const forget = () => { try { sessionStorage.removeItem(storageKey); } catch { /* Browser storage is optional. */ } };
  const loadAvailability = useCallback(async () => {
    if (!permitted || !hotelUid || !current()) return;
    setAvailabilityLoading(true); setError(null);
    try { const value = await getSupplierAiImportAvailability(hotelUid); if (current()) setAvailability(value); }
    catch (failure) { if (current()) setError(failure); }
    finally { if (current()) setAvailabilityLoading(false); }
  }, [permitted, hotelUid, current]);
  useEffect(() => {
    if (!open || !permitted) return;
    loadAvailability();
    let jobId; try { jobId = JSON.parse(sessionStorage.getItem(storageKey) || "null")?.jobId; } catch { /* Invalid local reference is ignored. */ }
    if (!jobId || job) return;
    const captured = generation.current; setResuming(true);
    getSupplierAiImport(hotelUid, jobId).then((value) => { if (current() && captured === generation.current) { generation.current += 1; setJob(value); setSupplierId(value.supplierId); setResuming(false); } }).catch((failure) => { if (current() && captured === generation.current) { setError(failure); try { sessionStorage.removeItem(storageKey); } catch { /* Optional browser storage. */ } } }).finally(() => { if (current() && (captured === generation.current || latestJob.current?.jobId === jobId)) setResuming(false); });
  }, [open, permitted, loadAvailability, hotelUid, storageKey, current]); // Job is resumed only when this view opens.
  const refreshJob = useCallback(async () => {
    if (!job?.jobId || !current()) return;
    const captured = { jobId: job.jobId, generation: generation.current, request: ++jobRequests.current };
    const active = () => current() && generation.current === captured.generation && latestJob.current?.jobId === captured.jobId && jobRequests.current === captured.request;
    try { const value = await getSupplierAiImport(hotelUid, captured.jobId); if (active()) { setJob(value); setPollError(null); } }
    catch (failure) { if (active()) {
      setPollError(failure);
      if (["not-found", "failed-precondition"].includes(String(failure.code || "").replace(/^functions\//, ""))) {
        setPollError(null);
        setJob((prior) => ({ hotelUid: prior?.hotelUid, jobId: prior?.jobId, status: "expired", error: { message: failure.message } }));
        setRows([]); setSelected({}); setOutcomes([]); pendingCommit.current = null; setUncertainCommit(false);
        try { sessionStorage.removeItem(storageKey); } catch { /* An expired reference contains no source content. */ }
      }
    } }
  }, [job?.jobId, hotelUid, current, storageKey]);
  useEffect(() => {
    if (!job || !processing.has(job.status) || !current()) return;
    const timer = setTimeout(refreshJob, pollError ? 10000 : 3000);
    return () => clearTimeout(timer);
  }, [job, refreshJob, pollError, current]);
  const loadRows = useCallback(async (next = null) => {
    if (!job?.jobId || !current()) return;
    const captured = { jobId: job.jobId, generation: generation.current, request: ++rowRequests.current };
    const active = () => current() && generation.current === captured.generation && latestJob.current?.jobId === captured.jobId && rowRequests.current === captured.request;
    setReviewLoading(true); setError(null);
    try {
      const value = await getSupplierAiImportReview(hotelUid, captured.jobId, next);
      if (!active()) return;
      if (!Array.isArray(value.rows) || !Number.isSafeInteger(value.totalRows) || value.totalRows > 1000) throw new Error("The review response is invalid. Reopen this import.");
      const reviewedRows = value.rows.map((incoming) => {
        const local = latestRows.current.find((entry) => entry.rowId === incoming.rowId);
        return local && (local.reviewRevision > incoming.reviewRevision || (local.reviewRevision === incoming.reviewRevision && local.committed && !incoming.committed)) ? local : incoming;
      });
      setRows(reviewedRows); setTotalRows(value.totalRows); setNextCursor(value.nextCursor || null); setCursor(next);
      setSelected((prior) => Object.fromEntries(Object.entries(prior).filter(([rowId, revision]) => {
        const row = reviewedRows.find((entry) => entry.rowId === rowId);
        return !row || (row.reviewRevision === revision && !row.committed && row.category !== "blocked" && !(row.issues || []).some((issue) => issue.severity === "error"));
      })));
    } catch (failure) { if (active()) setError(failure); }
    finally { if (active()) setReviewLoading(false); }
  }, [hotelUid, job?.jobId, current]);
  useEffect(() => { if (job && reviewable.has(job.status) && lastReviewJob.current !== job.jobId) { lastReviewJob.current = job.jobId; loadRows(null); } }, [job, loadRows]);
  const chooseFile = (event) => {
    const chosen = event.target.files?.[0];
    if (busy || uncertainUpload || !current()) return;
    setError(null);
    try { validateSupplierAiImportFile(chosen); setFile(chosen); }
    catch (failure) { event.target.value = ""; setFile(null); setError(failure); }
  };
  const start = async () => {
    if (!file || !supplierId || busy || resuming || !permitted || !availability?.available || !current()) return;
    const captured = ++generation.current;
    setBusy(true); setError(null);
    try {
      const value = await startSupplierAiImport(hotelUid, supplierId, file);
      if (!current() || captured !== generation.current) return;
      setJob(value); remember(value); setUncertainUpload(false); setFile(null);
    } catch (failure) {
      if (!current()) return;
      setError(failure);
      setUncertainUpload(!["invalid-argument", "permission-denied", "unauthenticated", "failed-precondition", "resource-exhausted", "already-exists", "not-found"].includes(String(failure.code || "").replace(/^functions\//, "")));
    } finally { if (current()) setBusy(false); }
  };
  const select = (rowId, checked, reviewRevision) => setSelected((prior) => { const next = { ...prior }; if (checked) next[rowId] = reviewRevision; else delete next[rowId]; return next; });
  const corrected = (row) => { if (!current() || generation.current !== renderedGeneration || latestJob.current?.jobId !== job?.jobId || !row?.rowId) return; setRows((prior) => prior.map((value) => value.rowId === row.rowId ? row : value)); select(row.rowId, false); };
  const confirm = async () => {
    if (busy || !current() || !job || !permitted) return;
    const commandRows = pendingCommit.current || Object.entries(selected).map(([rowId, reviewRevision]) => ({ rowId, reviewRevision, acknowledged: true }));
    if (!commandRows.length) return;
    pendingCommit.current = commandRows; setBusy(true); setError(null);
    try {
      const result = await confirmSupplierAiImport(hotelUid, job.jobId, commandRows);
      if (!current()) return;
      setOutcomes(result.outcomes); setUncertainCommit(false); pendingCommit.current = null; setSelected({});
      await loadRows(cursor); if (current()) { onImported?.(result); await refreshJob(); }
    } catch (failure) { if (current()) { setError(failure); setUncertainCommit(true); } }
    finally { if (current()) setBusy(false); }
  };
  const reset = () => { if (busy || uncertainUpload || uncertainCommit) return; generation.current += 1; rowRequests.current += 1; jobRequests.current += 1; setReviewLoading(false); setResuming(false); setPollError(null); forget(); setJob(null); setRows([]); setSelected({}); setOutcomes([]); setCursor(null); setCursorHistory([null]); setNextCursor(null); lastReviewJob.current = null; setError(null); };
  const limits = availability?.limits || {};
  return <Modal open={open} onClose={onClose} title="AI supplier-product import">
    <div className="min-w-0 space-y-4 [overflow-wrap:anywhere]">
      <p className="text-sm text-stone-600">Convert a supplier document into a draft. Nothing is saved as a product until you review and confirm selected rows. Automatic model fallback is disabled.</p>
      {!permitted && <p role="alert" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">Supplier-product read and create permissions, supplier read access and an active Procurement subscription are required.</p>}
      {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-800">{error.message}</p>}
      {!job && permitted && <>
        {resuming && <p role="status" className="animate-pulse text-sm text-stone-600">Recovering the saved private draft…</p>}
        {availabilityLoading && <p role="status" className="animate-pulse text-sm text-stone-600">Checking hotel import access and budget…</p>}
        {!availabilityLoading && !availability && <button type="button" className="ht-button-secondary" onClick={loadAvailability}>Retry access check</button>}
        {availability && !availability.available && <p role="status" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">AI supplier imports are disabled. Ask the platform operator to enable the global AI import settings.</p>}
        {availability?.available && <>
          <label className="block text-sm font-semibold">Supplier<Combobox aria-label="AI import supplier" disabled={busy || resuming || uncertainUpload} value={suppliers.find((supplier) => supplier.id === supplierId) || null} options={suppliers} displayValue={(supplier) => supplier.name || "Unnamed supplier"} getOptionValue={(supplier) => supplier.id} onChange={(supplier) => setSupplierId(supplier?.id || "")} loading={suppliersLoading} placeholder="Choose this document's supplier" /></label>
          <label className="block text-sm font-semibold">Supplier document<input ref={input} type="file" accept={SUPPLIER_AI_IMPORT_ACCEPT} disabled={busy || resuming || uncertainUpload} onChange={chooseFile} className="mt-2 block max-w-full text-sm" /></label>
          {file && <p className="text-xs text-stone-600">Selected: {file.name} · {(file.size / 1024).toFixed(1)} KiB</p>}
          <p className="text-xs text-stone-500">CSV, XLSX, PDF, DOCX, EML or TXT. Maximum {Math.floor((limits.maxFileBytes || 10485760) / 1048576)} MiB, {limits.maxPages || 50} document pages and {limits.maxProducts || 1000} products. Do not upload guest or personal data. Documents are private and expire automatically.</p>
          {typeof limits.maxCostPerImportUsd === "number" && <p className="text-xs text-stone-500">Maximum AI budget: ${limits.maxCostPerImportUsd.toFixed(2)} per import. Every attempt counts toward this budget.</p>}
          {uncertainUpload && <p className="text-sm text-amber-800">The upload acknowledgement was lost. Retry this same file and supplier to recover the original import; a new run will not be started.</p>}
          <button type="button" disabled={!file || !supplierId || busy || resuming || suppliersLoading} onClick={start} className="ht-button-primary w-full">{busy ? "Uploading document…" : uncertainUpload ? "Recover original upload" : "Prepare AI import review"}</button>
        </>}
      </>}
      {job && <>
        <div role="status" className="rounded-xl border border-brand-200 bg-brand-50 p-3 text-sm"><p className="font-semibold">{statuses[job.status] || `Import status: ${job.status}`}</p><p className="mt-1 text-xs">{job.source?.fileName || "Supplier document"}</p>{processing.has(job.status) && <div aria-hidden="true" className="mt-3 h-1.5 overflow-hidden rounded-full bg-brand-100"><div className="h-full w-1/2 animate-pulse rounded-full bg-brand-700" /></div>}</div>
        {job.expiresAtMillis && <p className="text-xs text-stone-500">Private draft expires {new Date(job.expiresAtMillis).toLocaleString()}. Closing this dialog keeps the import available in this browser session.</p>}
        {job.usage && <p className="text-xs text-stone-600">AI calls: {job.usage.attempts ?? "Unknown"}. Estimated cost: {typeof job.usage.actualCostUsd === "number" ? `$${job.usage.actualCostUsd.toFixed(4)}` : "Unavailable"}{job.usage.unknownCalls > 0 ? " · unresolved provider usage remains reserved" : ""}.</p>}
        {Array.isArray(job.warnings) && job.warnings.map((warning, index) => <p key={index} className="rounded-lg bg-amber-50 p-2 text-xs text-amber-900">{typeof warning === "string" ? warning : warning.message || warning.code || "Document extraction needs review."}</p>)}
        {job.usage && (typeof job.usage.knownCostUsd === "number" || typeof job.usage.reservedCostUsd === "number") && <p className="text-xs text-stone-600">Known cost: {typeof job.usage.knownCostUsd === "number" ? `$${job.usage.knownCostUsd.toFixed(4)}` : "Unavailable"} · Reserved budget: {typeof job.usage.reservedCostUsd === "number" ? `$${job.usage.reservedCostUsd.toFixed(4)}` : "Unavailable"}. Reserved budget is not a confirmed charge.</p>}
        {job.error && <p role="alert" className="text-sm text-red-800">{job.error.message || String(job.error)}</p>}
        {pollError && <p role="alert" className="text-sm text-amber-800">{pollError.message} The original import reference is retained.</p>}
        <button type="button" onClick={refreshJob} disabled={busy} className="ht-button-secondary">Refresh import status</button>
        {reviewable.has(job.status) && <>
          <div className="border-t pt-3"><h2 className="font-semibold">Product review</h2><p className="mt-1 text-xs text-stone-500">{totalRows} rows · {Object.keys(selected).length} selected across review pages. Errors must be corrected; unchanged rows do not rewrite products. Product revisions are checked again on confirmation.</p></div>
          <button type="button" onClick={() => loadRows(cursor)} disabled={busy || reviewLoading || uncertainCommit} className="ht-button-secondary">Refresh review rows</button>
          {reviewLoading ? <p role="status" className="animate-pulse text-sm">Loading review rows…</p> : rows.map((row) => <SupplierAiImportRow key={`${job.jobId}:${row.rowId}`} hotelUid={hotelUid} jobId={job.jobId} row={row} selected={Boolean(selected[row.rowId])} onSelect={select} onCorrected={corrected} locked={busy || uncertainCommit} current={() => current() && generation.current === renderedGeneration && latestJob.current?.jobId === job.jobId} />)}
          {!reviewLoading && !rows.length && <p className="text-sm text-stone-600">No review rows are available.</p>}
          <div className="flex justify-between gap-2"><button type="button" disabled={reviewLoading || busy || uncertainCommit || cursorHistory.length <= 1} onClick={() => { const history = cursorHistory.slice(0, -1); setCursorHistory(history); loadRows(history[history.length - 1]); }} className="ht-button-secondary">Previous rows</button><button type="button" disabled={reviewLoading || busy || uncertainCommit || !nextCursor} onClick={() => { setCursorHistory((history) => [...history, nextCursor]); loadRows(nextCursor); }} className="ht-button-secondary">Next rows</button></div>
          {uncertainCommit && <p className="text-sm text-amber-800">Some writes may already have succeeded. Retry the original selection to recover its saved results. Selection and corrections remain locked until the response is recovered.</p>}
          <button type="button" onClick={confirm} disabled={busy || reviewLoading || (!Object.keys(selected).length && !uncertainCommit)} className="ht-button-primary w-full">{busy ? "Confirming reviewed rows…" : uncertainCommit ? "Recover original confirmation" : `Confirm ${Object.keys(selected).length} reviewed rows`}</button>
        </>}
        {outcomes.length > 0 && <section className="rounded-lg border border-stone-200 bg-stone-50 p-3 text-sm" aria-label="Import results"><h2 className="font-semibold">Confirmed server results</h2><p className="mt-1">{outcomes.filter((row) => row.status === "created").length} created · {outcomes.filter((row) => row.status === "updated").length} updated · {outcomes.filter((row) => row.status === "unchanged").length} unchanged · {outcomes.filter((row) => row.status === "blocked").length} blocked</p>{outcomes.filter((row) => row.status === "blocked").map((row) => <p key={row.rowId} className="mt-2 text-xs text-red-700">{row.rowId}: {row.error?.message || row.error || "This row could not be imported. Recheck the product and its revision."}</p>)}</section>}
        {!processing.has(job.status) && <button type="button" disabled={busy || uncertainUpload || uncertainCommit} onClick={reset} className="ht-button-secondary">Start another document</button>}
      </>}
    </div>
  </Modal>;
}
