const test = require("node:test"), assert = require("node:assert/strict");
const { proposal } = require("./inventoryCostProposalPolicy");
const context = (patch = {}) => ({ hotelUid: "hotel-a", purpose: "movement", locationId: "store", catalogProductId: "juice", stockCountId: null,
  businessDate: "2026-10-12", currency: "EUR", baseUnit: "l", asOfMillis: 1791800000000, postingCutoffSequence: 2, ...patch });
const opening = (patch = {}) => ({ id: "checkpoint", hotelUid: "hotel-a", locationId: "store", stockCountId: "opening", inventoryPolicyVersion: 1,
  sequence: 1, businessDate: "2026-10-01", currency: "EUR", coverageIssues: [],
  items: [{ catalogProductId: "juice", baseUnit: "l", quantity: 10, unitCost: 2 }], ...patch });
const movement = (patch = {}) => ({ id: "received", hotelUid: "hotel-a", locationId: "store", inventoryPolicyVersion: 1,
  kind: "receipt", receivedOn: "2026-10-05", sequence: 2, coverageGaps: [],
  lines: [{ catalogProductId: "juice", baseUnit: "l", quantity: 20, netUnitCost: 3, netValue: 60, currency: "EUR" }], ...patch });
const calculate = (anchor = opening(), movements = [movement()], ctx = context(), reasons = []) => proposal(ctx, anchor, movements, reasons);
const unavailable = (result, code) => { assert.equal(result.status, "unavailable"); assert.equal(result.netUnitCost, null); assert(result.reasons.some((entry) => entry.code === code), JSON.stringify(result.reasons)); };

