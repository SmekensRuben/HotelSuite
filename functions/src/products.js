const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { admin } = require("./config");
const { requireHotelPermission } = require("./authorization");
const { requireDocumentId } = require("./subscriptions");
const { revision, digest, text } = require("./validation");
const { gated, requireSaasRollout } = require("./saasRollout");
const policy = require("./productPolicy");
const pricePolicy = require("./supplierPricePolicy");

const MAX_IMPORT_PRODUCTS = 25;
const COLLECTIONS = ["catalogproducts", "supplierproducts"];
const stamp = () => admin.firestore.FieldValue.serverTimestamp();
const operationId = (uid, requestId) => `p-${digest(uid, requestId).slice(0, 48)}`;
const skuKey = (supplierId, supplierSku) => digest(supplierId, supplierSku);
function currentRevision(value) {
  const result = value?.revision === undefined ? 0 : value.revision;
  if (!Number.isSafeInteger(result) || result < 0 || result >= Number.MAX_SAFE_INTEGER) throw new HttpsError("failed-precondition", "The stored product revision needs review.");
  return result;
}
function supportedFields(input, fields, name) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !fields.includes(key))) {
    throw new HttpsError("invalid-argument", `Unsupported ${name} field.`);
  }
}
function uncommitted(error) {
  // This marker is set only after current authorization and the transaction
  // proved no matching operation was committed. It never hides uncertainty.
  if (error instanceof HttpsError) return new HttpsError(error.code, error.message, { ...error.details, productRequestUncommitted: true });
  return error;
}

