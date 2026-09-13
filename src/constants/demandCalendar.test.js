import { describe, expect, it } from "vitest";
import { categoryDefaultsForEvent, EMPTY_EVENT, SYSTEM_TYPES, validateDemandCalendarEvent } from "./demandCalendar";

describe("demand calendar model", () => {
  it("keeps the forecasting system types machine-readable", () => {
    expect(Object.keys(SYSTEM_TYPES)).toEqual(["SCHOOL_HOLIDAY", "PUBLIC_HOLIDAY", "BRIDGE_DAY", "BUSINESS_EVENT", "LEISURE_EVENT", "CITYWIDE_COMPRESSION", "FESTIVE_PERIOD", "OTHER"]);
  });
  it("copies category forecasting defaults into an event", () => {
    expect(categoryDefaultsForEvent({ systemType: "SCHOOL_HOLIDAY", defaultImpactLevel: "HIGH", defaultGroupDemandEffect: "SUPPRESS", defaultTransientBusinessEffect: "SUPPRESS", defaultTransientLeisureEffect: "BOOST", defaultBqtDemandEffect: "SUPPRESS" })).toEqual({ systemType: "SCHOOL_HOLIDAY", impactLevel: "HIGH", groupDemandEffect: "SUPPRESS", transientBusinessEffect: "SUPPRESS", transientLeisureEffect: "BOOST", bqtDemandEffect: "SUPPRESS" });
  });
  it("validates dates, attendance, URL, and required values", () => {
    const invalid = validateDemandCalendarEvent({ ...EMPTY_EVENT, startDate: "2026-05-02", endDate: "2026-05-01", expectedAttendance: -1, sourceUrl: "not a url" });
    expect(invalid.name).toBe("Required"); expect(invalid.endDate).toMatch(/on or after/); expect(invalid.expectedAttendance).toMatch(/negative/); expect(invalid.sourceUrl).toMatch(/valid URL/);
  });
});
