import React, { useCallback, useEffect, useRef, useState } from "react";
import { auth } from "../../firebaseConfig";
import { getHotelOrderReceiving, recordHotelOrderReceipt, reverseHotelOrderReceipt, finalizeHotelOrderReceiving } from "../../services/firebaseOrders";
import { useScopedAsync } from "../../hooks/useScopedAsync";
import { usePermission } from "../../hooks/usePermission";
import AsyncError from "../shared/AsyncError";
import { Combobox } from "../ui/combobox";

const field = "ht-field mt-1";
const kinds = { receipt: recordHotelOrderReceipt, reversal: reverseHotelOrderReceipt, finalization: finalizeHotelOrderReceiving };
const lineKey = (line) => line.orderLineId || line.supplierProductId;
function readPending(key, hotelUid, orderId) {
  try {
    const saved = sessionStorage.getItem(key);
    if (!saved) return null;
    const command = JSON.parse(saved);
    if (!Object.hasOwn(kinds, command.kind) || command.input?.hotelUid !== hotelUid || command.input?.orderId !== orderId
      || typeof command.input?.requestId !== "string" || !command.input.requestId || command.input.requestId.length > 128
      || !Number.isSafeInteger(command.input?.expectedRevision) || command.input.expectedRevision < 0) return { corrupt: true };
    return command;
  } catch { return { corrupt: true }; }
}
const moment = (value) => value == null ? "Unknown time" : new Date(value).toLocaleString("en-GB");
export default function OrderReceivingPanel(props) {
  const actorUid = auth.currentUser?.uid || "";
  return <ScopedReceiving key={`${props.hotelUid}:${props.orderId}:${actorUid}`} {...props} actorUid={actorUid} />;
}
function ScopedReceiving({ hotelUid, orderId, actorUid, orderRevision, onChanged, disabled = false }) {
  const canReceive = usePermission("orders", "receive"), canFinalize = usePermission("orders", "finalize");
  const key = `receiving-request:${actorUid}:${hotelUid}:${orderId}`;
  const [pending, setPending] = useState(() => readPending(key, hotelUid, orderId));
  const [form, setForm] = useState({ receivedOn: "", deliveryReference: "", inventoryLocationId: "", note: "", lines: {} });
  const [finalReason, setFinalReason] = useState(""), [acceptShortfall, setAcceptShortfall] = useState(false);
  const [reverseId, setReverseId] = useState(null), [reverseReason, setReverseReason] = useState("");
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(null);
  const [older, setOlder] = useState([]), [cursor, setCursor] = useState(null), [moreBusy, setMoreBusy] = useState(false), [moreError, setMoreError] = useState(null);
  const mounted = useRef(false), paging = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; paging.current++; }; }, []);
  const load = useCallback(async () => {
    const result = await getHotelOrderReceiving({ hotelUid, orderId });
    if (Number.isSafeInteger(orderRevision) && result.orderRevision < orderRevision) throw new Error("Receiving is older than this order. Refresh before recording goods.");
    return result;
  }, [hotelUid, orderId, orderRevision]);
  const query = useScopedAsync({ scopeKey: `${hotelUid}:${orderId}:${orderRevision ?? "legacy"}`, load });
  const data = query.data;
  useEffect(() => {
    if (data) {
      setCursor(data.nextCursor); setOlder([]); setMoreError(null);
      setForm((previous) => ({ ...previous, receivedOn: previous.receivedOn || data.today || "" }));
    }
  }, [data]);
  const refresh = async () => { paging.current++; setMoreBusy(false); setOlder([]); setMoreError(null); return query.run(); };
  const execute = async (command) => {
    if (busy || disabled || !actorUid || command.corrupt) return;
    setBusy(true); setMessage(null);
    try { sessionStorage.setItem(key, JSON.stringify(command)); }
    catch {
      setBusy(false); setMessage({ error: true, text: "This browser could not preserve the receiving request. No request was sent. Check browser storage before continuing." });
      return;
    }
    setPending(command);
    try {
      // Persist before calling: an uncertain response keeps the exact ID, payload and revision.
      await kinds[command.kind](command.input);
      sessionStorage.removeItem(key);
      if (!mounted.current) return;
      setPending(null); setReverseId(null); setReverseReason(""); setFinalReason(""); setAcceptShortfall(false);
      setForm({ receivedOn: data?.today || "", deliveryReference: "", inventoryLocationId: "", note: "", lines: {} });
      setMessage({ text: command.kind === "receipt" ? "Goods receipt recorded." : command.kind === "reversal" ? "Receipt reversed; the original remains in history." : "Receiving finalized." });
      await Promise.all([refresh(), onChanged?.()]);
    } catch (error) {
      if (!mounted.current) return;
      if (error?.details?.receivingRequestUncommitted === true) {
        sessionStorage.removeItem(key); setPending(null);
        setMessage({ error: true, text: error.message });
        await refresh();
      } else {
        setMessage({ error: true, text: "The result could not be confirmed. Retry the same saved request before entering another receipt." });
      }
    } finally { if (mounted.current) setBusy(false); }
  };
  const submit = (kind, details) => execute({ kind, input: { hotelUid, orderId, requestId: crypto.randomUUID(), expectedRevision: data.orderRevision, ...details } });
  const loadMore = async () => {
    if (!cursor || moreBusy) return;
    const sequence = ++paging.current;
    setMoreBusy(true); setMoreError(null);
    try {
      const next = await getHotelOrderReceiving({ hotelUid, orderId, afterEventId: cursor });
      if (!mounted.current || sequence !== paging.current) return;
      if (next.orderRevision !== data.orderRevision) throw new Error("The order changed while loading history. Refresh receiving before continuing.");
      if (next.nextCursor === cursor) throw new Error("Receiving history did not advance. Refresh before continuing.");
      setOlder((previous) => [...previous, ...next.events]); setCursor(next.nextCursor);
    } catch (error) { if (mounted.current && sequence === paging.current) setMoreError(error); }
    finally { if (mounted.current && sequence === paging.current) setMoreBusy(false); }
  };
  const available = data?.availability === "available";
  const closed = data?.status === "Finalized";
  const blocked = disabled || busy || Boolean(pending) || query.loading || Boolean(query.error) || moreBusy || Boolean(moreError) || !available || closed || !data?.releaseReady || !actorUid;
  const events = [...(data?.events || []), ...older];
  const hasShortfall = data?.lines?.some((line) => line.outstandingQuantity > 0);
  const hasDiscrepancies = data?.lines?.some((line) => line.outstandingQuantity > 0 || line.excessQuantity > 0 || line.rejectedQuantity > 0);
  const setLine = (id, name, value) => setForm((previous) => ({ ...previous, lines: { ...previous.lines, [id]: { ...previous.lines[id], [name]: value } } }));
  return <section className="ht-panel mt-6 space-y-5 p-5 sm:p-6" aria-label="Goods receiving">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-xl font-semibold">Goods receiving</h2>
      <p className="mt-2 text-sm text-slate-600">Enter quantities in the purchase units recorded on this order. Accepted goods are converted to the frozen catalog unit for receipt evidence. Rejected goods remain separate; physical stock counts use catalog units.</p></div>
      <button type="button" className="ht-button-secondary" disabled={busy || query.loading} onClick={refresh}>Refresh receiving</button></div>
    {message && <p role={message.error ? "alert" : "status"} className={`rounded-xl border p-4 text-sm ${message.error ? "border-amber-200 bg-amber-50" : "border-emerald-200 bg-emerald-50"}`}>{message.text}</p>}
    {pending && <div role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm">
      <p>{pending.corrupt ? "The saved receiving request cannot be read. Review receiving history before recovering this browser session." : "A saved receiving request needs confirmation. Its original quantities and revision are preserved."}</p>
      {!pending.corrupt && <button type="button" className="ht-button-secondary mt-3" disabled={busy || disabled || (pending.kind === "receipt" ? !canReceive : !canFinalize)} onClick={() => execute(pending)}>Retry saved receiving request</button>}
    </div>}
    <AsyncError error={query.error} onRetry={refresh} label="Could not load receiving history." />
    {query.loading && <p role="status" className="text-sm text-slate-600">Loading receiving...</p>}
    {data && <>
      {!data.releaseReady && <p role="alert" className="text-sm text-amber-900">Receiving changes await the verified platform activation.</p>}
      {!available && <p role="status" className="rounded-xl bg-amber-50 p-4 text-sm text-amber-900">{data.reason}</p>}
      {available && <>
        {data.supplierReceiptBlockReason && <p role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">{data.supplierReceiptBlockReason} Rejected-only deliveries, receipt reversals and explicit supervisor closure remain available.</p>}
        <p className="text-sm font-medium">Receiving status: {data.receivingState}</p>
        <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="border-b"><th className="p-2">Product / unit</th><th className="p-2">Ordered</th><th className="p-2">Accepted</th><th className="p-2">Rejected</th><th className="p-2">Outstanding</th><th className="p-2">Overdelivery</th></tr></thead>
          <tbody>{data.lines.map((line) => <tr key={lineKey(line)} className="border-b"><th scope="row" className="p-2 font-medium">{line.productName}<span className="mt-1 block text-xs text-slate-500">{line.purchaseUnit}</span>{typeof line.supplierConfirmedQuantity === "number" && <span className="mt-1 block text-xs text-slate-500">Supplier confirmed: {line.supplierConfirmedQuantity} · still promised: {line.supplierOutstandingQuantity}</span>}</th>
            {["orderedQuantity", "acceptedQuantity", "rejectedQuantity", "outstandingQuantity", "excessQuantity"].map((column) => <td key={column} className="p-2 tabular-nums">{line[column]}</td>)}</tr>)}</tbody></table></div>
        {closed && <p className="rounded-xl bg-slate-50 p-4 text-sm">Receiving is finalized. {data.finalizationReason && `Reason: ${data.finalizationReason}`}</p>}
        {canReceive && !closed && <form className="space-y-4 rounded-xl border border-slate-200 p-4" onSubmit={(event) => {
          event.preventDefault(); if (blocked) return;
          const lines = data.lines.map((line) => ({ supplierProductId: line.supplierProductId,
            ...(line.orderLineId ? { orderLineId: line.orderLineId } : {}),
            acceptedQuantity: Number(form.lines[lineKey(line)]?.acceptedQuantity || 0),
            rejectedQuantity: Number(form.lines[lineKey(line)]?.rejectedQuantity || 0), reason: form.lines[lineKey(line)]?.reason || "" }))
            .filter((line) => line.acceptedQuantity !== 0 || line.rejectedQuantity !== 0);
          if (!form.deliveryReference.trim() || !lines.length) { setMessage({ error: true, text: "Enter a delivery reference and at least one accepted or rejected quantity." }); return; }
          if (data.supplierReceiptBlockReason && lines.some((line) => line.acceptedQuantity > 0)) { setMessage({ error: true, text: data.supplierReceiptBlockReason }); return; }
          const date = new Date(`${form.receivedOn}T00:00:00Z`);
          if (!/^\d{4}-\d{2}-\d{2}$/.test(form.receivedOn) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== form.receivedOn) {
            setMessage({ error: true, text: "Choose a valid receipt business date." }); return;
          }
          if (lines.some((line) => [line.acceptedQuantity, line.rejectedQuantity].some((value) => !Number.isFinite(value) || value < 0 || value > 100000 || Math.abs(value * 1000 - Math.round(value * 1000)) > 1e-7)
            || (line.rejectedQuantity > 0 || line.acceptedQuantity > data.lines.find((source) => lineKey(source) === lineKey(line)).outstandingQuantity
              || typeof data.lines.find((source) => lineKey(source) === lineKey(line)).supplierOutstandingQuantity === "number"
                && line.acceptedQuantity > data.lines.find((source) => lineKey(source) === lineKey(line)).supplierOutstandingQuantity) && !line.reason.trim())) {
            setMessage({ error: true, text: "Review quantities and explain rejected goods or accepted overdelivery." }); return;
          }
          if (lines.some((line) => line.acceptedQuantity > 0) && !form.inventoryLocationId) {
            setMessage({ error: true, text: "Select the physical location receiving these goods." }); return;
          }
          submit("receipt", { receivedOn: form.receivedOn, deliveryReference: form.deliveryReference, note: form.note, lines,
            ...(form.inventoryLocationId ? { inventoryLocationId: form.inventoryLocationId } : {}) });
        }}><h3 className="font-semibold">Record a delivery</h3>
          <fieldset disabled={blocked} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2"><label className="text-sm font-medium">Receipt business date<input required type="date" className={field} value={form.receivedOn} onChange={(event) => setForm({ ...form, receivedOn: event.target.value })} /></label>
              <label className="text-sm font-medium">Delivery note / receipt reference<input required maxLength={120} className={field} value={form.deliveryReference} onChange={(event) => setForm({ ...form, deliveryReference: event.target.value })} /></label></div>
            <p className="text-xs text-slate-500">Use a unique delivery reference for this order. A reversed receipt retains its reference; use a new correction reference.</p>
            <label className="block text-sm font-medium">Physical receiving location
              <Combobox aria-label="Physical receiving location" options={data.inventoryLocations || []} value={(data.inventoryLocations || []).find((location) => location.id === form.inventoryLocationId) || null} onChange={(location) => setForm({ ...form, inventoryLocationId: location?.id || "" })} displayValue={(location) => location.stockPointType === "outlet"
                ? `${location.name} · ${location.inventoryRole === "central_storage" ? "Central store" : "Entire outlet"}`
                : location.outletName ? `${location.outletName} / ${location.name}` : location.name || "Unnamed location"} getOptionValue={(location) => location.id} placeholder="Choose an outlet, central store or location" disabled={blocked} className={field} />
            </label>
            {data.inventoryLocationsTruncated && <p className="text-sm text-amber-900">The stock point list is incomplete. Ask a hotel administrator to review the receiving destination.</p>}
            {data.inventoryCoverageReasons?.length > 0 && <p className="text-sm text-amber-900">Some frozen product conversions or price contracts need review. Receiving remains traceable; affected inventory quantities or values will be unavailable in period comparisons.</p>}
            <p className="text-xs text-slate-500">Accepted goods create receipt evidence for this location. This does not represent live on-hand stock.</p>
            <button type="button" className="ht-button-secondary" onClick={() => setForm((previous) => ({ ...previous, lines: Object.fromEntries(data.lines.map((line) => [lineKey(line), { ...previous.lines[lineKey(line)], acceptedQuantity: String(line.supplierOutstandingQuantity ?? line.outstandingQuantity) }])) }))}>Fill outstanding quantities</button>
            {data.lines.map((line) => {
              const values = form.lines[lineKey(line)] || {};
              const needsReason = Number(values.rejectedQuantity || 0) > 0 || Number(values.acceptedQuantity || 0) > line.outstandingQuantity
                || typeof line.supplierOutstandingQuantity === "number" && Number(values.acceptedQuantity || 0) > line.supplierOutstandingQuantity;
              return <div key={lineKey(line)} className="rounded-xl bg-slate-50 p-3"><p className="text-sm font-semibold">{line.productName} · {line.purchaseUnit}</p>
                <div className="mt-2 grid gap-3 sm:grid-cols-2"><label className="text-sm">Accepted {line.productName}<input type="number" min="0" max="100000" step="0.001" placeholder="0" className={field} value={values.acceptedQuantity || ""} onChange={(event) => setLine(lineKey(line), "acceptedQuantity", event.target.value)} /></label>
                  <label className="text-sm">Rejected {line.productName}<input type="number" min="0" max="100000" step="0.001" placeholder="0" className={field} value={values.rejectedQuantity || ""} onChange={(event) => setLine(lineKey(line), "rejectedQuantity", event.target.value)} /></label></div>
                <label className="mt-3 block text-sm">Discrepancy reason {line.productName}<input required={needsReason} maxLength={300} className={field} value={values.reason || ""} onChange={(event) => setLine(lineKey(line), "reason", event.target.value)} /></label>
              </div>;
            })}
            <label className="block text-sm">Receipt note<textarea maxLength={1000} className={field} value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} /></label>
            <button className="ht-button-primary" type="submit">Record goods receipt</button>
          </fieldset>
        </form>}
        {canFinalize && !closed && <form className="space-y-3 rounded-xl border border-amber-200 p-4" onSubmit={(event) => { event.preventDefault(); if (!blocked) submit("finalization", { acceptShortfall, reason: finalReason }); }}>
          <h3 className="font-semibold">Receiving supervisor review</h3><p className="text-sm text-slate-600">Review the history and discrepancies. Finalization closes receiving and preserves any outstanding quantities.</p>
          <fieldset disabled={blocked} className="space-y-3">
            {hasShortfall && <label className="flex items-start gap-3 text-sm"><input type="checkbox" required checked={acceptShortfall} onChange={(event) => setAcceptShortfall(event.target.checked)} />Close this order with its outstanding quantities explicitly acknowledged</label>}
            <label className="block text-sm">Finalization reason<textarea required={hasDiscrepancies} maxLength={1000} className={field} value={finalReason} onChange={(event) => setFinalReason(event.target.value)} /></label>
            <button type="submit" className="ht-button-primary">Finalize receiving</button>
          </fieldset>
        </form>}
      </>}
      <div><h3 className="font-semibold">Receiving history</h3>
        {!events.length && <p className="mt-2 text-sm text-slate-600">No receiving events recorded.</p>}
        <ol className="mt-3 space-y-3">{events.map((event) => <li key={event.id} className="rounded-xl border border-slate-200 p-4 text-sm">
          <div className="flex flex-wrap justify-between gap-2"><p className="font-semibold">{event.kind === "receipt" ? `Delivery ${event.deliveryReference}` : event.kind === "reversal" ? "Receipt reversal" : "Receiving finalized"}{event.reversed && " · reversed"}</p><time>{moment(event.createdAtMillis)}</time></div>
          <p className="mt-1 text-xs text-slate-500">Recorded by {event.actorName && event.actorName !== event.actorUid ? event.actorName : "Unknown user"}{event.receivedOn && ` · receipt date ${event.receivedOn}`}</p>
          {event.kind === "reversal" && <p className="mt-2 break-all text-xs">Original receipt: {event.receiptId}</p>}
          {event.lines.map((line) => <p key={lineKey(line)} className="mt-2">{line.productName}: {line.acceptedQuantity} accepted, {line.rejectedQuantity} rejected · {line.purchaseUnit}{line.reason && ` · ${line.reason}`}</p>)}
          {["receipt", "reversal"].includes(event.kind) && <p className="mt-2 text-xs text-slate-500">{event.inventoryMovement
            ? `Inventory posting ${event.inventoryMovement.sequence} · location ${event.inventoryMovement.locationId}`
            : "No inventory movement recorded; rejected-only or historical receiving evidence."}</p>}
          {(event.note || event.reason) && <p className="mt-2 whitespace-pre-wrap">{event.note || event.reason}</p>}
          {event.supplierResponseId && <p className="mt-2 text-xs text-slate-500">Receipt pricing is frozen from the supplier response and hotel review recorded before this delivery.</p>}
          {canFinalize && event.kind === "receipt" && !event.reversed && !closed && available && <button type="button" disabled={blocked} className="ht-button-secondary mt-3" onClick={() => { setReverseId(event.id); setReverseReason(""); }}>Reverse receipt {event.deliveryReference}</button>}
        </li>)}</ol>
        {moreError && <div role="alert" className="mt-3 text-sm"><p>{moreError.message}</p><button type="button" className="ht-button-secondary mt-2" onClick={loadMore}>Retry history page</button></div>}
        {cursor && <button type="button" className="ht-button-secondary mt-3" disabled={moreBusy || busy || query.loading} onClick={loadMore}>{moreBusy ? "Loading older receipts..." : "Load older receiving events"}</button>}
      </div>
      {reverseId && canFinalize && <form className="space-y-3 rounded-xl border border-amber-200 p-4" onSubmit={(event) => { event.preventDefault(); if (!blocked) submit("reversal", { receiptId: reverseId, reason: reverseReason }); }}>
        <h3 className="font-semibold">Reverse a recorded receipt</h3><p className="text-sm">This records a compensating event and retains the original delivery evidence.</p>
        <label className="block text-sm">Reversal reason<textarea required disabled={blocked} maxLength={1000} className={field} value={reverseReason} onChange={(event) => setReverseReason(event.target.value)} /></label>
        <div className="flex gap-3"><button type="submit" disabled={blocked} className="ht-button-primary">Confirm receipt reversal</button><button type="button" disabled={busy} className="ht-button-secondary" onClick={() => setReverseId(null)}>Cancel reversal</button></div>
      </form>}
    </>}
  </section>;
}
