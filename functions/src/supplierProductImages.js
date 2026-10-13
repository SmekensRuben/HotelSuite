const { onRequest, HttpsError } = require("firebase-functions/v2/https");
const { onObjectFinalized } = require("firebase-functions/v2/storage");
const { createHash, randomUUID } = require("node:crypto");
const { admin, logger } = require("./config");
const { requireHotelPermission } = require("./authorization");
const { requireSaasRollout } = require("./saasRollout");
const { requireDocumentId } = require("./subscriptions");
const { revision, digest } = require("./validation");
const { MAX_IMAGE_BYTES, MAX_DERIVATIVE_BYTES, IMAGE_POLICY_VERSION, imageInput, createImageVariants } = require("./supplierProductImagesPolicy");

const options = { region: "us-central1", cors: true, memory: "512MiB", concurrency: 2, minInstances: 0, maxInstances: 3, timeoutSeconds: 120 };
const storageOptions = { region: "us-west1", memory: "512MiB", concurrency: 2, minInstances: 0, maxInstances: 3, timeoutSeconds: 120, retry: true };
const MAX_ATTEMPTS = 3;
const LEASE_MS = 180000;
const prefix = "private/supplier-product-images";
const statusFor = { unauthenticated: 401, "permission-denied": 403, "not-found": 404, "invalid-argument": 400, "failed-precondition": 409, "resource-exhausted": 429, "already-exists": 409, aborted: 409, unavailable: 503 };
function strictId(value, field) {
  const id = requireDocumentId(value, field);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new HttpsError("invalid-argument", field + " contains unsupported characters.");
  return id;
}
function assetIdOf(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new HttpsError("invalid-argument", "A valid image asset ID is required.");
  return value;
}
function generationOf(value) {
  if (typeof value !== "string" || !/^\d{1,30}$/.test(value)) throw new HttpsError("failed-precondition", "Image object generation is unavailable.");
  return value;
}
function sourcePath(hotelUid, productId, assetId) { return `${prefix}/${hotelUid}/${productId}/${assetId}/source`; }
function variantPath(hotelUid, productId, assetId, variant) { return `${prefix}/${hotelUid}/${productId}/${assetId}/${variant}.webp`; }
function references(db, hotelUid, productId, assetId, requestId) {
  return { product: db.doc(`hotels/${hotelUid}/supplierproducts/${productId}`), asset: db.doc(`hotels/${hotelUid}/supplierProductImages/${assetId}`),
    ...(requestId ? { operation: db.doc(`hotels/${hotelUid}/supplierProductImageOperations/${requestId}`) } : {}) };
}
function resultOf(hotelUid, productId, asset) {
  return { hotelUid, productId, assetId: asset.assetId, imageRevision: asset.imageRevision, status: asset.status,
    ...(asset.errorCode ? { error: { code: asset.errorCode, message: asset.errorMessage || "The image could not be prepared. Upload it again." } } : {}) };
}
async function authorize(db, request, hotelUid, action, tx, auth) {
  await requireSaasRollout(db, tx);
  // Do not reuse request-scoped Auth caching across Storage I/O or transaction retries.
  await requireHotelPermission(db, { auth: request.auth }, hotelUid, "supplierproducts", action, tx, auth);
}
function currentAsset(product, assetId, imageRevision) {
  return product.exists && product.data().image?.assetId === assetId && product.data().imageRevision === imageRevision;
}
function actorRequest(asset) {
  return { auth: { uid: asset.actorUid, token: { email_verified: true, auth_time: asset.authTime } } };
}
async function savePrivateObject(bucket, path, bytes, hash, metadata) {
  const object = bucket.file(path);
  try {
    await object.save(bytes, { resumable: false, preconditionOpts: { ifGenerationMatch: 0 }, metadata: {
      contentType: metadata.contentType, cacheControl: "private, no-store", metadata: { sha256: hash, policyVersion: String(IMAGE_POLICY_VERSION) },
    } });
  } catch (error) {
    if (Number(error.code) !== 412) throw error;
  }
  const [saved] = await object.getMetadata();
  if (saved.metadata?.sha256 !== hash || Number(saved.size) !== bytes.length || saved.contentType !== metadata.contentType
    || saved.metadata?.firebaseStorageDownloadTokens) throw new HttpsError("already-exists", "This image object belongs to a different upload.");
  return generationOf(saved.generation);
}
async function failAsset(refs, db, asset, error, services = {}) {
  const code = error.code === "invalid-argument" ? "invalid-image" : error.code === "permission-denied" ? "access-changed" : "processing-failed";
  return db.runTransaction(async (tx) => {
    const [product, current] = await Promise.all([tx.get(refs.product), tx.get(refs.asset)]);
    const now = services.now?.() ?? Date.now();
    if (!current.exists || current.data().status === "ready"
      || asset.leaseId && current.data().leaseId !== asset.leaseId
      || !asset.leaseId && current.data().leaseId && current.data().leaseUntil > now) return current.exists ? current.data() : asset;
    const failure = { ...current.data(), status: "failed", errorCode: code,
      errorMessage: code === "invalid-image" ? "The uploaded image is invalid. Upload a static JPEG, PNG or WebP image." : "The image could not be prepared. Upload it again.",
      updatedAt: admin.firestore.FieldValue.serverTimestamp() };
    // Revoked access cannot mutate the visible product; private failure evidence remains available to operators.
    if (currentAsset(product, asset.assetId, asset.imageRevision) && code !== "access-changed") {
      await authorize(db, actorRequest(asset), asset.hotelUid, "update", tx, services.auth);
      tx.update(refs.product, { image: { assetId: asset.assetId, policyVersion: IMAGE_POLICY_VERSION, status: "failed", errorCode: code } });
    }
    failure.retryable = code === "processing-failed" && (failure.attempts || 0) < MAX_ATTEMPTS;
    tx.update(refs.asset, { status: failure.status, errorCode: failure.errorCode, errorMessage: failure.errorMessage, retryable: failure.retryable,
      leaseUntil: 0, leaseId: admin.firestore.FieldValue.delete(), updatedAt: failure.updatedAt });
    return failure;
  });
}
async function processImageAsset(hotelUid, productId, assetId, expectedGeneration, services = {}) {
  const db = services.firestore || admin.firestore(), bucket = services.bucket || admin.storage().bucket();
  const refs = references(db, hotelUid, productId, assetId);
  let asset;
  try {
    asset = await db.runTransaction(async (tx) => {
      const [product, stored] = await Promise.all([tx.get(refs.product), tx.get(refs.asset)]);
      if (!stored.exists || stored.data().hotelUid !== hotelUid || stored.data().productId !== productId || stored.data().assetId !== assetId) return null;
      const data = stored.data();
      if (!currentAsset(product, assetId, data.imageRevision) || product.data().archived === true) return null;
      await authorize(db, actorRequest(data), hotelUid, "update", tx, services.auth);
      if (data.sourceGeneration && data.sourceGeneration !== expectedGeneration) return null;
      if (data.status === "ready" || data.errorCode === "invalid-image" || data.errorCode === "access-changed") return { ...data, terminal: true };
      const now = services.now?.() ?? Date.now();
      if (data.leaseUntil > now) return { ...data, busy: true };
      if ((data.attempts || 0) >= MAX_ATTEMPTS) {
        const errorCode = "processing-failed", errorMessage = "The image could not be prepared after three attempts. Upload it again.";
        tx.update(refs.asset, { status: "failed", errorCode, errorMessage, retryable: false, leaseUntil: 0, leaseId: admin.firestore.FieldValue.delete() });
        tx.update(refs.product, { image: { assetId, policyVersion: IMAGE_POLICY_VERSION, status: "failed", errorCode } });
        return { ...data, status: "failed", errorCode, errorMessage, terminal: true };
      }
      const leaseId = randomUUID();
      tx.update(refs.asset, { attempts: (data.attempts || 0) + 1, sourceGeneration: expectedGeneration, leaseId, leaseUntil: now + LEASE_MS, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      return { ...data, attempts: (data.attempts || 0) + 1, sourceGeneration: expectedGeneration, leaseId };
    });
    if (!asset) return { ignored: true };
    if (asset.terminal) return resultOf(hotelUid, productId, asset);
    if (asset.busy) return { ...resultOf(hotelUid, productId, { ...asset, status: "pending" }), busy: true };
    const path = sourcePath(hotelUid, productId, assetId);
    const source = bucket.file(path, { generation: expectedGeneration });
    const [metadata] = await source.getMetadata();
    if (metadata.generation !== expectedGeneration || metadata.metadata?.sha256 !== asset.hash || metadata.metadata?.firebaseStorageDownloadTokens
      || metadata.contentEncoding && metadata.contentEncoding !== "identity" || Number(metadata.size) !== asset.size || asset.size > MAX_IMAGE_BYTES) {
      throw new HttpsError("invalid-argument", "The image source does not match its authorized upload.");
    }
    const [bytes] = await source.download({ decompress: false });
    if (bytes.length !== asset.size || createHash("sha256").update(bytes).digest("hex") !== asset.hash) throw new HttpsError("invalid-argument", "The image source changed.");
    const variants = await createImageVariants(bytes, asset.mimeType);
    await authorize(db, actorRequest(asset), hotelUid, "update", undefined, services.auth);
    const saved = {};
    for (const variant of ["thumbnail", "display"]) {
      const output = variants[variant], outputPath = variantPath(hotelUid, productId, assetId, variant);
      const generation = await savePrivateObject(bucket, outputPath, output.bytes, createHash("sha256").update(output.bytes).digest("hex"), { contentType: "image/webp" });
      saved[variant] = { path: outputPath, generation, size: output.bytes.length, width: output.width, height: output.height };
    }
    return db.runTransaction(async (tx) => {
      await authorize(db, actorRequest(asset), hotelUid, "update", tx, services.auth);
      const [product, stored] = await Promise.all([tx.get(refs.product), tx.get(refs.asset)]);
      if (!stored.exists || !currentAsset(product, assetId, asset.imageRevision) || product.data().archived === true
        || stored.data().sourceGeneration !== expectedGeneration || stored.data().leaseId !== asset.leaseId) return { ignored: true };
      if (stored.data().status === "ready") return resultOf(hotelUid, productId, stored.data());
      const image = { assetId, policyVersion: IMAGE_POLICY_VERSION, status: "ready", ...saved };
      tx.update(refs.product, { image });
      tx.update(refs.asset, { status: "ready", ...saved, retryable: false, leaseUntil: 0, leaseId: admin.firestore.FieldValue.delete(),
        errorCode: admin.firestore.FieldValue.delete(), errorMessage: admin.firestore.FieldValue.delete(), updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      return resultOf(hotelUid, productId, { ...asset, status: "ready", errorCode: null });
    });
  } catch (error) {
    if (!asset) throw error;
    const failed = await failAsset(refs, db, asset, error, services);
    return { ...resultOf(hotelUid, productId, failed), retryable: failed.retryable === true };
  }
}
async function uploadSupplierProductImage(request, data, bytes, services = {}) {
  imageInput(bytes, data.mimeType);
  const hotelUid = strictId(data.hotelUid, "hotelUid"), productId = strictId(data.productId, "productId");
  const requestId = strictId(data.requestId, "requestId");
  if (!(typeof data.expectedImageRevision === "string" && /^(0|[1-9]\d*)$/.test(data.expectedImageRevision)
    || Number.isSafeInteger(data.expectedImageRevision))) throw new HttpsError("invalid-argument", "A valid expected image revision is required.");
  const expectedRevision = revision(Number(data.expectedImageRevision));
  const db = services.firestore || admin.firestore(), bucket = services.bucket || admin.storage().bucket();
  await authorize(db, request, hotelUid, "update", undefined, services.auth);
  const hash = createHash("sha256").update(bytes).digest("hex");
  const fingerprint = digest(productId, expectedRevision, data.mimeType, hash);
  const assetId = digest(hotelUid, productId, requestId, request.auth.uid, fingerprint);
  const refs = references(db, hotelUid, productId, assetId, requestId);
  const replay = await db.runTransaction(async (tx) => {
    await authorize(db, request, hotelUid, "update", tx, services.auth);
    const [product, operation, stored] = await Promise.all([tx.get(refs.product), tx.get(refs.operation), tx.get(refs.asset)]);
    if (!operation.exists) return null;
    if (operation.data().actorUid !== request.auth.uid || operation.data().fingerprint !== fingerprint || !stored.exists) throw new HttpsError("already-exists", "This image request ID was used for a different upload.");
    if (!currentAsset(product, assetId, stored.data().imageRevision) || product.data().archived === true) throw new HttpsError("aborted", "A newer image was selected or the product was archived. Reload before uploading again.");
    return stored.data();
  });
  if (replay?.status === "ready" || replay?.status === "failed" && replay.retryable !== true) return resultOf(hotelUid, productId, replay);
  if (replay?.leaseUntil > (services.now?.() ?? Date.now())) return resultOf(hotelUid, productId, { ...replay, status: "pending" });
  const asset = await db.runTransaction(async (tx) => {
    await authorize(db, request, hotelUid, "update", tx, services.auth);
    const [product, operation, stored] = await Promise.all([tx.get(refs.product), tx.get(refs.operation), tx.get(refs.asset)]);
    if (!product.exists) throw new HttpsError("not-found", "Save the supplier product before uploading an image.");
    if (product.data().archived === true) throw new HttpsError("failed-precondition", "Archived supplier products cannot receive new images.");
    if (operation.exists) {
      if (operation.data().actorUid !== request.auth.uid || operation.data().fingerprint !== fingerprint || !stored.exists) throw new HttpsError("already-exists", "This image request ID was used for a different upload.");
      if (!currentAsset(product, assetId, stored.data().imageRevision)) throw new HttpsError("aborted", "A newer image was selected. Reload the product before uploading again.");
      return stored.data();
    }
    const currentRevision = product.data().imageRevision ?? 0;
    if (!Number.isSafeInteger(currentRevision) || currentRevision !== expectedRevision) throw new HttpsError("aborted", "The product image changed. Reload before uploading.");
    const next = { hotelUid, productId, assetId, imageRevision: expectedRevision + 1, mimeType: data.mimeType, size: bytes.length,
      hash, actorUid: request.auth.uid, authTime: Number(request.auth.token.auth_time), status: "pending", attempts: 0, policyVersion: IMAGE_POLICY_VERSION,
      createdAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp() };
    if (!Number.isFinite(next.authTime)) throw new HttpsError("unauthenticated", "A current signed-in session is required.");
    tx.create(refs.asset, next);
    tx.create(refs.operation, { actorUid: request.auth.uid, fingerprint, assetId, productId, createdAt: admin.firestore.FieldValue.serverTimestamp() });
    tx.update(refs.product, { image: { assetId, status: "pending", policyVersion: IMAGE_POLICY_VERSION }, imageRevision: next.imageRevision });
    return next;
  });
  if (asset.status === "ready") return resultOf(hotelUid, productId, asset);
  let generation;
  try { generation = await savePrivateObject(bucket, sourcePath(hotelUid, productId, assetId), bytes, hash, { contentType: data.mimeType }); }
  catch (error) {
    const failed = await failAsset(refs, db, asset, error, services);
    return { ...resultOf(hotelUid, productId, failed), retryable: failed.retryable === true };
  }
  await authorize(db, request, hotelUid, "update", undefined, services.auth);
  const processed = await processImageAsset(hotelUid, productId, assetId, generation, services);
  if (processed.ignored) throw new HttpsError("aborted", "A newer image was selected or the product was archived. Reload before uploading again.");
  return processed;
}
async function readSupplierProductImage(request, data, services = {}) {
  const hotelUid = strictId(data.hotelUid, "hotelUid"), productId = strictId(data.productId, "productId"), assetId = assetIdOf(data.assetId);
  if (!["thumbnail", "display"].includes(data.variant)) throw new HttpsError("invalid-argument", "Select the thumbnail or display image.");
  const db = services.firestore || admin.firestore(), bucket = services.bucket || admin.storage().bucket();
  await authorize(db, request, hotelUid, "read", undefined, services.auth);
  const refs = references(db, hotelUid, productId, assetId);
  const product = await refs.product.get(), image = product.data()?.image;
  if (!product.exists || image?.assetId !== assetId) throw new HttpsError("not-found", "This product image is no longer selected.");
  if (image.status !== "ready") throw new HttpsError("failed-precondition", "The product image is not available yet. Reload or upload it again.");
  const variant = image[data.variant], path = variantPath(hotelUid, productId, assetId, data.variant);
  if (!variant || variant.path !== path || !Number.isSafeInteger(variant.size) || variant.size <= 0 || variant.size > MAX_DERIVATIVE_BYTES) throw new HttpsError("failed-precondition", "The product image needs operator review.");
  const file = bucket.file(path, { generation: generationOf(variant.generation) }), [metadata] = await file.getMetadata();
  if (metadata.generation !== variant.generation || Number(metadata.size) !== variant.size || metadata.contentType !== "image/webp"
    || metadata.contentEncoding && metadata.contentEncoding !== "identity" || metadata.metadata?.firebaseStorageDownloadTokens) throw new HttpsError("failed-precondition", "The product image object does not match its snapshot.");
  const [bytes] = await file.download({ decompress: false });
  if (bytes.length !== variant.size || bytes.length > MAX_DERIVATIVE_BYTES) throw new HttpsError("failed-precondition", "The image size changed during download.");
  await authorize(db, request, hotelUid, "read", undefined, services.auth);
  const latest = await refs.product.get();
  if (!currentAsset(latest, assetId, product.data().imageRevision) || latest.data().image?.[data.variant]?.generation !== variant.generation) throw new HttpsError("not-found", "This product image has changed.");
  return { bytes };
}
async function supplierProductImageHandler(req, res, services = {}) {
  res.set("Cache-Control", "private, no-store"); res.set("X-Content-Type-Options", "nosniff");
  if (!["GET", "POST"].includes(req.method)) return res.status(405).json({ error: { code: "invalid-argument", message: "Use GET or POST." } });
  try {
    const header = req.headers.authorization;
    if (typeof header !== "string" || !/^Bearer \S+$/.test(header)) throw new HttpsError("unauthenticated", "Sign in to access product images.");
    let token;
    try { token = await (services.auth || admin.auth()).verifyIdToken(header.slice(7), true); } catch { throw new HttpsError("unauthenticated", "Your session has expired. Sign in again."); }
    const request = { auth: { uid: token.uid, token } };
    if (req.method === "POST") {
      if (req.headers["content-type"] !== "application/octet-stream") throw new HttpsError("invalid-argument", "Use a binary image upload.");
      return res.status(200).json(await uploadSupplierProductImage(request, req.query, req.rawBody, services));
    }
    const image = await readSupplierProductImage(request, req.query, services);
    res.set("Content-Type", "image/webp");
    return res.status(200).send(image.bytes);
  } catch (error) {
    const status = statusFor[error.code] || 500;
    return res.status(status).json({ error: { code: status === 500 ? "internal" : error.code, message: status === 500 ? "The image could not be processed. Please try again." : error.message } });
  }
}
async function processSupplierProductImageHandler(event, services = {}) {
  const object = event.data || {}, match = new RegExp(`^${prefix}/([A-Za-z0-9_-]+)/([A-Za-z0-9_-]+)/([a-f0-9]{64})/source$`).exec(object.name || "");
  if (!match) return { ignored: true };
  const bucket = services.bucket || admin.storage().bucket();
  if (object.bucket !== bucket.name) return { ignored: true };
  const [hotelUid, productId, assetId] = match.slice(1);
  try {
    const result = await processImageAsset(hotelUid, productId, assetId, generationOf(object.generation), { ...services, bucket });
    if (result.busy || result.retryable) throw new HttpsError("unavailable", "Image processing will retry after its current bounded attempt.");
    return result;
  }
  catch (error) {
    // Invalid or revoked reservations are permanent. Unexpected infrastructure failures may retry;
    // persisted attempts cap actual decoding and no retry can publish a superseded asset.
    if (["permission-denied", "failed-precondition", "invalid-argument", "not-found"].includes(error.code)) {
      logger.warn("Supplier image processing stopped", { hotelUid, productId, assetId, code: error.code });
      return { ignored: true, errorCode: error.code };
    }
    throw error;
  }
}
module.exports = { MAX_ATTEMPTS, strictId, assetIdOf, generationOf, sourcePath, variantPath, references, resultOf, processImageAsset,
  uploadSupplierProductImage, readSupplierProductImage, supplierProductImageHandler, processSupplierProductImageHandler,
  supplierProductImage: onRequest(options, supplierProductImageHandler), processSupplierProductImage: onObjectFinalized(storageOptions, processSupplierProductImageHandler) };
