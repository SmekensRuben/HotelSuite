import React, { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  BedDouble,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  CircleDollarSign,
  Euro,
  Hotel,
  Percent,
  Sparkles,
  Users,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import GroupQuoteFormFields from "./GroupQuoteFormFields";
import HistoricalYearsDropdown from "./HistoricalYearsDropdown";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { addQuote, getGroupQuoteSettings, getHistoryQuoteDates, getLatestHistoryForecastSnapshot, getLatestLighthouseSnapshot } from "../../services/firebaseQuotes";
import { buildHistoricalDateAnalysis, calculateAnalysisSummary } from "../../utils/quoteAnalysis";
import { getInclusiveQuoteDates } from "../../utils/quoteDates";
import { calculateDisplacementDay, DISPLACEMENT_FORECAST_CONFIG } from "../../utils/displacementForecast";
import { calculateGroupContribution, simulateGroupQuote } from "../../utils/contributionAnalysis";

const currency = (value) => `€${Number(value || 0).toFixed(2)}`;
const rooms = (value) => value === null || value === undefined ? "—" : Math.round(value).toLocaleString();
const percentage = (value) => value === null || value === undefined ? "—" : `${(value * 100).toFixed(1)}%`;

function IconHeader({ icon: Icon, label }) {
  return <span title={label} className="inline-flex"><Icon aria-hidden="true" className="h-4 w-4" /><span className="sr-only">{label}</span></span>;
}

export default function GroupQuoteCreatePage() {
  const navigate = useNavigate();
  const { hotelUid } = useHotelContext();
  const [consideredDates, setConsideredDates] = useState([]);
  const [selectedYears, setSelectedYears] = useState([]);
  const [weekOffsets, setWeekOffsets] = useState({});
  const [quoteSettings, setQuoteSettings] = useState({});
  const [analysisQuote, setAnalysisQuote] = useState(null);
  const [saving, setSaving] = useState(false);
  const [forecastData, setForecastData] = useState(null);
  const [forecastLoading, setForecastLoading] = useState(false);
  const [testGroupRate, setTestGroupRate] = useState("");
  const today = useMemo(() => new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }), []);
  const handleLogout = async () => { await signOut(auth); sessionStorage.clear(); window.location.href = "/login"; };
  const availableYears = useMemo(() => [...new Set(consideredDates.map((item) => Number(item.date.slice(0, 4))))].sort((a, b) => b - a), [consideredDates]);

  useEffect(() => {
    if (!hotelUid) return;
    Promise.all([getHistoryQuoteDates(hotelUid), getGroupQuoteSettings(hotelUid)]).then(([dates, settings]) => {
      setConsideredDates(dates);
      setQuoteSettings(settings);
      setSelectedYears([...new Set(dates.map((item) => Number(item.date.slice(0, 4))))].sort((a, b) => b - a));
    });
  }, [hotelUid]);

  useEffect(() => {
    if (!hotelUid || !analysisQuote) return;
    let active = true;
    setForecastData(null);
    setForecastLoading(true);
    Promise.all([getLatestHistoryForecastSnapshot(hotelUid), getLatestLighthouseSnapshot(hotelUid)])
      .then(([current, lighthouse]) => {
        if (!active) return;
        const maxShare = Number(quoteSettings.maxHistoricalGroupSharePercentage);
        const byDate = Object.fromEntries(getInclusiveQuoteDates(analysisQuote.startDate, analysisQuote.endDate).map((stayDate) => [stayDate,
          calculateDisplacementDay({
            stayDate,
            requestedGroupRooms: analysisQuote.roomsByDate.find((item) => item.date === stayDate)?.rooms,
            currentOtb: current.byDate[stayDate],
            historicalRows: consideredDates,
            selectedHistoricalYears: selectedYears,
            lighthouseByDate: lighthouse.byDate,
            maxHistoricalGroupShare: Number.isFinite(maxShare) ? maxShare / 100 : 1,
            inflationPercentage: quoteSettings.inflationPercentage,
            config: DISPLACEMENT_FORECAST_CONFIG,
          })
        ]));
        setForecastData({ byDate, currentSnapshotDate: current.snapshotDate, lighthouseSnapshotDate: lighthouse.snapshotDate });
      })
      .finally(() => { if (active) setForecastLoading(false); });
    return () => { active = false; };
  }, [hotelUid, analysisQuote, consideredDates, selectedYears, quoteSettings.maxHistoricalGroupSharePercentage]);

  const analysis = useMemo(() => analysisQuote ? buildHistoricalDateAnalysis(
    getInclusiveQuoteDates(analysisQuote.startDate, analysisQuote.endDate), consideredDates, selectedYears, weekOffsets, {
      quoteYear: Number(analysisQuote.startDate.slice(0, 4)),
      requestedRoomsByDate: Object.fromEntries(analysisQuote.roomsByDate.map((item) => [item.date, item.rooms])),
      inflationPercentage: quoteSettings.inflationPercentage,
      displacementThresholdPercentage: quoteSettings.displacementThresholdPercentage,
      displacedRoomsByDate: Object.fromEntries(Object.entries(forecastData?.byDate || {}).map(([date, result]) => [date, result.displacedRooms])),
    }
  ) : [], [analysisQuote, consideredDates, selectedYears, weekOffsets, quoteSettings, forecastData]);

  const analysisSummary = useMemo(() => calculateAnalysisSummary(analysis, {
    totalRequestedRooms: analysisQuote?.roomsByDate.reduce((total, item) => total + Number(item.rooms || 0), 0) || 0,
    roomVatPercentage: quoteSettings.roomVatPercentage,
    breakfastAllocation: quoteSettings.breakfastAllocation,
    breakfastIncluded: Number(analysisQuote?.breakfastPax || 0) > 0,
  }), [analysis, analysisQuote, quoteSettings]);

  const contribution = useMemo(() => {
    if (!analysisQuote || !forecastData) return null;
    try { return calculateGroupContribution({ quote: analysisQuote, forecastByDate: forecastData.byDate, settings: quoteSettings }); }
    catch (error) { return { validationError: error.message }; }
  }, [analysisQuote, forecastData, quoteSettings]);
  const simulation = useMemo(() => contribution && !contribution.validationError ? simulateGroupQuote(contribution, testGroupRate) : null, [contribution, testGroupRate]);

  const toggleYear = (year) => setSelectedYears((current) => current.includes(year)
    ? current.filter((item) => item !== year)
    : [...current, year].sort((a, b) => b - a));

  const moveYear = (year, direction) => setWeekOffsets((current) => ({
    ...current,
    [year]: Number(current[year] || 0) + direction,
  }));

  const handleSave = async () => {
    setSaving(true);
    try {
      const quoteId = await addQuote(hotelUid, {
        ...analysisQuote,
        analysisYears: selectedYears,
        displacementForecast: Object.values(forecastData?.byDate || {}),
      });
      navigate(`/revenue/group-quotes/${quoteId}`);
    } finally {
      setSaving(false);
    }
  };

  return <div className="min-h-screen bg-gray-50 text-gray-900">
    <HeaderBar today={today} onLogout={handleLogout} />
    <PageContainer className="space-y-6 pb-10">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div><p className="text-sm uppercase tracking-wide text-gray-500">Revenue / Group Quotes</p><h1 className="text-3xl font-semibold">Create Quote</h1></div>
        <button type="button" onClick={() => navigate("/revenue/group-quotes")} className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-semibold hover:bg-gray-100"><ArrowLeft className="h-4 w-4" /> Back to overview</button>
      </div>

      <Card className="border border-gray-200 bg-white shadow-sm">
        <GroupQuoteFormFields defaultGroupCommissionPercentage={quoteSettings.defaultGroupCommissionPercentage} onSubmit={setAnalysisQuote} saving={false} submitLabel="Start Analysis" />
      </Card>

      <Card className="border border-gray-200 bg-white shadow-sm">
        <details>
          <summary className="cursor-pointer font-semibold">Advanced / Model Settings</summary>
          <div className="mt-4 border-t border-gray-200 pt-4">
            <fieldset><legend className="mb-2 text-sm font-semibold">Historical years</legend><HistoricalYearsDropdown years={availableYears} selectedYears={selectedYears} onToggle={toggleYear} /></fieldset>
          </div>
        </details>
      </Card>

      {analysisQuote && <section className="space-y-6">
        <div><p className="text-sm font-semibold uppercase tracking-wide text-gray-500">Group displacement analysis</p><h2 className="text-2xl font-semibold">Analysis overview</h2><p className="mt-1 text-sm text-gray-600">Economic decision support for the requested stay dates.</p></div>
        {contribution?.validationError ? <Card className="border border-red-200 bg-red-50 text-red-800"><strong>Contribution settings error:</strong> {contribution.validationError}</Card> : contribution && <>
          <Card className="overflow-hidden border border-gray-200 bg-white p-0 shadow-sm">
            <div className="border-b border-gray-200 bg-gray-50 px-6 py-4"><p className="text-xs font-semibold uppercase tracking-widest text-gray-500">Pricing / Economic Summary</p><h3 className="mt-1 text-xl font-semibold">Economic decision</h3></div>
            <div className="grid gap-6 p-6 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,0.9fr)]">
              <div>
                <div className="rounded-xl border-2 border-blue-200 bg-blue-50 p-5"><p className="text-sm font-bold uppercase tracking-wide text-blue-800">Economic Floor Rate</p><p className="mt-1 text-4xl font-bold text-gray-900">{contribution.economicFloorRate === null ? "Unavailable" : currency(contribution.economicFloorRate)}</p><p className="mt-1 text-sm font-medium text-gray-600">Average room rate</p><p className="mt-4 text-sm text-gray-700">Minimum average group room rate expected to make accepting the group economically neutral versus protecting expected transient demand.</p></div>
                <p className="mt-3 text-sm font-medium text-gray-600">Pricing recommendation not yet applied.</p>
                {testGroupRate !== "" && simulation && <div className="mt-5 grid gap-3 sm:grid-cols-2">
                  <div className="rounded-lg bg-gray-50 p-4"><p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Test Rate</p><p className="mt-1 text-2xl font-semibold">{currency(simulation.testGroupRate)}</p></div>
                  <div className={`rounded-lg p-4 ${Math.abs(simulation.rateAboveFloor) <= 0.01 ? "bg-amber-50 text-amber-900" : simulation.rateAboveFloor > 0 ? "bg-green-50 text-green-800" : "bg-red-50 text-red-800"}`}><p className="text-xs font-semibold uppercase tracking-wide">{Math.abs(simulation.rateAboveFloor) <= 0.01 ? "At Floor" : simulation.rateAboveFloor > 0 ? "Above Floor" : "Below Floor"}</p><p className="mt-1 text-2xl font-semibold">{simulation.rateAboveFloor > 0 ? "+" : ""}{currency(simulation.rateAboveFloor)}</p><p className="text-sm font-semibold">{simulation.rateAboveFloorPercentage !== null && simulation.rateAboveFloorPercentage > 0 ? "+" : ""}{percentage(simulation.rateAboveFloorPercentage)}</p></div>
                  <div className={`rounded-lg p-4 sm:col-span-2 ${simulation.netIncrementalContribution >= 0 ? "bg-green-50 text-green-800" : "bg-red-50 text-red-800"}`}><p className="text-xs font-semibold uppercase tracking-wide">Expected Net Incremental Contribution</p><p className="mt-1 text-2xl font-semibold">{simulation.netIncrementalContribution > 0 ? "+" : ""}{currency(simulation.netIncrementalContribution)}</p><p className="mt-1 text-sm font-semibold">Status: {Math.abs(simulation.rateAboveFloor) <= 0.01 ? "Economically neutral" : simulation.rateAboveFloor > 0 ? "Economically acceptable" : "Below economic floor"}</p></div>
                </div>}
              </div>
              <div className="rounded-xl border border-gray-200 p-5"><h3 className="text-lg font-semibold">Quote Simulator</h3><p className="mt-1 text-sm text-gray-600">Simulation only: this value is not saved as the quote rate.</p><label className="mt-4 block text-sm font-semibold">Test Average Group Rate<input min="0" step="0.01" type="number" value={testGroupRate} onChange={(event) => setTestGroupRate(event.target.value)} className="mt-2 w-full rounded-lg border border-gray-300 px-3 py-2 font-normal" /></label>{simulation && <dl className="mt-4 grid gap-x-4 gap-y-3 sm:grid-cols-2">{[["Group Room Revenue", currency(simulation.testGroupRoomRevenue)], ["Commission Cost", currency(simulation.testGroupCommissionCost)], ["Net Group Contribution", currency(simulation.testGroupContribution)], ["Lost Transient Contribution", currency(simulation.totalLostTransientContribution)], ["Net Incremental Contribution", currency(simulation.netIncrementalContribution)], ["Rate Above / Below Floor", `${simulation.rateAboveFloor > 0 ? "+" : ""}${currency(simulation.rateAboveFloor)}${simulation.rateAboveFloorPercentage === null ? "" : ` (${simulation.rateAboveFloorPercentage > 0 ? "+" : ""}${percentage(simulation.rateAboveFloorPercentage)})`}`]].map(([label, value]) => <div key={label} className="border-t border-gray-100 pt-3"><dt className="text-xs font-semibold uppercase tracking-wide text-gray-500">{label}</dt><dd className="mt-1 font-semibold">{value}</dd></div>)}</dl>}</div>
            </div>
            {contribution.warnings.length > 0 && <div className="mx-6 mb-6 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"><strong>Warnings:</strong><ul className="ml-5 list-disc">{contribution.warnings.map((warning, index) => <li key={`${warning}-${index}`}>{warning}</li>)}</ul></div>}
          </Card>

          <div><h3 className="text-lg font-semibold">Group Impact</h3><p className="text-sm text-gray-600">Room-night impact across all requested stay dates.</p><dl className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{[["Requested room nights", rooms(contribution.totalRequestedGroupRoomNights)], ["Displaced room nights", rooms(contribution.totalDisplacedRooms)], ["Incremental room nights", rooms(contribution.totalNonDisplacingGroupRooms)], ["Displacement ratio", contribution.totalRequestedGroupRoomNights === 0 ? "—" : percentage(contribution.totalDisplacedRooms / contribution.totalRequestedGroupRoomNights)]].map(([label, value]) => <Card key={label} className="border border-gray-200 p-4 shadow-sm"><dt className="text-xs font-semibold uppercase tracking-wide text-gray-500">{label}</dt><dd className="mt-2 text-2xl font-semibold">{value}</dd></Card>)}</dl></div>

          <Card className="border border-gray-200 bg-white shadow-sm"><div><p className="text-xs font-semibold uppercase tracking-widest text-gray-500">Contribution Bridge</p><h3 className="mt-1 text-lg font-semibold">Contribution breakdown</h3><p className="mt-1 text-sm text-gray-600">Existing contribution inputs shown by their economic effect.</p></div><dl className="mt-5 divide-y divide-gray-100">{[["Lost transient contribution", contribution.totalLostTransientContribution === null ? "Unavailable" : currency(contribution.totalLostTransientContribution), "text-gray-900"], ["Group variable room costs", `-${currency(contribution.groupVariableRoomCosts)}`, "text-red-700"], ["Group breakfast costs", `-${currency(contribution.groupBreakfastCosts)}`, "text-red-700"], ["BQT contribution", `+${currency(contribution.bqtContribution)}`, "text-green-700"], ["Group commission", percentage(contribution.groupCommission), "text-gray-900"]].map(([label, value, tone]) => <div key={label} className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0"><dt className="text-sm font-medium text-gray-600">{label}</dt><dd className={`text-base font-semibold tabular-nums ${tone}`}>{value}</dd></div>)}</dl><p className="mt-4 border-t border-gray-100 pt-4 text-xs text-gray-500">This breakdown presents the existing result values and is not an additional reconciliation formula.</p></Card>

          <Card className="border border-gray-200 bg-white p-0 shadow-sm"><div className="px-6 py-5"><p className="text-xs font-semibold uppercase tracking-widest text-gray-500">Nightly Analysis</p><h3 className="mt-1 text-lg font-semibold">Stay-date impact</h3></div><div className="overflow-x-auto border-t border-gray-200"><table className="min-w-[960px] w-full text-sm"><thead className="bg-gray-50 text-left text-xs uppercase text-gray-500"><tr>{["Date", "Requested Group RN", "Displaced RN", "Incremental RN", "Final Transient Demand Forecast", "Expected Transient Room Rate", "Lost Transient Contribution", "Confidence"].map((heading) => <th key={heading} className="whitespace-nowrap px-4 py-3">{heading}</th>)}</tr></thead><tbody className="divide-y divide-gray-100">{contribution.nightly.map((night) => { const forecast = forecastData?.byDate?.[night.stayDate] || {}; return <tr key={night.stayDate}><td className="whitespace-nowrap px-4 py-3 font-medium">{night.stayDate}</td><td className="px-4 py-3">{rooms(night.requestedGroupRooms)}</td><td className="px-4 py-3">{rooms(night.displacedRooms)}</td><td className="px-4 py-3">{rooms(night.requestedGroupRooms - night.displacedRooms)}</td><td className="px-4 py-3">{rooms(forecast.transientDemandForecast)}</td><td className="whitespace-nowrap px-4 py-3">{night.expectedTransientRoomRate === null ? "—" : currency(night.expectedTransientRoomRate)}</td><td className="whitespace-nowrap px-4 py-3">{night.lostTransientContribution === null ? "—" : currency(night.lostTransientContribution)}</td><td className="px-4 py-3"><span className={`rounded-full px-2.5 py-1 text-xs font-bold uppercase ${forecast.forecastConfidence === "high" ? "bg-green-100 text-green-800" : forecast.forecastConfidence === "medium" ? "bg-blue-100 text-blue-800" : "bg-amber-200 text-amber-900"}`}>{forecast.forecastConfidence || "—"}</span></td></tr>; })}</tbody></table></div></Card>
        </>}

        <Card className="border border-gray-200 bg-white shadow-sm">
          <div className="mb-4 flex flex-wrap items-end justify-between gap-2"><div><h3 className="text-lg font-semibold">Transient-demand forecast</h3><p className="text-sm text-gray-600">PMS snapshot {forecastData?.currentSnapshotDate || "unavailable"} · Lighthouse snapshot {forecastData?.lighthouseSnapshotDate || "unavailable"}</p></div>{forecastLoading && <span className="text-sm text-gray-500">Loading forecast…</span>}</div>
          <div className="space-y-3">{Object.values(forecastData?.byDate || {}).map((result) => <details key={result.stayDate} className={`rounded-lg border ${result.forecastConfidence === "low" ? "border-amber-300 bg-amber-50" : "border-gray-200"}`}>
            <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-3 p-4"><span className="font-semibold">{result.stayDate}</span><span className="flex flex-wrap items-center gap-3"><span className="text-sm font-medium text-gray-700">{rooms(result.transientDemandForecast)} transient forecast</span><span className="text-sm text-gray-600">{rooms(result.displacedRooms)} displaced rooms</span><span className={`rounded-full px-2.5 py-1 text-xs font-bold uppercase ${result.forecastConfidence === "high" ? "bg-green-100 text-green-800" : result.forecastConfidence === "medium" ? "bg-blue-100 text-blue-800" : "bg-amber-200 text-amber-900"}`}>{result.forecastConfidence} confidence</span><span className="text-xs font-semibold uppercase text-gray-500">View details</span></span></summary>
            <div className="border-t border-inherit p-4"><dl className="grid gap-x-5 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
              <div><dt className="text-gray-500">Historical selection tier</dt><dd className="font-medium">{result.historicalSelectionTier}</dd></div>
              <div><dt className="text-gray-500">Selected historical years</dt><dd className="font-medium">{result.historicalYears?.join(", ") || "None"}</dd></div>
              <div><dt className="text-gray-500">Historical sample used / censored</dt><dd className="font-medium">{result.historicalSelectedCount} / {result.historicalCensoredCount}</dd></div>
              <div><dt className="text-gray-500">Historical transient baseline</dt><dd className="font-medium">{rooms(result.historicalBaselineRooms)} rooms ({percentage(result.historicalMedianTransientOccupancy)})</dd></div>
              <div><dt className="text-gray-500">Latest Lighthouse Market Demand</dt><dd className="font-medium">{percentage(result.targetLighthouseMarketDemand)}</dd></div>
              <div><dt className="text-gray-500">Comparable Lighthouse Market Demand</dt><dd className="font-medium">{percentage(result.comparableLighthouseMarketDemand)}</dd></div>
              <div><dt className="text-gray-500">Lighthouse demand adjustment</dt><dd className="font-medium">{percentage(result.lighthouseMarketModifier - 1)} ({result.lighthouseMarketModifier.toFixed(3)}×)</dd></div>
              <div><dt className="text-gray-500">Adjusted historical demand</dt><dd className="font-medium">{rooms(result.adjustedHistoricalDemand)} rooms</dd></div>
              <div><dt className="text-gray-500">Current transient OTB</dt><dd className="font-medium">{rooms(result.currentTransientOtb)} rooms</dd></div>
              <div><dt className="text-gray-500">Final transient demand forecast</dt><dd className="font-semibold">{rooms(result.transientDemandForecast)} rooms</dd></div>
              <div><dt className="text-gray-500">Existing group OTB</dt><dd className="font-medium">{rooms(result.existingGroupOtb)} rooms</dd></div>
              <div><dt className="text-gray-500">Other committed rooms</dt><dd className="font-medium">{rooms(result.otherCommittedRooms)} rooms</dd></div>
              <div><dt className="text-gray-500">Sellable inventory</dt><dd className="font-medium">{rooms(result.sellableInventory)} rooms</dd></div>
              <div><dt className="text-gray-500">Requested group rooms</dt><dd className="font-medium">{rooms(result.requestedGroupRooms)} rooms</dd></div>
              <div><dt className="text-gray-500">Expected displaced transient rooms</dt><dd className="font-semibold text-red-700">{rooms(result.displacedRooms)} rooms</dd></div>
              <div><dt className="text-gray-500">Non-displacing group rooms</dt><dd className="font-semibold text-green-700">{rooms(result.nonDisplacingGroupRooms)} rooms</dd></div>
            </dl>
            {result.warnings.length > 0 && <div className="mt-3 rounded border border-amber-300 bg-white/70 p-2 text-sm text-amber-900"><strong>Warnings:</strong><ul className="ml-5 list-disc">{result.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></div>}
            </div>
          </details>)}</div>
        </Card>
        <details className="rounded-lg border border-gray-200 bg-white shadow-sm">
          <summary className="cursor-pointer p-4 text-lg font-semibold">Historical Performance Reference</summary>
          <div className="space-y-4 border-t border-gray-200 p-4">
        {analysis.length ? analysis.map(({ year, matches }) => {
          const yearTotal = matches.reduce((total, match) => total + match.displacedRevenue, 0);
          return <Card key={year}>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <div><h3 className="text-lg font-semibold">{year}</h3><p className="text-sm text-gray-600">Total displaced revenue: <strong>{currency(yearTotal)}</strong></p></div>
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => moveYear(year, -1)} className="rounded border border-gray-300 p-1.5 hover:bg-gray-100" aria-label={`Move ${year} one week back`}><ChevronLeft className="h-4 w-4" /></button>
                <span className="min-w-24 text-center text-xs font-medium text-gray-600">{weekOffsets[year] ? `${weekOffsets[year] > 0 ? "+" : ""}${weekOffsets[year]} week${Math.abs(weekOffsets[year]) === 1 ? "" : "s"}` : "Same week"}</span>
                <button type="button" onClick={() => moveYear(year, 1)} className="rounded border border-gray-300 p-1.5 hover:bg-gray-100" aria-label={`Move ${year} one week forward`}><ChevronRight className="h-4 w-4" /></button>
              </div>
            </div>
            <div className="overflow-x-auto"><table className="min-w-full text-sm">
              <thead className="border-b text-left text-xs uppercase text-gray-500"><tr>
                <th className="py-2 pr-3"><IconHeader icon={CalendarDays} label="Day" /></th>
                <th className="px-3 py-2"><IconHeader icon={CalendarDays} label="Considered Date" /></th>
                <th className="px-3 py-2"><IconHeader icon={Hotel} label="Inventory Rooms" /></th>
                <th className="px-3 py-2"><IconHeader icon={BedDouble} label="Occupied Rooms (Group Rooms)" /></th>
                <th className="px-3 py-2"><IconHeader icon={Euro} label="Average Room Rate" /></th>
                <th className="px-3 py-2"><IconHeader icon={Percent} label="Adjusted Average Room Rate" /></th>
                <th className="px-3 py-2"><IconHeader icon={Users} label="Displaced Rooms" /></th>
                <th className="px-3 py-2"><IconHeader icon={CircleDollarSign} label="Displaced Revenue" /></th>
                <th className="py-2 pl-3"><IconHeader icon={Sparkles} label="Events" /></th>
              </tr></thead>
              <tbody className="divide-y divide-gray-200">{matches.map((match) => <tr key={match.quoteDate}>
                <td className="py-2 pr-3 font-semibold">{match.weekday}</td>
                <td className="px-3 py-2">{match.consideredDate?.date || match.historicalDate || "-"}</td>
                <td className="px-3 py-2">{Number(match.consideredDate?.calculatedInventoryRooms || 0)}</td>
                <td className="px-3 py-2">{Number(match.consideredDate?.calculatedOccRooms || 0)} <span className="font-semibold text-green-600">({Number(match.consideredDate?.groupRooms || 0)})</span></td>
                <td className="px-3 py-2">{currency(match.consideredDate?.averageRoomRate)}</td>
                <td className="px-3 py-2">{currency(match.adjustedAverageRoomRate)}</td>
                <td className="px-3 py-2">{match.displacedRooms}</td>
                <td className="px-3 py-2">{currency(match.displacedRevenue)}</td>
                <td className="py-2 pl-3 text-gray-400">—</td>
              </tr>)}</tbody>
            </table></div>
          </Card>;
        }) : <Card><p className="text-gray-600">Select at least one historical year to view the analysis.</p></Card>}

          </div>
        </details>
        <div className="flex justify-end"><button type="button" disabled={saving || forecastLoading || !forecastData} onClick={handleSave} className="rounded-lg bg-[#b41f1f] px-5 py-2 font-semibold text-white disabled:bg-gray-400">{saving ? "Saving quote..." : "Save Quote"}</button></div>
      </section>}
    </PageContainer>
  </div>;
}
