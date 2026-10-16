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
import InventoryExceptionReview from "../inventory/InventoryExceptionReview";
import { procurementReadScope } from "../../services/procurementReadPool";

export default function InventoryPeriodsPage() {
  const { hotelUid } = useHotelContext();
  const canRead = usePermission("stockcounts", "read");
  const accessScope = procurementReadScope(hotelUid)?.key;
  const [locationId, setLocationId] = useState(""), [openingId, setOpeningId] = useState(""), [closingId, setClosingId] = useState("");
  const [selection, setSelection] = useState(null);
  const [reportPolicyVersion, setReportPolicyVersion] = useState(2);
  const today = useMemo(() => new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }), []);
  const loadLocations = useCallback(() => getInventoryLocations(hotelUid), [hotelUid]);
  const locations = useScopedAsync({ scopeKey: `${accessScope}:${hotelUid}`, enabled: Boolean(hotelUid && canRead), load: loadLocations });
  const loadCheckpoints = useCallback(() => getInventoryCheckpoints(hotelUid, locationId), [hotelUid, locationId]);
  const checkpoints = useScopedAsync({ scopeKey: `${accessScope}:${hotelUid}:${locationId}`, enabled: Boolean(hotelUid && locationId && canRead), load: loadCheckpoints });
  const reportKey = selection ? `${selection.hotelUid}:${selection.locationId}:${selection.openingId}:${selection.closingId}:v${selection.reportPolicyVersion}` : "none";
  const loadReport = useCallback(() => getInventoryPeriod(selection.hotelUid, selection.locationId, selection.openingId, selection.closingId, selection.reportPolicyVersion), [selection]);
  const report = useScopedAsync({ scopeKey: `${accessScope}:${reportKey}`, enabled: Boolean(selection && selection.hotelUid === hotelUid && selection.locationId === locationId && selection.reportPolicyVersion === reportPolicyVersion && canRead), load: loadReport });
  useEffect(() => { setLocationId(""); setOpeningId(""); setClosingId(""); setSelection(null); }, [hotelUid]);
  useEffect(() => { setOpeningId(""); setClosingId(""); setSelection(null); }, [locationId]);
  const choices = checkpoints.data || [];
  const locationChoices = locations.data || [];
  const opening = choices.find((item) => item.stockCountId === openingId), closing = choices.find((item) => item.stockCountId === closingId);
  const validSelection = Boolean(opening && closing && opening.sequence < closing.sequence && !checkpoints.error);
  const result = canRead && selection?.reportPolicyVersion === reportPolicyVersion ? report.data : null;
  const classified = result?.reportPolicyVersion === 2;
  return <div className="min-h-screen bg-canvas text-gray-900">
    <HeaderBar today={today} onLogout={async () => { await signOut(auth); sessionStorage.clear(); window.location.href = "/login"; }} />
    <ProcurementPage className="space-y-6">
      <div><p className="text-xs uppercase tracking-wider text-slate-500">Purchasing & inventory</p><h1 className="text-3xl font-semibold">Inventory periods</h1><p className="mt-1 max-w-2xl text-sm text-slate-600">Compare completed physical counts with recorded receipts, transfers, waste, breakage and physical returns. This is periodic evidence, not live stock.</p></div>
      {!canRead && <p role="alert">Stock count read permission is required.</p>}
      {locations.error && <div role="alert"><p>{locations.error.message}</p><button className="ht-button-secondary mt-2" onClick={locations.retry}>Retry locations</button></div>}
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Card className="space-y-4">
          <h2 className="text-lg font-semibold">Choose a comparison</h2>
          <label className="block text-sm font-medium">Analysis policy
            <select aria-label="Analysis policy" value={reportPolicyVersion} className="ht-field mt-1" disabled={!canRead || report.loading} onChange={(event) => { setReportPolicyVersion(Number(event.target.value)); setSelection(null); }}>
              <option value={2}>V2 · Classified movements and residual difference</option>
              <option value={1}>V1 · Original receipts-only snapshot</option>
            </select>
          </label>
          <p className="text-xs leading-5 text-slate-500">Policies save separate immutable reports. Choosing V2 never overwrites or silently recalculates a historical V1 snapshot.</p>
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
          <div className="flex justify-end"><button className="ht-button-primary disabled:opacity-50" disabled={!canRead || !validSelection || report.loading} onClick={() => setSelection({ hotelUid, locationId, openingId, closingId, reportPolicyVersion })}>Compare counts</button></div>
        </Card>
        <aside className="rounded-2xl border border-slate-200 bg-slate-50 p-5 text-sm">
          <h2 className="font-semibold">How to read this period</h2>
          <p className="mt-3 font-medium">{reportPolicyVersion === 2 ? "Residual difference = opening + net receipts + transfers in − transfers out − registered waste − breakage − physical returns − closing." : "V1 inferred usage = opening count + net recorded receipts − closing count."}</p>
          <p className="mt-3 leading-6 text-slate-600">{reportPolicyVersion === 2 ? "Registered movements explain part of the difference. The remaining amount may include sales, unregistered movements or errors; it is not guaranteed sales consumption or live on-hand stock." : "The original V1 policy cannot distinguish sales, waste, theft or transfers. Its saved result is retained unchanged."} Evidence uses posting checkpoints; late or backdated entries are flagged.</p>
          <p className="mt-3 leading-6 text-slate-600">Complete location counts must use a consistent physical delivery cutoff. Costs remain estimates and require complete source evidence.</p>
        </aside>
      </div>
      {report.loading && <p role="status" className="text-sm text-slate-600">Calculating recorded period evidence...</p>}
      {report.error && <div role="alert"><p>{report.error.message}</p><button className="ht-button-secondary mt-2" onClick={report.retry}>Retry period report</button></div>}
      {result && <Card className="space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-xl font-semibold">{result.opening.businessDate} → {result.closing.businessDate}</h2><p className="mt-1 text-sm font-medium">{classified ? "V2 · Classified movement snapshot" : "V1 · Original receipts-only snapshot"}</p><p className="mt-1 text-sm text-slate-500">{result.recordedReceiptCount} receipt/reversal postings{classified ? ` · ${result.recordedManualAdjustmentCount} registered movement postings` : ""} · Currency: {result.currency || "Unknown"}</p></div><span className={`rounded-full px-3 py-1 text-xs font-semibold ${result.currentlyComplete ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-800"}`}>{result.currentlyComplete ? "Quantity evidence complete" : "Review quantity evidence"}</span></div>
        <div className="grid gap-3 sm:grid-cols-3">{[["Saved quantity coverage", result.coverage.quantityComplete ? "Complete" : "Incomplete"], ["Cost coverage", result.coverage.costComplete ? "Complete" : "Incomplete"], ["Current quantity evidence", result.currentlyComplete ? "Complete" : "Incomplete — review cutoff and late postings"]].map(([label, value]) => <div key={label} className="rounded-xl bg-slate-50 p-3"><p className="text-xs text-slate-500">{label}</p><p className="mt-1 text-sm font-semibold">{value}</p></div>)}</div>
        <button type="button" className="ht-button-secondary" disabled={report.loading} onClick={report.retry}>Recheck current evidence</button>
        <InventoryExceptionReview title="Entries posted after this period closed" issues={result.postClosureIssues || []} hotelUid={hotelUid} locationId={locationId} stockCountId={closingId} />
        <InventoryExceptionReview title="Coverage and cutoff warnings" issues={result.exceptionDetails || result.coverage.issues} hotelUid={hotelUid} locationId={locationId} stockCountId={closingId} />
        {classified ? <>
          <div className="overflow-x-auto rounded-xl border border-slate-200"><table aria-label="Classified period quantities" className="w-full text-left text-sm"><thead className="bg-slate-50 text-xs text-slate-600"><tr>{["Catalog product", "Unit", "Opening", "Net receipts", "Transfers in", "Transfers out", "Registered waste", "Breakage", "Physical returns", "Closing", "Residual difference"].map((label) => <th key={label} className="whitespace-nowrap px-3 py-3">{label}</th>)}</tr></thead><tbody>{result.items.map((item) => <tr key={item.catalogProductId} className="border-t border-slate-100"><th scope="row" className="px-3 py-3 font-medium">{item.catalogProductName || "Unnamed catalog product"}</th><td className="px-3 py-3">{item.baseUnit}</td>{["openingQuantity", "netReceiptQuantity", "transferInQuantity", "transferOutQuantity", "wasteQuantity", "breakageQuantity", "physicalReturnQuantity", "closingQuantity", "residualQuantity"].map((key) => <td key={key} className="px-3 py-3 tabular-nums">{formatInventoryQuantity(item[key])}</td>)}</tr>)}</tbody></table></div>
          <details className="min-w-0 rounded-xl border border-slate-200 p-4"><summary className="cursor-pointer text-sm font-semibold">Estimated source values</summary><p className="mt-3 text-xs leading-5 text-slate-500">Opening + receipts + transfers in − transfers out − waste − breakage − physical returns − closing = residual estimated value. Sources use their explicit frozen net values; no weighted-average cost is invented. Unknown source costs or currencies leave the residual value unavailable.</p>
            <div className="mt-3 overflow-x-auto"><table aria-label="Classified period source values" className="w-full text-left text-sm"><thead><tr>{["Catalog product", "Opening", "Net receipts", "Transfers in", "Transfers out", "Waste", "Breakage", "Physical returns", "Closing", "Residual estimated value"].map((label) => <th key={label} className="whitespace-nowrap px-3 py-3">{label}</th>)}</tr></thead><tbody>{result.items.map((item) => <tr key={item.catalogProductId} className="border-t"><th scope="row" className="px-3 py-3 font-medium">{item.catalogProductName || "Unnamed catalog product"}</th>{["openingValue", "receiptValue", "transferInValue", "transferOutValue", "wasteValue", "breakageValue", "physicalReturnValue", "closingValue", "residualValue"].map((key) => <td key={key} className="px-3 py-3 tabular-nums">{formatInventoryValue(key === "residualValue" && !result.currentlyComplete ? null : item[key], result.currency)}</td>)}</tr>)}</tbody></table></div>
          </details>
        </> : <div className="overflow-x-auto rounded-xl border border-slate-200"><table aria-label="Original receipts-only quantities" className="w-full text-left text-sm"><thead className="bg-slate-50 text-xs text-slate-600"><tr>{["Catalog product", "Unit", "Opening", "Net receipts", "Closing", "Inferred usage", "Estimated cost / unit", "Estimated usage value"].map((label) => <th key={label} className="px-3 py-3">{label}</th>)}</tr></thead><tbody>{result.items.map((item) => <tr key={item.catalogProductId} className="border-t border-slate-100"><th scope="row" className="px-3 py-3 font-medium">{item.catalogProductName || "Unnamed catalog product"}</th><td className="px-3 py-3">{item.baseUnit}</td>{[item.openingQuantity, item.netReceiptQuantity, item.closingQuantity, item.inferredUsageQuantity].map((quantity, index) => <td key={index} className="px-3 py-3 tabular-nums">{formatInventoryQuantity(quantity)}</td>)}<td className="px-3 py-3 tabular-nums">{formatInventoryUnitCost(result.currentlyComplete ? item.periodUnitCost : null, result.currency)}</td><td className="px-3 py-3 tabular-nums">{formatInventoryValue(result.currentlyComplete ? item.inferredUsageValue : null, result.currency)}</td></tr>)}</tbody></table></div>}
        <p className="text-xs leading-5 text-slate-500">{classified ? "Classifications explain registered physical events only. A residual is neither guaranteed sales consumption nor a live balance. Reconciliation and late-cutoff warnings must be resolved before relying on the analysis." : "V1 costs remain period-weighted estimates when the opening cost and every relevant receipt cost are known in the hotel currency. The historical snapshot is not migrated to V2."}</p>
      </Card>}
    </ProcurementPage>
  </div>;
}
