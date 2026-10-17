const test = require("node:test");
const assert = require("node:assert/strict");
const { collectPurchasingSignals, SOURCES } = require("./purchasingMonitoringSignals");
const { DEFAULT_PURCHASING_THRESHOLDS } = require("./purchasingMonitoringPolicy");

const now = Date.parse("2026-10-17T12:00:00Z"), root = "hotels/hotel-a";
const configuration = { environment: "production", maxDocumentsPerSource: 50, thresholds: DEFAULT_PURCHASING_THRESHOLDS };
function database(seed = {}) {
  const records = new Map(Object.entries({ "hotelSubscriptions/hotel-a": { status: "active", modules: ["procurement"], modulePolicyVersion: 1 }, ...seed }));
  const queries = [], writes = [], failures = new Set();
  const snapshot = (path) => ({ id: path.split("/").at(-1), exists: records.has(path), data: () => records.has(path) ? { ...records.get(path) } : undefined });
  const db = { records, queries, writes, failures, doc(path) { return { path, get: async () => {
    if (failures.has(path)) throw new Error("private source error");
    return snapshot(path);
  } }; }, collection(path) {
    const filters = []; let after = null, limit = Infinity, fields = null;
    const query = { orderBy() { return query; }, startAfter(id) { after = id; return query; },
      select(...value) { fields = value; return query; }, limit(value) { limit = value; return query; },
      where(field, operator, value) { filters.push({ field, operator, value }); return query; },
      async get() {
        if (failures.has(path)) throw new Error("private source error");
        queries.push({ path, after, limit, fields, filters });
        const docs = [...records.keys()].filter((key) => key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes("/"))
          .sort().filter((key) => after === null || key.split("/").at(-1) > after)
          .filter((key) => filters.every(({ field, operator, value }) => operator === "in" ? value.includes(records.get(key)[field]) : records.get(key)[field] === value))
          .slice(0, limit).map(snapshot);
        return { docs, size: docs.length, empty: docs.length === 0 };
      } };
    return query;
  }, async runTransaction(work) { return work({ get: (ref) => ref.get(), set(ref, value) { records.set(ref.path, value); writes.push(ref.path); } }); } };
  return db;
}
function find(result, process, sourceId) {
  return result.observations.find((item) => item.process === process && item.sourceId === sourceId);
}

test("collector covers tenant sources without mutating business records or copying sensitive payloads", async () => {
  const seed = {
    [`${root}/dispatches/dispatch-a`]: { status: "failed", externalAttempt: false, createdAt: now - 60000, error: "private supplier credential" },
    [`${root}/mailQueue/request-mail`]: { type: "purchase-request", purchaseRequestId: "request-a", status: "failed", queuedAt: now - 60000, payload: { to: ["private@example.test"], text: "private request" } },
    [`${root}/supplierAiImportJobs/import-a`]: { status: "response_unknown", updatedAt: now, source: "private uploaded content" },
    [`${root}/catalogSyncJobs/catalog-a`]: { status: "review", updatedAt: now },
    [`${root}/scheduledMailReceipts/receipt-a`]: { status: "processing", attemptedAt: new Date(now - 3600000), deliveryKey: "private mail data" },
    [`${root}/importRuns/file-a`]: { state: "processing", updatedAt: now - 3600000, leaseUntil: now - 1, descriptor: { fileType: "supplier-prices", name: "private filename" } },
    [`${root}/workflowTelemetry/error-a`]: { schemaVersion: 1, process: "orders", code: "internal", origin: "backend", count: 1, environment: "production", lastOccurredAtMillis: now },
    "hotels/hotel-b/mailQueue/private": { status: "failed", error: "other hotel private" },
  };
  const db = database(seed), before = JSON.stringify([...db.records]);
  const result = await collectPurchasingSignals(db, "hotel-a", configuration, now);
  assert.equal(find(result, "dispatches", "dispatch-a").status, "failed");
  assert.equal(find(result, "mail-queue", "request-mail").metadata.purchaseRequestId, "request-a");
  assert.equal(find(result, "supplier-imports", "import-a").status, "needs-review");
  assert.equal(find(result, "scheduled-mail", "receipt-a").status, "needs-review");
  assert.equal(find(result, "imports", "file-a").metadata.fileType, "supplier-prices");
  assert.equal(find(result, "workflow", "error-a").metadata.origin, "backend");
  assert.equal(result.coverage.length, SOURCES.length + 2);
  assert.equal(JSON.stringify(result).includes("private"), false);
  assert.deepEqual(db.writes, [`${root}/platformHealth/purchasingScan`]);
  db.records.delete(`${root}/platformHealth/purchasingScan`);
  assert.equal(JSON.stringify([...db.records]), before);
  assert.equal(db.queries.every((query) => query.path.startsWith(`${root}/`) && query.limit <= 41), true);
});

