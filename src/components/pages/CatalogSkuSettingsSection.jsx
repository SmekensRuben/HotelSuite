import React, { useCallback, useEffect, useState } from "react";
import { useProcurementSettingsScope } from "../../hooks/useProcurementSettingsScope";
import { usePermission } from "../../hooks/usePermission";
import { useScopedAsync } from "../../hooks/useScopedAsync";
import AsyncError from "../shared/AsyncError";
import CatalogSkuBackfillPanel from "../catalog/CatalogSkuBackfillPanel";
import { getCatalogSkuSettings, getPendingCatalogSkuSettings, normalizeCatalogSkuSettings, retryCatalogSkuSettings, saveCatalogSkuSettings } from "../../services/firebaseCatalogSkuSettings";

export default function CatalogSkuSettingsSection() {
  const scope = useProcurementSettingsScope(), canRead = usePermission("catalogsettings", "read");
  return canRead ? <ScopedCatalogSkuSettings key={scope.scopeKey} scope={scope} /> : null;
}
function ScopedCatalogSkuSettings({ scope }) {
  const { hotelUid, current } = scope, canUpdate = usePermission("catalogsettings", "update");
  const canReadCatalog = usePermission("catalogproducts", "read"), canUpdateCatalog = usePermission("catalogproducts", "update");
  const load = useCallback(() => getCatalogSkuSettings(hotelUid), [hotelUid]);
  const query = useScopedAsync({ scopeKey: scope.scopeKey, enabled: Boolean(hotelUid), retainData: true, load });
  const [draft, setDraft] = useState(null), [pending, setPending] = useState(null), [error, setError] = useState(null);
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState("");
  useEffect(() => {
    try { setPending(getPendingCatalogSkuSettings(hotelUid)); }
    catch (failure) { setError(failure); }
  }, [hotelUid]);
  useEffect(() => { if (query.data) setDraft(normalizeCatalogSkuSettings(query.data)); }, [query.data]);
  const locked = busy || Boolean(pending) || !canUpdate || query.loading || Boolean(query.error);
  const preview = draft ? `${draft.prefix}${String(draft.nextNumber).padStart(draft.padding, "0")}` : "";
  const dirty = Boolean(draft && query.data && JSON.stringify(draft) !== JSON.stringify(normalizeCatalogSkuSettings(query.data)));
  const save = async (retry = false) => {
    if (!current() || busy || !canUpdate || !query.data || !draft) return;
    setBusy(true); setError(null); setNotice("");
    try {
      if (retry) await retryCatalogSkuSettings(hotelUid);
      else await saveCatalogSkuSettings(hotelUid, draft, { expectedRevision: query.data.revision });
      if (!current()) return;
      setPending(null); setNotice("Internal SKU settings saved for this hotel."); await query.retry();
    } catch (failure) {
      if (!current()) return;
      setError(failure);
      try { setPending(getPendingCatalogSkuSettings(hotelUid)); } catch (recoveryFailure) { setError(recoveryFailure); }
      if (failure?.details?.catalogSkuRequestUncommitted === true) await query.retry();
    } finally { if (current()) setBusy(false); }
  };
  return <section aria-label="Internal SKU settings" className="space-y-5 rounded-2xl border border-gray-200 bg-white p-5">
    <div><h2 className="text-xl font-semibold">Internal SKUs</h2><p className="mt-2 text-sm text-gray-600">Number new Catalog Products consistently across manual creation, imports and catalog sync.</p></div>
    <AsyncError error={query.error} onRetry={query.retry} label="Could not load internal SKU settings." />
    {query.loading && <p role="status" className="text-sm text-gray-500">Loading hotel SKU settings…</p>}
    {draft && <form onSubmit={(event) => { event.preventDefault(); save(); }} className="space-y-4">
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={draft.enabled} disabled={locked} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} /><span>Generate an internal SKU when a new Catalog Product has no entered SKU</span></label>
      <div className="grid gap-4 sm:grid-cols-3">
        <label className="text-sm font-medium">Prefix<input aria-label="SKU prefix" value={draft.prefix} maxLength={20} pattern="[A-Z0-9_-]*" disabled={locked} onChange={(event) => setDraft({ ...draft, prefix: event.target.value.toUpperCase() })} className="ht-field mt-1 w-full" /><span className="text-xs font-normal text-gray-500">Letters, numbers, hyphens or underscores.</span></label>
        <label className="text-sm font-medium">Minimum digits<input aria-label="SKU minimum digits" type="number" min="1" max="12" step="1" value={draft.padding} disabled={locked} onChange={(event) => setDraft({ ...draft, padding: Number(event.target.value) })} className="ht-field mt-1 w-full" /></label>
        <label className="text-sm font-medium">Next number<input aria-label="SKU next number" type="number" min={query.data?.nextNumber || 1} max={Number.MAX_SAFE_INTEGER - 1} step="1" value={draft.nextNumber} disabled={locked} onChange={(event) => setDraft({ ...draft, nextNumber: Number(event.target.value) })} className="ht-field mt-1 w-full" /><span className="text-xs font-normal text-gray-500">The sequence moves forward across prefix changes.</span></label>
      </div>
      <div className="rounded-xl bg-gray-50 p-4"><p className="text-xs text-gray-500">Next generated SKU</p><p className="mt-1 break-all font-mono text-lg font-semibold">{preview}</p><p className="mt-2 text-xs text-gray-600">The server allocates an available number on save. Entered and existing SKUs are kept; archived SKU reservations remain in use.</p></div>
      <button type="submit" className="ht-button-primary" disabled={locked}>{busy ? "Saving…" : "Save SKU settings"}</button>
      {!canUpdate && <p className="text-xs text-gray-500">Catalog settings update permission is required to change numbering.</p>}
    </form>}
    {pending && <div role="status" className="space-y-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-900"><p>A previous settings save needs verification. Retry its original values before editing.</p><button type="button" className="ht-button-secondary" disabled={busy || !canUpdate || query.loading || !query.data} onClick={() => save(true)}>Verify original settings save</button></div>}
    <AsyncError error={error} label="Could not save internal SKU settings." />
    {notice && <p role="status" className="text-sm text-emerald-800">{notice}</p>}
    {query.data && canReadCatalog && canUpdateCatalog && <CatalogSkuBackfillPanel scope={scope} settings={query.data} locked={busy || Boolean(pending) || dirty || query.loading || Boolean(query.error)} onAssigned={query.retry} />}
  </section>;
}
