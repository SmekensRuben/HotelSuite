const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { admin } = require("./config");
const { requireHotelPermission } = require("./authorization");
const { requireDocumentId, requireHotelSubscription } = require("./subscriptions");
const { revision, text, digest } = require("./validation");
const { requireSaasRollout, gated } = require("./saasRollout");
const { units } = require("./productPolicy");
const stamp = () => admin.firestore.FieldValue.serverTimestamp();
const LIMIT = 250;
function identity(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) throw new HttpsError("invalid-argument", "A template item needs a product identity.");
  if (item.catalogProductId != null) return { catalogProductId: requireDocumentId(item.catalogProductId, "catalogProductId") };
  return { supplierProductId: requireDocumentId(item.supplierProductId, "supplierProductId"), outletId: requireDocumentId(item.outletId, "outletId") };
}
const itemKey = (item) => item.catalogProductId ? JSON.stringify(["catalog", item.catalogProductId]) : JSON.stringify(["supplier", item.supplierProductId, item.outletId]);
function itemsInput(items) {
  if (!Array.isArray(items) || items.length > LIMIT) throw new HttpsError("invalid-argument", "Stock templates support at most 250 product identities.");
  const normalized = items.map(identity);
  if (new Set(normalized.map(itemKey)).size !== normalized.length) throw new HttpsError("invalid-argument", "Duplicate template products are not allowed.");
  return normalized;
}
async function mutateHotelStockTemplateHandler(request, services = {}) {
  const input = request.data || {};
  const actions = { create: "create", rename: "update", "add-item": "update", "remove-item": "update", "replace-items": "update", archive: "delete" };
  if (!Object.hasOwn(actions, input.action)) throw new HttpsError("invalid-argument", "Unsupported template command.");
  const allowed = ["hotelUid", "locationId", "templateId", "action", "expectedRevision", "requestId",
    ...(["create", "rename"].includes(input.action) ? ["name"] : []),
    ...(["add-item", "remove-item"].includes(input.action) ? ["item"] : []),
    ...(input.action === "replace-items" ? ["items"] : [])];
  if (Object.keys(input).some((key) => !allowed.includes(key))) throw new HttpsError("invalid-argument", "Unsupported stock template field.");
  const hotelUid = requireDocumentId(input.hotelUid, "hotelUid"), locationId = requireDocumentId(input.locationId, "locationId");
  const templateId = requireDocumentId(input.templateId, "templateId"), expected = revision(input.expectedRevision);
  const requestId = requireDocumentId(input.requestId, "requestId"), db = services.firestore || admin.firestore();
  const ref = db.doc(`hotels/${hotelUid}/locations/${locationId}/stockTemplates/${templateId}`);
  const operation = db.doc(`hotels/${hotelUid}/stockTemplateOperations/${digest(request.auth?.uid, requestId)}`);
  const fingerprint = digest(input);
  return db.runTransaction(async (tx) => {
    await requireHotelPermission(db, { ...request }, hotelUid, "locations", actions[input.action], tx, services.auth);
    await requireHotelSubscription(db, hotelUid, tx, "procurement");
    await requireSaasRollout(db, tx);
    const previousOperation = await tx.get(operation);
    if (previousOperation.exists) {
      if (previousOperation.data().fingerprint !== fingerprint) throw new HttpsError("already-exists", "This template request ID was used for different details.");
      return previousOperation.data().result;
    }
    try {
      const [location, snapshot] = await tx.getAll(db.doc(`hotels/${hotelUid}/locations/${locationId}`), ref);
      if (!location.exists) throw new HttpsError("not-found", "Inventory location not found in this hotel.");
      if (input.action === "create" && snapshot.exists) throw new HttpsError("already-exists", "This stock template already exists.");
      if (input.action !== "create" && !snapshot.exists) throw new HttpsError("not-found", "Stock template not found.");
      const source = snapshot.data() || {}, storedRevision = source.revision ?? 0;
      if (!Number.isSafeInteger(storedRevision) || storedRevision < 0) throw new HttpsError("failed-precondition", "The template revision needs review.");
      if (expected !== storedRevision) throw new HttpsError("aborted", "The stock template changed. Reload before editing it.");
      if (source.archived === true) throw new HttpsError("failed-precondition", "Archived stock templates cannot be edited.");
      const name = ["create", "rename"].includes(input.action) ? text(input.name, "Template name", 200, true)
        : text(source.name, "Template name", 200, true);
      let items = input.action === "create" ? [] : itemsInput(source.items);
      const originalLegacy = new Set(items.filter((item) => !item.catalogProductId).map(itemKey));
      if (input.action === "replace-items") items = itemsInput(input.items);
      if (input.action === "add-item") {
        const item = identity(input.item);
        if (!item.catalogProductId) throw new HttpsError("invalid-argument", "Add a catalog product; legacy supplier identities require explicit conversion.");
        if (!items.some((existing) => itemKey(existing) === itemKey(item))) items = itemsInput([...items, item]);
      }
      if (input.action === "remove-item") { const key = itemKey(identity(input.item)); items = items.filter((item) => itemKey(item) !== key); }
      if (items.some((item) => !item.catalogProductId && !originalLegacy.has(itemKey(item)))) {
        throw new HttpsError("invalid-argument", "Do not introduce new legacy supplier identities into a stock template.");
      }
      // Preserve unresolved legacy identities during edits so an operator can
      // remove them deliberately. Every new catalog reference is validated.
      const productIds = [...new Set(items.filter((item) => item.catalogProductId).map((item) => item.catalogProductId))];
      const products = productIds.length ? await tx.getAll(...productIds.map((id) => db.doc(`hotels/${hotelUid}/catalogproducts/${id}`))) : [];
      if (input.action !== "archive" && products.some((product) => !product.exists || product.data().inventoryTracked !== true
        || product.data().active === false || product.data().archived === true || !Object.hasOwn(units, product.data().baseUnit))) {
        throw new HttpsError("failed-precondition", "Choose active, inventory-tracked catalog products with supported units in this hotel.");
      }
      const result = { hotelUid, locationId, templateId, revision: expected + 1 };
      tx.set(ref, { ...source, id: templateId, name, items, revision: result.revision,
        inventoryPolicyVersion: items.every((item) => item.catalogProductId) ? 1 : 0,
        ...(input.action === "create" ? { createdBy: request.auth.uid, createdAt: stamp() } : {}),
        ...(input.action === "archive" ? { archived: true } : {}), updatedBy: request.auth.uid, updatedAt: stamp() });
      tx.create(operation, { fingerprint, result, actorUid: request.auth.uid, createdAt: stamp() });
      return result;
    } catch (error) {
      if (error instanceof HttpsError) throw new HttpsError(error.code, error.message, { stockTemplateRequestUncommitted: true });
      throw error;
    }
  });
}
module.exports = { identity, itemsInput, mutateHotelStockTemplateHandler,
  mutateHotelStockTemplate: onCall({ region: "us-central1", cors: true, timeoutSeconds: 120 }, gated(mutateHotelStockTemplateHandler)) };
