import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import PendingStockCommand from "../inventory/PendingStockCommand";
import HeaderBar from "../layout/HeaderBar";
import ProcurementPage from "../layout/ProcurementPage";
import { Card } from "../layout/Card";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { createStockCount, getStockCountSources, STOCK_COUNT_TYPES } from "../../services/firebaseStockCounts";
import { useScopedAsync } from "../../hooks/useScopedAsync";
import { usePermission } from "../../hooks/usePermission";
import { procurementReadScope } from "../../services/procurementReadPool";

const fieldClass = "mt-1 block min-h-[44px] w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-base";
const lastCompletedMonth = () => {
  const now = new Date();
  return { month: now.getMonth() === 0 ? 12 : now.getMonth(), year: now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear() };
};
const months = Array.from({ length: 12 }, (_, index) => ({ value: index + 1,
  label: new Intl.DateTimeFormat("en", { month: "long" }).format(new Date(2000, index, 1)) }));

function groupSources(sources) {
  const groups = new Map();
  for (const source of sources || []) {
    const key = source.outletId ? `outlet:${source.outletId}` : `location:${source.locationId}`;
    if (!groups.has(key)) groups.set(key, { id: key, outletId: source.outletId || null, name: source.outletName || source.locationName,
      central: source.inventoryRole === "central_storage", selected: true, detail: false, sources: [] });
    groups.get(key).sources.push({ ...source, selected: true, stockTemplateId: "" });
  }
  return [...groups.values()];
}

