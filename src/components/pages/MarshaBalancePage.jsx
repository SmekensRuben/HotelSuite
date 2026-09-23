import React, { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, X } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { toast } from "react-toastify";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import DataListTable from "../shared/DataListTable";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { usePermission } from "../../hooks/usePermission";
import { getMarshaBalanceData, getMarshaBalanceSettings, saveMarshaBalanceSettings } from "../../services/firebaseMarshaBalance";
import { enumerateDates, evaluateBalance, findOverlappingOperaTypes, getBrusselsDateString, getDefaultBalanceRange, getSourceState } from "../../utils/marshaBalance";

const emptyRule = () => ({ id: crypto.randomUUID(), marshaRoomType: "", operaRoomTypes: [], comparisonMode: "exact", reservedRooms: 0, allowedDeviation: 0, lowerDeviation: 0, upperDeviation: 0, enabled: false });

function Status({ state }) {
  if (state.status === "current" || state.status === "ok") return <span className="inline-flex items-center gap-1 font-medium text-green-700"><Check className="h-4 w-4" aria-hidden="true" />{state.label}</span>;
  if (["missing", "critical", "unassessable"].includes(state.status)) return <span className="inline-flex items-center gap-1 font-medium text-red-700"><X className="h-4 w-4" aria-hidden="true" />{state.label}</span>;
  return <span className="inline-flex items-center gap-1 font-medium text-amber-700"><AlertTriangle className="h-4 w-4" aria-hidden="true" />{state.label}</span>;
}

function OperaTypesInput({ values, disabled, onChange }) {
  const [draft, setDraft] = useState("");
  const addValues = (raw) => {
    const additions = raw.split(",").map((value) => value.trim().toUpperCase()).filter(Boolean);
    if (additions.length) onChange([...new Set([...values, ...additions])]);
    setDraft("");
  };
  return <div className="mt-1 rounded border bg-white p-2">
    <div className="mb-1 flex flex-wrap gap-1">{values.map((type) => <span key={type} className="inline-flex items-center gap-1 rounded bg-gray-100 px-2 py-1 text-xs">{type}{!disabled && <button type="button" aria-label={`Remove ${type}`} onClick={() => onChange(values.filter((value) => value !== type))}>×</button>}</span>)}</div>
    <input value={draft} disabled={disabled} placeholder={values.length ? "Add another type" : "Type QNK, then press Enter"} className="w-full border-0 p-0 text-sm outline-none" onChange={(event) => setDraft(event.target.value)} onBlur={() => addValues(draft)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === ",") { event.preventDefault(); addValues(draft); } }} />
  </div>;
}

