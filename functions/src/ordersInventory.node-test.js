const test = require("node:test");
const assert = require("node:assert/strict");
const { canonicalLines, cartInput, sameOrderContract, orderPriceContract } = require("./orders");
const { receiptInventoryLines } = require("./orderReceiving");

// Acceptance fixtures deliberately use mixed supplier/catalog units and two
// purchase options. Expected quantities/prices are calculated independently.
const offer = (patch = {}) => ({ supplierId: "vendor", supplierSku: "MILK", supplierProductName: "Milk", active: true,
  currency: "EUR", baseUnit: "ml", purchaseUnit: "Case of six", baseUnitsPerPurchaseUnit: 6000,
  pricePerPurchaseUnit: 12, priceBasis: "net", vatRate: null, catalogProductId: "milk", productPolicyVersion: 1,
  purchaseOptions: [{ id: "single", purchaseUnit: "Bottle", baseUnitsPerPurchaseUnit: 1000, pricePerPurchaseUnit: 3 }], ...patch });
function fixture(product = offer(), catalog = { name: "Milk", baseUnit: "l", inventoryTracked: true, active: true }) {
  const records = new Map(Object.entries({
    "hotels/a/supplierproducts/milk-vendor": product, "hotels/a/catalogproducts/milk": catalog,
    "hotels/a/suppliers/vendor": { name: "Vendor" }, "hotels/a/outlets/kitchen": { name: "Kitchen" },
  }));
  const db = { doc: (path) => ({ path }) };
  const tx = { getAll: async (...refs) => refs.map((ref) => ({ id: ref.path.split("/").at(-1), exists: records.has(ref.path), data: () => records.get(ref.path) })) };
  return { db, tx, records };
}
const input = (purchaseOptionId = "default", quantity = 1) => ({ supplierProductId: "milk-vendor", outletId: "kitchen", purchaseOptionId, qtyPurchaseUnits: quantity });
async function lines(product, selected = [input()], catalog) { const f = fixture(product, catalog); return (await canonicalLines(f.db, f.tx, "a", selected)).lines; }

test("independent package selection creates distinct lines and freezes exact catalog conversions", async () => {
  const result = await lines(offer(), [input("default", 2), input("single", 1)]);
  assert.equal(result.length, 2);
  assert.notEqual(result[0].orderLineId, result[1].orderLineId);
  assert.deepEqual(result.map((row) => row.pricePerPurchaseUnit * row.qtyPurchaseUnits), [24, 3]);
  assert.deepEqual(result.map((row) => row.inventoryTerms.catalogUnitsPerPurchaseUnit), [6, 1]);
  assert.deepEqual(result.map((row) => row.inventoryTerms.catalogBaseUnit), ["l", "l"]);
  assert.equal(result[0].inventoryTerms.netUnitCost, 2);
  assert.equal(result[1].inventoryTerms.netUnitCost, 3);
  const receipt = receiptInventoryLines(result, [
    { supplierProductId: "milk-vendor", orderLineId: result[0].orderLineId, acceptedQuantity: 1, rejectedQuantity: 1 },
    { supplierProductId: "milk-vendor", orderLineId: result[1].orderLineId, acceptedQuantity: 1, rejectedQuantity: 0 },
  ]);
  assert.deepEqual(receipt.lines.map((row) => row.quantity), [6, 1]);
  assert.deepEqual(receipt.lines.map((row) => row.netValue), [12, 3]);
  assert.equal(receipt.coverageGaps.length, 0);
});
test("an unknown purchase price is not converted into a free order, while explicit zero is orderable", async () => {
  for (const price of [null, undefined, "12", NaN, Infinity, -1]) await assert.rejects(lines(offer({ pricePerPurchaseUnit: price })), { code: price === null || price === undefined ? "failed-precondition" : "invalid-argument" });
  assert.equal((await lines(offer({ pricePerPurchaseUnit: 0 })))[0].pricePerPurchaseUnit, 0);
});
test("different options are allowed but an exact duplicate product-option-outlet is rejected", () => {
  assert.equal(cartInput([input("default"), input("single")]).length, 2);
  assert.throws(() => cartInput([input("single"), input("single")]), /duplicate/i);
});
test("packaging, currency, net price contract and catalog unit changes invalidate confirmation", async () => {
  const frozen = (await lines(offer()))[0];
  const order = { supplierId: "vendor", currency: "EUR" };
  assert.equal(sameOrderContract(frozen, frozen, order), true);
  for (const patch of [{ baseUnitsPerPurchaseUnit: 12000 }, { purchaseUnit: "New box" }, { priceBasis: "gross", vatRate: 0.2 }, { currency: "USD" }, { supplierSku: "NEW" }]) {
    const current = (await lines(offer(patch)))[0];
    assert.equal(sameOrderContract(current, frozen, order), false, JSON.stringify(patch));
  }
  const catalogChanged = (await lines(offer(), [input()], { name: "Milk", baseUnit: "ml", inventoryTracked: true, active: true }))[0];
  assert.equal(sameOrderContract(catalogChanged, frozen, order), false);
});
test("gross pricing removes explicit VAT once, unknown price contracts keep cost unknown", async () => {
  const gross = (await lines(offer({ pricePerPurchaseUnit: 12.72, priceBasis: "gross", vatRate: 0.06 })))[0];
  assert.equal(gross.netPricePerPurchaseUnit, 12);
  assert.equal(gross.inventoryTerms.netUnitCost, 2);
  const unknown = (await lines(offer({ priceBasis: "unknown" })))[0];
  assert.equal(unknown.pricePerPurchaseUnit, 12);
  assert.equal(unknown.netPricePerPurchaseUnit, null);
  assert.equal(unknown.inventoryTerms.netUnitCost, null);
});

