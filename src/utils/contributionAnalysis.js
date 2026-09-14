import { normalizeRoomVatPercentage, toRoomRateExVat, toRoomRateInclVat } from "./roomRateVat";
import { calculateFutureGroupValue, FUTURE_GROUP_VALUE_WARNINGS } from "./futureGroupValue";

const number = (value) => Number(value);
const WARNING_CODES = new Map([
  ["Future group contribution currently excludes unknown future BQT and breakfast economics.", "FUTURE_GROUP_ECONOMICS_EXCLUDED"],
  [FUTURE_GROUP_VALUE_WARNINGS.LOW_EVIDENCE, "FUTURE_GROUP_VALUE_LOW_EVIDENCE"],
  [FUTURE_GROUP_VALUE_WARNINGS.CURRENT_ONLY, "FUTURE_GROUP_VALUE_CURRENT_ONLY"],
  [FUTURE_GROUP_VALUE_WARNINGS.UNAVAILABLE, "FUTURE_GROUP_VALUE_UNAVAILABLE"],
  ["Future group contribution uses the default group commission because no separate expected future group commission is configured.", "FUTURE_GROUP_COMMISSION_DEFAULT_FALLBACK"],
  ["Group Forecast V1 does not yet use historical booking pace.", "GROUP_PACE_UNAVAILABLE"],
  ["High uncertainty in future group-demand forecast.", "FUTURE_GROUP_LOW_CONFIDENCE"],
  ["Group forecast is based on a limited but contextually relevant historical sample.", "GROUP_SAMPLE_LIMITED"],
  ["Group forecast is based on a very limited historical sample.", "GROUP_SAMPLE_VERY_LIMITED"],
  ["Historical Demand Calendar coverage is incomplete; normal-business matching may include unlabeled event periods.", "CALENDAR_COVERAGE_INCOMPLETE"],
  ["Current group OTB is missing; zero was used as a fallback.", "CURRENT_GROUP_OTB_MISSING"],
  ["Historical group observations above 100% of sellable inventory were excluded.", "INVALID_HISTORICAL_GROUP_SHARE"],
]);

export function aggregateAnalysisWarnings(nightly) {
  const grouped = new Map();
  nightly.forEach((night) => night.contributionWarnings.forEach((message) => {
    const code = WARNING_CODES.get(message) || message.replace(/\d{4}-\d{2}-\d{2}|\d+(?:\.\d+)?/g, "#").replace(/\W+/g, "_").replace(/^_|_$/g, "").toUpperCase();
    const existing = grouped.get(code) || { code, message, stayDates: [] };
    if (!existing.stayDates.includes(night.stayDate)) existing.stayDates.push(night.stayDate);
    grouped.set(code, existing);
  }));
  return [...grouped.values()];
}

export function calculateDemandCapacitySummary(transientForecast = {}, groupForecast = {}) {
  const sellableInventory = Math.max(0, number(transientForecast.sellableInventory) || 0);
  const finalTransientDemandForecast = Math.max(0, number(transientForecast.transientDemandForecast) || 0);
  const expectedFinalGroupDemand = Math.max(0, number(groupForecast.forecastBase) || 0);
  const hardOtherCommittedRooms = Math.max(0, number(transientForecast.hardOtherCommittedRooms) || 0);
  const expectedTotalDemand = finalTransientDemandForecast + expectedFinalGroupDemand + hardOtherCommittedRooms;
  return { sellableInventory, finalTransientDemandForecast, expectedFinalGroupDemand, hardOtherCommittedRooms, expectedTotalDemand, expectedSlack: sellableInventory - expectedTotalDemand };
}

