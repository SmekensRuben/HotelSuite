import React, { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import PageShell from "../layout/PageShell";
import Modal from "../shared/Modal";
import AsyncError from "../shared/AsyncError";
import SupplierImportProductReview from "../catalog/SupplierImportProductReview";
import SupplierImportMappingsPanel from "../catalog/SupplierImportMappingsPanel";
import { auth } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { usePermission } from "../../hooks/usePermission";
import { useSupplierProductAuthority } from "../../hooks/useSupplierProductAuthority";
import { useSupplierAiImportProgress } from "../../contexts/SupplierAiImportProgressContext";
import { getSupplierAiImport, confirmSupplierAiImport, getPendingSupplierAiImportCommit } from "../../services/firebaseSupplierAiImports";
import { readSupplierImportWorkspace, decideSupplierImportRows, completeSupplierImportReview } from "../../services/firebaseSupplierImportWorkspace";
import { filterSupplierImportIndex } from "../../utils/supplierImportWorkspace";

const filters = [["all", "All products"], ["attention", "Needs attention"], ["pending", "Awaiting review"], ["approved", "Approved"], ["skipped", "Skipped"], ["applied", "Imported"]];
const applied = (row) => ["created", "updated", "unchanged"].includes(row.committedStatus);
const categoryLabel = (value) => ({ new: "New product", changed: "Proposed update", unchanged: "Unchanged", blocked: "Needs correction" })[value] || "Review";
const statusLabel = (row) => applied(row) ? "Imported" : row.committedStatus === "blocked" ? "Import needs correction" : ({ pending: "Awaiting review", approved: "Approved", skipped: "Skipped" })[row.reviewStatus] || "Awaiting review";
const uncertain = (error) => !["invalid-argument", "permission-denied", "unauthenticated", "not-found", "already-exists", "failed-precondition", "resource-exhausted", "aborted"].includes(String(error?.code || "").replace(/^functions\//, ""));

export default function SupplierAiImportReviewPage() {
  const { jobId } = useParams(), { hotelUid } = useHotelContext(), authority = useSupplierProductAuthority();
  return <ScopedSupplierAiImportReviewPage key={`${authority}:${jobId}`} hotelUid={hotelUid} jobId={jobId} />;
}
function ScopedSupplierAiImportReviewPage({ hotelUid, jobId }) {
  const progress = useSupplierAiImportProgress();
  const canRead = usePermission("supplierproducts", "read"), canCreate = usePermission("supplierproducts", "create"), canUpdate = usePermission("supplierproducts", "update"), canReadSuppliers = usePermission("suppliers", "read");
  const permitted = Boolean(hotelUid && jobId && canRead && canReadSuppliers && canCreate);
  const actor = useRef(auth.currentUser).current, alive = useRef(true), sequence = useRef(0), latestWorkspace = useRef(null), latestFocus = useRef(null);
  const current = useCallback(() => alive.current && auth.currentUser === actor, [actor]);
  const [job, setJob] = useState(null), [workspace, setWorkspace] = useState(null), [loading, setLoading] = useState(true), [error, setError] = useState(null), [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("all"), [search, setSearch] = useState(""), [page, setPage] = useState(0), [selected, setSelected] = useState({});
  const [reviewMode, setReviewMode] = useState("attention"), [focus, setFocus] = useState(null), [focusLoading, setFocusLoading] = useState(false), [notice, setNotice] = useState("");
  const recoveryAtMount = useRef(null);
  if (recoveryAtMount.current === null) {
    try { recoveryAtMount.current = { pending: getPendingSupplierAiImportCommit(hotelUid, jobId), error: null }; }
    catch (failure) { recoveryAtMount.current = { pending: null, error: failure }; }
  }
  const [confirmation, setConfirmation] = useState(false), [pendingCommit, setPendingCommit] = useState(recoveryAtMount.current.pending), [outcomes, setOutcomes] = useState([]), [recoveryError, setRecoveryError] = useState(recoveryAtMount.current.error);
  const pendingDecision = useRef(null), commitRows = useRef(null), operation = useRef(false), rowRequests = useRef(0);
  latestWorkspace.current = workspace; latestFocus.current = focus;
  useEffect(() => { alive.current = true; return () => { alive.current = false; sequence.current += 1; rowRequests.current += 1; }; }, []);
  const load = useCallback(async ({ focusRowId = null } = {}) => {
    if (!current() || !permitted) return null;
    const request = ++sequence.current; rowRequests.current += 1; setFocusLoading(false); setLoading(true); setError(null);
    try {
      const nextJob = await getSupplierAiImport(hotelUid, jobId);
      if (!current() || sequence.current !== request) return null;
      setJob(nextJob); progress?.updateJob?.(nextJob);
      if (!["review", "partially_committed", "completed"].includes(nextJob.status)) { setWorkspace(null); setFocus(null); return null; }
      const value = await readSupplierImportWorkspace(hotelUid, jobId, { includeIndex: true, ...(focusRowId ? { focusRowId } : {}) });
      if (!current() || sequence.current !== request) return null;
      setWorkspace(value);
      setSelected((prior) => Object.fromEntries(Object.entries(prior).filter(([rowId, revision]) => value.index?.some((row) => row.rowId === rowId && row.reviewRevision === revision && row.bulkEligible && row.reviewStatus === "pending" && !applied(row)))));
      if (focusRowId) setFocus(value.rows.find((row) => row.rowId === focusRowId) || null);
      try { setPendingCommit(getPendingSupplierAiImportCommit(hotelUid, jobId)); setRecoveryError(null); }
      catch (failure) { setRecoveryError(failure); }
      return value;
    } catch (failure) { if (current() && sequence.current === request) { setError(failure); setWorkspace(null); setFocus(null); } return null; }
    finally { if (current() && sequence.current === request) setLoading(false); }
  }, [current, hotelUid, jobId, permitted]);
  useEffect(() => { if (permitted) load(); else setLoading(false); }, [permitted, load]);
  useEffect(() => {
    if (!job || !["queued", "processing", "uploading"].includes(job.status) || !permitted) return;
    const timer = setTimeout(() => load(), 4000);
    return () => clearTimeout(timer);
  }, [job, permitted, load]);
  useEffect(() => { setPage(0); setSelected({}); }, [filter, search]);
  const index = workspace?.index || [], visible = filterSupplierImportIndex(index, filter, search), pageRows = visible.slice(page * 25, page * 25 + 25);
  const canHandle = (row) => row.requiresUpdate === true || (row.requiresUpdate === undefined && ["changed", "unchanged"].includes(row.category)) ? canUpdate : canCreate;
  const reviewQueue = (value = latestWorkspace.current, mode = reviewMode) => filterSupplierImportIndex(value?.index || [], mode === "attention" ? "attention" : "all").filter((row) => row.reviewStatus === "pending" && !applied(row) && canHandle(row));
  const openRow = async (rowId) => {
    if (!current() || busy || operation.current || pendingDecision.current || pendingCommit || recoveryError) return;
    const request = ++rowRequests.current; sequence.current += 1; setLoading(false); setFocusLoading(true); setError(null); setFocus(null);
    try {
      const value = await readSupplierImportWorkspace(hotelUid, jobId, { focusRowId: rowId, includeIndex: true });
      if (!current() || rowRequests.current !== request) return;
      setWorkspace(value); setFocus(value.rows.find((row) => row.rowId === rowId) || null);
    } catch (failure) { if (current() && rowRequests.current === request) setError(failure); }
    finally { if (current() && rowRequests.current === request) setFocusLoading(false); }
  };
  const advance = async (rowId, value) => {
    const all = value?.index || [], oldPosition = all.findIndex((row) => row.rowId === rowId), queue = reviewQueue(value);
    const next = queue.find((row) => all.findIndex((entry) => entry.rowId === row.rowId) > oldPosition) || queue.find((row) => row.rowId !== rowId);
    if (!next) { setFocus(null); setNotice("This review queue is complete. Your decisions are saved; products are changed only when you import approved products."); return; }
    // openRow cannot be called while the current decision still owns the lock.
    const reviewed = await readSupplierImportWorkspace(hotelUid, jobId, { focusRowId: next.rowId, includeIndex: true });
    if (current()) { setWorkspace(reviewed); setFocus(reviewed.rows.find((row) => row.rowId === next.rowId) || null); }
  };
  const decide = async (rows, action, bulk = false) => {
    if (!current() || operation.current || pendingCommit || recoveryError) return;
    const command = pendingDecision.current || { rows: rows.map((row) => ({ rowId: row.rowId, reviewRevision: row.reviewRevision, action, acknowledged: true })), bulk, rowId: bulk ? null : rows[0]?.rowId };
    pendingDecision.current = command; operation.current = true; setBusy(true); setError(null); setNotice("");
    try {
      for (let offset = command.offset || 0; offset < command.rows.length; offset += 25) {
        await decideSupplierImportRows(hotelUid, jobId, command.rows.slice(offset, offset + 25), { bulk: command.bulk });
        if (!current()) return;
        command.offset = offset + 25;
      }
      pendingDecision.current = null; setSelected({});
      const value = await load();
      if (!current()) return;
      if (command.rowId && value) await advance(command.rowId, value);
      else setNotice("The selected products are approved. No supplier products have been changed yet.");
    } catch (failure) {
      if (current()) { setError(failure); if (!uncertain(failure)) { pendingDecision.current = null; await load({ focusRowId: command.rowId }); setError(failure); } }
    } finally { if (current()) { operation.current = false; setBusy(false); } }
  };
  const corrected = async (row) => { setSelected({}); const value = await load({ focusRowId: row.rowId }); return value?.rows.find((entry) => entry.rowId === row.rowId) || row; };
  const later = async (row) => { if (!current() || busy || operation.current) return; operation.current = true; setBusy(true); setError(null); try { const value = await load(); if (value && current()) await advance(row.rowId, value); } catch (failure) { if (current()) setError(failure); } finally { if (current()) { operation.current = false; setBusy(false); } } };
  const approved = index.filter((row) => row.reviewStatus === "approved" && !applied(row) && canHandle(row));
  const canFinish = workspace?.status !== "completed" && workspace?.reviewCounts?.pending === 0 && workspace?.reviewCounts?.approved === 0 && (workspace?.reviewCounts?.skipped || 0) + (workspace?.reviewCounts?.applied || 0) === workspace?.totalRows;
  const beginCommit = () => {
    if (!current() || busy || !workspace?.index || recoveryError) return;
    try { const recovered = getPendingSupplierAiImportCommit(hotelUid, jobId); commitRows.current = recovered?.rows || approved.map(({ rowId, reviewRevision }) => ({ rowId, reviewRevision, acknowledged: true })); if (commitRows.current.length || canFinish) setConfirmation(true); }
    catch (failure) { setRecoveryError(failure); }
  };
  const commit = async () => {
    if (!current() || operation.current || !commitRows.current || (!commitRows.current.length && !canFinish)) return;
    operation.current = true; setBusy(true); setError(null); setNotice(""); setConfirmation(false);
    try {
      const hadProducts = commitRows.current.length > 0;
      if (hadProducts) {
        const result = await confirmSupplierAiImport(hotelUid, jobId, commitRows.current);
        if (!current()) return;
        setOutcomes(result.outcomes); setPendingCommit(null);
      }
      commitRows.current = null;
      const completion = await completeSupplierImportReview(hotelUid, jobId);
      if (!current()) return;
      await load(); setFocus(null); setNotice(hadProducts ? "Approved products were processed. Check the result below; any remaining products can still be reviewed." : completion.completed ? "This review is complete. Every product was already imported or explicitly skipped; this final check changed no supplier products." : "The review is still open. Check the remaining products before finishing.");
    } catch (failure) { if (current()) { setError(failure); try { setPendingCommit(getPendingSupplierAiImportCommit(hotelUid, jobId)); } catch (recoveryFailure) { setRecoveryError(recoveryFailure); } if (!uncertain(failure)) { await load(); setError(failure); } } }
    finally { if (current()) { operation.current = false; setBusy(false); } }
  };
  const mappingBusy = (value) => { operation.current = value; setBusy(value); };
  const counts = workspace?.counts, reviewCounts = workspace?.reviewCounts;
  const focusedIndex = index.findIndex((row) => row.rowId === focus?.rowId);
  return <PageShell variant="procurement" className="space-y-5">
    <header className="flex flex-wrap items-start justify-between gap-4"><div><Link to="/catalog/supplier-products" className="text-sm text-stone-500 hover:text-brand-800">← Supplier products</Link><h1 className="mt-2 font-display text-3xl tracking-tight text-brand-950">Review supplier import</h1><p className="mt-1 text-sm text-stone-600">{job?.source?.fileName || "Supplier document"} · Review decisions are saved. Approving prepares a change; importing applies it.</p></div><button type="button" className="ht-button-secondary" disabled={busy || loading || !permitted || Boolean(pendingDecision.current)} onClick={() => load({ focusRowId: focus?.rowId })}>Refresh</button></header>
    {!permitted && <p role="alert" className="rounded-xl bg-amber-50 p-4 text-sm text-amber-900">Select a hotel with supplier-product access to review this import.</p>}
    <AsyncError error={error} onRetry={pendingDecision.current ? () => decide([], "approve") : pendingCommit ? beginCommit : () => load({ focusRowId: focus?.rowId })} label={pendingDecision.current || pendingCommit ? "The previous operation could not be confirmed. Retry the same operation." : "Could not verify this import."} />
    <AsyncError error={recoveryError} label="The original import confirmation reference is unavailable. Ask your hotel administrator to verify this draft before making further changes." />
    {notice && <p role="status" className="rounded-xl border border-green-100 bg-green-50 p-4 text-sm text-green-900">{notice}</p>}
    {loading && !workspace && permitted && <div role="status" className="space-y-3 rounded-2xl border bg-white p-5"><span className="text-sm text-stone-500">Preparing the saved import review…</span><div className="h-16 animate-pulse rounded-xl bg-stone-100" /><div className="h-32 animate-pulse rounded-xl bg-stone-100" /></div>}
    {job && !workspace && !loading && !error && <section className="ht-panel p-5"><h2 className="font-semibold">{["queued", "processing", "uploading"].includes(job.status) ? "Your import is still processing" : job.status === "expired" ? "This draft has expired" : "Import status"}</h2><p className="mt-2 text-sm text-stone-600">{["queued", "processing", "uploading"].includes(job.status) ? "Processing continues when you leave this page. The review becomes available when the document is ready." : job.error?.message || "There are no products ready for review. Start a new document if necessary."}</p></section>}
    {workspace && <>
      <section aria-label="Import overview" className="rounded-2xl border border-stone-200 bg-white p-4 sm:p-5"><div className="flex flex-wrap items-baseline justify-between gap-2"><h2 className="font-semibold text-brand-950">{workspace.totalRows} extracted products</h2><span className="text-xs text-stone-500">Totals cover the complete document</span></div>
        {counts ? <dl className="mt-4 grid grid-cols-3 gap-2 sm:gap-4">{[["new", "New products"], ["changed", "Proposed updates"], ["unchanged", "Unchanged"]].map(([key, label]) => <div key={key} className="rounded-xl bg-stone-50 p-3"><dt className="text-xs text-stone-600">{label}</dt><dd className="mt-1 text-2xl font-semibold tabular-nums text-brand-950">{counts[key]}</dd></div>)}</dl> : <p className="mt-3 text-sm text-stone-600">Product classifications are unavailable. Refresh to verify the complete document.</p>}
        <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-sm text-stone-600"><span>Needs attention: <strong>{workspace.index ? index.filter((row) => row.needsAttention && !applied(row) && row.reviewStatus !== "skipped").length : "Unavailable"}</strong></span><span>Approved: <strong>{reviewCounts?.approved ?? "Unavailable"}</strong></span><span>Skipped: <strong>{reviewCounts?.skipped ?? "Unavailable"}</strong></span><span>Imported: <strong>{reviewCounts?.applied ?? "Unavailable"}</strong></span></div>
        {workspace.summary?.unknownPriceRows > 0 && <p className="mt-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-950">Purchase prices are unknown for {workspace.summary.unknownPriceRows} products. Review these offers as inactive concepts or supply a reliable purchase price. Document totals and annual spending are not current purchase prices.</p>}
        {workspace.summary && <details className="mt-3 text-sm"><summary className="cursor-pointer font-medium text-stone-600">Document findings</summary><ul className="mt-3 space-y-2 text-xs text-stone-700">{workspace.summary.findings.map((finding) => <li key={`${finding.field}:${finding.code}:${finding.severity}`} className="rounded-lg bg-stone-50 p-2"><strong>{finding.count} products:</strong> {finding.message}</li>)}</ul></details>}
        {!workspace.summary && <p className="mt-3 text-xs text-stone-500">A document-wide findings overview is unavailable for this draft. Each product retains its individual source and validation checks.</p>}
      </section>
      {!pendingCommit && !recoveryError && <SupplierImportMappingsPanel key={`${hotelUid}:${jobId}`} hotelUid={hotelUid} jobId={jobId} supplierId={workspace.supplierId} sourceFormat={workspace.sourceFormat} profileId={workspace.profileId} groups={workspace.mappingGroups} truncated={workspace.mappingGroupsTruncated} current={current} locked={busy || Boolean(pendingDecision.current)} onBusyChange={mappingBusy} onApplied={() => load({ focusRowId: focus?.rowId })} />}
      <Link className="text-sm font-medium text-brand-800 underline" to={`/settings/procurement?section=supplier-imports&supplier=${encodeURIComponent(workspace.supplierId)}&format=${encodeURIComponent(workspace.sourceFormat || "xlsx")}`}>Manage supplier import mappings</Link>
      {pendingCommit && <section className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950"><p className="font-semibold">A previous import confirmation is awaiting verification</p><p className="mt-1">Recover the same {pendingCommit.rows.length} approved products before changing this draft. Replaying the original confirmation checks its saved receipts.</p><button type="button" className="ht-button-secondary mt-3" disabled={busy} onClick={beginCommit}>Recover original confirmation</button></section>}
      <section aria-label="Product review queue" className="space-y-4 rounded-2xl border border-stone-200 bg-white p-4 sm:p-5"><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-semibold text-brand-950">Product review</h2><p className="mt-1 text-sm text-stone-600">Focus on exceptions, or check every product. Only warning-free eligible selections can be approved together.</p></div><div className="flex flex-wrap gap-2"><select aria-label="Guided review mode" value={reviewMode} onChange={(event) => setReviewMode(event.target.value)} disabled={busy || Boolean(pendingCommit) || Boolean(pendingDecision.current)} className="rounded-lg border bg-white px-3 py-2 text-sm"><option value="attention">Review items needing attention</option><option value="all">Review all</option></select><button type="button" className="ht-button-secondary" disabled={busy || !workspace.index || !reviewQueue().length || Boolean(pendingCommit) || Boolean(pendingDecision.current)} onClick={() => openRow(reviewQueue()[0].rowId)}>Start review</button></div></div>
        {focusLoading && <div role="status" className="animate-pulse rounded-xl bg-stone-50 p-5 text-sm text-stone-500">Opening the product and its source…</div>}
        {focus && <SupplierImportProductReview key={focus.rowId} hotelUid={hotelUid} jobId={jobId} row={focus} position={focusedIndex + 1} total={workspace.totalRows} locked={busy || Boolean(pendingCommit) || Boolean(pendingDecision.current) || Boolean(recoveryError)} current={current} onCorrected={corrected} onApprove={(row) => decide([row], "approve")} onSkip={(row) => decide([row], "skip")} onLater={later} />}
        <div className="flex flex-wrap gap-3"><input aria-label="Search imported products" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search product or supplier SKU" className="min-w-0 flex-1 rounded-lg border px-3 py-2 text-sm" /><select aria-label="Filter imported products" value={filter} onChange={(event) => setFilter(event.target.value)} className="rounded-lg border bg-white px-3 py-2 text-sm">{filters.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></div>
        {!workspace.index ? <p role="status" className="text-sm text-stone-500">The complete product list is unavailable. Refresh to restore the review queue; loaded rows cannot establish whole-document counts.</p> : <>
          <div className="overflow-x-auto"><table className="w-full min-w-[520px] text-left text-sm"><thead className="border-b text-xs text-stone-500"><tr><th className="relative w-9 px-2 py-3"><span className="sr-only">Select eligible products</span></th><th className="px-2 py-3">Product</th><th className="px-2 py-3">Proposal</th><th className="px-2 py-3">Review status</th><th className="relative px-2 py-3"><span className="sr-only">Review product</span></th></tr></thead><tbody>{pageRows.map((row) => <tr key={row.rowId} className="border-b border-stone-100"><td className="px-2 py-3"><input type="checkbox" aria-label={`Select ${row.name}`} checked={selected[row.rowId] === row.reviewRevision} disabled={busy || Boolean(pendingCommit) || Boolean(pendingDecision.current) || !row.bulkEligible || row.reviewStatus !== "pending" || applied(row) || !canHandle(row)} onChange={(event) => setSelected((prior) => event.target.checked ? { ...prior, [row.rowId]: row.reviewRevision } : Object.fromEntries(Object.entries(prior).filter(([id]) => id !== row.rowId)))} /></td><td className="max-w-xs px-2 py-3"><p className="font-medium text-brand-950">{row.name}</p><p className="mt-1 text-xs text-stone-500">{row.sku || "SKU missing"}{row.needsAttention && " · Needs attention"}</p></td><td className="px-2 py-3 text-xs text-stone-600">{categoryLabel(row.category)}</td><td className="px-2 py-3 text-xs text-stone-600">{statusLabel(row)}</td><td className="px-2 py-3"><button type="button" className="text-xs font-medium text-brand-800 underline" disabled={busy || Boolean(pendingCommit) || Boolean(pendingDecision.current)} onClick={() => openRow(row.rowId)}>Review</button></td></tr>)}</tbody></table></div>
          {!pageRows.length && <p className="py-3 text-sm text-stone-500">No products match this view.</p>}
          <div className="flex flex-wrap items-center justify-between gap-3"><span className="text-xs text-stone-500">{visible.length ? `${page * 25 + 1}–${Math.min((page + 1) * 25, visible.length)} of ${visible.length}` : "0 products"}</span><div className="flex gap-2"><button type="button" className="ht-button-secondary" disabled={page === 0} onClick={() => setPage((prior) => prior - 1)}>Previous</button><button type="button" className="ht-button-secondary" disabled={(page + 1) * 25 >= visible.length} onClick={() => setPage((prior) => prior + 1)}>Next</button></div></div>
          {Object.keys(selected).length > 0 && <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-brand-50 p-3"><span className="text-sm">{Object.keys(selected).length} warning-free products selected</span><button type="button" className="ht-button-secondary" disabled={busy || Boolean(pendingCommit) || Boolean(pendingDecision.current)} onClick={() => decide(index.filter((row) => selected[row.rowId] === row.reviewRevision && row.bulkEligible && row.reviewStatus === "pending"), "approve", true)}>Approve selected ({Object.keys(selected).length})</button></div>}
        </>}
      </section>
      {outcomes.length > 0 && <section aria-label="Import result" className="rounded-xl border border-stone-200 bg-white p-4"><h2 className="font-semibold">Latest import result</h2><p className="mt-2 text-sm text-stone-600">{outcomes.filter((row) => row.status === "created").length} created · {outcomes.filter((row) => row.status === "updated").length} updated · {outcomes.filter((row) => row.status === "unchanged").length} unchanged · {outcomes.filter((row) => row.status === "blocked").length} need correction</p>{outcomes.some((row) => row.status === "blocked") && <p className="mt-2 text-sm text-amber-900">Blocked products were not changed. Open them in the review queue and check their source and current supplier-product values.</p>}</section>}
      <footer className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-brand-100 bg-brand-50 p-4 sm:p-5"><div><p className="font-semibold text-brand-950">{workspace.status === "completed" ? "Import review complete" : `${pendingCommit?.rows.length ?? approved.length} approved products ready`}</p><p className="mt-1 text-xs text-stone-600">{reviewCounts?.pending ?? "Unknown"} awaiting review · {reviewCounts?.skipped ?? "Unknown"} skipped. Your saved decisions can be resumed while this private draft is retained.</p></div><button type="button" className="ht-button-primary" disabled={busy || loading || !workspace.index || Boolean(pendingDecision.current) || Boolean(recoveryError) || (!approved.length && !pendingCommit && !canFinish)} onClick={beginCommit}>{busy ? "Processing…" : pendingCommit ? "Recover original confirmation" : canFinish ? "Finish review" : "Import approved products"}</button></footer>
    </>}
    <Modal open={confirmation} onClose={() => { if (!busy) setConfirmation(false); }} title={pendingCommit ? "Recover import confirmation" : canFinish ? "Finish review" : "Import approved products"}><p className="text-sm text-stone-600">{pendingCommit ? "Verify the original confirmation using its saved operation references. Already applied products will not be imported twice." : canFinish ? "Finish this saved review. Every product was already imported or explicitly skipped, so this final check changes no supplier products." : `Apply ${commitRows.current?.length || 0} explicitly approved products to this hotel's supplier catalog. Pending and skipped products are excluded.`}</p><p className="mt-3 text-xs text-stone-500">Package and price changes are checked again against the current catalog before they are applied.</p><div className="mt-5 flex flex-wrap justify-end gap-2"><button type="button" className="ht-button-secondary" onClick={() => setConfirmation(false)}>Cancel</button><button type="button" className="ht-button-primary" disabled={busy} onClick={commit}>{pendingCommit ? "Verify original confirmation" : canFinish ? "Confirm finish" : "Confirm import"}</button></div></Modal>
  </PageShell>;
}
