import { describe, expect, it } from "vitest";
import { buildMarketContextSnapshot, calculateGroupStayMarketSummary, calculateMarketPricingDate, parseLighthousePublicRate, parseLighthouseRateStatus } from "./marketPricingContext";

const compset = { ownHotelLighthouseFieldName: "Own" };
const competitors = [
  { id: "pillows", displayName: "Pillows", lighthouseFieldName: "Pillows", active: true, includeInMarketContext: true, marketRelevanceWeight: 35, groupIntelligenceEnabled: true },
  { id: "nh", displayName: "NH", lighthouseFieldName: "NH", active: true, includeInMarketContext: true, marketRelevanceWeight: 30 },
  { id: "yalo", displayName: "Yalo", lighthouseFieldName: "Yalo", active: true, includeInMarketContext: true, marketRelevanceWeight: 20 },
  { id: "novotel", displayName: "Novotel", lighthouseFieldName: "Novotel", active: true, includeInMarketContext: true, marketRelevanceWeight: 15 },
];
const rates = { Own: "249", Pillows: "270", NH: "244", Yalo: "195", Novotel: "176", "Market demand": "93%", "My OTB": "81" };

describe("Lighthouse public market pricing", () => {
  it.each([["289", "AVAILABLE", 289], ["Sold out", "SOLD_OUT", null], ["sold_OUT", "SOLD_OUT", null], ["LOS2", "LOS_RESTRICTION", null], ["los3", "LOS_RESTRICTION", null], ["Closed", "CLOSED", null], ["garbage", "UNAVAILABLE", null]])("classifies %j as %s", (input, status, rate) => expect(parseLighthouseRateStatus(input)).toEqual({ rawValue: input, rateInclVat: rate, availabilityStatus: status }));
  it.each([["249", 249], ["249.00", 249], ["249,00", 249], [" €249 ", 249], ["LOS2", null], ["Closed", null], ["", null], [null, null], ["N/A", null], ["-", null]])("parses %j as %j", (input, expected) => expect(parseLighthousePublicRate(input)).toBe(expected));

  it("keeps consumer rates including VAT regardless of room VAT", () => {
    expect(calculateMarketPricingDate({ stayDate: "2027-04-03", requestedRooms: 50, lighthouseRow: rates, compset: { ...compset, roomVatPercentage: 12 }, competitors }).ownPublicRateInclVat).toBe(249);
    expect(calculateMarketPricingDate({ stayDate: "2027-04-03", requestedRooms: 50, lighthouseRow: rates, compset: { ...compset, roomVatPercentage: 21 }, competitors }).ownPublicRateInclVat).toBe(249);
  });

  it("calculates weighted reference, median, range, demand, and full coverage", () => {
    const result = calculateMarketPricingDate({ stayDate: "2027-04-03", requestedRooms: 50, lighthouseRow: rates, compset, competitors });
    expect(result.weightedCompsetReferenceInclVat).toBeCloseTo(270 * .35 + 244 * .30 + 195 * .20 + 176 * .15);
    expect(result.compsetMedianInclVat).toBe(219.5);
    expect(result.compsetLowInclVat).toBe(176);
    expect(result.compsetHighInclVat).toBe(270);
    expect(result.compsetCoverage).toBe(1);
    expect(result.marketPricingConfidence).toBe("HIGH");
    expect(result.marketDemand).toBe(.93);
    expect(result.myOtb).toBe(.81);
  });

  it("excludes unavailable rates and renormalizes valid configured weights", () => {
    const result = calculateMarketPricingDate({ stayDate: "2027-04-03", requestedRooms: 50, lighthouseRow: { ...rates, Yalo: "LOS2" }, compset, competitors });
    expect(result.validCompetitorRates).toHaveLength(3);
    expect(result.validCompetitorRates.some((item) => item.publicRateInclVat === 0)).toBe(false);
    expect(result.compsetCoverage).toBe(.8);
    expect(result.weightedCompsetReferenceInclVat).toBeCloseTo((270 * 35 + 244 * 30 + 176 * 15) / 80);
  });

  it("keeps sold-out pressure visible but excludes it from all numeric references", () => {
    const result = calculateMarketPricingDate({ stayDate: "2027-04-03", requestedRooms: 50, lighthouseRow: { Own: 349, Pillows: 375, NH: 314, Yalo: 235, Novotel: "Sold out" }, compset, competitors });
    expect(result.validCompetitorRates).toHaveLength(3);
    expect(result.weightedCompsetReferenceInclVat).toBeCloseTo((375 * 35 + 314 * 30 + 235 * 20) / 85);
    expect(result.compsetMedianInclVat).toBe(314);
    expect(result.rateCoverage).toBe(.85);
    expect(result.soldOutWeightShare).toBe(.15);
    expect(result.competitors.find((item) => item.competitorId === "novotel")).toMatchObject({ availabilityStatus: "SOLD_OUT", publicRateInclVat: null, normalizedEffectiveWeight: null });
    expect(result.validCompetitorRates.map((item) => item.normalizedEffectiveWeight)).toEqual([35 / 85, 30 / 85, 20 / 85]);
  });

  it("supports arbitrary totals and excludes inactive, opted-out, zero-weight, and unmapped competitors", () => {
    const configured = [
      { id: "a", lighthouseFieldName: "A", active: true, includeInMarketContext: true, marketRelevanceWeight: 7 },
      { id: "b", lighthouseFieldName: "B", active: true, includeInMarketContext: true, marketRelevanceWeight: 3 },
      { id: "inactive", lighthouseFieldName: "C", active: false, includeInMarketContext: true, marketRelevanceWeight: 90 },
      { id: "excluded", lighthouseFieldName: "D", active: true, includeInMarketContext: false, marketRelevanceWeight: 90 },
      { id: "zero", lighthouseFieldName: "E", active: true, includeInMarketContext: true, marketRelevanceWeight: 0 },
      { id: "unmapped", active: true, includeInMarketContext: true, marketRelevanceWeight: 5 },
    ];
    const result = calculateMarketPricingDate({ lighthouseRow: { A: 100, B: 200, C: 1, D: 1, E: 1 }, compset: {}, competitors: configured });
    expect(result.weightedCompsetReferenceInclVat).toBe(130);
    expect(result.compsetCoverage).toBeCloseTo(10 / 15);
    expect(result.marketPricingConfidence).toBe("MEDIUM");
  });

  it("weights overall metrics by requested room nights without zero-filling missing dates", () => {
    const summary = calculateGroupStayMarketSummary([
      { requestedRooms: 50, weightedCompsetReferenceInclVat: 200, ownPublicRateInclVat: null, compsetMedianInclVat: 190, coverage: 1 },
      { requestedRooms: 100, weightedCompsetReferenceInclVat: 260, ownPublicRateInclVat: 280, compsetMedianInclVat: 250, coverage: 1 },
    ]);
    expect(summary.weightedMarketReferenceInclVat).toBe(240);
    expect(summary.weightedOwnPublicRateInclVat).toBe(280);
    expect(summary.overallCoverage).toBe(1);
  });

  it("freezes configured and effective settings in an independent snapshot", () => {
    const sourceCompetitors = structuredClone(competitors);
    const snapshot = buildMarketContextSnapshot({ lighthouseSnapshotDate: "2026-09-14", compset, competitors: sourceCompetitors, lighthouseByDate: { "2027-04-03": rates }, roomsByDate: [{ date: "2027-04-03", rooms: 50 }] });
    sourceCompetitors[0].marketRelevanceWeight = 999;
    expect(snapshot.rateBasis).toBe("INCL_VAT_CONSUMER");
    expect(snapshot.marketContextModelVersion).toBe("market-context-v1");
    expect(snapshot.competitorSettings[0].configuredWeight).toBe(35);
    expect(snapshot.stayDates[0].competitors[0].normalizedEffectiveWeight).toBe(.35);
  });
});
