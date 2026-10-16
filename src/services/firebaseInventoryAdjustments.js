import { auth, functions, httpsCallable } from "../firebaseConfig";
import { invalidateProcurementReads, poolProcurementRead, procurementReadScope } from "./procurementReadPool";

const kinds = ["transfer", "waste", "physical_return"];
const units = ["g", "kg", "ml", "l", "each"];
const decimal = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1000000
  && /^\d+(\.\d{1,6})?$/.test(String(value));
const identifier = (value) => typeof value === "string" && Boolean(value.trim()) && value.length <= 128 && !value.includes("/");
const businessDate = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};
const nullableCurrency = (value) => value === null || /^[A-Z]{3}$/.test(value || "");
function requireHotel(hotelUid) {
  if (!identifier(hotelUid)) throw new Error("A valid selected hotel is required.");
}
function validInput(operation, input) {
  if (!input || !identifier(input.hotelUid) || !businessDate(input.businessDate)
    || typeof input.note !== "string" || !input.note.trim() || input.note.length > 1000
    || typeof input.reference !== "string" || !input.reference.trim() || input.reference.length > 128) return false;
  if (operation === "reverse") return identifier(input.adjustmentId);
  return operation === "record" && (input.movementType == null || input.kind === "transfer" && ["transfer", "requisition"].includes(input.movementType)) && kinds.includes(input.kind) && identifier(input.catalogProductId)
    && identifier(input.sourceLocationId) && decimal(input.quantity) && input.quantity > 0
    && (input.kind !== "transfer" || identifier(input.destinationLocationId) && input.destinationLocationId !== input.sourceLocationId)
    && (input.kind !== "waste" || ["waste", "breakage"].includes(input.reasonType))
    && (input.netUnitCost === null && input.currency === null || decimal(input.netUnitCost) && /^[A-Z]{3}$/.test(input.currency || ""));
}
function commandKey(hotelUid) {
  requireHotel(hotelUid);
  const actorUid = auth.currentUser?.uid;
  if (!actorUid) throw new Error("A signed-in hotel user is required.");
  return `inventory-adjustment-command:${actorUid}:${hotelUid}`;
}
export function getPendingInventoryAdjustment(hotelUid) {
  if (!hotelUid || !auth.currentUser?.uid) return null;
  const raw = sessionStorage.getItem(commandKey(hotelUid));
  if (!raw) return null;
  try {
    const pending = JSON.parse(raw);
    if (pending.actorUid !== auth.currentUser.uid || pending.input?.hotelUid !== hotelUid
      || !validInput(pending.operation, pending.input) || !/^[a-f0-9-]{36}$/i.test(pending.requestId || "")) throw new Error("Invalid saved request");
    return pending;
  } catch {
    throw new Error("The saved movement request cannot be read. Review its outcome before replacing it; no new request was created.");
  }
}
function validResult(operation, input, pending, data) {
  return data?.hotelUid === input.hotelUid && data.inventoryAdjustmentPolicyVersion === 1
    && data.actorUid === pending.actorUid && data.requestId === pending.requestId
    && Array.isArray(data.movementIds) && data.movementIds.length >= 1 && data.movementIds.length <= 2 && data.movementIds.every(identifier)
    && (operation === "record" ? identifier(data.adjustmentId) && data.kind === input.kind && data.businessDate === input.businessDate
      : data.originalAdjustmentId === input.adjustmentId && identifier(data.reversalAdjustmentId));
}
async function execute(operation, input) {
  if (!validInput(operation, input)) throw new Error("Enter a valid business date, reference, reason, product, locations and positive catalog quantity. Optional cost needs an explicit currency.");
  const key = commandKey(input.hotelUid), scope = procurementReadScope(input.hotelUid);
  let pending = getPendingInventoryAdjustment(input.hotelUid);
  if (pending && (pending.operation !== operation || JSON.stringify(pending.input) !== JSON.stringify(input))) {
    throw new Error("The previous movement has an uncertain outcome. Retry the original saved request before recording another movement.");
  }
  if (!pending) {
    pending = { operation, actorUid: auth.currentUser.uid, input, requestId: crypto.randomUUID() };
    try { sessionStorage.setItem(key, JSON.stringify(pending)); }
    catch { throw new Error("This browser could not preserve the movement request. No request was sent. Check browser storage before continuing."); }
  }
  try {
    if (auth.currentUser?.uid !== pending.actorUid || scope && !scope.current()) throw new Error("Hotel access changed before recording. The original saved request was retained.");
    const { data } = await httpsCallable(functions, operation === "record" ? "recordHotelInventoryAdjustment" : "reverseHotelInventoryAdjustment")({ ...pending.input, requestId: pending.requestId, expectedActorUid: pending.actorUid });
    if (!validResult(operation, input, pending, data)) throw new Error("The movement result could not be verified. Retry the original saved request.");
    sessionStorage.removeItem(key);
    if (scope && !scope.current()) throw new Error("Hotel access changed while recording. Reload the selected hotel's movement history.");
    return data;
  } catch (error) {
    if (error?.details?.inventoryAdjustmentRequestUncommitted === true) sessionStorage.removeItem(key);
    throw error;
  } finally { invalidateProcurementReads(input.hotelUid); }
}
export const recordInventoryAdjustment = (input) => execute("record", input);
export const reverseInventoryAdjustment = (input) => execute("reverse", input);
export function retryPendingInventoryAdjustment(hotelUid) {
  const pending = getPendingInventoryAdjustment(hotelUid);
  if (!pending) throw new Error("No pending movement request is available.");
  return execute(pending.operation, pending.input);
}

