import React, { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import PageShell from "../layout/PageShell";
import Modal from "../shared/Modal";
import AsyncError from "../shared/AsyncError";
import CatalogSyncReviewRow from "../catalog/CatalogSyncReviewRow";
import { auth } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { usePermission } from "../../hooks/usePermission";
import { useSupplierProductAuthority } from "../../hooks/useSupplierProductAuthority";
import { readCatalogSyncWorkspace, getCatalogSyncRecovery, getPendingCatalogSyncApply, applyCatalogSync, retryCatalogSyncApply, getPendingCatalogSyncRefinement, refineCatalogSyncSuggestions, retryCatalogSyncRefinement } from "../../services/firebaseCatalogSync";

export default function CatalogSyncPage() {
  const [params] = useSearchParams(), authority = useSupplierProductAuthority(), { hotelUid } = useHotelContext();
  const supplierId = params.get("supplierId") || null;
  return <ScopedCatalogSyncPage key={`${authority}:${supplierId || "all"}`} hotelUid={hotelUid} supplierId={supplierId} />;
}
function ScopedCatalogSyncPage({ hotelUid, supplierId }) {
  const canReadCatalog = usePermission("catalogproducts", "read"), canReadOffers = usePermission("supplierproducts", "read"), canUpdateOffers = usePermission("supplierproducts", "update"), canCreate = usePermission("catalogproducts", "create");
  const canReadSuppliers = usePermission("suppliers", "read");
  const permitted = Boolean(hotelUid && canReadSuppliers && canReadCatalog && canReadOffers && canUpdateOffers);
  const actor = useRef(auth.currentUser).current, alive = useRef(true), generation = useRef(0), operation = useRef(false);
  const current = useCallback(() => alive.current && auth.currentUser === actor, [actor]);
  const [workspace, setWorkspace] = useState(null), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState(null), [notice, setNotice] = useState("");
  const [requiresFresh, setRequiresFresh] = useState(false);
  const [choices, setChoices] = useState({}), [drafts, setDrafts] = useState({}), [separate, setSeparate] = useState({}), [skipped, setSkipped] = useState({});
  const [pendingApply, setPendingApply] = useState(null), [pendingAi, setPendingAi] = useState(null), [confirmation, setConfirmation] = useState(false), [outcomes, setOutcomes] = useState([]);
  const confirmedChoices = useRef(null), confirmedJobId = useRef(null);
  const [recoveryJobId, setRecoveryJobId] = useState(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current += 1; }; }, []);
  const recovery = (jobId) => { const saved = getCatalogSyncRecovery(hotelUid, supplierId); setRecoveryJobId(jobId || saved?.jobId || null); if (jobId) setPendingApply(getPendingCatalogSyncApply(hotelUid, jobId)); setPendingAi(getPendingCatalogSyncRefinement(hotelUid, saved?.pendingRefinementJobId || jobId || saved?.jobId)); };
  const load = useCallback(async ({ fresh = false, cursor = null } = {}) => {
    if (!permitted || !current()) return null;
    const request = ++generation.current; setLoading(true); setError(null);
    try {
      const saved = getCatalogSyncRecovery(hotelUid, supplierId);
      if (saved?.jobId) recovery(saved.jobId);
      const result = await readCatalogSyncWorkspace(hotelUid, { supplierId, fresh, cursor });
      if (!current() || generation.current !== request) return null;
      recovery(result.jobId); setWorkspace(result); if (fresh) setRequiresFresh(false); setChoices({}); setSeparate({}); setSkipped({});
      const groupDrafts = {}; for (const row of result.rows) { if (!groupDrafts[row.groupKey] || (!groupDrafts[row.groupKey].baseUnit && row.proposedNewProduct.baseUnit)) groupDrafts[row.groupKey] = row.proposedNewProduct; groupDrafts[row.rowId] = row.proposedNewProduct; } setDrafts(groupDrafts);
      return result;
    } catch (failure) { if (current() && generation.current === request) setError(failure); return null; }
    finally { if (current() && generation.current === request) setLoading(false); }
  }, [hotelUid, supplierId, current, permitted]);
  useEffect(() => { if (permitted) load(); else setLoading(false); }, [load, permitted]);
  const updateDraft = (row, value) => {
    const group = separate[row.rowId] ? row.rowId : row.groupKey; setDrafts((prior) => ({ ...prior, [group]: value }));
    setChoices((prior) => Object.fromEntries(Object.entries(prior).filter(([rowId, choice]) => rowId !== row.rowId && !(choice.target.kind === "new" && choice.target.createGroupId === group))));
  };
  const reviewed = (row, choice) => { if (!current() || busy || pendingApply) return; setChoices((prior) => choice ? { ...prior, [row.rowId]: choice } : Object.fromEntries(Object.entries(prior).filter(([rowId]) => rowId !== row.rowId))); };
  const beginApply = () => { const jobId = pendingApply?.input?.jobId || workspace?.jobId || recoveryJobId; if (!current() || busy || loading || (!pendingApply && requiresFresh) || !jobId) return; confirmedJobId.current = jobId; confirmedChoices.current = pendingApply?.input?.choices || Object.values(choices); if (confirmedChoices.current.length) setConfirmation(true); };
  const apply = async () => {
    if (!current() || operation.current || !confirmedJobId.current || !confirmedChoices.current?.length) return;
    operation.current = true; setBusy(true); setConfirmation(false); setError(null); setNotice("");
    try {
      const jobId = confirmedJobId.current;
      const result = pendingApply ? await retryCatalogSyncApply(hotelUid, jobId) : await applyCatalogSync(hotelUid, jobId, confirmedChoices.current);
      if (!current()) return;
      setOutcomes(result.outcomes.map((outcome) => { const selected = confirmedChoices.current.find((choice) => choice.rowId === outcome.rowId); const source = workspace?.rows.find((row) => row.rowId === outcome.rowId); const catalogName = selected?.target.kind === "new" ? selected.target.product.name : source?.existingMatches.find((match) => match.catalogProductId === outcome.catalogProductId)?.product.name; const created = result.createdCatalogs.find((catalog) => catalog.catalogProductId === outcome.catalogProductId); return { ...outcome, sourceName: source?.supplierProduct.supplierProductName || "Supplier offer", catalogName: catalogName || "Catalog article", internalSku: created?.internalSku || null }; })); setPendingApply(null); confirmedChoices.current = null;
      const refreshed = workspace ? await load() : null; if (!refreshed && current()) { setWorkspace(null); setRequiresFresh(true); } if (current()) setNotice(`${result.outcomes.length} supplier offer${result.outcomes.length === 1 ? "" : "s"} linked. ${result.createdCatalogs.length} catalog article${result.createdCatalogs.length === 1 ? "" : "s"} created. Existing prices, packages and historical records are preserved.`);
    } catch (failure) { if (current()) { setError(failure); try { recovery(confirmedJobId.current); } catch (recoveryFailure) { setError(recoveryFailure); } if (failure.details?.catalogSyncRequestUncommitted === true) { setRequiresFresh(true); setChoices({}); setNotice("No choices in this request were applied. Start a fresh review to check the current offer and catalog revisions."); } } }
    finally { if (current()) { operation.current = false; setBusy(false); } }
  };
  const refine = async (row) => {
    const jobId = pendingAi?.input?.jobId || workspace?.jobId || recoveryJobId;
    if (!current() || operation.current || !jobId || (!pendingAi && !workspace) || pendingApply || (pendingAi && row)) return;
    operation.current = true; setBusy(true); setError(null); setNotice("");
    try {
      const result = pendingAi ? await retryCatalogSyncRefinement(hotelUid, jobId) : await refineCatalogSyncSuggestions(hotelUid, jobId, workspace.revision, [row.rowId]);
      if (!current()) return;
      recovery(workspace?.jobId || recoveryJobId || jobId);
      if (result.status === "ready") { if (workspace?.jobId === jobId) await load(); if (current()) setNotice("AI suggestions are ready. Review their reasoning and physical differences; no links were approved or applied."); }
      else setNotice(result.status === "disabled" ? "AI suggestions are unavailable. Deterministic matching and manual catalog review remain available." : ["processing", "response-unknown"].includes(result.status) ? "The AI suggestion result is not confirmed. Retry its original request before requesting further suggestions. Manual review remains available." : result.message || "No additional suggestions were produced. Continue with manual review.");
    } catch (failure) { if (current()) { setError(failure); try { recovery(workspace?.jobId || recoveryJobId || jobId); } catch (recoveryFailure) { setError(recoveryFailure); } } }
    finally { if (current()) { operation.current = false; setBusy(false); } }
  };
  const remaining = workspace?.rows.filter((row) => !row.applied && !skipped[row.rowId]) || [];
  return <PageShell variant="procurement" className="space-y-5">
    <header className="flex flex-wrap items-start justify-between gap-3"><div><Link to="/catalog/products" className="text-sm text-stone-500">← Catalog Products</Link><h1 className="mt-2 font-display text-3xl text-brand-950">Catalog sync</h1><p className="mt-1 max-w-2xl text-sm text-stone-600">Review unlinked supplier offers against stable physical articles. Choose an existing article or create a reviewed new one, then confirm the selected links.</p></div><button type="button" className="ht-button-secondary" disabled={busy || loading || !permitted} onClick={() => load()}>Refresh review</button></header>
    {!permitted && <p role="alert" className="rounded-xl bg-amber-50 p-4 text-sm text-amber-950">Select a hotel with catalog, supplier and supplier-product read access and supplier-product update permission. Creating new articles additionally requires catalog create permission.</p>}
    <AsyncError error={error} onRetry={pendingApply ? beginApply : pendingAi ? () => refine(null) : () => load()} label={pendingApply ? "The previous apply result could not be confirmed. Recover the same reviewed choices." : "The catalog sync review could not be verified."} />
    {notice && <p role="status" className="rounded-xl bg-green-50 p-4 text-sm text-green-950">{notice}</p>}
    {loading && permitted && !workspace && <p role="status" className="animate-pulse rounded-xl bg-stone-50 p-5 text-sm text-stone-600">Preparing a private catalog review…</p>}
      {pendingApply && <section aria-label="Recover catalog sync" className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950"><p className="font-semibold">An earlier apply request needs reconciliation</p><p className="mt-1">Recover its {pendingApply.input.choices.length} original choices and revisions before editing this review. Replaying the request cannot create duplicate articles.</p><button type="button" className="ht-button-secondary mt-3" disabled={busy} onClick={beginApply}>Recover original catalog sync</button></section>}
      {pendingAi && <section aria-label="Recover optional suggestions" className="rounded-xl bg-stone-50 p-4 text-xs text-stone-700"><p>The earlier optional suggestion request is awaiting confirmation. Manual review remains available; new suggestion requests are paused.</p><button type="button" className="ht-button-secondary mt-2" disabled={busy || Boolean(pendingApply)} onClick={() => refine(null)}>Retry original suggestion request</button></section>}
    {!workspace && recoveryJobId && !loading && <button type="button" className="ht-button-secondary" disabled={busy || Boolean(pendingApply)} onClick={() => load({ fresh: true })}>Start fresh manual review</button>}
    {workspace && <>
      <section aria-label="Catalog sync overview" className="rounded-2xl border bg-white p-4"><p className="font-semibold text-brand-950">{workspace.rows.length} offers in this review · {workspace.rows.filter((row) => row.applied).length} linked · {Object.keys(skipped).length} skipped</p><p className="mt-2 text-xs text-stone-600">Skipping leaves the supplier offer untouched. Only explicitly reviewed choices are applied. Different quality, allergens and incompatible physical units keep separate identities.</p>{!workspace.catalogPool.complete && <p className="mt-2 text-xs text-amber-950">The suggestion pool contains {workspace.catalogPool.count ?? "a bounded number of"} catalog articles. Use catalog search for other matches; absence from suggestions does not establish that an article is new.</p>}<div className="mt-3 flex flex-wrap gap-2"><button type="button" className="ht-button-secondary text-xs" disabled={busy || loading || Boolean(pendingApply) || Object.keys(choices).length > 0} onClick={() => load({ fresh: true })}>Start fresh review</button>{workspace.nextCursor && <button type="button" className="ht-button-secondary text-xs" disabled={busy || loading || Boolean(pendingApply) || Object.keys(choices).length > 0} onClick={() => load({ fresh: true, cursor: workspace.nextCursor })}>Review next offers</button>}</div></section>
      <div className="space-y-4">{remaining.map((row) => <CatalogSyncReviewRow key={`${workspace.jobId}:${row.rowId}:${row.reviewRevision}`} hotelUid={hotelUid} row={row} draft={drafts[separate[row.rowId] ? row.rowId : row.groupKey] || row.proposedNewProduct} separate={separate[row.rowId] === true} onSeparateChange={(value) => { setSeparate((prior) => ({ ...prior, [row.rowId]: value })); reviewed(row, null); }} onDraftChange={(value) => updateDraft(row, value)} reviewed={choices[row.rowId]} onReviewed={(choice) => reviewed(row, choice)} onSkip={() => { if (!busy && !pendingApply) { setSkipped((prior) => ({ ...prior, [row.rowId]: true })); reviewed(row, null); } }} canCreate={canCreate} locked={requiresFresh || busy || loading || Boolean(pendingApply)} current={current} onRefine={() => refine(row)} refineLocked={Boolean(pendingAi)} />)}</div>
      {!remaining.length && <p className="rounded-xl bg-stone-50 p-5 text-sm text-stone-600">{workspace.nextCursor ? "No offers remain in this source window. Continue scanning with Review next offers; later windows may still contain unlinked offers." : "No offers remain in this view. Skipped offers are unchanged and can be reviewed again by refreshing."}</p>}
      {outcomes.length > 0 && <section aria-label="Catalog sync result" className="rounded-xl border bg-white p-4"><h2 className="font-semibold">Latest link result</h2><ul className="mt-2 space-y-1 text-xs text-stone-600">{outcomes.map((row) => <li key={row.rowId}>{row.sourceName} → <Link className="font-medium text-brand-800 underline" to={`/catalog/products/${encodeURIComponent(row.catalogProductId)}`}>{row.catalogName}{row.internalSku ? ` (${row.internalSku})` : ""}</Link> · {row.status === "created-and-linked" ? "New article created and linked" : "Linked to existing article"}</li>)}</ul></section>}
      <footer className="sticky bottom-3 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-brand-100 bg-brand-50 p-4 shadow-sm"><div><p className="font-semibold text-brand-950">{pendingApply?.input.choices.length ?? Object.keys(choices).length} reviewed choices ready</p><p className="mt-1 text-xs text-stone-600">No supplier prices, purchase packages or historical snapshots are rewritten.</p></div><div className="flex flex-wrap gap-2">{Object.keys(choices).length > 0 && !pendingApply && <button type="button" className="ht-button-secondary" disabled={busy} onClick={() => setChoices({})}>Clear reviewed selection</button>}<button type="button" className="ht-button-primary" disabled={requiresFresh || busy || loading || (!pendingApply && !Object.keys(choices).length)} onClick={beginApply}>{busy ? "Processing…" : pendingApply ? "Recover original choices" : `Apply reviewed choices (${Object.keys(choices).length})`}</button></div></footer>
    </>}
    <Modal open={confirmation} onClose={() => { if (!busy) setConfirmation(false); }} title={pendingApply ? "Recover original catalog sync" : "Apply reviewed catalog links"}><p className="text-sm text-stone-600">{pendingApply ? "Verify the same request with its original choices and revisions. Already applied links and group creations are not repeated." : `Apply ${confirmedChoices.current?.length || 0} explicitly reviewed supplier links. Shared new-article groups create one article only when their reviewed definitions and physical goods are compatible.`}</p><div className="mt-5 flex justify-end gap-2"><button type="button" className="ht-button-secondary" onClick={() => setConfirmation(false)}>Cancel</button><button type="button" className="ht-button-primary" disabled={busy} onClick={apply}>{pendingApply ? "Confirm original recovery" : "Confirm catalog sync"}</button></div></Modal>
  </PageShell>;
}
