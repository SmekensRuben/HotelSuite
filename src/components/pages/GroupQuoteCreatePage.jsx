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
            lighthouseByDate: lighthouse.byDate,
            maxHistoricalGroupShare: Number.isFinite(maxShare) ? maxShare / 100 : 1,
            config: DISPLACEMENT_FORECAST_CONFIG,
          })
        ]));
        setForecastData({ byDate, currentSnapshotDate: current.snapshotDate, lighthouseSnapshotDate: lighthouse.snapshotDate });
      })
      .finally(() => { if (active) setForecastLoading(false); });
    return () => { active = false; };
  }, [hotelUid, analysisQuote, consideredDates, quoteSettings.maxHistoricalGroupSharePercentage]);

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
    breakfastIncluded: analysisQuote?.breakfastIncluded,
  }), [analysis, analysisQuote, quoteSettings]);

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
        <GroupQuoteFormFields onSubmit={setAnalysisQuote} saving={false} submitLabel="Start Analysis">
          <fieldset><legend className="mb-2 text-sm font-semibold">Historical years</legend><HistoricalYearsDropdown years={availableYears} selectedYears={selectedYears} onToggle={toggleYear} /></fieldset>
        </GroupQuoteFormFields>
      </Card>

      {analysisQuote && <section className="space-y-4">
        <div><h2 className="text-2xl font-semibold">Analysis overview</h2><p className="text-sm text-gray-600">Comparable available dates with the same day of week for each selected year.</p></div>
        <Card className="border border-gray-200 bg-white shadow-sm">
          <div className="mb-4 flex flex-wrap items-end justify-between gap-2"><div><h3 className="text-lg font-semibold">Transient-demand forecast</h3><p className="text-sm text-gray-600">PMS snapshot {forecastData?.currentSnapshotDate || "unavailable"} · Lighthouse snapshot {forecastData?.lighthouseSnapshotDate || "unavailable"}</p></div>{forecastLoading && <span className="text-sm text-gray-500">Loading forecast…</span>}</div>
          <div className="space-y-4">{Object.values(forecastData?.byDate || {}).map((result) => <div key={result.stayDate} className={`rounded-lg border p-4 ${result.forecastConfidence === "low" ? "border-amber-300 bg-amber-50" : "border-gray-200"}`}>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h4 className="font-semibold">{result.stayDate}</h4><span className={`rounded-full px-2.5 py-1 text-xs font-bold uppercase ${result.forecastConfidence === "high" ? "bg-green-100 text-green-800" : result.forecastConfidence === "medium" ? "bg-blue-100 text-blue-800" : "bg-amber-200 text-amber-900"}`}>{result.forecastConfidence} confidence</span></div>
            <dl className="grid gap-x-5 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
              <div><dt className="text-gray-500">Historical selection tier</dt><dd className="font-medium">{result.historicalSelectionTier}</dd></div>
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
          </div>)}</div>
        </Card>
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

        {analysis.length > 0 && <Card className="p-0 overflow-hidden">
          <div className="border-b border-gray-200 px-4 py-3"><h3 className="text-base font-semibold">Analysis Summary</h3></div>
          <div className="overflow-x-auto"><table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500"><tr><th className="px-4 py-2">Year</th><th className="px-4 py-2">Total Displacement</th></tr></thead>
            <tbody className="divide-y divide-gray-100">{analysisSummary.displacementByYear.map((item) => <tr key={item.year}><td className="px-4 py-2 font-medium">{item.year}</td><td className="px-4 py-2">{currency(item.totalDisplacement)}</td></tr>)}</tbody>
            <tfoot className="border-t-2 border-gray-200 bg-gray-50 font-semibold"><tr><td className="px-4 py-2">Average displacement</td><td className="px-4 py-2">{currency(analysisSummary.averageDisplacement)}</td></tr><tr className="text-green-800"><td className="px-4 py-2">Profitable from</td><td className="px-4 py-2">{currency(analysisSummary.profitablePrice)} per room</td></tr></tfoot>
          </table></div>
        </Card>}
        <div className="flex justify-end"><button type="button" disabled={saving || forecastLoading || !forecastData} onClick={handleSave} className="rounded-lg bg-[#b41f1f] px-5 py-2 font-semibold text-white disabled:bg-gray-400">{saving ? "Saving quote..." : "Save Quote"}</button></div>
      </section>}
    </PageContainer>
  </div>;
}
