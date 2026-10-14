import { auth, functions, httpsCallable } from "../firebaseConfig";
import { invalidateProcurementReads, poolProcurementRead, procurementReadScope } from "./procurementReadPool";

const validId = (value) => typeof value === "string" && value.length > 0 && value.length <= 128 && value.trim() === value && !/[\\/\u0000-\u001f]/.test(value);
const validRevision = (value) => Number.isSafeInteger(value) && value >= 0;
export function normalizeCatalogSkuSettings(value) {
  if (!value || typeof value.enabled !== "boolean" || typeof value.prefix !== "string" || !/^[A-Z0-9_-]{0,20}$/.test(value.prefix)
    || !Number.isInteger(value.padding) || value.padding < 1 || value.padding > 12
    || !Number.isSafeInteger(value.nextNumber) || value.nextNumber < 1) throw new Error("Choose valid automatic SKU settings.");
  return { enabled: value.enabled, prefix: value.prefix, padding: value.padding, nextNumber: value.nextNumber };
}
const storageKey = (hotelUid, uid = auth.currentUser?.uid) => `catalog-sku-settings:${uid}:${hotelUid}`;
function capture(hotelUid) {
  const actor = auth.currentUser, scope = procurementReadScope(hotelUid);
  if (!actor?.uid || !validId(hotelUid) || !scope) throw new Error("Sign in and select a hotel before changing SKU settings.");
  const current = () => auth.currentUser === actor && scope.current();
  return { actor, current, assertCurrent: () => { if (!current()) throw new Error("Hotel access changed. Reopen SKU settings with the original account."); } };
}
function project(data, hotelUid) {
  if (data?.hotelUid !== hotelUid || data.policyVersion !== 1 || !validRevision(data.revision)) throw new Error("The hotel SKU settings could not be verified.");
  return { hotelUid, policyVersion: 1, revision: data.revision, ...normalizeCatalogSkuSettings(data) };
}
export function getPendingCatalogSkuSettings(hotelUid) {
  if (!hotelUid || !auth.currentUser?.uid) return null;
  const saved = sessionStorage.getItem(storageKey(hotelUid));
  if (!saved) return null;
  let pending;
  try { pending = JSON.parse(saved); } catch { throw new Error("The original SKU settings request could not be verified."); }
  if (pending.hotelUid !== hotelUid || pending.actorUid !== auth.currentUser.uid || !validId(pending.requestId)
    || !validRevision(pending.expectedRevision)) throw new Error("The original SKU settings request could not be verified.");
  return { hotelUid, actorUid: pending.actorUid, requestId: pending.requestId, expectedRevision: pending.expectedRevision,
    settings: normalizeCatalogSkuSettings(pending.settings) };
}
export function getCatalogSkuSettings(hotelUid) {
  const captured = capture(hotelUid);
  return poolProcurementRead(hotelUid, "catalog-sku-settings", async () => {
    const { data } = await httpsCallable(functions, "getHotelCatalogSkuSettings")({ hotelUid });
    captured.assertCurrent();
    return project(data, hotelUid);
  });
}
export async function saveCatalogSkuSettings(hotelUid, settings, { expectedRevision } = {}) {
  const captured = capture(hotelUid), normalized = normalizeCatalogSkuSettings(settings);
  if (!validRevision(expectedRevision)) throw new Error("Refresh the hotel SKU settings before saving.");
  const existing = getPendingCatalogSkuSettings(hotelUid);
  if (existing && (existing.expectedRevision !== expectedRevision || JSON.stringify(existing.settings) !== JSON.stringify(normalized))) {
    throw new Error("Verify the original SKU settings request before making another change.");
  }
  const pending = existing || { hotelUid, actorUid: captured.actor.uid, requestId: crypto.randomUUID(), expectedRevision, settings: normalized };
  sessionStorage.setItem(storageKey(hotelUid, captured.actor.uid), JSON.stringify(pending));
  try {
    captured.assertCurrent();
    const { data } = await httpsCallable(functions, "saveHotelCatalogSkuSettings")({ hotelUid, requestId: pending.requestId, expectedRevision, settings: normalized });
    captured.assertCurrent();
    const result = project(data, hotelUid);
    if (data.requestId !== pending.requestId || result.revision !== expectedRevision + 1
      || JSON.stringify(normalizeCatalogSkuSettings(result)) !== JSON.stringify(normalized)) throw new Error("The saved SKU settings could not be verified. Retry the original request.");
    sessionStorage.removeItem(storageKey(hotelUid, captured.actor.uid));
    invalidateProcurementReads(hotelUid);
    return result;
  } catch (error) {
    if (captured.current() && error?.details?.catalogSkuRequestUncommitted === true) sessionStorage.removeItem(storageKey(hotelUid, captured.actor.uid));
    throw error;
  }
}
export function retryCatalogSkuSettings(hotelUid) {
  const pending = getPendingCatalogSkuSettings(hotelUid);
  if (!pending) throw new Error("No original SKU settings request is available.");
  return saveCatalogSkuSettings(hotelUid, pending.settings, { expectedRevision: pending.expectedRevision });
}
