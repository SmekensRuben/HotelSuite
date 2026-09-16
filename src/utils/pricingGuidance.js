import { deriveExplicitQuoteMealBasis, getMealBasisDataQualityWarnings } from "../constants/groupMealBasis";

export const PRICING_GUIDANCE_MODEL_VERSION = "pricing-guidance-v1";

export const DEFAULT_PRICING_STRATEGY = Object.freeze({
  lowDisplacementUpperBound: 0.25,
  highDisplacementLowerBound: 0.65,
  targetMarketCaptureLow: 0.80,
  targetMarketCaptureMedium: 0.90,
  targetMarketCaptureHigh: 0.97,
  stretchMarketCaptureLow: 0.90,
  stretchMarketCaptureMedium: 0.97,
  stretchMarketCaptureHigh: 1.00,
  highMarketDemandThreshold: 0.80,
  highMarketDemandCaptureUplift: 0.02,
  soldOutWeightThreshold: 0.20,
  soldOutCaptureUplift: 0.02,
  recommendedRateRoundingStep: 1,
});

export const PRICING_WARNINGS = Object.freeze({
  PUBLIC_MARKET_PRODUCT_NOT_NORMALIZED: "Public market rates may differ from the group quote in meal basis, occupancy, room type and booking conditions.",
  ECONOMIC_FLOOR_ABOVE_MARKET: "Expected economic floor is above the current public market reference. The group may not be commercially attractive at prevailing market pricing.",
  RECOMMENDATION_ABOVE_OWN_PUBLIC_RATE: "Suggested group pricing exceeds the current own public rate; verify product and meal-basis comparability.",
});

const validNumber = (value) => value !== null && value !== undefined && Number.isFinite(Number(value));
const capCapture = (value) => Math.min(1, Math.max(0, value));
const roundToStep = (value, step) => step > 0 ? Math.round(value / step) * step : value;

export function normalizePricingStrategy(strategy = {}) {
  const normalized = Object.fromEntries(Object.entries(DEFAULT_PRICING_STRATEGY).map(([key, fallback]) => [key, validNumber(strategy[key]) ? Number(strategy[key]) : fallback]));
  if (normalized.lowDisplacementUpperBound < 0 || normalized.highDisplacementLowerBound < normalized.lowDisplacementUpperBound) throw new Error("Displacement yield-band thresholds are invalid.");
  for (const [key, value] of Object.entries(normalized)) if (value < 0) throw new Error(`${key} must be zero or greater.`);
  return normalized;
}

export function determineYieldBand(displacementRatio, strategy = DEFAULT_PRICING_STRATEGY) {
  if (!validNumber(displacementRatio)) return "UNAVAILABLE";
  if (displacementRatio <= strategy.lowDisplacementUpperBound) return "LOW";
  if (displacementRatio >= strategy.highDisplacementLowerBound) return "HIGH";
  return "MEDIUM";
}

export function deriveQuoteMealBasis(roomsByDate = [], legacyBreakfastPax) {
  return deriveExplicitQuoteMealBasis(roomsByDate, legacyBreakfastPax);
}

export function selectMarketAnchor(summary = {}) {
  if (validNumber(summary.weightedMarketReferenceInclVat) && Number(summary.rateCoverage) >= 0.6) return { value: Number(summary.weightedMarketReferenceInclVat), source: "WEIGHTED_COMPSET_REFERENCE" };
  if (validNumber(summary.weightedCompsetMedianInclVat)) return { value: Number(summary.weightedCompsetMedianInclVat), source: "COMPSET_MEDIAN" };
  if (validNumber(summary.weightedOwnPublicRateInclVat)) return { value: Number(summary.weightedOwnPublicRateInclVat), source: "OWN_PUBLIC_RATE" };
  return { value: null, source: "UNAVAILABLE" };
}

