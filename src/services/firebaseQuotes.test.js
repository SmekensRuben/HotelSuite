import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../firebaseConfig", () => ({
  addDoc: vi.fn(), collection: vi.fn(), db: {}, deleteDoc: vi.fn(), doc: vi.fn(), getDoc: vi.fn(), getDocs: vi.fn(),
  documentId: vi.fn(), functions: {}, httpsCallable: vi.fn(), limit: vi.fn(), onSnapshot: vi.fn(), orderBy: vi.fn(), query: vi.fn(), serverTimestamp: vi.fn(), setDoc: vi.fn(), updateDoc: vi.fn(), writeBatch: vi.fn(),
}));

import { addQuote, buildQuoteDecisionSnapshot, competitorGroupQuotesPath, getAuthoritativeQuoteMealBasis, getStayPatternModelEvidence, GROUP_QUOTE_ANALYSIS_MODEL_VERSION, hasAnalysisAffectingChanges, MARKET_CONTEXT_MODEL_VERSION, normalizeOptionalRate, prepareQuoteForSave, QUOTE_STATUSES, saveCompsetConfiguration, saveQuoteOutcome, validateCompetitorGroupObservation } from "./firebaseQuotes";
import { addDoc, collection, doc, getDoc, getDocs, setDoc, updateDoc, writeBatch } from "../firebaseConfig";

beforeEach(() => {
  vi.clearAllMocks();
  writeBatch.mockImplementation(() => ({ set: vi.fn(), update: vi.fn(), delete: vi.fn(), commit: vi.fn().mockResolvedValue() }));
});

const quote = {
  name: "Original", startDate: "2027-04-01", endDate: "2027-04-02",
  roomsByDate: [{ date: "2027-04-01", rooms: 10, bqtRevenue: 100 }],
  breakfastPax: 20, groupCommissionPercentage: 10,
};