async function prepareProduct(tx, db, hotelUid, collection, productId, action, expected, input, plannedSkus) {
  const ref = db.doc(`hotels/${hotelUid}/${collection}/${productId}`);
  const current = await tx.get(ref), previous = current.exists ? current.data() : null;
  if (action === "create" && current.exists) throw new HttpsError("already-exists", "This product ID already exists. Edit the existing product instead.");
  if (action !== "create" && !current.exists) throw new HttpsError("not-found", "Product not found in this hotel.");
  if (currentRevision(previous) !== expected) throw new HttpsError("aborted", "The product changed. Refresh before saving.");
  if (!current.exists && expected !== 0) throw new HttpsError("aborted", "New products require expectedRevision zero.");
  if (action === "archive") return { ref, previous, next: { ...previous, active: false, archived: true }, expected, action, productId };
  // Older clients/imports predate optional contract bounds. An omitted update
  // field preserves its stored value; only an explicit null/blank clears it.
  const productInput = collection === "supplierproducts" && previous && input && typeof input === "object" && !Array.isArray(input)
    ? { ...input, ...Object.fromEntries(["priceValidFrom", "priceValidUntil"].filter((key) => !Object.hasOwn(input, key)).map((key) => [key, previous[key] ?? null])) }
    : input;
  const next = collection === "catalogproducts" ? policy.normalizeCatalogProduct(productInput) : policy.normalizeSupplierProduct(productInput);
  if (previous?.archived === true && next.active) throw new HttpsError("failed-precondition", "Archived product identities cannot be reactivated. Create a distinct product instead.");
  // Canonical inventory units become immutable after the first reviewed save.
  // A new product is required for a changed inventory identity; existing order,
  // receipt and count snapshots retain their original terms.
  if (collection === "catalogproducts" && previous?.productPolicyVersion === policy.PRODUCT_POLICY_VERSION && previous.baseUnit !== next.baseUnit) {
    throw new HttpsError("failed-precondition", "The canonical base unit is immutable. Create a new catalog product for a different unit.");
  }
  const plan = { ref, previous, next, expected, action, productId };
  if (collection === "supplierproducts") {
    const supplier = await tx.get(db.doc(`hotels/${hotelUid}/suppliers/${next.supplierId}`));
    if (!supplier.exists) throw new HttpsError("failed-precondition", "The supplier does not exist in this hotel.");
    if (next.active && (supplier.data().active === false || supplier.data().archived === true)) throw new HttpsError("failed-precondition", "An active supplier product requires an active supplier.");
    next.supplierName = text(supplier.data().name ?? next.supplierId, "Supplier name", 200, true);
    if (next.catalogProductId) {
      const catalog = await tx.get(db.doc(`hotels/${hotelUid}/catalogproducts/${next.catalogProductId}`));
      if (!catalog.exists) throw new HttpsError("failed-precondition", "The linked catalog product does not exist in this hotel.");
      plan.catalog = catalog.data();
      if (!policy.compatibleUnits(next.baseUnit, catalog.data().baseUnit)) throw new HttpsError("failed-precondition", "The supplier and catalog base units must use the same physical dimension.");
      if (next.active && (catalog.data().active === false || catalog.data().archived === true)) throw new HttpsError("failed-precondition", "An active supplier product requires an active linked catalog product.");
      // Validate all package conversions now, rather than creating an offer
      // which can never produce a representable inventory quantity.
      for (const option of [{ baseUnitsPerPurchaseUnit: next.baseUnitsPerPurchaseUnit }, ...next.purchaseOptions]) {
        policy.convertQuantity(option.baseUnitsPerPurchaseUnit, next.baseUnit, catalog.data().baseUnit);
      }
    }
    if (previous?.catalogProductId) {
      plan.previousCatalog = previous.catalogProductId === next.catalogProductId ? plan.catalog
        : (await tx.get(db.doc(`hotels/${hotelUid}/catalogproducts/${requireDocumentId(previous.catalogProductId, "Previous catalog product ID")}`))).data() || null;
    }
    plan.priceChanged = pricePolicy.priceTermsChanged(previous, next, plan.previousCatalog, plan.catalog);
    plan.priceHistoryRef = db.doc(`hotels/${hotelUid}/supplierPriceHistory/${productId}/entries/${String(expected + 1).padStart(16, "0")}`);
    if (previous?.productPolicyVersion === policy.PRODUCT_POLICY_VERSION && (previous.supplierId !== next.supplierId || (previous.catalogProductId && previous.catalogProductId !== next.catalogProductId) || previous.baseUnit !== next.baseUnit)) {
      throw new HttpsError("failed-precondition", "A reviewed supplier product's supplier, catalog link and base unit are immutable. Create a distinct offer for a changed identity.");
    }
    const key = skuKey(next.supplierId, next.supplierSku);
    plan.skuRef = db.doc(`hotels/${hotelUid}/productSkuKeys/${key}`);
    const reserved = await tx.get(plan.skuRef);
    if ((reserved.exists && reserved.data().productId !== productId) || (plannedSkus.has(key) && plannedSkus.get(key) !== productId)) {
      throw new HttpsError("already-exists", "This supplier SKU already belongs to another product.");
    }
    // The reservation serializes concurrent saves. The bounded query discovers
    // historical products which were created before reservations existed.
    const legacy = await tx.get(db.collection(`hotels/${hotelUid}/supplierproducts`).where("supplierId", "==", next.supplierId).where("supplierSku", "==", next.supplierSku).limit(2));
    if (legacy.docs.some((document) => document.id !== productId)) throw new HttpsError("already-exists", "This supplier SKU already belongs to another product.");
    plannedSkus.set(key, productId);
    if (previous?.supplierId && previous?.supplierSku && skuKey(previous.supplierId, previous.supplierSku) !== key) {
      plan.oldSkuRef = db.doc(`hotels/${hotelUid}/productSkuKeys/${skuKey(previous.supplierId, previous.supplierSku)}`);
      const old = await tx.get(plan.oldSkuRef);
      plan.releaseOldSku = old.exists && old.data().productId === productId;
    }
  }
  return plan;
}
function writeProduct(tx, plan, collection, actorUid) {
  const now = stamp();
  // Archived legacy records are retained intact. Reviewed saves replace only
  // the public product schema and leave frozen downstream records untouched.
  const next = { ...plan.next, createdAt: plan.previous?.createdAt ?? now, createdBy: plan.previous?.createdBy ?? actorUid,
    revision: plan.expected + 1, updatedAt: now, updatedBy: actorUid };
  if (plan.previous?.archived === true || plan.action === "archive") next.archived = true;
  if (collection === "supplierproducts" && plan.action !== "archive") {
    next.priceUpdatedOn = plan.priceChanged ? now : plan.previous?.priceUpdatedOn ?? null;
    if (plan.priceChanged) tx.create(plan.priceHistoryRef, pricePolicy.historyEntry(plan, actorUid, now));
  }
  tx.set(plan.ref, next);
  if (plan.skuRef) tx.set(plan.skuRef, { productId: plan.productId, supplierId: next.supplierId, supplierSku: next.supplierSku, updatedAt: now });
  if (plan.releaseOldSku) tx.delete(plan.oldSkuRef);
  return { productId: plan.productId, revision: next.revision, ...(plan.action === "archive" ? { archived: true } : {}) };
}

