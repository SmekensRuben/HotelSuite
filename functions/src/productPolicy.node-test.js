const test = require("node:test");
const assert = require("node:assert/strict");
const policy = require("./productPolicy");

const catalog = (patch = {}) => ({ id: "milk", name: "Milk", baseUnit: "l", inventoryTracked: true, active: true, ...patch });
const supplier = (patch = {}) => ({ supplierId: "dairy", supplierSku: "MILK-6", supplierProductName: "Milk six pack", currency: "EUR",
  pricingModel: "Per Purchase Unit", pricePerBaseUnit: null, pricePerPurchaseUnit: 12, purchaseUnit: "Case of six", baseUnit: "l",
  baseUnitsPerPurchaseUnit: 6, catalogProductId: "milk", active: true, priceBasis: "net", vatRate: null, purchaseOptions: [], ...patch });
test("kg purchase measures support fractional orders, exact mass inventory and net goods value", () => {
  for (const [baseUnit, amount] of [["kg", 1], ["g", 1000]]) {
    const product = policy.normalizeSupplierProduct(supplier({ purchaseUnit: "KG", baseUnit, baseUnitsPerPurchaseUnit: amount, pricePerPurchaseUnit: 8 }));
    assert.equal(product.purchaseUnit, "kg"); const option = policy.resolvePurchaseOption(product);
    const terms = policy.inventoryTerms(product, catalog({ baseUnit: "g" }), option);
    assert.equal(terms.available, true); assert.equal(terms.catalogUnitsPerPurchaseUnit, 1000); assert.equal(terms.netUnitCost, 0.008);
    assert.equal(policy.multiplyQuantities(2.5, terms.catalogUnitsPerPurchaseUnit), 2500);
    assert.equal(policy.calculateNetValue(2.5, option.netPricePerPurchaseUnit), 20);
  }
});
test("kg guards reject false piece, volume and package-size conversions at save and order boundaries", () => {
  for (const [baseUnit, amount] of [["each", 1], ["l", 1], ["g", 1], ["kg", 2]]) {
    const invalid = supplier({ purchaseUnit: "kg", baseUnit, baseUnitsPerPurchaseUnit: amount });
    assert.throws(() => policy.normalizeSupplierProduct(invalid), /kg purchase unit/);
    assert.throws(() => policy.resolvePurchaseOption(invalid), /kg purchase unit/);
  }
  assert.equal(policy.measuredPurchaseContent("__proto__", "kg"), null);
  assert.equal(policy.measuredPurchaseContent("constructor", "kg"), null);
});
test("additional kg options inherit a compatible mass unit and cannot redefine one kilogram", () => {
  const extra = { id: "by-weight", purchaseUnit: "kg", baseUnitsPerPurchaseUnit: 1000, pricePerPurchaseUnit: 8 };
  const product = policy.normalizeSupplierProduct(supplier({ purchaseUnit: "Box", baseUnit: "g", baseUnitsPerPurchaseUnit: 5000, purchaseOptions: [extra] }));
  assert.equal(policy.resolvePurchaseOption(product, "by-weight").baseUnitsPerPurchaseUnit, 1000);
  assert.throws(() => policy.normalizeSupplierProduct(supplier({ purchaseUnit: "Box", baseUnit: "g", baseUnitsPerPurchaseUnit: 5000, purchaseOptions: [{ ...extra, baseUnitsPerPurchaseUnit: 5 }] })), /exactly 1 kg/);
});

test("supplier images are upload-only and external URL fields cannot enter the public schema", () => {
  assert.equal(Object.hasOwn(policy.normalizeSupplierProduct(supplier()), "imageUrl"), false);
  for (const imageUrl of ["", null, "https://supplier.example/milk.jpg"]) {
    assert.throws(() => policy.normalizeSupplierProduct(supplier({ imageUrl })), (error) => error.code === "invalid-argument" && /protected image upload/.test(error.message));
  }
});