describe("saved Group Quote analysis validity", () => {
  it("versions the optimal-portfolio contribution model separately from historical evidence", () => expect(GROUP_QUOTE_ANALYSIS_MODEL_VERSION).toBe("group-contribution-v5-optimal-portfolio"));
  it("does not invalidate analysis for a name-only edit", () => expect(hasAnalysisAffectingChanges(quote, { ...quote, name: "Renamed" })).toBe(false));
  it.each([
    ["stay dates", { ...quote, endDate: "2027-04-03" }],
    ["requested rooms", { ...quote, roomsByDate: [{ ...quote.roomsByDate[0], rooms: 11 }] }],
    ["BQT revenue", { ...quote, roomsByDate: [{ ...quote.roomsByDate[0], bqtRevenue: 101 }] }],
    ["Breakfast Pax", { ...quote, breakfastPax: 21 }],
    ["commission", { ...quote, groupCommissionPercentage: 11 }],
    ["analysis years", { ...quote, analysisYears: [2026] }],
    ["request date", { ...quote, requestDate: "2026-10-10" }],
    ["segment", { ...quote, groupSegment: "MICE" }],
    ["date semantics", { ...quote, dateRangeSemantics: "CHECKOUT_EXCLUSIVE" }],
    ["input schema", { ...quote, quoteInputSchemaVersion: "group-quote-v3" }],
  ])("invalidates analysis when %s change", (_label, update) => expect(hasAnalysisAffectingChanges(quote, update)).toBe(true));
  it("saves an explicitly unavailable draft without source/nightly analysis and clears commercial guidance", async () => {
    addDoc.mockResolvedValue({ id: "draft-1" });
    await expect(addQuote("hotel", { ...quote, analysisStatus: "UNAVAILABLE", draft: true, pricingGuidanceSnapshot: { targetRateInclVat: 0 }, analysisContributionSnapshot: { economicFloorRateInclVat: 0 } })).resolves.toBe("draft-1");
    expect(addDoc.mock.calls[0][1]).toMatchObject({ analysisStatus: "UNAVAILABLE", pricingGuidanceSnapshot: null, analysisContributionSnapshot: null });
  });
  it("rejects unavailable data labeled current while retaining old snapshot versions for reads/outcomes", () => {
    expect(() => prepareQuoteForSave({ ...quote, analysisStatus: "CURRENT" })).toThrow("unavailable draft");
    expect(buildQuoteDecisionSnapshot({ ...quote, analysisModelVersion: "historical-v1", analysisContributionSnapshot: { economicFloorRateInclVat: 140 } }, {})).toMatchObject({ contributionModelVersion: "historical-v1", analysisStatus: "UNAVAILABLE", economicFloorRateInclVat: null });
  });
  it("rejects unknown statuses and current analysis without positive feasibility evidence", () => {
    expect(() => prepareQuoteForSave({ ...quote, analysisStatus: "UNKNOWN" })).toThrow("Invalid quote analysis status");
    expect(() => prepareQuoteForSave({ ...quote, analysisStatus: "CURRENT", analysisModelVersion: "v5", sourceAvailabilitySnapshot: {}, analysisContributionSnapshot: { economicFloorRateInclVat: 150 }, physicalFeasibility: { status: "UNKNOWN" } })).toThrow("unavailable draft");
  });
  it("returns root lifecycle evidence beside annual models so stale roots cannot be hidden", async () => {
    doc.mockImplementation((_db, path) => path);
    getDoc.mockImplementation(async (path) => ({ exists: () => true, id: path.split("/").at(-1), data: () => path.endsWith("stayPatternModel") ? { status: "VALIDATION_FAILED", sourceFingerprint: "new-source" } : { status: "VALID", sourceFingerprint: "old-source" } }));
    expect(await getStayPatternModelEvidence("hotel", [2024])).toMatchObject({ root: { status: "VALIDATION_FAILED" }, years: [{ year: 2024, status: "VALID" }] });
  });
  it("rejects nonfinite physical evidence even when the floor is finite", () => {
    expect(() => prepareQuoteForSave({ ...quote, analysisStatus: "CURRENT", analysisModelVersion: "v5", sourceAvailabilitySnapshot: {}, analysisContributionSnapshot: { economicFloorRateInclVat: 150 }, physicalFeasibility: { status: "PHYSICALLY_FEASIBLE", requestedRoomNights: Infinity } })).toThrow("unavailable draft");
  });
});

