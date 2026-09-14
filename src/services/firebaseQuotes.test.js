import { describe, expect, it, vi } from "vitest";

vi.mock("../firebaseConfig", () => ({
  addDoc: vi.fn(), collection: vi.fn(), db: {}, deleteDoc: vi.fn(), doc: vi.fn(), getDoc: vi.fn(), getDocs: vi.fn(),
  documentId: vi.fn(), limit: vi.fn(), onSnapshot: vi.fn(), orderBy: vi.fn(), query: vi.fn(), serverTimestamp: vi.fn(), setDoc: vi.fn(), updateDoc: vi.fn(),
}));

import { GROUP_QUOTE_ANALYSIS_MODEL_VERSION, hasAnalysisAffectingChanges } from "./firebaseQuotes";

const quote = {
  name: "Original", startDate: "2027-04-01", endDate: "2027-04-02",
  roomsByDate: [{ date: "2027-04-01", rooms: 10, bqtRevenue: 100 }],
  breakfastPax: 20, groupCommissionPercentage: 10,
};

describe("saved Group Quote analysis validity", () => {
  it("uses the Future Group Value V2 model version", () => expect(GROUP_QUOTE_ANALYSIS_MODEL_VERSION).toBe("group-contribution-v2-group-value"));
  it("does not invalidate analysis for a name-only edit", () => expect(hasAnalysisAffectingChanges(quote, { ...quote, name: "Renamed" })).toBe(false));
  it.each([
    ["stay dates", { ...quote, endDate: "2027-04-03" }],
    ["requested rooms", { ...quote, roomsByDate: [{ ...quote.roomsByDate[0], rooms: 11 }] }],
    ["BQT revenue", { ...quote, roomsByDate: [{ ...quote.roomsByDate[0], bqtRevenue: 101 }] }],
    ["Breakfast Pax", { ...quote, breakfastPax: 21 }],
    ["commission", { ...quote, groupCommissionPercentage: 11 }],
  ])("invalidates analysis when %s change", (_label, update) => expect(hasAnalysisAffectingChanges(quote, update)).toBe(true));
});
