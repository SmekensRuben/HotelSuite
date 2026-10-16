const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("./config");
const { createHash, randomUUID } = require("node:crypto");
const { admin, logger } = require("./config");
const { digest, revision, text } = require("./validation");
const { gated } = require("./saasRollout");
const { requireMcpHotelPermission } = require("./hotelMcpAccess");
const { strictId, assetIdOf, generationOf, variantPath, savePrivateObject } = require("./supplierProductImages");
const { MAX_DERIVATIVE_BYTES, IMAGE_POLICY_VERSION, imageInput, createImageVariants } = require("./supplierProductImagesPolicy");

const TEMP_PREFIX = "private/mcp-proposal-images", IMAGE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000, LEASE_MS = 180000, MAX_ATTEMPTS = 3, MAX_CLEANUP_FILES = 100, MAX_MANAGED_CANDIDATES = 25;
const OPTIONS = { region: "us-central1", cors: true, timeoutSeconds: 120, memory: "512MiB", concurrency: 2, maxInstances: 3 };
const stamp = () => admin.firestore.FieldValue.serverTimestamp();
const hashBytes = (bytes) => createHash("sha256").update(bytes).digest("hex");
const batchPath = (hotelUid, batchId) => `hotels/${hotelUid}/hotelMcpProposalBatches/${batchId}`;
const assetPath = (hotelUid, assetId) => `hotels/${hotelUid}/hotelMcpProposalImages/${assetId}`;
const operationPath = (hotelUid, uid, requestId) => `hotels/${hotelUid}/hotelMcpProposalImageOperations/o-${digest(uid, requestId).slice(0, 48)}`;
const tempVariantPath = (asset, variant) => `${TEMP_PREFIX}/${String(asset.expiresAtMillis).padStart(13, "0")}/${asset.hotelUid}/${asset.batchId}/${asset.rowId}/${asset.assetId}/${variant}.webp`;
const nowOf = (services) => services.now?.() ?? Date.now();
function exact(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !fields.includes(key))) throw new HttpsError("invalid-argument", `Unsupported ${label} field.`);
}
function nativeOnly(request) { if (request.mcpAuth !== undefined) throw new HttpsError("permission-denied", "Choose and attach proposal images in Hotel Toolkit."); }
function sourceUrl(value, field) {
  const result = text(value, field, 2048, true);
  let parsed; try { parsed = new URL(result); } catch { throw new HttpsError("invalid-argument", `${field} must be an HTTPS URL.`); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new HttpsError("invalid-argument", `${field} must be an HTTPS URL without credentials.`);
  return parsed.href;
}
function publicUrl(value) { try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password ? `${url.origin}${url.pathname}`.slice(0, 2048) : null; } catch { return null; } }
function safeError(error, attaching = false) {
  const code = error?.code === "invalid-argument" ? "invalid-image" : ["permission-denied", "unauthenticated"].includes(error?.code) ? "access-changed"
    : error?.code === "aborted" ? "image-conflict" : error?.code === "failed-precondition" ? "review-required" : error?.code === "unavailable" ? "source-unavailable" : "processing-failed";
  const messages = { "invalid-image": "Use a static JPEG, PNG or WebP image of at most 5 MiB and 16 megapixels.", "access-changed": "Your current hotel access no longer permits this image action.",
    "image-conflict": "The product image changed. Review the current image and explicitly confirm replacement again.", "review-required": "Review this image selection and the approved supplier product before attaching it.",
    "source-unavailable": "The image source is temporarily unavailable. Retry or choose a different image.", "processing-failed": attaching ? "The image could not be attached. Product data was preserved; retry the selected image." : "The image could not be prepared. Retry or choose a different image." };
  return { code, message: messages[code] };
}
function currentImage(product) {
  const imageRevision = product?.imageRevision ?? 0;
  if (!Number.isSafeInteger(imageRevision) || imageRevision < 0 || imageRevision >= Number.MAX_SAFE_INTEGER) throw new HttpsError("failed-precondition", "The current product image revision needs review.");
  const image = product?.image;
  return { assetId: typeof image?.assetId === "string" && /^[a-f0-9]{64}$/.test(image.assetId) ? image.assetId : null,
    status: ["pending", "ready", "failed"].includes(image?.status) ? image.status : image ? "failed" : "none", imageRevision };
}
function publicProposalImage(value) {
  if (!value || typeof value.assetId !== "string" || !/^[a-f0-9]{64}$/.test(value.assetId)) return null;
  const attachment = value.attachment || {}, current = value.currentImage || {};
  const error = (entry) => entry ? { code: String(entry.code || "processing-failed").slice(0, 100), message: String(entry.message || "The image action could not complete.").slice(0, 1000) } : null;
  return { assetId: value.assetId, status: ["preparing", "ready", "failed", "expired"].includes(value.status) ? value.status : "failed",
    selection: ["unselected", "selected", "omitted"].includes(value.selection) ? value.selection : "unselected", decisionRevision: Number.isSafeInteger(value.decisionRevision) ? value.decisionRevision : 0,
    sourceUrl: publicUrl(value.sourceUrl), sourcePageUrl: publicUrl(value.sourcePageUrl), mimeType: ["image/jpeg", "image/png", "image/webp"].includes(value.mimeType) ? value.mimeType : null,
    width: Number.isSafeInteger(value.width) && value.width > 0 ? value.width : null, height: Number.isSafeInteger(value.height) && value.height > 0 ? value.height : null,
    error: error(value.error), expiresAtMillis: Number.isSafeInteger(value.expiresAtMillis) ? value.expiresAtMillis : 0,
    attachment: { status: ["none", "attaching", "attached", "failed"].includes(attachment.status) ? attachment.status : "none", productId: attachment.productId || null,
      imageRevision: Number.isSafeInteger(attachment.imageRevision) ? attachment.imageRevision : null, error: error(attachment.error) },
    currentImage: { assetId: typeof current.assetId === "string" && /^[a-f0-9]{64}$/.test(current.assetId) ? current.assetId : null,
      status: ["none", "pending", "ready", "failed"].includes(current.status) ? current.status : "none", imageRevision: Number.isSafeInteger(current.imageRevision) ? current.imageRevision : 0 } };
}
function descriptor(asset, product, services) {
  return publicProposalImage({ ...asset, status: asset.expiresAtMillis <= nowOf(services) && asset.status !== "preparing" ? "expired" : asset.status,
    currentImage: currentImage(product) });
}
function resultOf(context, asset, services) {
  return { hotelUid: context.hotelUid, batchId: context.batch.batchId, rowId: context.row.rowId, batchRevision: context.batch.revision, image: descriptor(asset, context.product, services) };
}
function writeBatchImage(tx, context, asset, services) {
  context.row.image = descriptor(asset, context.product, services);
  context.batch.revision += 1; context.batch.updatedAtMillis = nowOf(services);
  tx.set(context.batchRef, { ...context.batch, updatedAt: stamp() });
}
async function contextFor(tx, db, request, hotelUid, batchId, rowId, services, write = true, unlocked = true) {
  const actor = { ...request };
  await requireMcpHotelPermission(db, actor, hotelUid, "supplierproducts", "read", tx, services);
  const batchRef = db.doc(batchPath(hotelUid, batchId)), snapshot = await tx.get(batchRef);
  if (!snapshot.exists) throw new HttpsError("not-found", "This private product proposal batch does not exist in this hotel.");
  const batch = snapshot.data();
  if (batch.ownerUid !== request.auth?.uid) throw new HttpsError("permission-denied", "Only the requester may prepare or review this private proposal image.");
  const row = batch.rows?.find((entry) => entry.rowId === rowId);
  if (!row || row.kind !== "supplier") throw new HttpsError("not-found", "Select an existing supplier product proposal in this batch.");
  if (!["create", "update"].includes(row.action)) throw new HttpsError("failed-precondition", "The supplier proposal action needs review.");
  if (write) await requireMcpHotelPermission(db, actor, hotelUid, "supplierproducts", row.action, tx, services);
  if (unlocked && batch.activeReviewId) throw new HttpsError("failed-precondition", "Finish the active product review command before changing proposal images.");
  if (write && row.status === "skipped") throw new HttpsError("failed-precondition", "Skipped supplier proposals cannot receive image changes.");
  const productId = row.result?.productId || (row.action === "update" ? row.productId : null), productRef = productId ? db.doc(`hotels/${hotelUid}/supplierproducts/${strictId(productId, "Supplier product ID")}`) : null;
  const productSnapshot = productRef ? await tx.get(productRef) : null, product = productSnapshot?.exists ? productSnapshot.data() : null;
  return { hotelUid, batchRef, batch, row, productRef, product, actor };
}
function requireAsset(snapshot, context, assetId) {
  if (!snapshot.exists) throw new HttpsError("not-found", "This private proposal image is unavailable. Prepare another image.");
  const asset = snapshot.data();
  if (asset.assetId !== assetId || asset.hotelUid !== context.hotelUid || asset.batchId !== context.batch.batchId || asset.rowId !== context.row.rowId || asset.ownerUid !== context.batch.ownerUid) throw new HttpsError("permission-denied", "This image does not belong to the selected private proposal.");
  return asset;
}
async function freshContext(db, request, hotelUid, batchId, rowId, services, write = true) { return db.runTransaction((tx) => contextFor(tx, db, request, hotelUid, batchId, rowId, services, write)); }
function parseIds(data) { return { hotelUid: strictId(data.hotelUid, "hotelUid"), batchId: strictId(data.batchId, "batchId"), rowId: strictId(data.rowId, "rowId") }; }

