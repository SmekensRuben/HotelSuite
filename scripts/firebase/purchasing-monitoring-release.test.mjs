import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parsePurchasingMonitoringArgs, requirePurchasingMonitoringTarget, monitoringResources, firestoreFields, firestoreData,
  createMonitoringRequest, runPurchasingMonitoringRelease } from "./purchasing-monitoring-release.mjs";

const SHA = "a".repeat(40), PROJECT = "hotel-toolkit", NUMBER = "358734544002", BASE = `projects/${PROJECT}`;
const CONFIGURATION = { ...JSON.parse(await readFile(new URL("../../config/purchasing-monitoring.production.json", import.meta.url), "utf8")), releaseSha: SHA };
const INDEXES = [{ collectionGroup: "orderAudit", queryScope: "COLLECTION", fields: [{ fieldPath: "orderId", order: "ASCENDING" }, { fieldPath: "revision", order: "DESCENDING" }] }];
const RUNTIME = `${NUMBER}-compute@developer.gserviceaccount.com`, NOW = 10000000;
const opts = (patch = {}) => ({ phase: "preflight", projectId: PROJECT, projectNumber: NUMBER, sha: SHA, apply: false, ...patch });
const doc = (value, updateTime = "2026-10-17T00:00:00Z") => ({ fields: firestoreFields(value), updateTime });

function fixture({ prepared = false, active = false, heartbeat, overrides = {} } = {}) {
  const operations = [], resources = monitoringResources(CONFIGURATION, NUMBER);
  const iam = { version: 3, etag: "etag", bindings: [
    { role: "roles/cloudscheduler.serviceAgent", members: [`serviceAccount:service-${NUMBER}@gcp-sa-cloudscheduler.iam.gserviceaccount.com`] },
    { role: "roles/run.invoker", members: [`serviceAccount:${RUNTIME}`] },
    ...(prepared ? resources.runtimeRoles.map(role => ({ role, members: [`serviceAccount:${RUNTIME}`] })) : []) ] };
  const policies = prepared ? resources.policies.map((policy, index) => ({ ...structuredClone(policy), name: `${BASE}/alertPolicies/${index + 1}`, enabled: active })) : [];
  let marker = active ? doc({ ...CONFIGURATION, enabled: true, activatedAtMillis: NOW - 600000 }) : null;
  const request = async operation => {
    operations.push(structuredClone(operation));
    const { api, path, method = "GET", body } = operation;
    const override = overrides[`${api}:${path}`];
    if (override !== undefined) return typeof override === "function" ? override(operation) : structuredClone(override);
    if (api === "resource") {
      if (path.endsWith(":getIamPolicy")) return structuredClone(iam);
      if (path.endsWith(":setIamPolicy")) { Object.assign(iam, structuredClone(body.policy)); return iam; }
      return { projectId: PROJECT, projectNumber: NUMBER, lifecycleState: "ACTIVE" };
    }
    if (api === "functions") return { name: `${BASE}/locations/us-central1/functions/checkPlatformImportHealth`, environment: "GEN_2", state: "ACTIVE", serviceConfig: {
      serviceAccountEmail: RUNTIME, service: `${BASE}/locations/us-central1/services/checkplatformimporthealth`, uri: "https://evaluator.example.run.app" } };
    if (api === "scheduler") return { name: resources.schedulerName, state: "ENABLED", schedule: "every 15 minutes", httpTarget: { httpMethod: "POST", uri: "https://evaluator.example.run.app", oidcToken: { serviceAccountEmail: RUNTIME } } };
    if (api === "run") return { bindings: [] };
    if (api === "rules") return path.includes("/releases/") ? { rulesetName: `${BASE}/rulesets/reviewed` } : { source: { files: [{ content: "reviewed rules" }] } };
    if (api === "firestore") {
      if (path.endsWith("/indexes")) return method === "POST" ? { name: `${BASE}/databases/(default)/operations/create` } : { indexes: prepared ? INDEXES.map(index => ({ ...index, name: `${BASE}/databases/(default)/collectionGroups/${index.collectionGroup}/indexes/ready`, state: "READY" })) : [] };
      if (path.endsWith("documents:commit")) { marker = { ...body.writes[0].update, updateTime: "2026-10-17T01:00:00Z" }; return {}; }
      if (path.endsWith("/purchasingMonitoring")) return marker;
      if (path.endsWith("/importMonitoringWorker")) return heartbeat ? doc(heartbeat) : null;
    }
    if (api === "logging") return method === "GET" ? prepared ? resources.metrics.find(metric => path.endsWith(`/${metric.name}`)) : null : {};
    if (api === "monitoring") {
      if (path.endsWith("/timeSeries")) return { timeSeries: [{ points: [{ interval: { endTime: new Date(NOW - 60000).toISOString() } }] }] };
      if (method === "GET") return { alertPolicies: structuredClone(policies) };
      if (method === "POST") { policies.push({ ...structuredClone(body), name: `${BASE}/alertPolicies/${policies.length + 1}` }); return policies.at(-1); }
      const current = policies.find(policy => policy.name === path);
      if (current) Object.assign(current, structuredClone(body));
      return current || {};
    }
    throw new Error(`Unexpected fixture request ${api} ${method} ${path}`);
  };
  return { request, operations, policies, get marker() { return marker; } };
}
const successfulHeartbeat = (patch = {}) => ({ lastSuccessfulAtMillis: NOW - 60000, failedHotels: 0,
  lastSuccessfulCycleAtMillis: NOW - 60000, cycleStartedAtMillis: NOW - 300000, lastCycleCheckedHotels: 2, lastCycleFailedHotels: 0, ...patch });
