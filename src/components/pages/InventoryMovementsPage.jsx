import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { usePermission } from "../../hooks/usePermission";
import { useScopedAsync } from "../../hooks/useScopedAsync";
import { useStaffDisplayNames } from "../../hooks/useStaffDisplayNames";
import { getInventoryAdjustments, getInventoryAdjustmentChoices, getPendingInventoryAdjustment,
  recordInventoryAdjustment, reverseInventoryAdjustment, retryPendingInventoryAdjustment } from "../../services/firebaseInventoryAdjustments";
import HeaderBar from "../layout/HeaderBar";
import ProcurementPage from "../layout/ProcurementPage";
import { Card } from "../layout/Card";
import { Combobox } from "../ui/combobox";
import { formatInventoryQuantity, formatInventoryValue, formatInventoryUnitCost, parseInventoryDecimal } from "../inventory/inventoryFormatting";

const blankForm = () => ({ kind: "transfer", reasonType: "waste", businessDate: "", reference: "", note: "", product: null,
  source: null, destination: null, quantity: "", netUnitCost: "", costCurrency: null });
const kindName = (event) => event.kind === "transfer" ? "Internal transfer" : event.kind === "physical_return" ? "Physical supplier return"
  : event.kind === "reversal" ? "Compensating reversal" : event.reasonType === "breakage" ? "Breakage" : "Waste";
const dateTime = (value) => value === null ? "Unknown posting time" : new Date(value).toLocaleString("en-GB");
const scopedOptions = (options, selected) => selected && !options.some((item) => item.id === selected.id) ? [selected, ...options] : options;

function useMovementSources(hotelUid, kind, enabled) {
  const [queryText, setQueryText] = useState(""), [prefix, setPrefix] = useState("");
  useEffect(() => { const timer = setTimeout(() => setPrefix(queryText.trim().toLowerCase()), 350); return () => clearTimeout(timer); }, [queryText]);
  const scopeKey = `${hotelUid}:${kind}:${prefix}`;
  const load = useCallback(() => getInventoryAdjustmentChoices(hotelUid, kind, null, prefix), [hotelUid, kind, prefix]);
  const first = useScopedAsync({ scopeKey, enabled, load });
  const [extra, setExtra] = useState({ scopeKey: null, choices: [], cursor: null, busy: false, error: null });
  const active = useRef(null), generation = useRef(0), seen = useRef(new Set());
  active.current = scopeKey;
  useEffect(() => { generation.current++; seen.current.clear(); setExtra({ scopeKey, choices: [], cursor: first.data?.nextCursor || null, busy: false, error: null }); }, [scopeKey, first.data]);
  useEffect(() => () => { active.current = null; generation.current++; }, []);
  const current = extra.scopeKey === scopeKey ? extra : { choices: [], cursor: first.data?.nextCursor || null, busy: false, error: null };
  const choices = [...(first.data?.choices || []), ...current.choices];
  const loadMore = async () => {
    const cursor = current.cursor;
    if (!cursor || current.busy || first.loading || !enabled) return;
    const request = ++generation.current;
    setExtra((previous) => ({ ...previous, scopeKey, busy: true, error: null }));
    try {
      if (seen.current.has(cursor) || choices.length >= 1000) throw new Error("This source search needs a narrower prefix. It will not be silently truncated.");
      const next = await getInventoryAdjustmentChoices(hotelUid, kind, cursor, prefix);
      if (active.current !== scopeKey || request !== generation.current) return;
      if (next.hotelCurrency !== first.data?.hotelCurrency) throw new Error("Hotel currency changed while loading sources. Refresh sources before continuing.");
      seen.current.add(cursor);
      const existing = new Set(choices.map((item) => item.id));
      setExtra((previous) => ({ scopeKey, choices: [...previous.choices, ...next.choices.filter((item) => !existing.has(item.id))], cursor: next.nextCursor, busy: false, error: null }));
    } catch (error) { if (active.current === scopeKey && request === generation.current) setExtra((previous) => ({ ...previous, busy: false, error })); }
  };
  return { choices, currency: first.data?.hotelCurrency ?? null, currencyKnown: Boolean(first.data), loading: first.loading || current.busy || queryText.trim().toLowerCase() !== prefix,
    error: first.error || current.error, cursor: current.cursor, loadMore, retry: first.retry, search: setQueryText };
}

