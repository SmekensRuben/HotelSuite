const test = require("node:test");
const assert = require("node:assert/strict");
const { pricingTerms, priceTermsChanged, priceValueChanged, canonicalPrice, projectOptions, assessPriceValidity } = require("./supplierPricePolicy");
const offer = (patch = {}) => ({ productPolicyVersion: 1, supplierId: "s", supplierSku: "sku", supplierProductName: "Orange juice", catalogProductId: "juice",
  currency: "EUR", priceBasis: "gross", vatRate: 0.06, pricingModel: "Per Purchase Unit", baseUnit: "ml", purchaseUnit: "Case",
  baseUnitsPerPurchaseUnit: 6000, pricePerPurchaseUnit: 15.9, purchaseOptions: [], ...patch });
const catalog = { baseUnit: "l" };
const result = (patch = {}, optionPatch = {}) => { const terms = pricingTerms(offer(patch), catalog); return canonicalPrice(terms, { ...terms.options[0], ...optionPatch }); };

test("gross VAT is removed once and compatible supplier ml content compares per canonical litre", () => {
  assert.deepEqual(result(), { available: true, reason: null, catalogUnitsPerPurchaseUnit: 6, netPricePerPurchaseUnit: 15, netPricePerCatalogUnit: 2.5 });
  assert.equal(result({ priceBasis: "net", vatRate: 0.21, pricePerPurchaseUnit: 15 }).netPricePerCatalogUnit, 2.5);
});
test("explicit zero is a known price; missing/string prices, currency, basis and tax remain unavailable", () => {
  assert.equal(result({ pricePerPurchaseUnit: 0 }).netPricePerCatalogUnit, 0);
  for (const patch of [{ pricePerPurchaseUnit: null }, { pricePerPurchaseUnit: "15" }, { currency: "" }, { priceBasis: "unknown" }, { vatRate: null }, { vatRate: "0.06" }]) assert.equal(result(patch).available, false);
});
test("dimension mismatch, fractional precision underflow and malformed quantity are never free or guessed", () => {
  for (const patch of [{ baseUnit: "kg" }, { baseUnitsPerPurchaseUnit: null }, { baseUnitsPerPurchaseUnit: 0 }, { baseUnitsPerPurchaseUnit: 0.000001 }, { pricePerPurchaseUnit: 0.000001, baseUnitsPerPurchaseUnit: 1000000 }, { pricePerPurchaseUnit: 1e-7 }, { productPolicyVersion: null }]) assert.equal(result(patch).available, false);
  assert.equal(result({ pricePerPurchaseUnit: 1, baseUnitsPerPurchaseUnit: 3000, priceBasis: "net" }).netPricePerCatalogUnit, 0.333333);
});
test("content changes include price/package/currency/VAT/options/link but not display edits or option ordering", () => {
  const before = offer();
  assert.equal(priceTermsChanged(before, offer({ supplierProductName: "Renamed", imageUrl: "new", active: false }), catalog, catalog), false);
  for (const patch of [{ pricePerPurchaseUnit: 16 }, { baseUnitsPerPurchaseUnit: 3000 }, { currency: "USD" }, { vatRate: 0.12 }, { purchaseUnit: "Bottle" }, { catalogProductId: null }, { purchaseOptions: [{ id: "small", purchaseUnit: "Bottle", baseUnitsPerPurchaseUnit: 1000, pricePerPurchaseUnit: 3 }] }]) assert.equal(priceTermsChanged(before, offer(patch), catalog, catalog), true);
  const options = [{ id: "b", purchaseUnit: "b", baseUnitsPerPurchaseUnit: 2000, pricePerPurchaseUnit: 3 }, { id: "a", purchaseUnit: "a", baseUnitsPerPurchaseUnit: 1000, pricePerPurchaseUnit: 2 }];
  assert.equal(priceTermsChanged(offer({ purchaseOptions: options }), offer({ purchaseOptions: [...options].reverse() }), catalog, catalog), false);
});
test("additional packages use their own purchase price and content and every result is bounded", () => {
  const terms = pricingTerms(offer({ purchaseOptions: [{ id: "bottle", purchaseUnit: "Bottle", baseUnitsPerPurchaseUnit: 1000, pricePerPurchaseUnit: 3.18 }] }), catalog);
  assert.equal(projectOptions(terms)[1].netPricePerCatalogUnit, 3);
  terms.options = Array.from({ length: 200 }, () => terms.options[0]);
  assert.equal(projectOptions(terms).length, 21);
  assert.ok(projectOptions(terms).every((option) => !option.available && option.reason === "purchase-options-configuration-invalid"));
  for (const options of [{}, [{ id: "default" }], [{ id: "x" }, { id: "x" }]]) {
    assert.ok(projectOptions(pricingTerms(offer({ purchaseOptions: options }), catalog)).every((option) => !option.available));
  }
});
test("contract bounds qualify today's prices without inventing dates or using an implicit time zone", () => {
  assert.equal(assessPriceValidity(offer(), null), "unknown");
  const bounds = offer({ priceValidFrom: "2026-10-01", priceValidUntil: "2026-10-31" });
  assert.equal(assessPriceValidity(bounds, "2026-10-01"), "current");
  assert.equal(assessPriceValidity(bounds, "2026-10-31"), "current");
  assert.equal(assessPriceValidity(bounds, "2026-09-30"), "future");
  assert.equal(assessPriceValidity(bounds, "2026-11-01"), "expired");
  assert.equal(assessPriceValidity(bounds, null), "unavailable");
  assert.equal(assessPriceValidity(offer({ priceValidFrom: "invalid" }), "2026-10-12"), "invalid");
  assert.equal(priceTermsChanged(offer(), bounds, catalog, catalog), true);
});


test("economic price changes compare equivalent physical unit spellings without hiding smaller packages", () => {
  const grams = offer({ baseUnit: "g", baseUnitsPerPurchaseUnit: 400, pricePerPurchaseUnit: 12 });
  const kilos = offer({ baseUnit: "kg", baseUnitsPerPurchaseUnit: 0.4, pricePerPurchaseUnit: 12 });
  assert.equal(priceValueChanged(grams, kilos), false);
  assert.equal(priceValueChanged(grams, { ...kilos, baseUnitsPerPurchaseUnit: 0.3 }), true);
  assert.equal(priceValueChanged(offer({ baseUnit: "ml", baseUnitsPerPurchaseUnit: 6000 }), offer({ baseUnit: "l", baseUnitsPerPurchaseUnit: 6 })), false);
  assert.equal(priceValueChanged(grams, offer({ baseUnit: "ml", baseUnitsPerPurchaseUnit: 400, pricePerPurchaseUnit: 12 })), true, "cross-dimension contracts remain incomparable");
});
