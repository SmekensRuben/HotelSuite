const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { admin } = require("./config");
const { requireHotelPermission } = require("./authorization");
const { requireDocumentId } = require("./subscriptions");
const { digest, text, revision } = require("./validation");
const { gated, requireSaasRollout } = require("./saasRollout");
const policy = require("./productPolicy");
const { supplierProductInternals } = require("./products");
const { loadSupplierAiConfiguration } = require("./supplierAiPolicy");

const AI_PROPOSAL_POLICY_VERSION = 1;
const MAX_AI_ROWS = 1000;
const MAX_CONFIRM_ROWS = 25;
const RAW_TEXT_FIELDS = ["supplierSku", "supplierProductName", "currency", "pricingModel", "purchaseUnit", "baseUnit", "priceBasis", "gtin", "priceValidFrom", "priceValidUntil"];
const RAW_NUMBER_FIELDS = ["pricePerBaseUnit", "pricePerPurchaseUnit", "baseUnitsPerPurchaseUnit", "vatRate"];
const RAW_FIELDS = [...RAW_TEXT_FIELDS, ...RAW_NUMBER_FIELDS];
const PRODUCT_FIELDS = ["supplierId", ...RAW_FIELDS, "catalogProductId", "active", "purchaseOptions"];
const PATCH_FIELDS = PRODUCT_FIELDS.filter((field) => field !== "supplierId");
const FIELD_LIMITS = { supplierSku: 150, supplierProductName: 200, currency: 3, pricingModel: 30, purchaseUnit: 100, baseUnit: 10,
  priceBasis: 10, gtin: 14, priceValidFrom: 10, priceValidUntil: 10 };
const stamp = () => admin.firestore.FieldValue.serverTimestamp();
const jobPath = (hotelUid, jobId) => `hotels/${hotelUid}/supplierAiImportJobs/${jobId}`;
const bad = (message) => { throw new HttpsError("invalid-argument", message); };
function object(value, name, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value) || (fields && Object.keys(value).some((key) => !fields.includes(key)))) bad(`Unsupported ${name} field.`);
}

// All source fields are nullable, rather than implicitly zero/EUR/net. The
// strict provider schema is merely a transport contract, never write authority.
const AI_SUPPLIER_SCHEMA = { type: "object", additionalProperties: false, required: ["rows"], properties: {
  rows: { type: "array", maxItems: MAX_AI_ROWS, items: { type: "object", additionalProperties: false,
    required: [...RAW_FIELDS, "sourceAnchors"], properties: {
      ...Object.fromEntries(RAW_TEXT_FIELDS.map((field) => [field, { type: ["string", "null"] }])),
      ...Object.fromEntries(RAW_NUMBER_FIELDS.map((field) => [field, { type: ["number", "null"] }])),
      sourceAnchors: { type: "array", maxItems: 8, items: { type: "object", additionalProperties: false, required: ["sourceId", "quote"],
        properties: { sourceId: { type: "string" }, quote: { type: "string" } } } },
    } } },
} };

function sourceQuoteMatch(source, quote) {
  if (typeof source.text !== "string" || !quote) return null;
  const literalIndex = source.text.indexOf(quote);
  if (literalIndex !== -1) return { quote: source.text.slice(literalIndex, literalIndex + quote.length), verificationMethod: "exact-text" };
  // CSV/XLSX cells are deliberately JSON-encoded by our parser. Match decoded
  // cell text, not the escaping of that transport representation. Only Unicode
  // canonical equivalence and whitespace may change: never repair numbers,
  // punctuation, case, units, ordering or a paraphrase on the model's behalf.
  if (!/^(?:csv-(?:row-\d+|header)|xlsx-sheet-\d+-row-\d+)$/.test(source.sourceId)) return null;
  let cells;
  try { cells = JSON.parse(source.text); } catch { return null; }
  if (!Array.isArray(cells) || cells.length > 128 || cells.some((cell) => cell !== null && !["string", "number", "boolean"].includes(typeof cell))) return null;
  const normalize = (value) => value.normalize("NFC").replace(/\s+/gu, " ").trim();
  const normalizedQuote = normalize(quote);
  for (const cell of cells) {
    const value = String(cell ?? ""), index = value.indexOf(quote);
    if (index !== -1) return { quote: value.slice(index, index + quote.length), verificationMethod: "decoded-cell" };
    const normalizedCell = normalize(value), normalizedIndex = normalizedCell.indexOf(normalizedQuote);
    if (normalizedQuote && normalizedIndex !== -1) return { quote: normalizedCell.slice(normalizedIndex, normalizedIndex + normalizedQuote.length), verificationMethod: "normalized-whitespace" };
  }
  return null;
}

