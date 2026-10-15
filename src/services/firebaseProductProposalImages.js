import { auth, functions, httpsCallable } from "../firebaseConfig";
import { invalidateProcurementReads, poolProcurementRead, procurementReadScope } from "./procurementReadPool";
import { validateSupplierImageFile } from "./firebaseSupplierProductImages";

const pending = new WeakMap();
const id = (value) => typeof value === "string" && value.length > 0 && value.length <= 128 && value.trim() === value && ![".", ".."].includes(value) && !/[\\/\u0000-\u001f\u007f]/.test(value);
const revision = (value) => Number.isSafeInteger(value) && value >= 0;
const terminal = new Set(["invalid-argument", "permission-denied", "unauthenticated", "not-found", "already-exists", "aborted", "failed-precondition"]);

function capture(hotelUid, batchId, rowId) {
  const actor = auth.currentUser, scope = procurementReadScope(hotelUid);
  if (!actor?.uid || ![hotelUid, batchId, rowId].every(id) || !scope) throw new Error("Sign in and choose a product proposal from this hotel.");
  return { actor, assert() { if (auth.currentUser !== actor || !scope.current()) throw new Error("Hotel access changed. Reopen this product proposal."); } };
}
function key(hotelUid, batchId, rowId) { return JSON.stringify([hotelUid, batchId, rowId]); }
function commands(actor = auth.currentUser) {
  if (!actor?.uid) throw new Error("Sign in before reviewing a proposed image.");
  if (!pending.has(actor)) pending.set(actor, new Map());
  return pending.get(actor);
}
export function getPendingProductProposalImageAction(hotelUid, batchId, rowId) {
  if (!auth.currentUser?.uid) return null;
  return commands().get(key(hotelUid, batchId, rowId)) || null;
}
export function safeProductProposalImageUrl(value) {
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password ? url.href : null; } catch { return null; }
}
function endpoint() {
  const project = functions.app.options.projectId;
  if (!/^[a-z0-9-]+$/.test(project)) throw new Error("The product proposal image service is not configured.");
  return `https://us-central1-${project}.cloudfunctions.net/hotelMcpProposalImage`;
}
async function http(method, input, operation, file) {
  const token = await operation.actor.getIdToken(); operation.assert();
  const response = await fetch(`${endpoint()}?${new URLSearchParams(input)}`, { method,
    headers: { Authorization: `Bearer ${token}`, ...(file ? { "Content-Type": "application/octet-stream" } : {}) },
    ...(file ? { body: file } : {}), cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" });
  operation.assert();
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw Object.assign(new Error(result.error?.message || "The proposed image request could not be verified. Retry this image action."), { code: result.error?.code || "unavailable" });
  }
  const result = method === "GET" ? await response.blob() : await response.json(); operation.assert(); return result;
}
function acknowledgement(data, input) {
  if (data?.hotelUid !== input.hotelUid || data.batchId !== input.batchId || data.rowId !== input.rowId || !revision(data.batchRevision) || !id(data.image?.assetId) || !["preparing", "ready", "failed", "expired"].includes(data.image.status) || !["unselected", "selected", "omitted"].includes(data.image.selection) || !revision(data.image.decisionRevision)) throw new Error("The proposed image acknowledgement could not be verified. Retry the original image action.");
  return data;
}
async function execute(command) {
  const { input, kind, file } = command, operation = capture(input.hotelUid, input.batchId, input.rowId), cache = commands(operation.actor), resource = key(input.hotelUid, input.batchId, input.rowId);
  const original = cache.get(resource);
  if (original && (original.kind !== kind || original.file !== file || JSON.stringify(original.input) !== JSON.stringify(input))) throw new Error("Retry the original image action before changing the image proposal.");
  cache.set(resource, command);
  try {
    const data = kind === "file" ? await http("POST", input, operation, file) : (await httpsCallable(functions, kind === "url" ? "prepareHotelMcpProposalImage" : "decideHotelMcpProposalImage")(input)).data;
    operation.assert(); const result = acknowledgement(data, input);
    const preparing = result.image.status === "preparing" && (kind !== "decision" || input.action === "retry");
    const attaching = kind === "decision" && input.action === "attach" && result.image.attachment?.status === "attaching";
    if (!preparing && !attaching) cache.delete(resource);
    return result;
  } catch (failure) {
    operation.assert();
    if (terminal.has(String(failure.code || "").replace(/^functions\//, ""))) cache.delete(resource);
    throw failure;
  } finally { invalidateProcurementReads(input.hotelUid); }
}
export async function prepareProductProposalImage(hotelUid, batchId, rowId, { imageUrl, sourcePageUrl } = {}) {
  capture(hotelUid, batchId, rowId);
  const normalizedUrl = safeProductProposalImageUrl(imageUrl), normalizedPage = sourcePageUrl ? safeProductProposalImageUrl(sourcePageUrl) : null;
  if (!normalizedUrl || (sourcePageUrl && !normalizedPage)) throw new Error("Use an HTTPS image URL and optional HTTPS source page without embedded credentials.");
  const input = { hotelUid, batchId, rowId, imageUrl: normalizedUrl, ...(normalizedPage ? { sourcePageUrl: normalizedPage } : {}) };
  const original = getPendingProductProposalImageAction(hotelUid, batchId, rowId);
  return execute({ kind: "url", input: { ...input, requestId: original?.kind === "url" ? original.input.requestId : crypto.randomUUID() } });
}
export async function uploadProductProposalImage(hotelUid, batchId, rowId, file) {
  capture(hotelUid, batchId, rowId); validateSupplierImageFile(file);
  const original = getPendingProductProposalImageAction(hotelUid, batchId, rowId);
  return execute({ kind: "file", file, input: { hotelUid, batchId, rowId, requestId: original?.kind === "file" && original.file === file ? original.input.requestId : crypto.randomUUID(), mimeType: file.type } });
}
export async function decideProductProposalImage(hotelUid, batchId, rowId, { assetId, expectedBatchRevision, action, replaceExisting = false, expectedImageRevision } = {}) {
  capture(hotelUid, batchId, rowId);
  if (!id(assetId) || !revision(expectedBatchRevision) || !["select", "omit", "attach", "retry"].includes(action) || typeof replaceExisting !== "boolean" || (replaceExisting && !revision(expectedImageRevision))) throw new Error("Review the current image and its revision before choosing an image action.");
  const original = getPendingProductProposalImageAction(hotelUid, batchId, rowId);
  return execute({ kind: "decision", input: { hotelUid, batchId, rowId, assetId, expectedBatchRevision, action, replaceExisting, ...(expectedImageRevision === undefined ? {} : { expectedImageRevision }), requestId: original?.kind === "decision" ? original.input.requestId : crypto.randomUUID() } });
}
export function retryProductProposalImageAction(hotelUid, batchId, rowId) {
  const original = getPendingProductProposalImageAction(hotelUid, batchId, rowId);
  if (!original) return Promise.reject(new Error("No pending image action is available."));
  return execute(original);
}
export function getProductProposalImage(hotelUid, batchId, rowId, image, variant = "display") {
  const operation = capture(hotelUid, batchId, rowId);
  if (!id(image?.assetId) || image.status !== "ready" || !["thumbnail", "display"].includes(variant)) return Promise.reject(new Error("The proposed image preview is not ready."));
  return poolProcurementRead(hotelUid, `product-proposal-image:${batchId}:${rowId}:${image.assetId}:${variant}`, async () => {
    const blob = await http("GET", { hotelUid, batchId, rowId, assetId: image.assetId, variant }, operation);
    if (!blob || blob.type !== "image/webp" || blob.size <= 0 || blob.size > 1024 * 1024) throw new Error("The proposed image preview could not be verified.");
    return blob;
  });
}