test("orange juice supplier millilitres become catalog litres for receipts and physical count comparisons", async () => {
  const product = (await lines(offer({ supplierProductName: "Orange juice", pricePerPurchaseUnit: 15.9, priceBasis: "gross", vatRate: 0.06 }),
    [input("default", 2)], { name: "Orange juice", baseUnit: "l", inventoryTracked: true, active: true }))[0];
  assert.equal(product.baseUnit, "ml"); assert.equal(product.inventoryTerms.catalogBaseUnit, "l");
  assert.equal(product.inventoryTerms.catalogUnitsPerPurchaseUnit, 6);
  const received = receiptInventoryLines([product], [{ supplierProductId: product.supplierProductId, orderLineId: product.orderLineId, acceptedQuantity: 2, rejectedQuantity: 0 }]);
  assert.equal(received.lines[0].quantity, 12); assert.equal(received.lines[0].baseUnit, "l");
  assert.equal(received.lines[0].netValue, 30); assert.equal(received.lines[0].netUnitCost, 2.5);
  const { period } = require("./inventoryPolicy");
  const checkpoint = { locationId: "store", currency: "EUR", businessDate: "2026-10-01", sequence: 1,
    items: [{ catalogProductId: "milk", catalogProductName: "Orange juice", baseUnit: "l", quantity: 20, unitCost: 2 }] };
  const closing = { ...checkpoint, sequence: 3, businessDate: "2026-10-10", items: [{ ...checkpoint.items[0], quantity: 15 }] };
  const movement = { id: "receipt", kind: "receipt", inventoryPolicyVersion: 1, locationId: "store", sequence: 2,
    receivedOn: "2026-10-05", lines: received.lines, coverageGaps: [] };
  const report = period(checkpoint, closing, [movement]);
  assert.equal(report.items[0].netReceiptQuantity, 12); assert.equal(report.items[0].inferredUsageQuantity, 17);
});
test("foreign catalog identity and ambiguous legacy conversion stay explicit inventory coverage gaps", async () => {
  const foreign = (await lines(offer({ catalogProductId: "foreign" })))[0];
  assert.equal(foreign.inventoryTerms.available, false);
  assert.equal(receiptInventoryLines([foreign], [{ ...input(), orderLineId: foreign.orderLineId, acceptedQuantity: 1, rejectedQuantity: 0 }]).coverageGaps.length, 1);
  const legacy = (await lines(offer({ productPolicyVersion: undefined, baseUnit: "liters", baseUnitsPerPurchaseUnit: "6" })))[0];
  assert.equal(legacy.inventoryTerms.available, false);
  assert.equal(legacy.inventoryTerms.catalogUnitsPerPurchaseUnit, null);
});

