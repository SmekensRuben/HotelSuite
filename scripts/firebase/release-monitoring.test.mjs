import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { monitoringResources, firestoreFields, firestoreData } from "./purchasing-monitoring-release.mjs";
import { assessPurchasingReadiness, pausePurchasingMonitoring, parseReleaseMonitoringArgs } from "./release-monitoring.mjs";

const PROJECT = "hotel-toolkit", NUMBER = "358734544002", BASE = `projects/${PROJECT}`;
const DATABASE = `${BASE}/databases/(default)`, MARKER = `${DATABASE}/documents/platformConfiguration/purchasingMonitoring`;
const WORKER = `${DATABASE}/documents/platformConfiguration/importMonitoringWorker`;
const RULES = "reviewed rules", RULESET = `${BASE}/rulesets/reviewed`, INDEX_PATH = `${DATABASE}/collectionGroups/-/indexes`;
const INDEXES = [{ collectionGroup: "orderAudit", queryScope: "COLLECTION", fields: [
  { fieldPath: "orderId", order: "ASCENDING" }, { fieldPath: "revision", order: "DESCENDING" } ] }];
const readyIndexes = indexes => indexes.map((index, position) => ({ ...structuredClone(index),
  name: `${DATABASE}/collectionGroups/${index.collectionGroup}/indexes/ready-${position}`, state: "READY" }));
const NOW = Date.UTC(2026, 9, 17, 10), CUTOFF = NOW - 600000, OLD_SHA = "a".repeat(40), NEW_SHA = "c".repeat(40);
const CONFIGURATION = { ...JSON.parse(await readFile(new URL("../../config/purchasing-monitoring.production.json", import.meta.url), "utf8")),
  enabled: true, releaseSha: OLD_SHA };
const RESOURCES = monitoringResources(CONFIGURATION, NUMBER), RUNTIME = RESOURCES.runtimeAccount;
const document = (value, updateTime = "2026-10-17T09:00:00Z") => ({ name: MARKER, fields: firestoreFields(value), updateTime });
const heartbeat = (patch = {}) => ({ lastSuccessfulAtMillis: NOW - 60000, failedHotels: 0, cycleFailedHotels: 0,
  lastSuccessfulCycleAtMillis: NOW - 60000, cycleStartedAtMillis: CUTOFF + 60000,
  lastCycleCheckedHotels: 2, lastCycleFailedHotels: 0, ...patch });

function fixture({ marker = document({ ...CONFIGURATION, activatedAtMillis: NOW - 86400000,
  activationHistory: [{ releaseSha: "b".repeat(40), activatedAtMillis: NOW - 172800000 }] }),
  worker = heartbeat(), overrides = {}, policies } = {}) {
  const operations = [];
  const ownedPolicies = policies || RESOURCES.policies.map((policy, index) => ({ ...structuredClone(policy),
    name: `${BASE}/alertPolicies/${index + 1}`, enabled: true }));
  let configuration = marker;
  const request = async operation => {
    operations.push(structuredClone(operation));
    const { api, path, method = "GET", body } = operation;
    const override = overrides[`${api}:${path}`];
    if (override !== undefined) return typeof override === "function" ? override(operation) : structuredClone(override);
    if (api === "resource") return path.endsWith(":getIamPolicy") ? { version: 3, bindings: [
      { role: "roles/cloudscheduler.serviceAgent", members: [`serviceAccount:service-${NUMBER}@gcp-sa-cloudscheduler.iam.gserviceaccount.com`] },
      ...RESOURCES.runtimeRoles.map(role => ({ role, members: [`serviceAccount:${RUNTIME}`] })) ] }
      : { projectId: PROJECT, projectNumber: NUMBER, lifecycleState: "ACTIVE" };
    if (api === "functions") return { name: `${BASE}/locations/us-central1/functions/checkPlatformImportHealth`,
      state: "ACTIVE", environment: "GEN_2", serviceConfig: { serviceAccountEmail: RUNTIME,
        service: `${BASE}/locations/us-central1/services/checkplatformimporthealth`, uri: "https://evaluator.example.run.app",
        environmentVariables: { RELEASE_MODE: "controlled", RELEASE_SHA: NEW_SHA, DEPLOYMENT_ENV: "production" } } };
    if (api === "scheduler") return { name: RESOURCES.schedulerName, state: "ENABLED", schedule: "every 15 minutes",
      httpTarget: { httpMethod: "POST", uri: "https://evaluator.example.run.app", oidcToken: { serviceAccountEmail: RUNTIME } } };
    if (api === "run") return { bindings: [{ role: "roles/run.invoker", members: [`serviceAccount:${RUNTIME}`] }] };
    if (api === "rules") return path.endsWith("/releases/cloud.firestore") ? { rulesetName: RULESET }
      : { source: { files: [{ content: RULES }] } };
    if (api === "firestore") {
      if (path === INDEX_PATH) return { indexes: readyIndexes(INDEXES) };
      if (path === MARKER) return structuredClone(configuration);
      if (path === WORKER) return worker ? document(worker) : null;
      if (path.endsWith("documents:commit")) {
        const write = body.writes[0];
        configuration = { ...configuration, fields: { ...configuration.fields, ...write.update.fields } };
        return {};
      }
    }
    if (api === "logging") return structuredClone(RESOURCES.metrics.find(metric => path.endsWith(`/${metric.name}`)));
    if (api === "monitoring") {
      if (path.endsWith("/timeSeries")) return { timeSeries: [{ points: [{
        interval: { endTime: new Date(NOW - 60000).toISOString() }, value: { int64Value: "1" } }] }] };
      if (method === "GET") return { alertPolicies: structuredClone(ownedPolicies) };
      const policy = ownedPolicies.find(entry => entry.name === path);
      if (method === "PATCH" && policy) { Object.assign(policy, structuredClone(body)); return policy; }
    }
    throw new Error(`Unexpected fixture operation ${api} ${method} ${path}`);
  };
  return { request, operations, policies: ownedPolicies, get marker() { return configuration; } };
}
const assess = (state, patch = {}) => assessPurchasingReadiness({ request: state.request, projectId: PROJECT,
  projectNumber: NUMBER, sha: NEW_SHA, now: NOW, rulesSource: RULES, indexes: INDEXES, ...patch });