const evidenceIssue = (code, message) => ({ field: "sourceAnchors", code, message: `${message} Exclude this row, or correct the source and start a new import; editing product fields cannot verify this evidence.`, severity: "error" });
function validateRawSupplierAiRows(payload, { sourceUnits = [] } = {}) {
  object(payload, "AI response", ["rows"]);
  if (!Array.isArray(payload.rows) || payload.rows.length > MAX_AI_ROWS) bad(`An AI response must contain at most ${MAX_AI_ROWS} rows.`);
  const sources = new Map(sourceUnits.map((unit) => [unit.sourceId, unit]));
  return payload.rows.map((input, index) => {
    object(input, `AI row ${index + 1}`, [...RAW_FIELDS, "sourceAnchors"]);
    const result = {};
    for (const field of RAW_FIELDS) {
      if (!Object.hasOwn(input, field)) bad(`AI row ${index + 1} is missing the nullable ${field} field.`);
      const value = input[field];
      if (value !== null && (RAW_TEXT_FIELDS.includes(field) ? typeof value !== "string" || value.length > FIELD_LIMITS[field] : typeof value !== "number" || !Number.isFinite(value))) {
        bad(`AI row ${index + 1} has an invalid ${field} type or size.`);
      }
      result[field] = value;
    }
    if (!Array.isArray(input.sourceAnchors) || input.sourceAnchors.length > 8) bad(`AI row ${index + 1} supports at most eight source anchors.`);
    result.sourceEvidenceIssues = [];
    if (!input.sourceAnchors.length) result.sourceEvidenceIssues.push(evidenceIssue("evidence-missing-anchors", "The AI did not provide a product source reference."));
    result.sourceAnchors = input.sourceAnchors.map((anchor) => {
      object(anchor, "source anchor", ["sourceId", "quote"]);
      const sourceId = text(anchor.sourceId, "Source ID", 160, true), quote = text(anchor.quote, "Source quote", 1000);
      const source = sources.get(sourceId);
      if (!source) {
        result.sourceEvidenceIssues.push(evidenceIssue("evidence-unknown-source", "The AI reference does not identify a source row supplied to this import."));
        return { sourceId, quote, anchor: sourceId, verified: false, evidenceKind: "unverified-reference", sourceExcerpt: null, excerptTruncated: false };
      }
      const pdfPage = source.kind === "pdf-page" || source.method === "vision" || source.anchor?.type === "pdf-page";
      const matched = !pdfPage && sourceQuoteMatch(source, quote), verified = Boolean(matched);
      if (!quote || (!verified && !pdfPage)) result.sourceEvidenceIssues.push(evidenceIssue("evidence-quote-absent", "The AI reference quote cannot be verified against its source row."));
      return { sourceId, quote: matched ? matched.quote : quote,
        anchor: typeof source.anchor === "string" ? source.anchor.slice(0, 250) : JSON.stringify(source.anchor ?? sourceId).slice(0, 250), verified,
        verificationMethod: matched?.verificationMethod ?? null,
        evidenceKind: pdfPage ? "visual-page" : verified ? "extracted-text" : "unverified-reference",
        sourceExcerpt: pdfPage || typeof source.text !== "string" ? null : source.text.slice(0, 1000),
        excerptTruncated: !pdfPage && typeof source.text === "string" && source.text.length > 1000 };
    });
    if (result.sourceAnchors.length && !result.sourceAnchors.some((anchor) => sources.has(anchor.sourceId) && sources.get(anchor.sourceId).contextOnly !== true)) {
      result.sourceEvidenceIssues.push(evidenceIssue("evidence-context-only", "The AI did not identify a product source row; repeated header context alone cannot establish a product."));
    }
    return result;
  });
}

function productView(product) {
  if (!product) return null;
  return Object.fromEntries(PRODUCT_FIELDS.map((field) => [field, product[field] === undefined ? null : product[field]]));
}
function emptyProduct(supplierId) {
  return { supplierId, supplierSku: null, supplierProductName: null, currency: null, pricingModel: null,
    pricePerBaseUnit: null, pricePerPurchaseUnit: null, purchaseUnit: null, baseUnit: null, baseUnitsPerPurchaseUnit: null,
    catalogProductId: null, active: false, priceBasis: "unknown", vatRate: null, purchaseOptions: [], gtin: null,
    priceValidFrom: null, priceValidUntil: null };
}
const issue = (field, code, message, severity = "error") => ({ field, code, message, severity });
const hasErrors = (issues) => issues.some((entry) => entry.severity === "error");
function validationIssues(product) {
  const issues = [];
  for (const field of ["supplierSku", "supplierProductName", "currency", "pricingModel", "purchaseUnit", "baseUnit", "baseUnitsPerPurchaseUnit"]) {
    if (product[field] === null || product[field] === undefined || product[field] === "") issues.push(issue(field, "missing", `${field} must be supplied or explicitly corrected before import.`));
  }
  // Validate fields independently to report all useful corrections in one pass.
  const baseline = { ...emptyProduct("supplier"), supplierSku: "SKU", supplierProductName: "Product", currency: "EUR",
    pricingModel: "Per Purchase Unit", purchaseUnit: "Case", baseUnit: "each", baseUnitsPerPurchaseUnit: 1 };
  for (const field of PATCH_FIELDS) {
    if (issues.some((entry) => entry.field === field)) continue;
    try { policy.normalizeSupplierProduct({ ...baseline, [field]: product[field], ...(field === "priceBasis" && product[field] === "gross" ? { vatRate: product.vatRate } : {}) }); }
    catch (error) { issues.push(issue(field, "invalid", error.message)); }
  }
  if (!hasErrors(issues)) {
    try { policy.normalizeSupplierProduct(product); }
    catch (error) { issues.push(issue("contract", "invalid", error.message)); }
  }
  if (product.priceBasis === "unknown" || product.priceBasis === null) issues.push(issue("priceBasis", "unknown", "The source does not establish net or gross pricing; net cost remains unavailable.", "warning"));
  const authoritativePrice = product.pricingModel === "Per Base Unit" ? product.pricePerBaseUnit : product.pricePerPurchaseUnit;
  if (authoritativePrice === null || authoritativePrice === undefined) issues.push(issue("price", "unknown", "The purchase price is unknown; this offer cannot be ordered until it is supplied.", "warning"));
  if (!product.catalogProductId) issues.push(issue("catalogProductId", "unlinked", "No catalog product was guessed. Choose a link for inventory conversion, or explicitly keep this offer unlinked.", "warning"));
  return issues;
}

