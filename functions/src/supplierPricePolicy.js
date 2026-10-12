const policy = require("./productPolicy");
const { digest } = require("./validation");
const { validDate } = require("./importMonitoringPolicy");

const SUPPLIER_PRICE_POLICY_VERSION = 1;
const SCALE = 1000000n;
const nullish = (value) => value === undefined ? null : value;

// Only purchasing terms participate in the immutable price-content fingerprint.
// Names, active flags and pictures do not manufacture price-change events.
function pricingTerms(product, catalog) {
  const additional = product?.purchaseOptions ?? [];
  const optionIds = Array.isArray(additional) ? additional.map((option) => option?.id) : [];
  return {
    productPolicyVersion: nullish(product?.productPolicyVersion), unitPolicyVersion: 1,
    catalogProductId: nullish(product?.catalogProductId), catalogBaseUnit: nullish(catalog?.baseUnit),
    baseUnit: nullish(product?.baseUnit), currency: nullish(product?.currency),
    priceBasis: nullish(product?.priceBasis), vatRate: nullish(product?.vatRate),
    contractualValidFrom: nullish(product?.priceValidFrom), contractualValidUntil: nullish(product?.priceValidUntil),
    pricingModel: nullish(product?.pricingModel), hasUnreviewedVariants: product?.hasVariants === true && !product.purchaseOptions?.length,
    configurationValid: Array.isArray(additional) && additional.length <= 20
      && optionIds.every((id) => typeof id === "string" && id && !id.includes("/") && !["default", ".", ".."].includes(id))
      && new Set(optionIds).size === optionIds.length,
    options: [{ id: "default", purchaseUnit: nullish(product?.purchaseUnit),
      baseUnitsPerPurchaseUnit: nullish(product?.baseUnitsPerPurchaseUnit), pricePerPurchaseUnit: nullish(product?.pricePerPurchaseUnit) },
    ...(Array.isArray(product?.purchaseOptions) ? product.purchaseOptions.map((option) => ({
      id: nullish(option?.id), purchaseUnit: nullish(option?.purchaseUnit),
      baseUnitsPerPurchaseUnit: nullish(option?.baseUnitsPerPurchaseUnit), pricePerPurchaseUnit: nullish(option?.pricePerPurchaseUnit),
    })).sort((left, right) => String(left.id) < String(right.id) ? -1 : String(left.id) > String(right.id) ? 1 : 0) : [])],
  };
}

function priceTermsChanged(previous, next, previousCatalog, nextCatalog) {
  if (!previous) return true;
  return digest(pricingTerms(previous, previousCatalog)) !== digest(pricingTerms(next, nextCatalog));
}

