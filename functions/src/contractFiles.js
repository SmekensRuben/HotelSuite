const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { createHash } = require("node:crypto");
const { admin } = require("./config");
const { requireHotelPermission } = require("./authorization");
const { requireDocumentId, requireHotelSubscription } = require("./subscriptions");
const { requirePrivateWorkflows, requireCurrentStaff, privateWorkflowsEnabled } = require("./privateWorkflows");
const { text, revision, digest } = require("./validation");

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_FILES = 20;
const options = { region: "us-central1", cors: true, memory: "512MiB", concurrency: 4, maxInstances: 5, timeoutSeconds: 120 };
const detailsFields = ["name", "startDate", "endDate", "pricePerMonth", "terminationPeriodDays", "cancelBefore", "category", "categoryId", "subcategory", "subcategoryId", "reminderDays", "followers"];
function strictId(value, field) {
  const id = requireDocumentId(value, field);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new HttpsError("invalid-argument", field + " contains unsupported characters.");
  return id;
}
function contractDate(value, field) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new HttpsError("invalid-argument", field + " must be a calendar date.");
  const date = new Date(value + "T00:00:00Z");
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new HttpsError("invalid-argument", field + " is invalid.");
  return value;
}
function filesOf(data, hotelUid, contractId) {
  const source = data.contractFiles?.length ? data.contractFiles : data.contractFile ? [data.contractFile] : [];
  if (!Array.isArray(source) || source.length > MAX_FILES) throw new HttpsError("failed-precondition", "Contract attachments need operator review.");
  return source.map((file) => {
    const path = file.filePath;
    const legacyPrefix = "hotels/" + hotelUid + "/contracts/" + contractId + "/";
    const privatePrefix = "private/contracts/" + hotelUid + "/" + contractId + "/";
    if (typeof path !== "string" || path.length > 1000 || (!path.startsWith(legacyPrefix) && !path.startsWith(privatePrefix))
      || path.split("/").some((part) => !part || [".", ".."].includes(part)) || /[\u0000-\u001f]/.test(path)) {
      throw new HttpsError("failed-precondition", "A contract attachment is not scoped to this contract. Operator review is required.");
    }
    const fileId = file.fileId || createHash("sha256").update(path).digest("hex").slice(0, 32);
    if (!/^[a-f0-9]{32}$/.test(fileId)) throw new HttpsError("failed-precondition", "Contract file ID is invalid.");
    if (path.startsWith(privatePrefix) && path !== privatePrefix + fileId) throw new HttpsError("failed-precondition", "Contract file path does not match its ID.");
    return { fileId, fileName: text(file.fileName, "fileName", 200, true), filePath: path,
      ...(Number.isSafeInteger(file.size) ? { size: file.size } : {}) };
  });
}
function contractView(id, data, hotelUid) {
  const view = { id, revision: data.revision || 0, contractFiles: filesOf(data, hotelUid, id) };
  for (const field of detailsFields) if (Object.hasOwn(data, field)) view[field] = data[field];
  return view;
}
async function authorize(db, request, hotelUid, action, tx, auth = admin.auth()) {
  await requireCurrentStaff(request, auth);
  await requireHotelPermission(db, request, hotelUid, "contracts", action, tx);
  // Private operational files require an active subscription even for operators.
  await requireHotelSubscription(db, hotelUid, tx);
}
async function listHotelContractsHandler(request, services = {}) {
  const hotelUid = strictId(request.data?.hotelUid, "hotelUid");
  const db = services.firestore || admin.firestore();
  await authorize(db, request, hotelUid, "read", undefined, services.auth);
  if (request.data?.contractId) {
    const id = strictId(request.data.contractId, "contractId");
    const snap = await db.doc("hotels/" + hotelUid + "/contracts/" + id).get();
    return { contract: snap.exists ? contractView(id, snap.data(), hotelUid) : null, privateWorkflowsEnabled: await privateWorkflowsEnabled(db) };
  }
  let query = db.collection("hotels/" + hotelUid + "/contracts").orderBy(admin.firestore.FieldPath.documentId());
  if (request.data?.afterId) query = query.startAfter(strictId(request.data.afterId, "afterId"));
  const page = await query.limit(101).get();
  return { contracts: page.docs.slice(0, 100).map((s) => contractView(s.id, s.data(), hotelUid)), nextCursor: page.size > 100 ? page.docs[99].id : null };
}
function contractInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((k) => !detailsFields.includes(k))) throw new HttpsError("invalid-argument", "Unexpected contract fields.");
  const result = {};
  for (const key of ["name", "category", "categoryId", "subcategory", "subcategoryId"]) result[key] = text(input[key] ?? "", key, 200, key === "name");
  result.startDate = contractDate(input.startDate, "startDate");
  result.endDate = contractDate(input.endDate, "endDate");
  if (result.endDate < result.startDate) throw new HttpsError("invalid-argument", "The end date must follow the start date.");
  if (!Number.isFinite(input.pricePerMonth) || input.pricePerMonth < 0 || input.pricePerMonth > 10000000) throw new HttpsError("invalid-argument", "Monthly price is invalid.");
  if (!Number.isSafeInteger(input.terminationPeriodDays) || input.terminationPeriodDays < 0 || input.terminationPeriodDays > 3650) throw new HttpsError("invalid-argument", "Termination period must be 0–3650 whole days.");
  result.pricePerMonth = Math.round(input.pricePerMonth * 100) / 100;
  result.terminationPeriodDays = input.terminationPeriodDays;
  const cancellation = new Date(result.endDate + "T00:00:00Z");
  cancellation.setUTCDate(cancellation.getUTCDate() - result.terminationPeriodDays);
  result.cancelBefore = cancellation.toISOString().slice(0, 10);
  if (!Array.isArray(input.reminderDays) || input.reminderDays.length > 20 || input.reminderDays.some((day) => !Number.isSafeInteger(day) || day < 0 || day > 3650)) throw new HttpsError("invalid-argument", "Reminder days must be bounded whole days.");
  result.reminderDays = [...new Set(input.reminderDays)].sort((a, b) => b - a);
  if (!Array.isArray(input.followers) || input.followers.length > 20) throw new HttpsError("invalid-argument", "At most 20 contract followers are supported.");
  result.followers = [...new Set(input.followers.map((f) => strictId(f.id, "followerId")))];
  return result;
}
async function followerDirectory(db, auth, hotelUid, ids, tx) {
  return Promise.all(ids.map(async (id) => {
    const ref = db.doc("hotels/" + hotelUid + "/members/" + id);
    const membership = tx ? await tx.get(ref) : await ref.get();
    let user;
    try { user = await auth.getUser(id); } catch { throw new HttpsError("failed-precondition", "A selected follower is no longer available."); }
    if (!membership.exists || user.disabled || !user.emailVerified || !user.email) throw new HttpsError("failed-precondition", "Followers must be verified, active hotel members.");
    return { id, email: user.email, name: user.displayName || user.email };
  }));
}
async function listContractFollowersHandler(request, services = {}) {
  const hotelUid = strictId(request.data?.hotelUid, "hotelUid");
  const db = services.firestore || admin.firestore(), auth = services.auth || admin.auth();
  await authorize(db, request, hotelUid, request.data?.editing === true ? "update" : "create", undefined, auth);
  const members = await db.collection("hotels/" + hotelUid + "/members").limit(101).get();
  if (members.size > 100) throw new HttpsError("resource-exhausted", "The hotel directory needs pagination before it can be used here.");
  const users = await Promise.all(members.docs.map(async (s) => {
    try { const u = await auth.getUser(s.id); return !u.disabled && u.emailVerified && u.email ? { id: u.uid, uid: u.uid, email: u.email, name: u.displayName || u.email } : null; } catch { return null; }
  }));
  return { users: users.filter(Boolean), privateWorkflowsEnabled: await privateWorkflowsEnabled(db) };
}
async function saveHotelContractHandler(request, services = {}) {
  const input = request.data || {}, hotelUid = strictId(input.hotelUid, "hotelUid"), requestId = strictId(input.requestId, "requestId");
  const creating = input.creating === true;
  const id = strictId(input.contractId, "contractId"), expectedRevision = revision(input.expectedRevision);
  const payload = contractInput(input.contract);
  const keepFileIds = input.keepFileIds || [];
  if (!Array.isArray(keepFileIds) || keepFileIds.length > MAX_FILES || keepFileIds.some((id) => !/^[a-f0-9]{32}$/.test(id)) || new Set(keepFileIds).size !== keepFileIds.length) throw new HttpsError("invalid-argument", "Invalid attachment selection.");
  const uploadFileIds = input.uploadFileIds || [];
  if (!Array.isArray(uploadFileIds) || uploadFileIds.length + keepFileIds.length > MAX_FILES || uploadFileIds.some((key) => !/^[a-f0-9]{32}$/.test(key)) || new Set(uploadFileIds).size !== uploadFileIds.length) throw new HttpsError("invalid-argument", "Invalid upload selection.");
  const fingerprint = digest(id, creating, expectedRevision, payload, keepFileIds, uploadFileIds);
  const db = services.firestore || admin.firestore(), auth = services.auth || admin.auth();
  const ref = db.doc("hotels/" + hotelUid + "/contracts/" + id), operation = db.doc("hotels/" + hotelUid + "/contractOperations/" + requestId);
  return db.runTransaction(async (tx) => {
    await requirePrivateWorkflows(db, tx);
    await authorize(db, request, hotelUid, creating ? "create" : "update", tx, auth);
    const [current, previous] = await Promise.all([tx.get(ref), tx.get(operation)]);
    if (previous.exists) {
      if (previous.data().actorUid !== request.auth.uid || previous.data().fingerprint !== fingerprint) throw new HttpsError("already-exists", "This request ID was used for a different contract change.");
      return previous.data().result;
    }
    if (creating ? current.exists : !current.exists) throw new HttpsError(creating ? "already-exists" : "not-found", "Reload the contract before saving.");
    const before = current.data() || {};
    if ((before.revision || 0) !== expectedRevision) throw new HttpsError("aborted", "Contract changed. Reload before saving.");
    const existingFiles = filesOf(before, hotelUid, id);
    if (keepFileIds.some((key) => !existingFiles.some((f) => f.fileId === key))) throw new HttpsError("invalid-argument", "An attachment does not belong to this contract.");
    if (keepFileIds.length < existingFiles.length) await authorize(db, request, hotelUid, "delete", tx, auth);
    const removedFiles = existingFiles.filter((f) => !keepFileIds.includes(f.fileId));
    const followers = await followerDirectory(db, auth, hotelUid, payload.followers, tx);
    const result = { contractId: id, revision: expectedRevision + 1 };
    tx.set(ref, { ...payload, followers, contractFiles: existingFiles.filter((f) => keepFileIds.includes(f.fileId)), revision: result.revision,
      createdAt: before.createdAt || admin.firestore.FieldValue.serverTimestamp(), createdBy: before.createdBy || request.auth.uid,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(), updatedBy: request.auth.uid });
    tx.create(operation, { actorUid: request.auth.uid, fingerprint, result, creating, uploadFileIds, createdAt: admin.firestore.FieldValue.serverTimestamp() });
    for (const file of removedFiles) tx.set(db.doc("hotels/" + hotelUid + "/contractAttachments/" + file.fileId), { contractId: id, status: "detached", detachedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    tx.create(db.collection("hotels/" + hotelUid + "/contractAudit").doc(), { action: creating ? "create" : "update", actorUid: request.auth.uid, contractId: id, revision: result.revision, removedFiles: existingFiles.filter((f) => !keepFileIds.includes(f.fileId)).map((f) => f.fileId), createdAt: admin.firestore.FieldValue.serverTimestamp() });
    return result;
  });
}
async function readContractFile(request, data, services = {}) {
  const db = services.firestore || admin.firestore(), bucket = services.bucket || admin.storage().bucket();
  const hotelUid = strictId(data.hotelUid, "hotelUid"), id = strictId(data.contractId, "contractId");
  await authorize(db, request, hotelUid, "read", undefined, services.auth);
  const current = await db.doc("hotels/" + hotelUid + "/contracts/" + id).get();
  if (!current.exists) throw new HttpsError("not-found", "Contract not found.");
  const file = filesOf(current.data(), hotelUid, id).find((f) => f.fileId === data.fileId);
  if (!file) throw new HttpsError("not-found", "Contract document not found.");
  const object = bucket.file(file.filePath), [metadata] = await object.getMetadata();
  if (!(Number(metadata.size) > 0 && Number(metadata.size) <= MAX_FILE_BYTES)) throw new HttpsError("failed-precondition", "This document exceeds the supported size.");
  if (metadata.contentEncoding && metadata.contentEncoding !== "identity") throw new HttpsError("failed-precondition", "This document encoding needs operator review.");
  // Pin the object generation and buffer the bounded response: streamed gen-2 responses are limited to 10 MiB.
  const [bytes] = await bucket.file(file.filePath, { generation: metadata.generation }).download({ decompress: false });
  if (bytes.length !== Number(metadata.size) || bytes.length > MAX_FILE_BYTES) throw new HttpsError("failed-precondition", "Document size changed during download.");
  await authorize(db, request, hotelUid, "read", undefined, services.auth);
  const latest = await current.ref.get();
  if (!latest.exists || !filesOf(latest.data(), hotelUid, id).some((f) => f.fileId === file.fileId && f.filePath === file.filePath)) throw new HttpsError("not-found", "This document has been removed.");
  return { bytes, fileName: file.fileName };
}
async function uploadContractDocument(request, data, bytes, services = {}) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_FILE_BYTES) throw new HttpsError("invalid-argument", "Upload a nonempty document of at most 20 MiB.");
  const hotelUid = strictId(data.hotelUid, "hotelUid"), id = strictId(data.contractId, "contractId");
  const fileId = text(data.fileId, "fileId", 32, true), fileName = text(data.fileName, "fileName", 200, true);
  if (!/^[a-f0-9]{32}$/.test(fileId) || /[\r\n/\\]/.test(fileName)) throw new HttpsError("invalid-argument", "Invalid file ID or name.");
  const db = services.firestore || admin.firestore(), bucket = services.bucket || admin.storage().bucket();
  const ref = db.doc("hotels/" + hotelUid + "/contracts/" + id), hash = createHash("sha256").update(bytes).digest("hex");
  const path = "private/contracts/" + hotelUid + "/" + id + "/" + fileId;
  const requestId = strictId(data.requestId, "requestId");
  const operationRef = db.doc("hotels/" + hotelUid + "/contractOperations/" + requestId);
  const attachmentRef = db.doc("hotels/" + hotelUid + "/contractAttachments/" + fileId);
  const operation = await operationRef.get();
  if (!operation.exists || operation.data().actorUid !== request.auth?.uid || operation.data().result.contractId !== id
    || !operation.data().uploadFileIds?.includes(fileId) || operation.data().creating !== (data.creating === "true")) throw new HttpsError("permission-denied", "This document is not part of an authorized contract save.");
  await requirePrivateWorkflows(db);
  await authorize(db, request, hotelUid, data.creating === "true" ? "create" : "update", undefined, services.auth);
  const current = await ref.get();
  if (!current.exists) throw new HttpsError("not-found", "Save the contract before uploading documents.");
  if (data.creating === "true" && current.data().createdBy !== request.auth.uid) throw new HttpsError("permission-denied", "Creating permission only allows uploads to your own new contract.");
  if (filesOf(current.data(), hotelUid, id).length >= MAX_FILES && !filesOf(current.data(), hotelUid, id).some((f) => f.fileId === fileId)) throw new HttpsError("resource-exhausted", "A contract supports at most 20 documents.");
  const object = bucket.file(path);
  try {
    await object.save(bytes, { resumable: false, preconditionOpts: { ifGenerationMatch: 0 }, metadata: { contentType: "application/octet-stream", cacheControl: "private, no-store", metadata: { sha256: hash, actorUid: request.auth.uid } } });
  } catch (error) {
    if (error.code !== 412) throw error;
    const [metadata] = await object.getMetadata();
    if (metadata.metadata?.sha256 !== hash || metadata.metadata?.actorUid !== request.auth.uid) throw new HttpsError("already-exists", "This file ID belongs to a different upload.");
  }
  return db.runTransaction(async (tx) => {
    await requirePrivateWorkflows(db, tx);
    await authorize(db, request, hotelUid, data.creating === "true" ? "create" : "update", tx, services.auth);
    const [latest, attachment] = await Promise.all([tx.get(ref), tx.get(attachmentRef)]);
    if (attachment.exists && attachment.data().status === "detached") throw new HttpsError("aborted", "This document was removed. Reload before uploading again.");
    if (!latest.exists) throw new HttpsError("not-found", "Contract was removed during upload.");
    if (data.creating === "true" && latest.data().createdBy !== request.auth.uid) throw new HttpsError("permission-denied", "Contract ownership changed.");
    const files = filesOf(latest.data(), hotelUid, id);
    if (files.some((f) => f.fileId === fileId)) return { fileId, revision: latest.data().revision || 0 };
    if (files.length >= MAX_FILES) throw new HttpsError("resource-exhausted", "A contract supports at most 20 documents.");
    const nextRevision = (latest.data().revision || 0) + 1;
    tx.create(attachmentRef, { contractId: id, requestId, hash, status: "attached", createdAt: admin.firestore.FieldValue.serverTimestamp() });
    tx.update(ref, { contractFiles: [...files, { fileId, fileName, filePath: path, size: bytes.length }], revision: nextRevision, updatedAt: admin.firestore.FieldValue.serverTimestamp(), updatedBy: request.auth.uid });
    tx.create(db.collection("hotels/" + hotelUid + "/contractAudit").doc(), { action: "attach", contractId: id, fileId, actorUid: request.auth.uid, revision: nextRevision, createdAt: admin.firestore.FieldValue.serverTimestamp() });
    return { fileId, revision: nextRevision };
  });
}
const statusFor = { unauthenticated: 401, "permission-denied": 403, "not-found": 404, "invalid-argument": 400, "failed-precondition": 409, "resource-exhausted": 429, "already-exists": 409, aborted: 409 };
async function contractDocumentHandler(req, res, services = {}) {
  res.set("Cache-Control", "private, no-store"); res.set("X-Content-Type-Options", "nosniff");
  if (!["GET", "POST"].includes(req.method)) return res.status(405).json({ error: "Use GET or POST." });
  try {
    const header = req.headers.authorization;
    if (typeof header !== "string" || !/^Bearer \S+$/.test(header)) throw new HttpsError("unauthenticated", "Sign in to access contract documents.");
    let token;
    try { token = await (services.auth || admin.auth()).verifyIdToken(header.slice(7), true); } catch { throw new HttpsError("unauthenticated", "Your session has expired. Sign in again."); }
    const request = { auth: { uid: token.uid, token } };
    if (req.method === "POST") {
      if (req.headers["content-type"] !== "application/octet-stream") throw new HttpsError("invalid-argument", "Use a binary document upload.");
      return res.status(200).json(await uploadContractDocument(request, req.query, req.rawBody, services));
    }
    const file = await readContractFile(request, req.query, services);
    res.set("Content-Type", "application/octet-stream");
    res.set("Content-Disposition", "attachment; filename*=UTF-8''" + encodeURIComponent(file.fileName));
    return res.status(200).send(file.bytes);
  } catch (error) {
    const status = statusFor[error.code] || 500;
    return res.status(status).json({ error: status === 500 ? "The document could not be processed. Please try again." : error.message });
  }
}
module.exports = { MAX_FILE_BYTES, strictId, contractDate, filesOf, contractView, contractInput, listHotelContractsHandler, listContractFollowersHandler, saveHotelContractHandler, readContractFile, uploadContractDocument, contractDocumentHandler,
  listHotelContracts: onCall(options, listHotelContractsHandler), listContractFollowers: onCall(options, listContractFollowersHandler), saveHotelContract: onCall(options, saveHotelContractHandler), contractDocument: onRequest(options, contractDocumentHandler) };
