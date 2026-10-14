const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeSupplierAiProposal, normalizeSupplierAiProposals, applyPurchaseUnitMappingToProposal } = require("./supplierAiNormalization");
const { validateRawSupplierAiRows, buildSupplierAiCandidate } = require("./supplierAiProposal");
const policy = require("./productPolicy");
const settings = { policyVersion: 2, currency: "EUR", priceBasis: "net", vatRate: null };
function fixture(patch = {}, columns = {}) {
  const raw = { supplierSku: "00081-A", supplierProductName: "MOZZARELLA PLAKKEN400G", currency: null, pricingModel: null,
    pricePerBaseUnit: null, pricePerPurchaseUnit: null, purchaseUnit: "PK", baseUnit: "GR", baseUnitsPerPurchaseUnit: null,
    priceBasis: null, vatRate: null, gtin: "6291041500213", priceValidFrom: null, priceValidUntil: null,
    sourceAnchors: [{ sourceId: "xlsx-sheet-1-row-2", quote: "00081-A" }], ...patch };
  const headers = ["SKU", "Name", "Package", "Content", columns.priceHeader ?? "Unit price", "Annual amount", "Annual quantity"];
  const values = [raw.supplierSku, raw.supplierProductName, raw.purchaseUnit, columns.content ?? "400 GR", columns.price ?? "", columns.amount ?? "", columns.quantity ?? ""];
  const sourceUnits = [{ sourceId: "xlsx-sheet-1-row-1", anchor: "Worksheet 1, row 1 (possible header)", contextOnly: true, text: JSON.stringify(headers) },
    { sourceId: "xlsx-sheet-1-row-2", anchor: "Worksheet 1, row 2", text: JSON.stringify(values) }];
  return { raw, sourceUnits, checked: validateRawSupplierAiRows({ rows: [raw] }, { sourceUnits })[0] };
}
const normalize = (data, context = settings) => normalizeSupplierAiProposal(data.checked, { importSettings: context, sourceUnits: data.sourceUnits });
const candidate = (raw, extra = {}) => buildSupplierAiCandidate({ hotelUid: "hotel", jobId: "job", supplierId: "supplier", rowIndex: 0, raw, ...extra });
const codes = (row) => row.normalizationFindings.map((entry) => entry.code);
const mappingSnapshot = (mappings = [], revision = mappings.length ? 1 : 0) => ({ version: 1, supplierId: "supplier", sourceFormat: "xlsx", profileId: "default", revision, mappings });
const normalizeMapped = (data, snapshot = mappingSnapshot()) => normalizeSupplierAiProposal(data.checked,
  { importSettings: settings, sourceUnits: data.sourceUnits, purchaseUnitMappingSnapshot: snapshot });

