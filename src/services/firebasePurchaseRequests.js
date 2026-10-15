import { auth, functions, httpsCallable } from "../firebaseConfig";
import { invalidateProcurementReads, procurementReadScope } from "./procurementReadPool";

const pending = new WeakMap();
const validId = (value) => typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\/\u0000-\u001f]/.test(value);
const clean = (value) => JSON.parse(JSON.stringify(value));
const message = (failure) => String(failure?.message || "The purchase request could not be verified. Try again.").replace(/^Firebase:\s*/i, "").slice(0, 1000);

function capture(hotelUid) {
  const actor = auth.currentUser, scope = procurementReadScope(hotelUid);
  if (!validId(hotelUid) || !actor?.uid || !scope) throw new Error("Sign in and select a hotel before opening purchase requests.");
  const assert = () => { if (auth.currentUser !== actor || !scope.current()) throw new Error("Your hotel access changed. Reopen this view with the authorized account."); };
  return { actor, assert, current: () => auth.currentUser === actor && scope.current() };
}
const storageKey = (hotelUid, resource) => `purchase-request:v1:${auth.currentUser?.uid}:${hotelUid}:${resource}`;
function read(hotelUid, resource) {
  const actor = auth.currentUser;
  if (!actor?.uid || !hotelUid) return null;
  if (!pending.has(actor)) pending.set(actor, new Map());
  const key = storageKey(hotelUid, resource);
  let value = pending.get(actor).get(key);
  if (!value) {
    let raw; try { raw = sessionStorage.getItem(key); } catch { throw new Error("Browser session storage is unavailable. Restore it to reconcile any earlier purchase request command before making another change."); }
    if (!raw) return null;
    try { value = JSON.parse(raw); } catch { throw new Error("The saved purchase request command is unreadable. Ask an administrator to reconcile it."); }
  }
  if (value.version !== 1 || !validId(value.requestId) || value.hotelUid !== hotelUid || value.actorUid !== actor.uid || value.resource !== resource || !value.input || typeof value.endpoint !== "string") throw new Error("The saved purchase request command could not be verified. Reconcile it before making another change.");
  pending.get(actor).set(key, value);
  return clean(value);
}
function write(hotelUid, resource, value) {
  const actor = auth.currentUser, key = storageKey(hotelUid, resource);
  const serialized = JSON.stringify(value);
  try {
    const existing = sessionStorage.getItem(key);
    if (existing != null && existing !== serialized) throw new Error("A different saved purchase request command needs reconciliation.");
    sessionStorage.setItem(key, serialized);
    if (sessionStorage.getItem(key) !== serialized) throw new Error("The command reference could not be verified.");
  } catch { throw new Error("Enable browser session storage before changing this request. Its exact command reference could not be saved and no command was sent."); }
  if (!pending.has(actor)) pending.set(actor, new Map());
  pending.get(actor).set(key, value);
}
function remove(hotelUid, resource) {
  pending.get(auth.currentUser)?.delete(storageKey(hotelUid, resource));
  try { sessionStorage.removeItem(storageKey(hotelUid, resource)); } catch { /* In-view recovery has completed. */ }
}
async function invoke(endpoint, hotelUid, input, operation) {
  operation.assert();
  try {
    const { data } = await httpsCallable(functions, endpoint)({ ...input, hotelUid });
    operation.assert();
    if (!data || typeof data !== "object" || data.hotelUid !== hotelUid) throw new Error("The response belongs to another hotel or could not be verified.");
    return data;
  } catch (failure) { operation.assert(); throw Object.assign(new Error(message(failure)), { code: failure?.code, details: failure?.details }); }
}
async function query(endpoint, hotelUid, input = {}) { return invoke(endpoint, hotelUid, input, capture(hotelUid)); }
async function command(endpoint, hotelUid, resource, input) {
  const operation = capture(hotelUid);
  const normalized = clean(input), suppliedId = normalized.requestId;
  delete normalized.requestId;
  let saved = read(hotelUid, resource);
  if (saved && (saved.endpoint !== endpoint || JSON.stringify(saved.input) !== JSON.stringify(normalized))) throw new Error("The previous result is uncertain. Recover the original command before changing this request.");
  if (!saved) {
    if (suppliedId != null && !validId(suppliedId)) throw new Error("Use a valid unique command reference.");
    saved = { version: 1, hotelUid, actorUid: operation.actor.uid, resource, endpoint, requestId: suppliedId || crypto.randomUUID(), input: normalized };
  }
  write(hotelUid, resource, saved);
  try {
    const value = await invoke(endpoint, hotelUid, { ...saved.input, requestId: saved.requestId }, operation);
    if (value.requestId !== saved.requestId || (normalized.purchaseRequestId && value.purchaseRequestId !== normalized.purchaseRequestId && value.request?.id !== normalized.purchaseRequestId)) throw new Error("The command acknowledgement could not be verified. Recover the original command.");
    if (endpoint === "mutateHotelPurchaseRequest" && (!validId(value.purchaseRequestId) || value.request?.id !== value.purchaseRequestId || value.request.hotelUid !== hotelUid || !Number.isSafeInteger(value.revision) || value.revision < 1 || value.request.revision !== value.revision)) throw new Error("The saved request acknowledgement could not be verified. Recover the original command.");
    operation.assert(); remove(hotelUid, resource); return value;
  } catch (failure) {
    if (operation.current() && failure.details?.purchaseRequestUncommitted === true) remove(hotelUid, resource);
    throw failure;
  } finally { invalidateProcurementReads(hotelUid); }
}
function retry(hotelUid, resource) {
  const saved = read(hotelUid, resource);
  if (!saved) return Promise.reject(new Error("No uncertain purchase request command is available."));
  return command(saved.endpoint, hotelUid, resource, { ...saved.input, requestId: saved.requestId });
}