function MovementHistoryItem({ hotelUid, event, canReverse, disabled, onReverse }) {
  const names = useStaffDisplayNames({ hotelUid, scopeKey: `movement:${event.adjustmentId}`, record: { createdBy: event.actorUid } });
  return <li className="rounded-xl border border-slate-200 p-4">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="font-semibold">{kindName(event)} · {event.catalogProductName || "Unknown catalog product"}</p>
      <p className="mt-1 text-sm text-slate-600">{formatInventoryQuantity(event.quantity)} {event.baseUnit} · {event.sourceLocationName || "Unknown location"}{event.destinationLocationId ? ` → ${event.destinationLocationName || "Unknown destination"}` : ""}</p></div>
      <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium">{event.reversedByAdjustmentId ? "Reversed · original retained" : event.kind === "reversal" ? "Reversal evidence" : "Completed event"}</span></div>
    <dl className="mt-3 grid gap-2 text-xs text-slate-500 sm:grid-cols-2"><div><dt>Business date / reference</dt><dd className="mt-1 text-sm text-slate-700">{event.businessDate} · {event.reference}</dd></div>
      <div><dt>Posted by / time</dt><dd className="mt-1 text-sm text-slate-700">{names.createdByName} · {dateTime(event.postedAtMillis)}</dd></div>
      <div><dt>Estimated net cost per {event.baseUnit}</dt><dd className="mt-1 text-sm text-slate-700">{formatInventoryUnitCost(event.netUnitCost, event.currency)}</dd></div>
      <div><dt>Estimated net event value</dt><dd className="mt-1 text-sm text-slate-700">{formatInventoryValue(event.netValue, event.currency)}</dd></div></dl>
    <p className="mt-3 whitespace-pre-wrap text-sm">{event.note}</p>
    {event.kind === "reversal" && <p className="mt-2 text-xs text-slate-500">Original quantities, locations and value were offset using their frozen snapshots.</p>}
    {canReverse && event.kind !== "reversal" && !event.reversedByAdjustmentId && <button type="button" className="ht-button-secondary mt-3" disabled={disabled} onClick={() => onReverse(event)}>Reverse this event</button>}
  </li>;
}