const pause = (state, patch = {}) => pausePurchasingMonitoring({ request: state.request, projectId: PROJECT,
  projectNumber: NUMBER, now: NOW, ...patch });
const mutations = state => state.operations.filter(operation => ["POST", "PATCH", "PUT", "DELETE"].includes(operation.method)
  && !operation.path.endsWith(":getIamPolicy"));

test("CLI arguments bind production and default to read-only modes with an explicit verification cutoff", () => {
  assert.equal(parseReleaseMonitoringArgs(["preflight", "--project", PROJECT, "--sha", NEW_SHA]).apply, false);
  assert.equal(parseReleaseMonitoringArgs(["pause", "--project", PROJECT, "--sha", NEW_SHA, "--apply"]).apply, true);
  assert.equal(parseReleaseMonitoringArgs(["verify", "--project", PROJECT, "--sha", NEW_SHA, "--not-before-millis", String(CUTOFF)]).notBeforeMillis, CUTOFF);
  for (const args of [
    ["preflight", "--project", "hotel-toolkit-staging", "--sha", NEW_SHA],
    ["preflight", "--project", PROJECT, "--sha", NEW_SHA, "--apply"],
    ["pause", "--project", PROJECT, "--sha", NEW_SHA, "--apply", "--dry-run"],
    ["verify", "--project", PROJECT, "--sha", NEW_SHA],
    ["verify", "--project", PROJECT, "--sha", NEW_SHA, "--not-before-millis", "NaN"],
    ["preflight", "--project", PROJECT, "--sha", NEW_SHA, "--not-before-millis", String(CUTOFF)],
    ["pause", "--project", PROJECT, "--sha", NEW_SHA, "--sha", OLD_SHA],
    ["preflight", "--project", PROJECT, "--sha", "short"],
  ]) assert.throws(() => parseReleaseMonitoringArgs(args));
});

test("release readiness accepts the installed configuration SHA and is read-only before the first controlled deployment", async () => {
  const state = fixture({ worker: null });
  const result = await assess(state);
  assert.equal(result.prepared, true);
  assert.equal(result.verified, false);
  assert.equal(result.configurationReleaseSha, OLD_SHA);
  assert.equal(result.projectId, PROJECT);
  assert.equal(result.environment, "production");
  assert.deepEqual(mutations(state), []);
  assert.equal(state.operations.some(operation => operation.path.endsWith("/timeSeries")), false);
  assert.equal(state.operations.some(operation => operation.api === "rules" && operation.path === RULESET), true);
  assert.equal(state.operations.some(operation => operation.api === "firestore" && operation.path === INDEX_PATH), true);
});

