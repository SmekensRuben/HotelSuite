const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeSupplierAiProposal, normalizeSupplierAiProposals } = require("./supplierAiNormalization");
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
