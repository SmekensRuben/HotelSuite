import { describe, expect, it } from "vitest";
import { evaluateSimplifiedBalance, extractMappedTotal, getSourceState, migrateMarshaBalanceSettings, normalizeRoomsByType, resolveOperaCountingRule, validateBalanceSettings } from "./marshaBalance";

const genrRule = (overrides = {}) => ({ marshaCode: "GENR", normalMinimum: 5, visibilityMinimum: 3, distributionStopsAtZeroConfirmed: true, operaTypeRules: [{ operaType: "DBDB", defaultCounts: true, weekdayOverrides: { 5: false, 6: false }, dateOverrides: [], independentPhysicalInventoryConfirmed: true }], ...overrides });
const settings = (overrides = {}) => ({ availabilityRules: [genrRule()], premiumCategories: [], ...overrides });
const evaluate = (overrides = {}) => evaluateSimplifiedBalance({ marshaRooms: { GENR: 3 }, operaRooms: { DBDB: 0, QNK: 1 }, marshaTotal: 3, operaTotal: 3, settings: settings(), stayDate: "2026-09-24", ...overrides });

describe("MARSHA Balance configurable availability", () => {
  it("uses explicit mapped totals and never treats Total as a room type", () => {
    expect(extractMappedTotal({ total: 7, roomsByType: { GENR: 4, EXEC: 8 } })).toEqual({ value: 7, field: "total" });
    expect(normalizeRoomsByType({ GENR: 4, Total: 6 })).toEqual({ GENR: 4 });
  });

  it("migrates legacy GENR weekend protection without changing Friday/Saturday behavior", () => {
    const migrated = migrateMarshaBalanceSettings({ minimumGenr: 5, weekendDbdbProtection: true, premiumCategories: [] });
    expect(migrated.availabilityRules[0]).toMatchObject({ marshaCode: "GENR", normalMinimum: 5 });
    expect(resolveOperaCountingRule(migrated.availabilityRules[0].operaTypeRules[0], "2026-09-25")).toMatchObject({ counts: false, source: "weekday" });
    expect(resolveOperaCountingRule(migrated.availabilityRules[0].operaTypeRules[0], "2026-09-27")).toMatchObject({ counts: true, source: "default" });
  });

  it("allows total 1 and visible GENR 3 with a suitable room and confirmed stop at zero", () => {
    const result = evaluate({ marshaRooms: { GENR: 3 }, operaRooms: { DBDB: 0, QNK: 1 }, marshaTotal: 1, operaTotal: 1, settings: settings({ availabilityRules: [genrRule({ operaTypeRules: [{ operaType: "QNK", defaultCounts: true, weekdayOverrides: {}, dateOverrides: [], independentPhysicalInventoryConfirmed: true }] })] }) });
    expect(result.code).toBe("ok");
    expect(result.availabilityAssessments[0]).toMatchObject({ effectiveMinimum: 3, suitableRoomAvailable: true });
  });

  it("requires action before visibility exception when total 2 has one excluded DBDB and GENR 3", () => {
    const result = evaluate({ marshaRooms: { GENR: 3 }, operaRooms: { DBDB: 1, QNK: 1 }, marshaTotal: 2, operaTotal: 2, stayDate: "2026-09-26" });
    expect(result.code).toBe("action");
    expect(result.alerts).toContainEqual(expect.objectContaining({ code: "suitable_inventory_limit", suitableInventory: 1, excess: 2 }));
  });

  it("requires action when total is zero but a MARSHA type remains visible", () => {
    const result = evaluate({ marshaRooms: { GENR: 3 }, operaRooms: { DBDB: 0, QNK: 0 }, marshaTotal: 0, operaTotal: 0 });
    expect(result.alerts).toContainEqual(expect.objectContaining({ code: "zero_total_visibility" }));
  });

  it("gives date overrides precedence over weekday and default rules", () => {
    const rule = { operaType: "DBDB", defaultCounts: false, weekdayOverrides: { 5: false, 6: false }, dateOverrides: [{ id: "one", startDate: "2026-09-25", endDate: "2026-09-25", counts: true }] };
    expect(resolveOperaCountingRule(rule, "2026-09-25")).toMatchObject({ counts: true, source: "date" });
    expect(resolveOperaCountingRule(rule, "2026-09-26")).toMatchObject({ counts: false, source: "weekday" });
    expect(resolveOperaCountingRule(rule, "2026-09-27")).toMatchObject({ counts: false, source: "default" });
  });

  it("rejects overlapping inclusive date overrides on save validation", () => {
    const configured = settings({ availabilityRules: [genrRule({ operaTypeRules: [{ operaType: "DBDB", defaultCounts: true, weekdayOverrides: {}, independentPhysicalInventoryConfirmed: true, dateOverrides: [{ startDate: "2026-09-20", endDate: "2026-09-25", counts: false }, { startDate: "2026-09-25", endDate: "2026-09-30", counts: true }] }] })] });
    expect(validateBalanceSettings(configured)).toContain("GENR/DBDB: overlapping date overrides are not allowed.");
  });

  it("reviews low-total visibility when distribution stop-at-zero is not confirmed", () => {
    const configured = settings({ availabilityRules: [genrRule({ distributionStopsAtZeroConfirmed: false, operaTypeRules: [{ operaType: "QNK", defaultCounts: true, weekdayOverrides: {}, dateOverrides: [], independentPhysicalInventoryConfirmed: true }] })] });
    const result = evaluate({ marshaRooms: { GENR: 3 }, operaRooms: { QNK: 1 }, marshaTotal: 1, operaTotal: 1, settings: configured });
    expect(result.alerts).toContainEqual(expect.objectContaining({ code: "visibility_exception_review" }));
  });

  it("cannot reliably subtract excluded inventory without independent physical confirmation", () => {
    const configured = settings({ availabilityRules: [genrRule({ operaTypeRules: [{ operaType: "DBDB", defaultCounts: false, weekdayOverrides: {}, dateOverrides: [], independentPhysicalInventoryConfirmed: false }] })] });
    expect(evaluate({ operaRooms: { DBDB: 1 }, marshaTotal: 2, operaTotal: 2, settings: configured }).code).toBe("unreliable");
  });

  it("retains total mismatch and premium shortage controls", () => {
    const configured = settings({ premiumCategories: [{ marshaCode: "EXEC", operaType: "EXEC", allowedHigherOperaTypes: ["SUITE"] }] });
    const result = evaluate({ marshaRooms: { GENR: 3, EXEC: 2 }, operaRooms: { DBDB: 0, QNK: 1, EXEC: 0, SUITE: 1 }, marshaTotal: 3, operaTotal: 2, settings: configured });
    expect(result.alerts).toEqual(expect.arrayContaining([expect.objectContaining({ code: "total_mismatch" }), expect.objectContaining({ code: "premium_uncovered", uncovered: 1 })]));
  });

  it("does not report missing totals, stale snapshots, or negative relevant values as safe", () => {
    expect(evaluate({ marshaTotal: null }).code).toBe("unassessable");
    expect(evaluate({ marshaRooms: { GENR: -1 } }).code).toBe("unreliable");
    expect(getSourceState({ stayDocument: {}, snapshotDate: "2026-09-24", today: "2026-09-25" }).status).toBe("stale");
    expect(getSourceState({ stayDocument: {}, snapshotDate: "2026-09-25", today: "2026-09-25", metadata: { status: "incomplete" } }).status).toBe("missing");
  });
});
