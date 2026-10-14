const test = require("node:test"), assert = require("node:assert/strict");
const { extractSupplierAiSource } = require("./supplierAiExtraction");
const { interpretSupplierSourceRows, interpretationForSources, numberCell, dateCell } = require("./supplierImportFormat");
const { mappingSnapshot } = require("./supplierImportMappings");
const settings = { policyVersion: 2, currency: "EUR", priceBasis: "net", vatRate: null };
const header = ["SKU", "Name", "Package", "Count", "Content", "Content unit", "Unit price", "Valid from", "Issued on"];
const interpretation = { version: 1, header, sheetName: null, columns: { supplierSku: 0, supplierProductName: 1, purchaseUnit: 2, packCount: 3,
  contentQuantity: 4, contentUnit: 5, pricePerPurchaseUnit: 6, priceValidFrom: 7, sourceIssuedOn: 8 }, defaults: { currency: "EUR", priceBasis: "net" },
  assortmentMode: "partial", documentPurpose: "price-list", decimalSeparator: ",", dateFormat: "DD/MM/YYYY" };
const snapshot = (patch = {}) => mappingSnapshot({ version: 1, supplierId: "supplier", sourceFormat: "csv", profileId: "default", revision: 4,
  mappings: [{ sourceUnit: "FL", purchaseUnit: "Bottle" }], interpretation, ...patch }, { supplierId: "supplier", sourceFormat: "csv", profileId: "default" });
