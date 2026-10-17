const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { withPurchasingTelemetry } = require("./purchasingTelemetry");
const { admin } = require("./config");
const { requireDocumentId } = require("./subscriptions");
const { digest, revision } = require("./validation");
const { requireHotelPermission } = require("./authorization");
const { gated } = require("./saasRollout");
const recurring = require("./supplierRecurringReview");

const REVIEW_VERSION = 1;
const MAX_REVIEW_BATCH = 25;
const MAX_WORKSPACE_ROWS = 1000;
const FILTERS = ["all", "attention", "pending", "approved", "skipped", "applied"];
const REVIEW_COUNTS = ["pending", "approved", "skipped", "applied"];
const OUTCOME_COUNTS = ["created", "updated", "unchanged"];
const stamp = () => admin.firestore.FieldValue.serverTimestamp();
const jobPath = (hotelUid, jobId) => `hotels/${hotelUid}/supplierAiImportJobs/${jobId}`;
const internals = () => require("./supplierAiProposal").supplierAiProposalInternals;
const invalid = (message) => { throw new HttpsError("invalid-argument", message); };
function object(value, fields, name) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !fields.includes(key))) invalid(`Unsupported ${name} field.`);
}
function rowId(value) {
  const id = requireDocumentId(value, "Review row ID");
  if (!/^r-\d{6}$/.test(id)) invalid("The review row ID is invalid.");
  return id;
}
function reviewStatus(row) {
  if (row.committed && OUTCOME_COUNTS.includes(row.committed.status)) return "applied";
  return row.review?.reviewRevision === row.reviewRevision && ["approved", "skipped"].includes(row.review.status) ? row.review.status : "pending";
}
function canApprove(row) {
  return !row.committed && row.lastOutcome?.status !== "blocked" && !(row.sourceEvidenceIssues || []).length && row.category !== "blocked"
    && !(row.issues || []).some((issue) => issue.severity === "error");
}
function bulkEligible(row) {
  // Inactive, unlinked draft products are an explicit safe storage mode. Price,
  // conversion, source and inferred-contract warnings still require individual
  // review, rather than a model confidence score authorizing a bulk write.
  const detail = recurring.recurringReview(row);
  // Confirmed recurring formats permit group decisions only for unchanged
  // confirmations and factual price changes to existing offers. New identities,
  // package changes and unknown interpretation need an individual decision.
  if (row.sourceInterpretation && (!row.previousProduct || !["price-change", "confirmation"].includes(detail.category)
    || row.sourceInterpretation.status !== "confirmed" || !detail.confirmsUnitPrice || !detail.physicalPriceComparison.comparable)) return false;
  return canApprove(row) && !(row.issues || []).some((issue) => issue.severity === "warning"
    && !["inactive-new-offer", "unlinked"].includes(issue.code))
    && !(row.normalizationFindings || []).some((finding) => ["inference", "approved-name-expansion"].includes(finding.provenance));
}
function emptyReviewState() {
  return { version: REVIEW_VERSION, counts: Object.fromEntries(REVIEW_COUNTS.map((key) => [key, 0])),
    outcomes: Object.fromEntries(OUTCOME_COUNTS.map((key) => [key, 0])), failed: 0 };
}
function validateReviewState(state, totalRows) {
  if (!state || state.version !== REVIEW_VERSION || !state.counts || !state.outcomes
    || REVIEW_COUNTS.some((key) => !Number.isSafeInteger(state.counts[key]) || state.counts[key] < 0)
    || OUTCOME_COUNTS.some((key) => !Number.isSafeInteger(state.outcomes[key]) || state.outcomes[key] < 0)
    || !Number.isSafeInteger(state.failed) || state.failed < 0
    || REVIEW_COUNTS.reduce((sum, key) => sum + state.counts[key], 0) !== totalRows
    || OUTCOME_COUNTS.reduce((sum, key) => sum + state.outcomes[key], 0) !== state.counts.applied
    || state.failed > totalRows - state.counts.applied) {
    throw new HttpsError("failed-precondition", "The durable import review counts do not reconcile. Start a new import.");
  }
  return state;
}
function adjustReviewState(state, row, direction = 1) {
  if (!state || state.version !== REVIEW_VERSION) throw new HttpsError("failed-precondition", "The durable import review receipt is unavailable.");
  const next = { ...state, counts: { ...state.counts }, outcomes: { ...state.outcomes } };
  const status = reviewStatus(row);
  next.counts[status] += direction;
  if (status === "applied") next.outcomes[row.committed.status] += direction;
  if (!row.committed && row.lastOutcome?.status === "blocked") next.failed += direction;
  if ([...Object.values(next.counts), ...Object.values(next.outcomes), next.failed].some((count) => !Number.isSafeInteger(count) || count < 0)) {
    throw new HttpsError("failed-precondition", "The durable import review counts are invalid.");
  }
  return next;
}
function publicReviewCounts(state, totalRows) {
  validateReviewState(state, totalRows);
  return { reviewCounts: { ...state.counts, failed: state.failed }, outcomeCounts: { ...state.outcomes } };
}
function publicReview(row) {
  const review = row.review || { status: "pending", reviewRevision: row.reviewRevision };
  return { review: { status: reviewStatus(row) === "applied" ? review.status : reviewStatus(row), reviewRevision: row.reviewRevision,
    decidedBy: review.decidedBy ?? null }, canApprove: canApprove(row), bulkEligible: bulkEligible(row), lastOutcome: row.lastOutcome ?? null };
}
function sourcePurchaseUnit(row) {
  const value = row.purchaseUnitMapping && Object.hasOwn(row.purchaseUnitMapping, "sourceUnit")
    ? row.purchaseUnitMapping.sourceUnit : row.originalInput?.purchaseUnit;
  return typeof value === "string" && value.trim() && value.length <= 100 ? value.trim() : null;
}
function indexRow(row) {
  const sourceUnit = sourcePurchaseUnit(row);
  return { rowId: row.rowId, reviewRevision: row.reviewRevision, category: row.category,
    requiresUpdate: Boolean(row.previousProduct), name: row.product?.supplierProductName ?? null, sku: row.product?.supplierSku ?? null,
    reviewStatus: reviewStatus(row), committedStatus: row.committed?.status ?? null,
    needsAttention: !bulkEligible(row), bulkEligible: bulkEligible(row), canApprove: canApprove(row),
    failed: !row.committed && row.lastOutcome?.status === "blocked", sourceUnit,
    purchaseUnit: row.product?.purchaseUnit ?? null,
    purchaseUnitMapping: row.purchaseUnitMapping ?? null,
    recurringReview: recurring.recurringReview(row),
    humanPurchaseUnit: Object.hasOwn(row.userPatch || {}, "purchaseUnit") };
}
function writeIndex(tx, db, hotelUid, jobId, row) {
  tx.set(db.doc(`${jobPath(hotelUid, jobId)}/reviewIndex/${row.rowId}`), indexRow(row));
}
function publicIndex(row) {
  return Object.fromEntries(["rowId", "reviewRevision", "category", "requiresUpdate", "name", "sku", "reviewStatus", "committedStatus", "needsAttention", "bulkEligible", "canApprove", "failed", "sourceUnit", "purchaseUnit", "humanPurchaseUnit", "recurringReview"].map((key) => [key, row[key] ?? null]));
}
function validateIndex(entries, job) {
  if (entries.length !== job.totalRows || entries.some((row, index) => row.rowId !== `r-${String(index + 1).padStart(6, "0")}` || !Number.isSafeInteger(row.reviewRevision)
    || row.reviewRevision < 1 || !["new", "changed", "unchanged", "blocked"].includes(row.category)
    || !REVIEW_COUNTS.includes(row.reviewStatus))) {
    throw new HttpsError("failed-precondition", "The complete import review index is unavailable. Start a new import.");
  }
  const state = emptyReviewState(), categories = { new: 0, changed: 0, unchanged: 0, blocked: 0 };
  for (const row of entries) {
    categories[row.category]++;
    state.counts[row.reviewStatus]++;
    if (row.reviewStatus === "applied") {
      if (!OUTCOME_COUNTS.includes(row.committedStatus)) throw new HttpsError("failed-precondition", "The applied import outcome is invalid.");
      state.outcomes[row.committedStatus]++;
    }
    if (row.failed === true) state.failed++;
  }
  if (digest(state) !== digest(validateReviewState(job.reviewState, job.totalRows)) || digest(categories) !== digest(job.counts)) {
    throw new HttpsError("failed-precondition", "The complete import review index and counts disagree. Start a new import.");
  }
  return entries;
}
function mappingGroups(entries) {
  const groups = new Map();
  for (const row of entries) {
    if (!row.sourceUnit || ["applied", "skipped"].includes(row.reviewStatus) || row.humanPurchaseUnit) continue;
    const key = row.sourceUnit.normalize("NFKC").trim().toUpperCase();
    const group = groups.get(key) || { sourceUnit: row.sourceUnit, count: 0, rowIds: [], units: new Set(), confirmed: true };
    group.count++;
    group.rowIds.push({ rowId: row.rowId, reviewRevision: row.reviewRevision });
    const proposed = row.purchaseUnitMapping?.suggestedUnit ?? row.purchaseUnit;
    if (proposed) group.units.add(proposed);
    if (!row.purchaseUnitMapping || !["confirmed", "known"].includes(row.purchaseUnitMapping.status)) group.confirmed = false;
    groups.set(key, group);
  }
  const all = [...groups.values()].sort((left, right) => left.sourceUnit.localeCompare(right.sourceUnit));
  return { mappingGroups: all.slice(0, 100).map(({ sourceUnit, count, rowIds, units, confirmed }) => ({ sourceUnit, count, rowIds,
    suggestedUnit: units.size === 1 ? [...units][0] : null, purchaseUnit: confirmed && units.size === 1 ? [...units][0] : null,
    status: units.size > 1 ? "conflict" : confirmed ? "mapped" : "unmapped" })), mappingGroupsTruncated: all.length > 100 };
}
function requireWorkspaceJob(snapshot, now, actorUid, allowCompleted = true) {
  const job = internals().requireReviewJob(snapshot, now, actorUid, allowCompleted);
  if (job.importReviewVersion !== REVIEW_VERSION) throw new HttpsError("failed-precondition", "This legacy draft uses the original review dialog. Start a new import for the guided review workspace.");
  validateReviewState(job.reviewState, job.totalRows);
  return job;
}
function requireSettledFormat(job) {
  if (job.formatApplication && job.formatApplication.complete !== true) throw new HttpsError("failed-precondition", "Finish applying the confirmed supplier format before reviewing or applying products.");
}
async function requireRowAuthority(db, request, hotelUid, tx, services, row) {
  if (row.previousProduct || row.committed?.status === "updated") await requireHotelPermission(db, request, hotelUid, "supplierproducts", "update", tx, services.auth);
  if (row.product?.catalogProductId) await requireHotelPermission(db, request, hotelUid, "catalogproducts", "read", tx, services.auth);
}
function selectedRows(input, actions = false) {
  if (!Array.isArray(input) || input.length < 1 || input.length > MAX_REVIEW_BATCH) invalid(`Select between one and ${MAX_REVIEW_BATCH} review rows.`);
  const rows = input.map((selection) => {
    object(selection, actions ? ["rowId", "reviewRevision", "action", "acknowledged"] : ["rowId", "reviewRevision"], "review selection");
    if (actions && (!["approve", "skip", "reset"].includes(selection.action) || selection.acknowledged !== true)) invalid("Every review decision requires an explicit acknowledgement and supported action.");
    return { rowId: rowId(selection.rowId), reviewRevision: revision(selection.reviewRevision), ...(actions ? { action: selection.action, acknowledged: true } : {}) };
  });
  if (new Set(rows.map((row) => row.rowId)).size !== rows.length) invalid("Review selections cannot contain duplicate rows.");
  return rows;
}
async function ensureGuidedWorkspace(db, request, hotelUid, jobId, services) {
  const root = jobPath(hotelUid, jobId);
  // Legacy drafts are adapted with review metadata only. Immutable product
  // proposals, source evidence, paid receipts and revisions are never rerun.
  for (let pass = 0; pass <= Math.ceil(MAX_WORKSPACE_ROWS / 100); pass++) {
    const complete = await db.runTransaction(async (tx) => {
      await internals().requireReviewAuthority(db, request, hotelUid, tx, services);
      const job = internals().requireReviewJob(await tx.get(db.doc(root)), services.now?.() ?? Date.now(), request.auth.uid, true);
      if (job.importReviewVersion === REVIEW_VERSION) return true;
      const migration = job.reviewMigration || { version: REVIEW_VERSION, processed: 0, cursor: null };
      if (migration.version !== REVIEW_VERSION || !Number.isSafeInteger(migration.processed) || migration.processed < 0
        || migration.processed > job.totalRows || (migration.cursor !== null && !/^r-\d{6}$/.test(migration.cursor))) {
        throw new HttpsError("failed-precondition", "The guided review preparation receipt is invalid.");
      }
      let query = db.collection(`${root}/rows`).orderBy(admin.firestore.FieldPath.documentId());
      if (migration.cursor) query = query.startAfter(migration.cursor);
      const snapshots = await tx.get(query.limit(101)), rows = snapshots.docs.slice(0, 100).map((doc) => doc.data());
      if (!rows.length || migration.processed + rows.length > job.totalRows) {
        throw new HttpsError("failed-precondition", "The legacy import rows do not match its complete row count.");
      }
      let state = job.reviewState || emptyReviewState();
      for (const row of rows) {
        if (row.review && !job.reviewMigration) throw new HttpsError("failed-precondition", "The legacy review metadata is inconsistent.");
        row.review = row.review || { status: row.committed ? "approved" : "pending", reviewRevision: row.reviewRevision };
        row.lastOutcome = row.lastOutcome || row.committed || null;
        state = adjustReviewState(state, row);
      }
      const processed = migration.processed + rows.length, finished = processed === job.totalRows;
      if (finished && snapshots.docs.length > rows.length) throw new HttpsError("failed-precondition", "The legacy import contains unexpected additional rows.");
      if (!finished && snapshots.docs.length <= 100) throw new HttpsError("failed-precondition", "Some legacy import rows are unavailable.");
      validateReviewState(state, processed);
      for (const row of rows) { tx.set(db.doc(`${root}/rows/${row.rowId}`), row); writeIndex(tx, db, hotelUid, jobId, row); }
      tx.set(db.doc(root), { ...job, reviewState: state,
        reviewMigration: { version: REVIEW_VERSION, processed, cursor: rows.at(-1).rowId, complete: finished },
        ...(finished ? { importReviewVersion: REVIEW_VERSION } : {}), updatedAt: stamp() });
      return finished;
    });
    if (complete) return;
  }
  throw new HttpsError("aborted", "The guided review preparation is incomplete. Refresh to continue from its saved cursor.");
}
async function readHotelSupplierAiImportWorkspaceHandler(request, services = {}) {
  const input = request.data || {};
  object(input, ["hotelUid", "jobId", "cursor", "limit", "filter", "includeIndex", "focusRowId"], "import workspace request");
  const hotelUid = requireDocumentId(input.hotelUid, "hotelUid"), jobId = requireDocumentId(input.jobId, "jobId");
  const limit = input.limit ?? MAX_REVIEW_BATCH, filter = input.filter ?? "all";
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_REVIEW_BATCH || !FILTERS.includes(filter)
    || (input.includeIndex !== undefined && typeof input.includeIndex !== "boolean")) invalid("The import workspace page is invalid.");
  const cursor = input.cursor == null ? null : rowId(input.cursor), focus = input.focusRowId == null ? null : rowId(input.focusRowId);
  const db = services.firestore || admin.firestore();
  await ensureGuidedWorkspace(db, request, hotelUid, jobId, services);
  return db.runTransaction(async (tx) => {
    await internals().requireReviewAuthority(db, request, hotelUid, tx, services);
    const job = requireWorkspaceJob(await tx.get(db.doc(jobPath(hotelUid, jobId))), services.now?.() ?? Date.now(), request.auth.uid);
    const snapshot = await tx.get(db.collection(`${jobPath(hotelUid, jobId)}/reviewIndex`).orderBy(admin.firestore.FieldPath.documentId()).limit(MAX_WORKSPACE_ROWS + 1));
    const index = validateIndex(snapshot.docs.map((doc) => doc.data()), job);
    const filtered = index.filter((row) => (!cursor || row.rowId > cursor) && (filter === "all" || filter === "attention" ? filter === "all" || row.needsAttention : row.reviewStatus === filter));
    const selected = focus ? index.filter((row) => row.rowId === focus) : filtered.slice(0, limit);
    if (focus && !selected.length) throw new HttpsError("not-found", "The selected review row does not exist in this import.");
    const documents = await Promise.all(selected.map((row) => tx.get(db.doc(`${jobPath(hotelUid, jobId)}/rows/${row.rowId}`))));
    if (documents.some((doc) => !doc.exists)) throw new HttpsError("failed-precondition", "An indexed review row is unavailable.");
    const rows = documents.map((doc, index) => {
      const row = doc.data();
      const expectedIndex = indexRow(row);
      // Saved pre-extension indexes remain valid without re-running extraction.
      if (!Object.hasOwn(selected[index], "recurringReview")) delete expectedIndex.recurringReview;
      if (digest(expectedIndex) !== digest(selected[index])) throw new HttpsError("failed-precondition", "The row and review index disagree. Refresh this import.");
      return internals().publicRow(row);
    });
    const offers = await tx.get(db.collection(`hotels/${hotelUid}/supplierproducts`).where("supplierId", "==", job.supplierId).limit(MAX_WORKSPACE_ROWS + 1));
    const importedSkus = new Set(index.map((entry) => entry.sku).filter(Boolean));
    const missing = offers.docs.filter((doc) => doc.data().archived !== true && !importedSkus.has(doc.data().supplierSku));
    const completeAssortment = offers.docs.length <= MAX_WORKSPACE_ROWS;
    const assortmentSummary = { mode: job.sourceInterpretation?.assortmentMode ?? job.importSettings?.assortmentMode ?? "unknown",
      missingOfferCount: completeAssortment ? missing.length : null, complete: completeAssortment,
      missingOffers: missing.slice(0, 20).map((doc) => ({ productId: doc.id, supplierSku: doc.data().supplierSku ?? null, supplierProductName: doc.data().supplierProductName ?? null })),
      policy: "preserve-existing" };
    return { hotelUid, jobId, supplierId: job.supplierId, status: job.status, importReviewVersion: REVIEW_VERSION,
      totalRows: job.totalRows, counts: job.counts, ...publicReviewCounts(job.reviewState, job.totalRows), rows,
      ...(input.includeIndex !== false ? { index: index.map(publicIndex) } : {}),
      nextCursor: !focus && filtered.length > limit ? selected.at(-1).rowId : null,
      summary: require("./supplierAiImports").publicJob(job).summary,
      sourceFormat: job.purchaseUnitMappingSnapshot?.sourceFormat ?? job.fileName?.split(".").at(-1)?.toLowerCase() ?? null, profileId: job.purchaseUnitMappingSnapshot?.profileId ?? "default",
      sourceInterpretation: job.sourceInterpretation ?? null, sourceFormatCandidate: job.sourceFormatCandidate ?? null, assortmentSummary,
      formatApplication: job.formatApplication ?? null,
      ...mappingGroups(index) };
  });
}
async function decideHotelSupplierAiImportRowsHandler(request, services = {}) {
  const input = request.data || {};
  object(input, ["hotelUid", "jobId", "requestId", "rows", "bulk"], "import review decision");
  const hotelUid = requireDocumentId(input.hotelUid, "hotelUid"), jobId = requireDocumentId(input.jobId, "jobId"), requestId = requireDocumentId(input.requestId, "requestId");
  if (input.bulk !== undefined && typeof input.bulk !== "boolean") invalid("The bulk review acknowledgement is invalid.");
  const rows = selectedRows(input.rows, true), db = services.firestore || admin.firestore(), fingerprint = digest(rows, input.bulk === true);
  const root = jobPath(hotelUid, jobId), receiptRef = db.doc(`${root}/reviewOperations/d-${digest(request.auth?.uid, requestId).slice(0, 48)}`);
  return db.runTransaction(async (tx) => {
    await internals().requireReviewAuthority(db, request, hotelUid, tx, services);
    const job = requireWorkspaceJob(await tx.get(db.doc(root)), services.now?.() ?? Date.now(), request.auth.uid);
    requireSettledFormat(job);
    const receipt = await tx.get(receiptRef);
    const snapshots = await Promise.all(rows.map((selection) => tx.get(db.doc(`${root}/rows/${selection.rowId}`))));
    for (const snapshot of snapshots) {
      if (!snapshot.exists) throw new HttpsError("not-found", "A selected review row does not exist.");
      await requireRowAuthority(db, request, hotelUid, tx, services, snapshot.data());
    }
    if (receipt.exists) {
      if (receipt.data().fingerprint !== fingerprint) throw new HttpsError("already-exists", "This review request was already used with different decisions.");
      const stored = receipt.data();
      const rowReceipts = await Promise.all(stored.rowIds.map((id) => tx.get(db.doc(`${receiptRef.path}/rows/${id}`))));
      if (rowReceipts.some((doc) => !doc.exists)) throw new HttpsError("failed-precondition", "The durable review decision receipt is incomplete.");
      return { ...stored.result, rows: rowReceipts.map((doc) => doc.data().row) };
    }
    if (job.status !== "review") throw new HttpsError("failed-precondition", "A completed import cannot receive new review decisions.");
    let state = job.reviewState;
    const updated = snapshots.map((snapshot, index) => {
      const row = snapshot.data(), selection = rows[index];
      if (row.committed) throw new HttpsError("failed-precondition", "An applied row cannot be reviewed or skipped again.");
      if (row.reviewRevision !== selection.reviewRevision) throw new HttpsError("aborted", "The reviewed product changed. Refresh before deciding.");
      if (selection.action === "approve" && row.lastOutcome?.status === "blocked") throw new HttpsError("failed-precondition", "Revalidate this failed proposal before approving its current product contract.");
      if (selection.action === "approve" && !canApprove(row)) throw new HttpsError("failed-precondition", "Correct the blocking fields or skip this product before approving it.");
      if (selection.action === "approve" && input.bulk === true && !bulkEligible(row)) throw new HttpsError("failed-precondition", "This product needs individual review before approval.");
      const next = { ...row, review: { status: selection.action === "approve" ? "approved" : selection.action === "skip" ? "skipped" : "pending",
        reviewRevision: row.reviewRevision, decidedBy: request.auth.uid, decidedAt: stamp() },
        lastOutcome: selection.action === "approve" ? null : row.lastOutcome ?? null, updatedAt: stamp() };
      state = adjustReviewState(adjustReviewState(state, row, -1), next);
      return next;
    });
    validateReviewState(state, job.totalRows);
    const result = { hotelUid, jobId, totalRows: job.totalRows, rows: updated.map(internals().publicRow), ...publicReviewCounts(state, job.totalRows) };
    for (const row of updated) {
      tx.set(db.doc(`${root}/rows/${row.rowId}`), row); writeIndex(tx, db, hotelUid, jobId, row);
      tx.create(db.doc(`hotels/${hotelUid}/productAudit/ai-review-${digest(jobId, requestId, row.rowId).slice(0, 40)}`), {
        action: "ai-import-review-decision", jobId, rowId: row.rowId, actorUid: request.auth.uid,
        reviewRevision: row.reviewRevision, decision: row.review.status, createdAt: stamp() });
    }
    tx.set(db.doc(root), { ...job, reviewState: state, updatedAt: stamp() });
    const { rows: receiptRows, ...receiptResult } = result;
    for (const row of receiptRows) tx.create(db.doc(`${receiptRef.path}/rows/${row.rowId}`), { row, createdAt: stamp() });
    tx.create(receiptRef, { actorUid: request.auth.uid, fingerprint, result: receiptResult, rowIds: receiptRows.map((row) => row.rowId), createdAt: stamp() });
    return result;
  });
}
async function completeHotelSupplierAiImportReviewHandler(request, services = {}) {
  const input = request.data || {}; object(input, ["hotelUid", "jobId", "requestId"], "import completion");
  const hotelUid = requireDocumentId(input.hotelUid, "hotelUid"), jobId = requireDocumentId(input.jobId, "jobId"), requestId = requireDocumentId(input.requestId, "requestId");
  const db = services.firestore || admin.firestore(), root = jobPath(hotelUid, jobId);
  const receiptRef = db.doc(`${root}/reviewOperations/f-${digest(request.auth?.uid, requestId).slice(0, 48)}`);
  return db.runTransaction(async (tx) => {
    await internals().requireReviewAuthority(db, request, hotelUid, tx, services);
    const job = requireWorkspaceJob(await tx.get(db.doc(root)), services.now?.() ?? Date.now(), request.auth.uid);
    requireSettledFormat(job);
    const receipt = await tx.get(receiptRef);
    const snapshot = await tx.get(db.collection(`${root}/reviewIndex`).orderBy(admin.firestore.FieldPath.documentId()).limit(MAX_WORKSPACE_ROWS + 1));
    const index = validateIndex(snapshot.docs.map((doc) => doc.data()), job);
    if (index.some((row) => row.committedStatus === "updated")) await requireHotelPermission(db, request, hotelUid, "supplierproducts", "update", tx, services.auth);
    if (receipt.exists) return receipt.data().result;
    const completed = index.every((row) => ["applied", "skipped"].includes(row.reviewStatus));
    const result = { hotelUid, jobId, totalRows: job.totalRows, completed, ...publicReviewCounts(job.reviewState, job.totalRows) };
    // A failed/incomplete final check is read-only and can be retried after the
    // remaining explicit decisions. No pending product is silently skipped.
    if (completed) {
      tx.set(db.doc(root), { ...job, status: "completed", completedBy: request.auth.uid, completedAt: stamp(), updatedAt: stamp() });
      tx.create(receiptRef, { actorUid: request.auth.uid, result, createdAt: stamp() });
    }
    return result;
  });
}

