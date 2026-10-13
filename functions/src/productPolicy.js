const { HttpsError } = require("firebase-functions/v2/https");
const { requireDocumentId } = require("./subscriptions");
const { text } = require("./validation");
const units = require("./unitCatalog.json");
const { validDate } = require("./importMonitoringPolicy");

const PRODUCT_POLICY_VERSION = 1;
const SCALE = 1000000n;
const MAX_QUANTITY = 1000000;
const MAX_CONVERTED_QUANTITY = 1000000000;
const MAX_PRICE = 1000000;
const fail = (message) => { throw new HttpsError("invalid-argument", message); };

function object(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${field} must be an object.`);
  return value;
}
function supportedFields(value, fields, field) {
  object(value, field);
  if (Object.keys(value).some((key) => !fields.includes(key))) fail(`Unsupported ${field} field.`);
}
function boolean(value, field) {
  if (typeof value !== "boolean") fail(`${field} must be an explicit boolean.`);
  return value;
}

// Parse the decimal spelling of a number; binary floating point arithmetic is
// never used to establish a physical quantity or unit conversion.
function fixed(value, field = "Quantity", { maximum = MAX_CONVERTED_QUANTITY, positive = false } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > maximum || (positive && value === 0)) {
    fail(`${field} must be a finite ${positive ? "positive" : "non-negative"} number at most ${maximum}.`);
  }
  const [mantissa, exponentText] = String(value).toLowerCase().split("e");
  const exponent = exponentText === undefined ? 0 : Number(exponentText);
  const [whole, fractional = ""] = mantissa.split(".");
  const digits = BigInt(whole + fractional);
  const places = fractional.length - exponent;
  let scaled;
  if (places <= 6) scaled = digits * (10n ** BigInt(6 - places));
  else {
    const divisor = 10n ** BigInt(places - 6);
    if (digits % divisor !== 0n) fail(`${field} supports at most six decimal places.`);
    scaled = digits / divisor;
  }
  if (scaled > BigInt(Number.MAX_SAFE_INTEGER)) fail(`${field} is outside the exact quantity limit.`);
  return scaled;
}
function decimal(value, field, options) { return Number(fixed(value, field, options)) / Number(SCALE); }
function optionalNumber(value, field, options) {
  if (value === null || value === undefined) return null;
  return decimal(value, field, options);
}
function baseUnit(value) {
  if (typeof value !== "string" || !Object.hasOwn(units, value)) fail("Choose an explicit supported base unit: g, kg, ml, l or each.");
  return value;
}
function compatibleUnits(from, to) { return Boolean(units[from] && units[to] && units[from].dimension === units[to].dimension); }
function exactResult(scaled, field = "Converted quantity") {
  if (scaled < 0n || scaled > BigInt(MAX_CONVERTED_QUANTITY) * SCALE || scaled > BigInt(Number.MAX_SAFE_INTEGER)) fail(`${field} is outside the exact quantity limit.`);
  return Number(scaled) / Number(SCALE);
}
function convertQuantity(value, from, to) {
  baseUnit(from); baseUnit(to);
  if (!compatibleUnits(from, to)) fail("Mass, volume and item quantities cannot be converted into one another.");
  const numerator = fixed(value) * BigInt(units[from].factor);
  const denominator = BigInt(units[to].factor);
  if (numerator % denominator !== 0n) fail("The converted quantity requires more than six decimal places.");
  return exactResult(numerator / denominator);
}
function multiplyQuantities(left, right) {
  const product = fixed(left) * fixed(right);
  if (product % SCALE !== 0n) fail("The multiplied quantity requires more than six decimal places.");
  return exactResult(product / SCALE);
}
function derivedPrice(left, right, divide = false) {
  const a = fixed(left, "Price", { maximum: MAX_PRICE }), b = fixed(right, "Package quantity", { maximum: MAX_CONVERTED_QUANTITY, positive: true });
  // Prices have explicit six-decimal rounding; physical quantities do not.
  const numerator = divide ? a * SCALE : a * b;
  const denominator = divide ? b : SCALE;
  const result = Number((numerator + denominator / 2n) / denominator) / Number(SCALE);
  if (result > MAX_PRICE) fail("The derived price exceeds the maximum supported price.");
  if (a > 0n && result === 0) fail("The derived price is below the supported price precision.");
  return result;
}
function calculateNetValue(quantity, netPricePerPurchaseUnit) {
  const amount = fixed(quantity, "Purchase quantity");
  const price = optionalNumber(netPricePerPurchaseUnit, "Net purchase price", { maximum: MAX_PRICE });
  if (price === null) return null;
  const product = amount * fixed(price, "Net purchase price", { maximum: MAX_PRICE });
  const rounded = (product + SCALE / 2n) / SCALE;
  if (product > 0n && rounded === 0n) throw new HttpsError("failed-precondition", "The receipt value is below the supported monetary precision.");
  return exactResult(rounded, "Receipt value");
}
function priceContract(input) {
  if (!["net", "gross", "unknown"].includes(input.priceBasis)) fail("An explicit net, gross or unknown price basis is required.");
  const vatRate = optionalNumber(input.vatRate, "VAT rate", { maximum: 1 });
  if (input.priceBasis === "gross" && vatRate === null) fail("Gross prices require an explicit VAT rate, as a fraction from 0 to 1.");
  return { priceBasis: input.priceBasis, vatRate };
}
function optionalPriceDate(value, field) {
  if (value === null || value === undefined || value === "") return null;
  if (!validDate(value)) fail(`${field} must be a valid YYYY-MM-DD date or blank.`);
  return value;
}
function packageGtin(value) {
  if (value === null || value === undefined || value === "") return null;
  const result = text(value, "Package GTIN", 14);
  if (result === "") return null;
  if (!/^([0-9]{8}|[0-9]{12}|[0-9]{13}|[0-9]{14})$/.test(result)) {
    fail("Package GTIN must contain 8, 12, 13 or 14 digits, including its check digit.");
  }
  // GS1 modulo 10: starting immediately before the check digit, weights
  // alternate 3 and 1. Keep the supplied spelling and any leading zeroes.
  let sum = 0;
  for (let index = result.length - 2, weight = 3; index >= 0; index--, weight = weight === 3 ? 1 : 3) {
    sum += Number(result[index]) * weight;
  }
  if ((10 - sum % 10) % 10 !== Number(result.at(-1))) fail("Package GTIN has an invalid GS1 check digit.");
  return result;
}
function netPrice(price, basis, vatRate) {
  price = optionalNumber(price, "Price", { maximum: MAX_PRICE });
  if (price === null || basis === "unknown") return null;
  if (basis === "net") return price;
  if (basis !== "gross" || typeof vatRate !== "number" || !Number.isFinite(vatRate) || vatRate < 0 || vatRate > 1) return null;
  const numerator = fixed(price, "Price", { maximum: MAX_PRICE }) * SCALE;
  const denominator = SCALE + fixed(vatRate, "VAT rate", { maximum: 1 });
  return Number((numerator + denominator / 2n) / denominator) / Number(SCALE);
}

const CATALOG_TEXT = { name: 200, brand: 200, description: 4000, category: 100, subcategory: 100,
  gtin: 100, internalSku: 100, storageType: 100, notes: 4000, imageUrl: 1000 };
function normalizeCatalogProduct(input) {
  supportedFields(input, [...Object.keys(CATALOG_TEXT), "nameLower", "active", "baseUnit", "baseQtyPerUnit", "allergens", "inventoryTracked"], "catalog product");
  const result = {};
  for (const [key, max] of Object.entries(CATALOG_TEXT)) result[key] = text(input[key] ?? "", key, max, key === "name");
  result.nameLower = result.name.toLowerCase();
  if (input.nameLower !== undefined && input.nameLower !== result.nameLower) fail("nameLower must match the product name.");
  result.active = boolean(input.active, "active");
  result.inventoryTracked = boolean(input.inventoryTracked, "inventoryTracked");
  result.baseUnit = baseUnit(input.baseUnit);
  result.baseQtyPerUnit = optionalNumber(input.baseQtyPerUnit, "Base quantity per unit", { maximum: MAX_QUANTITY, positive: true });
  if (!Array.isArray(input.allergens ?? []) || (input.allergens ?? []).length > 30) fail("Use at most 30 allergen labels.");
  result.allergens = [...new Set((input.allergens ?? []).map((value) => text(value, "Allergen", 100, true)))];
  result.productPolicyVersion = PRODUCT_POLICY_VERSION;
  return result;
}
function normalizeOption(input) {
  supportedFields(input, ["id", "purchaseUnit", "baseUnitsPerPurchaseUnit", "pricePerPurchaseUnit", "gtin"], "purchase option");
  return { id: requireDocumentId(input.id, "Purchase option ID"), purchaseUnit: text(input.purchaseUnit, "Purchase unit", 100, true),
    baseUnitsPerPurchaseUnit: decimal(input.baseUnitsPerPurchaseUnit, "Base units per purchase unit", { maximum: MAX_QUANTITY, positive: true }),
    pricePerPurchaseUnit: optionalNumber(input.pricePerPurchaseUnit, "Purchase price", { maximum: MAX_PRICE }), gtin: packageGtin(input.gtin) };
}
function normalizeSupplierProduct(input) {
  if (input && Object.hasOwn(input, "imageUrl")) fail("Supplier product images must use the protected image upload workflow; external image URLs are not supported.");
  supportedFields(input, ["supplierId", "supplierSku", "supplierProductName", "supplierName", "currency", "pricingModel", "pricePerBaseUnit", "pricePerPurchaseUnit", "purchaseUnit", "baseUnit", "baseUnitsPerPurchaseUnit", "catalogProductId", "active", "priceBasis", "vatRate", "purchaseOptions", "priceValidFrom", "priceValidUntil", "gtin"], "supplier product");
  if (!/^[A-Z]{3}$/.test(input.currency ?? "")) fail("Currency must be an explicit three-letter uppercase code.");
  if (!["Per Purchase Unit", "Per Base Unit"].includes(input.pricingModel)) fail("Choose Per Purchase Unit or Per Base Unit pricing.");
  const result = { supplierId: requireDocumentId(input.supplierId, "supplierId"),
    supplierSku: text(input.supplierSku, "Supplier SKU", 150, true), supplierProductName: text(input.supplierProductName, "Supplier product name", 200, true),
    currency: input.currency, pricingModel: input.pricingModel, baseUnit: baseUnit(input.baseUnit),
    purchaseUnit: text(input.purchaseUnit, "Purchase unit", 100, true), gtin: packageGtin(input.gtin),
    baseUnitsPerPurchaseUnit: decimal(input.baseUnitsPerPurchaseUnit, "Base units per purchase unit", { maximum: MAX_QUANTITY, positive: true }),
    pricePerBaseUnit: optionalNumber(input.pricePerBaseUnit, "Base unit price", { maximum: MAX_PRICE }),
    pricePerPurchaseUnit: optionalNumber(input.pricePerPurchaseUnit, "Purchase price", { maximum: MAX_PRICE }),
    catalogProductId: input.catalogProductId === null || input.catalogProductId === undefined || input.catalogProductId === "" ? null : requireDocumentId(input.catalogProductId, "catalogProductId"),
    active: boolean(input.active, "active"), ...priceContract(input),
    priceValidFrom: optionalPriceDate(input.priceValidFrom, "Price valid from"), priceValidUntil: optionalPriceDate(input.priceValidUntil, "Price valid until"),
    productPolicyVersion: PRODUCT_POLICY_VERSION };
  if (result.priceValidFrom && result.priceValidUntil && result.priceValidFrom > result.priceValidUntil) fail("Price valid from must not be after price valid until.");
  if (result.pricingModel === "Per Base Unit") result.pricePerPurchaseUnit = result.pricePerBaseUnit === null ? null : derivedPrice(result.pricePerBaseUnit, result.baseUnitsPerPurchaseUnit);
  else {
    result.pricePerBaseUnit = null;
    if (result.pricePerPurchaseUnit !== null) {
      // Purchase price is authoritative for this contract. An unrepresentable
      // display price per tiny/large base unit is unknown, never rounded free.
      try { result.pricePerBaseUnit = derivedPrice(result.pricePerPurchaseUnit, result.baseUnitsPerPurchaseUnit, true); }
      catch { result.pricePerBaseUnit = null; }
    }
  }
  if (!Array.isArray(input.purchaseOptions ?? []) || (input.purchaseOptions ?? []).length > 20) fail("Use at most 20 additional purchase options.");
  result.purchaseOptions = (input.purchaseOptions ?? []).map(normalizeOption);
  const ids = result.purchaseOptions.map((option) => option.id);
  if (ids.includes("default") || new Set(ids).size !== ids.length) fail("Additional purchase option IDs must be unique and cannot be default.");
  return result;
}

function resolvePurchaseOption(product, optionId = "default") {
  object(product, "Supplier product");
  if (product.hasVariants && (!Array.isArray(product.purchaseOptions) || product.purchaseOptions.length === 0)) {
    throw new HttpsError("failed-precondition", "Legacy package variants require an explicit reviewed purchase-option configuration before ordering.");
  }
  optionId = requireDocumentId(optionId, "Purchase option ID");
  let source;
  if (optionId === "default") source = product;
  else {
    if (!Array.isArray(product.purchaseOptions) || product.purchaseOptions.length > 20) fail("This purchase option needs review.");
    const candidates = product.purchaseOptions.filter((option) => option?.id === optionId);
    if (candidates.length !== 1) fail("Select an existing, unique purchase option.");
    source = candidates[0];
  }
  const price = optionalNumber(source.pricePerPurchaseUnit, "Purchase price", { maximum: MAX_PRICE });
  if (price === null) throw new HttpsError("failed-precondition", "This purchase option has an unknown price and cannot be ordered.");
  if (!/^[A-Z]{3}$/.test(product.currency ?? "")) throw new HttpsError("failed-precondition", "The supplier product currency needs review.");
  const unit = units[product.baseUnit] ? product.baseUnit : null;
  if (!unit && product.productPolicyVersion === PRODUCT_POLICY_VERSION) throw new HttpsError("failed-precondition", "The reviewed supplier base unit needs repair.");
  // Old supplier offers may still be purchased with a known purchase price;
  // their ambiguous physical conversion must remain unavailable.
  let amount = null;
  if (source.baseUnitsPerPurchaseUnit !== null && source.baseUnitsPerPurchaseUnit !== undefined) {
    try { amount = decimal(source.baseUnitsPerPurchaseUnit, "Base units per purchase unit", { maximum: MAX_QUANTITY, positive: true }); }
    catch (error) { if (product.productPolicyVersion === PRODUCT_POLICY_VERSION || optionId !== "default") throw error; }
  }
  if (amount === null && product.productPolicyVersion === PRODUCT_POLICY_VERSION) throw new HttpsError("failed-precondition", "The reviewed package quantity needs repair.");
  const basis = ["net", "gross", "unknown"].includes(product.priceBasis) ? product.priceBasis : "unknown";
  let vatRate = null;
  try { vatRate = optionalNumber(product.vatRate, "VAT rate", { maximum: 1 }); }
  catch (error) { if (product.productPolicyVersion === PRODUCT_POLICY_VERSION) throw error; }
  if (basis === "gross" && vatRate === null && product.productPolicyVersion === PRODUCT_POLICY_VERSION) throw new HttpsError("failed-precondition", "The gross price contract needs an explicit VAT rate.");
  return { id: optionId, purchaseUnit: text(source.purchaseUnit, "Purchase unit", 100, true), baseUnit: unit,
    baseUnitsPerPurchaseUnit: amount, pricePerPurchaseUnit: price, currency: product.currency,
    priceBasis: basis, vatRate, netPricePerPurchaseUnit: netPrice(price, basis, vatRate) };
}

function inventoryTerms(product, catalog, option) {
  const unavailable = (reason) => ({ inventoryPolicyVersion: PRODUCT_POLICY_VERSION, available: false, reason,
    catalogProductId: typeof product?.catalogProductId === "string" ? product.catalogProductId : null,
    catalogProductName: null, catalogBaseUnit: null, catalogUnitsPerPurchaseUnit: null,
    inventoryTracked: typeof catalog?.inventoryTracked === "boolean" ? catalog.inventoryTracked : null, currency: option?.currency ?? product?.currency ?? null, netUnitCost: null });
  if (!product?.catalogProductId) return unavailable("unlinked-supplier-product");
  if (!catalog || catalog.id !== product.catalogProductId) return unavailable("catalog-product-unavailable");
  if (catalog.inventoryTracked === false) return unavailable("catalog-product-not-inventory-tracked");
  if (catalog.inventoryTracked !== true) return unavailable("inventory-tracking-policy-unknown");
  if (catalog.active === false || catalog.archived === true) return unavailable("catalog-product-inactive");
  if (!option?.baseUnit || !catalog.baseUnit || !compatibleUnits(option.baseUnit, catalog.baseUnit) || option.baseUnitsPerPurchaseUnit === null) return unavailable("unknown-or-incompatible-unit-conversion");
  let amount;
  try { amount = convertQuantity(option.baseUnitsPerPurchaseUnit, option.baseUnit, catalog.baseUnit); }
  catch { return unavailable("unrepresentable-unit-conversion"); }
  let netUnitCost = null;
  let costReason = "unknown-net-price-contract";
  if (option.netPricePerPurchaseUnit !== null && option.netPricePerPurchaseUnit !== undefined) {
    try { netUnitCost = derivedPrice(option.netPricePerPurchaseUnit, amount, true); }
    catch (error) { netUnitCost = null; costReason = error.message.includes("below the supported price precision") ? "unit-cost-below-supported-precision" : "unrepresentable-unit-cost"; }
  }
  return { inventoryPolicyVersion: PRODUCT_POLICY_VERSION, available: true,
    reason: netUnitCost === null ? costReason : null,
    catalogProductId: catalog.id, catalogProductName: text(catalog.name, "Catalog product name", 200, true),
    catalogBaseUnit: catalog.baseUnit, catalogUnitsPerPurchaseUnit: amount,
    inventoryTracked: true, currency: option.currency, netUnitCost };
}

module.exports = { PRODUCT_POLICY_VERSION, MAX_QUANTITY, MAX_PRICE, units, baseUnit, compatibleUnits,
  decimal, derivedPrice, convertQuantity, multiplyQuantities, calculateNetValue, netPrice, normalizeCatalogProduct, normalizeSupplierProduct,
  resolvePurchaseOption, inventoryTerms };
