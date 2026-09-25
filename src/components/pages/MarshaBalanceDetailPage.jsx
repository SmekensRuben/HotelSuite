import React, { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Check, ChevronDown, ChevronUp, X, AlertTriangle } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import DataListTable from "../shared/DataListTable";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { getMarshaBalanceData, getMarshaBalanceSettings } from "../../services/firebaseMarshaBalance";
import { evaluateOperationalBalance, getBrusselsDateString, getSourceState } from "../../utils/marshaBalance";

const resultColor = { ok: "text-green-700", upgrade: "text-blue-700", intentional: "text-gray-600", review: "text-amber-700", action: "text-red-700", unassessable: "text-red-700", unreliable: "text-red-700", unconfigured: "text-gray-600" };
function Result({ value }) {
  const Icon = ["ok", "upgrade", "intentional"].includes(value.code) ? Check : ["action", "unassessable", "unreliable"].includes(value.code) ? X : AlertTriangle;
  return <span className={`inline-flex items-center gap-1 font-semibold ${resultColor[value.code]}`}><Icon className="h-4 w-4" />{value.label}</span>;
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
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showSnapshot, setShowSnapshot] = useState(false);
  const today = getBrusselsDateString();
  useEffect(() => {
    let active = true; setLoading(true); setError("");
    Promise.all([getMarshaBalanceData(hotelUid, [stayDate], today), getMarshaBalanceSettings(hotelUid)])
      .then(([sourceData, nextSettings]) => { if (active) { setData(sourceData); setSettings(nextSettings); } })
      .catch((loadError) => { console.error(loadError); if (active) setError("Balance details could not be loaded."); })
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [hotelUid, stayDate]);

  const detail = useMemo(() => {
    if (!data || !settings) return null;
    const marshaDoc = data.marsha.stays[stayDate];
    const operaDoc = data.opera.stays[stayDate];
    if (!marshaDoc || !operaDoc) return { code: "unassessable", label: "Cannot assess", reason: "A required stay-date document is missing.", categories: [], dataIssues: ["Missing stay-date source data."], marshaDoc, operaDoc };
    if (data.marsha.snapshotDate !== data.opera.snapshotDate) return { code: "unassessable", label: "Cannot assess", reason: "MARSHA and Opera snapshots are not comparable.", categories: [], dataIssues: ["Snapshot dates differ."], marshaDoc, operaDoc };
    const marshaState = getSourceState({ stayDocument: marshaDoc, snapshotDate: data.marsha.snapshotDate, today, metadata: data.marsha.metadata });
    const operaState = getSourceState({ stayDocument: operaDoc, snapshotDate: data.opera.snapshotDate, today, metadata: data.opera.metadata });
    if (marshaState.status !== "current" || operaState.status !== "current") return { code: "unassessable", label: "Cannot assess", reason: "Both source snapshots must be current and complete.", categories: [], dataIssues: [`MARSHA: ${marshaState.label}; Opera: ${operaState.label}.`], marshaDoc, operaDoc };
    return { ...evaluateOperationalBalance(marshaDoc.roomsByType, operaDoc.roomsByType, settings, stayDate), marshaDoc, operaDoc };
  }, [data, settings, stayDate]);
  const logout = async () => { await signOut(auth); sessionStorage.clear(); window.location.href = "/login"; };
  const columns = [
    { key: "categoryCode", label: "MARSHA category", render: (row) => <strong>{row.categoryCode}</strong> },
    { key: "offered", label: "Offered", render: (row) => row.offeredRaw },
    { key: "ownAvailable", label: "Own Opera type", render: (row) => row.ownAvailable ?? "—" },
    { key: "placement", label: "Room placement", sortable: false, render: (row) => <div>{row.placements?.length ? row.placements.map((item) => <div key={`${item.operaType}-${item.kind}`}>{item.rooms} × {item.operaType}{item.kind === "upgrade" ? " (higher type)" : ""}{item.protectedUse ? `; ${item.protectedUse} protected` : ""}</div>) : "No physical rooms placed"}<span className="block text-xs text-blue-700">{row.higherUsed || 0} higher used; {row.higherPotential || 0} potentially available under release policy</span></div> },
    { key: "overbooking", label: "Approved overbooking", render: (row) => row.approvedOverbooking || 0 },
    { key: "uncovered", label: "Uncovered", render: (row) => <strong className={row.uncovered ? "text-red-700" : ""}>{row.uncovered ?? "—"}</strong> },
    { key: "result", label: "Conclusion", sortable: false, render: (row) => <div><Result value={row} />{row.sharedTypes?.length > 0 && <p className="text-xs text-amber-700">Shared capacity: {row.sharedTypes.join(", ")}</p>}{row.exception && <p className="text-xs">Exception: {row.exception.reason} ({row.exception.responsible})</p>}</div> },
  ];

  return <div className="min-h-screen bg-gray-50 text-gray-900"><HeaderBar today={new Date().toLocaleDateString("en-GB", { timeZone: "Europe/Brussels", weekday: "long", month: "long", day: "numeric" })} onLogout={logout} /><PageContainer className="space-y-6">
    <button onClick={() => navigate("/front-office/marsha-balance")} className="inline-flex items-center gap-2 text-sm font-semibold text-[#b41f1f]"><ArrowLeft className="h-4 w-4" />Back to MARSHA Balance</button>
    <div><p className="text-sm uppercase tracking-wide text-gray-500">Balance details</p><h1 className="text-3xl font-semibold">{stayDate}</h1><p className="mt-1 text-gray-600">Operational room-placement coverage for this stay date.</p></div>
    {error && <div className="rounded-lg bg-red-50 p-4 text-red-800">{error}</div>}{loading && <p>Loading details…</p>}
    {!loading && detail && <><Card className={`border ${["ok", "upgrade", "intentional"].includes(detail.code) ? "border-green-200" : detail.code === "review" ? "border-amber-200" : "border-red-200"}`}><div className="flex items-center gap-3"><Result value={detail} />{detail.urgent && ["review", "action"].includes(detail.code) && <span className="rounded bg-red-100 px-2 py-1 text-xs font-semibold text-red-800">Near arrival</span>}</div>{detail.reason && <p className="mt-2 text-sm text-gray-700">{detail.reason}</p>}</Card>
      {(detail.dataIssues?.length > 0 || detail.deficitIssues?.length > 0) && <Card className="border border-red-200"><h2 className="text-lg font-semibold text-red-800">Data and existing inventory issues</h2><ul className="mt-2 list-disc space-y-1 pl-5 text-sm">{[...(detail.dataIssues || []), ...(detail.deficitIssues || [])].map((issue) => <li key={issue}>{issue}</li>)}</ul><p className="mt-3 text-xs text-gray-500">Data issues are never suppressed by a commercial exception.</p></Card>}
      <div><h2 className="mb-3 text-xl font-semibold">Sales category coverage</h2><DataListTable columns={columns} rows={(detail.categories || []).map((item) => ({ ...item, id: item.categoryCode }))} emptyMessage="No confirmed MARSHA sales categories can be assessed." getRowProps={(row) => ({ className: ["ok", "upgrade", "intentional"].includes(row.code) ? "bg-green-50" : row.code === "review" ? "bg-amber-50" : "bg-red-50" })} /></div>
      {detail.placements?.length > 0 && <Card><h2 className="text-lg font-semibold">Existing Opera deficits covered first</h2><div className="mt-2 space-y-1 text-sm">{detail.placements.map((item, index) => <p key={`${item.categoryCode}-${item.operaType}-${index}`}>{item.rooms} × {item.operaType} used to {item.purpose} for {item.categoryCode}.</p>)}</div></Card>}
      <Card className="grid gap-4 sm:grid-cols-2"><div><h2 className="font-semibold">MARSHA source values</h2><pre className="mt-2 overflow-auto rounded bg-gray-50 p-3 text-sm">{JSON.stringify(detail.marshaDoc?.roomsByType || {}, null, 2)}</pre></div><div><h2 className="font-semibold">Opera source values</h2><pre className="mt-2 overflow-auto rounded bg-gray-50 p-3 text-sm">{JSON.stringify(detail.operaDoc?.roomsByType || {}, null, 2)}</pre></div></Card>
      <Card><button onClick={() => setShowSnapshot((value) => !value)} className="flex w-full items-center justify-between font-semibold"><span>Snapshot information</span>{showSnapshot ? <ChevronUp className="h-5 w-5" /> : <ChevronDown className="h-5 w-5" />}</button>{showSnapshot && <div className="mt-4 grid gap-4 border-t pt-4 sm:grid-cols-2"><div><h3 className="font-semibold">MARSHA</h3><p className="text-sm">Snapshot date: {data.marsha.snapshotDate || "Not available"}</p><p className="text-sm">Status: {data.marsha.metadata?.status || data.marsha.metadata?.importStatus || "Not provided"}</p><p className="text-sm">Completed: {formatMetadata(data.marsha.metadata) || "Not provided"}</p></div><div><h3 className="font-semibold">Opera</h3><p className="text-sm">Snapshot date: {data.opera.snapshotDate || "Not available"}</p><p className="text-sm">Status: {data.opera.metadata?.status || data.opera.metadata?.importStatus || "Not provided"}</p><p className="text-sm">Completed: {formatMetadata(data.opera.metadata) || "Not provided"}</p></div></div>}</Card>
    </>}
  </PageContainer></div>;
}
