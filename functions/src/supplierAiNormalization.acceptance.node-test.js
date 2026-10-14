const test = require("node:test");
const assert = require("node:assert/strict");
const ExcelJS = require("exceljs");
const { extractSupplierAiSource } = require("./supplierAiExtraction");
const proposal = require("./supplierAiProposal");
const productPolicy = require("./productPolicy");

const settings = { policyVersion: 2, currency: "EUR", priceBasis: "net", vatRate: null };
const empty = {
  supplierSku: "000001", supplierProductName: null, currency: null, pricingModel: null,
  purchaseUnit: null, baseUnit: null, priceBasis: null, gtin: null,
  priceValidFrom: null, priceValidUntil: null, pricePerBaseUnit: null,
  pricePerPurchaseUnit: null, baseUnitsPerPurchaseUnit: null, vatRate: null,
};

async function extracted(headers, values) {
  const workbook = new ExcelJS.Workbook(), sheet = workbook.addWorksheet("Offers");
  sheet.addRow(headers); sheet.addRow(values);
  const source = await extractSupplierAiSource({ bytes: Buffer.from(await workbook.xlsx.writeBuffer()),
    fileName: "independent-offers.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  return source.units.map((unit, index) => ({ ...unit, contextOnly: index === 0 }));
}

function normalized(sourceUnits, name, patch = {}) {
  const input = { ...empty, supplierProductName: name, ...patch,
    sourceAnchors: [{ sourceId: sourceUnits[1].sourceId, quote: name }] };
  const checked = proposal.validateRawSupplierAiRows({ rows: [input] }, { sourceUnits })[0];
  return require("./supplierAiNormalization").normalizeSupplierAiProposal(checked, { importSettings: settings, sourceUnits });
}

function candidate(raw, previous = null) {
  return proposal.buildSupplierAiCandidate({ hotelUid: "hotel-a", jobId: "independent", supplierId: "dairy",
    rowIndex: 0, raw, previous, productId: previous ? "existing-offer" : null });
}

test("a real XLSX Pack/GR proposal becomes a readable 400g inactive draft without inventing a price", async () => {
  const name = "MOZZARELLA PLAKKEN 400G";
  const source = await extracted(["SKU", "Description", "Purchase package", "Content unit", "Price per pack"],
    ["000001", name, "PK", "GR", null]);
  const raw = normalized(source, name, { purchaseUnit: "PK", baseUnit: "GR" });
  const row = candidate(raw);
  assert.equal(row.product.supplierProductName, "Mozzarella Plakken 400g");
  assert.equal(row.product.supplierSku, "000001");
  assert.equal(row.product.purchaseUnit, "Pack");
  assert.equal(row.product.baseUnit, "g");
  assert.equal(row.product.baseUnitsPerPurchaseUnit, 400);
  assert.equal(row.product.pricingModel, "Per Purchase Unit");
  assert.equal(row.product.currency, "EUR");
  assert.equal(row.product.active, false);
  assert.equal(row.product.pricePerPurchaseUnit, null);
  assert.equal(row.sourceAnchors[0].quote, name);
  assert.equal(row.sourceAnchors[0].verified, true);
  assert.ok(row.normalizationFindings.some((finding) => finding.provenance === "inference"));
  assert.throws(() => productPolicy.resolvePurchaseOption(row.product), /unknown price/i);
});

test("100 inferred 10g pieces remain one 1kg Box in the real purchasing and inventory contracts", async () => {
  const name = "ROCH. BOTER 10G";
  const source = await extracted(["SKU", "Description", "Purchase package", "Package content", "Content unit", "Net price per box", "Currency"],
    ["000001", name, "DS", 1, "KG", 8, "EUR"]);
  const raw = normalized(source, name, { purchaseUnit: "DS", baseUnit: "KG", baseUnitsPerPurchaseUnit: 1,
    pricingModel: "Per Purchase Unit", pricePerPurchaseUnit: 8, currency: "EUR", priceBasis: "net" });
  const row = candidate(raw);
  assert.equal(row.product.supplierProductName, "Rochefort Boter 10g");
  assert.equal(row.product.purchaseUnit, "Box");
  assert.equal(row.product.baseUnit, "kg");
  assert.equal(row.product.baseUnitsPerPurchaseUnit, 1);
  assert.equal(row.packInference.piecesPerPurchaseUnit, 100);
  assert.equal(row.packInference.pieceQuantity, 10);
  assert.equal(row.packInference.pieceUnit, "g");
  assert.deepEqual(row.product.purchaseOptions, []);
  const product = productPolicy.normalizeSupplierProduct({ ...row.product, catalogProductId: "butter" });
  const option = productPolicy.resolvePurchaseOption(product);
  const terms = productPolicy.inventoryTerms(product, { id: "butter", name: "Butter", baseUnit: "g", inventoryTracked: true, active: true }, option);
  assert.equal(terms.available, true);
  assert.equal(terms.catalogUnitsPerPurchaseUnit, 1000);
  assert.equal(terms.netUnitCost, 0.008);
  assert.equal(productPolicy.convertQuantity(10, "g", "kg") * row.packInference.piecesPerPurchaseUnit, 1);
  assert.equal(row.sourceAnchors[0].quote, name);
});

test("annual supplier spend is removed as an alleged unit price and cannot make an offer orderable", async () => {
  const name = "MOZZARELLA PLAKKEN 400G";
  const source = await extracted(["SKU", "Description", "Purchase package", "Content unit", "Annual quantity", "Annual spend EUR"],
    ["000001", name, "PK", "GR", 200, 1234]);
  const raw = normalized(source, name, { purchaseUnit: "PK", baseUnit: "GR", pricingModel: "Per Purchase Unit", pricePerPurchaseUnit: 1234 });
  const row = candidate(raw);
  assert.equal(row.product.pricePerPurchaseUnit, null);
  assert.equal(row.product.pricePerBaseUnit, null);
  assert.ok(row.normalizationFindings.some((finding) => finding.field === "pricePerPurchaseUnit"));
  assert.throws(() => productPolicy.resolvePurchaseOption(row.product), /unknown price/i);
});

test("an unpriced new source cannot relabel or resize an established price contract", async () => {
  const name = "ROCH. BOTER 10G";
  const source = await extracted(["SKU", "Description", "Package", "Content", "Unit", "Annual spend"],
    ["000001", name, "DS", 0.5, "KG", 1234]);
  const raw = normalized(source, name, { purchaseUnit: "DS", baseUnit: "KG", baseUnitsPerPurchaseUnit: 0.5 });
  const previous = productPolicy.normalizeSupplierProduct({ ...empty, supplierId: "dairy", supplierProductName: "Rochefort Boter 10g",
    currency: "USD", pricingModel: "Per Base Unit", purchaseUnit: "Case", baseUnit: "kg", baseUnitsPerPurchaseUnit: 1,
    pricePerBaseUnit: 12, priceBasis: "gross", vatRate: 0.21, active: false, catalogProductId: null, purchaseOptions: [] });
  const row = candidate(raw, previous);
  for (const field of ["currency", "pricingModel", "purchaseUnit", "baseUnitsPerPurchaseUnit", "pricePerBaseUnit", "pricePerPurchaseUnit", "priceBasis", "vatRate"]) {
    assert.equal(row.product[field], previous[field], `Unpriced import preserves ${field}`);
  }
  assert.equal(productPolicy.resolvePurchaseOption(row.product).netPricePerPurchaseUnit,
    productPolicy.resolvePurchaseOption(previous).netPricePerPurchaseUnit);
});

test("a base price explicitly per kg is reconciled with g inventory content rather than multiplied a thousandfold", async () => {
  const name = "MOZZARELLA PLAKKEN 400G";
  const source = await extracted(["SKU", "Description", "Package", "Package content", "Content unit", "Net price per kg", "Currency"],
    ["000001", name, "PK", 400, "GR", 12, "EUR"]);
  const row = candidate(normalized(source, name, { purchaseUnit: "PK", baseUnit: "GR", baseUnitsPerPurchaseUnit: 400,
    pricingModel: "Per Base Unit", pricePerBaseUnit: 12, currency: "EUR", priceBasis: "net" }));
  assert.equal(row.product.baseUnit, "g");
  assert.equal(row.product.pricePerBaseUnit, 0.012);
  assert.equal(row.product.pricePerPurchaseUnit, 4.8);
  assert.equal(productPolicy.resolvePurchaseOption(row.product).netPricePerPurchaseUnit, 4.8);
});

test("inner piece weights and annual quantities cannot prove the full purchasable Box content", async () => {
  const name = "ROCH. BOTER 10G";
  const source = await extracted(["SKU", "Description", "Package", "Package content", "Content unit", "Net price per box"],
    ["000001", name, "DS", 1, "KG", 8]);
  const row = candidate(normalized(source, name, { purchaseUnit: "DS", baseUnit: "g", baseUnitsPerPurchaseUnit: 10,
    pricingModel: "Per Purchase Unit", pricePerPurchaseUnit: 8, priceBasis: "net" }));
  if (row.product.baseUnitsPerPurchaseUnit === null) assert.equal(row.category, "blocked");
  else assert.equal(productPolicy.convertQuantity(row.product.baseUnitsPerPurchaseUnit, row.product.baseUnit, "g"), 1000);
  const annual = await extracted(["SKU", "Description", "Package", "Annual quantity", "Quantity unit"],
    ["000001", name, "DS", 200, "KG"]);
  const unknown = candidate(normalized(annual, name, { purchaseUnit: "DS", baseUnit: "KG", baseUnitsPerPurchaseUnit: 200 }));
  assert.equal(unknown.product.baseUnitsPerPurchaseUnit, null);
  assert.equal(unknown.category, "blocked");
});