export function normalizeContributionSettings(settings = {}) {
  const futureGroupCommissionConfigured = settings.expectedFutureGroupCommissionPercentage !== null
    && settings.expectedFutureGroupCommissionPercentage !== undefined
    && settings.expectedFutureGroupCommissionPercentage !== "";
  const normalized = {
    variableRoomCost: number(settings.variableRoomCost),
    breakfastCostPerPerson: number(settings.breakfastCostPerPerson),
    transientAverageBreakfastPax: number(settings.transientAverageBreakfastPax),
    transientAverageBreakfastRevenuePerPax: number(settings.transientAverageBreakfastRevenuePerPax),
    bqtContributionMargin: number(settings.bqtContributionMarginPercentage) / 100,
    transientDistributionCost: number(settings.transientDistributionCostPercentage) / 100,
    defaultGroupCommission: number(settings.defaultGroupCommissionPercentage) / 100,
    expectedFutureGroupCommission: number(futureGroupCommissionConfigured ? settings.expectedFutureGroupCommissionPercentage : settings.defaultGroupCommissionPercentage) / 100,
    futureGroupCommissionDefaultFallback: !futureGroupCommissionConfigured,
    inflationPercentage: number(settings.inflationPercentage || 0),
    roomVatPercentage: normalizeRoomVatPercentage(settings.roomVatPercentage),
  };
  const errors = [];
  for (const [field, value] of [
    ["variableRoomCost", normalized.variableRoomCost],
    ["breakfastCostPerPerson", normalized.breakfastCostPerPerson],
    ["transientAverageBreakfastPax", normalized.transientAverageBreakfastPax],
    ["transientAverageBreakfastRevenuePerPax", normalized.transientAverageBreakfastRevenuePerPax],
  ]) if (!Number.isFinite(value) || value < 0) errors.push(`${field} must be zero or greater.`);
  if (!Number.isFinite(normalized.bqtContributionMargin) || normalized.bqtContributionMargin < 0 || normalized.bqtContributionMargin > 1) errors.push("bqtContributionMarginPercentage must be between 0 and 100.");
  if (!Number.isFinite(normalized.transientDistributionCost) || normalized.transientDistributionCost < 0 || normalized.transientDistributionCost >= 1) errors.push("transientDistributionCostPercentage must be at least 0 and less than 100.");
  if (!Number.isFinite(normalized.defaultGroupCommission) || normalized.defaultGroupCommission < 0 || normalized.defaultGroupCommission >= 1) errors.push("defaultGroupCommissionPercentage must be at least 0 and less than 100.");
  if (!Number.isFinite(normalized.expectedFutureGroupCommission) || normalized.expectedFutureGroupCommission < 0 || normalized.expectedFutureGroupCommission >= 1) errors.push("expectedFutureGroupCommissionPercentage must be at least 0 and less than 100.");
  if (errors.length) throw new Error(errors.join(" "));
  return normalized;
}

