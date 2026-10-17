const test = require("node:test");
const assert = require("node:assert/strict");
const { classifyPurchasingSignal, DEFAULT_PURCHASING_THRESHOLDS, milliseconds } = require("./purchasingMonitoringPolicy");

const now = Date.parse("2026-10-17T12:00:00Z");
const config = { environment: "production", thresholds: DEFAULT_PURCHASING_THRESHOLDS };
const classify = (process, record, override = {}) => classifyPurchasingSignal(process, "operation-a", record, { ...config, ...override }, now);

test("pending and running operations use independent explicit deadlines and preserved leases", () => {
  assert.equal(classify("dispatches", { status: "pending", createdAt: now - 16 * 60000 }).status, "stalled");
  assert.equal(classify("dispatches", { status: "processing", processingAt: new Date(now - 16 * 60000) }).status, "processing");
  assert.equal(classify("supplier-imports", { status: "processing", updatedAt: now - 60000, leaseUntil: now - 1 }).status, "stalled");
  assert.equal(classify("supplier-imports", { status: "processing", updatedAt: now - 31 * 60000, leaseUntil: now + 60000 }).status, "processing");
  assert.equal(classify("dispatches", { status: "pending", createdAt: now - 16 * 60000 }, { thresholds: { ...config.thresholds, pendingMinutes: 20 } }).status, "processing");
});

test("ambiguous attempts never become safely failed or an automatic retry instruction", () => {
  for (const record of [{ status: "failed", externalAttempt: true }, { status: "needs-review" }, { status: "response_unknown" },
    { status: "processing", processingAt: now - 3600000, externalAttempt: true }]) {
    const item = classify("dispatches", record);
    assert.equal(item.status, "needs-review");
    assert.match(item.nextStep, /before any retry/);
  }
  const item = classify("scheduled-mail", { status: "processing", attemptedAt: new Date(now - 3600000) });
  assert.equal(item.status, "needs-review");
  assert.equal(item.code, "external-result-unconfirmed");
});

test("a receipt establishes transport acceptance and cannot establish supplier acceptance", () => {
  assert.equal(classify("mail-queue", { status: "sent", providerId: "receipt", sentAt: now }).status, "healthy");
  assert.equal(classify("dispatches", { status: "sent", via: "sftp", remotePath: "/supplier/private.csv", completedAt: now }).status, "healthy");
  assert.equal(classify("mail-queue", { status: "sent", sentAt: now }).code, "transport-receipt-missing");
  assert.equal(classify("mail-queue", { status: "sent", providerId: "receipt" }).code, "transport-time-missing");
  assert.equal(classify("dispatches", { status: "sent", manuallyReconciled: true, receiptSource: "supplier-contact", reviewedBy: "reviewer-a", reviewedAt: now }).status, "healthy");
  assert.equal(classify("mail-queue", { status: "sent", manuallyReconciled: true, orderId: "order-a", dispatchRequestId: "dispatch-a", reviewedBy: "reviewer-a", reviewedAt: now }).status, "healthy");
  assert.equal(classify("dispatches", { status: "superseded", replacementDispatchId: "replacement-a", createdAt: now }).status, "paused");
  const item = classify("supplier-confirmations", { status: "Ordered", dispatchStatus: "sent", dispatchedAt: now - 25 * 3600000 });
  assert.equal(item.status, "needs-review");
  assert.equal(item.code, "supplier-response-overdue");
  assert.match(item.nextStep, /transport acceptance does not establish supplier acceptance/);
});

test("staging and demo simulations never count as real delivery even with a sent status", () => {
  for (const patch of [{ status: "simulated" }, { status: "sent", dispatchMode: "simulation" }, { status: "sent", via: "simulation" }]) {
    assert.equal(classify("dispatches", { providerId: "fake-ack", completedAt: now, ...patch }).status, "simulated");
  }
  assert.equal(classify("dispatches", { status: "sent", providerId: "fake-ack", completedAt: now, environment: "staging" }).status, "unknown");
  assert.equal(classify("dispatches", { status: "sent", providerId: "fake-ack", completedAt: now, dispatchEnvironment: "staging" }).status, "unknown");
  assert.equal(classify("dispatches", { status: "failed", environment: "staging", updatedAt: now }, { environment: "staging" }).status, "failed");
  assert.equal(classify("supplier-imports", { status: "completed", updatedAt: now, environment: "staging" }).code, "environment-mismatch");
});

