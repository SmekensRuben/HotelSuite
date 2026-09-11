import { describe, expect, it } from "vitest";
import { calculateGroupContribution, normalizeContributionSettings, simulateGroupQuote } from "./contributionAnalysis";
import { calculateDisplacementDay } from "./displacementForecast";

const settings = (overrides = {}) => ({ variableRoomCost: 20, breakfastCostPerPerson: 5, bqtContributionMarginPercentage: 30, defaultGroupCommissionPercentage: 10, transientAverageBreakfastPax: 1.5, transientAverageBreakfastRevenuePerPax: 12, transientDistributionCostPercentage: 8, inflationPercentage: 5, ...overrides });
const quote = (overrides = {}) => ({ breakfastPax: 20, roomsByDate: [{ date: "2027-09-08", rooms: 10, bqtRevenue: 1000 }], ...overrides });
const forecast = (overrides = {}) => ({ "2027-09-08": { displacedRooms: 4, nonDisplacingGroupRooms: 6, expectedTransientRoomRate: 100, ...overrides } });
const result = (quoteOverrides, settingOverrides, forecastOverrides) => calculateGroupContribution({ quote: quote(quoteOverrides), settings: settings(settingOverrides), forecastByDate: forecast(forecastOverrides) });

describe("Contribution Displacement Engine V1", () => {
  it("normalizes whole percentage points without mutating their storage representation", () => {
    const source = settings({ bqtContributionMarginPercentage: 30, defaultGroupCommissionPercentage: 10, transientDistributionCostPercentage: 8 });
    expect(normalizeContributionSettings(source)).toMatchObject({ bqtContributionMargin: .3, defaultGroupCommission: .1, transientDistributionCost: .08 });
    expect(source).toMatchObject({ bqtContributionMarginPercentage: 30, defaultGroupCommissionPercentage: 10, transientDistributionCostPercentage: 8 });
  });
  it("returns zero lost contribution for zero displaced rooms, even without ADR", () => expect(result({}, {}, { displacedRooms: 0, nonDisplacingGroupRooms: 10, expectedTransientRoomRate: null }).totalLostTransientContribution).toBe(0));
  it("calculates transient room and breakfast contribution separately", () => {
    const night = result().nightly[0];
    expect(night.transientDistributionCostPerRoom).toBe(8);
    expect(night.transientRoomContributionPerRoom).toBe(72);
    expect(night.transientBreakfastContributionPerRoom).toBe(10.5);
    expect(night.transientContributionPerDisplacedRoom).toBe(82.5);
    expect(night.lostTransientContribution).toBe(330);
  });
  it("preserves negative breakfast contribution", () => expect(result({}, { breakfastCostPerPerson: 15 }).nightly[0].transientBreakfastContributionPerRoom).toBe(-4.5));
  it("applies distribution cost only to ADR", () => expect(result({}, { transientAverageBreakfastRevenuePerPax: 100 }).nightly[0].transientDistributionCostPerRoom).toBe(8));
  it("sums multiple-night lost contribution", () => {
    const two = calculateGroupContribution({ settings: settings(), quote: quote({ roomsByDate: [{ date: "a", rooms: 10, bqtRevenue: 0 }, { date: "b", rooms: 10, bqtRevenue: 0 }] }), forecastByDate: { a: { displacedRooms: 2, nonDisplacingGroupRooms: 8, expectedTransientRoomRate: 100 }, b: { displacedRooms: 3, nonDisplacingGroupRooms: 7, expectedTransientRoomRate: 100 } } });
    expect(two.totalLostTransientContribution).toBe(412.5);
  });
  it("uses 30% BQT contribution and calculates group variable and breakfast costs", () => expect(result()).toMatchObject({ bqtContribution: 300, groupVariableRoomCosts: 200, groupBreakfastCosts: 100 }));
  it("uses default commission when override is absent and lets the quote override win", () => {
    expect(result().groupCommission).toBe(.1);
    expect(result({ groupCommissionPercentage: 5 }).groupCommission).toBe(.05);
  });
  it("calculates floors with zero and ten percent commission", () => {
    expect(result({ groupCommissionPercentage: 0 }).economicFloorRate).toBe(33);
    expect(result().economicFloorRate).toBeCloseTo(36.666666666666664);
  });
  it("moves the floor in the expected directions", () => {
    expect(result({ roomsByDate: [{ date: "2027-09-08", rooms: 10, bqtRevenue: 2000 }] }).economicFloorRate).toBeLessThan(result().economicFloorRate);
    expect(result({ breakfastPax: 30 }).economicFloorRate).toBeGreaterThan(result().economicFloorRate);
    expect(result({}, {}, { displacedRooms: 5, nonDisplacingGroupRooms: 5 }).economicFloorRate).toBeGreaterThan(result().economicFloorRate);
  });
  it("clamps required net revenue and floor at zero when BQT is sufficient", () => expect(result({ roomsByDate: [{ date: "2027-09-08", rooms: 10, bqtRevenue: 10000 }] }, {}, { displacedRooms: 0, nonDisplacingGroupRooms: 10 }).requiredNetGroupRoomRevenue).toBe(0));
  it("makes the floor null and warns when displaced rooms have no ADR", () => {
    const missing = result({}, {}, { expectedTransientRoomRate: null });
    expect(missing.totalLostTransientContribution).toBeNull(); expect(missing.economicFloorRate).toBeNull(); expect(missing.warnings.join(" ")).toMatch(/ADR/);
  });
  it("does not block the floor for missing ADR when displacement is zero", () => expect(result({}, {}, { displacedRooms: 0, nonDisplacingGroupRooms: 10, expectedTransientRoomRate: null }).economicFloorRate).not.toBeNull());
  it("rejects invalid commission and settings", () => {
    expect(() => result({ groupCommissionPercentage: 100 })).toThrow(/commission/i);
    expect(() => result({}, { transientDistributionCostPercentage: 100 })).toThrow(/transientDistributionCostPercentage/);
  });
  it("returns a null floor and warning for zero room nights", () => {
    const empty = result({ roomsByDate: [] }); expect(empty.economicFloorRate).toBeNull(); expect(empty.warnings.join(" ")).toMatch(/zero/);
  });
  it("simulates exact, above, and below-floor rates without rounding", () => {
    const contribution = result(); const exact = simulateGroupQuote(contribution, contribution.economicFloorRate);
    expect(exact.netIncrementalContribution).toBeCloseTo(0, 10);
    expect(simulateGroupQuote(contribution, contribution.economicFloorRate + .123456).netIncrementalContribution).toBeGreaterThan(0);
    expect(simulateGroupQuote(contribution, contribution.economicFloorRate - .123456).netIncrementalContribution).toBeLessThan(0);
    expect(exact.economicFloorRate).not.toBe(Number(exact.economicFloorRate.toFixed(2)));
  });
});

