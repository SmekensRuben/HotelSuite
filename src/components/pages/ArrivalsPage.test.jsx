import { describe, expect, it } from "vitest";
import { filterArrivals, filterMadeReservations, getMembershipLevels, getReservationCreator } from "../../utils/arrivalFilters";

const arrivals = [
  { id: "1", rateCode: "BAR", memberships: [{ membershipLevel: "Gold" }] },
  { id: "2", rateCode: "CORP-01", memberships: { primary: { membershipLevel: "Silver" } } },
  { id: "3", rateCode: "BAR-PKG", memberships: [{ membershipLevel: "Platinum" }, { membershipLevel: "Gold" }] },
];

describe("arrival filters", () => {
  it("normalizes array and object membership data", () => {
    expect(getMembershipLevels(arrivals[1])).toEqual(["Silver"]);
    expect(getMembershipLevels(arrivals[2])).toEqual(["Platinum", "Gold"]);
  });

  it("filters Rate Codes case-insensitively using partial matches", () => {
    expect(filterArrivals(arrivals, "bar", []).map(({ id }) => id)).toEqual(["1", "3"]);
  });

  it("matches any of the selected memberships and combines both filters", () => {
    expect(filterArrivals(arrivals, "pkg", ["Silver", "Gold"]).map(({ id }) => id)).toEqual(["3"]);
  });
});

describe("made reservation filters", () => {
  const madeReservations = [
    { id: "1", rateCode: "BAR", roomCategoryLabel: "DLX", insertUser: " ALICE " },
    { id: "2", rateCode: "CORP", roomCategoryLabel: "PM", insertUser: "BOB" },
    { id: "3", rateCode: "BAR-PKG", roomCategoryLabel: "pr", insertUser: "ALICE" },
  ];

  it("excludes PM and PR room categories by default", () => {
    expect(filterMadeReservations(madeReservations, "", false).map(({ id }) => id)).toEqual(["1"]);
  });

  it("includes PM records when requested and combines the Rate Code filter", () => {
    expect(filterMadeReservations(madeReservations, "bar", true).map(({ id }) => id)).toEqual(["1", "3"]);
  });

  it("normalizes creator values and only includes checked creators", () => {
    expect(getReservationCreator(madeReservations[0])).toBe("ALICE");
    expect(filterMadeReservations(madeReservations, "", true, ["BOB"]).map(({ id }) => id)).toEqual(["2"]);
    expect(filterMadeReservations(madeReservations, "", true, []).map(({ id }) => id)).toEqual([]);
  });
});
