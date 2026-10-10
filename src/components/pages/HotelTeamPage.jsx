import React, { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import ModuleRolePicker from "../shared/ModuleRolePicker";
import { useHotelContext } from "../../contexts/HotelContext";
import { auth, signOut } from "../../firebaseConfig";
import { getHotelTeam, updateHotelMember, removeHotelMember } from "../../services/firebaseHotelTeam";
import { inviteHotelUser } from "../../services/firebaseOnboarding";
import { PERMISSION_CATALOG } from "../../constants/permissionCatalog";
import { FEATURE_MODULE, MODULE_CATALOG, CORE_FEATURES } from "../../constants/moduleCatalog";

const inputClass = "mt-2 w-full rounded-lg border border-slate-300 bg-white p-2.5";
const blank = () => ({ firstName: "", lastName: "", email: "", hotelAdmin: false, moduleRoles: {}, additionalPermissions: [] });
function editAccess(member) {
  return { ...blank(), ...member, additionalPermissions: (member.additionalPermissions ?? member.permissions ?? [])
    .filter((key) => !key.startsWith("users.")) };
}
function errorMessage(error) {
  if (error?.code === "functions/aborted") return "This member changed. Refresh the team before trying again.";
  return error?.message || "The hotel team could not be updated. Please retry.";
}

export default function HotelTeamPage({ platform = false }) {
  const context = useHotelContext();
  const route = useParams();
  const hotelUid = platform ? route.hotelUid : context.hotelUid;
  return <ScopedHotelTeamPage key={`${hotelUid}:${platform}`} platform={platform} hotelUid={hotelUid} />;
}

function ScopedHotelTeamPage({ platform, hotelUid }) {
  const context = useHotelContext();
  const hotelName = platform ? hotelUid : context.hotelName;
  const isHotelAdmin = context.isHotelAdmin;
  const isPlatformAdmin = platform && context.isPlatformAdmin;
  const [team, setTeam] = useState({ users: [], modules: [], seatLimit: null });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(blank);
  const [confirmRemoval, setConfirmRemoval] = useState(false);
  const attempt = useRef(null);
  const request = useRef(0);
  const operation = useRef(0);
  const scope = useRef(hotelUid);
  scope.current = hotelUid;
  const canManage = isHotelAdmin || isPlatformAdmin;
  const load = async () => {
    const sequence = ++request.current;
    setLoading(true); setError("");
    try {
      const data = await getHotelTeam(hotelUid);
      if (sequence === request.current) setTeam(data);
    } catch (failure) { if (sequence === request.current) setError(errorMessage(failure)); }
    finally { if (sequence === request.current) setLoading(false); }
  };
  useEffect(() => {
    operation.current++; setBusy(false);
    setEditing(null); setForm(blank()); setConfirmRemoval(false); setMessage(""); attempt.current = null;
    if (canManage) load();
    return () => { request.current++; operation.current++; };
  }, [hotelUid, canManage]);
  const change = (name, value) => { setForm((previous) => ({ ...previous, [name]: value })); attempt.current = null; };
  const select = (member) => { setEditing(member.id); setForm(editAccess(member)); setError(""); setMessage(""); setConfirmRemoval(false); attempt.current = null; };
  const reset = () => { setEditing(null); setForm(blank()); setConfirmRemoval(false); attempt.current = null; };
  const save = async (event) => {
    event.preventDefault();
    if (!canManage || busy || loading || error) return;
    const sequence = ++operation.current;
    const current = () => operation.current === sequence && scope.current === hotelUid;
    setBusy(true); setMessage("");
    try {
      if (editing) await updateHotelMember({ hotelUid, userId: editing, ...form, expectedRevision: form.revision });
      else {
        attempt.current ||= crypto.randomUUID();
        await inviteHotelUser({ hotelUid, ...form, requestId: attempt.current });
      }
      if (!current()) return;
      reset(); await load(); if (current()) setMessage(editing ? "Hotel access updated." : "Hotel access assigned. The invitation is queued for delivery.");
    } catch (failure) { if (current()) setError(errorMessage(failure)); }
    finally { if (current()) setBusy(false); }
  };
  const resend = async () => {
    if (!editing || busy) return;
    const sequence = ++operation.current;
    const current = () => operation.current === sequence && scope.current === hotelUid;
    setBusy(true); setError(""); setMessage("");
    try {
      attempt.current ||= crypto.randomUUID();
      await inviteHotelUser({ hotelUid, email: form.email, resend: true, requestId: attempt.current });
      if (current()) { attempt.current = null; setMessage("Invitation queued again. Existing access has been preserved."); }
    } catch (failure) { if (current()) setError(errorMessage(failure)); }
    finally { if (current()) setBusy(false); }
  };
  const remove = async () => {
    if (!editing || busy) return;
    const sequence = ++operation.current;
    const current = () => operation.current === sequence && scope.current === hotelUid;
    setBusy(true); setError("");
    try {
      attempt.current ||= crypto.randomUUID();
      await removeHotelMember({ hotelUid, userId: editing, expectedRevision: form.revision, requestId: attempt.current });
      if (!current()) return;
      reset(); await load(); if (current()) setMessage("Access to this hotel removed. The account and its other hotel assignments are preserved.");
    } catch (failure) { if (current()) setError(errorMessage(failure)); }
    finally { if (current()) setBusy(false); }
  };
  if (!canManage) return <PageContainer as={platform ? "div" : "main"}><p role="alert">Hotel administrator access is required.</p></PageContainer>;
  return <div className="min-h-screen bg-slate-50 text-slate-900">
    <HeaderBar today={new Date().toLocaleDateString("en-GB")} onLogout={() => signOut(auth)} />
    <PageContainer as={platform ? "div" : "main"} className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3"><div><h1 className="text-3xl font-semibold">Hotel team</h1>
        <p className="mt-2 text-sm text-slate-600">Manage named accounts and module roles for {hotelName}. Other hotels remain separate.</p></div>
        <button disabled={busy || loading} onClick={load} className="rounded-lg border bg-white px-4 py-2 text-sm">Refresh team</button></div>
      {error && <p role="alert" className="rounded-lg bg-red-50 p-4 text-sm text-red-800">{error}</p>}
      {message && <p role="status" className="rounded-lg bg-emerald-50 p-4 text-sm text-emerald-800">{message}</p>}
      {loading ? <p role="status">Loading hotel team...</p> : <div className="grid items-start gap-6 lg:grid-cols-2">
        <div className="overflow-x-auto rounded-xl border bg-white p-5"><p className="mb-4 text-sm text-slate-600">{team.users.length} assigned accounts · {team.seatLimit === null ? "No user limit" : `Limit: ${team.seatLimit}`}. Invited accounts count as assigned users.</p>
          <table className="w-full text-left text-sm"><caption className="sr-only">Team members for this hotel</caption><thead><tr><th className="pb-3">Member</th><th className="pb-3">Administration</th></tr></thead>
            <tbody>{team.users.map((member) => <tr key={member.id} className="border-t"><td className="py-3"><button disabled={busy} onClick={() => select(member)} className="text-left text-brand-800 underline">{[member.firstName, member.lastName].filter(Boolean).join(" ") || member.email || member.id}</button><p className="mt-1 text-xs text-slate-500">{member.email}</p></td><td>{member.hotelAdmin ? "Hotel administrator" : "Member"}</td></tr>)}</tbody>
          </table><button disabled={busy} onClick={reset} className="mt-5 rounded-lg bg-brand-800 px-4 py-2 text-sm font-semibold text-white">Invite a member</button>
        </div>
        <form onSubmit={save} className="space-y-5 rounded-xl border bg-white p-6">
          <h2 className="text-xl font-semibold">{editing ? "Edit hotel access" : "Invite a member"}</h2>
          <fieldset disabled={busy} className="space-y-4"><div className="grid gap-4 sm:grid-cols-2">
            <label className="text-sm">First name<input maxLength={80} value={form.firstName} onChange={(event) => change("firstName", event.target.value)} className={inputClass} /></label>
            <label className="text-sm">Last name<input maxLength={80} value={form.lastName} onChange={(event) => change("lastName", event.target.value)} className={inputClass} /></label></div>
            <label className="block text-sm">Email<input required type="email" maxLength={254} readOnly={Boolean(editing)} value={form.email} onChange={(event) => change("email", event.target.value)} className={inputClass} /></label>
            <label className="flex items-start gap-3 text-sm"><input type="checkbox" checked={form.hotelAdmin} onChange={(event) => change("hotelAdmin", event.target.checked)} />Hotel administrator</label>
            <p className="text-xs leading-5 text-slate-500">Administrators can invite and manage this hotel's members and grant licensed module roles. Operational access is assigned separately. Keep two administrators where possible; the last administrator cannot be removed.</p>
          </fieldset>
          <ModuleRolePicker modules={team.modules} value={form.moduleRoles} onChange={(value) => change("moduleRoles", value)} disabled={busy} />
          <details className="rounded-lg border p-4"><summary className="cursor-pointer text-sm font-semibold">Advanced permissions ({form.additionalPermissions.length})</summary>
            <p className="mt-3 text-xs leading-5 text-slate-500">Existing custom permissions are preserved. Permissions for inactive modules remain stored and blocked. Hotel administration is managed by the separate checkbox.</p>
            {Object.entries(PERMISSION_CATALOG).filter(([feature]) => feature !== "users" && (CORE_FEATURES.includes(feature.toLowerCase()) || FEATURE_MODULE[feature.toLowerCase()])).map(([feature, actions]) => {
              const licensed = CORE_FEATURES.includes(feature.toLowerCase()) || team.modules.includes(FEATURE_MODULE[feature.toLowerCase()]);
              const displayed = [...actions, ...(form.additionalPermissions.includes(`${feature.toLowerCase()}.*`) ? ["*"] : [])];
              if (!licensed && !displayed.some((action) => form.additionalPermissions.includes(`${feature.toLowerCase()}.${action}`))) return null;
              return <fieldset key={feature} disabled={busy || !licensed} className="mt-4"><legend className="text-xs font-semibold">{MODULE_CATALOG[FEATURE_MODULE[feature.toLowerCase()]]?.label || "Platform basics"} · {feature}</legend><div className="mt-2 flex flex-wrap gap-3">{displayed.map((action) => {
                const key = `${feature.toLowerCase()}.${action}`;
                return <label key={key} className="flex flex-wrap items-center gap-2 text-xs"><input type="checkbox" checked={form.additionalPermissions.includes(key)} onChange={() => change("additionalPermissions", form.additionalPermissions.includes(key) ? form.additionalPermissions.filter((item) => item !== key) : [...form.additionalPermissions, key])} />{action === "*" ? "All actions (legacy)" : action}</label>;
              })}</div></fieldset>;
            })}
          </details>
          <button disabled={busy || loading || Boolean(error)} className="rounded-lg bg-brand-800 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{busy ? "Saving..." : editing ? "Save hotel access" : "Assign access and send invitation"}</button>
          {editing && <div className="flex flex-wrap gap-4 border-t pt-4"><button type="button" disabled={busy} onClick={resend} className="text-sm text-brand-800 underline">Resend invitation</button><button type="button" disabled={busy} onClick={() => setConfirmRemoval(true)} className="text-sm text-red-800 underline">Remove hotel access</button></div>}
          {confirmRemoval && <div role="alertdialog" aria-label="Confirm hotel access removal" className="rounded-lg border border-red-200 bg-red-50 p-4"><p className="text-sm">Remove {form.email}'s access to this hotel? Their account and other hotel memberships are preserved.</p><div className="mt-3 flex gap-4"><button type="button" disabled={busy} onClick={remove} className="text-sm font-semibold text-red-800">Confirm removal</button><button type="button" disabled={busy} onClick={() => setConfirmRemoval(false)} className="text-sm">Keep access</button></div></div>}
        </form>
      </div>}
    </PageContainer>
  </div>;
}
