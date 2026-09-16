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
import { addQuote, getCompsetConfiguration, getGroupQuoteSettings, getHistoryQuoteDates, getLatestHistoryForecastSnapshot, getLatestLighthouseSnapshot, GROUP_QUOTE_ANALYSIS_MODEL_VERSION, MARKET_CONTEXT_MODEL_VERSION } from "../../services/firebaseQuotes";
import { getQuoteStayDates } from "../../utils/quoteDates";
import { calculateDisplacementDay, DISPLACEMENT_FORECAST_CONFIG, prepareDisplacementForecastData } from "../../utils/displacementForecast";
import { calculateGroupContribution, simulateGroupQuote } from "../../utils/contributionAnalysis";
import { getDemandCalendarEvents } from "../../services/firebaseDemandCalendar";
import { calculateGroupDemandForecast, prepareGroupForecastData } from "../../utils/groupDemandForecast";
import { buildMarketContextSnapshot } from "../../utils/marketPricingContext";
import GroupQuoteAnalysisView from "./GroupQuoteAnalysisView";
import { calculatePricingGuidance, PRICING_GUIDANCE_MODEL_VERSION } from "../../utils/pricingGuidance";
import QuoteInputSummary from "./QuoteInputSummary";
import { deriveExplicitQuoteMealBasis } from "../../constants/groupMealBasis";
import { sourceStatusForDate } from "../../utils/hotelStayDates";
import { calculatePhysicalFeasibility, PHYSICAL_FEASIBILITY_VERSION } from "../../utils/physicalCapacity";

