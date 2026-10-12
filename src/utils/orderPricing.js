export function knownOrderAmount(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
export function formatOrderMoney(value, currency) {
  const amount = knownOrderAmount(value);
  if (amount === null) return "Unavailable";
  return `${amount.toFixed(2)} ${typeof currency === "string" && /^[A-Z]{3}$/.test(currency) ? currency : "(currency unknown)"}`;
}
export function formatOrderSubtotal(price, quantity, currency) {
  if (knownOrderAmount(price) === null || knownOrderAmount(quantity) === null) return "Unavailable";
  return formatOrderMoney(price * quantity, currency);
}

export function normalizeOrderPriceBasis(value) {
  return ["net", "gross", "unknown"].includes(value) ? value : "unknown";
}

export function formatOrderPriceBasis(value) {
  const basis = normalizeOrderPriceBasis(value);
  if (basis === "net") return "Net (excluding VAT)";
  if (basis === "gross") return "Gross (including VAT)";
  return "Unknown (VAT treatment unavailable)";
}
