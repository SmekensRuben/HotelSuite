import React, { useEffect, useMemo, useState } from "react";
import { toast } from "react-toastify";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import DataListTable from "../shared/DataListTable";
import Modal from "../shared/Modal";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { usePermission } from "../../hooks/usePermission";
import { getMarshaBalanceData, getMarshaBalanceSettings, saveMarshaBalanceSettings } from "../../services/firebaseMarshaBalance";
import { enumerateDates, evaluateBalance, findOverlappingOperaTypes, getBrusselsDateString, getDefaultBalanceRange, getSourceState } from "../../utils/marshaBalance";

const badgeClasses = { ok: "bg-green-100 text-green-800", current: "bg-green-100 text-green-800", review: "bg-amber-100 text-amber-800", expected: "bg-blue-100 text-blue-800", critical: "bg-red-100 text-red-800", missing: "bg-red-100 text-red-800", stale: "bg-amber-100 text-amber-800", unconfigured: "bg-gray-100 text-gray-700", unassessable: "bg-gray-100 text-gray-700" };
const emptyRule = () => ({ id: crypto.randomUUID(), marshaRoomType: "", operaRoomTypes: [], comparisonMode: "exact", reservedRooms: 0, allowedDeviation: 0, lowerDeviation: 0, upperDeviation: 0, enabled: false });

function Badge({ state }) {
  return <span className={`inline-flex rounded-full px-2 py-1 text-xs font-semibold ${badgeClasses[state.status] || badgeClasses.unassessable}`}>{state.label}</span>;
}

function SourceCell({ source, stayDate, today }) {
  if (!source.snapshotDate) return <div><Badge state={{ status: "missing", label: "Ontbrekend" }} /><p className="mt-1 text-xs text-gray-500">Geen snapshot</p></div>;
  const state = getSourceState({ stayDocument: source.stays[stayDate], snapshotDate: source.snapshotDate, today, metadata: source.metadata });
  return <div><Badge state={state} /><p className="mt-1 text-xs text-gray-500">Snapshot {source.snapshotDate}</p></div>;
}

function formatTimestamp(value) {
  const date = value?.toDate?.() || (value ? new Date(value) : null);
  return date && !Number.isNaN(date.getTime()) ? date.toLocaleString("nl-BE", { timeZone: "Europe/Brussels" }) : null;
}

