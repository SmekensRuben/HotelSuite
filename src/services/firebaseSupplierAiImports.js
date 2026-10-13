import { auth, functions, httpsCallable } from "../firebaseConfig";
import { invalidateProcurementReads, poolProcurementRead, procurementReadScope } from "./procurementReadPool";

export const MAX_SUPPLIER_AI_IMPORT_BYTES = 10 * 1024 * 1024;
export const SUPPLIER_AI_IMPORT_ACCEPT = ".csv,.xlsx,.pdf,.docx,.eml,.txt";
const types = {
  csv: "text/csv", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pdf: "application/pdf", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  eml: "message/rfc822", txt: "text/plain",
};
const id = (value) => typeof value === "string" && value.length > 0 && value.length <= 128 && value.trim() === value && !/[\\/\u0000-\u001f]/.test(value) && ![".", ".."].includes(value);
const uploadCommands = new WeakMap();
const commitCommands = new WeakMap();
const terminal = new Set(["invalid-argument", "permission-denied", "unauthenticated", "not-found", "already-exists", "failed-precondition", "resource-exhausted"]);
const jobStatuses = new Set(["uploading", "queued", "processing", "review", "partially_committed", "completed", "failed", "response_unknown", "expired"]);
const INTERNAL_IMPORT_DETAIL = /cost|budget|reserv|paid|bill|usage|accounting|token|model|reasoning|provider|secret|configuration|fallback|maxCalls|maxInput|maxOutput|priceVersion|\bUSD\b|[$€£]|gpt[- ]|openai|sk-|AIza|Bearer|https?:|api[-_ ]?key|authorization/i;
const publicMessage = (value, fallback = "The import could not be prepared. Contact your hotel administrator for assistance.") => {
  if (typeof value !== "string" || !value.trim() || value.length > 2000) return fallback;
  return INTERNAL_IMPORT_DETAIL.test(value) ? "The import could not be prepared. Contact your hotel administrator for assistance." : value;
};
const publicError = (value) => value && typeof value === "object" ? { code: typeof value.code === "string" && !INTERNAL_IMPORT_DETAIL.test(value.code) ? value.code.slice(0, 80) : "unavailable", message: publicMessage(value.message) } : undefined;
const count = (value, maximum = 1000) => Number.isSafeInteger(value) && value >= 0 && value <= maximum;
// Explicitly project the customer contract, including responses from older deployments.
// Provider configuration and accounting data must never reach hotel-facing components.
export function normalizeSupplierAiImportJob(value) {
  if (!value || !id(value.hotelUid) || !id(value.jobId) || !id(value.ownerUid) || !jobStatuses.has(value.status)) throw new Error("The import status could not be verified. Reopen the original import.");
  const result = { hotelUid: value.hotelUid, jobId: value.jobId, ...(id(value.supplierId) ? { supplierId: value.supplierId } : {}), ownerUid: value.ownerUid, status: value.status };
  if (value.source && typeof value.source === "object") {
    result.source = {};
    if (typeof value.source.fileName === "string" && value.source.fileName.length <= 180) result.source.fileName = value.source.fileName;
    if (count(value.source.size, MAX_SUPPLIER_AI_IMPORT_BYTES)) result.source.size = value.source.size;
    if (Object.values(types).includes(value.source.mimeType)) result.source.mimeType = value.source.mimeType;
  }
  if (Number.isSafeInteger(value.expiresAtMillis) && value.expiresAtMillis > 0) result.expiresAtMillis = value.expiresAtMillis;
  if (value.totalRows != null) { if (!count(value.totalRows)) throw new Error("The import row count could not be verified."); result.totalRows = value.totalRows; }
  if (value.counts === null) result.counts = null;
  else if (value.counts) {
    const keys = ["new", "changed", "unchanged", "blocked"], total = keys.reduce((sum, key) => sum + value.counts[key], 0);
    result.counts = keys.every((key) => count(value.counts[key])) && total <= 1000 && (value.totalRows == null || total === value.totalRows) ? Object.fromEntries(keys.map((key) => [key, value.counts[key]])) : null;
  }
  if (value.progress) {
    const { completedChunks, totalChunks } = value.progress;
    if (!count(completedChunks, 32) || (totalChunks !== null && (!count(totalChunks, 32) || completedChunks > totalChunks))) throw new Error("The import progress could not be verified.");
    result.progress = { completedChunks, totalChunks };
  }
  if (Array.isArray(value.warnings)) result.warnings = value.warnings.slice(0, 100).map((warning) => typeof warning === "string" ? { code: "document-review", message: publicMessage(warning) } : { code: typeof warning?.code === "string" && !INTERNAL_IMPORT_DETAIL.test(warning.code) ? warning.code.slice(0, 80) : "document-review", message: publicMessage(warning?.message, "Document extraction needs review."), ...(Array.isArray(warning?.sourceIds) ? { sourceIds: warning.sourceIds.filter(id).slice(0, 1000) } : {}), ...(count(warning?.count) ? { count: warning.count } : {}) });
  if (value.error) result.error = publicError(value.error);
  return result;
}