export default function StockCountCreatePage() {
  const navigate = useNavigate();
  const { hotelUid } = useHotelContext();
  const canCreate = usePermission("stockcounts", "create");
  const scopeKey = `${hotelUid}:${auth.currentUser?.uid}:${canCreate}`;
  const sourcesScope = useRef(null);
  const activeScope = useRef({ key: scopeKey });
  if (activeScope.current.key !== scopeKey) activeScope.current = { key: scopeKey };
  const [type, setType] = useState("Ad Hoc"), [reason, setReason] = useState("");
  const [businessDate, setBusinessDate] = useState("");
  const [periodMonth, setPeriodMonth] = useState(() => lastCompletedMonth().month);
  const [periodYear, setPeriodYear] = useState(() => lastCompletedMonth().year);
  const [groupState, setGroupState] = useState({ scopeKey: null, values: [] });
  const groups = groupState.scopeKey === scopeKey ? groupState.values : [];
  const setGroups = (update) => setGroupState((previous) => ({ scopeKey,
    values: typeof update === "function" ? update(previous.scopeKey === scopeKey ? previous.values : []) : update }));
  const [saving, setSaving] = useState(false), [error, setError] = useState("");
  const today = useMemo(() => new Date().toLocaleDateString(undefined,
    { weekday: "long", month: "long", day: "numeric" }), []);
  const loadSources = useCallback(async () => {
    const scope = procurementReadScope(hotelUid);
    const result = await getStockCountSources(hotelUid);
    if (!scope?.current() || activeScope.current.key !== scopeKey) throw new Error("Your hotel access changed. Reload before starting a count.");
    sourcesScope.current = { key: scopeKey, actor: auth.currentUser, scope };
    return result;
  }, [hotelUid, scopeKey]);
  const { data: sources, loading, error: sourceError, retry } = useScopedAsync({
    scopeKey, enabled: Boolean(hotelUid && canCreate), load: loadSources,
  });
  useEffect(() => {
    const query = new URLSearchParams(window.location.search), requestedOutlet = query.get("outletId");
    const requestedLocation = query.get("hotelUid") === hotelUid ? query.get("locationId") : null;
    const next = groupSources(sources);
    if (requestedLocation && next.some((group) => group.sources.some((source) => source.locationId === requestedLocation))) {
      next.forEach((group) => {
        const selected = group.sources.find((source) => source.locationId === requestedLocation);
        group.selected = Boolean(selected);
        group.detail = Boolean(selected && !selected.isOutletDefault && selected.locationId !== `outlet:${selected.outletId}`);
        group.sources.forEach((source) => { source.selected = source.locationId === requestedLocation; });
      });
    } else if (requestedOutlet && next.some((group) => group.outletId === requestedOutlet)) {
      next.forEach((group) => { group.selected = group.outletId === requestedOutlet; });
    }
    setGroups(next);
  }, [sources, scopeKey]);
  useEffect(() => {
    activeScope.current = { key: scopeKey };
    const query = new URLSearchParams(window.location.search), recountOf = query.get("hotelUid") === hotelUid ? query.get("recountOf") : null;
    setSaving(false); setError(""); setBusinessDate(""); setReason(recountOf && /^[^/]{1,128}$/.test(recountOf) ? `Follow-up to count ${recountOf}: review the physical cutoff and record new quantities.` : ""); setType("Ad Hoc");
    setPeriodMonth(lastCompletedMonth().month); setPeriodYear(lastCompletedMonth().year);
    return () => { activeScope.current = { key: null }; };
  }, [scopeKey]);

  const selectedRows = groups.filter((group) => group.selected).flatMap((group) => {
    const defaultPoint = group.sources.find((source) => source.isOutletDefault || source.locationId === `outlet:${source.outletId}`);
    return defaultPoint && !group.detail ? [defaultPoint] : group.sources.filter((source) => source.selected && source !== defaultPoint);
  });
  const changeGroup = (groupId, update) => setGroups((previous) => previous.map((group) =>
    group.id === groupId ? { ...group, ...update } : group));
  const changeSource = (groupId, locationId, update) => setGroups((previous) => previous.map((group) => group.id === groupId
    ? { ...group, sources: group.sources.map((source) => source.locationId === locationId ? { ...source, ...update } : source) } : group));
  const validPeriod = Number.isInteger(periodYear) && periodYear >= 2000 && periodYear <= 9999;

  const handleSubmit = async (event) => {
    event.preventDefault(); setError("");
    if (!hotelUid || !canCreate || saving) return;
    if (sourcesScope.current?.key !== scopeKey || sourcesScope.current.actor !== auth.currentUser || !sourcesScope.current.scope.current()) {
      setError("Your hotel access changed. Reload stock points before starting a count."); return;
    }
    if (!selectedRows.length || selectedRows.length > 50) { setError("Select between 1 and 50 stock points."); return; }
    if (type === "Month-End" && !validPeriod) { setError("Enter a valid year."); return; }
    const requested = activeScope.current, actor = auth.currentUser; setSaving(true);
    try {
      const input = { type,
        ...(type === "Month-End" ? { periodMonth, periodYear } : businessDate ? { businessDate } : {}),
        ...(type === "Ad Hoc" && reason.trim() ? { reason: reason.trim() } : {}),
        locations: selectedRows.map((row) => ({
          ...(!row.isOutletDefault && row.locationId !== `outlet:${row.outletId}` ? { locationId: row.locationId } : {}),
          ...(row.outletId ? { outletId: row.outletId } : {}),
          ...(row.stockTemplateId ? { stockTemplateId: row.stockTemplateId } : {}) })) };
      const result = await createStockCount(hotelUid, input);
      if (activeScope.current === requested && auth.currentUser === actor) navigate(`/catalog/stock-counts/${result.id}`);
    } catch (failure) { if (activeScope.current === requested) setError(failure.message || "Unable to start stock count."); }
    finally { if (activeScope.current === requested) setSaving(false); }
  };

  return <div className="min-h-screen bg-canvas text-gray-900">
    <HeaderBar today={today} onLogout={async () => { await signOut(auth); sessionStorage.clear(); window.location.href = "/login"; }} />
    <ProcurementPage width="form" className="space-y-6">
      <div><p className="text-sm uppercase tracking-wide text-gray-500">Purchasing & inventory</p>
        <h1 className="text-3xl font-semibold">Start a stock count</h1>
        <p className="mt-1 text-gray-600">Choose where to count, then search or scan products and enter quantities.</p></div>
      <PendingStockCommand kind="count" hotelUid={hotelUid} disabled={saving}
        onComplete={(result) => navigate(`/catalog/stock-counts/${result.id || result.stockCountId}`)} />
      {sourceError && <div role="alert"><p>{sourceError.message || "Unable to load stock points."}</p><button type="button" onClick={retry}>Retry</button></div>}
      <Card><form onSubmit={handleSubmit} className="space-y-6">
        <fieldset disabled={saving} className="space-y-5">
          <legend className="mb-3 text-lg font-semibold">1. When are you counting?</legend>
          <label className="block text-sm font-medium">Count type<select aria-label="Count type" className={fieldClass} value={type}
            onChange={(event) => setType(event.target.value)}>{STOCK_COUNT_TYPES.map((value) => <option key={value}>{value}</option>)}</select></label>
          {type === "Month-End" ? <div className="grid grid-cols-2 gap-3">
            <label className="text-sm font-medium">Month<select aria-label="Month" className={fieldClass} value={periodMonth}
              onChange={(event) => setPeriodMonth(Number(event.target.value))}>{months.map((month) => <option value={month.value} key={month.value}>{month.label}</option>)}</select></label>
            <label className="text-sm font-medium">Year<input aria-label="Year" type="number" inputMode="numeric" min="2000" max="9999" required
              className={fieldClass} value={periodYear} onChange={(event) => setPeriodYear(Number(event.target.value))} /></label>
            <p className="col-span-2 text-xs text-gray-500">The business date is the last day of the selected month.</p>
          </div> : <label className="block text-sm font-medium">Business date (optional)<input aria-label="Business date" type="date"
            className={fieldClass} value={businessDate} onChange={(event) => setBusinessDate(event.target.value)} />
            <span className="mt-1 block text-xs text-gray-500">Leave blank for today in the hotel's time zone.</span></label>}
          {type === "Ad Hoc" && <label className="block text-sm font-medium">Reason (optional)<input aria-label="Reason (optional)" maxLength={500}
            className={fieldClass} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="For example: handover or spot check" /></label>}
        </fieldset>
        <fieldset disabled={!canCreate || saving || loading || Boolean(sourceError)} className="space-y-3">
          <legend className="mb-3 text-lg font-semibold">2. Where are you counting?</legend>
          <p className="text-sm text-gray-600">Count an outlet as a whole, or split it into locations. Central stores can be counted in the same way.</p>
          {loading ? <p>Loading stock points...</p> : !groups.length ? <p className="rounded-lg border border-dashed p-4 text-sm text-gray-500">No stock points available. Configure an outlet or central store in Settings.</p>
            : groups.map((group) => {
              const defaultPoint = group.sources.find((source) => source.isOutletDefault || source.locationId === `outlet:${source.outletId}`);
              const detailPoints = group.sources.filter((source) => source !== defaultPoint);
              const visible = defaultPoint && !group.detail ? [defaultPoint] : detailPoints;
              return <div key={group.id} className="space-y-3 rounded-xl border border-gray-200 p-4">
                <label className="flex min-h-[44px] items-center gap-3 font-semibold"><input type="checkbox" checked={group.selected}
                  onChange={(event) => changeGroup(group.id, { selected: event.target.checked })} className="h-5 w-5" />
                  {group.name}{group.central && <span className="rounded bg-indigo-50 px-2 py-1 text-xs text-indigo-700">Central store</span>}</label>
                {group.selected && <>
                  {defaultPoint && detailPoints.length > 0 && <label className="flex min-h-[44px] items-center gap-3 text-sm"><input type="checkbox" checked={group.detail}
                    onChange={(event) => changeGroup(group.id, { detail: event.target.checked })} className="h-5 w-5" />Count separate locations</label>}
                  {visible.map((source) => <div key={source.locationId} className="space-y-2 border-t border-gray-100 pt-3">
                    {group.detail && <label className="flex min-h-[44px] items-center gap-3 text-sm font-medium"><input type="checkbox" checked={source.selected}
                      onChange={(event) => changeSource(group.id, source.locationId, { selected: event.target.checked })} className="h-5 w-5" />{source.locationName}</label>}
                    <label className="block text-sm text-gray-600">Template (optional)<select aria-label={`Template for ${source.locationName}`}
                      value={source.stockTemplateId} disabled={group.detail && !source.selected} className={fieldClass}
                      onChange={(event) => changeSource(group.id, source.locationId, { stockTemplateId: event.target.value })}>
                      <option value="">Start with an empty list</option>{(source.templates || []).map((template) => <option value={template.id} key={template.id}>{template.name}</option>)}
                    </select></label>
                  </div>)}
                </>}
              </div>;
            })}
          <p className="text-sm text-gray-500">Templates are a starting checklist. You can add products while counting. Blank quantities remain uncounted; enter 0 when no stock is present.</p>
        </fieldset>
        {error && <div role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700"><p>{error}</p>
          <button type="button" disabled={saving} onClick={retry} className="mt-2 min-h-[44px] underline">Reload stock points</button></div>}
        <div className="sticky bottom-0 flex flex-wrap items-center justify-between gap-3 border-t bg-white py-3">
          <span className="text-sm text-gray-600">{selectedRows.length} stock {selectedRows.length === 1 ? "point" : "points"} selected</span>
          <div className="flex gap-2"><button type="button" disabled={saving} onClick={() => navigate("/catalog/stock-counts")} className="min-h-[44px] rounded-lg border px-4">Cancel</button>
            <button type="submit" disabled={!canCreate || saving || loading || Boolean(sourceError) || !selectedRows.length || selectedRows.length > 50 || (type === "Month-End" && !validPeriod)}
              className="min-h-[44px] rounded-lg bg-brand-800 px-4 font-semibold text-white disabled:opacity-50">{saving ? "Starting..." : "Start counting"}</button></div>
        </div>
      </form></Card>
    </ProcurementPage>
  </div>;
}
