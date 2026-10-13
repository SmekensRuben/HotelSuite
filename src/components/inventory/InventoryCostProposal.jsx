import React, { useEffect, useRef, useState } from "react";
import { auth } from "../../firebaseConfig";
import { getInventoryCostProposal } from "../../services/firebaseInventoryCostProposals";
import { procurementReadScope } from "../../services/procurementReadPool";
import { formatInventoryQuantity, formatInventoryUnitCost, formatInventoryValue } from "./inventoryFormatting";

export default function InventoryCostProposal({ request, baseUnit, currency, businessDate, articleName, contextVersion = null, disabled = false, onApply }) {
  const contextKey = JSON.stringify([request.hotelUid, request.purpose, request.stockCountId, request.locationId, request.catalogProductId, baseUnit, currency, businessDate, contextVersion]);
  const active = useRef({ contextKey, actor: auth.currentUser, generation: 0, mounted: true });
  if (active.current.contextKey !== contextKey || active.current.actor !== auth.currentUser) active.current = { contextKey, actor: auth.currentUser, generation: active.current.generation + 1, mounted: true };
  const [state, setState] = useState({ scope: null, loading: false, data: null, error: null });
  useEffect(() => {
    active.current.mounted = true;
    return () => { active.current.mounted = false; active.current.generation++; };
  }, []);
  const ownState = state.scope === active.current ? state : { loading: false, data: null, error: null };
  const current = ownState.data && !ownState.readScope?.current()
    ? { loading: false, data: null, error: new Error("Hotel access or recorded evidence changed. Refresh the estimate before applying it.") } : ownState;
  const ready = Boolean(request.hotelUid && request.locationId && request.catalogProductId && baseUnit && currency && businessDate && auth.currentUser?.uid);
  const load = async () => {
    if (disabled || !ready || current.loading) return;
    const scope = active.current, actor = auth.currentUser, readScope = procurementReadScope(request.hotelUid), generation = ++scope.generation;
    const isLive = () => scope === active.current && scope.mounted && generation === scope.generation;
    const isCurrent = () => scope === active.current && scope.mounted && actor === auth.currentUser && generation === scope.generation && readScope?.current();
    setState({ scope, loading: true, data: null, error: null });
    try {
      const data = await getInventoryCostProposal(request, { baseUnit, currency, businessDate });
      if (isCurrent()) setState({ scope, readScope, loading: false, data, error: null });
      else if (isLive()) setState({ scope, loading: false, data: null, error: new Error("Hotel access or recorded evidence changed. Request a fresh estimate.") });
    } catch (error) { if (isLive()) setState({ scope, loading: false, data: null, error }); }
  };
  const apply = () => {
    if (disabled || !current.data?.available || active.current.actor !== auth.currentUser || !active.current.mounted) return;
    if (!current.readScope?.current()) {
      setState({ scope: active.current, loading: false, data: null, error: new Error("Hotel access or recorded evidence changed. Refresh the estimate before applying it.") });
      return;
    }
    onApply(current.data.netUnitCost, current.data);
  };
  return <div className="min-w-0 space-y-2 rounded-xl bg-slate-50 p-3 text-sm">
    <div className="flex flex-wrap items-center justify-between gap-2"><p className="font-medium text-slate-700">Weighted stock-cost estimate</p>
      <button type="button" className="ht-button-secondary min-h-[44px]" disabled={disabled || !ready || current.loading} onClick={load} aria-label={`Suggest unit cost${articleName ? ` for ${articleName}` : ""}`}>{current.loading ? "Calculating estimate…" : current.data || current.error ? "Refresh cost estimate" : "Suggest unit cost"}</button></div>
    <p className="text-xs leading-5 text-slate-500">Uses a completed opening count plus signed, validated receipt and physical movement quantities and net values through {businessDate || "the selected business date"}. This is a quantity-weighted recorded-source estimate, not live stock valuation or an average of supplier prices. A suggestion never replaces the entered cost until you apply it.</p>
    {!ready && <p className="text-xs text-slate-500">Choose an article, source location and business date with a known unit and currency to request an estimate.</p>}
    {current.loading && <div role="status" className="flex items-center gap-2 text-slate-600"><span aria-hidden="true" className="h-4 w-4 animate-spin rounded-full border-2 border-slate-200 border-t-brand-600 motion-reduce:animate-none" /><span>Reviewing recorded stock-cost evidence…</span></div>}
    {current.error && <p role="alert" className="text-xs leading-5 text-amber-900">{current.error.message || "The estimate could not be verified."} You can keep cost unknown or enter a reviewed manual estimate.</p>}
    {current.data && <div className="space-y-2 border-t border-slate-200 pt-3">
      {current.data.available ? <>
        <p className="font-semibold text-slate-900">{formatInventoryUnitCost(current.data.netUnitCost, current.data.currency)} / {current.data.baseUnit}</p>
        <dl className="grid gap-2 text-xs sm:grid-cols-2"><div><dt className="text-slate-500">Opening evidence</dt><dd>{current.data.source.openingBusinessDate} · {formatInventoryQuantity(current.data.source.openingQuantity)} {current.data.baseUnit} · {formatInventoryValue(current.data.source.openingNetValue, current.data.currency)}</dd></div>
          <div><dt className="text-slate-500">Recorded source basis</dt><dd>{formatInventoryQuantity(current.data.source.weightedSourceQuantity)} {current.data.baseUnit} · {formatInventoryValue(current.data.source.weightedSourceNetValue, current.data.currency)}</dd></div>
          <div><dt className="text-slate-500">Signed movement changes</dt><dd>{formatInventoryQuantity(current.data.source.recordedMovementQuantity)} {current.data.baseUnit} · {formatInventoryValue(current.data.source.recordedMovementNetValue, current.data.currency)} · {current.data.source.movementCount} movement{current.data.source.movementCount === 1 ? "" : "s"}</dd></div>
          <div><dt className="text-slate-500">Assessment cutoff</dt><dd>{current.data.businessDate} · sequence {current.data.source.postingCutoffSequence}</dd></div></dl>
        <p className="text-xs leading-5 text-slate-500">{current.data.costBasis} Policy v{current.data.costProposalPolicyVersion}; checked {new Date(current.data.asOfMillis).toLocaleString("en-GB")}.</p>
        <button type="button" className="ht-button-primary min-h-[44px]" disabled={disabled} onClick={apply} aria-label={`Apply cost estimate${articleName ? ` for ${articleName}` : ""}`}>Apply estimate to this draft</button>
      </> : <div role="status" className="space-y-1 text-xs leading-5 text-amber-900"><p className="font-medium">Weighted estimate unavailable</p><ul className="list-disc space-y-1 pl-4">{current.data.reasons.map((reason, index) => <li key={`${reason.code}:${index}`}>{reason.detail}</li>)}</ul><p>Keep cost unknown or enter a reviewed manual estimate; no zero value was substituted.</p></div>}
    </div>}
  </div>;
}
