const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { admin } = require("./config");
const { requireHotelPermission } = require("./authorization");
const { requireDocumentId, requirePlatformAdministrator } = require("./subscriptions");
const { requireVerifiedUser, text, email, revision, digest } = require("./validation");
const { gated, enforceRequestRollout } = require("./saasRollout");

const PRIVATE_FIELDS = ["username", "password", "sftpAddress", "sftpProtocol", "sftpPort", "sftpUser", "sftpPassword", "sftpHostKey"];
const PUBLIC_TEXT = { name: 200, accountNumber: 100, orderEmail: 254, phone: 100, notes: 4000, category: 100, subcategory: 100, webshopUrl: 500 };

function supplierPublicView(id, supplier) {
  const result = { id, revision: supplier.revision || 0, credentialsConfigured: supplier.credentialsConfigured === true || Boolean(supplier.password || supplier.sftpPassword) };
  for (const key of [...Object.keys(PUBLIC_TEXT), "orderEmailCc", "orderSystem", "deliveryDays"]) {
    if (supplier[key] !== undefined) result[key] = supplier[key];
  }
  return result;
}

async function listSuppliersHandler(request, services = {}) {
  const db = services.firestore || admin.firestore();
  const hotelUid = requireDocumentId(request.data?.hotelUid, "hotelUid");
  await requireHotelPermission(db, request, hotelUid, "suppliers", "read");
  if (request.data?.supplierId) {
    const supplierId = requireDocumentId(request.data.supplierId, "supplierId");
    const snap = await db.doc(`hotels/${hotelUid}/suppliers/${supplierId}`).get();
    return { supplier: snap.exists ? supplierPublicView(snap.id, snap.data()) : null };
  }
  const afterId = request.data?.afterId ? requireDocumentId(request.data.afterId, "afterId") : null;
  let query = db.collection(`hotels/${hotelUid}/suppliers`).orderBy(admin.firestore.FieldPath.documentId());
  if (afterId) query = query.startAfter(afterId);
  const page = await query.limit(101).get();
  return { suppliers: page.docs.slice(0, 100).map((s) => supplierPublicView(s.id, s.data())), nextCursor: page.size > 100 ? page.docs[99].id : null };
}

async function getSupplierConnectionHandler(request, services = {}) {
  const db = services.firestore || admin.firestore();
  const hotelUid = requireDocumentId(request.data?.hotelUid, "hotelUid");
  const supplierId = requireDocumentId(request.data?.supplierId, "supplierId");
  await requireHotelPermission(db, request, hotelUid, "suppliers", "password");
  const [snap, legacy] = await Promise.all([db.doc(`hotels/${hotelUid}/supplierSecrets/${supplierId}`).get(), db.doc(`hotels/${hotelUid}/suppliers/${supplierId}`).get()]);
  const data = {};
  for (const field of PRIVATE_FIELDS) {
    if (legacy.exists && Object.hasOwn(legacy.data(), field)) data[field] = legacy.data()[field];
    if (snap.exists && Object.hasOwn(snap.data(), field)) data[field] = snap.data()[field];
  }
  // Passwords never leave the backend, including to platform administrators.
  return { username: data.username || "", sftpAddress: data.sftpAddress || "", sftpProtocol: "sftp",
    sftpPort: String(data.sftpPort || 22), sftpUser: data.sftpUser || "", sftpHostKey: data.sftpHostKey || "",
    passwordConfigured: Boolean(data.password), sftpPasswordConfigured: Boolean(data.sftpPassword) };
}

function validateSupplier(input) {
  const value = {};
  for (const [key, max] of Object.entries(PUBLIC_TEXT)) value[key] = text(input[key] || "", key, max, key === "name");
  if (value.orderEmail) value.orderEmail = email(value.orderEmail);
  if (value.webshopUrl) {
    let url;
    try { url = new URL(value.webshopUrl); } catch { throw new HttpsError("invalid-argument", "Webshop URL must be an HTTPS URL."); }
    if (url.protocol !== "https:" || url.username || url.password) throw new HttpsError("invalid-argument", "Webshop URL must be an HTTPS URL without credentials.");
  }
  if (!["Email", "SFTP csv"].includes(input.orderSystem)) throw new HttpsError("invalid-argument", "Choose Email or SFTP csv.");
  value.orderSystem = input.orderSystem;
  if (!Array.isArray(input.orderEmailCc) || input.orderEmailCc.length > 10) throw new HttpsError("invalid-argument", "Use at most ten CC addresses.");
  value.orderEmailCc = [...new Set(input.orderEmailCc.map(email))];
  if (!Array.isArray(input.deliveryDays) || input.deliveryDays.length > 7 || input.deliveryDays.some((n) => !Number.isInteger(n) || n < 0 || n > 6)) {
    throw new HttpsError("invalid-argument", "Delivery days must be weekdays from 0 to 6.");
  }
  value.deliveryDays = [...new Set(input.deliveryDays)];
  return value;
}