const source = async (text) => extractSupplierAiSource({ bytes: Buffer.from(text), fileName: "supplier.csv", mimeType: "text/csv" });
const row = '0001;Sparkling water;FL;12;0,5;L;"18,60";01/11/2026;14/10/2026';
test("confirmed table format parses exact SKUs, split contents, decimals and future dates without interpretation guesses", async () => {
  const parsed = interpretSupplierSourceRows(await source(header.join(";") + "\n" + row), snapshot(), { importSettings: settings });
  const product = parsed.rows[0]; assert.equal(parsed.sourceInterpretation.status, "confirmed");
  assert.equal(product.supplierSku, "0001"); assert.equal(product.purchaseUnit, "Bottle"); assert.equal(product.baseUnit, "l");
  assert.equal(product.baseUnitsPerPurchaseUnit, 6); assert.equal(product.pricePerPurchaseUnit, 18.6); assert.equal(product.priceValidFrom, "2026-11-01");
  assert.equal(product.sourceInterpretation.sourceIssuedOn, "2026-10-14"); assert.equal(product.sourceInterpretation.unitPriceEstablished, true);
  assert.equal(product.sourceAnchors[0].verified, true); assert.deepEqual(product.normalizationFindings, []);
  assert.equal(product.sourceInterpretation.profileRevision, 4); assert.ok(product.sourceInterpretation.providedFields.includes("baseUnitsPerPurchaseUnit"));
});
test("changed headers and extra worksheets cannot reuse confirmed formats or silently omit a table", async () => {
  const data = await source(header.join(";") + "\n" + row);
  data.units[0].text = JSON.stringify([...header.slice(0, -1), "Document date"]);
  const changed = interpretSupplierSourceRows(data, snapshot(), { importSettings: settings });
  assert.equal(changed.sourceInterpretation.status, "review-required"); assert.equal(changed.sourceInterpretation.requiresFormatReview, true); assert.deepEqual(changed.rows, []);
  const multi = { format: "xlsx", units: [
    { sourceId: "xlsx-sheet-1-row-1", anchor: 'Worksheet 1 "Offers", row 1 (possible header)', text: JSON.stringify(header) },
    { sourceId: "xlsx-sheet-1-row-2", anchor: 'Worksheet 1 "Offers", row 2', text: JSON.stringify(row.split(";")) },
    { sourceId: "xlsx-sheet-2-row-1", anchor: 'Worksheet 2 "Extras", row 1 (possible header)', text: JSON.stringify(["SKU", "Name"]) },
  ] };
  const profile = { ...snapshot(), sourceFormat: "xlsx", interpretation: { ...interpretation, sheetName: "Offers" } }; delete profile.interpretationFingerprint;
  assert.equal(interpretationForSources(multi, profile).sourceInterpretation.reason, "multiple-tables");
});
test("blank price columns remain unestablished and statistics never reconfirm price agreements", async () => {
  const data = await source(header.join(";") + "\n" + row.replace('"18,60"', ""));
  const missing = interpretSupplierSourceRows(data, snapshot(), { importSettings: settings }).rows[0];
  assert.equal(missing.pricePerPurchaseUnit, null); assert.equal(missing.sourceInterpretation.unitPriceEstablished, false);
  assert.equal(missing.sourceInterpretation.providedFields.includes("pricePerPurchaseUnit"), false);
  const stats = snapshot({ interpretation: { ...interpretation, columns: { supplierSku: 0, supplierProductName: 1 }, defaults: {}, documentPurpose: "statistics" } });
  const result = interpretSupplierSourceRows(await source(header.join(";") + "\n" + row), stats, { importSettings: settings }).rows[0];
  assert.equal(result.pricePerPurchaseUnit, null); assert.equal(result.sourceInterpretation.unitPriceEstablished, false); assert.equal(result.purchaseUnit, null);
});
test("unknown decimal spelling and invalid calendar dates are blocked instead of rounded or repaired", async () => {
  assert.equal(numberCell("1,234", ","), 1.234); assert.equal(numberCell("1,234", "."), null); assert.equal(numberCell("1.234,56", ","), null);
  assert.equal(dateCell("2026-02-30", "YYYY-MM-DD"), null); assert.equal(dateCell("30/02/2026", "DD/MM/YYYY"), null);
  const parsed = interpretSupplierSourceRows(await source(header.join(";") + "\n" + row.replace("01/11/2026", "30/02/2026")), snapshot(), { importSettings: settings });
  assert.equal(parsed.rows[0].priceValidFrom, null); assert.equal(parsed.rows[0].normalizationFindings[0].code, "source-format-cell-invalid");
});
test("per-upload dates never enter recurring defaults and unstructured documents retain individual review", () => {
  const plan = interpretationForSources({ format: "pdf", units: [] }, null, { importSettings: { sourceIssuedOn: "2026-10-14", priceValidFrom: "2027-01-01" } });
  assert.equal(plan.sourceFormatCandidate, null); assert.equal(plan.sourceInterpretation.requiresFormatReview, false);
});
test("confirmed explicit prices per kilogram convert exactly to a gram inventory unit", async () => {
  const headings = ["SKU", "Name", "Package", "Content", "Price per kg"];
  const profile = snapshot({ interpretation: { ...interpretation, header: headings, columns: { supplierSku: 0, supplierProductName: 1, purchaseUnit: 2,
    baseUnitsPerPurchaseUnit: 3, pricePerBaseUnit: 4 }, defaults: { baseUnit: "g", currency: "EUR", priceBasis: "net" }, decimalSeparator: "." } });
  const parsed = interpretSupplierSourceRows(await source(headings.join(";") + "\n001;Flour;FL;500;8\n"), profile, { importSettings: settings });
  assert.equal(parsed.rows[0].pricePerBaseUnit, 0.008); assert.equal(parsed.rows[0].baseUnit, "g"); assert.equal(parsed.rows[0].baseUnitsPerPurchaseUnit, 500);
  assert.equal(parsed.rows[0].pricingModel, "Per Base Unit");
});
test("a statistical upload overrides a confirmed price-list purpose and cannot reconfirm its numeric prices", async () => {
  const data = await source(header.join(";") + "\n" + row);
  const parsed = interpretSupplierSourceRows(data, snapshot(), { importSettings: { ...settings, documentPurpose: "statistics", assortmentMode: "full" } });
  assert.equal(parsed.sourceInterpretation.status, "confirmed"); assert.equal(parsed.sourceInterpretation.documentPurpose, "statistics");
  assert.equal(parsed.sourceInterpretation.assortmentMode, "full"); assert.equal(parsed.rows[0].pricePerPurchaseUnit, null); assert.equal(parsed.rows[0].sourceInterpretation.unitPriceEstablished, false);
});
test("a confirmed currency conflicting with current import context remains blocked for review", async () => {
  const parsed = interpretSupplierSourceRows(await source(header.join(";") + "\n" + row), snapshot(), { importSettings: { ...settings, currency: "USD" } });
  assert.equal(parsed.rows[0].currency, "EUR"); assert.ok(parsed.rows[0].normalizationFindings.some((finding) => finding.code === "source-format-context-conflict" && finding.field === "currency"));
});
test("cached XLSX formulas remain uncertain even for an exactly confirmed recurring schema", async () => {
  const ExcelJS = require("exceljs"), workbook = new ExcelJS.Workbook(), headings = ["SKU", "Name", "Package", "Content", "Purchase price"];
  workbook.addWorksheet("Offers").addRows([headings, ["0001", "Water", "FL", 0.75, { formula: "2*1.2", result: 2.4 }]]);
  const data = await extractSupplierAiSource({ bytes: Buffer.from(await workbook.xlsx.writeBuffer()), fileName: "offers.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  assert.deepEqual(data.units[1].uncertainColumns, [4]); assert.equal(data.units[1].sheetName, "Offers");
  const scoped = { version: 1, supplierId: "supplier", sourceFormat: "xlsx", profileId: "default", revision: 1, mappings: [{ sourceUnit: "FL", purchaseUnit: "Bottle" }],
    interpretation: { ...interpretation, header: headings, sheetName: "Offers", columns: { supplierSku: 0, supplierProductName: 1, purchaseUnit: 2, baseUnitsPerPurchaseUnit: 3, pricePerPurchaseUnit: 4 },
      defaults: { baseUnit: "l", currency: "EUR", priceBasis: "net" }, decimalSeparator: "." } };
  const parsed = interpretSupplierSourceRows(data, scoped, { importSettings: settings });
  assert.equal(parsed.rows[0].pricePerPurchaseUnit, 2.4); assert.equal(parsed.rows[0].sourceInterpretation.unitPriceEstablished, false);
  assert.equal(parsed.rows[0].normalizationFindings[0].code, "source-formula-unverified");
});
test("a kilogram purchase measure overrides shared volume defaults before physical price conversion", async () => {
  const headings = ["SKU", "Name", "Purchase unit", "Inner count", "Inner content", "Content unit", "Price per kg", "Currency"];
  const profile = snapshot({ interpretation: { ...interpretation, header: headings, columns: { supplierSku: 0, supplierProductName: 1, purchaseUnit: 2,
    packCount: 3, contentQuantity: 4, contentUnit: 5, pricePerBaseUnit: 6, currency: 7 }, defaults: { baseUnit: "l", currency: "EUR", priceBasis: "net" }, decimalSeparator: "." }, mappings: [] });
  const parsed = interpretSupplierSourceRows(await source(headings.join(";") + "\nKG001;Flour;KG;1;1;ST;8;EUR\n"), profile, { importSettings: settings });
  const row = parsed.rows[0]; assert.equal(row.purchaseUnit, "kg"); assert.equal(row.baseUnit, "kg"); assert.equal(row.baseUnitsPerPurchaseUnit, 1); assert.equal(row.pricePerBaseUnit, 8);
  assert.equal(row.sourceInterpretation.unitPriceEstablished, true); assert.deepEqual(row.normalizationFindings, []);
});
test("confirmed total-content columns parse explicit named quantities and multipacks with physical conversion", async () => {
  const headings = ["SKU", "Name", "Package", "Total package content", "Purchase price"];
  for (const [content, base, total] of [["12 x 0.75 L", "l", 9], ["Box 6 x 70 cl", "ml", 4200], ["400 GR", "g", 400], ["1 kg", "g", 1000]]) {
    const profile = snapshot({ interpretation: { ...interpretation, header: headings, columns: { supplierSku: 0, supplierProductName: 1, purchaseUnit: 2, baseUnitsPerPurchaseUnit: 3, pricePerPurchaseUnit: 4 },
      defaults: { baseUnit: base, currency: "EUR", priceBasis: "net" }, decimalSeparator: "." } });
    const parsed = interpretSupplierSourceRows(await source(headings.join(";") + `\n001;Water;FL;${content};12\n`), profile, { importSettings: settings });
    assert.equal(parsed.rows[0].baseUnitsPerPurchaseUnit, total); assert.equal(parsed.rows[0].baseUnit, base); assert.deepEqual(parsed.rows[0].normalizationFindings, []);
  }
});
test("explicit currency, tax labels and VAT percentages normalize without floating-point fractions", async () => {
  const headings = ["SKU", "Name", "Package", "Content", "Unit price", "Currency", "Price basis", "VAT"];
  const profile = snapshot({ interpretation: { ...interpretation, header: headings, columns: { supplierSku: 0, supplierProductName: 1, purchaseUnit: 2, baseUnitsPerPurchaseUnit: 3,
    pricePerPurchaseUnit: 4, currency: 5, priceBasis: 6, vatRate: 7 }, defaults: { baseUnit: "l" }, decimalSeparator: "." } });
  const parsed = interpretSupplierSourceRows(await source(headings.join(";") + "\n001;Water;FL;0.75;2.4;eur;excl. BTW;5.6%\n"), profile, { importSettings: settings });
  assert.equal(parsed.rows[0].currency, "EUR"); assert.equal(parsed.rows[0].priceBasis, "net"); assert.equal(parsed.rows[0].vatRate, 0.056);
  assert.deepEqual(parsed.rows[0].normalizationFindings, []);
});
