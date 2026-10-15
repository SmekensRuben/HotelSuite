import React, { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import PageShell from "../layout/PageShell";
import Modal from "../shared/Modal";
import AsyncError from "../shared/AsyncError";
import ProductProposalReviewRow, { productProposalName } from "../catalog/ProductProposalReviewRow";
import { auth } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { usePermission } from "../../hooks/usePermission";
import { useSupplierProductAuthority } from "../../hooks/useSupplierProductAuthority";
import { useScopedAsync } from "../../hooks/useScopedAsync";
import { listProductProposalBatches, readProductProposalBatch, reviewProductProposals, retryProductProposalReview, getPendingProductProposalReview } from "../../services/firebaseProductProposals";

const statuses = ["all", "ready", "invalid", "unchanged", "conflict", "failed", "applied", "skipped"];
const safeSourceUrl = (value) => { try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) ? url.href : null; } catch { return null; } };

export default function ProductProposalsPage() {
  const authority = useSupplierProductAuthority(), { hotelUid } = useHotelContext(), [params, setParams] = useSearchParams();
  const batchId = params.get("batchId") || null;
  return <ScopedProductProposalsPage key={`${authority}:${batchId || "list"}`} hotelUid={hotelUid} batchId={batchId} openBatch={(value) => setParams(value ? { batchId: value } : {})} />;
}

