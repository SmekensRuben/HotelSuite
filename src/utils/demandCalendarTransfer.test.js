import { describe, expect, it } from "vitest";
import { createDemandCalendarExport, parseDemandCalendarImport } from "./demandCalendarTransfer";

const category = { id: "school", name: "School Holidays", systemType: "SCHOOL_HOLIDAY", defaultImpactLevel: "HIGH", defaultGroupDemandEffect: "SUPPRESS", defaultTransientBusinessEffect: "SUPPRESS", defaultTransientLeisureEffect: "BOOST", defaultBqtDemandEffect: "SUPPRESS", active: true };
const event = { id: "easter", name: "Easter Holiday", categoryId: "school", systemType: "SCHOOL_HOLIDAY", startDate: "2026-04-06", endDate: "2026-04-19", impactLevel: "HIGH", groupDemandEffect: "SUPPRESS", transientBusinessEffect: "SUPPRESS", transientLeisureEffect: "BOOST", bqtDemandEffect: "SUPPRESS", region: "Flanders", active: true };

describe("Demand Calendar transfer", () => {
  it("round-trips categories and events while retaining their linked ids", () => {
    const parsed = parseDemandCalendarImport(JSON.stringify(createDemandCalendarExport([event], [category])));
    expect(parsed.categories[0].id).toBe("school");
    expect(parsed.events[0]).toMatchObject({ id: "easter", categoryId: "school", systemType: "SCHOOL_HOLIDAY" });
  });
  it("rejects unrelated and invalid files", () => {
    expect(() => parseDemandCalendarImport("not json")).toThrow("valid JSON");
    expect(() => parseDemandCalendarImport('{"format":"other"}')).toThrow("valid Demand Calendar export");
    const exported = createDemandCalendarExport([{ ...event, systemType: "CUSTOM" }], [category]);
    expect(() => parseDemandCalendarImport(JSON.stringify(exported))).toThrow("invalid calendar event");
  });
});
