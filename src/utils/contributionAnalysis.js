const number = (value) => Number(value);

export function normalizeContributionSettings(settings = {}) {
  const normalized = {
    variableRoomCost: number(settings.variableRoomCost),
    breakfastCostPerPerson: number(settings.breakfastCostPerPerson),
    transientAverageBreakfastPax: number(settings.transientAverageBreakfastPax),
    transientAverageBreakfastRevenuePerPax: number(settings.transientAverageBreakfastRevenuePerPax),
    bqtContributionMargin: number(settings.bqtContributionMarginPercentage) / 100,
    transientDistributionCost: number(settings.transientDistributionCostPercentage) / 100,
    defaultGroupCommission: number(settings.defaultGroupCommissionPercentage) / 100,
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
    const existingGroupRevenue = Math.max(0, number(forecast.existingGroupRevenue) || 0);
    let expectedFutureGroupRoomRate = null, futureGroupRateSource = null;
    if (pipelineRooms > 0 && pipelineRevenue > 0) { expectedFutureGroupRoomRate = pipelineRevenue / pipelineRooms; futureGroupRateSource = "PROSPECT_PIPELINE_ADR"; contributionWarnings.push("Future group contribution uses current prospect pipeline ADR as a room-rate proxy."); }
    else if (currentGroupOtb > 0 && existingGroupRevenue > 0) { expectedFutureGroupRoomRate = existingGroupRevenue / currentGroupOtb; futureGroupRateSource = "EXISTING_GROUP_ADR"; }
    const futureGroupContributionPerRoom = expectedFutureGroupRoomRate === null ? null : expectedFutureGroupRoomRate * (1 - groupCommission) - values.variableRoomCost;
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
    if ([scenarios.low, scenarios.base, scenarios.high].some((scenario) => scenario.displacedFutureGroupRooms > 0) && futureGroupContributionPerRoom === null) contributionWarnings.push("Future group demand is forecast, but no reliable future group rate/value estimate is available.");
    if (futureGroupDemandHigh > 0) contributionWarnings.push("Future group contribution currently excludes unknown future BQT and breakfast economics.");
    if (groupForecast.confidence === "LOW") contributionWarnings.push("High uncertainty in future group-demand forecast.");
    contributionWarnings.push("Group Forecast V1 does not yet use historical booking pace.");
    return { stayDate: roomNight.date, requestedGroupRooms, currentTransientOtb, currentGroupOtb, hardOtherCommittedRooms, hardCommittedRooms, sellableInventory, physicalCapacityAvailableForNewGroup, capacityConflictRooms, finalTransientDemandForecast, futureTransientDemand, futureGroupDemandLow, futureGroupDemandBase, futureGroupDemandHigh, remainingCapacityBeforeNewGroup, expectedTransientRoomRate, transientDistributionCostPerRoom, transientRoomContributionPerRoom, transientBreakfastContributionPerRoom, transientContributionPerDisplacedRoom, futureTransientContributionPerRoom: transientContributionPerDisplacedRoom, expectedFutureGroupRoomRate, futureGroupRateSource, futureGroupContributionPerRoom, scenarios, displacedRooms: scenarios.base.totalDisplacedFutureRooms, nonDisplacingGroupRooms: scenarios.base.nonDisplacingGroupRooms, lostTransientContribution: scenarios.transientOnly.lostFutureTransientContribution, contributionWarnings };
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
  const warnings = nightly.flatMap((night) => night.contributionWarnings);
  const floorFor = (key) => {
    const lost = sumScenario(key, "totalLostContribution");
    if (totalRequestedGroupRoomNights <= 0 || lost === null || nightly.some((night) => night.capacityConflictRooms > 0)) return { requiredNet: null, requiredGross: null, floor: null };
    const requiredNet = Math.max(0, lost + groupVariableRoomCosts + groupBreakfastCosts - bqtContribution);
    const requiredGross = requiredNet / (1 - groupCommission);
    return { requiredNet, requiredGross, floor: requiredGross / totalRequestedGroupRoomNights };
  };
  const floors = { low: floorFor("low"), base: floorFor("base"), high: floorFor("high"), transientOnly: floorFor("transientOnly") };
  if (totalRequestedGroupRoomNights <= 0) warnings.push("Economic Floor Rate is unavailable because requested group room nights are zero.");
  else if (floors.base.floor === null) warnings.push("Adjusted Economic Floor is unavailable because capacity or required contribution value is unavailable.");
  const scenarioTotals = Object.fromEntries(["low", "base", "high"].map((key) => [key, { totalDisplacedRooms: sumScenario(key, "totalDisplacedFutureRooms"), displacedFutureTransientRooms: sumScenario(key, "displacedFutureTransientRooms"), displacedFutureGroupRooms: sumScenario(key, "displacedFutureGroupRooms"), lostFutureTransientContribution: sumScenario(key, "lostFutureTransientContribution"), lostFutureGroupContribution: sumScenario(key, "lostFutureGroupContribution"), totalLostContribution: sumScenario(key, "totalLostContribution"), economicFloorRate: floors[key].floor }]));
  return { totalRequestedGroupRoomNights, totalDisplacedRooms, totalNonDisplacingGroupRooms, totalLostTransientContribution, totalLostContribution: scenarioTotals.base.totalLostContribution, totalLostFutureTransientContribution: scenarioTotals.base.lostFutureTransientContribution, totalLostFutureGroupContribution: scenarioTotals.base.lostFutureGroupContribution, groupVariableRoomCosts, breakfastPax, groupBreakfastCosts, totalBqtRevenue, bqtContributionMargin: values.bqtContributionMargin, bqtContribution, groupCommission, requiredNetGroupRoomRevenue: floors.base.requiredNet, requiredGrossGroupRoomRevenue: floors.base.requiredGross, economicFloorRate: floors.base.floor, economicFloorLow: floors.low.floor, economicFloorBase: floors.base.floor, economicFloorHigh: floors.high.floor, transientOnlyEconomicFloor: floors.transientOnly.floor, scenarioTotals, nightly, warnings };
}

export function simulateGroupQuote(contribution, testGroupRate) {
  if (contribution.economicFloorRate === null || contribution.totalLostContribution === null) return null;
  const rate = number(testGroupRate);
  if (!Number.isFinite(rate) || rate < 0) return null;
  const testGroupRoomRevenue = rate * contribution.totalRequestedGroupRoomNights;
  const testGroupCommissionCost = testGroupRoomRevenue * contribution.groupCommission;
  const testGroupContribution = testGroupRoomRevenue - testGroupCommissionCost - contribution.groupVariableRoomCosts - contribution.groupBreakfastCosts + contribution.bqtContribution;
  const netIncrementalContribution = testGroupContribution - contribution.totalLostContribution;
  const rateAboveFloor = rate - contribution.economicFloorRate;
  return { testGroupRate: rate, testGroupRoomRevenue, testGroupCommissionCost, testGroupContribution, totalLostContribution: contribution.totalLostContribution, totalLostTransientContribution: contribution.totalLostTransientContribution, netIncrementalContribution, economicFloorRate: contribution.economicFloorRate, rateAboveFloor, rateAboveFloorPercentage: contribution.economicFloorRate > 0 ? rate / contribution.economicFloorRate - 1 : null };
}
