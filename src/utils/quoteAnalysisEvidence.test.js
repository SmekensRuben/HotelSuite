import { describe, expect, it } from "vitest";
import { calculateGroupContribution } from "./contributionAnalysis";
import { freezeContributionEvidence, losAnalysisFallback } from "./quoteAnalysisEvidence";

describe("frozen contribution evidence", () => {
  it("retains both optimized portfolios, unknowns, scenario assumptions and price contracts", () => {
    const result = calculateGroupContribution({
      quote: { quoteInputSchemaVersion: "group-quote-v3-meal-basis", groupCommissionPercentage: 0, roomsByDate: [{ date: "2027-05-01", rooms: 20, breakfastPax: 0, bqtRevenue: 0, mealBasis: "RO" }] },
      settings: { variableRoomCost: 0, breakfastCostPerPerson: 0, transientAverageBreakfastPax: 0, transientAverageBreakfastRevenuePerPax: 0, bqtContributionMarginPercentage: 0, transientDistributionCostPercentage: 0, defaultGroupCommissionPercentage: 0, roomVatPercentage: 0 },
      forecastByDate: { "2027-05-01": { sellableInventory: 100, currentTransientOtb: 0, existingGroupOtb: 0, hardOtherCommittedRooms: 0, transientDemandForecast: 90, expectedTransientRoomRate: 200, groupForecast: { forecastLow: 100, forecastBase: 100, forecastHigh: 100, comparables: [{ stayDate: "2026-05-01", finalGroupRooms: 100, groupRevenueDeductible: 10000, sellableInventory: 100 }] }, currentDeductibleGroupRevenue: 0 } },
    });
    const frozen = freezeContributionEvidence(result);
    expect(frozen.totalLostContribution).toBe(3000);
    expect(frozen.snapshotVersion).toBe("group-quote-contribution-snapshot-v2");
    expect(frozen.nightly[0].scenarios.base.portfolioWithoutGroup).toEqual(result.nightly[0].scenarios.base.portfolioWithoutGroup);
    expect(frozen.nightly[0].scenarios.base.portfolioWithGroup).toEqual(result.nightly[0].scenarios.base.portfolioWithGroup);
    expect(frozen).toMatchObject({ groupCommission: 0, roomVatPercentage: 0, groupVariableRoomCosts: 0 });
    result.nightly[0].scenarios.base.portfolioWithoutGroup.accepted.TRANSIENT = 999;
    expect(frozen.nightly[0].scenarios.base.portfolioWithoutGroup.accepted.TRANSIENT).not.toBe(999);
    expect(freezeContributionEvidence({ economicFloorRateInclVat: null, nightly: [{ value: NaN }] })).toMatchObject({ economicFloorRateInclVat: null, nightly: [{ value: null }] });
    expect(freezeContributionEvidence({ validationError: "Missing source" })).toBeNull();
  });
  it("records LOS errors as an inactive, explicit fallback without hiding its reason", () => {
    expect(losAnalysisFallback("los-v2", "LOS_HORIZON_CALCULATION_FAILED", { error: "Missing required night" })).toMatchObject({ active: false, modelVersion: "los-v2", warningCode: "LOS_NETWORK_FALLBACK_TO_STAY_DATE", fallbackReason: "LOS_HORIZON_CALCULATION_FAILED", error: "Missing required night" });
  });
});
