import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import PageShell from "../layout/PageShell";
import AsyncError from "../shared/AsyncError";
import { useScopedAsync } from "../../hooks/useScopedAsync";
import { Card } from "../layout/Card";
import GroupQuoteFormFields from "./GroupQuoteFormFields";
import HistoricalYearsDropdown from "./HistoricalYearsDropdown";
import { useHotelContext } from "../../contexts/HotelContext";
import { addQuote, getCompsetConfiguration, getGroupQuoteSettings, getHistoryQuoteDates, getLatestHistoryForecastSnapshot, getLatestLighthouseSnapshot, getStayPatternModelEvidence, GROUP_QUOTE_ANALYSIS_MODEL_VERSION, MARKET_CONTEXT_MODEL_VERSION } from "../../services/firebaseQuotes";
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
import { applyLosNetworkOpportunityCost, buildLosNetworkSnapshot, combineStayPatternYears, createLosNetworkHorizon, LOS_NETWORK_DEFAULTS, LOS_DISPLACEMENT_MODEL_VERSION, STAY_PATTERN_MODEL_VERSION } from "../../utils/losNetwork";
import { freezeContributionEvidence, losAnalysisFallback } from "../../utils/quoteAnalysisEvidence";

const hasPmsCapacity = (row) => row && [row.calculatedInventoryRooms, row.individualRooms, row.groupRooms].every((value) =>
  (typeof value === "number" || typeof value === "string") && String(value).trim() !== "" && Number.isFinite(Number(value)) && Number(value) >= 0);

