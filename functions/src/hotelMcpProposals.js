const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { admin, logger } = require("./config");
const { requireDocumentId } = require("./subscriptions");
const { digest, revision, text, requireCurrentVerifiedUser } = require("./validation");
const { normalizedPermissions, permissionAllows } = require("./authorization");
const { gated, requireSaasRollout } = require("./saasRollout");
const { validDate } = require("./importMonitoringPolicy");
const policy = require("./productPolicy");
const { readMcpIndexQuery } = require("./hotelMcpQuery");

const MAX_PROPOSAL_ROWS = 25, MAX_PROPOSAL_BYTES = 180000, MAX_STORED_BYTES = 850000, MAX_SOURCE_VALUE_DEPTH = 16, VERSION = 1;
const COLLECTIONS = { catalog: "catalogproducts", supplier: "supplierproducts" };
const CATALOG_FIELDS = ["name", "brand", "description", "category", "subcategory", "gtin", "storageType", "notes", "baseUnit", "active", "inventoryTracked", "allergens"];
const SUPPLIER_FIELDS = ["supplierId", "supplierSku", "supplierProductName", "brand", "currency", "pricingModel", "pricePerBaseUnit", "pricePerPurchaseUnit", "purchaseUnit", "baseUnit", "baseUnitsPerPurchaseUnit", "catalogProductId", "active", "priceBasis", "vatRate", "purchaseOptions", "priceValidFrom", "priceValidUntil", "gtin"];
const REVIEWABLE = new Set(["ready", "invalid", "unchanged", "conflict", "failed"]);
const stamp = () => admin.firestore.FieldValue.serverTimestamp();
const access = (...args) => require("./hotelMcpAccess").requireMcpHotelPermission(...args);
const internals = () => require("./products").catalogProductInternals;
const batchPath = (hotelUid, batchId) => `hotels/${hotelUid}/hotelMcpProposalBatches/${batchId}`;
const operationPath = (hotelUid, uid, requestId) => `hotels/${hotelUid}/hotelMcpProposalOperations/o-${digest(uid, requestId).slice(0, 48)}`;
const fieldsFor = (kind) => kind === "catalog" ? CATALOG_FIELDS : SUPPLIER_FIELDS;
function exact(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !fields.includes(key))) throw new HttpsError("invalid-argument", `Unsupported ${label} field.`);
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
function boundedDepth(value, maximumDepth) {
  const pending = [{ value, depth: 0 }];
  while (pending.length) {
    const current = pending.pop();
    if (current.depth > maximumDepth) throw new HttpsError("invalid-argument", `Product proposal source values support at most ${MAX_SOURCE_VALUE_DEPTH} nesting levels.`);
    if (current.value && typeof current.value === "object") for (const child of Object.values(current.value)) pending.push({ value: child, depth: current.depth + 1 });
  }
}
function boundedJson(value, maximum = MAX_PROPOSAL_BYTES) {
  // Request, row and snapshot wrappers are separate from source field values.
  // This additional outer guard rejects extreme input before serialization.
  boundedDepth(value, MAX_SOURCE_VALUE_DEPTH + 8);
  let encoded;
  try { encoded = JSON.stringify(value); } catch { throw new HttpsError("invalid-argument", "Product proposals must contain JSON data."); }
  if (!encoded || Buffer.byteLength(encoded, "utf8") > maximum) throw new HttpsError("resource-exhausted", "This proposal batch is too large. Send fewer products or shorter source values.");
  return JSON.parse(encoded);
}
function sourceData(input) {
  exact(input, ["label", "url", "documentDate", "mappingId", "sourceFormat"], "proposal source");
  const source = { label: text(input.label, "Source label", 300, true), url: null, documentDate: input.documentDate ?? null, mappingId: null, sourceFormat: input.sourceFormat ?? null };
  if (source.documentDate !== null && !validDate(source.documentDate)) throw new HttpsError("invalid-argument", "The source document date must be YYYY-MM-DD or unknown.");
  if (input.url != null && input.url !== "") {
    source.url = text(input.url, "Source URL", 1000, true);
    let parsed; try { parsed = new URL(source.url); } catch { throw new HttpsError("invalid-argument", "The source URL must be an HTTPS URL."); }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new HttpsError("invalid-argument", "The source URL must be an HTTPS URL without credentials.");
  }
  if (source.sourceFormat !== null && !["csv", "xlsx", "xls", "pdf", "docx", "eml", "txt", "web", "text"].includes(source.sourceFormat)) throw new HttpsError("invalid-argument", "Choose a supported source format.");
  if (input.mappingId != null) {
    source.mappingId = requireDocumentId(input.mappingId, "Source mapping ID");
    if (!source.sourceFormat) throw new HttpsError("invalid-argument", "A mapping reference requires its matching source format.");
  }
  return source;
}
function patchData(kind, value) {
  exact(value, fieldsFor(kind), `${kind} product proposal`);
  for (const fieldValue of Object.values(value)) boundedDepth(fieldValue, MAX_SOURCE_VALUE_DEPTH);
  const result = boundedJson(value);
  // These text fields support explicit clearing. Required fields and physical
  // quantities still pass the ordinary protected product validator unchanged.
  if (kind === "catalog") for (const key of CATALOG_FIELDS.filter((field) => !["name", "baseUnit", "active", "inventoryTracked", "allergens"].includes(field))) {
    if (Object.hasOwn(result, key) && result[key] === null) result[key] = "";
  }
  if (Object.hasOwn(result, "brand") && result.brand === null) result.brand = "";
  if (kind === "supplier" && Array.isArray(result.purchaseOptions)) {
    if (result.purchaseOptions.length > 20) throw new HttpsError("invalid-argument", "Use at most 20 additional purchase option changes.");
    const ids = result.purchaseOptions.map((option) => {
      exact(option, ["id", "purchaseUnit", "baseUnitsPerPurchaseUnit", "pricePerPurchaseUnit", "gtin"], "purchase option proposal");
      return requireDocumentId(option.id, "Purchase option ID");
    });
    if (new Set(ids).size !== ids.length) throw new HttpsError("invalid-argument", "Purchase option changes must use unique stable option IDs.");
  }
  return result;
}
function productFields(kind, value) {
  if (!value) return null;
  const fields = [...fieldsFor(kind), ...(kind === "catalog" ? ["internalSku", "imageUrl"] : ["supplierName"])];
  const result = Object.fromEntries(fields.filter((key) => Object.hasOwn(value, key)).map((key) => [key, value[key]]));
  for (const fieldValue of Object.values(result)) boundedDepth(fieldValue, MAX_SOURCE_VALUE_DEPTH);
  return boundedJson(result);
}
function issue(code, message, severity = "error") { return { code, message: String(message).slice(0, 1000), severity }; }
function errorData(error) { return { code: typeof error?.code === "string" ? error.code : "internal", message: String(error?.message || "The proposal could not be applied.").slice(0, 1000) }; }
function summary(rows) {
  const result = { total: rows.length, ready: 0, invalid: 0, unchanged: 0, applied: 0, skipped: 0, conflict: 0, failed: 0 };
  for (const row of rows) result[row.status] = (result[row.status] || 0) + 1;
  return result;
}
function finalizeBatch(batch) {
  batch.summary = summary(batch.rows);
  batch.status = batch.summary.applied + batch.summary.skipped === batch.rows.length ? "completed" : batch.summary.applied ? "partial" : "review";
  boundedJson(batch, MAX_STORED_BYTES);
  return batch;
}
function publicBatch(batch) {
  const publicFields = new Set([...CATALOG_FIELDS, ...SUPPLIER_FIELDS, "internalSku", "supplierName"]);
  const optionFields = new Set(["id", "purchaseUnit", "baseUnitsPerPurchaseUnit", "pricePerPurchaseUnit", "gtin"]);
  const publicOption = (value) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).filter(([key]) => optionFields.has(key))) : value;
  const publicProduct = (value) => value ? Object.fromEntries(Object.entries(value).filter(([key]) => publicFields.has(key)).map(([key, entry]) => [key,
    key === "purchaseOptions" ? Array.isArray(entry) ? entry.map(publicOption) : publicOption(entry) : entry])) : null;
  const rows = batch.rows.map((row) => ({ rowId: row.rowId, kind: row.kind, action: row.action, status: row.status, productId: row.productId,
    expectedRevision: row.expectedRevision, original: publicProduct(row.original), proposed: publicProduct(row.proposed), patch: publicProduct(row.patch),
    catalogRowId: row.catalogRowId, issues: row.issues, result: row.result, error: row.error, current: publicProduct(row.current), currentRevision: row.currentRevision,
    image: row.kind === "supplier" && row.image ? require("./hotelMcpProposalImages").publicProposalImage(row.image) : null }));
  return { batchId: batch.batchId, hotelUid: batch.hotelUid, requesterUid: batch.ownerUid, revision: batch.revision, status: batch.status,
    source: batch.source, createdAtMillis: batch.createdAtMillis, updatedAtMillis: batch.updatedAtMillis,
    processing: Boolean(batch.activeReviewId), pendingReview: batch.reviewCommand || null, rows, summary: batch.summary };
}
function ownedBatch(snapshot, uid) {
  if (!snapshot.exists) throw new HttpsError("not-found", "This private product proposal batch does not exist in this hotel.");
  const batch = snapshot.data();
  if (!uid || batch.ownerUid !== uid) throw new HttpsError("permission-denied", "Only the requester may open or review this private product proposal batch.");
  if (batch.version !== VERSION || !Array.isArray(batch.rows) || batch.rows.length > MAX_PROPOSAL_ROWS || !Number.isSafeInteger(batch.revision) || batch.revision < 1) throw new HttpsError("failed-precondition", "The stored proposal batch needs reconciliation.");
  return batch;
}
async function authorizeRows(db, request, hotelUid, rows, tx, services, write = false) {
  const permissions = new Set();
  for (const row of rows) {
    const collection = COLLECTIONS[row.kind];
    if (!Object.hasOwn(COLLECTIONS, row.kind)) throw new HttpsError("invalid-argument", "Choose catalog or supplier products.");
    permissions.add(`${collection}.read`);
    if (write) permissions.add(`${collection}.${row.action}`);
    const product = row.proposed || row.patch || {};
    if (row.kind === "supplier" && product.supplierId) permissions.add("suppliers.read");
    if (row.kind === "supplier" && (row.catalogRowId || product.catalogProductId)) permissions.add("catalogproducts.read");
  }
  for (const permission of permissions) {
    const [feature, action] = permission.split(".");
    await access(db, request, hotelUid, feature, action, tx, services);
  }
  await requireSaasRollout(db, tx);
}
async function authorizeAnyProductRead(db, request, hotelUid, tx, services) {
  const { requireMcpScope, READ_SCOPE } = require("./hotelMcpAccess");
  await requireMcpScope(request, READ_SCOPE);
  await requireCurrentVerifiedUser(request, services.auth);
  await requireSaasRollout(db, tx);
  const member = await tx.get(db.doc(`hotels/${hotelUid}/members/${request.auth.uid}`));
  const permissions = normalizedPermissions(member.exists ? member.data().permissions : []);
  const feature = Object.values(COLLECTIONS).find((candidate) => permissionAllows(permissions, candidate, "read")) || "catalogproducts";
  await access(db, request, hotelUid, feature, "read", tx, services);
}
async function validateSourceMapping(tx, db, request, hotelUid, source, rows, services) {
  if (!source.mappingId) return null;
  await access(db, request, hotelUid, "suppliers", "read", tx, services);
  await access(db, request, hotelUid, "supplierproducts", "read", tx, services);
  const snapshot = await tx.get(db.doc(`hotels/${hotelUid}/supplierImportMappingProfiles/${source.mappingId}`));
  const mapping = snapshot.exists ? snapshot.data() : null;
  const supplierRows = rows.filter((row) => row.kind === "supplier");
  if (!mapping || mapping.sourceFormat !== source.sourceFormat || !supplierRows.length || supplierRows.some((row) => row.proposed?.supplierId !== mapping.supplierId)) throw new HttpsError("invalid-argument", "The referenced supplier mapping does not match every supplier article and this source format.");
  const relevant = Object.fromEntries(["version", "supplierId", "sourceFormat", "profileId", "revision", "mappings", "interpretation", "interpretationFingerprint"].filter((key) => Object.hasOwn(mapping, key)).map((key) => [key, mapping[key]]));
  return { mappingId: source.mappingId, revision: mapping.revision ?? 0, fingerprint: digest(canonical(relevant)) };
}
async function classificationIssues(tx, db, hotelUid, product) {
  const issues = [];
  if (!product.category) {
    issues.push(issue("classification-unknown", "No category was supplied. Classification remains unknown for review.", "warning"));
    if (product.subcategory) issues.push(issue("subcategory-parent-required", "Choose an existing parent category before selecting a subcategory."));
    return issues;
  }
  const categories = await tx.get(db.collection(`hotels/${hotelUid}/settings/catalog/categories`).where("name", "==", product.category).limit(2));
  if (categories.docs.length !== 1) {
    issues.push(issue("category-unavailable", "Choose one existing, unambiguous category from this hotel's catalog settings."));
    return issues;
  }
  if (!product.subcategory) issues.push(issue("subcategory-unknown", "No subcategory was supplied. Classification remains incomplete for review.", "warning"));
  else {
    const children = await tx.get(db.collection(`hotels/${hotelUid}/settings/catalog/subcategories`).where("name", "==", product.subcategory).where("categoryId", "==", categories.docs[0].id).limit(2));
    if (children.docs.length !== 1) issues.push(issue("subcategory-unavailable", "Choose an existing subcategory belonging to the selected category."));
  }
  return issues;
}
function mergedProduct(row, base) {
  const result = { ...(productFields(row.kind, base) || {}), ...row.patch };
  if (row.kind === "catalog") {
    delete result.internalSku; delete result.imageUrl;
    if (base?.internalSku !== undefined) result.internalSku = base.internalSku;
    if (base?.imageUrl !== undefined) result.imageUrl = base.imageUrl;
  } else {
    delete result.supplierName;
    // A source may omit optional dates, prices or barcodes. Unknown values are
    // represented explicitly without manufacturing financial or physical terms.
    if (!Object.hasOwn(result, "priceBasis")) result.priceBasis = "unknown";
    if (Array.isArray(row.patch.purchaseOptions)) {
      // A partial source updates only the named stable package identities.
      // An explicit empty array is the deliberate clear-all operation; leaving
      // an option out of a nonempty source list never removes it.
      if (!row.patch.purchaseOptions.length) result.purchaseOptions = [];
      else {
        const options = new Map((base?.purchaseOptions || []).map((option) => [option.id, option]));
        for (const option of row.patch.purchaseOptions) options.set(option.id, { ...(options.get(option.id) || {}), ...option });
        result.purchaseOptions = [...options.values()];
      }
    }
  }
  return result;
}
async function validateRow(tx, db, hotelUid, row, allRows, base, source, captureReferences = false) {
  const issues = [], product = mergedProduct(row, base);
  let normalized = product;
  try {
    normalized = row.kind === "catalog" ? policy.normalizeCatalogProduct(product) : policy.normalizeSupplierProduct(product);
  } catch (error) { issues.push(issue("product-invalid", error.message)); }
  if (row.kind === "catalog") {
    issues.push(...await classificationIssues(tx, db, hotelUid, product));
    if (!Object.hasOwn(row.patch, "allergens") && !base) issues.push(issue("allergens-unknown", "No allergen information was supplied; no allergens were inferred.", "warning"));
    if (base?.productPolicyVersion === policy.PRODUCT_POLICY_VERSION && product.baseUnit !== base.baseUnit) issues.push(issue("catalog-unit-immutable", "The catalog base unit is immutable. Propose a separate catalog identity for a different unit."));
  } else {
    if (product.supplierId) {
      try {
        const id = requireDocumentId(product.supplierId, "Supplier ID"), supplier = await tx.get(db.doc(`hotels/${hotelUid}/suppliers/${id}`));
        if (!supplier.exists || product.active && (supplier.data().active === false || supplier.data().archived === true)) issues.push(issue("supplier-unavailable", "Choose an existing active supplier from this hotel."));
      } catch (error) { issues.push(issue("supplier-invalid", error.message)); }
    }
    let catalog = null;
    if (row.catalogRowId) {
      const parent = allRows.find((candidate) => candidate.rowId === row.catalogRowId);
      if (!parent || parent.kind !== "catalog" || parent.rowId === row.rowId) issues.push(issue("catalog-dependency-invalid", "The catalog dependency must reference a catalog proposal in this same batch."));
      else if (parent.status === "skipped" || parent.status === "invalid" || parent.status === "conflict" || parent.status === "failed") issues.push(issue("catalog-dependency-unresolved", "Correct and approve the linked catalog proposal before this supplier article."));
      else catalog = parent.proposed;
      if (product.catalogProductId) issues.push(issue("catalog-link-ambiguous", "Use either an existing catalog product ID or a same-batch catalog proposal, not both."));
    } else if (product.catalogProductId) {
      try {
        const id = requireDocumentId(product.catalogProductId, "Catalog product ID"), snapshot = await tx.get(db.doc(`hotels/${hotelUid}/catalogproducts/${id}`));
        if (!snapshot.exists) issues.push(issue("catalog-unavailable", "The linked catalog product does not exist in this hotel."));
        else {
          catalog = snapshot.data();
          const reference = { productId: id, revision: internals().currentRevision(catalog), fingerprint: digest(canonical(productFields("catalog", catalog))) };
          if (captureReferences) row.catalogReference = reference;
          else if (row.catalogReference && (row.catalogReference.productId !== reference.productId || row.catalogReference.revision !== reference.revision || row.catalogReference.fingerprint !== reference.fingerprint)) issues.push(issue("catalog-reference-conflict", "The linked catalog product changed after review. Reopen this proposal and review the current catalog selection before approval."));
        }
      } catch (error) { issues.push(issue("catalog-invalid", error.message)); }
    } else issues.push(issue("catalog-link-unknown", "This offer has no catalog link. Inventory conversion remains unavailable.", "warning"));
    if (catalog) {
      if (!policy.compatibleUnits(product.baseUnit, catalog.baseUnit)) issues.push(issue("catalog-unit-incompatible", "Supplier and catalog units must measure the same physical dimension."));
      else if (normalized.productPolicyVersion === 1) for (const option of [normalized, ...(normalized.purchaseOptions || [])]) {
        try { policy.convertQuantity(option.baseUnitsPerPurchaseUnit, product.baseUnit, catalog.baseUnit); }
        catch (error) { issues.push(issue("catalog-conversion-invalid", error.message)); }
      }
      if (product.active && (catalog.active === false || catalog.archived === true)) issues.push(issue("catalog-inactive", "An active offer requires an active linked catalog product."));
    }
    if (base?.productPolicyVersion === policy.PRODUCT_POLICY_VERSION && (base.supplierId !== product.supplierId || base.baseUnit !== product.baseUnit || base.catalogProductId && (row.catalogRowId || base.catalogProductId !== product.catalogProductId))) issues.push(issue("supplier-identity-immutable", "A reviewed offer's supplier, linked catalog identity and base unit cannot be replaced. Propose a distinct offer."));
    if (!product.priceValidFrom && !product.priceValidUntil) issues.push(issue("price-validity-unknown", "Price validity is unknown. Review the supplier agreement before relying on this price.", "warning"));
    if (!source.documentDate) issues.push(issue("source-date-unknown", "The price source date is unknown; freshness cannot be established.", "warning"));
    if (product.priceBasis === "unknown") issues.push(issue("price-basis-unknown", "The source does not establish a net or gross price basis.", "warning"));
    if (product.pricePerPurchaseUnit == null && product.pricePerBaseUnit == null) issues.push(issue("price-unknown", "No unit price was supplied. Existing prices are preserved when omitted; no price is invented.", "warning"));
  }
  return { proposed: productFields(row.kind, normalized), issues };
}
function statusFor(row, base) {
  if (row.issues.some((entry) => entry.severity === "error")) return "invalid";
  if (row.action === "update") {
    try {
      const normalized = row.kind === "catalog" ? policy.normalizeCatalogProduct(mergedProduct({ ...row, patch: {} }, base)) : policy.normalizeSupplierProduct(mergedProduct({ ...row, patch: {} }, base));
      if (!row.catalogRowId && digest(canonical(productFields(row.kind, normalized))) === digest(canonical(row.proposed))) return "unchanged";
    } catch { /* Incomplete old records still require a reviewed protected save. */ }
  }
  return "ready";
}
function noWrite(error) {
  return error instanceof HttpsError && !["permission-denied", "unauthenticated"].includes(error.code) ? new HttpsError(error.code, error.message, { ...error.details, productProposalRequestUncommitted: true }) : error;
}

