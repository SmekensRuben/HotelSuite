import units from "../../functions/src/unitCatalog.json";
import purchaseMeasures from "../../functions/src/purchaseUnitMeasures.json";

export const isMeasuredPurchaseUnit = (unit) => typeof unit === "string" && Object.hasOwn(purchaseMeasures, unit.trim().toLowerCase());
export function measuredPurchaseContent(purchaseUnit, contentUnit) {
  const key = typeof purchaseUnit === "string" ? purchaseUnit.trim().toLowerCase() : "";
  if (!Object.hasOwn(purchaseMeasures, key)) return null;
  const measure = purchaseMeasures[key];
  return previewCatalogPackageQuantity(measure.quantity, measure.baseUnit, contentUnit);
}

export const PRODUCT_UNIT_LABELS = {
  g: "g (grams)", kg: "kg (kilograms)", ml: "ml (millilitres)",
  l: "l (litres)", each: "each (items)",
};

export function productUnitLabel(unit) {
  return PRODUCT_UNIT_LABELS[unit] || "Unit needs review";
}

/** Read-only preview of the existing six-decimal physical-unit contract. */
export function previewCatalogPackageQuantity(quantity, from, to) {
  if (quantity === null || quantity === undefined || quantity === "") return null;
  const value = typeof quantity === "string" ? Number(quantity) : quantity;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1000000) return null;
  if (!units[from] || !units[to] || units[from].dimension !== units[to].dimension) return null;
  const [mantissa, exponentText] = String(value).toLowerCase().split("e");
  const [whole, fraction = ""] = mantissa.split(".");
  const places = fraction.length - Number(exponentText || 0);
  const digits = BigInt(whole + fraction);
  let scaled;
  if (places <= 6) scaled = digits * (10n ** BigInt(6 - places));
  else {
    const divisor = 10n ** BigInt(places - 6);
    if (digits % divisor !== 0n) return null;
    scaled = digits / divisor;
  }
  const numerator = scaled * BigInt(units[from].factor);
  const denominator = BigInt(units[to].factor);
  if (numerator % denominator !== 0n) return null;
  const converted = numerator / denominator;
  if (converted > 1000000000000000n || converted > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(converted) / 1000000;
}

export function packageConversionLabel(quantity, from, to) {
  const converted = previewCatalogPackageQuantity(quantity, from, to);
  return converted === null ? "Package conversion unavailable — review the catalog link, units and package content."
    : `${Number(quantity)} ${from} = ${converted} ${to} per purchase unit for stock counts.`;
}
