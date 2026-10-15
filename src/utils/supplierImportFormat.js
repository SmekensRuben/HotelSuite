const columns = new Set(["supplierSku", "supplierProductName", "brand", "purchaseUnit", "baseUnitsPerPurchaseUnit", "baseUnit", "pricePerPurchaseUnit", "pricePerBaseUnit", "priceBasis", "currency", "vatRate", "priceValidFrom", "priceValidUntil", "sourceIssuedOn", "gtin", "packCount", "contentQuantity", "contentUnit"]);
const defaults = new Set(["baseUnit", "pricingModel", "currency", "priceBasis", "vatRate"]);
const object = (value) => Boolean(value && typeof value === "object" && !Array.isArray(value));
const label = (value, max = 300) => typeof value === "string" && value.length <= max && !/[\u0000-\u001f]/.test(value);
export function validSupplierDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export function normalizeSupplierFormatInterpretation(value, { candidate = false } = {}) {
  const allowed = ["version", "header", "sheetName", "columns", "defaults", "assortmentMode", "documentPurpose", "decimalSeparator", "dateFormat"];
  if (!object(value) || Object.keys(value).some((key) => !allowed.includes(key)) || value.version !== 1
    || !Array.isArray(value.header) || !value.header.length || value.header.length > 128 || value.header.some((item) => typeof item !== "string" || item.length > 8192 || /[\u0000]/.test(item))
    || value.sheetName !== null && !label(value.sheetName, 200) || !object(value.columns)
    || Object.entries(value.columns).some(([key, index]) => !columns.has(key) || !Number.isInteger(index) || index < 0 || index >= value.header.length)
    || !candidate && (!Number.isInteger(value.columns.supplierSku) || new Set(Object.values(value.columns)).size !== Object.keys(value.columns).length || value.columns.pricePerPurchaseUnit !== undefined && value.columns.pricePerBaseUnit !== undefined)
    || !object(value.defaults) || Object.entries(value.defaults).some(([key, item]) => !defaults.has(key) || item !== null && typeof item !== "boolean" && typeof item !== "number" && !label(item, 200) || typeof item === "number" && !Number.isFinite(item))
    || !["full", "partial", "unknown"].includes(value.assortmentMode) || !["price-list", "product-list", "statistics"].includes(value.documentPurpose)
    || ![".", ","].includes(value.decimalSeparator) || !["YYYY-MM-DD", "DD/MM/YYYY"].includes(value.dateFormat)) throw new Error("The supplier file interpretation could not be verified. Review its columns and defaults.");
  return { version: 1, header: value.header.map((item) => item.normalize("NFC")), sheetName: value.sheetName, columns: Object.fromEntries(Object.keys(value.columns).sort().map((key) => [key, value.columns[key]])), defaults: Object.fromEntries(Object.keys(value.defaults).sort().map((key) => [key, value.defaults[key]])),
    assortmentMode: value.assortmentMode, documentPurpose: value.documentPurpose, decimalSeparator: value.decimalSeparator, dateFormat: value.dateFormat };
}
export function projectSupplierFormatCandidate(value) {
  if (!object(value) || !["csv", "xlsx"].includes(value.sourceFormat) || !label(value.formatFingerprint, 128) || !value.formatFingerprint) return null;
  try {
    const interpretation = normalizeSupplierFormatInterpretation(Object.fromEntries(["version", "header", "sheetName", "columns", "defaults", "assortmentMode", "documentPurpose", "decimalSeparator", "dateFormat"].map((key) => [key, value[key]])), { candidate: true });
    return { ...interpretation, sourceFormat: value.sourceFormat, formatFingerprint: value.formatFingerprint };
  } catch { return null; }
}
export function projectSupplierSourceInterpretation(value) {
  if (!object(value) || value.version !== 1 || !["confirmed", "review-required", "unconfirmed"].includes(value.status)
    || !label(value.profileId, 80) || !Number.isSafeInteger(value.profileRevision) || value.profileRevision < 0
    || value.formatFingerprint !== null && !label(value.formatFingerprint, 128)
    || !["full", "partial", "unknown"].includes(value.assortmentMode) || !["price-list", "product-list", "statistics"].includes(value.documentPurpose)) return null;
  return { version: 1, status: value.status, profileId: value.profileId, profileRevision: value.profileRevision,
    formatFingerprint: value.formatFingerprint, reason: label(value.reason, 500) ? value.reason : null,
    assortmentMode: value.assortmentMode, documentPurpose: value.documentPurpose };
}