async function stageHotelProductProposalsHandler(request, services = {}) {
  const input = request.data || {};
  exact(input, ["hotelUid", "requestId", "source", "rows"], "product proposal batch");
  boundedJson(input);
  const hotelUid = requireDocumentId(input.hotelUid, "hotelUid"), requestId = requireDocumentId(input.requestId, "requestId");
  if (!Array.isArray(input.rows) || input.rows.length < 1 || input.rows.length > MAX_PROPOSAL_ROWS) throw new HttpsError("invalid-argument", `Propose between 1 and ${MAX_PROPOSAL_ROWS} products per batch.`);
  const source = sourceData(input.source), db = services.firestore || admin.firestore();
  const fingerprint = digest(canonical(input)), batchId = `mcp-${digest(request.auth?.uid, requestId).slice(0, 48)}`, ref = db.doc(batchPath(hotelUid, batchId));
  const rows = input.rows.map((entry) => {
    exact(entry, ["rowId", "kind", "action", "productId", "expectedRevision", "product", "catalogRowId"], "product proposal row");
    if (!Object.hasOwn(COLLECTIONS, entry.kind) || !["create", "update"].includes(entry.action)) throw new HttpsError("invalid-argument", "Propose catalog or supplier products using create or update.");
    const rowId = requireDocumentId(entry.rowId, "Proposal row ID"), patch = patchData(entry.kind, entry.product);
    if (entry.action === "create" && (entry.productId != null || entry.expectedRevision != null && entry.expectedRevision !== 0)) throw new HttpsError("invalid-argument", "New product identities are assigned by the backend and require revision zero.");
    const productId = entry.action === "update" ? requireDocumentId(entry.productId, "Existing product ID") : `p-${digest(hotelUid, batchId, rowId, entry.kind).slice(0, 40)}`;
    const catalogRowId = entry.catalogRowId == null ? null : requireDocumentId(entry.catalogRowId, "Catalog proposal row ID");
    if (catalogRowId && entry.kind !== "supplier") throw new HttpsError("invalid-argument", "Only supplier products may refer to a same-batch catalog proposal.");
    return { rowId, kind: entry.kind, action: entry.action, productId, expectedRevision: entry.action === "update" ? revision(entry.expectedRevision) : 0,
      patch, catalogRowId, original: null, proposed: null, status: "ready", issues: [], result: null, error: null, current: null, currentRevision: null };
  });
  if (new Set(rows.map((row) => row.rowId)).size !== rows.length || new Set(rows.map((row) => `${row.kind}:${row.productId}`)).size !== rows.length) throw new HttpsError("invalid-argument", "Proposal row IDs and target product identities must be unique within a batch.");
  return db.runTransaction(async (tx) => {
    const actor = { ...request };
    await authorizeRows(db, actor, hotelUid, rows, tx, services, true);
    const saved = await tx.get(ref);
    if (saved.exists) {
      const existing = ownedBatch(saved, request.auth.uid);
      await authorizeRows(db, actor, hotelUid, existing.rows, tx, services, true);
      if (existing.fingerprint !== fingerprint) throw new HttpsError("already-exists", "This proposal request ID was already used with different source data.");
      return publicBatch(existing);
    }
    for (const row of rows) {
      const current = await tx.get(db.doc(`hotels/${hotelUid}/${COLLECTIONS[row.kind]}/${row.productId}`));
      const stored = current.exists ? current.data() : null;
      row.original = productFields(row.kind, stored);
      row.originalRevision = stored ? internals().currentRevision(stored) : null;
      row.originalFingerprint = stored ? digest(canonical(row.original)) : null;
      row.base = stored ? productFields(row.kind, stored) : null;
      row.basePolicyVersion = stored?.productPolicyVersion ?? null;
    }
    // Catalog rows are validated first so dependencies see their actual reviewed
    // proposal, even when the client placed supplier rows first in the batch.
    for (const row of [...rows].sort((left, right) => (left.kind === "catalog" ? 0 : 1) - (right.kind === "catalog" ? 0 : 1))) {
      const base = row.base ? { ...row.base, productPolicyVersion: row.basePolicyVersion } : null;
      Object.assign(row, await validateRow(tx, db, hotelUid, row, rows, base, source, true));
      row.status = statusFor(row, base);
      if (row.action === "update" && (!base || row.originalRevision !== row.expectedRevision)) {
        row.status = "conflict"; row.current = row.original; row.currentRevision = row.originalRevision;
        row.issues.push(issue("product-conflict", "The current product does not match the requested revision. Reconcile it explicitly before approval."));
      }
    }
    await authorizeRows(db, actor, hotelUid, rows, tx, services, true);
    const mappingEvidence = await validateSourceMapping(tx, db, actor, hotelUid, source, rows, services);
    if (mappingEvidence) for (const row of rows.filter((candidate) => candidate.kind === "supplier")) row.reviewedMappingFingerprint = mappingEvidence.fingerprint;
    const now = services.now?.() ?? Date.now();
    const batch = finalizeBatch({ version: VERSION, batchId, hotelUid, ownerUid: request.auth.uid, requester: { uid: request.auth.uid }, fingerprint,
      source, originalSource: source, mappingEvidence, originalRows: rows.map((row) => ({ rowId: row.rowId, patch: row.patch, catalogRowId: row.catalogRowId })), rows,
      revision: 1, activeReviewId: null, createdAtMillis: now, updatedAtMillis: now });
    tx.create(ref, { ...batch, createdAt: stamp(), updatedAt: stamp() });
    return publicBatch(batch);
  });
}

