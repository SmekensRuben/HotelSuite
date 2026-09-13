import { applyInflationAdjustment } from "./quoteAnalysis";

export const DISPLACEMENT_FORECAST_CONFIG = {
  historicalYears: 5,
  minimumPreferredHistoricalSample: 6,
  minimumFallbackHistoricalSample: 3,
  historicalCapacityConstraintThreshold: 0.95,
  lighthouseComparableWindowDays: 28,
  lighthouseDemandBeta: 0.5,
  lighthouseMinModifier: 0.85,
  lighthouseMaxModifier: 1.15,
};

const LOWER_BOUND_WARNING = "Historical transient demand is capacity constrained; baseline is a lower-bound estimate.";
const LIGHTHOUSE_WARNING = "Lighthouse Market Demand is missing or invalid; no market adjustment was applied.";

const numeric = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "string" ? Number(value.trim().replace(",", ".")) : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const utcDate = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
};

export function normalizePercentage(value) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const hasPercent = trimmed.endsWith("%");
    const parsed = Number(trimmed.replace(/%$/, "").trim().replace(",", "."));
    if (!Number.isFinite(parsed) || parsed < 0) return null;
    const normalized = hasPercent || parsed > 1 ? parsed / 100 : parsed;
    return normalized <= 1 ? normalized : null;
  }
  const parsed = numeric(value);
  if (parsed === null || parsed < 0) return null;
  const normalized = parsed > 1 ? parsed / 100 : parsed;
  return normalized <= 1 ? normalized : null;
}

