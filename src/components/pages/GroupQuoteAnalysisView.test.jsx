import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import GroupQuoteAnalysisView from "./GroupQuoteAnalysisView";

const forecast = { stayDate: "2027-04-03", transientDemandForecast: 113, forecastConfidence: "HIGH", historicalSelectedCount: 8, historicalSelectionTier: "DOW", historicalYears: [2026], lighthouseMarketModifier: 1, currentTransientOtb: 30, warnings: [], historicalTransientAdrObservations: [{ date: "2026-04-04", individualRooms: 100, individualRevenueDeductible: 20000, rawTransientAdrExVat: 200, inflationAdjustedTransientAdrExVat: 205 }] };
const group = { stayDate: "2027-04-03", forecastBase: 22, confidence: "MEDIUM", sampleSize: 6, currentGroupOtb: 5, historicalP25GroupRooms: 10, historicalP50GroupRooms: 20, historicalP75GroupRooms: 30, remainingPotentialBase: 17, comparableTier: "DOW", targetCalendarFeatures: { calendarRegime: ["NORMAL"] }, comparables: [{ stayDate: "2026-04-04", dayOfWeek: "SAT", calendarContext: "NORMAL", finalGroupRooms: 20, sellableInventory: 200 }] };
const night = { stayDate: "2027-04-03", mealBasis: "BB", breakfastPax: 20, requestedGroupRooms: 100, finalTransientDemandForecast: 113, futureGroupDemandBase: 17, sellableInventory: 200, capacityConflictRooms: 0, historicalComparableTransientAdrExVat: 200, currentTransientOtbAdrExVat: 210, expectedFutureTransientRoomRateExVat: 209.64, transientRoomContributionPerRoom: 180, transientBreakfastContributionPerRoom: 5, futureTransientContributionPerRoom: 185, transientValueConfidence: "HIGH", historicalTransientAdrEvidenceCount: 8, historicalTransientAdrObservations: forecast.historicalTransientAdrObservations, historicalComparableGroupAdrExVat: 190, currentExistingGroupAdrExVat: 195, expectedFutureGroupRoomRateExVat: 195, expectedFutureGroupCommission: .1, futureGroupContributionPerRoom: 165, futureGroupValueConfidence: "MEDIUM", historicalAdrEvidenceCount: 5, historicalGroupAdrObservations: [{ date: "2026-04-04", groupRooms: 20, groupRevenueDeductible: 3800, rawGroupAdrExVat: 190, inflationAdjustedGroupAdrExVat: 195 }], scenarios: { base: { totalDisplacedFutureRooms: 64, displacedFutureTransientRooms: 50, displacedFutureGroupRooms: 14, nonDisplacingGroupRooms: 36, totalLostContribution: 1000 } } };
const contribution = { economicFloorRateInclVat: 176, economicFloorRateExVat: 160, totalRequestedGroupRoomNights: 100, totalDisplacedRooms: 64, totalNonDisplacingGroupRooms: 36, scenarioTotals: { base: { displacedFutureTransientRooms: 50, displacedFutureGroupRooms: 14 } }, totalLostFutureTransientContribution: 800, totalLostFutureGroupContribution: 200, totalLostContribution: 1000, groupVariableRoomCosts: 300, groupBreakfastCosts: 100, bqtContribution: 0, requiredRoomRevenueAfterCostsExVat: 1400, groupCommission: .1, requiredCommissionableRoomRevenueExVat: 1555, roomVatPercentage: 10, warningDetails: [], nightly: [night] };
const guidance = { targetRateInclVat: 239, stretchRateInclVat: 255, proposedRateMealBasis: "BB", displacementRatio: .64, marketAnchorInclVat: 263, weightedMarketDemand: .93, confidence: "HIGH", warnings: [{ code: "PUBLIC_MARKET_PRODUCT_NOT_NORMALIZED", message: "Public market product not normalized" }, { code: "ECONOMIC_FLOOR_ABOVE_MARKET", message: "Economic Floor above market" }] };
const market = { groupStaySummary: { weightedOwnPublicRateInclVat: 244, weightedMarketReferenceInclVat: 263, weightedCompsetMedianInclVat: 260, rateCoverage: .85, weightedSoldOutWeightShare: .15, weightedPlaceholderWeightShare: 0 }, stayDates: [{ stayDate: "2027-04-03", ownPublicRateInclVat: 244, weightedCompsetReferenceInclVat: 263, marketDemand: .93, coverage: .85, soldOutWeightShare: .15, competitors: [{ competitorId: "c", displayName: "Comp Hotel", availabilityStatus: "SOLD_OUT", configuredWeight: 1, normalizedEffectiveWeight: 0 }] }] };
const props = { contribution, forecastData: { byDate: { "2027-04-03": forecast } }, groupForecastData: { byDate: { "2027-04-03": group } }, marketContextSnapshot: market, pricingGuidance: guidance, quoteSettings: { transientDistributionCostPercentage: 10 }, testGroupRate: "", setTestGroupRate: vi.fn(), simulation: null, targetSimulation: { netIncrementalContribution: 3840 }, forecastLoading: false };

describe("GroupQuoteAnalysisView hierarchy", () => {
  it("makes Target primary while preserving the unchanged quote corridor and decision values", () => {
    render(<GroupQuoteAnalysisView {...props} />);
    const decision = screen.getByRole("heading", { name: "Commercial Decision" }).closest("section, [aria-labelledby]");
    expect(within(decision).getByText("Target Rate").parentElement).toHaveClass("border-[#b41f1f]");
    expect(within(decision).getByText("€239.00")).toBeVisible();
    expect(within(decision).getByText("€255.00")).toBeVisible();
    expect(within(decision).getByText("€176.00")).toBeVisible();
    expect(within(decision).getByText("64.0%")).toBeVisible();
    expect(within(decision).getByText("€263.00")).toBeVisible();
    screen.getAllByText("€209.64", { exact: false }).forEach((element) => expect(element).not.toBeVisible());
  });

  it("collapses simulator, diagnostics, comparables and competitor intelligence by default", () => {
    render(<GroupQuoteAnalysisView {...props} />);
    expect(screen.getByText("Test another rate").parentElement).not.toHaveAttribute("open");
    const diagnostics = screen.getByText("Model Diagnostics", { exact: false }).closest("details");
    expect(diagnostics).not.toHaveAttribute("open");
    expect(screen.getByText("Comp Hotel")).not.toBeVisible();
    fireEvent.click(screen.getByText("Model Diagnostics", { exact: false }));
    for (const label of ["Transient Demand", "Group Demand", "Transient Value", "Future Group Value"]) expect(screen.getByText(label)).toBeVisible();
    const transientDemand = screen.getByText("Transient Demand").closest("details");
    fireEvent.click(within(transientDemand).getByText("Transient Demand"));
    expect(within(transientDemand).getByText("Historical selection tier")).toBeVisible();
    expect(within(transientDemand).getByText("View 1 historical ADR observations")).toBeVisible();
    expect(within(transientDemand).getByText("2026-04-04")).not.toBeVisible();
  });

  it("keeps critical warnings visible and summarizes informational notes", () => {
    render(<GroupQuoteAnalysisView {...props} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Action required");
    expect(screen.getByText(/1 modelling note/)).toBeVisible();
    expect(screen.getByText("Public market product not normalized")).not.toBeVisible();
  });
});
