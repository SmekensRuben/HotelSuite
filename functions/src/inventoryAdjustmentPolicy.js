const { HttpsError } = require("firebase-functions/v2/https");
const { requireDocumentId } = require("./subscriptions");
const { text } = require("./validation");
const inventory = require("./inventoryPolicy");
const { calculateNetValue } = require("./productPolicy");

const INVENTORY_ADJUSTMENT_POLICY_VERSION = 1;
const MANUAL_KINDS = new Set(["transfer_in", "transfer_out", "waste", "breakage", "physical_return"]);
function object(input, fields) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).some((field) => !fields.includes(field))) {
    throw new HttpsError("invalid-argument", "Unsupported inventory adjustment input.");
  }
  return input;
}
function record(input) {
  object(input, ["hotelUid", "requestId", "expectedActorUid", "kind", "catalogProductId", "quantity", "sourceLocationId", "destinationLocationId", "businessDate", "note", "reference", "reasonType", "netUnitCost", "currency"]);
  if (!["transfer", "waste", "physical_return"].includes(input.kind)) throw new HttpsError("invalid-argument", "Choose transfer, waste or physical return.");
  const quantity = inventory.amount(input.quantity, "Adjustment quantity");
  if (quantity <= 0) throw new HttpsError("invalid-argument", "Adjustment quantity must be positive.");
  const sourceLocationId = requireDocumentId(input.sourceLocationId, "sourceLocationId");
  const destinationLocationId = input.kind === "transfer" ? requireDocumentId(input.destinationLocationId, "destinationLocationId") : null;
  if (input.kind !== "transfer" && input.destinationLocationId != null) throw new HttpsError("invalid-argument", "Only transfers may have a destination location.");
  if (destinationLocationId === sourceLocationId) throw new HttpsError("invalid-argument", "A transfer needs two different physical locations.");
  if (input.kind === "waste" ? !["waste", "breakage"].includes(input.reasonType) : input.reasonType != null) {
    throw new HttpsError("invalid-argument", "Waste entries require an explicit waste or breakage reason type.");
  }
  const netUnitCost = inventory.cost(input.netUnitCost, "Net unit cost");
  const currency = input.currency == null ? null : inventory.currency(input.currency);
  if (netUnitCost != null && currency == null) throw new HttpsError("invalid-argument", "An explicit currency is required with a net unit cost.");
  return { hotelUid: requireDocumentId(input.hotelUid, "hotelUid"), requestId: requireDocumentId(input.requestId, "requestId"), expectedActorUid: requireDocumentId(input.expectedActorUid, "expectedActorUid"),
    kind: input.kind, catalogProductId: requireDocumentId(input.catalogProductId, "catalogProductId"), quantity,
    sourceLocationId, destinationLocationId, reasonType: input.kind === "waste" ? input.reasonType : null,
    businessDate: inventory.businessDate(input.businessDate), note: text(input.note, "Note", 1000, true),
    reference: text(input.reference, "Reference", 200, true), netUnitCost, currency,
    netValue: calculateNetValue(quantity, netUnitCost) };
}
function reverse(input) {
  object(input, ["hotelUid", "requestId", "expectedActorUid", "adjustmentId", "businessDate", "note", "reference"]);
  return { hotelUid: requireDocumentId(input.hotelUid, "hotelUid"), requestId: requireDocumentId(input.requestId, "requestId"), expectedActorUid: requireDocumentId(input.expectedActorUid, "expectedActorUid"),
    adjustmentId: requireDocumentId(input.adjustmentId, "adjustmentId"), businessDate: inventory.businessDate(input.businessDate),
    note: text(input.note, "Reversal note", 1000, true), reference: text(input.reference, "Reversal reference", 200, true) };
}
module.exports = { INVENTORY_ADJUSTMENT_POLICY_VERSION, MANUAL_KINDS, object, record, reverse };
