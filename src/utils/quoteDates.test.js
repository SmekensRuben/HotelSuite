import { describe, expect, it } from "vitest";
import { DATE_RANGE_SEMANTICS, getCheckoutExclusiveStayDates, getInclusiveQuoteDates, getQuoteStayDates } from "./quoteDates";

describe("getInclusiveQuoteDates", () => {
  it("includes both the start and end date", () => {
    expect(getInclusiveQuoteDates("2026-09-10", "2026-09-12")).toEqual([
      "2026-09-10",
      "2026-09-11",
      "2026-09-12",
    ]);
  });

  it("supports a one-night range and rejects invalid ranges", () => {
    expect(getInclusiveQuoteDates("2026-09-10", "2026-09-10")).toEqual(["2026-09-10"]);
    expect(getInclusiveQuoteDates("2026-09-11", "2026-09-10")).toEqual([]);
    expect(getInclusiveQuoteDates("not-a-date", "2026-09-10")).toEqual([]);
  });
});


describe("checkout-exclusive quote dates", () => {
  it("creates exact room nights before checkout", () => expect(getCheckoutExclusiveStayDates("2027-04-03", "2027-04-05")).toEqual(["2027-04-03", "2027-04-04"]));
  it("rejects same-day checkout", () => expect(getCheckoutExclusiveStayDates("2027-04-03", "2027-04-03")).toEqual([]));
  it("keeps unversioned legacy quote ends inclusive", () => expect(getQuoteStayDates({ startDate: "2027-04-03", endDate: "2027-04-05" })).toHaveLength(3));
  it("uses exclusive semantics only with the explicit flag", () => expect(getQuoteStayDates({ startDate: "2027-04-03", endDate: "2027-04-05", dateRangeSemantics: DATE_RANGE_SEMANTICS.CHECKOUT_EXCLUSIVE })).toHaveLength(2));
});