export function calculatePricingGuidance({ economicFloorRateInclVat, totalDisplacedRoomNights, requestedRoomNights, marketSummary = {}, roomsByDate = [], breakfastPax = 0, strategy: inputStrategy = {} }) {
  const strategy = normalizePricingStrategy(inputStrategy);
  const floor = validNumber(economicFloorRateInclVat) ? Number(economicFloorRateInclVat) : null;
  const displacementRatio = Number(requestedRoomNights) > 0 ? Math.max(0, Number(totalDisplacedRoomNights) || 0) / Number(requestedRoomNights) : null;
  const yieldBand = determineYieldBand(displacementRatio, strategy);
  const anchor = selectMarketAnchor(marketSummary);
  const suffix = yieldBand === "UNAVAILABLE" ? null : yieldBand[0] + yieldBand.slice(1).toLowerCase();
  const baseTargetCapture = suffix ? strategy[`targetMarketCapture${suffix}`] : null;
  const baseStretchCapture = suffix ? strategy[`stretchMarketCapture${suffix}`] : null;
  const demandAdjustment = validNumber(marketSummary.weightedMarketDemand) && marketSummary.weightedMarketDemand >= strategy.highMarketDemandThreshold ? strategy.highMarketDemandCaptureUplift : 0;
  const soldOutAdjustment = validNumber(marketSummary.weightedSoldOutWeightShare) && marketSummary.weightedSoldOutWeightShare >= strategy.soldOutWeightThreshold ? strategy.soldOutCaptureUplift : 0;
  const targetCapture = baseTargetCapture === null ? null : capCapture(baseTargetCapture + demandAdjustment + soldOutAdjustment);
  const stretchCapture = baseStretchCapture === null ? null : capCapture(baseStretchCapture + demandAdjustment + soldOutAdjustment);
  const rawTargetRateInclVat = anchor.value === null || targetCapture === null ? null : anchor.value * targetCapture;
  const rawStretchRateInclVat = anchor.value === null || stretchCapture === null ? null : anchor.value * stretchCapture;
  const unroundedTargetRateInclVat = floor === null || rawTargetRateInclVat === null ? null : Math.max(floor, rawTargetRateInclVat);
  const unroundedStretchRateInclVat = unroundedTargetRateInclVat === null || rawStretchRateInclVat === null ? null : Math.max(unroundedTargetRateInclVat, rawStretchRateInclVat);
  const targetRateInclVat = unroundedTargetRateInclVat === null ? null : Math.max(floor, roundToStep(unroundedTargetRateInclVat, strategy.recommendedRateRoundingStep));
  const stretchRateInclVat = unroundedStretchRateInclVat === null ? null : Math.max(targetRateInclVat, roundToStep(unroundedStretchRateInclVat, strategy.recommendedRateRoundingStep));
  const warnings = [{ code: "PUBLIC_MARKET_PRODUCT_NOT_NORMALIZED", message: PRICING_WARNINGS.PUBLIC_MARKET_PRODUCT_NOT_NORMALIZED }, ...getMealBasisDataQualityWarnings(roomsByDate)];
  if (floor !== null && anchor.value !== null && floor > anchor.value) warnings.push({ code: "ECONOMIC_FLOOR_ABOVE_MARKET", message: PRICING_WARNINGS.ECONOMIC_FLOOR_ABOVE_MARKET });
  if (validNumber(marketSummary.weightedOwnPublicRateInclVat) && ((targetRateInclVat ?? -Infinity) > marketSummary.weightedOwnPublicRateInclVat || (stretchRateInclVat ?? -Infinity) > marketSummary.weightedOwnPublicRateInclVat)) warnings.push({ code: "RECOMMENDATION_ABOVE_OWN_PUBLIC_RATE", message: PRICING_WARNINGS.RECOMMENDATION_ABOVE_OWN_PUBLIC_RATE });
  const confidence = floor === null || anchor.value === null ? "UNAVAILABLE" : ["HIGH", "MEDIUM", "LOW"].includes(marketSummary.marketPricingConfidence) ? marketSummary.marketPricingConfidence : "LOW";
  return { version: PRICING_GUIDANCE_MODEL_VERSION, strategy: { ...strategy }, economicFloorRateInclVat: floor, marketAnchorInclVat: anchor.value, marketAnchorSource: anchor.source, displacementRatio, yieldBand, weightedMarketDemand: marketSummary.weightedMarketDemand ?? null, weightedSoldOutWeightShare: marketSummary.weightedSoldOutWeightShare ?? null, baseTargetCapture, baseStretchCapture, demandAdjustment, soldOutAdjustment, targetCapture, stretchCapture, rawTargetRateInclVat, rawStretchRateInclVat, targetRateInclVat, stretchRateInclVat, proposedRateMealBasis: deriveQuoteMealBasis(roomsByDate, breakfastPax), confidence, warnings };
}