test("bounded persistent rotation reaches old failures and never claims unseen sources are healthy", async () => {
  const seed = Object.fromEntries(Array.from({ length: 5 }, (_, index) => [`${root}/dispatches/dispatch-${index}`,
    { status: index === 4 ? "failed" : "sent", providerId: "receipt", completedAt: now - 60000 }]));
  const db = database(seed), config = { ...configuration, maxDocumentsPerSource: 2 };
  const first = await collectPurchasingSignals(db, "hotel-a", config, now);
  assert.equal(first.coverage.find((item) => item.process === "dispatches").status, "unknown");
  assert.equal(find(first, "dispatches", "dispatch-4"), undefined);
  const second = await collectPurchasingSignals(db, "hotel-a", config, now + 1000);
  assert.equal(find(second, "dispatches", "dispatch-4"), undefined);
  const third = await collectPurchasingSignals(db, "hotel-a", config, now + 2000);
  assert.equal(find(third, "dispatches", "dispatch-4").status, "failed");
  assert.equal(third.coverage.find((item) => item.process === "dispatches").status, "unknown");
  assert.equal(find(third, "dispatches", "scan-coverage").code, "scan-cycle-complete");
  assert.equal(db.records.get(`${root}/platformHealth/purchasingScan`).sources.dispatches.afterId, null);
});

test("legacy document IDs remain usable cursors while displayed identifiers are opaque", async () => {
  const db = database({ [`${root}/dispatches/aaa private@example.test`]: { status: "failed", createdAt: now },
    [`${root}/dispatches/zzz`]: { status: "failed", createdAt: now } });
  const config = { ...configuration, maxDocumentsPerSource: 1 };
  const first = await collectPurchasingSignals(db, "hotel-a", config, now);
  assert.match(first.observations.find((item) => item.process === "dispatches" && item.code === "operation-failed").sourceId, /^opaque-/);
  const second = await collectPurchasingSignals(db, "hotel-a", config, now + 1000);
  assert.equal(find(second, "dispatches", "zzz").status, "failed");
});

test("a failed source read does not advance its durable cursor or leak the exception", async () => {
  const db = database({ [`${root}/platformHealth/purchasingScan`]: { version: 1, sources: { dispatches: { afterId: "previous" } } } });
  db.failures.add(`${root}/dispatches`);
  const result = await collectPurchasingSignals(db, "hotel-a", configuration, now);
  assert.equal(result.coverage.find((item) => item.process === "dispatches").readError, true);
  assert.equal(result.cursors.dispatches.afterId, "previous");
  assert.equal(find(result, "dispatches", "scan-coverage").code, "source-read-unavailable");
  assert.equal(JSON.stringify(result).includes("private source error"), false);
});

test("backlog probes remain exact below their bound despite many terminal historical records", async () => {
  const seed = Object.fromEntries(Array.from({ length: 60 }, (_, index) => [`${root}/mailQueue/old-${String(index).padStart(3, "0")}`,
    { status: "sent", providerId: "receipt", sentAt: now - 60000 }]));
  const db = database(seed);
  for (let index = 0; index < 21; index++) db.records.set(`${root}/mailQueue/queued-${index}`, { status: "queued", queuedAt: now });
  const first = await collectPurchasingSignals(db, "hotel-a", configuration, now);
  assert.equal(find(first, "mail-queue", "queue-backlog").status, "needs-review");
  for (let index = 0; index < 21; index++) db.records.delete(`${root}/mailQueue/queued-${index}`);
  const second = await collectPurchasingSignals(db, "hotel-a", configuration, now + 1000);
  assert.equal(find(second, "mail-queue", "queue-backlog").status, "healthy");
  assert.equal(second.coverage.find((item) => item.process === "mail-queue").status, "unknown");
});