export const getPurchaseRequestContext = (hotelUid, options = {}) => query("getHotelPurchaseRequestContext", hotelUid, options);
export const listPurchaseRequests = (hotelUid, filters = {}) => query("listHotelPurchaseRequests", hotelUid, filters);
export const getPurchaseRequest = async (hotelUid, purchaseRequestId, options = {}) => {
  const value = await query("getHotelPurchaseRequest", hotelUid, { ...options, purchaseRequestId });
  if (value.request?.id !== purchaseRequestId || (value.request.hotelUid != null && value.request.hotelUid !== hotelUid)) throw new Error("The response belongs to another purchase request.");
  return value;
};
export const mutatePurchaseRequest = (hotelUid, input) => command("mutateHotelPurchaseRequest", hotelUid, input.purchaseRequestId || "create", input);
export const getPendingPurchaseRequestCommand = (hotelUid, resource = "create") => read(hotelUid, resource);
export const retryPurchaseRequestCommand = (hotelUid, resource = "create") => retry(hotelUid, resource);
export const getPurchaseRequestSettings = (hotelUid) => query("getHotelPurchaseRequestSettings", hotelUid);
export const savePurchaseRequestSettings = (hotelUid, input) => command("saveHotelPurchaseRequestSettings", hotelUid, "settings", input);
export const getPendingPurchaseRequestSettingsCommand = (hotelUid) => read(hotelUid, "settings");
export const retryPurchaseRequestSettingsCommand = (hotelUid) => retry(hotelUid, "settings");
export const getPurchaseBudgets = (hotelUid, year) => query("getHotelPurchaseBudgets", hotelUid, { year });
export const savePurchaseBudgets = (hotelUid, input) => command("saveHotelPurchaseBudgets", hotelUid, "budgets", input);
export const getPendingPurchaseBudgetCommand = (hotelUid) => read(hotelUid, "budgets");
export const retryPurchaseBudgetCommand = (hotelUid) => retry(hotelUid, "budgets");
