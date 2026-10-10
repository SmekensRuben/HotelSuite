import React, { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { getPlatformHotel, updatePlatformHotel, startPlatformSupport, platformError } from "../../services/firebasePlatform";
import { usePlatformQuery, usePlatformScope } from "../../hooks/usePlatformQuery";
import { Title, QueryState, Status, Moment, button, primary, field, panel } from "./PlatformShared";

export default function PlatformHotelPage() {
  const { hotelUid } = useParams(), navigate = useNavigate();
  const query = usePlatformQuery(() => getPlatformHotel(hotelUid), hotelUid);
  const capture = usePlatformScope(hotelUid), supportRequest = useRef(null);
  const [form, setForm] = useState({}), [reason, setReason] = useState(""), [busy, setBusy] = useState(false), [message, setMessage] = useState(null);
  useEffect(() => { if (query.data) setForm({ name: query.data.name, timeZone: query.data.timeZone || "", contactName: query.data.contactName, contactEmail: query.data.contactEmail }); setMessage(null); setReason(""); }, [query.data, hotelUid]);
  useEffect(() => { setBusy(false); supportRequest.current = null; }, [hotelUid]);
  const save = async (event) => {
    event.preventDefault(); if (busy) return; setBusy(true); setMessage(null);
    const current = capture();
    try { await updatePlatformHotel({ hotelUid, expectedRevision: query.data.revision, ...form }); if (!current()) return; await query.refresh(); if (current()) setMessage({ text: "Hotel details saved." }); }
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
      <form onSubmit={save} className={panel}><h2 className="text-lg font-semibold">Property and contact</h2><p className="mt-1 text-xs text-slate-500">Permanent hotel ID: {hotelUid}</p>
        {[["name", "Hotel name", true], ["timeZone", "Hotel time zone", true], ["contactName", "Primary contact name", false], ["contactEmail", "Primary contact email", false]].map(([key, label, required]) => <label key={key} className="mt-4 block text-sm font-medium">{label}<input required={required} disabled={busy} type={key === "contactEmail" ? "email" : "text"} maxLength={key === "contactEmail" ? 254 : key === "name" ? 200 : key === "timeZone" ? 80 : 120} placeholder={key === "timeZone" ? "Europe/Brussels" : undefined} className={field} value={form[key] || ""} onChange={(event) => setForm({ ...form, [key]: event.target.value })} /></label>)}
        <button disabled={busy} className={`${primary} mt-5`}>Save hotel details</button></form>
      <div className="space-y-6"><section className={panel}><h2 className="text-lg font-semibold">Subscription</h2><div className="mt-3"><Status value={expired ? "expired" : subscription?.status || "unconfigured"} /></div><p className="mt-3 text-sm">Expires: {subscription?.validUntilMillis == null ? subscription?.status === "active" ? "No expiry" : "Unknown" : <Moment value={subscription.validUntilMillis} />}</p><p className="mt-3 text-sm">Modules: {query.data.subscription?.modules?.join(", ") || (query.data.subscription?.modules ? "Core only" : "Assignment required")}</p><p className="mt-2 text-sm">Assigned members: {query.data.memberCount} · Limit: {query.data.subscription?.seatLimit ?? "Unlimited"}</p><Link to="/platform/subscriptions" className={`${button} mt-4 inline-block`}>Manage subscriptions</Link></section>
        <section className={panel}><h2 className="text-lg font-semibold">Hotel administrators</h2><ul className="mt-3 space-y-2 text-sm">{query.data.administrators.map((person) => <li key={person.uid}>{person.name || person.uid}{person.email && <span className="ml-2 text-slate-500">{person.email}</span>}</li>)}</ul>{query.data.administratorsTruncated && <p className="mt-3 text-sm">Showing the first 20 administrators.</p>}{!query.data.administrators.length && <p className="mt-3 text-sm text-amber-900">Appoint a primary and backup administrator.</p>}<Link className={`${button} mt-4 inline-block`} to={`/platform/hotels/${hotelUid}/team`}>Manage hotel team</Link></section></div>
      <section className={panel}><h2 className="text-lg font-semibold">Imports and integrations</h2><p className="mt-3 text-sm text-slate-600">Review expected deliveries, processing outcomes and unresolved incidents.</p><Link className={`${button} mt-4 inline-block`} to={`/platform/hotels/${hotelUid}/imports`}>Inspect hotel imports</Link></section>
      <form onSubmit={support} className={panel}><h2 className="text-lg font-semibold">Open hotel for support</h2><p className="mt-3 text-sm text-slate-600">Start a read-only diagnostic session for this hotel. The session lasts 30 minutes and is recorded in the audit history. It grants no employee role.</p><label className="mt-4 block text-sm font-medium">Support reason<input required maxLength={300} disabled={busy} className={field} value={reason} onChange={(event) => setReason(event.target.value)} /></label><button disabled={busy} className={`${primary} mt-4`}>Start read-only support</button></form>
    </div>}</QueryState></>;
}
