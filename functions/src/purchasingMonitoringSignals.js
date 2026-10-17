const { isDeepStrictEqual } = require("node:util");
const { classifyPurchasingSignal, observation, thresholdsFor, milliseconds, evidenceTime, safeIdentifier, sourceIdentifier } = require("./purchasingMonitoringPolicy");

// Each evaluation reads at most 450 documents, including cursor/limit state and
// two immutable confirmation events or one active catalog operation per item.
// ID rotation includes legacy records without timestamps and needs no new index.
const SOURCES = Object.freeze([
  { collection: "dispatches", process: "dispatches", maximum: 15 },
  { collection: "orders", process: "supplier-confirmations", maximum: 12 },
  { collection: "mailQueue", process: "mail-queue", maximum: 15 },
  { collection: "supplierAiImportJobs", process: "supplier-imports", maximum: 30 },
  { collection: "catalogSyncJobs", process: "catalog-sync", maximum: 12 },
  { collection: "scheduledMailReceipts", process: "scheduled-mail", maximum: 30 },
  { collection: "importRuns", process: "imports", maximum: 30 },
  { collection: "workflowTelemetry", process: "workflow", maximum: 30 },
  { collection: "contractReminderRuns", process: "contract-reminders", maximum: 20 },
  { collection: "importTelemetry", process: "imports-preflight", maximum: 15 },
]);
const PROJECTED_FIELDS = ["status", "state", "orderId", "purchaseRequestId", "dispatchRequestId", "supplierId", "jobId", "runId",
  "environment", "dispatchEnvironment", "deliveryMode", "dispatchMode", "simulated", "via", "externalAttempt", "providerId", "remotePath",
  "manuallyReconciled", "reviewedBy", "receiptSource", "recoveredFrom", "recoveredByMailId", "recoveryOf", "replacementDispatchId", "event", "recipientUid", "hotelUid",
  "enabled", "paused", "errorCode", "updatedAtMillis", "updatedAt", "completedAtMillis", "completedAt", "sentAt", "failedAt", "reviewedAt",
  "processingAt", "attemptedAt", "queuedAt", "startedAtMillis", "startedAt", "createdAt", "leaseUntilMillis", "leaseUntil", "retryCount", "attemptCount",
  "type", "downstreamStatus", "descriptor.fileType", "fileType", "result.writtenCount", "result.affectsStayPattern", "completedChunks", "totalChunks",
  "supplierConfirmation", "revision", "dispatchStatus", "dispatchedAt", "aiRefinementState", "expiresAtMillis", "poolComplete",
  "schemaVersion", "process", "origin", "code", "count", "firstOccurredAtMillis", "lastOccurredAtMillis", "reviewedThroughMillis", "expiresAt", "correlationId"];

