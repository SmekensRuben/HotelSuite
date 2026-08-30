import { describe, expect, it } from "vitest";
import { calculateNights } from "./arrivalDates";

describe("calculateNights", () => {
  it("calculates the number of nights without timezone rounding errors", () => {
    expect(calculateNights("2026-08-30", "2026-09-02")).toBe(3);
  });

  it("returns an empty value for invalid date ranges", () => {
    expect(calculateNights("2026-09-02", "2026-08-30")).toBe("");
    expect(calculateNights("not-a-date", "2026-08-30")).toBe("");
  });
});
