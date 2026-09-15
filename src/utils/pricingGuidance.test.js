import { describe, expect, it } from "vitest";
import { calculatePricingGuidance, DEFAULT_PRICING_STRATEGY, deriveQuoteMealBasis, determineYieldBand, selectMarketAnchor } from "./pricingGuidance";

const market = { weightedMarketReferenceInclVat: 250, weightedCompsetMedianInclVat: 245, weightedOwnPublicRateInclVat: 260, rateCoverage: 1, weightedMarketDemand: .7, weightedSoldOutWeightShare: 0, marketPricingConfidence: "HIGH" };

describe("Pricing Guidance V1", () => {
  it.each([[.1, "LOW"], [.45, "MEDIUM"], [.8, "HIGH"]])("maps displacement %s to %s", (ratio, band) => expect(determineYieldBand(ratio, DEFAULT_PRICING_STRATEGY)).toBe(band));

  it("uses weighted reference with usable coverage, then median, then own rate", () => {
    expect(selectMarketAnchor(market).source).toBe("WEIGHTED_COMPSET_REFERENCE");
    expect(selectMarketAnchor({ ...market, rateCoverage: .5 }).value).toBe(245);
    expect(selectMarketAnchor({ weightedOwnPublicRateInclVat: 260 }).value).toBe(260);
  });

  it("calculates unrounded raw target/stretch then applies the final euro step", () => {
    const result = calculatePricingGuidance({ economicFloorRateInclVat: 176.2, totalDisplacedRoomNights: 45, requestedRoomNights: 100, marketSummary: { ...market, weightedMarketReferenceInclVat: 263 }, breakfastPax: 20 });
    expect(result.rawTargetRateInclVat).toBeCloseTo(236.7);
    expect(result.rawStretchRateInclVat).toBeCloseTo(255.11);
    expect(result.targetRateInclVat).toBe(237);
    expect(result.stretchRateInclVat).toBe(255);
    expect(result.proposedRateMealBasis).toBe("LEGACY_UNKNOWN");
  });

  it("protects the floor above market and emits the prominent warning", () => {
    const result = calculatePricingGuidance({ economicFloorRateInclVat: 240, totalDisplacedRoomNights: 45, requestedRoomNights: 100, marketSummary: { ...market, weightedMarketReferenceInclVat: 220 } });
    expect(result.rawTargetRateInclVat).toBe(198);
    expect(result.targetRateInclVat).toBe(240);
    expect(result.stretchRateInclVat).toBe(240);
    expect(result.warnings.map((item) => item.code)).toContain("ECONOMIC_FLOOR_ABOVE_MARKET");
  });

  it("adds high-demand and sold-out uplifts as percentage points and caps at 100%", () => {
    const result = calculatePricingGuidance({ economicFloorRateInclVat: 100, totalDisplacedRoomNights: 45, requestedRoomNights: 100, marketSummary: { ...market, weightedMarketDemand: .8, weightedSoldOutWeightShare: .2 } });
    expect(result.targetCapture).toBeCloseTo(.94);
    expect(result.stretchCapture).toBe(1);
    expect(result.demandAdjustment).toBe(.02);
    expect(result.soldOutAdjustment).toBe(.02);
  });

  it("does not treat LOS restriction as sold-out pressure and never mutates the floor", () => {
    const baseline = calculatePricingGuidance({ economicFloorRateInclVat: 184.123, totalDisplacedRoomNights: 10, requestedRoomNights: 100, marketSummary: market });
    const changedMarket = calculatePricingGuidance({ economicFloorRateInclVat: 184.123, totalDisplacedRoomNights: 10, requestedRoomNights: 100, marketSummary: { ...market, weightedMarketDemand: .99, weightedSoldOutWeightShare: 0, weightedRestrictedWeightShare: 1, weightedMarketReferenceInclVat: 400 } });
    expect(changedMarket.soldOutAdjustment).toBe(0);
    expect(changedMarket.targetRateInclVat).not.toBe(baseline.targetRateInclVat);
    expect(changedMarket.economicFloorRateInclVat).toBe(184.123);
    expect(baseline.economicFloorRateInclVat).toBe(184.123);
  });

  it("returns unavailable guidance without a floor or market anchor", () => {
    expect(calculatePricingGuidance({ economicFloorRateInclVat: null, totalDisplacedRoomNights: 0, requestedRoomNights: 1, marketSummary: market }).confidence).toBe("UNAVAILABLE");
    expect(calculatePricingGuidance({ economicFloorRateInclVat: 100, totalDisplacedRoomNights: 0, requestedRoomNights: 1, marketSummary: {} }).targetRateInclVat).toBeNull();
  });
});


describe("commercial meal basis", () => {
  it("derives RO, BB and MIXED without inferring pax from rooms", () => {
    expect(deriveQuoteMealBasis([{ breakfastPax: 0 }, { breakfastPax: 0 }])).toBe("RO");
    expect(deriveQuoteMealBasis([{ breakfastPax: 50 }, { breakfastPax: 80 }])).toBe("BB");
    expect(deriveQuoteMealBasis([{ breakfastPax: 0 }, { breakfastPax: 50 }])).toBe("MIXED");
  });
});
