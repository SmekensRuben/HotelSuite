import { describe, expect, it, vi } from "vitest";

vi.mock("../firebaseConfig", () => ({
  addDoc: vi.fn(), collection: vi.fn(), db: {}, deleteDoc: vi.fn(), doc: vi.fn(), getDoc: vi.fn(), getDocs: vi.fn(),
  documentId: vi.fn(), limit: vi.fn(), onSnapshot: vi.fn(), orderBy: vi.fn(), query: vi.fn(), serverTimestamp: vi.fn(), setDoc: vi.fn(), updateDoc: vi.fn(),
}));

import { buildQuoteDecisionSnapshot, competitorGroupQuotesPath, getAuthoritativeQuoteMealBasis, GROUP_QUOTE_ANALYSIS_MODEL_VERSION, hasAnalysisAffectingChanges, MARKET_CONTEXT_MODEL_VERSION, QUOTE_STATUSES, saveQuoteOutcome, validateCompetitorGroupObservation } from "./firebaseQuotes";
import { doc, setDoc, updateDoc } from "../firebaseConfig";

const quote = {
  name: "Original", startDate: "2027-04-01", endDate: "2027-04-02",
  roomsByDate: [{ date: "2027-04-01", rooms: 10, bqtRevenue: 100 }],
  breakfastPax: 20, groupCommissionPercentage: 10,
};

describe("saved Group Quote analysis validity", () => {
  it("uses the Future Group Value V2 model version", () => expect(GROUP_QUOTE_ANALYSIS_MODEL_VERSION).toBe("group-contribution-v4-net-group-value"));
  it("does not invalidate analysis for a name-only edit", () => expect(hasAnalysisAffectingChanges(quote, { ...quote, name: "Renamed" })).toBe(false));
  it.each([
    ["stay dates", { ...quote, endDate: "2027-04-03" }],
    ["requested rooms", { ...quote, roomsByDate: [{ ...quote.roomsByDate[0], rooms: 11 }] }],
    ["BQT revenue", { ...quote, roomsByDate: [{ ...quote.roomsByDate[0], bqtRevenue: 101 }] }],
    ["Breakfast Pax", { ...quote, breakfastPax: 21 }],
    ["commission", { ...quote, groupCommissionPercentage: 11 }],
  ])("invalidates analysis when %s change", (_label, update) => expect(hasAnalysisAffectingChanges(quote, update)).toBe(true));
});

describe("commercial outcome workflow", () => {
  const savedQuote = { ...quote, id: "quote-1", dateRangeSemantics: "CHECKOUT_EXCLUSIVE", quoteInputSchemaVersion: "group-quote-v2", requestDate: "2027-01-01", pricingGuidanceSnapshot: { economicFloorRateInclVat: 180, targetRateInclVat: 220, stretchRateInclVat: 240, proposedRateMealBasis: "BB", displacementRatio: .4, marketAnchorInclVat: 245, weightedMarketDemand: .8 }, marketContextSnapshot: { groupStaySummary: { marketPricingConfidence: "HIGH" }, stayDates: [{ stayDate: "2027-04-01", competitors: [{ competitorId: "pillows", publicRateInclVat: 300 }] }] } };
  it("uses explicit nightly meal basis for outcomes and rate history", async () => {
    const explicit = { ...savedQuote, roomsByDate: [{ ...savedQuote.roomsByDate[0], mealBasis: "BB", breakfastPax: 0 }, { date: "2027-04-02", rooms: 10, mealBasis: "RO", breakfastPax: 20, bqtRevenue: 0 }], rateHistory: [] };
    expect(getAuthoritativeQuoteMealBasis(explicit)).toBe("MIXED");
    updateDoc.mockResolvedValue();
    await saveQuoteOutcome("hotel", explicit, { status: "WON", finalQuotedRateInclVat: 219, finalQuotedMealBasis: "BB" });
    expect(updateDoc.mock.calls.at(-1)[1]).toMatchObject({ outcome: { finalQuotedMealBasis: "MIXED" }, rateHistory: [{ rateInclVat: 219, mealBasis: "MIXED" }] });
  });
  it("does not reuse breakfast-derived guidance labels for pre-V3 quotes", () => {
    expect(getAuthoritativeQuoteMealBasis(savedQuote)).toBe("LEGACY_UNKNOWN");
  });
  it("supports every controlled lifecycle status and freezes decision evidence", () => {
    expect(QUOTE_STATUSES).toEqual(["PENDING", "WON", "LOST", "DECLINED", "CANCELLED"]);
    expect(buildQuoteDecisionSnapshot(savedQuote, { finalQuotedRateInclVat: 219, finalQuotedMealBasis: "BB" })).toMatchObject({ economicFloorRateInclVat: 180, targetRateInclVat: 220, finalQuotedRateInclVat: 219, quoteMealBasis: "BB", marketContextConfidence: "HIGH" });
  });
  it("updates one stable canonical observation from saved public-rate context on repeated LOST saves", async () => {
    doc.mockImplementation((_db, path) => path); updateDoc.mockResolvedValue(); setDoc.mockResolvedValue();
    const input = { status: "LOST", lostReason: "PRICE", lostToCompetitorId: "pillows", competitorQuotedRateInclVat: 229, competitorMealBasis: "BB", competitorOccupancyBasis: "DOUBLE", competitorSourceConfidence: "HIGH", finalQuotedMealBasis: "BB", competitors: [{ id: "pillows", displayName: "Pillows" }] };
    await saveQuoteOutcome("hotel", savedQuote, input); await saveQuoteOutcome("hotel", savedQuote, input);
    const observationCalls = setDoc.mock.calls.filter(([path]) => String(path).endsWith("competitorGroupQuotes/quote-1_pillows"));
    expect(observationCalls).toHaveLength(2);
    expect(new Set(observationCalls.map(([path]) => path)).size).toBe(1);
    expect(observationCalls[0][1]).toMatchObject({ sourceQuoteId: "quote-1", publicRatesByDate: [{ stayDate: "2027-04-01", publicRateInclVat: 300 }], competitorQuotedRateInclVat: 229, mealBasis: "BB" });
  });
});

describe("competitor group intelligence foundation", () => {
  const observation = {
    competitorId: "pillows", sourceType: "LOST_GROUP", competitorQuotedRateInclVat: "229",
    mealBasis: "BB", occupancyBasis: "DOUBLE", sourceConfidence: "HIGH",
  };

  it("uses a separate canonical collection and component model version", () => {
    expect(competitorGroupQuotesPath("hotel-1")).toBe("hotels/hotel-1/competitorGroupQuotes");
    expect(MARKET_CONTEXT_MODEL_VERSION).toBe("market-context-v1.1-rate-quality");
  });

  it("preserves controlled product/evidence fields and permits optional quote/public-rate links", () => {
    expect(validateCompetitorGroupObservation(observation)).toMatchObject({ competitorQuotedRateInclVat: 229, mealBasis: "BB", occupancyBasis: "DOUBLE", sourceConfidence: "HIGH" });
    expect(validateCompetitorGroupObservation({ ...observation, sourceQuoteId: "quote-1", publicRateAtObservationInclVat: 300 })).toMatchObject({ sourceQuoteId: "quote-1", publicRateAtObservationInclVat: 300 });
  });

  it("rejects uncontrolled categorical values", () => {
    expect(() => validateCompetitorGroupObservation({ ...observation, mealBasis: "BREAKFAST_MAYBE" })).toThrow("Invalid mealBasis");
  });
});