function buildSupplierAiCandidate({ hotelUid, jobId, supplierId, rowIndex, raw, previous = null, productId = null, userPatch = {}, duplicate = false, ambiguous = false, reviewRevision = 1 }) {
  const inputPatch = Object.fromEntries(RAW_FIELDS.filter((field) => raw[field] !== null && raw[field] !== undefined).map((field) => [field, raw[field]]));
  const before = productView(previous);
  // Omitted AI values never clear an existing package, GTIN, price contract or
  // catalog link. Only a separately authenticated human correction may clear.
  const candidate = { ...emptyProduct(supplierId), ...(before || {}), ...inputPatch, ...userPatch, supplierId };
  if (previous && candidate.purchaseOptions === null) candidate.purchaseOptions = previous.purchaseOptions ?? [];
  if (previous && Array.isArray(candidate.purchaseOptions)) {
    const priorOptions = new Map((previous.purchaseOptions || []).map((option) => [option.id, option]));
    candidate.purchaseOptions = candidate.purchaseOptions.map((option) => {
      if (!option || typeof option !== "object" || Array.isArray(option) || Object.hasOwn(option, "gtin")) return option;
      return { ...option, gtin: priorOptions.get(option.id)?.gtin ?? null };
    });
  }
  const sourceEvidenceIssues = raw.sourceEvidenceIssues || [];
  const issues = [...validationIssues(candidate), ...sourceEvidenceIssues];
  if (duplicate) issues.push(issue("supplierSku", "duplicate-source-sku", "This import contains the same supplier SKU more than once. Correct distinct SKUs only when supported by the source, or remove duplicate rows from the source and re-import."));
  if (ambiguous) issues.push(issue("supplierSku", "ambiguous-existing-sku", "More than one existing offer has this exact supplier and SKU. Repair the duplicate identities before importing."));
  if (previous) {
    for (const field of ["supplierSku", "baseUnit", ...(previous.catalogProductId ? ["catalogProductId"] : [])]) {
      if (candidate[field] !== previous[field]) issues.push(issue(field, "protected-identity", `The existing offer's ${field} cannot be changed by AI import. Use the original identity or create a distinct offer outside this import.`));
    }
    if (previous.archived === true && candidate.active) issues.push(issue("active", "archived", "An archived supplier offer cannot be reactivated."));
    if (previous.hasVariants === true && !candidate.purchaseOptions?.length) issues.push(issue("purchaseOptions", "legacy-variants", "Legacy package variants need a reviewed purchase-option configuration before import."));
  } else if (candidate.active !== true) {
    issues.push(issue("active", "inactive-new-offer", "New AI-imported offers start inactive. Enable this offer explicitly if its purchasing terms are ready.", "warning"));
  }
  let normalized = candidate;
  if (!hasErrors(issues)) normalized = policy.normalizeSupplierProduct(candidate);
  const canonicalBefore = before && (() => { try { return policy.normalizeSupplierProduct(before); } catch { return before; } })();
  const changes = PRODUCT_FIELDS.filter((field) => JSON.stringify(canonicalBefore?.[field] ?? null) !== JSON.stringify(normalized[field] ?? null))
    .map((field) => ({ field, before: canonicalBefore?.[field] ?? null, after: normalized[field] ?? null }));
  return { rowId: `r-${String(rowIndex + 1).padStart(6, "0")}`, rowIndex, policyVersion: AI_PROPOSAL_POLICY_VERSION,
    category: hasErrors(issues) ? "blocked" : previous ? changes.length ? "changed" : "unchanged" : "new",
    productId: productId || `p-${digest(hotelUid, jobId, rowIndex).slice(0, 40)}`,
    expectedRevision: supplierProductInternals.currentRevision(previous), reviewRevision,
    product: productView(normalized), previousProduct: before ? { ...before, productPolicyVersion: previous.productPolicyVersion ?? null } : null, inputPatch, userPatch,
    issues, changes, sourceAnchors: raw.sourceAnchors || [], sourceEvidenceIssues, duplicate, ambiguous, committed: null };
}

