import { describe, expect, it } from "vitest";
import { packageConversionLabel, previewCatalogPackageQuantity } from "./productUnitDisplay";

describe("supplier package display in catalog stock units", () => {
  it("explains orange juice in millilitres and physical counts in litres", () => {
    expect(previewCatalogPackageQuantity(1000, "ml", "l")).toBe(1);
    expect(packageConversionLabel(1000, "ml", "l")).toBe("1000 ml = 1 l per purchase unit for stock counts.");
    expect(previewCatalogPackageQuantity("6000", "ml", "l")).toBe(6);
    expect(previewCatalogPackageQuantity(0.125, "kg", "g")).toBe(125);
  });
  it.each([null, undefined, "", " ", "invalid", 0, -1, Infinity, 1000001])("keeps missing or invalid package content unavailable: %s", (quantity) => {
    expect(previewCatalogPackageQuantity(quantity, "ml", "l")).toBeNull();
  });
  it("never guesses dimensions or rounds unsupported precision into a valid quantity", () => {
    expect(previewCatalogPackageQuantity(1, "kg", "l")).toBeNull();
    expect(previewCatalogPackageQuantity(1, "bottle", "each")).toBeNull();
    expect(previewCatalogPackageQuantity(0.000001, "ml", "l")).toBeNull();
    expect(previewCatalogPackageQuantity(0.0000001, "l", "ml")).toBeNull();
    expect(previewCatalogPackageQuantity(0.000001, "l", "ml")).toBe(0.001);
  });
});