describe("expected transient ADR", () => {
  const historicalRows = [100, 200, 1000].map((averageRoomRate, index) => ({ date: `2026-09-${String([2, 9, 16][index]).padStart(2, "0")}`, historyFutureType: "History", calculatedInventoryRooms: 100, calculatedOccRooms: 50, individualRooms: 40, groupRooms: 10, averageRoomRate }));
  it("uses the median of the forecast's selected comparables with existing inflation adjustment", () => {
    const output = calculateDisplacementDay({ stayDate: "2027-09-08", requestedGroupRooms: 10, currentOtb: { calculatedInventoryRooms: 100, individualRooms: 95 }, historicalRows, selectedHistoricalYears: [2024, 2025, 2026], inflationPercentage: 10 });
    expect(output.expectedTransientRoomRate).toBeCloseTo(220);
  });
  it("ignores invalid, missing, and non-positive ADR", () => {
    const output = calculateDisplacementDay({ stayDate: "2027-09-08", requestedGroupRooms: 10, currentOtb: { calculatedInventoryRooms: 100 }, historicalRows: historicalRows.map((row, i) => ({ ...row, averageRoomRate: [0, "bad", 100][i] })), selectedHistoricalYears: [2024, 2025, 2026], inflationPercentage: 10 });
    expect(output.expectedTransientRoomRate).toBeCloseTo(110);
  });
});
