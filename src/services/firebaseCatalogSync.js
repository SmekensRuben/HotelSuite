import { auth, functions, httpsCallable } from "../firebaseConfig";
import { reportPurchasingError } from "./firebasePurchasingTelemetry";
import { procurementReadScope, invalidateProcurementReads } from "./procurementReadPool";
import { catalogSyncId as id, catalogSyncRevision as revision, catalogSyncMessage, catalogSyncChoices, projectCatalogSyncWorkspace } from "../utils/catalogSyncWorkspace";

const memory = new WeakMap();
function capture(hotelUid) {
  const actor = auth.currentUser, scope = procurementReadScope(hotelUid);
  if (!actor?.uid || !id(hotelUid) || !scope) throw new Error("Sign in and select a hotel before synchronizing catalog articles.");
  return { actor, current: () => auth.currentUser === actor && scope.current(), assert: () => { if (auth.currentUser !== actor || !scope.current()) throw new Error("Hotel access changed. Reopen this review with the original authorized account."); } };
}
function key(hotelUid, resource) { if (!auth.currentUser?.uid) throw new Error("Sign in to recover a catalog sync request."); return `catalog-sync:${auth.currentUser.uid}:${hotelUid}:${resource}`; }
function read(keyName) {
  if (!memory.has(auth.currentUser)) memory.set(auth.currentUser, new Map());
  const cached = memory.get(auth.currentUser).get(keyName);
  if (cached) return cached;
  let saved; try { saved = sessionStorage.getItem(keyName); } catch { return null; }
  if (!saved) return null;
  let value; try { value = JSON.parse(saved); } catch { throw new Error("The saved catalog sync reference could not be verified. Ask your hotel administrator to reconcile it."); }
  if (value.version !== 1 || !id(value.requestId)) throw new Error("The saved catalog sync request is invalid. Reconcile it before starting another operation.");
  memory.get(auth.currentUser).set(keyName, value); return value;
}
function write(keyName, value) { if (!memory.has(auth.currentUser)) memory.set(auth.currentUser, new Map()); memory.get(auth.currentUser).set(keyName, value); try { sessionStorage.setItem(keyName, JSON.stringify(value)); } catch { /* The open view still retains exact retry identity. */ } }
function remove(keyName) { memory.get(auth.currentUser)?.delete(keyName); try { sessionStorage.removeItem(keyName); } catch { /* In-view reconciliation is still complete. */ } }
async function invoke(endpoint, hotelUid, payload, operation) {
  operation.assert();
  try { const { data } = await httpsCallable(functions, endpoint)({ hotelUid, ...payload }); operation.assert(); if (data?.hotelUid !== hotelUid || (payload.jobId && data.jobId !== payload.jobId)) throw new Error("The catalog sync response belongs to another hotel or review."); return data; }
  catch (failure) { operation.assert(); reportPurchasingError(hotelUid, "catalog-sync", failure); throw Object.assign(new Error(catalogSyncMessage(failure?.message)), { code: failure?.code, details: failure?.details }); }
}
const sessionResource = (supplierId) => `workspace:${encodeURIComponent(supplierId || "all")}`;
export function getCatalogSyncRecovery(hotelUid, supplierId = null) {
  if (!hotelUid || !auth.currentUser?.uid) return null;
  const storageKey = key(hotelUid, sessionResource(supplierId)), saved = read(storageKey);
  if (!saved) return null;
  if ((saved.jobId != null && !id(saved.jobId)) || (saved.pendingRefinementJobId != null && !id(saved.pendingRefinementJobId))) throw new Error("The saved catalog sync workspace reference is invalid.");
  if (saved.pendingRefinementJobId && !getPendingCatalogSyncRefinement(hotelUid, saved.pendingRefinementJobId)) { const resolved = { ...saved }; delete resolved.pendingRefinementJobId; write(storageKey, resolved); return resolved; }
  return saved;
}
export async function readCatalogSyncWorkspace(hotelUid, { supplierId = null, cursor = null, fresh = false } = {}) {
  if ((supplierId != null && !id(supplierId)) || (cursor != null && !id(cursor))) throw new Error("Choose a valid supplier and source page.");
  const operation = capture(hotelUid), storageKey = key(hotelUid, sessionResource(supplierId));
  let saved = getCatalogSyncRecovery(hotelUid, supplierId);
  if (fresh && saved && !saved.jobId) throw new Error("Recover the original preview request before starting another review.");
  if (fresh && saved?.jobId && getPendingCatalogSyncApply(hotelUid, saved.jobId)) throw new Error("Recover the original catalog sync operation before starting a fresh review.");
  if (!saved || fresh) { const pendingRefinementJobId = saved?.pendingRefinementJobId || (saved?.jobId && getPendingCatalogSyncRefinement(hotelUid, saved.jobId) ? saved.jobId : null); saved = { version: 1, requestId: crypto.randomUUID(), supplierId, cursor, ...(pendingRefinementJobId ? { pendingRefinementJobId } : {}) }; write(storageKey, saved); }
  const input = saved.jobId ? { jobId: saved.jobId } : { requestId: saved.requestId, supplierId: saved.supplierId, cursor: saved.cursor, limit: 25 };
  const value = projectCatalogSyncWorkspace(await invoke("readHotelCatalogSyncWorkspace", hotelUid, input, operation), hotelUid); operation.assert();
  write(storageKey, { ...saved, jobId: value.jobId }); return value;
}
export function getPendingCatalogSyncApply(hotelUid, jobId) { if (!hotelUid || !auth.currentUser?.uid) return null; const value = read(key(hotelUid, `apply:${jobId}`)); if (value) { if (value.input?.jobId !== jobId || JSON.stringify(value.input.choices) !== JSON.stringify(catalogSyncChoices(value.input.choices))) throw new Error("The original catalog sync choices could not be verified."); } return value; }
export async function applyCatalogSync(hotelUid, jobId, choices) {
  if (!id(jobId)) throw new Error("Reopen a verified catalog sync review.");
  const operation = capture(hotelUid), storageKey = key(hotelUid, `apply:${jobId}`), input = { jobId, choices: catalogSyncChoices(choices) };
  let pending = getPendingCatalogSyncApply(hotelUid, jobId);
  if (pending && JSON.stringify(pending.input) !== JSON.stringify(input)) throw new Error("The previous apply result is uncertain. Recover its original reviewed choices before changing anything.");
  if (!pending) { pending = { version: 1, requestId: crypto.randomUUID(), input }; write(storageKey, pending); }
  try {
    const data = await invoke("applyHotelCatalogSync", hotelUid, { ...pending.input, requestId: pending.requestId }, operation);
    if (data.requestId !== pending.requestId || !Array.isArray(data.outcomes) || data.outcomes.length !== input.choices.length || data.outcomes.some((row, index) => row.rowId !== input.choices[index].rowId || !id(row.supplierProductId) || !id(row.catalogProductId) || (input.choices[index].target.kind === "existing" && row.catalogProductId !== input.choices[index].target.catalogProductId) || !revision(row.supplierRevision) || !["linked", "created-and-linked"].includes(row.status)) || !Array.isArray(data.createdCatalogs) || data.createdCatalogs.some((row) => !id(row.catalogProductId) || !revision(row.revision)) || typeof data.completed !== "boolean") throw new Error("The apply acknowledgement could not be verified. Retry the original reviewed choices.");
    operation.assert(); remove(storageKey); return { hotelUid, jobId, requestId: data.requestId, outcomes: data.outcomes.map(({ rowId, supplierProductId, catalogProductId, supplierRevision, status }) => ({ rowId, supplierProductId, catalogProductId, supplierRevision, status })), createdCatalogs: data.createdCatalogs.map(({ catalogProductId, revision: currentRevision, internalSku }) => ({ catalogProductId, revision: currentRevision, internalSku: typeof internalSku === "string" ? internalSku.slice(0, 100) : null })), completed: data.completed };
  } catch (failure) { if (operation.current() && failure.details?.catalogSyncRequestUncommitted === true) remove(storageKey); throw failure; }
  finally { invalidateProcurementReads(hotelUid); }
}
export function retryCatalogSyncApply(hotelUid, jobId) { const saved = getPendingCatalogSyncApply(hotelUid, jobId); if (!saved) return Promise.reject(new Error("No pending catalog sync apply request is available.")); return applyCatalogSync(hotelUid, jobId, saved.input.choices); }
export function getPendingCatalogSyncRefinement(hotelUid, jobId) { if (!hotelUid || !auth.currentUser?.uid) return null; const value = read(key(hotelUid, `refine:${jobId}`)); if (value && (value.input?.jobId !== jobId || !revision(value.input.expectedRevision) || !Array.isArray(value.input.rowIds) || value.input.rowIds.length < 1 || value.input.rowIds.length > 10 || value.input.rowIds.some((rowId) => !id(rowId)))) throw new Error("The original suggestion request could not be verified."); return value; }
export async function refineCatalogSyncSuggestions(hotelUid, jobId, expectedRevision, rowIds) {
  const operation = capture(hotelUid);
  if (!id(jobId) || !revision(expectedRevision) || !Array.isArray(rowIds) || !rowIds.length || rowIds.length > 10 || rowIds.some((rowId) => !id(rowId))) throw new Error("Choose up to 10 current proposals for optional suggestion refinement.");
  const storageKey = key(hotelUid, `refine:${jobId}`), input = { jobId, expectedRevision, rowIds };
  let pending = getPendingCatalogSyncRefinement(hotelUid, jobId);
  if (pending && JSON.stringify(pending.input) !== JSON.stringify(input)) throw new Error("Recover the original suggestion request before requesting new suggestions.");
  if (!pending) { pending = { version: 1, requestId: crypto.randomUUID(), input }; write(storageKey, pending); }
  let data;
  try { data = await invoke("refineHotelCatalogSyncSuggestions", hotelUid, { ...pending.input, requestId: pending.requestId }, operation); }
  catch (failure) { if (operation.current() && failure.details?.catalogSyncRefinementUncommitted === true) remove(storageKey); throw failure; }
  if (data.requestId !== pending.requestId || data.policyVersion !== 1 || !["ready", "failed", "processing", "response-unknown", "disabled"].includes(data.status) || !revision(data.revision) || !Array.isArray(data.suggestions) || data.suggestions.length > 10 || data.suggestions.some((row) => !rowIds.includes(row.rowId) || (row.catalogProductId != null && !id(row.catalogProductId)))) throw new Error("The suggestion acknowledgement could not be verified. Retry the original request.");
  operation.assert(); if (["ready", "failed", "disabled"].includes(data.status)) remove(storageKey);
  return { hotelUid, jobId, requestId: data.requestId, status: data.status, revision: data.revision, suggestions: data.suggestions.map((row) => ({ rowId: row.rowId, catalogProductId: row.catalogProductId || null, reason: catalogSyncMessage(row.reason), specificDifferences: (Array.isArray(row.specificDifferences) ? row.specificDifferences : []).slice(0, 30).map(catalogSyncMessage) })), message: data.message ? catalogSyncMessage(data.message) : null };
}
export function retryCatalogSyncRefinement(hotelUid, jobId) { const saved = getPendingCatalogSyncRefinement(hotelUid, jobId); if (!saved) return Promise.reject(new Error("No pending suggestion request is available.")); return refineCatalogSyncSuggestions(hotelUid, jobId, saved.input.expectedRevision, saved.input.rowIds); }
