import { describe, expect, it, vi } from "vitest";

vi.mock("../firebaseConfig", () => ({
  addDoc: vi.fn(), collection: vi.fn(), db: {}, deleteDoc: vi.fn(), doc: vi.fn(), getDoc: vi.fn(), getDocs: vi.fn(),
  documentId: vi.fn(), limit: vi.fn(), onSnapshot: vi.fn(), orderBy: vi.fn(), query: vi.fn(), serverTimestamp: vi.fn(), setDoc: vi.fn(), updateDoc: vi.fn(),
}));

import { competitorGroupQuotesPath, GROUP_QUOTE_ANALYSIS_MODEL_VERSION, hasAnalysisAffectingChanges, MARKET_CONTEXT_MODEL_VERSION, validateCompetitorGroupObservation } from "./firebaseQuotes";

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

describe("competitor group intelligence foundation", () => {
  const observation = {
    competitorId: "pillows", sourceType: "LOST_GROUP", competitorQuotedRateInclVat: "229",
    mealBasis: "BB", occupancyBasis: "DOUBLE", sourceConfidence: "HIGH",
  };

  it("uses a separate canonical collection and component model version", () => {
    expect(competitorGroupQuotesPath("hotel-1")).toBe("hotels/hotel-1/competitorGroupQuotes");
    expect(MARKET_CONTEXT_MODEL_VERSION).toBe("market-context-v1");
  });

  it("preserves controlled product/evidence fields and permits optional quote/public-rate links", () => {
    expect(validateCompetitorGroupObservation(observation)).toMatchObject({ competitorQuotedRateInclVat: 229, mealBasis: "BB", occupancyBasis: "DOUBLE", sourceConfidence: "HIGH" });
    expect(validateCompetitorGroupObservation({ ...observation, sourceQuoteId: "quote-1", publicRateAtObservationInclVat: 300 })).toMatchObject({ sourceQuoteId: "quote-1", publicRateAtObservationInclVat: 300 });
  });

  it("rejects uncontrolled categorical values", () => {
    expect(() => validateCompetitorGroupObservation({ ...observation, mealBasis: "BREAKFAST_MAYBE" })).toThrow("Invalid mealBasis");
  });
});
