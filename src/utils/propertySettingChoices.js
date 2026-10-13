const commonZones = { "Europe/Brussels": "Belgium — Brussels", "Europe/Amsterdam": "Netherlands — Amsterdam", "Europe/Paris": "France — Paris",
  "Europe/London": "United Kingdom — London", "America/New_York": "United States — New York", "UTC": "Coordinated Universal Time" };
const fallbackZones = [...Object.keys(commonZones), "Europe/Berlin", "Europe/Madrid", "Europe/Rome", "Europe/Lisbon", "America/Chicago", "America/Los_Angeles", "Asia/Dubai", "Asia/Tokyo", "Australia/Sydney"];
const fallbackCurrencies = ["EUR", "USD", "GBP", "CHF", "CAD", "AUD", "NZD", "SEK", "NOK", "DKK", "PLN", "CZK", "JPY", "CNY", "INR", "AED", "ZAR"];
function supported(key, fallback) {
  try { return typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf(key) : fallback; }
  catch { return fallback; }
}
export function validTimeZoneChoice(value) {
  try { return typeof value === "string" && Boolean(value) && value.length <= 80 && Boolean(new Intl.DateTimeFormat("en", { timeZone: value })); }
  catch { return false; }
}
export function timeZoneChoices(saved) {
  const values = new Set([...fallbackZones, ...supported("timeZone", fallbackZones), ...(validTimeZoneChoice(saved) ? [saved] : [])]);
  return [...values].map((id) => ({ id, label: `${commonZones[id] || id.replaceAll("_", " ").split("/").at(-1)} (${id})` }))
    .sort((a, b) => Number(Boolean(commonZones[b.id])) - Number(Boolean(commonZones[a.id])) || a.label.localeCompare(b.label));
}
export function currencyChoices() {
  let names;
  try { names = new Intl.DisplayNames(["en"], { type: "currency" }); } catch { /* The ISO code remains an explicit selection on older browsers. */ }
  return supported("currency", fallbackCurrencies).map((id) => ({ id, label: `${id} — ${names?.of(id) || id}` }))
    .sort((a, b) => Number(b.id === "EUR") - Number(a.id === "EUR") || a.label.localeCompare(b.label));
}
