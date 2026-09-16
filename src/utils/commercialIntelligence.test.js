import { describe, expect, it } from "vitest";
import { averageQuoteVariance, decisionWinRate, leadTimeBand } from "./commercialIntelligence";

describe("commercial intelligence frozen calculations", () => {
  it("uses only won and lost in decision win rate", () => {
    const statuses = ["WON","WON","WON","WON","LOST","LOST","LOST","LOST","LOST","LOST","DECLINED","DECLINED","DECLINED","CANCELLED","CANCELLED","PENDING","PENDING","PENDING","PENDING","PENDING"];
    expect(decisionWinRate(statuses.map(commercialStatus => ({ commercialStatus })))).toBe(.4);
  });
  it("excludes missing frozen targets instead of treating them as zero", () => {
    const quotes = [{ outcome: { decisionSnapshot: { finalQuotedRateInclVat: 200, targetRateInclVat: null } } }, { outcome: { decisionSnapshot: { finalQuotedRateInclVat: 220, targetRateInclVat: 200 } } }];
    expect(averageQuoteVariance(quotes, "targetRateInclVat")).toEqual({ amount: 20, percentage: .1, sampleCount: 1 });
  });
  it("centralizes lead-time bands and preserves unknown", () => { expect(leadTimeBand(366)).toBe("366+"); expect(leadTimeBand(null)).toBe("UNKNOWN"); });
});
