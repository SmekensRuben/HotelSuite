import React, { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowLeft, Check, ChevronDown, ChevronUp, X } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import DataListTable from "../shared/DataListTable";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { getMarshaBalanceData, getMarshaBalanceSettings } from "../../services/firebaseMarshaBalance";
import { evaluateSimplifiedBalance, getBrusselsDateString, getSourceState } from "../../utils/marshaBalance";

const colors = { ok: "text-green-700", warning: "text-amber-700", review: "text-amber-700", action: "text-red-700", unreliable: "text-red-700", unassessable: "text-red-700", unconfigured: "text-gray-600" };
function Result({ value }) {
  const Icon = value.code === "ok" ? Check : ["action", "unreliable", "unassessable"].includes(value.code) ? X : AlertTriangle;
  return <span className={`inline-flex items-center gap-1 font-semibold ${colors[value.code]}`}><Icon className="h-4 w-4" />{value.label}</span>;
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
    const sourceFailure = (message) => ({ code: "unassessable", label: "Cannot assess", alerts: [{ severity: "unassessable", code: "source_data", title: "Source data problem", message }], categories: [], marshaDoc, operaDoc });
    if (!marshaDoc || !operaDoc) return sourceFailure("A required stay-date document is missing.");
    if (data.marsha.snapshotDate !== data.opera.snapshotDate) return sourceFailure("MARSHA and Opera snapshots are not comparable.");
    const marshaState = getSourceState({ stayDocument: marshaDoc, snapshotDate: data.marsha.snapshotDate, today, metadata: data.marsha.metadata });
    const operaState = getSourceState({ stayDocument: operaDoc, snapshotDate: data.opera.snapshotDate, today, metadata: data.opera.metadata });
    if (marshaState.status !== "current" || operaState.status !== "current") return sourceFailure(`Both sources must be current and complete. MARSHA: ${marshaState.label}; Opera: ${operaState.label}.`);
    return { ...evaluateSimplifiedBalance({ marshaRooms: marshaDoc.roomsByType, operaRooms: operaDoc.roomsByType, marshaTotal: marshaDoc.mappedTotal, operaTotal: operaDoc.mappedTotal, settings, stayDate }), marshaDoc, operaDoc };
  }, [data, settings, stayDate, today]);
  const logout = async () => { await signOut(auth); sessionStorage.clear(); window.location.href = "/login"; };
  const columns = [
    { key: "categoryCode", label: "MARSHA category", render: (row) => <strong>{row.categoryCode}</strong> },
    { key: "marshaValue", label: "MARSHA offered" },
    { key: "ownOperaValue", label: "Own Opera type", render: (row) => <span>{row.operaType}: {row.ownOperaValue}</span> },
    { key: "shortage", label: "Own-type shortage", render: (row) => row.shortage ?? "—" },
    { key: "higher", label: "Allowed higher types", sortable: false, render: (row) => row.higherTypes?.length ? row.higherTypes.map((item) => <div key={item.code}>{item.code}: {item.value ?? "missing"}</div>) : "None" },
    { key: "coveredByHigher", label: "Covered by higher", render: (row) => row.coveredByHigher ?? "—" },
    { key: "uncovered", label: "Uncovered", render: (row) => <strong className={row.uncovered ? "text-red-700" : ""}>{row.uncovered ?? "—"}</strong> },
    { key: "result", label: "Conclusion", sortable: false, render: (row) => <Result value={row} /> },
  ];

  return <div className="min-h-screen bg-gray-50 text-gray-900"><HeaderBar today={new Date().toLocaleDateString("en-GB", { timeZone: "Europe/Brussels", weekday: "long", month: "long", day: "numeric" })} onLogout={logout} /><PageContainer className="space-y-6">
    <button onClick={() => navigate("/front-office/marsha-balance")} className="inline-flex items-center gap-2 text-sm font-semibold text-[#b41f1f]"><ArrowLeft className="h-4 w-4" />Back to MARSHA Balance</button><div><p className="text-sm uppercase tracking-wide text-gray-500">Balance details</p><h1 className="text-3xl font-semibold">{stayDate}</h1><p className="mt-1 text-gray-600">Separate findings for source data, explicit totals, GENR, premium upgrades, and weekend DBDB protection.</p></div>
    {error && <div className="rounded-lg bg-red-50 p-4 text-red-800">{error}</div>}{loading && <p>Loading details…</p>}
    {!loading && detail && <><Card className={`border ${detail.code === "ok" ? "border-green-200" : ["warning", "review", "unconfigured"].includes(detail.code) ? "border-amber-200" : "border-red-200"}`}><Result value={detail} /><p className="mt-2 text-sm text-gray-600">{detail.alerts.length ? `${detail.alerts.length} finding(s) for this stay date.` : "All configured controls passed."}</p></Card>
      <div><h2 className="mb-3 text-xl font-semibold">Findings</h2><div className="space-y-3">{detail.alerts.length ? detail.alerts.map((item, index) => <Card key={`${item.code}-${index}`} className={item.severity === "action" || item.severity === "unassessable" || item.severity === "unreliable" ? "border border-red-200" : "border border-amber-200"}><p className="text-xs font-semibold uppercase tracking-wide text-gray-500">{item.code.replaceAll("_", " ")}</p><h3 className="mt-1 font-semibold">{item.title}</h3><p className="mt-1 text-sm">{item.message}</p>{item.code === "weekend_limit" && <dl className="mt-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4"><div><dt>Opera total</dt><dd className="font-semibold">{item.operaTotal}</dd></div><div><dt>Opera DBDB</dt><dd className="font-semibold">{item.operaDbdb}</dd></div><div><dt>Weekend maximum GENR</dt><dd className="font-semibold">{item.weekendMaximumGenr}</dd></div><div><dt>MARSHA GENR</dt><dd className="font-semibold">{item.marshaGenr}</dd></div></dl>}</Card>) : <Card className="border border-green-200"><Check className="mr-2 inline h-5 w-5 text-green-700" />No findings.</Card>}</div></div>
      {detail.marshaDoc && <Card><h2 className="text-lg font-semibold">GENR and total summary</h2><dl className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">{[["MARSHA total", detail.marshaTotal], ["Opera total", detail.operaTotal], ["MARSHA GENR", detail.marshaGenr], ["Effective minimum GENR", detail.minimumGenr], ["Weekend maximum GENR", detail.weekendMaximumGenr ?? "Not applicable"]].map(([label, value]) => <div key={label} className="rounded bg-gray-50 p-3"><dt className="text-xs text-gray-500">{label}</dt><dd className="text-xl font-semibold">{value ?? "Missing"}</dd></div>)}</dl></Card>}
      <div><h2 className="mb-3 text-xl font-semibold">Premium category checks</h2><DataListTable columns={columns} rows={(detail.categories || []).map((item) => ({ ...item, id: item.categoryCode }))} emptyMessage="No premium categories configured." getRowProps={(row) => ({ className: row.code === "ok" ? "bg-green-50" : row.code === "warning" ? "bg-amber-50" : "bg-red-50" })} /></div>
      <Card className="grid gap-4 sm:grid-cols-2"><div><h2 className="font-semibold">MARSHA source values</h2><p className="text-xs text-gray-500">Mapped total field: {detail.marshaDoc?.mappedTotalField || "missing"}</p><pre className="mt-2 overflow-auto rounded bg-gray-50 p-3 text-sm">{JSON.stringify(detail.marshaDoc?.roomsByType || {}, null, 2)}</pre></div><div><h2 className="font-semibold">Opera source values</h2><p className="text-xs text-gray-500">Mapped total field: {detail.operaDoc?.mappedTotalField || "missing"}</p><pre className="mt-2 overflow-auto rounded bg-gray-50 p-3 text-sm">{JSON.stringify(detail.operaDoc?.roomsByType || {}, null, 2)}</pre></div></Card>
      <Card><button onClick={() => setShowSnapshot((value) => !value)} className="flex w-full items-center justify-between font-semibold"><span>Snapshot information</span>{showSnapshot ? <ChevronUp className="h-5 w-5" /> : <ChevronDown className="h-5 w-5" />}</button>{showSnapshot && <div className="mt-4 grid gap-4 border-t pt-4 sm:grid-cols-2"><div><h3 className="font-semibold">MARSHA</h3><p className="text-sm">Snapshot date: {data.marsha.snapshotDate || "Not available"}</p><p className="text-sm">Completed: {formatMetadata(data.marsha.metadata) || "Not provided"}</p></div><div><h3 className="font-semibold">Opera</h3><p className="text-sm">Snapshot date: {data.opera.snapshotDate || "Not available"}</p><p className="text-sm">Completed: {formatMetadata(data.opera.metadata) || "Not provided"}</p></div></div>}</Card>
    </>}
  </PageContainer></div>;
}