test("readiness validates the published Rules and all required indexes without deploying or repairing resources", async () => {
  for (const overrides of [
    { [`rules:${RULESET}`]: { source: { files: [{ content: "older rules" }] } } },
    { [`rules:${BASE}/releases/cloud.firestore`]: { rulesetName: "projects/hotel-toolkit-staging/rulesets/foreign" } },
    { [`firestore:${INDEX_PATH}`]: { indexes: [] } },
    ...["CREATING", "NEEDS_REPAIR"].map(state => ({ [`firestore:${INDEX_PATH}`]: {
      indexes: readyIndexes(INDEXES).map(index => ({ ...index, state })),
    } })),
  ]) {
    const state = fixture({ overrides });
    await assert.rejects(assess(state));
    assert.deepEqual(mutations(state), []);
  }
});

test("readiness defaults to the committed Rules and composite-index manifest when no fixture sources are supplied", async () => {
  const committedRules = await readFile(new URL("../../firebase/firestore.rules", import.meta.url), "utf8");
  const manifest = JSON.parse(await readFile(new URL("../../firebase/firestore.indexes.json", import.meta.url), "utf8"));
  const state = fixture({ overrides: {
    [`rules:${RULESET}`]: { source: { files: [{ content: committedRules }] } },
    [`firestore:${INDEX_PATH}`]: { indexes: readyIndexes(manifest.indexes) },
  } });
  const result = await assessPurchasingReadiness({ request: state.request, projectId: PROJECT,
    projectNumber: NUMBER, sha: NEW_SHA, now: NOW });
  assert.equal(result.prepared, true);
  assert.equal(result.configurationReleaseSha, OLD_SHA);
  assert.equal(state.operations.some(operation => operation.api === "rules" && operation.path === RULESET), true);
  assert.equal(state.operations.some(operation => operation.api === "firestore" && operation.path === INDEX_PATH), true);
  assert.deepEqual(mutations(state), []);
});

test("readiness rejects absent, disabled, malformed, and other-environment markers without changes", async () => {
  for (const marker of [null, document({ ...CONFIGURATION, enabled: false }),
    document({ ...CONFIGURATION, schemaVersion: 2 }), document({ ...CONFIGURATION, environment: "staging" }),
    document({ ...CONFIGURATION, projectId: "hotel-toolkit-staging" }), document({ ...CONFIGURATION, releaseSha: "not-a-sha" })]) {
    const state = fixture({ marker });
    await assert.rejects(assess(state));
    assert.deepEqual(mutations(state), []);
  }
});

test("readiness rejects an installed configuration changed during its remote inspection", async () => {
  for (const changed of [{ ...CONFIGURATION, enabled: false }, { ...CONFIGURATION, releaseSha: "d".repeat(40) },
    { ...CONFIGURATION, thresholds: { ...CONFIGURATION.thresholds, pendingMinutes: 30 } }]) {
    let reads = 0;
    const state = fixture({ overrides: { [`firestore:${MARKER}`]: () => document(++reads === 1 ? CONFIGURATION : changed) } });
    await assert.rejects(assess(state));
    assert.deepEqual(mutations(state), []);
  }
});

