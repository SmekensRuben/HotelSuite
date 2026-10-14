import { auth, functions, httpsCallable } from "../firebaseConfig";
import { invalidateProcurementReads, poolProcurementRead, procurementReadScope } from "./procurementReadPool";
import { PURCHASE_UNITS, SUPPLIER_IMPORT_FILTERS, projectSupplierImportRow, projectSupplierImportWorkspace, projectReviewCounts } from "../utils/supplierImportWorkspace";

const ids = (value) => typeof value === "string" && value.length > 0 && value.length <= 128 && value.trim() === value && !/[\\/\u0000-\u001f]/.test(value) && ![".", ".."].includes(value);
const formats = new Set(["csv", "xlsx", "pdf", "docx", "eml", "txt"]);
const pending = new WeakMap();
const terminal = new Set(["invalid-argument", "permission-denied", "unauthenticated", "not-found", "already-exists", "failed-precondition", "resource-exhausted", "aborted"]);
const privateMessage = /\b(?:openai|tokens?|budget|billing|reasoning|fallback|secret|api[-_\s]?key|bearer|gpt[-\s][a-z0-9][a-z0-9._-]*|AI[-_\s]?(?:model|cost|usage))\b|(?:CostUsd|CostMicros|reservedCost|sk-[a-z0-9])/i;
function capture(hotelUid) {
  const actor = auth.currentUser, scope = procurementReadScope(hotelUid);
  if (!actor?.uid || !ids(hotelUid) || !scope) throw new Error("Sign in and select a hotel before reviewing imports.");
  return { actor, assertCurrent: () => { if (auth.currentUser !== actor || !scope.current()) throw new Error("Hotel access changed. Reopen the import from the current hotel."); } };
}
async function invoke(name, hotelUid, input, captured = capture(hotelUid)) {
  captured.assertCurrent();
  let data;
  try { ({ data } = await httpsCallable(functions, name)({ hotelUid, ...input })); }
  catch (error) {
    captured.assertCurrent();
    throw Object.assign(new Error(typeof error?.message === "string" && !privateMessage.test(error.message) ? error.message : "The import could not be verified. Ask your hotel administrator for assistance."), { code: error?.code });
  }
  captured.assertCurrent();
  if (data?.hotelUid !== hotelUid || (input.jobId && data.jobId !== input.jobId) || (input.supplierId && data.supplierId !== input.supplierId)) throw new Error("The import response belongs to another hotel or session.");
  return data;
}
async function stableCommand(name, hotelUid, payload, verify) {
  const captured = capture(hotelUid);
  const bytes = new TextEncoder().encode(JSON.stringify([name, hotelUid, payload]));
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  captured.assertCurrent();
  const key = `supplier-import-command:${captured.actor.uid}:${hotelUid}:${digest}`;
  if (!pending.has(captured.actor)) pending.set(captured.actor, new Map());
  const commands = pending.get(captured.actor);
  let stored; try { stored = JSON.parse(sessionStorage.getItem(key) || "null"); } catch { /* Browser recovery is optional. */ }
  if (stored && !ids(stored.requestId)) throw new Error("The original import operation could not be verified.");
  const requestId = commands.get(key) || stored?.requestId || crypto.randomUUID();
  commands.set(key, requestId);
  // Only an opaque operation reference is stored, never product/source values.
  try { sessionStorage.setItem(key, JSON.stringify({ requestId })); } catch { /* Same-view retries retain the command. */ }
  try {
    const data = await invoke(name, hotelUid, { ...payload, requestId }, captured);
    const result = verify(data, requestId);
    captured.assertCurrent();
    commands.delete(key); try { sessionStorage.removeItem(key); } catch { /* Optional browser recovery. */ }
    return result;
  } catch (error) {
    if (terminal.has(String(error.code || "").replace(/^functions\//, ""))) {
      commands.delete(key); try { sessionStorage.removeItem(key); } catch { /* Optional browser recovery. */ }
    }
    throw error;
  } finally { invalidateProcurementReads(hotelUid); }
}
export function readSupplierImportWorkspace(hotelUid, jobId, { cursor = null, filter = "all", focusRowId = null, includeIndex = true, limit = 25 } = {}) {
  if (!ids(jobId) || (cursor !== null && !ids(cursor)) || (focusRowId !== null && !ids(focusRowId)) || !SUPPLIER_IMPORT_FILTERS.includes(filter) || !Number.isInteger(limit) || limit < 1 || limit > 25) return Promise.reject(new Error("The import review reference is invalid."));
  const input = { jobId, cursor, filter, includeIndex, limit, ...(focusRowId ? { focusRowId } : {}) };
  return poolProcurementRead(hotelUid, `supplier-import-workspace:${JSON.stringify(input)}`, async () => projectSupplierImportWorkspace(await invoke("readHotelSupplierAiImportWorkspace", hotelUid, input)));
}
export function decideSupplierImportRows(hotelUid, jobId, rows, { bulk = false } = {}) {
  if (!ids(jobId) || !Array.isArray(rows) || rows.length < 1 || rows.length > 25 || rows.some((row) => !ids(row.rowId) || !Number.isSafeInteger(row.reviewRevision) || row.reviewRevision < 1 || !["approve", "skip", "reset"].includes(row.action) || row.acknowledged !== true) || new Set(rows.map((row) => row.rowId)).size !== rows.length) return Promise.reject(new Error("Choose current, explicitly reviewed products before saving a decision."));
  const payload = { jobId, rows: rows.map(({ rowId, reviewRevision, action }) => ({ rowId, reviewRevision, action, acknowledged: true })), bulk: bulk === true };
  return stableCommand("decideHotelSupplierAiImportRows", hotelUid, payload, (data) => {
    if (!Array.isArray(data.rows) || data.rows.length !== rows.length) throw new Error("The review decision acknowledgement is incomplete. Retry the same decision.");
    const received = data.rows.map(projectSupplierImportRow);
    if (received.some((row, index) => row.rowId !== rows[index].rowId || row.reviewRevision !== rows[index].reviewRevision || row.review?.status !== ({ approve: "approved", skip: "skipped", reset: "pending" })[rows[index].action])) throw new Error("The review decision acknowledgement could not be verified. Retry the same decision.");
    return { hotelUid, jobId, rows: received };
  });
}
export function applySupplierImportMapping(hotelUid, jobId, { sourceUnit, purchaseUnit, expectedMappingRevision = null, rows }) {
  if (!ids(jobId) || typeof sourceUnit !== "string" || !sourceUnit.trim() || sourceUnit.length > 100 || !PURCHASE_UNITS.includes(purchaseUnit) || (expectedMappingRevision !== null && (!Number.isSafeInteger(expectedMappingRevision) || expectedMappingRevision < 0)) || !Array.isArray(rows) || !rows.length || rows.length > 25 || rows.some((row) => !ids(row.rowId) || !Number.isSafeInteger(row.reviewRevision) || row.reviewRevision < 1)) return Promise.reject(new Error("Choose a purchase unit and the current affected products."));
  const payload = { jobId, sourceUnit, purchaseUnit, expectedMappingRevision, rows: rows.map(({ rowId, reviewRevision }) => ({ rowId, reviewRevision })) };
  return stableCommand("applyHotelSupplierAiImportMapping", hotelUid, payload, (data) => {
    if (typeof data.sourceUnit !== "string" || data.sourceUnit.normalize("NFKC").trim().toUpperCase() !== sourceUnit.normalize("NFKC").trim().toUpperCase() || data.purchaseUnit !== purchaseUnit) throw new Error("The mapping choice acknowledgement could not be verified. Retry the same selection.");
    if (!Array.isArray(data.rows) || !Array.isArray(data.outcomes) || data.outcomes.length !== rows.length || data.outcomes.some((outcome, index) => outcome.rowId !== rows[index].rowId || !["mapped", "skipped", "blocked"].includes(outcome.status))) throw new Error("The mapping acknowledgement is incomplete. Retry the same selection.");
    const received = data.rows.map(projectSupplierImportRow);
    const mapped = data.outcomes.filter((outcome) => outcome.status === "mapped");
    if (received.length !== mapped.length || new Set(received.map((row) => row.rowId)).size !== received.length || mapped.some((outcome) => {
      const original = rows.find((row) => row.rowId === outcome.rowId), updated = received.find((row) => row.rowId === outcome.rowId);
      return !updated || !Number.isSafeInteger(outcome.reviewRevision) || outcome.reviewRevision <= original.reviewRevision || updated.reviewRevision !== outcome.reviewRevision;
    })) throw new Error("The mapped product revisions could not be verified. Retry the same mapping.");
    const outcomes = data.outcomes.map((outcome) => ({ rowId: outcome.rowId, status: outcome.status, ...(Number.isSafeInteger(outcome.reviewRevision) ? { reviewRevision: outcome.reviewRevision } : {}), ...(["already-applied", "review-skipped", "human-correction"].includes(outcome.reason) ? { reason: outcome.reason } : {}), ...(outcome.error ? { error: { code: typeof outcome.error.code === "string" && !privateMessage.test(outcome.error.code) ? outcome.error.code : "unavailable", message: typeof outcome.error.message === "string" && !privateMessage.test(outcome.error.message) ? outcome.error.message : "This product could not be mapped. Refresh and review it individually." } } : {}) }));
    return { hotelUid, jobId, rows: received, outcomes };
  });
}
function mappingScope(supplierId, sourceFormat, profileId) {
  if (!ids(supplierId) || !formats.has(sourceFormat) || !ids(profileId)) throw new Error("The supplier mapping profile is invalid.");
  return { supplierId, sourceFormat, profileId };
}
function mappingProfile(data, expected) {
  if (data.version !== 1 || data.sourceFormat !== expected.sourceFormat || data.profileId !== expected.profileId || !Number.isSafeInteger(data.revision) || data.revision < 0 || !Array.isArray(data.mappings) || data.mappings.length > 100) throw new Error("The supplier mapping profile could not be verified.");
  const project = (value) => {
    if (!value || typeof value.sourceUnit !== "string" || !value.sourceUnit.trim() || value.sourceUnit.length > 100 || !PURCHASE_UNITS.includes(value.purchaseUnit)) throw new Error("A supplier purchase-unit mapping is invalid.");
    return { sourceUnit: value.sourceUnit, purchaseUnit: value.purchaseUnit };
  };
  return { version: 1, supplierId: expected.supplierId, sourceFormat: expected.sourceFormat, profileId: expected.profileId, revision: data.revision, mappings: data.mappings.map(project), suggestions: (Array.isArray(data.suggestions) ? data.suggestions : []).slice(0, 100).map((value) => ({ ...project(value), needsConfirmation: true })) };
}
export function readSupplierPurchaseUnitMappings(hotelUid, supplierId, sourceFormat, profileId = "default") {
  const input = mappingScope(supplierId, sourceFormat, profileId);
  return poolProcurementRead(hotelUid, `supplier-unit-mappings:${JSON.stringify(input)}`, async () => mappingProfile(await invoke("readHotelSupplierPurchaseUnitMappings", hotelUid, input), input));
}
export function saveSupplierPurchaseUnitMappings(hotelUid, supplierId, sourceFormat, profileId, expectedRevision, mappings) {
  const scope = mappingScope(supplierId, sourceFormat, profileId);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || !Array.isArray(mappings) || !mappings.length || mappings.length > 100 || mappings.some((mapping) => typeof mapping.sourceUnit !== "string" || !mapping.sourceUnit.trim() || mapping.sourceUnit.length > 100 || !PURCHASE_UNITS.includes(mapping.purchaseUnit))) return Promise.reject(new Error("Choose valid supplier purchase-unit mappings."));
  return stableCommand("saveHotelSupplierPurchaseUnitMapping", hotelUid, { ...scope, expectedRevision, mappings: mappings.map(({ sourceUnit, purchaseUnit }) => ({ sourceUnit, purchaseUnit })) }, (data, requestId) => {
    const saved = mappingProfile(data, scope);
    if (data.requestId !== requestId || saved.revision !== expectedRevision + 1 || mappings.some((chosen) => !saved.mappings.some((entry) => entry.sourceUnit.normalize("NFKC").trim().toUpperCase() === chosen.sourceUnit.normalize("NFKC").trim().toUpperCase() && entry.purchaseUnit === chosen.purchaseUnit))) throw new Error("The saved supplier rule could not be verified. Retry the same mapping selection.");
    return saved;
  });
}
export function completeSupplierImportReview(hotelUid, jobId) {
  if (!ids(jobId)) return Promise.reject(new Error("The import reference is invalid."));
  return stableCommand("completeHotelSupplierAiImportReview", hotelUid, { jobId }, (data) => {
    const counts = Number.isSafeInteger(data.totalRows) && data.totalRows >= 0 && data.totalRows <= 1000 ? projectReviewCounts(data.reviewCounts, data.totalRows) : null;
    if (typeof data.completed !== "boolean" || !counts || (data.completed && (counts.pending !== 0 || counts.approved !== 0 || counts.applied + counts.skipped !== data.totalRows))) throw new Error("The final import status could not be verified. Retry the same completion.");
    return { hotelUid, jobId, completed: data.completed, totalRows: data.totalRows, reviewCounts: counts };
  });
}