async function applyHotelSupplierAiImportMappingHandler(request, services = {}) {
  const input = request.data || {};
  object(input, ["hotelUid", "jobId", "requestId", "sourceUnit", "purchaseUnit", "expectedMappingRevision", "rows"], "import mapping application");
  const hotelUid = requireDocumentId(input.hotelUid, "hotelUid"), jobId = requireDocumentId(input.jobId, "jobId"), requestId = requireDocumentId(input.requestId, "requestId");
  const mappings = require("./supplierImportMappings"), normalization = require("./supplierAiNormalization");
  const sourceUnit = mappings.sourceUnitKey(input.sourceUnit), purchaseUnit = mappings.canonicalPurchaseUnit(input.purchaseUnit);
  const expectedMappingRevision = input.expectedMappingRevision == null ? null : revision(input.expectedMappingRevision);
  const selections = selectedRows(input.rows), db = services.firestore || admin.firestore(), root = jobPath(hotelUid, jobId);
  const fingerprint = digest(sourceUnit, purchaseUnit, expectedMappingRevision, selections);
  const receiptRef = db.doc(`${root}/reviewOperations/m-${digest(request.auth?.uid, requestId).slice(0, 48)}`);
  return db.runTransaction(async (tx) => {
    await internals().requireReviewAuthority(db, request, hotelUid, tx, services);
    await requireHotelPermission(db, request, hotelUid, "suppliers", "read", tx, services.auth);
    const job = requireWorkspaceJob(await tx.get(db.doc(root)), services.now?.() ?? Date.now(), request.auth.uid);
    requireSettledFormat(job);
    const scope = mappings.mappingScope({ supplierId: job.supplierId,
      sourceFormat: job.purchaseUnitMappingSnapshot?.sourceFormat ?? job.fileName?.split(".").at(-1)?.toLowerCase(),
      profileId: job.purchaseUnitMappingSnapshot?.profileId ?? "default" });
    const [receipt, profile, supplier] = await Promise.all([tx.get(receiptRef), tx.get(mappings.mappingProfileRef(db, hotelUid, scope)), tx.get(db.doc(`hotels/${hotelUid}/suppliers/${job.supplierId}`))]);
    if (!supplier.exists || supplier.data().archived === true) throw new HttpsError("failed-precondition", "The selected supplier is unavailable in this hotel.");
    const snapshots = await Promise.all(selections.map((selection) => tx.get(db.doc(`${root}/rows/${selection.rowId}`))));
    for (const snapshot of snapshots) {
      if (!snapshot.exists) throw new HttpsError("not-found", "A selected review row no longer exists.");
      await requireRowAuthority(db, request, hotelUid, tx, services, snapshot.data());
    }
    if (receipt.exists) {
      if (receipt.data().fingerprint !== fingerprint) throw new HttpsError("already-exists", "This mapping application request was used with different details.");
      const stored = receipt.data();
      const rowReceipts = await Promise.all(stored.rowIds.map((id) => tx.get(db.doc(`${receiptRef.path}/rows/${id}`))));
      if (rowReceipts.some((doc) => !doc.exists)) throw new HttpsError("failed-precondition", "The durable mapping application receipt is incomplete.");
      return { ...stored.result, rows: rowReceipts.map((doc) => doc.data().row) };
    }
    if (job.status !== "review") throw new HttpsError("failed-precondition", "A completed import cannot receive new mappings.");
    let snapshot = null;
    if (expectedMappingRevision !== null) {
      snapshot = mappings.mappingSnapshot(profile.exists ? profile.data() : null, scope);
      if (snapshot.revision !== expectedMappingRevision || !snapshot.mappings.some((entry) => entry.sourceUnit === sourceUnit && entry.purchaseUnit === purchaseUnit)) {
        throw new HttpsError("aborted", "The confirmed supplier mapping changed. Refresh before applying it.");
      }
    }
    let state = job.reviewState, counts = { ...job.counts }, reconciliation = job.reconciliation, summary = job.summary ?? null;
    const updates = [], outcomes = [];
    for (let index = 0; index < snapshots.length; index++) {
      const row = snapshots[index].data(), selection = selections[index];
      if (row.committed || reviewStatus(row) === "skipped" || Object.hasOwn(row.userPatch || {}, "purchaseUnit")) {
        outcomes.push({ rowId: row.rowId, status: "skipped", reason: row.committed ? "already-applied" : reviewStatus(row) === "skipped" ? "review-skipped" : "human-correction" });
        continue;
      }
      try {
        if (row.reviewRevision !== selection.reviewRevision) throw new HttpsError("aborted", "This product changed. Refresh before applying the mapping.");
        const raw = { ...Object.fromEntries(internals().RAW_FIELDS.map((field) => [field, null])), ...(row.sourceInput || row.inputPatch),
          sourceAnchors: row.sourceAnchors, sourceEvidenceIssues: row.sourceEvidenceIssues || [],
          sourceInterpretation: row.sourceInterpretation ?? null,
          originalInput: row.originalInput ?? null, purchaseUnitMapping: row.purchaseUnitMapping ?? null,
          ...(row.normalizationVersion === 2 ? { normalizationVersion: 2, originalInput: row.originalInput,
            normalizationFindings: row.normalizationFindings, packInference: row.packInference, purchaseUnitMapping: row.purchaseUnitMapping } : {}) };
        const mapped = normalization.applyPurchaseUnitMappingToProposal(raw, { sourceUnit, purchaseUnit, snapshot });
        const userPatch = { ...(row.userPatch || {}), purchaseUnit }, sku = userPatch.supplierSku ?? mapped.supplierSku;
        const matches = await internals().matchesForSku((ref) => tx.get(ref), db, hotelUid, job.supplierId, sku);
        const duplicates = typeof sku === "string" && sku.trim() ? await tx.get(db.collection(`${root}/rows`).where("product.supplierSku", "==", sku.trim()).limit(2)) : { docs: [] };
        let previous = matches.length === 1 ? matches[0].data() : null, productId = matches.length === 1 ? matches[0].id : null;
        if (previous && !row.previousProduct) await requireHotelPermission(db, request, hotelUid, "supplierproducts", "update", tx, services.auth);
        if (row.previousProduct) {
          const current = await tx.get(db.doc(`hotels/${hotelUid}/supplierproducts/${row.productId}`));
          if (!current.exists) throw new HttpsError("aborted", "The existing supplier product was removed. Start a new import.");
          previous = current.data(); productId = row.productId;
        }
        const previousPriceAgreement = await internals().loadPreviousPriceAgreement((ref) => tx.get(ref), db, hotelUid, productId, previous, mapped, userPatch);
        const next = internals().buildSupplierAiCandidate({ hotelUid, jobId, supplierId: job.supplierId, rowIndex: row.rowIndex,
          raw: mapped, previous, productId, previousPriceAgreement, userPatch, reviewRevision: row.reviewRevision + 1,
          duplicate: duplicates.docs.some((doc) => doc.id !== row.rowId), ambiguous: matches.length > 1 });
        await internals().validateReferences((ref) => tx.get(ref), db, hotelUid, next);
        next.review = { status: "pending", reviewRevision: next.reviewRevision }; next.lastOutcome = null;
        next.purchaseUnitMapping = mapped.purchaseUnitMapping;
        next.createdAt = row.createdAt; next.updatedAt = stamp(); next.correctedBy = request.auth.uid;
        if (counts[row.category] < 1) throw new HttpsError("failed-precondition", "The import category counts do not reconcile.");
        const nextState = adjustReviewState(adjustReviewState(state, row, -1), next);
        let nextReconciliation = reconciliation, nextSummary = summary;
        if (row.normalizationVersion === 2) {
          const accumulator = internals().adjustSummaryAccumulator(internals().adjustSummaryAccumulator(reconciliation?.summaryAccumulator, row, -1), next);
          nextReconciliation = { ...reconciliation, summaryAccumulator: accumulator };
          nextSummary = internals().publicSummary(accumulator, job.totalRows);
        }
        counts[row.category]--; counts[next.category]++;
        state = nextState; reconciliation = nextReconciliation; summary = nextSummary;
        updates.push(next); outcomes.push({ rowId: row.rowId, status: "mapped", reviewRevision: next.reviewRevision });
      } catch (error) {
        if (!(error instanceof HttpsError) || !["invalid-argument", "failed-precondition", "aborted", "not-found"].includes(error.code)) throw error;
        outcomes.push({ rowId: row.rowId, status: "blocked", error: { code: error.code, message: error.message } });
      }
    }
    validateReviewState(state, job.totalRows);
    const result = { hotelUid, jobId, totalRows: job.totalRows, sourceUnit, purchaseUnit, rows: updates.map(internals().publicRow), outcomes, ...publicReviewCounts(state, job.totalRows) };
    for (const row of updates) {
      tx.set(db.doc(`${root}/rows/${row.rowId}`), row); writeIndex(tx, db, hotelUid, jobId, row);
      tx.create(db.doc(`hotels/${hotelUid}/productAudit/ai-mapping-${digest(jobId, requestId, row.rowId).slice(0, 40)}`), {
        action: "ai-import-mapping-application", actorUid: request.auth.uid, jobId, rowId: row.rowId,
        reviewRevision: row.reviewRevision, sourceUnit, purchaseUnit, mappingRevision: snapshot?.revision ?? null, createdAt: stamp() });
    }
    if (updates.length) tx.set(db.doc(root), { ...job, counts, reviewState: state, reconciliation, summary, updatedAt: stamp() });
    const { rows: receiptRows, ...receiptResult } = result;
    for (const row of receiptRows) tx.create(db.doc(`${receiptRef.path}/rows/${row.rowId}`), { row, createdAt: stamp() });
    tx.create(receiptRef, { actorUid: request.auth.uid, fingerprint, result: receiptResult, rowIds: receiptRows.map((row) => row.rowId), createdAt: stamp() });
    return result;
  });
}