test("readiness fails closed on identity, IAM, metric, policy, and scheduled invocation drift", async () => {
  const functionPath = `${BASE}/locations/us-central1/functions/checkPlatformImportHealth`;
  const runPath = `${BASE}/locations/us-central1/services/checkplatformimporthealth:getIamPolicy`;
  const policies = RESOURCES.policies.map((policy, index) => ({ ...structuredClone(policy), name: `${BASE}/alertPolicies/${index + 1}`, enabled: true }));
  const alteredPolicies = patch => ({ alertPolicies: [{ ...structuredClone(policies[0]), ...patch }, structuredClone(policies[1])] });
  const overrides = [
    { [`resource:${BASE}`]: { projectId: PROJECT, projectNumber: "123456789", lifecycleState: "ACTIVE" } },
    { [`resource:${BASE}:getIamPolicy`]: { bindings: [] } },
    { [`functions:${functionPath}`]: { state: "FAILED" } },
    { [`scheduler:${RESOURCES.schedulerName}`]: { state: "PAUSED" } },
    { [`run:${runPath}`]: { bindings: [{ role: "roles/run.invoker", members: ["allUsers"] }] } },
    { [`run:${runPath}`]: { bindings: [{ role: "roles/run.invoker", members: ["allAuthenticatedUsers"] }] } },
    { [`logging:${BASE}/metrics/${RESOURCES.metrics[0].name}`]: null },
    { [`logging:${BASE}/metrics/${RESOURCES.metrics[0].name}`]: { ...RESOURCES.metrics[0], disabled: true } },
    { [`logging:${BASE}/metrics/${RESOURCES.metrics[0].name}`]: { ...RESOURCES.metrics[0], filter: RESOURCES.metrics[0].filter.replace('environment="production"', 'environment="staging"') } },
    { [`monitoring:${BASE}/alertPolicies`]: alteredPolicies({ notificationChannels: [`${BASE}/notificationChannels/external`] }) },
    { [`monitoring:${BASE}/alertPolicies`]: alteredPolicies({ enabled: false }) },
    { [`monitoring:${BASE}/alertPolicies`]: alteredPolicies({ conditions: [] }) },
  ];
  for (const override of overrides) {
    const state = fixture({ overrides: override });
    await assert.rejects(assess(state));
    assert.deepEqual(mutations(state), []);
  }
});

test("readiness refuses non-production or mismatched project-number targets before remote reads", async () => {
  for (const target of [{ projectId: "hotel-toolkit-staging", projectNumber: "123456789" },
    { projectId: PROJECT, projectNumber: "123456789" }, { projectId: "hotel-toolkit-other", projectNumber: NUMBER }]) {
    const state = fixture();
    await assert.rejects(assess(state, target));
    await assert.rejects(pause(state, target));
    assert.deepEqual(state.operations, []);
  }
});

test("readiness rejects inherited public invocation and an incompatible explicit Scheduler OIDC audience", async () => {
  const ordinary = await fixture().request({ api: "resource", path: `${BASE}:getIamPolicy`, method: "POST" });
  for (const member of ["allUsers", "allAuthenticatedUsers"]) {
    const state = fixture({ overrides: { [`resource:${BASE}:getIamPolicy`]: { ...ordinary,
      bindings: [...ordinary.bindings, { role: "roles/run.invoker", members: [member] }] } } });
    await assert.rejects(assess(state), /public Cloud Run invocation/);
    assert.deepEqual(mutations(state), []);
  }
  const scheduler = await fixture().request({ api: "scheduler", path: RESOURCES.schedulerName });
  const state = fixture({ overrides: { [`scheduler:${RESOURCES.schedulerName}`]: { ...scheduler,
    httpTarget: { ...scheduler.httpTarget, oidcToken: { ...scheduler.httpTarget.oidcToken, audience: "https://unrelated.invalid" } } } } });
  await assert.rejects(assess(state), /Scheduler\/OIDC/);
  assert.deepEqual(mutations(state), []);
});

test("execution verification requires a supplied valid deployment cutoff", async () => {
  for (const notBeforeMillis of [undefined, 0, NaN, NOW + 1]) {
    const state = fixture();
    await assert.rejects(assess(state, { verifyExecution: true, notBeforeMillis }));
    assert.deepEqual(mutations(state), []);
  }
});

test("post-deployment verification requires fresh full-rotation evidence and an ingested metric after its cutoff", async () => {
  const state = fixture();
  const result = await assess(state, { verifyExecution: true, notBeforeMillis: CUTOFF });
  assert.equal(result.verified, true);
  assert.equal(result.lastSuccessfulAtMillis, NOW - 60000);
  assert.deepEqual(mutations(state), []);
  const query = state.operations.find(operation => operation.path.endsWith("/timeSeries"));
  assert.equal(query.params["interval.startTime"], new Date(CUTOFF).toISOString());
  assert.equal(query.params["interval.endTime"], new Date(NOW).toISOString());
  assert.match(query.params.filter, /resource\.labels\.project_id="hotel-toolkit"/);
});