async function readHotelProductProposalBatchHandler(request, services = {}) {
  const input = request.data || {}; exact(input, ["hotelUid", "batchId"], "product proposal lookup");
  const hotelUid = requireDocumentId(input.hotelUid, "hotelUid"), batchId = requireDocumentId(input.batchId, "batchId"), db = services.firestore || admin.firestore();
  return db.runTransaction(async (tx) => {
    const actor = { ...request };
    // The initial read is guarded before looking up any private batch. The
    // batch's actual feature permissions are checked before returning data.
    await authorizeAnyProductRead(db, actor, hotelUid, tx, services);
    const batch = ownedBatch(await tx.get(db.doc(batchPath(hotelUid, batchId))), request.auth.uid);
    await authorizeRows(db, actor, hotelUid, batch.rows, tx, services);
    // A native image edit has its own revision and does not change the product
    // proposal revision. Refresh the comparison so a rejected replacement can
    // be explicitly reviewed against the actual current image.
    for (const row of batch.rows.filter((entry) => entry.kind === "supplier" && entry.image)) {
      const productId = row.result?.productId || (row.action === "update" ? row.productId : null);
      const product = productId ? await tx.get(db.doc(`hotels/${hotelUid}/supplierproducts/${requireDocumentId(productId, "Supplier product ID")}`)) : null;
      row.image = { ...row.image, currentImage: require("./hotelMcpProposalImages").currentImage(product?.exists ? product.data() : null),
        ...((row.image.expiresAtMillis ?? Infinity) <= (services.now?.() ?? Date.now()) ? { status: "expired" } : {}) };
    }
    return publicBatch(batch);
  });
}
async function listHotelProductProposalBatchesHandler(request, services = {}) {
  const input = request.data || {}; exact(input, ["hotelUid", "limit", "cursor"], "product proposal list");
  const hotelUid = requireDocumentId(input.hotelUid, "hotelUid"), db = services.firestore || admin.firestore(), limit = input.limit ?? 15;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PROPOSAL_ROWS) throw new HttpsError("invalid-argument", "List between 1 and 25 private proposal batches.");
  const cursor = input.cursor == null ? null : requireDocumentId(input.cursor, "Batch cursor");
  return db.runTransaction(async (tx) => {
    const actor = { ...request };
    await authorizeAnyProductRead(db, actor, hotelUid, tx, services);
    let query = db.collection(`hotels/${hotelUid}/hotelMcpProposalBatches`).where("ownerUid", "==", request.auth.uid)
      .orderBy("createdAtMillis", "desc").orderBy(admin.firestore.FieldPath.documentId(), "desc");
    if (cursor) {
      const anchor = ownedBatch(await tx.get(db.doc(batchPath(hotelUid, cursor))), request.auth.uid);
      query = query.startAfter(anchor.createdAtMillis, cursor);
    }
    const page = query.limit(limit + 1);
    const found = await readMcpIndexQuery("proposals", () => tx.get(page)), batches = [];
    for (const doc of found.docs.slice(0, limit)) {
      const batch = ownedBatch(doc, request.auth.uid);
      // Returning a summary is also a product data action. Revoked feature
      // access does not retain visibility through an old staged request.
      try { await authorizeRows(db, actor, hotelUid, batch.rows, tx, services); }
      catch (error) {
        if (error?.code !== "permission-denied") throw error;
        // Old private batches never retain revoked product access, and cannot
        // hide newer accessible batches. The bounded scan still advances.
        continue;
      }
      const { rows, ...result } = publicBatch(batch); void rows;
      batches.push(result);
    }
    await authorizeAnyProductRead(db, { ...request }, hotelUid, tx, services);
    return { hotelUid, batches, nextCursor: found.docs.length > limit ? found.docs[limit - 1].id : null };
  });
}

