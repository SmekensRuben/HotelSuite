import { describe, expect, it } from "vitest";
import { filterArrivals, getMembershipLevels } from "../../utils/arrivalFilters";

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
