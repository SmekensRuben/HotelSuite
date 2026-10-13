const inventory = require("./inventoryPolicy");
const { calculateNetValue } = require("./productPolicy");
const { validDate } = require("./importMonitoringPolicy");
const { MANUAL_KINDS } = require("./inventoryAdjustmentPolicy");

const COST_PROPOSAL_POLICY_VERSION = 1;
const COST_BASIS = "Quantity-weighted estimate from a completed physical count and frozen net receipt and manual movement evidence. Recorded outbound values participate explicitly; unrecorded sales and consumption do not. This is not live on-hand stock, invoice cost or a perpetual moving average.";
const MAX_SOURCES = 1000;
const MICROS = 1000000;
function reason(code, detail) { return { code, detail: typeof detail === "string" ? detail.slice(0, 500) : "Inventory source evidence needs reconciliation." }; }
function bounded(value, signed = false) {
  return inventory.amount(value, "Stored cost proposal source", { signed, maximum: 1000000000 });
}
function add(values) {
  const total = values.reduce((sum, value) => sum + BigInt(Math.round(bounded(value, true) * MICROS)), 0n);
  if (total > 1000000000000000n || total < -1000000000000000n) throw new Error("Source aggregate exceeds the supported bound.");
  return Number(total) / MICROS;
}
function unavailable(context, reasons, source = null) {
  return { ...context, costProposalPolicyVersion: COST_PROPOSAL_POLICY_VERSION, status: "unavailable", available: false,
    netUnitCost: null, source, reasons: reasons.slice(0, 50), costBasis: COST_BASIS };
}
// Net frozen values are the authority. A displayed unit price may be rounded;
// recomputing receipt values from it, current supplier prices or VAT would drift.
function proposal(context, anchor, movements, extraReasons = []) {
  const reasons = [...extraReasons], issue = (code, detail) => {
    if (!reasons.some((item) => item.code === code && item.detail === detail)) reasons.push(reason(code, detail));
  };
  if (!anchor) { issue("opening-count-unavailable", "No completed physical opening count is available before this cutoff."); return unavailable(context, reasons); }
  const source = { anchorStockCountId: anchor.stockCountId ?? null, anchorCheckpointId: anchor.id ?? null,
    openingBusinessDate: anchor.businessDate ?? null, openingQuantity: null, openingNetValue: null,
    recordedMovementQuantity: null, recordedMovementNetValue: null, weightedSourceQuantity: null,
    weightedSourceNetValue: null, postingCutoffSequence: context.postingCutoffSequence ?? null, movementCount: 0 };
  if (anchor.inventoryPolicyVersion !== 1 || anchor.hotelUid !== context.hotelUid || anchor.locationId !== context.locationId
    || !Number.isSafeInteger(anchor.sequence) || anchor.sequence < 1 || anchor.sequence > context.postingCutoffSequence
    || !validDate(anchor.businessDate) || !validDate(context.businessDate) || anchor.businessDate > context.businessDate) {
    issue("opening-count-needs-reconciliation", "The completed count scope, business date or posting cutoff is inconsistent.");
  }
  if (anchor.currency !== context.currency || context.currency == null) issue("source-currency-mismatch", "Source and target must use the same explicit currency.");
  if (!Array.isArray(anchor.items) || anchor.items.length < 1 || anchor.items.length > 250
    || new Set(anchor.items.map((item) => item?.catalogProductId)).size !== anchor.items.length) {
    issue("opening-count-needs-reconciliation", "The completed count product snapshot is incomplete or duplicated.");
  }
  if (!Array.isArray(anchor.coverageIssues || []) || (anchor.coverageIssues || []).length > 100) {
    issue("opening-count-needs-reconciliation", "The completed count coverage snapshot is malformed.");
  } else for (const entry of anchor.coverageIssues || []) issue("opening-cutoff-unreliable", entry?.detail || "The completed count has an unresolved physical posting cutoff.");
  const opening = Array.isArray(anchor.items) ? anchor.items.find((item) => item?.catalogProductId === context.catalogProductId) : null;
  if (!opening) issue("opening-product-missing", "This article has no explicit opening quantity in the latest eligible completed count.");
  else {
    if (opening.baseUnit !== context.baseUnit) issue("source-unit-mismatch", "The source unit differs from the frozen target catalog unit.");
    try {
      source.openingQuantity = bounded(opening.quantity);
      source.openingNetValue = source.openingQuantity === 0 ? 0 : calculateNetValue(source.openingQuantity, inventory.cost(opening.unitCost));
      if (source.openingNetValue == null) issue("opening-cost-unknown", "The positive opening quantity has no explicit net cost.");
    } catch { issue("opening-cost-unknown", "The opening quantity or its explicit net cost is unavailable or outside supported precision."); }
  }
  if (!Array.isArray(movements) || movements.length > MAX_SOURCES) {
    issue("source-window-exceeded", "The complete movement window exceeds the supported 1,000 postings."); return unavailable(context, reasons, source);
  }
  const quantities = [], values = [];
  for (const movement of movements) {
    if (!movement || typeof movement !== "object" || Array.isArray(movement)) { issue("movement-needs-reconciliation", "A recorded movement is malformed."); continue; }
    const manual = MANUAL_KINDS.has(movement.kind) || movement.kind === "adjustment_reversal";
    if (movement.inventoryPolicyVersion !== 1 || movement.hotelUid !== context.hotelUid || movement.locationId !== context.locationId
      || !Number.isSafeInteger(movement.sequence) || movement.sequence <= anchor.sequence || movement.sequence > context.postingCutoffSequence
      || !["receipt", "reversal"].includes(movement.kind) && !manual || manual && movement.inventoryAdjustmentPolicyVersion !== 1
      || !Array.isArray(movement.lines) || movement.lines.length > 100 || manual && movement.lines.length !== 1
      || movement.lines.some((line) => !line || typeof line !== "object" || Array.isArray(line))
      || !Array.isArray(movement.coverageGaps || []) || (movement.coverageGaps || []).length > 100) {
      issue("movement-needs-reconciliation", "A recorded movement has an inconsistent scope, policy, category or posting cutoff."); continue;
    }
    if (!validDate(movement.receivedOn)) { issue("source-date-unknown", "A recorded movement has no reliable business date."); continue; }
    // A known later business date is outside the requested estimate, even when
    // its posting was already present. Sequence reconciliation still includes it.
    if (movement.receivedOn > context.businessDate) continue;
    if (movement.receivedOn < anchor.businessDate || movement.backdatedAgainstCheckpoint) issue("backdated-source", "A movement was posted against an already counted or earlier business date; reconcile its physical cutoff.");
    for (const gap of movement.coverageGaps || []) issue("receipt-coverage-gap", gap?.reason || "An accepted receipt has unverified inventory coverage.");
    const originalKind = movement.kind === "adjustment_reversal" ? movement.originalKind : movement.kind;
    if (movement.kind === "adjustment_reversal" && !MANUAL_KINDS.has(originalKind)) { issue("movement-needs-reconciliation", "A manual reversal has an unknown original category."); continue; }
    const direction = (["receipt", "transfer_in"].includes(originalKind) ? 1 : -1) * (movement.kind === "adjustment_reversal" ? -1 : 1);
    if (movement.lines.some((line) => line.catalogProductId === context.catalogProductId)) source.movementCount++;
    for (const line of movement.lines) {
      if (line.catalogProductId !== context.catalogProductId) continue;
      if (line.baseUnit !== context.baseUnit) issue("source-unit-mismatch", "A movement unit differs from the target catalog unit.");
      try {
        const quantity = bounded(line.quantity, true);
        if (quantity * direction < 0 || manual && quantity === 0) throw new Error("Movement direction differs from its frozen category.");
        quantities.push(quantity);
        if (quantity !== 0 && (line.currency !== context.currency || line.netValue == null)) {
          issue("movement-cost-unknown", "A relevant movement lacks an explicit net value in the target currency."); continue;
        }
        const value = quantity === 0 && line.netValue == null ? 0 : bounded(line.netValue, true);
        if (value * direction < 0 || quantity === 0 && value !== 0) throw new Error("Movement value differs from its frozen direction.");
        values.push(value);
      } catch { issue("movement-needs-reconciliation", "A relevant movement quantity or frozen net value is inconsistent."); }
    }
  }
  try {
    source.recordedMovementQuantity = add(quantities);
    source.recordedMovementNetValue = reasons.some((item) => item.code === "movement-cost-unknown") ? null : add(values);
    source.weightedSourceQuantity = source.openingQuantity == null ? null : add([source.openingQuantity, source.recordedMovementQuantity]);
    source.weightedSourceNetValue = source.openingNetValue == null || source.recordedMovementNetValue == null ? null : add([source.openingNetValue, source.recordedMovementNetValue]);
  } catch { issue("source-value-outside-bound", "Aggregated source quantities or net values exceed supported precision or bounds."); }
  if (source.weightedSourceQuantity != null && source.weightedSourceQuantity <= 0) issue("no-positive-source-quantity", "A positive recorded source quantity is needed to suggest a weighted cost.");
  if (source.weightedSourceNetValue != null && source.weightedSourceNetValue < 0) issue("negative-source-value", "Recorded outflows exceed the valued source pool; reconcile before suggesting a cost.");
  if (reasons.length || source.weightedSourceQuantity == null || source.weightedSourceNetValue == null) return unavailable(context, reasons, source);
  const exactCost = source.weightedSourceNetValue / source.weightedSourceQuantity;
  const netUnitCost = Math.round(exactCost * MICROS) / MICROS;
  if (!Number.isFinite(netUnitCost) || netUnitCost > 1000000 || exactCost > 0 && netUnitCost === 0) {
    issue("suggested-cost-outside-bound", "The weighted unit cost is outside the supported cost precision or bound."); return unavailable(context, reasons, source);
  }
  return { ...context, costProposalPolicyVersion: COST_PROPOSAL_POLICY_VERSION, status: "available", available: true,
    netUnitCost, source, reasons: [], costBasis: COST_BASIS };
}
module.exports = { COST_PROPOSAL_POLICY_VERSION, COST_BASIS, MAX_SOURCES, proposal, unavailable, reason };
