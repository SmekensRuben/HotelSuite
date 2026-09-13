import { describe, expect, it } from "vitest";
import { backtestGroupDemandForecast, calculateGroupDemandForecast, calendarFeatures, percentile, prepareGroupHistory, selectGroupComparables } from "./groupDemandForecast";
import { calculateGroupContribution } from "./contributionAnalysis";

const dates = ["2023-04-04", "2023-04-11", "2023-04-18", "2023-04-25", "2024-04-02", "2024-04-09", "2024-04-16", "2024-04-23"];
const history = (overrides = {}) => dates.map((date, index) => ({ date, historyFutureType: "History", calculatedInventoryRooms: 100, inventoryRooms: 999, groupRooms: 10 + index * 10, ...overrides }));
const event = (systemType, startDate = "2023-01-01", endDate = "2028-12-31", extra = {}) => ({ id: systemType, name: systemType, active: true, systemType, groupDemandEffect: "SUPPRESS", startDate, endDate, ...extra });
const forecast = (options = {}) => calculateGroupDemandForecast({ stayDate: "2027-04-06", currentOtb: { calculatedInventoryRooms: 150, groupRooms: 12 }, historicalRows: history(), events: [], ...options });

describe("Group Demand Forecast V1", () => {
  it("uses calculated sellable inventory for historical group share", () => expect(prepareGroupHistory(history())[0].groupShare).toBe(.1));
  it("normalizes group rooms without intermediate rounding", () => {
    const result = calculateGroupDemandForecast({ stayDate: "2027-04-06", currentOtb: { calculatedInventoryRooms: 150, groupRooms: 0 }, historicalRows: history({ calculatedInventoryRooms: 145, groupRooms: 60 }) });
    expect(result.comparables[0].normalizedGroupRooms).toBeCloseTo(60 / 145 * 150, 12);
  });
  it("uses current group OTB as a hard floor", () => expect(forecast({ currentOtb: { calculatedInventoryRooms: 150, groupRooms: 200 } }).forecastLow).toBe(200));
  it("never forecasts base below OTB", () => expect(forecast().forecastBase).toBeGreaterThanOrEqual(12));
  it("never returns negative remaining potential", () => expect(forecast({ currentOtb: { calculatedInventoryRooms: 150, groupRooms: 200 } }).remainingPotentialBase).toBe(0));
  it("uses the median normalized demand for P50", () => expect(forecast().historicalP50GroupRooms).toBe(67.5));
  it("orders low, base and high", () => { const r = forecast(); expect(r.forecastLow).toBeLessThanOrEqual(r.forecastBase); expect(r.forecastBase).toBeLessThanOrEqual(r.forecastHigh); });

  for (const type of ["SCHOOL_HOLIDAY", "PUBLIC_HOLIDAY", "BRIDGE_DAY", "BUSINESS_EVENT"]) {
    it(`prefers ${type} context`, () => {
      const targetEvent = event(type, "2027-04-06", "2027-04-06");
      const pastEvents = dates.slice(0, 5).map((day, i) => event(type, day, day, { id: `${type}${i}` }));
      const r = forecast({ events: [targetEvent, ...pastEvents] });
      expect(r.comparableTier).toBe("TIER_1_SAME_DOW_MONTH_CALENDAR"); expect(r.comparables.every((item) => item.calendarFeatures.activeSystemTypes.includes(type))).toBe(true);
    });
  }
  it("normal business does not prefer school holidays", () => {
    const school = dates.slice(0, 3).map((day, i) => event("SCHOOL_HOLIDAY", day, day, { id: `s${i}` }));
    expect(forecast({ events: school }).comparables.every((item) => !item.calendarFeatures.isSchoolHoliday)).toBe(true);
  });
  it("supports overlapping events", () => { const f = calendarFeatures("2027-04-06", [event("SCHOOL_HOLIDAY"), event("BUSINESS_EVENT")]); expect(f.activeSystemTypes).toEqual(["SCHOOL_HOLIDAY", "BUSINESS_EVENT"]); });
  it("ignores inactive events", () => expect(calendarFeatures("2027-04-06", [event("PUBLIC_HOLIDAY", undefined, undefined, { active: false })]).activeEventIds).toHaveLength(0));
  it("uses group effect only as context, never a multiplier", () => {
    const neutral = forecast({ events: [event("SCHOOL_HOLIDAY", undefined, undefined, { groupDemandEffect: "NEUTRAL" })] });
    const boost = forecast({ events: [event("SCHOOL_HOLIDAY", undefined, undefined, { groupDemandEffect: "BOOST" })] });
    expect(neutral.historicalP50GroupRooms).toBe(boost.historicalP50GroupRooms);
  });
  it("excludes target during backtest", () => { const rows = [...history(), { date: "2027-04-06", calculatedInventoryRooms: 100, groupRooms: 999 }]; expect(backtestGroupDemandForecast({ historicalRows: rows }).observations.find((item) => item.targetDate === "2027-04-06").sampleSize).toBeLessThan(rows.length); });
  it("excludes invalid inventory", () => expect(prepareGroupHistory(history({ calculatedInventoryRooms: 0 }))).toHaveLength(0));
  it("excludes invalid group rooms", () => expect(prepareGroupHistory(history({ groupRooms: -1 }))).toHaveLength(0));
  it("low sample lowers confidence and warns", () => { const r = forecast({ historicalRows: history().slice(0, 2) }); expect(r.confidence).toBe("LOW"); expect(r.warnings).toContain("Limited historical group sample."); });
  it("broad fallback has low confidence", () => { const obs = prepareGroupHistory(history()); const r = selectGroupComparables("2027-04-07", obs, calendarFeatures("2027-04-07"), { preferredSample: 20, strongSample: 20 }); expect(r.tier).toBe("TIER_5_SEASON_FALLBACK"); });
  it("floors every scenario above P75", () => { const r = forecast({ currentOtb: { calculatedInventoryRooms: 150, groupRooms: 200 } }); expect([r.forecastLow, r.forecastBase, r.forecastHigh]).toEqual([200, 200, 200]); });
  it("does not divide by zero", () => expect(forecast({ historicalRows: history({ calculatedInventoryRooms: 0 }) }).forecastBase).toBeNull());
  it("implements interpolated percentiles without rounding", () => expect(percentile([1, 2, 4, 8], .25)).toBe(1.75));
  it("does not accept or apply five-day pace", () => expect(forecast({ recentGroupPickup: 999 }).paceAdjustmentApplied).toBe(false));
  it("does not change Economic Floor inputs or output", () => {
    const args = { quote: { roomsByDate: [{ date: "2027-04-06", rooms: 10, bqtRevenue: 0 }], breakfastPax: 0, groupCommissionPercentage: 0 }, forecastByDate: { "2027-04-06": { displacedRooms: 2, nonDisplacingGroupRooms: 8, expectedTransientRoomRate: 100 } }, settings: { variableRoomCost: 10, breakfastCostPerPerson: 0, bqtContributionMarginPercentage: 0, transientDistributionCostPercentage: 0, defaultGroupCommissionPercentage: 0, transientAverageBreakfastPax: 0, transientAverageBreakfastRevenuePerPax: 0, roomVatPercentage: 0 } };
    const before = calculateGroupContribution(args).economicFloorRate; forecast(); expect(calculateGroupContribution(args).economicFloorRate).toBe(before);
  });
  it("returns deterministic backtest metrics and breakdowns", () => { const r = backtestGroupDemandForecast({ historicalRows: history() }); expect(r.sampleCount).toBe(8); expect(r.mae).toBeGreaterThanOrEqual(0); expect(r.breakdown.month["04"]).toBeTruthy(); });
});