async function saveSupplierHandler(request, services = {}) {
  const db = services.firestore || admin.firestore();
  const input = request.data || {};
  const hotelUid = requireDocumentId(input.hotelUid, "hotelUid");
  const supplierId = input.supplierId ? requireDocumentId(input.supplierId, "supplierId") : `s-${digest(request.auth?.uid, requireDocumentId(input.requestId, "requestId")).slice(0, 40)}`;
  const expected = revision(input.expectedRevision);
  const value = validateSupplier(input.supplier || {});
  const credentials = input.credentials;
  if (credentials !== undefined && (!credentials || typeof credentials !== "object" || Array.isArray(credentials))) throw new HttpsError("invalid-argument", "Invalid credential configuration.");
  const publicRef = db.doc(`hotels/${hotelUid}/suppliers/${supplierId}`);
  const secretRef = db.doc(`hotels/${hotelUid}/supplierSecrets/${supplierId}`);
  // Store the request fingerprint with private data; it is never returned to clients.
  const creationFingerprint = digest(value, credentials || null, input.clearCredentials === true);
  return db.runTransaction(async (tx) => {
    await requireHotelPermission(db, request, hotelUid, "suppliers", input.supplierId ? "update" : "create", tx);
    if (credentials !== undefined) await requireHotelPermission(db, request, hotelUid, "suppliers", "password", tx);
    const [current, secret] = await Promise.all([tx.get(publicRef), tx.get(secretRef)]);
    if (input.supplierId && !current.exists) throw new HttpsError("not-found", "Supplier not found.");
    if (!input.supplierId && current.exists) {
      if (secret.data()?.creationFingerprint !== creationFingerprint) throw new HttpsError("already-exists", "This supplier request was used with different details.");
      return { supplierId, revision: current.data().revision || 1 };
    }
    if ((current.data()?.revision || 0) !== expected) throw new HttpsError("aborted", "Supplier changed. Reload before saving.");
    let nextSecret = secret.exists ? { ...secret.data() } : {};
    // Relocate old credentials as part of a legitimate supplier edit, never return them.
    for (const field of PRIVATE_FIELDS) if (!Object.hasOwn(nextSecret, field) && current.data()?.[field]) nextSecret[field] = current.data()[field];
    if (input.clearCredentials === true) {
      if (credentials === undefined) throw new HttpsError("permission-denied", "Credential management permission is required.");
      nextSecret = {};
    } else if (credentials !== undefined) {
      for (const field of PRIVATE_FIELDS) {
        if (!Object.hasOwn(credentials, field)) continue;
        const raw = credentials[field];
        if (typeof raw !== "string") throw new HttpsError("invalid-argument", "Connection fields must be text.");
        const isPassword = field.toLowerCase().includes("password");
        let next;
        if (isPassword) {
          if (raw.length > 2000 || /[\u0000\r\n]/.test(raw)) throw new HttpsError("invalid-argument", "Passwords must be at most 2000 characters without line breaks.");
          next = raw;
        } else next = text(raw, field, 500);
        // Blank password fields preserve an existing password.
        if (next || !field.toLowerCase().includes("password")) nextSecret[field] = next;
      }
      if (nextSecret.sftpAddress) {
        const { resolveSftpConnectionOptions } = require("./sftpTransport");
        try { resolveSftpConnectionOptions(nextSecret, { requirePassword: false }); }
        catch { throw new HttpsError("invalid-argument", "Review the SFTP hostname, folder, username, port and verified SHA256 host key."); }
      }
    }
    const stamp = admin.firestore.FieldValue.serverTimestamp();
    const metadata = { ...value, revision: expected + 1, credentialsConfigured: Boolean(nextSecret.password || nextSecret.sftpPassword),
      updatedAt: stamp, updatedBy: request.auth.uid };
    if (!current.exists) {
      Object.assign(metadata, { createdAt: stamp, createdBy: request.auth.uid });
      nextSecret.creationFingerprint = creationFingerprint;
    }
    // Replace with an explicit public schema, dropping all legacy secret fields.
    tx.set(publicRef, { createdAt: current.data()?.createdAt || stamp, createdBy: current.data()?.createdBy || request.auth.uid, ...metadata });
    tx.set(secretRef, { ...nextSecret, updatedAt: stamp, updatedBy: request.auth.uid });
    tx.create(db.collection(`hotels/${hotelUid}/supplierAudit`).doc(), { supplierId, action: current.exists ? "update" : "create", credentialsChanged: credentials !== undefined, actorUid: request.auth.uid, revision: expected + 1, createdAt: stamp });
    return { supplierId, revision: expected + 1 };
  });
}

