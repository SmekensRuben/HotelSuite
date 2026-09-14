import { describe, expect, it } from "vitest";
import { backtestGroupDemandForecast, calculateGroupDemandForecast, calendarFeatures, percentile, prepareGroupForecastData, prepareGroupHistory, selectGroupComparables } from "./groupDemandForecast";
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
  it("deduplicates identical regime features while retaining overlapping event IDs", () => {
    const f = calendarFeatures("2027-04-06", [event("SCHOOL_HOLIDAY", undefined, undefined, { id: "one" }), event("SCHOOL_HOLIDAY", undefined, undefined, { id: "two" })]);
    expect(f.calendarRegime).toEqual(["SCHOOL_HOLIDAY:SUPPRESS"]);
    expect(f.activeEventIds).toEqual(["one", "two"]);
  });
  it("reuses one calendar feature object per date in prepared analysis data", () => {
    const prepared = prepareGroupForecastData({ historicalRows: history(), events: [], targetDates: ["2027-04-06"] });
    expect(prepared.featureMap.size).toBe(history().length + 1);
    expect(prepared.featuresFor("2027-04-06")).toBe(prepared.featuresFor("2027-04-06"));
  });
  it("ignores inactive events", () => expect(calendarFeatures("2027-04-06", [event("PUBLIC_HOLIDAY", undefined, undefined, { active: false })]).activeEventIds).toHaveLength(0));
  it("uses group effect only as context, never a multiplier", () => {
    const neutral = forecast({ events: [event("SCHOOL_HOLIDAY", undefined, undefined, { groupDemandEffect: "NEUTRAL" })] });
    const boost = forecast({ events: [event("SCHOOL_HOLIDAY", undefined, undefined, { groupDemandEffect: "BOOST" })] });
    expect(neutral.historicalP50GroupRooms).toBe(boost.historicalP50GroupRooms);
  });
  it("excludes target during backtest", () => { const rows = [...history(), { date: "2027-04-06", calculatedInventoryRooms: 100, groupRooms: 99 }]; expect(backtestGroupDemandForecast({ historicalRows: rows }).observations.find((item) => item.targetDate === "2027-04-06").sampleSize).toBeLessThan(rows.length); });
  it("excludes invalid inventory", () => expect(prepareGroupHistory(history({ calculatedInventoryRooms: 0 }))).toHaveLength(0));
  it("excludes invalid group rooms", () => expect(prepareGroupHistory(history({ groupRooms: -1 }))).toHaveLength(0));
  it("excludes realized group shares above 100 percent and warns", () => {
    const r = forecast({ historicalRows: [...history(), { date: "2026-04-07", calculatedInventoryRooms: 100, groupRooms: 101 }] });
    expect(r.selectedHistoricalDates).not.toContain("2026-04-07");
    expect(r.warnings).toContain("Historical group observations above 100% of sellable inventory were excluded.");
  });
  it("distinguishes missing group OTB from zero and caps confidence", () => {
    const r = forecast({ currentOtb: { calculatedInventoryRooms: 150 } });
    expect(r.currentGroupOtb).toBe(0); expect(r.currentGroupOtbExists).toBe(false); expect(r.confidence).toBe("LOW");
    expect(r.warnings).toContain("Current group OTB is missing; zero was used as a fallback.");
  });
  it("caps otherwise HIGH normal-business confidence when historical calendar coverage is incomplete", () => {
    const incomplete = forecast({ events: [event("PUBLIC_HOLIDAY", "2023-12-25", "2023-12-25")] });
    expect(incomplete.calendarCoverageRatio).toBe(.5); expect(incomplete.confidence).toBe("MEDIUM");
    expect(incomplete.warnings).toContain("Historical Demand Calendar coverage is incomplete; normal-business matching may include unlabeled event periods.");
    const complete = forecast({ events: [event("PUBLIC_HOLIDAY", "2023-12-25", "2023-12-25"), event("PUBLIC_HOLIDAY", "2024-12-25", "2024-12-25", { id: "2024" })] });
    expect(complete.calendarCoverageRatio).toBe(1); expect(complete.confidence).toBe("HIGH");
  });
  it("low sample lowers confidence and warns", () => { const r = forecast({ historicalRows: history().slice(0, 2) }); expect(r.confidence).toBe("LOW"); expect(r.warnings).toContain("Limited historical group sample."); });
  it("broad fallback has low confidence", () => { const obs = prepareGroupHistory(history()); const r = selectGroupComparables("2027-04-07", obs, calendarFeatures("2027-04-07"), { preferredSample: 20, strongSample: 20 }); expect(r.tier).toBe("TIER_5_SEASON_FALLBACK"); });
  it("prefers four Tier 1 observations over a much larger broad sample", () => {
    const target = "2027-04-06";
    const exact = dates.slice(0, 4).map((stayDate) => ({ stayDate, calendarFeatures: calendarFeatures(stayDate), groupShare: .2, sellableInventory: 100, finalGroupRooms: 20 }));
    const broad = Array.from({ length: 100 }, (_, index) => ({ stayDate: `2026-03-${String(index % 28 + 1).padStart(2, "0")}`, calendarFeatures: calendarFeatures("2026-03-01"), groupShare: .3, sellableInventory: 100, finalGroupRooms: 30 })).filter((item) => new Date(`${item.stayDate}T00:00:00Z`).getUTCDay() !== 2);
    const selected = selectGroupComparables(target, [...exact, ...broad], calendarFeatures(target));
    expect(selected.tier).toBe("TIER_1_SAME_DOW_MONTH_CALENDAR"); expect(selected.selectionPass).toBe("LIMITED"); expect(selected.selected).toHaveLength(4);
  });
  it("uses a three-row Tier 2 before broader tiers", () => {
    const targetFeatures = calendarFeatures("2027-04-06", [event("BUSINESS_EVENT", "2027-04-06", "2027-04-06")]);
    const observations = ["2024-03-05", "2025-03-04", "2026-03-03"].map((stayDate) => ({ stayDate, calendarFeatures: targetFeatures, groupShare: .2, sellableInventory: 100, finalGroupRooms: 20 }));
    const selected = selectGroupComparables("2027-04-06", observations, targetFeatures);
    expect(selected.tier).toBe("TIER_2_SAME_DOW_SEASON_CALENDAR"); expect(selected.selectionPass).toBe("LIMITED");
  });
  it("uses a three-row Tier 3 over an emergency Tier 1 sample", () => {
    const target = "2027-04-06", targetFeatures = calendarFeatures(target, [event("BUSINESS_EVENT", target, target)]);
    const observations = ["2023-04-04", "2024-04-02", "2025-04-01"].map((stayDate, index) => ({ stayDate, calendarFeatures: index === 0 ? targetFeatures : calendarFeatures(stayDate), groupShare: .2, sellableInventory: 100, finalGroupRooms: 20 }));
    const selected = selectGroupComparables(target, observations, targetFeatures);
    expect(selected.tier).toBe("TIER_3_SAME_DOW_MONTH"); expect(selected.selectionPass).toBe("LIMITED");
  });
  it("marks an emergency single observation LOW", () => { const r = forecast({ historicalRows: history().slice(0, 1) }); expect(r.selectionPass).toBe("EMERGENCY"); expect(r.confidence).toBe("LOW"); expect(r.warnings).toContain("Group forecast is based on a very limited historical sample."); });
  it("floors every scenario above P75", () => { const r = forecast({ currentOtb: { calculatedInventoryRooms: 150, groupRooms: 200 } }); expect([r.forecastLow, r.forecastBase, r.forecastHigh]).toEqual([200, 200, 200]); });
  it("does not divide by zero", () => expect(forecast({ historicalRows: history({ calculatedInventoryRooms: 0 }) }).forecastBase).toBeNull());
  it("implements interpolated percentiles without rounding", () => expect(percentile([1, 2, 4, 8], .25)).toBe(1.75));
  it("does not accept or apply five-day pace", () => expect(forecast({ recentGroupPickup: 999 }).paceAdjustmentApplied).toBe(false));
  it("does not change Economic Floor inputs or output", () => {
    const args = { quote: { roomsByDate: [{ date: "2027-04-06", rooms: 10, bqtRevenue: 0 }], breakfastPax: 0, groupCommissionPercentage: 0 }, forecastByDate: { "2027-04-06": { displacedRooms: 2, nonDisplacingGroupRooms: 8, expectedTransientRoomRate: 100 } }, settings: { variableRoomCost: 10, breakfastCostPerPerson: 0, bqtContributionMarginPercentage: 0, transientDistributionCostPercentage: 0, defaultGroupCommissionPercentage: 0, transientAverageBreakfastPax: 0, transientAverageBreakfastRevenuePerPax: 0, roomVatPercentage: 0 } };
    const before = calculateGroupContribution(args).economicFloorRate; forecast(); expect(calculateGroupContribution(args).economicFloorRate).toBe(before);
  });
  it("returns deterministic backtest metrics and breakdowns", () => { const r = backtestGroupDemandForecast({ historicalRows: history() }); expect(r.sampleCount).toBe(7); expect(r.mae).toBeGreaterThanOrEqual(0); expect(r.breakdown.month["04"]).toBeTruthy(); });
  it("prevents future stay-date leakage in backtests", () => {
    const rows = ["2023-03-06", "2023-03-13", "2023-03-20", "2024-04-01", "2024-04-02", "2025-04-01", "2026-04-01"].map((date, index) => ({ date, historyFutureType: "History", calculatedInventoryRooms: 100, groupRooms: 10 + index }));
    const target = backtestGroupDemandForecast({ historicalRows: rows }).observations.find((item) => item.targetDate === "2024-04-01");
    expect(target).toBeTruthy();
    const direct = calculateGroupDemandForecast({ stayDate: "2024-04-01", currentOtb: { calculatedInventoryRooms: 100, groupRooms: 0 }, historicalRows: rows });
    expect(direct.selectedHistoricalDates.every((date) => date < "2024-04-01")).toBe(true);
  });
  it("excludes unselected years before selecting comparables and percentiles", () => {
    const rows = [...history(), ...[1, 8, 15, 22, 29].map((day) => ({ date: `2025-04-${String(day).padStart(2, "0")}`, calculatedInventoryRooms: 100, groupRooms: 100 }))];
    const all = calculateGroupDemandForecast({ stayDate: "2027-04-06", currentOtb: { calculatedInventoryRooms: 100, groupRooms: 0 }, historicalRows: rows });
    const filtered = calculateGroupDemandForecast({ stayDate: "2027-04-06", currentOtb: { calculatedInventoryRooms: 100, groupRooms: 0 }, historicalRows: rows, selectedHistoricalYears: [2023, 2024] });
    expect(filtered.comparables.every((item) => !item.stayDate.startsWith("2025"))).toBe(true);
    expect(filtered.sampleSize).toBe(8);
    expect(filtered.historicalP75GroupRooms).not.toBe(all.historicalP75GroupRooms);
  });
  it("exposes deductible group revenue only on the authoritative selected comparable set", () => {
    const rows = history().map((row) => ({ ...row, groupRevenueDeductible: row.groupRooms * 200 }));
    const result = calculateGroupDemandForecast({ stayDate: "2027-04-06", currentOtb: { calculatedInventoryRooms: 100, groupRooms: 0 }, historicalRows: rows, selectedHistoricalYears: [2023] });
    expect(result.comparables).toHaveLength(4);
    expect(result.comparables.every((item) => item.groupRevenueDeductible === item.finalGroupRooms * 200 && item.stayDate.startsWith("2023"))).toBe(true);
  });
  it("recalculates confidence and warns after selected-year filtering limits the sample", () => {
    const result = forecast({ selectedHistoricalYears: [2023] });
    expect(result.sampleSize).toBe(4);
    expect(result.confidence).toBe("LOW");
    expect(result.warnings).toContain("Historical group sample is limited by the selected analysis years.");
  });
});
