export const PRODUCT_BASE_UNITS = ["g", "kg", "ml", "l", "each"];

export function knownPrice(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function productPurchaseOptions(product = {}) {
  const preview = product.latestApprovedPurchaseTerms;
  const reviewedPreview = hasApprovedScheduledPrice(product) && preview?.versionId === product.latestApprovedPriceVersionId;
  const legacyPackages = product.hasVariants && !(product.purchaseOptions?.length > 0);
  if (legacyPackages && !(reviewedPreview && preview.purchaseOptions?.length > 0)) return [];
  const options = legacyPackages ? [] : [
    { id: "default", purchaseUnit: product.purchaseUnit, baseUnitsPerPurchaseUnit: product.baseUnitsPerPurchaseUnit, pricePerPurchaseUnit: knownPrice(product.pricePerPurchaseUnit) },
    ...(Array.isArray(product.purchaseOptions) ? product.purchaseOptions.filter((option) => option.id !== "default") : []),
  ];
  if (!reviewedPreview) return options;
  const approved = [
    { id: "default", purchaseUnit: preview.purchaseUnit, baseUnitsPerPurchaseUnit: preview.baseUnitsPerPurchaseUnit, pricePerPurchaseUnit: preview.pricePerPurchaseUnit },
    ...(Array.isArray(preview.purchaseOptions) ? preview.purchaseOptions.filter((option) => option.id !== "default") : []),
  ];
  // Keep today's displayed packages. Add future-only options, or fill missing
  // current estimates, with the reviewed preview; the order date still decides.
  const merged = options.map((option) => {
    const next = approved.find((entry) => entry.id === option.id);
    return knownPrice(option.pricePerPurchaseUnit) === null && next && knownPrice(next.pricePerPurchaseUnit) !== null
      ? { ...option, ...next, currency: preview.currency, priceBasis: preview.priceBasis,
        baseUnit: preview.baseUnit, indicativePriceVersionId: preview.versionId, priceRequiresDateReview: true } : option;
  });
  const existing = new Set(merged.map((option) => option.id));
  for (const option of approved) if (!existing.has(option.id)) {
    merged.push({ ...option, currency: preview.currency, priceBasis: preview.priceBasis,
      baseUnit: preview.baseUnit, indicativePriceVersionId: preview.versionId, priceRequiresDateReview: true });
    existing.add(option.id);
  }
  return merged;
}

export function hasApprovedScheduledPrice(product = {}) {
  return typeof product.latestApprovedPriceVersionId === "string" && product.latestApprovedPriceVersionId.length > 0
    && !product.latestApprovedPriceVersionId.includes("/") && product.latestApprovedPriceVersionId !== product.currentPriceVersionId;
}

export function canAddPurchaseOptionToDraftCart(product, option) {
  if (!product || product.active === false || product.archived === true || !option?.purchaseUnit) return false;
  if (knownPrice(option.pricePerPurchaseUnit) !== null) return true;
  // Approved future terms are resolved by the server when adding an estimate.
  // An unreviewed missing price still cannot be treated as a free package.
  return hasApprovedScheduledPrice(product) && PRODUCT_BASE_UNITS.includes(product.baseUnit)
    && typeof option.baseUnitsPerPurchaseUnit === "number" && Number.isFinite(option.baseUnitsPerPurchaseUnit)
    && option.baseUnitsPerPurchaseUnit > 0 && /^[A-Z]{3}$/.test(product.currency ?? "");
}

export function formatPurchasePrice(option, currency, basis, { approvedScheduledPrice = false } = {}) {
  const price = knownPrice(option?.pricePerPurchaseUnit);
  if (price === null) return approvedScheduledPrice ? "Approved dated price · checked in order preview" : "Price unavailable";
  return `Indicative: ${price.toFixed(2)} ${option?.currency || currency || "Currency unavailable"} / ${option.purchaseUnit || "package"} (${option?.priceBasis || basis || "unknown"} price basis)${option?.priceRequiresDateReview ? " · dated version" : ""}`;
}