async function mutateProduct(request, services, collection) {
  const db = services.firestore || admin.firestore(), input = request.data || {};
  const hotelUid = requireDocumentId(input.hotelUid, "hotelUid"), requestId = requireDocumentId(input.requestId, "requestId");
  const commandId = operationId(request.auth?.uid, requestId), operationRef = db.doc(`hotels/${hotelUid}/productOperations/${commandId}`);
  const fingerprint = digest(collection, input);
  // Structural IDs are parsed outside the transaction; all product values and
  // revisions are validated only after checking the immutable operation record.
  return db.runTransaction(async (tx) => {
    const actor = { ...request };
    const action = input.action;
    if (!["create", "update", "archive"].includes(action)) throw new HttpsError("invalid-argument", "Choose create, update or archive.");
    await requireHotelPermission(db, actor, hotelUid, collection, action === "archive" ? "delete" : action, tx, services.auth);
    await requireSaasRollout(db, tx);
    const prior = await tx.get(operationRef);
    if (prior.exists) {
      if (prior.data().fingerprint !== fingerprint) throw new HttpsError("already-exists", "This product request was already used with different details.");
      return prior.data().result;
    }
    try {
      supportedFields(input, ["hotelUid", "requestId", "action", "productId", "expectedRevision", "product"], "product command");
      const expected = revision(input.expectedRevision);
      const productId = input.productId === undefined || input.productId === null
        ? `p-${digest(collection, request.auth.uid, requestId).slice(0, 40)}` : requireDocumentId(input.productId, "productId");
      if (action !== "create" && !input.productId) throw new HttpsError("invalid-argument", "An existing product ID is required.");
      if (action === "archive" && input.product !== undefined) throw new HttpsError("invalid-argument", "Archival does not accept changed product details.");
      const plan = await prepareProduct(tx, db, hotelUid, collection, productId, action, expected, input.product, new Map());
      const result = { hotelUid, ...writeProduct(tx, plan, collection, request.auth.uid) };
      tx.create(operationRef, { actorUid: request.auth.uid, collection, action, fingerprint, result, createdAt: stamp() });
      tx.create(db.doc(`hotels/${hotelUid}/productAudit/${commandId}`), { actorUid: request.auth.uid, collection, action, productId, revision: result.revision, createdAt: stamp() });
      return result;
    } catch (error) { throw uncommitted(error); }
  });
}
const mutateHotelCatalogProductHandler = (request, services = {}) => mutateProduct(request, services, "catalogproducts");
const mutateHotelSupplierProductHandler = (request, services = {}) => mutateProduct(request, services, "supplierproducts");