export default function GroupQuoteCreatePage() {
  const navigate = useNavigate();
  const { hotelUid } = useHotelContext();
  const [consideredDates, setConsideredDates] = useState([]);
  const [selectedYears, setSelectedYears] = useState([]);
  const [quoteSettings, setQuoteSettings] = useState({});
  const [compsetConfiguration, setCompsetConfiguration] = useState({ settings: {}, competitors: [] });
  const [analysisQuote, setAnalysisQuote] = useState(null);
  const [saving, setSaving] = useState(false);
  const [forecastData, setForecastData] = useState(null);
  const [groupForecastData, setGroupForecastData] = useState(null);
  const [forecastLoading, setForecastLoading] = useState(false);
  const [sourceData, setSourceData] = useState(null);
  const [yearsCustomized, setYearsCustomized] = useState(false);
  const [testGroupRate, setTestGroupRate] = useState("");
  const [showInputForm, setShowInputForm] = useState(true);
  const today = useMemo(() => new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }), []);
  const handleLogout = async () => { await signOut(auth); sessionStorage.clear(); window.location.href = "/login"; };
  const availableYears = useMemo(() => [...new Set(consideredDates.map((item) => Number(item.date.slice(0, 4))))].sort((a, b) => b - a), [consideredDates]);

  useEffect(() => {
    if (!hotelUid) return;
    Promise.all([getHistoryQuoteDates(hotelUid), getGroupQuoteSettings(hotelUid), getCompsetConfiguration(hotelUid)]).then(([dates, settings, compset]) => {
      setConsideredDates(dates);
      setQuoteSettings(settings);
      setCompsetConfiguration(compset);
      setSelectedYears([]);
    });
  }, [hotelUid]);

  useEffect(() => {
    if (!hotelUid || !analysisQuote) return;
    let active = true;
    setSourceData(null);
    setForecastLoading(true);
    Promise.all([getLatestHistoryForecastSnapshot(hotelUid), getLatestLighthouseSnapshot(hotelUid), getDemandCalendarEvents(hotelUid)])
      .then(([current, lighthouse, events]) => {
        if (!active) return;
        setSourceData({ current, lighthouse, events });
      })
      .finally(() => { if (active) setForecastLoading(false); });
    return () => { active = false; };
  }, [hotelUid, analysisQuote]);

  useEffect(() => {
    if (!analysisQuote || !sourceData) return;
    const stayDates = getQuoteStayDates(analysisQuote);
    const preparedTransient = prepareDisplacementForecastData({ historicalRows: consideredDates, lighthouseByDate: sourceData.lighthouse.byDate });
    const preparedGroup = prepareGroupForecastData({ historicalRows: consideredDates, events: sourceData.events, targetDates: stayDates });
    const maxShare = Number(quoteSettings.maxHistoricalGroupSharePercentage);
    const byDate = Object.fromEntries(stayDates.map((stayDate) => {
      const pmsRow = sourceData.current.byDate[stayDate];
      const pmsDataStatus = sourceStatusForDate(stayDate, sourceData.current.coverage, pmsRow, (row) => row && Number.isFinite(Number(row.calculatedInventoryRooms)) && Number.isFinite(Number(row.individualRooms)) && Number.isFinite(Number(row.groupRooms)));
      if (pmsDataStatus !== "AVAILABLE") return [stayDate, { stayDate, pmsDataStatus }];
      return [stayDate, { ...calculateDisplacementDay({
            stayDate,
            requestedGroupRooms: analysisQuote.roomsByDate.find((item) => item.date === stayDate)?.rooms,
            currentOtb: pmsRow,
            preparedData: preparedTransient,
            selectedHistoricalYears: selectedYears,
            maxHistoricalGroupShare: Number.isFinite(maxShare) ? maxShare / 100 : 1,
            inflationPercentage: quoteSettings.inflationPercentage,
            config: DISPLACEMENT_FORECAST_CONFIG,
          }), pmsDataStatus }];
    }));
    setForecastData({ byDate, pmsCoverage: sourceData.current.coverage, currentSnapshotDate: sourceData.current.snapshotDate, lighthouseSnapshotDate: sourceData.lighthouse.snapshotDate });
    const groupByDate = Object.fromEntries(stayDates.map((stayDate) => [stayDate, byDate[stayDate].pmsDataStatus === "AVAILABLE" ? calculateGroupDemandForecast({ stayDate, currentOtb: sourceData.current.byDate[stayDate], preparedData: preparedGroup, selectedHistoricalYears: selectedYears }) : { stayDate, pmsDataStatus: byDate[stayDate].pmsDataStatus }]));
    setGroupForecastData({ byDate: groupByDate });
  }, [analysisQuote, sourceData, consideredDates, selectedYears, quoteSettings.maxHistoricalGroupSharePercentage, quoteSettings.inflationPercentage]);

  const combinedForecastByDate = useMemo(() => forecastData && groupForecastData ? Object.fromEntries(Object.entries(forecastData.byDate).map(([stayDate, forecast]) => [stayDate, { ...forecast, groupForecast: groupForecastData.byDate[stayDate] }])) : null, [forecastData, groupForecastData]);
  const physicalFeasibility = useMemo(() => {
    if (!analysisQuote || !combinedForecastByDate || Object.values(forecastData.byDate).some((date) => date.pmsDataStatus !== "AVAILABLE")) return null;
    return calculatePhysicalFeasibility({ roomsByDate: analysisQuote.roomsByDate, forecastByDate: combinedForecastByDate });
  }, [analysisQuote, combinedForecastByDate, forecastData]);
  const contribution = useMemo(() => {
    if (!analysisQuote || !forecastData || !groupForecastData) return null;
    if (Object.values(forecastData.byDate).some((date) => date.pmsDataStatus !== "AVAILABLE")) return { validationError: "PMS target-date data is unavailable for one or more stay nights." };
    try {
      const result = calculateGroupContribution({ quote: analysisQuote, forecastByDate: combinedForecastByDate, settings: quoteSettings });
      return physicalFeasibility?.status === "PHYSICAL_CAPACITY_SHORTFALL" ? { ...result, economicFloorUnavailableReason: "ECONOMIC_FLOOR_UNAVAILABLE_PHYSICAL_CAPACITY" } : result;
    } catch (error) { return { validationError: error.message }; }
  }, [analysisQuote, forecastData, groupForecastData, combinedForecastByDate, physicalFeasibility, quoteSettings]);
  const simulation = useMemo(() => contribution && !contribution.validationError ? simulateGroupQuote(contribution, testGroupRate) : null, [contribution, testGroupRate]);
  const marketContextSnapshot = useMemo(() => analysisQuote && sourceData ? buildMarketContextSnapshot({ lighthouseSnapshotDate: sourceData.lighthouse.snapshotDate, lighthouseCoverage: sourceData.lighthouse.coverage, compset: compsetConfiguration.settings, competitors: compsetConfiguration.competitors, lighthouseByDate: sourceData.lighthouse.byDate, roomsByDate: analysisQuote.roomsByDate }) : null, [analysisQuote, sourceData, compsetConfiguration]);
  const pricingGuidanceSnapshot = useMemo(() => contribution && !contribution.validationError && marketContextSnapshot ? { ...calculatePricingGuidance({ economicFloorRateInclVat: contribution.economicFloorRateInclVat, totalDisplacedRoomNights: contribution.totalDisplacedRooms, requestedRoomNights: contribution.totalRequestedGroupRoomNights, marketSummary: marketContextSnapshot.groupStaySummary, roomsByDate: analysisQuote.roomsByDate, breakfastPax: analysisQuote.breakfastPax, strategy: compsetConfiguration.settings.pricingStrategy }), ...(physicalFeasibility?.status === "PHYSICAL_CAPACITY_SHORTFALL" ? { unavailableReason: "REQUESTED_PRODUCT_PHYSICALLY_INFEASIBLE" } : {}) } : null, [contribution, marketContextSnapshot, analysisQuote, compsetConfiguration, physicalFeasibility]);
  const targetSimulation = useMemo(() => contribution && !contribution.validationError && pricingGuidanceSnapshot?.targetRateInclVat != null ? simulateGroupQuote(contribution, pricingGuidanceSnapshot.targetRateInclVat) : null, [contribution, pricingGuidanceSnapshot]);

  const toggleYear = (year) => { setYearsCustomized(true); setSelectedYears((current) => current.includes(year)
    ? current.filter((item) => item !== year)
    : [...current, year].sort((a, b) => b - a)); };

  const startAnalysis = (quote) => {
    if (!yearsCustomized) {
      const targetYear = Number(quote.startDate.slice(0, 4));
      setSelectedYears(availableYears.filter((year) => year < targetYear).slice(0, 5));
    }
    setAnalysisQuote(quote);
    setShowInputForm(false);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const quoteId = await addQuote(hotelUid, {
        ...analysisQuote,
        analysisYears: selectedYears,
        displacementForecast: Object.values(forecastData?.byDate || {}),
        groupDemandForecast: Object.values(groupForecastData?.byDate || {}),
        integratedDisplacement: contribution?.nightly.map((night) => ({
          stayDate: night.stayDate,
          scenario: "BASE",
          totalDisplacedRooms: night.scenarios.base.totalDisplacedFutureRooms,
          displacedFutureTransientRooms: night.scenarios.base.displacedFutureTransientRooms,
          displacedFutureGroupRooms: night.scenarios.base.displacedFutureGroupRooms,
          nonDisplacingGroupRooms: night.scenarios.base.nonDisplacingGroupRooms,
        })) || [],
        commercialStatus: "PENDING",
        quoteInputSnapshot: { version: analysisQuote.quoteInputSchemaVersion, requestDate: analysisQuote.requestDate, arrivalDate: analysisQuote.startDate, checkOutDate: analysisQuote.endDate, dateRangeSemantics: analysisQuote.dateRangeSemantics, groupSegment: analysisQuote.groupSegment || "UNKNOWN", roomsByDate: analysisQuote.roomsByDate.map((night) => ({ date: night.date, rooms: night.rooms, mealBasis: night.mealBasis, breakfastPax: night.breakfastPax, bqtRevenue: night.bqtRevenue })) },
        analysisStatus: "CURRENT",
        analysisModelVersion: GROUP_QUOTE_ANALYSIS_MODEL_VERSION,
        contributionModelVersion: GROUP_QUOTE_ANALYSIS_MODEL_VERSION,
        marketContextModelVersion: MARKET_CONTEXT_MODEL_VERSION,
        pricingGuidanceModelVersion: PRICING_GUIDANCE_MODEL_VERSION,
        physicalFeasibilityVersion: PHYSICAL_FEASIBILITY_VERSION,
        physicalFeasibility,
        marketContextSnapshot,
        pricingGuidanceSnapshot,
        sourceAvailabilitySnapshot: { pmsSnapshotDate: sourceData.current.snapshotDate, pmsMaximumStayDateAvailable: sourceData.current.coverage?.maximumStayDateAvailable || null, pmsStatusByDate: Object.fromEntries(Object.entries(forecastData.byDate).map(([date, value]) => [date, value.pmsDataStatus])), lighthouseSnapshotDate: sourceData.lighthouse.snapshotDate, lighthouseMaximumStayDateAvailable: sourceData.lighthouse.coverage?.maximumStayDateAvailable || null, lighthouseStatusByDate: Object.fromEntries((marketContextSnapshot?.stayDates || []).map((date) => [date.stayDate, date.lighthouseDataStatus])), marketDateCoverage: marketContextSnapshot?.groupStaySummary?.marketDateCoverage ?? null },
        analysisContributionSnapshot: contribution && !contribution.validationError ? { economicFloorRateInclVat: contribution.economicFloorRateInclVat, economicFloorRateExVat: contribution.economicFloorRateExVat, economicFloorUnavailableReason: contribution.economicFloorUnavailableReason || null } : null,
      });
      navigate(`/revenue/group-quotes/${quoteId}`);
    } finally {
      setSaving(false);
    }
  };

  const mealBasis = analysisQuote ? deriveExplicitQuoteMealBasis(analysisQuote.roomsByDate) : "LEGACY_UNKNOWN";

  return <div className="min-h-screen bg-gray-50 text-gray-900">
    <HeaderBar today={today} onLogout={handleLogout} />
    <PageContainer className="space-y-6 pb-10">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div><p className="text-sm uppercase tracking-wide text-gray-500">Revenue / Group Quotes</p><h1 className="text-3xl font-semibold">Create Quote</h1></div>
        <button type="button" onClick={() => navigate("/revenue/group-quotes")} className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-semibold hover:bg-gray-100"><ArrowLeft className="h-4 w-4" /> Back to overview</button>
      </div>

      {analysisQuote && !showInputForm ? <QuoteInputSummary quote={analysisQuote} mealBasis={mealBasis} onEdit={() => setShowInputForm(true)} /> : <Card className="border border-gray-200 bg-white shadow-sm"><GroupQuoteFormFields initialQuote={analysisQuote} defaultGroupCommissionPercentage={quoteSettings.defaultGroupCommissionPercentage} defaultGroupMealBasis={quoteSettings.defaultGroupMealBasis || "RO"} onSubmit={startAnalysis} saving={false} submitLabel={analysisQuote ? "Run Updated Analysis" : "Start Analysis"} /></Card>}

      {showInputForm && <Card className="border border-gray-200 bg-white shadow-sm"><details><summary className="cursor-pointer font-semibold">Advanced / Model Settings</summary><div className="mt-4 border-t border-gray-200 pt-4"><fieldset><legend className="mb-2 text-sm font-semibold">Historical years</legend><HistoricalYearsDropdown years={availableYears} selectedYears={selectedYears} onToggle={toggleYear} /></fieldset></div></details></Card>}

      {analysisQuote && <section className="space-y-6"><GroupQuoteAnalysisView contribution={contribution} physicalFeasibility={physicalFeasibility} forecastData={forecastData} groupForecastData={groupForecastData} marketContextSnapshot={marketContextSnapshot} pricingGuidance={pricingGuidanceSnapshot} quoteSettings={quoteSettings} testGroupRate={testGroupRate} setTestGroupRate={setTestGroupRate} simulation={simulation} targetSimulation={targetSimulation} forecastLoading={forecastLoading} /><div className="flex justify-end"><button type="button" disabled={saving || forecastLoading || !forecastData} onClick={handleSave} className="rounded-lg bg-[#b41f1f] px-5 py-2 font-semibold text-white disabled:bg-gray-400">{saving ? "Saving quote..." : "Save Quote"}</button></div></section>}
    </PageContainer>
  </div>;
}
