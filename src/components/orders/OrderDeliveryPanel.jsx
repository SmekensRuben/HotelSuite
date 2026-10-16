import React, { useCallback, useEffect, useRef, useState } from "react";
import { auth } from "../../firebaseConfig";
import { getHotelOrderDelivery, reviewOrderDelivery } from "../../services/firebaseOrders";
import { useScopedAsync } from "../../hooks/useScopedAsync";
import { usePermission } from "../../hooks/usePermission";
import AsyncError from "../shared/AsyncError";

const sources = { "email-provider": "Email provider receipt", "sftp-transfer": "SFTP transfer receipt", "supplier-contact": "Supplier contact", "configuration-review": "Configuration review" };
const actions = { "record-receipt": "Record verified delivery receipt", "record-review": "Record findings only", "retry-preparation": "Retry preparation" };
const descriptions = {
  "preparation-failed": ["Preparation failed before sending", "No external send was attempted. Review the reported configuration or access problem. A delivery recovery manager who is also a designated outlet approver can then retry preparation using the original order details."],
  "unknown": ["Delivery outcome unknown", "The order may already have been sent. Do not create a replacement order or send it again. Check the email provider receipt or the supplier's SFTP file using this order and dispatch reference. Ask the supplier to verify receipt if transport evidence is unavailable. Record verified receipt evidence, or save findings while the outcome remains unresolved."],
  "receipt-verified": ["Supplier receipt verified", "An authorized reviewer recorded evidence that the supplier received this order. Receipt does not confirm commercial acceptance. Record the supplier’s acceptance or proposed changes in Supplier confirmation below."],
  "transport-accepted": ["Transport accepted the order", "The email provider accepted the message or the SFTP transfer completed. This does not confirm that the supplier accepted the order. Record supplier responses in Supplier confirmation below."],
  "in-progress": ["Delivery in progress", "Wait for the delivery worker and refresh this review. Do not resend or create a replacement order. If processing stalls, a delivery recovery manager can review the evidence after the worker review window."],
  "legacy-review": ["Legacy delivery needs review", "The original dispatch evidence is unavailable. Ask a platform operator to inspect the historical delivery before taking further action."],
  "simulated": ["Simulated delivery", "This simulated order did not contact a supplier."],
};
function savedCommand(key, hotelUid, orderId) {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const value = JSON.parse(raw);
    if (value?.hotelUid !== hotelUid || value?.orderId !== orderId || !Object.hasOwn(actions, value.action)
      || !Object.hasOwn(sources, value.source) || !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0
      || typeof value.requestId !== "string" || !value.requestId || typeof value.reason !== "string" || typeof value.evidence !== "string") return { corrupt: true };
    return value;
  } catch { return { corrupt: true }; }
}
export default function OrderDeliveryPanel(props) {
  const actorUid = auth.currentUser?.uid || "";
  return <ScopedDelivery key={`${props.hotelUid}:${props.orderId}:${actorUid}`} {...props} actorUid={actorUid} />;
}
function ScopedDelivery({ hotelUid, orderId, actorUid, orderRevision, onChanged, isPlatformAdmin = false, disabled = false }) {
  const permitted = usePermission("orders", "recover"), canRecover = permitted || isPlatformAdmin;
  const key = `delivery-recovery:${actorUid}:${hotelUid}:${orderId}`;
  const [pending, setPending] = useState(() => savedCommand(key, hotelUid, orderId));
  const [form, setForm] = useState({ action: "record-review", source: "", evidence: "", reason: "" });
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(null), [older, setOlder] = useState([]), [cursor, setCursor] = useState(null), [paging, setPaging] = useState(false);
  const mounted = useRef(false), pageSequence = useRef(0), commandBusy = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; pageSequence.current++; }; }, []);
  const load = useCallback(async () => {
    const result = await getHotelOrderDelivery({ hotelUid, orderId });
    if (Number.isSafeInteger(orderRevision) && result.orderRevision < orderRevision) throw new Error("Delivery review is older than this order. Refresh before recovery.");
    return result;
  }, [hotelUid, orderId, orderRevision]);
  const query = useScopedAsync({ scopeKey: `${hotelUid}:${orderId}:${orderRevision}`, load });
  const data = query.data;
  useEffect(() => { pageSequence.current++; setPaging(false); setOlder([]); setCursor(data?.nextCursor || null); }, [data]);
  const refresh = async () => { pageSequence.current++; setPaging(false); return query.run(); };
  const execute = async (command) => {
    if (commandBusy.current || disabled || !canRecover || !actorUid || command.corrupt) return;
    commandBusy.current = true; setBusy(true); setMessage(null);
    try { sessionStorage.setItem(key, JSON.stringify(command)); }
    catch { commandBusy.current = false; setBusy(false); setMessage("Browser storage is unavailable. No recovery request was sent."); return; }
    setPending(command);
    try {
      await reviewOrderDelivery(command);
      sessionStorage.removeItem(key);
      if (!mounted.current) return;
      setPending(null); setForm({ action: "record-review", source: "", evidence: "", reason: "" });
      setMessage("Recovery evidence recorded. Review the refreshed delivery state before taking another action.");
      await Promise.all([refresh(), onChanged?.()]);
    } catch (error) {
      if (!mounted.current) return;
      if (error?.details?.deliveryRequestUncommitted === true) {
        sessionStorage.removeItem(key); setPending(null); setMessage(error.message); await refresh();
      } else setMessage("The recovery result could not be confirmed. Retry the same saved recovery request; do not send the order again.");
    } finally { commandBusy.current = false; if (mounted.current) setBusy(false); }
  };
  const more = async () => {
    if (!cursor || paging) return;
    const sequence = ++pageSequence.current; setPaging(true);
    try {
      const result = await getHotelOrderDelivery({ hotelUid, orderId, afterEventId: cursor });
      if (!mounted.current || sequence !== pageSequence.current) return;
      if (result.orderRevision !== data.orderRevision || result.nextCursor === cursor) throw new Error("Delivery history changed. Refresh before continuing.");
      setOlder((previous) => [...previous, ...result.events]); setCursor(result.nextCursor);
    } catch (error) { if (mounted.current && sequence === pageSequence.current) setMessage(error.message); }
    finally { if (mounted.current && sequence === pageSequence.current) setPaging(false); }
  };
  const allowed = data ? { "record-receipt": data.canRecordReceipt, "retry-preparation": data.canRetryPreparation, "record-review": data.canRecordReview } : {};
  const blocked = busy || disabled || query.loading || Boolean(query.error) || Boolean(pending) || !canRecover || !actorUid;
  const description = descriptions[data?.outcome];
  return <section id="order-recovery" aria-label="Delivery review" className="ht-panel mt-6 space-y-4 p-5 sm:p-6">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-xl font-semibold">Delivery review</h2><button type="button" className="ht-button-secondary" disabled={busy || query.loading} onClick={refresh}>Refresh delivery</button></div>
    <AsyncError error={query.error} onRetry={refresh} label="Could not load delivery evidence." />
    {query.loading && <p role="status">Loading delivery evidence...</p>}
    {message && <p role="status" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">{message}</p>}
    {pending && <div role="alert" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm"><p>{pending.corrupt ? "The saved recovery request cannot be read. Review the audit history with your delivery recovery manager before recovering this browser session." : "A recovery request is awaiting a confirmed result. Its original evidence, reason and request ID are preserved."}</p>
      {!pending.corrupt && <><p className="mt-2">{actions[pending.action]} · {sources[pending.source]} · {pending.evidence}</p><button type="button" className="ht-button-secondary mt-3" disabled={busy || disabled || !canRecover} onClick={() => execute(pending)}>Retry saved recovery request</button></>}</div>}
    {data && <>
      {description && <div className="rounded-lg bg-slate-50 p-4"><h3 className="font-semibold">{description[0]}</h3><p className="mt-2 text-sm leading-6">{description[1]}</p></div>}
      <p className="break-all text-xs text-slate-600">Order reference: {orderId} · Dispatch reference: {data.dispatchId || "Unavailable"}</p>
      {data.error && <p className="text-sm text-amber-900">Reported problem: {data.error}</p>}
      {(data.providerId || data.remotePath) && <p className="break-all text-sm">Transport evidence: {data.providerId || data.remotePath}</p>}
      {data.canRecordReview && !canRecover && <p className="text-sm">Ask a hotel user with orders.recover permission to review delivery. Preparation retries also require orders.approve and designation as this outlet's approver.</p>}
      {canRecover && data.canRecordReview && <form className="space-y-3 rounded-lg border p-4" onSubmit={(event) => {
        event.preventDefault();
        if (blocked || !allowed[form.action] || !form.source || !form.evidence.trim() || !form.reason.trim()) return;
        execute({ ...form, hotelUid, orderId, requestId: crypto.randomUUID(), expectedRevision: data.orderRevision });
      }}><h3 className="font-semibold">Record recovery evidence</h3><fieldset disabled={blocked} className="space-y-3">
        <label className="block text-sm font-medium">Recovery action<select className="ht-field mt-1" value={form.action} onChange={(event) => setForm({ ...form, action: event.target.value, source: event.target.value === "retry-preparation" ? "configuration-review" : event.target.value === "record-receipt" ? data.method === "sftp" ? "sftp-transfer" : "email-provider" : "" })}>
          {Object.entries(actions).filter(([action]) => allowed[action]).map(([action, label]) => <option key={action} value={action}>{label}</option>)}
        </select></label>
        <label className="block text-sm font-medium">Evidence source<select required className="ht-field mt-1" value={form.source} onChange={(event) => setForm({ ...form, source: event.target.value })}><option value="">Choose evidence source</option>{Object.entries(sources).filter(([source]) => form.action === "retry-preparation" ? source === "configuration-review" : form.action === "record-receipt" ? source === "supplier-contact" || source === (data.method === "sftp" ? "sftp-transfer" : "email-provider") : true).map(([source, label]) => <option key={source} value={source}>{label}</option>)}</select></label>
        <label className="block text-sm font-medium">Evidence reference or findings<textarea required maxLength={1000} className="ht-field mt-1" value={form.evidence} onChange={(event) => setForm({ ...form, evidence: event.target.value })} /></label>
        <label className="block text-sm font-medium">Recovery reason<textarea required maxLength={500} className="ht-field mt-1" value={form.reason} onChange={(event) => setForm({ ...form, reason: event.target.value })} /></label>
        <p className="text-xs text-slate-600">Use a receipt ID or stable remote file reference. For a supplier receipt, include who confirmed receipt, when, and the original order reference. Do not enter credentials. Recording a delivery receipt does not record supplier acceptance. Findings alone do not prove delivery.</p>
        <button type="submit" className="ht-button-primary" disabled={!allowed[form.action] || !form.source || !form.evidence.trim() || !form.reason.trim()}>Save recovery action</button>
      </fieldset></form>}
      <div><h3 className="font-semibold">Recovery history</h3>{![...data.events, ...older].length && <p className="mt-2 text-sm text-slate-600">No recovery decisions in this history page.</p>}<ol className="mt-3 space-y-3">{[...data.events, ...older].map((event) => <li key={event.id} className="rounded-lg border p-3 text-sm"><p className="font-medium">{actions[event.action]} · {sources[event.source] || "Legacy evidence"}</p><p className="mt-1">Evidence: {event.evidence}</p><p>Reason: {event.reason}</p><p className="mt-2 break-all text-xs text-slate-600">By {event.actorUid} · {event.createdAtMillis == null ? "Unknown time" : new Date(event.createdAtMillis).toLocaleString("en-GB")} · Revision {event.revision} · Dispatch {event.dispatchId}</p></li>)}</ol>{cursor && <button type="button" className="ht-button-secondary mt-3" disabled={paging || busy || query.loading} onClick={more}>{paging ? "Loading history..." : "Load older recovery history"}</button>}</div>
    </>}
  </section>;
}
