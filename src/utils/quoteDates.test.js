import { describe, expect, it } from "vitest";
import { getInclusiveQuoteDates } from "./quoteDates";

describe("getInclusiveQuoteDates", () => {
  it("includes both the start and end date", () => {
    expect(getInclusiveQuoteDates("2026-09-10", "2026-09-12")).toEqual([
      "2026-09-10",
      "2026-09-11",
      "2026-09-12",
    ]);
  });

  it("supports a one-night range and rejects invalid ranges", () => {
    expect(getInclusiveQuoteDates("2026-09-10", "2026-09-10")).toEqual(["2026-09-10"]);
    expect(getInclusiveQuoteDates("2026-09-11", "2026-09-10")).toEqual([]);
    expect(getInclusiveQuoteDates("not-a-date", "2026-09-10")).toEqual([]);
  });
});
