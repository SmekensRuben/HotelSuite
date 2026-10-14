import { describe, expect, it } from "vitest";
import { orderPriceEvidence, orderPriceReliability, orderPriceSource } from "./orderPriceReliability";

describe("recorded order price evidence", () => {
  it("keeps historical missing validity explicit", () => {
    expect(orderPriceReliability({})).toContain("Historical price snapshot");
    expect(orderPriceEvidence({})).toBe("Price changed: unknown · Last confirmed: unknown");
    expect(orderPriceSource({})).toBe("Source not recorded");
  });
  it("shows the chosen delivery date and unknown validity without manufacturing a range", () => {
    expect(orderPriceReliability({ priceValidity: "unknown", pricingDateBasis: "delivery-date", pricingDate: "2026-11-02", pricingAgreementKnown: true }))
      .toBe("Validity unknown · delivery date: 2026-11-02");
    expect(orderPriceSource({ priceSourceReference: "November prices.xlsx" })).toBe("Source: November prices.xlsx");
  });
  it("separates recorded price changes from subsequent confirmations and never fills missing evidence", () => {
    expect(orderPriceEvidence({ lastPriceChangeAt: { seconds: Date.parse("2026-01-03T14:00:00Z") / 1000 }, lastPriceConfirmedAt: { _seconds: Date.parse("2026-10-04T09:00:00Z") / 1000 } }))
      .toBe("Price changed: 2026-01-03 · Last confirmed: 2026-10-04");
    expect(orderPriceEvidence({ lastPriceChangeAt: "not-a-date", lastPriceConfirmedAt: null })).toContain("Last confirmed: unknown");
    expect(orderPriceEvidence({ lastPriceConfirmedAt: "2026-10-04", priceConfirmationMatchesCurrentTerms: false })).toContain("2026-10-04 (previous terms)");
  });
});
