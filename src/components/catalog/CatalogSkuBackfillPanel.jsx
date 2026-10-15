import React, { useCallback, useEffect, useRef, useState } from "react";
import { getCatalogProducts } from "../../services/firebaseProducts";
import { assignCatalogSkus, getPendingCatalogSkuAssignment, retryCatalogSkuAssignment } from "../../services/firebaseCatalogSkuAssignments";
import { useScopedAsync } from "../../hooks/useScopedAsync";
import AsyncError from "../shared/AsyncError";

export default function CatalogSkuBackfillPanel(props) {
  return <ScopedCatalogSkuBackfillPanel key={props.scope.scopeKey} {...props} />;
}
function ScopedCatalogSkuBackfillPanel({ scope, settings, locked = false, onAssigned }) {
  const { hotelUid, current } = scope;
  const [opened, setOpened] = useState(false), [cursor, setCursor] = useState(null), [selected, setSelected] = useState({});
  const [pending, setPending] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState(null), [notice, setNotice] = useState(""), [recoveryBlocked, setRecoveryBlocked] = useState(false);
  const mounted = useRef(true), operationRunning = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const active = () => mounted.current && current();
  const load = useCallback(() => getCatalogProducts(hotelUid, { pageSize: 25, cursor }), [hotelUid, cursor]);
  const cursorKey = cursor?.ref?.path || cursor?.id || (Number.isSafeInteger(cursor?.offset) ? String(cursor.offset) : "first");
  const query = useScopedAsync({ scopeKey: `${scope.scopeKey}:${cursorKey}`, enabled: opened && Boolean(hotelUid), load });
  useEffect(() => { try { setPending(getPendingCatalogSkuAssignment(hotelUid)); } catch (failure) { setError(failure); setRecoveryBlocked(true); } }, [hotelUid]);
  useEffect(() => { setSelected({}); }, [query.data]);
  const rows = (query.data?.products || []).filter((product) => (product.internalSku === undefined || product.internalSku === null || typeof product.internalSku === "string" && !product.internalSku.trim())
    && product.archived !== true && !product.archivedAt);
  const waiting = locked || busy || Boolean(pending) || recoveryBlocked || query.loading;
  const assign = async (retry = false) => {
    if (!active() || operationRunning.current || busy || locked || recoveryBlocked) return;
    operationRunning.current = true;
    setBusy(true); setError(null); setNotice("");
    try {
      const result = retry ? await retryCatalogSkuAssignment(hotelUid) : await assignCatalogSkus(hotelUid, {
        expectedSettingsRevision: settings.revision, products: rows.filter((product) => selected[product.id]).map((product) => ({ productId: product.id, expectedRevision: product.revision ?? 0 })),
      });
      if (!active()) return;
      setPending(null); setSelected({}); setNotice(`${result.assigned.length} internal SKUs assigned. Product identities and recorded history are preserved.`);
      if (opened) await query.retry(); if (active()) await onAssigned?.();
    } catch (failure) {
      if (!active()) return;
      setError(failure); try { setPending(getPendingCatalogSkuAssignment(hotelUid)); } catch (recoveryFailure) { setError(recoveryFailure); setRecoveryBlocked(true); }
      if (failure?.details?.catalogSkuRequestUncommitted === true) { if (opened) await query.retry(); if (active()) await onAssigned?.(); }
    } finally { operationRunning.current = false; if (active()) setBusy(false); }
  };
  return <section aria-label="Assign missing internal SKUs" className="space-y-3 border-t border-gray-200 pt-5">
    <div><h3 className="font-semibold">Existing products without an internal SKU</h3><p className="mt-1 text-sm text-gray-600">Review up to 25 products per page and explicitly select which receive a number.</p></div>
    <p className="text-xs text-gray-500">Saved numbering: {settings.prefix}{String(settings.nextNumber).padStart(settings.padding, "0")}. Available numbers are allocated atomically when you confirm.</p>
    {!opened && <button type="button" className="ht-button-secondary" disabled={locked || busy || Boolean(pending) || recoveryBlocked || !settings.enabled} onClick={() => setOpened(true)}>Review products without SKUs</button>}
    {!settings.enabled && <p className="text-xs text-gray-500">Enable and save automatic numbering before assigning missing SKUs.</p>}
    {opened && <>
      <AsyncError error={query.error} onRetry={query.retry} label="Could not load products for SKU assignment." />
      {query.loading && <p role="status" className="text-sm text-gray-500">Loading catalog products…</p>}
      {rows.length > 0 && <ul className="space-y-2">{rows.map((product) => <li key={product.id}><label className="flex items-start gap-3 rounded-lg bg-gray-50 p-3 text-sm"><input type="checkbox" className="mt-1" checked={Boolean(selected[product.id])} disabled={waiting || !settings.enabled} onChange={(event) => setSelected({ ...selected, [product.id]: event.target.checked })} /><span className="min-w-0 break-words">{product.name || "Unnamed catalog product"}<span className="block text-xs text-gray-500">{product.baseUnit || "Unit needs review"}</span></span></label></li>)}</ul>}
      {!query.loading && query.data && !rows.length && <p className="text-sm text-gray-500">No unnumbered products on this page.</p>}
      <div className="flex flex-wrap gap-2"><button type="button" className="ht-button-primary" disabled={waiting || !settings.enabled || Boolean(query.error) || !rows.some((product) => selected[product.id])} onClick={() => assign()}>Assign SKUs to {rows.filter((product) => selected[product.id]).length} selected products</button>
        {query.data?.hasMore && <button type="button" className="ht-button-secondary" disabled={waiting} onClick={() => { setSelected({}); setCursor(query.data.cursor); }}>Next catalog page</button>}
        {cursor && <button type="button" className="ht-button-secondary" disabled={waiting} onClick={() => { setSelected({}); setCursor(null); }}>First catalog page</button>}
      </div>
    </>}
    {pending && <div role="status" className="rounded-lg bg-amber-50 p-3 text-sm"><p>Verify the original SKU assignment before changing the selection.</p><button type="button" className="ht-button-secondary mt-2" disabled={busy || locked} onClick={() => assign(true)}>Verify original SKU assignment</button></div>}
    <AsyncError error={error} label="Could not assign internal SKUs." />
    {notice && <p role="status" className="text-sm text-emerald-800">{notice}</p>}
  </section>;
}
