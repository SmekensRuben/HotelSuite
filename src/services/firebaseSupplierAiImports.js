import { projectSupplierFormatCandidate, projectSupplierSourceInterpretation } from "../utils/supplierImportFormat";
import { supplierAiImportSummary, supplierAiImportSettings } from "../utils/supplierAiImportSummary";
import { currencyChoices } from "../utils/propertySettingChoices";
import { auth, functions, httpsCallable } from "../firebaseConfig";
import { reportPurchasingError } from "./firebasePurchasingTelemetry";
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
const supportedCurrencies = new Set(currencyChoices().map((choice) => choice.id));
export function normalizeSupplierAiImportSettings(value) {
  const keys = ["policyVersion", "priceBasis", "currency", "vatRate"];
  const optional = ["assortmentMode", "documentPurpose", "sourceIssuedOn", "priceValidFrom", "priceValidUntil"];
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key) && !optional.includes(key)) || keys.some((key) => !Object.hasOwn(value, key)) || value.policyVersion !== 2 || !["net", "gross", "unknown"].includes(value.priceBasis) || !supportedCurrencies.has(value.currency) || (value.vatRate !== null && (typeof value.vatRate !== "number" || !Number.isFinite(value.vatRate) || value.vatRate < 0 || value.vatRate > 1 || Number(value.vatRate.toFixed(6)) !== value.vatRate))) throw new Error("Choose the document's price basis, currency and optional shared VAT rate before importing.");
  const settings = supplierAiImportSettings(value);
  if (!settings) throw new Error("Review the source purpose, assortment scope and valid business dates before importing.");
  return settings;
}
const publicImportSettings = (value) => { const settings = supplierAiImportSettings(value); return settings && supportedCurrencies.has(settings.currency) && (settings.vatRate === null || Number(settings.vatRate.toFixed(6)) === settings.vatRate) ? settings : null; };
export function supplierAiImportVatFraction(percent) {
  const value = String(percent ?? "");
  if (value.length > 30 || !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) throw new Error("Enter a VAT percentage from 0 to 100 with at most four decimal places.");
  const [whole = "0", rawFraction = ""] = value.split("."), fraction = rawFraction.replace(/0+$/, "");
  if (fraction.length > 4) throw new Error("Shared VAT supports at most four decimal places as a percentage.");
  const micros = BigInt((whole || "0") + fraction.padEnd(4, "0"));
  if (micros > 1000000n) throw new Error("Enter a VAT percentage from 0 to 100.");
  const digits = micros.toString().padStart(7, "0");
  return Number(`${digits.slice(0, -6)}.${digits.slice(-6)}`);
}
const sameSettings = (first, second) => JSON.stringify(first) === JSON.stringify(second);
export function normalizeSupplierAiImportSummary(value, expectedRows = null) {
  return supplierAiImportSummary(value, { totalRows: expectedRows });
}
// Explicitly project the customer contract, including responses from older deployments.
// Provider configuration and accounting data must never reach hotel-facing components.
export function normalizeSupplierAiImportJob(value) {
  if (!value || !id(value.hotelUid) || !id(value.jobId) || !id(value.ownerUid) || !jobStatuses.has(value.status)) throw new Error("The import status could not be verified. Reopen the original import.");
  const result = { hotelUid: value.hotelUid, jobId: value.jobId, ...(id(value.supplierId) ? { supplierId: value.supplierId } : {}), ownerUid: value.ownerUid, status: value.status, importSettings: publicImportSettings(value.importSettings), summary: null };
  if (value.importReviewVersion === 1) result.importReviewVersion = 1;
  if (value.recurringImportVersion === 1) result.recurringImportVersion = 1;
  if (value.sourceInterpretation) result.sourceInterpretation = projectSupplierSourceInterpretation(value.sourceInterpretation);
  if (value.sourceFormatCandidate) result.sourceFormatCandidate = projectSupplierFormatCandidate(value.sourceFormatCandidate);
  if (id(value.mappingProfileId)) result.mappingProfileId = value.mappingProfileId;
  if (Object.hasOwn(types, value.sourceFormat)) result.sourceFormat = value.sourceFormat;
  if (value.source && typeof value.source === "object") {
    result.source = {};
    if (typeof value.source.fileName === "string" && value.source.fileName.length <= 180) result.source.fileName = value.source.fileName;
    if (count(value.source.size, MAX_SUPPLIER_AI_IMPORT_BYTES)) result.source.size = value.source.size;
    if (Object.values(types).includes(value.source.mimeType)) result.source.mimeType = value.source.mimeType;
  }
  if (Number.isSafeInteger(value.expiresAtMillis) && value.expiresAtMillis > 0) result.expiresAtMillis = value.expiresAtMillis;
  if (value.totalRows != null) { if (!count(value.totalRows)) throw new Error("The import row count could not be verified."); result.totalRows = value.totalRows; }
  if (result.importSettings && ["review", "partially_committed", "completed"].includes(value.status)) result.summary = normalizeSupplierAiImportSummary(value.summary, value.totalRows ?? null);
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
function importAvailability(result) {
  if (typeof result.available !== "boolean" || (result.reason != null && !["disabled", "upgrade-required"].includes(result.reason))) throw new Error("AI import settings could not be verified.");
  const limits = {};
  for (const [key, maximum] of [["maxFileBytes", MAX_SUPPLIER_AI_IMPORT_BYTES], ["maxPages", 50], ["maxProducts", 1000]]) if (count(result.limits?.[key], maximum) && result.limits[key] > 0) limits[key] = result.limits[key];
  const supported = result.importPolicyVersion === 2, reviewSupported = result.reviewWorkspaceVersion === 1;
  return { available: result.available && supported && reviewSupported,
    ...(Object.hasOwn(result, "aiAvailable") ? { aiAvailable: result.aiAvailable === true } : {}),
    ...(Object.hasOwn(result, "recurringImportVersion") ? { recurringImportVersion: result.recurringImportVersion === 1 ? 1 : null } : {}),
    ...(Object.hasOwn(result, "sourceFormatProfileVersion") ? { sourceFormatProfileVersion: result.sourceFormatProfileVersion === 1 ? 1 : null } : {}), importPolicyVersion: supported ? 2 : null, reviewWorkspaceVersion: reviewSupported ? 1 : null, reason: result.available && (!supported || !reviewSupported) ? "upgrade-required" : result.reason ?? null, limits, defaults: { currency: supportedCurrencies.has(result.defaults?.currency) ? result.defaults.currency : null } };
}
export function getSupplierAiImportAvailability(hotelUid) {
  return poolProcurementRead(hotelUid, "supplier-ai-import-availability", async () => importAvailability(await request("GET", { hotelUid }, context(hotelUid))));
}
async function fileFingerprint(file) {
  const bytes = typeof file.arrayBuffer === "function" ? await file.arrayBuffer() : await new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error("The document could not be read.")); reader.readAsArrayBuffer(file);
  });
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (value) => value.toString(16).padStart(2, "0")).join("");
}
export async function startSupplierAiImport(hotelUid, supplierId, file, settings, { mappingProfileId = "default" } = {}) {
  let importSettings = normalizeSupplierAiImportSettings(settings);
  const mimeType = validateSupplierAiImportFile(file), captured = context(hotelUid);
  if (!id(supplierId)) throw new Error("Choose an existing hotel supplier.");
  if (typeof mappingProfileId !== "string" || !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(mappingProfileId)) throw new Error("Choose a valid supplier import profile.");
  if (!uploadCommands.has(captured.actor)) uploadCommands.set(captured.actor, new WeakMap());
  const files = uploadCommands.get(captured.actor);
  if (!files.has(file)) files.set(file, new Map());
  const commands = files.get(file), key = JSON.stringify([hotelUid, supplierId]);
  const fingerprint = await fileFingerprint(file); captured.assertCurrent();
  const recoveryKey = `supplier-ai-upload:${captured.actor.uid}:${hotelUid}:${supplierId}:${fingerprint}`;
  let recovered; try { recovered = JSON.parse(sessionStorage.getItem(recoveryKey) || "null"); } catch { /* Local recovery is optional. */ }
  let pending = commands.get(key) || recovered;
  const legacyRecovery = Boolean(pending?.requestId && !Object.hasOwn(pending, "importSettings"));
  const isRecurringInput = ["assortmentMode", "documentPurpose", "sourceIssuedOn", "priceValidFrom", "priceValidUntil"].some((field) => Object.hasOwn(importSettings, field));
  if (pending?.recurringImportVersion !== undefined && Number(pending.recurringImportVersion) !== 1) throw new Error("The saved recurring import version could not be verified. Recover the original upload.");
  if (pending?.requestId && (typeof pending.requestId !== "string" || !/^[a-z0-9-]{1,128}$/i.test(pending.requestId))) throw new Error("The original upload reference could not be verified. Contact your hotel administrator.");
  if (pending?.requestId && Object.hasOwn(pending, "reviewWorkspaceVersion") && Number(pending.reviewWorkspaceVersion) !== 1) throw new Error("The original import review version could not be verified. Contact your hotel administrator.");
  if (pending?.requestId && Number(pending.reviewWorkspaceVersion) === 1 && pending.mappingProfileId !== mappingProfileId) throw Object.assign(new Error("Recover the original document with its saved supplier import profile."), { code: "import-profile-changed", mappingProfileId: pending.mappingProfileId });
  if (pending?.requestId && !legacyRecovery) {
    const original = publicImportSettings(typeof pending.importSettings === "string" ? (() => { try { return JSON.parse(pending.importSettings); } catch { return null; } })() : pending.importSettings);
    if (!original) throw Object.assign(new Error("An earlier upload must be checked before importing this document again. Contact your hotel administrator."), { code: "import-settings-unavailable" });
    // New controls must not alter an unresolved pre-upgrade upload's saved command.
    const optionalDefaults = { assortmentMode: "partial", documentPurpose: "price-list", sourceIssuedOn: null, priceValidFrom: null, priceValidUntil: null };
    const displayedLegacyDefaults = Object.entries(optionalDefaults).every(([field, fallback]) =>
      Object.hasOwn(original, field) ? original[field] === importSettings[field] : !Object.hasOwn(importSettings, field) || importSettings[field] === fallback);
    if (displayedLegacyDefaults && ["policyVersion", "priceBasis", "currency", "vatRate"].every((field) => original[field] === importSettings[field])) importSettings = original;
    if (!sameSettings(original, importSettings)) throw Object.assign(new Error("Recover the original upload with its saved price settings. These settings have been restored; retry the same file and supplier."), { code: "import-settings-changed", importSettings: original });
  }
  if (!legacyRecovery) {
    const availability = importAvailability(await request("GET", { hotelUid }, captured));
    if (!pending?.requestId && isRecurringInput && (availability.recurringImportVersion !== 1 || availability.sourceFormatProfileVersion !== 1)) throw Object.assign(new Error("The recurring supplier import service update is not complete. Recover an existing upload or try again after the update."), { code: "failed-precondition" });
    if (availability.importPolicyVersion !== 2 || (!pending?.requestId || Number(pending.reviewWorkspaceVersion) === 1) && availability.reviewWorkspaceVersion !== 1) throw Object.assign(new Error("Import service update is in progress. Try again after it finishes."), { code: pending?.requestId ? "unavailable" : "failed-precondition" });
    if (!pending?.requestId && !availability.available) throw Object.assign(new Error("AI supplier imports are currently unavailable. Ask your hotel administrator for assistance."), { code: "failed-precondition" });
  }
  // Another upload can reserve the same document while the capability check is
  // awaiting the server. Preserve that original command across File instances.
  if (!pending?.requestId) {
    let stored; try { stored = JSON.parse(sessionStorage.getItem(recoveryKey) || "null"); } catch { /* Browser recovery is optional. */ }
    const concurrent = commands.get(key) || stored;
    if (concurrent?.requestId) {
      if (typeof concurrent.requestId !== "string" || !/^[a-z0-9-]{1,128}$/i.test(concurrent.requestId)) throw new Error("The original upload reference could not be verified. Contact your hotel administrator.");
      const original = publicImportSettings(typeof concurrent.importSettings === "string" ? (() => { try { return JSON.parse(concurrent.importSettings); } catch { return null; } })() : concurrent.importSettings);
      if (!original) throw Object.assign(new Error("An earlier upload must be checked before importing this document again. Contact your hotel administrator."), { code: "import-settings-unavailable" });
      if (!sameSettings(original, importSettings)) throw Object.assign(new Error("Recover the original upload with its saved price settings. These settings have been restored; retry the same file and supplier."), { code: "import-settings-changed", importSettings: original });
      pending = concurrent; recovered = concurrent;
    }
  }
  const requestId = typeof recovered?.requestId === "string" && /^[a-z0-9-]{1,128}$/i.test(recovered.requestId) ? recovered.requestId : crypto.randomUUID();
  const recoveredName = typeof recovered?.fileName === "string" && recovered.fileName.length <= 180 && recovered.fileName.length > 0 && !/[\u0000-\u001f\\/]/.test(recovered.fileName) ? recovered.fileName : file.name;
  const recoveredType = Object.values(types).includes(recovered?.mimeType) ? recovered.mimeType : mimeType;
  const reviewWorkspaceVersion = pending?.requestId ? pending.reviewWorkspaceVersion : 1;
  const recurringImportVersion = pending?.requestId ? pending.recurringImportVersion : isRecurringInput ? 1 : undefined;
  if (reviewWorkspaceVersion !== undefined && Number(reviewWorkspaceVersion) !== 1) throw new Error("The original import review version could not be verified. Contact your hotel administrator.");
  if (pending?.requestId && reviewWorkspaceVersion !== undefined && pending.mappingProfileId !== mappingProfileId) throw Object.assign(new Error("Recover the original document with its saved supplier import profile."), { code: "import-profile-changed", mappingProfileId: pending.mappingProfileId });
  const command = commands.get(key) || { hotelUid, supplierId, fileName: recoveredName, mimeType: recoveredType, requestId, ...(recurringImportVersion === undefined ? {} : { recurringImportVersion: "1" }), ...(legacyRecovery ? {} : { importSettings: JSON.stringify(importSettings) }), ...(reviewWorkspaceVersion === undefined ? {} : { reviewWorkspaceVersion: "1", mappingProfileId: pending?.mappingProfileId || mappingProfileId }) };
  commands.set(key, command);
  try { sessionStorage.setItem(recoveryKey, JSON.stringify({ requestId: command.requestId, fileName: command.fileName, mimeType: command.mimeType, ...(command.recurringImportVersion ? { recurringImportVersion: 1 } : {}), ...(legacyRecovery ? {} : { importSettings }), ...(command.reviewWorkspaceVersion ? { reviewWorkspaceVersion: 1, mappingProfileId: command.mappingProfileId } : {}) })); } catch { /* In-view retries retain the original request. */ }
  try {
    const result = await request("POST", command, captured, file);
    if (result.hotelUid !== hotelUid || result.supplierId !== supplierId || result.ownerUid !== captured.actor.uid || !id(result.jobId)) throw new Error("The import acknowledgement could not be verified. Retry the same file and supplier.");
    const confirmed = normalizeSupplierAiImportJob(result);
    if (!sameSettings(confirmed.importSettings, legacyRecovery ? null : importSettings)) throw new Error("The import price settings could not be verified. Recover the original upload.");
    if (command.recurringImportVersion && confirmed.recurringImportVersion !== 1) throw new Error("The recurring supplier import acknowledgement could not be verified. Recover the original upload.");
    if (command.reviewWorkspaceVersion && (confirmed.importReviewVersion !== 1 || confirmed.mappingProfileId !== command.mappingProfileId)) throw new Error("The import review settings could not be verified. Recover the original upload.");
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
  catch (failure) { captured.assertCurrent(); reportPurchasingError(hotelUid, "supplier-imports", failure); throw Object.assign(new Error(publicMessage(failure?.message, "The import request could not be verified. Reopen the original import.")), { code: failure?.code }); }
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
export async function saveSupplierAiImportReview(hotelUid, input) {
  try { return await command("correctHotelSupplierAiImportRow", hotelUid, input); }
  finally { invalidateProcurementReads(hotelUid); }
}
function commitRows(rows) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 1000 || rows.some((row) => !row || !id(row.rowId) || !Number.isSafeInteger(row.reviewRevision) || row.reviewRevision < 1 || row.acknowledged !== true) || new Set(rows.map((row) => row.rowId)).size !== rows.length) throw new Error("Select the latest reviewed rows before confirming this import.");
  return rows.map(({ rowId, reviewRevision }) => ({ rowId, reviewRevision, acknowledged: true }));
}
const commitKey = (hotelUid, jobId) => JSON.stringify([hotelUid, jobId]);
const commitStorageKey = (actor, hotelUid, jobId) => `supplier-ai-confirm:${actor.uid}:${hotelUid}:${jobId}`;
function recoverCommitPlan(captured, hotelUid, jobId) {
  if (!commitCommands.has(captured.actor)) commitCommands.set(captured.actor, new Map());
  const commands = commitCommands.get(captured.actor), key = commitKey(hotelUid, jobId);
  if (commands.has(key)) return commands.get(key);
  let encoded;
  try { encoded = sessionStorage.getItem(commitStorageKey(captured.actor, hotelUid, jobId)); }
  catch { return null; /* In-view recovery still works when browser storage is unavailable. */ }
  if (!encoded) return null;
  let stored;
  try {
    if (encoded.length > 200000) throw new Error("Oversized confirmation reference");
    stored = JSON.parse(encoded);
  } catch { throw new Error("The original import confirmation could not be recovered. Contact your hotel administrator before importing again."); }
  if (stored?.version !== 1 || stored.hotelUid !== hotelUid || stored.jobId !== jobId || stored.ownerUid !== captured.actor.uid || !Array.isArray(stored.batches) || !stored.batches.length || stored.batches.length > 40) throw new Error("The original import confirmation reference is invalid. Contact your hotel administrator.");
  const batches = stored.batches.map((batch) => {
    if (!id(batch?.requestId) || !Array.isArray(batch.rows) || batch.rows.length > 25) throw new Error("The original import confirmation batch is invalid.");
    return { requestId: batch.requestId, rows: commitRows(batch.rows) };
  });
  commitRows(batches.flatMap((batch) => batch.rows));
  if (new Set(batches.map((batch) => batch.requestId)).size !== batches.length) throw new Error("The original import confirmation requests are invalid.");
  // Browser progress is not authoritative. Replay all original commands after
  // reload; the server rechecks current access and returns immutable receipts.
  const plan = { offset: 0, outcomes: [], batches };
  commands.set(key, plan); return plan;
}
export function getPendingSupplierAiImportCommit(hotelUid, jobId) {
  if (!id(jobId)) throw new Error("The import reference is invalid.");
  const captured = context(hotelUid), plan = recoverCommitPlan(captured, hotelUid, jobId);
  captured.assertCurrent();
  return plan ? { hotelUid, jobId, rows: plan.batches.flatMap((batch) => batch.rows.map((row) => ({ ...row }))) } : null;
}
export async function confirmSupplierAiImport(hotelUid, jobId, rows) {
  const captured = context(hotelUid);
  if (!id(jobId)) throw new Error("The import reference is invalid.");
  const selection = commitRows(rows), original = recoverCommitPlan(captured, hotelUid, jobId);
  if (original && JSON.stringify(original.batches.flatMap((batch) => batch.rows)) !== JSON.stringify(selection)) throw Object.assign(new Error("Finish recovering the original import confirmation before changing its selected products."), { code: "import-confirmation-pending", rows: original.batches.flatMap((batch) => batch.rows.map((row) => ({ ...row }))) });
  const commands = commitCommands.get(captured.actor), key = commitKey(hotelUid, jobId);
  const plan = original || { offset: 0, outcomes: [], batches: Array.from({ length: Math.ceil(selection.length / 25) }, (_, index) => ({ requestId: crypto.randomUUID(), rows: selection.slice(index * 25, index * 25 + 25) })) };
  commands.set(key, plan);
  if (plan.inFlight) return plan.inFlight;
  try { sessionStorage.setItem(commitStorageKey(captured.actor, hotelUid, jobId), JSON.stringify({ version: 1, hotelUid, jobId, ownerUid: captured.actor.uid, batches: plan.batches })); } catch { /* In-view recovery retains the original commands when browser storage is unavailable. */ }
  plan.inFlight = (async () => {
    while (plan.offset < plan.batches.length) {
      captured.assertCurrent();
      const batch = plan.batches[plan.offset], result = await command("commitHotelSupplierAiImportRows", hotelUid, { jobId, ...batch });
      if (result.complete !== true || !Array.isArray(result.outcomes) || result.outcomes.length !== batch.rows.length || result.outcomes.some((row, index) => row.rowId !== batch.rows[index].rowId || !["created", "updated", "unchanged", "blocked"].includes(row.status) || (row.status !== "blocked" && (!id(row.productId) || !Number.isSafeInteger(row.revision) || row.revision < 0)))) throw new Error("The import acknowledgement is incomplete. Retry the same selected rows.");
      plan.outcomes.push(...result.outcomes); plan.offset += 1;
    }
    commands.delete(key);
    try { sessionStorage.removeItem(commitStorageKey(captured.actor, hotelUid, jobId)); } catch { /* Replaying a leftover receipt remains idempotent. */ }
    return { hotelUid, jobId, outcomes: plan.outcomes, complete: true };
  })().finally(() => { plan.inFlight = null; invalidateProcurementReads(hotelUid); });
  return plan.inFlight;
}