describe("commercial outcome workflow", () => {
  const savedQuote = { ...quote, id: "quote-1", analysisStatus: "CURRENT", dateRangeSemantics: "CHECKOUT_EXCLUSIVE", quoteInputSchemaVersion: "group-quote-v2", requestDate: "2027-01-01", pricingGuidanceSnapshot: { economicFloorRateInclVat: 180, targetRateInclVat: 220, stretchRateInclVat: 240, proposedRateMealBasis: "BB", displacementRatio: .4, marketAnchorInclVat: 245, weightedMarketDemand: .8 }, marketContextSnapshot: { groupStaySummary: { marketPricingConfidence: "HIGH" }, stayDates: [{ stayDate: "2027-04-01", competitors: [{ competitorId: "pillows", publicRateInclVat: 300 }] }] } };
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
    await saveQuoteOutcome("hotel", savedQuote, input, { recordCompetitorObservation: true }); await saveQuoteOutcome("hotel", savedQuote, input, { recordCompetitorObservation: true });
    const batches = writeBatch.mock.results.map((result) => result.value);
    const observationCalls = batches.flatMap((batch) => batch.set.mock.calls).filter(([path]) => String(path).endsWith("competitorGroupQuotes/quote-1_pillows"));
    expect(observationCalls).toHaveLength(2);
    expect(new Set(observationCalls.map(([path]) => path)).size).toBe(1);
    expect(observationCalls[0][1]).toMatchObject({ sourceQuoteId: "quote-1", publicRatesByDate: [{ stayDate: "2027-04-01", publicRateInclVat: 300 }], competitorQuotedRateInclVat: 229, mealBasis: "BB" });
    expect(batches.every((batch) => batch.update.mock.calls.length === 1 && batch.commit.mock.calls.length === 1)).toBe(true);
    expect(updateDoc).not.toHaveBeenCalled();
    expect(setDoc).not.toHaveBeenCalled();
  });
  it.each([null, undefined, "", "  "])("preserves unknown competitor rate %s and creates no zero-price observation", async (value) => {
    updateDoc.mockResolvedValue();
    const result = await saveQuoteOutcome("hotel", savedQuote, { status: "LOST", lostToCompetitorId: "pillows", competitorQuotedRateInclVat: value });
    expect(result.competitorQuotedRateInclVat).toBeNull();
    expect(setDoc).not.toHaveBeenCalled();
    expect(writeBatch).not.toHaveBeenCalled();
  });
  it("records an explicitly entered zero as a real observation", async () => {
    doc.mockImplementation((_db, path) => path); updateDoc.mockResolvedValue(); setDoc.mockResolvedValue();
    await saveQuoteOutcome("hotel", savedQuote, { status: "LOST", lostToCompetitorId: "pillows", competitorQuotedRateInclVat: 0 }, { recordCompetitorObservation: true });
    expect(writeBatch.mock.results[0].value.set.mock.calls[0][1].competitorQuotedRateInclVat).toBe(0);
    expect(normalizeOptionalRate("0")).toBe(0);
  });
  it("saves a quote-only editor's known LOST outcome without attempting commercial intelligence writes", async () => {
    updateDoc.mockResolvedValue();
    await saveQuoteOutcome("hotel", savedQuote, { status: "LOST", lostToCompetitorId: "pillows", competitorQuotedRateInclVat: 200 });
    expect(updateDoc).toHaveBeenCalledTimes(1);
    expect(writeBatch).not.toHaveBeenCalled();
    expect(setDoc).not.toHaveBeenCalled();
  });
  it("rejects a coupled observation atomically without first persisting the quote outcome", async () => {
    const batch = { set: vi.fn(), update: vi.fn(), commit: vi.fn().mockRejectedValue(new Error("permission denied")) };
    writeBatch.mockReturnValue(batch);
    await expect(saveQuoteOutcome("hotel", savedQuote, { status: "LOST", lostToCompetitorId: "pillows", competitorQuotedRateInclVat: 200 }, { recordCompetitorObservation: true })).rejects.toThrow("permission denied");
    expect(batch.update).toHaveBeenCalledTimes(1);
    expect(batch.set).toHaveBeenCalledTimes(1);
    expect(batch.commit).toHaveBeenCalledTimes(1);
    expect(updateDoc).not.toHaveBeenCalled();
    expect(setDoc).not.toHaveBeenCalled();
  });
  it("validates a requested observation before either write is queued", async () => {
    await expect(saveQuoteOutcome("hotel", savedQuote, { status: "LOST", lostToCompetitorId: "pillows", competitorQuotedRateInclVat: 200, competitorMealBasis: "BAD" }, { recordCompetitorObservation: true })).rejects.toThrow("Invalid mealBasis");
    expect(updateDoc).not.toHaveBeenCalled();
    expect(writeBatch).not.toHaveBeenCalled();
  });
  it.each([{ status: "LOST", lostToCompetitorId: "pillows", competitorQuotedRateInclVat: "" }, { status: "LOST", competitorQuotedRateInclVat: 100 }, { status: "PENDING", lostToCompetitorId: "pillows", competitorQuotedRateInclVat: 100 }])("rejects incomplete requested observations before any quote write (%j)", async (input) => {
    await expect(saveQuoteOutcome("hotel", savedQuote, input, { recordCompetitorObservation: true })).rejects.toThrow("requires a lost quote");
    expect(updateDoc).not.toHaveBeenCalled(); expect(writeBatch).not.toHaveBeenCalled();
  });
  it.each(["STALE", "UNAVAILABLE"])("suppresses prior commercial guidance in a %s decision while preserving saved evidence", (analysisStatus) => {
    const prior = { ...savedQuote, analysisStatus, analysisStaleReason: "QUOTE_INPUTS_CHANGED", analysisUnavailableReason: "Sources missing" };
    const originalGuidance = { ...prior.pricingGuidanceSnapshot };
    expect(buildQuoteDecisionSnapshot(prior, {})).toMatchObject({ analysisStatus, analysisStaleReason: "QUOTE_INPUTS_CHANGED", analysisUnavailableReason: "Sources missing", economicFloorRateInclVat: null, targetRateInclVat: null, stretchRateInclVat: null });
    expect(prior.pricingGuidanceSnapshot).toEqual(originalGuidance);
  });
});