async function prepareReservation(request, data, source, services) {
  const ids = parseIds(data), requestId = strictId(data.requestId, "requestId"), db = services.firestore || admin.firestore();
  const fingerprint = digest(ids.batchId, ids.rowId, source), assetId = digest("mcp-proposal-image", ids.hotelUid, request.auth?.uid, requestId, fingerprint);
  const ref = db.doc(assetPath(ids.hotelUid, assetId)), operationRef = db.doc(operationPath(ids.hotelUid, request.auth?.uid, requestId));
  return db.runTransaction(async (tx) => {
    const context = await contextFor(tx, db, request, ids.hotelUid, ids.batchId, ids.rowId, services), operation = await tx.get(operationRef), existing = await tx.get(ref);
    const now = nowOf(services);
    if (operation.exists) {
      if (operation.data().fingerprint !== fingerprint || operation.data().action !== "prepare") throw new HttpsError("already-exists", "This image request ID was already used with different details.");
      const asset = requireAsset(existing, context, assetId);
      if (context.row.image?.assetId !== assetId) throw new HttpsError("aborted", "A newer proposal image was prepared. Review the current candidate.");
      if (asset.status === "ready" || asset.status === "expired" || asset.leaseUntil > now || asset.status === "failed" && (!asset.retryable || asset.attempts >= MAX_ATTEMPTS) || asset.expiresAtMillis <= now) return { context, asset, run: false };
      if (asset.attempts >= MAX_ATTEMPTS) {
        const terminal = { ...asset, status: "failed", retryable: false, error: safeError(new Error("retry window exceeded")), leaseId: null, leaseUntil: 0 };
        tx.set(ref, terminal); writeBatchImage(tx, context, terminal, services);
        return { context, asset: terminal, run: false };
      }
      const next = { ...asset, status: "preparing", leaseId: randomUUID(), leaseUntil: now + LEASE_MS, attempts: asset.attempts + 1, error: null };
      tx.set(ref, next); writeBatchImage(tx, context, next, services);
      return { context, asset: next, run: true };
    }
    const asset = { ...ids, assetId, ownerUid: request.auth.uid, sourceKind: source.kind, originalSourceUrl: source.imageUrl || null, originalSourcePageUrl: source.sourcePageUrl || null,
      sourceUrl: publicUrl(source.imageUrl), sourcePageUrl: publicUrl(source.sourcePageUrl), mimeType: source.mimeType || null,
      inputHash: source.hash || null, status: "preparing", selection: "unselected", decisionRevision: 0, selectedBy: null, selectedExpectedImageRevision: null, selectedReplaceExisting: false,
      width: null, height: null, error: null, retryable: false, attempts: 1, leaseId: randomUUID(), leaseUntil: now + LEASE_MS,
      attachment: { status: "none", productId: null, imageRevision: null, error: null }, variants: {}, createdAtMillis: now, expiresAtMillis: now + IMAGE_LIFETIME_MS, createdAt: stamp() };
    tx.create(ref, asset); tx.create(operationRef, { action: "prepare", ownerUid: request.auth.uid, fingerprint, assetId, batchId: ids.batchId, rowId: ids.rowId, createdAt: stamp() });
    writeBatchImage(tx, context, asset, services);
    return { context, asset, run: true };
  });
}
async function failedPreparation(request, asset, error, services) {
  const db = services.firestore || admin.firestore(), ref = db.doc(assetPath(asset.hotelUid, asset.assetId)), failure = safeError(error);
  try {
    return await db.runTransaction(async (tx) => {
      const context = await contextFor(tx, db, request, asset.hotelUid, asset.batchId, asset.rowId, services), saved = await tx.get(ref);
      const current = requireAsset(saved, context, asset.assetId);
      if (current.leaseId !== asset.leaseId) return resultOf(context, current, services);
      const next = { ...current, status: "failed", error: failure, retryable: !["invalid-image", "access-changed"].includes(failure.code) && current.attempts < MAX_ATTEMPTS, leaseId: null, leaseUntil: 0 };
      tx.set(ref, next);
      if (context.row.image?.assetId === asset.assetId) writeBatchImage(tx, context, next, services);
      return resultOf(context, next, services);
    });
  } catch (authorizationError) {
    if (!["permission-denied", "unauthenticated", "failed-precondition"].includes(authorizationError?.code)) throw authorizationError;
    // Bounded private operation evidence may record failure after revocation;
    // revoked access never changes a product or its proposal selection.
    await db.runTransaction(async (tx) => {
      const saved = await tx.get(ref);
      if (saved.exists && saved.data().leaseId === asset.leaseId) tx.set(ref, { ...saved.data(), status: "failed", error: failure, retryable: false, leaseId: null, leaseUntil: 0 });
    });
    throw authorizationError;
  }
}
async function executePreparation(request, reservation, input, services) {
  if (!reservation.run) return resultOf(reservation.context, reservation.asset, services);
  const asset = reservation.asset, db = services.firestore || admin.firestore(), bucket = services.bucket || admin.storage().bucket();
  try {
    const downloaded = input || await (services.downloadImage || require("./hotelMcpImageDownload").downloadProposalImage)(asset.originalSourceUrl, services);
    imageInput(downloaded.bytes, downloaded.mimeType);
    await freshContext(db, request, asset.hotelUid, asset.batchId, asset.rowId, services);
    const variants = await (services.createImageVariants || createImageVariants)(downloaded.bytes, downloaded.mimeType), saved = {};
    for (const variant of ["thumbnail", "display"]) {
      await freshContext(db, request, asset.hotelUid, asset.batchId, asset.rowId, services);
      const value = variants[variant], path = tempVariantPath(asset, variant), hash = hashBytes(value.bytes);
      const generation = await savePrivateObject(bucket, path, value.bytes, hash, { contentType: "image/webp" });
      saved[variant] = { path, generation, hash, size: value.bytes.length, width: value.width, height: value.height };
    }
    return db.runTransaction(async (tx) => {
      const context = await contextFor(tx, db, request, asset.hotelUid, asset.batchId, asset.rowId, services), ref = db.doc(assetPath(asset.hotelUid, asset.assetId));
      const current = requireAsset(await tx.get(ref), context, asset.assetId);
      if (context.row.image?.assetId !== asset.assetId || current.leaseId !== asset.leaseId) throw new HttpsError("aborted", "A newer proposal image was prepared. Review the current candidate.");
      const next = { ...current, status: "ready", sourceUrl: publicUrl(downloaded.sourceUrl || asset.originalSourceUrl), mimeType: downloaded.mimeType,
        width: saved.display.width, height: saved.display.height, variants: saved, leaseId: null, leaseUntil: 0, error: null, retryable: false };
      tx.set(ref, next); writeBatchImage(tx, context, next, services);
      return resultOf(context, next, services);
    });
  } catch (error) { return failedPreparation(request, asset, error, services); }
}
async function prepareHotelMcpProposalImageHandler(request, services = {}) {
  const data = request.data || {}; exact(data, ["hotelUid", "batchId", "rowId", "requestId", "imageUrl", "sourcePageUrl"], "proposal image preparation");
  const source = { kind: "url", imageUrl: sourceUrl(data.imageUrl, "Image URL"), sourcePageUrl: data.sourcePageUrl == null ? null : sourceUrl(data.sourcePageUrl, "Source page URL") };
  const reservation = await prepareReservation(request, data, source, services);
  return executePreparation(request, reservation, null, services);
}
async function uploadHotelMcpProposalImage(request, data, bytes, services = {}) {
  nativeOnly(request); exact(data, ["hotelUid", "batchId", "rowId", "requestId", "mimeType"], "proposal image upload");
  imageInput(bytes, data.mimeType);
  const reservation = await prepareReservation(request, data, { kind: "upload", mimeType: data.mimeType, hash: hashBytes(bytes) }, services);
  return executePreparation(request, reservation, { bytes, mimeType: data.mimeType, sourceUrl: null }, services);
}

