export function formatInventoryValue(value, currency) {
  if (typeof value !== "number" || !Number.isFinite(value) || !/^[A-Z]{3}$/.test(currency || "")) return "Unavailable";
  try { return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(value); }
  catch { return "Unavailable"; }
}
export function formatInventoryQuantity(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? new Intl.NumberFormat(undefined, { maximumFractionDigits: 6 }).format(value) : "Unknown";
}
export function parseInventoryDecimal(value, { optional = false } = {}) {
  if (value === "" && optional) return null;
  if (!/^\d+(\.\d{1,6})?$/.test(String(value))) throw new Error("Enter a non-negative number with at most six decimal places.");
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric > 1000000) throw new Error("Enter a number no greater than 1,000,000.");
  return numeric;
}
export function formatInventoryUnitCost(value, currency) {
  if (typeof value !== "number" || !Number.isFinite(value) || !/^[A-Z]{3}$/.test(currency || "")) return "Unavailable";
  const formatter = new Intl.NumberFormat(undefined, { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 6 });
  return value > 0 && value < 0.000001 ? `<${formatter.format(0.000001)}` : formatter.format(value);
}
