import React, { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Upload } from "lucide-react";
import * as XLSX from "xlsx";
import { useNavigate } from "react-router-dom";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { getGroupQuoteSettings, rebuildStayPatternModel, saveGroupQuoteSettings } from "../../services/firebaseQuotes";
import { saveLighthouseData } from "../../services/firebaseLighthouse";
import { getLocalIsoDate, parseLighthouseRows } from "../../utils/lighthouseImport";
import CompsetSettings from "./CompsetSettings";

export default function GroupQuoteSettingsPage() {
  const navigate = useNavigate();
  const { hotelUid } = useHotelContext();
  const [inflationPercentage, setInflationPercentage] = useState("");
  const [displacementThresholdPercentage, setDisplacementThresholdPercentage] = useState("");
  const [maxHistoricalGroupSharePercentage, setMaxHistoricalGroupSharePercentage] = useState("");
  const [roomVatPercentage, setRoomVatPercentage] = useState("");
  const [breakfastAllocation, setBreakfastAllocation] = useState("");
  const [variableRoomCost, setVariableRoomCost] = useState("");
  const [breakfastCostPerPerson, setBreakfastCostPerPerson] = useState("");
  const [bqtContributionMarginPercentage, setBqtContributionMarginPercentage] = useState("");
  const [transientDistributionCostPercentage, setTransientDistributionCostPercentage] = useState("");
  const [defaultGroupCommissionPercentage, setDefaultGroupCommissionPercentage] = useState("");
  const [defaultGroupMealBasis, setDefaultGroupMealBasis] = useState("RO");
  const [expectedFutureGroupCommissionPercentage, setExpectedFutureGroupCommissionPercentage] = useState("");
  const [transientAverageBreakfastPax, setTransientAverageBreakfastPax] = useState("");
  const [transientAverageBreakfastRevenuePerPax, setTransientAverageBreakfastRevenuePerPax] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importMessage, setImportMessage] = useState(null);
  const [stayPatternYear, setStayPatternYear] = useState("");
  const [rebuildingStayPattern, setRebuildingStayPattern] = useState(false);
  const [stayPatternResult, setStayPatternResult] = useState(null);
  const fileInputRef = useRef(null);
  const today = useMemo(() => new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }), []);
  const handleLogout = async () => { await signOut(auth); sessionStorage.clear(); window.location.href = "/login"; };

  useEffect(() => {
    if (!hotelUid) return;
    getGroupQuoteSettings(hotelUid).then((settings) => {
      setInflationPercentage(settings.inflationPercentage ?? "");
      setDisplacementThresholdPercentage(settings.displacementThresholdPercentage ?? "");
      setMaxHistoricalGroupSharePercentage(settings.maxHistoricalGroupSharePercentage ?? "");
      setRoomVatPercentage(settings.roomVatPercentage ?? "");
      setBreakfastAllocation(settings.breakfastAllocation ?? "");
      setVariableRoomCost(settings.variableRoomCost ?? "");
      setBreakfastCostPerPerson(settings.breakfastCostPerPerson ?? "");
      setBqtContributionMarginPercentage(settings.bqtContributionMarginPercentage ?? "");
      setTransientDistributionCostPercentage(settings.transientDistributionCostPercentage ?? "");
      setDefaultGroupCommissionPercentage(settings.defaultGroupCommissionPercentage ?? "");
      setDefaultGroupMealBasis(["RO", "BB"].includes(settings.defaultGroupMealBasis) ? settings.defaultGroupMealBasis : "RO");
      setExpectedFutureGroupCommissionPercentage(settings.expectedFutureGroupCommissionPercentage ?? settings.defaultGroupCommissionPercentage ?? "");
      setTransientAverageBreakfastPax(settings.transientAverageBreakfastPax ?? "");
      setTransientAverageBreakfastRevenuePerPax(settings.transientAverageBreakfastRevenuePerPax ?? "");
      setLoading(false);
    });
  }, [hotelUid]);

  const handleSubmit = async (event) => {
    event.preventDefault();
    setSaving(true);
    await saveGroupQuoteSettings(hotelUid, {
      inflationPercentage: Number(inflationPercentage),
      displacementThresholdPercentage: Number(displacementThresholdPercentage),
      maxHistoricalGroupSharePercentage: Number(maxHistoricalGroupSharePercentage),
      roomVatPercentage: Number(roomVatPercentage),
      breakfastAllocation: Number(breakfastAllocation),
      variableRoomCost: Number(variableRoomCost),
      breakfastCostPerPerson: Number(breakfastCostPerPerson),
      bqtContributionMarginPercentage: Number(bqtContributionMarginPercentage),
      transientDistributionCostPercentage: Number(transientDistributionCostPercentage),
      defaultGroupCommissionPercentage: Number(defaultGroupCommissionPercentage),
      defaultGroupMealBasis,
      expectedFutureGroupCommissionPercentage: Number(expectedFutureGroupCommissionPercentage),
      transientAverageBreakfastPax: Number(transientAverageBreakfastPax),
      transientAverageBreakfastRevenuePerPax: Number(transientAverageBreakfastRevenuePerPax),
    });
    setSaving(false);
    navigate("/revenue/group-quotes");
  };

  const handleLighthouseImport = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    setImporting(true);
    setImportMessage(null);
    try {
      const workbook = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: true });
      const ratesSheetName = workbook.SheetNames.find((name) => name.trim().toLowerCase() === "rates");
      if (!ratesSheetName) throw new Error('Het Excel-bestand bevat geen tabblad "Rates".');
      const rows = XLSX.utils.sheet_to_json(workbook.Sheets[ratesSheetName], {
        header: 1,
        defval: "",
        raw: false,
      });
      const lighthouseRows = parseLighthouseRows(rows);
      await saveLighthouseData(hotelUid, getLocalIsoDate(), lighthouseRows);
      setImportMessage({ type: "success", text: `${lighthouseRows.length} datums zijn succesvol geïmporteerd.` });
    } catch (error) {
      console.error("Lighthouse-import mislukt:", error);
      setImportMessage({ type: "error", text: error?.message || "Het Excel-bestand kon niet geïmporteerd worden." });
    } finally {
      setImporting(false);
    }
  };

  const handleStayPatternRebuild = async () => {
    setRebuildingStayPattern(true);
    setStayPatternResult(null);
    try {
      setStayPatternResult(await rebuildStayPatternModel(hotelUid, stayPatternYear || null));
    } catch (error) {
      setStayPatternResult({ error: error?.message || "Stay Pattern model rebuild failed." });
    } finally {
      setRebuildingStayPattern(false);
    }
  };

  const metricCells = (metrics = {}) => [metrics.comparedDates, metrics.authoritativeRooms, metrics.reconstructedRooms, metrics.meanAbsoluteError?.toFixed(2), metrics.medianAbsoluteError?.toFixed(2), metrics.wape == null ? "—" : `${(metrics.wape * 100).toFixed(2)}%`, metrics.signedErrorRooms, metrics.matchingDateShare == null ? "—" : `${(metrics.matchingDateShare * 100).toFixed(2)}%`, metrics.passes ? "PASS" : "FAIL"];

  return <div className="min-h-screen bg-gray-50 text-gray-900"><HeaderBar today={today} onLogout={handleLogout} /><PageContainer className="space-y-6">
    <div className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-sm uppercase tracking-wide text-gray-500">Revenue / Group Quotes</p><h1 className="text-3xl font-semibold">Group Quote Settings</h1></div><div className="flex flex-wrap justify-end gap-3"><input ref={fileInputRef} type="file" accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel" onChange={handleLighthouseImport} className="hidden" /><button type="button" disabled={importing || !hotelUid} onClick={() => fileInputRef.current?.click()} className="inline-flex items-center gap-2 rounded-lg bg-[#b41f1f] px-4 py-2 text-sm font-semibold text-white hover:bg-[#961a1a] disabled:cursor-not-allowed disabled:bg-gray-400"><Upload className="h-4 w-4" /> {importing ? "Importing..." : "Upload Lighthouse Data"}</button><button type="button" onClick={() => navigate("/revenue/group-quotes")} className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-semibold hover:bg-gray-100"><ArrowLeft className="h-4 w-4" /> Back to overview</button></div></div>
    {importMessage && <div role="status" className={`rounded-lg border px-4 py-3 text-sm font-medium ${importMessage.type === "success" ? "border-green-200 bg-green-50 text-green-800" : "border-red-200 bg-red-50 text-red-800"}`}>{importMessage.text}</div>}
    <Card><CompsetSettings hotelUid={hotelUid} /></Card>
    <Card><h2 className="text-lg font-semibold">Stay Pattern Model</h2><p className="mt-1 text-sm text-gray-600">Rebuild from the already imported staydatepattern reservation history. Leave year empty to rebuild all available years.</p><div className="mt-4 flex flex-wrap items-end gap-3"><label className="text-sm font-semibold">Optional year<input aria-label="Stay Pattern year" type="number" min="1900" max="2200" value={stayPatternYear} onChange={(event) => setStayPatternYear(event.target.value)} placeholder="All years" className="mt-1 block rounded border px-3 py-2 font-normal" /></label><button type="button" onClick={handleStayPatternRebuild} disabled={rebuildingStayPattern || !hotelUid} className="rounded-lg bg-[#b41f1f] px-4 py-2 font-semibold text-white disabled:bg-gray-400">{rebuildingStayPattern ? "Rebuilding…" : "Rebuild Stay Pattern Model"}</button></div>{stayPatternResult?.error && <p role="alert" className="mt-4 rounded bg-red-50 p-3 text-red-800">{stayPatternResult.error}</p>}{stayPatternResult && !stayPatternResult.error && <div className="mt-5 space-y-4"><p role="status" className={`rounded p-3 font-semibold ${stayPatternResult.status === "VALID" ? "bg-green-50 text-green-800" : "bg-amber-50 text-amber-900"}`}>{stayPatternResult.status} · years {stayPatternResult.affectedYears?.join(", ")} · source through {stayPatternResult.sourceThroughDate || "unknown"}</p><div className="overflow-x-auto"><table className="min-w-[1050px] w-full text-xs"><thead><tr className="text-left">{["Year / Type", "Dates", "Authoritative RN", "Reconstructed RN", "MAE", "Median AE", "WAPE", "Signed bias", "Matching", "Result"].map((heading)=><th className="p-2" key={heading}>{heading}</th>)}</tr></thead><tbody>{stayPatternResult.annualResults?.flatMap((annual)=>["transient","group"].map((type)=><tr className="border-t" key={`${annual.year}-${type}`}><td className="p-2 font-semibold">{annual.year} · {type.toUpperCase()}</td>{metricCells(annual.reconciliation[type]).map((value,index)=><td className="p-2" key={index}>{value ?? "—"}</td>)}</tr>))}{["transient","group"].map((type)=><tr className="border-t bg-gray-50" key={`combined-${type}`}><td className="p-2 font-bold">Combined · {type.toUpperCase()}</td>{metricCells(stayPatternResult.combined?.[type]).map((value,index)=><td className="p-2" key={index}>{value ?? "—"}</td>)}</tr>)}</tbody></table></div><details className="rounded border"><summary className="cursor-pointer p-3 font-semibold">Top 20 reconciliation mismatches</summary><div className="overflow-x-auto border-t"><table className="min-w-[1100px] w-full text-xs"><thead><tr>{["Date","Weekday","Transient authoritative","Transient reconstructed","Transient difference","Group authoritative","Group reconstructed","Group difference"].map((heading)=><th className="p-2 text-left" key={heading}>{heading}</th>)}</tr></thead><tbody>{stayPatternResult.topMismatches?.map((row)=><tr className="border-t" key={row.stayDate}><td className="p-2">{row.stayDate}</td><td>{row.weekday}</td><td>{row.authoritativeTransient}</td><td>{row.reconstructedTransient}</td><td>{row.differenceTransient}</td><td>{row.authoritativeGroup}</td><td>{row.reconstructedGroup}</td><td>{row.differenceGroup}</td></tr>)}</tbody></table></div></details><details className="rounded border"><summary className="cursor-pointer p-3 font-semibold">Exclusions and LOS coverage</summary><div className="grid gap-3 border-t p-3 text-sm sm:grid-cols-2 lg:grid-cols-3">{stayPatternResult.annualResults?.map((annual)=><div className="rounded bg-gray-50 p-3" key={annual.year}><strong>{annual.year}</strong><p>Realized used: {annual.quality.realizedReservationsUsed}</p><p>Cancelled/no-show: {annual.quality.cancelledNoShowExclusions}</p><p>NORATE: {annual.quality.norateExclusions}</p><p>Unclassified: {annual.quality.unclassifiedRateCodeCount}</p><p>Possible share: {annual.quality.possibleShareCount}</p><p>Invalid stay: {annual.quality.invalidStayCount}</p><p>Transient coverage: {(annual.losCoverage.TRANSIENT * 100).toFixed(2)}%</p><p>Group coverage: {(annual.losCoverage.GROUP * 100).toFixed(2)}%</p></div>)}</div></details></div>}</Card>
    <Card>{loading ? <p>Loading settings...</p> : <form onSubmit={handleSubmit} className="space-y-5"><div className="grid max-w-5xl gap-4 sm:grid-cols-2 lg:grid-cols-3"><label className="block text-sm font-semibold">Default Group Meal Basis<select value={defaultGroupMealBasis} onChange={(event)=>setDefaultGroupMealBasis(event.target.value)} className="mt-2 w-full rounded-lg border border-gray-300 px-3 py-2 font-normal"><option value="RO">Room Only (RO)</option><option value="BB">Bed &amp; Breakfast (BB)</option></select><span className="mt-1 block text-xs font-normal text-gray-500">Default commercial meal basis used when creating new group quote stay-night rows. This can be changed per night.</span></label><label className="block text-sm font-semibold">Inflation %<input required min="0" step="0.01" type="number" value={inflationPercentage} onChange={(event) => setInflationPercentage(event.target.value)} className="mt-2 w-full rounded-lg border border-gray-300 px-3 py-2 font-normal" /></label><label className="block text-sm font-semibold">Displacement Threshold %<input required min="0" max="100" step="0.01" type="number" value={displacementThresholdPercentage} onChange={(event) => setDisplacementThresholdPercentage(event.target.value)} className="mt-2 w-full rounded-lg border border-gray-300 px-3 py-2 font-normal" /></label><label className="block text-sm font-semibold">Max Historical Group Share %<input required min="0" max="100" step="0.01" type="number" value={maxHistoricalGroupSharePercentage} onChange={(event) => setMaxHistoricalGroupSharePercentage(event.target.value)} className="mt-2 w-full rounded-lg border border-gray-300 px-3 py-2 font-normal" /></label><label className="block text-sm font-semibold">Room VAT %<input required min="0" step="0.01" type="number" value={roomVatPercentage} onChange={(event) => setRoomVatPercentage(event.target.value)} className="mt-2 w-full rounded-lg border border-gray-300 px-3 py-2 font-normal" /></label><label className="block text-sm font-semibold">Breakfast Allocation (€)<input required min="0" step="0.01" type="number" value={breakfastAllocation} onChange={(event) => setBreakfastAllocation(event.target.value)} className="mt-2 w-full rounded-lg border border-gray-300 px-3 py-2 font-normal" /></label><label className="block text-sm font-semibold">Variable Room Cost (€)<input required min="0" step="0.01" type="number" value={variableRoomCost} onChange={(event) => setVariableRoomCost(event.target.value)} className="mt-2 w-full rounded-lg border border-gray-300 px-3 py-2 font-normal" /></label><label className="block text-sm font-semibold">Breakfast Cost Per Person (€)<input required min="0" step="0.01" type="number" value={breakfastCostPerPerson} onChange={(event) => setBreakfastCostPerPerson(event.target.value)} className="mt-2 w-full rounded-lg border border-gray-300 px-3 py-2 font-normal" /></label><label className="block text-sm font-semibold">BQT Contribution Margin %<input required min="0" max="100" step="0.01" type="number" value={bqtContributionMarginPercentage} onChange={(event) => setBqtContributionMarginPercentage(event.target.value)} className="mt-2 w-full rounded-lg border border-gray-300 px-3 py-2 font-normal" /></label><label className="block text-sm font-semibold">Transient Distribution Cost %<input required min="0" max="99.99" step="0.01" type="number" value={transientDistributionCostPercentage} onChange={(event) => setTransientDistributionCostPercentage(event.target.value)} className="mt-2 w-full rounded-lg border border-gray-300 px-3 py-2 font-normal" /></label><label className="block text-sm font-semibold">Default Group Commission %<input required min="0" max="99.99" step="0.01" type="number" value={defaultGroupCommissionPercentage} onChange={(event) => setDefaultGroupCommissionPercentage(event.target.value)} className="mt-2 w-full rounded-lg border border-gray-300 px-3 py-2 font-normal" /></label><label className="block text-sm font-semibold">Expected Future Group Commission %<input required min="0" max="99.99" step="0.01" type="number" value={expectedFutureGroupCommissionPercentage} onChange={(event) => setExpectedFutureGroupCommissionPercentage(event.target.value)} className="mt-2 w-full rounded-lg border border-gray-300 px-3 py-2 font-normal" /><span className="mt-1 block text-xs font-normal text-gray-500">Default Group Commission % applies to the group being quoted. Expected Future Group Commission % is used only to estimate the net value of other future group business that could be displaced.</span></label><label className="block text-sm font-semibold">Transient Average Breakfast Pax<input required min="0" step="0.01" type="number" value={transientAverageBreakfastPax} onChange={(event) => setTransientAverageBreakfastPax(event.target.value)} className="mt-2 w-full rounded-lg border border-gray-300 px-3 py-2 font-normal" /></label><label className="block text-sm font-semibold">Transient Average Breakfast Revenue Per Pax (€)<input required min="0" step="0.01" type="number" value={transientAverageBreakfastRevenuePerPax} onChange={(event) => setTransientAverageBreakfastRevenuePerPax(event.target.value)} className="mt-2 w-full rounded-lg border border-gray-300 px-3 py-2 font-normal" /></label></div><div><button disabled={saving} className="rounded-lg bg-[#b41f1f] px-5 py-2 font-semibold text-white disabled:bg-gray-400">{saving ? "Saving..." : "Save Settings"}</button></div></form>}</Card>
  </PageContainer></div>;
}