async function matchesForSku(reader, db, hotelUid, supplierId, sku) {
  if (typeof sku !== "string" || !sku.trim()) return [];
  const query = db.collection(`hotels/${hotelUid}/supplierproducts`).where("supplierId", "==", supplierId).where("supplierSku", "==", sku.trim()).limit(2);
  return (await reader(query)).docs;
}
async function validateReferences(reader, db, hotelUid, candidate) {
  const supplier = await reader(db.doc(`hotels/${hotelUid}/suppliers/${candidate.product.supplierId}`));
  if (!supplier.exists) candidate.issues.push(issue("supplierId", "missing-supplier", "The selected supplier does not exist in this hotel."));
  else if (candidate.product.active && (supplier.data().active === false || supplier.data().archived === true)) candidate.issues.push(issue("active", "inactive-supplier", "An active offer requires an active supplier."));
  if (candidate.product.catalogProductId) {
    let catalog;
    try { catalog = await reader(db.doc(`hotels/${hotelUid}/catalogproducts/${requireDocumentId(candidate.product.catalogProductId, "Catalog product ID")}`)); }
    catch (error) { candidate.issues.push(issue("catalogProductId", "invalid", error.message)); }
    if (catalog && !catalog.exists) candidate.issues.push(issue("catalogProductId", "missing-catalog", "The chosen catalog product does not exist in this hotel."));
    if (catalog?.exists) {
      if (candidate.product.active && (catalog.data().active === false || catalog.data().archived === true)) candidate.issues.push(issue("catalogProductId", "inactive-catalog", "An active offer requires an active catalog product."));
      try {
        for (const option of [candidate.product, ...(candidate.product.purchaseOptions || [])]) policy.convertQuantity(option.baseUnitsPerPurchaseUnit, candidate.product.baseUnit, catalog.data().baseUnit);
      } catch (error) { candidate.issues.push(issue("baseUnitsPerPurchaseUnit", "catalog-conversion", error.message)); }
    }
  }
  if (hasErrors(candidate.issues)) candidate.category = "blocked";
  return candidate;
}

const RECONCILIATION_CATEGORIES = ["new", "changed", "unchanged", "blocked"];
const sourceFingerprint = (source) => digest(source?.path ?? null, source?.generation ?? null, source?.sha256 ?? null,
  source?.size ?? null, source?.contentType ?? null);