export async function getInventoryAdjustmentChoices(hotelUid, kind, afterId = null, query = "") {
  requireHotel(hotelUid);
  if (!["locations", "catalogproducts"].includes(kind) || afterId !== null && !identifier(afterId) || typeof query !== "string" || query.length > 200) throw new Error("Invalid movement source selection.");
  const prefix = query.trim().toLowerCase();
  return poolProcurementRead(hotelUid, `movement-choices:${kind}:${afterId || "first"}:${prefix}`, async () => {
    const { data } = await httpsCallable(functions, "listHotelInventoryAdjustmentChoices")({ hotelUid, kind, afterId, query: prefix });
    if (data?.hotelUid !== hotelUid || data.kind !== kind || data.inventoryAdjustmentPolicyVersion !== 1
      || data.query !== undefined && data.query !== prefix
      || !nullableCurrency(data.hotelCurrency) || !Array.isArray(data.choices) || data.choices.length > 50
      || data.choices.some((choice) => !identifier(choice.id) || typeof choice.name !== "string" || !choice.name.trim()
        || kind === "catalogproducts" && !units.includes(choice.baseUnit))
      || !(data.nextCursor === null || identifier(data.nextCursor)) || afterId !== null && data.nextCursor === afterId) {
      throw new Error("Movement source response scope, currency or pagination is invalid.");
    }
    return data;
  });
}
export async function getInventoryAdjustments(hotelUid, afterAdjustmentId = null, adjustmentId = null) {
  requireHotel(hotelUid);
  if (afterAdjustmentId !== null && !identifier(afterAdjustmentId)) throw new Error("Invalid movement history cursor.");
  if (adjustmentId !== null && (!identifier(adjustmentId) || afterAdjustmentId !== null)) throw new Error("Invalid movement review reference.");
  return poolProcurementRead(hotelUid, `movement-history:${afterAdjustmentId || "first"}:${adjustmentId || "all"}`, async () => {
    const { data } = await httpsCallable(functions, "listHotelInventoryAdjustments")({ hotelUid, afterAdjustmentId, ...(adjustmentId ? { adjustmentId } : {}) });
    if (data?.hotelUid !== hotelUid || data.inventoryAdjustmentPolicyVersion !== 1 || !Array.isArray(data.adjustments) || data.adjustments.length > 50
      || data.adjustments.some((event) => !identifier(event.adjustmentId) || ![...kinds, "reversal"].includes(event.kind)
        || !businessDate(event.businessDate) || !identifier(event.catalogProductId) || !units.includes(event.baseUnit)
        || !decimal(event.quantity) || event.quantity <= 0 || !identifier(event.sourceLocationId) || !identifier(event.actorUid)
        || typeof event.catalogProductName !== "string" || typeof event.sourceLocationName !== "string"
        || event.netValue !== null && (typeof event.netValue !== "number" || !Number.isFinite(event.netValue) || event.netValue < 0)
        || !nullableCurrency(event.currency) || event.netUnitCost !== null && !decimal(event.netUnitCost)
        || event.postedAtMillis !== null && !Number.isFinite(event.postedAtMillis))
      || !(data.nextCursor === null || identifier(data.nextCursor)) || afterAdjustmentId !== null && data.nextCursor === afterAdjustmentId
      || adjustmentId && (data.requestedAdjustmentId !== adjustmentId || data.adjustments.length !== 1 || data.adjustments[0].adjustmentId !== adjustmentId || data.nextCursor !== null)) {
      throw new Error("Movement history response scope, policy or pagination is invalid.");
    }
    return data;
  });
}