async function deleteSupplierHandler(request, services = {}) {
  const db = services.firestore || admin.firestore();
  const hotelUid = requireDocumentId(request.data?.hotelUid, "hotelUid");
  const supplierId = requireDocumentId(request.data?.supplierId, "supplierId");
  return db.runTransaction(async (tx) => {
    await requireHotelPermission(db, request, hotelUid, "suppliers", "delete", tx);
    const current = await tx.get(db.doc(`hotels/${hotelUid}/suppliers/${supplierId}`));
    if (!current.exists) return { deleted: false };
    // Referenced suppliers remain as inactive records to preserve order history.
    const orders = await tx.get(db.collection(`hotels/${hotelUid}/orders`).where("supplierId", "==", supplierId).limit(1));
    if (!orders.empty) throw new HttpsError("failed-precondition", "This supplier has order history and cannot be deleted.");
    tx.delete(current.ref); tx.delete(db.doc(`hotels/${hotelUid}/supplierSecrets/${supplierId}`));
    return { deleted: true };
  });
}

async function migrateSupplierCredentialsHandler(request, services = {}) {
  requireVerifiedUser(request); requirePlatformAdministrator(request);
  const db = services.firestore || admin.firestore();
  const hotelUid = requireDocumentId(request.data?.hotelUid, "hotelUid");
  const afterId = request.data?.afterId ? requireDocumentId(request.data.afterId, "afterId") : null;
  let query = db.collection(`hotels/${hotelUid}/suppliers`).orderBy(admin.firestore.FieldPath.documentId());
  if (afterId) query = query.startAfter(afterId);
  const page = await query.limit(51).get();
  let changed = 0;
  for (const item of page.docs.slice(0, 50)) {
    changed += await db.runTransaction(async (tx) => {
      await enforceRequestRollout(db, request, tx);
      const privateRef = db.doc(`hotels/${hotelUid}/supplierSecrets/${item.id}`);
      const [supplier, secret] = await Promise.all([tx.get(item.ref), tx.get(privateRef)]);
      const legacy = PRIVATE_FIELDS.filter((key) => Object.hasOwn(supplier.data() || {}, key));
      if (!legacy.length) return 0;
      if (request.data?.apply !== true) return 1;
      const existing = secret.data() || {};
      const update = {}, privateUpdate = {};
      for (const key of legacy) {
        if (!Object.hasOwn(existing, key)) privateUpdate[key] = supplier.data()[key];
        update[key] = admin.firestore.FieldValue.delete();
      }
      update.credentialsConfigured = Boolean(existing.password || existing.sftpPassword || privateUpdate.password || privateUpdate.sftpPassword);
      tx.set(privateRef, { ...privateUpdate, migratedAt: admin.firestore.FieldValue.serverTimestamp(), migratedBy: request.auth.uid }, { merge: true });
      tx.update(item.ref, update);
      return 1;
    });
  }
  return { scanned: Math.min(page.size, 50), changed, applied: request.data?.apply === true, nextCursor: page.size > 50 ? page.docs[49].id : null };
}

const options = { region: "us-central1", cors: true };
module.exports = { PRIVATE_FIELDS, supplierPublicView, listSuppliersHandler, getSupplierConnectionHandler, saveSupplierHandler, deleteSupplierHandler, migrateSupplierCredentialsHandler,
  listSuppliers: onCall(options, listSuppliersHandler), getSupplierConnection: onCall(options, getSupplierConnectionHandler),
  saveSupplier: onCall(options, gated(saveSupplierHandler)), deleteSupplier: onCall(options, gated(deleteSupplierHandler)),
  migrateSupplierCredentials: onCall(options, gated(migrateSupplierCredentialsHandler)) };
