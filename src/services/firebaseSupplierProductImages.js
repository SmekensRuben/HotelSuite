import { auth, functions } from "../firebaseConfig";
import { invalidateProcurementReads, poolProcurementRead, procurementReadScope } from "./procurementReadPool";

export const MAX_SUPPLIER_IMAGE_BYTES = 5 * 1024 * 1024;
export const SUPPLIER_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
const id = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const terminal = new Set(["invalid-argument", "permission-denied", "unauthenticated", "not-found", "already-exists", "aborted", "failed-precondition"]);
const pending = new WeakMap();
export function validateSupplierImageFile(file) {
  if (!file || !Number.isSafeInteger(file.size) || file.size <= 0 || file.size > MAX_SUPPLIER_IMAGE_BYTES) throw new Error("Choose an image between 1 byte and 5 MiB.");
  if (!SUPPLIER_IMAGE_TYPES.includes(file.type)) throw new Error("Choose a JPEG, PNG or WebP image. Animated images and SVG files are not supported.");
}
function endpoint() {
  const project = functions.app.options.projectId;
  if (!/^[a-z0-9-]+$/.test(project)) throw new Error("The product image service is not configured.");
  return `https://us-central1-${project}.cloudfunctions.net/supplierProductImage`;
}
async function request(method, input, actor, file) {
  const token = await actor.getIdToken();
  if (auth.currentUser !== actor) throw new Error("Hotel access changed. Reload this view.");
  const response = await fetch(`${endpoint()}?${new URLSearchParams(input)}`, {
    method, headers: { Authorization: `Bearer ${token}`, ...(file ? { "Content-Type": "application/octet-stream" } : {}) },
    ...(file ? { body: file } : {}), cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer",
  });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw Object.assign(new Error(result.error?.message || "The product image response could not be verified. Retry or reload the product."), { code: result.error?.code || "unavailable" });
  }
  const result = await (method === "GET" ? response.blob() : response.json());
  if (auth.currentUser !== actor) throw new Error("Hotel access changed. Reload this view.");
  return result;
}
export async function uploadSupplierProductImage(hotelUid, product, file) {
  validateSupplierImageFile(file);
  const actor = auth.currentUser;
  if (!actor?.uid || !id(hotelUid) || !id(product?.id)) throw new Error("Choose a saved product from the current hotel before uploading its image.");
  const revision = product.imageRevision ?? 0;
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("The product image revision needs review. Reload the product.");
  if (!pending.has(actor)) pending.set(actor, new WeakMap());
  const files = pending.get(actor);
  if (!files.has(file)) files.set(file, new Map());
  const commands = files.get(file), key = JSON.stringify([hotelUid, product.id, revision]);
  const command = commands.get(key) || { hotelUid, productId: product.id, expectedImageRevision: String(revision), requestId: crypto.randomUUID(), mimeType: file.type };
  commands.set(key, command);
  const scope = procurementReadScope(hotelUid);
  try {
    const result = await request("POST", command, actor, file);
    if (scope && !scope.current()) throw new Error("Hotel access changed. Reload this view.");
    if (result?.hotelUid !== hotelUid || result.productId !== product.id || !id(result.assetId)
      || result.imageRevision !== revision + 1 || !["pending", "ready", "failed"].includes(result.status)) throw new Error("The image upload acknowledgement could not be verified. Retry the same file or reload the product.");
    commands.delete(key);
    return result;
  } catch (error) {
    if (terminal.has(String(error.code || "").replace(/^functions\//, ""))) commands.delete(key);
    throw error;
  } finally { invalidateProcurementReads(hotelUid); }
}

export function getSupplierProductImage(hotelUid, product, variant = "thumbnail") {
  const actor = auth.currentUser, assetId = product?.image?.assetId;
  if (!actor?.uid || !id(hotelUid) || !id(product?.id) || !id(assetId) || !["thumbnail", "display"].includes(variant)) return Promise.reject(new Error("The managed product image is unavailable."));
  return poolProcurementRead(hotelUid, `supplier-image:${product.id}:${assetId}:${variant}`, async () => {
    const blob = await request("GET", { hotelUid, productId: product.id, assetId, variant }, actor);
    if (!blob || blob.type !== "image/webp" || !blob.size || blob.size > MAX_SUPPLIER_IMAGE_BYTES) throw new Error("The product image response is invalid.");
    return blob;
  });
}
