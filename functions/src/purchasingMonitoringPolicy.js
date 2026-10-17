const { createHash } = require("node:crypto");

const DEFAULT_PURCHASING_THRESHOLDS = Object.freeze({ pendingMinutes: 15, processingMinutes: 30,
  supplierConfirmationHours: 24, reviewHours: 48, backlogCount: 20, retryCount: 3,
  limitWarningRatio: 0.8, staleScanMinutes: 60, scheduledWorkerHours: 30 });
const DELIVERY_PROCESSES = new Set(["dispatches", "mail-queue", "scheduled-mail"]);
const WORKFLOW_PROCESSES = new Set(["purchase-requests", "orders", "stock-counts", "contracts", "supplier-imports", "catalog-sync"]);
const TELEMETRY_CODES = new Set(["internal", "unavailable", "deadline-exceeded", "unknown", "render-failed"]);

function milliseconds(value) {
  try {
    const result = typeof value === "number" ? value : value instanceof Date ? value.getTime() : value?.toMillis?.();
    return Number.isFinite(result) && result > 0 && result <= 8640000000000000 ? result : null;
  } catch { return null; }
}
function safeIdentifier(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value) ? value : null;
}
function sourceIdentifier(value) {
  return safeIdentifier(value) || `opaque-${createHash("sha256").update(typeof value === "string" ? value : "invalid").digest("hex").slice(0, 32)}`;
}
function thresholdsFor(config = {}) {
  const result = { ...DEFAULT_PURCHASING_THRESHOLDS, ...config.thresholds };
  for (const key of Object.keys(DEFAULT_PURCHASING_THRESHOLDS)) {
    if (!Number.isFinite(result[key]) || result[key] <= 0 || key === "limitWarningRatio" && result[key] > 1) {
      throw new Error("Purchasing monitoring thresholds are invalid.");
    }
  }
  return result;
}
function evidenceTime(record) {
  const values = [record.lastOccurredAtMillis, record.updatedAtMillis, record.updatedAt, record.completedAtMillis,
    record.completedAt, record.sentAt, record.failedAt, record.reviewedAt, record.processingAt,
    record.attemptedAt, record.queuedAt, record.startedAtMillis, record.startedAt, record.createdAt, record.firstOccurredAtMillis];
  return values.map(milliseconds).find((value) => value !== null) ?? null;
}
function safeMetadata(record) {
  const result = {};
  for (const key of ["orderId", "purchaseRequestId", "dispatchRequestId", "supplierId", "runId", "jobId", "recoveredFrom", "recoveredByMailId", "recoveryOf", "replacementDispatchId"]) {
    const value = safeIdentifier(record[key]);
    if (value) result[key] = value;
  }
  if (["production", "staging", "test"].includes(record.environment)) result.sourceEnvironment = record.environment;
  if (["purchase-request", "order-confirmation", "order-approval", "hotel-invitation"].includes(record.type)) result.mailType = record.type;
  if (typeof record.externalAttempt === "boolean") result.externalAttempt = record.externalAttempt;
  for (const key of ["retryCount", "attemptCount", "count", "completedChunks", "totalChunks"]) {
    if (Number.isSafeInteger(record[key]) && record[key] >= 0) result[key] = Math.min(record[key], 1000000000);
  }
  return result;
}
function observation(process, id, record, status, code, summary, nextStep, severity = "info") {
  const correlationId = safeIdentifier(record.correlationId) || safeIdentifier(record.dispatchRequestId)
    || safeIdentifier(record.orderId) || safeIdentifier(record.purchaseRequestId) || sourceIdentifier(id);
  return { process, sourceId: sourceIdentifier(id), status, code, severity, summary, nextStep,
    evidenceAtMillis: evidenceTime(record), correlationId, metadata: safeMetadata(record) };
}
function classifyPurchasingSignal(process, id, record = {}, config = {}, now = Date.now()) {
  const thresholds = thresholdsFor(config);
  const emit = (...args) => observation(process, id, record, ...args);
  const at = evidenceTime(record), elapsed = at === null ? null : now - at;
  const status = record.status ?? record.state;
  if (at !== null && at > now + 60000) return emit("unknown", "future-evidence", "The source timestamp is ahead of the evaluator.", "Check the source clock and evidence before deciding recovery.", "warning");
  const simulated = record.simulated === true || status === "simulated" || record.deliveryMode === "simulation"
    || record.dispatchMode === "simulation" || record.via === "simulation";
  if (simulated) return emit("simulated", "simulation-only", "This operation was simulated; no real delivery is established.", "Use production evidence to verify an actual delivery.");
  if (record.environment && record.environment !== config.environment && config.environment) {
    return emit("unknown", "environment-mismatch", "The source belongs to a different environment.", "Inspect the configured environment and source ownership.", "warning");
  }
  if (DELIVERY_PROCESSES.has(process) && status === "sent" && (record.environment === "staging" || record.dispatchEnvironment === "staging")) {
    return emit("unknown", "staging-transport-unverified", "A staging sent status has no explicit simulation evidence.", "Reconcile the environment and simulation marker; do not treat it as a real supplier delivery.", "warning");
  }
  if (process === "workflow") {
    if (!WORKFLOW_PROCESSES.has(record.process) || !TELEMETRY_CODES.has(record.code)
      || !["frontend", "backend"].includes(record.origin) || !Number.isSafeInteger(record.count) || record.count < 1 || at === null) {
      return emit("unknown", "workflow-evidence-invalid", "Workflow error telemetry is incomplete.", "Inspect the telemetry writer; do not infer a business operation result.", "warning");
    }
    if (elapsed > thresholds.reviewHours * 3600000 || (milliseconds(record.reviewedThroughMillis) ?? 0) >= at) return null;
    const result = emit("needs-review", "unexpected-workflow-error", "An unexpected workflow error was recorded.", "Use the correlation reference to inspect the workflow; verify its persisted result before recovery.", "warning");
    result.metadata = { ...result.metadata, workflowProcess: record.process, origin: record.origin, failureClass: record.code };
    return result;
  }
  if (record.paused === true || record.enabled === false || ["paused", "disabled"].includes(status)) {
    return emit("paused", "operation-paused", "This operation is explicitly paused or disabled.", "Review the intended pause before changing its configuration.");
  }
  if (status === "superseded") return emit("paused", "operation-superseded", "An operator superseded this operation with a separate recovery attempt.", "Inspect the linked replacement and its explicit result; superseding alone does not prove successful delivery.");
  if (process === "contract-reminders") {
    if (config.environment === "staging") return emit("paused", "contract-delivery-disabled", "External contract reminder deliveries are disabled in staging.", "Use a separately activated production task and its transport receipts to verify delivery.");
    if (status === "failed") return emit("needs-review", "contract-reminder-run-failed", "The reminder task failed; individual deliveries may need reconciliation.", "Inspect scheduled delivery receipts and the task history before any operator retry.", "warning");
    if (status === "completed") {
      if (at === null) return emit("unknown", "completion-time-missing", "The completed reminder task has no reliable timestamp.", "Inspect its task evidence before closing an incident.", "warning");
      return emit("healthy", "contract-reminder-task-completed", "The reminder task completed; each email has a separate transport receipt.", "Check scheduled delivery receipts to verify individual transport acceptance.");
    }
  }
  if (process === "supplier-confirmations") {
    if (record.status === "Canceled") return emit("paused", "order-canceled", "The order is canceled.", "Keep its dispatch and supplier evidence for review.");
    if (!["Ordered", "Received", "Finalized"].includes(record.status) || record.dispatchStatus !== "sent") return null;
    const summary = record.supplierConfirmation;
    if (summary !== undefined) {
      if (!summary || summary.policyVersion !== 1 || record.confirmationEvidenceVerified !== true
        || !["accepted", "changes-proposed", "rejected"].includes(summary.responseType)
        || !["not-required", "accepted", "pending", "follow-up"].includes(summary.reviewState)
        || typeof summary.requiresAttention !== "boolean") {
        return emit("unknown", "supplier-confirmation-evidence-invalid", "The supplier confirmation evidence needs reconciliation.", "Open the order and reconcile its immutable supplier response history.", "warning");
      }
      if (summary.requiresAttention) return emit("needs-review", "supplier-response-review", "The supplier response requires hotel follow-up.", "Review the rejection or proposed changes in the order before receiving goods.", "warning");
      return emit("healthy", "supplier-response-recorded", "A supplier response and its required review are recorded.", "Keep receiving and transport acceptance separate from supplier confirmation.");
    }
    const sent = milliseconds(record.dispatchedAt);
    if (sent === null) return emit("unknown", "supplier-confirmation-age-unknown", "The order has no reliable dispatch time for supplier follow-up.", "Inspect historical order evidence before setting a follow-up deadline.", "warning");
    if (now - sent > thresholds.supplierConfirmationHours * 3600000) return emit("needs-review", "supplier-response-overdue", "No supplier response is recorded within the configured follow-up period.", "Contact the supplier and record its response; transport acceptance does not establish supplier acceptance.", "warning");
    return emit("processing", "supplier-response-pending", "Transport was accepted; a supplier response has not yet been recorded.", "Track the supplier response separately from transport delivery.");
  }
  if (status === "needs-review" || ["response_unknown", "response-unknown"].includes(status)) {
    return emit("needs-review", DELIVERY_PROCESSES.has(process) ? "delivery-unconfirmed" : "external-result-unconfirmed",
      "The external result is unconfirmed.", "Reconcile the provider or supplier evidence before any retry.", "critical");
  }
  if (status === "blocked") return emit("needs-review", "authorization-or-policy-blocked", "Current authority or environment policy blocked the operation.", "Review live subscription, permissions and environment policy before recovery.", "warning");
  if (status === "failed" || status === "error") {
    if (record.externalAttempt === true) return emit("needs-review", "delivery-unconfirmed", "A failed operation may already have reached the external service.", "Reconcile external evidence before any retry.", "critical");
    const limited = ["resource-exhausted", "quota-exceeded", "budget-exceeded"].includes(record.errorCode);
    if (process === "imports-preflight" && record.errorCode === "import-preflight-failed") return emit("failed", "import-preflight-failed",
      "The import failed before a processing run could be established.", "Review the canonical import configuration and source identity before operator recovery.", "warning");
    return emit("failed", limited ? "operation-limit-reached" : "operation-failed", limited ? "A configured operation limit was reached." : "The operation failed before a confirmed successful result.",
      limited ? "Inspect the configured limits and retained usage before operator recovery." : "Inspect the source configuration and its safe operation history before operator recovery.", "warning");
  }
  if (DELIVERY_PROCESSES.has(process) && status === "sent") {
    const manualReceipt = record.manuallyReconciled === true && safeIdentifier(record.reviewedBy) && milliseconds(record.reviewedAt) !== null
      && (process === "dispatches" ? ["email-provider", "sftp-transfer", "supplier-contact"].includes(record.receiptSource)
        : process === "mail-queue" && safeIdentifier(record.orderId) && safeIdentifier(record.dispatchRequestId));
    const acknowledged = manualReceipt || (process === "dispatches" && record.via === "sftp" ? typeof record.remotePath === "string" && record.remotePath.length > 0
      : typeof record.providerId === "string" && record.providerId.trim().length > 0);
    if (!acknowledged) return emit("unknown", "transport-receipt-missing", "A sent status has no usable transport acknowledgment.", "Reconcile the provider or SFTP receipt before treating this as a real delivery.", "warning");
    if (at === null) return emit("unknown", "transport-time-missing", "The transport acknowledgment has no reliable evidence timestamp.", "Reconcile the retained delivery receipt before closing its incident.", "warning");
    return emit("healthy", "transport-accepted", "The transport accepted the operation; supplier acceptance is tracked separately.", "Use the supplier response workflow to verify commercial acceptance.");
  }
  if (["complete", "completed", "committed", "succeeded", "ready"].includes(status)) {
    if (at === null) return emit("unknown", "completion-time-missing", "The completed status has no reliable evidence timestamp.", "Reconcile the completion evidence before closing its incident.", "warning");
    if (process === "imports" && (!Number.isSafeInteger(record.result?.writtenCount) || record.result.writtenCount < 0)) {
      return emit("unknown", "import-result-unavailable", "The completed import has no verified written-row count.", "Inspect its source checkpoints and recorded result.", "warning");
    }
    if (record.downstreamStatus === "failed") return emit("failed", "downstream-failed", "Source processing completed but its downstream step failed.", "Review the downstream workflow; preserve the completed source checkpoints.", "warning");
    if (record.downstreamStatus === "pending" || record.downstreamStatus === "unknown") return emit("unknown", "downstream-unconfirmed", "The source completed but its downstream result is unconfirmed.", "Verify the downstream workflow before closing the incident.", "warning");
    return emit("healthy", "operation-completed", "The operation has a recorded completed result.", "Keep the recorded source evidence for support.");
  }
  if (status === "review") {
    return emit("needs-review", "operator-review-pending", "The prepared proposal is waiting for operator review.", "Review and explicitly approve the proposal in its workflow.", "warning");
  }
  if (["queued", "pending", "received", "processing", "running", "counting", "responding"].includes(status)) {
    const pending = ["queued", "pending", "received"].includes(status);
    const lease = milliseconds(record.leaseUntilMillis) ?? milliseconds(record.leaseUntil);
    if (at === null) return emit("unknown", "operation-age-unknown", "The in-progress operation has no reliable evidence timestamp.", "Inspect the source record before deciding whether it is stalled.", "warning");
    const stale = lease !== null && !pending ? lease <= now : elapsed > (pending ? thresholds.pendingMinutes : thresholds.processingMinutes) * 60000;
    if (stale) {
      if (record.externalAttempt === true || status === "responding" || process === "scheduled-mail") {
        return emit("needs-review", "external-result-unconfirmed", "An in-progress operation exceeded its deadline after a possible external attempt.", "Reconcile provider evidence before any retry.", "critical");
      }
      return emit("stalled", pending ? "queue-age-exceeded" : "processing-age-exceeded", "The operation exceeded its configured progress deadline.", "Inspect the worker and its persisted checkpoints; recovery requires an operator decision.", "warning");
    }
    const retries = record.retryCount ?? record.attemptCount;
    if (Number.isSafeInteger(retries) && retries >= thresholds.retryCount) return emit("needs-review", "retry-threshold-reached", "The operation reached the configured attempt threshold.", "Inspect the attempt history and cause before further operator recovery.", "warning");
    return emit("processing", pending ? "operation-queued" : "operation-processing", "The operation is progressing within its configured deadline.", "Wait for a confirmed result and inspect again if the deadline expires.");
  }
  return emit("unknown", "source-status-unknown", "The source has no supported operation status.", "Inspect the source schema and its workflow evidence.", "warning");
}

module.exports = { DEFAULT_PURCHASING_THRESHOLDS, milliseconds, safeIdentifier, sourceIdentifier, evidenceTime,
  safeMetadata, observation, thresholdsFor, classifyPurchasingSignal };