test("missing, future and corrupt evidence stays unknown", () => {
  assert.equal(classify("dispatches", { status: "processing" }).code, "operation-age-unknown");
  assert.equal(classify("imports", { state: "complete", updatedAt: now, result: {} }).code, "import-result-unavailable");
  assert.equal(classify("imports", { state: "complete", updatedAt: now, result: { writtenCount: 0 } }).status, "healthy");
  assert.equal(classify("dispatches", { status: "processing", createdAt: now + 120000 }).code, "future-evidence");
  assert.equal(classify("dispatches", { status: "SENT private@example.test" }).code, "source-status-unknown");
  assert.equal(milliseconds({ toMillis() { throw new Error("private"); } }), null);
});

test("only verified supplier confirmation summaries can close a response incident", () => {
  const source = { status: "Ordered", dispatchStatus: "sent", updatedAt: now,
    supplierConfirmation: { policyVersion: 1, responseType: "accepted", reviewState: "not-required", requiresAttention: false } };
  assert.equal(classify("supplier-confirmations", source).status, "unknown");
  assert.equal(classify("supplier-confirmations", { ...source, confirmationEvidenceVerified: true }).status, "healthy");
  assert.equal(classify("supplier-confirmations", { ...source, confirmationEvidenceVerified: true,
    supplierConfirmation: { ...source.supplierConfirmation, responseType: "changes-proposed", reviewState: "pending", requiresAttention: true } }).status, "needs-review");
});

test("workflow errors preserve uncertainty about business results and use allowlisted classes", () => {
  const record = { process: "purchase-requests", origin: "frontend", code: "internal", count: 2, environment: "production", lastOccurredAtMillis: now };
  const item = classify("workflow", record);
  assert.equal(item.status, "needs-review");
  assert.equal(item.metadata.workflowProcess, "purchase-requests");
  assert.match(item.nextStep, /verify its persisted result/);
  assert.equal(classify("workflow", { ...record, code: "private exception" }).status, "unknown");
  assert.equal(classify("workflow", { ...record, lastOccurredAtMillis: now - 49 * 3600000 }), null);
  assert.equal(classify("workflow", { ...record, reviewedThroughMillis: now }), null);
  assert.equal(classify("workflow", { ...record, reviewedThroughMillis: now - 1 }).status, "needs-review");
});

test("safe observations never copy recipients, provider payloads, credentials or arbitrary errors", () => {
  const secret = "private@example.test/password=secret";
  const item = classifyPurchasingSignal("mail-queue", secret, { status: "failed", type: "purchase-request", error: secret,
    errorCode: secret, payload: { to: [secret], text: secret }, providerId: secret, actorUid: secret, supplierId: secret,
    correlationId: secret, password: secret, queuedAt: now }, config, now);
  assert.equal(item.code, "operation-failed");
  assert.equal(item.metadata.mailType, "purchase-request");
  assert.match(item.sourceId, /^opaque-/);
  assert.equal(JSON.stringify(item).includes(secret), false);
});

test("retry limits and budget failures have stable public failure classes", () => {
  assert.equal(classify("supplier-imports", { status: "processing", updatedAt: now, attemptCount: 3 }).code, "retry-threshold-reached");
  assert.equal(classify("supplier-imports", { status: "failed", errorCode: "resource-exhausted" }).code, "operation-limit-reached");
  assert.equal(classify("imports", { state: "complete", updatedAt: now, result: { writtenCount: 10 }, downstreamStatus: "failed" }).code, "downstream-failed");
  assert.throws(() => classify("imports", {}, { thresholds: { pendingMinutes: 0 } }), /thresholds are invalid/);
});
