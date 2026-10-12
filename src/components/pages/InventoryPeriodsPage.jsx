import React, { useCallback, useEffect, useMemo, useState } from "react";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { useScopedAsync } from "../../hooks/useScopedAsync";
import { usePermission } from "../../hooks/usePermission";
import { getInventoryLocations, getInventoryCheckpoints, getInventoryPeriod } from "../../services/firebaseInventory";
import HeaderBar from "../layout/HeaderBar";
import ProcurementPage from "../layout/ProcurementPage";
import { Card } from "../layout/Card";
import { Combobox } from "../ui/combobox";
import { formatInventoryQuantity, formatInventoryValue, formatInventoryUnitCost } from "../inventory/inventoryFormatting";

export default function InventoryPeriodsPage() {
  const { hotelUid } = useHotelContext();
  const canRead = usePermission("stockcounts", "read");
  const [locationId, setLocationId] = useState(""), [openingId, setOpeningId] = useState(""), [closingId, setClosingId] = useState("");
  const [selection, setSelection] = useState(null);
  const today = useMemo(() => new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }), []);
  const loadLocations = useCallback(() => getInventoryLocations(hotelUid), [hotelUid]);
  const locations = useScopedAsync({ scopeKey: hotelUid, enabled: Boolean(hotelUid && canRead), load: loadLocations });
  const loadCheckpoints = useCallback(() => getInventoryCheckpoints(hotelUid, locationId), [hotelUid, locationId]);
  const checkpoints = useScopedAsync({ scopeKey: `${hotelUid}:${locationId}`, enabled: Boolean(hotelUid && locationId && canRead), load: loadCheckpoints });
  const reportKey = selection ? `${selection.hotelUid}:${selection.locationId}:${selection.openingId}:${selection.closingId}` : "none";
  const loadReport = useCallback(() => getInventoryPeriod(selection.hotelUid, selection.locationId, selection.openingId, selection.closingId), [selection]);
  const report = useScopedAsync({ scopeKey: reportKey, enabled: Boolean(selection && selection.hotelUid === hotelUid && selection.locationId === locationId && canRead), load: loadReport });
  useEffect(() => { setLocationId(""); setOpeningId(""); setClosingId(""); setSelection(null); }, [hotelUid]);
  useEffect(() => { setOpeningId(""); setClosingId(""); setSelection(null); }, [locationId]);
  const choices = checkpoints.data || [];
  const locationChoices = locations.data || [];
  const opening = choices.find((item) => item.stockCountId === openingId), closing = choices.find((item) => item.stockCountId === closingId);
  const validSelection = Boolean(opening && closing && opening.sequence < closing.sequence && !checkpoints.error);
  const result = report.data;
  return <div className="min-h-screen bg-canvas text-gray-900">
    <HeaderBar today={today} onLogout={async () => { await signOut(auth); sessionStorage.clear(); window.location.href = "/login"; }} />
    <ProcurementPage className="space-y-6">
      <div><p className="text-xs uppercase tracking-wider text-slate-500">Purchasing & inventory</p><h1 className="text-3xl font-semibold">Inventory periods</h1><p className="mt-1 max-w-2xl text-sm text-slate-600">Compare two physical counts and the recorded goods receipts between them.</p></div>
      {!canRead && <p role="alert">Stock count read permission is required.</p>}
      {locations.error && <div role="alert"><p>{locations.error.message}</p><button className="ht-button-secondary mt-2" onClick={locations.retry}>Retry locations</button></div>}
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Card className="space-y-4">
          <h2 className="text-lg font-semibold">Choose a comparison</h2>
          <label className="block text-sm font-medium">Physical location
            <Combobox aria-label="Physical location" options={locationChoices} value={locationChoices.find((location) => (location.locationId || location.id) === locationId) || null} onChange={(location) => setLocationId(location?.locationId || location?.id || "")} displayValue={(location) => location.locationName || location.name || "Unnamed location"} getOptionValue={(location) => location.locationId || location.id} disabled={!canRead || locations.loading || Boolean(locations.error)} placeholder="Search physical locations" className="ht-field mt-1" />
          </label>
          {checkpoints.loading && <p role="status" className="text-sm text-slate-600">Loading completed count checkpoints...</p>}
          {checkpoints.error && <div role="alert"><p>{checkpoints.error.message}</p><button className="ht-button-secondary mt-2" onClick={checkpoints.retry}>Retry completed counts</button></div>}
          {locationId && !checkpoints.loading && !checkpoints.error && choices.length < 2 && <p className="rounded-xl bg-amber-50 p-3 text-sm">At least two completed catalog counts are needed for this location. Historical supplier-based counts cannot be compared with this policy.</p>}
          <div className="grid gap-4 sm:grid-cols-2">{[["Opening count", openingId, setOpeningId], ["Closing count", closingId, setClosingId]].map(([label, value, setter]) => <label key={label} className="text-sm font-medium">{label}
            <Combobox aria-label={label} options={choices} value={choices.find((checkpoint) => checkpoint.stockCountId === value) || null} onChange={(checkpoint) => { setter(checkpoint?.stockCountId || ""); setSelection(null); }} displayValue={(checkpoint) => `${checkpoint.stockCountName || "Unnamed count"} · ${checkpoint.businessDate} · #${checkpoint.sequence}`} getOptionValue={(checkpoint) => checkpoint.stockCountId} disabled={!canRead || !locationId || checkpoints.loading || Boolean(checkpoints.error)} placeholder="Search completed counts" className="ht-field mt-1" />
          </label>)}</div>
          {openingId && closingId && !validSelection && <p role="alert" className="text-sm text-amber-800">Closing count must follow the opening count at the same location.</p>}
          <div className="flex justify-end"><button className="ht-button-primary disabled:opacity-50" disabled={!canRead || !validSelection || report.loading} onClick={() => setSelection({ hotelUid, locationId, openingId, closingId })}>Compare counts</button></div>
        </Card>
        <aside className="rounded-2xl border border-slate-200 bg-slate-50 p-5 text-sm">
          <h2 className="font-semibold">How to read this period</h2>
          <p className="mt-3 font-medium">Inferred usage = opening count + net recorded receipts − closing count.</p>
          <p className="mt-3 leading-6 text-slate-600">This period difference cannot identify sales, waste or theft. It is not live stock. Receipts use their posting checkpoint; late or backdated entries are flagged.</p>
          <p className="mt-3 leading-6 text-slate-600">Complete location counts must use a consistent physical delivery cutoff. Costs remain estimates and require complete source evidence.</p>
        </aside>
      </div>
      {report.loading && <p role="status" className="text-sm text-slate-600">Calculating recorded period evidence...</p>}
      {report.error && <div role="alert"><p>{report.error.message}</p><button className="ht-button-secondary mt-2" onClick={report.retry}>Retry period report</button></div>}
      {result && <Card className="space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-xl font-semibold">{result.opening.businessDate} → {result.closing.businessDate}</h2><p className="mt-1 text-sm text-slate-500">{result.recordedReceiptCount} recorded receipt/reversal movements · Currency: {result.currency || "Unknown"}</p></div><span className={`rounded-full px-3 py-1 text-xs font-semibold ${result.currentlyComplete ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-800"}`}>{result.currentlyComplete ? "Complete evidence" : "Review evidence"}</span></div>
        <div className="grid gap-3 sm:grid-cols-3">{[["Saved quantity coverage", result.coverage.quantityComplete ? "Complete" : "Incomplete"], ["Cost coverage", result.coverage.costComplete ? "Complete" : "Incomplete"], ["Current period evidence", result.currentlyComplete ? "Complete" : "Incomplete — review cutoff and late postings"]].map(([label, value]) => <div key={label} className="rounded-xl bg-slate-50 p-3"><p className="text-xs text-slate-500">{label}</p><p className="mt-1 text-sm font-semibold">{value}</p></div>)}</div>
        {(result.postClosureIssues || []).length > 0 && <div role="alert" className="rounded-xl bg-amber-50 p-4 text-sm"><p className="font-semibold">Entries posted after this period closed</p><p>The saved calculation is unchanged. Its quantity and cost estimates are not currently validated against these late entries.</p><ul className="mt-2 list-disc pl-5">{result.postClosureIssues.map((issue, index) => <li key={index}>{issue.detail || issue.code}</li>)}</ul></div>}
        {result.coverage.issues.length > 0 && <div role="alert" className="rounded-xl bg-amber-50 p-4 text-sm"><p className="font-medium">Coverage and cutoff warnings</p><ul className="mt-2 list-disc pl-5">{result.coverage.issues.map((issue, index) => <li key={`${issue.code}:${index}`}>{issue.detail || issue.code}</li>)}</ul></div>}
        <div className="overflow-x-auto rounded-xl border border-slate-200"><table className="w-full text-left text-sm"><thead className="bg-slate-50 text-xs text-slate-600"><tr>{["Catalog product", "Unit", "Opening", "Net receipts", "Closing", "Inferred usage", "Estimated cost / unit", "Estimated usage value"].map((label) => <th key={label} className="px-3 py-3">{label}</th>)}</tr></thead><tbody>{result.items.map((item) => <tr key={item.catalogProductId} className="border-t border-slate-100"><th scope="row" className="px-3 py-3 font-medium">{item.catalogProductName || "Unnamed catalog product"}</th><td className="px-3 py-3">{item.baseUnit}</td>{[item.openingQuantity, item.netReceiptQuantity, item.closingQuantity, item.inferredUsageQuantity].map((quantity, index) => <td key={index} className="px-3 py-3 tabular-nums">{formatInventoryQuantity(quantity)}</td>)}<td className="px-3 py-3 tabular-nums">{formatInventoryUnitCost(result.currentlyComplete ? item.periodUnitCost : null, result.currency)}</td><td className="px-3 py-3 tabular-nums">{formatInventoryValue(result.currentlyComplete ? item.inferredUsageValue : null, result.currency)}</td></tr>)}</tbody></table></div>
        <p className="text-xs leading-5 text-slate-500">Costs are period-weighted estimates only when the opening cost and every relevant receipt cost are known in the hotel currency. Missing evidence remains unavailable.</p>
      </Card>}
    </ProcurementPage>
  </div>;
}
