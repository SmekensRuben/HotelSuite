import React, { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, Plus, Trash2, X } from "lucide-react";
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
import { createEmptyMarshaBalanceSettings, enumerateDates, evaluateSimplifiedBalance, getBrusselsDateString, getDefaultBalanceRange, getSourceState, validateBalanceSettings } from "../../utils/marshaBalance";

const resultColors = { ok: "text-green-700", warning: "text-amber-700", review: "text-amber-700", action: "text-red-700", unreliable: "text-red-700", unassessable: "text-red-700", unconfigured: "text-gray-600" };
function Result({ value }) {
  const Icon = value.code === "ok" || value.status === "current" ? Check : ["action", "unreliable", "unassessable"].includes(value.code) || value.status === "missing" ? X : AlertTriangle;
  return <span className={`inline-flex items-center gap-1 font-semibold ${resultColors[value.code] || (value.status === "current" ? "text-green-700" : value.status === "missing" ? "text-red-700" : "text-amber-700")}`}><Icon className="h-4 w-4" />{value.label}</span>;
}

export default function MarshaBalancePage() {
  const navigate = useNavigate();
  const { hotelUid } = useHotelContext();
  const canUpdate = usePermission("marshaBalance", "update");
  const initialRange = useMemo(() => getDefaultBalanceRange(), []);
  const [from, setFrom] = useState(initialRange.from);
  const [to, setTo] = useState(initialRange.to);
  const [activeTab, setActiveTab] = useState("overview");
  const [statusFilter, setStatusFilter] = useState("");
  const [data, setData] = useState(null);
  const [settings, setSettings] = useState(createEmptyMarshaBalanceSettings());
  const [previewDate, setPreviewDate] = useState(initialRange.from);
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
      .then(([nextData, nextSettings]) => { if (active) { setData(nextData); setSettings({ ...createEmptyMarshaBalanceSettings(), ...nextSettings }); setPreviewDate(dates[0]); } })
      .catch((loadError) => { console.error(loadError); if (active) setError("MARSHA Balance data could not be loaded."); })
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [hotelUid, from, to]);

  const evaluateDate = (stayDate) => {
    if (!data) return { code: "unassessable", label: "Cannot assess", alerts: [] };
    const marshaDoc = data.marsha.stays[stayDate];
    const operaDoc = data.opera.stays[stayDate];
    const marshaState = data.marsha.snapshotDate ? getSourceState({ stayDocument: marshaDoc, snapshotDate: data.marsha.snapshotDate, today, metadata: data.marsha.metadata }) : { status: "missing" };
    const operaState = data.opera.snapshotDate ? getSourceState({ stayDocument: operaDoc, snapshotDate: data.opera.snapshotDate, today, metadata: data.opera.metadata }) : { status: "missing" };
    if (!marshaDoc || !operaDoc || data.marsha.snapshotDate !== data.opera.snapshotDate || marshaState.status !== "current" || operaState.status !== "current") return { code: "unassessable", label: "Cannot assess", alerts: [{ severity: "unassessable", code: "source_data", title: "Source data problem", message: "Current, complete stay-date documents from comparable snapshots are required." }] };
    return evaluateSimplifiedBalance({ marshaRooms: marshaDoc.roomsByType, operaRooms: operaDoc.roomsByType, marshaTotal: marshaDoc.mappedTotal, operaTotal: operaDoc.mappedTotal, settings, stayDate });
  };

  const rows = useMemo(() => !data ? [] : dates.map((stayDate) => {
    const marshaDoc = data.marsha.stays[stayDate];
    const operaDoc = data.opera.stays[stayDate];
    const marshaState = data.marsha.snapshotDate ? getSourceState({ stayDocument: marshaDoc, snapshotDate: data.marsha.snapshotDate, today, metadata: data.marsha.metadata }) : { status: "missing", label: "Missing" };
    const operaState = data.opera.snapshotDate ? getSourceState({ stayDocument: operaDoc, snapshotDate: data.opera.snapshotDate, today, metadata: data.opera.metadata }) : { status: "missing", label: "Missing" };
    const balance = evaluateDate(stayDate);
    return { id: stayDate, stayDate, marshaState, operaState, balance, healthy: marshaState.status === "current" && operaState.status === "current" && balance.code === "ok" };
  }), [data, dates, settings, today]);
  const filteredRows = statusFilter ? rows.filter((row) => row.balance.code === statusFilter) : rows;
  const preview = evaluateDate(previewDate);
  const detectedOperaCodes = [...new Set(Object.values(data?.opera.stays || {}).flatMap((doc) => Object.keys(doc?.roomsByType || {})))].sort();
  const detectedMarshaCodes = [...new Set(Object.values(data?.marsha.stays || {}).flatMap((doc) => Object.keys(doc?.roomsByType || {})))].sort();
  const updatePremium = (index, patch) => setSettings((current) => ({ ...current, premiumCategories: current.premiumCategories.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item) }));
  const save = async () => {
    const validationErrors = validateBalanceSettings(settings);
    if (validationErrors.length) return toast.error(validationErrors[0]);
    const cleanSettings = { minimumGenr: Number(settings.minimumGenr), weekendDbdbProtection: true, premiumCategories: settings.premiumCategories.map((item) => ({ marshaCode: item.marshaCode.trim().toUpperCase(), operaType: item.operaType.trim().toUpperCase(), allowedHigherOperaTypes: [...new Set((item.allowedHigherOperaTypes || []).map((code) => code.trim().toUpperCase()).filter(Boolean))] })) };
    setSaving(true);
    try { await saveMarshaBalanceSettings(hotelUid, cleanSettings); setSettings(cleanSettings); toast.success("MARSHA Balance settings saved."); }
    catch (saveError) { console.error(saveError); toast.error("Settings could not be saved."); }
    finally { setSaving(false); }
  };
  const logout = async () => { await signOut(auth); sessionStorage.clear(); window.location.href = "/login"; };
  const columns = [
    { key: "stayDate", label: "Date" },
    { key: "marsha", label: "MARSHA data", sortable: false, render: (row) => <Result value={row.marshaState} /> },
    { key: "opera", label: "Opera data", sortable: false, render: (row) => <Result value={row.operaState} /> },
    { key: "balance", label: "Balance", sortValue: (row) => row.balance.label, render: (row) => <div><Result value={row.balance} />{row.balance.alerts?.length > 1 && <span className="ml-2 text-xs text-gray-500">{row.balance.alerts.length} reasons</span>}</div> },
  ];

  return <div className="min-h-screen bg-gray-50 text-gray-900"><HeaderBar today={new Date().toLocaleDateString("en-GB", { timeZone: "Europe/Brussels", weekday: "long", month: "long", day: "numeric" })} onLogout={logout} /><PageContainer className="space-y-6">
    <div><p className="text-sm uppercase tracking-wide text-gray-500">Front Office</p><h1 className="text-3xl font-semibold">MARSHA Balance</h1><p className="mt-1 text-gray-600">Read-only controls for mapped totals, GENR availability, premium shortages, and weekend DBDB protection.</p></div>
    <div className="flex border-b"><button className={`px-4 py-2 ${activeTab === "overview" ? "border-b-2 border-[#b41f1f] font-semibold" : ""}`} onClick={() => setActiveTab("overview")}>Overview</button><button className={`px-4 py-2 ${activeTab === "settings" ? "border-b-2 border-[#b41f1f] font-semibold" : ""}`} onClick={() => setActiveTab("settings")}>Settings</button></div>
    {error && <div className="rounded-lg bg-red-50 p-4 text-red-800">{error}</div>}
    {activeTab === "overview" && <><Card className="flex flex-wrap items-end gap-4"><label className="text-sm font-medium">From<input type="date" value={from} onChange={(event) => setFrom(event.target.value)} className="mt-1 block rounded-lg border px-3 py-2" /></label><label className="text-sm font-medium">To<input type="date" value={to} onChange={(event) => setTo(event.target.value)} className="mt-1 block rounded-lg border px-3 py-2" /></label><label className="text-sm font-medium">Result<select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} className="mt-1 block rounded-lg border bg-white px-3 py-2"><option value="">All results</option><option value="ok">Within rules</option><option value="warning">Warning</option><option value="review">Review</option><option value="action">Action required</option><option value="unreliable">Cannot reliably assess</option><option value="unassessable">Cannot assess</option><option value="unconfigured">Not configured</option></select></label></Card>{loading ? <p>Loading data…</p> : <DataListTable columns={columns} rows={filteredRows} emptyMessage="No stay dates match these filters." onRowClick={(row) => navigate(`/front-office/marsha-balance/${row.stayDate}`)} getRowProps={(row) => ({ className: row.healthy ? "bg-green-50 hover:bg-green-100" : ["warning", "review", "unconfigured"].includes(row.balance.code) ? "bg-amber-50 hover:bg-amber-100" : "bg-red-50 hover:bg-red-100" })} />}</>}
    {activeTab === "settings" && <div className="space-y-6"><Card className="space-y-4"><div><h2 className="text-xl font-semibold">GENR control</h2><p className="text-sm text-gray-600">The desired GENR minimum is capped by the explicit MARSHA total and, on protected weekend nights, by the DBDB boundary.</p></div><label className="block text-sm font-medium">X: desired minimum GENR<input type="number" min="0" step="1" value={settings.minimumGenr} disabled={!canUpdate} onChange={(event) => setSettings((current) => ({ ...current, minimumGenr: Number(event.target.value) }))} className="mt-1 block w-48 rounded border px-3 py-2" /></label><p className="rounded bg-blue-50 p-3 text-sm text-blue-800">Opera DBDB protection is always active for Friday and Saturday stay nights.</p></Card>
      <Card className="space-y-4"><div className="flex justify-between gap-3"><div><h2 className="text-xl font-semibold">Premium shortage controls</h2><p className="text-sm text-gray-600">Configure the corresponding Opera type and only the explicitly suitable higher types for each premium MARSHA category.</p></div>{canUpdate && <button onClick={() => setSettings((current) => ({ ...current, premiumCategories: [...current.premiumCategories, { marshaCode: "", operaType: "", allowedHigherOperaTypes: [] }] }))} className="h-fit rounded border px-3 py-2 text-sm"><Plus className="mr-1 inline h-4 w-4" />Add premium category</button>}</div>{settings.premiumCategories.map((category, index) => <div key={`${index}-${category.marshaCode}`} className="grid gap-3 rounded-lg border p-4 md:grid-cols-[1fr_1fr_2fr_auto]"><label className="text-xs font-medium">MARSHA premium category<select value={category.marshaCode} disabled={!canUpdate} onChange={(event) => updatePremium(index, { marshaCode: event.target.value })} className="mt-1 block w-full rounded border bg-white px-2 py-2"><option value="">Select category</option>{detectedMarshaCodes.map((code) => <option key={code}>{code}</option>)}</select></label><label className="text-xs font-medium">Corresponding Opera type<select value={category.operaType} disabled={!canUpdate} onChange={(event) => updatePremium(index, { operaType: event.target.value })} className="mt-1 block w-full rounded border bg-white px-2 py-2"><option value="">Select type</option>{detectedOperaCodes.map((code) => <option key={code}>{code}</option>)}</select></label><div><p className="text-xs font-medium">Allowed higher Opera types</p><div className="mt-1 flex flex-wrap gap-2">{detectedOperaCodes.filter((code) => code !== category.operaType).map((code) => { const selected = category.allowedHigherOperaTypes.includes(code); return <button key={code} type="button" disabled={!canUpdate} onClick={() => updatePremium(index, { allowedHigherOperaTypes: selected ? category.allowedHigherOperaTypes.filter((item) => item !== code) : [...category.allowedHigherOperaTypes, code] })} className={`rounded border px-2 py-1 text-xs ${selected ? "border-[#b41f1f] bg-red-50" : "bg-white"}`}>{selected ? "✓ " : ""}{code}</button>; })}</div></div>{canUpdate && <button onClick={() => setSettings((current) => ({ ...current, premiumCategories: current.premiumCategories.filter((_, itemIndex) => itemIndex !== index) }))} className="self-end pb-2 text-red-700"><Trash2 className="h-4 w-4" /></button>}</div>)}</Card>
      <Card className="space-y-3"><div className="flex flex-wrap items-end justify-between gap-3"><div><h2 className="text-xl font-semibold">Preview before saving</h2><p className="text-sm text-gray-600">Uses a real stay date and the unsaved simplified settings.</p></div><label className="text-sm font-medium">Stay date<select value={previewDate} onChange={(event) => setPreviewDate(event.target.value)} className="ml-2 rounded border bg-white px-3 py-2">{dates.map((date) => <option key={date}>{date}</option>)}</select></label></div><div className="rounded border p-4"><Result value={preview} /><div className="mt-3 space-y-2">{preview.alerts?.length ? preview.alerts.map((item, index) => <div key={`${item.code}-${index}`} className="rounded bg-gray-50 p-3 text-sm"><strong>{item.title}</strong><p>{item.message}</p></div>) : <p className="text-sm text-gray-600">No findings for this stay date.</p>}</div></div>{canUpdate && <button disabled={saving} onClick={save} className="rounded-lg bg-[#b41f1f] px-4 py-2 font-semibold text-white disabled:opacity-50">{saving ? "Saving…" : "Save settings"}</button>}</Card>
    </div>}
  </PageContainer></div>;
}
