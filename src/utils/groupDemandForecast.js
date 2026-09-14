import { getBusinessSeason } from "./displacementForecast";

export const GROUP_FORECAST_METHOD = "HISTORICAL_FINAL_GROUP_DEMAND";
export const GROUP_FORECAST_CONFIG = { preferredSample: 5, strongSample: 8 };

const IMPORTANT_TYPES = new Set(["SCHOOL_HOLIDAY", "PUBLIC_HOLIDAY", "BRIDGE_DAY", "BUSINESS_EVENT", "CITYWIDE_COMPRESSION", "FESTIVE_PERIOD"]);
const number = (value) => value === null || value === undefined || value === "" ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const date = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value || "") ? new Date(`${value}T00:00:00Z`) : null;

export function percentile(values, fraction) {
  const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const remainder = position - lower;
  return sorted[lower + 1] === undefined ? sorted[lower] : sorted[lower] + remainder * (sorted[lower + 1] - sorted[lower]);
}

export function calendarFeatures(stayDate, events = []) {
  const activeEvents = events.filter((event) => event?.active === true && event.startDate <= stayDate && event.endDate >= stayDate);
  const types = [...new Set(activeEvents.map((event) => event.systemType).filter(Boolean))];
  const material = activeEvents.filter((event) => IMPORTANT_TYPES.has(event.systemType) && (event.groupDemandEffect || "NEUTRAL") !== "NEUTRAL");
  // Important event types remain part of the regime even when their effect is neutral.
  const regimeEvents = activeEvents.filter((event) => IMPORTANT_TYPES.has(event.systemType));
  const regime = regimeEvents.length ? regimeEvents.map((event) => `${event.systemType}:${event.groupDemandEffect || "NEUTRAL"}`).sort() : ["NORMAL_GROUP_BUSINESS"];
  return {
    isSchoolHoliday: types.includes("SCHOOL_HOLIDAY"), isPublicHoliday: types.includes("PUBLIC_HOLIDAY"),
    isBridgeDay: types.includes("BRIDGE_DAY"), hasBusinessEvent: types.includes("BUSINESS_EVENT"),
    hasLeisureEvent: types.includes("LEISURE_EVENT"), hasCitywideCompression: types.includes("CITYWIDE_COMPRESSION"),
    hasFestivePeriod: types.includes("FESTIVE_PERIOD"), activeEventIds: activeEvents.map((event) => event.id).filter(Boolean),
    activeEventNames: activeEvents.map((event) => event.name).filter(Boolean), activeSystemTypes: types,
    groupDemandEffects: [...new Set(activeEvents.map((event) => event.groupDemandEffect || "NEUTRAL"))],
    calendarRegime: regime, isNormalGroupBusiness: material.length === 0 && regimeEvents.length === 0,
  };
}

const sameRegime = (left, right) => left.calendarRegime.join("|") === right.calendarRegime.join("|");

export function prepareGroupHistory(rows = [], events = []) {
  return rows.flatMap((row) => {
    const stayDate = row.date || row.consideredDate || row.id;
    const inventory = number(row.calculatedInventoryRooms);
    const groupRooms = number(row.groupRooms);
    if ((row.historyFutureType && row.historyFutureType !== "History") || !date(stayDate) || inventory === null || inventory <= 0 || groupRooms === null || groupRooms < 0) return [];
    return [{ stayDate, finalGroupRooms: groupRooms, sellableInventory: inventory, groupShare: groupRooms / inventory, calendarFeatures: calendarFeatures(stayDate, events) }];
  });
}

export function selectGroupComparables(stayDate, observations, targetFeatures, config = GROUP_FORECAST_CONFIG) {
  const target = date(stayDate);
  if (!target) return { selected: [], tier: null };
  const eligible = observations.filter((item) => item.stayDate !== stayDate);
  const sameDow = (item) => date(item.stayDate).getUTCDay() === target.getUTCDay();
  const sameMonth = (item) => date(item.stayDate).getUTCMonth() === target.getUTCMonth();
  const sameSeason = (item) => getBusinessSeason(item.stayDate) === getBusinessSeason(stayDate);
  const regime = (item) => sameRegime(item.calendarFeatures, targetFeatures);
  const tiers = [
    ["TIER_1_SAME_DOW_MONTH_CALENDAR", (item) => sameDow(item) && sameMonth(item) && regime(item)],
    ["TIER_2_SAME_DOW_SEASON_CALENDAR", (item) => sameDow(item) && sameSeason(item) && regime(item)],
    ["TIER_3_SAME_DOW_MONTH", (item) => sameDow(item) && sameMonth(item)],
    ["TIER_4_SAME_DOW_SEASON", (item) => sameDow(item) && sameSeason(item)],
    ["TIER_5_SEASON_FALLBACK", sameSeason],
  ];
  const matches = tiers.map(([tier, predicate]) => ({ tier, selected: eligible.filter(predicate) }));
  return matches.find((match) => match.selected.length >= config.preferredSample) || [...matches].reverse().find((match) => match.selected.length) || { selected: [], tier: null };
}