async function applyHotelSupplierImportFormatHandler(request, services = {}) {
  const input = request.data || {};
  object(input, ["hotelUid", "jobId", "requestId", "expectedMappingRevision"], "supplier format application");
  const hotelUid = requireDocumentId(input.hotelUid, "hotelUid"), jobId = requireDocumentId(input.jobId, "jobId"), requestId = requireDocumentId(input.requestId, "requestId");
  const expectedMappingRevision = revision(input.expectedMappingRevision), db = services.firestore || admin.firestore();
  const mappings = require("./supplierImportMappings"), formats = require("./supplierImportFormat"), root = jobPath(hotelUid, jobId);
  const operationId = `t-${digest(request.auth?.uid, requestId).slice(0, 48)}`, operationRef = db.doc(`${root}/reviewOperations/${operationId}`);
  const fingerprint = digest(hotelUid, jobId, expectedMappingRevision), jobRef = db.doc(root);
  const preparation = await db.runTransaction(async (tx) => {
    await internals().requireReviewAuthority(db, request, hotelUid, tx, services);
    await requireHotelPermission(db, request, hotelUid, "suppliers", "read", tx, services.auth);
    const job = requireWorkspaceJob(await tx.get(jobRef), services.now?.() ?? Date.now(), request.auth.uid);
    const receipt = await tx.get(operationRef);
    if (receipt.exists && receipt.data().fingerprint !== fingerprint) throw new HttpsError("already-exists", "This format request was used with different details.");
    if (receipt.data()?.requiresUpdate) await requireHotelPermission(db, request, hotelUid, "supplierproducts", "update", tx, services.auth);
    if (receipt.data()?.complete) return { result: receipt.data().result };
    if (job.status !== "review") throw new HttpsError("failed-precondition", "A completed import cannot receive a new source interpretation.");
    if (job.formatApplication?.complete === false && job.formatApplication.operationId !== operationId) {
      throw new HttpsError("failed-precondition", "Resume the saved format application before starting another one.");
    }
    const scope = mappings.mappingScope({ supplierId: job.supplierId, sourceFormat: job.purchaseUnitMappingSnapshot?.sourceFormat,
      profileId: job.purchaseUnitMappingSnapshot?.profileId ?? "default" });
    const profile = receipt.exists ? null : await tx.get(mappings.mappingProfileRef(db, hotelUid, scope));
    const snapshot = mappings.mappingSnapshot(receipt.exists ? receipt.data().profileSnapshot : profile.exists ? profile.data() : null, scope);
    if (receipt.exists && digest(snapshot) !== receipt.data().profileFingerprint) throw new HttpsError("failed-precondition", "The saved supplier format snapshot is unavailable or inconsistent.");
    if (snapshot.revision !== expectedMappingRevision || !snapshot.interpretation) throw new HttpsError("aborted", "The confirmed supplier format changed. Refresh before applying it.");
    if (!job.sourceFormatCandidate || !job.sourceFormatObject || job.sourceFormatObject.path !== `private/supplier-ai-imports/${hotelUid}/${jobId}/source-format.json`) {
      throw new HttpsError("failed-precondition", "This import has no pinned structured source. Start a new import with the confirmed profile.");
    }
    const tableFingerprint = mappings.tableFingerprint(snapshot.interpretation.header.map((value) => value.trim()), snapshot.interpretation.sheetName, scope.sourceFormat);
    if (tableFingerprint !== job.sourceFormatCandidate.formatFingerprint) throw new HttpsError("failed-precondition", "The confirmed profile describes a different table. Review this file's actual columns.");
    return { job, scope, snapshot };
  });
  if (preparation.result) return preparation.result;
  const bucket = services.bucket || admin.storage().bucket();
  const source = JSON.parse((await require("./supplierAiImports").readPrivate(bucket, preparation.job.sourceFormatObject, 2 * 1024 * 1024)).toString("utf8"));
  if (source.sourceSha256 !== preparation.job.source?.sha256 || source.format !== preparation.scope.sourceFormat) {
    throw new HttpsError("failed-precondition", "The structured source does not match this import's uploaded file.");
  }
  const parsed = formats.interpretSupplierSourceRows(source, preparation.snapshot, { importSettings: preparation.job.importSettings || {} });
  if (parsed.sourceInterpretation.status !== "confirmed" || parsed.rows.length !== preparation.job.totalRows) {
    throw new HttpsError("failed-precondition", "The confirmed format changes the number of source articles. Start a new import so every article can be reviewed.");
  }
  const profileFingerprint = digest(preparation.snapshot), sourceFingerprint = digest(preparation.job.sourceFormatObject);
  const frequencies = new Map();
  for (const row of parsed.rows) if (row.supplierSku) frequencies.set(row.supplierSku, (frequencies.get(row.supplierSku) || 0) + 1);
  for (let batch = 0; batch <= Math.ceil(MAX_WORKSPACE_ROWS / MAX_REVIEW_BATCH); batch++) {
    const result = await db.runTransaction(async (tx) => {
      await internals().requireReviewAuthority(db, request, hotelUid, tx, services);
      await requireHotelPermission(db, request, hotelUid, "suppliers", "read", tx, services.auth);
      const job = requireWorkspaceJob(await tx.get(jobRef), services.now?.() ?? Date.now(), request.auth.uid);
      const receipt = await tx.get(operationRef);
      const profile = receipt.exists ? null : await tx.get(mappings.mappingProfileRef(db, hotelUid, preparation.scope));
      const snapshot = mappings.mappingSnapshot(receipt.exists ? receipt.data().profileSnapshot : profile.exists ? profile.data() : null, preparation.scope);
      if (digest(snapshot) !== profileFingerprint || digest(job.sourceFormatObject) !== sourceFingerprint) throw new HttpsError("aborted", "The confirmed format or source changed during application. Start a new import with the current profile; the original review is preserved.");
      let operation = receipt.exists ? receipt.data() : null;
      if (operation?.fingerprint !== fingerprint && operation) throw new HttpsError("already-exists", "This format request was used with different details.");
      if (operation?.requiresUpdate) await requireHotelPermission(db, request, hotelUid, "supplierproducts", "update", tx, services.auth);
      if (operation?.complete) return operation.result;
      if (job.status !== "review" || job.formatApplication?.complete === false && job.formatApplication.operationId !== operationId) throw new HttpsError("failed-precondition", "This import cannot apply the requested format.");
      let reconciliation = job.reconciliation || {}, summaryAccumulator = reconciliation.summaryAccumulator;
      if (!operation) {
        const all = await tx.get(db.collection(`${root}/rows`).orderBy(admin.firestore.FieldPath.documentId()).limit(MAX_WORKSPACE_ROWS + 1));
        if (all.docs.length !== job.totalRows) throw new HttpsError("failed-precondition", "The complete source review rows are unavailable.");
        // Model output order is not source identity. Keep each saved correction
        // attached to its exact source row when deterministic columns replace
        // an initial interpretation, or require a fresh import if ambiguous.
        const sources = new Map();
        parsed.rows.forEach((row, index) => {
          for (const anchor of row.sourceAnchors || []) {
            const indexes = sources.get(anchor.sourceId) || new Set(); indexes.add(index); sources.set(anchor.sourceId, indexes);
          }
        });
        const rowSourceIndexes = all.docs.map((doc, index) => {
          const row = doc.data(), expectedId = `r-${String(index + 1).padStart(6, "0")}`;
          if (doc.id !== expectedId || row.rowId !== expectedId || row.rowIndex !== index) throw new HttpsError("failed-precondition", "The complete source review row identities are invalid.");
          const matches = new Set((row.sourceAnchors || []).flatMap((anchor) => [...(sources.get(anchor.sourceId) || [])]));
          if (matches.size !== 1) throw new HttpsError("failed-precondition", "An original proposal cannot be linked to exactly one source article. Start a new import with the confirmed format.");
          return [...matches][0];
        });
        if (new Set(rowSourceIndexes).size !== job.totalRows) throw new HttpsError("failed-precondition", "The original proposals do not cover every source article exactly once. Start a new import with the confirmed format.");
        const requiresUpdate = all.docs.some((doc) => Boolean(doc.data().previousProduct));
        if (requiresUpdate) await requireHotelPermission(db, request, hotelUid, "supplierproducts", "update", tx, services.auth);
        if (!summaryAccumulator) {
          summaryAccumulator = all.docs.reduce((state, doc) => internals().adjustSummaryAccumulator(state, doc.data()), internals().emptySummaryAccumulator());
        }
        operation = { fingerprint, profileFingerprint, profileSnapshot: snapshot, sourceFingerprint, requiresUpdate, rowSourceIndexes,
          processed: 0, rebuiltRows: 0, skippedRows: 0, complete: false, actorUid: request.auth.uid, createdAt: stamp() };
      }
      if (operation.profileFingerprint !== profileFingerprint || operation.sourceFingerprint !== sourceFingerprint) throw new HttpsError("aborted", "The saved format application no longer matches the source or profile.");
      if (!Array.isArray(operation.rowSourceIndexes) || operation.rowSourceIndexes.length !== job.totalRows
        || operation.rowSourceIndexes.some((index) => !Number.isSafeInteger(index) || index < 0 || index >= job.totalRows)
        || new Set(operation.rowSourceIndexes).size !== job.totalRows) throw new HttpsError("failed-precondition", "The saved source row associations are invalid.");
      const start = operation.processed, end = Math.min(start + MAX_REVIEW_BATCH, job.totalRows);
      const documents = await Promise.all(parsed.rows.slice(start, end).map((_, offset) => tx.get(db.doc(`${root}/rows/r-${String(start + offset + 1).padStart(6, "0")}`))));
      let state = job.reviewState, counts = { ...job.counts }, rebuiltRows = operation.rebuiltRows, skippedRows = operation.skippedRows;
      const updates = [];
      for (let offset = 0; offset < documents.length; offset++) {
        const document = documents[offset];
        if (!document.exists) throw new HttpsError("failed-precondition", "A source review row is unavailable.");
        const row = document.data();
        await requireRowAuthority(db, request, hotelUid, tx, services, row);
        if (row.committed || reviewStatus(row) === "skipped") { skippedRows++; continue; }
        const raw = parsed.rows[operation.rowSourceIndexes[start + offset]], userPatch = row.userPatch || {}, sku = userPatch.supplierSku ?? raw.supplierSku;
        const matches = await internals().matchesForSku((ref) => tx.get(ref), db, hotelUid, job.supplierId, sku);
        let previous = matches.length === 1 ? matches[0].data() : null, productId = matches.length === 1 ? matches[0].id : null;
        if (previous) await requireHotelPermission(db, request, hotelUid, "supplierproducts", "update", tx, services.auth);
        if (row.previousProduct) {
          const current = await tx.get(db.doc(`hotels/${hotelUid}/supplierproducts/${row.productId}`));
          if (!current.exists) throw new HttpsError("aborted", "An existing offer was removed. Start a new import.");
          previous = current.data(); productId = row.productId;
        }
        const previousPriceAgreement = await internals().loadPreviousPriceAgreement((ref) => tx.get(ref), db, hotelUid, productId, previous, raw, userPatch);
        const next = internals().buildSupplierAiCandidate({ hotelUid, jobId, supplierId: job.supplierId, rowIndex: row.rowIndex, raw, previous, productId, previousPriceAgreement,
          userPatch, reviewRevision: row.reviewRevision + 1, duplicate: frequencies.get(sku) > 1, ambiguous: matches.length > 1 });
        await internals().validateReferences((ref) => tx.get(ref), db, hotelUid, next);
        next.review = { status: "pending", reviewRevision: next.reviewRevision }; next.lastOutcome = null;
        next.createdAt = row.createdAt; next.updatedAt = stamp(); next.correctedBy = request.auth.uid;
        if (counts[row.category] < 1) throw new HttpsError("failed-precondition", "The import category counts do not reconcile.");
        counts[row.category]--; counts[next.category]++;
        state = adjustReviewState(adjustReviewState(state, row, -1), next);
        summaryAccumulator = internals().adjustSummaryAccumulator(internals().adjustSummaryAccumulator(summaryAccumulator, row, -1), next);
        rebuiltRows++; updates.push(next);
      }
      validateReviewState(state, job.totalRows);
      const complete = end === job.totalRows, result = { hotelUid, jobId, rebuiltRows, skippedRows, completed: complete };
      for (const row of updates) {
        tx.set(db.doc(`${root}/rows/${row.rowId}`), row); writeIndex(tx, db, hotelUid, jobId, row);
        tx.create(db.doc(`hotels/${hotelUid}/productAudit/ai-format-${digest(jobId, requestId, row.rowId).slice(0, 40)}`), {
          action: "ai-import-format-application", jobId, rowId: row.rowId, actorUid: request.auth.uid,
          profileRevision: snapshot.revision, interpretationFingerprint: snapshot.interpretationFingerprint, reviewRevision: row.reviewRevision, createdAt: stamp() });
      }
      tx.set(operationRef, { ...operation, requiresUpdate: operation.requiresUpdate || updates.some((row) => Boolean(row.previousProduct)),
        processed: end, rebuiltRows, skippedRows, complete, result, updatedAt: stamp() });
      reconciliation = { ...reconciliation, summaryAccumulator };
      tx.set(jobRef, { ...job, counts, reviewState: state, reconciliation, summary: internals().publicSummary(summaryAccumulator, job.totalRows),
        formatApplication: { operationId, requestId, complete, processed: end, totalRows: job.totalRows, profileRevision: snapshot.revision },
        ...(complete ? { purchaseUnitMappingSnapshot: snapshot, sourceInterpretation: parsed.sourceInterpretation, sourceFormatCandidate: parsed.sourceFormatCandidate } : {}), updatedAt: stamp() });
      return result;
    });
    if (result.completed) return result;
  }
  throw new HttpsError("aborted", "The confirmed format application is incomplete. Resume the same request to continue from its saved progress.");
}