test("a tiny known receipt value is preserved even when per-base-unit cost is below supported precision", async () => {
  const product = (await lines(offer({ baseUnitsPerPurchaseUnit: 1000000, pricePerPurchaseUnit: 0.000001 })))[0];
  assert.equal(product.inventoryTerms.catalogUnitsPerPurchaseUnit, 1000);
  assert.equal(product.inventoryTerms.netUnitCost, null);
  const received = receiptInventoryLines([product], [{ supplierProductId: product.supplierProductId, orderLineId: product.orderLineId, acceptedQuantity: 1, rejectedQuantity: 0 }]);
  assert.equal(received.lines[0].quantity, 1000);
  assert.equal(received.lines[0].netValue, 0.000001);
  assert.equal(received.lines[0].netUnitCost, null);
});

test("ambiguous legacy variants cannot silently order the flat default package", async () => {
  await assert.rejects(lines(offer({ productPolicyVersion: undefined, hasVariants: true, purchaseOptions: [],
    variants: [{ unit: "Case", quantity: 6, price: 12 }] })), { code: "failed-precondition" });
});

test("period cost uses opening stock and net received value, never the closing entered price or latest offer price", () => {
  const { period } = require("./inventoryPolicy");
  const opening = { stockCountId: "opening", locationId: "store", sequence: 1, businessDate: "2026-10-01", currency: "EUR",
    items: [{ catalogProductId: "milk", baseUnit: "l", quantity: 100, unitCost: 2 }] };
  const closing = { stockCountId: "closing", locationId: "store", sequence: 3, businessDate: "2026-10-10", currency: "EUR",
    items: [{ catalogProductId: "milk", baseUnit: "l", quantity: 80, unitCost: 99 }] };
  const movement = { id: "receipt", kind: "receipt", inventoryPolicyVersion: 1, locationId: "store", sequence: 2, receivedOn: "2026-10-05", coverageGaps: [],
    lines: [{ catalogProductId: "milk", baseUnit: "l", quantity: 30, netValue: 90, netUnitCost: 3, currency: "EUR" }] };
  const report = period(opening, closing, [movement]);
  assert.equal(report.items[0].inferredUsageQuantity, 50);
  assert.equal(report.items[0].periodUnitCost, 290 / 130);
  assert.equal(report.items[0].inferredUsageValue, 111.5385);
  assert.equal(report.coverage.costComplete, true);
});

// 12 net + 12 gross must not become an unlabeled total of 24.
test("order totals require a single explicit price basis without guessing historical tax", () => {
  for (const pair of [["net", "gross"], ["net", "unknown"], ["gross", undefined]]) {
    assert.throws(() => orderPriceContract(pair.map((priceBasis) => ({ currency: "EUR", priceBasis, pricePerPurchaseUnit: 12 }))), /cannot mix.*price bases/i);
  }
  assert.deepEqual(orderPriceContract([{ currency: "EUR", priceBasis: "gross", vatRate: 0.21 }, { currency: "EUR", priceBasis: "gross", vatRate: 0.06 }]), { currency: "EUR", priceBasis: "gross" });
  assert.deepEqual(orderPriceContract([{ currency: "EUR" }]), { currency: "EUR", priceBasis: "unknown" });
  assert.throws(() => orderPriceContract([{ currency: "EUR", priceBasis: "net" }, { currency: "USD", priceBasis: "net" }]), /mix currencies/i);
});
