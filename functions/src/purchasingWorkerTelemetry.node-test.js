const { test } = require("node:test");
const assert = require("node:assert/strict");
const { withPurchasingWorkerTelemetry } = require("./purchasingWorkerTelemetry");
const { DEFAULT_PURCHASING_THRESHOLDS } = require("./purchasingMonitoringPolicy");

function setup({ failReads = false, failWrites = false } = {}) {
  const writes = [], logs = [], marker = { schemaVersion: 1, projectId: "hotel-toolkit", environment: "production",
    enabled: true, releaseSha: "a".repeat(40), thresholds: DEFAULT_PURCHASING_THRESHOLDS,
    maxHotelsPerRun: 25, maxDocumentsPerSource: 50, evaluatorStaleMinutes: 45 };
  return { writes, logs, services: { runtimePolicy: { projectId: marker.projectId, environment: marker.environment },
    now: () => 1800000000000, logger: { error: (...value) => logs.push(value) }, firestore: { doc(path) { return {
      async get() { if (failReads) throw new Error("private provider token"); return { exists: true, data: () => marker }; },
      async set(value) { if (failWrites) throw new Error("private provider token"); writes.push({ path, value }); },
    }; } } } };
}

test("failed monitoring reads and writes preserve a successful scheduled action exactly once", async () => {
  for (const flags of [{ failReads: true }, { failWrites: true }]) {
    const state = setup(flags); let calls = 0;
    const result = { sent: 1 };
    const wrapped = withPurchasingWorkerTelemetry("contract-reminders", async () => { calls++; return result; }, state.services);
    assert.equal(await wrapped(), result);
    assert.equal(calls, 1);
    assert.equal(JSON.stringify(state.logs).includes("private provider token"), false);
  }
});

test("worker failures retain their original error and produce only safe execution metadata", async () => {
  const state = setup(), original = new Error("private provider body"); let calls = 0;
  const wrapped = withPurchasingWorkerTelemetry("contract-reminders", async () => { calls++; throw original; }, state.services);
  await assert.rejects(wrapped(), error => error === original);
  assert.equal(calls, 1);
  assert.deepEqual(state.writes.map(row => row.value.status), ["processing", "failed"]);
  assert.equal(state.writes[1].value.lastFailureAtMillis, 1800000000000);
  assert.equal(JSON.stringify(state.writes).includes("private provider body"), false);
});

test("a telemetry request that never settles cannot hold the business handler indefinitely", async () => {
  for (const phase of ["read", "write"]) {
    const state = setup(); let calls = 0;
    const originalDoc = state.services.firestore.doc;
    state.services.timeoutMillis = 5;
    state.services.firestore.doc = (path) => {
      const ref = originalDoc(path);
      if (phase === "read") ref.get = () => new Promise(() => {});
      else ref.set = () => new Promise(() => {});
      return ref;
    };
    const wrapped = withPurchasingWorkerTelemetry("contract-reminders", async () => { calls++; return "completed-once"; }, state.services);
    assert.equal(await wrapped(), "completed-once");
    assert.equal(calls, 1);
  }
});