test("explicit units convert kg/g and l/ml exactly without deriving a mass/volume conversion", () => {
  assert.equal(policy.convertQuantity(1.25, "kg", "g"), 1250);
  assert.equal(policy.convertQuantity(250, "g", "kg"), 0.25);
  assert.equal(policy.convertQuantity(250, "ml", "l"), 0.25);
  assert.equal(policy.convertQuantity(0.001, "g", "kg"), 0.000001);
  for (const pair of [["g", "ml"], ["kg", "each"], ["litre", "l"]]) assert.throws(() => policy.convertQuantity(1, ...pair));
  assert.throws(() => policy.convertQuantity(0.000001, "g", "kg"), /six decimal/);
  assert.throws(() => policy.convertQuantity(1000000.000001, "kg", "g"), /exact quantity limit/);
});
test("physical multiplication and primitives reject hidden rounding, coercion and unbounded results", () => {
  assert.equal(policy.multiplyQuantities(0.5, 24), 12);
  assert.equal(policy.multiplyQuantities(0.1, 0.2), 0.02);
  assert.equal(policy.multiplyQuantities(1, 0.000001), 0.000001);
  assert.throws(() => policy.multiplyQuantities(0.000001, 0.000001), /six decimal/);
  assert.throws(() => policy.multiplyQuantities(1000000, 1000000), /exact quantity limit/);
  for (const value of [null, "1", true, NaN, Infinity, -1, 0.0000001]) assert.throws(() => policy.decimal(value));
});
test("catalog inventory identity requires explicit flags and units while absent costs stay absent", () => {
  const value = policy.normalizeCatalogProduct({ name: "Milk", baseUnit: "l", active: true, inventoryTracked: true, allergens: [] });
  assert.equal(value.productPolicyVersion, 1);
  assert.throws(() => policy.normalizeCatalogProduct({ name: "Milk", baseUnit: "l", active: true }), /explicit boolean/);
  assert.throws(() => policy.normalizeCatalogProduct({ name: "Milk", baseUnit: "litres", active: true, inventoryTracked: true }), /supported base unit/);
});
test("supplier brand is optional bounded text independent of the supplier's name", () => {
  assert.equal(policy.normalizeSupplierProduct(supplier({ brand: "  iQ McCain  " })).brand, "iQ McCain");
  assert.equal(policy.normalizeSupplierProduct(supplier()).brand, "");
  for (const brand of [true, {}, 42, "x".repeat(201)]) assert.throws(() => policy.normalizeSupplierProduct(supplier({ brand })));
});
test("two suppliers and selectable packages produce one catalog quantity identity", () => {
  const a = policy.normalizeSupplierProduct(supplier());
  const b = policy.normalizeSupplierProduct(supplier({ supplierId: "alternative", supplierSku: "MILK-12", baseUnit: "ml", baseUnitsPerPurchaseUnit: 12000, pricePerPurchaseUnit: 30,
    purchaseOptions: [{ id: "single", purchaseUnit: "Bottle", baseUnitsPerPurchaseUnit: 1000, pricePerPurchaseUnit: 2.5 }] }));
  assert.equal(policy.inventoryTerms(a, catalog(), policy.resolvePurchaseOption(a)).catalogUnitsPerPurchaseUnit, 6);
  const option = policy.resolvePurchaseOption(b, "single");
  const terms = policy.inventoryTerms(b, catalog(), option);
  assert.equal(terms.catalogProductId, "milk"); assert.equal(terms.catalogUnitsPerPurchaseUnit, 1); assert.equal(terms.netUnitCost, 2.5);
  assert.equal(policy.inventoryTerms(b, catalog(), policy.resolvePurchaseOption(b)).catalogUnitsPerPurchaseUnit, 12);
  assert.throws(() => policy.resolvePurchaseOption(b, "missing"));
});
test("a case of 24 may be represented as 24 each without rounding one item to a case fraction", () => {
  const offer = policy.normalizeSupplierProduct(supplier({ baseUnit: "each", baseUnitsPerPurchaseUnit: 24, pricePerPurchaseUnit: 48 }));
  const terms = policy.inventoryTerms(offer, catalog({ baseUnit: "each" }), policy.resolvePurchaseOption(offer));
  assert.equal(terms.catalogUnitsPerPurchaseUnit, 24); assert.equal(terms.netUnitCost, 2);
  assert.equal(policy.convertQuantity(1, "each", "each"), 1);
});
test("unknown prices are not free; explicit zero and unknown net basis are distinct", () => {
  for (const price of [null, undefined]) {
    const offer = policy.normalizeSupplierProduct(supplier({ pricePerPurchaseUnit: price }));
    assert.equal(offer.pricePerPurchaseUnit, null); assert.equal(offer.pricePerBaseUnit, null);
    assert.throws(() => policy.resolvePurchaseOption(offer), /unknown price/);
  }
  for (const price of ["12", false, NaN, Infinity, -1, 1000001]) assert.throws(() => policy.normalizeSupplierProduct(supplier({ pricePerPurchaseUnit: price })));
  const free = policy.normalizeSupplierProduct(supplier({ pricePerPurchaseUnit: 0 }));
  assert.equal(policy.resolvePurchaseOption(free).netPricePerPurchaseUnit, 0);
  const unknown = policy.normalizeSupplierProduct(supplier({ priceBasis: "unknown" }));
  const terms = policy.inventoryTerms(unknown, catalog(), policy.resolvePurchaseOption(unknown));
  assert.equal(terms.available, true); assert.equal(terms.netUnitCost, null); assert.equal(terms.reason, "unknown-net-price-contract");
});
test("net/gross contract preserves explicit zero VAT and does not apply VAT twice", () => {
  const gross = policy.normalizeSupplierProduct(supplier({ pricePerPurchaseUnit: 12.1, priceBasis: "gross", vatRate: 0.21 }));
  assert.equal(policy.resolvePurchaseOption(gross).netPricePerPurchaseUnit, 10);
  assert.equal(policy.resolvePurchaseOption(policy.normalizeSupplierProduct(supplier({ priceBasis: "gross", vatRate: 0 }))).netPricePerPurchaseUnit, 12);
  assert.equal(policy.resolvePurchaseOption(policy.normalizeSupplierProduct(supplier({ vatRate: 0.21 }))).netPricePerPurchaseUnit, 12);
  for (const rate of [null, undefined, "0.21", 21, -1]) assert.throws(() => policy.normalizeSupplierProduct(supplier({ priceBasis: "gross", vatRate: rate })));
});
test("per-base pricing derives one bounded purchase price rather than trusting conflicting input", () => {
  const offer = policy.normalizeSupplierProduct(supplier({ pricingModel: "Per Base Unit", pricePerBaseUnit: 2, pricePerPurchaseUnit: 999 }));
  assert.equal(offer.pricePerPurchaseUnit, 12);
  assert.equal(policy.normalizeSupplierProduct(supplier({ pricingModel: "Per Base Unit", pricePerBaseUnit: null, pricePerPurchaseUnit: 99 })).pricePerPurchaseUnit, null);
  assert.throws(() => policy.normalizeSupplierProduct(supplier({ pricingModel: "Per Base Unit", pricePerBaseUnit: 1000000 })), /maximum supported price/);
});
test("bounded unique purchase options reject reserved IDs and untyped package quantities", () => {
  for (const patch of [{ id: "default" }, { baseUnitsPerPurchaseUnit: 0 }, { baseUnitsPerPurchaseUnit: "12" }, { unexpected: true }]) {
    assert.throws(() => policy.normalizeSupplierProduct(supplier({ purchaseOptions: [{ id: "single", purchaseUnit: "Bottle", baseUnitsPerPurchaseUnit: 1, pricePerPurchaseUnit: 2, ...patch }] })));
  }
  const option = { id: "same", purchaseUnit: "Bottle", baseUnitsPerPurchaseUnit: 1, pricePerPurchaseUnit: 2 };
  assert.throws(() => policy.normalizeSupplierProduct(supplier({ purchaseOptions: [option, option] })));
  assert.throws(() => policy.normalizeSupplierProduct(supplier({ purchaseOptions: Array.from({ length: 21 }, (_, i) => ({ ...option, id: `option-${i}` })) })));
});
test("legacy procurement may keep known purchase price while uncertain inventory terms remain explicit", () => {
  const legacy = supplier({ baseUnit: "litres", baseUnitsPerPurchaseUnit: "6", priceBasis: undefined });
  const option = policy.resolvePurchaseOption(legacy);
  assert.equal(option.pricePerPurchaseUnit, 12); assert.equal(option.baseUnitsPerPurchaseUnit, null);
  assert.equal(policy.inventoryTerms(legacy, catalog(), option).available, false);
  assert.equal(policy.inventoryTerms(supplier({ catalogProductId: null }), null, option).reason, "unlinked-supplier-product");
  assert.equal(policy.inventoryTerms(supplier(), catalog({ id: "wrong" }), option).reason, "catalog-product-unavailable");
  assert.equal(policy.inventoryTerms(supplier(), catalog({ inventoryTracked: false }), option).reason, "catalog-product-not-inventory-tracked");
  assert.equal(policy.inventoryTerms(supplier(), catalog({ inventoryTracked: undefined }), option).reason, "inventory-tracking-policy-unknown");
  assert.equal(policy.inventoryTerms(supplier(), null, option).inventoryTracked, null);
});
test("unknown or unrepresentable valuation keeps physical quantities available without inventing zero cost", () => {
  const offer = policy.normalizeSupplierProduct(supplier({ baseUnit: "kg", baseUnitsPerPurchaseUnit: 1000000, pricePerPurchaseUnit: 0.000001 }));
  const terms = policy.inventoryTerms(offer, catalog({ baseUnit: "g" }), policy.resolvePurchaseOption(offer));
  assert.equal(terms.available, true); assert.equal(terms.catalogUnitsPerPurchaseUnit, 1000000000);
  assert.equal(terms.netUnitCost, null); assert.equal(terms.reason, "unit-cost-below-supported-precision");
  for (const value of ["12", false, Infinity, -1]) assert.throws(() => policy.netPrice(value, "net", null));
});
test("receipt net value uses the original package cost independently of a tiny displayed base cost", () => {
  assert.equal(policy.calculateNetValue(2, 0.01), 0.02);
  assert.equal(policy.calculateNetValue(0.123, 0.123456), 0.015185);
  assert.equal(policy.calculateNetValue(0, 12), 0);
  assert.equal(policy.calculateNetValue(2, 0), 0);
  assert.equal(policy.calculateNetValue(2, null), null);
  assert.throws(() => policy.calculateNetValue(0.000001, 0.000001), /monetary precision/);
  assert.throws(() => policy.calculateNetValue(1000000, 1000000), /exact quantity limit/);
});
test("ambiguous legacy variants cannot bypass package review through the backend default option", () => {
  const legacy = supplier({ hasVariants: true, variants: [{ packages: 6, perBaseUnit: 1 }] });
  assert.throws(() => policy.resolvePurchaseOption(legacy), (error) => error.code === "failed-precondition" && /reviewed purchase-option/.test(error.message));
  assert.throws(() => policy.resolvePurchaseOption({ ...legacy, hasVariants: "true" }), /reviewed purchase-option/);
  const reviewed = policy.normalizeSupplierProduct(supplier({ purchaseOptions: [{ id: "single", purchaseUnit: "Bottle", baseUnitsPerPurchaseUnit: 1, pricePerPurchaseUnit: 2 }] }));
  assert.equal(policy.resolvePurchaseOption(reviewed).pricePerPurchaseUnit, 12);
  assert.equal(policy.resolvePurchaseOption(reviewed, "single").pricePerPurchaseUnit, 2);
});
test("optional supplier contract price dates remain unknown when missing and validate real ordered business dates", () => {
  const unknown = policy.normalizeSupplierProduct(supplier());
  assert.equal(unknown.priceValidFrom, null); assert.equal(unknown.priceValidUntil, null);
  const dated = policy.normalizeSupplierProduct(supplier({ priceValidFrom: "2026-10-01", priceValidUntil: "2026-10-31" }));
  assert.equal(dated.priceValidFrom, "2026-10-01"); assert.equal(dated.priceValidUntil, "2026-10-31");
  assert.equal(policy.normalizeSupplierProduct(supplier({ priceValidFrom: "2028-02-29" })).priceValidFrom, "2028-02-29");
  for (const patch of [{ priceValidFrom: "2026-02-29" }, { priceValidUntil: "31/10/2026" }, { priceValidFrom: 20261001 },
    { priceValidFrom: "2026-11-01", priceValidUntil: "2026-10-31" }]) assert.throws(() => policy.normalizeSupplierProduct(supplier(patch)));
});

