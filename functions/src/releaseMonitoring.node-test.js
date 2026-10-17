const test = require("node:test");
const assert = require("node:assert/strict");
const { memoryDatabase } = require("./inventoryTestHelpers");
const { purchasingMonitoringAllowed, readPurchasingMonitoringConfiguration } = require("./purchasingMonitoringConfig");
const { recordPurchasingError, withPurchasingTelemetry } = require("./purchasingTelemetry");
const { withPurchasingWorkerTelemetry } = require("./purchasingWorkerTelemetry");
const { SAAS_RULES_VERSION } = require("./saasRollout");
const { checkPlatformImportHealth, runPlatformMonitoringWorker } = require("./platformMonitoring");
const { processImportedFileToFirestore } = require("./fileImportTypes");

async function withMode(mode, operation) {
  const previous = process.env.RELEASE_MODE;
  if (mode === undefined) delete process.env.RELEASE_MODE; else process.env.RELEASE_MODE = mode;
  try { return await operation(); }
  finally { if (previous === undefined) delete process.env.RELEASE_MODE; else process.env.RELEASE_MODE = previous; }
}

test("only explicit development or invalid modes pause additional monitoring; an absent mode preserves compatibility", async () => {
  assert.equal(purchasingMonitoringAllowed({}), true);
  assert.equal(purchasingMonitoringAllowed({ RELEASE_MODE: "controlled" }), true);
  const db = { doc() { throw new Error("No marker read is allowed while additional monitoring is disabled."); } };
  for (const mode of ["development", "", "unsupported", " controlled "]) {
    assert.equal(purchasingMonitoringAllowed({ RELEASE_MODE: mode }), false);
    const configuration = await readPurchasingMonitoringConfiguration(db, { projectId: "hotel-toolkit", env: { RELEASE_MODE: mode } });
    assert.equal(configuration.enabled, false);
    assert.equal(configuration.environment, "production");
  }
});

function developmentTelemetryFixture(user = { uid: "buyer", emailVerified: true }) {
  const db = memoryDatabase({ "hotels/hotel-a/members/buyer": { permissions: ["orders.read"] },
    "hotelSubscriptions/hotel-a": { status: "active", validUntil: null, modules: ["procurement"], modulePolicyVersion: 1 },
    "platformConfiguration/saasProcurement": { enabled: true, rulesVersion: SAAS_RULES_VERSION } });
  const doc = db.doc;
  db.doc = path => {
    assert.notEqual(path, "platformConfiguration/purchasingMonitoring", "Development must not read the additional monitoring marker.");
    return doc(path);
  };
  return { db, services: { firestore: db, auth: { getUser: async () => user } } };
}
const developmentRequest = () => ({ auth: { uid: "buyer", token: { email_verified: true, auth_time: 1000 } }, data: { hotelUid: "hotel-a" } });
const telemetryInput = (hotelUid = "hotel-a") => ({ hotelUid, process: "orders", code: "internal", origin: "frontend" });

test("development suppresses new callable and worker telemetry without changing either business result", async () => withMode("development", async () => {
  const logs = [], { db, services } = developmentTelemetryFixture(), before = structuredClone([...db.records]);
  const request = developmentRequest();
  const result = await recordPurchasingError(request, telemetryInput(), services);
  assert.equal(result.accepted, false);
  const original = new Error("Business action failed"); let calls = 0;
  const failed = withPurchasingTelemetry(async () => { calls++; throw original; }, "orders");
  await assert.rejects(failed(request, services), error => error === original);
  assert.equal(calls, 1);
  const success = { completed: true };
  const worker = withPurchasingWorkerTelemetry("contract-reminders", async () => { calls++; return success; }, {
    firestore: db, runtimePolicy: { projectId: "hotel-toolkit", environment: "production" }, logger: { error: value => logs.push(value) } });
  assert.equal(await worker(), success);
  assert.equal(calls, 2); assert.deepEqual([...db.records], before); assert.deepEqual(logs, []);
}));

