import React, { useEffect, useRef, useState } from "react";
import { AlertCircle, Building2, CheckCircle2, CreditCard, Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { auth, signOut } from "../../firebaseConfig";
import { getHotelSubscriptions, saveHotelSubscription } from "../../services/firebaseSubscriptions";
import { subscriptionIsActive } from "../../utils/subscription";
import { MODULE_CATALOG } from "../../constants/moduleCatalog";

const LABELS = { trialing: "Trial", active: "Active", suspended: "Paused", canceled: "Canceled" };
const dateValue = (subscription) => subscription?.validUntil?.toDate?.().toISOString().slice(0, 10) || "";

export default function SubscriptionsPage({ platform = false }) {
  const [hotels, setHotels] = useState([]);
  const [selected, setSelected] = useState("");
  const [status, setStatus] = useState("active");
  const [planId, setPlanId] = useState("standard");
  const [validUntil, setValidUntil] = useState("");
  const [modules, setModules] = useState([]);
  const [seatLimit, setSeatLimit] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [message, setMessage] = useState(null);
  const request = useRef(0);
  const current = hotels.find((hotel) => hotel.hotelUid === selected);
  const select = (hotel) => {
    setSelected(hotel.hotelUid); setStatus(hotel.subscription?.status || "active");
    setPlanId(hotel.subscription?.planId || "standard"); setValidUntil(dateValue(hotel.subscription));
    setModules(hotel.subscription?.modules || []); setSeatLimit(hotel.subscription?.seatLimit ?? "");
    setMessage(null);
  };
  const load = async (preferred = "") => {
    const attempt = ++request.current;
    setLoading(true); setLoadError(null);
    try {
      const records = await getHotelSubscriptions();
      if (attempt !== request.current) return false;
      setHotels(records);
      if (records.length) select(records.find((hotel) => hotel.hotelUid === preferred) || records[0]);
      return true;
    } catch (error) {
      if (attempt !== request.current) return false;
      const records = error.hotelRecords || [];
      setHotels(records);
      if (records.length) select(records.find((hotel) => hotel.hotelUid === preferred) || records[0]);
      setLoadError({ code: error.code, partial: records.length > 0 });
      return false;
    } finally { if (attempt === request.current) setLoading(false); }
  };
  useEffect(() => {
    load();
    return () => { request.current++; };
  }, []);
  const save = async (event) => {
    event.preventDefault();
    if (!current || saving || loading || loadError) return;
    setSaving(true); setMessage(null);
    try {
      await saveHotelSubscription({ hotelUid: selected, status, planId,
        modules, seatLimit: seatLimit === "" ? null : Number(seatLimit),
        validUntil: validUntil ? new Date(validUntil + "T00:00:00Z").toISOString() : null,
        expectedRevision: current.subscription?.revision || 0 });
      const refreshed = await load(selected);
      setMessage({ type: "success", text: refreshed ? "Subscription saved. Hotel access has been updated."
        : "Subscription saved, but we could not refresh the overview. Check again before making another change." });
    } catch (error) {
      const text = error?.code === "functions/aborted"
        ? "Another administrator changed this subscription. Refresh the overview before saving again."
        : error?.code === "functions/not-found" || error?.code === "functions/unavailable"
          ? "Subscription activation is not available. Your platform operator needs to complete the Firebase Functions setup."
          : error?.code === "functions/permission-denied" || error?.code === "functions/unauthenticated"
            ? "Your platform administrator access could not be verified. Sign in again or contact the platform operator."
            : error?.code === "functions/invalid-argument"
              ? "Check the plan and access end date. An active subscription or trial must end in the future."
              : "The subscription could not be saved. Check your connection and try again.";
      setMessage({ type: "error", text });
    } finally { setSaving(false); }
  };
  const activeCount = hotels.filter((hotel) => subscriptionIsActive(hotel.subscription)).length;

  return <div className="min-h-screen bg-[#f6f4f1] text-slate-900">
    <HeaderBar today={new Date().toLocaleDateString("en-GB")} onLogout={() => signOut(auth)} />
    <PageContainer className="space-y-7">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div><p className="text-xs font-semibold uppercase tracking-widest text-[#b41f1f]">Platform administration</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">Hotel subscriptions</h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-600">Manage access per property. Activate a hotel, set up a trial, or pause access when needed.</p>
        </div>
        <button disabled={loading || saving} onClick={() => load(selected)} className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium hover:bg-slate-50 disabled:opacity-50">
          <RefreshCw size={16} aria-hidden="true" /> Refresh overview
        </button>
      </div>
      <div className="flex items-start gap-3 rounded-2xl border border-slate-200 bg-white p-5">
        <ShieldCheck size={22} className="shrink-0 text-[#b41f1f]" aria-hidden="true" />
        <div><p className="text-sm font-semibold">Manual access management</p><p className="mt-1 text-sm leading-6 text-slate-600">You can activate your own hotels without a payment. Customer invoicing is handled separately; saving here updates access and does not charge anyone.</p></div>
      </div>
      {loading ? <div role="status" className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white p-8 text-slate-500"><Loader2 size={20} className="animate-spin" aria-hidden="true" /> Loading hotel subscriptions...</div> : <>
        {loadError && <div role="alert" className="flex gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-5 text-amber-950">
          <AlertCircle size={22} className="shrink-0" aria-hidden="true" /><div>
            <h2 className="font-semibold">{loadError.partial ? "Subscription setup required" : "Hotel overview unavailable"}</h2>
            <p className="mt-2 text-sm leading-6">{loadError.partial
              ? "Your hotels were loaded, but their subscription records could not be read. Complete the Firebase subscription setup before changing access."
              : "We could not load your hotels. Check your connection and platform administrator access, then refresh the overview."}</p>
            {loadError.code && <p className="mt-2 font-mono text-xs">Error reference: {loadError.code}</p>}
          </div>
        </div>}
        {hotels.length > 0 ? <>
          <div className="grid gap-4 sm:grid-cols-3">
            {[["Properties", hotels.length, Building2], ["With active access", loadError ? "—" : activeCount, CheckCircle2], ["Billing", "Manual", CreditCard]].map(([label, value, Icon]) =>
              <div key={label} className="rounded-2xl border border-slate-200 bg-white p-5"><div className="flex items-center justify-between text-slate-500"><span className="text-sm">{label}</span><Icon size={18} aria-hidden="true" /></div><p className="mt-3 text-2xl font-semibold">{value}</p></div>)}
          </div>
          <div className="grid items-start gap-6 lg:grid-cols-[1.2fr_0.8fr]">
            <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white">
              <table className="w-full text-left text-sm"><caption className="sr-only">Subscriptions by hotel</caption>
                <thead><tr className="border-b bg-slate-50 text-xs uppercase tracking-wider text-slate-500"><th className="p-4">Hotel</th><th className="p-4">Access</th><th className="p-4">Plan</th></tr></thead>
                <tbody>{hotels.map((hotel) => <tr key={hotel.hotelUid} className={"border-b last:border-0 " + (selected === hotel.hotelUid ? "bg-[#b41f1f]/5" : "")}>
                  <td className="p-4"><button disabled={saving || Boolean(loadError)} onClick={() => select(hotel)} className="text-left font-semibold text-[#9b1c1c] hover:underline disabled:text-slate-600"><span className="block">{hotel.hotelName}</span><span className="mt-1 block font-mono text-xs font-normal text-slate-400">{hotel.hotelUid}</span></button></td>
                  <td className="p-4"><span className={"inline-block rounded-full px-2.5 py-1 text-xs font-medium " + (subscriptionIsActive(hotel.subscription) ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-600")}>{loadError ? "Unavailable" : subscriptionIsActive(hotel.subscription) ? LABELS[hotel.subscription.status] : hotel.subscription && ["active", "trialing"].includes(hotel.subscription.status) ? "Expired" : LABELS[hotel.subscription?.status] || "Not activated"}</span></td>
                  <td className="p-4 text-slate-500">{loadError ? "—" : hotel.subscription?.planId || "Not assigned"}</td>
                </tr>)}</tbody>
              </table>
            </div>
            {!loadError && current && <form onSubmit={save} className="space-y-5 rounded-2xl border border-slate-200 bg-white p-6">
              <div><p className="text-xs font-semibold uppercase tracking-widest text-slate-400">Manage subscription</p><h2 className="mt-2 text-xl font-semibold">{current.hotelName}</h2></div>
              <label className="block text-sm font-medium">Status<select disabled={saving} value={status} onChange={(event) => setStatus(event.target.value)} className="mt-2 w-full rounded-xl border border-slate-200 bg-white p-3">{Object.entries(LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
              <label className="block text-sm font-medium">Plan<input disabled={saving} required pattern="[a-zA-Z0-9_-]{1,60}" value={planId} onChange={(event) => setPlanId(event.target.value)} className="mt-2 w-full rounded-xl border border-slate-200 p-3" /><span className="mt-2 block text-xs font-normal text-slate-500">The plan is a billing label. Select the licensed modules below; users still need their own action permissions.</span></label>
              {current.subscription?.moduleMigrationRequired && <p role="status" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">This subscription needs an explicit module assignment. Review its existing agreement before saving.</p>}
              <fieldset disabled={saving} className="space-y-3"><legend className="mb-3 text-sm font-semibold">Licensed modules</legend>{Object.entries(MODULE_CATALOG).map(([id, module]) => <label key={id} className="flex items-center gap-3 text-sm"><input type="checkbox" checked={modules.includes(id)} onChange={() => setModules((previous) => previous.includes(id) ? previous.filter((key) => key !== id) : [...previous, id])} />{module.label}</label>)}<p className="text-xs leading-5 text-slate-500">Platform basics are included. Removing a module blocks access and future work; its records and historical permissions are retained.</p></fieldset>
              <label className="block text-sm font-medium">Assigned-user limit<input disabled={saving} type="number" min={1} max={10000} step={1} value={seatLimit} onChange={(event) => setSeatLimit(event.target.value)} placeholder="Unlimited" className="mt-2 w-full rounded-xl border border-slate-200 p-3" /><span className="mt-2 block text-xs font-normal leading-5 text-slate-500">Leave empty for unlimited users. Assigned and invited members count. A lower limit blocks new assignments and preserves existing access.</span></label>
              <label className="block text-sm font-medium">First day without access<input disabled={saving} type="date" required={status === "trialing"} value={validUntil} onChange={(event) => setValidUntil(event.target.value)} className="mt-2 w-full rounded-xl border border-slate-200 p-3" /><span className="mt-2 block text-xs font-normal leading-5 text-slate-500">Access ends at 00:00 UTC on this date. Leave empty for an active subscription with no end date. Trials require an end date.</span></label>
              <button disabled={saving} className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#b41f1f] px-4 py-3 text-sm font-semibold text-white hover:bg-[#981b1b] disabled:opacity-50">{saving && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}{saving ? "Saving..." : "Save subscription"}</button>
              <p className="text-xs leading-5 text-slate-500">Pausing or canceling blocks hotel modules. Platform administrators can still manage the property.</p>
            </form>}
          </div>
        </> : !loadError && <div className="rounded-2xl border border-slate-200 bg-white p-10 text-center"><Building2 size={32} className="mx-auto text-slate-400" aria-hidden="true" /><h2 className="mt-4 text-lg font-semibold">No hotels available yet</h2><p className="mt-2 text-sm text-slate-500">Create a property before assigning its first subscription.</p></div>}
      </>}
      {message && <p role={message.type === "error" ? "alert" : "status"} className={"rounded-xl border p-4 text-sm " + (message.type === "error" ? "border-red-200 bg-red-50 text-red-800" : "border-emerald-200 bg-emerald-50 text-emerald-800")}>{message.text}</p>}
    </PageContainer>
  </div>;
}
