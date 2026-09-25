import { describe, expect, it } from "vitest";
import { enumerateDates, evaluateOperationalBalance, getDefaultBalanceRange, normalizeRoomsByType, validateBalanceSettings } from "./marshaBalance";

const settings = (overrides = {}) => ({
  operaRoomTypes: [
    { code: "EXEC", classification: "physical", protectedRooms: 0, protectionMode: "hard" },
    { code: "SUITE", classification: "physical", protectedRooms: 0, protectionMode: "hard" },
  ],
  salesCategories: [{ code: "EXEC", confirmed: true, allowedOperaTypes: ["EXEC", "SUITE"], releasePolicy: "strict", earlyReleaseLimit: 0, overbookingLimit: 0 }],
  hotelOverbookingLimit: 0,
  hotelOverbookingConfirmed: false,
  hotelSalesLimit: null,
  hotelSalesLimitConfirmed: false,
  exceptions: [],
  ...overrides,
});

describe("MARSHA Balance operational assessment", () => {
  it("uses Brussels calendar boundaries and includes 31 days", () => {
    const range = getDefaultBalanceRange(new Date("2026-03-28T23:30:00Z"));
    expect(range.from).toBe("2026-03-29");
    expect(enumerateDates(range.from, range.to)).toHaveLength(31);
  });

  it("preserves missing, zero, negative and Total values as distinct source data", () => {
    expect(normalizeRoomsByType({ EXEC: 0, SUITE: -1, Total: 7, invalid: "2" })).toEqual({ EXEC: 0, SUITE: -1, Total: 7 });
  });

  it("covers EXEC through an allowed suite upgrade", () => {
    const result = evaluateOperationalBalance({ EXEC: 1 }, { EXEC: 0, SUITE: 1 }, settings(), "2026-09-25");
    expect(result.code).toBe("upgrade");
    expect(result.categories[0]).toMatchObject({ higherUsed: 1, uncovered: 0 });
  });

  it("requires action for demonstrably uncovered availability", () => {
    expect(evaluateOperationalBalance({ EXEC: 1 }, { EXEC: 0, SUITE: 0 }, settings(), "2026-09-25")).toMatchObject({ code: "action" });
    expect(evaluateOperationalBalance({ EXEC: 2 }, { EXEC: 0, SUITE: 1 }, settings(), "2026-09-25").categories[0]).toMatchObject({ uncovered: 1, code: "action" });
  });

  it("uses preferred rooms first and reports higher rooms and soft protection", () => {
    const config = settings({
      operaRoomTypes: [
        { code: "QNK", classification: "physical", protectedRooms: 0, protectionMode: "hard" },
        { code: "DBDB", classification: "physical", protectedRooms: 1, protectionMode: "soft" },
      ],
      salesCategories: [{ code: "GENR", confirmed: true, allowedOperaTypes: ["QNK", "DBDB"], releasePolicy: "strict", overbookingLimit: 0 }],
    });
    const result = evaluateOperationalBalance({ GENR: 6 }, { QNK: 4, DBDB: 3 }, config, "2026-09-25");
    expect(result.categories[0].placements).toEqual([
      { operaType: "QNK", rooms: 4, kind: "preferred", protectedUse: 0 },
      { operaType: "DBDB", rooms: 2, kind: "upgrade", protectedUse: 0 },
    ]);
    expect(result.categories[0].code).toBe("upgrade");
  });

  it("treats a closed premium category as an intentional sales choice", () => {
    const config = settings({ salesCategories: [{ code: "SUITE", confirmed: true, allowedOperaTypes: ["SUITE"], releasePolicy: "strict", overbookingLimit: 0 }] });
    expect(evaluateOperationalBalance({ SUITE: 0 }, { EXEC: 0, SUITE: 2 }, config, "2026-09-25")).toMatchObject({ code: "intentional" });
  });

  it("marks shared suite capacity for review instead of counting it twice", () => {
    const config = settings({ salesCategories: [
      { code: "EXEC", confirmed: true, allowedOperaTypes: ["EXEC", "SUITE"], releasePolicy: "strict", overbookingLimit: 0 },
      { code: "SUITE", confirmed: true, allowedOperaTypes: ["SUITE"], releasePolicy: "strict", overbookingLimit: 0 },
    ] });
    const result = evaluateOperationalBalance({ EXEC: 1, SUITE: 1 }, { EXEC: 0, SUITE: 1 }, config, "2026-09-25");
    expect(result.code).toBe("review");
    expect(result.categories.some((item) => item.sharedTypes.includes("SUITE"))).toBe(true);
  });

  it("uses a confirmed hotel-wide sales limit", () => {
    const config = settings({ hotelSalesLimitConfirmed: true, hotelSalesLimit: 0 });
    expect(evaluateOperationalBalance({ EXEC: 1 }, { EXEC: 1, SUITE: 0 }, config, "2026-09-25")).toMatchObject({ code: "action", hotelLimitExceeded: true });
  });

  it("uses a suite for an existing EXEC deficit before new availability", () => {
    const result = evaluateOperationalBalance({ EXEC: 1 }, { EXEC: -1, SUITE: 1 }, settings(), "2026-09-25");
    expect(result.placements).toContainEqual({ categoryCode: "EXEC", operaType: "SUITE", rooms: 1, purpose: "cover existing EXEC deficit" });
    expect(result.categories[0]).toMatchObject({ uncovered: 1, code: "action" });
  });

  it("never treats unconfirmed categories as within rules", () => {
    const config = settings({ salesCategories: [{ code: "EXEC", confirmed: false, allowedOperaTypes: [] }] });
    expect(evaluateOperationalBalance({ EXEC: 0 }, { EXEC: 1, SUITE: 1 }, config, "2026-09-25").code).toBe("unconfigured");
  });

  it("never treats an unclassified Opera code as within rules", () => {
    expect(evaluateOperationalBalance({ EXEC: 0 }, { EXEC: 1, SUITE: 1, HOUSE: 4 }, settings(), "2026-09-25")).toMatchObject({ code: "unconfigured" });
  });

  it("validates that allowed types are confirmed physical Opera types", () => {
    expect(validateBalanceSettings(settings({ salesCategories: [{ code: "EXEC", confirmed: true, allowedOperaTypes: ["VIRTUAL"] }] }))).toContain("VIRTUAL is not configured as a physical Opera room type.");
  });
});