export function validateSupplierAiImportFile(file) {
  if (!file || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > MAX_SUPPLIER_AI_IMPORT_BYTES) throw new Error("Choose a file between 1 byte and 10 MiB.");
  const extension = String(file.name || "").split(".").pop().toLowerCase();
  if (!types[extension]) throw new Error("Choose CSV, XLSX, PDF, DOCX, EML or TXT. Password-protected documents are not supported.");
  if (file.name.length > 180 || /[\u0000-\u001f\\/]/.test(file.name)) throw new Error("The file name is invalid. Rename the file and try again.");
  return types[extension];
}
function context(hotelUid) {
  const actor = auth.currentUser, scope = procurementReadScope(hotelUid);
  if (!actor?.uid || !id(hotelUid) || !scope) throw new Error("Sign in and select a hotel before using AI import.");
  const assertCurrent = () => { if (auth.currentUser !== actor || !scope.current()) throw new Error("Hotel access changed. Reopen this import from the current hotel."); };
  return { actor, assertCurrent };
}
function endpoint() {
  const project = functions.app.options.projectId;
  if (!/^[a-z0-9-]+$/.test(project)) throw new Error("AI import is not configured.");
  return `https://us-central1-${project}.cloudfunctions.net/supplierProductAiImport`;
}
async function request(method, input, captured, file) {
  const token = await captured.actor.getIdToken(); captured.assertCurrent();
  const response = await fetch(`${endpoint()}?${new URLSearchParams(input)}`, {
    method, headers: { Authorization: `Bearer ${token}`, ...(file ? { "Content-Type": "application/octet-stream" } : {}) },
    ...(file ? { body: file } : {}), cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer",
  });
  captured.assertCurrent();
  const result = await response.json().catch(() => null); captured.assertCurrent();
  if (!response.ok) throw Object.assign(new Error(publicMessage(result?.error?.message, "AI import could not be verified. Retry the same request.")), { code: result?.error?.code || "unavailable" });
  if (!result || typeof result !== "object") throw new Error("AI import returned an invalid response. Retry the same request.");
  return result;
}
export function getSupplierAiImportAvailability(hotelUid) {
  return poolProcurementRead(hotelUid, "supplier-ai-import-availability", async () => {
    const result = await request("GET", { hotelUid }, context(hotelUid));
    if (typeof result.available !== "boolean" || (result.reason != null && result.reason !== "disabled")) throw new Error("AI import settings could not be verified.");
    const limits = {};
    for (const [key, maximum] of [["maxFileBytes", MAX_SUPPLIER_AI_IMPORT_BYTES], ["maxPages", 50], ["maxProducts", 1000]]) if (count(result.limits?.[key], maximum) && result.limits[key] > 0) limits[key] = result.limits[key];
    return { available: result.available, reason: result.reason ?? null, limits };
  });
}
async function fileFingerprint(file) {
  const bytes = typeof file.arrayBuffer === "function" ? await file.arrayBuffer() : await new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error("The document could not be read.")); reader.readAsArrayBuffer(file);
  });
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (value) => value.toString(16).padStart(2, "0")).join("");
}
export async function startSupplierAiImport(hotelUid, supplierId, file) {
  const mimeType = validateSupplierAiImportFile(file), captured = context(hotelUid);
  if (!id(supplierId)) throw new Error("Choose an existing hotel supplier.");
  if (!uploadCommands.has(captured.actor)) uploadCommands.set(captured.actor, new WeakMap());
  const files = uploadCommands.get(captured.actor);
  if (!files.has(file)) files.set(file, new Map());
  const commands = files.get(file), key = JSON.stringify([hotelUid, supplierId]);
  const fingerprint = await fileFingerprint(file); captured.assertCurrent();
  const recoveryKey = `supplier-ai-upload:${captured.actor.uid}:${hotelUid}:${supplierId}:${fingerprint}`;
  let recovered; try { recovered = JSON.parse(sessionStorage.getItem(recoveryKey) || "null"); } catch { /* Local recovery is optional. */ }
  const requestId = typeof recovered?.requestId === "string" && /^[a-z0-9-]{1,128}$/i.test(recovered.requestId) ? recovered.requestId : crypto.randomUUID();
  const recoveredName = typeof recovered?.fileName === "string" && recovered.fileName.length <= 180 && recovered.fileName.length > 0 && !/[\u0000-\u001f\\/]/.test(recovered.fileName) ? recovered.fileName : file.name;
  const recoveredType = Object.values(types).includes(recovered?.mimeType) ? recovered.mimeType : mimeType;
  const command = commands.get(key) || { hotelUid, supplierId, fileName: recoveredName, mimeType: recoveredType, requestId };
  commands.set(key, command);
  try { sessionStorage.setItem(recoveryKey, JSON.stringify({ requestId: command.requestId, fileName: command.fileName, mimeType: command.mimeType })); } catch { /* In-view retries retain the original request. */ }
  try {
    const result = await request("POST", command, captured, file);
    if (result.hotelUid !== hotelUid || result.supplierId !== supplierId || result.ownerUid !== captured.actor.uid || !id(result.jobId)) throw new Error("The import acknowledgement could not be verified. Retry the same file and supplier.");
    const confirmed = normalizeSupplierAiImportJob(result);
    commands.delete(key);
    try { sessionStorage.setItem(`supplier-ai-import:${hotelUid}:${captured.actor.uid}`, JSON.stringify({ jobId: result.jobId })); } catch { /* The open view can still recover the job. */ }
    try { sessionStorage.removeItem(recoveryKey); } catch { /* Optional local recovery. */ }
    return confirmed;
  } catch (error) {
    if (terminal.has(String(error.code || "").replace(/^functions\//, ""))) {
      commands.delete(key); try { sessionStorage.removeItem(recoveryKey); } catch { /* Optional browser storage. */ }
    }
    throw error;
  }
}
export function getSupplierAiImport(hotelUid, jobId) {
  if (!id(jobId)) return Promise.reject(new Error("The import reference is invalid."));
  return poolProcurementRead(hotelUid, `supplier-ai-import:${jobId}`, async () => {
    const captured = context(hotelUid), result = await request("GET", { hotelUid, jobId }, captured);
    if (result.hotelUid !== hotelUid || result.jobId !== jobId || result.ownerUid !== captured.actor.uid) throw new Error("The import belongs to another session or hotel.");
    return normalizeSupplierAiImportJob(result);
  });
}
async function command(name, hotelUid, input) {
  const captured = context(hotelUid); captured.assertCurrent();
  let data;
  try { ({ data } = await httpsCallable(functions, name)({ hotelUid, ...input })); }
  catch (failure) { captured.assertCurrent(); throw Object.assign(new Error(publicMessage(failure?.message, "The import request could not be verified. Reopen the original import.")), { code: failure?.code }); }
  captured.assertCurrent();
  if (data?.hotelUid !== hotelUid || data?.jobId !== input.jobId) throw new Error("The import response could not be verified. Reopen the original import.");
  const result = { hotelUid: data.hotelUid, jobId: data.jobId };
  if (name === "readHotelSupplierAiImportRows") return { ...result, rows: data.rows, totalRows: data.totalRows, nextCursor: data.nextCursor ?? null };
  if (name === "correctHotelSupplierAiImportRow") return { ...result, row: data.row };
  return { ...result, complete: data.complete, outcomes: Array.isArray(data.outcomes) ? data.outcomes.map((outcome) => ({ rowId: outcome.rowId, status: outcome.status, ...(outcome.productId != null ? { productId: outcome.productId } : {}), ...(outcome.revision != null ? { revision: outcome.revision } : {}), ...(outcome.error ? { error: publicError(outcome.error) } : {}) })) : data.outcomes };
}
// Review and commit requests operate on the durable server draft, never on raw AI output.
export function getSupplierAiImportReview(hotelUid, jobId, cursor = null) {
  return poolProcurementRead(hotelUid, `supplier-ai-review:${jobId}:${cursor || "first"}`, () => command("readHotelSupplierAiImportRows", hotelUid, { jobId, limit: 25, cursor }));
}
export const saveSupplierAiImportReview = (hotelUid, input) => command("correctHotelSupplierAiImportRow", hotelUid, input);
export async function confirmSupplierAiImport(hotelUid, jobId, rows) {
  const captured = context(hotelUid);
  if (!id(jobId) || !Array.isArray(rows) || !rows.length || rows.length > 1000 || rows.some((row) => !id(row.rowId) || !Number.isSafeInteger(row.reviewRevision) || row.reviewRevision < 1 || row.acknowledged !== true)) throw new Error("Select reviewed rows before confirming this import.");
  if (!commitCommands.has(captured.actor)) commitCommands.set(captured.actor, new Map());
  const commands = commitCommands.get(captured.actor), key = JSON.stringify([hotelUid, jobId, rows]);
  const plan = commands.get(key) || { offset: 0, outcomes: [], batches: Array.from({ length: Math.ceil(rows.length / 25) }, (_, index) => ({ requestId: crypto.randomUUID(), rows: rows.slice(index * 25, index * 25 + 25) })) };
  commands.set(key, plan);
  try {
    while (plan.offset < plan.batches.length) {
      captured.assertCurrent();
      const batch = plan.batches[plan.offset], result = await command("commitHotelSupplierAiImportRows", hotelUid, { jobId, ...batch });
      if (result.complete !== true || !Array.isArray(result.outcomes) || result.outcomes.length !== batch.rows.length || result.outcomes.some((row, index) => row.rowId !== batch.rows[index].rowId || !["created", "updated", "unchanged", "blocked"].includes(row.status) || (row.status !== "blocked" && (!id(row.productId) || !Number.isSafeInteger(row.revision) || row.revision < 0)))) throw new Error("The import acknowledgement is incomplete. Retry the same selected rows.");
      plan.outcomes.push(...result.outcomes); plan.offset += 1;
    }
    commands.delete(key);
    return { hotelUid, jobId, outcomes: plan.outcomes, complete: true };
  } finally { invalidateProcurementReads(hotelUid); }
}