function requireReconciliationLease(snapshot, leaseId, supplierId) {
  if (!snapshot.exists || snapshot.data().status !== "processing" || snapshot.data().leaseId !== leaseId || snapshot.data().supplierId !== supplierId) {
    throw new HttpsError("aborted", "The AI import processing lease is no longer current.");
  }
  return snapshot.data();
}
function validateReconciliationState(state, fingerprint, totalRows, source) {
  if (!state || state.fingerprint !== fingerprint || state.totalRows !== totalRows || state.sourceFingerprint !== sourceFingerprint(source)) {
    throw new HttpsError("failed-precondition", "The source or proposals changed during AI import reconciliation. Start a new import.");
  }
  if (!Number.isSafeInteger(state.nextRowIndex) || state.nextRowIndex < 0 || state.nextRowIndex > totalRows || !state.counts
    || RECONCILIATION_CATEGORIES.some((category) => !Number.isSafeInteger(state.counts[category]) || state.counts[category] < 0)
    || Object.keys(state.counts).some((category) => !RECONCILIATION_CATEGORIES.includes(category))
    || RECONCILIATION_CATEGORIES.reduce((count, category) => count + state.counts[category], 0) !== state.nextRowIndex) {
    throw new HttpsError("failed-precondition", "The AI import reconciliation progress is invalid. Start a new import.");
  }
  return state;
}
async function reconcileSupplierAiRows({ db, hotelUid, supplierId, jobId, rows, leaseId, maxRows = 100, shouldContinue = () => true }) {
  hotelUid = requireDocumentId(hotelUid, "hotelUid"); supplierId = requireDocumentId(supplierId, "supplierId"); jobId = requireDocumentId(jobId, "jobId");
  leaseId = requireDocumentId(leaseId, "Processing lease ID");
  if (!Array.isArray(rows) || rows.length > MAX_AI_ROWS) bad(`Review supports at most ${MAX_AI_ROWS} products.`);
  if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 100 || typeof shouldContinue !== "function") bad("Reconcile between one and 100 rows per bounded worker pass.");
  const fingerprint = digest(rows), jobRef = db.doc(jobPath(hotelUid, jobId));
  let state = await db.runTransaction(async (tx) => {
    const job = requireReconciliationLease(await tx.get(jobRef), leaseId, supplierId);
    if (job.reconciliation) return validateReconciliationState(job.reconciliation, fingerprint, rows.length, job.source);
    const initial = { fingerprint, sourceFingerprint: sourceFingerprint(job.source), totalRows: rows.length, nextRowIndex: 0,
      counts: { new: 0, changed: 0, unchanged: 0, blocked: 0 } };
    tx.set(jobRef, { ...job, reconciliation: initial, updatedAt: stamp() });
    return initial;
  });
  const frequencies = new Map();
  for (const row of rows) if (typeof row.supplierSku === "string" && row.supplierSku.trim()) frequencies.set(row.supplierSku.trim(), (frequencies.get(row.supplierSku.trim()) || 0) + 1);
  // A job only becomes reviewable after every separate candidate has persisted.
  // Every immutable candidate and its cursor/count receipt commit together.
  // Later invocations resume from confirmed paid results instead of rewriting
  // earlier rows or spending another provider call to rebuild them.
  for (let processed = 0; processed < maxRows && state.nextRowIndex < rows.length; processed++) {
    if (!shouldContinue()) break;
    const index = state.nextRowIndex;
    state = await db.runTransaction(async (tx) => {
      const job = requireReconciliationLease(await tx.get(jobRef), leaseId, supplierId);
      const current = validateReconciliationState(job.reconciliation, fingerprint, rows.length, job.source);
      if (current.nextRowIndex > index) return current;
      if (current.nextRowIndex !== index) throw new HttpsError("aborted", "The AI import reconciliation cursor changed.");
      const rowRef = db.doc(`${jobRef.path}/rows/r-${String(index + 1).padStart(6, "0")}`), prior = await tx.get(rowRef);
      const sourceRowFingerprint = digest(rows[index]);
      let result;
      if (prior.exists) {
        result = prior.data();
        if (result.reconciliationFingerprint !== fingerprint || result.sourceRowFingerprint !== sourceRowFingerprint
          || result.rowIndex !== index || result.reviewRevision !== 1 || result.committed
          || !RECONCILIATION_CATEGORIES.includes(result.category)) {
          throw new HttpsError("failed-precondition", "An existing AI review row does not match this source reconciliation. Start a new import.");
        }
      } else {
        const matches = await matchesForSku((ref) => tx.get(ref), db, hotelUid, supplierId, rows[index].supplierSku);
        result = buildSupplierAiCandidate({ hotelUid, jobId, supplierId, rowIndex: index, raw: rows[index],
          previous: matches.length === 1 ? matches[0].data() : null, productId: matches.length === 1 ? matches[0].id : null,
          duplicate: frequencies.get(rows[index].supplierSku?.trim()) > 1, ambiguous: matches.length > 1 });
        await validateReferences((ref) => tx.get(ref), db, hotelUid, result);
        tx.create(rowRef, { ...result, reconciliationFingerprint: fingerprint, sourceRowFingerprint, createdAt: stamp(), updatedAt: stamp() });
      }
      const next = { ...current, nextRowIndex: index + 1, counts: { ...current.counts, [result.category]: current.counts[result.category] + 1 } };
      tx.set(jobRef, { ...job, reconciliation: next, updatedAt: stamp() });
      return next;
    });
  }
  return { counts: state.counts, totalRows: rows.length, complete: state.nextRowIndex === rows.length, nextRowIndex: state.nextRowIndex };
}

