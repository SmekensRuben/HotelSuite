import { applyInflationAdjustment } from "./quoteAnalysis";
import { median } from "./displacementForecast";

const numeric = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export const FUTURE_GROUP_VALUE_WARNINGS = Object.freeze({
  LOW_EVIDENCE: "Future group value is based on limited group-rate evidence.",
  CURRENT_ONLY: "Future group value is based only on current group-rate signals because no valid historical comparable ADR evidence is available.",
  UNAVAILABLE: "Future group demand is forecast, but no reliable group-rate evidence is available to value displaced future group rooms.",
});

function evidenceSource({ historicalCount, hasExisting }) {
  if (historicalCount && hasExisting) return "HISTORICAL_AND_EXISTING";
  if (historicalCount) return "HISTORICAL_ONLY";
  if (hasExisting) return "EXISTING_ONLY";
  return "UNAVAILABLE";
}

export function calculateFutureGroupValue({
  stayDate,
  groupForecast = {},
  inflationPercentage = 0,
  pipelineRooms,
  pipelineRevenue,
  currentGroupOtb,
  currentDeductibleGroupRevenue,
  currentDeductibleGroupRevenueSource = null,
} = {}) {
  const targetYear = Number(String(stayDate || "").slice(0, 4));
  const historicalGroupAdrObservations = (groupForecast.comparables || []).flatMap((comparable) => {
    const date = comparable.stayDate;
    const rooms = numeric(comparable.finalGroupRooms ?? comparable.groupRooms);
    const revenue = numeric(comparable.groupRevenueDeductible);
    const inventory = numeric(comparable.sellableInventory ?? comparable.calculatedInventoryRooms);
    const historicalYear = Number(String(date || "").slice(0, 4));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "") || date >= stayDate || !(inventory > 0) || !(rooms > 0) || rooms > inventory || !(revenue > 0) || !Number.isFinite(targetYear) || !Number.isFinite(historicalYear)) return [];
    const rawGroupAdrExVat = revenue / rooms;
    return [{
      date,
      groupRooms: rooms,
      groupRevenueDeductible: revenue,
      rawGroupAdrExVat,
      inflationAdjustedGroupAdrExVat: applyInflationAdjustment(rawGroupAdrExVat, inflationPercentage, Math.max(0, targetYear - historicalYear)),
    }];
  });
  const historicalValues = historicalGroupAdrObservations.map((item) => item.inflationAdjustedGroupAdrExVat);
  const historicalComparableGroupAdrExVat = median(historicalValues);

  const parsedPipelineRooms = numeric(pipelineRooms);
  const parsedPipelineRevenue = numeric(pipelineRevenue);
  // Non-deductible prospect revenue has an unknown VAT/package basis. Its rate
  // is useful commercial context, but is not comparable net room ADR evidence.
  const pipelineCommercialRate = parsedPipelineRooms > 0 && parsedPipelineRevenue > 0 ? parsedPipelineRevenue / parsedPipelineRooms : null;
  const parsedCurrentRooms = numeric(currentGroupOtb);
  const parsedCurrentRevenue = numeric(currentDeductibleGroupRevenue);
  const currentExistingGroupAdrExVat = parsedCurrentRooms > 0 && parsedCurrentRevenue > 0 ? parsedCurrentRevenue / parsedCurrentRooms : null;
  const futureGroupAdrEvidenceExVat = [
    ...historicalValues.map((value) => ({ source: "HISTORICAL_COMPARABLE", value })),
    ...(currentExistingGroupAdrExVat === null ? [] : [{ source: "CURRENT_EXISTING_GROUP", value: currentExistingGroupAdrExVat }]),
  ];
  const expectedFutureGroupRoomRateExVat = median(futureGroupAdrEvidenceExVat.map((item) => item.value));
  const historicalAdrEvidenceCount = historicalGroupAdrObservations.length;
  const hasPipelineCommercialRate = pipelineCommercialRate !== null;
  const hasExistingGroupAdrSignal = currentExistingGroupAdrExVat !== null;
  let futureGroupValueConfidence = null;
  if (futureGroupAdrEvidenceExVat.length) {
    if (historicalAdrEvidenceCount >= 5 && hasExistingGroupAdrSignal) futureGroupValueConfidence = "HIGH";
    else if (historicalAdrEvidenceCount >= 3 || (historicalAdrEvidenceCount >= 2 && hasExistingGroupAdrSignal)) futureGroupValueConfidence = "MEDIUM";
    else futureGroupValueConfidence = "LOW";
  }
  const warnings = [];
  if (futureGroupValueConfidence === "LOW") warnings.push(FUTURE_GROUP_VALUE_WARNINGS.LOW_EVIDENCE);
  if (!historicalAdrEvidenceCount && hasExistingGroupAdrSignal) warnings.push(FUTURE_GROUP_VALUE_WARNINGS.CURRENT_ONLY);

  return {
    groupDemandComparableCount: (groupForecast.comparables || []).length,
    historicalGroupAdrObservations,
    historicalAdrEvidenceCount,
    historicalComparableGroupAdrExVat,
    pipelineCommercialRate,
    pipelineCommercialRateBasis: "UNKNOWN_COMMERCIAL_PACKAGE",
    hasPipelineCommercialRate,
    currentExistingGroupAdrExVat,
    currentDeductibleGroupRevenueSource,
    futureGroupAdrEvidenceExVat,
    expectedFutureGroupRoomRateExVat,
    futureGroupValueConfidence,
    futureGroupValueSource: evidenceSource({ historicalCount: historicalAdrEvidenceCount, hasExisting: hasExistingGroupAdrSignal }),
    hasExistingGroupAdrSignal,
    warnings,
  };
}
