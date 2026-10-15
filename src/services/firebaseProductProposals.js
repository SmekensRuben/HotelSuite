import { auth, functions, httpsCallable } from "../firebaseConfig";
import { invalidateProcurementReads, procurementReadScope } from "./procurementReadPool";

const memory = new WeakMap();
const validId = (value) => typeof value === "string" && value.length > 0 && value.length <= 128 && value === value.trim() && ![".", ".."].includes(value) && !/^__.*__$/.test(value) && !/[\u0000-\u001f\u007f/]/.test(value);
const revision = (value) => Number.isSafeInteger(value) && value >= 0;
const actions = ["correct", "skip", "approve"];

function capture(hotelUid) {
  const actor = auth.currentUser, scope = procurementReadScope(hotelUid);
  if (!actor?.uid || !validId(hotelUid) || !scope) throw new Error("Sign in and select a hotel before opening product proposals.");
  return { actor, assert() { if (auth.currentUser !== actor || !scope.current()) throw new Error("Hotel access changed. Reopen product proposals with the authorized account."); } };
}
function storageKey(hotelUid, batchId) {
  if (!auth.currentUser?.uid || !validId(hotelUid) || !validId(batchId)) throw new Error("Choose a verified product proposal batch.");
  return `product-proposal-review:${auth.currentUser.uid}:${hotelUid}:${batchId}`;
}
function remember(key, value) {
  if (!memory.has(auth.currentUser)) memory.set(auth.currentUser, new Map());
  if (value) memory.get(auth.currentUser).set(key, value); else memory.get(auth.currentUser).delete(key);
  try { if (value) sessionStorage.setItem(key, JSON.stringify(value)); else sessionStorage.removeItem(key); } catch { /* Exact retry identity remains in the current authenticated session. */ }
}
export function getPendingProductProposalReview(hotelUid, batchId) {
  const key = storageKey(hotelUid, batchId);
  let pending = memory.get(auth.currentUser)?.get(key);
  if (!pending) {
    let stored; try { stored = sessionStorage.getItem(key); } catch { return null; }
    if (!stored) return null;
    try { pending = JSON.parse(stored); } catch { throw new Error("The original review request could not be verified. Ask your administrator to reconcile it."); }
  }
  if (pending.version !== 1 || !validId(pending.requestId) || pending.input?.batchId !== batchId || !revision(pending.input.expectedRevision) || !actions.includes(pending.input.action)) throw new Error("The saved product review is invalid. Reconcile it before starting another action.");
  return pending;
}
async function invoke(endpoint, hotelUid, payload, operation) {
  operation.assert();
  const { data } = await httpsCallable(functions, endpoint)({ hotelUid, ...payload });
  operation.assert();
  if (data?.hotelUid !== hotelUid || (payload.batchId && data.batchId !== payload.batchId)) throw new Error("The product proposal response belongs to another hotel or batch.");
  return data;
}
function batch(value) {
  if (!validId(value.batchId) || !revision(value.revision) || !Array.isArray(value.rows) || value.rows.some((row) => !validId(row.rowId) || !["catalog", "supplier"].includes(row.kind) || !["create", "update"].includes(row.action) || !Array.isArray(row.issues))) throw new Error("The product proposal batch could not be verified. Reload this review.");
  return value;
}
export async function listProductProposalBatches(hotelUid, { cursor = null, limit = 25 } = {}) {
  const operation = capture(hotelUid);
  const data = await invoke("listHotelProductProposalBatches", hotelUid, { cursor, limit }, operation);
  if (!Array.isArray(data.batches) || data.batches.some((item) => !validId(item.batchId)) || (data.nextCursor != null && typeof data.nextCursor !== "string")) throw new Error("The product proposal list could not be verified.");
  return data;
}
export async function readProductProposalBatch(hotelUid, batchId) {
  if (!validId(batchId)) throw new Error("Choose a verified product proposal batch.");
  const data = batch(await invoke("readHotelProductProposalBatch", hotelUid, { batchId }, capture(hotelUid)));
  if (data.pendingReview) {
    const { requestId, expectedRevision, action, rowIds } = data.pendingReview;
    if (!validId(requestId) || !revision(expectedRevision) || action !== "approve" || !Array.isArray(rowIds) || !rowIds.length || rowIds.some((id) => !validId(id))) throw new Error("The interrupted approval could not be verified. Ask your administrator to reconcile it.");
    const input = { batchId, expectedRevision, action, rowIds }, existing = getPendingProductProposalReview(hotelUid, batchId);
    if (existing && (existing.requestId !== requestId || JSON.stringify(existing.input) !== JSON.stringify(input))) throw new Error("This batch has another interrupted review. Reconcile the original request before continuing.");
    if (!existing) remember(storageKey(hotelUid, batchId), { version: 1, requestId, input });
  }
  return data;
}
export async function reviewProductProposals(hotelUid, batchId, { expectedRevision, action, rowIds, corrections } = {}) {
  if (!validId(batchId) || !revision(expectedRevision) || !actions.includes(action) || !Array.isArray(rowIds) || !rowIds.length || rowIds.length > 25 || rowIds.some((id) => !validId(id)) || new Set(rowIds).size !== rowIds.length) throw new Error("Select current product proposals and a valid review action.");
  if (action === "correct" && (!Array.isArray(corrections) || corrections.length !== rowIds.length)) throw new Error("Include the reviewed replacement patch for each corrected proposal.");
  const operation = capture(hotelUid), key = storageKey(hotelUid, batchId);
  const input = { batchId, expectedRevision, action, rowIds, ...(corrections ? { corrections } : {}) };
  let pending = getPendingProductProposalReview(hotelUid, batchId);
  if (pending && JSON.stringify(pending.input) !== JSON.stringify(input)) throw new Error("Recover the original review request before changing this batch.");
  if (!pending) { pending = { version: 1, requestId: crypto.randomUUID(), input }; remember(key, pending); }
  try {
    const wireInput = { ...pending.input, requestId: pending.requestId };
    if (action === "correct") delete wireInput.rowIds;
    const data = batch(await invoke("reviewHotelProductProposals", hotelUid, wireInput, operation));
    if (data.requestId !== pending.requestId) throw new Error("The review acknowledgement could not be verified. Retry the original request.");
    operation.assert(); if (!data.pendingReview && !data.processing && data.status !== "processing") remember(key, null); return data;
  } catch (failure) {
    operation.assert();
    if (failure.details?.productProposalRequestUncommitted === true) remember(key, null);
    throw failure;
  } finally { invalidateProcurementReads(hotelUid); }
}
export function retryProductProposalReview(hotelUid, batchId) {
  const pending = getPendingProductProposalReview(hotelUid, batchId);
  if (!pending) return Promise.reject(new Error("No pending product review is available."));
  return reviewProductProposals(hotelUid, batchId, pending.input);
}