test("development telemetry preserves current account, hotel membership, subscription and rollout authorization", async () => withMode("development", async () => {
  const ordinary = developmentTelemetryFixture();
  await assert.rejects(recordPurchasingError(developmentRequest(), telemetryInput("hotel-b"), ordinary.services), { code: "permission-denied" });
  for (const user of [{ uid: "buyer", emailVerified: true, disabled: true },
    { uid: "buyer", emailVerified: true, tokensValidAfterTime: new Date(1001000).toISOString() }]) {
    const state = developmentTelemetryFixture(user);
    await assert.rejects(recordPurchasingError(developmentRequest(), telemetryInput(), state.services), { code: "permission-denied" });
  }
  const noSubscription = developmentTelemetryFixture();
  noSubscription.db.records.get("hotelSubscriptions/hotel-a").status = "inactive";
  await assert.rejects(recordPurchasingError(developmentRequest(), telemetryInput(), noSubscription.services), { code: "permission-denied" });
  const noRollout = developmentTelemetryFixture();
  noRollout.db.records.get("platformConfiguration/saasProcurement").enabled = false;
  await assert.rejects(recordPurchasingError(developmentRequest(), telemetryInput(), noRollout.services), { code: "failed-precondition" });
}));

test("development keeps the existing scheduled import evaluator active even with a malformed purchasing marker", async () => withMode("development", async () => {
  const now = Date.parse("2026-10-10T07:00:00Z");
  const db = memoryDatabase({ "hotels/hotel-a": { name: "Hotel A" },
    "hotelSubscriptions/hotel-a": { status: "active", validUntil: null, modules: ["procurement"], modulePolicyVersion: 1 },
    "platformConfiguration/purchasingMonitoring": { enabled: true, schemaVersion: "old malformed configuration" },
    "hotels/hotel-a/fileImportTypes/arrivals": { name: "Daily arrivals", fileType: "arrivals", enabled: true },
    "hotels/hotel-a/importMonitors/arrivals": { label: "Daily arrivals", fileType: "arrivals", timeZone: "Europe/Brussels",
      expectedBy: "07:30", graceMinutes: 30, weekdays: [0, 1, 2, 3, 4, 5, 6], businessDateOffsetDays: 0,
      startsOn: "2026-10-01", enabled: true, paused: false, acceptEmpty: false, revision: 1 },
    "hotels/hotel-a/platformHealth/purchasing": { status: "attention", computedAtMillis: now - 1000 },
    "platformIncidents/existing-workflow-alert": { state: "open", process: "workflow", evidenceAtMillis: now - 1000 } });
  const beforeMarker = structuredClone(db.records.get("platformConfiguration/purchasingMonitoring"));
  const beforeHealth = structuredClone(db.records.get("hotels/hotel-a/platformHealth/purchasing"));
  const result = await runPlatformMonitoringWorker({ firestore: db, now: () => now });
  assert.equal(result.purchasingEnabled, false); assert.equal(result.checkedHotels, 1); assert.equal(result.failedHotels, 0);
  assert.equal(db.records.get("hotels/hotel-a/platformHealth/imports").status, "attention");
  assert.ok([...db.records].some(([path, record]) => path.startsWith("platformIncidents/") && record.code === "overdue"));
  assert.deepEqual(db.records.get("platformConfiguration/purchasingMonitoring"), beforeMarker);
  assert.deepEqual(db.records.get("hotels/hotel-a/platformHealth/purchasing"), beforeHealth);
  assert.equal(db.records.get("platformIncidents/existing-workflow-alert").state, "open");
  assert.equal(checkPlatformImportHealth.__endpoint.scheduleTrigger.schedule, "every 15 minutes");
  assert.equal(processImportedFileToFirestore.__endpoint.eventTrigger.eventType, "google.cloud.storage.object.v1.finalized");
  assert.equal(processImportedFileToFirestore.__endpoint.eventTrigger.retry, true);
  await processImportedFileToFirestore.run({ data: { name: "outside-import-scope/example.txt" } });
}));