export function median(values) {
  const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function getBusinessSeason(dateValue) {
  const month = utcDate(dateValue)?.getUTCMonth() + 1;
  if (!month) return null;
  if (month <= 2) return "WINTER_LOW";
  if (month <= 6) return "SPRING_BUSINESS";
  if (month <= 8) return "SUMMER";
  if (month <= 11) return "AUTUMN_BUSINESS";
  return "FESTIVE";
}

export function mapCurrentOtb(document) {
  const individualRooms = Math.max(0, numeric(document?.individualRooms) ?? 0);
  const groupRooms = Math.max(0, numeric(document?.groupRooms) ?? 0);
  const occupiedRooms = Math.max(0, numeric(document?.calculatedOccRooms) ?? 0);
  return {
    currentTransientOtb: individualRooms,
    existingGroupOtb: groupRooms,
    sellableInventory: Math.max(0, numeric(document?.calculatedInventoryRooms) ?? 0),
    otherCommittedRooms: Math.max(0, occupiedRooms - individualRooms - groupRooms),
    currentOtbExists: numeric(document?.individualRooms) !== null,
  };
}

export function prepareHistoricalObservations(rows, config = DISPLACEMENT_FORECAST_CONFIG) {
  return rows.flatMap((row) => {
    if (row.historyFutureType && row.historyFutureType !== "History") return [];
    const date = row.date || row.consideredDate || row.id;
    const inventory = numeric(row.calculatedInventoryRooms);
    const individualRooms = numeric(row.individualRooms);
    if (!utcDate(date) || inventory === null || inventory <= 0 || individualRooms === null) return [];
    const groupRooms = Math.max(0, numeric(row.groupRooms) ?? 0);
    const occupiedRooms = Math.max(0, numeric(row.calculatedOccRooms) ?? 0);
    const otherActualRooms = Math.max(0, occupiedRooms - individualRooms - groupRooms);
    const transientCapacity = Math.max(0, inventory - groupRooms - otherActualRooms);
    const utilization = transientCapacity > 0 ? individualRooms / transientCapacity : null;
    return [{
      ...row,
      date,
      inventory,
      individualRooms,
      groupShare: groupRooms / inventory,
      otherActualRooms,
      transientCapacity,
      transientCapacityUtilization: utilization,
      isCapacityConstrained: transientCapacity <= 0 || utilization >= config.historicalCapacityConstraintThreshold,
      transientOccupancyRatio: individualRooms / inventory,
    }];
  });
}

export function selectHistoricalObservations(targetDate, observations, maxHistoricalGroupShare, config = DISPLACEMENT_FORECAST_CONFIG, selectedHistoricalYears) {
  const target = utcDate(targetDate);
  if (!target) return { selected: [], tier: "unavailable", counts: { candidate: 0, preferred: 0, usable: 0, censored: 0 } };
  const threshold = Number.isFinite(maxHistoricalGroupShare) ? maxHistoricalGroupShare : 1;
  const targetYear = target.getUTCFullYear();
  const selectedYearSet = Array.isArray(selectedHistoricalYears)
    ? new Set(selectedHistoricalYears.map(Number).filter(Number.isFinite))
    : null;
  const candidates = observations.filter((item) => {
    const date = utcDate(item.date);
    const age = date ? targetYear - date.getUTCFullYear() : 0;
    const yearIsEligible = selectedYearSet
      ? selectedYearSet.has(date?.getUTCFullYear())
      : age >= 1 && age <= config.historicalYears;
    return date && yearIsEligible && date.getUTCDay() === target.getUTCDay();
  });
  const sameMonth = candidates.filter((item) => utcDate(item.date).getUTCMonth() === target.getUTCMonth());
  const sameSeason = candidates.filter((item) => getBusinessSeason(item.date) === getBusinessSeason(targetDate));
  const unconstrained = (items) => items.filter((item) => !item.isCapacityConstrained);
  const preferred = (items) => unconstrained(items).filter((item) => item.groupShare <= threshold);
  const tiers = [
    [preferred(sameMonth), "same-month-preferred"],
    [unconstrained(sameMonth), "same-month-unconstrained"],
    [preferred(sameSeason), "same-season-preferred"],
    [unconstrained(sameSeason), "same-season-unconstrained"],
  ];
  const match = tiers.find(([items]) => items.length >= config.minimumPreferredHistoricalSample);
  let selected = match?.[0] || [];
  let tier = match?.[1] || "unavailable";
  if (!selected.length) {
    const fallback = unconstrained(sameSeason);
    if (fallback.length >= config.minimumFallbackHistoricalSample) {
      selected = fallback;
      tier = "same-season-low-sample";
    } else {
      const sameMonthCensored = sameMonth.filter((item) => item.isCapacityConstrained);
      const sameSeasonCensored = sameSeason.filter((item) => item.isCapacityConstrained);
      selected = sameMonthCensored.length ? sameMonthCensored : sameSeasonCensored;
      if (selected.length) tier = "censored-lower-bound";
    }
  }
  return {
    selected,
    tier,
    counts: {
      candidate: candidates.length,
      preferred: preferred(sameSeason).length,
      usable: unconstrained(sameSeason).length,
      censored: sameSeason.filter((item) => item.isCapacityConstrained).length,
    },
  };
}

export function calculateLighthouseModifier(targetDate, lighthouseByDate, config = DISPLACEMENT_FORECAST_CONFIG) {
  const target = utcDate(targetDate);
  const targetDemand = normalizePercentage(lighthouseByDate?.[targetDate]?.["Market demand"]);
  const comparable = target ? Object.entries(lighthouseByDate || {}).flatMap(([dateValue, row]) => {
    const date = utcDate(dateValue);
    if (!date || dateValue === targetDate || date.getUTCDay() !== target.getUTCDay()) return [];
    const distance = Math.abs(date.getTime() - target.getTime()) / 86400000;
    const demand = normalizePercentage(row?.["Market demand"]);
    return distance <= config.lighthouseComparableWindowDays && demand !== null ? [demand] : [];
  }) : [];
  const comparableDemand = median(comparable);
  if (targetDemand === null || comparableDemand === null || comparableDemand <= 0) {
    return { targetDemand, comparableDemand, marketIndex: null, modifier: 1, valid: false, warning: LIGHTHOUSE_WARNING };
  }
  const marketIndex = targetDemand / comparableDemand;
  const uncapped = 1 + config.lighthouseDemandBeta * (marketIndex - 1);
  return {
    targetDemand,
    comparableDemand,
    marketIndex,
    modifier: Math.min(config.lighthouseMaxModifier, Math.max(config.lighthouseMinModifier, uncapped)),
    valid: true,
    warning: null,
  };
}

export function calculateDisplacementScenario({ sellableInventory, existingGroupOtb, otherCommittedRooms, requestedGroupRooms, transientDemandForecast }) {
  const requested = Math.max(0, numeric(requestedGroupRooms) ?? 0);
  const availableTransientWithoutGroup = Math.max(0, sellableInventory - existingGroupOtb - otherCommittedRooms);
  const transientSoldWithoutGroup = Math.min(transientDemandForecast, availableTransientWithoutGroup);
  const availableTransientWithGroup = Math.max(0, availableTransientWithoutGroup - requested);
  const transientSoldWithGroup = Math.min(transientDemandForecast, availableTransientWithGroup);
  const displacedRooms = Math.min(requested, Math.max(0, transientSoldWithoutGroup - transientSoldWithGroup));
  return { availableTransientWithoutGroup, transientSoldWithoutGroup, availableTransientWithGroup, transientSoldWithGroup, displacedRooms, nonDisplacingGroupRooms: requested - displacedRooms };
}

export function calculateDisplacementDay({ stayDate, requestedGroupRooms, currentOtb, historicalRows = [], lighthouseByDate = {}, maxHistoricalGroupShare = 1, selectedHistoricalYears, inflationPercentage = 0, config = DISPLACEMENT_FORECAST_CONFIG }) {
  const current = mapCurrentOtb(currentOtb);
  const observations = prepareHistoricalObservations(historicalRows, config);
  const historical = selectHistoricalObservations(stayDate, observations, maxHistoricalGroupShare, config, selectedHistoricalYears);
  const historicalMedianTransientOccupancy = median(historical.selected.map((item) => item.transientOccupancyRatio));
  const targetYear = utcDate(stayDate)?.getUTCFullYear();
  const inflationAdjustedHistoricalAdrValues = historical.selected.flatMap((item) => {
    const adr = numeric(item.averageRoomRate);
    const historicalYear = utcDate(item.date)?.getUTCFullYear();
    if (adr === null || adr <= 0 || !targetYear || !historicalYear) return [];
    return [applyInflationAdjustment(adr, inflationPercentage, Math.max(0, targetYear - historicalYear))];
  });
  const expectedTransientRoomRate = median(inflationAdjustedHistoricalAdrValues);
  const historicalBaselineRooms = historicalMedianTransientOccupancy === null ? null : historicalMedianTransientOccupancy * current.sellableInventory;
  const lighthouse = calculateLighthouseModifier(stayDate, lighthouseByDate, config);
  const adjustedHistoricalDemand = historicalBaselineRooms === null ? null : historicalBaselineRooms * lighthouse.modifier;
  const transientDemandForecast = Math.max(current.currentTransientOtb, adjustedHistoricalDemand ?? 0);
  const warnings = [];
  if (historical.tier === "censored-lower-bound") warnings.push(LOWER_BOUND_WARNING);
  if (historicalBaselineRooms === null) warnings.push("Historical transient baseline is unavailable.");
  if (lighthouse.warning) warnings.push(lighthouse.warning);
  if (!current.currentOtbExists) warnings.push("Current transient OTB is missing.");
  if (!currentOtb || current.sellableInventory <= 0) warnings.push("Current sellable inventory is missing or invalid.");
  let forecastConfidence = "low";
  const sameMonth = historical.tier.startsWith("same-month");
  const sameSeason = historical.tier === "same-season-preferred" || historical.tier === "same-season-unconstrained";
  if (sameMonth && historical.selected.length >= 8 && current.currentOtbExists && lighthouse.valid) forecastConfidence = "high";
  else if (current.currentOtbExists && ((sameMonth && historical.selected.length >= 6) || (sameSeason && historical.selected.length >= 6))) forecastConfidence = "medium";
  const scenario = calculateDisplacementScenario({ ...current, requestedGroupRooms, transientDemandForecast });
  return {
    stayDate,
    ...current,
    requestedGroupRooms: Math.max(0, numeric(requestedGroupRooms) ?? 0),
    historicalYears: Array.isArray(selectedHistoricalYears) ? selectedHistoricalYears.map(Number) : null,
    historicalSelectionTier: historical.tier,
    forecastConfidence,
    historicalCandidateCount: historical.counts.candidate,
    historicalPreferredCount: historical.counts.preferred,
    historicalUsableCount: historical.counts.usable,
    historicalCensoredCount: historical.counts.censored,
    historicalSelectedCount: historical.selected.length,
    historicalMedianTransientOccupancy,
    expectedTransientRoomRate,
    historicalBaselineRooms,
    targetLighthouseMarketDemand: lighthouse.targetDemand,
    comparableLighthouseMarketDemand: lighthouse.comparableDemand,
    lighthouseMarketIndex: lighthouse.marketIndex,
    lighthouseMarketModifier: lighthouse.modifier,
    adjustedHistoricalDemand,
    transientDemandForecast,
    ...scenario,
    warnings,
  };
}