function requireReviewJob(snapshot, now = Date.now(), actorUid) {
  if (!snapshot.exists) throw new HttpsError("not-found", "AI import not found in this hotel.");
  const job = snapshot.data();
  if (!actorUid || job.ownerUid !== actorUid) throw new HttpsError("permission-denied", "Only the current import owner may review or confirm this private draft.");
  if (job.status !== "review") throw new HttpsError("failed-precondition", "This AI import is not ready for product review.");
  const expiry = job.expiresAt?.toMillis?.() ?? job.expiresAtMillis;
  if (!Number.isFinite(expiry) || expiry <= now) throw new HttpsError("failed-precondition", "This AI import has expired. Start a new import.");
  if (job.configPolicyVersion !== AI_PROPOSAL_POLICY_VERSION) throw new HttpsError("failed-precondition", "This AI import policy needs review before confirmation.");
  if (!Number.isSafeInteger(job.configVersion) || job.configVersion < 0) throw new HttpsError("failed-precondition", "This AI import has an invalid source configuration revision.");
  if (!Number.isSafeInteger(job.totalRows) || job.totalRows < 1 || job.totalRows > MAX_AI_ROWS) {
    throw new HttpsError("failed-precondition", "This AI import has an unknown or invalid total row count. Start a new import.");
  }
  const categories = ["new", "changed", "unchanged", "blocked"];
  if (!job.counts || typeof job.counts !== "object" || Array.isArray(job.counts)
    || Object.keys(job.counts).some((category) => !categories.includes(category))
    || categories.some((category) => !Number.isSafeInteger(job.counts[category]) || job.counts[category] < 0)
    || categories.reduce((total, category) => total + job.counts[category], 0) !== job.totalRows) {
    throw new HttpsError("failed-precondition", "This AI import has invalid proposal classification counts. Start a new import.");
  }
  requireDocumentId(job.supplierId, "Stored supplier ID");
  return job;
}
async function requireReviewAuthority(db, request, hotelUid, tx, services) {
  const actor = { ...request };
  await requireHotelPermission(db, actor, hotelUid, "supplierproducts", "read", tx, services.auth);
  await requireHotelPermission(db, actor, hotelUid, "supplierproducts", "create", tx, services.auth);
  await requireSaasRollout(db, tx);
  return actor;
}
function publicRow(row) {
  return { rowId: row.rowId, category: row.category, productId: row.productId, expectedRevision: row.expectedRevision,
    reviewRevision: row.reviewRevision, product: row.product, previousProduct: row.previousProduct,
    inputPatch: row.inputPatch, issues: row.issues, changes: row.changes, sourceAnchors: row.sourceAnchors, committed: row.committed || null };
}

async function readHotelSupplierAiImportRowsHandler(request, services = {}) {
  const input = request.data || {}; object(input, "AI review request", ["hotelUid", "jobId", "cursor", "limit"]);
  const hotelUid = requireDocumentId(input.hotelUid, "hotelUid"), jobId = requireDocumentId(input.jobId, "jobId");
  const limit = input.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) bad("Read between one and 100 review rows per page.");
  const cursor = input.cursor == null ? null : requireDocumentId(input.cursor, "Review cursor");
  if (cursor && !/^r-\d{6}$/.test(cursor)) bad("The AI review cursor is invalid.");
  const db = services.firestore || admin.firestore();
  return db.runTransaction(async (tx) => {
    await requireReviewAuthority(db, request, hotelUid, tx, services);
    const job = requireReviewJob(await tx.get(db.doc(jobPath(hotelUid, jobId))), services.now?.() ?? Date.now(), request.auth.uid);
    let query = db.collection(`${jobPath(hotelUid, jobId)}/rows`).orderBy(admin.firestore.FieldPath.documentId());
    if (cursor) query = query.startAfter(cursor);
    const result = await tx.get(query.limit(limit + 1));
    return { hotelUid, jobId, rows: result.docs.slice(0, limit).map((doc) => publicRow(doc.data())),
      nextCursor: result.docs.length > limit ? result.docs[limit - 1].id : null, totalRows: job.totalRows };
  });
}

