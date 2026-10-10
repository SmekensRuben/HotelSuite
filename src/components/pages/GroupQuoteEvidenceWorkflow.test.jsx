import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import GroupQuoteCreatePage from "./GroupQuoteCreatePage";

const mocks = vi.hoisted(() => ({ settings: vi.fn(), history: vi.fn(), compset: vi.fn(), patterns: vi.fn(), add: vi.fn(), combine: vi.fn(), failHorizon: false }));
const input = { name: "Repeated group", requestDate: "2027-01-01", startDate: "2027-05-01", endDate: "2027-05-02", dateRangeSemantics: "CHECKOUT_EXCLUSIVE", quoteInputSchemaVersion: "group-quote-v3-meal-basis", groupCommissionPercentage: 0, roomsByDate: [{ date: "2027-05-01", rooms: 20, breakfastPax: 0, bqtRevenue: 0, mealBasis: "RO" }] };
vi.mock("../../contexts/HotelContext", () => ({ useHotelContext: () => ({ hotelUid: "hotel" }) }));
vi.mock("react-router-dom", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../layout/PageShell", () => ({ default: ({ children }) => <main>{children}</main> }));
vi.mock("./GroupQuoteFormFields", () => ({ default: ({ onSubmit, saving }) => <button disabled={saving} onClick={() => onSubmit(input)}>Analyze</button> }));
vi.mock("./GroupQuoteAnalysisView", () => ({ default: ({ contribution }) => <output>{contribution?.losNetworkDisplacement?.fallbackReason || "Loading evidence"}</output> }));
vi.mock("../../services/firebaseDemandCalendar", () => ({ getDemandCalendarEvents: async () => [] }));
vi.mock("../../services/firebaseQuotes", () => ({
  addQuote: mocks.add, getGroupQuoteSettings: mocks.settings, getHistoryQuoteDates: mocks.history, getCompsetConfiguration: mocks.compset, getStayPatternModelEvidence: mocks.patterns,
  getLatestHistoryForecastSnapshot: async () => ({ snapshotDate: "2027-01-01", coverage: {}, byDate: { "2027-05-01": { calculatedInventoryRooms: 100, individualRooms: 0, groupRooms: 0 } } }),
  getLatestLighthouseSnapshot: async () => null,
  GROUP_QUOTE_ANALYSIS_MODEL_VERSION: "group-contribution-v5-optimal-portfolio", MARKET_CONTEXT_MODEL_VERSION: "market-v1",
}));
vi.mock("../../utils/displacementForecast", async (original) => ({ ...(await original()), calculateDisplacementDay: () => ({ sellableInventory: 100, currentTransientOtb: 0, existingGroupOtb: 0, hardOtherCommittedRooms: 0, transientDemandForecast: 90, expectedTransientRoomRate: 200 }) }));
vi.mock("../../utils/groupDemandForecast", async (original) => ({ ...(await original()), calculateGroupDemandForecast: () => ({ forecastLow: 100, forecastBase: 100, forecastHigh: 100, comparables: [{ stayDate: "2026-05-01", finalGroupRooms: 100, groupRevenueDeductible: 10000, sellableInventory: 100 }] }) }));
vi.mock("../../utils/contributionAnalysis", async (original) => {
  const actual = await original();
  return { ...actual, calculateGroupContribution: (args) => { if (mocks.failHorizon && args.quote.roomsByDate.length > 1) throw new Error("Required horizon valuation is missing"); return actual.calculateGroupContribution(args); } };
});
vi.mock("../../utils/losNetwork", async (original) => {
  const actual = await original();
  return { ...actual, combineStayPatternYears: (...args) => { mocks.combine(...args); return actual.combineStayPatternYears(...args); } };
});
const root = (status, buildRunId) => ({ modelVersion: "stay-pattern-v1", publicationVersion: "stay-pattern-publication-v2", status, sourceRevision: 0, publishedSourceRevision: 0, buildRunId, latestCompletedBuildRunId: buildRunId, publishedYearBuildRunIds: { 2026: buildRunId } });
const evidence = (status, buildRunId) => ({ root: root(status, buildRunId), years: [{ year: 2026, modelVersion: "stay-pattern-v1", status: "VALID", buildRunId }] });

describe("quote analysis source and snapshot integration", () => {
  beforeEach(() => {
    vi.clearAllMocks(); mocks.failHorizon = false;
    mocks.history.mockResolvedValue([{ date: "2026-05-01" }]);
    mocks.compset.mockResolvedValue({ settings: {}, competitors: [] });
    mocks.settings.mockResolvedValue({ variableRoomCost: 0, breakfastCostPerPerson: 0, transientAverageBreakfastPax: 0, transientAverageBreakfastRevenuePerPax: 0, bqtContributionMarginPercentage: 0, transientDistributionCostPercentage: 0, defaultGroupCommissionPercentage: 0, roomVatPercentage: 0 });
    mocks.patterns.mockResolvedValue(evidence("VALID", "first")); mocks.add.mockResolvedValue("saved");
  });
  const analyze = async () => {
    const button = await screen.findByRole("button", { name: "Analyze" });
    await waitFor(() => expect(button).toBeEnabled()); fireEvent.click(button);
    await waitFor(() => expect(screen.getByRole("button", { name: "Save Quote" })).toBeEnabled());
  };
  it("refetches every configuration and publication on same-input VALID→STALE→VALID analysis", async () => {
    render(<GroupQuoteCreatePage />);
    await analyze();
    expect(mocks.combine.mock.calls.at(-1)[2]).toMatchObject({ status: "VALID", buildRunId: "first" });
    for (const [status, run] of [["STALE", "changed"], ["VALID", "rebuilt"]]) {
      mocks.patterns.mockResolvedValue(evidence(status, run));
      fireEvent.click(screen.getByRole("button", { name: "Edit inputs" })); await analyze();
      expect(mocks.combine.mock.calls.at(-1)[2]).toMatchObject({ status, buildRunId: run });
    }
    expect(mocks.patterns).toHaveBeenCalledTimes(3);
    expect(mocks.settings).toHaveBeenCalledTimes(4); expect(mocks.history).toHaveBeenCalledTimes(4); expect(mocks.compset).toHaveBeenCalledTimes(4);
    fireEvent.click(screen.getByRole("button", { name: "Save Quote" }));
    await waitFor(() => expect(mocks.add).toHaveBeenCalledTimes(1));
    const saved = mocks.add.mock.calls[0][1];
    expect(saved.analysisContributionSnapshot).toMatchObject({ snapshotVersion: "group-quote-contribution-snapshot-v2", totalLostContribution: 3000, economicFloorRateInclVat: 150 });
    expect(saved.analysisContributionSnapshot.nightly[0].scenarios.base.portfolioWithoutGroup.accepted).toEqual({ TRANSIENT: 90, GROUP: 10 });
    expect(saved.analysisContributionSnapshot.nightly[0].scenarios.base.portfolioWithGroup.accepted).toEqual({ TRANSIENT: 80, GROUP: 0 });
  });
  it("retains a validated per-night result and explicit LOS horizon failure in saved evidence", async () => {
    mocks.failHorizon = true;
    render(<GroupQuoteCreatePage />); await analyze();
    expect(screen.getByText("LOS_HORIZON_CALCULATION_FAILED")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save Quote" }));
    await waitFor(() => expect(mocks.add).toHaveBeenCalledTimes(1));
    expect(mocks.add.mock.calls[0][1]).toMatchObject({ analysisStatus: "CURRENT", analysisContributionSnapshot: { economicFloorRateInclVat: 150 }, losNetworkDisplacement: { active: false, fallbackReason: "LOS_HORIZON_CALCULATION_FAILED", error: "Required horizon valuation is missing" } });
  });
  it("uses an explicit per-night fallback when model evidence cannot be read", async () => {
    mocks.patterns.mockRejectedValue(new Error("Model unavailable"));
    render(<GroupQuoteCreatePage />); await analyze();
    expect(screen.getByText("LOS_PATTERN_READ_FAILED")).toBeInTheDocument();
  });
});
