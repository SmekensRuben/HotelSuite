import React, { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Building2, Mail, ShieldCheck, Loader2 } from "lucide-react";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { auth, signOut } from "../../firebaseConfig";
import { createHotel, inviteHotelUser, getHotelOnboardingStatus } from "../../services/firebaseOnboarding";
import { getHotelSubscriptions } from "../../services/firebaseSubscriptions";
import { useHotelContext } from "../../contexts/HotelContext";

const fieldClass = "mt-2 w-full rounded-xl border border-slate-200 bg-white p-3";
const buttonClass = "inline-flex items-center justify-center gap-2 rounded-xl bg-[#b41f1f] px-5 py-3 text-sm font-semibold text-white hover:bg-[#981b1b] disabled:opacity-50";
const roles = { manager: "Hotel manager", purchaser: "Purchaser", approver: "Order approver", viewer: "Viewer" };

function messageFor(error) {
  if (["functions/already-exists", "functions/invalid-argument", "functions/failed-precondition"].includes(error?.code)) return error.message;
  if (error?.code === "functions/permission-denied") return "Verify your email and platform administrator access before continuing.";
  return "The request could not be completed. Retry with the same details to safely resume it.";
}

export default function HotelOnboardingPage() {
  const { refreshHotelAssignments } = useHotelContext();
  const [hotels, setHotels] = useState([]);
  const [rolloutReady, setRolloutReady] = useState(null);
  const [name, setName] = useState("");
  const [hotelUid, setHotelUid] = useState("");
  const [status, setStatus] = useState("trialing");
  const [trialDays, setTrialDays] = useState(14);
  const [selectedHotel, setSelectedHotel] = useState("");
  const [recipient, setRecipient] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [resend, setResend] = useState(false);
  const [role, setRole] = useState("manager");
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState(null);
  const createAttempt = useRef(null);
  const inviteAttempt = useRef(null);
  const attempt = (ref, details) => {
    const fingerprint = JSON.stringify(details);
    if (ref.current?.fingerprint !== fingerprint) ref.current = { fingerprint, requestId: crypto.randomUUID() };
    return ref.current.requestId;
  };
  useEffect(() => {
    let canceled = false;
    Promise.all([getHotelSubscriptions(), getHotelOnboardingStatus()]).then(([items, status]) => {
      if (!canceled) { setHotels(items); setSelectedHotel(items[0]?.hotelUid || ""); setRolloutReady(status.enabled === true); }
    }).catch(() => { if (!canceled) setMessage({ error: true, text: "Hotel setup could not be loaded. Refresh this page before continuing." }); });
    return () => { canceled = true; };
  }, []);

  const create = async (event) => {
    event.preventDefault();
    if (busy || rolloutReady !== true) return;
    setBusy("create"); setMessage(null);
    const details = { name, hotelUid, status, trialDays: Number(trialDays) };
    try {
      const result = await createHotel({ ...details, requestId: attempt(createAttempt, details) });
      await refreshHotelAssignments();
      setHotels((items) => [...items.filter((h) => h.hotelUid !== result.hotelUid), { hotelUid: result.hotelUid, hotelName: result.name }]);
      setSelectedHotel(result.hotelUid);
      setMessage({ text: `${result.name} is ready. Invite the first hotel manager below.` });
      setName(""); setHotelUid(""); createAttempt.current = null;
    } catch (error) { setMessage({ error: true, text: messageFor(error) }); }
    finally { setBusy(""); }
  };
  const invite = async (event) => {
    event.preventDefault();
    if (busy || rolloutReady !== true) return;
    setBusy("invite"); setMessage(null);
    const details = { hotelUid: selectedHotel, email: recipient, firstName, lastName, role, resend };
    try {
      await inviteHotelUser({ ...details, requestId: attempt(inviteAttempt, details) });
      setMessage({ text: `Access has been assigned to ${recipient}. Their invitation is queued for email delivery.` });
      setRecipient(""); setFirstName(""); setLastName(""); setResend(false); inviteAttempt.current = null;
    } catch (error) { setMessage({ error: true, text: messageFor(error) }); }
    finally { setBusy(""); }
  };

  return <div className="min-h-screen bg-[#f6f4f1] text-slate-900">
    <HeaderBar today={new Date().toLocaleDateString("en-GB")} onLogout={() => signOut(auth)} />
    <PageContainer className="space-y-7">
      <div><p className="text-xs font-semibold uppercase tracking-widest text-[#b41f1f]">Platform administration</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">Set up a hotel</h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-600">Create a property, assign its access period and invite the team. Each hotel has its own data and permissions.</p></div>
      <div className="flex gap-3 rounded-2xl border border-slate-200 bg-white p-5"><ShieldCheck className="shrink-0 text-[#b41f1f]" size={22} />
        <p className="text-sm leading-6 text-slate-600">Hotel roles apply to the selected property. A hotel manager receives all hotel permissions and can manage supplier credentials. Platform administrator access is managed separately. Invoicing remains manual.</p></div>
      {message && <p role={message.error ? "alert" : "status"} className={`rounded-xl border p-4 text-sm ${message.error ? "border-red-200 bg-red-50 text-red-800" : "border-emerald-200 bg-emerald-50 text-emerald-800"}`}>{message.text}</p>}
      {rolloutReady === false && <div role="status" className="rounded-xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-900">
        <p className="font-semibold">Hotel setup is awaiting platform activation</p>
        <p className="mt-2 leading-6">Your platform operator must complete the verified Firebase release before hotels and invitations can be created.</p>
        <button type="button" className="mt-3 font-semibold underline" onClick={async () => {
          try { setRolloutReady((await getHotelOnboardingStatus()).enabled === true); }
          catch { setMessage({ error: true, text: "Activation status could not be checked. Please retry." }); }
        }}>Check activation again</button>
      </div>}
      <div className="grid items-start gap-6 lg:grid-cols-2">
        <form onSubmit={create} className="space-y-5 rounded-2xl border border-slate-200 bg-white p-6">
          <Building2 size={24} className="text-[#b41f1f]" /><div><p className="text-xs font-semibold uppercase tracking-widest text-slate-400">Step 1</p><h2 className="mt-2 text-xl font-semibold">Create a property</h2></div>
          <label className="block text-sm font-medium">Hotel name<input required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} className={fieldClass} disabled={Boolean(busy)} /></label>
          <label className="block text-sm font-medium">Hotel ID<input required pattern="[a-z0-9][a-z0-9-]{2,59}" value={hotelUid} onChange={(e) => setHotelUid(e.target.value.toLowerCase())} className={fieldClass} disabled={Boolean(busy)} /><span className="mt-2 block text-xs font-normal text-slate-500">A unique, permanent ID, such as riverside-hotel.</span></label>
          <label className="block text-sm font-medium">Initial access<select value={status} onChange={(e) => setStatus(e.target.value)} className={fieldClass} disabled={Boolean(busy)}><option value="trialing">Trial</option><option value="active">Active · manual invoicing</option></select></label>
          {status === "trialing" && <label className="block text-sm font-medium">Trial length in days<input required type="number" min={1} max={90} value={trialDays} onChange={(e) => setTrialDays(e.target.value)} className={fieldClass} disabled={Boolean(busy)} /></label>}
          <button disabled={Boolean(busy) || rolloutReady !== true} className={buttonClass}>{busy === "create" && <Loader2 size={16} className="animate-spin" />}Create hotel</button>
        </form>
        <form onSubmit={invite} className="space-y-5 rounded-2xl border border-slate-200 bg-white p-6">
          <Mail size={24} className="text-[#b41f1f]" /><div><p className="text-xs font-semibold uppercase tracking-widest text-slate-400">Step 2</p><h2 className="mt-2 text-xl font-semibold">Invite a team member</h2></div>
          <label className="block text-sm font-medium">Hotel<select required value={selectedHotel} onChange={(e) => setSelectedHotel(e.target.value)} className={fieldClass} disabled={Boolean(busy)}><option value="">Choose a hotel</option>{hotels.map((h) => <option key={h.hotelUid} value={h.hotelUid}>{h.hotelName}</option>)}</select></label>
          <div className="grid gap-4 sm:grid-cols-2"><label className="block text-sm font-medium">First name<input maxLength={80} value={firstName} onChange={(e) => setFirstName(e.target.value)} className={fieldClass} disabled={Boolean(busy)} /></label><label className="block text-sm font-medium">Last name<input maxLength={80} value={lastName} onChange={(e) => setLastName(e.target.value)} className={fieldClass} disabled={Boolean(busy)} /></label></div>
          <label className="block text-sm font-medium">Email address<input required type="email" maxLength={254} value={recipient} onChange={(e) => setRecipient(e.target.value)} className={fieldClass} disabled={Boolean(busy)} /></label>
          <label className="block text-sm font-medium">Hotel role<select value={role} onChange={(e) => setRole(e.target.value)} className={fieldClass} disabled={Boolean(busy)}>{Object.entries(roles).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
          <label className="flex items-start gap-3 text-sm"><input type="checkbox" checked={resend} disabled={Boolean(busy)} onChange={(event) => setResend(event.target.checked)} />Resend an invitation to an existing member and keep their current access.</label>
          <p className="text-xs leading-5 text-slate-500">New users receive password setup and email verification links. Existing accounts keep their password and access to other hotels. An order approver must also be assigned to an outlet.</p>
          <button disabled={Boolean(busy) || !selectedHotel || rolloutReady !== true} className={buttonClass}>{busy === "invite" && <Loader2 size={16} className="animate-spin" />}{resend ? "Resend invitation" : "Assign access and send invitation"}</button>
        </form>
      </div>
      <Link to="/settings/subscriptions" className="inline-block text-sm font-semibold text-[#9b1c1c] hover:underline">Manage hotel subscriptions →</Link>
    </PageContainer>
  </div>;
}