export function calculateGroupDemandForecast({ stayDate, currentOtb, historicalRows = [], events = [], selectedHistoricalYears, config = GROUP_FORECAST_CONFIG }) {
  const currentGroupOtb = Math.max(0, number(currentOtb?.groupRooms) ?? 0);
  const currentSellableInventory = number(currentOtb?.calculatedInventoryRooms);
  const targetCalendarFeatures = calendarFeatures(stayDate, events);
  const selectedYearSet = Array.isArray(selectedHistoricalYears) ? new Set(selectedHistoricalYears.map(Number)) : null;
  const history = prepareGroupHistory(historicalRows, events).filter((item) => !selectedYearSet || selectedYearSet.has(Number(item.stayDate.slice(0, 4))));
  const match = selectGroupComparables(stayDate, history, targetCalendarFeatures, config);
  const comparables = currentSellableInventory > 0 ? match.selected.map((item) => ({
    ...item, normalizedGroupRooms: item.groupShare * currentSellableInventory,
    dayOfWeek: date(item.stayDate).toLocaleDateString("en", { weekday: "short", timeZone: "UTC" }),
    calendarContext: item.calendarFeatures.isNormalGroupBusiness ? "Normal group business" : item.calendarFeatures.activeSystemTypes.join(", "),
  })) : [];
  const shares = match.selected.map((item) => item.groupShare);
  const rooms = comparables.map((item) => item.normalizedGroupRooms);
  const p25Rooms = percentile(rooms, .25), p50Rooms = percentile(rooms, .5), p75Rooms = percentile(rooms, .75);
  const floor = (value) => value === null ? null : Math.max(currentGroupOtb, value);
  const forecastLow = floor(p25Rooms), forecastBase = floor(p50Rooms), forecastHigh = floor(p75Rooms);
  let confidence = "LOW";
  if (match.tier === "TIER_1_SAME_DOW_MONTH_CALENDAR" && comparables.length >= config.strongSample) confidence = "HIGH";
  else if (match.tier && !match.tier.startsWith("TIER_5") && comparables.length >= config.preferredSample) confidence = "MEDIUM";
  const warnings = ["Group pace adjustment is not available yet; forecast is based on historical final group demand.", "Forecast represents expected realized group demand, not unconstrained inquiry demand."];
  if (comparables.length < config.preferredSample) warnings.unshift("Limited historical group sample.");
  if (selectedYearSet && comparables.length < config.preferredSample) warnings.unshift("Historical group sample is limited by the selected analysis years.");
  if (match.tier && !match.tier.startsWith("TIER_1") && !match.tier.startsWith("TIER_2")) warnings.unshift("Exact calendar-context comparables were unavailable; a broader seasonal sample was used.");
  if (!targetCalendarFeatures.activeEventIds.length) warnings.unshift("No Demand Calendar context was available for this stay date.");
  if (p75Rooms !== null && currentGroupOtb > p75Rooms) warnings.unshift("Current Group OTB already exceeds historical P75 final demand.");
  return {
    stayDate, currentGroupOtb, currentSellableInventory: currentSellableInventory > 0 ? currentSellableInventory : 0,
    forecastLow, forecastBase, forecastHigh,
    remainingPotentialLow: forecastLow === null ? null : Math.max(0, forecastLow - currentGroupOtb),
    remainingPotentialBase: forecastBase === null ? null : Math.max(0, forecastBase - currentGroupOtb),
    remainingPotentialHigh: forecastHigh === null ? null : Math.max(0, forecastHigh - currentGroupOtb),
    historicalP25GroupShare: percentile(shares, .25), historicalP50GroupShare: percentile(shares, .5), historicalP75GroupShare: percentile(shares, .75),
    historicalP25GroupRooms: p25Rooms, historicalP50GroupRooms: p50Rooms, historicalP75GroupRooms: p75Rooms,
    sampleSize: comparables.length, comparableTier: match.tier, selectedHistoricalDates: comparables.map((item) => item.stayDate), selectedHistoricalYears: selectedYearSet ? [...selectedYearSet] : null,
    comparables, targetCalendarFeatures, confidence, method: GROUP_FORECAST_METHOD, paceAdjustmentApplied: false, warnings,
  };
}

const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
export function backtestGroupDemandForecast({ historicalRows = [], events = [], config = GROUP_FORECAST_CONFIG }) {
  const eligible = prepareGroupHistory(historicalRows, events);
  const observations = eligible.flatMap((target) => {
    const result = calculateGroupDemandForecast({ stayDate: target.stayDate, currentOtb: { groupRooms: 0, calculatedInventoryRooms: target.sellableInventory }, historicalRows, events, config });
    if (result.forecastBase === null) return [];
    const signedError = result.forecastBase - target.finalGroupRooms;
    return [{ targetDate: target.stayDate, actualGroupRooms: target.finalGroupRooms, forecastP25: result.forecastLow, forecastP50: result.forecastBase, forecastP75: result.forecastHigh, absoluteError: Math.abs(signedError), signedError, selectionTier: result.comparableTier, sampleSize: result.sampleSize, confidence: result.confidence, calendarContext: result.targetCalendarFeatures.calendarRegime, month: target.stayDate.slice(5, 7), dayOfWeek: date(target.stayDate).getUTCDay(), businessSeason: getBusinessSeason(target.stayDate) }];
  });
  const errors = observations.map((item) => item.signedError);
  const summarize = (items) => ({ sampleCount: items.length, mae: mean(items.map((item) => item.absoluteError)), medianAbsoluteError: percentile(items.map((item) => item.absoluteError), .5), bias: mean(items.map((item) => item.signedError)), rmse: items.length ? Math.sqrt(mean(items.map((item) => item.signedError ** 2))) : null, intervalCoverage: items.length ? items.filter((item) => item.actualGroupRooms >= item.forecastP25 && item.actualGroupRooms <= item.forecastP75).length / items.length : null });
  const breakdown = (key) => Object.fromEntries([...new Set(observations.map((item) => String(item[key])))].map((value) => [value, summarize(observations.filter((item) => String(item[key]) === value))]));
  return { ...summarize(observations), observations, breakdown: { month: breakdown("month"), dayOfWeek: breakdown("dayOfWeek"), businessSeason: breakdown("businessSeason"), calendarRegime: breakdown("calendarContext") }, errorCount: errors.length };
}