test("post-deployment verification checks controlled production runtime mode and the deployed candidate SHA", async () => {
  const path = `${BASE}/locations/us-central1/functions/checkPlatformImportHealth`;
  for (const environmentVariables of [undefined, { RELEASE_MODE: "controlled", DEPLOYMENT_ENV: "production" },
    { RELEASE_MODE: "legacy", RELEASE_SHA: NEW_SHA, DEPLOYMENT_ENV: "production" },
    { RELEASE_MODE: "controlled", RELEASE_SHA: OLD_SHA, DEPLOYMENT_ENV: "production" },
    { RELEASE_MODE: "controlled", RELEASE_SHA: NEW_SHA },
    { RELEASE_MODE: "controlled", RELEASE_SHA: NEW_SHA, DEPLOYMENT_ENV: "staging" }]) {
    const state = fixture({ overrides: { [`functions:${path}`]: { name: path, state: "ACTIVE", environment: "GEN_2",
      serviceConfig: { serviceAccountEmail: RUNTIME, service: `${BASE}/locations/us-central1/services/checkplatformimporthealth`,
        uri: "https://evaluator.example.run.app", environmentVariables } } } });
    assert.equal((await assess(state)).prepared, true);
    await assert.rejects(assess(state, { verifyExecution: true, notBeforeMillis: CUTOFF }));
    assert.deepEqual(mutations(state), []);
  }
});

test("old, future, partial, failed and empty full-rotation heartbeats never verify execution", async () => {
  const stale = NOW - (CONFIGURATION.evaluatorStaleMinutes + 1) * 60000;
  for (const worker of [null, heartbeat({ lastSuccessfulAtMillis: CUTOFF }), heartbeat({ lastSuccessfulAtMillis: NOW + 1 }),
    heartbeat({ lastSuccessfulAtMillis: stale }), heartbeat({ failedHotels: 1 }), heartbeat({ cycleFailedHotels: 1 }),
    heartbeat({ lastCycleFailedHotels: 1 }), heartbeat({ lastCycleCheckedHotels: 0 }),
    heartbeat({ cycleStartedAtMillis: CUTOFF }), heartbeat({ cycleStartedAtMillis: NOW + 1 }),
    heartbeat({ lastSuccessfulCycleAtMillis: CUTOFF }), heartbeat({ lastSuccessfulCycleAtMillis: NOW + 1 })]) {
    const state = fixture({ worker });
    await assert.rejects(assess(state, { verifyExecution: true, notBeforeMillis: CUTOFF }));
    assert.deepEqual(mutations(state), []);
  }
});

test("a marker, zero-valued, stale, future, or absent metric cannot substitute for real ingested execution evidence", async () => {
  for (const series of [{}, { timeSeries: [] }, { timeSeries: [{ points: [] }] },
    { timeSeries: [{ points: [{ interval: { endTime: new Date(NOW - 60000).toISOString() }, value: { int64Value: "0" } }] }] },
    ...[CUTOFF, NOW + 1].map(end => ({ timeSeries: [{ points: [{ interval: { endTime: new Date(end).toISOString() }, value: { int64Value: "1" } }] }] }))]) {
    const state = fixture({ overrides: { [`monitoring:${BASE}/timeSeries`]: series } });
    await assert.rejects(assess(state, { verifyExecution: true, notBeforeMillis: CUTOFF }));
    assert.deepEqual(mutations(state), []);
  }
});

test("a deployment cutoff never makes a metric older than the configured freshness window valid", async () => {
  const oldCutoff = NOW - 7200000, stale = NOW - (CONFIGURATION.evaluatorStaleMinutes + 1) * 60000;
  const state = fixture({ overrides: { [`monitoring:${BASE}/timeSeries`]: { timeSeries: [{ points: [{
    interval: { endTime: new Date(stale).toISOString() }, value: { int64Value: "1" } }] }] } } });
  await assert.rejects(assess(state, { verifyExecution: true, notBeforeMillis: oldCutoff }));
  const query = state.operations.find(operation => operation.path.endsWith("/timeSeries"));
  assert.equal(query.params["interval.startTime"], new Date(NOW - CONFIGURATION.evaluatorStaleMinutes * 60000).toISOString());
  assert.deepEqual(mutations(state), []);
});

test("a long full hotel rotation verifies when it started after deployment and completed freshly", async () => {
  const notBeforeMillis = NOW - 7200000, cycleStartedAtMillis = NOW - 3600000;
  const state = fixture({ worker: heartbeat({ cycleStartedAtMillis }) });
  assert.equal((await assess(state, { verifyExecution: true, notBeforeMillis })).verified, true);
  assert.deepEqual(mutations(state), []);
  const stale = fixture({ worker: heartbeat({ cycleStartedAtMillis,
    lastSuccessfulCycleAtMillis: NOW - (CONFIGURATION.evaluatorStaleMinutes + 1) * 60000 }) });
  await assert.rejects(assess(stale, { verifyExecution: true, notBeforeMillis }));
  assert.deepEqual(mutations(stale), []);
});