const options = { region: "us-central1", cors: true, timeoutSeconds: 120 };
const readHotelSupplierAiImportWorkspace = onCall(options, gated(withPurchasingTelemetry(readHotelSupplierAiImportWorkspaceHandler, "supplier-imports")));
const decideHotelSupplierAiImportRows = onCall(options, gated(withPurchasingTelemetry(decideHotelSupplierAiImportRowsHandler, "supplier-imports")));
const completeHotelSupplierAiImportReview = onCall(options, gated(withPurchasingTelemetry(completeHotelSupplierAiImportReviewHandler, "supplier-imports")));
const applyHotelSupplierAiImportMapping = onCall(options, gated(withPurchasingTelemetry(applyHotelSupplierAiImportMappingHandler, "supplier-imports")));
const applyHotelSupplierImportFormat = onCall(options, gated(withPurchasingTelemetry(applyHotelSupplierImportFormatHandler, "supplier-imports")));
module.exports = { REVIEW_VERSION, MAX_REVIEW_BATCH, emptyReviewState, adjustReviewState, validateReviewState, publicReviewCounts,
  reviewStatus, canApprove, bulkEligible, publicReview, indexRow, writeIndex, requireSettledFormat,
  readHotelSupplierAiImportWorkspaceHandler, decideHotelSupplierAiImportRowsHandler, completeHotelSupplierAiImportReviewHandler, applyHotelSupplierAiImportMappingHandler,
  applyHotelSupplierImportFormatHandler, applyHotelSupplierImportFormat,
  readHotelSupplierAiImportWorkspace, decideHotelSupplierAiImportRows, completeHotelSupplierAiImportReview, applyHotelSupplierAiImportMapping };
