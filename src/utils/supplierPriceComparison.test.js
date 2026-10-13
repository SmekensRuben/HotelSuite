import { describe, expect, it } from "vitest";
import { compareSupplierOffers, formatSupplierPrice, supplierPriceChanges } from "./supplierPriceComparison";
const option = (price, patch = {}) => ({ id: "default", purchaseUnit: "Case", available: true, reason: null, netPricePerCatalogUnit: price, ...patch });
const product = (id, currency, price, patch = {}) => ({ id, supplierName: id, active: true, currency, options: [option(price)], ...patch });
const entry = (current, old, patch = {}) => ({ catalogProductId: "milk", catalogBaseUnit: "l", currency: "EUR", options: [option(current)],
  previous: { catalogProductId: "milk", catalogBaseUnit: "l", currency: "EUR", options: [option(old)] }, ...patch });

describe("supplier goods-price presentation", () => {
  it("ranks each explicit currency separately, marks equal minima and treats zero as a valid price", () => {
    const rows = compareSupplierOffers([product("c", "EUR", 2), product("b", "EUR", 0), product("a", "EUR", 0), product("d", "USD", 1)]);
    expect(rows.map((row) => row.supplierProductId)).toEqual(["a", "b", "c", "d"]);
    expect(rows.filter((row) => row.lowestLoadedPrice).map((row) => row.supplierProductId)).toEqual(["a", "b", "d"]);
  });
  it("excludes inactive offers and preserves unknown review reasons without ranking unavailable prices", () => {
    const rows = compareSupplierOffers([product("inactive", "EUR", 1, { active: false }), product("unknown", "EUR", null, { options: [option(null, { available: false, reason: "purchase-price-unavailable" })] }), product("known", "EUR", 2)]);
    expect(rows.map((row) => row.supplierProductId)).toEqual(["known", "unknown"]);
    expect(rows[1].comparable).toBe(false);
    expect(compareSupplierOffers(rows.map((row) => product(row.supplierProductId, row.currency, row.netPricePerCatalogUnit, { options: [row] })), { includeUnavailable: false })).toHaveLength(1);
  });
  it("filters loaded supplier names/SKUs/packages and never relabels a filtered higher price cheapest", () => {
    const products = [product("lowest", "EUR", 1), product("larger", "EUR", 2, { supplierSku: "SEARCH-SKU" })];
    const rows = compareSupplierOffers(products, { query: "search-sku", currency: "EUR" });
    expect(rows).toHaveLength(1); expect(rows[0].lowestLoadedPrice).toBe(false);
    expect(compareSupplierOffers(products, { currency: "USD" })).toEqual([]);
  });
  it("computes a known unit-price increase and decline independently of source package size", () => {
    expect(supplierPriceChanges(entry(2.5, 2))[0]).toMatchObject({ comparable: true, delta: 0.5, percentage: 25 });
    expect(supplierPriceChanges(entry(0, 2))[0]).toMatchObject({ delta: -2, percentage: -100 });
    expect(supplierPriceChanges(entry(2, 0))[0]).toMatchObject({ comparable: true, delta: 2, percentage: null });
  });
  it("does not compare across currency, catalog identity, unit or unknown historic price contracts", () => {
    for (const patch of [{ currency: "USD" }, { catalogBaseUnit: "kg" }, { catalogProductId: "other" }]) {
      expect(supplierPriceChanges(entry(3, 2, patch))[0]).toMatchObject({ comparable: false, delta: null, percentage: null });
    }
    expect(supplierPriceChanges(entry(3, null))[0].comparable).toBe(false);
  });
  it("shows removed options and does not turn them into zero-price goods", () => {
    const result = supplierPriceChanges(entry(2, 1, { options: [] }));
    expect(result[0]).toMatchObject({ available: false, removed: true, reason: "purchase-option-removed", delta: null });
  });
  it("formats bounded zero prices but leaves missing prices/currencies unavailable", () => {
    expect(formatSupplierPrice(0, "EUR")).not.toBe("Unavailable");
    for (const [price, currency] of [[null, "EUR"], ["2", "EUR"], [2, null]]) expect(formatSupplierPrice(price, currency)).toBe("Unavailable");
  });
  it("excludes future/expired/unassessable bounds from cheapest ranking while preserving unknown bounds as qualified source prices", () => {
    const rows = compareSupplierOffers([product("expired", "EUR", 0.5, { priceValidity: "expired" }), product("future", "EUR", 0.2, { priceValidity: "future" }),
      product("missingzone", "EUR", 0.1, { priceValidity: "unavailable" }), product("unknownbounds", "EUR", 2, { priceValidity: "unknown" })]);
    expect(rows.filter((row) => row.lowestLoadedPrice).map((row) => row.supplierProductId)).toEqual(["unknownbounds"]);
    expect(rows.find((row) => row.supplierProductId === "expired")).toMatchObject({ comparable: false, reason: "price-validity-expired" });
  });
});
