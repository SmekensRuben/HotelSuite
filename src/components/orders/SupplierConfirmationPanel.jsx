import React, { useCallback, useEffect, useRef, useState } from "react";
import { auth } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { usePermission } from "../../hooks/usePermission";
import { useVerifiedRefresh } from "../../hooks/useVerifiedRefresh";
import { procurementReadScope } from "../../services/procurementReadPool";
import { getSupplierConfirmations, recordSupplierConfirmation, reviewSupplierConfirmation } from "../../services/firebaseSupplierConfirmations";
import { supplierResponseLabels, supplierConfirmationStatus } from "../../utils/supplierConfirmationDisplay";
import { formatOrderMoney, formatOrderPriceBasis } from "../../utils/orderPricing";
import AsyncError from "../shared/AsyncError";
import { ArticleRowsSkeleton, LoadingStatus } from "../ui/ResourceLoading";

const keyOf = (line) => line.orderLineId || line.supplierProductId;
const field = "ht-field mt-1";
const commands = { response: recordSupplierConfirmation, review: reviewSupplierConfirmation };
function readPending(key, hotelUid, orderId, actorUid) {
  try {
    const saved = sessionStorage.getItem(key);
    if (!saved) return null;
    const command = JSON.parse(saved), input = command.input;
    if (!Object.hasOwn(commands, command.kind) || input?.hotelUid !== hotelUid || input?.orderId !== orderId || input?.expectedActorUid !== actorUid
      || typeof input.requestId !== "string" || !input.requestId || input.requestId.length > 128
      || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0
      || !(command.kind === "response" ? input.response : input.review)) return { corrupt: true };
    return command;
  } catch { return { corrupt: true }; }
}
function initialForm(data) {
  return { responseType: "accepted", channel: "email", supplierReference: "", respondedOn: data.today || "", note: "",
    lines: Object.fromEntries(data.submittedLines.map((line) => [keyOf(line), { confirmedQuantity: String(line.orderedQuantity), deliveryDate: line.deliveryDate,
      priceMode: "as-ordered", pricePerPurchaseUnit: "", substitute: null, reason: "" }])) };
}
const time = (value) => value === null ? "Unknown recording time" : new Date(value).toLocaleString("en-GB");
function ResponseLines({ response }) {
  return <div className="space-y-3">{response.lines.map((line) => <div key={keyOf(line)} className="min-w-0 rounded-xl bg-slate-50 p-3 text-sm">
    <p className="break-words font-medium">{line.productName} · {line.purchaseUnit}</p>
    <div className="mt-2 grid gap-2 text-slate-700 sm:grid-cols-3">
      <p>Quantity: <strong>{line.confirmedQuantity}</strong><span className="mt-1 block text-xs text-slate-500">Submitted: {line.orderedQuantity}</span></p>
      <p>Delivery: <strong>{line.confirmedDeliveryDate || "Unknown"}</strong><span className="mt-1 block text-xs text-slate-500">Requested: {line.deliveryDate}</span></p>
      <p>Package price: <strong>{formatOrderMoney(line.pricePerPurchaseUnit, line.currency)}</strong><span className="mt-1 block text-xs text-slate-500">{formatOrderPriceBasis(line.priceBasis)} · submitted: {formatOrderMoney(line.orderedPrice, line.currency)}</span></p>
    </div>
    {line.substitute && <p className="mt-2 break-words text-amber-900">Replacement proposal: {line.substitute.description} · {line.substitute.supplierSku} · {line.substitute.purchaseUnit}. Original-product receipt conversion is blocked.</p>}
    {line.reason && <p className="mt-2 whitespace-pre-wrap break-words">{line.reason}</p>}
  </div>)}</div>;
}
export default function SupplierConfirmationPanel(props) {
  const context = useHotelContext();
  const canRead = usePermission("orders", "read"), canRecord = usePermission("orders", "recordconfirmation"), canReview = usePermission("orders", "reviewconfirmation");
  const authority = JSON.stringify([context.permissions, context.subscriptionActive, context.subscription?.modules, context.subscription?.status]);
  const scope = procurementReadScope(props.hotelUid, `${props.orderId}:${props.orderRevision}:${authority}`);
  return <ScopedPanel key={scope?.key || "no-supplier-response-authority"} {...props} scope={scope} canRead={canRead} canRecord={canRecord} canReview={canReview} />;
}
function ScopedPanel({ hotelUid, orderId, orderRevision, scope, canRead, canRecord, canReview, onChanged, disabled = false }) {
  const actorUid = auth.currentUser?.uid || "";
  const storageKey = `supplier-confirmation-request:${actorUid}:${hotelUid}:${orderId}`;
  const [pending, setPending] = useState(() => readPending(storageKey, hotelUid, orderId, actorUid));
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(null), [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(null), [formRevision, setFormRevision] = useState(null), [reviewReason, setReviewReason] = useState("");
  const [older, setOlder] = useState([]), [cursor, setCursor] = useState(null), [moreBusy, setMoreBusy] = useState(false), [moreError, setMoreError] = useState(null);
  const mounted = useRef(false), locked = useRef(false), pageSequence = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; pageSequence.current++; }; }, []);
  const current = () => mounted.current && scope?.current();
  const load = useCallback(async () => {
    const data = await getSupplierConfirmations({ hotelUid, orderId });
    if (Number.isSafeInteger(orderRevision) && data.orderRevision < orderRevision) throw new Error("The supplier response is older than this order. Refresh before making changes.");
    return data;
  }, [hotelUid, orderId, orderRevision]);
  const query = useVerifiedRefresh({ scopeKey: scope?.key, enabled: Boolean(scope && canRead), load });
  const data = query.data;
  useEffect(() => {
    if (!data) return;
    setOlder([]); setCursor(data.nextCursor); setMoreError(null);
    if (formRevision === null && !query.loading) { setForm(initialForm(data)); setFormRevision(data.orderRevision); }
  }, [data, formRevision, query.loading]);
  useEffect(() => { setReviewReason(""); }, [data?.orderRevision, data?.current?.responseId]);
  const refresh = () => { pageSequence.current++; setMoreBusy(false); setMoreError(null); return query.retry(); };
  const execute = async (command) => {
    if (locked.current || disabled || !current() || !canRead || command.corrupt || !(command.kind === "response" ? canRecord : canReview)) return;
    locked.current = true; setBusy(true); setMessage(null);
    try { sessionStorage.setItem(storageKey, JSON.stringify(command)); }
    catch { locked.current = false; setBusy(false); setMessage({ error: true, text: "Browser storage could not preserve this request. No command was sent." }); return; }
    setPending(command);
    let acknowledged = false;
    try {
      await commands[command.kind](command.input);
      sessionStorage.removeItem(storageKey);
      if (!current()) return;
      acknowledged = true;
      setPending(null); setShowForm(false); setFormRevision(null); setReviewReason("");
      setMessage({ text: command.kind === "response" ? "Supplier response recorded. The submitted order remains in history." : "Hotel review recorded. Earlier receipt values remain unchanged." });
      await onChanged?.();
      if (current()) await refresh();
    } catch (error) {
      if (!current()) return;
      if (acknowledged) {
        setMessage({ error: true, text: "The supplier change was saved, but the order could not be refreshed. Refresh responses before continuing." });
        await refresh();
      } else if (error?.details?.confirmationRequestUncommitted === true) {
        try { sessionStorage.removeItem(storageKey); setPending(null); }
        catch { setMessage({ error: true, text: "The uncommitted saved request could not be cleared. Retry it after browser storage is available." }); return; }
        setMessage({ error: true, text: error.message }); await refresh();
      } else setMessage({ error: true, text: "The result is uncertain. Retry the exact saved request before entering another supplier response or review." });
    } finally { locked.current = false; if (current()) setBusy(false); }
  };
  const submit = (kind, details) => execute({ kind, input: { hotelUid, orderId, expectedActorUid: actorUid, requestId: crypto.randomUUID(), expectedRevision: data.orderRevision,
    [kind === "response" ? "response" : "review"]: details } });
  const loadMore = async () => {
    if (!cursor || moreBusy || !current()) return;
    const sequence = ++pageSequence.current; setMoreBusy(true); setMoreError(null);
    try {
      const page = await getSupplierConfirmations({ hotelUid, orderId, afterEventId: cursor });
      if (!current() || sequence !== pageSequence.current) return;
      const seen = new Set([...(data.events || []), ...older].map((event) => event.id));
      if (page.orderRevision !== data.orderRevision || page.nextCursor === cursor || page.events.some((event) => seen.has(event.id)) || older.length + page.events.length > 475) {
        throw new Error("Supplier history changed or did not advance. Refresh responses before continuing.");
      }
      setOlder((previous) => [...previous, ...page.events]); setCursor(page.nextCursor);
    } catch (error) { if (current() && sequence === pageSequence.current) setMoreError(error); }
    finally { if (current() && sequence === pageSequence.current) setMoreBusy(false); }
  };
  const closed = data?.status === "Finalized";
  const blocked = disabled || busy || Boolean(pending) || query.loading || Boolean(query.error) || moreBusy || Boolean(moreError)
    || !canRead || !scope?.current() || data?.availability !== "available" || closed || !data?.releaseReady;
  const staleDraft = data && formRevision !== data.orderRevision;
  const updateLine = (lineKey, name, value) => setForm((previous) => ({ ...previous, lines: { ...previous.lines, [lineKey]: { ...previous.lines[lineKey], [name]: value } } }));
  const active = data?.current, events = [...(data?.events || []), ...older];
  if (!canRead || !scope) return null;
  return <section className="ht-panel space-y-5 p-5 sm:p-6" aria-label="Supplier confirmation">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-xl font-semibold">Supplier confirmation</h2>
      <p className="mt-2 max-w-3xl text-sm text-slate-600">Track the supplier's business response separately from sending the order and receiving goods. Hotel team members record the evidence received from the supplier.</p></div>
      <button type="button" className="ht-button-secondary" disabled={busy || query.loading || moreBusy} onClick={refresh}>Refresh responses</button></div>
    {message && <p role={message.error ? "alert" : "status"} className={`rounded-xl border p-3 text-sm ${message.error ? "border-amber-200 bg-amber-50" : "border-emerald-200 bg-emerald-50"}`}>{message.text}</p>}
    {busy && <LoadingStatus>Saving the supplier response…</LoadingStatus>}
    {pending && !busy && <div role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm"><p>{pending.corrupt
      ? "The saved supplier request cannot be read. Review order history before recovering browser storage."
      : "A saved supplier request needs confirmation. Its exact response, identity and revision are preserved."}</p>
      {!pending.corrupt && <button className="ht-button-secondary mt-3" type="button" disabled={disabled || !data?.releaseReady || !(pending.kind === "response" ? canRecord : canReview)} onClick={() => execute(pending)}>Retry saved supplier request</button>}</div>}
    <AsyncError error={query.error} onRetry={refresh} label="Could not verify supplier responses." />
    {query.loading && (data ? <LoadingStatus>Refreshing verified supplier responses…</LoadingStatus> : <ArticleRowsSkeleton rows={3} label="Loading supplier responses…" />)}
    {data && <>
      {data.availability !== "available" && <p role="status" className="rounded-xl bg-amber-50 p-4 text-sm text-amber-900">{data.reason}</p>}
      {!data.releaseReady && <p role="alert" className="text-sm text-amber-900">Supplier response changes await the verified platform activation.</p>}
      {data.availability === "available" && <>
        <div className={`rounded-xl border p-4 ${active?.requiresAttention ? "border-amber-200 bg-amber-50" : "border-slate-200"}`}>
          <p className="font-semibold">{supplierConfirmationStatus({ status: data.status, ...(active ? { supplierConfirmation: active } : {}) }).label}</p>
          {!active ? <p className="mt-2 text-sm text-slate-600">The order was sent. No supplier business response has been recorded yet.</p> : <div className="mt-3 space-y-3">
            <p className="break-words text-sm">Reference: {active.response.supplierReference} · response date: {active.response.respondedOn} · source: {active.response.channel}</p>
            <ResponseLines response={active.response} />
            {active.response.note && <p className="whitespace-pre-wrap break-words text-sm">{active.response.note}</p>}
            {active.review && <p className="break-words text-sm">Hotel review: {active.review.decision === "accept" ? "Proposed terms accepted" : "Supplier follow-up required"} · {active.review.reason}</p>}
          </div>}
        </div>
        {!canRecord && !closed && <p className="text-sm text-slate-600">You can read supplier responses. A hotel administrator can assign Supplier Coordinator access to record them.</p>}
        {canRecord && !canReview && active?.responseType === "changes-proposed" && !closed && <p className="text-sm text-slate-600">A Supplier Terms Approver must review these proposed changes before accepted goods can be recorded.</p>}
        {canReview && active && active.responseType !== "accepted" && !closed && <form className="space-y-3 rounded-xl border border-slate-200 p-4" onSubmit={(event) => event.preventDefault()}>
          <h3 className="font-semibold">Review the supplier's response</h3>
          <p className="text-sm text-slate-600">Accepted price changes affect subsequent receipts only. Quantity changes do not close outstanding goods. Unknown prices remain unknown; the original order and quoted total are preserved.</p>
          {(active.responseType === "rejected" || active.response.lines.some((line) => line.substitute)) && <p className="text-sm text-amber-900">This response needs supplier follow-up. Replacement products require a separately verified purchase snapshot before inventory receiving.</p>}
          <fieldset disabled={blocked} className="space-y-3"><label className="block text-sm font-medium">Hotel review reason<textarea maxLength={1000} required className={field} value={reviewReason} onChange={(event) => setReviewReason(event.target.value)} /></label>
            <div className="flex flex-wrap gap-2">{active.responseType === "changes-proposed" && !active.response.lines.some((line) => line.substitute) && <button type="button" className="ht-button-primary" disabled={!reviewReason.trim()} onClick={() => submit("review", { responseId: active.responseId, decision: "accept", reason: reviewReason })}>Accept proposed terms</button>}
              <button type="button" className="ht-button-secondary" disabled={!reviewReason.trim()} onClick={() => submit("review", { responseId: active.responseId, decision: "follow-up", reason: reviewReason })}>Request supplier follow-up</button></div>
          </fieldset>
        </form>}
        {canRecord && !closed && <div className="space-y-3">
          <button className="ht-button-secondary" type="button" disabled={blocked} onClick={() => setShowForm((value) => !value)}>{showForm ? "Close response form" : "Record supplier response"}</button>
          {showForm && form && <form className="space-y-4 rounded-xl border border-slate-200 p-4" onSubmit={(event) => {
            event.preventDefault(); if (blocked || staleDraft) return;
            const lines = form.responseType === "rejected" ? [] : data.submittedLines.map((line) => {
              const values = form.lines[keyOf(line)];
              return { supplierProductId: line.supplierProductId, ...(line.orderLineId ? { orderLineId: line.orderLineId } : {}), confirmedQuantity: values.confirmedQuantity.trim() ? Number(values.confirmedQuantity) : null,
                deliveryDate: values.deliveryDate, priceMode: values.priceMode, ...(values.priceMode === "quoted" ? { pricePerPurchaseUnit: values.pricePerPurchaseUnit.trim() ? Number(values.pricePerPurchaseUnit) : null } : {}),
                substitute: values.substitute, reason: values.reason };
            });
            if (lines.some((line) => line.confirmedQuantity === null || line.priceMode === "quoted" && line.pricePerPurchaseUnit === null)) { setMessage({ error: true, text: "Enter explicit quantities and quoted prices, or mark the price unknown. Blank values do not mean zero." }); return; }
            submit("response", { responseType: form.responseType, channel: form.channel, supplierReference: form.supplierReference, respondedOn: form.respondedOn, note: form.note, lines });
          }}><h3 className="font-semibold">Record evidence received from the supplier</h3>
            <p className="text-sm text-slate-600">Record the supplier's full latest response, including unchanged lines. This does not send another order or authenticate the supplier.</p>
            {staleDraft && <div role="alert" className="text-sm text-amber-900"><p>The order changed while this response was being drafted. Review the current terms before starting again.</p><button type="button" className="ht-button-secondary mt-2" onClick={() => { setForm(initialForm(data)); setFormRevision(data.orderRevision); }}>Start with current terms</button></div>}
            <fieldset disabled={blocked || staleDraft} className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="text-sm font-medium">Supplier response<select aria-label="Supplier response" className={field} value={form.responseType} onChange={(event) => {
                  const type = event.target.value; setForm((previous) => type === "accepted" ? { ...initialForm(data), supplierReference: previous.supplierReference, respondedOn: previous.respondedOn, channel: previous.channel, note: previous.note } : { ...previous, responseType: type });
                }}><option value="accepted">Accepted as ordered</option><option value="changes-proposed">Proposed changes</option><option value="rejected">Rejected order</option></select></label>
                <label className="text-sm font-medium">Response received via<select aria-label="Response received via" className={field} value={form.channel} onChange={(event) => setForm({ ...form, channel: event.target.value })}>{[["email", "Email"], ["sftp", "SFTP message"], ["portal", "Supplier portal"], ["phone", "Telephone"], ["other", "Other evidence"]].map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
                <label className="text-sm font-medium">Supplier response reference<input required maxLength={120} className={field} value={form.supplierReference} onChange={(event) => setForm({ ...form, supplierReference: event.target.value })} /></label>
                <label className="text-sm font-medium">Supplier response date<input required type="date" max={data.today || undefined} className={field} value={form.respondedOn} onChange={(event) => setForm({ ...form, respondedOn: event.target.value })} /></label>
              </div>
              {form.responseType === "accepted" && <p className="text-sm text-slate-600">All submitted quantities, package prices and requested delivery dates are accepted unchanged.</p>}
              {form.responseType === "changes-proposed" && data.submittedLines.map((line) => {
                const values = form.lines[keyOf(line)];
                return <div className="min-w-0 space-y-3 rounded-xl bg-slate-50 p-3" key={keyOf(line)}><p className="break-words text-sm font-semibold">{line.productName} · {line.purchaseUnit}</p>
                  <p className="text-xs text-slate-500">Submitted: {line.orderedQuantity} · {formatOrderMoney(line.orderedPrice, line.currency)} ({formatOrderPriceBasis(line.priceBasis)}) · delivery {line.deliveryDate}</p>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="text-sm">Confirmed quantity · {line.productName} ({line.purchaseUnit})<input required type="number" min="0" max="100000" step="0.001" className={field} value={values.confirmedQuantity} onChange={(event) => updateLine(keyOf(line), "confirmedQuantity", event.target.value)} /></label>
                    <div><label className="text-sm">Confirmed delivery date · {line.productName}<input type="date" required={values.deliveryDate !== null} disabled={values.deliveryDate === null} className={field} value={values.deliveryDate || ""} onChange={(event) => updateLine(keyOf(line), "deliveryDate", event.target.value)} /></label><label className="mt-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={values.deliveryDate === null} onChange={(event) => updateLine(keyOf(line), "deliveryDate", event.target.checked ? null : line.deliveryDate)} />Delivery date unknown · {line.productName}</label></div>
                    <label className="text-sm">Package price status · {line.productName}<select aria-label={`Package price status · ${line.productName}`} className={field} value={values.priceMode} onChange={(event) => updateLine(keyOf(line), "priceMode", event.target.value)}><option value="as-ordered">As submitted</option><option value="quoted">New quoted price</option><option value="unknown">Price unknown</option></select></label>
                    {values.priceMode === "quoted" && <label className="text-sm">Quoted package price · {line.productName} ({line.currency}, {formatOrderPriceBasis(line.priceBasis)})<input required type="number" min="0" max="1000000" step="0.000001" className={field} value={values.pricePerPurchaseUnit} onChange={(event) => updateLine(keyOf(line), "pricePerPurchaseUnit", event.target.value)} /></label>}
                  </div>
                  <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={Boolean(values.substitute)} onChange={(event) => updateLine(keyOf(line), "substitute", event.target.checked ? { description: "", supplierSku: "", purchaseUnit: "" } : null)} />Supplier proposed a replacement · {line.productName}</label>
                  {values.substitute && <div className="grid gap-3 sm:grid-cols-2">{[["description", "Replacement description"], ["supplierSku", "Replacement supplier SKU"], ["purchaseUnit", "Replacement purchase unit"]].map(([name, label]) => <label className="text-sm" key={name}>{label} · {line.productName}<input required maxLength={name === "supplierSku" ? 150 : 200} className={field} value={values.substitute[name]} onChange={(event) => updateLine(keyOf(line), "substitute", { ...values.substitute, [name]: event.target.value })} /></label>)}</div>}
                  <label className="block text-sm">Change explanation · {line.productName}<input maxLength={300} className={field} value={values.reason} onChange={(event) => updateLine(keyOf(line), "reason", event.target.value)} /></label>
                </div>;
              })}
              <label className="block text-sm">Supplier response note<textarea required={form.responseType === "rejected"} maxLength={1000} className={field} value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} /></label>
              <button type="submit" className="ht-button-primary">Save supplier response</button>
            </fieldset>
          </form>}
        </div>}
      </>}
      <div><h3 className="font-semibold">Supplier response history</h3>
        {!events.length && <p className="mt-2 text-sm text-slate-600">No supplier response or hotel review is recorded.</p>}
        <ol className="mt-3 space-y-3">{events.map((event) => <li className="min-w-0 rounded-xl border border-slate-200 p-4 text-sm" key={event.id}>
          <div className="flex flex-wrap justify-between gap-2"><p className="font-medium">{event.kind === "response" ? supplierResponseLabels[event.response.responseType] : event.review.decision === "accept" ? "Hotel accepted proposed terms" : "Hotel requested supplier follow-up"}</p><time>{time(event.createdAtMillis)}</time></div>
          <p className="mt-1 text-xs text-slate-500">Recorded by {event.actorName || "Unknown user"}</p>
          {event.kind === "response" ? <details className="mt-3"><summary className="cursor-pointer break-words">Response {event.response.supplierReference} · {event.response.respondedOn} · {event.response.channel}</summary><div className="mt-3 space-y-3"><ResponseLines response={event.response} />{event.response.note && <p className="whitespace-pre-wrap break-words">{event.response.note}</p>}</div></details>
            : <p className="mt-2 whitespace-pre-wrap break-words">{event.review.reason}</p>}
        </li>)}</ol>
        {moreError && <AsyncError error={moreError} onRetry={loadMore} label="Could not load older supplier responses." />}
        {cursor && <button type="button" className="ht-button-secondary mt-3" disabled={moreBusy || query.loading || busy} onClick={loadMore}>{moreBusy ? "Loading older responses…" : "Load older responses"}</button>}
      </div>
    </>}
  </section>;
}
