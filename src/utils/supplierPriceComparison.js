const knownPrice = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const reasonLabels = {
  "product-policy-needs-review": "Product terms need review",
  "purchase-options-need-review": "Legacy purchase options need review",
  "purchase-options-configuration-invalid": "Purchase option configuration needs review",
  "catalog-link-or-unit-unavailable": "Catalog link or unit unavailable",
  "currency-unavailable": "Currency unknown",
  "price-basis-unavailable": "Price basis unknown",
  "purchase-price-unavailable": "Purchase price unknown",
  "vat-rate-unavailable": "Gross price VAT unknown",
  "package-content-unavailable": "Package contents unknown",
  "net-price-below-supported-precision": "Net price is below supported precision",
  "canonical-price-outside-supported-precision": "Unit price is outside supported precision",
  "invalid-or-incompatible-price-content": "Invalid price, package content or unit conversion",
  "purchase-option-removed": "Purchase option removed",
  "price-validity-future": "Contract price is not yet valid",
  "price-validity-expired": "Contract price has expired",
  "price-validity-unavailable": "Set a hotel time zone to assess price validity",
  "price-validity-invalid": "Contract validity dates need review",
  "supplier-pricing-date-agreement-unknown": "Confirm whether prices apply on the order date or delivery date",
  "price-source-date-unknown": "Source issue date is unknown",
  "purchase-option-price-confirmation-unknown": "One or more purchase options have no matching price confirmation",
};
export const supplierPriceUnavailableLabel = (reason) => reasonLabels[reason] || "Price comparison unavailable";

/** Rank only server-validated eligible offers, separately for each explicit currency. */
export function compareSupplierOffers(products, { query = "", currency = "", includeUnavailable = true } = {}) {
  const needle = query.trim().toLowerCase();
  const rows = (Array.isArray(products) ? products : []).filter((product) => product.active === true)
    .flatMap((product) => (product.options || []).map((option) => ({ ...option, supplierProductId: product.id,
      supplierId: product.supplierId, supplierName: product.supplierName, supplierSku: product.supplierSku,
      name: product.name, currency: product.currency, priceBasis: product.priceBasis, vatRate: product.vatRate,
      priceValidity: product.priceValidity || "unknown", contractualValidFrom: product.contractualValidFrom,
      contractualValidUntil: product.contractualValidUntil,
      sourcePriceRecordedAt: product.sourcePriceRecordedAt, reliability: product.reliability, scheduledVersionCount: product.scheduledVersionCount || 0 })))
    .map((row) => ({ ...row, reason: !["current", "unknown"].includes(row.priceValidity) ? `price-validity-${row.priceValidity}` : row.reason,
      comparable: ["current", "unknown"].includes(row.priceValidity) && row.available === true && /^[A-Z]{3}$/.test(row.currency || "") && knownPrice(row.netPricePerCatalogUnit) }))
    .filter((row) => (!currency || row.currency === currency) && (!needle || [row.name, row.supplierName, row.supplierSku, row.purchaseUnit].some((value) => String(value || "").toLowerCase().includes(needle)))
      && (includeUnavailable || row.comparable));
  const minimums = new Map();
  // The cheapest label is based on all loaded eligible offers, not on a name filter.
  for (const product of products || []) if (product.active === true && ["current", "unknown"].includes(product.priceValidity || "unknown") && /^[A-Z]{3}$/.test(product.currency || "")) {
    for (const option of product.options || []) if (option.available === true && knownPrice(option.netPricePerCatalogUnit)) {
      const prior = minimums.get(product.currency);
      minimums.set(product.currency, prior === undefined ? option.netPricePerCatalogUnit : Math.min(prior, option.netPricePerCatalogUnit));
    }
  }
  return rows.map((row) => ({ ...row, lowestLoadedPrice: row.comparable && row.netPricePerCatalogUnit === minimums.get(row.currency) }))
    .sort((left, right) => String(left.currency || "").localeCompare(String(right.currency || ""))
      || Number(right.comparable) - Number(left.comparable)
      || (left.comparable ? left.netPricePerCatalogUnit - right.netPricePerCatalogUnit : 0)
      || String(left.supplierName || "").localeCompare(String(right.supplierName || ""))
      || String(left.supplierProductId).localeCompare(String(right.supplierProductId)) || String(left.id).localeCompare(String(right.id)));
}

export function supplierPriceChanges(entry) {
  const current = entry?.options || [];
  const removed = (entry?.previous?.options || []).filter((option) => !current.some((candidate) => candidate.id === option.id))
    .map((option) => ({ ...option, available: false, reason: "purchase-option-removed", removed: true }));
  return [...current, ...removed].map((option) => {
    const previous = entry.previous?.options?.find((candidate) => candidate.id === option.id);
    const comparable = option.available === true && previous?.available === true
      && /^[A-Z]{3}$/.test(entry.currency || "") && entry.currency === entry.previous.currency
      && entry.catalogBaseUnit === entry.previous.catalogBaseUnit && entry.catalogProductId === entry.previous.catalogProductId
      && knownPrice(option.netPricePerCatalogUnit) && knownPrice(previous.netPricePerCatalogUnit);
    const delta = comparable ? Number((option.netPricePerCatalogUnit - previous.netPricePerCatalogUnit).toFixed(6)) : null;
    return { ...option, previous, comparable, delta,
      percentage: comparable && previous.netPricePerCatalogUnit > 0 ? delta / previous.netPricePerCatalogUnit * 100 : null };
  });
}

export function formatSupplierPrice(value, currency) {
  if (!knownPrice(value) || !/^[A-Z]{3}$/.test(currency || "")) return "Unavailable";
  try { return new Intl.NumberFormat(undefined, { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(value); }
  catch { return `${value} ${currency}`; }
}
