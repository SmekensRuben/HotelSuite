import React, { useState } from "react";
import { ArrowRight, Building2, CheckCircle2, LifeBuoy, LockKeyhole, LogOut, RefreshCw, ShieldCheck } from "lucide-react";
import { useHotelContext } from "../../contexts/HotelContext";
import { auth, signOut } from "../../firebaseConfig";

const STATUS_LABELS = { trialing: "Trial ended", active: "Expired", suspended: "Paused", canceled: "Canceled" };

export default function SubscriptionAccessPage() {
  const { hotelName, hotelUid, hotelUids = [], selectHotel, subscription, subscriptionError,
    subscriptionLoading, retrySubscription } = useHotelContext();
  const [actionError, setActionError] = useState("");
  const expiry = subscription?.validUntil?.toDate?.();
  const unavailable = Boolean(subscriptionError);
  const status = unavailable ? "Unable to verify" : STATUS_LABELS[subscription?.status] || "Not activated";
  const switchHotel = async (uid) => {
    setActionError("");
    try { await selectHotel(uid); } catch { setActionError("We could not switch hotels. Please try again."); }
  };
  const logout = async () => {
    try { await signOut(auth); } catch { setActionError("We could not sign you out. Please try again."); }
  };

  return <div className="min-h-screen bg-[#f6f4f1] text-slate-900">
    <header className="border-b border-slate-200/70 bg-white">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-5 sm:px-8">
        <div className="flex items-center gap-3">
          <img src="/assets/breakfast_pilot_logo_black_circle.png" alt="" className="h-11 w-11" />
          <div><p className="text-lg font-bold tracking-tight">Hotel Toolkit</p><p className="text-xs text-slate-500">Your hotel. Connected.</p></div>
        </div>
        <button onClick={logout} className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 focus-visible:outline-[#b41f1f]">
          <LogOut size={16} aria-hidden="true" /> Sign out
        </button>
      </div>
    </header>
    <main className="mx-auto grid max-w-6xl gap-10 px-5 py-12 sm:px-8 sm:py-20 lg:grid-cols-[1.1fr_0.9fr] lg:gap-16">
      <section className="self-center">
        <span className="inline-flex items-center gap-2 rounded-full border border-[#b41f1f]/15 bg-[#b41f1f]/5 px-3 py-1.5 text-xs font-semibold uppercase tracking-widest text-[#9b1c1c]">
          <LockKeyhole size={14} aria-hidden="true" /> {unavailable ? "Access check unavailable" : "Hotel access paused"}
        </span>
        <h1 className="mt-6 max-w-xl text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">
          {unavailable ? "We could not verify your hotel access" : "No active hotel subscription"}
        </h1>
        <p className="mt-5 max-w-lg text-base leading-7 text-slate-600">
          {unavailable ? "Your subscription status could not be loaded. This does not mean your subscription has ended. Check again, or contact your platform administrator if the problem continues."
            : `Access to ${hotelName || "this hotel"} is currently paused. Your platform administrator can activate or renew the hotel's subscription so your team can get back to work.`}
        </p>
        <button disabled={subscriptionLoading} onClick={() => { setActionError(""); retrySubscription?.(); }}
          className="mt-8 inline-flex items-center gap-2 rounded-xl bg-[#b41f1f] px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-[#981b1b] focus-visible:outline-offset-4 focus-visible:outline-[#b41f1f] disabled:opacity-50">
          <RefreshCw size={17} aria-hidden="true" /> Check access again
        </button>
        <p className="mt-3 text-xs text-slate-500">Access updates automatically when your subscription is activated.</p>
        {actionError && <p role="alert" className="mt-4 text-sm text-red-700">{actionError}</p>}
      </section>
      <section aria-label="Hotel access details" className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-xl shadow-slate-200/40">
        <div className="border-b border-slate-100 p-7 sm:p-8">
          <div className="mb-5 inline-flex rounded-2xl bg-slate-100 p-3"><Building2 size={28} className="text-slate-700" aria-hidden="true" /></div>
          <p className="text-xs font-semibold uppercase tracking-widest text-slate-500">Selected hotel</p>
          <h2 className="mt-2 break-words text-2xl font-semibold">{hotelName || "Hotel"}</h2>
          <dl className="mt-6 space-y-4 text-sm">
            <div className="flex items-center justify-between gap-4"><dt className="text-slate-500">Subscription status</dt><dd className="rounded-full bg-amber-50 px-3 py-1 font-medium text-amber-800">{status}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-slate-500">Plan</dt><dd className="break-all font-medium">{subscription?.planId || "Not assigned"}</dd></div>
            {expiry && <div className="flex justify-between gap-4"><dt className="text-slate-500">{expiry.getTime() <= Date.now() ? "Access ended" : "Access end date"}</dt><dd className="font-medium">{expiry.toLocaleDateString("en-GB", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" })} (UTC)</dd></div>}
            <div className="flex justify-between gap-4"><dt className="shrink-0 text-slate-500">Hotel reference</dt><dd className="break-all font-mono text-xs">{hotelUid}</dd></div>
          </dl>
        </div>
        <div className="space-y-5 bg-slate-50/70 p-7 sm:p-8">
          <div className="flex gap-3"><LifeBuoy size={20} className="mt-0.5 shrink-0 text-[#b41f1f]" aria-hidden="true" /><div><h3 className="text-sm font-semibold">Contact your platform administrator</h3><p className="mt-1 text-sm leading-6 text-slate-600">Share the hotel reference above so they can check your access.</p></div></div>
          <div className="flex gap-3"><ShieldCheck size={20} className="mt-0.5 shrink-0 text-slate-500" aria-hidden="true" /><p className="text-sm leading-6 text-slate-600">Your account stays available. This screen does not delete hotel data or start a payment.</p></div>
        </div>
      </section>
      {hotelUids.length > 1 && <section className="lg:col-span-2" aria-label="Switch hotel">
        <h2 className="text-sm font-semibold">Work with another hotel</h2>
        <p className="mt-1 text-sm text-slate-500">Select another property assigned to your account.</p>
        <div className="mt-4 flex flex-wrap gap-3">{hotelUids.filter((uid) => uid !== hotelUid).map((uid) => <button key={uid} onClick={() => switchHotel(uid)} className="inline-flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-medium hover:border-[#b41f1f] focus-visible:outline-[#b41f1f]">{uid}<ArrowRight size={16} aria-hidden="true" /></button>)}</div>
      </section>}
      <p className="flex items-center gap-2 text-xs text-slate-400 lg:col-span-2"><CheckCircle2 size={14} aria-hidden="true" /> Hotel access is managed per property.</p>
    </main>
  </div>;
}
