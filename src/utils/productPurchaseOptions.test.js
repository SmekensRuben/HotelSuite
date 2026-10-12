import { describe, expect, it } from "vitest";
import { formatPurchasePrice, knownPrice, productPurchaseOptions } from "./productPurchaseOptions";

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
});