const run = (state, options = {}) => runPurchasingMonitoringRelease({ request: state.request, options: opts(options), configuration: CONFIGURATION, indexes: INDEXES, rulesSource: "reviewed rules", now: NOW });
const mutations = state => state.operations.filter(operation => ["POST", "PUT", "PATCH", "DELETE"].includes(operation.method) && !operation.path.endsWith(":getIamPolicy"));

test("arguments default to dry-run, pin project identities, and require explicit mutation confirmation", () => {
  assert.equal(parsePurchasingMonitoringArgs(["prepare", "--project", PROJECT, "--sha", SHA]).apply, false);
  assert.throws(() => parsePurchasingMonitoringArgs(["activate", "--project", PROJECT, "--sha", SHA, "--apply"]));
  assert.throws(() => parsePurchasingMonitoringArgs(["prepare", "--project", PROJECT, "--sha", SHA, "--apply", "--confirm-project", PROJECT, "--dry-run"]));
  assert.throws(() => parsePurchasingMonitoringArgs(["plan", "--project", "hotel-toolkit-staging", "--sha", SHA, "--project-number", NUMBER]));
  assert.throws(() => parsePurchasingMonitoringArgs(["plan", "--project", "test-breakfast", "--sha", SHA]));
  assert.throws(() => requirePurchasingMonitoringTarget(opts(), { GCLOUD_PROJECT: "hotel-toolkit-staging" }));
  assert.throws(() => requirePurchasingMonitoringTarget(opts(), { FIRESTORE_EMULATOR_HOST: "localhost:8080" }));
});

test("Cloud Monitoring uses independent failure and absence signals, combines revisions, and has no external channels", () => {
  const resources = monitoringResources(CONFIGURATION, NUMBER);
  assert.equal(resources.metrics.length, 2);
  assert.match(resources.metrics[0].filter, /jsonPayload\.environment="production"/);
  assert.match(resources.metrics[1].filter, /jsonPayload\.outcome="failure"/);
  assert.equal(resources.policies[0].conditions[0].conditionAbsent.duration, "2700s");
  assert.equal(resources.policies[0].conditions[0].conditionAbsent.aggregations[0].crossSeriesReducer, "REDUCE_SUM");
  resources.policies.forEach(policy => { assert.equal(policy.enabled, false); assert.deepEqual(policy.notificationChannels, []); });
});

test("preflight and prepare dry-run perform no mutations", async () => {
  for (const phase of ["preflight", "prepare"]) {
    const state = fixture();
    const result = await run(state, { phase });
    assert.equal(result.dryRun, true); assert.equal(result.schedulerVerified, true);
    assert.deepEqual(mutations(state), []);
    assert.deepEqual(result.missingRuntimeRoles, ["roles/datastore.user", "roles/logging.logWriter"]);
  }
});

test("prepare only adds reviewed runtime roles, missing indexes and internal evaluator monitoring", async () => {
  const state = fixture();
  await run(state, { phase: "prepare", apply: true, confirmProject: PROJECT });
  const changes = mutations(state);
  assert.equal(changes.length, 6);
  assert.equal(changes.filter(operation => operation.api === "firestore").length, 1);
  assert.equal(changes.some(operation => operation.path.endsWith("documents:commit")), false);
  assert.deepEqual(state.policies.map(policy => policy.enabled), [false, false]);
  const policy = changes.find(operation => operation.api === "resource").body.policy;
  assert.equal(policy.etag, "etag"); assert.equal(policy.bindings.length, 4);
});

