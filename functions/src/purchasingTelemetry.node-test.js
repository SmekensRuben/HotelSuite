const test = require("node:test");
const assert = require("node:assert/strict");
const { memoryDatabase } = require("./inventoryTestHelpers");
const { DEFAULT_PURCHASING_THRESHOLDS } = require("./purchasingMonitoringConfig");
const { SAAS_RULES_VERSION } = require("./saasRollout");
const { reportHotelPurchasingErrorHandler, resolvePlatformWorkflowIncidentHandler, withPurchasingTelemetry, unexpectedErrorCode } = require("./purchasingTelemetry");
const now = Date.parse("2026-10-17T10:00:00Z");
const marker = { schemaVersion: 1, projectId: "hotel-toolkit-staging", environment: "staging", enabled: true, releaseSha: "a".repeat(40),
  thresholds: DEFAULT_PURCHASING_THRESHOLDS, maxHotelsPerRun: 25, maxDocumentsPerSource: 50, evaluatorStaleMinutes: 60 };
function fixture() {
  const db = memoryDatabase({ "hotels/hotel-a/members/buyer": { permissions: ["orders.read"] },
    "hotelSubscriptions/hotel-a": { status: "active", modules: ["procurement"], modulePolicyVersion: 1 },
    "platformConfiguration/saasProcurement": { enabled: true, rulesVersion: SAAS_RULES_VERSION },
    "platformConfiguration/purchasingMonitoring": marker });
  return { db, services: { firestore: db, auth: { getUser: async () => ({ uid: "buyer", emailVerified: true }) }, now: () => now,
    runtimePolicy: { projectId: "hotel-toolkit-staging", environment: "staging" } } };
}
const request = (extra = {}) => ({ auth: { uid: "buyer", token: { email_verified: true } }, data: { hotelUid: "hotel-a", process: "orders", code: "internal", ...extra } });
const records = (db) => [...db.records].filter(([path]) => path.includes("/workflowTelemetry/"));

test("concurrent reports deduplicate into one privacy-preserving aggregate and enforce the rate window", async () => {
  const { db, services } = fixture();
  const results = await Promise.all(Array.from({ length: 12 }, () => reportHotelPurchasingErrorHandler(request(), services)));
  assert.equal(results.filter((row) => row.accepted).length, 1);
  const [[, aggregate]] = records(db);
  assert.deepEqual(Object.keys(aggregate).sort(), ["schemaVersion", "environment", "process", "origin", "code", "count", "firstOccurredAtMillis", "lastOccurredAtMillis", "correlationId", "expiresAt"].sort());
  assert.equal(aggregate.count, 1); assert.equal(aggregate.origin, "frontend"); assert.equal(aggregate.lastOccurredAtMillis, now);
  assert.equal(aggregate.expiresAt.seconds * 1000, now + 7 * 86400000);
});

test("raw payloads, cross-hotel access and platform-only identities cannot ingest hotel telemetry", async () => {
  const { db, services } = fixture();
  await assert.rejects(reportHotelPurchasingErrorHandler(request({ message: "secret" }), services), { code: "invalid-argument" });
  await assert.rejects(reportHotelPurchasingErrorHandler(request({ hotelUid: "hotel-b" }), services), { code: "permission-denied" });
  db.records.delete("hotels/hotel-a/members/buyer");
  const platform = request(); platform.auth.token.platformAdmin = true;
  await assert.rejects(reportHotelPurchasingErrorHandler(platform, services), { code: "permission-denied" });
  assert.equal(records(db).length, 0);
});

test("disabled or mismatched environment markers cannot turn staging into production telemetry", async () => {
  const { db, services } = fixture();
  db.records.set("platformConfiguration/purchasingMonitoring", { ...marker, enabled: false });
  assert.equal((await reportHotelPurchasingErrorHandler(request(), services)).accepted, false);
  db.records.set("platformConfiguration/purchasingMonitoring", { ...marker, environment: "production" });
  assert.equal((await reportHotelPurchasingErrorHandler(request(), services)).accepted, false);
  assert.equal(records(db).length, 0);
});

