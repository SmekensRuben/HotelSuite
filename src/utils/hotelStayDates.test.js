import { describe, expect, it } from "vitest";
import { deriveSourceCoverage, formatHotelStayDate, sourceStatusForDate } from "./hotelStayDates";

describe("hotel stay date and source horizons", () => {
  it("formats exact date keys with their weekday without a timezone shift", () => {
    expect(formatHotelStayDate("2026-09-17")).toBe("Thu 17 Sep 2026");
    expect(formatHotelStayDate("2026-09-19")).toBe("Sat 19 Sep 2026");
  });
  it("distinguishes available, missing, and out-of-horizon dates from actual coverage", () => {
    const byDate = { "2027-01-01": {}, "2027-09-10": {}, "2027-09-15": {} };
    const coverage = deriveSourceCoverage("2026-09-15", byDate);
    expect(sourceStatusForDate("2027-09-10", coverage, byDate["2027-09-10"])).toBe("AVAILABLE");
    expect(sourceStatusForDate("2027-10-01", coverage)).toBe("OUT_OF_HORIZON");
    expect(sourceStatusForDate("2027-08-15", coverage)).toBe("MISSING");
  });
});
