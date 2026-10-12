const SCALE = 1000000n;
const MAX = 1000000n * SCALE;
const UNITS = new Set(["g", "kg", "ml", "l", "each"]);
function micros(value, field, { numeric = false, positive = false } = {}) {
  if (numeric && (typeof value !== "number" || !Number.isFinite(value))) throw new Error(`${field} is unavailable.`);
  const spelling = String(value);
  if (!/^\d+(\.\d{1,6})?$/.test(spelling)) throw new Error(`${field} needs a non-negative number with at most six decimal places.`);
  const [whole, fraction = ""] = spelling.split(".");
  const quantity = BigInt(whole) * SCALE + BigInt(fraction.padEnd(6, "0"));
  if (quantity > MAX || positive && quantity === 0n) throw new Error(`${field} is outside the supported quantity bound.`);
  return quantity;
}
function spelling(quantity) {
  const fraction = String(quantity % SCALE).padStart(6, "0").replace(/0+$/, "");
  return String(quantity / SCALE) + (fraction ? `.${fraction}` : "");
}

/** Exact physical quantity only. Optional estimated unit cost is never inferred. */
export function countPackageQuantity(entries, looseQuantity, baseUnit) {
  if (!UNITS.has(baseUnit)) throw new Error("The frozen catalog count unit is unavailable.");
  if (!Array.isArray(entries) || entries.length > 10) throw new Error("Use at most ten package entries for one article.");
  let total = 0n, explicit = looseQuantity !== "";
  if (explicit) total = micros(looseQuantity, "Loose quantity");
  for (const entry of entries) {
    if (entry.quantity === "") continue;
    explicit = true;
    if (!entry.option || entry.option.baseUnit !== baseUnit) throw new Error("Choose a validated package for this count unit.");
    if (!/^\d+$/.test(String(entry.quantity))) throw new Error("Full packages need a non-negative whole number. Enter opened contents as loose quantity.");
    const packageQuantity = micros(entry.quantity, "Full packages");
    const contents = micros(entry.option.catalogUnitsPerPackage, "Package contents", { numeric: true, positive: true });
    total += packageQuantity * contents / SCALE;
    if (total > MAX) throw new Error("The total count cannot exceed 1,000,000 catalog units.");
  }
  if (!explicit) return { counted: false, quantity: null, text: "" };
  if (total > MAX) throw new Error("The total count cannot exceed 1,000,000 catalog units.");
  return { counted: true, quantity: Number(total) / Number(SCALE), text: spelling(total) };
}
