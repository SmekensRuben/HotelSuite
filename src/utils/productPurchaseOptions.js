export const PRODUCT_BASE_UNITS = ["g", "kg", "ml", "l", "each"];

export function knownPrice(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function productPurchaseOptions(product = {}) {
  if (product.hasVariants && !(product.purchaseOptions?.length > 0)) return [];
  return [
    { id: "default", purchaseUnit: product.purchaseUnit, baseUnitsPerPurchaseUnit: product.baseUnitsPerPurchaseUnit, pricePerPurchaseUnit: knownPrice(product.pricePerPurchaseUnit) },
    ...(Array.isArray(product.purchaseOptions) ? product.purchaseOptions.filter((option) => option.id !== "default") : []),
  ];
}

export function formatPurchasePrice(option, currency, basis) {
  const price = knownPrice(option?.pricePerPurchaseUnit);
  if (price === null) return "Price unavailable";
  return `${price.toFixed(2)} ${currency || "Currency unavailable"} / ${option.purchaseUnit || "package"} (${basis || "unknown"} price basis)`;
}