async function splitExport({ count = 1, purchase = "BK", content = 500, unit = "GR", raw = {}, duplicate = false, csv = false } = {}) {
  const ExcelJS = require("exceljs"), { extractSupplierAiSource } = require("./supplierAiExtraction");
  const name = "FICTIONAL SUPPLIER ITEM";
  const headers = ["Artikelnummer", "Artikel omschrijving", "\n Inhoud verpakking \n", "\n Eenheid verpakking \n", "Inhoud", "\n Eenheid \n", "Aantal", "Inkoopwaarde"];
  const values = ["00081-A", name, count, purchase, content, unit, 100, 1200];
  if (duplicate) { headers.push("Purchase unit"); values.push("TR"); }
  const workbook = new ExcelJS.Workbook(); workbook.addWorksheet("Volumes").addRows([headers, values]);
  const bytes = csv ? Buffer.from(headers.map((value) => JSON.stringify(value.replace(/\s+/g, " ").trim())).join(",") + "\n" + values.map((value) => value === null ? "" : value).join(",")) : Buffer.from(await workbook.xlsx.writeBuffer());
  const source = await extractSupplierAiSource({ fileName: csv ? "fictional.csv" : "fictional.xlsx", mimeType: csv ? "text/csv" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", bytes });
  const sourceUnits = source.units.map((value, index) => ({ ...value, contextOnly: index === 0 }));
  const proposal = { ...fixture().raw, supplierProductName: name, purchaseUnit: unit, baseUnit: null, baseUnitsPerPurchaseUnit: 1,
    sourceAnchors: [{ sourceId: sourceUnits[1].sourceId, quote: name }], ...raw };
  return { raw: proposal, sourceUnits, checked: validateRawSupplierAiRows({ rows: [proposal] }, { sourceUnits })[0] };
}
test("real XLSX and CSV split exports map Eenheid verpakking and retain physical content independently", async () => {
  for (const csv of [false, true]) {
    const data = await splitExport({ csv });
    const normalized = normalizeMapped(data, mappingSnapshot([{ sourceUnit: "BK", purchaseUnit: "Box" }, { sourceUnit: "GR", purchaseUnit: "Jar" }]));
    assert.equal(normalized.purchaseUnit, "Box"); assert.equal(normalized.purchaseUnitMapping.sourceUnit, "BK");
    assert.equal(normalized.baseUnit, "g"); assert.equal(normalized.baseUnitsPerPurchaseUnit, 500);
    assert.equal(normalized.originalInput.purchaseUnit, "GR"); assert.deepEqual(normalized.sourceAnchors, data.checked.sourceAnchors);
    assert.equal(normalized.pricePerPurchaseUnit, null); assert.equal(normalized.pricePerBaseUnit, null);
    const pending = normalizeMapped(data);
    assert.equal(pending.purchaseUnit, "BK"); assert.equal(pending.purchaseUnitMapping.suggestedUnit, "Box");
    assert.equal(pending.purchaseUnitMapping.status, "unconfirmed"); assert.equal(candidate(pending).category, "blocked");
  }
});
test("split exports multiply inner packages by their content instead of substituting one inner item", async () => {
  for (const [count, purchase, content, unit, label, base, total] of [[12, "PK", 1, "LT", "Pack", "l", 12], [2, "ZK", 5, "KG", "Bag", "kg", 10], [6, "FL", 2, "CL", "Bottle", "ml", 120]]) {
    const row = normalizeMapped(await splitExport({ count, purchase, content, unit }), mappingSnapshot([{ sourceUnit: purchase, purchaseUnit: label }]));
    assert.equal(row.purchaseUnit, label); assert.equal(row.baseUnit, base); assert.equal(row.baseUnitsPerPurchaseUnit, total);
    assert.equal(row.pricePerPurchaseUnit, null); assert.equal(row.pricePerBaseUnit, null);
  }
});
test("a blank explicit package column never falls back to physical Eenheid or a provider guess", async () => {
  const row = normalizeMapped(await splitExport({ purchase: null, unit: "ST", raw: { purchaseUnit: "TR" } }), mappingSnapshot([{ sourceUnit: "ST", purchaseUnit: "Piece" }, { sourceUnit: "TR", purchaseUnit: "Tray" }]));
  assert.equal(row.purchaseUnit, null); assert.equal(row.purchaseUnitMapping.sourceUnit, null);
  assert.equal(row.purchaseUnitMapping.status, "unconfirmed"); assert.equal(row.baseUnitsPerPurchaseUnit, null);
  assert.equal(candidate(row).category, "blocked");
  assert.throws(() => applyPurchaseUnitMappingToProposal(row, { sourceUnit: "ST", purchaseUnit: "Piece" }), { code: "failed-precondition" });
});
test("conflicting explicit package columns cannot be approved through a physical-unit mapping", async () => {
  const row = normalizeMapped(await splitExport({ duplicate: true }), mappingSnapshot([{ sourceUnit: "BK", purchaseUnit: "Box" }, { sourceUnit: "TR", purchaseUnit: "Tray" }, { sourceUnit: "GR", purchaseUnit: "Bottle" }]));
  assert.equal(row.purchaseUnitMapping.sourceUnit, null); assert.equal(row.purchaseUnitMapping.status, "unconfirmed");
  assert.equal(candidate(row).category, "blocked");
});
test("weight purchase units and missing inner quantities remain unavailable rather than becoming item counts", async () => {
  for (const fields of [{ purchase: "KG", unit: "ST", content: 1 }, { purchase: "PK", content: null }, { purchase: "PK", count: null }]) {
    const row = normalizeMapped(await splitExport(fields), mappingSnapshot([{ sourceUnit: fields.purchase, purchaseUnit: "Pack" }]));
    assert.equal(row.baseUnitsPerPurchaseUnit, null); assert.ok(codes(row).includes("split-package-content-unavailable"));
    assert.equal(candidate(row).category, "blocked");
  }
});
test("unit-price channel uses the explicit package column even when bare Eenheid has a saved rule", () => {
  const data = fixture({ purchaseUnit: "GR", baseUnit: "g", pricePerPurchaseUnit: 15 }, { content: "500 GR" });
  data.sourceUnits[0].text = JSON.stringify(["SKU", "Name", "Eenheid verpakking", "Package content", "Unit price", "Eenheid"]);
  data.sourceUnits[1].text = JSON.stringify([data.raw.supplierSku, data.raw.supplierProductName, "BK", "500 GR", 15, "GR"]);
  data.checked = validateRawSupplierAiRows({ rows: [data.raw] }, { sourceUnits: data.sourceUnits })[0];
  const row = normalizeMapped(data, mappingSnapshot([{ sourceUnit: "BK", purchaseUnit: "Box" }, { sourceUnit: "GR", purchaseUnit: "Jar" }]));
  assert.equal(row.purchaseUnit, "Box"); assert.equal(row.pricePerPurchaseUnit, 15); assert.equal(row.pricingModel, "Per Purchase Unit");
  assert.equal(codes(row).includes("price-purchase-label-conflict"), false);
});

test("confirmed Sligro source mappings produce canonical English packages without changing physical contents", () => {
  for (const [sourceUnit, purchaseUnit] of Object.entries({ FL: "Bottle", ZK: "Bag", EM: "Bucket", BK: "Box", TR: "Tray", PT: "Jar", ST: "Piece", DS: "Box", PK: "Pack" })) {
    const normalized = normalizeMapped(fixture({ purchaseUnit: sourceUnit, baseUnit: "KG", baseUnitsPerPurchaseUnit: 1 }, { content: "1 KG" }), mappingSnapshot([{ sourceUnit, purchaseUnit }]));
    assert.equal(normalized.purchaseUnit, purchaseUnit); assert.equal(normalized.baseUnit, "kg"); assert.equal(normalized.baseUnitsPerPurchaseUnit, 1);
    assert.equal(normalized.purchaseUnitMapping.sourceUnit, sourceUnit); assert.equal(normalized.purchaseUnitMapping.status, "confirmed");
    assert.equal(normalized.originalInput.purchaseUnit, sourceUnit); assert.equal(codes(normalized).includes("purchase-unit-unconfirmed"), false);
  }
});
test("supplier profile overrides common aliases while unknown abbreviations require explicit review", () => {
  const overridden = normalizeMapped(fixture({ purchaseUnit: "FL" }, { content: "400 GR" }), mappingSnapshot([{ sourceUnit: "FL", purchaseUnit: "Jar" }]));
  assert.equal(overridden.purchaseUnit, "Jar"); assert.equal(overridden.purchaseUnitMapping.suggestedUnit, "Jar");
  for (const [code, suggested] of [["TR", "Tray"], ["ZZ", null], ["FL", "Bottle"]]) {
    const normalized = normalizeMapped(fixture({ purchaseUnit: code }));
    assert.equal(normalized.purchaseUnitMapping.status, "unconfirmed"); assert.equal(normalized.purchaseUnitMapping.suggestedUnit, suggested);
    assert.equal(normalized.purchaseUnit, code); assert.equal(candidate(normalized).category, "blocked");
    assert.ok(codes(normalized).includes("purchase-unit-unconfirmed"));
  }
});
test("verified source purchase-unit cells take precedence over a model's unconfirmed expanded label", () => {
  const data = fixture({ purchaseUnit: "Bottle" });
  data.sourceUnits[1].text = data.sourceUnits[1].text.replace('"Bottle"', '"FL"');
  data.checked = validateRawSupplierAiRows({ rows: [data.raw] }, { sourceUnits: data.sourceUnits })[0];
  const unconfirmed = normalizeMapped(data);
  assert.equal(unconfirmed.purchaseUnitMapping.sourceUnit, "FL"); assert.equal(unconfirmed.purchaseUnitMapping.status, "unconfirmed");
  const confirmed = normalizeMapped(data, mappingSnapshot([{ sourceUnit: "FL", purchaseUnit: "Jar" }]));
  assert.equal(confirmed.purchaseUnit, "Jar"); assert.equal(confirmed.purchaseUnitMapping.status, "confirmed");
});
test("real CSV and XLSX source Eenheid recover confirmed FL mappings even when the model purchase unit is null", async () => {
  const ExcelJS = require("exceljs"), { extractSupplierAiSource } = require("./supplierAiExtraction");
  const name = "MILK 1L", headers = ["SKU", "Name", "Eenheid", "Package content", "Content unit"], values = ["00081-A", name, "FL", "1 L", "L"];
  const workbook = new ExcelJS.Workbook(), sheet = workbook.addWorksheet("Volumes"); sheet.addRow(headers); sheet.addRow(values);
  for (const [fileName, bytes] of [["volumes.csv", Buffer.from(headers.join(",") + "\n" + values.join(",") + "\n")],
    ["volumes.xlsx", Buffer.from(await workbook.xlsx.writeBuffer())]]) {
    const extracted = await extractSupplierAiSource({ fileName, bytes, mimeType: fileName.endsWith("csv") ? "text/csv" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const sourceUnits = extracted.units.map((unit, index) => ({ ...unit, contextOnly: index === 0 }));
    const raw = { ...fixture({ supplierProductName: name, purchaseUnit: null, baseUnit: "L" }).raw,
      sourceAnchors: [{ sourceId: sourceUnits[1].sourceId, quote: name }] };
    const checked = validateRawSupplierAiRows({ rows: [raw] }, { sourceUnits })[0];
    const normalized = normalizeSupplierAiProposal(checked, { importSettings: settings, sourceUnits,
      purchaseUnitMappingSnapshot: mappingSnapshot([{ sourceUnit: "FL", purchaseUnit: "Bottle" }]) });
    assert.equal(normalized.purchaseUnit, "Bottle", fileName); assert.equal(normalized.purchaseUnitMapping.sourceUnit, "FL");
    assert.equal(normalized.purchaseUnitMapping.status, "confirmed"); assert.equal(normalized.baseUnit, "l"); assert.equal(normalized.baseUnitsPerPurchaseUnit, 1);
    assert.equal(normalized.originalInput.purchaseUnit, null); assert.equal(candidate(normalized).category, "new");
    const unmapped = normalizeSupplierAiProposal(checked, { importSettings: settings, sourceUnits, purchaseUnitMappingSnapshot: mappingSnapshot() });
    assert.equal(unmapped.purchaseUnitMapping.sourceUnit, "FL"); assert.equal(unmapped.purchaseUnitMapping.status, "unconfirmed"); assert.equal(candidate(unmapped).category, "blocked");
  }
});
test("physical-unit columns cannot establish a purchase unit and contradictory purchase-unit headers remain blocked", () => {
  const data = fixture({ purchaseUnit: null, baseUnit: "KG" }, { content: "1 KG" });
  data.sourceUnits[0].text = JSON.stringify(["SKU", "Name", "Content unit", "Content", "Unit", "Annual amount", "Annual quantity"]);
  const cells = JSON.parse(data.sourceUnits[1].text); cells[2] = "FL"; cells[4] = "FL"; data.sourceUnits[1].text = JSON.stringify(cells);
  data.checked = validateRawSupplierAiRows({ rows: [data.raw] }, { sourceUnits: data.sourceUnits })[0];
  const physical = normalizeMapped(data, mappingSnapshot([{ sourceUnit: "FL", purchaseUnit: "Bottle" }]));
  assert.equal(physical.purchaseUnit, null); assert.equal(physical.purchaseUnitMapping.sourceUnit, null); assert.equal(physical.purchaseUnitMapping.status, "unconfirmed");
  const ambiguous = fixture({ purchaseUnit: null });
  const header = JSON.parse(ambiguous.sourceUnits[0].text), values = JSON.parse(ambiguous.sourceUnits[1].text);
  header[2] = "Purchase unit"; values[2] = "FL"; header[4] = "Package"; values[4] = "TR";
  ambiguous.sourceUnits[0].text = JSON.stringify(header); ambiguous.sourceUnits[1].text = JSON.stringify(values);
  ambiguous.checked = validateRawSupplierAiRows({ rows: [ambiguous.raw] }, { sourceUnits: ambiguous.sourceUnits })[0];
  const blocked = normalizeMapped(ambiguous, mappingSnapshot([{ sourceUnit: "FL", purchaseUnit: "Bottle" }, { sourceUnit: "TR", purchaseUnit: "Tray" }]));
  assert.equal(blocked.purchaseUnitMapping.status, "unconfirmed"); assert.equal(blocked.purchaseUnit, null); assert.equal(candidate(blocked).category, "blocked");
});
test("explicit one-import mapping changes only its label and findings and preserves prices, physical contents and other human metadata", () => {
  const normalized = normalizeMapped(fixture({ purchaseUnit: "TR", pricePerPurchaseUnit: 12 }, { price: 12, priceHeader: "Purchase price", content: "400 GR" }));
  const original = structuredClone(normalized), extra = { ...normalized, humanNote: "Preserve my reviewed product", customReview: { approvedName: true } };
  const confirmed = applyPurchaseUnitMappingToProposal(extra, { sourceUnit: "TR", purchaseUnit: "Tray" });
  assert.equal(confirmed.purchaseUnit, "Tray"); assert.equal(confirmed.purchaseUnitMapping.status, "confirmed");
  for (const field of ["pricePerPurchaseUnit", "pricePerBaseUnit", "pricingModel", "currency", "priceBasis", "vatRate", "baseUnit", "baseUnitsPerPurchaseUnit", "originalInput", "sourceAnchors", "customReview", "humanNote"]) {
    assert.deepEqual(confirmed[field], extra[field], field);
  }
  assert.deepEqual(normalized, original); assert.equal(codes(confirmed).includes("purchase-unit-unconfirmed"), false);
  assert.ok(codes(confirmed).includes("purchase-unit-confirmed-for-import"));
  assert.throws(() => applyPurchaseUnitMappingToProposal(extra, { sourceUnit: "FL", purchaseUnit: "Bottle" }), { code: "failed-precondition" });
  assert.throws(() => applyPurchaseUnitMappingToProposal(extra, { sourceUnit: "TR", purchaseUnit: "Box", snapshot: mappingSnapshot([{ sourceUnit: "TR", purchaseUnit: "Tray" }]) }), { code: "aborted" });
});
test("an explicit source purchase-unit price stays available behind mapping review and survives human confirmation", () => {
  for (const sourceUnit of ["FL", "ZK", "EM", "TR"]) {
    const data = fixture({ purchaseUnit: sourceUnit, pricePerPurchaseUnit: 12 }, { price: 12, priceHeader: "Unit price", content: "400 GR" });
    const normalized = normalizeMapped(data);
    assert.equal(normalized.pricePerPurchaseUnit, 12); assert.equal(normalized.pricingModel, "Per Purchase Unit");
    assert.equal(candidate(normalized).category, "blocked");
    assert.equal(codes(normalized).includes("price-purchase-label-conflict"), false);
    const label = { FL: "Bottle", ZK: "Bag", EM: "Bucket", TR: "Tray" }[sourceUnit];
    const reviewed = applyPurchaseUnitMappingToProposal(normalized, { sourceUnit, purchaseUnit: label });
    assert.equal(reviewed.pricePerPurchaseUnit, 12); assert.equal(candidate(reviewed).category, "new");
  }
});
test("explicit prices per canonical Bucket, Tray and all supported English packages retain the purchase-price contract", () => {
  for (const purchaseUnit of require("./supplierImportMappings").PURCHASE_UNITS) {
    const normalized = normalizeMapped(fixture({ purchaseUnit, pricePerPurchaseUnit: 6 }, { price: 6, priceHeader: `Net price per ${purchaseUnit}`, content: "400 GR" }));
    assert.equal(normalized.pricePerPurchaseUnit, 6, purchaseUnit); assert.equal(normalized.pricingModel, "Per Purchase Unit");
    assert.equal(normalized.baseUnitsPerPurchaseUnit, 400); assert.equal(normalized.purchaseUnitMapping.status, "known");
    assert.equal(candidate(normalized).category, "new", purchaseUnit);
  }
});
test("a supplier package-code mapping cannot redefine an explicit per-kilogram price as a per-Box price", () => {
  const normalized = normalizeMapped(fixture({ purchaseUnit: "KG", baseUnit: "GR", pricePerPurchaseUnit: 12 },
    { price: 12, priceHeader: "Net price per kg", content: "400 GR" }), mappingSnapshot([{ sourceUnit: "KG", purchaseUnit: "Box" }]));
  assert.equal(normalized.purchaseUnit, "Box"); assert.equal(normalized.baseUnit, "g");
  assert.equal(normalized.pricingModel, "Per Base Unit"); assert.equal(normalized.pricePerBaseUnit, 0.012); assert.equal(normalized.pricePerPurchaseUnit, null);
  assert.equal(candidate(normalized).product.pricePerPurchaseUnit, 4.8);
});

test("uppercase display names, canonical GR, English PK and explicit import context create an unpriced inactive draft", () => {
  const data = fixture(), normalized = normalize(data), proposed = candidate(normalized);
  assert.equal(normalized.supplierProductName, "Mozzarella Plakken400g"); assert.equal(normalized.baseUnit, "g");
  assert.equal(normalized.purchaseUnit, "Pack"); assert.equal(normalized.baseUnitsPerPurchaseUnit, 400);
  assert.equal(normalized.currency, "EUR"); assert.equal(normalized.priceBasis, "net"); assert.equal(normalized.pricingModel, "Per Purchase Unit");
  assert.equal(normalized.pricePerPurchaseUnit, null); assert.equal(normalized.pricePerBaseUnit, null);
  assert.equal(proposed.product.active, false); assert.equal(proposed.category, "new");
  assert.ok(codes(normalized).includes("inactive-draft-price-model")); assert.ok(codes(normalized).includes("source-price-missing"));
  assert.equal(normalized.originalInput.supplierProductName, "MOZZARELLA PLAKKEN400G");
  assert.equal(normalized.supplierSku, "00081-A"); assert.equal(normalized.gtin, "6291041500213");
  assert.deepEqual(normalized.sourceAnchors, data.checked.sourceAnchors); assert.deepEqual(data.raw.supplierProductName, "MOZZARELLA PLAKKEN400G");
  assert.throws(() => policy.resolvePurchaseOption(proposed.product), /unknown price/);
});

test("DS1kg and a named10g piece infer100pieces as metadata while preserving one kilogram of inventory", () => {
  for (const supplierProductName of ["ROCH.BOTER 10G", "ROCH. BOTER 10G", "ROCH.BOTER10GR"]) {
    const normalized = normalize(fixture({ supplierProductName, purchaseUnit: "DS1KG", baseUnit: "KG", baseUnitsPerPurchaseUnit: 1 }, { content: "1 KG" }));
    assert.equal(normalized.supplierProductName, "Rochefort Boter 10g"); assert.equal(normalized.purchaseUnit, "Box");
    assert.equal(normalized.baseUnit, "kg"); assert.equal(normalized.baseUnitsPerPurchaseUnit, 1);
    assert.deepEqual(normalized.packInference, { piecesPerPurchaseUnit: 100, pieceQuantity: 10, pieceUnit: "g", provenance: "source-name" });
    assert.ok(codes(normalized).includes("approved-name-expansion")); assert.ok(codes(normalized).includes("piece-count-inferred"));
    const product = candidate(normalized).product; assert.deepEqual(product.purchaseOptions, []);
    const terms = policy.inventoryTerms({ ...product, catalogProductId: "butter" }, { id: "butter", name: "Butter", baseUnit: "g", active: true, inventoryTracked: true },
      { baseUnit: product.baseUnit, baseUnitsPerPurchaseUnit: product.baseUnitsPerPurchaseUnit, netPricePerPurchaseUnit: null, currency: "EUR" });
    assert.equal(terms.catalogUnitsPerPurchaseUnit, 1000); assert.equal(terms.netUnitCost, null);
  }
});

test("Box content cannot be invented from an inner400g name, ambiguous multipacks, or unknown physical units", () => {
  const box = normalize(fixture({ purchaseUnit: "DS", baseUnitsPerPurchaseUnit: null }, { content: "" }));
  assert.equal(box.baseUnitsPerPurchaseUnit, null); assert.equal(candidate(box).category, "blocked"); assert.equal(box.packInference, null);
  const multi = normalize(fixture({ supplierProductName: "MILK 6x1L", purchaseUnit: "PK", baseUnit: "L", baseUnitsPerPurchaseUnit: null }, { content: "" }));
  assert.equal(multi.baseUnitsPerPurchaseUnit, null); assert.equal(candidate(multi).category, "blocked");
  const unknown = normalize(fixture({ baseUnit: "unknown", baseUnitsPerPurchaseUnit: null }));
  assert.equal(unknown.baseUnit, "unknown"); assert.equal(candidate(unknown).category, "blocked");
  const conflict = normalize(fixture({ supplierProductName: "JUICE 400ML", baseUnit: "KG" }, { content: "400 ML" }));
  assert.equal(conflict.baseUnit, "kg"); assert.equal(conflict.baseUnitsPerPurchaseUnit, null);
  assert.ok(codes(conflict).includes("package-dimension-conflict"));
});

test("nonintegral and ambiguous named pieces remain unavailable rather than rounded or made purchasable", () => {
  const odd = normalize(fixture({ supplierProductName: "BUTTER 9G", purchaseUnit: "DS", baseUnit: "KG", baseUnitsPerPurchaseUnit: 1 }, { content: "1KG" }));
  assert.equal(odd.packInference, null); assert.ok(codes(odd).includes("piece-count-not-integral"));
  const ambiguous = normalize(fixture({ supplierProductName: "BUTTER 10G 20G", purchaseUnit: "DS", baseUnit: "KG", baseUnitsPerPurchaseUnit: 1 }, { content: "1KG" }));
  assert.equal(ambiguous.packInference, null); assert.ok(codes(ambiguous).includes("ambiguous-piece-content"));
  assert.deepEqual(candidate(odd).product.purchaseOptions, []);
});

test("mixed-case brands and exact SKU/GTIN survive display normalization while only approved butter abbreviation expands", () => {
  const normalized = normalize(fixture({ supplierProductName: "iQ McCain FRITES400GR", supplierSku: "mC-0001", gtin: "00012345678905" }));
  assert.equal(normalized.supplierProductName, "iQ McCain Frites400g"); assert.equal(normalized.supplierSku, "mC-0001"); assert.equal(normalized.gtin, "00012345678905");
  assert.equal(normalize(fixture({ supplierProductName: "ROCH. KAAS400G" })).supplierProductName, "Roch. Kaas400g");
});

test("explicit supplier unit-price cells establish channels; annual spend, quantities and unsupported zeros stay unknown", () => {
  const priced = normalize(fixture({ pricePerPurchaseUnit: 12, currency: "eur", baseUnitsPerPurchaseUnit: 400 }, { price: "12,00 EUR" }));
  assert.equal(priced.pricePerPurchaseUnit, 12); assert.equal(priced.pricingModel, "Per Purchase Unit"); assert.ok(codes(priced).includes("source-unit-price"));
  const base = normalize(fixture({ pricePerBaseUnit: 0.03 }, { price: "0,03", priceHeader: "Price per g" }));
  assert.equal(base.pricingModel, "Per Base Unit"); assert.equal(base.pricePerBaseUnit, 0.03);
  const statistics = normalize(fixture({ pricePerPurchaseUnit: 1200 }, { amount: 1200, quantity: 100 }));
  assert.equal(statistics.pricePerPurchaseUnit, null); assert.ok(codes(statistics).includes("statistical-amount-not-price"));
  const zero = normalize(fixture({ pricePerPurchaseUnit: 0 }, { amount: 0 }));
  assert.equal(zero.pricePerPurchaseUnit, null);
  const explicitZero = normalize(fixture({ pricePerPurchaseUnit: 0 }, { price: 0 })); assert.equal(explicitZero.pricePerPurchaseUnit, 0);
});
test("explicit per-kilogram prices preserve value when model confuses base grams with purchase-package pricing", () => {
  for (const priceFields of [{ pricePerBaseUnit: 12, pricingModel: "Per Base Unit" }, { pricePerPurchaseUnit: 12, pricingModel: "Per Purchase Unit" }]) {
    const normalized = normalize(fixture({ ...priceFields, baseUnit: "GR", baseUnitsPerPurchaseUnit: 400 }, { price: 12, priceHeader: "Unit price per kg" }));
    const proposed = candidate(normalized);
    assert.equal(normalized.baseUnit, "g"); assert.equal(normalized.pricePerBaseUnit, 0.012); assert.equal(normalized.pricePerPurchaseUnit, null);
    assert.equal(normalized.pricingModel, "Per Base Unit"); assert.equal(proposed.product.pricePerPurchaseUnit, 4.8);
    assert.equal(proposed.category, "new");
  }
  const fine = normalize(fixture({ pricePerBaseUnit: 0.012 }, { price: "0,012", priceHeader: "Price per g" }));
  assert.equal(fine.pricePerBaseUnit, 0.012); assert.equal(candidate(fine).product.pricePerPurchaseUnit, 4.8);
  for (const alreadyConverted of [{ pricePerBaseUnit: 0.012 }, { pricePerPurchaseUnit: 4.8 }]) {
    const normalized = normalize(fixture(alreadyConverted, { price: 12, priceHeader: "Price per kg" }));
    assert.equal(normalized.pricePerBaseUnit, 0.012); assert.equal(candidate(normalized).product.pricePerPurchaseUnit, 4.8);
  }
});
test("full package content takes precedence over named inner weight and annual quantities cannot establish Box contents", () => {
  const explicit = normalize(fixture({ supplierProductName: "BUTTER10G", purchaseUnit: "DS", baseUnit: "GR", baseUnitsPerPurchaseUnit: 10 }, { content: "1 KG" }));
  assert.equal(explicit.baseUnit, "g"); assert.equal(explicit.baseUnitsPerPurchaseUnit, 1000); assert.equal(explicit.packInference.piecesPerPurchaseUnit, 100);
  const misleading = fixture({ supplierProductName: "BUTTER10G", purchaseUnit: "DS", baseUnit: "KG", baseUnitsPerPurchaseUnit: 200 }, { content: "", quantity: 200 });
  const labels = JSON.parse(misleading.sourceUnits[0].text); labels.push("Unit"); misleading.sourceUnits[0].text = JSON.stringify(labels);
  const cells = JSON.parse(misleading.sourceUnits[1].text); cells.push("KG"); misleading.sourceUnits[1].text = JSON.stringify(cells);
  const blocked = normalize(misleading); assert.equal(blocked.baseUnitsPerPurchaseUnit, null); assert.equal(candidate(blocked).category, "blocked");
  const annualPrice = normalize(fixture({ pricePerPurchaseUnit: 12 }, { price: 12, priceHeader: "Annual average price" }));
  assert.equal(annualPrice.pricePerPurchaseUnit, null);
});
test("bare Price lacks a channel, while explicit purchase prices and contextual Unit price remain reviewable", () => {
  for (const priceHeader of ["Price", "Net price"]) {
    const row = normalize(fixture({ pricePerPurchaseUnit: 12 }, { price: 12, priceHeader }));
    assert.equal(row.pricePerPurchaseUnit, null); assert.ok(codes(row).includes("source-price-channel-unknown"));
    assert.throws(() => policy.resolvePurchaseOption(candidate(row).product), /unknown price/);
  }
  const explicit = normalize(fixture({ pricePerPurchaseUnit: 12 }, { price: 12, priceHeader: "Purchase price" }));
  assert.equal(explicit.pricePerPurchaseUnit, 12);
  const contextual = normalize(fixture({ pricePerPurchaseUnit: 12 }, { price: 12 }));
  assert.equal(contextual.pricePerPurchaseUnit, 12); assert.ok(codes(contextual).includes("purchase-price-channel-inferred"));
  const missingPackage = fixture({ pricePerPurchaseUnit: 12 }, { price: 12 });
  const headers = JSON.parse(missingPackage.sourceUnits[0].text); headers[2] = "Comment"; missingPackage.sourceUnits[0].text = JSON.stringify(headers);
  assert.equal(normalize(missingPackage).pricePerPurchaseUnit, null);
});
test("count dimensions need full package evidence; a single ST is one each, while annual Box quantities are unknown", () => {
  const annual = normalize(fixture({ supplierProductName: "NAPKINS", purchaseUnit: "DS", baseUnit: "ST", baseUnitsPerPurchaseUnit: 200 }, { content: "", quantity: 200 }));
  assert.equal(annual.baseUnit, "each"); assert.equal(annual.baseUnitsPerPurchaseUnit, null); assert.equal(candidate(annual).category, "blocked");
  const counted = normalize(fixture({ supplierProductName: "NAPKINS", purchaseUnit: "DS", baseUnit: "ST", baseUnitsPerPurchaseUnit: null }, { content: "100ST" }));
  assert.equal(counted.baseUnit, "each"); assert.equal(counted.baseUnitsPerPurchaseUnit, 100); assert.equal(candidate(counted).category, "new");
  const single = normalize(fixture({ supplierProductName: "NAPKIN", purchaseUnit: "ST", baseUnit: "ST", baseUnitsPerPurchaseUnit: null }, { content: "" }));
  assert.equal(single.purchaseUnit, "Piece"); assert.equal(single.baseUnitsPerPurchaseUnit, 1); assert.ok(codes(single).includes("single-piece-content-inferred"));
});
test("explicit multipack content is multiplied exactly instead of treating its inner quantity as the entire Box", () => {
  const milk = normalize(fixture({ supplierProductName: "MILK 1L", purchaseUnit: "DS", baseUnit: "L", baseUnitsPerPurchaseUnit: 6 }, { content: "6x1L" }));
  assert.equal(milk.baseUnitsPerPurchaseUnit, 6); assert.equal(candidate(milk).category, "new");
  const butter = normalize(fixture({ supplierProductName: "BUTTER10G", purchaseUnit: "DS", baseUnit: "KG", baseUnitsPerPurchaseUnit: 1 }, { content: "100x10g" }));
  assert.equal(butter.baseUnitsPerPurchaseUnit, 1); assert.equal(butter.packInference.piecesPerPurchaseUnit, 100);
});

test("currency and basis conflicts block until explicit field correction; source VAT wins over an optional fallback", () => {
  const normalized = normalize(fixture({ currency: "USD", priceBasis: "gross", vatRate: 0.06 }), { ...settings, vatRate: 0.21 });
  assert.equal(normalized.currency, "USD"); assert.equal(normalized.priceBasis, "gross"); assert.equal(normalized.vatRate, 0.06);
  assert.equal(candidate(normalized).category, "blocked"); assert.ok(codes(normalized).includes("source-vat-retained"));
  assert.equal(candidate(normalized, { userPatch: { currency: "USD", priceBasis: "gross" } }).category, "new");
  assert.ok(normalized.normalizationFindings.some((entry) => entry.code === "currency-context-conflict" && entry.severity === "error"));
  const mixedVAT = normalize(fixture({ priceBasis: "gross", vatRate: 0.06 }), { ...settings, priceBasis: "gross", vatRate: 0.21 });
  assert.equal(candidate(mixedVAT).category, "new"); assert.equal(mixedVAT.vatRate, 0.06);
});

test("gross contracts require a known VAT fraction and are never filled from hotel location", () => {
  const unknown = normalize(fixture({ pricePerPurchaseUnit: 12.6 }, { price: 12.6 }), { ...settings, priceBasis: "gross" });
  assert.equal(unknown.vatRate, null); assert.equal(candidate(unknown).category, "blocked");
  const reviewed = normalize(fixture({ pricePerPurchaseUnit: 12.6 }, { price: 12.6 }), { ...settings, priceBasis: "gross", vatRate: 0.05 });
  assert.equal(candidate(reviewed).category, "new"); assert.equal(policy.netPrice(reviewed.pricePerPurchaseUnit, reviewed.priceBasis, reviewed.vatRate), 12);
});
test("explicit structured USD, inclusive price basis and VAT percentage cannot be replaced by matching model/default guesses", () => {
  const data = fixture({ currency: "EUR", priceBasis: "net", vatRate: 0.21, pricePerPurchaseUnit: 12.72 }, { price: 12.72, priceHeader: "Unit price incl VAT" });
  const headers = JSON.parse(data.sourceUnits[0].text), cells = JSON.parse(data.sourceUnits[1].text);
  headers.push("Currency", "VAT %"); cells.push("USD", 6);
  data.sourceUnits[0].text = JSON.stringify(headers); data.sourceUnits[1].text = JSON.stringify(cells);
  const normalized = normalize(data, { ...settings, vatRate: 0.21 });
  assert.equal(normalized.currency, "USD"); assert.equal(normalized.priceBasis, "gross"); assert.equal(normalized.vatRate, 0.06);
  assert.equal(candidate(normalized).category, "blocked");
  assert.ok(codes(normalized).includes("currency-context-conflict")); assert.ok(codes(normalized).includes("basis-context-conflict"));
  assert.equal(normalized.originalInput.currency, "EUR"); assert.equal(normalized.originalInput.priceBasis, "net");
  assert.equal(policy.netPrice(normalized.pricePerPurchaseUnit, normalized.priceBasis, normalized.vatRate), 12);
});

test("existing offers without new unit prices keep their entire prior financial and physical package contract", () => {
  const normalized = normalize(fixture({ supplierProductName: "MOZZARELLA PLAKKEN500G", purchaseUnit: "PK", baseUnit: "KG", baseUnitsPerPurchaseUnit: 0.5 }, { content: "0.5 KG" }),
    { ...settings, currency: "USD", priceBasis: "gross", vatRate: 0.21 });
  const previous = { ...candidate(normalize(fixture())).product, supplierSku: normalized.supplierSku, supplierProductName: "Existing milk", currency: "EUR", priceBasis: "net", vatRate: null,
    pricingModel: "Per Base Unit", pricePerBaseUnit: 10, pricePerPurchaseUnit: 10, purchaseUnit: "Box", baseUnit: "kg", baseUnitsPerPurchaseUnit: 1, revision: 2 };
  const proposed = candidate(normalized, { previous });
  assert.equal(proposed.category, "changed"); assert.equal(proposed.product.currency, "EUR"); assert.equal(proposed.product.priceBasis, "net");
  assert.equal(proposed.product.vatRate, null); assert.equal(proposed.product.pricingModel, "Per Base Unit"); assert.equal(proposed.product.pricePerBaseUnit, 10);
  assert.equal(proposed.product.pricePerPurchaseUnit, 10); assert.equal(proposed.product.purchaseUnit, "Box"); assert.equal(proposed.product.baseUnitsPerPurchaseUnit, 1);
  assert.ok(proposed.issues.some((entry) => entry.code === "source-price-missing")); assert.ok(proposed.issues.some((entry) => entry.code === "existing-price-contract-preserved"));
});

test("physical corrections clear a stale piece hint while preserving original normalization and exact evidence errors", () => {
  const normalized = normalize(fixture({ supplierProductName: "BUTTER10G", purchaseUnit: "DS", baseUnit: "KG", baseUnitsPerPurchaseUnit: 1 }, { content: "1KG" }));
  const corrected = candidate(normalized, { userPatch: { baseUnitsPerPurchaseUnit: 2 } });
  assert.equal(corrected.packInference, null); assert.ok(corrected.issues.some((entry) => entry.code === "piece-inference-stale"));
  assert.equal(corrected.normalizationFindings.find((entry) => entry.code === "piece-count-inferred").after.piecesPerPurchaseUnit, 100);
  const bad = { ...normalized, sourceEvidenceIssues: [{ field: "sourceAnchors", code: "evidence-quote-absent", severity: "error", message: "Invalid source quote." }] };
  assert.equal(candidate(bad, { userPatch: { baseUnitsPerPurchaseUnit: 1, baseUnit: "kg", currency: "EUR" } }).category, "blocked");
});

test("legacy jobs remain byte-identical and normalization cannot silently be applied twice", () => {
  const checked = fixture().checked, serialized = JSON.stringify(checked);
  assert.equal(normalizeSupplierAiProposal(checked), checked); assert.equal(normalizeSupplierAiProposal(checked, { importSettings: { policyVersion: 1 } }), checked);
  assert.equal(JSON.stringify(checked), serialized); const enriched = normalizeSupplierAiProposals([checked], { importSettings: settings, sourceUnits: fixture().sourceUnits });
  assert.equal(enriched[0].normalizationVersion, 2); assert.throws(() => normalizeSupplierAiProposal(enriched[0], { importSettings: settings }), /already applied/);
});
