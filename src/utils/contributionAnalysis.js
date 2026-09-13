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
  const nightly = (quote.roomsByDate || []).map((roomNight) => {
    const forecast = forecastByDate[roomNight.date] || {};
    const requestedGroupRooms = Math.max(0, number(roomNight.rooms) || 0);
    const displacedRooms = Math.max(0, number(forecast.displacedRooms) || 0);
    const nonDisplacingGroupRooms = Math.max(0, number(forecast.nonDisplacingGroupRooms) || (requestedGroupRooms - displacedRooms));
    const expectedTransientRoomRate = Number.isFinite(forecast.expectedTransientRoomRate) && forecast.expectedTransientRoomRate > 0
      ? forecast.expectedTransientRoomRate : null;
    const contributionWarnings = [];
    if (expectedTransientRoomRate === null && displacedRooms > 0) contributionWarnings.push(`Historical ADR is missing for ${roomNight.date}; lost transient contribution is unavailable.`);
    const transientDistributionCostPerRoom = expectedTransientRoomRate === null ? null : expectedTransientRoomRate * values.transientDistributionCost;
    const transientRoomContributionPerRoom = expectedTransientRoomRate === null ? null : expectedTransientRoomRate - transientDistributionCostPerRoom - values.variableRoomCost;
    const transientContributionPerDisplacedRoom = expectedTransientRoomRate === null ? null : transientRoomContributionPerRoom + transientBreakfastContributionPerRoom;
    const lostTransientContribution = displacedRooms === 0 ? 0 : transientContributionPerDisplacedRoom === null ? null : displacedRooms * transientContributionPerDisplacedRoom;
    return { stayDate: roomNight.date, requestedGroupRooms, displacedRooms, nonDisplacingGroupRooms, expectedTransientRoomRate, transientDistributionCostPerRoom, transientRoomContributionPerRoom, transientBreakfastContributionPerRoom, transientContributionPerDisplacedRoom, lostTransientContribution, contributionWarnings };
  });
  const totalRequestedGroupRoomNights = nightly.reduce((sum, night) => sum + night.requestedGroupRooms, 0);
  const totalDisplacedRooms = nightly.reduce((sum, night) => sum + night.displacedRooms, 0);
  const totalNonDisplacingGroupRooms = nightly.reduce((sum, night) => sum + night.nonDisplacingGroupRooms, 0);
  const missingRequiredAdr = nightly.some((night) => night.displacedRooms > 0 && night.lostTransientContribution === null);
  const totalLostTransientContribution = missingRequiredAdr ? null : nightly.reduce((sum, night) => sum + night.lostTransientContribution, 0);
  const groupVariableRoomCosts = totalRequestedGroupRoomNights * values.variableRoomCost;
  const breakfastPax = Math.max(0, number(quote.breakfastPax) || 0);
  const groupBreakfastCosts = breakfastPax * values.breakfastCostPerPerson;
  const totalBqtRevenue = (quote.roomsByDate || []).reduce((sum, night) => sum + Math.max(0, number(night.bqtRevenue) || 0), 0);
  const bqtContribution = totalBqtRevenue * values.bqtContributionMargin;
  const warnings = nightly.flatMap((night) => night.contributionWarnings);
  let requiredNetGroupRoomRevenue = null;
  let requiredGrossGroupRoomRevenue = null;
  let economicFloorRate = null;
  if (totalRequestedGroupRoomNights <= 0) warnings.push("Economic Floor Rate is unavailable because requested group room nights are zero.");
  else if (totalLostTransientContribution === null) warnings.push("Economic Floor Rate is unreliable because required historical ADR data is missing.");
  else {
    requiredNetGroupRoomRevenue = Math.max(0, totalLostTransientContribution + groupVariableRoomCosts + groupBreakfastCosts - bqtContribution);
    requiredGrossGroupRoomRevenue = requiredNetGroupRoomRevenue / (1 - groupCommission);
    economicFloorRate = requiredGrossGroupRoomRevenue / totalRequestedGroupRoomNights;
  }
  return { totalRequestedGroupRoomNights, totalDisplacedRooms, totalNonDisplacingGroupRooms, totalLostTransientContribution, groupVariableRoomCosts, breakfastPax, groupBreakfastCosts, totalBqtRevenue, bqtContributionMargin: values.bqtContributionMargin, bqtContribution, groupCommission, requiredNetGroupRoomRevenue, requiredGrossGroupRoomRevenue, economicFloorRate, nightly, warnings };
}

export function simulateGroupQuote(contribution, testGroupRate) {
  if (contribution.economicFloorRate === null || contribution.totalLostTransientContribution === null) return null;
  const rate = number(testGroupRate);
  if (!Number.isFinite(rate) || rate < 0) return null;
  const testGroupRoomRevenue = rate * contribution.totalRequestedGroupRoomNights;
  const testGroupCommissionCost = testGroupRoomRevenue * contribution.groupCommission;
  const testGroupContribution = testGroupRoomRevenue - testGroupCommissionCost - contribution.groupVariableRoomCosts - contribution.groupBreakfastCosts + contribution.bqtContribution;
  const netIncrementalContribution = testGroupContribution - contribution.totalLostTransientContribution;
  const rateAboveFloor = rate - contribution.economicFloorRate;
  return { testGroupRate: rate, testGroupRoomRevenue, testGroupCommissionCost, testGroupContribution, totalLostTransientContribution: contribution.totalLostTransientContribution, netIncrementalContribution, economicFloorRate: contribution.economicFloorRate, rateAboveFloor, rateAboveFloorPercentage: contribution.economicFloorRate > 0 ? rate / contribution.economicFloorRate - 1 : null };
}