export function calculateGroupContribution({ quote, forecastByDate = {}, settings = {} }) {
  const values = normalizeContributionSettings(settings);
  const override = quote.groupCommissionPercentage;
  const groupCommission = override === null || override === undefined || override === ""
    ? values.defaultGroupCommission
    : number(override) / 100;
  if (!Number.isFinite(groupCommission) || groupCommission < 0 || groupCommission >= 1) throw new Error("Group commission percentage must be at least 0 and less than 100.");

  const transientBreakfastContributionPerRoom = values.transientAverageBreakfastPax
    * (values.transientAverageBreakfastRevenuePerPax - values.breakfastCostPerPerson);
  const calculateScenario = ({ futureTransientDemand, futureGroupDemand, remainingCapacityBeforeNewGroup, requestedGroupRooms, transientValue, groupValue }) => {
    const futureDemandWithoutNewGroup = futureTransientDemand + futureGroupDemand;
    const futureSalesWithoutNewGroup = Math.min(futureDemandWithoutNewGroup, remainingCapacityBeforeNewGroup);
    const remainingCapacityAfterNewGroup = Math.max(0, remainingCapacityBeforeNewGroup - requestedGroupRooms);
    const futureSalesWithNewGroup = Math.min(futureDemandWithoutNewGroup, remainingCapacityAfterNewGroup);
    const totalDisplacedFutureRooms = Math.min(requestedGroupRooms, Math.max(0, futureSalesWithoutNewGroup - futureSalesWithNewGroup));
    const buckets = [
      { type: "GROUP", available: futureGroupDemand, value: groupValue },
      { type: "TRANSIENT", available: futureTransientDemand, value: transientValue },
    ].sort((left, right) => {
      if (left.value === null && right.value !== null) return -1;
      if (right.value === null && left.value !== null) return 1;
      return (left.value ?? 0) - (right.value ?? 0); // GROUP remains first on an exact tie.
    });
    let remaining = totalDisplacedFutureRooms;
    const displaced = { GROUP: 0, TRANSIENT: 0 };
    buckets.forEach((bucket) => { const rooms = Math.min(bucket.available, remaining); displaced[bucket.type] = rooms; remaining -= rooms; });
    const lostFutureTransientContribution = displaced.TRANSIENT === 0 ? 0 : transientValue === null ? null : displaced.TRANSIENT * transientValue;
    const lostFutureGroupContribution = displaced.GROUP === 0 ? 0 : groupValue === null ? null : displaced.GROUP * groupValue;
    const totalLostContribution = lostFutureTransientContribution === null || lostFutureGroupContribution === null ? null : lostFutureTransientContribution + lostFutureGroupContribution;
    return { futureGroupDemand, futureDemandWithoutNewGroup, futureSalesWithoutNewGroup, remainingCapacityAfterNewGroup, futureSalesWithNewGroup, totalDisplacedFutureRooms, displacedFutureTransientRooms: displaced.TRANSIENT, displacedFutureGroupRooms: displaced.GROUP, nonDisplacingGroupRooms: requestedGroupRooms - totalDisplacedFutureRooms, lostFutureTransientContribution, lostFutureGroupContribution, totalLostContribution };
  };
  const nightly = (quote.roomsByDate || []).map((roomNight) => {
    const forecast = forecastByDate[roomNight.date] || {};
    const groupForecast = forecast.groupForecast || {};
    const requestedGroupRooms = Math.max(0, number(roomNight.rooms) || 0);
    const currentTransientOtb = Math.max(0, number(forecast.currentTransientOtb) || 0);
    const currentGroupOtb = Math.max(0, number(forecast.existingGroupOtb) || 0);
    const hardOtherCommittedRooms = Math.max(0, number(forecast.hardOtherCommittedRooms) || 0);
    const sellableInventory = Math.max(0, number(forecast.sellableInventory) || 0);
    const finalTransientDemandForecast = Math.max(currentTransientOtb, number(forecast.transientDemandForecast) || 0);
    const futureTransientDemand = Math.max(0, finalTransientDemandForecast - currentTransientOtb);
    const futureGroupDemandLow = Math.max(0, (number(groupForecast.forecastLow) ?? currentGroupOtb) - currentGroupOtb);
    const futureGroupDemandBase = Math.max(0, (number(groupForecast.forecastBase) ?? currentGroupOtb) - currentGroupOtb);
    const futureGroupDemandHigh = Math.max(0, (number(groupForecast.forecastHigh) ?? currentGroupOtb) - currentGroupOtb);
    const hardCommittedRooms = currentTransientOtb + currentGroupOtb + hardOtherCommittedRooms;
    const physicalCapacityAvailableForNewGroup = Math.max(0, sellableInventory - hardCommittedRooms);
    const capacityConflictRooms = forecast.groupForecast ? Math.max(0, requestedGroupRooms - physicalCapacityAvailableForNewGroup) : 0;
    const remainingCapacityBeforeNewGroup = physicalCapacityAvailableForNewGroup;
    const expectedTransientRoomRate = Number.isFinite(forecast.expectedTransientRoomRate) && forecast.expectedTransientRoomRate > 0
      ? forecast.expectedTransientRoomRate : null;
    const contributionWarnings = [];
    const transientDistributionCostPerRoom = expectedTransientRoomRate === null ? null : expectedTransientRoomRate * values.transientDistributionCost;
    const transientRoomContributionPerRoom = expectedTransientRoomRate === null ? null : expectedTransientRoomRate - transientDistributionCostPerRoom - values.variableRoomCost;
    const transientContributionPerDisplacedRoom = expectedTransientRoomRate === null ? null : transientRoomContributionPerRoom + transientBreakfastContributionPerRoom;
    const pipelineRooms = Math.max(0, number(forecast.groupProspectPipelineRooms) || 0);
    const pipelineRevenue = Math.max(0, number(forecast.groupProspectPipelineRevenue) || 0);
    const existingGroupRevenue = Math.max(0, number(forecast.currentDeductibleGroupRevenue ?? forecast.existingGroupRevenue) || 0);
    const futureGroupValue = calculateFutureGroupValue({
      stayDate: roomNight.date,
      groupForecast,
      inflationPercentage: values.inflationPercentage,
      pipelineRooms,
      pipelineRevenue,
      currentGroupOtb,
      currentDeductibleGroupRevenue: existingGroupRevenue,
      currentDeductibleGroupRevenueSource: forecast.currentDeductibleGroupRevenueSource || (forecast.existingGroupRevenue ? "LEGACY_GROUP_REVENUE" : null),
    });
    const expectedFutureGroupRoomRate = futureGroupValue.expectedFutureGroupRoomRateExVat;
    const futureGroupRateSource = futureGroupValue.futureGroupValueSource;
    const futureGroupContributionPerRoom = expectedFutureGroupRoomRate === null ? null : expectedFutureGroupRoomRate * (1 - values.expectedFutureGroupCommission) - values.variableRoomCost;
    const expectedFutureGroupRoomRateInclVat = toRoomRateInclVat(expectedFutureGroupRoomRate, values.roomVatPercentage);
    contributionWarnings.push(...futureGroupValue.warnings);
    if (values.futureGroupCommissionDefaultFallback) contributionWarnings.push("Future group contribution uses the default group commission because no separate expected future group commission is configured.");
    const makeScenario = (groupDemand) => calculateScenario({ futureTransientDemand, futureGroupDemand: groupDemand, remainingCapacityBeforeNewGroup, requestedGroupRooms, transientValue: transientContributionPerDisplacedRoom, groupValue: futureGroupContributionPerRoom });
    let scenarios = { low: makeScenario(futureGroupDemandLow), base: makeScenario(futureGroupDemandBase), high: makeScenario(futureGroupDemandHigh), transientOnly: makeScenario(0) };
    // Saved analyses created before Future Group Demand do not contain its forecast.
    // Retain their already-calculated transient-only displacement for compatibility.
    if (!forecast.groupForecast) {
      const legacyDisplaced = Math.min(requestedGroupRooms, Math.max(0, number(forecast.displacedRooms) || 0));
      const legacy = { futureGroupDemand: 0, futureDemandWithoutNewGroup: 0, futureSalesWithoutNewGroup: 0, remainingCapacityAfterNewGroup: 0, futureSalesWithNewGroup: 0, totalDisplacedFutureRooms: legacyDisplaced, displacedFutureTransientRooms: legacyDisplaced, displacedFutureGroupRooms: 0, nonDisplacingGroupRooms: requestedGroupRooms - legacyDisplaced, lostFutureTransientContribution: legacyDisplaced === 0 ? 0 : transientContributionPerDisplacedRoom === null ? null : legacyDisplaced * transientContributionPerDisplacedRoom, lostFutureGroupContribution: 0 };
      legacy.totalLostContribution = legacy.lostFutureTransientContribution;
      scenarios = { low: legacy, base: legacy, high: legacy, transientOnly: legacy };
    }
    if (capacityConflictRooms > 0) contributionWarnings.push(`Requested group exceeds currently uncommitted physical capacity by ${capacityConflictRooms} rooms.`);
    if (Object.values(scenarios).some((scenario) => scenario.displacedFutureTransientRooms > 0) && transientContributionPerDisplacedRoom === null) contributionWarnings.push(`Historical ADR is missing for ${roomNight.date}; lost transient contribution is unavailable.`);
    if ([scenarios.low, scenarios.base, scenarios.high].some((scenario) => scenario.displacedFutureGroupRooms > 0) && futureGroupContributionPerRoom === null) contributionWarnings.push(FUTURE_GROUP_VALUE_WARNINGS.UNAVAILABLE);
    if (futureGroupDemandHigh > 0) contributionWarnings.push("Future group contribution currently excludes unknown future BQT and breakfast economics.");
    if (groupForecast.confidence === "LOW") contributionWarnings.push("High uncertainty in future group-demand forecast.");
    ["Group forecast is based on a limited but contextually relevant historical sample.", "Group forecast is based on a very limited historical sample.", "Historical Demand Calendar coverage is incomplete; normal-business matching may include unlabeled event periods.", "Current group OTB is missing; zero was used as a fallback.", "Historical group observations above 100% of sellable inventory were excluded."].forEach((message) => {
      if (groupForecast.warnings?.includes(message)) contributionWarnings.push(message);
    });
    contributionWarnings.push("Group Forecast V1 does not yet use historical booking pace.");
    return { stayDate: roomNight.date, requestedGroupRooms, currentTransientOtb, currentGroupOtb, hardOtherCommittedRooms, hardCommittedRooms, sellableInventory, physicalCapacityAvailableForNewGroup, capacityConflictRooms, finalTransientDemandForecast, futureTransientDemand, futureGroupDemandLow, futureGroupDemandBase, futureGroupDemandHigh, remainingCapacityBeforeNewGroup, expectedTransientRoomRate, transientDistributionCostPerRoom, transientRoomContributionPerRoom, transientBreakfastContributionPerRoom, transientContributionPerDisplacedRoom, futureTransientContributionPerRoom: transientContributionPerDisplacedRoom, ...futureGroupValue, expectedFutureGroupRoomRate, expectedFutureGroupRoomRateExVat: expectedFutureGroupRoomRate, expectedFutureGroupRoomRateInclVat, futureGroupRateSource, expectedFutureGroupCommission: values.expectedFutureGroupCommission, futureGroupCommissionDefaultFallback: values.futureGroupCommissionDefaultFallback, futureGroupContributionPerRoom, scenarios, displacedRooms: scenarios.base.totalDisplacedFutureRooms, nonDisplacingGroupRooms: scenarios.base.nonDisplacingGroupRooms, lostTransientContribution: scenarios.transientOnly.lostFutureTransientContribution, contributionWarnings };
  });
  const totalRequestedGroupRoomNights = nightly.reduce((sum, night) => sum + night.requestedGroupRooms, 0);
  const totalDisplacedRooms = nightly.reduce((sum, night) => sum + night.displacedRooms, 0);
  const totalNonDisplacingGroupRooms = nightly.reduce((sum, night) => sum + night.nonDisplacingGroupRooms, 0);
  const sumScenario = (key, field) => nightly.some((night) => night.scenarios[key][field] === null) ? null : nightly.reduce((sum, night) => sum + night.scenarios[key][field], 0);
  const totalLostTransientContribution = sumScenario("transientOnly", "lostFutureTransientContribution");
  const groupVariableRoomCosts = totalRequestedGroupRoomNights * values.variableRoomCost;
  const breakfastPax = Math.max(0, number(quote.breakfastPax) || 0);
  const groupBreakfastCosts = breakfastPax * values.breakfastCostPerPerson;
  const totalBqtRevenue = (quote.roomsByDate || []).reduce((sum, night) => sum + Math.max(0, number(night.bqtRevenue) || 0), 0);
  const bqtContribution = totalBqtRevenue * values.bqtContributionMargin;
  const warningDetails = aggregateAnalysisWarnings(nightly);
  const warnings = warningDetails.map((warning) => warning.message);
  const floorFor = (key) => {
    const lost = sumScenario(key, "totalLostContribution");
    if (totalRequestedGroupRoomNights <= 0 || lost === null || nightly.some((night) => night.capacityConflictRooms > 0)) return { requiredNet: null, requiredGross: null, floor: null };
    const requiredNet = Math.max(0, lost + groupVariableRoomCosts + groupBreakfastCosts - bqtContribution);
    const requiredGross = requiredNet / (1 - groupCommission);
    return { requiredNet, requiredGross, floor: requiredGross / totalRequestedGroupRoomNights };
  };
  const floors = { low: floorFor("low"), base: floorFor("base"), high: floorFor("high"), transientOnly: floorFor("transientOnly") };
  const floorInclVat = (floor) => toRoomRateInclVat(floor, values.roomVatPercentage);
  if (totalRequestedGroupRoomNights <= 0) warnings.push("Economic Floor Rate is unavailable because requested group room nights are zero.");
  else if (floors.base.floor === null) warnings.push("Adjusted Economic Floor is unavailable because capacity or required contribution value is unavailable.");
  const allWarningDetails = [...warningDetails, ...warnings.filter((message) => !warningDetails.some((warning) => warning.message === message)).map((message) => ({ code: message.replace(/\W+/g, "_").replace(/^_|_$/g, "").toUpperCase(), message, stayDates: [] }))];
  const scenarioTotals = Object.fromEntries(["low", "base", "high"].map((key) => [key, { totalDisplacedRooms: sumScenario(key, "totalDisplacedFutureRooms"), displacedFutureTransientRooms: sumScenario(key, "displacedFutureTransientRooms"), displacedFutureGroupRooms: sumScenario(key, "displacedFutureGroupRooms"), lostFutureTransientContribution: sumScenario(key, "lostFutureTransientContribution"), lostFutureGroupContribution: sumScenario(key, "lostFutureGroupContribution"), totalLostContribution: sumScenario(key, "totalLostContribution"), economicFloorRate: floors[key].floor }]));
  return { totalRequestedGroupRoomNights, totalDisplacedRooms, totalNonDisplacingGroupRooms, totalLostTransientContribution, totalLostContribution: scenarioTotals.base.totalLostContribution, totalLostFutureTransientContribution: scenarioTotals.base.lostFutureTransientContribution, totalLostFutureGroupContribution: scenarioTotals.base.lostFutureGroupContribution, groupVariableRoomCosts, breakfastPax, groupBreakfastCosts, totalBqtRevenue, bqtContributionMargin: values.bqtContributionMargin, bqtContribution, groupCommission, expectedFutureGroupCommission: values.expectedFutureGroupCommission, futureGroupCommissionDefaultFallback: values.futureGroupCommissionDefaultFallback, roomVatPercentage: values.roomVatPercentage, requiredNetGroupRoomRevenue: floors.base.requiredNet, requiredRoomRevenueAfterCostsExVat: floors.base.requiredNet, requiredGrossGroupRoomRevenue: floors.base.requiredGross, requiredCommissionableRoomRevenueExVat: floors.base.requiredGross, economicFloorRate: floors.base.floor, economicFloorRateExVat: floors.base.floor, economicFloorRateInclVat: floorInclVat(floors.base.floor), economicFloorLow: floors.low.floor, economicFloorBase: floors.base.floor, economicFloorHigh: floors.high.floor, economicFloorLowExVat: floors.low.floor, economicFloorBaseExVat: floors.base.floor, economicFloorHighExVat: floors.high.floor, economicFloorLowInclVat: floorInclVat(floors.low.floor), economicFloorBaseInclVat: floorInclVat(floors.base.floor), economicFloorHighInclVat: floorInclVat(floors.high.floor), transientOnlyEconomicFloor: floors.transientOnly.floor, transientOnlyEconomicFloorExVat: floors.transientOnly.floor, transientOnlyEconomicFloorInclVat: floorInclVat(floors.transientOnly.floor), scenarioTotals, nightly, warnings, warningDetails: allWarningDetails };
}