async function importHotelProductsHandler(request, services = {}) {
  const db = services.firestore || admin.firestore(), input = request.data || {};
  const hotelUid = requireDocumentId(input.hotelUid, "hotelUid"), requestId = requireDocumentId(input.requestId, "requestId");
  const collection = input.collection;
  if (!COLLECTIONS.includes(collection)) throw new HttpsError("invalid-argument", "Choose catalogproducts or supplierproducts.");
  const commandId = operationId(request.auth?.uid, requestId), operationRef = db.doc(`hotels/${hotelUid}/productOperations/${commandId}`);
  const fingerprint = digest("import", input);
  return db.runTransaction(async (tx) => {
    const actor = { ...request };
    await requireHotelPermission(db, actor, hotelUid, collection, "create", tx, services.auth);
    await requireSaasRollout(db, tx);
    const prior = await tx.get(operationRef);
    if (prior.exists) {
      // Replay does not let a formerly privileged importer retain update access.
      if (prior.data().requiresUpdate) await requireHotelPermission(db, actor, hotelUid, collection, "update", tx, services.auth);
      if (prior.data().fingerprint !== fingerprint) throw new HttpsError("already-exists", "This import request was already used with different details.");
      return prior.data().result;
    }
    try {
      supportedFields(input, ["hotelUid", "requestId", "collection", "products", "onExisting"], "product import");
      if (!["skip", "overwrite"].includes(input.onExisting)) throw new HttpsError("invalid-argument", "Choose skip or overwrite for existing products.");
      if (!Array.isArray(input.products) || input.products.length < 1 || input.products.length > MAX_IMPORT_PRODUCTS) throw new HttpsError("invalid-argument", `Import between 1 and ${MAX_IMPORT_PRODUCTS} products per request.`);
      const plans = [], outcomes = [], ids = new Set(), plannedSkus = new Map();
      let requiresUpdate = false;
      for (let index = 0; index < input.products.length; index++) {
        const row = input.products[index];
        supportedFields(row, ["productId", "expectedRevision", "product"], "import row");
        const productId = row.productId === null || row.productId === undefined ? `p-${digest(collection, request.auth.uid, requestId, index).slice(0, 40)}` : requireDocumentId(row.productId, "productId");
        if (ids.has(productId)) throw new HttpsError("invalid-argument", "An import cannot contain duplicate product IDs.");
        ids.add(productId);
        // Even skipped rows use the same schema validator as interactive saves.
        if (collection === "catalogproducts") policy.normalizeCatalogProduct(row.product);
        else policy.normalizeSupplierProduct(row.product);
        const expected = revision(row.expectedRevision);
        const current = await tx.get(db.doc(`hotels/${hotelUid}/${collection}/${productId}`));
        if (current.exists && input.onExisting === "skip") {
          outcomes.push({ productId, revision: currentRevision(current.data()), skipped: true });
          continue;
        }
        if (current.exists) {
          await requireHotelPermission(db, actor, hotelUid, collection, "update", tx, services.auth);
          requiresUpdate = true;
        }
        const plan = await prepareProduct(tx, db, hotelUid, collection, productId, current.exists ? "update" : "create", expected, row.product, plannedSkus);
        plans.push(plan); outcomes.push({ productId, revision: expected + 1 });
      }
      // No transaction writes occur until every row and reference has passed.
      for (const plan of plans) writeProduct(tx, plan, collection, request.auth.uid);
      const result = { hotelUid, collection, imported: plans.length, skipped: outcomes.length - plans.length, products: outcomes };
      tx.create(operationRef, { actorUid: request.auth.uid, collection, action: "import", requiresUpdate, fingerprint, result, createdAt: stamp() });
      tx.create(db.doc(`hotels/${hotelUid}/productAudit/${commandId}`), { actorUid: request.auth.uid, collection, action: "import", products: outcomes, imported: plans.length, createdAt: stamp() });
      return result;
    } catch (error) { throw uncommitted(error); }
  });
}

const options = { region: "us-central1", cors: true, timeoutSeconds: 120 };
const mutateHotelCatalogProduct = onCall(options, gated(mutateHotelCatalogProductHandler));
const mutateHotelSupplierProduct = onCall(options, gated(mutateHotelSupplierProductHandler));
const importHotelProducts = onCall(options, gated(importHotelProductsHandler));
module.exports = { MAX_IMPORT_PRODUCTS, mutateHotelCatalogProductHandler, mutateHotelSupplierProductHandler,
  importHotelProductsHandler, mutateHotelCatalogProduct, mutateHotelSupplierProduct, importHotelProducts };
