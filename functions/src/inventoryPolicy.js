const { HttpsError } = require("firebase-functions/v2/https");
const { requireDocumentId } = require("./subscriptions");
const { validDate } = require("./importMonitoringPolicy");
const { decimal } = require("./productPolicy");

const INVENTORY_POLICY_VERSION = 1;
const UNITS = new Set(["g", "kg", "ml", "l", "each"]);
const SCALE = 1000000;
function amount(value, field, { signed = false, maximum = 1000000 } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value) || (!signed && value < 0)) {
    throw new HttpsError("invalid-argument", `${field} must be a bounded number with at most six decimals.`);
  }
  const sign = value < 0 ? -1 : 1;
  return decimal(Math.abs(value), field, { maximum }) * sign;
}
function cost(value, field = "unitCost") {
  return value == null ? null : amount(value, field);
}
function currency(value) {
  if (typeof value !== "string" || !/^[A-Z]{3}$/.test(value)) throw new HttpsError("failed-precondition", "A valid hotel currency is required for catalog counts.");
  return value;
}
function unit(value) {
  if (!UNITS.has(value)) throw new HttpsError("failed-precondition", "A catalog product needs a supported inventory base unit.");
  return value;
}
function businessDate(value) {
  if (!validDate(value)) throw new HttpsError("invalid-argument", "A valid inventory business date is required.");
  return value;
}
function countItems(value) {
  if (!Array.isArray(value) || value.length > 250) throw new HttpsError("invalid-argument", "A location may include at most 250 counted products.");
  const result = value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)
      || Object.keys(item).some((field) => !["catalogProductId", "quantity", "isCounted", "unitCost"].includes(field))) {
      throw new HttpsError("invalid-argument", "Unsupported catalog count item fields.");
    }
    if (typeof item.isCounted !== "boolean") throw new HttpsError("invalid-argument", "Each product needs an explicit counted state.");
    const quantity = !item.isCounted && item.quantity === null ? null : amount(item.quantity, "quantity");
    if (!item.isCounted && quantity !== null && quantity !== 0) throw new HttpsError("invalid-argument", "Uncounted products must have an empty or legacy zero quantity.");
    return { catalogProductId: requireDocumentId(item.catalogProductId, "catalogProductId"), quantity,
      isCounted: item.isCounted, unitCost: cost(item.unitCost) };
  });
  if (new Set(result.map((item) => item.catalogProductId)).size !== result.length) throw new HttpsError("invalid-argument", "Count each catalog product once per location.");
  return result;
}
function money(value) {
  if (!Number.isFinite(value) || Math.abs(value) > 1e12) throw new HttpsError("resource-exhausted", "Inventory valuation exceeds the supported bound.");
  return Math.round(value * 10000) / 10000;
}
function addAmounts(...values) {
  const micros = values.reduce((sum, value) => sum + Math.round(amount(value, "Inventory quantity", { signed: true, maximum: 1000000000 }) * SCALE), 0);
  if (!Number.isSafeInteger(micros) || Math.abs(micros) > 1000000000 * SCALE) throw new HttpsError("resource-exhausted", "Inventory quantity exceeds the supported bound.");
  return micros / SCALE;
}
function valuation(items) {
  if (!items.length) return { countedValue: null, knownCountedValue: 0, costComplete: false };
  let value = 0, complete = true;
  for (const item of items) {
    if (!item.isCounted) { complete = false; continue; }
    const quantity = amount(item.quantity, "Stored quantity");
    const unitCost = cost(item.unitCost);
    if (quantity > 0 && unitCost == null) { complete = false; continue; }
    value += quantity * (unitCost || 0);
  }
  return { countedValue: complete ? money(value) : null, knownCountedValue: money(value), costComplete: complete };
}
function completeCount(templateItems, countedItems) {
  if (!countedItems.length) throw new HttpsError("failed-precondition", "Add and explicitly count at least one product before finishing this stock point.");
  const actual = new Map(countedItems.map((item) => [item.catalogProductId, item]));
  if (templateItems.some((item) => actual.get(item.catalogProductId)?.isCounted !== true)
    || countedItems.some((item) => item.isCounted !== true)) {
    throw new HttpsError("failed-precondition", "Explicitly count every included product, including zero, before finishing this location.");
  }
}
function period(opening, closing, movements) {
  if (![opening.sequence, closing.sequence].every((value) => Number.isSafeInteger(value) && value > 0)
    || !validDate(opening.businessDate) || !validDate(closing.businessDate)
    || opening.locationId !== closing.locationId || closing.sequence <= opening.sequence
    || closing.businessDate < opening.businessDate) throw new HttpsError("failed-precondition", "Choose successive checkpoints for the same location in business-date order.");
  const reportCurrency = currency(opening.currency);
  if (closing.currency !== reportCurrency) throw new HttpsError("failed-precondition", "Checkpoint currencies differ; currency reconciliation is required.");
  const issues = [], rows = new Map();
  const issue = (code, detail) => { if (!issues.some((item) => item.code === code && item.detail === detail)) issues.push({ code, detail }); };
  for (const checkpoint of [opening, closing]) {
    if (!Array.isArray(checkpoint.items) || checkpoint.items.length < 1 || checkpoint.items.length > 250
      || new Set(checkpoint.items.map((item) => item.catalogProductId)).size !== checkpoint.items.length) throw new HttpsError("failed-precondition", "Checkpoint products need reconciliation.");
    for (const entry of checkpoint.coverageIssues || []) issue(entry.code || "checkpoint-cutoff-unknown", entry.detail || checkpoint.stockCountId);
  }
  if (new Set(movements.map((item) => item.sequence)).size !== movements.length) throw new HttpsError("failed-precondition", "Duplicate movement sequences need reconciliation.");
  function rowFor(item) {
    requireDocumentId(item.catalogProductId, "Stored catalogProductId"); unit(item.baseUnit);
    let row = rows.get(item.catalogProductId);
    if (!row) { row = { catalogProductId: item.catalogProductId, catalogProductName: item.catalogProductName || item.catalogProductId,
      baseUnit: item.baseUnit, openingQuantity: null, netReceiptQuantity: 0, closingQuantity: null,
      openingValue: null, receiptValue: 0, costComplete: true }; rows.set(item.catalogProductId, row); }
    if (row.baseUnit !== item.baseUnit) throw new HttpsError("failed-precondition", "An inventory product changed base units between checkpoints. Reconcile before comparing.");
    return row;
  }
  for (const item of opening.items) {
    const row = rowFor(item); row.openingQuantity = amount(item.quantity, "Opening quantity");
    row.openingValue = item.unitCost == null && row.openingQuantity > 0 ? null : money(row.openingQuantity * (cost(item.unitCost) || 0));
    if (row.openingValue == null) { row.costComplete = false; issue("opening-cost-unknown", item.catalogProductId); }
  }
  for (const item of closing.items) rowFor(item).closingQuantity = amount(item.quantity, "Closing quantity");
  for (const movement of movements) {
    if (movement.inventoryPolicyVersion !== INVENTORY_POLICY_VERSION || movement.locationId !== opening.locationId
      || !["receipt", "reversal"].includes(movement.kind) || !Array.isArray(movement.lines) || movement.lines.length > 100
      || !Array.isArray(movement.coverageGaps || []) || (movement.coverageGaps || []).length > 100
      || !Number.isSafeInteger(movement.sequence) || movement.sequence <= opening.sequence || movement.sequence >= closing.sequence) {
      throw new HttpsError("failed-precondition", "A period movement needs reconciliation.");
    }
    if (!validDate(movement.receivedOn)) issue("source-date-unknown", movement.id || "receipt");
    else if (movement.receivedOn < opening.businessDate || movement.receivedOn > closing.businessDate) issue("backdated-or-outside-period", movement.id || "receipt");
    if (movement.backdatedAgainstCheckpoint) issue("backdated-or-outside-period", `${movement.id}: posted after a checkpoint on the same or a later business date`);
    for (const gap of movement.coverageGaps || []) issue("receipt-coverage-gap", `${movement.id || "receipt"}: ${gap.reason || gap.code || "Unknown receipt coverage"}`);
    for (const item of movement.lines) {
      const row = rowFor(item), quantity = amount(item.quantity, "Movement quantity", { signed: true, maximum: 1000000000 });
      row.netReceiptQuantity = addAmounts(row.netReceiptQuantity, quantity);
      if (item.currency !== reportCurrency || (item.netValue == null && quantity !== 0)) {
        row.costComplete = false; issue("receipt-cost-unknown", item.catalogProductId);
      } else row.receiptValue += item.netValue == null ? 0 : amount(item.netValue, "Receipt net value", { signed: true, maximum: 1000000000 });
    }
  }
  const items = [...rows.values()].sort((a, b) => a.catalogProductId.localeCompare(b.catalogProductId)).map((row) => {
    const quantityKnown = row.openingQuantity != null && row.closingQuantity != null;
    if (!quantityKnown) issue("checkpoint-product-missing", row.catalogProductId);
    const available = quantityKnown ? addAmounts(row.openingQuantity, row.netReceiptQuantity) : null;
    const value = row.openingValue == null ? null : row.openingValue + row.receiptValue;
    const inferredUsageQuantity = quantityKnown ? addAmounts(available, -row.closingQuantity) : null;
    if (available < 0 || value < 0) { row.costComplete = false; issue("negative-period-basis", row.catalogProductId); }
    if (inferredUsageQuantity < 0) issue("count-surplus", row.catalogProductId);
    const validCost = row.costComplete && quantityKnown && available > 0 && value != null;
    return { catalogProductId: row.catalogProductId, catalogProductName: row.catalogProductName, baseUnit: row.baseUnit,
      openingQuantity: row.openingQuantity, netReceiptQuantity: row.netReceiptQuantity, closingQuantity: row.closingQuantity,
      inferredUsageQuantity, periodUnitCost: validCost ? value / available : null,
      inferredUsageValue: validCost ? money(inferredUsageQuantity * value / available) : null };
  });
  // Any unresolved receipt or late source date prevents a complete economic claim.
  const quantityComplete = !issues.some((item) => ["receipt-coverage-gap", "checkpoint-product-missing", "source-date-unknown", "backdated-or-outside-period", "postings-during-count", "checkpoint-cutoff-unknown"].includes(item.code));
  if (!quantityComplete) for (const item of items) { item.periodUnitCost = null; item.inferredUsageValue = null; }
  const costComplete = quantityComplete && items.every((item) => item.periodUnitCost != null || item.openingQuantity === 0 && item.netReceiptQuantity === 0 && item.closingQuantity === 0);
  return { items, coverage: { quantityComplete, costComplete, issues } };
}
module.exports = { INVENTORY_POLICY_VERSION, amount, cost, currency, unit, businessDate, countItems, money, valuation, completeCount, period };