test("optional purchase-package GTINs validate GS1 check digits and preserve leading zeroes as text", () => {
  // Includes GS1's published GTIN-13 example 6291041500213. GTIN syntax and
  // check digits do not establish allocation, ownership or a catalog mapping.
  for (const gtin of ["96385074", "036000291452", "6291041500213", "16291041500210", "06291041500213"]) {
    const product = policy.normalizeSupplierProduct(supplier({ gtin }));
    assert.equal(product.gtin, gtin);
  }
  for (const gtin of [undefined, null, "", "  "]) assert.equal(policy.normalizeSupplierProduct(supplier({ gtin })).gtin, null);
  for (const gtin of ["6291041500214", "036000291453", "96385075", "16291041500211", "629104150021", "123456789", 36000291452, false,
    "6291041500213x", "６２９１０４１５００２１３", "6291041500213\n\u0000"]) {
    assert.throws(() => policy.normalizeSupplierProduct(supplier({ gtin })), (error) => error.code === "invalid-argument");
  }
});

test("default and additional purchase packages carry independent optional GTINs without changing cost or physical terms", () => {
  const product = policy.normalizeSupplierProduct(supplier({ gtin: "16291041500210",
    purchaseOptions: [{ id: "single", purchaseUnit: "Bottle", baseUnitsPerPurchaseUnit: 1, pricePerPurchaseUnit: 2, gtin: "6291041500213" }] }));
  assert.equal(product.gtin, "16291041500210");
  assert.equal(product.purchaseOptions[0].gtin, "6291041500213");
  const option = policy.resolvePurchaseOption(product, "single");
  assert.equal(option.pricePerPurchaseUnit, 2);
  assert.equal(policy.inventoryTerms(product, catalog(), option).catalogUnitsPerPurchaseUnit, 1);
  assert.throws(() => policy.normalizeSupplierProduct(supplier({ purchaseOptions: [
    { id: "single", purchaseUnit: "Bottle", baseUnitsPerPurchaseUnit: 1, pricePerPurchaseUnit: 2, gtin: "6291041500214" },
  ] })), /invalid GS1 check digit/);
});