test("independent quantity-weighted arithmetic gives 80/30 rather than unweighted 2.50", () => {
  const result = calculate(); assert.equal(result.status, "available"); assert.equal(result.netUnitCost, 2.666667);
  assert.equal(result.source.weightedSourceNetValue, 10 * 2 + 20 * 3);
  assert.equal(result.source.weightedSourceQuantity, 10 + 20);
  assert.match(result.costBasis, /not live on-hand/);
});
test("known zero value is a free cost only with a positive explicit source quantity", () => {
  const anchor = opening({ items: [{ catalogProductId: "juice", baseUnit: "l", quantity: 10, unitCost: 0 }] });
  assert.equal(calculate(anchor, []).netUnitCost, 0);
  const zero = opening({ items: [{ catalogProductId: "juice", baseUnit: "l", quantity: 0, unitCost: null }] });
  unavailable(calculate(zero, []), "no-positive-source-quantity");
  assert.equal(calculate(zero).netUnitCost, 3);
});
test("missing or unknown opening, quantities and costs stay explicitly unavailable", () => {
  unavailable(calculate(null), "opening-count-unavailable");
  unavailable(calculate(opening({ items: [] })), "opening-product-missing");
  for (const patch of [{ quantity: null }, { quantity: "10" }, { unitCost: null }, { unitCost: "2" }]) {
    const item = { ...opening().items[0], ...patch }; unavailable(calculate(opening({ items: [item] })), "opening-cost-unknown");
  }
  unavailable(calculate(opening(), [movement({ lines: [{ ...movement().lines[0], netValue: null }] })]), "movement-cost-unknown");
});
test("frozen net values are authoritative: no VAT, commission or current supplier price is applied twice", () => {
  const line = { ...movement().lines[0], netUnitCost: 999, netValue: 50, grossValue: 60.5, vatRate: 0.21, commissionRate: 0.10, currentSupplierPrice: 777 };
  const result = calculate(opening(), [movement({ lines: [line] })]);
  assert.equal(result.source.recordedMovementNetValue, 50); assert.equal(result.netUnitCost, 2.333333);
});
test("a receipt containing two interchangeable supplier offers preserves both quantities and values", () => {
  const first = { ...movement().lines[0], quantity: 5, netValue: 10 }, second = { ...movement().lines[0], quantity: 15, netValue: 45 };
  const result = calculate(opening(), [movement({ lines: [first, second] })]);
  assert.equal(result.source.weightedSourceQuantity, 30); assert.equal(result.source.weightedSourceNetValue, 75); assert.equal(result.netUnitCost, 2.5);
  assert.equal(result.source.movementCount, 1);
});
test("signed frozen manual transfers, waste, breakage, returns and exact reversals participate consistently", () => {
  for (const kind of ["transfer_out", "waste", "breakage", "physical_return"]) {
    const out = movement({ kind, inventoryAdjustmentPolicyVersion: 1, lines: [{ ...movement().lines[0], quantity: -2, netValue: -6 }] });
    const result = calculate(opening(), [out]); assert.equal(result.netUnitCost, 1.75);
    const reverse = { ...out, id: "reverse", kind: "adjustment_reversal", originalKind: kind, sequence: 3,
      receivedOn: "2026-10-06", lines: [{ ...out.lines[0], quantity: 2, netValue: 6 }] };
    assert.equal(calculate(opening(), [out, reverse], context({ postingCutoffSequence: 3 })).netUnitCost, 2);
  }
  const incoming = movement({ kind: "transfer_in", inventoryAdjustmentPolicyVersion: 1 }); assert.equal(calculate(opening(), [incoming]).netUnitCost, 2.666667);
  unavailable(calculate(opening(), [movement({ kind: "waste", inventoryAdjustmentPolicyVersion: 1,
    lines: [{ ...movement().lines[0], quantity: -2, netValue: null, currency: null }] })]), "movement-cost-unknown");
});
test("receipt reversal uses its frozen signed value and cannot imply a negative pool or unsupported direction", () => {
  const reversed = movement({ kind: "reversal", lines: [{ ...movement().lines[0], quantity: -5, netValue: -10 }] });
  assert.equal(calculate(opening(), [reversed]).netUnitCost, 2);
  unavailable(calculate(opening(), [movement({ kind: "reversal" })]), "movement-needs-reconciliation");
  unavailable(calculate(opening(), [movement({ kind: "reversal", lines: [{ ...movement().lines[0], quantity: -20, netValue: -60 }] })]), "no-positive-source-quantity");
  unavailable(calculate(opening(), [movement({ kind: "waste", inventoryAdjustmentPolicyVersion: 1,
    lines: [{ ...movement().lines[0], quantity: -1, netValue: -30 }] })]), "negative-source-value");
});
test("business-date bounds and checkpoint uncertainty are explicit; later known receipts are not included", () => {
  assert.equal(calculate(opening(), [movement({ receivedOn: "2026-10-13" })]).netUnitCost, 2);
  for (const patch of [{ receivedOn: "2026-09-30" }, { backdatedAgainstCheckpoint: true }]) unavailable(calculate(opening(), [movement(patch)]), "backdated-source");
  unavailable(calculate(opening(), [movement({ receivedOn: null })]), "source-date-unknown");
  unavailable(calculate(opening({ coverageIssues: [{ code: "postings-during-count" }] })), "opening-cutoff-unreliable");
  unavailable(calculate(opening(), [movement({ sequence: 3 })]), "movement-needs-reconciliation");
  unavailable(calculate(opening(), [movement({ coverageGaps: [{ reason: "Unknown physical conversion" }] })]), "receipt-coverage-gap");
});
test("same-hotel location, unit and currency contracts cannot be guessed or converted silently", () => {
  for (const patch of [{ hotelUid: "hotel-b" }, { locationId: "bar" }]) unavailable(calculate(opening(patch)), "opening-count-needs-reconciliation");
  unavailable(calculate(opening({ currency: "USD" })), "source-currency-mismatch");
  unavailable(calculate(opening({ items: [{ ...opening().items[0], baseUnit: "ml" }] })), "source-unit-mismatch");
  for (const patch of [{ currency: "USD" }, { currency: null }, { baseUnit: "ml" }]) {
    const result = calculate(opening(), [movement({ lines: [{ ...movement().lines[0], ...patch }] })]); assert.equal(result.available, false);
  }
  unavailable(calculate(opening(), [movement({ hotelUid: "hotel-b" })]), "movement-needs-reconciliation");
});
test("malformed evidence, bounded windows and underprecision values fail as unavailable, not free or partial", () => {
  for (const patch of [{ coverageIssues: {} }, { items: null }]) assert.equal(calculate(opening(patch)).available, false);
  for (const row of [null, movement({ lines: null }), movement({ lines: {} }), movement({ lines: [null] }), movement({ coverageGaps: {} })]) {
    unavailable(calculate(opening(), [row]), "movement-needs-reconciliation");
  }
  unavailable(calculate(opening(), Array.from({ length: 1001 }, () => movement())), "source-window-exceeded");
  const tiny = opening({ items: [{ catalogProductId: "juice", baseUnit: "l", quantity: 0, unitCost: null }] });
  unavailable(calculate(tiny, [movement({ lines: [{ ...movement().lines[0], quantity: 1000000, netValue: 0.000001 }] })]), "suggested-cost-outside-bound");
  const before = structuredClone([opening(), movement()]); calculate(before[0], [before[1]]); assert.deepEqual(before, [opening(), movement()]);
});
