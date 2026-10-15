"use strict";

const { HttpsError } = require("firebase-functions/v2/https");
const { mappingSnapshot, tableFingerprint, normalizeInterpretation } = require("./supplierImportMappings");
const policy = require("./productPolicy");
const RAW_FIELDS = ["supplierSku", "supplierProductName", "brand", "currency", "pricingModel", "purchaseUnit", "baseUnit", "priceBasis", "gtin",
  "priceValidFrom", "priceValidUntil", "pricePerBaseUnit", "pricePerPurchaseUnit", "baseUnitsPerPurchaseUnit", "vatRate"];
const NUMBER_FIELDS = new Set(["pricePerBaseUnit", "pricePerPurchaseUnit", "baseUnitsPerPurchaseUnit", "vatRate", "packCount", "contentQuantity"]);
const UNIT_ALIASES = { gr: "g", gram: "g", kg: "kg", g: "g", ml: "ml", l: "l", lt: "l", ltr: "l", st: "each", each: "each", piece: "each", pcs: "each" };
const label = (value) => String(value ?? "").normalize("NFC").trim();
function cells(unit) {
  try { const value = JSON.parse(unit.text); return Array.isArray(value) && value.length <= 128 && value.every((cell) => cell === null || typeof cell === "string" || typeof cell === "boolean" || typeof cell === "number" && Number.isFinite(cell)) ? value : null; } catch { return null; }
}
function tablesForSource(source) {
  if (!["csv", "xlsx"].includes(source?.format) || !Array.isArray(source.units) || source.units.length > 5000) return [];
  const tables = [];
  for (const unit of source.units) {
    if (!(unit.sourceId === "csv-header" || /\(possible header\)$/.test(unit.anchor || ""))) continue;
    const header = cells(unit); if (!header) continue;
    const prefix = unit.sourceId === "csv-header" ? "csv-row-" : unit.sourceId.slice(0, unit.sourceId.lastIndexOf("-row-") + 5);
    const match = /^Worksheet \d+ ("(?:[^"\\]|\\.)*"), row /.exec(unit.anchor || "");
    let sheetName = unit.sheetName ?? null;
    if (match && sheetName === null) { try { sheetName = JSON.parse(match[1]); } catch { /* Invalid sheet metadata requires source review. */ } }
    tables.push({ header: header.map((value) => label(value)), sheetName, headerUnit: unit,
      rows: source.units.filter((row) => row !== unit && row.sourceId.startsWith(prefix)),
      formatFingerprint: tableFingerprint(header.map((value) => label(value)), sheetName, source.format) });
  }
  return tables;
}
const COLUMN_LABELS = {
  supplierSku: /^(?:sku|article number|article no|item number|item no|product code|artikelnummer|artikelcode|code article)$/i,
  supplierProductName: /^(?:name|description|product name|article description|artikel omschrijving|omschrijving|productnaam|libell[eé])$/i,
  brand: /^(?:brand|product brand|merk|marque)$/i,
  purchaseUnit: /^(?:purchase unit|purchase package|packaging unit|package|package unit|eenheid verpakking|verpakking|besteleenheid)$/i,
  baseUnitsPerPurchaseUnit: /^(?:package content|total package content|base units per purchase unit|verpakkingsinhoud)$/i,
  baseUnit: /^(?:base unit|inventory unit)$/i,
  packCount: /^(?:pack count|inner packages|inhoud verpakking)$/i,
  contentQuantity: /^(?:inner content|content quantity|inhoud)$/i,
  contentUnit: /^(?:content unit|inner unit|eenheid)$/i,
  currency: /^(?:currency|valuta|devise)$/i,
  priceBasis: /^(?:price basis|prijsbasis|tax basis)$/i,
  vatRate: /^(?:vat rate|vat fraction|vat|btw|tva)(?:\s*\(%\)|\s*%)?$/i,
  priceValidFrom: /^(?:valid from|price valid from|geldig vanaf|start date)$/i,
  priceValidUntil: /^(?:valid until|price valid until|geldig tot|end date)$/i,
  sourceIssuedOn: /^(?:issued on|issue date|source date|list date|document date)$/i,
  gtin: /^(?:gtin|ean|barcode)$/i,
};
function candidateForTable(source, table, importSettings = {}) {
  const columns = {};
  for (const [field, pattern] of Object.entries(COLUMN_LABELS)) {
    const indexes = table.header.flatMap((heading, index) => pattern.test(heading.replace(/[_-]/g, " ").replace(/\s+/g, " ").trim()) ? [index] : []);
    if (indexes.length === 1) columns[field] = indexes[0];
  }
  const priceColumns = table.header.flatMap((heading, index) => /\b(?:price|prijs|prix|aankoopprijs|inkoopprijs|unitprice)\b/i.test(heading)
    && !/\b(?:total|annual|average|historical|spend|amount|value|totaal|gemiddeld|waarde|omzet|yearly)\b/i.test(heading) ? [index] : []);
  if (priceColumns.length === 1 && importSettings.documentPurpose !== "statistics") {
    const index = priceColumns[0], heading = table.header[index];
    if (/(?:\bper\s*|\/\s*)(?:kg|g|l|ml|each)\b/i.test(heading)) columns.pricePerBaseUnit = index;
    else if (/\b(?:purchase|package|box|bottle|pack|piece|unit price|eenheidsprijs|aankoopprijs|inkoopprijs)\b/i.test(heading)) columns.pricePerPurchaseUnit = index;
  }
  return { version: 1, sourceFormat: source.format, header: table.header, sheetName: table.sheetName, formatFingerprint: table.formatFingerprint, columns,
    defaults: {}, assortmentMode: importSettings.assortmentMode ?? "unknown", documentPurpose: importSettings.documentPurpose ?? "price-list", decimalSeparator: ".", dateFormat: "YYYY-MM-DD" };
}
function interpretationForSources(source, snapshot, { importSettings = {} } = {}) {
  const tables = tablesForSource(source), profile = snapshot ? mappingSnapshot(snapshot, { supplierId: snapshot.supplierId, sourceFormat: snapshot.sourceFormat, profileId: snapshot.profileId }) : null;
  const interpretation = profile?.interpretation;
  const matches = interpretation ? tables.filter((table) => tableFingerprint(interpretation.header.map(label), interpretation.sheetName, source.format) === table.formatFingerprint) : [];
  // Never silently ignore an extra worksheet: its data may change the scope.
  const confirmed = matches.length === 1 && tables.length === 1;
  const table = confirmed ? matches[0] : tables.length === 1 ? tables[0] : null;
  const status = confirmed ? "confirmed" : interpretation ? "review-required" : "unconfirmed";
  const sourceInterpretation = { version: 1, status, profileId: profile?.profileId ?? "default", profileRevision: profile?.revision ?? 0,
    requiresFormatReview: ["csv", "xlsx"].includes(source?.format) && !confirmed,
    formatFingerprint: table?.formatFingerprint ?? null, reason: confirmed ? null : tables.length > 1 ? "multiple-tables" : interpretation ? "changed-format" : "unconfirmed-format",
    assortmentMode: importSettings.assortmentMode ?? (confirmed ? interpretation.assortmentMode : "unknown"),
    documentPurpose: importSettings.documentPurpose ?? (confirmed ? interpretation.documentPurpose : "price-list") };
  return { sourceInterpretation, sourceFormatCandidate: table ? candidateForTable(source, table, importSettings) : null,
    ...(confirmed ? { table, interpretation } : {}) };
}
function numberCell(value, separator) {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null;
  const text = label(value), escaped = separator === "." ? "\\." : ",";
  if (!new RegExp(`^\\d+(?:${escaped}\\d{1,6})?$`).test(text)) return null;
  const number = Number(text.replace(",", "."));
  try { return policy.decimal(number, "Source quantity or price"); } catch { return null; }
}
function dateCell(value, format) {
  let text = label(value);
  if (/^\d{4}-\d\d-\d\dT00:00:00\.000Z$/.test(text)) text = text.slice(0, 10);
  if (format === "DD/MM/YYYY") { const match = /^(\d\d)\/(\d\d)\/(\d{4})$/.exec(text); if (!match) return null; text = `${match[3]}-${match[2]}-${match[1]}`; }
  if (!/^\d{4}-\d\d-\d\d$/.test(text)) return null;
  const timestamp = Date.parse(text + "T00:00:00Z");
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === text ? text : null;
}
function packageContentCell(value, decimalSeparator) {
  const text = label(value).replace(/^(?:box|pack|bottle|ds|pk|fl)\s*/i, ""), match = /^(?:(\d{1,6})\s*[x×*]\s*)?(\d+(?:[.,]\d{1,6})?)\s*(kg|g|gr|ml|cl|l|lt|ltr|each|st|pcs|pieces?)$/i.exec(text);
  if (!match) return null;
  const quantity = numberCell(match[2], decimalSeparator), unit = match[3].toLowerCase(), baseUnit = unit === "cl" ? "ml" : UNIT_ALIASES[unit] ?? (/^pieces?$/.test(unit) ? "each" : null);
  if (quantity === null || !baseUnit || match[1] !== undefined && Number(match[1]) < 1) return null;
  try { return { quantity: policy.multiplyQuantities(policy.multiplyQuantities(Number(match[1] ?? 1), quantity), unit === "cl" ? 10 : 1), unit: baseUnit }; }
  catch { return null; }
}
function interpretSupplierSourceRows(source, snapshot, { importSettings = {} } = {}) {
  const format = interpretationForSources(source, snapshot, { importSettings });
  if (format.sourceInterpretation.status !== "confirmed") return { rows: [], ...format };
  const interpretation = normalizeInterpretation(format.interpretation, source.format), units = source.units, rows = [];
  for (const unit of format.table.rows) {
    const values = cells(unit); if (!values) throw new HttpsError("failed-precondition", "A table row no longer has the confirmed source structure.");
    if (values.map(label).length === format.table.header.length && values.map(label).every((value, index) => value === format.table.header[index])) continue;
    const raw = Object.fromEntries(RAW_FIELDS.map((field) => [field, null])), supplied = new Set(), issues = [], extra = {};
    const issue = (field) => issues.push({ field, code: "source-format-cell-invalid", severity: "error", message: "This source cell does not match the confirmed format. Review the source interpretation before approving it." });
    for (const [field, index] of Object.entries(interpretation.columns)) {
      if (unit.uncertainColumns?.includes(index) || format.table.headerUnit.uncertainColumns?.includes(index)) {
        issues.push({ field, code: "source-formula-unverified", severity: "error", message: "The source contains a cached spreadsheet formula for this field. Check an explicit supplier value before approving it." });
      }
      const value = values[index]; if (value === null || value === undefined || label(value) === "") continue;
      if (field === "baseUnitsPerPurchaseUnit" && typeof value === "string" && !/^\d+(?:[.,]\d+)?$/.test(label(value))) {
        const content = packageContentCell(value, interpretation.decimalSeparator);
        if (!content) { issue(field); continue; }
        extra.fullPackageContent = content; continue;
      }
      const percentVat = field === "vatRate" && (/%/.test(format.table.header[index]) || /%$/.test(label(value)));
      let parsed = NUMBER_FIELDS.has(field) ? numberCell(percentVat ? String(value).replace(/%$/, "").trim() : value, interpretation.decimalSeparator)
        : ["priceValidFrom", "priceValidUntil", "sourceIssuedOn"].includes(field) ? dateCell(value, interpretation.dateFormat) : label(value);
      if (parsed === null) { issue(field); continue; }
      if (field === "vatRate") {
        if (percentVat) {
          try {
            const scaled = BigInt(Math.round(policy.decimal(parsed, "Source VAT percentage", { maximum: 100 }) * 1000000));
            if (scaled % 100n !== 0n) throw new Error("VAT precision");
            parsed = Number(scaled / 100n) / 1000000;
          }
          catch { issue(field); continue; }
        }
        if (parsed > 1) { issue(field); continue; }
      }
      if (["baseUnit", "contentUnit"].includes(field)) { parsed = UNIT_ALIASES[String(parsed).toLowerCase()] ?? null; if (!parsed) { issue(field); continue; } }
      if (field === "currency") { parsed = String(parsed).toUpperCase(); if (!Intl.supportedValuesOf("currency").includes(parsed)) { issue(field); continue; } }
      if (field === "priceBasis") {
        const basis = String(parsed).toLowerCase().replace(/\./g, "").replace(/\s+/g, " ");
        parsed = /^(?:net|netto|ht|excl(?:uding)? (?:vat|btw|tva)|exclusive (?:vat|btw|tva))$/.test(basis) ? "net"
          : /^(?:gross|bruto|ttc|incl(?:uding)? (?:vat|btw|tva)|inclusive (?:vat|btw|tva))$/.test(basis) ? "gross" : basis === "unknown" ? "unknown" : null;
        if (!parsed) { issue(field); continue; }
      }
      if (Object.hasOwn(raw, field)) { raw[field] = parsed; supplied.add(field); } else extra[field] = parsed;
    }
    if (!raw.supplierSku) { issue("supplierSku"); }
    for (const [field, value] of Object.entries(interpretation.defaults)) if (raw[field] === null && !Object.hasOwn(interpretation.columns, field)) { raw[field] = value; supplied.add(field); }
    for (const field of ["sourceIssuedOn", "priceValidFrom", "priceValidUntil"]) if (!(field === "sourceIssuedOn" ? extra[field] : raw[field]) && importSettings[field]) {
      if (field === "sourceIssuedOn") extra[field] = importSettings[field]; else { raw[field] = importSettings[field]; supplied.add(field); }
    }
    const channel = raw.pricePerPurchaseUnit !== null ? "pricePerPurchaseUnit" : raw.pricePerBaseUnit !== null ? "pricePerBaseUnit" : null;
    const unitPriceEstablished = format.sourceInterpretation.documentPurpose !== "statistics" && Boolean(channel);
    if (unitPriceEstablished) {
      raw.pricingModel = channel === "pricePerPurchaseUnit" ? "Per Purchase Unit" : "Per Base Unit"; supplied.add("pricingModel");
      for (const field of ["currency", "priceBasis", "vatRate"]) if (raw[field] === null && !Object.hasOwn(interpretation.columns, field) && importSettings[field] !== null && importSettings[field] !== undefined) { raw[field] = importSettings[field]; supplied.add(field); }
      for (const field of ["currency", "priceBasis"]) if (raw[field] !== null && raw[field] !== "unknown" && importSettings[field] !== undefined && importSettings[field] !== "unknown" && raw[field] !== importSettings[field]) {
        issues.push({ field, code: "source-format-context-conflict", severity: "error", message: "The confirmed source terms differ from this import's pricing context. Review the source or correct the import settings before approval." });
      }
    } else { raw.pricePerPurchaseUnit = null; raw.pricePerBaseUnit = null; }
    // A kilogram purchase measure defines its mass dimension before a price
    // conversion; a shared package default cannot turn KG into volume/items.
    if (/^(?:kg|kilo|kilograms?)$/i.test(raw.purchaseUnit ?? "")) raw.baseUnit = raw.baseUnit && policy.compatibleUnits(raw.baseUnit, "kg") ? raw.baseUnit : "kg";
    if (raw.pricePerBaseUnit !== null) {
      const priceHeader = interpretation.columns.pricePerBaseUnit !== undefined ? format.table.header[interpretation.columns.pricePerBaseUnit] : "";
      const explicitUnit = priceHeader.match(/(?:\bper\s*|\/\s*)(kg|g|ml|l|each)\b/i)?.[1]?.toLowerCase();
      if (explicitUnit) {
        try {
          const base = raw.baseUnit ?? explicitUnit;
          raw.pricePerBaseUnit = policy.derivedPrice(raw.pricePerBaseUnit, policy.convertQuantity(1, explicitUnit, base), true);
          raw.baseUnit = base; supplied.add("baseUnit");
        } catch { raw.pricePerBaseUnit = null; issue("pricePerBaseUnit"); }
      }
    }
    if (/^(?:kg|kilo|kilograms?)$/i.test(raw.purchaseUnit ?? "")) {
      raw.baseUnit = raw.baseUnit && policy.compatibleUnits(raw.baseUnit, "kg") ? raw.baseUnit : "kg";
      raw.baseUnitsPerPurchaseUnit = policy.convertQuantity(1, "kg", raw.baseUnit); supplied.add("baseUnit"); supplied.add("baseUnitsPerPurchaseUnit");
      if (raw.pricePerPurchaseUnit !== null) { raw.pricePerBaseUnit = policy.derivedPrice(raw.pricePerPurchaseUnit, raw.baseUnitsPerPurchaseUnit, true); raw.pricePerPurchaseUnit = null;
        raw.pricingModel = "Per Base Unit"; supplied.delete("pricePerPurchaseUnit"); supplied.add("pricePerBaseUnit"); }
    } else if (extra.fullPackageContent) {
      try { const base = raw.baseUnit ?? extra.fullPackageContent.unit;
        raw.baseUnitsPerPurchaseUnit = policy.convertQuantity(extra.fullPackageContent.quantity, extra.fullPackageContent.unit, base); raw.baseUnit = base;
        supplied.add("baseUnitsPerPurchaseUnit"); supplied.add("baseUnit");
      } catch { issue("baseUnitsPerPurchaseUnit"); }
    } else if (raw.baseUnitsPerPurchaseUnit === null && extra.packCount !== undefined && extra.contentQuantity !== undefined && extra.contentUnit) {
      try {
        const content = policy.multiplyQuantities(extra.packCount, extra.contentQuantity), base = raw.baseUnit ?? extra.contentUnit;
        raw.baseUnitsPerPurchaseUnit = policy.convertQuantity(content, extra.contentUnit, base); raw.baseUnit = base;
        supplied.add("baseUnitsPerPurchaseUnit"); supplied.add("baseUnit");
      } catch { issue("baseUnitsPerPurchaseUnit"); }
    }
    const quote = raw.supplierSku && String(values[interpretation.columns.supplierSku] ?? "").slice(0, 1000) || String(values.find((value) => label(value)) ?? "").slice(0, 1000);
    const checked = require("./supplierAiProposal").validateRawSupplierAiRows({ rows: [{ ...raw, sourceAnchors: [{ sourceId: unit.sourceId, quote }] }] }, { sourceUnits: units })[0];
    rows.push({ ...checked, sourceInterpretation: { ...format.sourceInterpretation, sourceIssuedOn: extra.sourceIssuedOn ?? null,
      providedFields: [...supplied].sort(), unitPriceEstablished: unitPriceEstablished && (raw.pricePerPurchaseUnit !== null || raw.pricePerBaseUnit !== null)
        && !issues.some((entry) => ["pricePerPurchaseUnit", "pricePerBaseUnit"].includes(entry.field)), interpretationFingerprint: snapshot.interpretationFingerprint ?? require("./supplierImportMappings").interpretationFingerprint(interpretation, source.format) },
      normalizationVersion: 2, originalInput: { ...raw }, normalizationFindings: issues, packInference: null,
      ...(raw.purchaseUnit ? { purchaseUnitMapping: require("./supplierAiNormalization").normalizePurchaseUnit(raw.purchaseUnit, { snapshot }) } : {}) });
    const row = rows.at(-1);
    if (row.purchaseUnitMapping?.status === "unconfirmed") row.normalizationFindings.push({ field: "purchaseUnit", code: "purchase-unit-unconfirmed", severity: "error",
      message: "Confirm this supplier purchase-package code before importing it.", before: raw.purchaseUnit, after: row.purchaseUnitMapping.suggestedUnit, provenance: "supplier-mapping" });
    else if (row.purchaseUnitMapping) row.purchaseUnit = row.purchaseUnitMapping.suggestedUnit;
    if (rows.length > 1000) throw new HttpsError("resource-exhausted", "The source contains more than 1,000 proposed products. No partial proposal was accepted.");
  }
  return { rows, sourceInterpretation: format.sourceInterpretation, sourceFormatCandidate: format.sourceFormatCandidate };
}
module.exports = { tablesForSource, interpretationForSources, interpretSupplierSourceRows, dateCell, numberCell };