export default function MarshaBalancePage() {
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
  const [selectedRow, setSelectedRow] = useState(null);
  const today = getBrusselsDateString();
  const dates = useMemo(() => enumerateDates(from, to), [from, to]);

  useEffect(() => {
    let active = true;
    if (!hotelUid || !dates.length) { setLoading(false); return () => { active = false; }; }
    setLoading(true); setError("");
    Promise.all([getMarshaBalanceData(hotelUid, dates, today), getMarshaBalanceSettings(hotelUid)])
      .then(([nextData, settings]) => { if (active) { setData(nextData); setRules(Array.isArray(settings.rules) ? settings.rules : []); } })
      .catch((err) => { console.error(err); if (active) setError("De MARSHA Balance-gegevens konden niet worden geladen."); })
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [hotelUid, from, to]);

  const rows = useMemo(() => !data ? [] : dates.map((stayDate) => {
    const marshaDoc = data.marsha.stays[stayDate];
    const operaDoc = data.opera.stays[stayDate];
    const comparable = data.marsha.snapshotDate && data.opera.snapshotDate && data.marsha.snapshotDate === data.opera.snapshotDate;
    const balance = !marshaDoc || !operaDoc || !comparable
      ? { status: "unassessable", label: "Niet te beoordelen", reason: !comparable ? "De bronnen gebruiken niet dezelfde snapshotdatum." : "Een vereist verblijfsdatumdocument ontbreekt.", calculations: [] }
      : evaluateBalance(marshaDoc.roomsByType, operaDoc.roomsByType, rules);
    return { id: stayDate, stayDate, marshaDoc, operaDoc, balance };
  }), [data, dates, rules]);
  const filteredRows = statusFilter ? rows.filter((row) => row.balance.status === statusFilter) : rows;

  const updateRule = (id, field, value) => setRules((current) => current.map((rule) => rule.id === id ? { ...rule, [field]: value } : rule));
  const saveRules = async () => {
    const overlaps = findOverlappingOperaTypes(rules);
    if (overlaps.length) { toast.error(`Opera-kamertypes mogen maar één keer actief zijn: ${overlaps.join(", ")}`); return; }
    const invalid = rules.some((rule) => rule.enabled && (!rule.marshaRoomType.trim() || !rule.operaRoomTypes.length));
    if (invalid) { toast.error("Vul voor elke actieve regel beide kamertypes in."); return; }
    setSaving(true);
    try { await saveMarshaBalanceSettings(hotelUid, rules); toast.success("Vergelijkingsregels opgeslagen."); }
    catch (err) { console.error(err); toast.error("De regels konden niet worden opgeslagen."); }
    finally { setSaving(false); }
  };
  const logout = async () => { await signOut(auth); sessionStorage.clear(); window.location.href = "/login"; };
  const columns = [
    { key: "stayDate", label: "Date", render: (row) => <button className="font-semibold text-[#b41f1f] underline" onClick={(event) => { event.stopPropagation(); setSelectedRow(row); }}>{row.stayDate}</button> },
    { key: "marsha", label: "MARSHA data", sortable: false, render: (row) => <SourceCell source={data.marsha} stayDate={row.stayDate} today={today} /> },
    { key: "opera", label: "Opera data", sortable: false, render: (row) => <SourceCell source={data.opera} stayDate={row.stayDate} today={today} /> },
    { key: "balance", label: "Balance", sortValue: (row) => row.balance.label, render: (row) => <Badge state={row.balance} /> },
  ];

  return <div className="min-h-screen bg-gray-50 text-gray-900">
    <HeaderBar today={new Date().toLocaleDateString("nl-BE", { timeZone: "Europe/Brussels", weekday: "long", month: "long", day: "numeric" })} onLogout={logout} />
    <PageContainer className="space-y-6">
      <div><p className="text-sm uppercase tracking-wide text-gray-500">Front Office</p><h1 className="text-3xl font-semibold">MARSHA Balance</h1><p className="mt-1 text-gray-600">Alleen-lezencontrole tussen de nachtelijke MARSHA- en Opera-beschikbaarheid.</p></div>
      <div className="flex border-b"><button className={`px-4 py-2 ${activeTab === "overview" ? "border-b-2 border-[#b41f1f] font-semibold" : ""}`} onClick={() => setActiveTab("overview")}>Overzicht</button><button className={`px-4 py-2 ${activeTab === "settings" ? "border-b-2 border-[#b41f1f] font-semibold" : ""}`} onClick={() => setActiveTab("settings")}>Settings</button></div>
      {error && <div className="rounded-lg bg-red-50 p-4 text-red-800">{error}</div>}
      {activeTab === "overview" && <>
        <Card className="flex flex-wrap items-end gap-4">
          <label className="text-sm font-medium">Van<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="mt-1 block rounded-lg border px-3 py-2" /></label>
          <label className="text-sm font-medium">Tot<input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="mt-1 block rounded-lg border px-3 py-2" /></label>
          <label className="text-sm font-medium">Status<select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="mt-1 block rounded-lg border bg-white px-3 py-2"><option value="">Alle statussen</option><option value="ok">Binnen regels</option><option value="review">Nakijken</option><option value="critical">Kritiek</option><option value="unconfigured">Geen regels ingesteld</option><option value="unassessable">Niet te beoordelen</option></select></label>
          {data && <div className="text-sm text-gray-600"><p>MARSHA snapshot: <strong>{data.marsha.snapshotDate || "geen"}</strong>{formatTimestamp(data.marsha.metadata.completedAt) && ` · voltooid ${formatTimestamp(data.marsha.metadata.completedAt)}`}</p><p>Opera snapshot: <strong>{data.opera.snapshotDate || "geen"}</strong>{formatTimestamp(data.opera.metadata.completedAt) && ` · voltooid ${formatTimestamp(data.opera.metadata.completedAt)}`}</p></div>}
        </Card>
        {from > to && <div className="rounded-lg bg-amber-50 p-4 text-amber-800">De einddatum moet op of na de begindatum liggen.</div>}
        {loading ? <p>Gegevens laden…</p> : <DataListTable columns={columns} rows={filteredRows} emptyMessage="Geen verblijfsdata voor deze filters." />}
      </>}
      {activeTab === "settings" && <Card className="space-y-4">
        <div><h2 className="text-xl font-semibold">Vergelijkingsregels</h2><p className="text-sm text-gray-600">Regels zijn pas actief nadat u ze expliciet inschakelt. Een Opera-kamertype kan maar in één actieve regel worden gebruikt.</p></div>
        {rules.map((rule) => <div key={rule.id} className="grid gap-3 rounded-lg border p-4 md:grid-cols-6">
          <label className="text-xs font-medium">MARSHA type<input value={rule.marshaRoomType} disabled={!canUpdate} onChange={(e) => updateRule(rule.id, "marshaRoomType", e.target.value.trim().toUpperCase())} className="mt-1 w-full rounded border px-2 py-2" /></label>
          <label className="text-xs font-medium">Opera types<input value={(rule.operaRoomTypes || []).join(", ")} disabled={!canUpdate} onChange={(e) => updateRule(rule.id, "operaRoomTypes", e.target.value.split(",").map((v) => v.trim().toUpperCase()).filter(Boolean))} placeholder="QNK, DBDB" className="mt-1 w-full rounded border px-2 py-2" /></label>
          <label className="text-xs font-medium">Vergelijking<select value={rule.comparisonMode} disabled={!canUpdate} onChange={(e) => updateRule(rule.id, "comparisonMode", e.target.value)} className="mt-1 w-full rounded border bg-white px-2 py-2"><option value="exact">Exact</option><option value="upper">Bovengrens</option><option value="range">Bandbreedte</option></select></label>
          <label className="text-xs font-medium">Gereserveerd<input type="number" value={rule.reservedRooms} disabled={!canUpdate} onChange={(e) => updateRule(rule.id, "reservedRooms", Number(e.target.value))} className="mt-1 w-full rounded border px-2 py-2" /></label>
          <label className="text-xs font-medium">Afwijking<input type="number" min="0" value={rule.allowedDeviation} disabled={!canUpdate} onChange={(e) => updateRule(rule.id, "allowedDeviation", Number(e.target.value))} className="mt-1 w-full rounded border px-2 py-2" /></label>
          <div className="flex items-end gap-3"><label className="flex items-center gap-2 pb-2 text-sm"><input type="checkbox" checked={Boolean(rule.enabled)} disabled={!canUpdate} onChange={(e) => updateRule(rule.id, "enabled", e.target.checked)} /> Actief</label>{canUpdate && <button className="pb-2 text-sm text-red-700" onClick={() => setRules((current) => current.filter((item) => item.id !== rule.id))}>Verwijder</button>}</div>
        </div>)}
        {canUpdate ? <div className="flex gap-3"><button onClick={() => setRules((current) => [...current, emptyRule()])} className="rounded-lg border px-4 py-2 font-semibold">Regel toevoegen</button><button disabled={saving} onClick={saveRules} className="rounded-lg bg-[#b41f1f] px-4 py-2 font-semibold text-white disabled:opacity-50">{saving ? "Opslaan…" : "Regels opslaan"}</button></div> : <p className="text-sm text-amber-700">U hebt alleen leesrechten voor deze instellingen.</p>}
      </Card>}
    </PageContainer>
    {selectedRow && <Modal open={true} onClose={() => setSelectedRow(null)} title={`Balance op ${selectedRow.stayDate}`}><div className="space-y-4 text-sm"><p className="rounded bg-blue-50 p-3">Deze controle wijzigt geen beschikbaarheid in Opera of MARSHA.</p><div className="grid gap-4 sm:grid-cols-2"><div><h3 className="font-semibold">MARSHA · snapshot {data.marsha.snapshotDate}</h3><pre className="mt-2 overflow-auto rounded bg-gray-50 p-3">{JSON.stringify(selectedRow.marshaDoc?.roomsByType ?? "Ontbrekend", null, 2)}</pre></div><div><h3 className="font-semibold">Opera · snapshot {data.opera.snapshotDate}</h3><pre className="mt-2 overflow-auto rounded bg-gray-50 p-3">{JSON.stringify(selectedRow.operaDoc?.roomsByType ?? "Ontbrekend", null, 2)}</pre></div></div><h3 className="font-semibold"><Badge state={selectedRow.balance} /></h3>{selectedRow.balance.reason && <p>{selectedRow.balance.reason}</p>}{selectedRow.balance.calculations.map((calc) => <div key={calc.rule.id} className="rounded border p-3"><strong>{calc.rule.marshaRoomType} ← {(calc.rule.operaRoomTypes || []).join(" + ")}</strong>{calc.assessable ? <p>{calc.operaValue} Opera − {calc.reservedRooms} gereserveerd − {calc.marshaValue} MARSHA = <strong>{calc.difference}</strong> (toegestaan: {calc.tolerance})</p> : <p>Niet te beoordelen: vereiste kamertypewaarde ontbreekt.</p>}</div>)}</div></Modal>}
  </div>;
}
