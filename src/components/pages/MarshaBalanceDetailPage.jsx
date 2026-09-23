import React, { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Check, ChevronDown, ChevronUp, X } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { getMarshaBalanceData, getMarshaBalanceSettings } from "../../services/firebaseMarshaBalance";
import { evaluateBalance, getBrusselsDateString, getSourceState } from "../../utils/marshaBalance";

function ValueBox({ label, value, tone = "neutral" }) {
  const colors = tone === "difference" ? (value === 0 ? "border-green-200 bg-green-50" : "border-red-200 bg-red-50") : "border-gray-200 bg-gray-50";
  return <div className={`rounded-lg border p-4 ${colors}`}><p className="text-xs font-semibold uppercase tracking-wide text-gray-500">{label}</p><p className="mt-1 text-2xl font-semibold">{value}</p></div>;
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

  const mappedMarsha = new Set(rules.filter((rule) => rule.enabled).map((rule) => rule.marshaRoomType));
  const mappedOpera = new Set(rules.filter((rule) => rule.enabled).flatMap((rule) => rule.operaRoomTypes || []));
  const logout = async () => { await signOut(auth); sessionStorage.clear(); window.location.href = "/login"; };

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
        <div className="space-y-4">
          {detail.result.calculations.map((calculation) => <Card key={calculation.rule.id}>
            <div className="mb-4"><h2 className="text-lg font-semibold">{calculation.rule.marshaRoomType} mapped to {(calculation.rule.operaRoomTypes || []).join(" + ")}</h2><p className="text-sm text-gray-500">{calculation.rule.comparisonMode === "exact" ? "Exact match" : calculation.rule.comparisonMode === "upper" ? "Maximum only" : "Allowed range"}</p></div>
            {calculation.assessable ? <><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><ValueBox label={`MARSHA ${calculation.rule.marshaRoomType}`} value={calculation.marshaValue} /><ValueBox label="Combined Opera" value={calculation.operaValue} /><ValueBox label="Reserved rooms deducted" value={calculation.reservedRooms} /><ValueBox label="Difference" value={calculation.difference} tone="difference" /></div><p className="mt-3 text-sm text-gray-600">Calculation: {calculation.operaValue} Opera − {calculation.reservedRooms} reserved − {calculation.marshaValue} MARSHA = <strong>{calculation.difference}</strong>.</p></> : <p className="rounded bg-red-50 p-3 text-red-700">A required mapped room type is missing from the source data.</p>}
          </Card>)}
        </div>
        <Card className="space-y-5"><h2 className="text-xl font-semibold">Unmapped room types</h2><UnmappedTypes title="MARSHA" rooms={detail.marshaDoc?.roomsByType} mappedTypes={mappedMarsha} /><UnmappedTypes title="Opera" rooms={detail.operaDoc?.roomsByType} mappedTypes={mappedOpera} /></Card>
        <Card><button onClick={() => setShowSnapshot((value) => !value)} className="flex w-full items-center justify-between font-semibold"><span>Snapshot information</span>{showSnapshot ? <ChevronUp className="h-5 w-5" /> : <ChevronDown className="h-5 w-5" />}</button>{showSnapshot && <div className="mt-4 grid gap-4 border-t pt-4 sm:grid-cols-2"><div><h3 className="font-semibold">MARSHA</h3><p className="text-sm">Snapshot date: {data.marsha.snapshotDate || "Not available"}</p><p className="text-sm">Import status: {data.marsha.metadata?.status || data.marsha.metadata?.importStatus || "Not provided"}</p><p className="text-sm">Completed: {formatMetadata(data.marsha.metadata) || "Not provided"}</p></div><div><h3 className="font-semibold">Opera</h3><p className="text-sm">Snapshot date: {data.opera.snapshotDate || "Not available"}</p><p className="text-sm">Import status: {data.opera.metadata?.status || data.opera.metadata?.importStatus || "Not provided"}</p><p className="text-sm">Completed: {formatMetadata(data.opera.metadata) || "Not provided"}</p></div></div>}</Card>
      </>}
    </PageContainer>
  </div>;
}