async function correctHotelSupplierAiImportRowHandler(request, services = {}) {
  const input = request.data || {}; object(input, "AI row correction", ["hotelUid", "jobId", "rowId", "expectedReviewRevision", "patch"]);
  const hotelUid = requireDocumentId(input.hotelUid, "hotelUid"), jobId = requireDocumentId(input.jobId, "jobId"), rowId = requireDocumentId(input.rowId, "rowId");
  const expected = revision(input.expectedReviewRevision); object(input.patch, "AI row correction patch", PATCH_FIELDS);
  if (JSON.stringify(input.patch).length > 20000) bad("The row correction exceeds the supported size.");
  const fingerprint = digest(input.expectedReviewRevision, input.patch), db = services.firestore || admin.firestore();
  return db.runTransaction(async (tx) => {
    const actor = await requireReviewAuthority(db, request, hotelUid, tx, services);
    const job = requireReviewJob(await tx.get(db.doc(jobPath(hotelUid, jobId))), services.now?.() ?? Date.now(), request.auth.uid);
    const rowRef = db.doc(`${jobPath(hotelUid, jobId)}/rows/${rowId}`), snapshot = await tx.get(rowRef);
    if (!snapshot.exists) throw new HttpsError("not-found", "Review row not found in this hotel import.");
    const row = snapshot.data();
    if (row.committed) throw new HttpsError("failed-precondition", "This row was already confirmed. Edit its supplier product instead.");
    if (row.previousProduct) await requireHotelPermission(db, actor, hotelUid, "supplierproducts", "update", tx, services.auth);
    if (Object.hasOwn(input.patch, "catalogProductId") && input.patch.catalogProductId) await requireHotelPermission(db, actor, hotelUid, "catalogproducts", "read", tx, services.auth);
    if (row.lastCorrection?.fingerprint === fingerprint && row.lastCorrection.actorUid === request.auth.uid) return { hotelUid, jobId, row: publicRow(row) };
    if (row.reviewRevision !== expected) throw new HttpsError("aborted", "The reviewed row changed. Refresh before correcting it.");
    const userPatch = { ...(row.userPatch || {}), ...input.patch };
    const sku = userPatch.supplierSku ?? row.inputPatch.supplierSku;
    const matches = await matchesForSku((ref) => tx.get(ref), db, hotelUid, job.supplierId, sku);
    const duplicateRows = typeof sku === "string" && sku.trim()
      ? await tx.get(db.collection(`${jobPath(hotelUid, jobId)}/rows`).where("product.supplierSku", "==", sku.trim()).limit(2)) : { docs: [] };
    let previous = matches.length === 1 ? matches[0].data() : null, productId = matches.length === 1 ? matches[0].id : null;
    if (previous && !row.previousProduct) await requireHotelPermission(db, actor, hotelUid, "supplierproducts", "update", tx, services.auth);
    // Once a candidate names an existing identity, correction cannot relink it
    // to another offer by changing a SKU. New rows may resolve their missing SKU.
    if (row.previousProduct) {
      const current = await tx.get(db.doc(`hotels/${hotelUid}/supplierproducts/${row.productId}`));
      if (!current.exists) throw new HttpsError("aborted", "The existing supplier product was removed. Start a new import.");
      previous = current.data(); productId = row.productId;
    }
    const raw = { ...Object.fromEntries(RAW_FIELDS.map((field) => [field, null])), ...row.inputPatch,
      sourceAnchors: row.sourceAnchors, sourceEvidenceIssues: row.sourceEvidenceIssues || [] };
    const next = buildSupplierAiCandidate({ hotelUid, jobId, supplierId: job.supplierId, rowIndex: row.rowIndex, raw, previous, productId,
      userPatch, reviewRevision: expected + 1, duplicate: duplicateRows.docs.some((document) => document.id !== rowId), ambiguous: matches.length > 1 });
    await validateReferences((ref) => tx.get(ref), db, hotelUid, next);
    if (!Object.hasOwn(job.counts, row.category) || job.counts[row.category] < 1) {
      throw new HttpsError("failed-precondition", "This reviewed row does not reconcile with its import classification counts. Start a new import.");
    }
    const counts = { ...job.counts };
    if (row.category !== next.category) { counts[row.category]--; counts[next.category]++; }
    tx.set(rowRef, { ...next, createdAt: row.createdAt, updatedAt: stamp(), correctedBy: request.auth.uid,
      lastCorrection: { fingerprint, actorUid: request.auth.uid } });
    if (row.category !== next.category) tx.set(db.doc(jobPath(hotelUid, jobId)), { ...job, counts, updatedAt: stamp() });
    return { hotelUid, jobId, row: publicRow(next) };
  });
}