async function readVariant(bucket, asset, variant) {
  const saved = asset.variants?.[variant], path = tempVariantPath(asset, variant);
  if (!saved || saved.path !== path || !Number.isSafeInteger(saved.size) || saved.size <= 0 || saved.size > MAX_DERIVATIVE_BYTES) throw new HttpsError("failed-precondition", "This prepared image needs review. Prepare another image.");
  const file = bucket.file(path, { generation: generationOf(saved.generation) }), [metadata] = await file.getMetadata();
  if (metadata.generation !== saved.generation || Number(metadata.size) !== saved.size || metadata.contentType !== "image/webp" || metadata.metadata?.firebaseStorageDownloadTokens
    || metadata.contentEncoding && metadata.contentEncoding !== "identity" || metadata.metadata?.sha256 !== saved.hash) throw new HttpsError("failed-precondition", "This private image object does not match its prepared evidence.");
  const [bytes] = await file.download({ decompress: false });
  if (bytes.length !== saved.size || hashBytes(bytes) !== saved.hash) throw new HttpsError("failed-precondition", "This prepared image changed. Prepare another image.");
  return bytes;
}
async function readHotelMcpProposalImage(request, data, services = {}) {
  nativeOnly(request); exact(data, ["hotelUid", "batchId", "rowId", "assetId", "variant"], "proposal image preview");
  const ids = parseIds(data), assetId = assetIdOf(data.assetId), db = services.firestore || admin.firestore(), bucket = services.bucket || admin.storage().bucket();
  if (!["thumbnail", "display"].includes(data.variant)) throw new HttpsError("invalid-argument", "Choose a thumbnail or display image.");
  const initial = await db.runTransaction(async (tx) => {
    const context = await contextFor(tx, db, request, ids.hotelUid, ids.batchId, ids.rowId, services, false, false), asset = requireAsset(await tx.get(db.doc(assetPath(ids.hotelUid, assetId))), context, assetId);
    if (context.row.image?.assetId !== assetId || asset.status !== "ready" || asset.expiresAtMillis <= nowOf(services)) throw new HttpsError("not-found", "This proposal image is no longer available. Prepare another image.");
    return asset;
  });
  const bytes = await readVariant(bucket, initial, data.variant);
  await db.runTransaction(async (tx) => {
    const context = await contextFor(tx, db, request, ids.hotelUid, ids.batchId, ids.rowId, services, false, false), asset = requireAsset(await tx.get(db.doc(assetPath(ids.hotelUid, assetId))), context, assetId);
    if (context.row.image?.assetId !== assetId || asset.status !== "ready" || asset.expiresAtMillis <= nowOf(services) || asset.variants?.[data.variant]?.generation !== initial.variants[data.variant].generation) throw new HttpsError("not-found", "This proposal image changed. Reload the current candidate.");
  });
  return { bytes };
}

