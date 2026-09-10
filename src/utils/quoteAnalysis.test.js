import { describe, expect, it } from "vitest";
import { buildHistoricalDateAnalysis, calculateDisplacementMetrics } from "./quoteAnalysis";

describe("buildHistoricalDateAnalysis", () => {
  it("finds the nearest available date with the same weekday per selected year", () => {
    const result = buildHistoricalDateAnalysis(
      ["2026-09-10", "2026-09-11"],
      ["2025-09-04", "2025-09-05", "2025-09-11", "2025-09-12"].map((date) => ({ date })),
      [2025]
    );
    expect(result[0].matches.map(({ weekday, historicalDate }) => ({ weekday, historicalDate }))).toEqual([
      { weekday: "Thursday", historicalDate: "2025-09-11" },
      { weekday: "Friday", historicalDate: "2025-09-12" },
    ]);
  });

  it("moves a selected historical year by complete weeks", () => {
    const dates = ["2025-09-11", "2025-09-18"].map((date) => ({ date, calculatedInventoryRooms: 10 }));
    const result = buildHistoricalDateAnalysis(["2026-09-10"], dates, [2025], { 2025: 1 });
    expect(result[0].matches[0].consideredDate).toMatchObject({ date: "2025-09-18", calculatedInventoryRooms: 10 });
  });

  it("calculates inflation-adjusted displacement metrics", () => {
    expect(calculateDisplacementMetrics({
      averageRoomRate: 100,
      calculatedOccRooms: 80,
      calculatedInventoryRooms: 100,
      requestedGroupRooms: 20,
      inflationPercentage: 5,
      displacementThresholdPercentage: 10,
      yearsAgo: 2,
    })).toEqual({
      adjustedAverageRoomRate: 110.25,
      displacedRooms: 10,
      displacedRevenue: 1102.5,
    });
  });
});
