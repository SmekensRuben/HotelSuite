const test = require("node:test");
const assert = require("node:assert/strict");
const { physicalPriceComparison, recurringReview, sourceEstablishesUnitPrice } = require("./supplierRecurringReview");
const product = (patch = {}) => ({ supplierId: "dairy", supplierSku: "MILK", supplierProductName: "Milk", currency: "EUR", pricingModel: "Per Purchase Unit",
  pricePerPurchaseUnit: 12, purchaseUnit: "Case", baseUnit: "l", baseUnitsPerPurchaseUnit: 6, priceBasis: "net", vatRate: null,
  active: true, catalogProductId: "milk", purchaseOptions: [], ...patch });
const source = (patch = {}) => ({ ...product(), sourceInterpretation: { status: "confirmed", documentPurpose: "price-list", unitPriceEstablished: true,
  providedFields: ["pricePerPurchaseUnit"], sourceIssuedOn: "2026-10-01", assortmentMode: "partial" }, ...patch });

test("a smaller package at the same case price exposes a physical-unit price increase", () => {
  const comparison = physicalPriceComparison(product(), product({ baseUnitsPerPurchaseUnit: 4 }));
  assert.deepEqual(comparison, { before: 2, after: 3, unit: "l", currency: "EUR", comparable: true, percentChange: 50, reason: null });
  const row = { product: product({ baseUnitsPerPurchaseUnit: 4 }), previousProduct: product(), category: "changed", changes: [{ field: "baseUnitsPerPurchaseUnit" }],
    inputPatch: source(), sourceInterpretation: source().sourceInterpretation, issues: [] };
  assert.equal(recurringReview(row).category, "packaging-change");
});
test("physical price comparison converts units, removes established VAT once and preserves zero", () => {
  assert.equal(physicalPriceComparison(product({ baseUnit: "ml", baseUnitsPerPurchaseUnit: 6000 }), product()).before, 2);
  assert.equal(physicalPriceComparison(product(), product({ pricePerPurchaseUnit: 14.52, priceBasis: "gross", vatRate: 0.21 })).after, 2);
  const zero = physicalPriceComparison(product({ pricePerPurchaseUnit: 0 }), product({ pricePerPurchaseUnit: 0 }));
  assert.equal(zero.before, 0); assert.equal(zero.comparable, true); assert.equal(zero.percentChange, null);
});
test("unknown price basis, different currencies and incompatible dimensions never fabricate comparable costs", () => {
  for (const after of [product({ priceBasis: "unknown" }), product({ currency: "USD" }), product({ baseUnit: "each" })]) {
    const comparison = physicalPriceComparison(product(), after);
    assert.equal(comparison.comparable, false); assert.equal(comparison.percentChange, null);
  }
});
test("format confirmation, actual unit-price field and document purpose independently fence reconfirmation", () => {
  assert.equal(sourceEstablishesUnitPrice(source()), true);
  for (const patch of [{ status: "review-required" }, { unitPriceEstablished: false }, { providedFields: [] }, { documentPurpose: "statistics" }]) {
    assert.equal(sourceEstablishesUnitPrice(source({ sourceInterpretation: { ...source().sourceInterpretation, ...patch } })), false);
  }
  assert.equal(sourceEstablishesUnitPrice(source({ pricePerPurchaseUnit: null })), false);
  assert.equal(sourceEstablishesUnitPrice(source({ pricePerPurchaseUnit: 0 })), true);
});
test("legacy confirmation checks actual extracted price evidence instead of a model value or SKU digits", () => {
  const legacy = { ...product({ pricePerPurchaseUnit: 12.5 }), sourceAnchors: [{ verified: true, sourceExcerpt: '["MILK12","12,50 EUR"]' }] };
  assert.equal(sourceEstablishesUnitPrice(legacy), true);
  assert.equal(sourceEstablishesUnitPrice({ ...legacy, pricePerPurchaseUnit: 12 }), false);
  assert.equal(sourceEstablishesUnitPrice({ ...legacy, sourceAnchors: [{ verified: false, sourceExcerpt: "12.50 EUR" }] }), false);
});