async function decideHotelMcpProposalImageHandler(request, services = {}) {
  nativeOnly(request);
  const data = request.data || {}; exact(data, ["hotelUid", "batchId", "rowId", "assetId", "requestId", "expectedBatchRevision", "action", "replaceExisting", "expectedImageRevision"], "proposal image decision");
  const ids = parseIds(data), assetId = assetIdOf(data.assetId), requestId = strictId(data.requestId, "requestId"), db = services.firestore || admin.firestore();
  if (!["select", "omit", "attach", "retry"].includes(data.action)) throw new HttpsError("invalid-argument", "Choose select, omit, attach or retry.");
  if (data.replaceExisting !== undefined && typeof data.replaceExisting !== "boolean") throw new HttpsError("invalid-argument", "Choose explicitly whether to replace the current image.");
  const fingerprint = digest(data), operationRef = db.doc(operationPath(ids.hotelUid, request.auth?.uid, requestId)), ref = db.doc(assetPath(ids.hotelUid, assetId));
  const started = await db.runTransaction(async (tx) => {
    const context = await contextFor(tx, db, request, ids.hotelUid, ids.batchId, ids.rowId, services), saved = await tx.get(ref), previous = await tx.get(operationRef);
    const asset = requireAsset(saved, context, assetId);
    if (previous.exists) {
      if (previous.data().fingerprint !== fingerprint || previous.data().action !== data.action) throw new HttpsError("already-exists", "This image decision request ID was already used with different choices.");
      const replayId = previous.data().assetId, replayRef = db.doc(assetPath(ids.hotelUid, replayId));
      const replayAsset = replayId === assetId ? asset : requireAsset(await tx.get(replayRef), context, replayId);
      if (context.row.image?.assetId !== replayId) throw new HttpsError("aborted", "A newer candidate was prepared. Review the current proposal image.");
      if (data.action === "retry" && replayAsset.status === "preparing" && replayAsset.leaseUntil <= nowOf(services) && replayAsset.attempts < MAX_ATTEMPTS) {
        const next = { ...replayAsset, leaseId: randomUUID(), leaseUntil: nowOf(services) + LEASE_MS, attempts: replayAsset.attempts + 1 };
        tx.set(replayRef, next); writeBatchImage(tx, context, next, services);
        return { context, asset: next, selectionSnapshot: previous.data().selectionSnapshot, run: true };
      }
      if (data.action === "retry" && replayAsset.status === "preparing" && replayAsset.leaseUntil <= nowOf(services) && replayAsset.attempts >= MAX_ATTEMPTS) {
        const next = { ...replayAsset, status: "failed", error: safeError(new Error("retry window exceeded")), retryable: false, leaseId: null, leaseUntil: 0 };
        tx.set(replayRef, next); writeBatchImage(tx, context, next, services);
        return { context, asset: next, selectionSnapshot: previous.data().selectionSnapshot, run: false };
      }
      return { context, asset: replayAsset, selectionSnapshot: previous.data().selectionSnapshot, run: false };
    }
    if (revision(data.expectedBatchRevision) !== context.batch.revision) throw new HttpsError("aborted", "This proposal review changed. Refresh before choosing an image.");
    if (context.row.image?.assetId !== assetId) throw new HttpsError("aborted", "A newer candidate was prepared. Review that image first.");
    const now = nowOf(services);
    let next = { ...asset }, nextRef = ref, shouldRun = false;
    if (data.action === "select") {
      if (asset.status !== "ready" || asset.expiresAtMillis <= now) throw new HttpsError("failed-precondition", "Prepare a valid, unexpired image before selecting it.");
      const current = currentImage(context.product), replacing = Boolean(context.product?.image) || current.imageRevision > 0;
      if (replacing) {
        await requireMcpHotelPermission(db, context.actor, ids.hotelUid, "supplierproducts", "update", tx, services);
        if (data.replaceExisting !== true || revision(data.expectedImageRevision) !== current.imageRevision) throw new HttpsError("aborted", "Review the current image and explicitly confirm its replacement.");
      } else if (data.expectedImageRevision !== undefined && revision(data.expectedImageRevision) !== current.imageRevision) throw new HttpsError("aborted", "The product image changed. Refresh before selecting a replacement.");
      next = { ...next, selection: "selected", decisionRevision: asset.decisionRevision + 1, selectedBy: request.auth.uid, selectedExpectedImageRevision: current.imageRevision,
        selectedReplaceExisting: replacing, attachment: { status: "none", productId: null, imageRevision: null, error: null } };
    } else if (data.action === "omit") next = { ...next, selection: "omitted", decisionRevision: asset.decisionRevision + 1, selectedBy: request.auth.uid, selectedExpectedImageRevision: null, selectedReplaceExisting: false };
    else if (data.action === "retry") {
      if (asset.sourceKind !== "url" || !asset.originalSourceUrl) throw new HttpsError("failed-precondition", "Upload another file or prepare a new image URL.");
      if (asset.expiresAtMillis <= now || asset.status === "expired") {
        const renewedId = digest("renew-expired-proposal-image", ids.hotelUid, ids.batchId, ids.rowId, asset.assetId, request.auth.uid, requestId);
        nextRef = db.doc(assetPath(ids.hotelUid, renewedId));
        const duplicate = await tx.get(nextRef);
        if (duplicate.exists) throw new HttpsError("already-exists", "This renewed image reservation needs reconciliation.");
        next = { ...asset, assetId: renewedId, status: "preparing", attempts: 1, error: null, selection: "unselected", decisionRevision: 0,
          selectedBy: null, selectedExpectedImageRevision: null, selectedReplaceExisting: false, width: null, height: null, variants: {},
          attachment: { status: "none", productId: null, imageRevision: null, error: null }, managedAssetId: null, attachedAt: null,
          managedCandidates: {}, managedCandidateCounter: 0, attachCandidateId: null,
          createdAtMillis: now, createdAt: stamp(), expiresAtMillis: now + IMAGE_LIFETIME_MS, leaseId: randomUUID(), leaseUntil: now + LEASE_MS, attachLeaseId: null, attachLeaseUntil: 0 };
        shouldRun = true;
      } else if (asset.status === "preparing") {
        if (asset.leaseUntil <= now) {
          if (asset.attempts >= MAX_ATTEMPTS) next = { ...asset, status: "failed", retryable: false, error: safeError(new Error("retry window exceeded")), leaseId: null, leaseUntil: 0 };
          else { next = { ...asset, attempts: asset.attempts + 1, leaseId: randomUUID(), leaseUntil: now + LEASE_MS }; shouldRun = true; }
        }
      } else if (asset.status === "ready") {
        // A refresh may race the original worker finishing. Return its ready
        // candidate without repeating download or changing human selection.
      } else {
        if (asset.status !== "failed" || !asset.retryable || asset.attempts >= MAX_ATTEMPTS) throw new HttpsError("failed-precondition", "This image cannot be retried. Prepare a new URL or upload another image.");
        next = { ...next, status: "preparing", attempts: asset.attempts + 1, error: null, leaseId: randomUUID(), leaseUntil: now + LEASE_MS };
        shouldRun = true;
      }
    } else if (asset.selection !== "selected" || asset.status !== "ready") throw new HttpsError("failed-precondition", "Select a prepared image before attaching it.");
    const selectionSnapshot = { rowId: ids.rowId, assetId: next.assetId, decisionRevision: next.decisionRevision };
    if (nextRef.path === ref.path) tx.set(ref, next); else tx.create(nextRef, next);
    writeBatchImage(tx, context, next, services);
    tx.create(operationRef, { action: data.action, ownerUid: request.auth.uid, fingerprint, batchId: ids.batchId, rowId: ids.rowId, assetId: next.assetId, selectionSnapshot, createdAt: stamp() });
    return { context, asset: next, selectionSnapshot, run: shouldRun };
  });
  if (data.action === "retry") {
    return executePreparation(request, started, null, services);
  }
  if (data.action !== "attach") return resultOf(started.context, started.asset, services);
  const outcomes = await attachSelectedProposalImages(request, { ...ids, rowIds: [ids.rowId], selectionSnapshot: [started.selectionSnapshot] }, services);
  if (outcomes[0]?.image) return outcomes[0];
  throw new HttpsError("failed-precondition", "The selected proposal image could not be attached. Refresh the current proposal.");
}