function blockedOutcome(rowId, error) {
  return { rowId, status: "blocked", productId: null, revision: null, error: { code: error.code, message: error.message } };
}
async function commitHotelSupplierAiImportRowsHandler(request, services = {}) {
  const input = request.data || {}; object(input, "AI import confirmation", ["hotelUid", "jobId", "requestId", "rows"]);
  const hotelUid = requireDocumentId(input.hotelUid, "hotelUid"), jobId = requireDocumentId(input.jobId, "jobId"), requestId = requireDocumentId(input.requestId, "requestId");
  if (!Array.isArray(input.rows) || input.rows.length < 1 || input.rows.length > MAX_CONFIRM_ROWS) bad(`Confirm between one and ${MAX_CONFIRM_ROWS} rows per request.`);
  const rows = input.rows.map((row) => {
    object(row, "AI confirmation row", ["rowId", "reviewRevision", "acknowledged"]);
    if (row.acknowledged !== true) bad("Every selected row requires explicit human review acknowledgement.");
    return { rowId: requireDocumentId(row.rowId, "rowId"), reviewRevision: revision(row.reviewRevision), acknowledged: true };
  });
  if (new Set(rows.map((row) => row.rowId)).size !== rows.length) bad("A confirmation cannot include duplicate review rows.");
  const db = services.firestore || admin.firestore(), fingerprint = digest(hotelUid, jobId, rows), operationId = `c-${digest(request.auth?.uid, requestId).slice(0, 48)}`;
  const operationRef = db.doc(`${jobPath(hotelUid, jobId)}/commitOperations/${operationId}`);
  // Capture the entire bounded command before processing rows. A transport
  // failure can replay this exact command without duplicating committed rows.
  await db.runTransaction(async (tx) => {
    await requireReviewAuthority(db, request, hotelUid, tx, services);
    requireReviewJob(await tx.get(db.doc(jobPath(hotelUid, jobId))), services.now?.() ?? Date.now(), request.auth.uid);
    const prior = await tx.get(operationRef);
    if (prior.exists) {
      if (prior.data().fingerprint !== fingerprint) throw new HttpsError("already-exists", "This AI confirmation request was used with different rows.");
    } else tx.create(operationRef, { actorUid: request.auth.uid, fingerprint, rows, createdAt: stamp() });
  });
  const outcomes = [];
  for (const selection of rows) {
    const outcome = await db.runTransaction(async (tx) => {
      const actor = await requireReviewAuthority(db, request, hotelUid, tx, services);
      const job = requireReviewJob(await tx.get(db.doc(jobPath(hotelUid, jobId))), services.now?.() ?? Date.now(), request.auth.uid);
      // Turning off billable AI processing does not prevent a human finishing a
      // valid existing draft. The current policy is still read and validated.
      let config;
      try { config = await loadSupplierAiConfiguration(db, tx); }
      catch { throw new HttpsError("failed-precondition", "This import needs administrator assistance before it can be confirmed."); }
      const rowRef = db.doc(`${jobPath(hotelUid, jobId)}/rows/${selection.rowId}`), receiptRef = db.doc(`${operationRef.path}/rows/${selection.rowId}`);
      const snapshot = await tx.get(rowRef), receipt = await tx.get(receiptRef);
      if (!snapshot.exists) throw new HttpsError("not-found", "A selected review row no longer exists.");
      const row = snapshot.data();
      if (row.previousProduct || row.committed?.status === "updated") await requireHotelPermission(db, actor, hotelUid, "supplierproducts", "update", tx, services.auth);
      if (row.product?.catalogProductId) await requireHotelPermission(db, actor, hotelUid, "catalogproducts", "read", tx, services.auth);
      if (receipt.exists) return receipt.data().outcome;
      let result;
      try {
        if (row.reviewRevision !== selection.reviewRevision) throw new HttpsError("aborted", "The reviewed row changed. Review and acknowledge its latest values.");
        if (row.committed) result = row.committed;
        else {
          if ((row.sourceEvidenceIssues || []).length) throw new HttpsError("failed-precondition", "This row has unverified source evidence. Exclude it, or correct the source and start a new import.");
          if (row.category === "blocked" || hasErrors(row.issues || [])) throw new HttpsError("failed-precondition", "Correct the blocking fields before confirming this row.");
          if (row.product.supplierId !== job.supplierId) throw new HttpsError("failed-precondition", "The candidate supplier identity does not match this import.");
          const action = row.previousProduct ? "update" : "create";
          const plan = await supplierProductInternals.prepareProduct(tx, db, hotelUid, "supplierproducts", row.productId, action, row.expectedRevision, row.product, new Map());
          // Reconciliation is not trusted at commit time. Compare the freshly
          // validated public result against the exact values the user reviewed.
          if (digest(productView(plan.next)) !== digest(productView(row.product))) throw new HttpsError("aborted", "Current product validation changed the reviewed values. Correct and review this row again.");
          if (row.category === "unchanged") result = { rowId: row.rowId, status: "unchanged", productId: row.productId, revision: row.expectedRevision };
          else result = { rowId: row.rowId, status: action === "create" ? "created" : "updated", ...supplierProductInternals.writeProduct(tx, plan, "supplierproducts", request.auth.uid) };
          tx.set(rowRef, { ...row, committed: result, confirmedBy: request.auth.uid, confirmedAt: stamp() });
          tx.create(db.doc(`hotels/${hotelUid}/productAudit/ai-${digest(jobId, row.rowId).slice(0, 48)}`), {
            actorUid: request.auth.uid, collection: "supplierproducts", action: "ai-import-confirmation", jobId, rowId: row.rowId,
            productId: row.productId, reviewRevision: row.reviewRevision, revision: result.revision,
            sourceConfigRevision: job.configVersion, confirmedConfigRevision: config.revision ?? 0, createdAt: stamp() });
        }
      } catch (error) {
        if (!(error instanceof HttpsError) || !["invalid-argument", "failed-precondition", "aborted", "already-exists", "not-found"].includes(error.code)) throw error;
        result = blockedOutcome(selection.rowId, error);
      }
      tx.create(receiptRef, { outcome: result, actorUid: request.auth.uid, createdAt: stamp() });
      return result;
    });
    outcomes.push(outcome);
  }
  return { hotelUid, jobId, outcomes, complete: true };
}

const options = { region: "us-central1", cors: true, timeoutSeconds: 120 };
const readHotelSupplierAiImportRows = onCall(options, gated(readHotelSupplierAiImportRowsHandler));
const correctHotelSupplierAiImportRow = onCall(options, gated(correctHotelSupplierAiImportRowHandler));
const commitHotelSupplierAiImportRows = onCall(options, gated(commitHotelSupplierAiImportRowsHandler));
module.exports = { AI_PROPOSAL_POLICY_VERSION, MAX_AI_ROWS, MAX_CONFIRM_ROWS, AI_SUPPLIER_SCHEMA, validateRawSupplierAiRows,
  buildSupplierAiCandidate, reconcileSupplierAiRows, readHotelSupplierAiImportRowsHandler, correctHotelSupplierAiImportRowHandler, commitHotelSupplierAiImportRowsHandler,
  readHotelSupplierAiImportRows, correctHotelSupplierAiImportRow, commitHotelSupplierAiImportRows };