test("activation requires full preparation and updates policies before an optimistic environment marker", async () => {
  await assert.rejects(run(fixture(), { phase: "activate", apply: true, confirmProject: PROJECT }), /Preparation is incomplete/);
  const state = fixture({ prepared: true });
  await run(state, { phase: "activate", apply: true, confirmProject: PROJECT });
  assert.deepEqual(mutations(state).map(operation => operation.api), ["monitoring", "monitoring", "firestore"]);
  const commit = mutations(state).at(-1).body.writes[0];
  assert.deepEqual(commit.currentDocument, { exists: false });
  assert.equal(firestoreData(commit.update).enabled, true);
  assert.equal(firestoreData(commit.update).projectId, PROJECT);
  assert.equal(firestoreData(commit.update).activatedAtMillis, NOW);
});

test("verification requires fresh fully successful scheduled evidence and a real ingested metric after activation", async () => {
  for (const heartbeat of [undefined, successfulHeartbeat({ lastSuccessfulAtMillis: NOW - 700000 }), successfulHeartbeat({ failedHotels: 1 }),
    successfulHeartbeat({ lastSuccessfulCycleAtMillis: NOW - 700000 }), successfulHeartbeat({ lastCycleFailedHotels: 1 }),
    successfulHeartbeat({ lastCycleCheckedHotels: 0 }), successfulHeartbeat({ cycleStartedAtMillis: NOW - 700000 })]) {
    await assert.rejects(run(fixture({ prepared: true, active: true, heartbeat }), { phase: "verify" }), /fresh successful scheduled evaluation/);
  }
  const state = fixture({ prepared: true, active: true, heartbeat: successfulHeartbeat() });
  assert.equal((await run(state, { phase: "verify" })).verified, true);
  assert.deepEqual(mutations(state), []);
  const empty = fixture({ prepared: true, active: true, heartbeat: successfulHeartbeat(), overrides: { [`monitoring:${BASE}/timeSeries`]: {} } });
  await assert.rejects(run(empty, { phase: "verify" }), /real evaluator success log metric/);
});

test("pause first disables the marker and then owned policies, even with a broken evaluator", async () => {
  const state = fixture({ prepared: true, active: true });
  await run(state, { phase: "pause", apply: true, confirmProject: PROJECT });
  assert.equal(state.operations.some(operation => operation.api === "functions" || operation.api === "scheduler"), false);
  assert.deepEqual(mutations(state).map(operation => operation.api), ["firestore", "monitoring", "monitoring"]);
  assert.equal(firestoreData(state.marker).enabled, false);
  assert.deepEqual(state.policies.map(policy => policy.enabled), [false, false]);
});

test("preflight refuses source, identity, Scheduler and alert-channel conflicts before changes", async () => {
  const overrides = [
    { [`resource:${BASE}`]: { projectId: PROJECT, projectNumber: "123456789", lifecycleState: "ACTIVE" } },
    { [`rules:${BASE}/rulesets/reviewed`]: { source: { files: [{ content: "old rules" }] } } },
    { [`scheduler:${monitoringResources(CONFIGURATION, NUMBER).schedulerName}`]: { state: "PAUSED" } },
    { [`run:${BASE}/locations/us-central1/services/checkplatformimporthealth:getIamPolicy`]: { bindings: [{ role: "roles/run.invoker", members: ["allUsers"] }] } },
  ];
  for (const override of overrides) {
    const state = fixture({ overrides: override });
    await assert.rejects(run(state, { phase: "prepare", apply: true, confirmProject: PROJECT }));
    assert.deepEqual(mutations(state), []);
  }
  const resources = monitoringResources(CONFIGURATION, NUMBER);
  const state = fixture({ overrides: { [`monitoring:${BASE}/alertPolicies`]: { alertPolicies: [{ ...resources.policies[0], name: `${BASE}/alertPolicies/1`, notificationChannels: ["external"] }] } } });
  await assert.rejects(run(state), /channel conflict/);
});

test("request failures redact OAuth/provider payloads and project-prefix lookalikes are rejected", async () => {
  const request = createMonitoringRequest(PROJECT, "secret-oauth", async () => ({ ok: false, status: 403, json: async () => ({ error: { message: "secret-oauth private provider payload" } }) }));
  await assert.rejects(request({ api: "monitoring", path: `${BASE}/alertPolicies` }), error => !error.message.includes("secret-oauth") && !error.message.includes("private provider payload"));
  await assert.rejects(request({ api: "monitoring", path: "projects/hotel-toolkit-staging/alertPolicies" }), /Unexpected monitoring API target/);
});
