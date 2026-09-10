import { describe, expect, it } from "vitest";
import { buildHistoricalDateAnalysis } from "./quoteAnalysis";

describe("buildHistoricalDateAnalysis", () => {
  it("finds the nearest available date with the same weekday per selected year", () => {
    const result = buildHistoricalDateAnalysis(
      ["2026-09-10", "2026-09-11"],
      ["2025-09-04", "2025-09-05", "2025-09-11", "2025-09-12"],
      [2025]
    );
    expect(result[0].matches).toEqual([
      { quoteDate: "2026-09-10", historicalDate: "2025-09-11" },
      { quoteDate: "2026-09-11", historicalDate: "2025-09-12" },
    ]);
  });
});