async function recordAttachmentFailure(request, ids, assetId, decisionRevision, leaseId, error, services) {
  const db = services.firestore || admin.firestore(), ref = db.doc(assetPath(ids.hotelUid, assetId));
  return db.runTransaction(async (tx) => {
    const context = await contextFor(tx, db, request, ids.hotelUid, ids.batchId, ids.rowId, services), asset = requireAsset(await tx.get(ref), context, assetId);
    if (asset.attachment?.status === "attached" || asset.attachLeaseId && leaseId && asset.attachLeaseId !== leaseId || context.row.image?.assetId !== assetId || asset.decisionRevision !== decisionRevision) return resultOf(context, asset, services);
    const next = { ...asset, attachment: { status: "failed", productId: context.row.result?.productId || null, imageRevision: null, error: safeError(error, true) }, attachLeaseId: null, attachLeaseUntil: 0 };
    tx.set(ref, next); writeBatchImage(tx, context, next, services);
    return resultOf(context, next, services);
  });
}
async function attachOne(request, ids, selected, services) {
  const db = services.firestore || admin.firestore(), bucket = services.bucket || admin.storage().bucket(), ref = db.doc(assetPath(ids.hotelUid, selected.assetId));
  let claimed;
  try {
    claimed = await db.runTransaction(async (tx) => {
      const context = await contextFor(tx, db, request, ids.hotelUid, ids.batchId, selected.rowId, services), asset = requireAsset(await tx.get(ref), context, selected.assetId);
      if (context.row.image?.assetId !== selected.assetId || context.row.image?.decisionRevision !== selected.decisionRevision || asset.decisionRevision !== selected.decisionRevision || asset.selection !== "selected") throw new HttpsError("failed-precondition", "The image selection changed after product approval.");
      if (asset.attachment?.status === "attached") return { context, asset, run: false };
      if (context.row.status !== "applied" || !context.row.result?.productId || !context.product || context.product.archived === true) throw new HttpsError("failed-precondition", "Approve the supplier product before attaching its selected image.");
      if (asset.status !== "ready" || asset.expiresAtMillis <= nowOf(services)) throw new HttpsError("failed-precondition", "The prepared image expired or is unavailable. Prepare and select another image.");
      const current = currentImage(context.product), replacing = Boolean(context.product.image) || current.imageRevision > 0;
      if (replacing) await requireMcpHotelPermission(db, context.actor, ids.hotelUid, "supplierproducts", "update", tx, services);
      if (current.imageRevision !== asset.selectedExpectedImageRevision || replacing && asset.selectedReplaceExisting !== true) throw new HttpsError("aborted", "The product image changed. Review it and explicitly confirm replacement again.");
      if (asset.attachLeaseUntil > nowOf(services)) return { context, asset, run: false };
      const candidates = { ...(asset.managedCandidates || {}) };
      if (Object.keys(candidates).length >= MAX_MANAGED_CANDIDATES) throw new HttpsError("resource-exhausted", "This image reached its bounded attachment retry window. Prepare and select another image.");
      const candidateCounter = (asset.managedCandidateCounter || 0) + 1;
      const managedAssetId = digest("mcp-approved-image", ids.hotelUid, context.row.result.productId, asset.assetId, selected.decisionRevision, candidateCounter);
      candidates[managedAssetId] = { productId: context.row.result.productId, decisionRevision: selected.decisionRevision, attached: false,
        paths: Object.fromEntries(["thumbnail", "display"].map((variant) => [variant, variantPath(ids.hotelUid, context.row.result.productId, managedAssetId, variant)])) };
      const next = { ...asset, attachment: { status: "attaching", productId: context.row.result.productId, imageRevision: null, error: null }, attachLeaseId: randomUUID(), attachLeaseUntil: nowOf(services) + LEASE_MS,
        priorImageFingerprint: digest(context.product.image ?? null), managedCandidates: candidates, managedCandidateCounter: candidateCounter, attachCandidateId: managedAssetId };
      tx.set(ref, next); writeBatchImage(tx, context, next, services);
      return { context, asset: next, run: true };
    });
    if (!claimed.run) return resultOf(claimed.context, claimed.asset, services);
    const asset = claimed.asset, productId = claimed.context.row.result.productId;
    const managedAssetId = asset.attachCandidateId, saved = {};
    for (const variant of ["thumbnail", "display"]) {
      await freshContext(db, request, ids.hotelUid, ids.batchId, selected.rowId, services);
      const bytes = await readVariant(bucket, asset, variant), path = variantPath(ids.hotelUid, productId, managedAssetId, variant);
      const generation = await savePrivateObject(bucket, path, bytes, hashBytes(bytes), { contentType: "image/webp" });
      saved[variant] = { path, generation, size: bytes.length, width: asset.variants[variant].width, height: asset.variants[variant].height };
    }
    return await db.runTransaction(async (tx) => {
      const context = await contextFor(tx, db, request, ids.hotelUid, ids.batchId, selected.rowId, services), latest = requireAsset(await tx.get(ref), context, asset.assetId);
      const managedRef = db.doc(`hotels/${ids.hotelUid}/supplierProductImages/${managedAssetId}`), managed = await tx.get(managedRef);
      if (latest.attachment?.status === "attached") return resultOf(context, latest, services);
      if (context.row.image?.assetId !== asset.assetId || context.row.image?.decisionRevision !== selected.decisionRevision || latest.decisionRevision !== selected.decisionRevision || latest.selection !== "selected" || latest.attachLeaseId !== asset.attachLeaseId) throw new HttpsError("aborted", "The image selection changed while preparing its attachment.");
      if (!context.product || context.product.archived === true || context.row.result?.productId !== productId) throw new HttpsError("failed-precondition", "The approved supplier product is unavailable.");
      const current = currentImage(context.product), replacing = Boolean(context.product.image) || current.imageRevision > 0;
      if (replacing) await requireMcpHotelPermission(db, context.actor, ids.hotelUid, "supplierproducts", "update", tx, services);
      if (current.imageRevision !== asset.selectedExpectedImageRevision || digest(context.product.image ?? null) !== asset.priorImageFingerprint) throw new HttpsError("aborted", "The product image changed while preparing its attachment.");
      if (asset.expiresAtMillis <= nowOf(services) || latest.status !== "ready") throw new HttpsError("failed-precondition", "The prepared image expired. Prepare another image.");
      const imageRevision = current.imageRevision + 1, image = { assetId: managedAssetId, policyVersion: IMAGE_POLICY_VERSION, status: "ready", ...saved };
      if (managed.exists && (managed.data().productId !== productId || managed.data().proposalAssetId !== asset.assetId || managed.data().imageRevision !== imageRevision)) throw new HttpsError("already-exists", "This managed image identity needs reconciliation.");
      const next = { ...latest, attachment: { status: "attached", productId, imageRevision, error: null }, attachLeaseId: null, attachLeaseUntil: 0, attachedAt: stamp(), managedAssetId,
        managedCandidates: { ...latest.managedCandidates, [managedAssetId]: { ...latest.managedCandidates[managedAssetId], attached: true } } };
      tx.set(context.productRef, { ...context.product, image, imageRevision });
      if (!managed.exists) tx.create(managedRef, { hotelUid: ids.hotelUid, productId, assetId: managedAssetId, proposalAssetId: asset.assetId, sourceBatchId: ids.batchId, sourceRowId: selected.rowId,
        actorUid: request.auth.uid, imageRevision, status: "ready", policyVersion: IMAGE_POLICY_VERSION, ...saved, createdAt: stamp() });
      context.product = { ...context.product, image, imageRevision };
      tx.set(ref, next); writeBatchImage(tx, context, next, services);
      return resultOf(context, next, services);
    });
  } catch (error) {
    if (["permission-denied", "unauthenticated"].includes(error?.code)) throw error;
    return recordAttachmentFailure(request, { ...ids, rowId: selected.rowId }, selected.assetId, selected.decisionRevision, claimed?.asset.attachLeaseId, error, services);
  }
}
async function attachSelectedProposalImages(request, data, services = {}) {
  nativeOnly(request);
  const hotelUid = strictId(data.hotelUid, "hotelUid"), batchId = strictId(data.batchId, "batchId");
  if (!Array.isArray(data.selectionSnapshot) || data.selectionSnapshot.length > 25) throw new HttpsError("invalid-argument", "Provide the exact reviewed image selections.");
  const selected = data.selectionSnapshot.filter((entry) => !data.rowIds || data.rowIds.includes(entry.rowId));
  const results = [];
  for (const entry of selected) {
    strictId(entry.rowId, "Image proposal row ID"); assetIdOf(entry.assetId); revision(entry.decisionRevision);
    results.push(await attachOne(request, { hotelUid, batchId }, entry, services));
  }
  return results;
}