test("supplier acceptance requires matching immutable tenant response evidence", async () => {
  const summary = { policyVersion: 1, responseId: "response-a", reviewId: null, responseType: "accepted", respondedOn: "2026-10-17",
    eventCount: 1, reviewState: "not-required", requiresAttention: false };
  const event = { policyVersion: 1, kind: "response", hotelUid: "hotel-a", orderId: "order-a", actorUid: "actor-a", revision: 2,
    response: { responseType: "accepted", respondedOn: "2026-10-17" }, result: { supplierConfirmation: summary } };
  const db = database({ [`${root}/orders/order-a`]: { status: "Ordered", dispatchStatus: "sent", revision: 2, dispatchedAt: now, updatedAt: now, supplierConfirmation: summary },
    [`${root}/orders/order-a/supplierConfirmations/response-a`]: event });
  assert.equal(find(await collectPurchasingSignals(db, "hotel-a", configuration, now), "supplier-confirmations", "order-a").status, "healthy");
  db.records.set(`${root}/orders/order-a/supplierConfirmations/response-a`, { ...event, hotelUid: "hotel-b" });
  assert.equal(find(await collectPurchasingSignals(db, "hotel-a", configuration, now + 1000), "supplier-confirmations", "order-a").status, "unknown");
});

test("active catalog suggestions are checked separately from review workspace status", async () => {
  const db = database({ [`${root}/catalogSyncJobs/job-a`]: { status: "review", updatedAt: now, aiRefinementState: { activeOperationId: "operation-a" } },
    [`${root}/catalogSyncJobs/job-a/aiOperations/operation-a`]: { status: "responding", updatedAt: now - 3600000, leaseUntilMillis: now - 1 } });
  const result = await collectPurchasingSignals(db, "hotel-a", configuration, now);
  assert.equal(find(result, "catalog-sync", "job-a:operation-a").status, "needs-review");
  db.records.set(`${root}/catalogSyncJobs/job-a`, { status: "review", updatedAt: now + 1000, aiRefinementState: { activeOperationId: null } });
  db.records.set(`${root}/catalogSyncJobs/job-a/aiOperations/operation-a`, { status: "ready", updatedAt: now + 1000 });
  const completed = await collectPurchasingSignals(db, "hotel-a", configuration, now + 1000);
  assert.equal(find(completed, "catalog-sync", "job-a:operation-a").status, "healthy");
  assert.deepEqual(db.records.get(`${root}/platformHealth/purchasingScan`).sources.catalogSyncJobs.pendingOperations, {});
});

test("paused subscriptions and missing subscription evidence never become healthy source results", async () => {
  for (const subscription of [{ status: "suspended", modules: ["procurement"], modulePolicyVersion: 1 },
    { status: "active", modules: [], modulePolicyVersion: 1 }, null]) {
    const db = database({ [`${root}/dispatches/failed`]: { status: "failed", createdAt: now } });
    if (subscription) db.records.set("hotelSubscriptions/hotel-a", subscription);
    else db.records.delete("hotelSubscriptions/hotel-a");
    const result = await collectPurchasingSignals(db, "hotel-a", configuration, now);
    assert.equal(result.coverage.every((item) => item.status === (subscription ? "paused" : "unknown")), true);
    assert.equal(result.inspected, 0);
    assert.equal(db.queries.length, 0);
    assert.equal(db.writes.length, 0);
  }
});

test("retained reservations and concurrency are compared with explicit operation limits", async () => {
  const db = database({ "platformConfiguration/aiSupplierProductImport": { enabled: true, maxConcurrentJobsPerHotel: 2,
    maxImportsPerHotelPerDay: 20, maxMonthlyCostPerHotelUsd: 10 },
  [`${root}/aiUsageMonths/2026-10`]: { knownCostMicros: 2000000, reservedCostMicros: 6500000, days: { "2026-10-17": 1 } },
  [`${root}/aiImportAdministration/state`]: { activeJobs: 2 } });
  const result = await collectPurchasingSignals(db, "hotel-a", configuration, now);
  assert.equal(find(result, "purchasing-limits", "supplier-ai-budget").status, "needs-review");
  assert.equal(find(result, "purchasing-limits", "supplier-ai-budget").metadata.reservedCostMicros, 6500000);
  assert.equal(find(result, "purchasing-limits", "supplier-ai-concurrency").status, "needs-review");
  assert.equal(find(result, "purchasing-limits", "supplier-ai-daily").status, "healthy");
});

