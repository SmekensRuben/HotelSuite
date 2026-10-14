import { describe, expect, it } from "vitest";
import { formatPurchasePrice, knownPrice, productPurchaseOptions, canAddPurchaseOptionToDraftCart, hasApprovedScheduledPrice } from "./productPurchaseOptions";

describe("purchase option display contracts", () => {
  it("distinguishes missing prices from explicit zero and does not coerce text", () => {
    expect(knownPrice(null)).toBeNull(); expect(knownPrice(undefined)).toBeNull(); expect(knownPrice("0")).toBeNull();
    expect(knownPrice(0)).toBe(0); expect(formatPurchasePrice({ pricePerPurchaseUnit: null }, "EUR", "net")).toBe("Price unavailable");
  });
  it("keeps independently selectable packages plus the legacy default", () => {
    const options = productPurchaseOptions({ purchaseUnit: "case24", baseUnitsPerPurchaseUnit: 24, pricePerPurchaseUnit: 36, purchaseOptions: [{ id: "single", purchaseUnit: "bottle", baseUnitsPerPurchaseUnit: 1, pricePerPurchaseUnit: 2 }] });
    expect(options.map((option) => option.id)).toEqual(["default", "single"]);
    expect(options[1].baseUnitsPerPurchaseUnit).toBe(1);
    expect(formatPurchasePrice(options[1], "USD", "gross")).toContain("2.00 USD / bottle (gross price basis)");
  });
  it("requires explicit review of old ambiguous variants", () => {
    expect(productPurchaseOptions({ hasVariants: true, variants: [{ perBaseUnit: 1, packages: 24 }], pricePerPurchaseUnit: 0 })).toEqual([]);
  });
  it("labels cached purchase prices as indicative instead of promising a current effective price", () => {
    expect(formatPurchasePrice({ purchaseUnit: "case", pricePerPurchaseUnit: 12 }, "EUR", "net")).toMatch(/^Indicative:/);
    expect(formatPurchasePrice({ pricePerPurchaseUnit: null }, "EUR", "net", { approvedScheduledPrice: true })).toContain("checked in order preview");
  });
  it("permits a reviewed future-only physical offer to enter a draft cart without making unknown offers free", () => {
    const option = { id: "default", purchaseUnit: "case", baseUnitsPerPurchaseUnit: 6, pricePerPurchaseUnit: null };
    const product = { active: true, baseUnit: "l", currency: "EUR", currentPriceVersionId: null, latestApprovedPriceVersionId: "0000000000000002" };
    expect(hasApprovedScheduledPrice(product)).toBe(true); expect(canAddPurchaseOptionToDraftCart(product, option)).toBe(true);
    expect(canAddPurchaseOptionToDraftCart({ ...product, latestApprovedPriceVersionId: undefined }, option)).toBe(false);
    expect(canAddPurchaseOptionToDraftCart({ ...product, currentPriceVersionId: "0000000000000002" }, option)).toBe(false);
    for (const patch of [{ active: false }, { archived: true }, { baseUnit: null }, { currency: null }]) expect(canAddPurchaseOptionToDraftCart({ ...product, ...patch }, option)).toBe(false);
    expect(canAddPurchaseOptionToDraftCart(product, { ...option, baseUnitsPerPurchaseUnit: null })).toBe(false);
  });
  it("exposes newly approved dated packages while keeping today's known prices and packages intact", () => {
    const product = { purchaseUnit: "case", baseUnitsPerPurchaseUnit: 6, pricePerPurchaseUnit: 12, currency: "EUR", baseUnit: "l",
      currentPriceVersionId: "v1", latestApprovedPriceVersionId: "v2", latestApprovedPurchaseTerms: { versionId: "v2", purchaseUnit: "smaller case", baseUnitsPerPurchaseUnit: 4,
        pricePerPurchaseUnit: 12, currency: "USD", priceBasis: "net", baseUnit: "l", purchaseOptions: [{ id: "future-bottle", purchaseUnit: "bottle", baseUnitsPerPurchaseUnit: 1, pricePerPurchaseUnit: 4 }] } };
    const options = productPurchaseOptions(product);
    expect(options[0]).toMatchObject({ purchaseUnit: "case", baseUnitsPerPurchaseUnit: 6, pricePerPurchaseUnit: 12 });
    expect(options[1]).toMatchObject({ id: "future-bottle", currency: "USD", priceRequiresDateReview: true, indicativePriceVersionId: "v2" });
    expect(formatPurchasePrice(options[1], "EUR", "gross")).toContain("4.00 USD / bottle (net price basis) · dated version");
    expect(productPurchaseOptions({ ...product, latestApprovedPurchaseTerms: { ...product.latestApprovedPurchaseTerms, versionId: "other-version" } })).toHaveLength(1);
    const reviewedLegacy = productPurchaseOptions({ ...product, hasVariants: true, purchaseOptions: [], pricePerPurchaseUnit: 10 });
    expect(reviewedLegacy[0]).toMatchObject({ id: "default", purchaseUnit: "smaller case", priceRequiresDateReview: true });
  });
});
