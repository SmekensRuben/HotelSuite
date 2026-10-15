const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { admin } = require("./config");
const { requireHotelPermission } = require("./authorization");
const { requireDocumentId } = require("./subscriptions");
const { digest, revision } = require("./validation");
const { gated, requireSaasRollout } = require("./saasRollout");
const policy = require("./productPolicy");

const CATALOG_SYNC_VERSION = 1, MAX_SYNC_ROWS = 25, MAX_CATALOG_POOL = 500, MAX_SOURCE_SCAN = 250, JOB_LIFETIME_MS = 24 * 60 * 60 * 1000;
const MAX_PACKAGE_VERSIONS = 100, MAX_BATCH_PACKAGE_VERSIONS = 250;
const stamp = () => admin.firestore.FieldValue.serverTimestamp();
const jobPath = (hotelUid, jobId) => `hotels/${hotelUid}/catalogSyncJobs/${jobId}`;
const internals = () => require("./products").catalogProductInternals;
const matching = () => require("./catalogSyncPolicy");
function exact(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((field) => !fields.includes(field))) throw new HttpsError("invalid-argument", `Unsupported ${label} field.`);
}
function boundedText(value, maximum) { return typeof value === "string" ? value.slice(0, maximum) : ""; }
function physicalFacts(value) {
  const facts = { name: boundedText(value?.name, 200), brand: boundedText(value?.brand, 200), description: boundedText(value?.description, 500),
    category: boundedText(value?.category, 100), subcategory: boundedText(value?.subcategory, 100), gtin: boundedText(value?.gtin, 100),
    internalSku: boundedText(value?.internalSku, 100), baseUnit: policy.units[value?.baseUnit] ? value.baseUnit : null,
    allergens: Array.isArray(value?.allergens) ? value.allergens.slice(0, 30).map((item) => boundedText(item, 100)) : [],
    active: value?.active === true, inventoryTracked: value?.inventoryTracked === true, productPolicyVersion: value?.productPolicyVersion ?? null };
  const identity = matching().extractCatalogPhysicalIdentity(value || {}, { knownBrands: value?.brand ? [value.brand] : [] });
  facts.physicalIdentity = { ...identity, qualifiers: Object.fromEntries(Object.entries(identity.qualifiers).map(([key, values]) => [key, values.slice(0, 30)])),
    truncated: Object.values(identity.qualifiers).some((values) => values.length > 30) };
  return facts;
}
function supplierFacts(value) {
  return { ...physicalFacts(value), supplierId: boundedText(value?.supplierId, 150), supplierSku: boundedText(value?.supplierSku, 150), hasVariants: value?.hasVariants === true,
    supplierProductName: boundedText(value?.supplierProductName, 200), purchaseUnit: boundedText(value?.purchaseUnit, 100),
    baseUnitsPerPurchaseUnit: value?.baseUnitsPerPurchaseUnit ?? null, catalogProductId: value?.catalogProductId ?? null,
    purchaseOptions: (Array.isArray(value?.purchaseOptions) ? value.purchaseOptions : []).slice(0, 20).map((option) => ({
      id: boundedText(option?.id, 150), purchaseUnit: boundedText(option?.purchaseUnit, 100), baseUnitsPerPurchaseUnit: option?.baseUnitsPerPurchaseUnit ?? null,
      gtin: boundedText(option?.gtin, 14) })) };
}
function isUnlinked(value) { return value?.catalogProductId === undefined || value.catalogProductId === null || value.catalogProductId === ""; }
function activeCanonical(value) { return value?.active === true && value.archived !== true && !value.archivedAt && value.productPolicyVersion === policy.PRODUCT_POLICY_VERSION; }
async function authorizeSync(db, request, hotelUid, tx, services = {}, write = false) {
  await requireSaasRollout(db, tx);
  const actor = { ...request };
  for (const [feature, action] of [["supplierproducts", "read"], ["catalogproducts", "read"], ["suppliers", "read"], ...(write ? [["supplierproducts", "update"]] : [])]) {
    await requireHotelPermission(db, actor, hotelUid, feature, action, tx, services.auth);
  }
  return actor;
}
function requireSyncJob(snapshot, actorUid, now = Date.now()) {
  if (!snapshot.exists) throw new HttpsError("not-found", "The catalog synchronization review does not exist in this hotel.");
  const job = snapshot.data();
  if (!actorUid || job.ownerUid !== actorUid) throw new HttpsError("permission-denied", "Only the owner may open or apply this private catalog review.");
  if (job.version !== CATALOG_SYNC_VERSION || !Number.isSafeInteger(job.revision) || job.revision < 1
    || !["review", "completed"].includes(job.status) || !Array.isArray(job.rowIds) || job.rowIds.length > MAX_SYNC_ROWS
    || new Set(job.rowIds).size !== job.rowIds.length || job.rowIds.some((id) => !/^r-\d{6}$/.test(id))) {
    throw new HttpsError("failed-precondition", "This catalog review is inconsistent. Start a new preview.");
  }
  if (!Number.isFinite(job.expiresAtMillis) || job.expiresAtMillis <= now) throw new HttpsError("failed-precondition", "This catalog review has expired. Start a new preview.");
  return job;
}
function validateSyncCompatibility(source, catalog) {
  const reasons = [], warnings = [], conversions = [];
  if (!activeCanonical(source)) reasons.push("Review an active supplier product's physical unit contract before linking it.");
  if (typeof source?.supplierProductName !== "string" || !source.supplierProductName.trim() || source.supplierProductName.length > 200
    || typeof source?.supplierSku !== "string" || !source.supplierSku.trim() || source.supplierSku.length > 150) reasons.push("Review the supplier article number and descriptive name before linking it.");
  if (!activeCanonical(catalog)) reasons.push("Select an active reviewed catalog product.");
  if (!policy.compatibleUnits(source?.baseUnit, catalog?.baseUnit)) reasons.push("Supplier and catalog units must measure the same physical dimension.");
  if (source?.hasVariants && !(Array.isArray(source.purchaseOptions) && source.purchaseOptions.length) || !Array.isArray(source?.purchaseOptions ?? []) || (source?.purchaseOptions || []).length > 20) {
    reasons.push("Review the supplier purchase options before linking this offer.");
  } else {
    const options = source?.purchaseOptions || [], ids = options.map((option) => option?.id);
    if (ids.some((id) => typeof id !== "string" || !id || id.length > 150 || /[\/\\\u0000-\u001f]/.test(id) || ["default", ".", ".."].includes(id)) || new Set(ids).size !== ids.length) {
      reasons.push("Supplier purchase-option identities must be supported and unique before linking.");
    }
    for (const option of [{ id: "default", purchaseUnit: source?.purchaseUnit, baseUnitsPerPurchaseUnit: source?.baseUnitsPerPurchaseUnit }, ...options]) {
      try {
        if (typeof option?.purchaseUnit !== "string" || !option.purchaseUnit.trim() || option.purchaseUnit.length > 100) throw new HttpsError("failed-precondition", "Review the supplier's purchase-package label before linking.");
        const quantity = policy.decimal(option?.baseUnitsPerPurchaseUnit, "Purchase package content", { maximum: policy.MAX_QUANTITY, positive: true });
        const measured = policy.measuredPurchaseContent(option.purchaseUnit, source.baseUnit);
        if (measured !== null && measured !== quantity) throw new HttpsError("failed-precondition", "A kg purchase unit must contain exactly 1 kg or 1000 g before linking.");
        conversions.push({ purchaseOptionId: option.id, quantity, from: source.baseUnit, to: catalog.baseUnit,
          convertedQuantity: policy.convertQuantity(quantity, source.baseUnit, catalog.baseUnit) });
      } catch (error) { reasons.push(error.message); }
    }
  }
  const semantic = matching().validateCatalogSyncSelection(source, catalog);
  reasons.push(...(semantic.reasons || [])); warnings.push(...(semantic.warnings || []));
  if (semantic.allowed !== true && !(semantic.reasons || []).length) reasons.push("These articles are not established as interchangeable goods.");
  return { allowed: reasons.length === 0, reasons: [...new Set(reasons)], warnings: [...new Set(warnings)], conversions };
}
async function validateApprovedPackages(tx, db, hotelUid, sourceRow, target, budget) {
  const versions = await tx.get(db.collection(`hotels/${hotelUid}/supplierPriceVersions/${sourceRow.row.supplierProductId}/entries`)
    .select("supplierPriceVersionPolicyVersion", "supplierProductId", "supplierId", "productTerms.baseUnit", "productTerms.purchaseUnit", "productTerms.baseUnitsPerPurchaseUnit", "productTerms.purchaseOptions")
    .limit(MAX_PACKAGE_VERSIONS + 1));
  if (versions.docs.length > MAX_PACKAGE_VERSIONS) throw new HttpsError("failed-precondition", "This offer's approved package history exceeds 100 versions. Review a paged physical-package reconciliation before linking it.");
  const ids = new Set(versions.docs.map((doc) => doc.id));
  if ([sourceRow.source.latestApprovedPriceVersionId, sourceRow.source.currentPriceVersionId].some((id) => id && !ids.has(id))) {
    throw new HttpsError("failed-precondition", "Approved supplier package evidence is missing from its stored history. Restore or reconcile it before linking.");
  }
  budget.versions += versions.docs.length;
  if (budget.versions > MAX_BATCH_PACKAGE_VERSIONS) throw new HttpsError("failed-precondition", "This batch contains more than 250 approved package versions. Select fewer offers so every physical conversion can be reviewed together.");
  for (const doc of versions.docs) {
    const version = doc.data(), terms = version.productTerms;
    if (version.supplierPriceVersionPolicyVersion !== 1 || version.supplierProductId !== sourceRow.row.supplierProductId || version.supplierId !== sourceRow.source.supplierId
      || !terms || !Array.isArray(terms.purchaseOptions ?? [])) throw new HttpsError("failed-precondition", "Approved supplier package evidence is incomplete or belongs to another offer. Review the source history before linking.");
    const historicalPackages = { ...supplierFacts(sourceRow.source), baseUnit: terms.baseUnit, purchaseUnit: terms.purchaseUnit,
      baseUnitsPerPurchaseUnit: terms.baseUnitsPerPurchaseUnit, purchaseOptions: (terms.purchaseOptions || []).map((option) => ({
        id: option?.id, purchaseUnit: option?.purchaseUnit, baseUnitsPerPurchaseUnit: option?.baseUnitsPerPurchaseUnit })) };
    const compatible = validateSyncCompatibility(historicalPackages, target);
    if (!compatible.allowed) throw new HttpsError("failed-precondition", "An approved supplier package, including a scheduled package, cannot convert exactly to this catalog unit. Choose a compatible unit or review the package agreement first.");
  }
}
function publicRow(row) {
  return { rowId: row.rowId, supplierProductId: row.supplierProductId, expectedSupplierRevision: row.expectedSupplierRevision, reviewRevision: row.reviewRevision,
    supplierProduct: { ...row.supplierProduct, sourceEachSpec: matching().extractCatalogPhysicalIdentity(row.supplierProduct).eachSpec },
    status: row.status, existingMatches: row.existingMatches, proposedNewProduct: row.proposedNewProduct,
    groupKey: row.groupKey ?? null, warnings: row.warnings || [], applied: row.applied || null,
    ...(row.aiSuggestion ? { aiSuggestion: { catalogProductId: row.aiSuggestion.catalogProductId ?? null, reason: boundedText(row.aiSuggestion.reason, 1000),
      specificDifferences: (Array.isArray(row.aiSuggestion.specificDifferences) ? row.aiSuggestion.specificDifferences : []).slice(0, 10).map((item) => boundedText(item, 500)) } } : {}) };
}
function publicWorkspace(job, rows) {
  return { hotelUid: job.hotelUid, jobId: job.jobId, revision: job.revision, status: job.status, supplierId: job.supplierId ?? null,
    nextCursor: job.nextCursor ?? null, scannedSuppliers: job.scannedSuppliers, catalogPool: { count: job.poolCount, complete: job.poolComplete === true, limit: MAX_CATALOG_POOL },
    createdGroups: job.createdGroups || {}, rows: rows.map(publicRow) };
}
async function workspaceRows(tx, db, hotelUid, jobId, job) {
  const docs = await Promise.all(job.rowIds.map((rowId) => tx.get(db.doc(`${jobPath(hotelUid, jobId)}/rows/${rowId}`))));
  if (docs.some((doc) => !doc.exists)) throw new HttpsError("failed-precondition", "Some catalog proposals are unavailable. Start a new preview.");
  return docs.map((doc, index) => {
    const row = doc.data();
    if (row.rowId !== job.rowIds[index] || !Number.isSafeInteger(row.reviewRevision) || row.reviewRevision < 1) throw new HttpsError("failed-precondition", "The catalog proposal references are inconsistent.");
    return row;
  });
}
async function loadMatchingPool(tx, db, hotelUid, jobId, job) {
  if (!Number.isSafeInteger(job.poolCount) || job.poolCount < 0 || job.poolCount > MAX_CATALOG_POOL || !/^[a-f0-9]{64}$/.test(job.poolFingerprint || "")) {
    throw new HttpsError("failed-precondition", "The frozen catalog matching pool is unavailable. Start a new preview.");
  }
  const snapshots = await tx.get(db.collection(`${jobPath(hotelUid, jobId)}/poolChunks`).orderBy(admin.firestore.FieldPath.documentId()).limit(6));
  if (snapshots.docs.length !== Math.ceil(job.poolCount / 100)) throw new HttpsError("failed-precondition", "The complete catalog matching pool is unavailable.");
  const pool = snapshots.docs.flatMap((doc, index) => {
    const chunk = doc.data();
    if (doc.id !== `p-${String(index + 1).padStart(6, "0")}` || !Array.isArray(chunk.products) || chunk.products.length < 1 || chunk.products.length > 100) {
      throw new HttpsError("failed-precondition", "The frozen catalog matching pool is inconsistent.");
    }
    return chunk.products;
  });
  if (pool.length !== job.poolCount || new Set(pool.map((row) => row.id)).size !== pool.length || digest(pool) !== job.poolFingerprint) {
    throw new HttpsError("failed-precondition", "The catalog matching pool changed after preview. Start a new review.");
  }
  for (const row of pool) {
    requireDocumentId(row.id, "Frozen catalog ID");
    if (!Number.isSafeInteger(row.revision) || row.revision < 0 || !activeCanonical(row)) throw new HttpsError("failed-precondition", "A frozen catalog candidate is invalid.");
  }
  return pool;
}
async function readHotelCatalogSyncWorkspaceHandler(request, services = {}) {
  const input = request.data || {};
  exact(input, ["hotelUid", "jobId", "requestId", "supplierId", "cursor", "limit"], "catalog synchronization preview");
  const hotelUid = requireDocumentId(input.hotelUid, "hotelUid"), db = services.firestore || admin.firestore();
  if (input.jobId != null) {
    if (Object.keys(input).some((key) => !["hotelUid", "jobId"].includes(key))) throw new HttpsError("invalid-argument", "Opening a saved review accepts only its hotel and job ID.");
    const jobId = requireDocumentId(input.jobId, "jobId");
    return db.runTransaction(async (tx) => {
      await authorizeSync(db, request, hotelUid, tx, services);
      const job = requireSyncJob(await tx.get(db.doc(jobPath(hotelUid, jobId))), request.auth.uid, services.now?.() ?? Date.now());
      return publicWorkspace(job, await workspaceRows(tx, db, hotelUid, jobId, job));
    });
  }
  const requestId = requireDocumentId(input.requestId, "requestId"), supplierId = input.supplierId == null ? null : requireDocumentId(input.supplierId, "supplierId");
  const cursor = input.cursor == null ? null : requireDocumentId(input.cursor, "cursor"), limit = input.limit ?? MAX_SYNC_ROWS;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SYNC_ROWS) throw new HttpsError("invalid-argument", "Preview between one and 25 supplier products.");
  const jobId = `s-${digest(request.auth?.uid, requestId).slice(0, 48)}`, ref = db.doc(jobPath(hotelUid, jobId)), fingerprint = digest(supplierId, cursor, limit);
  return db.runTransaction(async (tx) => {
    await authorizeSync(db, request, hotelUid, tx, services);
    const previous = await tx.get(ref);
    if (previous.exists) {
      const job = requireSyncJob(previous, request.auth.uid, services.now?.() ?? Date.now());
      if (job.previewFingerprint !== fingerprint) throw new HttpsError("already-exists", "This preview request was already used with different source choices.");
      return publicWorkspace(job, await workspaceRows(tx, db, hotelUid, jobId, job));
    }
    let query = db.collection(`hotels/${hotelUid}/supplierproducts`);
    if (supplierId) query = query.where("supplierId", "==", supplierId);
    query = query.orderBy(admin.firestore.FieldPath.documentId());
    if (cursor) query = query.startAfter(cursor);
    const [offers, catalogs] = await Promise.all([tx.get(query.select("name", "supplierId", "supplierSku", "supplierProductName", "purchaseUnit", "baseUnit", "baseUnitsPerPurchaseUnit", "purchaseOptions", "catalogProductId",
      "revision", "productPolicyVersion", "active", "archived", "archivedAt", "hasVariants", "brand", "description", "category", "subcategory", "allergens", "gtin", "internalSku", "inventoryTracked", "notes", "storageType").limit(MAX_SOURCE_SCAN + 1)),
      tx.get(db.collection(`hotels/${hotelUid}/catalogproducts`).orderBy(admin.firestore.FieldPath.documentId()).limit(MAX_CATALOG_POOL + 1))]);
    const pool = catalogs.docs.slice(0, MAX_CATALOG_POOL).filter((doc) => activeCanonical(doc.data())).map((doc) => ({ id: doc.id, revision: internals().currentRevision(doc.data()), ...physicalFacts(doc.data()) }));
    const sources = offers.docs.slice(0, MAX_SOURCE_SCAN), rows = [];
    let scannedSuppliers = 0, lastScanned = null;
    const supplierSnapshots = new Map();
    for (const doc of sources) {
      scannedSuppliers++; lastScanned = doc.id;
      const source = doc.data();
      if (source.active !== true || source.archived === true || source.archivedAt || !isUnlinked(source)) continue;
      let supplierReferenceValid = true;
      try {
        const sourceSupplierId = requireDocumentId(source.supplierId, "Supplier ID");
        if (!supplierSnapshots.has(sourceSupplierId)) supplierSnapshots.set(sourceSupplierId, await tx.get(db.doc(`hotels/${hotelUid}/suppliers/${sourceSupplierId}`)));
        const supplier = supplierSnapshots.get(sourceSupplierId);
        if (supplier.exists && (supplier.data().archived === true || supplier.data().archivedAt || supplier.data().active === false)) continue;
        if (!supplier.exists) supplierReferenceValid = false;
      } catch (error) {
        if (!(error instanceof HttpsError) || error.code !== "invalid-argument") throw error;
        supplierReferenceValid = false;
      }
      const facts = supplierFacts(source), suggestion = matching().getCatalogSyncSuggestions(facts, pool, { limit: 5 });
      const physicalReview = validateSyncCompatibility(source, { name: source.supplierProductName || source.name || "", baseUnit: source.baseUnit,
        active: true, productPolicyVersion: policy.PRODUCT_POLICY_VERSION });
      const sourceReviewed = activeCanonical(source) && supplierReferenceValid && physicalReview.allowed;
      const draft = sourceReviewed && suggestion.proposedCatalog ? policy.normalizeCatalogProduct({ name: suggestion.proposedCatalog.name,
        brand: suggestion.proposedCatalog?.brand || "", description: suggestion.proposedCatalog?.description || "", baseUnit: suggestion.proposedCatalog?.baseUnit || source.baseUnit,
        active: true, inventoryTracked: true, allergens: suggestion.proposedCatalog?.allergens || [], internalSku: "" }) : null;
      const proposedNewProduct = draft ? Object.fromEntries(Object.entries(draft).filter(([field]) => !["productPolicyVersion", "nameLower"].includes(field)))
        : { name: boundedText(source.supplierProductName || source.name, 200), brand: "", description: "", category: "", subcategory: "", gtin: "", internalSku: "", storageType: "", notes: "", imageUrl: "",
          baseUnit: "", active: true, inventoryTracked: true, allergens: [] };
      rows.push({ rowId: `r-${String(rows.length + 1).padStart(6, "0")}`, supplierProductId: doc.id,
        expectedSupplierRevision: internals().currentRevision(source), reviewRevision: 1, supplierProduct: facts, sourceFingerprint: digest(facts),
        status: sourceReviewed ? suggestion.status : "needs-unit-review", existingMatches: (sourceReviewed ? suggestion.candidates || [] : []).map((candidate) => {
          const catalog = pool.find((entry) => entry.id === candidate.catalogProductId);
          return { catalogProductId: catalog.id, expectedCatalogRevision: catalog.revision, product: physicalFacts(catalog), status: candidate.status,
            matchKind: candidate.matchKind, score: candidate.score, reasons: candidate.reasons || [], warnings: candidate.warnings || [], evidence: candidate.evidence || {} };
        }), proposedNewProduct, groupKey: sourceReviewed ? suggestion.groupKey ?? null : null,
        warnings: [...(suggestion.warnings || []), ...(!activeCanonical(source) ? ["Review this legacy offer's physical unit and package contract before synchronizing it."] : []),
          ...(!physicalReview.allowed ? physicalReview.reasons : []),
          ...(!supplierReferenceValid ? ["The supplier reference is missing or invalid. Edit the offer before synchronizing it."] : [])], applied: null });
      if (rows.length === limit) break;
    }
    const now = services.now?.() ?? Date.now(), job = { version: CATALOG_SYNC_VERSION, hotelUid, jobId, ownerUid: request.auth.uid, revision: 1,
      status: rows.length ? "review" : "completed", previewFingerprint: fingerprint, sourceFingerprint: digest(rows.map((row) => [row.supplierProductId, row.expectedSupplierRevision, row.sourceFingerprint]), pool),
      supplierId, cursor, nextCursor: scannedSuppliers < offers.docs.length ? lastScanned : null, scannedSuppliers,
      rowIds: rows.map((row) => row.rowId), poolCount: pool.length, poolFingerprint: digest(pool), poolComplete: catalogs.docs.length <= MAX_CATALOG_POOL, createdGroups: {},
      createdAt: stamp(), updatedAt: stamp(), expiresAtMillis: now + JOB_LIFETIME_MS };
    tx.create(ref, job);
    for (const row of rows) tx.create(db.doc(`${ref.path}/rows/${row.rowId}`), row);
    for (let offset = 0; offset < pool.length; offset += 100) tx.create(db.doc(`${ref.path}/poolChunks/p-${String(offset / 100 + 1).padStart(6, "0")}`), { products: pool.slice(offset, offset + 100) });
    return publicWorkspace(job, rows);
  });
}
function normalizeChoices(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > MAX_SYNC_ROWS) throw new HttpsError("invalid-argument", "Approve between one and 25 catalog proposals.");
  const choices = input.map((choice) => {
    exact(choice, ["rowId", "reviewRevision", "expectedSupplierRevision", "target", "acknowledged"], "catalog choice");
    if (choice.acknowledged !== true) throw new HttpsError("invalid-argument", "Every catalog choice needs an explicit interchangeability acknowledgement.");
    const target = choice.target;
    if (target?.kind === "existing") {
      exact(target, ["kind", "catalogProductId", "expectedCatalogRevision"], "existing catalog choice");
      return { rowId: requireDocumentId(choice.rowId, "rowId"), reviewRevision: revision(choice.reviewRevision), expectedSupplierRevision: revision(choice.expectedSupplierRevision), acknowledged: true,
        target: { kind: "existing", catalogProductId: requireDocumentId(target.catalogProductId, "Catalog product ID"), expectedCatalogRevision: revision(target.expectedCatalogRevision) } };
    }
    if (target?.kind !== "new") throw new HttpsError("invalid-argument", "Choose an existing catalog product or a reviewed new physical article.");
    exact(target, ["kind", "createGroupId", "product"], "new catalog choice");
    const { productPolicyVersion, ...product } = policy.normalizeCatalogProduct(target.product);
    return { rowId: requireDocumentId(choice.rowId, "rowId"), reviewRevision: revision(choice.reviewRevision), expectedSupplierRevision: revision(choice.expectedSupplierRevision), acknowledged: true,
      target: { kind: "new", createGroupId: requireDocumentId(target.createGroupId, "Creation group ID"), product } };
  });
  if (new Set(choices.map((choice) => choice.rowId)).size !== choices.length) throw new HttpsError("invalid-argument", "Catalog choices cannot repeat a supplier product.");
  return choices;
}
async function applyHotelCatalogSyncHandler(request, services = {}) {
  const input = request.data || {};
  exact(input, ["hotelUid", "jobId", "requestId", "choices"], "catalog synchronization application");
  const hotelUid = requireDocumentId(input.hotelUid, "hotelUid"), jobId = requireDocumentId(input.jobId, "jobId"), requestId = requireDocumentId(input.requestId, "requestId");
  const choices = normalizeChoices(input.choices), db = services.firestore || admin.firestore(), fingerprint = digest(jobId, choices);
  const operationId = `s-${digest(request.auth?.uid, requestId).slice(0, 48)}`, operationRef = db.doc(`hotels/${hotelUid}/catalogSyncOperations/${operationId}`);
  return db.runTransaction(async (tx) => {
    await authorizeSync(db, request, hotelUid, tx, services, true);
    const jobRef = db.doc(jobPath(hotelUid, jobId));
    const prior = await tx.get(operationRef);
    if (prior.exists) {
      if (prior.data().actorUid !== request.auth.uid || prior.data().jobId !== jobId || prior.data().fingerprint !== fingerprint) throw new HttpsError("already-exists", "This catalog application request was used with different choices.");
      if (prior.data().requiresCatalogCreate) await requireHotelPermission(db, request, hotelUid, "catalogproducts", "create", tx, services.auth);
      return prior.data().result;
    }
    try {
      const job = requireSyncJob(await tx.get(jobRef), request.auth.uid, services.now?.() ?? Date.now());
      if (job.status !== "review") throw new HttpsError("failed-precondition", "This catalog review is complete. Reopen its original application receipt or start a new preview.");
      const allRows = await workspaceRows(tx, db, hotelUid, jobId, job), byId = new Map(allRows.map((row) => [row.rowId, row]));
      const groups = new Map(), existingTargets = new Map(), sourceRows = [], createdGroups = { ...(job.createdGroups || {}) };
      for (const choice of choices) {
        const row = byId.get(choice.rowId);
        if (!row) throw new HttpsError("not-found", "A catalog proposal does not belong to this review.");
        if (row.applied) throw new HttpsError("failed-precondition", "This proposal was already applied. Recover its original application receipt.");
        if (row.reviewRevision !== choice.reviewRevision || row.expectedSupplierRevision !== choice.expectedSupplierRevision) throw new HttpsError("aborted", "The reviewed proposal changed. Refresh before approving it.");
        const sourceRef = db.doc(`hotels/${hotelUid}/supplierproducts/${row.supplierProductId}`), sourceSnapshot = await tx.get(sourceRef);
        if (!sourceSnapshot.exists) throw new HttpsError("not-found", "A supplier product was removed from this hotel.");
        const source = sourceSnapshot.data();
        if (internals().currentRevision(source) !== choice.expectedSupplierRevision || digest(supplierFacts(source)) !== row.sourceFingerprint) throw new HttpsError("aborted", "The supplier product changed after preview. Start a fresh review.");
        if (!isUnlinked(source)) throw new HttpsError("failed-precondition", "An existing catalog link cannot be replaced by synchronization.");
        const supplier = await tx.get(db.doc(`hotels/${hotelUid}/suppliers/${requireDocumentId(source.supplierId, "Supplier ID")}`));
        if (!supplier.exists || supplier.data().archived === true || supplier.data().archivedAt || supplier.data().active === false) throw new HttpsError("failed-precondition", "The source supplier is no longer active in this hotel.");
        let catalogProductId;
        if (choice.target.kind === "existing") {
          catalogProductId = choice.target.catalogProductId;
          const snapshot = await tx.get(db.doc(`hotels/${hotelUid}/catalogproducts/${catalogProductId}`));
          if (!snapshot.exists) throw new HttpsError("not-found", "The selected catalog product does not exist in this hotel.");
          if (internals().currentRevision(snapshot.data()) !== choice.target.expectedCatalogRevision) throw new HttpsError("aborted", "The selected catalog product changed. Review its latest identity.");
          existingTargets.set(catalogProductId, snapshot.data());
        } else {
          const groupId = choice.target.createGroupId, productFingerprint = digest(choice.target.product), saved = createdGroups[groupId];
          if (saved && saved.productFingerprint !== productFingerprint) throw new HttpsError("failed-precondition", "A shared creation group must retain the same reviewed catalog details.");
          if (!groups.has(groupId)) {
            if (saved) {
              const snapshot = await tx.get(db.doc(`hotels/${hotelUid}/catalogproducts/${saved.catalogProductId}`));
              if (!snapshot.exists || internals().currentRevision(snapshot.data()) !== saved.revision) throw new HttpsError("aborted", "The catalog article created for this group changed. Select its current reviewed identity instead.");
              groups.set(groupId, { ...saved, product: snapshot.data(), sourceProducts: [], created: false });
            } else groups.set(groupId, { catalogProductId: `c-${digest(hotelUid, jobId, groupId).slice(0, 40)}`, productFingerprint,
              product: { ...choice.target.product, productPolicyVersion: policy.PRODUCT_POLICY_VERSION }, sourceProducts: [], created: true });
          }
          const group = groups.get(groupId);
          if (group.productFingerprint !== productFingerprint) throw new HttpsError("failed-precondition", "Equivalent offers sharing a creation group must use identical reviewed catalog details.");
          group.sourceProducts.push(source); catalogProductId = group.catalogProductId;
        }
        sourceRows.push({ row, choice, sourceRef, source, catalogProductId });
      }
      const requiresCatalogCreate = [...groups.values()].some((group) => group.created);
      if (requiresCatalogCreate) await requireHotelPermission(db, request, hotelUid, "catalogproducts", "create", tx, services.auth);
      const linkedContexts = new Map();
      for (const catalogProductId of new Set(sourceRows.map((row) => row.catalogProductId))) {
        const linked = await tx.get(db.collection(`hotels/${hotelUid}/supplierproducts`).where("catalogProductId", "==", catalogProductId)
          .select("supplierProductName", "brand", "description", "notes", "storageType", "baseUnit", "allergens", "productPolicyVersion").limit(MAX_SYNC_ROWS + 1));
        if (linked.docs.length > MAX_SYNC_ROWS) throw new HttpsError("failed-precondition", "This catalog article has more than 25 linked offers. Review a bounded, paged identity reconciliation before adding another link.");
        linkedContexts.set(catalogProductId, linked.docs.map((doc) => doc.data()));
      }
      const allocation = require("./catalogSkuSettings"), allocationContext = allocation.createAllocationContext(), plannedSkus = new Map(), catalogPlans = [];
      for (const group of groups.values()) {
        for (const source of group.sourceProducts) {
          const compatible = validateSyncCompatibility(source, group.product);
          if (!compatible.allowed) throw new HttpsError("failed-precondition", compatible.reasons.join(" "));
          for (const other of group.sourceProducts) {
            const pair = matching().validateCatalogSyncSelection(source, { ...other, name: other.supplierProductName }, {
              allowDifferentBrands: !matching().extractCatalogPhysicalIdentity(group.product).brand });
            if (!pair.allowed) throw new HttpsError("failed-precondition", "Offers in a shared new article are not established as interchangeable goods. Keep them separate.");
          }
        }
        if (group.created) {
          const { productPolicyVersion, ...product } = group.product;
          const plan = await internals().prepareProduct(tx, db, hotelUid, "catalogproducts", group.catalogProductId, "create", 0, product, plannedSkus, undefined, services, allocationContext);
          catalogPlans.push(plan); group.revision = 1;
        }
      }
      const packageBudget = { versions: 0 }, catalogDefinitions = new Map();
      for (const sourceRow of sourceRows) {
        const target = existingTargets.get(sourceRow.catalogProductId) || [...groups.values()].find((group) => group.catalogProductId === sourceRow.catalogProductId)?.product;
        const compatible = validateSyncCompatibility(sourceRow.source, target);
        if (!compatible.allowed) throw new HttpsError("failed-precondition", compatible.reasons.join(" "));
        await validateApprovedPackages(tx, db, hotelUid, sourceRow, target, packageBudget);
        const requiredBrand = matching().extractCatalogPhysicalIdentity(target).brand;
        catalogDefinitions.set(sourceRow.catalogProductId, { catalogProductId: sourceRow.catalogProductId, name: boundedText(target.name, 200), baseUnit: target.baseUnit,
          requiredBrand: requiredBrand || null, supplierBrandVariationAllowed: !requiredBrand });
        const peers = [...sourceRows.filter((other) => other !== sourceRow && other.catalogProductId === sourceRow.catalogProductId).map((other) => other.source),
          ...(linkedContexts.get(sourceRow.catalogProductId) || [])];
        for (const peer of peers) {
          const verdict = matching().validateCatalogSyncSelection(sourceRow.source, { ...peer, name: peer.supplierProductName, active: true, archived: false }, { allowDifferentBrands: !requiredBrand });
          if (!verdict.allowed) throw new HttpsError("failed-precondition", "This offer conflicts with the physical identity of another offer assigned to this article. Review the known brand, quality, allergens and item size; keep non-interchangeable goods separate.");
        }
      }
      const now = stamp(), outcomes = sourceRows.map(({ row, source, catalogProductId, choice }) => ({ rowId: row.rowId, supplierProductId: row.supplierProductId,
        catalogProductId, supplierRevision: internals().currentRevision(source) + 1,
        status: choice.target.kind === "new" && groups.get(choice.target.createGroupId).created ? "created-and-linked" : "linked" }));
      const createdCatalogs = catalogPlans.map((plan) => {
        const written = internals().writeProduct(tx, plan, "catalogproducts", request.auth.uid);
        return { catalogProductId: written.productId, revision: written.revision, internalSku: plan.next.internalSku || null };
      });
      allocation.writeAllocation(tx, allocationContext, request.auth.uid);
      for (let index = 0; index < sourceRows.length; index++) {
        const { row, sourceRef } = sourceRows[index], outcome = outcomes[index];
        // Linking physical identity never edits supplier financial agreements,
        // confirmations, images, packages or historical operational snapshots.
        tx.update(sourceRef, { catalogProductId: outcome.catalogProductId, revision: outcome.supplierRevision, updatedAt: now, updatedBy: request.auth.uid });
        const next = { ...row, applied: outcome, appliedAt: now, appliedBy: request.auth.uid }; byId.set(row.rowId, next);
        tx.set(db.doc(`${jobRef.path}/rows/${row.rowId}`), next);
      }
      for (const [groupId, group] of groups) createdGroups[groupId] = { catalogProductId: group.catalogProductId, revision: group.revision, productFingerprint: group.productFingerprint };
      const completed = [...byId.values()].every((row) => Boolean(row.applied)), result = { hotelUid, jobId, requestId, outcomes, createdCatalogs, completed };
      tx.set(jobRef, { ...job, revision: job.revision + 1, status: completed ? "completed" : "review", createdGroups, updatedAt: now });
      tx.create(operationRef, { version: CATALOG_SYNC_VERSION, actorUid: request.auth.uid, jobId, fingerprint, choices, requiresCatalogCreate, result, createdAt: now });
      tx.create(db.doc(`hotels/${hotelUid}/catalogSyncAudit/${operationId}`), { actorUid: request.auth.uid, jobId, requestId, sourceFingerprint: job.sourceFingerprint,
        outcomes, createdCatalogs, catalogDefinitions: [...catalogDefinitions.values()], createdAt: now });
      return result;
    } catch (error) {
      if (error instanceof HttpsError) throw new HttpsError(error.code, error.message, { ...error.details, catalogSyncRequestUncommitted: true });
      throw error;
    }
  });
}
const options = { region: "us-central1", cors: true, timeoutSeconds: 120, memory: "512MiB", concurrency: 4, maxInstances: 5 };
const readHotelCatalogSyncWorkspace = onCall(options, gated(readHotelCatalogSyncWorkspaceHandler));
const applyHotelCatalogSync = onCall(options, gated(applyHotelCatalogSyncHandler));
module.exports = { CATALOG_SYNC_VERSION, MAX_SYNC_ROWS, MAX_CATALOG_POOL, MAX_SOURCE_SCAN, readHotelCatalogSyncWorkspaceHandler, applyHotelCatalogSyncHandler,
  readHotelCatalogSyncWorkspace, applyHotelCatalogSync, catalogSyncInternals: { authorizeSync, requireSyncJob, publicRow, publicWorkspace,
    validateSyncCompatibility, supplierFacts, physicalFacts, jobPath, workspaceRows, loadMatchingPool } };