test("manual contract reminder tasks expose missing worker progress without inventing email receipts", async () => {
  const db = database({ [`${root}/contractReminderRuns/run-a`]: { status: "processing", startedAt: new Date(now - 3600000) } });
  const result = await collectPurchasingSignals(db, "hotel-a", configuration, now);
  assert.equal(find(result, "contract-reminders", "run-a").status, "stalled");
  db.records.set(`${root}/contractReminderRuns/run-a`, { status: "completed", completedAt: new Date(now) });
  const completed = find(await collectPurchasingSignals(db, "hotel-a", configuration, now + 1000), "contract-reminders", "run-a");
  assert.equal(completed.status, "healthy");
  assert.match(completed.summary, /each email has a separate transport receipt/);
  const staging = find(await collectPurchasingSignals(db, "hotel-a", { ...configuration, environment: "staging" }, now + 2000), "contract-reminders", "run-a");
  assert.equal(staging.status, "paused");
});

test("unconfigured import preflight failures are detected and recover only against a completed raw run", async () => {
  const db = database({ [`${root}/importTelemetry/preflight-a`]: { status: "failed", errorCode: "import-preflight-failed", updatedAtMillis: now } });
  const first = await collectPurchasingSignals(db, "hotel-a", configuration, now);
  assert.equal(find(first, "imports-preflight", "preflight-a").code, "import-preflight-failed");
  db.records.set(`${root}/importTelemetry/preflight-a`, { status: "succeeded", errorCode: null, updatedAtMillis: now + 1000 });
  db.records.set(`${root}/importRuns/preflight-a`, { state: "complete", result: { writtenCount: 5 }, updatedAt: now + 1000 });
  const second = await collectPurchasingSignals(db, "hotel-a", configuration, now + 1000);
  assert.equal(find(second, "imports-preflight", "preflight-a").status, "healthy");
});

test("configured backlog thresholds beyond the probe bound remain unknown when insufficiently inspected", async () => {
  const seed = Object.fromEntries(Array.from({ length: 45 }, (_, index) => [`${root}/mailQueue/pending-${index}`, { status: "queued", queuedAt: now }]));
  const result = await collectPurchasingSignals(database(seed), "hotel-a", { ...configuration,
    thresholds: { ...configuration.thresholds, backlogCount: 100 } }, now);
  assert.equal(find(result, "mail-queue", "queue-backlog").status, "unknown");
  assert.equal(find(result, "mail-queue", "queue-backlog").metadata.countIsLowerBound, true);
});

test("explicitly disabled paid AI is paused and absent unused accounting does not invent available capacity", async () => {
  const policy = { enabled: false, maxConcurrentJobsPerHotel: 2, maxImportsPerHotelPerDay: 20, maxMonthlyCostPerHotelUsd: 10 };
  const db = database({ "platformConfiguration/aiSupplierProductImport": policy });
  const disabled = await collectPurchasingSignals(db, "hotel-a", configuration, now);
  assert.equal(find(disabled, "purchasing-limits", "supplier-ai").status, "paused");
  db.records.set("platformConfiguration/aiSupplierProductImport", { ...policy, enabled: true });
  const unused = await collectPurchasingSignals(db, "hotel-a", configuration, now + 1000);
  assert.equal(find(unused, "purchasing-limits", "supplier-ai"), undefined);
  assert.equal(unused.coverage.find((item) => item.process === "purchasing-limits").status, "no-workload");
  assert.equal(unused.coverage.find((item) => item.process === "purchasing-limits").capacityVerified, false);
});

test("synthetic accounting issues have explicit same-reference evidence when recovered", async () => {
  const policy = { enabled: true, maxConcurrentJobsPerHotel: 2, maxImportsPerHotelPerDay: 20, maxMonthlyCostPerHotelUsd: 10 };
  const db = database({ "platformConfiguration/aiSupplierProductImport": policy, [`${root}/aiUsageMonths/2026-10`]: { knownCostMicros: 0, reservedCostMicros: 0, days: {} } });
  assert.equal(find(await collectPurchasingSignals(db, "hotel-a", configuration, now), "purchasing-limits", "supplier-ai").status, "unknown");
  db.records.set(`${root}/aiImportAdministration/state`, { activeJobs: 0 });
  const recovered = await collectPurchasingSignals(db, "hotel-a", configuration, now + 1000);
  assert.equal(find(recovered, "purchasing-limits", "supplier-ai").status, "healthy");
  assert.equal(find(recovered, "purchasing-limits", "subscription").status, "healthy");
  assert.equal(find(recovered, "purchasing-limits", "supplier-ai-reservations").status, "healthy");
});

