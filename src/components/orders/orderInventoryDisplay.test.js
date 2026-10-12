import { expect, it } from "vitest";
import { frozenStockContent } from "./orderInventoryDisplay";

it("shows the frozen catalog quantity separately from millilitre package content", () => {
  expect(frozenStockContent({ purchaseUnit: "case", baseUnit: "ml", baseUnitsPerPurchaseUnit: 6000,
    inventoryTerms: { inventoryPolicyVersion: 1, available: true, catalogBaseUnit: "l", catalogUnitsPerPurchaseUnit: 6 } })).toBe("6 l per case in stock counts");
});
it("does not infer a historical conversion from current package content", () => {
  expect(frozenStockContent({ purchaseUnit: "case", baseUnit: "ml", baseUnitsPerPurchaseUnit: 6000 })).toBe("Catalog stock conversion unavailable");
});
it.each([null, undefined, "6", NaN, Infinity, 0, -1])("does not show unknown or invalid snapshotted amounts as valid: %s", (amount) => {
  expect(frozenStockContent({ inventoryTerms: { inventoryPolicyVersion: 1, available: true, catalogBaseUnit: "l", catalogUnitsPerPurchaseUnit: amount } })).toBe("Catalog stock conversion unavailable");
});
it("respects the recorded unavailable flag and unsupported unit", () => {
  expect(frozenStockContent({ inventoryTerms: { inventoryPolicyVersion: 1, available: false, catalogBaseUnit: "l", catalogUnitsPerPurchaseUnit: 6 } })).toBe("Catalog stock conversion unavailable");
  expect(frozenStockContent({ inventoryTerms: { inventoryPolicyVersion: 1, available: true, catalogBaseUnit: "bottle", catalogUnitsPerPurchaseUnit: 6 } })).toBe("Catalog stock conversion unavailable");
});

it.each([undefined, null, 2])("keeps unrecognized historical policy versions unavailable: %s", (version) => {
  expect(frozenStockContent({ inventoryTerms: { inventoryPolicyVersion: version, available: true, catalogBaseUnit: "l", catalogUnitsPerPurchaseUnit: 6 } })).toBe("Catalog stock conversion unavailable");
});