async function hotelMcpProposalImageHandler(req, res, services = {}) {
  res.set("Cache-Control", "private, no-store"); res.set("X-Content-Type-Options", "nosniff");
  if (!["GET", "POST"].includes(req.method)) return res.status(405).json({ error: { code: "invalid-argument", message: "Use GET or POST." } });
  try {
    if (typeof req.headers.authorization !== "string" || !/^Bearer \S+$/.test(req.headers.authorization)) throw new HttpsError("unauthenticated", "Sign in to access private proposal images.");
    let token; try { token = await (services.auth || admin.auth()).verifyIdToken(req.headers.authorization.slice(7), true); } catch { throw new HttpsError("unauthenticated", "Your session expired. Sign in again."); }
    const request = { auth: { uid: token.uid, token } };
    if (req.method === "POST") {
      if (req.headers["content-type"] !== "application/octet-stream") throw new HttpsError("invalid-argument", "Use a binary image upload.");
      return res.status(200).json(await uploadHotelMcpProposalImage(request, req.query, req.rawBody, services));
    }
    const result = await readHotelMcpProposalImage(request, req.query, services);
    res.set("Content-Type", "image/webp"); return res.status(200).send(result.bytes);
  } catch (error) {
    const statuses = { unauthenticated: 401, "permission-denied": 403, "not-found": 404, "invalid-argument": 400, "failed-precondition": 409, "already-exists": 409, aborted: 409, unavailable: 503, "resource-exhausted": 429 };
    const status = statuses[error?.code] || 500;
    return res.status(status).json({ error: { code: status === 500 ? "internal" : error.code, message: status === 500 ? "The private image action could not complete. Try again." : error.message } });
  }
}

