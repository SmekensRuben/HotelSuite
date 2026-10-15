const { onRequest, HttpsError } = require("firebase-functions/v2/https");
const { createHash } = require("node:crypto");
const { admin } = require("./config");
const { requireHotelPermission } = require("./authorization");
const { strictId } = require("./contractFiles");
const { text, revision } = require("./validation");
const { requireSaasRollout } = require("./saasRollout");

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_ATTACHMENTS = 10;
// A bounded lifetime upload allowance also covers replacements and interrupted saves.
const MAX_UPLOADS_PER_REQUEST = 50;
const MIME_TYPES = Object.freeze({ pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", txt: "text/plain", csv: "text/csv", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
const editableStatuses = new Set(["draft", "returned"]);
const fileIdOf = (value) => {
  if (typeof value !== "string" || !/^[a-f0-9]{32}$/.test(value)) throw new HttpsError("invalid-argument", "A valid attachment ID is required.");
  return value;
};
const requestRef = (db, hotelUid, id) => db.doc(`hotels/${hotelUid}/purchaseRequests/${id}`);
const filePath = (hotelUid, id, fileId) => `private/purchase-requests/${hotelUid}/${id}/${fileId}`;

// Inspect only the bounded ZIP directory. Office files are stored as opaque bytes;
// the service never extracts, renders, executes or follows links in documents.
function inspectOfficeArchive(bytes, extension) {
  let end = -1;
  for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 65557); index -= 1) {
    if (bytes.readUInt32LE(index) === 0x06054b50) { end = index; break; }
  }
  if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)
    || bytes.readUInt16LE(end + 8) !== bytes.readUInt16LE(end + 10)
    || end + 22 + bytes.readUInt16LE(end + 20) !== bytes.length) return false;
  const count = bytes.readUInt16LE(end + 10), length = bytes.readUInt32LE(end + 12), start = bytes.readUInt32LE(end + 16);
  if (!count || count > 2048 || start + length !== end) return false;
  let position = start, expanded = 0;
  const names = new Set();
  for (let index = 0; index < count; index += 1) {
    if (position + 46 > end || bytes.readUInt32LE(position) !== 0x02014b50) return false;
    const flags = bytes.readUInt16LE(position + 8), method = bytes.readUInt16LE(position + 10);
    const compressed = bytes.readUInt32LE(position + 20), uncompressed = bytes.readUInt32LE(position + 24);
    const nameLength = bytes.readUInt16LE(position + 28), extra = bytes.readUInt16LE(position + 30), comment = bytes.readUInt16LE(position + 32);
    const localOffset = bytes.readUInt32LE(position + 42), next = position + 46 + nameLength + extra + comment;
    if (next > end || flags & 1 || ![0, 8].includes(method) || !nameLength || localOffset + 30 > start
      || bytes.readUInt32LE(localOffset) !== 0x04034b50 || compressed > bytes.length) return false;
    const name = bytes.subarray(position + 46, position + 46 + nameLength).toString("utf8");
    if (name.startsWith("/") || name.includes("\\") || name.split("/").some((part) => part === "..")
      || /[\u0000-\u001f]/.test(name) || names.has(name) || /vbaproject|\.exe$|\.dll$|\.js$|\.vbs$/i.test(name)) return false;
    expanded += uncompressed;
    if (expanded > 100 * 1024 * 1024 || uncompressed > Math.max(1024 * 1024, compressed * 200)) return false;
    names.add(name); position = next;
  }
  return position === end && names.has("[Content_Types].xml") && names.has(extension === "docx" ? "word/document.xml" : "xl/workbook.xml");
}

