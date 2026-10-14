import { validSupplierDate } from "./supplierImportFormat";
const counters = ["totalRows", "normalizedRows", "assumptionRows", "unknownPriceRows", "blockedNormalizationRows", "inferredPieceRows", "missingRequiredRows"];
const categories = ["new", "changed", "unchanged", "blocked"];
const own = (value, field) => Object.hasOwn(value, field);
const rowCount = (value, maximum = 1000) => Number.isSafeInteger(value) && value >= 0 && value <= maximum;
const text = (value, maximum) => typeof value === "string" && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f]/.test(value);
const providerDetail = /\b(?:openai|provider|tokens?|budget|billing|billed|reasoning|fallback|secret|api[-_\s]?key|bearer|gpt[-\s][a-z0-9][a-z0-9._-]*|max(?:Input|Output|Calls)|priceVersion|estimated\s+(?:AI\s+)?cost|actual\s+(?:AI\s+)?cost|AI[-_\s]?(?:model|cost|usage))\b|(?:CostUsd|CostMicros|reservedCost|sk-[a-z0-9])/i;
const operatorField = /^(?:usage|model|provider|budget|cost|configuration|apiKey|secret|(?:input|output|cached|reasoning)?Tokens?|(?:actual|known|reserved)?Cost(?:Usd|Micros)?)$/i;
const id = (value) => text(value, 128) && value.trim() === value && !/[\\/]/.test(value) && ![".", ".."].includes(value);

export function supplierAiImportCategoryCounts(value, totalRows) {
  if (!value || typeof value !== "object" || categories.some((field) => !rowCount(value[field]))) return null;
  if (totalRows !== undefined && totalRows !== null && (!rowCount(totalRows) || categories.reduce((total, field) => total + value[field], 0) !== totalRows)) return null;
  return Object.fromEntries(categories.map((field) => [field, value[field]]));
}

// A complete overview comes from the server's full reconciliation. A loaded
// review page cannot substitute for a missing or incomplete summary.
export function supplierAiImportSummary(value, { totalRows, counts } = {}) {
  if (!value || typeof value !== "object" || value.version !== 2 || counters.some((field) => !own(value, field) || !rowCount(value[field], field === "totalRows" ? 1000 : value.totalRows))) return null;
  if (totalRows !== undefined && totalRows !== null && value.totalRows !== totalRows) return null;
  if (counts !== undefined && counts !== null && !supplierAiImportCategoryCounts(counts, value.totalRows)) return null;
  if (!Array.isArray(value.findings) || value.findings.length > 20) return null;
  const findings = [];
  const seen = new Set();
  for (const finding of value.findings) {
    if (!finding || !text(finding.field, 100) || !text(finding.code, 160) || !text(finding.message, 500) || !["info", "warning", "error"].includes(finding.severity) || !Number.isSafeInteger(finding.count) || finding.count < 1 || finding.count > value.totalRows || !Array.isArray(finding.rowIds) || finding.rowIds.length > 3 || finding.rowIds.some((rowId) => !id(rowId)) || new Set(finding.rowIds).size !== finding.rowIds.length) return null;
    if (operatorField.test(finding.field) || providerDetail.test(finding.field) || providerDetail.test(finding.code)) return null;
    const message = providerDetail.test(finding.message) ? "Your hotel administrator can help with this import check." : finding.message;
    const group = JSON.stringify([finding.field, finding.code, finding.severity]);
    if (seen.has(group)) return null;
    seen.add(group);
    findings.push({ field: finding.field, code: finding.code, severity: finding.severity, message, count: finding.count, rowIds: [...finding.rowIds] });
  }
  return { version: 2, ...Object.fromEntries(counters.map((field) => [field, value[field]])), findings };
}

export function supplierAiImportSettings(value) {
  if (!value || typeof value !== "object" || ["policyVersion", "priceBasis", "currency", "vatRate"].some((field) => !own(value, field)) || value.policyVersion !== 2 || !["net", "gross", "unknown"].includes(value.priceBasis) || typeof value.currency !== "string" || !/^[A-Z]{3}$/.test(value.currency) || (value.vatRate !== null && (typeof value.vatRate !== "number" || !Number.isFinite(value.vatRate) || value.vatRate < 0 || value.vatRate > 1))) return null;
  const result = { policyVersion: 2, priceBasis: value.priceBasis, currency: value.currency, vatRate: value.vatRate };
  for (const [key, allowed] of [["assortmentMode", ["full", "partial", "unknown"]], ["documentPurpose", ["price-list", "product-list", "statistics"]]]) {
    if (own(value, key)) { if (!allowed.includes(value[key])) return null; result[key] = value[key]; }
  }
  for (const key of ["sourceIssuedOn", "priceValidFrom", "priceValidUntil"]) {
    if (own(value, key)) { if (value[key] !== null && !validSupplierDate(value[key])) return null; result[key] = value[key]; }
  }
  if (result.priceValidFrom && result.priceValidUntil && result.priceValidFrom > result.priceValidUntil) return null;
  return result;
}

export function supplierAiReviewRowLabel(rowId) {
  const match = /^r-([0-9]{6})$/.exec(String(rowId || ""));
  return match && Number(match[1]) > 0 ? `Review row ${Number(match[1])}` : `Review row ${rowId}`;
}