async function cleanupHotelMcpProposalImagesHandler(_event = {}, services = {}) {
  const db = services.firestore || admin.firestore(), bucket = services.bucket || admin.storage().bucket(), now = nowOf(services);
  const [files] = await bucket.getFiles({ prefix: `${TEMP_PREFIX}/`, endOffset: `${TEMP_PREFIX}/${String(now + 1).padStart(13, "0")}/`, maxResults: MAX_CLEANUP_FILES, autoPaginate: false });
  const result = { scanned: files.length, deleted: 0, skipped: 0, failed: 0 };
  for (const listed of files) {
    const match = new RegExp(`^${TEMP_PREFIX}/(\\d{13})/([^/]{1,128})/([^/]{1,128})/([^/]{1,128})/([a-f0-9]{64})/(thumbnail|display)\\.webp$`).exec(listed.name || "");
    if (!match || Number(match[1]) > now) { result.skipped += 1; continue; }
    const [, deadline, hotelUid, batchId, rowId, assetId, variant] = match;
    try {
      strictId(hotelUid, "hotelUid"); strictId(batchId, "batchId"); strictId(rowId, "rowId");
      const allowed = await db.runTransaction(async (tx) => {
        const ref = db.doc(assetPath(hotelUid, assetId)), saved = await tx.get(ref), batchRef = db.doc(batchPath(hotelUid, batchId)), batchSnapshot = await tx.get(batchRef);
        if (!saved.exists) return true;
        const asset = saved.data();
        if (asset.hotelUid !== hotelUid || asset.batchId !== batchId || asset.rowId !== rowId || asset.expiresAtMillis !== Number(deadline) || asset.expiresAtMillis > now || asset.leaseUntil > now || asset.attachLeaseUntil > now) return false;
        const next = { ...asset, status: "expired", retryable: false, leaseId: null, leaseUntil: 0, attachLeaseId: null, attachLeaseUntil: 0 };
        tx.set(ref, next);
        if (batchSnapshot.exists) {
          const batch = batchSnapshot.data(), row = batch.rows?.find((entry) => entry.rowId === rowId);
          if (row?.image?.assetId === assetId && !batch.activeReviewId) {
            row.image = publicProposalImage({ ...row.image, status: "expired" }); batch.revision += 1; batch.updatedAtMillis = now;
            tx.set(batchRef, { ...batch, updatedAt: stamp() });
          }
        }
        return !asset.variants?.[variant] || asset.variants[variant].path === listed.name;
      });
      if (!allowed) { result.skipped += 1; continue; }
      // A failed or interrupted copy must not leave unreferenced permanent
      // derivatives. Keep the expiry-indexed temporary object until every
      // never-published candidate was checked and removed successfully.
      await cleanupManagedCandidates(db, bucket, hotelUid, assetId, now);
      const [metadata] = await bucket.file(listed.name).getMetadata();
      await bucket.file(listed.name, { generation: generationOf(metadata.generation), preconditionOpts: { ifGenerationMatch: metadata.generation } }).delete({ ignoreNotFound: true });
      result.deleted += 1;
    } catch (error) {
      if (Number(error?.code) === 404) continue;
      result.failed += 1;
      logger.warn("Proposal image cleanup deferred", { code: "cleanup-failed" });
    }
  }
  return result;
}

