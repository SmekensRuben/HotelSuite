import React, { useState } from "react";
import { manageHotelDemoData, platformError } from "../../services/firebasePlatform";
import { usePlatformQuery, usePlatformScope } from "../../hooks/usePlatformQuery";
import { QueryState, primary, button, panel } from "./PlatformShared";

export default function HotelDemoDataPanel({ hotelUid, onLoaded }) {
  return hotelUid === "test-hotel-2" ? <DemoData hotelUid={hotelUid} onLoaded={onLoaded} /> : null;
}
function DemoData({ hotelUid, onLoaded }) {
  const query = usePlatformQuery(() => manageHotelDemoData(hotelUid, "preview"), hotelUid);
  const capture = usePlatformScope(hotelUid);
  const [acknowledged, setAcknowledged] = useState(false), [busy, setBusy] = useState(false), [message, setMessage] = useState(null);
  const load = async () => {
    if (busy || !acknowledged || !query.data?.canApply) return;
    const current = capture(); setBusy(true); setMessage(null);
    try {
      await manageHotelDemoData(hotelUid, "apply");
      if (!current()) return;
      await query.refresh();
      if (current()) { onLoaded?.(); setMessage({ text: "Demo data loaded. Sign in with your test-hotel user to try the purchasing and inventory workflows." }); }
    } catch (error) {
      if (current()) setMessage({ error: true, text: `${platformError(error)} Refresh demo status before retrying: an uncertain request may already have completed. Repeating this dataset never overwrites your changes.` });
    } finally { if (current()) setBusy(false); }
  };
  const summary = query.data?.summary;
  return <section className={`${panel} xl:col-span-2`}>
    <h2 className="text-lg font-semibold">Test-hotel-2 demo dataset</h2>
    <p className="mt-3 text-sm text-slate-600">Add fictional DEMO products, suppliers, locations, orders and counts to this test hotel. Existing records, users and subscriptions are preserved. There is no automatic reset.</p>
    <p className="mt-2 text-sm text-amber-900">Orders using these demo suppliers are always simulated, even after editing their contact details. No supplier email or SFTP delivery is sent.</p>
    {message && <p role={message.error ? "alert" : "status"} className="mt-3 text-sm">{message.text}</p>}
    <QueryState query={query}>{summary && <div className="mt-4 space-y-3">
      <dl className="grid gap-3 text-sm sm:grid-cols-3">{[["catalogProducts", "Catalog products"], ["supplierProducts", "Supplier products"], ["suppliers", "Suppliers"], ["outlets", "Outlets"], ["locations", "Physical locations"], ["orders", "Orders"], ["stockCounts", "Stock counts"], ["receipts", "Receiving events"], ["inventoryMovements", "Inventory movements"]].map(([key, label]) => <div key={key}><dt className="text-slate-500">{label}</dt><dd className="font-semibold">{summary[key] ?? "Unavailable"}</dd></div>)}</dl>
      <p className="text-sm">Examples include alternative suppliers, pack sizes, gross/net prices, free samples, unknown prices, partial receipts, reversals, finished and unfinished counts. Dates are anchored to {query.data.businessDate} ({query.data.timeZone || "demo time zone unavailable"}).</p>
      {summary.approvers === 0 && <p className="text-sm text-amber-900">No enabled hotel administrator with orders.approve was found. Configure designated outlet approvers before confirming new orders.</p>}
      {query.data.alreadyLoaded ? <p role="status" className="text-sm font-medium">This dataset is already loaded. Your subsequent edits are preserved.</p> : <>
        {!query.data.canApply && <div role="alert"><p className="text-sm">Demo IDs already exist without a completed seed receipt. No data will be overwritten.</p><ul className="mt-2 text-xs">{(query.data.conflicts || []).map((path) => <li key={path}>{path}</li>)}</ul></div>}
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={acknowledged} disabled={busy || !query.data.canApply} onChange={(event) => setAcknowledged(event.target.checked)} />I understand these are fictional test records and are added only to test-hotel-2.</label>
        <button type="button" disabled={busy || !acknowledged || !query.data.canApply} className={primary} onClick={load}>{busy ? "Loading demo data…" : "Load demo dataset"}</button>
      </>}
      <button type="button" disabled={busy || query.loading} className={`${button} ml-2`} onClick={query.refresh}>Refresh demo status</button>
      <p className="text-sm text-slate-600">After loading, choose the DEMO Kitchen store and DEMO opening/closing counts in Inventory periods. Milk has 100 l opening + 30 l received − 80 l closing = 50 l inferred usage. The bar example retains an unknown juice cost.</p>
    </div>}</QueryState>
  </section>;
}
