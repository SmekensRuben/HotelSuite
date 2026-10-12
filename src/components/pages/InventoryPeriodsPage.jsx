import React, { useCallback, useEffect, useMemo, useState } from "react";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { useScopedAsync } from "../../hooks/useScopedAsync";
import { usePermission } from "../../hooks/usePermission";
import { getInventoryLocations, getInventoryCheckpoints, getInventoryPeriod } from "../../services/firebaseInventory";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
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
  const opening = choices.find((item) => item.stockCountId === openingId), closing = choices.find((item) => item.stockCountId === closingId);
  const validSelection = Boolean(opening && closing && opening.sequence < closing.sequence);
  const result = report.data;
  return <div className="min-h-screen bg-canvas text-gray-900">
    <HeaderBar today={today} onLogout={async () => { await signOut(auth); sessionStorage.clear(); window.location.href = "/login"; }} />
    <PageContainer className="space-y-6">
      <div><p className="text-sm uppercase tracking-wide text-gray-500">Catalog</p><h1 className="text-3xl font-semibold">Inventory periods</h1><p className="mt-1 text-gray-600">Compare physical counts and recorded receipts for one location.</p></div>
      <Card className="space-y-3"><p>Inferred usage = opening count + net recorded receipts − closing count.</p><p className="text-sm text-gray-600">This period difference cannot identify sales, waste or theft. It is not live stock. Receipts use their posting checkpoint; late or backdated entries are flagged. Complete location counts must use a consistent physical delivery cutoff.</p></Card>
      {!canRead && <p role="alert">Stock count read permission is required.</p>}
      {locations.error && <div role="alert"><p>{locations.error.message}</p><button onClick={locations.retry}>Retry locations</button></div>}
      <Card className="space-y-4"><label className="block text-sm font-medium">Physical location<select aria-label="Physical location" className="mt-1 w-full rounded border px-3 py-2" value={locationId} disabled={!canRead || locations.loading} onChange={(event) => setLocationId(event.target.value)}><option value="">Select location</option>{(locations.data || []).map((location) => <option key={location.locationId || location.id} value={location.locationId || location.id}>{location.locationName || location.name || location.locationId || location.id}</option>)}</select></label>
        {checkpoints.loading && <p>Loading completed count checkpoints...</p>}
        {checkpoints.error && <div role="alert"><p>{checkpoints.error.message}</p><button onClick={checkpoints.retry}>Retry completed counts</button></div>}
        {locationId && !checkpoints.loading && !checkpoints.error && choices.length < 2 && <p>At least two completed catalog counts are needed for this location. Historical supplier-based counts cannot be compared with this policy.</p>}
        <div className="grid gap-4 md:grid-cols-2">{[["Opening count", openingId, setOpeningId], ["Closing count", closingId, setClosingId]].map(([label, value, setter]) => <label key={label} className="text-sm font-medium">{label}<select aria-label={label} value={value} disabled={!locationId || checkpoints.loading} onChange={(event) => { setter(event.target.value); setSelection(null); }} className="mt-1 w-full rounded border px-3 py-2"><option value="">Select completed count</option>{choices.map((checkpoint) => <option key={checkpoint.id} value={checkpoint.stockCountId}>{checkpoint.stockCountName || checkpoint.stockCountId} · {checkpoint.businessDate} · #{checkpoint.sequence}</option>)}</select></label>)}</div>
        {openingId && closingId && !validSelection && <p role="alert">Closing count must follow the opening count at the same location.</p>}
        <button className="rounded bg-brand-800 px-4 py-2 text-white disabled:opacity-50" disabled={!canRead || !validSelection || report.loading} onClick={() => setSelection({ hotelUid, locationId, openingId, closingId })}>Compare counts</button>
      </Card>
      {report.loading && <p>Calculating recorded period evidence...</p>}
      {report.error && <div role="alert"><p>{report.error.message}</p><button onClick={report.retry}>Retry period report</button></div>}
      {result && <Card className="space-y-4"><h2 className="text-xl font-semibold">{result.opening.businessDate} → {result.closing.businessDate}</h2><p>{result.recordedReceiptCount} recorded receipt/reversal movements · Currency: {result.currency || "Unknown"}</p><p className="font-medium">Saved quantity coverage: {result.coverage.quantityComplete ? "Complete" : "Incomplete"} · Cost coverage: {result.coverage.costComplete ? "Complete" : "Incomplete"}</p>
        <p className="font-medium">Current period evidence: {result.currentlyComplete ? "Complete" : "Incomplete — review cutoff and late postings"}</p>
        {(result.postClosureIssues || []).length > 0 && <div role="alert" className="rounded bg-amber-50 p-3"><p className="font-semibold">Entries posted after this period closed</p><p>The saved calculation is unchanged. Its quantity and cost estimates are not currently validated against these late entries.</p><ul>{result.postClosureIssues.map((issue, index) => <li key={index}>{issue.detail || issue.code}</li>)}</ul></div>}
        {result.coverage.issues.length > 0 && <div role="alert" className="rounded bg-amber-50 p-3"><p className="font-medium">Coverage and cutoff warnings</p><ul>{result.coverage.issues.map((issue, index) => <li key={`${issue.code}:${index}`}>{issue.detail || issue.code}</li>)}</ul></div>}
        <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr>{["Catalog product", "Unit", "Opening", "Net receipts", "Closing", "Inferred usage", "Estimated cost / unit", "Estimated usage value"].map((label) => <th key={label} className="p-2">{label}</th>)}</tr></thead><tbody>{result.items.map((item) => <tr key={item.catalogProductId} className="border-t"><td className="p-2">{item.catalogProductName || item.catalogProductId}</td><td className="p-2">{item.baseUnit}</td>{[item.openingQuantity, item.netReceiptQuantity, item.closingQuantity, item.inferredUsageQuantity].map((quantity, index) => <td key={index} className="p-2">{formatInventoryQuantity(quantity)}</td>)}<td className="p-2">{formatInventoryUnitCost(result.currentlyComplete ? item.periodUnitCost : null, result.currency)}</td><td className="p-2">{formatInventoryValue(result.currentlyComplete ? item.inferredUsageValue : null, result.currency)}</td></tr>)}</tbody></table></div>
        <p className="text-sm text-gray-500">Costs are period-weighted estimates only when the opening cost and every relevant receipt cost are known in the hotel currency. Missing evidence remains unavailable.</p>
      </Card>}
    </PageContainer>
  </div>;
}