async function cleanupManagedCandidates(db, bucket, hotelUid, assetId, now) {
  const candidates = await db.runTransaction(async (tx) => {
    const saved = await tx.get(db.doc(assetPath(hotelUid, assetId)));
    if (!saved.exists) return [];
    const asset = saved.data();
    if (asset.expiresAtMillis > now || asset.attachLeaseUntil > now || asset.leaseUntil > now) throw new HttpsError("failed-precondition", "The proposal image is still in use.");
    const result = [];
    for (const [candidateId, candidate] of Object.entries(asset.managedCandidates || {})) {
      if (candidate.attached || candidate.cleaned || asset.managedAssetId === candidateId && asset.attachedAt) continue;
      assetIdOf(candidateId); strictId(candidate.productId, "Supplier product ID");
      const [product, receipt] = await Promise.all([tx.get(db.doc(`hotels/${hotelUid}/supplierproducts/${candidate.productId}`)), tx.get(db.doc(`hotels/${hotelUid}/supplierProductImages/${candidateId}`))]);
      // A live pointer or immutable managed receipt proves publication, even
      // after another image superseded it or a partial restore lost the flag.
      if (product.exists && product.data().image?.assetId === candidateId || receipt.exists) continue;
      const paths = ["thumbnail", "display"].map((variant) => {
        const expected = variantPath(hotelUid, candidate.productId, candidateId, variant);
        if (candidate.paths?.[variant] !== expected) throw new HttpsError("failed-precondition", "The private image copy evidence needs review.");
        return expected;
      });
      result.push({ candidateId, paths });
    }
    return result;
  });
  for (const candidate of candidates) {
    for (const path of candidate.paths) {
      try {
        const [metadata] = await bucket.file(path).getMetadata();
        await bucket.file(path, { generation: generationOf(metadata.generation), preconditionOpts: { ifGenerationMatch: metadata.generation } }).delete({ ignoreNotFound: true });
      } catch (error) { if (Number(error?.code) !== 404) throw error; }
    }
    await db.runTransaction(async (tx) => {
      const ref = db.doc(assetPath(hotelUid, assetId)), saved = await tx.get(ref);
      if (!saved.exists) return;
      const asset = saved.data(), stored = asset.managedCandidates?.[candidate.candidateId];
      if (!stored || stored.attached) return;
      tx.set(ref, { ...asset, managedCandidates: { ...asset.managedCandidates, [candidate.candidateId]: { ...stored, cleaned: true } } });
    });
  }
}

module.exports = { TEMP_PREFIX, IMAGE_LIFETIME_MS, LEASE_MS, MAX_ATTEMPTS, MAX_CLEANUP_FILES, assetPath, tempVariantPath, publicProposalImage, currentImage,
  prepareHotelMcpProposalImageHandler, uploadHotelMcpProposalImage, readHotelMcpProposalImage, decideHotelMcpProposalImageHandler, attachSelectedProposalImages,
  hotelMcpProposalImageHandler, cleanupHotelMcpProposalImagesHandler,
  prepareHotelMcpProposalImage: onCall(OPTIONS, gated(prepareHotelMcpProposalImageHandler)),
  decideHotelMcpProposalImage: onCall(OPTIONS, gated(decideHotelMcpProposalImageHandler)),
  hotelMcpProposalImage: onRequest(OPTIONS, hotelMcpProposalImageHandler),
  cleanupHotelMcpProposalImages: onSchedule({ schedule: "every 30 minutes", timeZone: "UTC", region: "us-central1", timeoutSeconds: 120, memory: "256MiB", maxInstances: 1 }, cleanupHotelMcpProposalImagesHandler) };
