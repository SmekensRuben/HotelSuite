import React, { useEffect, useMemo, useState } from "react";
import { ArrowLeft, ChevronLeft, ChevronRight } from "lucide-react";
import { useNavigate } from "react-router-dom";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import GroupQuoteFormFields from "./GroupQuoteFormFields";
import HistoricalYearsDropdown from "./HistoricalYearsDropdown";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { addQuote, getHistoryQuoteDates } from "../../services/firebaseQuotes";
import { buildHistoricalDateAnalysis } from "../../utils/quoteAnalysis";
import { getInclusiveQuoteDates } from "../../utils/quoteDates";

export default function GroupQuoteCreatePage() {
  const navigate = useNavigate();
  const { hotelUid } = useHotelContext();
  const [consideredDates, setConsideredDates] = useState([]);
  const [selectedYears, setSelectedYears] = useState([]);
  const [weekOffsets, setWeekOffsets] = useState({});
  const [analysisQuote, setAnalysisQuote] = useState(null);
  const [saving, setSaving] = useState(false);
  const today = useMemo(() => new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }), []);
  const handleLogout = async () => { await signOut(auth); sessionStorage.clear(); window.location.href = "/login"; };
  const availableYears = useMemo(() => [...new Set(consideredDates.map((item) => Number(item.date.slice(0, 4))))].sort((a, b) => b - a), [consideredDates]);

  useEffect(() => {
    if (!hotelUid) return;
    getHistoryQuoteDates(hotelUid).then((dates) => {
      setConsideredDates(dates);
      setSelectedYears([...new Set(dates.map((item) => Number(item.date.slice(0, 4))))].sort((a, b) => b - a));
    });
  }, [hotelUid]);

  const analysis = useMemo(() => analysisQuote ? buildHistoricalDateAnalysis(
    getInclusiveQuoteDates(analysisQuote.startDate, analysisQuote.endDate), consideredDates, selectedYears, weekOffsets
  ) : [], [analysisQuote, consideredDates, selectedYears, weekOffsets]);

  const toggleYear = (year) => setSelectedYears((current) => current.includes(year) ? current.filter((item) => item !== year) : [...current, year].sort((a, b) => b - a));
  const handleSave = async () => {
    setSaving(true);
    try {
      const quoteId = await addQuote(hotelUid, { ...analysisQuote, analysisYears: selectedYears });
      navigate(`/revenue/group-quotes/${quoteId}`);
    } finally { setSaving(false); }
  };

  return <div className="min-h-screen bg-gray-50 text-gray-900"><HeaderBar today={today} onLogout={handleLogout} /><PageContainer className="space-y-6 pb-10">
    <div className="flex flex-wrap items-center justify-between gap-4"><div><p className="text-sm uppercase tracking-wide text-gray-500">Revenue / Group Quotes</p><h1 className="text-3xl font-semibold">Create Quote</h1></div><button type="button" onClick={() => navigate("/revenue/group-quotes")} className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-semibold hover:bg-gray-100"><ArrowLeft className="h-4 w-4" /> Back to overview</button></div>
    <Card className="border border-gray-200 bg-white shadow-sm"><GroupQuoteFormFields onSubmit={setAnalysisQuote} saving={false} submitLabel="Start Analysis">
      <fieldset><legend className="mb-2 text-sm font-semibold">Historical years</legend><HistoricalYearsDropdown years={availableYears} selectedYears={selectedYears} onToggle={toggleYear} /></fieldset>
    </GroupQuoteFormFields></Card>
    {analysisQuote && <section className="space-y-4"><div><h2 className="text-2xl font-semibold">Analysis overview</h2><p className="text-sm text-gray-600">Comparable available dates with the same day of week for each selected year.</p></div>{analysis.length ? analysis.map(({ year, matches }) => <Card key={year}><div className="mb-3 flex flex-wrap items-center justify-between gap-3"><h3 className="text-lg font-semibold">{year}</h3><div className="flex items-center gap-2"><button type="button" onClick={() => setWeekOffsets((current) => ({ ...current, [year]: Number(current[year] || 0) - 1 }))} className="rounded border border-gray-300 p-1.5 hover:bg-gray-100" aria-label={`Move ${year} one week back`}><ChevronLeft className="h-4 w-4" /></button><span className="min-w-24 text-center text-xs font-medium text-gray-600">{weekOffsets[year] ? `${weekOffsets[year] > 0 ? "+" : ""}${weekOffsets[year]} week${Math.abs(weekOffsets[year]) === 1 ? "" : "s"}` : "Same week"}</span><button type="button" onClick={() => setWeekOffsets((current) => ({ ...current, [year]: Number(current[year] || 0) + 1 }))} className="rounded border border-gray-300 p-1.5 hover:bg-gray-100" aria-label={`Move ${year} one week forward`}><ChevronRight className="h-4 w-4" /></button></div></div><div className="overflow-x-auto"><table className="min-w-full text-sm"><thead className="border-b text-left text-xs uppercase text-gray-500"><tr><th className="py-2 pr-4">Day</th><th className="px-4 py-2">Considered Date</th><th className="px-4 py-2">Inventory Rooms</th><th className="px-4 py-2">Occupied Rooms</th><th className="py-2 pl-4">Average Room Rate</th></tr></thead><tbody className="divide-y divide-gray-200">{matches.map((match) => <tr key={match.quoteDate}><td className="py-2 pr-4 font-semibold">{match.weekday}</td><td className="px-4 py-2">{match.consideredDate?.date || match.historicalDate || "-"}</td><td className="px-4 py-2">{Number(match.consideredDate?.calculatedInventoryRooms || 0)}</td><td className="px-4 py-2">{Number(match.consideredDate?.calculatedOccRooms || 0)}</td><td className="py-2 pl-4">€{Number(match.consideredDate?.averageRoomRate || 0).toFixed(2)}</td></tr>)}</tbody></table></div></Card>) : <Card><p className="text-gray-600">Select at least one historical year to view the analysis.</p></Card>}<div className="flex justify-end"><button type="button" disabled={saving} onClick={handleSave} className="rounded-lg bg-[#b41f1f] px-5 py-2 font-semibold text-white disabled:bg-gray-400">{saving ? "Saving quote..." : "Save Quote"}</button></div></section>}
  </PageContainer></div>;
}
