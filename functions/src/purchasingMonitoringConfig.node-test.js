const test = require("node:test");
const assert = require("node:assert/strict");
const { validatePurchasingMonitoringConfiguration, readPurchasingMonitoringConfiguration } = require("./purchasingMonitoringConfig");
const defaults = require("../../config/purchasing-monitoring.production.json");
const SHA = "a".repeat(40);
const configuration = (patch = {}) => ({ ...structuredClone(defaults), releaseSha: SHA, ...patch });

test("purchasing monitoring requires the exact environment, project, policy and release", () => {
  const valid = configuration();
  assert.equal(validatePurchasingMonitoringConfiguration(valid, { projectId: "hotel-toolkit" }).enabled, false);
  for (const patch of [{ environment: "staging" }, { projectId: "hotel-toolkit-staging" }, { schemaVersion: 2 }, { releaseSha: "staging" }, { enabled: "true" }]) {
    assert.throws(() => validatePurchasingMonitoringConfiguration(configuration(patch), { projectId: "hotel-toolkit" }));
  }
  assert.throws(() => validatePurchasingMonitoringConfiguration(valid, { projectId: "demo-hotel-suite-a00" }));
  assert.throws(() => validatePurchasingMonitoringConfiguration(valid, { projectId: "hotel-toolkit", requireEnabled: true }));
});

test("purchasing monitoring validates bounded thresholds and work independently", () => {
  for (const patch of [{ maxHotelsPerRun: 26 }, { maxDocumentsPerSource: 51 }, { evaluatorStaleMinutes: 0 },
    { thresholds: { ...defaults.thresholds, pendingMinutes: 0 } }, { thresholds: { ...defaults.thresholds, retryCount: 2.5 } },
    { thresholds: { ...defaults.thresholds, limitWarningRatio: 1.1 } }, { thresholds: { ...defaults.thresholds, unknownThreshold: 1 } }]) {
    assert.throws(() => validatePurchasingMonitoringConfiguration(configuration(patch), { projectId: "hotel-toolkit" }));
  }
});

test("a missing marker is disabled; an invalid marker fails closed", async () => {
  const db = { doc: path => { assert.equal(path, "platformConfiguration/purchasingMonitoring"); return { get: async () => ({ exists: false }) }; } };
  assert.deepEqual(await readPurchasingMonitoringConfiguration(db, { projectId: "hotel-toolkit" }), { enabled: false, reason: "not-configured", projectId: "hotel-toolkit", environment: "production" });
  db.doc = () => ({ get: async () => ({ exists: true, data: () => configuration({ environment: "staging" }) }) });
  await assert.rejects(readPurchasingMonitoringConfiguration(db, { projectId: "hotel-toolkit" }));
});
