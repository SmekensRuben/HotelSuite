const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { admin } = require("./config");
const { requireDocumentId } = require("./subscriptions");
const { digest, revision } = require("./validation");
const { requireHotelPermission } = require("./authorization");
const { gated } = require("./saasRollout");

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
  const value = row.purchaseUnitMapping?.sourceUnit ?? row.originalInput?.purchaseUnit;
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
    humanPurchaseUnit: Object.hasOwn(row.userPatch || {}, "purchaseUnit") };
}
function writeIndex(tx, db, hotelUid, jobId, row) {
  tx.set(db.doc(`${jobPath(hotelUid, jobId)}/reviewIndex/${row.rowId}`), indexRow(row));
}
function publicIndex(row) {
  return Object.fromEntries(["rowId", "reviewRevision", "category", "requiresUpdate", "name", "sku", "reviewStatus", "committedStatus", "needsAttention", "bulkEligible", "canApprove", "failed", "sourceUnit", "purchaseUnit", "humanPurchaseUnit"].map((key) => [key, row[key] ?? null]));
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
      if (digest(indexRow(row)) !== digest(selected[index])) throw new HttpsError("failed-precondition", "The row and review index disagree. Refresh this import.");
      return internals().publicRow(row);
    });
    return { hotelUid, jobId, supplierId: job.supplierId, status: job.status, importReviewVersion: REVIEW_VERSION,
      totalRows: job.totalRows, counts: job.counts, ...publicReviewCounts(job.reviewState, job.totalRows), rows,
      ...(input.includeIndex !== false ? { index: index.map(publicIndex) } : {}),
      nextCursor: !focus && filtered.length > limit ? selected.at(-1).rowId : null,
      summary: require("./supplierAiImports").publicJob(job).summary,
      sourceFormat: job.purchaseUnitMappingSnapshot?.sourceFormat ?? job.fileName?.split(".").at(-1)?.toLowerCase() ?? null, profileId: job.purchaseUnitMappingSnapshot?.profileId ?? "default",
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
        const raw = { ...Object.fromEntries(internals().RAW_FIELDS.map((field) => [field, null])), ...row.inputPatch,
          sourceAnchors: row.sourceAnchors, sourceEvidenceIssues: row.sourceEvidenceIssues || [],
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
        const next = internals().buildSupplierAiCandidate({ hotelUid, jobId, supplierId: job.supplierId, rowIndex: row.rowIndex,
          raw: mapped, previous, productId, userPatch, reviewRevision: row.reviewRevision + 1,
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

const options = { region: "us-central1", cors: true, timeoutSeconds: 120 };
const readHotelSupplierAiImportWorkspace = onCall(options, gated(readHotelSupplierAiImportWorkspaceHandler));
const decideHotelSupplierAiImportRows = onCall(options, gated(decideHotelSupplierAiImportRowsHandler));
const completeHotelSupplierAiImportReview = onCall(options, gated(completeHotelSupplierAiImportReviewHandler));
const applyHotelSupplierAiImportMapping = onCall(options, gated(applyHotelSupplierAiImportMappingHandler));
module.exports = { REVIEW_VERSION, MAX_REVIEW_BATCH, emptyReviewState, adjustReviewState, validateReviewState, publicReviewCounts,
  reviewStatus, canApprove, bulkEligible, publicReview, indexRow, writeIndex,
  readHotelSupplierAiImportWorkspaceHandler, decideHotelSupplierAiImportRowsHandler, completeHotelSupplierAiImportReviewHandler, applyHotelSupplierAiImportMappingHandler,
  readHotelSupplierAiImportWorkspace, decideHotelSupplierAiImportRows, completeHotelSupplierAiImportReview, applyHotelSupplierAiImportMapping };