test("scheduled reminder heartbeat detects absent or failed execution before delivery receipts exist", async () => {
  const db = database();
  const unknown = await collectPurchasingSignals(db, "hotel-a", configuration, now);
  assert.equal(find(unknown, "background-workers", "contract-reminders").status, "unknown");
  db.records.set("platformWorkerHealth/contract-reminders", { status: "failed", environment: "production", updatedAtMillis: now,
    lastSuccessfulAtMillis: now - 86400000, lastFailureAtMillis: now });
  const failed = await collectPurchasingSignals(db, "hotel-a", configuration, now + 1000);
  assert.equal(find(failed, "background-workers", "contract-reminders").status, "failed");
  db.records.set("platformWorkerHealth/contract-reminders", { status: "completed", environment: "production", updatedAtMillis: now + 2000, lastSuccessfulAtMillis: now + 2000 });
  const success = await collectPurchasingSignals(db, "hotel-a", configuration, now + 2000);
  assert.equal(find(success, "background-workers", "contract-reminders").status, "healthy");
  const overdue = await collectPurchasingSignals(db, "hotel-a", configuration, now + 31 * 3600000);
  assert.equal(find(overdue, "background-workers", "contract-reminders").status, "stalled");
  const staging = await collectPurchasingSignals(db, "hotel-a", { ...configuration, environment: "staging" }, now);
  assert.equal(find(staging, "background-workers", "contract-reminders").status, "paused");
  db.records.set("platformWorkerHealth/contract-reminders", { status: "completed", environment: "production", updatedAtMillis: now - 1000,
    lastSuccessfulAtMillis: now - 1000, lastAttemptAtMillis: now, lastFailureAtMillis: now - 500 });
  const unfinished = await collectPurchasingSignals(db, "hotel-a", configuration, now + 1000);
  assert.equal(find(unfinished, "background-workers", "contract-reminders").status, "processing");
  assert.equal(find(unfinished, "background-workers", "contract-reminders").evidenceAtMillis, now);
});

test("only explicitly linked successful replacement deliveries recover original failure references", async () => {
  const source = { status: "superseded", orderId: "order-a", replacementDispatchId: "replacement-a", createdAt: now - 60000 };
  const replacement = { status: "sent", orderId: "order-a", recoveryOf: "dispatch-a", providerId: "receipt", completedAt: now };
  const failedMail = { status: "failed", type: "purchase-request", hotelUid: "hotel-a", purchaseRequestId: "request-a", revision: 1,
    event: "submit", recipientUid: "recipient-a", recoveredByMailId: "recovery-mail", queuedAt: now - 60000 };
  const db = database({ [`${root}/dispatches/dispatch-a`]: source, [`${root}/dispatches/replacement-a`]: replacement,
    [`${root}/mailQueue/original-mail`]: failedMail,
    [`${root}/mailQueue/recovery-mail`]: { ...failedMail, status: "sent", recoveredByMailId: null, recoveredFrom: "original-mail", providerId: "receipt", sentAt: now },
    [`${root}/mailQueue/order-mail`]: { type: "order-confirmation", status: "superseded", orderId: "order-a", dispatchRequestId: "dispatch-a", queuedAt: now - 60000 } });
  const recovered = await collectPurchasingSignals(db, "hotel-a", configuration, now);
  assert.equal(find(recovered, "dispatches", "dispatch-a").status, "healthy");
  assert.equal(find(recovered, "mail-queue", "original-mail").status, "healthy");
  assert.equal(find(recovered, "mail-queue", "order-mail").status, "healthy");
  db.records.set(`${root}/dispatches/replacement-a`, { ...replacement, orderId: "different-order" });
  db.records.set(`${root}/mailQueue/recovery-mail`, { ...failedMail, status: "sent", recoveredFrom: "foreign-mail", providerId: "receipt", sentAt: now });
  const unrelated = await collectPurchasingSignals(db, "hotel-a", configuration, now + 1000);
  assert.equal(find(unrelated, "dispatches", "dispatch-a").status, "paused");
  assert.equal(find(unrelated, "mail-queue", "original-mail").status, "failed");
  assert.equal(find(unrelated, "mail-queue", "order-mail").status, "paused");
});