test("pause dry-run inventories only and does not disable an existing evaluator", async () => {
  const state = fixture();
  const result = await pause(state);
  assert.equal(result.dryRun, true);
  assert.equal(result.paused, false);
  assert.deepEqual(mutations(state), []);
  assert.equal(firestoreData(state.marker).enabled, true);
  assert.equal(state.operations.some(operation => ["functions", "scheduler", "run"].includes(operation.api)), false);
});

test("pause changes only the marker enabled field with an optimistic mask, then disables the two owned policies", async () => {
  const state = fixture(), original = structuredClone(state.marker);
  state.marker.fields.opaqueHistory = { timestampValue: "2026-01-01T00:00:00.123456789Z" };
  const result = await pause(state, { apply: true });
  assert.equal(result.paused, true);
  const changes = mutations(state);
  assert.deepEqual(changes.map(operation => operation.api), ["firestore", "monitoring", "monitoring"]);
  const write = changes[0].body.writes[0];
  assert.equal(write.update.name, MARKER);
  assert.deepEqual(write.updateMask, { fieldPaths: ["enabled"] });
  assert.deepEqual(write.currentDocument, { updateTime: original.updateTime });
  assert.deepEqual(write.update.fields, firestoreFields({ enabled: false }));
  assert.deepEqual(state.marker.fields.opaqueHistory, { timestampValue: "2026-01-01T00:00:00.123456789Z" });
  assert.deepEqual(firestoreData(state.marker).activationHistory, firestoreData(original).activationHistory);
  for (const change of changes.slice(1)) {
    assert.equal(change.params.updateMask, "enabled");
    assert.deepEqual(change.body, { name: change.path, enabled: false });
  }
  assert.equal(state.operations.some(operation => ["functions", "scheduler", "run"].includes(operation.api)
    || operation.path === WORKER || operation.path.includes("incidents")), false);
});

test("pause tolerates a missing marker and disables only owned production policy identities", async () => {
  const own = RESOURCES.policies.map((policy, index) => ({ ...structuredClone(policy), name: `${BASE}/alertPolicies/${index + 1}`, enabled: true }));
  const unrelated = [{ ...structuredClone(own[0]), name: `${BASE}/alertPolicies/third`, displayName: "Another component",
    userLabels: { ...own[0].userLabels, hotelsuite_component: "another_component" } },
  { ...structuredClone(own[0]), name: `${BASE}/alertPolicies/staging`, displayName: "Staging evaluator",
    userLabels: { ...own[0].userLabels, hotelsuite_environment: "staging" } }];
  const state = fixture({ marker: null, policies: [...own, ...unrelated] });
  const result = await pause(state, { apply: true });
  assert.equal(result.configured, false);
  assert.deepEqual(mutations(state).map(operation => operation.path), own.map(policy => policy.name));
  assert.deepEqual(state.policies.map(policy => policy.enabled), [false, false, true, true]);
});

test("pause refuses ownership conflicts and non-optimistic marker writes before any mutations", async () => {
  const conflict = { ...structuredClone(RESOURCES.policies[0]), name: `${BASE}/alertPolicies/conflict`, enabled: true,
    userLabels: { hotelsuite_component: "unrelated" } };
  const noVersion = document(CONFIGURATION); delete noVersion.updateTime;
  const wrongProject = { ...structuredClone(RESOURCES.policies[0]),
    name: "projects/hotel-toolkit-staging/alertPolicies/wrong-project", enabled: true };
  for (const state of [fixture({ policies: [conflict] }), fixture({ policies: [wrongProject] }), fixture({ marker: noVersion })]) {
    await assert.rejects(pause(state, { apply: true }));
    assert.deepEqual(mutations(state), []);
  }
});

test("an optimistic marker update failure stops pause before changing alert policies", async () => {
  const state = fixture({ overrides: { [`firestore:${DATABASE}/documents:commit`]: () => { throw new Error("conflict"); } } });
  await assert.rejects(pause(state, { apply: true }), /conflict/);
  assert.deepEqual(mutations(state).map(operation => operation.api), ["firestore"]);
  assert.deepEqual(state.policies.map(policy => policy.enabled), [true, true]);
});