function priceEvidence(batch, row) {
  const keys = row.patch.pricingModel === "Per Base Unit" || row.proposed?.pricingModel === "Per Base Unit" ? ["pricePerBaseUnit"] : ["pricePerPurchaseUnit"];
  const provided = [];
  if (keys.some((key) => Object.hasOwn(row.patch, key) && typeof row.patch[key] === "number")) provided.push("default");
  if (Array.isArray(row.patch.purchaseOptions)) for (const option of row.patch.purchaseOptions) if (Object.hasOwn(option, "pricePerPurchaseUnit") && typeof option.pricePerPurchaseUnit === "number") provided.push(option.id);
  return { kind: "supplier-list", confirmsUnitPrice: provided.length > 0, providedPriceOptionIds: provided,
    allowPriceChange: Object.keys(row.patch).some((key) => ["pricePerBaseUnit", "pricePerPurchaseUnit", "priceBasis", "vatRate", "currency", "priceValidFrom", "priceValidUntil", "purchaseUnit", "baseUnitsPerPurchaseUnit", "purchaseOptions", "pricingModel"].includes(key)),
    sourceReference: batch.source.url || batch.source.label, sourceIssuedOn: batch.source.documentDate,
    sourceImportId: batch.batchId, sourceProposalId: row.rowId };
}
async function finishApprovedProposalImages(request, operation, result, services) {
  if (operation.action !== "approve" || !operation.imageSelections?.length) return result;
  let failed = false;
  try {
    await require("./hotelMcpProposalImages").attachSelectedProposalImages(request, {
      hotelUid: request.data.hotelUid, batchId: request.data.batchId, rowIds: operation.rowIds,
      selectionSnapshot: operation.imageSelections,
    }, services);
  } catch {
    // Product commands are already durable. Image I/O cannot roll them back or
    // turn their exact retry into another product/price/SKU mutation.
    failed = true;
    logger.warn("Product proposal data was committed; image attachment needs recovery.");
  }
  const current = await readHotelProductProposalBatchHandler({ ...request,
    data: { hotelUid: request.data.hotelUid, batchId: request.data.batchId } }, services);
  if (failed) for (const row of current.rows) {
    if (row.status === "applied" && row.image?.selection === "selected" && row.image.attachment?.status !== "attached"
      && operation.imageSelections.some((selection) => selection.rowId === row.rowId && selection.assetId === row.image.assetId
        && selection.decisionRevision === row.image.decisionRevision)) {
      row.image.attachment = { ...row.image.attachment, status: "failed", error: { code: "image-attachment-unavailable",
        message: "Product data was approved. The image could not be attached; retry the image without preparing the product again." } };
    }
  }
  return { ...current, requestId: request.data.requestId };
}
async function reviewHotelProductProposalsHandler(request, services = {}) {
  if (request.mcpAuth) throw new HttpsError("permission-denied", "Product proposals may only be approved in Hotel Toolkit.");
  const input = request.data || {}; exact(input, ["hotelUid", "batchId", "requestId", "expectedRevision", "action", "rowIds", "corrections"], "product proposal review");
  boundedJson(input);
  const hotelUid = requireDocumentId(input.hotelUid, "hotelUid"), batchId = requireDocumentId(input.batchId, "batchId"), requestId = requireDocumentId(input.requestId, "requestId");
  const db = services.firestore || admin.firestore(), ref = db.doc(batchPath(hotelUid, batchId)), opRef = db.doc(operationPath(hotelUid, request.auth?.uid, requestId));
  const fingerprint = digest(canonical(input));
  if (!["correct", "skip", "approve"].includes(input.action)) throw new HttpsError("invalid-argument", "Choose correct, skip or approve.");
  const started = await db.runTransaction(async (tx) => {
    const actor = { ...request };
    await authorizeAnyProductRead(db, actor, hotelUid, tx, services);
    const batch = ownedBatch(await tx.get(ref), request.auth.uid);
    await authorizeRows(db, actor, hotelUid, batch.rows, tx, services);
    const prior = await tx.get(opRef);
    if (prior.exists) {
      if (prior.data().fingerprint !== fingerprint || prior.data().batchId !== batchId) throw new HttpsError("already-exists", "This review request ID was already used with different choices.");
      await authorizeRows(db, actor, hotelUid, batch.rows.filter((row) => prior.data().rowIds.includes(row.rowId)), tx, services, true);
      return prior.data();
    }
    try {
      if (revision(input.expectedRevision) !== batch.revision) throw new HttpsError("aborted", "This proposal review changed. Refresh before continuing.");
      if (batch.activeReviewId) throw new HttpsError("failed-precondition", "Another review command is still processing. Resume its original request before starting a new action.");
      let rowIds = input.rowIds ?? batch.rows.filter((row) => REVIEWABLE.has(row.status)).map((row) => row.rowId);
      if (input.action === "correct") {
        if (!Array.isArray(input.corrections) || !input.corrections.length || input.corrections.length > MAX_PROPOSAL_ROWS) throw new HttpsError("invalid-argument", "Provide between 1 and 25 proposal corrections.");
        if (input.rowIds !== undefined) throw new HttpsError("invalid-argument", "Corrections identify their own proposal rows.");
        rowIds = input.corrections.map((entry) => requireDocumentId(entry.rowId, "Correction row ID"));
      } else if (input.corrections !== undefined) throw new HttpsError("invalid-argument", "Only a correction command may provide product changes.");
      if (!Array.isArray(rowIds) || rowIds.length < 1 || rowIds.length > MAX_PROPOSAL_ROWS || new Set(rowIds).size !== rowIds.length || rowIds.some((id) => typeof id !== "string" || !batch.rows.some((row) => row.rowId === id && REVIEWABLE.has(row.status)))) throw new HttpsError("invalid-argument", "Choose unique, unapplied proposal rows from this batch.");
      await authorizeRows(db, actor, hotelUid, batch.rows.filter((row) => rowIds.includes(row.rowId)), tx, services, true);
      if (input.action === "correct") {
        for (const correction of input.corrections) {
          exact(correction, ["rowId", "product", "catalogRowId", "expectedRevision", "acknowledgeCurrent"], "proposal correction");
          const row = batch.rows.find((candidate) => candidate.rowId === correction.rowId);
          row.patch = patchData(row.kind, correction.product);
          if (Object.hasOwn(correction, "catalogRowId")) {
            if (row.kind !== "supplier") throw new HttpsError("invalid-argument", "Only supplier proposals may depend on a catalog proposal.");
            row.catalogRowId = correction.catalogRowId == null ? null : requireDocumentId(correction.catalogRowId, "Catalog proposal row ID");
          }
          const snapshot = row.action === "update" ? await tx.get(db.doc(`hotels/${hotelUid}/${COLLECTIONS[row.kind]}/${row.productId}`)) : null;
          const current = snapshot?.exists ? snapshot.data() : null;
          if (Object.hasOwn(correction, "expectedRevision")) {
            if (row.action !== "update" || correction.acknowledgeCurrent !== true || !current || revision(correction.expectedRevision) !== internals().currentRevision(current)) throw new HttpsError("aborted", "Explicitly acknowledge the current existing product revision before reconciling this conflict.");
            row.expectedRevision = correction.expectedRevision; row.base = productFields(row.kind, current); row.basePolicyVersion = current.productPolicyVersion ?? null;
            row.baseFingerprint = digest(canonical(row.base));
          } else if (correction.acknowledgeCurrent !== undefined) throw new HttpsError("invalid-argument", "Acknowledging a current product requires its current revision.");
          row.error = null;
        }
        for (const row of [...batch.rows].filter((candidate) => REVIEWABLE.has(candidate.status)).sort((left, right) => (left.kind === "catalog" ? 0 : 1) - (right.kind === "catalog" ? 0 : 1))) {
          const base = row.base ? { ...row.base, productPolicyVersion: row.basePolicyVersion } : null;
          Object.assign(row, await validateRow(tx, db, hotelUid, row, batch.rows, base, batch.source, rowIds.includes(row.rowId))); row.status = statusFor(row, base);
          if (row.action === "update") {
            const current = await tx.get(db.doc(`hotels/${hotelUid}/${COLLECTIONS[row.kind]}/${row.productId}`));
            if (!current.exists || internals().currentRevision(current.data()) !== row.expectedRevision || digest(canonical(productFields(row.kind, current.data()))) !== (row.baseFingerprint || row.originalFingerprint)) {
              row.status = "conflict"; row.current = current.exists ? productFields(row.kind, current.data()) : null; row.currentRevision = current.exists ? internals().currentRevision(current.data()) : null;
              row.issues.push(issue("product-conflict", "The current product changed. Explicitly reconcile and acknowledge its current revision."));
            } else { row.current = null; row.currentRevision = null; }
          }
        }
      } else if (input.action === "skip") {
        for (const row of batch.rows.filter((candidate) => rowIds.includes(candidate.rowId))) { row.status = "skipped"; row.error = null; }
        // Dependent offers remain reviewable and visibly blocked when their
        // parent was skipped; no placeholder ID can become an active link.
        for (const row of batch.rows.filter((candidate) => REVIEWABLE.has(candidate.status) && candidate.catalogRowId && rowIds.includes(candidate.catalogRowId))) {
          row.status = "invalid"; row.issues = [...row.issues.filter((entry) => entry.code !== "catalog-dependency-unresolved"), issue("catalog-dependency-unresolved", "The linked catalog proposal was skipped. Select another catalog product or proposal.")];
        }
      }
      await authorizeRows(db, actor, hotelUid, batch.rows, tx, services);
      await authorizeRows(db, actor, hotelUid, batch.rows.filter((row) => rowIds.includes(row.rowId)), tx, services, true);
      const currentMapping = await validateSourceMapping(tx, db, actor, hotelUid, batch.source, batch.rows, services);
      if (currentMapping && input.action === "correct") for (const row of batch.rows.filter((candidate) => candidate.kind === "supplier" && rowIds.includes(candidate.rowId))) row.reviewedMappingFingerprint = currentMapping.fingerprint;
      if (currentMapping) for (const row of batch.rows.filter((candidate) => candidate.kind === "supplier" && REVIEWABLE.has(candidate.status) && candidate.reviewedMappingFingerprint !== currentMapping.fingerprint)) {
        row.status = "invalid";
        row.issues = [...row.issues.filter((entry) => entry.code !== "mapping-profile-changed"), issue("mapping-profile-changed", "The confirmed supplier mapping changed after this proposal. Review and save this row's explicit fields again before approval.")];
      }
      const now = services.now?.() ?? Date.now();
      batch.revision += 1; batch.updatedAtMillis = now;
      const operation = { batchId, ownerUid: request.auth.uid, fingerprint, action: input.action, rowIds: [...rowIds].sort((a, b) => (batch.rows.find((row) => row.rowId === a).kind === "catalog" ? 0 : 1) - (batch.rows.find((row) => row.rowId === b).kind === "catalog" ? 0 : 1)), outcomes: [], status: input.action === "approve" ? "applying" : "completed", createdAt: stamp() };
      if (input.action === "approve") {
        operation.imageSelections = batch.rows.filter((row) => rowIds.includes(row.rowId) && row.kind === "supplier" && row.image?.selection === "selected")
          .map((row) => ({ rowId: row.rowId, assetId: row.image.assetId, decisionRevision: row.image.decisionRevision }));
        batch.activeReviewId = opRef.path.split("/").at(-1);
        batch.reviewCommand = boundedJson(input);
      }
      finalizeBatch(batch);
      if (operation.status === "completed") operation.result = { ...publicBatch(batch), requestId };
      tx.set(ref, { ...batch, updatedAt: stamp() }); tx.create(opRef, operation);
      return operation;
    } catch (error) { throw noWrite(error); }
  });
  if (started.status === "completed") return finishApprovedProposalImages(request, started, started.result, services);
  // Each row and its durable result share the existing product transaction.
  // A crash between rows resumes this exact receipt; it cannot duplicate SKUs,
  // prices or products, nor repeat a previously committed row.
  for (const rowId of started.rowIds) {
    await db.runTransaction(async (tx) => {
      const actor = { ...request };
      await authorizeAnyProductRead(db, actor, hotelUid, tx, services);
      const batch = ownedBatch(await tx.get(ref), request.auth.uid), op = (await tx.get(opRef)).data();
      await authorizeRows(db, actor, hotelUid, batch.rows, tx, services);
      await authorizeRows(db, actor, hotelUid, batch.rows.filter((row) => op.rowIds.includes(row.rowId)), tx, services, true);
      if (op.status === "completed" || op.outcomes.some((outcome) => outcome.rowId === rowId)) return;
      if (batch.activeReviewId !== opRef.path.split("/").at(-1)) throw new HttpsError("failed-precondition", "The active proposal review receipt needs reconciliation.");
      const row = batch.rows.find((candidate) => candidate.rowId === rowId), collection = COLLECTIONS[row.kind];
      const snapshot = await tx.get(db.doc(`hotels/${hotelUid}/${collection}/${row.productId}`)), current = snapshot.exists ? snapshot.data() : null;
      let result = null, productPlan = null;
      try {
        if (row.action === "update" && (!current || internals().currentRevision(current) !== row.expectedRevision || digest(canonical(productFields(row.kind, current))) !== (row.baseFingerprint || row.originalFingerprint))) {
          row.current = productFields(row.kind, current); row.currentRevision = current ? internals().currentRevision(current) : null;
          throw new HttpsError("aborted", "The product changed after proposal review. Reconcile the current values before approval.");
        }
        const base = row.base ? { ...row.base, productPolicyVersion: row.basePolicyVersion } : null;
        Object.assign(row, await validateRow(tx, db, hotelUid, row, batch.rows, base, batch.source));
        const currentMapping = await validateSourceMapping(tx, db, actor, hotelUid, batch.source, batch.rows, services);
        if (row.kind === "supplier" && currentMapping && row.reviewedMappingFingerprint !== currentMapping.fingerprint) row.issues.push(issue("mapping-profile-changed", "The confirmed supplier mapping changed after this proposal. Review and save this row's explicit fields again before approval."));
        if (row.issues.some((entry) => entry.severity === "error")) throw new HttpsError("failed-precondition", "Correct this proposal's validation issues before approval.");
        let product = mergedProduct(row, current);
        if (row.catalogRowId) {
          const dependency = batch.rows.find((candidate) => candidate.rowId === row.catalogRowId);
          if (!dependency?.result?.productId || dependency.status !== "applied") throw new HttpsError("failed-precondition", "Approve the linked catalog proposal before its supplier articles.");
          const catalog = await tx.get(db.doc(`hotels/${hotelUid}/catalogproducts/${dependency.result.productId}`));
          if (!catalog.exists || internals().currentRevision(catalog.data()) !== dependency.result.revision) throw new HttpsError("failed-precondition", "The catalog product created for this proposal changed. Review it as an existing catalog selection before approving the supplier article.");
          product = { ...product, catalogProductId: dependency.result.productId };
        }
        if (row.status === "unchanged" && !(row.kind === "supplier" && priceEvidence(batch, row).confirmsUnitPrice)) result = { productId: row.productId, revision: row.expectedRevision, unchanged: true };
        else productPlan = await internals().prepareProduct(tx, db, hotelUid, collection, row.productId, row.action, row.expectedRevision, product, new Map(), row.kind === "supplier" ? priceEvidence(batch, row) : undefined, services);
      } catch (error) {
        if (!(error instanceof HttpsError) || ["permission-denied", "unauthenticated"].includes(error.code)) throw error;
        row.error = errorData(error); row.status = error.code === "aborted" ? "conflict" : row.issues.some((entry) => entry.severity === "error") ? "invalid" : "failed";
      }
      if (productPlan) result = internals().writeProduct(tx, productPlan, collection, request.auth.uid);
      if (result) {
        row.result = result; row.status = "applied"; row.error = null;
        tx.create(db.doc(`hotels/${hotelUid}/productAudit/mcp-${digest(batchId, rowId).slice(0, 48)}`), { actorUid: request.auth.uid, collection, action: row.action, productId: result.productId, revision: result.revision, sourceBatchId: batchId, sourceRowId: rowId, createdAt: stamp() });
      }
      op.outcomes.push({ rowId, status: row.status, result: row.result, error: row.error });
      batch.revision += 1; batch.updatedAtMillis = services.now?.() ?? Date.now(); finalizeBatch(batch);
      tx.set(ref, { ...batch, updatedAt: stamp() }); tx.set(opRef, op);
    });
    await services.afterRow?.(rowId);
  }
  const completed = await db.runTransaction(async (tx) => {
    const actor = { ...request };
    await authorizeAnyProductRead(db, actor, hotelUid, tx, services);
    const batch = ownedBatch(await tx.get(ref), request.auth.uid), operation = (await tx.get(opRef)).data();
    await authorizeRows(db, actor, hotelUid, batch.rows, tx, services);
    await authorizeRows(db, actor, hotelUid, batch.rows.filter((row) => operation.rowIds.includes(row.rowId)), tx, services, true);
    if (operation.status === "completed") return operation.result;
    batch.activeReviewId = null; batch.reviewCommand = null; batch.revision += 1; batch.updatedAtMillis = services.now?.() ?? Date.now(); finalizeBatch(batch);
    operation.status = "completed"; operation.result = { ...publicBatch(batch), requestId };
    tx.set(ref, { ...batch, updatedAt: stamp() }); tx.set(opRef, operation);
    return operation.result;
  });
  return finishApprovedProposalImages(request, started, completed, services);
}

const options = { region: "us-central1", cors: true, timeoutSeconds: 120, memory: "512MiB", concurrency: 4, maxInstances: 5 };
const stageHotelProductProposals = onCall(options, gated(stageHotelProductProposalsHandler));
const readHotelProductProposalBatch = onCall(options, gated(readHotelProductProposalBatchHandler));
const listHotelProductProposalBatches = onCall(options, gated(listHotelProductProposalBatchesHandler));
const reviewHotelProductProposals = onCall(options, gated(reviewHotelProductProposalsHandler));
module.exports = { MAX_PROPOSAL_ROWS, CATALOG_FIELDS, SUPPLIER_FIELDS, stageHotelProductProposalsHandler, readHotelProductProposalBatchHandler,
  listHotelProductProposalBatchesHandler, reviewHotelProductProposalsHandler, stageHotelProductProposals, readHotelProductProposalBatch,
  listHotelProductProposalBatches, reviewHotelProductProposals };
