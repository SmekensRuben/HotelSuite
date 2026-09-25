import React, { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowDown, ArrowUp, Check, Plus, Trash2, X } from "lucide-react";
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
import { createEmptyMarshaBalanceSettings, enumerateDates, evaluateOperationalBalance, getBrusselsDateString, getDefaultBalanceRange, getSourceState, validateBalanceSettings } from "../../utils/marshaBalance";

const resultStyles = {
  ok: "text-green-700", upgrade: "text-blue-700", intentional: "text-gray-600", review: "text-amber-700",
  action: "text-red-700", unassessable: "text-red-700", unreliable: "text-red-700", unconfigured: "text-gray-600",
};

function Status({ state }) {
  const Icon = ["ok", "upgrade", "intentional", "current"].includes(state.code || state.status) ? Check : ["action", "unassessable", "unreliable", "missing"].includes(state.code || state.status) ? X : AlertTriangle;
  return <span className={`inline-flex items-center gap-1 font-medium ${resultStyles[state.code] || (state.status === "current" ? "text-green-700" : state.status === "missing" ? "text-red-700" : "text-amber-700")}`}><Icon className="h-4 w-4" />{state.label}</span>;
}

function NumberField({ value, onChange, disabled, min = 0, className = "w-24" }) {
  return <input type="number" min={min} value={value ?? 0} disabled={disabled} onChange={(event) => onChange(Number(event.target.value))} className={`${className} rounded border px-2 py-2`} />;
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
      .then(([nextData, nextSettings]) => { if (active) { setData(nextData); setSettings(nextSettings); setPreviewDate(dates[0]); } })
      .catch((loadError) => { console.error(loadError); if (active) setError("MARSHA Balance data could not be loaded."); })
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [hotelUid, from, to]);

  const evaluateDate = (stayDate) => {
    if (!data) return { code: "unassessable", label: "Cannot assess" };
    const marshaDoc = data.marsha.stays[stayDate];
    const operaDoc = data.opera.stays[stayDate];
    const marshaState = data.marsha.snapshotDate ? getSourceState({ stayDocument: marshaDoc, snapshotDate: data.marsha.snapshotDate, today, metadata: data.marsha.metadata }) : { status: "missing" };
    const operaState = data.opera.snapshotDate ? getSourceState({ stayDocument: operaDoc, snapshotDate: data.opera.snapshotDate, today, metadata: data.opera.metadata }) : { status: "missing" };
    if (!marshaDoc || !operaDoc || data.marsha.snapshotDate !== data.opera.snapshotDate || marshaState.status !== "current" || operaState.status !== "current") return { code: "unassessable", label: "Cannot assess", reason: "Current, complete stay-date documents from comparable snapshots are required." };
    return evaluateOperationalBalance(marshaDoc.roomsByType, operaDoc.roomsByType, settings, stayDate);
  };

  const rows = useMemo(() => !data ? [] : dates.map((stayDate) => {
    const marshaDoc = data.marsha.stays[stayDate];
    const operaDoc = data.opera.stays[stayDate];
    const marshaState = data.marsha.snapshotDate ? getSourceState({ stayDocument: marshaDoc, snapshotDate: data.marsha.snapshotDate, today, metadata: data.marsha.metadata }) : { status: "missing", label: "Missing" };
    const operaState = data.opera.snapshotDate ? getSourceState({ stayDocument: operaDoc, snapshotDate: data.opera.snapshotDate, today, metadata: data.opera.metadata }) : { status: "missing", label: "Missing" };
    const balance = evaluateDate(stayDate);
    const healthy = marshaState.status === "current" && operaState.status === "current" && ["ok", "upgrade", "intentional"].includes(balance.code);
    return { id: stayDate, stayDate, marshaState, operaState, balance, healthy };
  }), [data, dates, settings, today]);
  const filteredRows = statusFilter ? rows.filter((row) => row.balance.code === statusFilter) : rows;
  const preview = evaluateDate(previewDate);
  const detectedOperaCodes = [...new Set(Object.values(data?.opera.stays || {}).flatMap((doc) => Object.keys(doc?.roomsByType || {})))].sort();
  const detectedMarshaCodes = [...new Set(Object.values(data?.marsha.stays || {}).flatMap((doc) => Object.keys(doc?.roomsByType || {}).filter((code) => code.toLowerCase() !== "total")))].sort();

  const patchSettings = (patch) => setSettings((current) => ({ ...current, ...patch }));
  const patchOpera = (code, patch) => patchSettings({ operaRoomTypes: settings.operaRoomTypes.map((item) => item.code === code ? { ...item, ...patch } : item) });
  const patchCategory = (code, patch) => patchSettings({ salesCategories: settings.salesCategories.map((item) => item.code === code ? { ...item, ...patch } : item) });
  const addOperaCode = (code) => patchSettings({ operaRoomTypes: [...settings.operaRoomTypes, { code, classification: code.toLowerCase() === "total" ? "total" : "unclassified", protectedRooms: 0, protectionMode: "hard" }] });
  const addCategory = (code) => patchSettings({ salesCategories: [...settings.salesCategories, { code, confirmed: false, allowedOperaTypes: [], releasePolicy: "strict", earlyReleaseLimit: 0, overbookingLimit: 0 }] });
  const moveAllowed = (category, index, direction) => {
    const next = [...category.allowedOperaTypes];
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    patchCategory(category.code, { allowedOperaTypes: next });
  };
  const save = async () => {
    const validationErrors = validateBalanceSettings(settings);
    if (validationErrors.length) return toast.error(validationErrors[0]);
    setSaving(true);
    try { await saveMarshaBalanceSettings(hotelUid, settings); toast.success("MARSHA Balance settings saved."); }
    catch (saveError) { console.error(saveError); toast.error("Settings could not be saved."); }
    finally { setSaving(false); }
  };
  const logout = async () => { await signOut(auth); sessionStorage.clear(); window.location.href = "/login"; };
  const columns = [
    { key: "stayDate", label: "Date" },
    { key: "marsha", label: "MARSHA data", sortable: false, render: (row) => <Status state={row.marshaState} /> },
    { key: "opera", label: "Opera data", sortable: false, render: (row) => <Status state={row.operaState} /> },
    { key: "balance", label: "Operational coverage", sortValue: (row) => row.balance.label, render: (row) => <div><Status state={row.balance} />{row.balance.urgent && ["review", "action"].includes(row.balance.code) && <span className="ml-2 text-xs font-semibold text-red-700">Near arrival</span>}</div> },
  ];

  return <div className="min-h-screen bg-gray-50 text-gray-900">
    <HeaderBar today={new Date().toLocaleDateString("en-GB", { timeZone: "Europe/Brussels", weekday: "long", month: "long", day: "numeric" })} onLogout={logout} />
    <PageContainer className="space-y-6">
      <div><p className="text-sm uppercase tracking-wide text-gray-500">Front Office</p><h1 className="text-3xl font-semibold">MARSHA Balance</h1><p className="mt-1 text-gray-600">Read-only control that checks whether rooms offered in MARSHA can be placed in suitable Opera room types.</p></div>
      <div className="flex border-b"><button className={`px-4 py-2 ${activeTab === "overview" ? "border-b-2 border-[#b41f1f] font-semibold" : ""}`} onClick={() => setActiveTab("overview")}>Overview</button><button className={`px-4 py-2 ${activeTab === "settings" ? "border-b-2 border-[#b41f1f] font-semibold" : ""}`} onClick={() => setActiveTab("settings")}>Settings</button></div>
      {error && <div className="rounded-lg bg-red-50 p-4 text-red-800">{error}</div>}
      {activeTab === "overview" && <><Card className="flex flex-wrap items-end gap-4"><label className="text-sm font-medium">From<input type="date" value={from} onChange={(event) => setFrom(event.target.value)} className="mt-1 block rounded-lg border px-3 py-2" /></label><label className="text-sm font-medium">To<input type="date" value={to} onChange={(event) => setTo(event.target.value)} className="mt-1 block rounded-lg border px-3 py-2" /></label><label className="text-sm font-medium">Result<select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} className="mt-1 block rounded-lg border bg-white px-3 py-2"><option value="">All results</option><option value="ok">Within rules</option><option value="upgrade">Covered via upgrade</option><option value="intentional">Intentional sales choice</option><option value="review">Review</option><option value="action">Action required</option><option value="unassessable">Cannot assess</option><option value="unconfigured">Not configured</option></select></label></Card>{loading ? <p>Loading data…</p> : <DataListTable columns={columns} rows={filteredRows} emptyMessage="No stay dates match these filters." onRowClick={(row) => navigate(`/front-office/marsha-balance/${row.stayDate}`)} getRowProps={(row) => ({ className: row.healthy ? "bg-green-50 hover:bg-green-100" : ["review", "unconfigured"].includes(row.balance.code) ? "bg-amber-50 hover:bg-amber-100" : "bg-red-50 hover:bg-red-100" })} />}</>}
      {activeTab === "settings" && <div className="space-y-6">
        <Card className="space-y-4"><div><h2 className="text-xl font-semibold">1. Opera room types</h2><p className="text-sm text-gray-600">Confirm which codes represent physical rooms. Total, virtual, and administrative codes never provide placement capacity.</p></div>{detectedOperaCodes.filter((code) => !settings.operaRoomTypes.some((item) => item.code === code)).map((code) => <button key={code} onClick={() => addOperaCode(code)} className="mr-2 rounded border px-3 py-1 text-sm"><Plus className="mr-1 inline h-3 w-3" />Configure {code}</button>)}<div className="space-y-2">{settings.operaRoomTypes.map((item) => <div key={item.code} className="grid items-end gap-3 rounded border p-3 md:grid-cols-5"><strong>{item.code}</strong><label className="text-xs font-medium">Classification<select value={item.classification} disabled={!canUpdate} onChange={(event) => patchOpera(item.code, { classification: event.target.value })} className="mt-1 block w-full rounded border bg-white px-2 py-2"><option value="unclassified">Not confirmed</option><option value="physical">Physical room</option><option value="virtual">Virtual</option><option value="administrative">Administrative</option><option value="total">Total</option></select></label>{item.classification === "physical" && <><label className="text-xs font-medium">Protected rooms<NumberField value={item.protectedRooms} disabled={!canUpdate} onChange={(value) => patchOpera(item.code, { protectedRooms: value })} className="mt-1 block w-full" /></label><label className="text-xs font-medium">Protection<select value={item.protectionMode || "hard"} disabled={!canUpdate} onChange={(event) => patchOpera(item.code, { protectionMode: event.target.value })} className="mt-1 block w-full rounded border bg-white px-2 py-2"><option value="hard">Hard — never use for a lower category</option><option value="soft">Soft — allow with warning</option></select></label></>}<button disabled={!canUpdate} onClick={() => patchSettings({ operaRoomTypes: settings.operaRoomTypes.filter((entry) => entry.code !== item.code) })} className="text-left text-red-700"><Trash2 className="inline h-4 w-4" /> Remove</button></div>)}</div></Card>
        <Card className="space-y-4"><div><h2 className="text-xl font-semibold">2. MARSHA sales categories</h2><p className="text-sm text-gray-600">Configure directed placement choices. The order is the placement preference; no upgrade path is inferred from room names.</p></div>{detectedMarshaCodes.filter((code) => !settings.salesCategories.some((item) => item.code === code)).map((code) => <button key={code} onClick={() => addCategory(code)} className="mr-2 rounded border px-3 py-1 text-sm"><Plus className="mr-1 inline h-3 w-3" />Configure {code}</button>)}{settings.salesCategories.map((category) => <div key={category.code} className="space-y-3 rounded-xl border p-4"><div className="flex items-center justify-between"><h3 className="text-lg font-semibold">MARSHA {category.code}</h3><label className="text-sm"><input type="checkbox" checked={Boolean(category.confirmed)} disabled={!canUpdate} onChange={(event) => patchCategory(category.code, { confirmed: event.target.checked })} className="mr-2" />Mapping confirmed</label></div><p className="text-sm font-medium">May this booking be placed in this Opera type?</p><div className="flex flex-wrap gap-2">{settings.operaRoomTypes.filter((item) => item.classification === "physical").map((item) => { const selected = category.allowedOperaTypes.includes(item.code); return <button key={item.code} disabled={!canUpdate} onClick={() => patchCategory(category.code, { allowedOperaTypes: selected ? category.allowedOperaTypes.filter((code) => code !== item.code) : [...category.allowedOperaTypes, item.code] })} className={`rounded border px-3 py-1 text-sm ${selected ? "border-[#b41f1f] bg-red-50" : "bg-white"}`}>{selected ? "✓ " : ""}{item.code}</button>; })}</div><div><p className="mb-1 text-sm font-medium">Preference order</p>{category.allowedOperaTypes.map((code, index) => <div key={code} className="mb-1 flex max-w-sm items-center justify-between rounded bg-gray-50 px-3 py-2"><span>{index + 1}. {code}{index === 0 ? " (own / lowest suitable type)" : ""}</span><span><button onClick={() => moveAllowed(category, index, -1)} disabled={!canUpdate || index === 0}><ArrowUp className="inline h-4 w-4" /></button><button onClick={() => moveAllowed(category, index, 1)} disabled={!canUpdate || index === category.allowedOperaTypes.length - 1}><ArrowDown className="ml-2 inline h-4 w-4" /></button></span></div>)}</div><div className="grid gap-3 md:grid-cols-3"><label className="text-xs font-medium">When to release?<select value={category.releasePolicy || "strict"} disabled={!canUpdate} onChange={(event) => patchCategory(category.code, { releasePolicy: event.target.value })} className="mt-1 block w-full rounded border bg-white px-2 py-2"><option value="strict">Strict — only after lower types are exhausted</option><option value="early">Early release allowed</option></select></label>{category.releasePolicy === "early" && <label className="text-xs font-medium">Maximum higher rooms released early<NumberField value={category.earlyReleaseLimit} disabled={!canUpdate} onChange={(value) => patchCategory(category.code, { earlyReleaseLimit: value })} className="mt-1 block w-full" /></label>}<label className="text-xs font-medium">Approved category overbooking<NumberField value={category.overbookingLimit} disabled={!canUpdate} onChange={(value) => patchCategory(category.code, { overbookingLimit: value })} className="mt-1 block w-full" /></label></div></div>)}</Card>
        <Card className="space-y-3"><h2 className="text-xl font-semibold">3. Hotel limits</h2><div className="grid gap-4 md:grid-cols-2"><label className="text-sm font-medium"><input type="checkbox" checked={settings.hotelOverbookingConfirmed} disabled={!canUpdate} onChange={(event) => patchSettings({ hotelOverbookingConfirmed: event.target.checked })} className="mr-2" />Hotel overbooking limit confirmed<NumberField value={settings.hotelOverbookingLimit} disabled={!canUpdate || !settings.hotelOverbookingConfirmed} onChange={(value) => patchSettings({ hotelOverbookingLimit: value })} className="ml-2" /></label><label className="text-sm font-medium"><input type="checkbox" checked={settings.hotelSalesLimitConfirmed} disabled={!canUpdate} onChange={(event) => patchSettings({ hotelSalesLimitConfirmed: event.target.checked })} className="mr-2" />Hotel-wide sales limit confirmed<NumberField value={settings.hotelSalesLimit ?? 0} disabled={!canUpdate || !settings.hotelSalesLimitConfirmed} onChange={(value) => patchSettings({ hotelSalesLimit: value })} className="ml-2" /></label></div><p className="text-xs text-gray-500">Limits default to zero/unconfirmed. Do not confirm a value until its meaning has been verified with the source-system owner.</p></Card>
        <Card className="space-y-3"><div className="flex justify-between"><div><h2 className="text-xl font-semibold">4. Date exceptions</h2><p className="text-sm text-gray-600">Temporary approved overbooking only; exceptions never hide missing or invalid source data.</p></div>{canUpdate && <button onClick={() => patchSettings({ exceptions: [...settings.exceptions, { id: crypto.randomUUID(), categoryCode: "", startDate: today, endDate: today, reason: "", responsible: "", additionalOverbooking: 0 }] })} className="rounded border px-3 py-2 text-sm"><Plus className="mr-1 inline h-4 w-4" />Add</button>}</div>{settings.exceptions.map((item) => <div key={item.id} className="grid gap-2 rounded border p-3 md:grid-cols-7"><select value={item.categoryCode} onChange={(event) => patchSettings({ exceptions: settings.exceptions.map((entry) => entry.id === item.id ? { ...entry, categoryCode: event.target.value } : entry) })} className="rounded border bg-white px-2"><option value="">Category</option>{settings.salesCategories.map((category) => <option key={category.code}>{category.code}</option>)}</select>{["startDate", "endDate"].map((field) => <input key={field} type="date" value={item[field]} onChange={(event) => patchSettings({ exceptions: settings.exceptions.map((entry) => entry.id === item.id ? { ...entry, [field]: event.target.value } : entry) })} className="rounded border px-2" />)}<input value={item.reason} placeholder="Reason" onChange={(event) => patchSettings({ exceptions: settings.exceptions.map((entry) => entry.id === item.id ? { ...entry, reason: event.target.value } : entry) })} className="rounded border px-2" /><input value={item.responsible} placeholder="Responsible" onChange={(event) => patchSettings({ exceptions: settings.exceptions.map((entry) => entry.id === item.id ? { ...entry, responsible: event.target.value } : entry) })} className="rounded border px-2" /><NumberField value={item.additionalOverbooking} onChange={(value) => patchSettings({ exceptions: settings.exceptions.map((entry) => entry.id === item.id ? { ...entry, additionalOverbooking: value } : entry) })} className="w-full" /><button onClick={() => patchSettings({ exceptions: settings.exceptions.filter((entry) => entry.id !== item.id) })} className="text-red-700"><Trash2 className="h-4 w-4" /></button></div>)}</Card>
        <Card className="space-y-3"><div className="flex flex-wrap items-end justify-between gap-3"><div><h2 className="text-xl font-semibold">Preview before saving</h2><p className="text-sm text-gray-600">Uses the currently loaded source values and your unsaved settings.</p></div><label className="text-sm font-medium">Stay date<select value={previewDate} onChange={(event) => setPreviewDate(event.target.value)} className="ml-2 rounded border bg-white px-3 py-2">{dates.map((date) => <option key={date}>{date}</option>)}</select></label></div><div className="rounded-lg border p-4"><Status state={preview} />{preview.reason && <p className="mt-2 text-sm text-gray-600">{preview.reason}</p>}<div className="mt-3 grid gap-2 sm:grid-cols-2">{preview.categories?.map((item) => <div key={item.categoryCode} className="rounded bg-gray-50 p-3 text-sm"><strong>{item.categoryCode}: {item.label}</strong><p>Offered {item.offeredRaw}; uncovered {item.uncovered ?? "—"}; higher used {item.higherUsed ?? "—"}; potentially available {item.higherPotential ?? "—"}</p></div>)}</div></div>{canUpdate && <button disabled={saving} onClick={save} className="rounded-lg bg-[#b41f1f] px-4 py-2 font-semibold text-white disabled:opacity-50">{saving ? "Saving…" : "Save settings"}</button>}</Card>
      </div>}
    </PageContainer>
  </div>;
}