function ScopedProductProposalsPage({ hotelUid, batchId, openBatch }) {
  const catalogRead = usePermission("catalogproducts", "read"), catalogCreate = usePermission("catalogproducts", "create"), catalogUpdate = usePermission("catalogproducts", "update");
  const supplierRead = usePermission("supplierproducts", "read"), supplierCreate = usePermission("supplierproducts", "create"), supplierUpdate = usePermission("supplierproducts", "update"), suppliersRead = usePermission("suppliers", "read");
  const permitted = Boolean(hotelUid && (catalogRead || supplierRead));
  const [cursor, setCursor] = useState(null), [selection, setSelection] = useState([]), [filter, setFilter] = useState("all"), [error, setError] = useState(null), [busy, setBusy] = useState(false), [notice, setNotice] = useState(""), [pending, setPending] = useState(null), [confirmation, setConfirmation] = useState(null);
  const actor = useRef(auth.currentUser).current, alive = useRef(true), operation = useRef(false);
  const current = useCallback(() => alive.current && auth.currentUser === actor, [actor]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const loadList = useCallback(() => listProductProposalBatches(hotelUid, { cursor, limit: 25 }), [hotelUid, cursor]);
  const list = useScopedAsync({ scopeKey: `${hotelUid}:${cursor || "first"}`, enabled: permitted && !batchId, load: loadList });
  const loadBatch = useCallback(() => readProductProposalBatch(hotelUid, batchId), [hotelUid, batchId]);
  const detail = useScopedAsync({ scopeKey: `${hotelUid}:${batchId}`, enabled: permitted && Boolean(batchId), retainData: true, load: loadBatch });
  useEffect(() => {
    if (!batchId || !permitted) return;
    try { setPending(getPendingProductProposalReview(hotelUid, batchId)); } catch (failure) { setError(failure); }
  }, [hotelUid, batchId, permitted, detail.data]);
  const batch = detail.data, rows = batch?.rows || [];
  const canEdit = (row) => row.kind === "catalog" ? catalogRead && (row.action === "create" ? catalogCreate : catalogUpdate) : supplierRead && (row.action === "create" ? supplierCreate : supplierUpdate);
  const eligible = (row, visited = new Set()) => {
    if (!row || visited.has(row.rowId) || !["ready", "unchanged", "failed"].includes(row.status) || row.issues.some((issue) => issue.severity === "error") || !canEdit(row)) return false;
    if (!row.catalogRowId) return true;
    const parent = rows.find((item) => item.rowId === row.catalogRowId);
    return parent?.status === "applied" || eligible(parent, new Set([...visited, row.rowId]));
  };
  const withDependencies = (ids) => {
    const selected = new Set();
    const add = (row) => { if (!eligible(row) || selected.has(row.rowId)) return; selected.add(row.rowId); if (row.catalogRowId) add(rows.find((item) => item.rowId === row.catalogRowId)); };
    ids.forEach((id) => add(rows.find((row) => row.rowId === id)));
    return rows.filter((row) => selected.has(row.rowId)).map((row) => row.rowId);
  };
  const selected = withDependencies(selection), validRows = rows.filter((row) => eligible(row));
  const toggle = (row, checked) => {
    if (checked) setSelection(withDependencies([...selection, row.rowId]));
    else setSelection(selection.filter((id) => id !== row.rowId && rows.find((item) => item.rowId === id)?.catalogRowId !== row.rowId));
  };
  const mutate = async (action, rowIds, corrections, recover = false) => {
    if (!current() || operation.current || !permitted || (!recover && pending)) return false;
    operation.current = true; setBusy(true); setError(null); setNotice("");
    try {
      const result = recover ? await retryProductProposalReview(hotelUid, batchId) : await reviewProductProposals(hotelUid, batchId, { expectedRevision: batch.revision, action, rowIds, ...(corrections ? { corrections } : {}) });
      if (!current()) return false;
      detail.setData(result); setSelection([]); setConfirmation(null); setPending(getPendingProductProposalReview(hotelUid, batchId));
      setNotice(result.processing || result.status === "processing" ? "Approval is still in progress. Resume the original request to verify the remaining results." : action === "correct" ? "Correction saved. Review the updated validation before approval." : action === "skip" ? "Proposal skipped. Active products were unchanged." : "Review results saved. Applied rows are retained; inspect any remaining exceptions before continuing.");
      return true;
    } catch (failure) {
      if (current()) {
        setError(failure); setConfirmation(null);
        try { setPending(getPendingProductProposalReview(hotelUid, batchId)); } catch (recoveryFailure) { setError(recoveryFailure); }
        if (failure.details?.productProposalRequestUncommitted === true) { setSelection([]); await detail.retry(); }
      }
      return false;
    } finally { if (current()) { operation.current = false; setBusy(false); } }
  };
  const confirm = (ids) => {
    const rowIds = withDependencies(ids);
    if (!busy && !pending && rowIds.length) setConfirmation({ rowIds, revision: batch.revision });
  };
  const visibleRows = rows.filter((row) => filter === "all" || row.status === filter);
  const loading = batchId ? detail.loading : list.loading;
  const locked = busy || loading || Boolean(pending) || Boolean(batch?.processing);
  return <PageShell variant="procurement" className="space-y-5">
    <header className="flex flex-wrap items-start justify-between gap-3"><div><Link to={catalogRead ? "/catalog/products" : "/catalog/supplier-products"} className="text-sm text-stone-500">{catalogRead ? "← Catalog Products" : "← Supplier Products"}</Link><h1 className="mt-2 font-display text-3xl text-brand-950">Product proposals</h1><p className="mt-1 max-w-2xl text-sm text-stone-600">Review products prepared by your connected AI client. Nothing becomes an active product until you approve it here.</p></div><button type="button" className="ht-button-secondary" disabled={!permitted || busy || loading || Boolean(pending)} onClick={() => { setSelection([]); (batchId ? detail : list).retry(); }}>Refresh progress</button></header>
    {!permitted && <p role="alert" className="rounded-xl bg-amber-50 p-4 text-sm">Select a hotel with catalog-product or supplier-product read permission to view your private proposal batches.</p>}
    <AsyncError error={error || detail.error || list.error} onRetry={pending ? () => mutate(pending.input.action, [], null, true) : () => (batchId ? detail : list).retry()} label="The product proposal review could not be verified." />
    {notice && <p role="status" className="rounded-xl bg-green-50 p-4 text-sm text-green-950">{notice}</p>}
    {pending && <section aria-label="Recover product review" className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950"><h2 className="font-semibold">The previous review result needs confirmation</h2><p className="mt-1">Recover its original {pending.input.action} request before editing or approving other proposals. Already applied products are reused and cannot be duplicated by this retry.</p><button type="button" className="ht-button-secondary mt-3" disabled={busy} onClick={() => mutate(pending.input.action, [], null, true)}>Retry original review</button></section>}
    {loading && permitted && !(batchId && batch) && <p role="status" className="rounded-xl bg-stone-50 p-5 text-sm">Loading your private product proposals…</p>}
    {!batchId && list.data && <section aria-label="Your proposal batches" className="space-y-3"><p className="text-xs text-stone-500">Only batches requested by your own account in this hotel are shown.</p>{!list.data.batches.length && <p className="rounded-xl bg-white p-5 text-sm text-stone-600">{list.data.nextCursor ? "No accessible proposal batches are shown on this page. Continue to older batches." : "No product proposals are available. Connect your AI client and ask it to prepare a product batch for this hotel."}</p>}{list.data.batches.map((item) => <button type="button" key={item.batchId} className="flex w-full flex-wrap items-center justify-between gap-3 rounded-xl border bg-white p-4 text-left hover:border-brand-300" onClick={() => openBatch(item.batchId)}><div><span className="block font-semibold">{item.source?.label || "Product proposal batch"}</span><span className="mt-1 block text-xs text-stone-500">{item.summary?.total ?? item.rowCount ?? "Unknown"} proposals · {item.summary?.applied || 0} applied · {item.batchId}</span></div><span className="rounded-full bg-stone-100 px-2 py-1 text-xs">{item.status}</span></button>)}<div className="flex gap-2">{cursor && <button type="button" className="ht-button-secondary" disabled={loading} onClick={() => setCursor(null)}>Newest batches</button>}{list.data.nextCursor && <button type="button" className="ht-button-secondary" disabled={loading} onClick={() => setCursor(list.data.nextCursor)}>Older batches</button>}</div></section>}
    {batch && <>
      <button type="button" className="text-sm text-stone-500 underline" disabled={busy} onClick={() => openBatch(null)}>All my proposal batches</button>
      <section aria-label="Proposal batch overview" className="space-y-3 rounded-2xl border bg-white p-4"><div className="flex flex-wrap justify-between gap-2"><h2 className="font-semibold text-brand-950">{batch.source?.label || "Product proposal batch"}</h2><span className="text-xs text-stone-500">{batch.status} · revision {batch.revision}</span></div><p className="text-sm text-stone-600">{rows.length} proposals · {rows.filter((row) => row.status === "applied").length} applied · {rows.filter((row) => row.status === "skipped").length} skipped · {rows.filter((row) => ["invalid", "conflict", "failed"].includes(row.status)).length} exceptions</p>{batch.source?.url && <p className="break-all text-xs text-stone-500">Source: {safeSourceUrl(batch.source.url) ? <a className="underline" href={safeSourceUrl(batch.source.url)} target="_blank" rel="noreferrer">{batch.source.url}</a> : batch.source.url}</p>}{batch.source?.documentDate && <p className="text-xs text-stone-500">Source document date: {batch.source.documentDate}</p>}<p className="text-xs text-stone-500">Approvals check current access and product revisions again. Conflicts and invalid rows remain available for correction. You can return to this batch to resume partial results.</p></section>
      <div className="flex flex-wrap items-center justify-between gap-3"><label className="flex items-center gap-2 text-xs font-semibold">Show<select aria-label="Filter proposals" className="rounded-lg border bg-white px-3 py-2" value={filter} onChange={(event) => setFilter(event.target.value)}>{statuses.map((status) => <option key={status} value={status}>{status === "all" ? "All proposals" : status === "ready" ? "New products and changes" : status.charAt(0).toUpperCase() + status.slice(1)}</option>)}</select></label><div className="flex flex-wrap gap-2"><button type="button" className="ht-button-secondary" disabled={locked || !validRows.length} onClick={() => setSelection(withDependencies(validRows.map((row) => row.rowId)))}>Select valid proposals ({validRows.length})</button>{selection.length > 0 && <button type="button" className="ht-button-secondary" disabled={locked} onClick={() => setSelection([])}>Clear selection</button>}</div></div>
      <div className="space-y-4">{visibleRows.map((row) => <ProductProposalReviewRow key={`${batchId}:${row.rowId}:${batch.revision}`} hotelUid={hotelUid} row={row} rows={rows} checked={selected.includes(row.rowId)} eligible={eligible(row)} canEdit={canEdit(row)} canReadCatalog={catalogRead} canReadSuppliers={suppliersRead} disabled={locked} onSelect={(checked) => toggle(row, checked)} onApprove={() => confirm([row.rowId])} onSkip={() => mutate("skip", [row.rowId])} onCorrect={(correction) => mutate("correct", [row.rowId], [correction])} />)}</div>
      {!visibleRows.length && <p className="rounded-xl bg-stone-50 p-5 text-sm text-stone-600">No proposals match this view.</p>}
      <footer className="sticky bottom-3 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-brand-100 bg-brand-50 p-4 shadow-sm"><p className="text-sm font-semibold">{selected.length} valid proposals selected</p><button type="button" className="ht-button-primary" disabled={locked || !selected.length} onClick={() => confirm(selected)}>Review approval ({selected.length})</button></footer>
    </>}
    <Modal open={Boolean(confirmation)} onClose={() => { if (!busy) setConfirmation(null); }} title="Approve product proposals"><p className="text-sm text-stone-600">Apply {confirmation?.rowIds.length || 0} reviewed proposals to active products in this hotel. Catalog dependencies are applied first and their real product IDs are reused for supplier links.</p><ul className="mt-3 max-h-48 space-y-1 overflow-y-auto text-xs text-stone-600">{confirmation?.rowIds.map((id) => <li key={id}>{productProposalName(rows.find((row) => row.rowId === id))}</li>)}</ul><p className="mt-3 text-xs text-stone-500">Existing orders, receipts and stock-count snapshots keep their recorded values. Any rejected rows remain available with their individual result.</p><div className="mt-5 flex justify-end gap-2"><button type="button" className="ht-button-secondary" disabled={busy} onClick={() => setConfirmation(null)}>Cancel</button><button type="button" className="ht-button-primary" disabled={busy || !confirmation || batch?.revision !== confirmation.revision} onClick={() => mutate("approve", confirmation.rowIds)}>{busy ? "Applying…" : "Confirm approval"}</button></div></Modal>
  </PageShell>;
}
