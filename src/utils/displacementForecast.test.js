import { describe, expect, it } from "vitest";
import {
  calculateDisplacementDay,
  calculateDisplacementScenario,
  calculateLighthouseModifier,
  mapCurrentOtb,
  median,
  normalizePercentage,
  prepareHistoricalObservations,
  selectHistoricalObservations,
} from "./displacementForecast";

const scenario = (overrides = {}) => calculateDisplacementScenario({
  sellableInventory: 100,
  existingGroupOtb: 10,
  otherCommittedRooms: 0,
  requestedGroupRooms: 20,
  transientDemandForecast: 70,
  ...overrides,
});

const row = (date, overrides = {}) => ({
  date,
  calculatedInventoryRooms: 100,
  calculatedOccRooms: 50,
  individualRooms: 40,
  groupRooms: 10,
  ...overrides,
});

const weekdayDates = (month, years, overrides = {}) => years.flatMap((year) => {
  const dates = [];
  for (let day = 1; day <= 28; day += 1) {
    const date = `${year}-${month}-${String(day).padStart(2, "0")}`;
    if (new Date(`${date}T00:00:00Z`).getUTCDay() === 3) dates.push(row(date, overrides));
  }
  return dates;
});
const lighthouse = (target, comparable) => ({
  "2027-09-08": { "Market demand": target },
  "2027-09-01": { "Market demand": comparable },
  "2027-09-15": { "Market demand": comparable },
});

describe("percentage and median utilities", () => {
  it.each([["93%", 0.93], [93, 0.93], [0.93, 0.93], [" 93,0% ", 0.93]])("normalizes %p", (value, expected) => {
    expect(normalizePercentage(value)).toBe(expected);
  });
  it.each(["bad", "", null, -1, 101])("returns null for invalid %p", (value) => expect(normalizePercentage(value)).toBeNull());
  it("calculates odd and even medians", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});

describe("with/without-group scenarios", () => {
  it("calculates zero displacement", () => expect(scenario().displacedRooms).toBe(0));
  it("calculates partial displacement", () => expect(scenario({ transientDemandForecast: 80 }).displacedRooms).toBe(10));
  it("calculates full displacement", () => expect(scenario({ transientDemandForecast: 100 }).displacedRooms).toBe(20));
  it("never displaces more than requested and preserves the room invariant", () => {
    const result = scenario({ requestedGroupRooms: 7, transientDemandForecast: 1000 });
    expect(result.displacedRooms).toBe(7);
    expect(result.nonDisplacingGroupRooms).toBeGreaterThanOrEqual(0);
    expect(result.displacedRooms + result.nonDisplacingGroupRooms).toBe(7);
  });
});

describe("Lighthouse modifier", () => {
  it("raises demand with beta dampening", () => expect(calculateLighthouseModifier("2027-09-08", lighthouse("90%", "75%")).modifier).toBeCloseTo(1.1));
  it("lowers demand with beta dampening", () => expect(calculateLighthouseModifier("2027-09-08", lighthouse("60%", "75%")).modifier).toBeCloseTo(0.9));
  it("caps at 1.15", () => expect(calculateLighthouseModifier("2027-09-08", lighthouse("100%", "20%")).modifier).toBe(1.15));
  it("floors at 0.85", () => expect(calculateLighthouseModifier("2027-09-08", lighthouse("10%", "100%")).modifier).toBe(0.85));
  it("uses one and warns when data is missing", () => {
    const result = calculateLighthouseModifier("2027-09-08", {});
    expect(result.modifier).toBe(1);
    expect(result.warning).toMatch(/missing or invalid/i);
  });
});

describe("historical selection", () => {
  it("keeps a high-group unconstrained observation usable in Tier 2", () => {
    const observations = prepareHistoricalObservations(weekdayDates("09", [2021, 2022, 2023, 2024, 2025, 2026], { calculatedOccRooms: 60, individualRooms: 20, groupRooms: 40 }));
    expect(selectHistoricalObservations("2027-09-08", observations, 0.25).tier).toBe("same-month-unconstrained");
  });
  it("censors a low-group capacity-constrained observation", () => {
    const [observation] = prepareHistoricalObservations([row("2026-09-08", { calculatedOccRooms: 98, individualRooms: 93, groupRooms: 5 })]);
    expect(observation.isCapacityConstrained).toBe(true);
  });
  it("does not use July or August for September", () => {
    const observations = prepareHistoricalObservations([...weekdayDates("07", [2021, 2022, 2023]), ...weekdayDates("08", [2024, 2025, 2026])]);
    expect(selectHistoricalObservations("2027-09-08", observations, 1).selected).toHaveLength(0);
  });
  it("allows September to fall back to October and November", () => {
    const observations = prepareHistoricalObservations([row("2024-10-09"), row("2025-11-12"), row("2026-10-14")]);
    expect(selectHistoricalObservations("2027-09-08", observations, 1).tier).toBe("same-season-low-sample");
  });
  it("prefers same-month over same-season", () => {
    const sameMonth = weekdayDates("09", [2021, 2022, 2023, 2024, 2025, 2026]);
    const season = weekdayDates("10", [2021, 2022, 2023, 2024, 2025, 2026]);
    expect(selectHistoricalObservations("2027-09-08", prepareHistoricalObservations([...sameMonth, ...season]), 1).tier).toBe("same-month-preferred");
  });
  it("uses censored history only as a low-confidence lower bound", () => {
    const result = calculateDisplacementDay({ stayDate: "2027-09-08", requestedGroupRooms: 10, currentOtb: { calculatedInventoryRooms: 100, individualRooms: 20 }, historicalRows: [row("2026-09-09", { individualRooms: 95, calculatedOccRooms: 95, groupRooms: 0 })] });
    expect(result.historicalSelectionTier).toBe("censored-lower-bound");
    expect(result.forecastConfidence).toBe("low");
    expect(result.warnings.join(" ")).toMatch(/lower-bound/);
  });
  it("ignores invalid and zero calculated inventory", () => expect(prepareHistoricalObservations([row("2026-09-08", { calculatedInventoryRooms: 0 }), row("2025-09-08", { calculatedInventoryRooms: "bad" })])).toHaveLength(0));
});

describe("daily forecast inputs", () => {
  it("uses current transient OTB as a hard floor", () => {
    const result = calculateDisplacementDay({ stayDate: "2027-09-08", requestedGroupRooms: 10, currentOtb: { calculatedInventoryRooms: 100, individualRooms: 90 }, historicalRows: weekdayDates("09", [2021, 2022, 2023, 2024, 2025, 2026]), lighthouseByDate: lighthouse("75%", "75%") });
    expect(result.adjustedHistoricalDemand).toBe(40);
    expect(result.transientDemandForecast).toBe(90);
  });
  it("never creates negative other committed rooms", () => expect(mapCurrentOtb({ calculatedOccRooms: 10, individualRooms: 20, groupRooms: 5 }).otherCommittedRooms).toBe(0));
  it("uses calculated inventory rather than physical inventory", () => expect(mapCurrentOtb({ calculatedInventoryRooms: 94, inventoryRooms: 100 }).sellableInventory).toBe(94));
});
