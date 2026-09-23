import { describe, expect, it } from "vitest";
import { enumerateDates, evaluateBalance, findOverlappingOperaTypes, getDefaultBalanceRange, normalizeRoomsByType } from "./marshaBalance";

const rule = { id: "one", enabled: true, marshaRoomType: "GENR", operaRoomTypes: ["QNK", "DBDB"], comparisonMode: "exact", reservedRooms: 1, allowedDeviation: 0 };

describe("MARSHA Balance", () => {
  it("uses Brussels calendar boundaries and includes 31 days", () => {
    const range = getDefaultBalanceRange(new Date("2026-03-28T23:30:00Z"));
    expect(range.from).toBe("2026-03-29");
    expect(enumerateDates(range.from, range.to)).toHaveLength(31);
  });

  it("retains zero and negative values but excludes Total", () => {
    expect(normalizeRoomsByType({ GENR: 0, QNQN: -1, Total: -1, invalid: "2" })).toEqual({ GENR: 0, QNQN: -1 });
  });

  it("distinguishes a missing room type from zero", () => {
    expect(evaluateBalance({ GENR: 0 }, { QNK: 1, DBDB: 0 }, [rule]).status).toBe("ok");
    expect(evaluateBalance({}, { QNK: 1, DBDB: 0 }, [rule]).status).toBe("unassessable");
  });

  it("does not allow the same Opera inventory in multiple active rules", () => {
    const rules = [rule, { ...rule, id: "two", marshaRoomType: "QNQN", operaRoomTypes: ["QNK"] }];
    expect(findOverlappingOperaTypes(rules)).toEqual(["QNK"]);
    expect(evaluateBalance({ GENR: 1, QNQN: 1 }, { QNK: 1, DBDB: 1 }, rules).status).toBe("unassessable");
  });
});
