import { describe, expect, it } from "vitest";
import { enumerateDates, evaluateSimplifiedBalance, extractMappedTotal, getDefaultBalanceRange, getSourceState, isWeekendStayDate, normalizeRoomsByType } from "./marshaBalance";

const baseSettings = (overrides = {}) => ({ minimumGenr: 5, premiumCategories: [], weekendDbdbProtection: true, ...overrides });
const evaluate = ({ marshaRooms = { GENR: 3 }, operaRooms = { DBDB: 0 }, marshaTotal = 3, operaTotal = 3, settings = baseSettings(), stayDate = "2026-09-24" } = {}) => evaluateSimplifiedBalance({ marshaRooms, operaRooms, marshaTotal, operaTotal, settings, stayDate });

describe("MARSHA Balance simplified controls", () => {
  it("uses Brussels calendar boundaries and includes 31 days", () => {
    const range = getDefaultBalanceRange(new Date("2026-03-28T23:30:00Z"));
    expect(range.from).toBe("2026-03-29");
    expect(enumerateDates(range.from, range.to)).toHaveLength(31);
  });

  it("reads the explicitly mapped total without summing room types", () => {
    expect(extractMappedTotal({ total: 7, roomsByType: { GENR: 4, EXEC: 8 } })).toEqual({ value: 7, field: "total" });
    expect(extractMappedTotal({ roomsByType: { GENR: 4, Total: 6 } })).toEqual({ value: 6, field: "roomsByType.Total" });
    expect(normalizeRoomsByType({ GENR: 4, Total: 6 })).toEqual({ GENR: 4 });
  });

  it("caps the normal GENR minimum at the MARSHA total", () => {
    const result = evaluate({ marshaRooms: { GENR: 2 }, operaRooms: { DBDB: 0 }, marshaTotal: 3, operaTotal: 3 });
    expect(result.minimumGenr).toBe(3);
    expect(result.alerts).toContainEqual(expect.objectContaining({ code: "genr_minimum", minimumGenr: 3, marshaGenr: 2 }));
  });

  it("uses Friday and Saturday from the stay date", () => {
    expect(isWeekendStayDate("2026-09-25")).toBe(true);
    expect(isWeekendStayDate("2026-09-26")).toBe(true);
    expect(isWeekendStayDate("2026-09-27")).toBe(false);
  });

  it("does not allow legacy settings to disable weekend DBDB protection", () => {
    const result = evaluate({ marshaRooms: { GENR: 8 }, operaRooms: { DBDB: 3 }, marshaTotal: 10, operaTotal: 10, stayDate: "2026-09-25", settings: baseSettings({ weekendDbdbProtection: false }) });
    expect(result.alerts).toContainEqual(expect.objectContaining({ code: "weekend_limit", excess: 1 }));
  });

  it("accepts GENR at the Friday DBDB boundary and rejects one above it", () => {
    const safe = evaluate({ marshaRooms: { GENR: 7 }, operaRooms: { DBDB: 3 }, marshaTotal: 10, operaTotal: 10, stayDate: "2026-09-25" });
    expect(safe.weekendMaximumGenr).toBe(7);
    expect(safe.alerts.some((item) => item.code === "weekend_limit")).toBe(false);
    const unsafe = evaluate({ marshaRooms: { GENR: 8 }, operaRooms: { DBDB: 3 }, marshaTotal: 10, operaTotal: 10, stayDate: "2026-09-25" });
    expect(unsafe).toMatchObject({ code: "action", weekendMaximumGenr: 7 });
    expect(unsafe.alerts).toContainEqual(expect.objectContaining({ code: "weekend_limit", excess: 1 }));
  });

  it("aligns the Friday minimum and maximum when DBDB is protected", () => {
    const result = evaluate({ marshaRooms: { GENR: 1 }, operaRooms: { DBDB: 3 }, marshaTotal: 4, operaTotal: 4, stayDate: "2026-09-25" });
    expect(result).toMatchObject({ weekendMaximumGenr: 1, minimumGenr: 1 });
    expect(result.alerts).toEqual([]);
  });

  it("warns when a premium shortage is fully covered by a higher type", () => {
    const settings = baseSettings({ minimumGenr: 0, premiumCategories: [{ marshaCode: "EXEC", operaType: "EXEC", allowedHigherOperaTypes: ["SUITE"] }] });
    const result = evaluate({ marshaRooms: { GENR: 0, EXEC: 1 }, operaRooms: { EXEC: 0, SUITE: 1, DBDB: 0 }, marshaTotal: 1, operaTotal: 1, settings });
    expect(result).toMatchObject({ code: "warning" });
    expect(result.categories[0]).toMatchObject({ shortage: 1, coveredByHigher: 1, uncovered: 0, code: "warning" });
  });

  it("requires action for the uncovered part of a premium shortage", () => {
    const settings = baseSettings({ minimumGenr: 0, premiumCategories: [{ marshaCode: "EXEC", operaType: "EXEC", allowedHigherOperaTypes: ["SUITE"] }] });
    const result = evaluate({ marshaRooms: { GENR: 0, EXEC: 2 }, operaRooms: { EXEC: 0, SUITE: 1, DBDB: 0 }, marshaTotal: 2, operaTotal: 2, settings });
    expect(result).toMatchObject({ code: "action" });
    expect(result.categories[0]).toMatchObject({ shortage: 2, coveredByHigher: 1, uncovered: 1 });
  });

  it("does not flag a closed premium category", () => {
    const settings = baseSettings({ premiumCategories: [{ marshaCode: "EXEC", operaType: "EXEC", allowedHigherOperaTypes: ["SUITE"] }] });
    const result = evaluate({ marshaRooms: { GENR: 3, EXEC: 0 }, operaRooms: { EXEC: 2, SUITE: 1, DBDB: 0 }, settings });
    expect(result.categories[0]).toMatchObject({ shortage: 0, code: "ok" });
  });

  it("reports total mismatch using only explicit totals", () => {
    const result = evaluate({ marshaRooms: { GENR: 3 }, operaRooms: { DBDB: 0 }, marshaTotal: 8, operaTotal: 7 });
    expect(result.alerts).toContainEqual(expect.objectContaining({ code: "total_mismatch", marshaTotal: 8, operaTotal: 7, difference: 1 }));
  });

  it("never reports missing totals or negative relevant values as safe", () => {
    expect(evaluate({ marshaTotal: null }).code).toBe("unassessable");
    expect(evaluate({ marshaRooms: { GENR: -1 } }).code).toBe("unreliable");
    const premiumSettings = baseSettings({ premiumCategories: [{ marshaCode: "EXEC", operaType: "EXEC", allowedHigherOperaTypes: ["SUITE"] }] });
    expect(evaluate({ marshaRooms: { GENR: 3, EXEC: 1 }, operaRooms: { EXEC: -1, SUITE: 1, DBDB: 0 }, settings: premiumSettings }).code).toBe("unreliable");
  });

  it("does not calculate a certain weekend boundary from mismatched totals or missing DBDB", () => {
    const mismatch = evaluate({ marshaRooms: { GENR: 4 }, operaRooms: { DBDB: 3 }, marshaTotal: 5, operaTotal: 4, stayDate: "2026-09-25" });
    expect(mismatch.weekendMaximumGenr).toBeNull();
    expect(mismatch.alerts.some((item) => item.code === "weekend_data")).toBe(true);
    const missing = evaluate({ marshaRooms: { GENR: 4 }, operaRooms: {}, marshaTotal: 5, operaTotal: 5, stayDate: "2026-09-25" });
    expect(missing.weekendMaximumGenr).toBeNull();
  });

  it("marks stale, missing, and incomplete snapshot data as not current", () => {
    expect(getSourceState({ stayDocument: {}, snapshotDate: "2026-09-24", today: "2026-09-25" }).status).toBe("stale");
    expect(getSourceState({ stayDocument: null, snapshotDate: "2026-09-25", today: "2026-09-25" }).status).toBe("expected");
    expect(getSourceState({ stayDocument: {}, snapshotDate: "2026-09-25", today: "2026-09-25", metadata: { status: "incomplete" } }).status).toBe("missing");
  });
});
