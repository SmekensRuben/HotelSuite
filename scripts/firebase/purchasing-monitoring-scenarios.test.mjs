import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { parseScenarioArguments, scenarioRecords, applyScenarios } from "./purchasing-monitoring-scenarios.mjs";
const require = createRequire(import.meta.url);
const { classifyPurchasingSignal } = require("../../functions/src/purchasingMonitoringPolicy");

test("synthetic scenarios reject production and unconfirmed writes before SDK access", async () => {
  for (const projectId of ["hotel-toolkit", "test-breakfast", "demo-hotel-toolkit-staging", undefined]) {
    assert.throws(() => parseScenarioArguments(["seed", "--project", projectId]));
  }
  assert.throws(() => parseScenarioArguments(["seed", "--project", "hotel-toolkit-staging", "--apply"]));
  await assert.rejects(applyScenarios({ projectId: "hotel-toolkit" }, {}), /real staging project/);
  assert.equal(parseScenarioArguments(["seed", "--project", "hotel-toolkit-staging"]).apply, false);
  assert.equal(parseScenarioArguments(["recover", "--project", "hotel-toolkit-staging", "--apply", "--confirm-project", "hotel-toolkit-staging"]).apply, true);
});

test("fictional source records exercise failure, stall, unknown, pause and simulation without an outbox", () => {
  const now = Date.parse("2026-10-17T10:00:00Z");
  const records = scenarioRecords(now);
  assert.deepEqual(records.map(({ id, data }) => classifyPurchasingSignal("imports", id, data, { environment: "staging" }, now).status),
    ["failed", "stalled", "unknown", "paused", "simulated"]);
  for (const { data } of records) {
    assert.equal(data.environment, "staging");
    assert.equal(data.descriptor.fileType, "monitoringFixture");
    assert.equal(data.descriptor.bucket, undefined);
    assert.match(data.descriptor.name, /^imports\/staging-hotel-a\/monitoring-fixture\//);
    assert.equal(data.descriptor.generation, undefined);
    assert.equal(data.actorUid, undefined);
  }
});
