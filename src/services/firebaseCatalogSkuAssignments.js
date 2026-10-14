import { auth, functions, httpsCallable } from "../firebaseConfig";
import { invalidateProcurementReads, procurementReadScope } from "./procurementReadPool";
const validId = (value) => typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 128 && !/[\\/\u0000-\u001f]/.test(value);
const validRevision = (value) => Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER;
const key = (hotelUid, uid = auth.currentUser?.uid) => `catalog-sku-assignment:${uid}:${hotelUid}`;
function payload(input) {
  if (!validRevision(input?.expectedSettingsRevision) || !Array.isArray(input.products) || !input.products.length || input.products.length > 25
    || input.products.some((product) => !product || typeof product !== "object" || Array.isArray(product) || !validId(product.productId) || !validRevision(product.expectedRevision))
    || new Set(input.products.map((product) => product.productId)).size !== input.products.length) throw new Error("Select up to 25 current Catalog Products without internal SKUs.");
  return { expectedSettingsRevision: input.expectedSettingsRevision, products: input.products.map(({ productId, expectedRevision }) => ({ productId, expectedRevision })) };
}
export function getPendingCatalogSkuAssignment(hotelUid) {
  if (!hotelUid || !auth.currentUser?.uid) return null;
  const saved = sessionStorage.getItem(key(hotelUid));
  if (!saved) return null;
  let pending;
  try { pending = JSON.parse(saved); } catch { throw new Error("The original SKU assignment could not be verified."); }
  if (!pending || typeof pending !== "object" || Array.isArray(pending) || pending.hotelUid !== hotelUid || pending.actorUid !== auth.currentUser.uid || !validId(pending.requestId)) throw new Error("The original SKU assignment belongs to another hotel or account.");
  return { hotelUid, actorUid: pending.actorUid, requestId: pending.requestId, ...payload(pending) };
}
export async function assignCatalogSkus(hotelUid, input) {
  const actor = auth.currentUser, scope = procurementReadScope(hotelUid), normalized = payload(input);
  if (!actor?.uid || !validId(hotelUid) || !scope) throw new Error("Sign in and select a hotel before assigning internal SKUs.");
  const current = () => auth.currentUser === actor && scope.current();
  const assertCurrent = () => { if (!current()) throw new Error("Hotel access changed. Verify the original SKU assignment with the original account."); };
  const previous = getPendingCatalogSkuAssignment(hotelUid);
  if (previous && JSON.stringify(payload(previous)) !== JSON.stringify(normalized)) throw new Error("Verify the original SKU assignment before changing its selection.");
  const pending = previous || { hotelUid, actorUid: actor.uid, requestId: crypto.randomUUID(), ...normalized };
  sessionStorage.setItem(key(hotelUid, actor.uid), JSON.stringify(pending));
  try {
    assertCurrent();
    const { data } = await httpsCallable(functions, "assignHotelCatalogSkus")({ hotelUid, requestId: pending.requestId, ...normalized });
    assertCurrent();
    if (data?.hotelUid !== hotelUid || data.requestId !== pending.requestId || data.settingsRevision !== normalized.expectedSettingsRevision + 1
      || !Array.isArray(data.assigned) || data.assigned.length !== normalized.products.length || data.assigned.some((row, index) => !row || row.productId !== normalized.products[index].productId
        || row.revision !== normalized.products[index].expectedRevision + 1 || typeof row.internalSku !== "string" || !/^[A-Z0-9_-]{1,100}$/.test(row.internalSku))
      || new Set(data.assigned.map((row) => row.internalSku)).size !== data.assigned.length) throw new Error("The assigned SKUs could not be verified. Retry the original selection.");
    const assigned = data.assigned.map(({ productId, revision, internalSku }) => ({ productId, revision, internalSku }));
    sessionStorage.removeItem(key(hotelUid, actor.uid)); invalidateProcurementReads(hotelUid);
    return { hotelUid, requestId: pending.requestId, assigned, settingsRevision: data.settingsRevision };
  } catch (error) {
    if (current() && error?.details?.catalogSkuRequestUncommitted === true) sessionStorage.removeItem(key(hotelUid, actor.uid));
    throw error;
  }
}
export function retryCatalogSkuAssignment(hotelUid) {
  const pending = getPendingCatalogSkuAssignment(hotelUid);
  if (!pending) throw new Error("No original SKU assignment is available.");
  return assignCatalogSkus(hotelUid, payload(pending));
}