test("one member cannot create unbounded accepted reports or rotate aggregate IDs across days", async () => {
  const { db, services } = fixture(); let time = now;
  services.now = () => time;
  for (let index = 0; index < 60; index++) {
    time = now + index * 60000;
    assert.equal((await reportHotelPurchasingErrorHandler(request(), services)).accepted, true);
  }
  time += 60000;
  assert.equal((await reportHotelPurchasingErrorHandler(request(), services)).reason, "rate-limited");
  const originalId = records(db)[0][0];
  time = now + 86400000;
  assert.equal((await reportHotelPurchasingErrorHandler(request(), services)).accepted, true);
  assert.equal(records(db).length, 1); assert.equal(records(db)[0][0], originalId);
});

test("backend telemetry invokes the operation once and preserves both successful and failed results", async () => {
  const { db, services } = fixture(); let attempts = 0;
  const success = { committed: true };
  assert.equal(await withPurchasingTelemetry(async () => { attempts++; return success; }, "orders")(request(), services), success);
  assert.equal(attempts, 1); assert.equal(records(db).length, 0);
  const original = new Error("private message");
  const failed = withPurchasingTelemetry(async () => { attempts++; throw original; }, "orders");
  await assert.rejects(failed(request(), services), (error) => error === original);
  assert.equal(attempts, 2); assert.equal(records(db)[0][1].origin, "backend");
  const brokenServices = { ...services, firestore: { runTransaction: async () => { throw new Error("telemetry unavailable"); } } };
  await assert.rejects(failed(request(), brokenServices), (error) => error === original);
  assert.equal(attempts, 3);
  for (const code of ["invalid-argument", "permission-denied", "failed-precondition", "aborted", "resource-exhausted"]) assert.equal(unexpectedErrorCode({ code }), null);
  assert.equal(unexpectedErrorCode({ code: "ERR_INVALID_ARG_TYPE" }), "unknown");
});

test("only a current platform operator can close reviewed workflow alerts and stale evidence remains open", async () => {
  const { db, services } = fixture();
  await reportHotelPurchasingErrorHandler(request(), services);
  const [[sourcePath]] = records(db), sourceId = sourcePath.split("/").at(-1);
  db.records.set("platformIncidents/workflow-alert", { hotelUid: "hotel-a", process: "workflow", code: "unexpected-workflow-error", sourceId,
    state: "open", episode: 1, lastDetectedAtMillis: now, evidenceAtMillis: now });
  const data = { incidentId: "workflow-alert", expectedLastDetectedAtMillis: now, reason: "Persisted outcome verified by an authorized hotel operator" };
  await assert.rejects(resolvePlatformWorkflowIncidentHandler({ ...request(), data }, services), { code: "permission-denied" });
  const operator = { auth: { uid: "operator", token: { email_verified: true, platformAdmin: true } }, data };
  const operatorServices = { ...services, auth: { getUser: async () => ({ uid: "operator", emailVerified: true, customClaims: { platformAdmin: true } }) } };
  db.records.get(sourcePath).lastOccurredAtMillis = now + 1;
  await assert.rejects(resolvePlatformWorkflowIncidentHandler({ ...operator }, operatorServices), { code: "aborted" });
  db.records.get(sourcePath).lastOccurredAtMillis = now;
  await resolvePlatformWorkflowIncidentHandler({ ...operator }, operatorServices);
  assert.equal(db.records.get("platformIncidents/workflow-alert").status, "reviewed");
  assert.equal(db.records.get("platformIncidents/workflow-alert").resolutionMode, "operator-review");
  assert.equal(db.records.get(sourcePath).reviewedThroughMillis, now);
  assert.equal([...db.records.keys()].filter((path) => path.startsWith("platformAudit/")).length, 1);
  assert.equal([...db.records.keys()].some((path) => /\/(orders|mailQueue|inventoryMovements)\//.test(path)), false);
  await resolvePlatformWorkflowIncidentHandler({ ...operator }, operatorServices);
  assert.equal([...db.records.keys()].filter((path) => path.startsWith("platformAudit/")).length, 1);
  assert.equal((await reportHotelPurchasingErrorHandler(request(), { ...services, now: () => now + 1 })).accepted, true);
  assert.equal(db.records.get(sourcePath).reviewedThroughMillis, now);
  assert.equal(db.records.get(sourcePath).lastOccurredAtMillis, now + 1);
});