export default function MarshaBalancePage() {
  const navigate = useNavigate();
  const { hotelUid } = useHotelContext();
  const canUpdate = usePermission("marshaBalance", "update");
  const initialRange = useMemo(() => getDefaultBalanceRange(), []);
  const [from, setFrom] = useState(initialRange.from);
  const [to, setTo] = useState(initialRange.to);
  const [statusFilter, setStatusFilter] = useState("");
  const [activeTab, setActiveTab] = useState("overview");
  const [data, setData] = useState(null);
  const [rules, setRules] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const today = getBrusselsDateString();
  const dates = useMemo(() => enumerateDates(from, to), [from, to]);

  useEffect(() => {
    let active = true;
    if (!hotelUid || !dates.length) { setLoading(false); return () => { active = false; }; }
    setLoading(true); setError("");
    Promise.all([getMarshaBalanceData(hotelUid, dates, today), getMarshaBalanceSettings(hotelUid)])
      .then(([nextData, settings]) => { if (active) { setData(nextData); setRules(Array.isArray(settings.rules) ? settings.rules : []); } })
      .catch((loadError) => { console.error(loadError); if (active) setError("MARSHA Balance data could not be loaded."); })
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [hotelUid, from, to]);

  const rows = useMemo(() => !data ? [] : dates.map((stayDate) => {
    const marshaDoc = data.marsha.stays[stayDate];
    const operaDoc = data.opera.stays[stayDate];
    const marshaState = data.marsha.snapshotDate ? getSourceState({ stayDocument: marshaDoc, snapshotDate: data.marsha.snapshotDate, today, metadata: data.marsha.metadata }) : { status: "missing", label: "Missing" };
    const operaState = data.opera.snapshotDate ? getSourceState({ stayDocument: operaDoc, snapshotDate: data.opera.snapshotDate, today, metadata: data.opera.metadata }) : { status: "missing", label: "Missing" };
    const comparable = data.marsha.snapshotDate && data.opera.snapshotDate && data.marsha.snapshotDate === data.opera.snapshotDate;
    const balance = !marshaDoc || !operaDoc || !comparable
      ? { status: "unassessable", label: "Cannot assess", reason: !comparable ? "The sources do not use the same snapshot date." : "A required stay-date document is missing.", calculations: [] }
      : evaluateBalance(marshaDoc.roomsByType, operaDoc.roomsByType, rules);
    const healthy = marshaState.status === "current" && operaState.status === "current" && balance.status === "ok";
    return { id: stayDate, stayDate, marshaState, operaState, balance, healthy };
  }), [data, dates, rules, today]);
  const filteredRows = statusFilter ? rows.filter((row) => row.balance.status === statusFilter) : rows;
  const updateRule = (id, field, value) => setRules((current) => current.map((rule) => rule.id === id ? { ...rule, [field]: value } : rule));

  const saveRules = async () => {
    const overlaps = findOverlappingOperaTypes(rules);
    if (overlaps.length) return toast.error(`Opera room types can only be used by one active rule: ${overlaps.join(", ")}`);
    if (rules.some((rule) => rule.enabled && (!rule.marshaRoomType.trim() || !rule.operaRoomTypes.length))) return toast.error("Every active rule needs a MARSHA type and at least one Opera type.");
    setSaving(true);
    try { await saveMarshaBalanceSettings(hotelUid, rules); toast.success("Comparison rules saved."); }
    catch (saveError) { console.error(saveError); toast.error("The rules could not be saved."); }
    finally { setSaving(false); }
  };
  const logout = async () => { await signOut(auth); sessionStorage.clear(); window.location.href = "/login"; };
  const columns = [
    { key: "stayDate", label: "Date" },
    { key: "marsha", label: "MARSHA data", sortable: false, render: (row) => <Status state={row.marshaState} /> },
    { key: "opera", label: "Opera data", sortable: false, render: (row) => <Status state={row.operaState} /> },
    { key: "balance", label: "Balance", sortValue: (row) => row.balance.label, render: (row) => <Status state={row.balance} /> },
  ];

  return <div className="min-h-screen bg-gray-50 text-gray-900">
    <HeaderBar today={new Date().toLocaleDateString("en-GB", { timeZone: "Europe/Brussels", weekday: "long", month: "long", day: "numeric" })} onLogout={logout} />
    <PageContainer className="space-y-6">
      <div><p className="text-sm uppercase tracking-wide text-gray-500">Front Office</p><h1 className="text-3xl font-semibold">MARSHA Balance</h1><p className="mt-1 text-gray-600">Read-only control of nightly MARSHA and Opera availability.</p></div>
      <div className="flex border-b"><button className={`px-4 py-2 ${activeTab === "overview" ? "border-b-2 border-[#b41f1f] font-semibold" : ""}`} onClick={() => setActiveTab("overview")}>Overview</button><button className={`px-4 py-2 ${activeTab === "settings" ? "border-b-2 border-[#b41f1f] font-semibold" : ""}`} onClick={() => setActiveTab("settings")}>Settings</button></div>
      {error && <div className="rounded-lg bg-red-50 p-4 text-red-800">{error}</div>}
      {activeTab === "overview" && <>
        <Card className="flex flex-wrap items-end gap-4">
          <label className="text-sm font-medium">From<input type="date" value={from} onChange={(event) => setFrom(event.target.value)} className="mt-1 block rounded-lg border px-3 py-2" /></label>
          <label className="text-sm font-medium">To<input type="date" value={to} onChange={(event) => setTo(event.target.value)} className="mt-1 block rounded-lg border px-3 py-2" /></label>
          <label className="text-sm font-medium">Status<select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} className="mt-1 block rounded-lg border bg-white px-3 py-2"><option value="">All statuses</option><option value="ok">Balanced</option><option value="review">Review</option><option value="critical">Critical</option><option value="unconfigured">No rules configured</option><option value="unassessable">Cannot assess</option></select></label>
        </Card>
        {from > to && <div className="rounded-lg bg-amber-50 p-4 text-amber-800">The end date must be on or after the start date.</div>}
        {loading ? <p>Loading data…</p> : <DataListTable columns={columns} rows={filteredRows} emptyMessage="No stay dates match these filters." onRowClick={(row) => navigate(`/front-office/marsha-balance/${row.stayDate}`)} getRowProps={(row) => ({ className: row.healthy ? "bg-green-50 hover:bg-green-100" : "bg-red-50 hover:bg-red-100", "aria-label": `Open balance details for ${row.stayDate}` })} />}
      </>}
      {activeTab === "settings" && <Card className="space-y-4">
        <div><h2 className="text-xl font-semibold">Comparison rules</h2><p className="text-sm text-gray-600">A rule maps one MARSHA category to one or more Opera room types. New rules remain inactive until you enable them.</p></div>
        {rules.map((rule) => <div key={rule.id} className="space-y-3 rounded-lg border p-4">
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
            <label className="text-xs font-medium">MARSHA room type<input value={rule.marshaRoomType} disabled={!canUpdate} onChange={(event) => updateRule(rule.id, "marshaRoomType", event.target.value.trim().toUpperCase())} className="mt-1 w-full rounded border px-2 py-2" /></label>
            <label className="text-xs font-medium">Opera room types<OperaTypesInput values={rule.operaRoomTypes || []} disabled={!canUpdate} onChange={(value) => updateRule(rule.id, "operaRoomTypes", value)} /></label>
            <label className="text-xs font-medium">Comparison<select value={rule.comparisonMode} disabled={!canUpdate} onChange={(event) => updateRule(rule.id, "comparisonMode", event.target.value)} className="mt-1 w-full rounded border bg-white px-2 py-2"><option value="exact">Exact match</option><option value="upper">Maximum only</option><option value="range">Allowed range</option></select><span className="mt-1 block font-normal text-gray-500">{rule.comparisonMode === "exact" ? "Adjusted Opera should equal MARSHA." : rule.comparisonMode === "upper" ? "Adjusted Opera may not exceed MARSHA." : "Set a separate allowed difference below and above."}</span></label>
            <label className="text-xs font-medium">Reserved rooms<input type="number" value={rule.reservedRooms} disabled={!canUpdate} onChange={(event) => updateRule(rule.id, "reservedRooms", Number(event.target.value))} className="mt-1 w-full rounded border px-2 py-2" /><span className="mt-1 block font-normal text-gray-500">Rooms deducted from the combined Opera value before comparison.</span></label>
          </div>
          <div className="flex flex-wrap items-end gap-4">
            {rule.comparisonMode === "range" ? <><label className="text-xs font-medium">Allowed below<input type="number" min="0" value={rule.lowerDeviation || 0} disabled={!canUpdate} onChange={(event) => updateRule(rule.id, "lowerDeviation", Number(event.target.value))} className="mt-1 block w-28 rounded border px-2 py-2" /></label><label className="text-xs font-medium">Allowed above<input type="number" min="0" value={rule.upperDeviation || 0} disabled={!canUpdate} onChange={(event) => updateRule(rule.id, "upperDeviation", Number(event.target.value))} className="mt-1 block w-28 rounded border px-2 py-2" /></label></> : <label className="text-xs font-medium">Allowed difference<input type="number" min="0" value={rule.allowedDeviation} disabled={!canUpdate} onChange={(event) => updateRule(rule.id, "allowedDeviation", Number(event.target.value))} className="mt-1 block w-32 rounded border px-2 py-2" /><span className="mt-1 block font-normal text-gray-500">A difference within this number is balanced.</span></label>}
            <label className="flex items-center gap-2 pb-2 text-sm"><input type="checkbox" checked={Boolean(rule.enabled)} disabled={!canUpdate} onChange={(event) => updateRule(rule.id, "enabled", event.target.checked)} /> Active</label>
            {canUpdate && <button className="pb-2 text-sm text-red-700" onClick={() => setRules((current) => current.filter((item) => item.id !== rule.id))}>Remove rule</button>}
          </div>
        </div>)}
        {canUpdate ? <div className="flex gap-3"><button onClick={() => setRules((current) => [...current, emptyRule()])} className="rounded-lg border px-4 py-2 font-semibold">Add rule</button><button disabled={saving} onClick={saveRules} className="rounded-lg bg-[#b41f1f] px-4 py-2 font-semibold text-white disabled:opacity-50">{saving ? "Saving…" : "Save rules"}</button></div> : <p className="text-sm text-amber-700">You have read-only access to these settings.</p>}
      </Card>}
    </PageContainer>
  </div>;
}