export default function InventoryMovementsPage() {
  const { hotelUid } = useHotelContext();
  const canRead = usePermission("inventorymovements", "read"), canCreate = usePermission("inventorymovements", "create"), canReverse = usePermission("inventorymovements", "reverse");
  const session = useRef({ actor: auth.currentUser, sequence: 0 });
  if (session.current.actor !== auth.currentUser) session.current = { actor: auth.currentUser, sequence: session.current.sequence + 1 };
  return <ScopedMovements key={`${hotelUid}:${auth.currentUser?.uid || ""}:${session.current.sequence}:${canRead}:${canCreate}:${canReverse}`} hotelUid={hotelUid} canRead={canRead} canCreate={canCreate} canReverse={canReverse} />;
}
function ScopedMovements({ hotelUid, canRead, canCreate, canReverse }) {
  const actor = useRef(auth.currentUser).current, actorUid = actor?.uid || "";
  const [form, setForm] = useState(blankForm);
  const [reverse, setReverse] = useState(null), [reverseForm, setReverseForm] = useState({ businessDate: "", reference: "", note: "" });
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(null), [pending, setPending] = useState(null), [pendingError, setPendingError] = useState("");
  const [older, setOlder] = useState([]), [cursor, setCursor] = useState(null), [moreBusy, setMoreBusy] = useState(false), [moreError, setMoreError] = useState(null);
  const mounted = useRef(false), historyGeneration = useRef(0), historyCursors = useRef(new Set());
  useEffect(() => {
    mounted.current = true;
    try { setPending(getPendingInventoryAdjustment(hotelUid)); } catch (error) { setPendingError(error.message); }
    return () => { mounted.current = false; historyGeneration.current++; };
  }, [hotelUid]);
  const today = useMemo(() => new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }), []);
  const loadHistory = useCallback(() => getInventoryAdjustments(hotelUid), [hotelUid]);
  const history = useScopedAsync({ scopeKey: `${hotelUid}:${actorUid}`, enabled: Boolean(hotelUid && actorUid && canRead), load: loadHistory });
  useEffect(() => { historyGeneration.current++; historyCursors.current.clear(); setOlder([]); setCursor(history.data?.nextCursor || null); setMoreBusy(false); setMoreError(null); }, [history.data]);
  const choicesEnabled = Boolean(hotelUid && actorUid && canCreate);
  const productSources = useMovementSources(hotelUid, "catalogproducts", choicesEnabled);
  const locationSources = useMovementSources(hotelUid, "locations", choicesEnabled);
  const blocked = busy || Boolean(pending || pendingError) || !actorUid;
  const setField = (key, value) => setForm((previous) => ({ ...previous, [key]: value }));
  const currency = productSources.currency;
  const sourceError = productSources.error || locationSources.error;
  const retrySavedAllowed = pending?.operation === "reverse" ? canReverse : canCreate;
  const isCurrent = () => mounted.current && auth.currentUser === actor;
  const execute = async (action) => {
    if (busy || pendingError || !actorUid || !isCurrent()) return;
    setBusy(true); setMessage(null);
    try {
      await action();
      if (!isCurrent()) return;
      setPending(null); setForm(blankForm()); setReverse(null); setReverseForm({ businessDate: "", reference: "", note: "" });
      setMessage({ text: "Movement evidence recorded. Historical events remain immutable." });
      await history.run();
    } catch (error) {
      if (!isCurrent()) return;
      let saved = null;
      try { saved = getPendingInventoryAdjustment(hotelUid); setPending(saved); } catch (storageError) { setPendingError(storageError.message); }
      setMessage({ error: true, text: saved ? "The outcome could not be confirmed. Retry the exact saved request before recording another movement." : error.message || "Could not record movement evidence." });
    } finally { if (isCurrent()) setBusy(false); }
  };
  const submit = (event) => {
    event.preventDefault();
    if (blocked || !canCreate || !form.product || !form.source || sourceError || productSources.loading || locationSources.loading) return;
    try {
      const quantity = parseInventoryDecimal(form.quantity), netUnitCost = parseInventoryDecimal(form.netUnitCost, { optional: true });
      if (quantity <= 0) throw new Error("Enter a positive movement quantity in the catalog base unit.");
      if (form.kind === "transfer" && (!form.destination || form.destination.id === form.source.id)) throw new Error("Choose two different active physical locations.");
      if (netUnitCost !== null && (!form.costCurrency || form.costCurrency !== currency || form.costCurrency !== locationSources.currency)) throw new Error("The estimated cost's explicit currency no longer matches the hotel sources. Clear and review the estimate, or leave cost blank if it is unknown.");
      const input = { hotelUid, kind: form.kind, catalogProductId: form.product.id, quantity, sourceLocationId: form.source.id,
        ...(form.kind === "transfer" ? { destinationLocationId: form.destination.id } : {}),
        ...(form.kind === "waste" ? { reasonType: form.reasonType } : {}), businessDate: form.businessDate,
        reference: form.reference.trim(), note: form.note.trim(), netUnitCost, currency: netUnitCost === null ? null : form.costCurrency };
      execute(() => recordInventoryAdjustment(input));
    } catch (error) { setMessage({ error: true, text: error.message }); }
  };
  const loadMoreHistory = async () => {
    if (!cursor || moreBusy || history.loading || !canRead) return;
    const request = ++historyGeneration.current;
    setMoreBusy(true); setMoreError(null);
    try {
      if (historyCursors.current.has(cursor) || older.length + (history.data?.adjustments.length || 0) >= 1000) throw new Error("Movement history exceeds this view's supported paging window. Narrow the review with a platform operator.");
      const page = await getInventoryAdjustments(hotelUid, cursor);
      if (!mounted.current || request !== historyGeneration.current) return;
      historyCursors.current.add(cursor);
      const seen = new Set([...(history.data?.adjustments || []), ...older].map((item) => item.adjustmentId));
      setOlder((previous) => [...previous, ...page.adjustments.filter((item) => !seen.has(item.adjustmentId))]); setCursor(page.nextCursor);
    } catch (error) { if (mounted.current && request === historyGeneration.current) setMoreError(error); }
    finally { if (mounted.current && request === historyGeneration.current) setMoreBusy(false); }
  };
  return <div className="min-h-screen bg-canvas text-gray-900">
    <HeaderBar today={today} onLogout={async () => { await signOut(auth); sessionStorage.clear(); window.location.href = "/login"; }} />
    <ProcurementPage className="space-y-6">
      <div><p className="text-xs uppercase tracking-wider text-slate-500">Purchasing & inventory</p><h1 className="text-3xl font-semibold">Inventory movements</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">Register physical transfers, waste, breakage and supplier returns to help explain differences between counts. These immutable events do not create a live on-hand balance.</p></div>
      {busy && <p role="status" className="rounded-xl bg-brand-50 p-4 text-sm">Recording movement evidence…</p>}
      {message && <p role={message.error ? "alert" : "status"} className={`rounded-xl border p-4 text-sm ${message.error ? "border-amber-200 bg-amber-50" : "border-emerald-200 bg-emerald-50"}`}>{message.text}</p>}
      {pendingError && <p role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm">{pendingError}</p>}
      {pending && !busy && <div role="alert" className="space-y-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm"><p className="font-semibold">A saved movement request needs reconciliation</p>
        <p>The original {pending.operation} request, business date, quantities, locations and request ID are preserved. It cannot be replaced with changed values.</p>
        <button type="button" className="ht-button-secondary" disabled={busy || !retrySavedAllowed} onClick={() => execute(() => retryPendingInventoryAdjustment(hotelUid))}>Retry saved movement request</button>
        {!retrySavedAllowed && <p>Your current permissions do not allow replaying this saved action. A hotel administrator must review access.</p>}</div>}
      {!canCreate && !canRead && <p role="alert">Inventory movement read or create permission is required.</p>}
      {canCreate && <Card className="space-y-5">
        <div><h2 className="text-xl font-semibold">Record a physical event</h2><p className="mt-1 text-sm text-slate-600">Choose an article and the physical locations involved. Enter the quantity in its catalog unit; a cost estimate is optional.</p></div>
        {(productSources.loading || locationSources.loading) && <p role="status" className="text-sm text-slate-600">Loading articles and locations…</p>}
        <form aria-label="Record a physical event" className="space-y-4" onSubmit={submit}>
          <div className="grid gap-4 sm:grid-cols-2"><label className="text-sm font-medium">Event type<select aria-label="Event type" className="ht-field mt-1" disabled={blocked} value={form.kind} onChange={(event) => { setField("kind", event.target.value); setField("destination", null); }}><option value="transfer">Internal transfer</option><option value="waste">Waste or breakage</option><option value="physical_return">Physical supplier return</option></select></label>
            {form.kind === "waste" && <label className="text-sm font-medium">Waste classification<select aria-label="Waste classification" className="ht-field mt-1" value={form.reasonType} disabled={blocked} onChange={(event) => setField("reasonType", event.target.value)}><option value="waste">Waste</option><option value="breakage">Breakage</option></select></label>}</div>
          {form.kind === "physical_return" && <p className="rounded-xl bg-slate-50 p-3 text-xs leading-5">Record goods that physically left this location. This is separate from rejected goods at receiving and does not record a supplier credit, payment or invoice adjustment.</p>}
          <label className="block text-sm font-medium">Catalog article<Combobox aria-label="Catalog article" required options={scopedOptions(productSources.choices, form.product)} value={form.product} onChange={(product) => { setField("product", product); setField("quantity", ""); setField("netUnitCost", ""); setField("costCurrency", null); }} displayValue={(product) => `${product.name} · ${product.baseUnit}`} getOptionValue={(product) => product.id} className="ht-field mt-1" placeholder="Search by article name" onQueryChange={productSources.search} filterOptions={false} loading={productSources.loading} disabled={blocked} description="Type the beginning of an article name to search. Use Load more catalog articles to see more results." /></label>
          {productSources.cursor && <button type="button" className="ht-button-secondary" disabled={blocked || productSources.loading} onClick={productSources.loadMore}>Load more catalog articles</button>}
          <div className="grid gap-4 sm:grid-cols-2"><label className="text-sm font-medium">From physical location<Combobox aria-label="From physical location" required value={form.source} options={scopedOptions(locationSources.choices, form.source)} onChange={(location) => { setField("source", location); if (location?.id === form.destination?.id) setField("destination", null); }} displayValue={(location) => location.name} getOptionValue={(location) => location.id} className="ht-field mt-1" placeholder="Search physical locations" onQueryChange={locationSources.search} filterOptions={false} loading={locationSources.loading} disabled={blocked} /></label>
            {form.kind === "transfer" && <label className="text-sm font-medium">To physical location<Combobox aria-label="To physical location" required value={form.destination} options={scopedOptions(locationSources.choices.filter((location) => location.id !== form.source?.id), form.destination)} onChange={(location) => setField("destination", location)} displayValue={(location) => location.name} getOptionValue={(location) => location.id} className="ht-field mt-1" placeholder="Search a different location" onQueryChange={locationSources.search} filterOptions={false} loading={locationSources.loading} disabled={blocked} /></label>}</div>
          {locationSources.cursor && <button type="button" className="ht-button-secondary" disabled={blocked || locationSources.loading} onClick={locationSources.loadMore}>Load more physical locations</button>}
          {sourceError && <div role="alert" className="space-y-2 text-sm text-amber-900"><p>Articles or locations could not be loaded. {sourceError.message}</p><button type="button" className="ht-button-secondary" disabled={blocked} onClick={() => { productSources.retry(); locationSources.retry(); }}>Retry articles and locations</button></div>}
          <div className="grid gap-4 sm:grid-cols-2"><label className="text-sm font-medium">Quantity ({form.product?.baseUnit || "catalog base unit"})<input aria-label="Movement quantity" className="ht-field mt-1" required type="number" min="0.000001" max="1000000" step="0.000001" disabled={blocked || !form.product} value={form.quantity} onChange={(event) => setField("quantity", event.target.value)} /></label>
            <label className="text-sm font-medium">Estimated net cost per {form.product?.baseUnit || "catalog unit"} ({(form.netUnitCost !== "" ? form.costCurrency : currency) || "currency unavailable"}) · Optional<input aria-label="Estimated net unit cost" aria-describedby="movement-cost-help" className="ht-field mt-1" type="number" min="0" max="1000000" step="0.000001" placeholder="Unknown — optional" disabled={blocked || !form.product || !currency && form.netUnitCost === ""} value={form.netUnitCost} onChange={(event) => { setField("netUnitCost", event.target.value); setField("costCurrency", event.target.value === "" ? null : currency); }} /></label></div>
          <div id="movement-cost-help" className="space-y-1 text-xs leading-5 text-slate-500"><p>A catalog article may have several supplier prices, so selecting it does not fill a stock cost. Enter a manual estimate for the stock being moved{form.product ? `, per ${form.product.baseUnit}` : ""}, excluding VAT. Leave blank if unknown; quantity is still recorded and its value remains unavailable. Enter 0 only for a known zero cost.</p>
            {productSources.currencyKnown && !currency && <p>The hotel's currency is unavailable. You can record the quantity, but cannot enter a cost estimate.</p>}</div>
          <div className="grid gap-4 sm:grid-cols-2"><label className="text-sm font-medium">Business date<input aria-label="Business date" type="date" required className="ht-field mt-1" disabled={blocked} value={form.businessDate} onChange={(event) => setField("businessDate", event.target.value)} /></label><label className="text-sm font-medium">Reference<input aria-label="Reference" required maxLength={128} className="ht-field mt-1" disabled={blocked} value={form.reference} onChange={(event) => setField("reference", event.target.value)} placeholder="Transfer note, waste record or return reference" /></label></div>
          <label className="block text-sm font-medium">Reason / evidence<textarea aria-label="Reason / evidence" required maxLength={1000} rows={3} className="ht-field mt-1" disabled={blocked} value={form.note} onChange={(event) => setField("note", event.target.value)} /></label>
          <div className="flex justify-end"><button type="submit" className="ht-button-primary" disabled={blocked || productSources.loading || locationSources.loading || Boolean(sourceError) || !form.product || !form.source || form.kind === "transfer" && !form.destination}>Record movement</button></div>
        </form>
      </Card>}
      {reverse && canReverse && <Card><form aria-label="Reverse a physical event" className="space-y-4" onSubmit={(event) => { event.preventDefault(); if (!blocked) execute(() => reverseInventoryAdjustment({ hotelUid, adjustmentId: reverse.adjustmentId, ...reverseForm, reference: reverseForm.reference.trim(), note: reverseForm.note.trim() })); }}>
        <h2 className="text-xl font-semibold">Reverse {kindName(reverse).toLowerCase()}</h2><p className="text-sm leading-6 text-slate-600">Offset {formatInventoryQuantity(reverse.quantity)} {reverse.baseUnit} of {reverse.catalogProductName} using the original frozen locations and values. The original event remains visible. A reversal is a correction of evidence, not a new physical supplier return.</p>
        <div className="grid gap-4 sm:grid-cols-2"><label className="text-sm font-medium">Reversal business date<input aria-label="Reversal business date" type="date" required className="ht-field mt-1" disabled={blocked} value={reverseForm.businessDate} onChange={(event) => setReverseForm((previous) => ({ ...previous, businessDate: event.target.value }))} /></label><label className="text-sm font-medium">Reversal reference<input aria-label="Reversal reference" required maxLength={128} className="ht-field mt-1" disabled={blocked} value={reverseForm.reference} onChange={(event) => setReverseForm((previous) => ({ ...previous, reference: event.target.value }))} /></label></div>
        <label className="block text-sm font-medium">Reversal reason<textarea aria-label="Reversal reason" required maxLength={1000} className="ht-field mt-1" disabled={blocked} value={reverseForm.note} onChange={(event) => setReverseForm((previous) => ({ ...previous, note: event.target.value }))} /></label>
        <div className="flex flex-wrap gap-3"><button type="submit" className="ht-button-primary" disabled={blocked}>Confirm compensating reversal</button><button type="button" className="ht-button-secondary" disabled={busy} onClick={() => setReverse(null)}>Cancel reversal</button></div>
      </form></Card>}
      {canRead && <Card className="space-y-4"><div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-xl font-semibold">Recorded movement history</h2><button type="button" className="ht-button-secondary" disabled={busy || history.loading} onClick={history.retry}>Refresh movement history</button></div>
        {history.loading && <p role="status" className="text-sm text-slate-600">Loading movement evidence…</p>}
        {history.error && <p role="alert" className="text-sm text-amber-900">{history.error.message}</p>}
        {!history.loading && !history.error && !history.data?.adjustments.length && <p className="text-sm text-slate-500">No manual physical events have been recorded. Goods receipts remain on their orders.</p>}
        <ol className="space-y-3">{[...(history.data?.adjustments || []), ...older].map((event) => <MovementHistoryItem key={event.adjustmentId} hotelUid={hotelUid} event={event} canReverse={canReverse} disabled={blocked} onReverse={(original) => { setReverse(original); setReverseForm({ businessDate: "", reference: "", note: "" }); }} />)}</ol>
        {moreError && <p role="alert" className="text-sm text-amber-900">{moreError.message}</p>}
        {cursor && <button type="button" className="ht-button-secondary" disabled={busy || moreBusy || history.loading} onClick={loadMoreHistory}>{moreBusy ? "Loading older events…" : "Load older movement events"}</button>}
      </Card>}
    </ProcurementPage>
  </div>;
}
