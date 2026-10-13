const { HttpsError } = require("firebase-functions/v2/https");
const { requireDocumentId } = require("./subscriptions");
const { validDate } = require("./importMonitoringPolicy");
const inventory = require("./inventoryPolicy");
const { calculateNetValue } = require("./productPolicy");
const { MANUAL_KINDS } = require("./inventoryAdjustmentPolicy");

const REPORT_POLICY_VERSION = 2;
const CATEGORY = { receipt: ["netReceipt", 1], reversal: ["netReceipt", 1], transfer_in: ["transferIn", 1],
  transfer_out: ["transferOut", -1], waste: ["waste", -1], breakage: ["breakage", -1], physical_return: ["physicalReturn", -1] };
// Keep six-decimal quantities and source values exact through aggregation.
function add(...values) {
  const sum = values.reduce((total, value) => total + BigInt(Math.round(inventory.amount(value, "Period amount", { signed: true, maximum: 1000000000 }) * 1000000)), 0n);
  if (sum > 1000000000000000n || sum < -1000000000000000n) throw new HttpsError("resource-exhausted", "The inventory period amount exceeds its supported bound.");
  return Number(sum) / 1000000;
}
function period(opening, closing, movements) {
  if (![opening.sequence, closing.sequence].every((value) => Number.isSafeInteger(value) && value > 0)
    || !validDate(opening.businessDate) || !validDate(closing.businessDate) || opening.locationId !== closing.locationId
    || closing.sequence <= opening.sequence || closing.businessDate < opening.businessDate) {
    throw new HttpsError("failed-precondition", "Choose successive checkpoints for the same location in business-date order.");
  }
  const reportCurrency = inventory.currency(opening.currency);
  if (closing.currency !== reportCurrency) throw new HttpsError("failed-precondition", "Checkpoint currencies differ; currency reconciliation is required.");
  if (!Array.isArray(movements) || movements.length > 1000 || new Set(movements.map((item) => item.sequence)).size !== movements.length) {
    throw new HttpsError("failed-precondition", "Period movement sequences need reconciliation.");
  }
  const issues = [], rows = new Map();
  const issue = (code, detail) => { if (!issues.some((item) => item.code === code && item.detail === detail)) issues.push({ code, detail }); };
  function rowFor(item) {
    requireDocumentId(item.catalogProductId, "Stored catalogProductId"); inventory.unit(item.baseUnit);
    let row = rows.get(item.catalogProductId);
    if (!row) {
      row = { catalogProductId: item.catalogProductId, catalogProductName: item.catalogProductName || item.catalogProductId, baseUnit: item.baseUnit,
        openingQuantity: null, closingQuantity: null, openingValue: null, closingValue: null };
      for (const category of ["netReceipt", "transferIn", "transferOut", "waste", "breakage", "physicalReturn"]) {
        row[`${category}Quantity`] = 0; row[category === "netReceipt" ? "receiptValue" : `${category}Value`] = 0;
      }
      rows.set(item.catalogProductId, row);
    }
    if (row.baseUnit !== item.baseUnit) throw new HttpsError("failed-precondition", "An inventory product changed base units between source snapshots.");
    return row;
  }
  for (const [checkpoint, prefix] of [[opening, "opening"], [closing, "closing"]]) {
    if (!Array.isArray(checkpoint.items) || checkpoint.items.length < 1 || checkpoint.items.length > 250
      || new Set(checkpoint.items.map((item) => item.catalogProductId)).size !== checkpoint.items.length) throw new HttpsError("failed-precondition", "Checkpoint products need reconciliation.");
    for (const entry of checkpoint.coverageIssues || []) issue(entry.code || "checkpoint-cutoff-unknown", entry.detail || checkpoint.stockCountId);
    for (const item of checkpoint.items) {
      const row = rowFor(item), quantity = inventory.amount(item.quantity, `${prefix} quantity`), unitCost = inventory.cost(item.unitCost);
      row[`${prefix}Quantity`] = quantity;
      try { row[`${prefix}Value`] = quantity === 0 ? 0 : calculateNetValue(quantity, unitCost); }
      catch (error) { if (error.code !== "failed-precondition") throw error; row[`${prefix}Value`] = null; }
      if (row[`${prefix}Value`] == null) issue(`${prefix}-cost-unknown`, item.catalogProductId);
    }
  }
  for (const movement of movements) {
    const manual = MANUAL_KINDS.has(movement.kind) || movement.kind === "adjustment_reversal";
    if (movement.inventoryPolicyVersion !== 1 || movement.locationId !== opening.locationId
      || (!CATEGORY[movement.kind] && movement.kind !== "adjustment_reversal")
      || !Array.isArray(movement.lines) || movement.lines.length > 100 || manual && movement.lines.length !== 1
      || !Array.isArray(movement.coverageGaps || []) || (movement.coverageGaps || []).length > 100
      || !Number.isSafeInteger(movement.sequence) || movement.sequence <= opening.sequence || movement.sequence >= closing.sequence
      || manual && movement.inventoryAdjustmentPolicyVersion !== 1
      || movement.kind === "adjustment_reversal" && !MANUAL_KINDS.has(movement.originalKind)
      || new Set(movement.lines.map((item) => item.catalogProductId)).size !== movement.lines.length) {
      throw new HttpsError("failed-precondition", "A period movement needs reconciliation.");
    }
    const originalKind = movement.kind === "adjustment_reversal" ? movement.originalKind : movement.kind;
    const [category, categorySign] = CATEGORY[originalKind];
    const expectedDirection = ["receipt", "transfer_in"].includes(originalKind) ? 1 : -1;
    const reverseDirection = movement.kind === "adjustment_reversal" ? -1 : 1;
    if (!validDate(movement.receivedOn)) issue("source-date-unknown", movement.id || "movement");
    else if (movement.receivedOn < opening.businessDate || movement.receivedOn > closing.businessDate) issue("backdated-or-outside-period", movement.id || "movement");
    if (movement.backdatedAgainstCheckpoint) issue("backdated-or-outside-period", `${movement.id}: posted after a checkpoint on the same or a later business date`);
    for (const gap of movement.coverageGaps || []) issue("receipt-coverage-gap", `${movement.id || "receipt"}: ${gap.reason || gap.code || "Unknown receipt coverage"}`);
    for (const line of movement.lines) {
      const row = rowFor(line), quantity = inventory.amount(line.quantity, "Movement quantity", { signed: true, maximum: 1000000000 });
      if (quantity * expectedDirection * reverseDirection < 0 || manual && quantity === 0) throw new HttpsError("failed-precondition", "A movement direction differs from its frozen category.");
      row[`${category}Quantity`] = add(row[`${category}Quantity`], quantity * categorySign);
      const valueField = category === "netReceipt" ? "receiptValue" : `${category}Value`;
      let value = line.netValue == null ? null : inventory.amount(line.netValue, "Movement net value", { signed: true, maximum: 1000000000 });
      if (value != null && value * expectedDirection * reverseDirection < 0) throw new HttpsError("failed-precondition", "A movement value differs from its frozen direction.");
      if (quantity !== 0 && (line.currency !== reportCurrency || value == null)) {
        row[valueField] = null; issue(manual ? "manual-cost-unknown" : "receipt-cost-unknown", line.catalogProductId);
      } else if (row[valueField] != null) row[valueField] = add(row[valueField], (value || 0) * categorySign);
    }
  }
  const items = [...rows.values()].sort((a, b) => a.catalogProductId.localeCompare(b.catalogProductId)).map((row) => {
    const quantityKnown = row.openingQuantity != null && row.closingQuantity != null;
    if (!quantityKnown) issue("checkpoint-product-missing", row.catalogProductId);
    const available = quantityKnown ? add(row.openingQuantity, row.netReceiptQuantity, row.transferInQuantity, -row.transferOutQuantity,
      -row.wasteQuantity, -row.breakageQuantity, -row.physicalReturnQuantity) : null;
    const residualQuantity = quantityKnown ? add(available, -row.closingQuantity) : null;
    if (available != null && available < 0) issue("negative-period-basis", row.catalogProductId);
    if (residualQuantity != null && residualQuantity < 0) issue("count-surplus", row.catalogProductId);
    const valueFields = ["openingValue", "receiptValue", "transferInValue", "transferOutValue", "wasteValue", "breakageValue", "physicalReturnValue", "closingValue"];
    const residualValue = quantityKnown && valueFields.every((field) => row[field] != null)
      ? add(row.openingValue, row.receiptValue, row.transferInValue, -row.transferOutValue, -row.wasteValue, -row.breakageValue, -row.physicalReturnValue, -row.closingValue) : null;
    return { ...row, residualQuantity, residualValue };
  });
  const quantityComplete = !issues.some((item) => ["receipt-coverage-gap", "checkpoint-product-missing", "source-date-unknown", "backdated-or-outside-period", "postings-during-count", "checkpoint-cutoff-unknown"].includes(item.code));
  if (!quantityComplete) for (const item of items) item.residualValue = null;
  const costComplete = quantityComplete && items.every((item) => item.residualValue != null)
    && !issues.some((item) => ["negative-period-basis", "count-surplus"].includes(item.code));
  if (!costComplete && issues.some((item) => ["negative-period-basis", "count-surplus"].includes(item.code))) for (const item of items) item.residualValue = null;
  return { items, coverage: { quantityComplete, costComplete, issues } };
}
module.exports = { REPORT_POLICY_VERSION, period, add };