describe("competitor group intelligence foundation", () => {
  const observation = {
    competitorId: "pillows", sourceType: "LOST_GROUP", competitorQuotedRateInclVat: "229",
    mealBasis: "BB", occupancyBasis: "DOUBLE", sourceConfidence: "HIGH",
  };

  it("uses a separate canonical collection and component model version", () => {
    expect(competitorGroupQuotesPath("hotel-1")).toBe("hotels/hotel-1/competitorGroupQuotes");
    expect(MARKET_CONTEXT_MODEL_VERSION).toBe("market-context-v1.2-source-horizon");
  });

  it("preserves controlled product/evidence fields and permits optional quote/public-rate links", () => {
    expect(validateCompetitorGroupObservation(observation)).toMatchObject({ competitorQuotedRateInclVat: 229, mealBasis: "BB", occupancyBasis: "DOUBLE", sourceConfidence: "HIGH" });
    expect(validateCompetitorGroupObservation({ ...observation, sourceQuoteId: "quote-1", publicRateAtObservationInclVat: 300 })).toMatchObject({ sourceQuoteId: "quote-1", publicRateAtObservationInclVat: 300 });
  });

  it("rejects uncontrolled categorical values", () => {
    expect(() => validateCompetitorGroupObservation({ ...observation, mealBasis: "BREAKFAST_MAYBE" })).toThrow("Invalid mealBasis");
  });
  it.each([null, undefined, "", "  "])("rejects unknown standalone observation rate %s", (value) => {
    expect(() => validateCompetitorGroupObservation({ ...observation, competitorQuotedRateInclVat: value })).toThrow("known competitor");
  });
});

describe("atomic compset saves", () => {
  it("commits configuration, competitor replacements and removed competitors in one batch", async () => {
    doc.mockImplementation((_db, path) => path); collection.mockImplementation((_db, path) => path);
    getDocs.mockResolvedValue({ size: 2, docs: [{ id: "old", ref: "old-ref" }, { id: "kept", ref: "kept-ref" }] });
    const batch = { set: vi.fn(), delete: vi.fn(), commit: vi.fn().mockResolvedValue() }; writeBatch.mockReturnValue(batch);
    await saveCompsetConfiguration("hotel", { ownHotelLighthouseFieldName: "Own" }, [{ id: "kept", displayName: "Kept", marketRelevanceWeight: 1 }]);
    expect(batch.set).toHaveBeenCalledTimes(2); expect(batch.delete).toHaveBeenCalledWith("old-ref"); expect(batch.commit).toHaveBeenCalledTimes(1);
    expect(setDoc).not.toHaveBeenCalled();
  });
  it("surfaces a rejected atomic commit without independent configuration writes", async () => {
    getDocs.mockResolvedValue({ size: 0, docs: [] });
    writeBatch.mockReturnValue({ set: vi.fn(), delete: vi.fn(), commit: vi.fn().mockRejectedValue(new Error("permission denied")) });
    await expect(saveCompsetConfiguration("hotel", {}, [{ id: "valid", displayName: "Valid", marketRelevanceWeight: 1 }])).rejects.toThrow("permission denied");
    expect(setDoc).not.toHaveBeenCalled();
  });
});
