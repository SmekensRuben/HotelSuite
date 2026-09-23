import React, { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Check, ChevronDown, ChevronUp, X } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import DataListTable from "../shared/DataListTable";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { getMarshaBalanceData, getMarshaBalanceSettings } from "../../services/firebaseMarshaBalance";
import { evaluateBalance, getBrusselsDateString, getSourceState } from "../../utils/marshaBalance";

function ValueBox({ label, value, result }) {
  const colors = result === undefined ? "border-gray-200 bg-gray-50" : result ? "border-green-200 bg-green-50" : "border-red-200 bg-red-50";
  return <div className={`rounded-lg border p-4 ${colors}`}><p className="text-xs font-semibold uppercase tracking-wide text-gray-500">{label}</p><p className="mt-1 text-2xl font-semibold">{value}</p></div>;
}

function RuleResult({ calculation }) {
  return calculation.assessable && calculation.within
    ? <span className="inline-flex items-center gap-1 font-semibold text-green-700"><Check className="h-4 w-4" />Balanced</span>
    : <span className="inline-flex items-center gap-1 font-semibold text-red-700"><X className="h-4 w-4" />Outside rule</span>;
}

function UnmappedTypes({ title, rooms, mappedTypes }) {
  const entries = Object.entries(rooms || {}).filter(([type]) => !mappedTypes.has(type));
  return <div><h3 className="font-semibold">{title}</h3>{entries.length ? <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">{entries.map(([type, value]) => <div key={type} className="flex justify-between rounded border bg-white px-3 py-2"><span>{type}</span><strong>{value}</strong></div>)}</div> : <p className="mt-2 text-sm text-gray-500">All room types are mapped.</p>}</div>;
}

function formatMetadata(metadata) {
  const timestamp = metadata?.completedAt || metadata?.importedAt || metadata?.updatedAt;
  const date = timestamp?.toDate?.() || (timestamp ? new Date(timestamp) : null);
  return date && !Number.isNaN(date.getTime()) ? date.toLocaleString("en-GB", { timeZone: "Europe/Brussels" }) : null;
}

export default function MarshaBalanceDetailPage() {
  const { stayDate } = useParams();
  const navigate = useNavigate();
  const { hotelUid } = useHotelContext();
  const [data, setData] = useState(null);
  const [rules, setRules] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showSnapshot, setShowSnapshot] = useState(false);
  const today = getBrusselsDateString();

  useEffect(() => {
    let active = true;
    setLoading(true); setError("");
    Promise.all([getMarshaBalanceData(hotelUid, [stayDate], today), getMarshaBalanceSettings(hotelUid)])
      .then(([sourceData, settings]) => { if (active) { setData(sourceData); setRules(Array.isArray(settings.rules) ? settings.rules : []); } })
      .catch((loadError) => { console.error(loadError); if (active) setError("Balance details could not be loaded."); })
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [hotelUid, stayDate]);

  const detail = useMemo(() => {
    if (!data) return null;
    const marshaDoc = data.marsha.stays[stayDate];
    const operaDoc = data.opera.stays[stayDate];
    const comparable = data.marsha.snapshotDate && data.opera.snapshotDate && data.marsha.snapshotDate === data.opera.snapshotDate;
    const result = marshaDoc && operaDoc && comparable ? evaluateBalance(marshaDoc.roomsByType, operaDoc.roomsByType, rules) : { status: "unassessable", label: "Cannot assess", calculations: [], reason: comparable ? "A stay-date document is missing." : "The snapshots are not comparable." };
    return { marshaDoc, operaDoc, result };
  }, [data, rules, stayDate]);

  const roomRules = rules.filter((rule) => rule.enabled && rule.ruleScope !== "total");
  const mappedMarsha = new Set(roomRules.map((rule) => rule.marshaRoomType));
  const mappedOpera = new Set(roomRules.flatMap((rule) => rule.operaRoomTypes || []));
  const logout = async () => { await signOut(auth); sessionStorage.clear(); window.location.href = "/login"; };
  const mappingCalculations = (detail?.result.calculations || []).filter((calculation) => calculation.rule.ruleScope !== "total").map((calculation) => ({ ...calculation, id: calculation.rule.id }));
  const totalCalculations = (detail?.result.calculations || []).filter((calculation) => calculation.rule.ruleScope === "total");
  const mappingColumns = [
    { key: "marshaType", label: "MARSHA mapping", render: ({ rule }) => <strong>{rule.marshaRoomType}</strong> },
    { key: "operaTypes", label: "Opera room types", sortable: false, render: ({ rule }) => (rule.operaRoomTypes || []).join(" + ") },
    { key: "values", label: "Values", sortable: false, render: (calculation) => calculation.assessable ? <span>{calculation.marshaValue} MARSHA / {calculation.operaValue} Opera{calculation.reservedRooms ? ` − ${calculation.reservedRooms} reserved` : ""}</span> : "Required value missing" },
    { key: "difference", label: "Difference", render: (calculation) => calculation.assessable ? <strong>{calculation.difference}</strong> : "—" },
    { key: "comparison", label: "Rule", sortable: false, render: ({ rule, tolerance }) => rule.comparisonMode === "exact" ? `Exact (±${tolerance})` : rule.comparisonMode === "upper" ? `Maximum (±${tolerance})` : rule.comparisonMode === "lower" ? `Minimum (±${tolerance})` : "Allowed range" },
    { key: "result", label: "Result", sortable: false, render: (calculation) => <RuleResult calculation={calculation} /> },
  ];

  return <div className="min-h-screen bg-gray-50 text-gray-900">
    <HeaderBar today={new Date().toLocaleDateString("en-GB", { timeZone: "Europe/Brussels", weekday: "long", month: "long", day: "numeric" })} onLogout={logout} />
    <PageContainer className="space-y-6">
      <button onClick={() => navigate("/front-office/marsha-balance")} className="inline-flex items-center gap-2 text-sm font-semibold text-[#b41f1f]"><ArrowLeft className="h-4 w-4" />Back to MARSHA Balance</button>
      <div><p className="text-sm uppercase tracking-wide text-gray-500">Balance details</p><h1 className="text-3xl font-semibold">{stayDate}</h1><p className="mt-1 text-gray-600">Mapped room availability and calculated differences.</p></div>
      {error && <div className="rounded-lg bg-red-50 p-4 text-red-800">{error}</div>}
      {loading && <p>Loading details…</p>}
      {!loading && detail && <>
        <Card className={detail.result.status === "ok" ? "border border-green-200" : "border border-red-200"}>
          <div className="flex items-center gap-2">{detail.result.status === "ok" ? <Check className="h-6 w-6 text-green-700" /> : <X className="h-6 w-6 text-red-700" />}<h2 className="text-xl font-semibold">{detail.result.label}</h2></div>
          {detail.result.reason && <p className="mt-2 text-red-700">{detail.result.reason}</p>}
        </Card>
        {totalCalculations.map((calculation) => <Card key={calculation.rule.id} className="p-4"><div className="mb-3 flex items-center justify-between gap-3"><div><h2 className="font-semibold">All physical room totals</h2><p className="text-xs text-gray-500">Total control, separate from room mappings</p></div><RuleResult calculation={calculation} /></div>{calculation.assessable ? <div className="grid gap-3 sm:grid-cols-3"><ValueBox label="MARSHA total" value={calculation.marshaValue} /><ValueBox label="Opera total after reservations" value={calculation.comparedOperaValue} /><ValueBox label="Difference" value={calculation.difference} result={calculation.within} /></div> : <p className="text-red-700">The totals cannot be assessed.</p>}</Card>)}
        <div><h2 className="mb-3 text-xl font-semibold">Room type mappings</h2><DataListTable columns={mappingColumns} rows={mappingCalculations} emptyMessage="No active room type mappings configured." getRowProps={(calculation) => ({ className: calculation.assessable && calculation.within ? "bg-green-50" : "bg-red-50" })} /></div>
        <Card className="space-y-5"><h2 className="text-xl font-semibold">Unmapped room types</h2><UnmappedTypes title="MARSHA" rooms={detail.marshaDoc?.roomsByType} mappedTypes={mappedMarsha} /><UnmappedTypes title="Opera" rooms={detail.operaDoc?.roomsByType} mappedTypes={mappedOpera} /></Card>
        <Card><button onClick={() => setShowSnapshot((value) => !value)} className="flex w-full items-center justify-between font-semibold"><span>Snapshot information</span>{showSnapshot ? <ChevronUp className="h-5 w-5" /> : <ChevronDown className="h-5 w-5" />}</button>{showSnapshot && <div className="mt-4 grid gap-4 border-t pt-4 sm:grid-cols-2"><div><h3 className="font-semibold">MARSHA</h3><p className="text-sm">Snapshot date: {data.marsha.snapshotDate || "Not available"}</p><p className="text-sm">Import status: {data.marsha.metadata?.status || data.marsha.metadata?.importStatus || "Not provided"}</p><p className="text-sm">Completed: {formatMetadata(data.marsha.metadata) || "Not provided"}</p></div><div><h3 className="font-semibold">Opera</h3><p className="text-sm">Snapshot date: {data.opera.snapshotDate || "Not available"}</p><p className="text-sm">Import status: {data.opera.metadata?.status || data.opera.metadata?.importStatus || "Not provided"}</p><p className="text-sm">Completed: {formatMetadata(data.opera.metadata) || "Not provided"}</p></div></div>}</Card>
      </>}
    </PageContainer>
  </div>;
}