export function simulateGroupQuote(contribution, testGroupRate) {
  if (contribution.economicFloorRateInclVat === null || contribution.totalLostContribution === null) return null;
  const testGroupRateInclVat = number(testGroupRate);
  if (!Number.isFinite(testGroupRateInclVat) || testGroupRateInclVat < 0) return null;
  const testGroupRateExVat = toRoomRateExVat(testGroupRateInclVat, contribution.roomVatPercentage);
  const testGroupRoomRevenueExVat = testGroupRateExVat * contribution.totalRequestedGroupRoomNights;
  const testGroupCommissionCost = testGroupRoomRevenueExVat * contribution.groupCommission;
  const testGroupContribution = testGroupRoomRevenueExVat - testGroupCommissionCost - contribution.groupVariableRoomCosts - contribution.groupBreakfastCosts + contribution.bqtContribution;
  const netIncrementalContribution = testGroupContribution - contribution.totalLostContribution;
  const rateAboveFloor = testGroupRateInclVat - contribution.economicFloorRateInclVat;
  return { testGroupRate: testGroupRateInclVat, testGroupRateInclVat, testGroupRateExVat, testGroupRoomRevenue: testGroupRoomRevenueExVat, testGroupRoomRevenueExVat, testGroupCommissionCost, testGroupContribution, totalLostContribution: contribution.totalLostContribution, totalLostTransientContribution: contribution.totalLostTransientContribution, netIncrementalContribution, economicFloorRate: contribution.economicFloorRateInclVat, economicFloorRateInclVat: contribution.economicFloorRateInclVat, economicFloorRateExVat: contribution.economicFloorRateExVat, rateAboveFloor, rateAboveFloorPercentage: contribution.economicFloorRateInclVat > 0 ? testGroupRateInclVat / contribution.economicFloorRateInclVat - 1 : null };
}