function validateAttachmentBytes(bytes, name, suppliedType) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_ATTACHMENT_BYTES) throw new HttpsError("invalid-argument", "Upload a nonempty document of at most 10 MiB.");
  const fileName = text(name, "fileName", 180, true);
  if (/[\r\n/\\]/.test(fileName) || fileName === "." || fileName === "..") throw new HttpsError("invalid-argument", "Choose a valid document filename.");
  const extension = fileName.split(".").at(-1).toLowerCase(), contentType = MIME_TYPES[extension];
  if (!contentType || suppliedType && ![contentType, "application/octet-stream"].includes(suppliedType)) throw new HttpsError("invalid-argument", "Supported attachments are PDF, PNG, JPEG, DOCX, XLSX, TXT and CSV.");
  let valid = false;
  if (extension === "pdf") valid = bytes.subarray(0, 5).toString() === "%PDF-" && bytes.subarray(-1024).includes(Buffer.from("%%EOF"));
  else if (extension === "png") valid = bytes.length >= 45 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.subarray(12, 16).toString() === "IHDR" && bytes.subarray(-8, -4).toString() === "IEND";
  else if (["jpg", "jpeg"].includes(extension)) valid = bytes.length > 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && bytes.at(-2) === 255 && bytes.at(-1) === 217;
  else if (["docx", "xlsx"].includes(extension)) valid = bytes.length >= 22 && inspectOfficeArchive(bytes, extension);
  else {
    try { const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes); valid = !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value); } catch { valid = false; }
  }
  if (!valid) throw new HttpsError("invalid-argument", "The document content does not match a supported file type.");
  return { fileName, contentType, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function attachmentView(data, hotelUid, id, fileId) {
  if (!data || data.status !== "ready" || data.purchaseRequestId !== id || data.fileId !== fileId
    || data.filePath !== filePath(hotelUid, id, fileId) || !/^[a-f0-9]{64}$/.test(data.sha256 || "")
    || !/^\d+$/.test(data.generation || "") || !Number.isSafeInteger(data.size) || data.size < 1 || data.size > MAX_ATTACHMENT_BYTES
    || !Object.values(MIME_TYPES).includes(data.contentType)) throw new HttpsError("failed-precondition", "An attachment is unavailable. Upload it again before saving.");
  return { fileId, fileName: text(data.fileName, "fileName", 180, true), filePath: data.filePath, size: data.size, contentType: data.contentType, sha256: data.sha256, generation: data.generation };
}

async function validatePurchaseRequestAttachments(tx, db, hotelUid, id, ids = []) {
  if (!Array.isArray(ids) || ids.length > MAX_ATTACHMENTS || new Set(ids).size !== ids.length) throw new HttpsError("invalid-argument", "Choose at most 10 distinct attachments.");
  return Promise.all(ids.map(async (value) => {
    const fileId = fileIdOf(value), ref = db.doc(`hotels/${hotelUid}/purchaseRequests/${id}/attachments/${fileId}`);
    const snapshot = await tx.get(ref);
    return attachmentView(snapshot.data(), hotelUid, id, fileId);
  }));
}

async function authorize(db, request, hotelUid, action, tx, services) {
  await requireSaasRollout(db, tx);
  if (action !== "read") await requireHotelPermission(db, request, hotelUid, "purchaserequests", "read", tx, services.auth);
  await requireHotelPermission(db, request, hotelUid, "purchaserequests", action, tx, services.auth);
}
function requireEditable(current, request, expectedRevision) {
  if (!current.exists) throw new HttpsError("not-found", "Save the purchase request before adding documents.");
  const data = current.data();
  if (data.requesterUid !== request.auth.uid || !editableStatuses.has(data.status)) throw new HttpsError("permission-denied", "Only the requester can change documents on a draft or returned request.");
  if (data.revision !== expectedRevision) throw new HttpsError("aborted", "The purchase request changed. Reload before uploading.");
  return data;
}

async function uploadPurchaseRequestAttachment(request, data, bytes, services = {}) {
  const hotelUid = strictId(data.hotelUid, "hotelUid"), id = strictId(data.purchaseRequestId, "purchaseRequestId"), fileId = fileIdOf(data.fileId);
  const expectedRevision = revision(typeof data.expectedRevision === "string" && /^\d+$/.test(data.expectedRevision) ? Number(data.expectedRevision) : data.expectedRevision);
  const details = validateAttachmentBytes(bytes, data.fileName, data.contentType);
  const db = services.firestore || admin.firestore(), bucket = services.bucket || admin.storage().bucket();
  const ref = requestRef(db, hotelUid, id), attachmentRef = ref.collection("attachments").doc(fileId), path = filePath(hotelUid, id, fileId);
  const fingerprint = createHash("sha256").update(JSON.stringify([request.auth?.uid, id, fileId, details])).digest("hex");
  // Persist the upload intent first. An interrupted upload is recoverable with the
  // same ID, while an unattached object can never become approved evidence.
  const existing = await db.runTransaction(async (tx) => {
    await authorize(db, request, hotelUid, "update", tx, services);
    const [current, previous, uploads] = await Promise.all([tx.get(ref), tx.get(attachmentRef), tx.get(ref.collection("attachments").limit(MAX_UPLOADS_PER_REQUEST + 1))]);
    requireEditable(current, request, expectedRevision);
    if (previous.exists) {
      if (previous.data().fingerprint !== fingerprint || previous.data().ownerUid !== request.auth.uid) throw new HttpsError("already-exists", "This attachment ID belongs to another upload.");
      return previous.data();
    }
    if (uploads.size >= MAX_UPLOADS_PER_REQUEST) throw new HttpsError("resource-exhausted", "This request has reached its document upload limit. Contact a hotel administrator.");
    tx.create(attachmentRef, { ...details, fileId, filePath: path, purchaseRequestId: id, ownerUid: request.auth.uid, fingerprint, status: "uploading", createdAt: admin.firestore.FieldValue.serverTimestamp() });
    return null;
  });
  if (existing?.status === "ready") return { attachment: attachmentView(existing, hotelUid, id, fileId), revision: expectedRevision };
  const object = bucket.file(path);
  let generation;
  try {
    try {
      await object.save(bytes, { resumable: false, preconditionOpts: { ifGenerationMatch: 0 }, metadata: { contentType: "application/octet-stream", cacheControl: "private, no-store", metadata: { sha256: details.sha256, ownerUid: request.auth.uid } } });
    } catch (error) {
      if (Number(error.code) !== 412) throw error;
    }
    const [metadata] = await object.getMetadata();
    if (metadata.metadata?.sha256 !== details.sha256 || metadata.metadata?.ownerUid !== request.auth.uid || Number(metadata.size) !== bytes.length
      || metadata.contentEncoding && metadata.contentEncoding !== "identity") throw new HttpsError("already-exists", "This attachment ID belongs to different document bytes.");
    generation = String(metadata.generation);
    return await db.runTransaction(async (tx) => {
      await authorize(db, { auth: request.auth }, hotelUid, "update", tx, services);
      const [current, uploaded] = await Promise.all([tx.get(ref), tx.get(attachmentRef)]);
      requireEditable(current, request, expectedRevision);
      if (!uploaded.exists || uploaded.data().fingerprint !== fingerprint) throw new HttpsError("aborted", "The document upload changed. Reload before retrying.");
      const attachment = attachmentView({ ...uploaded.data(), generation, status: "ready" }, hotelUid, id, fileId);
      tx.update(attachmentRef, { generation, status: "ready", completedAt: admin.firestore.FieldValue.serverTimestamp() });
      return { attachment, revision: expectedRevision };
    });
  } catch (error) {
    // Keep the persisted intent and generation for an exact retry. Never delete
    // a generation that another successful retry may already have attached.
    try { await attachmentRef.set({ lastFailureAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true }); } catch { /* The persisted upload intent remains safe to retry. */ }
    throw error;
  }
}

async function readPurchaseRequestAttachment(request, data, services = {}) {
  const hotelUid = strictId(data.hotelUid, "hotelUid"), id = strictId(data.purchaseRequestId, "purchaseRequestId"), fileId = fileIdOf(data.fileId);
  const db = services.firestore || admin.firestore(), bucket = services.bucket || admin.storage().bucket(), ref = requestRef(db, hotelUid, id);
  const requestedRevision = data.revision === undefined ? null : revision(typeof data.revision === "string" && /^\d+$/.test(data.revision) ? Number(data.revision) : data.revision);
  async function resolve() {
    // A new request wrapper prevents the per-request identity cache from hiding
    // an account revocation while document bytes were being downloaded.
    await authorize(db, { auth: request.auth }, hotelUid, "read", undefined, services);
    const current = await ref.get();
    if (!current.exists) throw new HttpsError("not-found", "Purchase request not found.");
    const source = requestedRevision === null ? current : await ref.collection("history").doc(String(requestedRevision).padStart(6, "0")).get();
    const sourceData = source.data();
    // Core history records expose their immutable snapshot as `request`.
    let attachment = (sourceData?.request || sourceData?.snapshot || sourceData)?.attachments?.find((file) => file.fileId === fileId);
    if (!attachment && requestedRevision === null && current.data().requesterUid === request.auth.uid && editableStatuses.has(current.data().status)) {
      const pending = await ref.collection("attachments").doc(fileId).get();
      if (pending.data()?.ownerUid === request.auth.uid) attachment = pending.data();
    }
    if (!attachment) throw new HttpsError("not-found", "This document does not belong to the selected request revision.");
    return attachmentView({ ...attachment, status: "ready", purchaseRequestId: id }, hotelUid, id, fileId);
  }
  const attachment = await resolve(), object = bucket.file(attachment.filePath, { generation: attachment.generation });
  const [metadata] = await object.getMetadata();
  if (String(metadata.generation) !== attachment.generation || Number(metadata.size) !== attachment.size || metadata.metadata?.sha256 !== attachment.sha256
    || metadata.contentEncoding && metadata.contentEncoding !== "identity") throw new HttpsError("failed-precondition", "The document no longer matches its approved source.");
  const [bytes] = await object.download({ decompress: false });
  if (bytes.length !== attachment.size || bytes.length > MAX_ATTACHMENT_BYTES || createHash("sha256").update(bytes).digest("hex") !== attachment.sha256) throw new HttpsError("failed-precondition", "Document integrity verification failed.");
  const latest = await resolve();
  if (latest.sha256 !== attachment.sha256 || latest.generation !== attachment.generation) throw new HttpsError("aborted", "The selected document changed. Reload before downloading.");
  return { bytes, fileName: attachment.fileName };
}

const statusFor = { unauthenticated: 401, "permission-denied": 403, "not-found": 404, "invalid-argument": 400, "failed-precondition": 409, "resource-exhausted": 429, "already-exists": 409, aborted: 409 };
async function purchaseRequestDocumentHandler(req, res, services = {}) {
  res.set("Cache-Control", "private, no-store"); res.set("X-Content-Type-Options", "nosniff");
  if (!["GET", "POST"].includes(req.method)) return res.status(405).json({ error: "Use GET or POST." });
  try {
    const header = req.headers.authorization;
    if (typeof header !== "string" || !/^Bearer \S+$/.test(header)) throw new HttpsError("unauthenticated", "Sign in to access purchase request documents.");
    let token;
    try { token = await (services.auth || admin.auth()).verifyIdToken(header.slice(7), true); } catch { throw new HttpsError("unauthenticated", "Your session has expired. Sign in again."); }
    const request = { auth: { uid: token.uid, token } };
    if (req.method === "POST") {
      if (req.headers["content-type"] !== "application/octet-stream") throw new HttpsError("invalid-argument", "Use a binary document upload.");
      return res.status(200).json(await uploadPurchaseRequestAttachment(request, req.query, req.rawBody, services));
    }
    const file = await readPurchaseRequestAttachment(request, req.query, services);
    res.set("Content-Type", "application/octet-stream");
    res.set("Content-Disposition", "attachment; filename*=UTF-8''" + encodeURIComponent(file.fileName));
    return res.status(200).send(file.bytes);
  } catch (error) {
    const status = statusFor[error.code] || 500;
    return res.status(status).json({ error: status === 500 ? "The document could not be processed. Please retry the same upload." : error.message });
  }
}

module.exports = { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, MAX_UPLOADS_PER_REQUEST, validateAttachmentBytes, inspectOfficeArchive, attachmentView, validatePurchaseRequestAttachments,
  uploadPurchaseRequestAttachment, readPurchaseRequestAttachment, purchaseRequestDocumentHandler,
  purchaseRequestDocument: onRequest({ region: "us-central1", cors: true, memory: "256MiB", concurrency: 4, maxInstances: 5, timeoutSeconds: 120 }, purchaseRequestDocumentHandler) };
