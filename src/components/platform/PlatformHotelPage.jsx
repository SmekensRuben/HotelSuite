import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { getPlatformHotel, updatePlatformHotel, startPlatformSupport, platformError } from "../../services/firebasePlatform";
import { usePlatformQuery, usePlatformScope } from "../../hooks/usePlatformQuery";
import { Title, QueryState, Status, Moment, button, primary, field, panel } from "./PlatformShared";
import HotelSetupChecklist from "./HotelSetupChecklist";
import HotelDemoDataPanel from "./HotelDemoDataPanel";
import PurchasingMonitoringPanel from "./PurchasingMonitoringPanel";
import { Combobox } from "../ui/combobox";
import { currencyChoices, timeZoneChoices, validTimeZoneChoice } from "../../utils/propertySettingChoices";

export default function PlatformHotelPage() {
  const { hotelUid } = useParams(), navigate = useNavigate(), location = useLocation();
  const query = usePlatformQuery(() => getPlatformHotel(hotelUid), hotelUid);
  const capture = usePlatformScope(hotelUid), supportRequest = useRef(null);
  const [demoRefresh, setDemoRefresh] = useState(0);
  const propertyForm = useRef(null);
  const [confirmCurrencyChange, setConfirmCurrencyChange] = useState(false);
  const [form, setForm] = useState({}), [reason, setReason] = useState(""), [busy, setBusy] = useState(false), [message, setMessage] = useState(null);
  useEffect(() => { if (query.data) setForm({ name: query.data.name, timeZone: query.data.timeZone || query.data.legacyTimeZone || "", currency: query.data.currency || "", contactName: query.data.contactName, contactEmail: query.data.contactEmail }); setMessage(null); setReason(""); setConfirmCurrencyChange(false); }, [query.data, hotelUid]);
  useEffect(() => {
    if (location.hash !== "#property-and-contact" || query.loading || !query.data || !propertyForm.current) return;
    propertyForm.current.scrollIntoView?.({ behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
    propertyForm.current.querySelector('[name="timeZone"]')?.focus({ preventScroll: true });
  }, [location.hash, location.key, query.loading, hotelUid]);
  const zones = useMemo(() => timeZoneChoices(form.timeZone), [form.timeZone]);
  const currencies = useMemo(currencyChoices, []);
  const currencyChanging = Boolean(query.data?.currency && form.currency && query.data.currency !== form.currency) || query.data?.currencyConflict === true;
  useEffect(() => { setBusy(false); supportRequest.current = null; setDemoRefresh(0); }, [hotelUid]);
  const save = async (event) => {
    event.preventDefault(); if (busy || !validTimeZoneChoice(form.timeZone) || !currencies.some((choice) => choice.id === form.currency) || currencyChanging && !confirmCurrencyChange) return; setBusy(true); setMessage(null);
    const current = capture();
    try { await updatePlatformHotel({ hotelUid, expectedRevision: query.data.revision, ...form, settingsFingerprint: query.data.settingsFingerprint, confirmCurrencyChange }); if (!current()) return; const saved = await query.refresh(); if (current() && saved) setMessage({ text: "Hotel details saved. Time zone and currency are applied to hotel operations." }); }
    catch (error) { if (current()) setMessage({ error: true, text: platformError(error) }); }
    finally { if (current()) setBusy(false); }
  };
  const support = async (event) => {
    event.preventDefault(); if (busy) return; setBusy(true); setMessage(null);
    const current = capture(), fingerprint = JSON.stringify([hotelUid, reason]);
    if (supportRequest.current?.fingerprint !== fingerprint) supportRequest.current = { fingerprint, id: crypto.randomUUID() };
    try { const result = await startPlatformSupport(hotelUid, reason, supportRequest.current.id); if (current()) navigate(`/platform/hotels/${hotelUid}/support/${result.sessionId}`); }
    catch (error) { if (current()) { setMessage({ error: true, text: platformError(error) }); setBusy(false); } }
  };
  const subscription = query.data?.subscription;
  const expired = subscription && ["active", "trialing"].includes(subscription.status)
    && (subscription.validUntilMillis == null ? subscription.status !== "active" : subscription.validUntilMillis <= Date.now());
  return <><Title title={query.data?.name || "Hotel details"} actions={<Link className={button} to="/platform/hotels">All hotels</Link>}>Property administration is separate from operational hotel access.</Title>
    {message && <p role={message.error ? "alert" : "status"} className={`${panel} mb-4`}>{message.text}</p>}
    <QueryState query={query}>{query.data && <div className="grid gap-6 xl:grid-cols-2">
      <div className="xl:col-span-2"><HotelSetupChecklist hotelUid={hotelUid} refreshKey={`${query.data.revision}:${demoRefresh}`} /></div>
      <div className="xl:col-span-2"><PurchasingMonitoringPanel hotelUid={hotelUid} /></div>
      <form ref={propertyForm} id="property-and-contact" onSubmit={save} className={`${panel} scroll-mt-24`}><h2 className="text-lg font-semibold">Property and contact</h2><p className="mt-1 text-xs text-slate-500">Permanent hotel ID: {hotelUid}</p>
        <label className="mt-4 block text-sm font-medium">Hotel name<input required disabled={busy} maxLength={200} className={field} value={form.name || ""} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div><label htmlFor="hotel-time-zone" className="block text-sm font-medium">Hotel time zone</label><Combobox id="hotel-time-zone" name="timeZone" aria-label="Hotel time zone" required disabled={busy} options={zones} value={zones.find((choice) => choice.id === form.timeZone) || null} getOptionValue={(choice) => choice.id} displayValue={(choice) => choice.label} onChange={(choice) => setForm({ ...form, timeZone: choice?.id || "" })} placeholder="Search a country or city" className={field} description="For a hotel in Belgium, select Belgium — Brussels. Daylight-saving time is handled automatically." /></div>
          <div><label htmlFor="hotel-currency" className="block text-sm font-medium">Hotel currency</label><Combobox id="hotel-currency" name="currency" aria-label="Hotel currency" required disabled={busy} options={currencies} value={currencies.find((choice) => choice.id === form.currency) || null} getOptionValue={(choice) => choice.id} displayValue={(choice) => choice.label} onChange={(choice) => { setForm({ ...form, currency: choice?.id || "" }); setConfirmCurrencyChange(false); }} placeholder="Search Euro, EUR or another currency" className={field} description="Currency for new stock counts and inventory cost estimates. Existing records retain their saved currencies." /></div>
        </div>
        {!query.data.timeZone && query.data.legacyTimeZone && <p className="mt-3 text-sm text-amber-900">The previously entered time zone is shown. Save hotel details to apply it to hotel operations.</p>}
        {query.data.currencyConflict && <p role="alert" className="mt-3 text-sm text-amber-900">The hotel's stored currencies disagree. Save the selected currency to reconcile its current settings.</p>}
        {currencyChanging && <label className="mt-4 flex items-start gap-2 rounded-xl bg-amber-50 p-3 text-sm"><input required type="checkbox" checked={confirmCurrencyChange} disabled={busy} onChange={(event) => setConfirmCurrencyChange(event.target.checked)} />Apply this currency to future inventory work. Existing orders, counts and reports retain their currencies; no conversion is performed.</label>}
        {[["contactName", "Primary contact name"], ["contactEmail", "Primary contact email"]].map(([key, label]) => <label key={key} className="mt-4 block text-sm font-medium">{label}<input disabled={busy} type={key === "contactEmail" ? "email" : "text"} maxLength={key === "contactEmail" ? 254 : 120} className={field} value={form[key] || ""} onChange={(event) => setForm({ ...form, [key]: event.target.value })} /></label>)}
        <div className="mt-5 flex flex-wrap gap-2"><button disabled={busy} className={primary}>Save hotel details</button>{message?.error && <button type="button" disabled={busy} onClick={() => query.refresh()} className={button}>Reload hotel details</button>}</div></form>
      <div className="space-y-6"><section className={panel}><h2 className="text-lg font-semibold">Subscription</h2><div className="mt-3"><Status value={expired ? "expired" : subscription?.status || "unconfigured"} /></div><p className="mt-3 text-sm">Expires: {subscription?.validUntilMillis == null ? subscription?.status === "active" ? "No expiry" : "Unknown" : <Moment value={subscription.validUntilMillis} />}</p><p className="mt-3 text-sm">Modules: {query.data.subscription?.modules?.join(", ") || (query.data.subscription?.modules ? "Core only" : "Assignment required")}</p><p className="mt-2 text-sm">Assigned members: {query.data.memberCount} · Limit: {query.data.subscription?.seatLimit ?? "Unlimited"}</p><Link to="/platform/subscriptions" className={`${button} mt-4 inline-block`}>Manage subscriptions</Link></section>
        <section className={panel}><h2 className="text-lg font-semibold">Hotel administrators</h2><ul className="mt-3 space-y-2 text-sm">{query.data.administrators.map((person) => <li key={person.uid}>{person.name || person.uid}{person.email && <span className="ml-2 text-slate-500">{person.email}</span>}</li>)}</ul>{query.data.administratorsTruncated && <p className="mt-3 text-sm">Showing the first 20 administrators.</p>}{!query.data.administrators.length && <p className="mt-3 text-sm text-amber-900">Appoint a primary and backup administrator.</p>}<Link className={`${button} mt-4 inline-block`} to={`/platform/hotels/${hotelUid}/team`}>Manage hotel team</Link></section></div>
      <section className={panel}><h2 className="text-lg font-semibold">Imports and integrations</h2><p className="mt-3 text-sm text-slate-600">Review expected deliveries, processing outcomes and unresolved incidents.</p><Link className={`${button} mt-4 inline-block`} to={`/platform/hotels/${hotelUid}/imports`}>Inspect hotel imports</Link></section>
      <HotelDemoDataPanel hotelUid={hotelUid} onLoaded={() => setDemoRefresh((value) => value + 1)} />
      <form onSubmit={support} className={panel}><h2 className="text-lg font-semibold">Open hotel for support</h2><p className="mt-3 text-sm text-slate-600">Start a read-only diagnostic session for this hotel. The session lasts 30 minutes and is recorded in the audit history. It grants no employee role.</p><label className="mt-4 block text-sm font-medium">Support reason<input required maxLength={300} disabled={busy} className={field} value={reason} onChange={(event) => setReason(event.target.value)} /></label><button disabled={busy} className={`${primary} mt-4`}>Start read-only support</button></form>
    </div>}</QueryState></>;
}