function canonicalPrice(terms, option) {
  const unavailable = (reason) => ({ available: false, reason, catalogUnitsPerPurchaseUnit: null,
    netPricePerPurchaseUnit: null, netPricePerCatalogUnit: null });
  if (terms?.productPolicyVersion !== policy.PRODUCT_POLICY_VERSION) return unavailable("product-policy-needs-review");
  if (terms.configurationValid !== true || !Array.isArray(terms.options) || terms.options.length < 1 || terms.options.length > 21
    || terms.options[0]?.id !== "default" || new Set(terms.options.map((entry) => entry.id)).size !== terms.options.length) return unavailable("purchase-options-configuration-invalid");
  if (terms.hasUnreviewedVariants) return unavailable("purchase-options-need-review");
  if (!terms.catalogProductId || !terms.catalogBaseUnit) return unavailable("catalog-link-or-unit-unavailable");
  if (!/^[A-Z]{3}$/.test(terms.currency ?? "")) return unavailable("currency-unavailable");
  if (!["net", "gross"].includes(terms.priceBasis)) return unavailable("price-basis-unavailable");
  if (typeof option?.pricePerPurchaseUnit !== "number") return unavailable("purchase-price-unavailable");
  try {
    const price = policy.decimal(option.pricePerPurchaseUnit, "Purchase price", { maximum: policy.MAX_PRICE });
    if (terms.priceBasis === "gross") {
      if (typeof terms.vatRate !== "number") return unavailable("vat-rate-unavailable");
      policy.decimal(terms.vatRate, "VAT rate", { maximum: 1 });
    }
    const amount = policy.convertQuantity(option.baseUnitsPerPurchaseUnit, terms.baseUnit, terms.catalogBaseUnit);
    if (amount <= 0) return unavailable("package-content-unavailable");
    const net = policy.netPrice(price, terms.priceBasis, terms.vatRate);
    if (net === null || price > 0 && net === 0) return unavailable("net-price-below-supported-precision");
    const scaled = (value) => BigInt(value.toFixed(6).replace(".", ""));
    const numerator = scaled(net) * SCALE, denominator = scaled(amount);
    const rounded = (numerator + denominator / 2n) / denominator;
    if (rounded > BigInt(policy.MAX_PRICE) * SCALE || numerator > 0n && rounded === 0n) return unavailable("canonical-price-outside-supported-precision");
    return { available: true, reason: null, catalogUnitsPerPurchaseUnit: amount,
      netPricePerPurchaseUnit: net, netPricePerCatalogUnit: Number(rounded) / Number(SCALE) };
  } catch { return unavailable("invalid-or-incompatible-price-content"); }
}

function projectOptions(terms) {
  // Limit output size, but never expose a valid partial price comparison from a
  // malformed configuration. Every displayed row is explicitly unavailable.
  return (Array.isArray(terms?.options) ? terms.options : []).slice(0, 21)
    .map((option) => ({ id: typeof option.id === "string" ? option.id : null,
      purchaseUnit: typeof option.purchaseUnit === "string" ? option.purchaseUnit.slice(0, 100) : null,
      baseUnitsPerPurchaseUnit: typeof option.baseUnitsPerPurchaseUnit === "number" && Number.isFinite(option.baseUnitsPerPurchaseUnit) && option.baseUnitsPerPurchaseUnit >= 0 ? option.baseUnitsPerPurchaseUnit : null,
      pricePerPurchaseUnit: typeof option.pricePerPurchaseUnit === "number" && Number.isFinite(option.pricePerPurchaseUnit) && option.pricePerPurchaseUnit >= 0 ? option.pricePerPurchaseUnit : null,
      ...canonicalPrice(terms, option) }));
}

function historyEntry(plan, actorUid, now) {
  return { supplierPricePolicyVersion: SUPPLIER_PRICE_POLICY_VERSION, supplierProductId: plan.productId,
    supplierId: plan.next.supplierId ?? null, supplierSku: plan.next.supplierSku ?? null,
    supplierProductName: plan.next.supplierProductName ?? null, supplierName: plan.next.supplierName ?? null,
    revision: plan.expected + 1, actorUid, observedAt: now,
    observation: plan.previous ? "terms-changed" : "initial-create",
    terms: pricingTerms(plan.next, plan.catalog), previousTerms: plan.previous ? pricingTerms(plan.previous, plan.previousCatalog) : null,
    // The earlier terms were observed in this transaction, not at an invented prior date.
    previousObservationDate: null, contractualValidFrom: plan.next.priceValidFrom ?? null, contractualValidUntil: plan.next.priceValidUntil ?? null };
}

function assessPriceValidity(product, today) {
  const from = product?.priceValidFrom ?? null, until = product?.priceValidUntil ?? null;
  if (from === null && until === null) return "unknown";
  if (from !== null && !validDate(from) || until !== null && !validDate(until) || from && until && from > until) return "invalid";
  if (!validDate(today)) return "unavailable";
  if (from && today < from) return "future";
  if (until && today > until) return "expired";
  return "current";
}

module.exports = { SUPPLIER_PRICE_POLICY_VERSION, pricingTerms, priceTermsChanged, canonicalPrice, projectOptions, historyEntry, assessPriceValidity };