function confirmationSummary(value) {
  if (!value || value.policyVersion !== 1 || !safeIdentifier(value.responseId)
    || value.reviewId !== null && !safeIdentifier(value.reviewId)
    || !Number.isSafeInteger(value.eventCount) || value.eventCount < 1 || value.eventCount > 500
    || !["accepted", "changes-proposed", "rejected"].includes(value.responseType)
    || !["not-required", "accepted", "pending", "follow-up"].includes(value.reviewState)
    || typeof value.requiresAttention !== "boolean" || !/^\d{4}-\d\d-\d\d$/.test(value.respondedOn || "")) return false;
  return value.requiresAttention === (value.responseType !== "accepted" && value.reviewState !== "accepted")
    && (value.responseType === "accepted" ? value.reviewState === "not-required" && value.reviewId === null
      : value.reviewState !== "not-required" && (value.reviewState === "pending") === (value.reviewId === null)
        && !(value.responseType === "rejected" && value.reviewState === "accepted"));
}
async function verifiedConfirmation(db, hotelUid, row, record, readCount) {
  const summary = record.supplierConfirmation;
  if (!confirmationSummary(summary) || !Number.isSafeInteger(record.revision) || record.revision < 1) return false;
  const base = `hotels/${hotelUid}/orders/${row.id}/supplierConfirmations`;
  const ids = [summary.responseId, ...(summary.reviewId ? [summary.reviewId] : [])];
  const snapshots = await Promise.all(ids.map((id) => db.doc(`${base}/${id}`).get()));
  readCount.value += ids.length;
  const response = snapshots[0].data(), review = snapshots[1]?.data();
  const valid = (event, kind) => event && event.policyVersion === 1 && event.kind === kind && event.hotelUid === hotelUid
    && event.orderId === row.id && safeIdentifier(event.actorUid) && Number.isSafeInteger(event.revision)
    && event.revision >= 1 && event.revision <= record.revision;
  if (!valid(response, "response") || response.response?.responseType !== summary.responseType || response.response?.respondedOn !== summary.respondedOn) return false;
  if (summary.reviewId && (!valid(review, "review") || review.review?.responseId !== summary.responseId
    || review.revision <= response.revision || review.review?.decision !== (summary.reviewState === "accepted" ? "accept" : "follow-up"))) return false;
  // These immutable server-owned events carry the same acknowledgement returned
  // by the protected domain command. A loose mutable order status is insufficient.
  return isDeepStrictEqual((review || response).result?.supplierConfirmation, summary);
}
function readFailure(process, id, now) {
  return observation(process, id, { updatedAtMillis: now }, "unknown", "source-read-unavailable",
    "This source could not be inspected.", "Check the evaluator permissions, indexes and source availability.", "warning");
}
async function recoveredDelivery(db, hotelUid, process, id, record, config, now, readCount) {
  let replacement, replacementId;
  if (process === "dispatches" && record.status === "superseded" && safeIdentifier(record.replacementDispatchId)) {
    replacementId = record.replacementDispatchId;
    replacement = await db.doc(`hotels/${hotelUid}/dispatches/${replacementId}`).get(); readCount.value++;
    if (!replacement.exists || replacement.data().recoveryOf !== id || replacement.data().orderId !== record.orderId) return null;
  } else if (process === "mail-queue" && record.type === "purchase-request" && safeIdentifier(record.recoveredByMailId)) {
    replacementId = record.recoveredByMailId;
    replacement = await db.doc(`hotels/${hotelUid}/mailQueue/${replacementId}`).get(); readCount.value++;
    const data = replacement.data();
    if (!replacement.exists || data.recoveredFrom !== id || data.hotelUid !== hotelUid || data.type !== "purchase-request"
      || data.purchaseRequestId !== record.purchaseRequestId || data.revision !== record.revision || data.event !== record.event || data.recipientUid !== record.recipientUid) return null;
  } else if (process === "mail-queue" && record.status === "superseded" && record.type === "order-confirmation"
    && safeIdentifier(record.dispatchRequestId)) {
    const dispatch = await db.doc(`hotels/${hotelUid}/dispatches/${record.dispatchRequestId}`).get(); readCount.value++;
    replacementId = safeIdentifier(dispatch.data()?.replacementDispatchId);
    if (!dispatch.exists || dispatch.data().orderId !== record.orderId || !replacementId) return null;
    replacement = await db.doc(`hotels/${hotelUid}/dispatches/${replacementId}`).get(); readCount.value++;
    if (!replacement.exists || replacement.data().orderId !== record.orderId || replacement.data().recoveryOf !== record.dispatchRequestId) return null;
  } else return null;
  const underlyingProcess = process === "mail-queue" && record.type === "order-confirmation" ? "dispatches" : process;
  const result = classifyPurchasingSignal(underlyingProcess, replacementId, replacement.data(), config, now);
  if (result?.status !== "healthy") return null;
  return { ...result, process, sourceId: sourceIdentifier(id), code: "replacement-delivery-accepted",
    summary: "An explicitly linked recovery attempt has a verified transport result; supplier acceptance remains separate.",
    nextStep: "Keep the original failure and replacement receipt as correlated recovery evidence.",
    metadata: { ...result.metadata, recoveredSourceId: sourceIdentifier(replacementId) } };
}
function currentCursor(value) {
  const id = value?.afterId;
  return typeof id === "string" && id.length > 0 && Buffer.byteLength(id, "utf8") <= 1500 && !/[\/\u0000-\u001f]/.test(id) && ![".", ".."].includes(id)
    ? value : { ...value, afterId: null, cycleStartedAtMillis: null, lastCompletedCycleAtMillis: value?.lastCompletedCycleAtMillis ?? null };
}
async function collectSource(db, hotelUid, source, config, now, storedCursor, readCount) {
  const limit = Math.min(source.maximum, config.maxDocumentsPerSource ?? 50), cursor = currentCursor(storedCursor);
  const pendingOperations = { ...(cursor.pendingOperations || {}) };
  let query = db.collection(`hotels/${hotelUid}/${source.collection}`).orderBy("__name__");
  if (cursor.afterId) query = query.startAfter(cursor.afterId);
  const result = await query.select(...PROJECTED_FIELDS).limit(limit + 1).get();
  readCount.value += result.size;
  const rows = result.docs.slice(0, limit), hasMore = result.size > limit;
  const partial = Boolean(cursor.afterId) || hasMore;
  const observations = [], evidenceTimes = [];
  let queued = 0;
  for (const row of rows) {
    let record = row.data();
    if (source.process === "imports-preflight") {
      const run = await db.doc(`hotels/${hotelUid}/importRuns/${row.id}`).get();
      readCount.value++;
      if (run.exists) {
        if (run.data().state !== "complete" && record.errorCode !== "import-preflight-failed") continue;
        record = run.data();
      } else if (["succeeded", "empty"].includes(record.status)) {
        observations.push(observation(source.process, row.id, record, "unknown", "import-run-evidence-missing",
          "The normalized import result has no retained processing run.", "Reconcile the original run and source identity before treating the import as completed.", "warning"));
        continue;
      }
    }
    const at = evidenceTime(record);
    if (at !== null) evidenceTimes.push(at);
    if (["queued", "pending", "received"].includes(record.status ?? record.state)) queued++;
    if (source.process === "workflow") {
      const expiry = milliseconds(record.expiresAt);
      if (expiry !== null && expiry <= now) continue;
    }
    if (source.process === "supplier-confirmations" && record.supplierConfirmation) {
      try { record.confirmationEvidenceVerified = await verifiedConfirmation(db, hotelUid, row, record, readCount); }
      catch { record.confirmationEvidenceVerified = false; }
    }
    let item = classifyPurchasingSignal(source.process === "imports-preflight" && record.state ? "imports" : source.process, row.id, record, config, now);
    if (["dispatches", "mail-queue"].includes(source.process)) {
      try { item = await recoveredDelivery(db, hotelUid, source.process, row.id, record, config, now, readCount) || item; }
      catch { item = readFailure(source.process, row.id, now); }
    }
    if (item) {
      item.process = source.process;
      const fileType = safeIdentifier(record.descriptor?.fileType) || safeIdentifier(record.fileType);
      if (fileType) item.metadata.fileType = fileType;
      observations.push(item);
    }
    if (source.process === "catalog-sync") {
      const jobKey = sourceIdentifier(row.id), currentOperationId = safeIdentifier(record.aiRefinementState?.activeOperationId);
      // A completed optional operation clears the source's active pointer. Keep
      // one previously observed reference until its explicit result is inspected.
      const previousOperationId = safeIdentifier(pendingOperations[jobKey]);
      const operationId = previousOperationId || currentOperationId;
      if (operationId) {
        if (Object.hasOwn(pendingOperations, jobKey) || Object.keys(pendingOperations).length < 100) pendingOperations[jobKey] = operationId;
        else observations.push(observation("catalog-sync", "operation-followup-capacity", { updatedAtMillis: now }, "unknown", "catalog-followup-capacity-exceeded",
          "The bounded catalog operation follow-up capacity was reached.", "Review retained catalog incidents and evaluator capacity; untracked operations remain unknown.", "warning"));
        try {
          const operation = await db.doc(`hotels/${hotelUid}/catalogSyncJobs/${row.id}/aiOperations/${operationId}`).get();
          readCount.value++;
          const active = operation.exists ? classifyPurchasingSignal("catalog-sync", `${row.id}:${operationId}`, { ...operation.data(), jobId: row.id }, config, now)
            : observation("catalog-sync", `${row.id}:${operationId}`, { jobId: row.id }, "unknown", "catalog-operation-missing",
              "The active catalog operation has no retained evidence.", "Reconcile the catalog suggestion and its usage reservation.", "warning");
          if (active) observations.push(active);
          if (active && ["healthy", "failed"].includes(active.status)) {
            if (currentOperationId && currentOperationId !== operationId) pendingOperations[jobKey] = currentOperationId;
            else delete pendingOperations[jobKey];
          }
        } catch { observations.push(readFailure("catalog-sync", `${row.id}:${operationId}`, now)); }
      }
    }
  }
  const thresholds = thresholdsFor(config);
  const cycleStartedAtMillis = cursor.cycleStartedAtMillis || now;
  const coverage = { process: source.process, status: partial ? "unknown" : rows.length ? "observed" : "no-workload",
    inspected: rows.length, truncated: partial, hasMore, oldestEvidenceAtMillis: evidenceTimes.length ? Math.min(...evidenceTimes) : null,
    cycleStartedAtMillis, lastCompletedCycleAtMillis: hasMore ? cursor.lastCompletedCycleAtMillis ?? null : now,
    nextCursor: hasMore ? sourceIdentifier(rows.at(-1).id) : null, pendingCountLowerBound: queued };
  const next = { afterId: hasMore ? rows.at(-1).id : null, cycleStartedAtMillis: hasMore ? cycleStartedAtMillis : null,
    lastCompletedCycleAtMillis: coverage.lastCompletedCycleAtMillis,
    ...(source.process === "catalog-sync" ? { pendingOperations } : {}) };
  if (hasMore && now - cycleStartedAtMillis > thresholds.staleScanMinutes * 60000) {
    observations.push(observation(source.process, "scan-coverage", { updatedAtMillis: now }, "unknown", "scan-cycle-overdue",
      "The bounded source scan has not completed within the configured coverage period.", "Review collection size and evaluator capacity; unseen records remain unknown.", "warning"));
  } else if (!hasMore) {
    observations.push(observation(source.process, "scan-coverage", { updatedAtMillis: now }, "healthy", "scan-cycle-complete",
      "The bounded source scan completed a rotation.", "Continue periodic evaluation; earlier pages retain their own observation times."));
  }
  if (source.process === "catalog-sync" && Object.keys(pendingOperations).length < 100) {
    observations.push(observation("catalog-sync", "operation-followup-capacity", { updatedAtMillis: now }, "healthy", "catalog-followup-capacity-available",
      "The retained catalog operation follow-up references are within their bounded capacity.", "Continue inspecting explicit operation results before clearing follow-up references."));
  }
  return { observations, coverage, next };
}
async function collectBacklog(db, hotelUid, source, config, now, readCount) {
  const threshold = thresholdsFor(config).backlogCount, limit = Math.min(threshold, 40);
  const result = await db.collection(`hotels/${hotelUid}/${source.collection}`)
    .where("status", "in", ["queued", "pending", "received"]).select("status").limit(limit + 1).get();
  readCount.value += result.size;
  const bounded = result.size > limit, high = result.size >= threshold;
  const item = observation(source.process, "queue-backlog", { updatedAtMillis: now }, high ? "needs-review" : bounded ? "unknown" : "healthy",
    high ? "queue-backlog-threshold" : bounded ? "queue-backlog-unbounded" : "queue-backlog-within-threshold",
    high ? "The pending queue reached its configured backlog threshold." : bounded ? "The bounded queue probe cannot establish the configured backlog count." : "The complete pending queue is below the configured backlog threshold.",
    high || bounded ? "Inspect worker capacity and pending operation age; the bounded count may be a lower bound." : "Continue checking pending operation age separately.", high || bounded ? "warning" : "info");
  item.metadata = { pendingCountLowerBound: result.size, countIsLowerBound: bounded };
  return item;
}
function limitObservation(id, ratio, config, now, values = {}) {
  const high = ratio >= thresholdsFor(config).limitWarningRatio;
  const item = observation("purchasing-limits", id, { updatedAtMillis: now }, high ? "needs-review" : "healthy",
    high ? "configured-limit-near" : "configured-limit-available", high ? "Usage is near or at a configured operation limit." : "Verified usage is below the configured warning ratio.",
    high ? "Review the configured limit, concurrency and retained reservations; do not increase limits automatically." : "Continue observing usage and retained reservations.", high ? "warning" : "info");
  item.metadata = { ...values, usageRatio: Math.round(ratio * 1000) / 1000 };
  return item;
}
async function collectLimits(db, hotelUid, config, now, readCount) {
  const result = (status, observations = [], capacityVerified = false) => ({ observations,
    coverage: { process: "purchasing-limits", status, inspected: 3, truncated: false, capacityVerified } });
  const month = new Date(now).toISOString().slice(0, 7), day = new Date(now).toISOString().slice(0, 10);
  const snapshots = await Promise.all([db.doc("platformConfiguration/aiSupplierProductImport").get(),
    db.doc(`hotels/${hotelUid}/aiUsageMonths/${month}`).get(), db.doc(`hotels/${hotelUid}/aiImportAdministration/state`).get()]);
  readCount.value += 3;
  const [policy, usage, active] = snapshots.map((snapshot) => snapshot.data());
  if (!snapshots[0].exists) return result("paused", [observation("purchasing-limits", "supplier-ai", { updatedAtMillis: now }, "paused", "supplier-ai-not-configured",
    "Paid supplier AI processing is not configured.", "Deterministic imports and explicit environment activation remain separate.")]);
  const amounts = [policy.maxConcurrentJobsPerHotel, policy.maxImportsPerHotelPerDay, policy.maxMonthlyCostPerHotelUsd];
  if (amounts.some((value) => !Number.isFinite(value) || value <= 0) || typeof policy.enabled !== "boolean") return result("unknown", [readFailure("purchasing-limits", "supplier-ai", now)]);
  if (!policy.enabled) {
    const results = [observation("purchasing-limits", "supplier-ai", { updatedAtMillis: now }, "paused", "supplier-ai-disabled",
      "Paid supplier AI processing is explicitly disabled.", "Review environment configuration before activating paid processing.")];
    if (Number.isSafeInteger(usage?.reservedCostMicros) && usage.reservedCostMicros >= 0) {
      const retained = usage.reservedCostMicros > 0;
      results.push(observation("purchasing-limits", "supplier-ai-reservations", { updatedAtMillis: now }, retained ? "needs-review" : "healthy",
        retained ? "retained-ai-reservations" : "retained-ai-reservations-cleared", retained ? "A disabled paid-AI workflow still has retained usage reservations." : "Retained usage accounting confirms that no reservation remains.",
        "Reconcile the provider accounting before releasing reservations or activating paid processing.", retained ? "warning" : "info"));
    }
    return result("paused", results);
  }
  if (!snapshots[1].exists && !snapshots[2].exists) return result("no-workload");
  if (!snapshots[1].exists || !snapshots[2].exists) return result("unknown", [observation("purchasing-limits", "supplier-ai", { updatedAtMillis: now }, "unknown", "usage-evidence-unavailable",
    "The retained supplier AI usage accounting is incomplete.", "Keep absent accounting separate from verified available capacity.")]);
  const known = usage?.knownCostMicros ?? (snapshots[1].exists ? null : 0);
  const reserved = usage?.reservedCostMicros ?? (snapshots[1].exists ? null : 0);
  const jobs = active?.activeJobs ?? (snapshots[2].exists ? null : 0);
  const usedToday = usage?.days?.[day] ?? 0;
  if ([known, reserved, jobs, usedToday].some((value) => !Number.isSafeInteger(value) || value < 0)) return result("unknown", [readFailure("purchasing-limits", "supplier-ai", now)]);
  const results = [observation("purchasing-limits", "supplier-ai", { updatedAtMillis: now }, "healthy", "supplier-ai-usage-verified",
    "Supplier AI usage accounting is available for the current hotel and month.", "Review the separately evaluated concurrency, daily count and budget thresholds."),
  limitObservation("supplier-ai-concurrency", jobs / policy.maxConcurrentJobsPerHotel, config, now, { activeJobs: jobs }),
    limitObservation("supplier-ai-daily", usedToday / policy.maxImportsPerHotelPerDay, config, now, { importsToday: usedToday }),
    limitObservation("supplier-ai-budget", (known + reserved) / (policy.maxMonthlyCostPerHotelUsd * 1000000), config, now,
      { knownCostMicros: known, reservedCostMicros: reserved })];
  if (reserved === 0) results.push(observation("purchasing-limits", "supplier-ai-reservations", { updatedAtMillis: now }, "healthy", "retained-ai-reservations-cleared",
    "Retained usage accounting confirms that no reservation remains.", "Continue observing provider accounting and retained reservations."));
  return result("observed", results, true);
}
async function collectBackgroundWorkers(db, config, now, readCount) {
  if (config.environment === "staging") return observation("background-workers", "contract-reminders", { updatedAtMillis: now }, "paused", "scheduled-worker-disabled",
    "Scheduled external contract reminder work is disabled in staging.", "Verify scheduled execution separately after explicit production activation.");
  const snapshot = await db.doc("platformWorkerHealth/contract-reminders").get();
  readCount.value++;
  const data = snapshot.data() || {};
  const success = milliseconds(data.lastSuccessfulAtMillis), failure = milliseconds(data.lastFailureAtMillis), attempt = milliseconds(data.lastAttemptAtMillis);
  const observed = Math.max(success || 0, failure || 0, attempt || 0);
  const emit = (...args) => observation("background-workers", "contract-reminders", { ...data, updatedAtMillis: observed || null }, ...args);
  if (!snapshot.exists || data.environment !== config.environment || [success, failure, attempt].some((value) => value !== null && value > now + 60000)) {
    return emit("unknown", "scheduled-worker-evidence-unavailable", "The scheduled reminder worker has no reliable evidence for this environment.", "Verify the deployed scheduler, invocation logs and worker heartbeat.", "warning");
  }
  if (attempt !== null && attempt > Math.max(success || 0, failure || 0)) return emit(now - attempt > thresholdsFor(config).processingMinutes * 60000 ? "stalled" : "processing",
    "scheduled-worker-processing", "The scheduled reminder worker has an unfinished attempt.", "Inspect invocation progress and delivery receipts before any operator recovery.", "warning");
  if (failure !== null && (success === null || failure > success)) return emit("failed", "scheduled-worker-failed", "The scheduled reminder worker failed after its latest successful scan.", "Inspect scheduler and worker logs; reconcile individual delivery receipts before recovery.", "warning");
  if (success === null) return emit("unknown", "scheduled-worker-success-unavailable", "The scheduled reminder worker has no confirmed successful scan.", "Verify scheduler invocation and a completed worker heartbeat.", "warning");
  if (now - success > thresholdsFor(config).scheduledWorkerHours * 3600000) return emit("stalled", "scheduled-worker-overdue", "The scheduled reminder worker has not completed within its configured observation period.", "Check the enabled scheduler, invocation authority and worker logs.", "warning");
  return observation("background-workers", "contract-reminders", { ...data, updatedAtMillis: success }, "healthy", "scheduled-worker-completed",
    "The scheduled reminder scan completed; email transport has separate delivery receipts.", "Use scheduled delivery receipts to verify individual email acceptance.");
}
async function collectPurchasingSignals(db, hotelUid, config, now = Date.now()) {
  if (!safeIdentifier(hotelUid) || !Number.isFinite(now) || now <= 0) throw new Error("A valid hotel and evaluation time are required.");
  if (config?.maxDocumentsPerSource != null && (!Number.isSafeInteger(config.maxDocumentsPerSource) || config.maxDocumentsPerSource < 1 || config.maxDocumentsPerSource > 50)) {
    throw new Error("The source scan limit must be between 1 and 50.");
  }
  thresholdsFor(config);
  const subscription = await db.doc(`hotelSubscriptions/${hotelUid}`).get(), subscriptionData = subscription.data();
  const { subscriptionIsActive } = require("./subscriptions");
  const { modulesAreValid, moduleAllows } = require("./modulePolicy");
  const validSubscription = subscription.exists && ["active", "trialing", "suspended", "canceled"].includes(subscriptionData?.status)
    && modulesAreValid(subscriptionData) && (subscriptionData.validUntil == null || milliseconds(subscriptionData.validUntil) !== null);
  if (!validSubscription || !subscriptionIsActive(subscriptionData, now) || !moduleAllows(subscriptionData, "procurement")) {
    const status = validSubscription ? "paused" : "unknown";
    return { observations: [observation("purchasing-limits", "subscription", { updatedAtMillis: now }, status,
      validSubscription ? "procurement-inactive" : "subscription-evidence-unavailable",
      validSubscription ? "Procurement monitoring is paused for this hotel's subscription." : "The hotel's subscription evidence is missing or invalid.",
      "Review the hotel's active subscription and explicit module configuration.", validSubscription ? "info" : "warning")],
    coverage: SOURCES.map((source) => ({ process: source.process, status, inspected: 0, truncated: true })),
    cursors: {}, inspected: 0, readCount: 1, readBound: 450, computedAtMillis: now };
  }
  const cursorRef = db.doc(`hotels/${hotelUid}/platformHealth/purchasingScan`), previous = await cursorRef.get();
  const version = previous.data()?.version ?? 0, previousCursors = previous.data()?.sources || {};
  const observations = [], coverage = [], cursors = { ...previousCursors }, readCount = { value: 2 };
  observations.push(observation("purchasing-limits", "subscription", { updatedAtMillis: now }, "healthy", "procurement-subscription-verified",
    "The hotel has an active subscription with the procurement module.", "Continue checking source workflows and environment configuration separately."));
  const results = await Promise.allSettled(SOURCES.map((source) => collectSource(db, hotelUid, source, config, now, previousCursors[source.collection], readCount)));
  results.forEach((result, index) => {
    const source = SOURCES[index];
    if (result.status === "fulfilled") {
      observations.push(...result.value.observations); coverage.push(result.value.coverage); cursors[source.collection] = result.value.next;
    } else {
      observations.push(readFailure(source.process, "scan-coverage", now));
      coverage.push({ process: source.process, status: "unknown", inspected: 0, truncated: true, readError: true, oldestEvidenceAtMillis: null });
    }
  });
  for (const source of SOURCES.filter((item) => ["dispatches", "mail-queue", "supplier-imports"].includes(item.process))) {
    try { observations.push(await collectBacklog(db, hotelUid, source, config, now, readCount)); }
    catch { observations.push(readFailure(source.process, "queue-backlog", now)); }
  }
  try {
    const limits = await collectLimits(db, hotelUid, config, now, readCount);
    observations.push(...limits.observations); coverage.push(limits.coverage);
  } catch {
    observations.push(readFailure("purchasing-limits", "supplier-ai", now));
    coverage.push({ process: "purchasing-limits", status: "unknown", inspected: 0, truncated: true, readError: true });
  }
  try {
    const worker = await collectBackgroundWorkers(db, config, now, readCount);
    observations.push(worker);
    coverage.push({ process: "background-workers", status: worker.status === "healthy" ? "observed" : worker.status,
      inspected: config.environment === "staging" ? 0 : 1, truncated: false });
  } catch {
    observations.push(readFailure("background-workers", "contract-reminders", now));
    coverage.push({ process: "background-workers", status: "unknown", inspected: 0, truncated: true, readError: true });
  }
  // A concurrent manual refresh must not rewind a worker's cursor. Only this
  // server-owned metadata is written; domain records and retries stay untouched.
  await db.runTransaction(async (tx) => {
    const current = await tx.get(cursorRef);
    if ((current.data()?.version ?? 0) !== version || (current.data()?.checkedAtMillis || 0) > now) return;
    tx.set(cursorRef, { schemaVersion: 1, version: version + 1, checkedAtMillis: now, sources: cursors });
  });
  return { observations, coverage, cursors, inspected: coverage.reduce((count, item) => count + item.inspected, 0), readCount: readCount.value,
    readBound: 450, configuration: { maxDocumentsPerSource: config.maxDocumentsPerSource ?? 50 }, computedAtMillis: now };
}

module.exports = { SOURCES, collectPurchasingSignals };