export default function GroupQuoteCreatePage() {
  const navigate = useNavigate();
  const { hotelUid } = useHotelContext();
  const [selectedYears, setSelectedYears] = useState([]);
  const [analysisState, setAnalysisState] = useState(null);
  const analysisQuote = analysisState?.hotelUid === hotelUid ? analysisState.quote : null;
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [yearsCustomized, setYearsCustomized] = useState(false);
  const [testGroupRate, setTestGroupRate] = useState("");
  const [showInputForm, setShowInputForm] = useState(true);
  const analysisRunId = analysisState?.runId || 0;
  const loadConfiguration = useCallback(async () => {
    const [dates, settings, compset] = await Promise.all([getHistoryQuoteDates(hotelUid), getGroupQuoteSettings(hotelUid), getCompsetConfiguration(hotelUid)]);
    return { dates, settings, compset };
  }, [hotelUid, analysisRunId]);
  const configuration = useScopedAsync({ scopeKey: `${hotelUid}:${analysisRunId}`, enabled: Boolean(hotelUid), load: loadConfiguration });
  const consideredDates = configuration.data?.dates || [];
  const quoteSettings = configuration.data?.settings || {};
  const compsetConfiguration = configuration.data?.compset || { settings: {}, competitors: [] };
  const availableYears = useMemo(() => [...new Set(consideredDates.map((item) => Number(item.date.slice(0, 4))))].sort((a, b) => b - a), [consideredDates]);
  useEffect(() => {
    setSelectedYears([]); setYearsCustomized(false); setAnalysisState(null); setShowInputForm(true); setSaveError(null); setTestGroupRate("");
  }, [hotelUid]);
  const loadSources = useCallback(async () => {
    const [current, lighthouse, events] = await Promise.all([getLatestHistoryForecastSnapshot(hotelUid), getLatestLighthouseSnapshot(hotelUid), getDemandCalendarEvents(hotelUid)]);
    return { current, lighthouse, events };
  }, [hotelUid, analysisQuote]);
  const sources = useScopedAsync({ scopeKey: `${hotelUid}:${analysisRunId}:${JSON.stringify(analysisQuote)}`, enabled: Boolean(hotelUid && analysisQuote), load: loadSources });
  const sourceData = sources.data;
  const forecastLoading = sources.loading;
  const loadPatterns = useCallback(async () => getStayPatternModelEvidence(hotelUid, selectedYears), [hotelUid, selectedYears, analysisRunId]);
  const patterns = useScopedAsync({ scopeKey: `${hotelUid}:${analysisRunId}:${selectedYears.join(",")}`, enabled: Boolean(hotelUid && analysisQuote && selectedYears.length), load: loadPatterns });
  const stayPatternYears = patterns.data?.years || [];
  const stayPatternRoot = patterns.data?.root || null;
  const { forecastData, groupForecastData } = useMemo(() => {
    if (!analysisQuote || !sourceData) return { forecastData: null, groupForecastData: null };
    const stayDates = getQuoteStayDates(analysisQuote);
    const current = sourceData.current || {};
    const lighthouse = sourceData.lighthouse || {};
    const preparedTransient = prepareDisplacementForecastData({ historicalRows: consideredDates, lighthouseByDate: lighthouse.byDate || {} });
    const preparedGroup = prepareGroupForecastData({ historicalRows: consideredDates, events: sourceData.events || [], targetDates: stayDates });
    const maxShare = Number(quoteSettings.maxHistoricalGroupSharePercentage);
    const byDate = Object.fromEntries(stayDates.map((stayDate) => {
      const pmsRow = current.byDate?.[stayDate];
      const pmsDataStatus = sourceStatusForDate(stayDate, current.coverage || {}, pmsRow, hasPmsCapacity);
      if (pmsDataStatus !== "AVAILABLE") return [stayDate, { stayDate, pmsDataStatus }];
      return [stayDate, { ...calculateDisplacementDay({ stayDate, requestedGroupRooms: analysisQuote.roomsByDate.find((item) => item.date === stayDate)?.rooms,
        currentOtb: pmsRow, preparedData: preparedTransient, selectedHistoricalYears: selectedYears,
        maxHistoricalGroupShare: Number.isFinite(maxShare) ? maxShare / 100 : 1, inflationPercentage: quoteSettings.inflationPercentage, config: DISPLACEMENT_FORECAST_CONFIG }), pmsDataStatus }];
    }));
    const groupByDate = Object.fromEntries(stayDates.map((stayDate) => [stayDate, byDate[stayDate].pmsDataStatus === "AVAILABLE"
      ? calculateGroupDemandForecast({ stayDate, currentOtb: current.byDate[stayDate], preparedData: preparedGroup, selectedHistoricalYears: selectedYears })
      : { stayDate, pmsDataStatus: byDate[stayDate].pmsDataStatus }]));
    return { forecastData: { byDate, pmsCoverage: current.coverage || null, currentSnapshotDate: current.snapshotDate || null, lighthouseSnapshotDate: lighthouse.snapshotDate || null }, groupForecastData: { byDate: groupByDate } };
  }, [analysisQuote, sourceData, consideredDates, selectedYears, quoteSettings]);

  const combinedForecastByDate = useMemo(() => forecastData && groupForecastData ? Object.fromEntries(Object.entries(forecastData?.byDate || {}).map(([stayDate, forecast]) => [stayDate, { ...forecast, groupForecast: groupForecastData.byDate[stayDate] }])) : null, [forecastData, groupForecastData]);
  const physicalFeasibility = useMemo(() => {
    if (!analysisQuote || !combinedForecastByDate || Object.values(forecastData.byDate).some((date) => date.pmsDataStatus !== "AVAILABLE")) return null;
    return calculatePhysicalFeasibility({ roomsByDate: analysisQuote.roomsByDate, forecastByDate: combinedForecastByDate });
  }, [analysisQuote, combinedForecastByDate, forecastData]);
  const legacyContribution = useMemo(() => {
    if (!analysisQuote || !forecastData || !groupForecastData) return null;
    if (Object.values(forecastData.byDate).some((date) => date.pmsDataStatus !== "AVAILABLE")) return { validationError: "PMS target-date data is unavailable for one or more stay nights." };
    try {
      const result = calculateGroupContribution({ quote: analysisQuote, forecastByDate: combinedForecastByDate, settings: quoteSettings });
      return physicalFeasibility?.status === "PHYSICAL_CAPACITY_SHORTFALL" ? { ...result, economicFloorUnavailableReason: "ECONOMIC_FLOOR_UNAVAILABLE_PHYSICAL_CAPACITY" } : result;
    } catch (error) { return { validationError: error.message }; }
  }, [analysisQuote, forecastData, groupForecastData, combinedForecastByDate, physicalFeasibility, quoteSettings]);
  const losNetworkSnapshot = useMemo(() => {
    if (!analysisQuote || !sourceData?.current?.byDate || !legacyContribution || legacyContribution.validationError) return null;
    if (patterns.error) return losAnalysisFallback(LOS_DISPLACEMENT_MODEL_VERSION, "LOS_PATTERN_READ_FAILED", { error: patterns.error.message });
    try {
    const maxLos = Number(quoteSettings.maxModeledLos) || LOS_NETWORK_DEFAULTS.maxModeledLos;
    const { horizonDates, valuationDates } = createLosNetworkHorizon({ groupArrivalDate: analysisQuote.startDate, groupCheckOutDate: analysisQuote.endDate, maxModeledLos: maxLos });
    const preparedTransient = prepareDisplacementForecastData({ historicalRows: consideredDates, lighthouseByDate: sourceData.lighthouse?.byDate || {} });
    const preparedGroup = prepareGroupForecastData({ historicalRows: consideredDates, events: sourceData.events, targetDates: horizonDates });
    const maxShare = Number(quoteSettings.maxHistoricalGroupSharePercentage);
    const networkForecastByDate = {};
    for (const stayDate of valuationDates) {
      const pmsRow = sourceData.current.byDate[stayDate];
      const status = sourceStatusForDate(stayDate, sourceData.current.coverage || {}, pmsRow, hasPmsCapacity);
      if (status !== "AVAILABLE") continue;
      networkForecastByDate[stayDate] = { ...calculateDisplacementDay({ stayDate, requestedGroupRooms: analysisQuote.roomsByDate.find((item) => item.date === stayDate)?.rooms || 0, currentOtb: pmsRow, preparedData: preparedTransient, selectedHistoricalYears: selectedYears, maxHistoricalGroupShare: Number.isFinite(maxShare) ? maxShare / 100 : 1, inflationPercentage: quoteSettings.inflationPercentage, config: DISPLACEMENT_FORECAST_CONFIG }), groupForecast: calculateGroupDemandForecast({ stayDate, currentOtb: pmsRow, preparedData: preparedGroup, selectedHistoricalYears: selectedYears }) };
    }
    const horizonQuote = { ...analysisQuote, roomsByDate: valuationDates.map((date) => ({ date, rooms: analysisQuote.roomsByDate.find((row) => row.date === date)?.rooms || 0, breakfastPax: 0, bqtRevenue: 0, mealBasis: "RO" })) };
    let horizonContribution;
    try { horizonContribution = calculateGroupContribution({ quote: horizonQuote, forecastByDate: networkForecastByDate, settings: quoteSettings }); }
    catch (error) { return losAnalysisFallback(LOS_DISPLACEMENT_MODEL_VERSION, "LOS_HORIZON_CALCULATION_FAILED", { horizonDates, valuationDates, error: error.message }); }
    const pattern = combineStayPatternYears(Object.values(stayPatternYears).filter(Boolean), selectedYears, stayPatternRoot);
    return buildLosNetworkSnapshot({ stayPattern: pattern, horizonDates, valuationDates, nightlyByDate: Object.fromEntries(horizonContribution.nightly.filter((night) => networkForecastByDate[night.stayDate]).map((night) => [night.stayDate, night])), requestedRoomsByDate: Object.fromEntries(analysisQuote.roomsByDate.map((night) => [night.date, Number(night.rooms) || 0])), groupArrivalDate: analysisQuote.startDate, groupCheckOutDate: analysisQuote.endDate, settings: { ...LOS_NETWORK_DEFAULTS, maxModeledLos: maxLos } });
    } catch (error) {
      return losAnalysisFallback(LOS_DISPLACEMENT_MODEL_VERSION, "LOS_ANALYSIS_FAILED", { error: error.message });
    }
  }, [analysisQuote, sourceData, legacyContribution, quoteSettings, consideredDates, selectedYears, stayPatternYears, stayPatternRoot, patterns.error]);
  const contribution = useMemo(() => !legacyContribution || legacyContribution.validationError ? legacyContribution : applyLosNetworkOpportunityCost(legacyContribution, losNetworkSnapshot), [legacyContribution, losNetworkSnapshot]);
  const simulation = useMemo(() => contribution && !contribution.validationError ? simulateGroupQuote(contribution, testGroupRate) : null, [contribution, testGroupRate]);
  const marketContextSnapshot = useMemo(() => analysisQuote && sourceData ? buildMarketContextSnapshot({ lighthouseSnapshotDate: sourceData?.lighthouse?.snapshotDate || null, lighthouseCoverage: sourceData.lighthouse?.coverage, compset: compsetConfiguration.settings, competitors: compsetConfiguration.competitors, lighthouseByDate: sourceData.lighthouse?.byDate || {}, roomsByDate: analysisQuote.roomsByDate }) : null, [analysisQuote, sourceData, compsetConfiguration]);
  const pricingGuidanceSnapshot = useMemo(() => contribution && !contribution.validationError && marketContextSnapshot ? { ...calculatePricingGuidance({ economicFloorRateInclVat: contribution.economicFloorRateInclVat, economicFloorUnavailableReason: contribution.economicFloorUnavailableReason, physicalFeasibility, totalDisplacedRoomNights: contribution.totalDisplacedRooms, requestedRoomNights: contribution.totalRequestedGroupRoomNights, marketSummary: marketContextSnapshot.groupStaySummary, roomsByDate: analysisQuote.roomsByDate, breakfastPax: analysisQuote.breakfastPax, strategy: compsetConfiguration.settings.pricingStrategy }), ...(physicalFeasibility?.status === "PHYSICAL_CAPACITY_SHORTFALL" ? { unavailableReason: "REQUESTED_PRODUCT_PHYSICALLY_INFEASIBLE" } : {}) } : null, [contribution, marketContextSnapshot, analysisQuote, compsetConfiguration, physicalFeasibility]);
  const targetSimulation = useMemo(() => contribution && !contribution.validationError && pricingGuidanceSnapshot?.targetRateInclVat != null ? simulateGroupQuote(contribution, pricingGuidanceSnapshot.targetRateInclVat) : null, [contribution, pricingGuidanceSnapshot]);

  const toggleYear = (year) => { setYearsCustomized(true); setSelectedYears((current) => current.includes(year)
    ? current.filter((item) => item !== year)
    : [...current, year].sort((a, b) => b - a)); };

  const startAnalysis = (quote) => {
    if (!yearsCustomized) {
      const targetYear = Number(quote.startDate.slice(0, 4));
      setSelectedYears(availableYears.filter((year) => year < targetYear).slice(0, 5));
    }
    setAnalysisState((current) => ({ hotelUid, quote, runId: (current?.runId || 0) + 1 }));
    setSaveError(null); setTestGroupRate("");
    setShowInputForm(false);
  };

  const analysisAvailable = !configuration.loading && !configuration.error && !patterns.loading && Boolean(contribution && !contribution.validationError && Array.isArray(contribution.nightly) && contribution.totalRequestedGroupRoomNights > 0 && Number.isFinite(contribution.economicFloorRateInclVat) && forecastData && sourceData && physicalFeasibility?.status === "PHYSICALLY_FEASIBLE");

  const handleSave = async () => {
    if (!hotelUid || !analysisQuote) return;
    setSaving(true); setSaveError(null);
    try {
      const available = analysisAvailable;
      const quoteId = await addQuote(hotelUid, {
        ...analysisQuote,
        analysisYears: selectedYears,
        displacementForecast: Object.values(forecastData?.byDate || {}),
        groupDemandForecast: Object.values(groupForecastData?.byDate || {}),
        integratedDisplacement: contribution?.nightly?.map((night) => ({
          stayDate: night.stayDate,
          scenario: "BASE",
          totalDisplacedRooms: night.scenarios.base.totalDisplacedFutureRooms,
          displacedFutureTransientRooms: night.scenarios.base.displacedFutureTransientRooms,
          displacedFutureGroupRooms: night.scenarios.base.displacedFutureGroupRooms,
          nonDisplacingGroupRooms: night.scenarios.base.nonDisplacingGroupRooms,
        })) || [],
        commercialStatus: "PENDING",
        quoteInputSnapshot: { version: analysisQuote.quoteInputSchemaVersion, requestDate: analysisQuote.requestDate, arrivalDate: analysisQuote.startDate, checkOutDate: analysisQuote.endDate, dateRangeSemantics: analysisQuote.dateRangeSemantics, groupSegment: analysisQuote.groupSegment || "UNKNOWN", roomsByDate: analysisQuote.roomsByDate.map((night) => ({ date: night.date, rooms: night.rooms, mealBasis: night.mealBasis, breakfastPax: night.breakfastPax, bqtRevenue: night.bqtRevenue })) },
        analysisStatus: available ? "CURRENT" : "UNAVAILABLE",
        analysisUnavailableReason: available ? null : contribution?.validationError || contribution?.economicFloorUnavailableReason || sources.error?.message || "Required analysis data is unavailable.",
        draft: !available,
        analysisModelVersion: GROUP_QUOTE_ANALYSIS_MODEL_VERSION,
        contributionModelVersion: GROUP_QUOTE_ANALYSIS_MODEL_VERSION,
        stayPatternModelVersion: STAY_PATTERN_MODEL_VERSION,
        displacementModelVersion: LOS_DISPLACEMENT_MODEL_VERSION,
        marketContextModelVersion: MARKET_CONTEXT_MODEL_VERSION,
        pricingGuidanceModelVersion: PRICING_GUIDANCE_MODEL_VERSION,
        physicalFeasibilityVersion: PHYSICAL_FEASIBILITY_VERSION,
        physicalFeasibility,
        marketContextSnapshot,
        pricingGuidanceSnapshot,
        sourceAvailabilitySnapshot: { pmsSnapshotDate: sourceData?.current?.snapshotDate || null, pmsMaximumStayDateAvailable: sourceData?.current?.coverage?.maximumStayDateAvailable || null, pmsStatusByDate: Object.fromEntries(Object.entries(forecastData?.byDate || {}).map(([date, value]) => [date, value.pmsDataStatus])), lighthouseSnapshotDate: sourceData?.lighthouse?.snapshotDate || null, lighthouseMaximumStayDateAvailable: sourceData?.lighthouse?.coverage?.maximumStayDateAvailable || null, lighthouseStatusByDate: Object.fromEntries((marketContextSnapshot?.stayDates || []).map((date) => [date.stayDate, date.lighthouseDataStatus])), marketDateCoverage: marketContextSnapshot?.groupStaySummary?.marketDateCoverage ?? null },
        analysisContributionSnapshot: available ? freezeContributionEvidence(contribution) : null,
        legacyStayDateDisplacement: contribution?.legacyStayDateDisplacement || contribution?.scenarioTotals || null,
        losNetworkDisplacement: contribution?.losNetworkDisplacement || losNetworkSnapshot,
      });
      navigate(`/revenue/group-quotes/${quoteId}`);
    } catch (error) {
      setSaveError(error);
    } finally {
      setSaving(false);
    }
  };

  const mealBasis = analysisQuote ? deriveExplicitQuoteMealBasis(analysisQuote.roomsByDate) : "LEGACY_UNKNOWN";

  return <PageShell className="space-y-6 pb-10">
      <AsyncError error={configuration.error} onRetry={configuration.retry} label="Could not load quote settings and history." />
      <AsyncError error={sources.error} onRetry={sources.retry} label="Could not load quote analysis sources. You can save an unavailable draft." />
      <AsyncError error={patterns.error} onRetry={patterns.retry} label="Could not load stay patterns. The stay-date analysis remains available." />
      <AsyncError error={saveError} label="Could not save this quote. Your inputs are retained; try saving again." />
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div><p className="text-sm uppercase tracking-wide text-gray-500">Revenue / Group Quotes</p><h1 className="text-3xl font-semibold">Create Quote</h1></div>
        <button type="button" onClick={() => navigate("/revenue/group-quotes")} className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-semibold hover:bg-gray-100"><ArrowLeft className="h-4 w-4" /> Back to overview</button>
      </div>

      {analysisQuote && !showInputForm ? <QuoteInputSummary quote={analysisQuote} mealBasis={mealBasis} onEdit={() => setShowInputForm(true)} /> : <Card className="border border-gray-200 bg-white shadow-sm"><GroupQuoteFormFields initialQuote={analysisQuote} defaultGroupCommissionPercentage={quoteSettings.defaultGroupCommissionPercentage} defaultGroupMealBasis={quoteSettings.defaultGroupMealBasis || "RO"} onSubmit={startAnalysis} key={hotelUid} saving={configuration.loading} submitLabel={analysisQuote ? "Run Updated Analysis" : "Start Analysis"} /></Card>}

      {showInputForm && <Card className="border border-gray-200 bg-white shadow-sm"><details><summary className="cursor-pointer font-semibold">Advanced / Model Settings</summary><div className="mt-4 border-t border-gray-200 pt-4"><fieldset><legend className="mb-2 text-sm font-semibold">Historical years</legend><HistoricalYearsDropdown years={availableYears} selectedYears={selectedYears} onToggle={toggleYear} /></fieldset></div></details></Card>}

      {analysisQuote && !showInputForm && <section className="space-y-6">{forecastLoading && <p role="status" className="text-gray-600">Loading quote analysis sources...</p>}<GroupQuoteAnalysisView contribution={contribution} physicalFeasibility={physicalFeasibility} forecastData={forecastData} groupForecastData={groupForecastData} marketContextSnapshot={marketContextSnapshot} pricingGuidance={pricingGuidanceSnapshot} quoteSettings={quoteSettings} testGroupRate={testGroupRate} setTestGroupRate={setTestGroupRate} simulation={simulation} targetSimulation={targetSimulation} forecastLoading={forecastLoading} /><div className="flex justify-end"><button type="button" disabled={saving || configuration.loading || forecastLoading || patterns.loading} onClick={handleSave} className="rounded-lg bg-[#b41f1f] px-5 py-2 font-semibold text-white disabled:bg-gray-400">{saving ? "Saving quote..." : analysisAvailable ? "Save Quote" : "Save Unavailable Draft"}</button></div></section>}
  </PageShell>;
}
