import React, { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
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
import { getInclusiveQuoteDates } from "../../utils/quoteDates";
import { calculateDisplacementDay, DISPLACEMENT_FORECAST_CONFIG } from "../../utils/displacementForecast";
import { calculateDemandCapacitySummary, calculateGroupContribution, simulateGroupQuote } from "../../utils/contributionAnalysis";
import { getDemandCalendarEvents } from "../../services/firebaseDemandCalendar";
import { calculateGroupDemandForecast } from "../../utils/groupDemandForecast";

const currency = (value) => `€${Number(value || 0).toFixed(2)}`;
const rooms = (value) => value === null || value === undefined ? "—" : Math.round(value).toLocaleString();
const percentage = (value) => value === null || value === undefined ? "—" : `${(value * 100).toFixed(1)}%`;

export default function GroupQuoteCreatePage() {
  const navigate = useNavigate();
  const { hotelUid } = useHotelContext();
  const [consideredDates, setConsideredDates] = useState([]);
  const [selectedYears, setSelectedYears] = useState([]);
  const [quoteSettings, setQuoteSettings] = useState({});
  const [analysisQuote, setAnalysisQuote] = useState(null);
  const [saving, setSaving] = useState(false);
  const [forecastData, setForecastData] = useState(null);
  const [groupForecastData, setGroupForecastData] = useState(null);
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
    setGroupForecastData(null);
    setForecastLoading(true);
    Promise.all([getLatestHistoryForecastSnapshot(hotelUid), getLatestLighthouseSnapshot(hotelUid), getDemandCalendarEvents(hotelUid)])
      .then(([current, lighthouse, events]) => {
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
        const groupByDate = Object.fromEntries(getInclusiveQuoteDates(analysisQuote.startDate, analysisQuote.endDate).map((stayDate) => [stayDate, calculateGroupDemandForecast({ stayDate, currentOtb: current.byDate[stayDate], historicalRows: consideredDates, events, selectedHistoricalYears: selectedYears })]));
        setGroupForecastData({ byDate: groupByDate });
      })
      .finally(() => { if (active) setForecastLoading(false); });
    return () => { active = false; };
  }, [hotelUid, analysisQuote, consideredDates, selectedYears, quoteSettings.maxHistoricalGroupSharePercentage]);

  const contribution = useMemo(() => {
    if (!analysisQuote || !forecastData || !groupForecastData) return null;
    const combined = Object.fromEntries(Object.entries(forecastData.byDate).map(([stayDate, forecast]) => [stayDate, { ...forecast, groupForecast: groupForecastData.byDate[stayDate] }]));
    try { return calculateGroupContribution({ quote: analysisQuote, forecastByDate: combined, settings: quoteSettings }); }
    catch (error) { return { validationError: error.message }; }
  }, [analysisQuote, forecastData, groupForecastData, quoteSettings]);
  const simulation = useMemo(() => contribution && !contribution.validationError ? simulateGroupQuote(contribution, testGroupRate) : null, [contribution, testGroupRate]);

  const toggleYear = (year) => setSelectedYears((current) => current.includes(year)
    ? current.filter((item) => item !== year)
    : [...current, year].sort((a, b) => b - a));

  const handleSave = async () => {
    setSaving(true);
    try {
      const quoteId = await addQuote(hotelUid, {
        ...analysisQuote,
        analysisYears: selectedYears,
        displacementForecast: Object.values(forecastData?.byDate || {}),
        groupDemandForecast: Object.values(groupForecastData?.byDate || {}),
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
                <div className="rounded-xl border-2 border-blue-200 bg-blue-50 p-5"><p className="text-sm font-bold uppercase tracking-wide text-blue-800">Economic Floor Rate</p><p className="mt-1 text-4xl font-bold text-gray-900">{contribution.economicFloorRateInclVat === null ? "Unavailable" : currency(contribution.economicFloorRateInclVat)}</p><p className="mt-1 text-sm font-medium text-gray-600">Incl. VAT · Base group-demand scenario</p><p className="text-xs text-gray-500">{contribution.economicFloorRateExVat === null ? "" : `${currency(contribution.economicFloorRateExVat)} excl. VAT`}</p><p className="mt-4 text-sm text-gray-700">The adjusted Economic Floor protects expected future transient and group contribution. Future group demand is based on Group Forecast V1.</p><dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-3"><div><dt className="text-gray-600">Transient-only Floor · incl. VAT</dt><dd className="font-semibold">{contribution.transientOnlyEconomicFloorInclVat === null ? "Unavailable" : currency(contribution.transientOnlyEconomicFloorInclVat)}</dd></div><div><dt className="text-gray-600">Low Group Demand Floor · incl. VAT</dt><dd className="font-semibold">{contribution.economicFloorLowInclVat === null ? "Unavailable" : currency(contribution.economicFloorLowInclVat)}</dd></div><div><dt className="text-gray-600">High Group Demand Floor · incl. VAT</dt><dd className="font-semibold">{contribution.economicFloorHighInclVat === null ? "Unavailable" : currency(contribution.economicFloorHighInclVat)}</dd></div></dl></div>
                <p className="mt-3 text-sm font-medium text-gray-600">Pricing recommendation not yet applied.</p>
                {testGroupRate !== "" && simulation && <div className="mt-5 grid gap-3 sm:grid-cols-2">
                  <div className="rounded-lg bg-gray-50 p-4"><p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Test Rate · incl. VAT</p><p className="mt-1 text-2xl font-semibold">{currency(simulation.testGroupRateInclVat)}</p></div>
                  <div className={`rounded-lg p-4 ${Math.abs(simulation.rateAboveFloor) <= 0.01 ? "bg-amber-50 text-amber-900" : simulation.rateAboveFloor > 0 ? "bg-green-50 text-green-800" : "bg-red-50 text-red-800"}`}><p className="text-xs font-semibold uppercase tracking-wide">{Math.abs(simulation.rateAboveFloor) <= 0.01 ? "At Floor" : simulation.rateAboveFloor > 0 ? "Above Floor" : "Below Floor"}</p><p className="mt-1 text-2xl font-semibold">{simulation.rateAboveFloor > 0 ? "+" : ""}{currency(simulation.rateAboveFloor)}</p><p className="text-sm font-semibold">{simulation.rateAboveFloorPercentage !== null && simulation.rateAboveFloorPercentage > 0 ? "+" : ""}{percentage(simulation.rateAboveFloorPercentage)}</p></div>
                  <div className={`rounded-lg p-4 sm:col-span-2 ${simulation.netIncrementalContribution >= 0 ? "bg-green-50 text-green-800" : "bg-red-50 text-red-800"}`}><p className="text-xs font-semibold uppercase tracking-wide">Expected Net Incremental Contribution</p><p className="mt-1 text-2xl font-semibold">{simulation.netIncrementalContribution > 0 ? "+" : ""}{currency(simulation.netIncrementalContribution)}</p><p className="mt-1 text-sm font-semibold">Status: {Math.abs(simulation.rateAboveFloor) <= 0.01 ? "Economically neutral" : simulation.rateAboveFloor > 0 ? "Economically acceptable" : "Below economic floor"}</p></div>
                </div>}
              </div>
              <div className="rounded-xl border border-gray-200 p-5"><h3 className="text-lg font-semibold">Quote Simulator</h3><p className="mt-1 text-sm text-gray-600">Simulation only: this value is not saved as the quote rate.</p><label className="mt-4 block text-sm font-semibold">Test Average Group Rate (incl. VAT)<input min="0" step="0.01" type="number" value={testGroupRate} onChange={(event) => setTestGroupRate(event.target.value)} className="mt-2 w-full rounded-lg border border-gray-300 px-3 py-2 font-normal" /></label><p className="mt-1 text-xs text-gray-500">Enter the commercial rate quoted to the client, including VAT.</p>{simulation && <dl className="mt-4 grid gap-x-4 gap-y-3 sm:grid-cols-2">{[["Net Room Revenue (excl. VAT)", currency(simulation.testGroupRoomRevenueExVat)], ["Commission Cost (excl. VAT)", currency(simulation.testGroupCommissionCost)], ["Net Group Contribution", currency(simulation.testGroupContribution)], ["Total Lost Contribution", currency(simulation.totalLostContribution)], ["Net Incremental Contribution", currency(simulation.netIncrementalContribution)], ["Rate Above / Below Floor (incl. VAT)", `${simulation.rateAboveFloor > 0 ? "+" : ""}${currency(simulation.rateAboveFloor)}${simulation.rateAboveFloorPercentage === null ? "" : ` (${simulation.rateAboveFloorPercentage > 0 ? "+" : ""}${percentage(simulation.rateAboveFloorPercentage)})`}`]].map(([label, value]) => <div key={label} className="border-t border-gray-100 pt-3"><dt className="text-xs font-semibold uppercase tracking-wide text-gray-500">{label}</dt><dd className="mt-1 font-semibold">{value}</dd></div>)}</dl>}</div>
            </div>
            {contribution.warningDetails.length > 0 && <div className="mx-6 mb-6 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"><strong>Warnings:</strong><ul className="ml-5 list-disc">{contribution.warningDetails.map((warning) => <li key={warning.code}>{warning.message}{warning.stayDates.length > 1 && <span className="ml-1 text-xs">(Applies to {warning.stayDates.length} stay dates)</span>}</li>)}</ul></div>}
          </Card>

          <div><h3 className="text-lg font-semibold">Group Impact</h3><p className="text-sm text-gray-600">Room-night impact across all requested stay dates.</p><dl className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{[["Requested room nights", rooms(contribution.totalRequestedGroupRoomNights)], ["Total displaced room nights", rooms(contribution.totalDisplacedRooms)], ["Incremental / non-displacing room nights", rooms(contribution.totalNonDisplacingGroupRooms)], ["Displacement ratio", contribution.totalRequestedGroupRoomNights === 0 ? "—" : percentage(contribution.totalDisplacedRooms / contribution.totalRequestedGroupRoomNights)]].map(([label, value]) => <Card key={label} className="border border-gray-200 p-4 shadow-sm"><dt className="text-xs font-semibold uppercase tracking-wide text-gray-500">{label}</dt><dd className="mt-2 text-2xl font-semibold">{value}</dd></Card>)}</dl><p className="mt-3 text-sm text-gray-600">Base breakdown: <strong>{rooms(contribution.scenarioTotals.base.displacedFutureTransientRooms)}</strong> future transient + <strong>{rooms(contribution.scenarioTotals.base.displacedFutureGroupRooms)}</strong> future group displaced.</p></div>

          <Card className="border border-gray-200 bg-white p-0 shadow-sm"><div className="px-6 py-5"><p className="text-xs font-semibold uppercase tracking-widest text-gray-500">Demand & Capacity</p><h3 className="mt-1 text-lg font-semibold">Combined demand position</h3></div><div className="overflow-x-auto border-t"><table className="min-w-[760px] w-full text-sm"><thead className="bg-gray-50 text-left text-xs uppercase text-gray-500"><tr>{["Date", "Sellable Inventory", "Transient", "Group", "Total Demand", "Capacity Position"].map((heading) => <th key={heading} className="px-4 py-3">{heading}</th>)}</tr></thead><tbody className="divide-y">{Object.entries(forecastData?.byDate || {}).map(([stayDate, transient]) => { const position = calculateDemandCapacitySummary(transient, groupForecastData?.byDate?.[stayDate]); return <tr key={stayDate}><td className="px-4 py-3 font-medium">{stayDate}</td><td className="px-4 py-3">{rooms(position.sellableInventory)}</td><td className="px-4 py-3">{rooms(position.finalTransientDemandForecast)}</td><td className="px-4 py-3">{rooms(position.expectedFinalGroupDemand)}</td><td className="px-4 py-3 font-semibold">{rooms(position.expectedTotalDemand)}</td><td className={`px-4 py-3 font-semibold ${position.expectedSlack < 0 ? "text-red-700" : "text-green-700"}`}>{position.expectedSlack >= 0 ? "+" : ""}{rooms(position.expectedSlack)} rooms{position.expectedSlack < 0 ? " / Compression" : ""}</td></tr>; })}</tbody></table></div></Card>

          <Card className="border border-gray-200 bg-white p-0 shadow-sm"><div className="px-6 py-5"><p className="text-xs font-semibold uppercase tracking-widest text-gray-500">Nightly Analysis</p><h3 className="mt-1 text-lg font-semibold">Stay-date impact</h3></div><div className="overflow-x-auto border-t border-gray-200"><table className="min-w-[1320px] w-full text-sm"><thead className="bg-gray-50 text-left text-xs uppercase text-gray-500"><tr>{["Date", "Requested Group RN", "Transient Forecast", "Final Group Forecast", "Future Group Potential", "Total Displaced RN", "Displaced Transient RN", "Displaced Future Group RN", "Incremental RN", "Lost Contribution", "Confidence"].map((heading) => <th key={heading} className="whitespace-nowrap px-4 py-3">{heading}</th>)}</tr></thead><tbody className="divide-y divide-gray-100">{contribution.nightly.map((night) => { const group = groupForecastData?.byDate?.[night.stayDate] || {}; const base = night.scenarios.base; return <tr key={night.stayDate}><td className="whitespace-nowrap px-4 py-3 font-medium">{night.stayDate}</td><td className="px-4 py-3">{rooms(night.requestedGroupRooms)}</td><td className="px-4 py-3">{rooms(night.finalTransientDemandForecast)}</td><td className="px-4 py-3">{rooms(group.forecastBase)}</td><td className="px-4 py-3">{rooms(night.futureGroupDemandBase)}</td><td className="px-4 py-3">{rooms(base.totalDisplacedFutureRooms)}</td><td className="px-4 py-3">{rooms(base.displacedFutureTransientRooms)}</td><td className="px-4 py-3">{rooms(base.displacedFutureGroupRooms)}</td><td className="px-4 py-3">{rooms(base.nonDisplacingGroupRooms)}</td><td className="px-4 py-3">{base.totalLostContribution === null ? "—" : currency(base.totalLostContribution)}</td><td className="px-4 py-3">{group.confidence || "—"}</td></tr>; })}</tbody></table></div></Card>
        </>}

        <Card className="border border-gray-200 bg-white shadow-sm">
          <div className="mb-4 flex flex-wrap items-end justify-between gap-2"><div><h3 className="text-lg font-semibold">Transient-demand forecast</h3><p className="text-sm text-gray-600">PMS snapshot {forecastData?.currentSnapshotDate || "unavailable"} · Lighthouse snapshot {forecastData?.lighthouseSnapshotDate || "unavailable"}</p></div>{forecastLoading && <span className="text-sm text-gray-500">Loading forecast…</span>}</div>
          <div className="space-y-3">{Object.values(forecastData?.byDate || {}).map((result) => <details key={result.stayDate} className={`rounded-lg border ${result.forecastConfidence === "low" ? "border-amber-300 bg-amber-50" : "border-gray-200"}`}>
            <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-3 p-4"><span className="font-semibold">{result.stayDate}</span><span className="flex flex-wrap items-center gap-3"><span className="text-sm font-medium text-gray-700">{rooms(result.transientDemandForecast)} transient forecast</span><span className={`rounded-full px-2.5 py-1 text-xs font-bold uppercase ${result.forecastConfidence === "high" ? "bg-green-100 text-green-800" : result.forecastConfidence === "medium" ? "bg-blue-100 text-blue-800" : "bg-amber-200 text-amber-900"}`}>{result.forecastConfidence} confidence</span><span className="text-xs font-semibold uppercase text-gray-500">View details</span></span></summary>
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
              <div><dt className="text-gray-500">Sellable inventory</dt><dd className="font-medium">{rooms(result.sellableInventory)} rooms</dd></div>
            </dl>
            {result.warnings.length > 0 && <div className="mt-3 rounded border border-amber-300 bg-white/70 p-2 text-sm text-amber-900"><strong>Warnings:</strong><ul className="ml-5 list-disc">{result.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></div>}
            </div>
          </details>)}</div>
        </Card>
        <Card className="border border-gray-200 bg-white shadow-sm">
          <div className="mb-4"><p className="text-xs font-semibold uppercase tracking-widest text-gray-500">Group Demand Forecast</p><h3 className="mt-1 text-lg font-semibold">Expected final group demand</h3><p className="mt-1 text-sm text-gray-600">Group Forecast V1 estimates expected final realized group demand from historical comparable dates. Historical booking pace and inquiry pipeline are not yet included.</p></div>
          <div className="space-y-3">{Object.values(groupForecastData?.byDate || {}).map((result) => <details key={result.stayDate} className={`rounded-lg border ${result.confidence === "LOW" ? "border-amber-300 bg-amber-50" : "border-gray-200"}`}>
            <summary className="grid cursor-pointer list-none gap-3 p-4 sm:grid-cols-[1fr_repeat(4,auto)] sm:items-center"><strong>{result.stayDate}</strong><span className="text-sm">Current Group OTB <strong>{rooms(result.currentGroupOtb)}</strong></span><span className="text-sm">Expected Final Group Demand <strong>{rooms(result.forecastBase)}</strong></span><span className="text-sm">Implied Remaining Group Potential <strong>+{rooms(result.remainingPotentialBase)}</strong></span><span className="text-xs font-bold">{result.confidence} · View details</span></summary>
            <div className="space-y-4 border-t border-inherit p-4"><dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
              {[['Current Group OTB', rooms(result.currentGroupOtb)], ['Current sellable inventory', rooms(result.currentSellableInventory)], ['Selected historical years used', result.selectedHistoricalYears?.join(', ') || 'None'], ['Historical P25 / P50 / P75', `${rooms(result.historicalP25GroupRooms)} / ${rooms(result.historicalP50GroupRooms)} / ${rooms(result.historicalP75GroupRooms)}`], ['Low / Base / High forecast', `${rooms(result.forecastLow)} / ${rooms(result.forecastBase)} / ${rooms(result.forecastHigh)}`], ['Implied remaining potential', `${rooms(result.remainingPotentialLow)} / ${rooms(result.remainingPotentialBase)} / ${rooms(result.remainingPotentialHigh)}`], ['Comparable tier', result.comparableTier || 'Unavailable'], ['Historical sample size', result.sampleSize], ['Calendar context', result.targetCalendarFeatures.calendarRegime.join(', ')], ['Forecast method', 'Historical Final Group Demand'], ['Pace adjustment', 'Not available yet']].map(([label, value]) => <div key={label}><dt className="text-gray-500">{label}</dt><dd className="font-medium">{value}</dd></div>)}
            </dl><div className="overflow-x-auto"><table className="min-w-full text-xs"><thead><tr className="border-b text-left text-gray-500">{['Historical Date', 'DOW', 'Calendar Context', 'Final Group Rooms', 'Sellable Inventory', 'Final Group Share', 'Normalized Group Rooms'].map((heading) => <th key={heading} className="p-2">{heading}</th>)}</tr></thead><tbody>{result.comparables.map((item) => <tr key={item.stayDate} className="border-b"><td className="p-2">{item.stayDate}</td><td className="p-2">{item.dayOfWeek}</td><td className="p-2">{item.calendarContext}</td><td className="p-2">{rooms(item.finalGroupRooms)}</td><td className="p-2">{rooms(item.sellableInventory)}</td><td className="p-2">{percentage(item.groupShare)}</td><td className="p-2">{item.normalizedGroupRooms.toFixed(1)}</td></tr>)}</tbody></table></div>
            {result.warnings.length > 0 && <div className="rounded border border-amber-300 bg-white/70 p-2 text-sm text-amber-900"><strong>Warnings:</strong><ul className="ml-5 list-disc">{result.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></div>}
            </div>
          </details>)}</div>
        </Card>
        {contribution && !contribution.validationError && <details className="rounded-lg border border-gray-200 bg-white shadow-sm"><summary className="cursor-pointer p-4 text-lg font-semibold">How is the Economic Floor calculated?</summary><div className="grid gap-5 border-t p-5 md:grid-cols-2 xl:grid-cols-4">
          <section><p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Stage 1 · Opportunity Cost</p><p className="mt-1 text-xs text-gray-500">Contribution expected to be lost from business displaced by accepting the new group.</p><dl className="mt-4 space-y-2 text-sm">{[["Lost future transient contribution", contribution.totalLostFutureTransientContribution], ["Lost future group contribution", contribution.totalLostFutureGroupContribution]].map(([label, value]) => <div key={label} className="flex justify-between gap-4"><dt>{label}</dt><dd>{value === null ? "Unavailable" : currency(value)}</dd></div>)}<div className="flex justify-between gap-4 border-t pt-2 font-semibold"><dt>Total opportunity cost</dt><dd>{contribution.totalLostContribution === null ? "Unavailable" : currency(contribution.totalLostContribution)}</dd></div></dl></section>
          <section><p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Stage 2 · Required Room Revenue</p><dl className="mt-4 space-y-2 text-sm">{[["Total opportunity cost", contribution.totalLostContribution, ""], ["Group variable room costs", contribution.groupVariableRoomCosts, "+"], ["Group breakfast costs", contribution.groupBreakfastCosts, "+"], ["BQT contribution", contribution.bqtContribution, "−"]].map(([label, value, sign]) => <div key={label} className="flex justify-between gap-4"><dt>{sign} {label}</dt><dd>{value === null ? "Unavailable" : currency(value)}</dd></div>)}<div className="flex justify-between gap-4 border-t pt-2 font-semibold"><dt>Required revenue after costs</dt><dd>{contribution.requiredRoomRevenueAfterCostsExVat === null ? "Unavailable" : currency(contribution.requiredRoomRevenueAfterCostsExVat)}</dd></div></dl></section>
          <section><p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Stage 3 · Commission</p><dl className="mt-4 space-y-2 text-sm"><div className="flex justify-between gap-4"><dt>Required revenue after costs</dt><dd>{contribution.requiredRoomRevenueAfterCostsExVat === null ? "Unavailable" : currency(contribution.requiredRoomRevenueAfterCostsExVat)}</dd></div><div className="flex justify-between gap-4"><dt>Group commission</dt><dd>{percentage(contribution.groupCommission)}</dd></div><div className="flex justify-between gap-4 border-t pt-2 font-semibold"><dt>Required commissionable room revenue excl. VAT</dt><dd>{contribution.requiredCommissionableRoomRevenueExVat === null ? "Unavailable" : currency(contribution.requiredCommissionableRoomRevenueExVat)}</dd></div></dl></section>
          <section><p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Stage 4 · VAT / Commercial Floor</p><dl className="mt-4 space-y-2 text-sm"><div className="flex justify-between gap-4"><dt>Requested room nights</dt><dd>{rooms(contribution.totalRequestedGroupRoomNights)}</dd></div><div className="flex justify-between gap-4"><dt>Economic Floor excl. VAT</dt><dd>{contribution.economicFloorRateExVat === null ? "Unavailable" : currency(contribution.economicFloorRateExVat)}</dd></div><div className="flex justify-between gap-4"><dt>Room VAT</dt><dd>{Number(contribution.roomVatPercentage).toFixed(1)}%</dd></div><div className="flex justify-between gap-4 border-t pt-2 font-semibold"><dt>Economic Floor incl. VAT</dt><dd>{contribution.economicFloorRateInclVat === null ? "Unavailable" : currency(contribution.economicFloorRateInclVat)}</dd></div></dl></section>
        </div></details>}
        <div className="flex justify-end"><button type="button" disabled={saving || forecastLoading || !forecastData} onClick={handleSave} className="rounded-lg bg-[#b41f1f] px-5 py-2 font-semibold text-white disabled:bg-gray-400">{saving ? "Saving quote..." : "Save Quote"}</button></div>
      </section>}
    </PageContainer>
  </div>;
}
