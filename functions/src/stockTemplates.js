const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { admin } = require("./config");
const { requireHotelPermission } = require("./authorization");
const { requireDocumentId, requireHotelSubscription } = require("./subscriptions");
const { revision, text, digest } = require("./validation");
const { requireSaasRollout, gated } = require("./saasRollout");
const { units, compatibleUnits } = require("./productPolicy");
const { isArchived } = require("./procurementResources");
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
      if (isArchived(location.data()) && input.action !== "archive") throw new HttpsError("failed-precondition", "Archived inventory locations cannot be used for new template changes.");
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
async function getHotelStockTemplateDisplayHandler(request, services = {}) {
  const input = request.data || {};
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).some((key) => !["hotelUid", "locationId", "templateId"].includes(key))) {
    throw new HttpsError("invalid-argument", "Unsupported stock template display request.");
  }
  const hotelUid = requireDocumentId(input.hotelUid, "hotelUid"), locationId = requireDocumentId(input.locationId, "locationId");
  const templateId = requireDocumentId(input.templateId, "templateId"), db = services.firestore || admin.firestore();
  return db.runTransaction(async (tx) => {
    await requireHotelPermission(db, { ...request }, hotelUid, "locations", "read", tx, services.auth);
    await requireSaasRollout(db, tx);
    const [location, template] = await tx.getAll(db.doc(`hotels/${hotelUid}/locations/${locationId}`),
      db.doc(`hotels/${hotelUid}/locations/${locationId}/stockTemplates/${templateId}`));
    if (!location.exists || !template.exists) throw new HttpsError("not-found", "Stock template not found in this hotel.");
    const source = template.data(), items = itemsInput(source.items);
    const storedRevision = source.revision ?? 0;
    if (!Number.isSafeInteger(storedRevision) || storedRevision < 0) {
      throw new HttpsError("failed-precondition", "The template revision needs review.");
    }
    const paths = [...new Set(items.flatMap((item) => item.catalogProductId ? [`hotels/${hotelUid}/catalogproducts/${item.catalogProductId}`]
      : [`hotels/${hotelUid}/supplierproducts/${item.supplierProductId}`, `hotels/${hotelUid}/outlets/${item.outletId}`]))];
    const snapshots = paths.length ? await tx.getAll(...paths.map((path) => db.doc(path))) : [];
    const byPath = new Map(paths.map((path, index) => [path, snapshots[index]]));
    const legacyCatalogIds = new Map();
    for (const item of items.filter((row) => !row.catalogProductId)) {
      const supplier = byPath.get(`hotels/${hotelUid}/supplierproducts/${item.supplierProductId}`);
      try {
        legacyCatalogIds.set(itemKey(item), requireDocumentId(supplier.data()?.catalogProductId, "Stored catalog product ID"));
      } catch (error) {
        if (!(error instanceof HttpsError) || error.code !== "invalid-argument") throw error;
        legacyCatalogIds.set(itemKey(item), null);
      }
    }
    const linkedPaths = [...new Set([...legacyCatalogIds.values()].filter(Boolean).map((id) => `hotels/${hotelUid}/catalogproducts/${id}`))]
      .filter((path) => !byPath.has(path));
    const linkedSnapshots = linkedPaths.length ? await tx.getAll(...linkedPaths.map((path) => db.doc(path))) : [];
    linkedPaths.forEach((path, index) => byPath.set(path, linkedSnapshots[index]));
    const label = (value) => typeof value === "string" && value.trim() ? value.trim().slice(0, 200) : null;
    const countReady = (product) => product?.exists && product.data().inventoryTracked === true && !isArchived(product.data())
      && Object.hasOwn(units, product.data().baseUnit) && Boolean(label(product.data().name));
    // Project only the selected location/template context. A locations-only
    // reader receives no directory, supplier pricing or unrelated metadata.
    return { hotelUid, locationId, templateId,
      location: { id: locationId, name: label(location.data().name), archived: Boolean(isArchived(location.data())) },
      template: { id: templateId, name: label(source.name), revision: storedRevision,
        archived: Boolean(isArchived(source)), items },
      items: items.map((item) => {
      if (item.catalogProductId) {
        const product = byPath.get(`hotels/${hotelUid}/catalogproducts/${item.catalogProductId}`);
        const name = label(product.data()?.name), baseUnit = product.data()?.baseUnit;
        return { ...item, catalogProductName: name, baseUnit: Object.hasOwn(units, baseUnit) ? baseUnit : null,
          available: Boolean(countReady(product)) };
      }
      const product = byPath.get(`hotels/${hotelUid}/supplierproducts/${item.supplierProductId}`);
      const outlet = byPath.get(`hotels/${hotelUid}/outlets/${item.outletId}`);
      const name = label(product.data()?.supplierProductName || product.data()?.name), outletName = label(outlet.data()?.name);
      const catalogId = legacyCatalogIds.get(itemKey(item)), catalog = catalogId ? byPath.get(`hotels/${hotelUid}/catalogproducts/${catalogId}`) : null;
      return { ...item, supplierProductName: name, outletName,
        available: Boolean(product.exists && outlet.exists && !isArchived(outlet.data()) && name && outletName
          && countReady(catalog) && compatibleUnits(product.data().baseUnit, catalog.data().baseUnit)) };
    }) };
  }, { readOnly: true });
}
module.exports = { identity, itemsInput, mutateHotelStockTemplateHandler, getHotelStockTemplateDisplayHandler,
  getHotelStockTemplateDisplay: onCall({ region: "us-central1", cors: true, timeoutSeconds: 120 }, gated(getHotelStockTemplateDisplayHandler)),
  mutateHotelStockTemplate: onCall({ region: "us-central1", cors: true, timeoutSeconds: 120 }, gated(mutateHotelStockTemplateHandler)) };
