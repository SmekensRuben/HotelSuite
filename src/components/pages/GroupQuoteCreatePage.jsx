import React, { useEffect, useMemo, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { useNavigate } from "react-router-dom";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import GroupQuoteFormFields from "./GroupQuoteFormFields";
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
  const [analysisQuote, setAnalysisQuote] = useState(null);
  const [saving, setSaving] = useState(false);
  const today = useMemo(() => new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }), []);
  const handleLogout = async () => { await signOut(auth); sessionStorage.clear(); window.location.href = "/login"; };
  const availableYears = useMemo(() => [...new Set(consideredDates.map((date) => Number(date.slice(0, 4))))].sort((a, b) => b - a), [consideredDates]);

  useEffect(() => {
    if (!hotelUid) return;
    getHistoryQuoteDates(hotelUid).then((dates) => {
      setConsideredDates(dates);
      setSelectedYears([...new Set(dates.map((date) => Number(date.slice(0, 4))))].sort((a, b) => b - a));
    });
  }, [hotelUid]);

  const analysis = useMemo(() => analysisQuote ? buildHistoricalDateAnalysis(
    getInclusiveQuoteDates(analysisQuote.startDate, analysisQuote.endDate), consideredDates, selectedYears
  ) : [], [analysisQuote, consideredDates, selectedYears]);

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
      <fieldset><legend className="mb-2 text-sm font-semibold">Historical years</legend>{availableYears.length ? <div className="flex flex-wrap gap-3">{availableYears.map((year) => <label key={year} className="flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-sm"><input type="checkbox" checked={selectedYears.includes(year)} onChange={() => toggleYear(year)} className="accent-[#b41f1f]" />{year}</label>)}</div> : <p className="text-sm text-gray-500">No historical quote years are available.</p>}</fieldset>
    </GroupQuoteFormFields></Card>
    {analysisQuote && <section className="space-y-4"><div><h2 className="text-2xl font-semibold">Analysis overview</h2><p className="text-sm text-gray-600">Comparable available dates with the same day of week for each selected year.</p></div>{analysis.length ? analysis.map(({ year, matches }) => <Card key={year}><h3 className="mb-3 text-lg font-semibold">{year}</h3><div className="divide-y divide-gray-200">{matches.map((match) => <div key={match.quoteDate} className="grid grid-cols-2 gap-4 py-2 text-sm"><span>{match.quoteDate}</span><span className="font-semibold">{match.historicalDate || "No matching date available"}</span></div>)}</div></Card>) : <Card><p className="text-gray-600">Select at least one historical year to view the analysis.</p></Card>}<div className="flex justify-end"><button type="button" disabled={saving} onClick={handleSave} className="rounded-lg bg-[#b41f1f] px-5 py-2 font-semibold text-white disabled:bg-gray-400">{saving ? "Saving quote..." : "Save Quote"}</button></div></section>}
  </PageContainer></div>;
}
