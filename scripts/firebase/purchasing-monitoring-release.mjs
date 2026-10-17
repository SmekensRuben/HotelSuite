// Project-bound operator tooling. Every remote mode is read-only unless --apply is explicit.
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { CONFIGURATION_PATH, validatePurchasingMonitoringConfiguration } = require("../../functions/src/purchasingMonitoringConfig.js");
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PRODUCTION_NUMBER = "358734544002";
const OPERATOR = "bestsmekens@gmail.com";
const FUNCTION_ID = "checkPlatformImportHealth";
const REGION = "us-central1";
const COMPONENT = "purchasing_monitoring";
const METRICS = { success: "hotelsuite_purchasing_monitoring_evaluations", failure: "hotelsuite_purchasing_monitoring_failures" };
const APIS = Object.freeze({ resource: "https://cloudresourcemanager.googleapis.com/v1/", firestore: "https://firestore.googleapis.com/v1/",
  functions: "https://cloudfunctions.googleapis.com/v2/", scheduler: "https://cloudscheduler.googleapis.com/v1/",
  run: "https://run.googleapis.com/v2/", rules: "https://firebaserules.googleapis.com/v1/", logging: "https://logging.googleapis.com/v2/",
  monitoring: "https://monitoring.googleapis.com/v3/" });
const MUTATIONS = new Set(["prepare", "activate", "pause"]);

export function parsePurchasingMonitoringArgs(args) {
  const options = { phase: args[0], apply: false };
  const flags = new Map([["--project", "projectId"], ["--project-number", "projectNumber"], ["--sha", "sha"], ["--confirm-project", "confirmProject"]]);
  const seen = new Set();
  for (let i = 1; i < args.length; i++) {
    const flag = args[i];
    if (seen.has(flag) || !flags.has(flag) && !["--apply", "--dry-run"].includes(flag)) throw new Error("Use unique supported purchasing monitoring arguments.");
    seen.add(flag);
    if (flag === "--apply") options.apply = true;
    else if (flag !== "--dry-run") {
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}.`);
      options[flags.get(flag)] = value;
    }
  }
  if (!["plan", "preflight", "prepare", "activate", "verify", "pause"].includes(options.phase)
    || !["hotel-toolkit", "hotel-toolkit-staging"].includes(options.projectId) || !/^[a-f0-9]{40}$/.test(options.sha || "")) {
    throw new Error("Use plan|preflight|prepare|activate|verify|pause --project hotel-toolkit|hotel-toolkit-staging --sha <40-character SHA> [--project-number <staging number>] [--dry-run | --apply --confirm-project <project>].");
  }
  if (options.projectId === "hotel-toolkit") {
    if (options.projectNumber && options.projectNumber !== PRODUCTION_NUMBER) throw new Error("Production project number mismatch.");
    options.projectNumber = PRODUCTION_NUMBER;
  } else if (!/^[1-9][0-9]{5,19}$/.test(options.projectNumber || "") || options.projectNumber === PRODUCTION_NUMBER) {
    throw new Error("Staging requires its separately verified --project-number; the production number is forbidden.");
  }
  if (options.apply && (!MUTATIONS.has(options.phase) || options.confirmProject !== options.projectId || seen.has("--dry-run"))) {
    throw new Error("Only prepare, activate and pause accept --apply, with the exact --confirm-project and without --dry-run.");
  }
  return options;
}

export function requirePurchasingMonitoringTarget(options, env = process.env) {
  if (!['hotel-toolkit', 'hotel-toolkit-staging'].includes(options.projectId)) throw new Error("Unknown monitoring project.");
  if (options.projectId === "hotel-toolkit" ? options.projectNumber !== PRODUCTION_NUMBER
    : !/^[1-9][0-9]{5,19}$/.test(options.projectNumber || "") || options.projectNumber === PRODUCTION_NUMBER) throw new Error("Monitoring project number mismatch.");
  for (const key of ["FIRESTORE_EMULATOR_HOST", "FIREBASE_AUTH_EMULATOR_HOST", "FIREBASE_STORAGE_EMULATOR_HOST", "STORAGE_EMULATOR_HOST", "FUNCTIONS_EMULATOR"]) {
    if (env[key]) throw new Error("Remove emulator configuration before remote monitoring preparation.");
  }
  for (const key of ["GCLOUD_PROJECT", "GOOGLE_CLOUD_PROJECT", "GCP_PROJECT", "CLOUDSDK_CORE_PROJECT"]) {
    if (env[key] && env[key] !== options.projectId) throw new Error("An ambient Google project conflicts with the explicit monitoring target.");
  }
  if (env.FIREBASE_CONFIG) {
    let value;
    try { value = JSON.parse(env.FIREBASE_CONFIG); } catch { throw new Error("Malformed ambient Firebase configuration."); }
    if (value.projectId !== options.projectId) throw new Error("Ambient Firebase configuration conflicts with the monitoring project.");
  }
}

export function monitoringResources(configuration, projectNumber) {
  const { projectId, environment, evaluatorStaleMinutes } = configuration;
  const filter = `resource.type="cloud_run_revision" AND resource.labels.project_id="${projectId}" AND jsonPayload.event="purchasing-monitoring-evaluation" AND jsonPayload.projectId="${projectId}" AND jsonPayload.environment="${environment}"`;
  const metrics = Object.entries(METRICS).map(([outcome, name]) => ({ name,
    description: `HotelSuite purchasing evaluator ${outcome}; ${environment}; no provider deliveries are inferred.`,
    filter: `${filter} AND jsonPayload.outcome="${outcome}"`,
    metricDescriptor: { metricKind: "DELTA", valueType: "INT64", unit: "1" }, disabled: false }));
  const policies = Object.entries(METRICS).map(([outcome, metric]) => {
    const metricFilter = `metric.type="logging.googleapis.com/user/${metric}" AND resource.type="cloud_run_revision" AND resource.labels.project_id="${projectId}"`;
    return { displayName: `HotelSuite purchasing evaluator ${outcome === "success" ? "absent" : "failed"} (${environment})`,
      userLabels: { hotelsuite_component: COMPONENT, hotelsuite_environment: environment, hotelsuite_signal: outcome },
      combiner: "OR", enabled: false, notificationChannels: [],
      documentation: { mimeType: "text/markdown", content: `Project: ${projectId}. Review platformConfiguration/importMonitoringWorker and Cloud Scheduler ${FUNCTION_ID}. This policy creates an internal Cloud Monitoring incident only; no email, webhook or external channel is configured. Staging simulation never proves production delivery.` },
      alertStrategy: { autoClose: "604800s" }, conditions: [{ displayName: outcome === "success" ? "Successful evaluator executions absent" : "Evaluator execution failed",
        ...(outcome === "success" ? { conditionAbsent: { filter: metricFilter, duration: `${evaluatorStaleMinutes * 60}s`,
          aggregations: [{ alignmentPeriod: "60s", perSeriesAligner: "ALIGN_SUM", crossSeriesReducer: "REDUCE_SUM" }], trigger: { count: 1 } } }
          : { conditionThreshold: { filter: metricFilter, comparison: "COMPARISON_GT", thresholdValue: 0, duration: "0s",
            aggregations: [{ alignmentPeriod: "60s", perSeriesAligner: "ALIGN_SUM", crossSeriesReducer: "REDUCE_SUM" }], trigger: { count: 1 } } }) }] };
  });
  return { metrics, policies, runtimeAccount: `${projectNumber}-compute@developer.gserviceaccount.com`,
    runtimeRoles: ["roles/datastore.user", "roles/logging.logWriter"],
    schedulerName: `projects/${projectId}/locations/${REGION}/jobs/firebase-schedule-${FUNCTION_ID}-${REGION}` };
}

export function firestoreFields(value) {
  const field = entry => entry === null ? { nullValue: null } : typeof entry === "boolean" ? { booleanValue: entry }
    : typeof entry === "number" ? Number.isSafeInteger(entry) ? { integerValue: String(entry) } : { doubleValue: entry }
      : typeof entry === "string" ? { stringValue: entry } : Array.isArray(entry) ? { arrayValue: { values: entry.map(field) } }
        : { mapValue: { fields: firestoreFields(entry) } };
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, field(entry)]));
}
export function firestoreData(document) {
  const value = field => "stringValue" in field ? field.stringValue : "integerValue" in field ? Number(field.integerValue)
    : "doubleValue" in field ? field.doubleValue : "booleanValue" in field ? field.booleanValue : "mapValue" in field ? firestoreData(field.mapValue)
      : "arrayValue" in field ? (field.arrayValue.values || []).map(value) : "timestampValue" in field ? field.timestampValue : null;
  return Object.fromEntries(Object.entries(document?.fields || {}).map(([key, field]) => [key, value(field)]));
}

export function createMonitoringRequest(projectId, token, fetchRequest = fetch) {
  return async ({ api, path, method = "GET", body, params = {}, allowMissing = false }) => {
    if (!APIS[api] || typeof path !== "string" || !([`projects/${projectId}`, `projects/${projectId}/`, `projects/${projectId}:`].some(prefix => prefix === `projects/${projectId}` ? path === prefix : path.startsWith(prefix)))) throw new Error("Unexpected monitoring API target.");
    const url = new URL(path, APIS[api]);
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
    let response;
    try { response = await fetchRequest(url, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Goog-User-Project": projectId },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) }); }
    catch { throw new Error(`Monitoring ${api} request failed (transport error). No credential or provider payload was printed.`); }
    if (allowMissing && response.status === 404) return null;
    if (!response.ok) throw new Error(`Monitoring ${api} request failed (HTTP ${response.status}). No credential or provider payload was printed.`);
    if (response.status === 204) return {};
    try { return await response.json(); } catch { throw new Error(`Monitoring ${api} response was not JSON.`); }
  };
}

async function listAll(request, operation, key) {
  const result = [], seen = new Set();
  let pageToken;
  for (let page = 0; page < 20; page++) {
    const response = await request({ ...operation, params: { ...operation.params, ...(pageToken ? { pageToken } : {}) } });
    if (!Array.isArray(response[key] || [])) throw new Error("Invalid monitoring inventory response.");
    result.push(...(response[key] || []));
    if (result.length > 2000) throw new Error("Monitoring inventory exceeds the bounded operator limit.");
    if (!response.nextPageToken) return result;
    if (typeof response.nextPageToken !== "string" || seen.has(response.nextPageToken)) throw new Error("Invalid monitoring inventory pagination.");
    pageToken = response.nextPageToken; seen.add(pageToken);
  }
  throw new Error("Monitoring inventory pagination exceeds the operator limit.");
}

function indexSignature(index) {
  const fields = structuredClone(index.fields);
  if (fields.at(-1)?.fieldPath === "__name__") fields.pop();
  return JSON.stringify({ collectionGroup: index.collectionGroup, queryScope: index.queryScope, fields });
}
const unconditionalRole = (policy, role, member) => policy.bindings?.some(binding => binding.role === role && !binding.condition && binding.members?.includes(member));
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const same = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));
function ownedPolicy(existing, desired, projectId) {
  return existing.name?.startsWith(`projects/${projectId}/alertPolicies/`)
    && Object.entries(desired.userLabels).every(([key, value]) => existing.userLabels?.[key] === value);
}
function policyContent(policy) { return { displayName: policy.displayName, userLabels: policy.userLabels, combiner: policy.combiner,
  notificationChannels: policy.notificationChannels || [], documentation: policy.documentation, alertStrategy: policy.alertStrategy,
  conditions: policy.conditions.map(({ name: _name, ...condition }) => ({ ...condition,
    ...(condition.conditionThreshold ? { conditionThreshold: { ...condition.conditionThreshold, thresholdValue: condition.conditionThreshold.thresholdValue ?? 0 } } : {}) })) }; }

export async function inspectPurchasingMonitoring({ request, options, configuration, indexes, rulesSource }) {
  const { projectId, projectNumber } = options, resources = monitoringResources(configuration, projectNumber);
  const base = `projects/${projectId}`, database = `${base}/databases/(default)`;
  const project = await request({ api: "resource", path: base });
  if (project.projectId !== projectId || String(project.projectNumber) !== projectNumber || project.lifecycleState !== "ACTIVE") throw new Error("Observed project identity or lifecycle does not match the explicit target.");
  const iam = await request({ api: "resource", path: `${base}:getIamPolicy`, method: "POST", body: { options: { requestedPolicyVersion: 3 } } });
  const runtimeMember = `serviceAccount:${resources.runtimeAccount}`;
  if (!unconditionalRole(iam, "roles/cloudscheduler.serviceAgent", `serviceAccount:service-${projectNumber}@gcp-sa-cloudscheduler.iam.gserviceaccount.com`)) {
    throw new Error("Restore the Cloud Scheduler service agent role using the existing project bootstrap before activation.");
  }
  const missingRoles = resources.runtimeRoles.filter(role => !unconditionalRole(iam, role, runtimeMember));
  const fn = await request({ api: "functions", path: `${base}/locations/${REGION}/functions/${FUNCTION_ID}` });
  if (fn.name !== `${base}/locations/${REGION}/functions/${FUNCTION_ID}` || fn.environment !== "GEN_2" || fn.state !== "ACTIVE"
    || fn.serviceConfig?.serviceAccountEmail !== resources.runtimeAccount || !fn.serviceConfig?.service?.startsWith(`${base}/locations/${REGION}/services/`)) throw new Error("The active evaluator must use the reviewed generation, region and runtime identity.");
  if (configuration.environment === "staging" && (fn.serviceConfig.environmentVariables?.RELEASE_SHA !== options.sha
    || fn.serviceConfig.environmentVariables?.DEPLOYMENT_ENV !== "staging")) throw new Error("Staging evaluator release/environment differs from the reviewed SHA.");
  const scheduler = await request({ api: "scheduler", path: resources.schedulerName });
  if (scheduler.name !== resources.schedulerName || scheduler.state !== "ENABLED" || !["every 15 minutes", "*/15 * * * *"].includes(scheduler.schedule)
    || scheduler.httpTarget?.httpMethod !== "POST" || scheduler.httpTarget?.uri !== fn.serviceConfig.uri
    || scheduler.httpTarget?.oidcToken?.serviceAccountEmail !== resources.runtimeAccount) throw new Error("The evaluator's enabled 15-minute Scheduler/OIDC configuration must match the deployed Function.");
  const invokerPolicy = await request({ api: "run", path: `${fn.serviceConfig.service}:getIamPolicy` });
  if (!unconditionalRole(invokerPolicy, "roles/run.invoker", runtimeMember) && !unconditionalRole(iam, "roles/run.invoker", runtimeMember)) throw new Error("The Scheduler identity lacks Cloud Run Invoker on the evaluator. Repair the exact service IAM before activation.");
  if (invokerPolicy.bindings?.some(binding => binding.members?.some(member => ["allUsers", "allAuthenticatedUsers"].includes(member)))) throw new Error("The scheduled evaluator must not have public Cloud Run invocation access.");
  const release = await request({ api: "rules", path: `${base}/releases/cloud.firestore` });
  if (!release.rulesetName?.startsWith(`${base}/rulesets/`)) throw new Error("Unexpected Firestore Rules release resource.");
  const rules = await request({ api: "rules", path: release.rulesetName });
  if (rules.source?.files?.length !== 1 || rules.source.files[0].content !== rulesSource) throw new Error("Publish and verify the reviewed Firestore Rules before monitoring activation.");
  const observedIndexes = await listAll(request, { api: "firestore", path: `${database}/collectionGroups/-/indexes` }, "indexes");
  const requiredIndexes = indexes.map(index => {
    const matches = observedIndexes.filter(entry => entry.name?.startsWith(`${database}/collectionGroups/${index.collectionGroup}/indexes/`)
      && indexSignature({ ...entry, collectionGroup: index.collectionGroup }) === indexSignature(index));
    if (matches.length > 1) throw new Error("Duplicate matching indexes need operator review.");
    if (matches[0] && !["READY", "CREATING"].includes(matches[0].state)) throw new Error("A required Firestore index needs operator repair.");
    return { ...index, state: matches[0]?.state || "MISSING" };
  });
  const metrics = [];
  for (const desired of resources.metrics) {
    const current = await request({ api: "logging", path: `${base}/metrics/${desired.name}`, allowMissing: true });
    if (current && !current.description?.startsWith("HotelSuite purchasing evaluator ")) throw new Error("An existing log metric name needs ownership review.");
    metrics.push({ desired, current });
  }
  const existingPolicies = await listAll(request, { api: "monitoring", path: `${base}/alertPolicies` }, "alertPolicies");
  const policies = resources.policies.map(desired => {
    const matching = existingPolicies.filter(entry => entry.displayName === desired.displayName || ownedPolicy(entry, desired, projectId));
    if (matching.length > 1 || matching.some(entry => !ownedPolicy(entry, desired, projectId) || (entry.notificationChannels || []).length)) {
      throw new Error("An alert policy name, ownership or channel conflict requires operator review.");
    }
    return { desired, current: matching[0] || null };
  });
  const marker = await request({ api: "firestore", path: `${database}/documents/${CONFIGURATION_PATH}`, allowMissing: true });
  if (marker) validatePurchasingMonitoringConfiguration(firestoreData(marker), { projectId });
  const heartbeat = await request({ api: "firestore", path: `${database}/documents/platformConfiguration/importMonitoringWorker`, allowMissing: true });
  return { resources, iam, missingRoles, requiredIndexes, metrics, policies, marker, heartbeat,
    summary: { projectId, environment: configuration.environment, releaseSha: options.sha, missingRuntimeRoles: missingRoles,
      indexes: requiredIndexes.map(({ collectionGroup, state }) => ({ collectionGroup, state })), schedulerVerified: true, rulesVerified: true,
      metricsPresent: metrics.filter(entry => entry.current).length, policiesPresent: policies.filter(entry => entry.current).length,
      configured: Boolean(marker), enabled: firestoreData(marker).enabled === true } };
}

function requirePrepared(inspection) {
  if (inspection.missingRoles.length || inspection.requiredIndexes.some(index => index.state !== "READY")
    || inspection.metrics.some(({ current, desired }) => !current || current.filter !== desired.filter || current.disabled === true
      || current.metricDescriptor?.metricKind !== "DELTA" || current.metricDescriptor?.valueType !== "INT64")
    || inspection.policies.some(({ current, desired }) => !current || !same(policyContent(current), policyContent(desired)))) {
    throw new Error("Preparation is incomplete or configuration drifted. Run prepare dry-run/apply; wait for every index to be READY.");
  }
}

export async function runPurchasingMonitoringRelease({ request, options, configuration, indexes, rulesSource, now = Date.now() }) {
  requirePurchasingMonitoringTarget(options, {});
  const validated = validatePurchasingMonitoringConfiguration(configuration, { projectId: options.projectId });
  if (validated.releaseSha !== options.sha) throw new Error("Configuration release SHA differs from the reviewed release.");
  if (options.apply && (!MUTATIONS.has(options.phase) || options.confirmProject !== options.projectId)) throw new Error("A mutation requires the exact project confirmation.");
  if (options.phase === "pause") {
    const base = `projects/${options.projectId}`, database = `${base}/databases/(default)`;
    const project = await request({ api: "resource", path: base });
    if (project.projectId !== options.projectId || String(project.projectNumber) !== options.projectNumber || project.lifecycleState !== "ACTIVE") throw new Error("Observed project identity mismatch.");
    const snapshot = await request({ api: "firestore", path: `${database}/documents/${CONFIGURATION_PATH}` });
    const marker = firestoreData(snapshot);
    validatePurchasingMonitoringConfiguration(marker, { projectId: options.projectId });
    if (options.apply) await request({ api: "firestore", path: `${database}/documents:commit`, method: "POST", body: { writes: [{ update: {
      name: `${database}/documents/${CONFIGURATION_PATH}`, fields: firestoreFields({ ...marker, enabled: false, pausedAtMillis: now, pausedBy: OPERATOR }) }, currentDocument: { updateTime: snapshot.updateTime } }] } });
    if (options.apply) {
      const policies = await listAll(request, { api: "monitoring", path: `${base}/alertPolicies` }, "alertPolicies");
      for (const desired of monitoringResources(validated, options.projectNumber).policies) {
        const matching = policies.filter(entry => ownedPolicy(entry, desired, options.projectId));
        if (matching.length > 1) throw new Error("Monitoring paused; duplicate internal policies need operator review.");
        for (const policy of matching) await request({ api: "monitoring", path: policy.name, method: "PATCH", params: { updateMask: "enabled" }, body: { name: policy.name, enabled: false } });
      }
    }
    return { projectId: options.projectId, environment: validated.environment, releaseSha: options.sha, phase: "pause", dryRun: !options.apply, paused: options.apply };
  }
  const inspection = await inspectPurchasingMonitoring({ request, options, configuration: validated, indexes, rulesSource });
  const { projectId } = options, base = `projects/${projectId}`, database = `${base}/databases/(default)`;
  const result = { ...inspection.summary, phase: options.phase, dryRun: !options.apply };
  if (options.phase === "prepare" && options.apply) {
    if (inspection.missingRoles.length) {
      const policy = structuredClone(inspection.iam); policy.bindings ||= [];
      for (const role of inspection.missingRoles) {
        let binding = policy.bindings.find(entry => entry.role === role && !entry.condition);
        if (!binding) { binding = { role, members: [] }; policy.bindings.push(binding); }
        binding.members.push(`serviceAccount:${inspection.resources.runtimeAccount}`);
      }
      await request({ api: "resource", path: `${base}:setIamPolicy`, method: "POST", body: { policy } });
    }
    for (const { collectionGroup, state, fields, queryScope } of inspection.requiredIndexes) {
      if (state === "MISSING") await request({ api: "firestore", path: `${database}/collectionGroups/${collectionGroup}/indexes`, method: "POST", body: { fields, queryScope } });
    }
    for (const { desired, current } of inspection.metrics) await request({ api: "logging", path: current ? `${base}/metrics/${desired.name}` : `${base}/metrics`, method: current ? "PUT" : "POST", body: desired });
    for (const { desired, current } of inspection.policies) {
      const body = { ...desired, enabled: current?.enabled === true };
      await request({ api: "monitoring", path: current?.name || `${base}/alertPolicies`, method: current ? "PATCH" : "POST", body: current ? { ...body, name: current.name } : body,
        ...(current ? { params: { updateMask: "displayName,userLabels,combiner,enabled,notificationChannels,documentation,alertStrategy,conditions" } } : {}) });
    }
    result.prepared = true; result.requiresVerification = true;
  }
  if (["activate", "verify"].includes(options.phase)) {
    requirePrepared(inspection);
    if (options.phase === "activate" && options.apply) {
      // Enable independent failure/absence monitoring before the domain worker.
      for (const { current } of inspection.policies) await request({ api: "monitoring", path: current.name, method: "PATCH",
        params: { updateMask: "enabled" }, body: { name: current.name, enabled: true } });
      const existing = firestoreData(inspection.marker);
      const activatedAtMillis = existing.enabled === true && existing.releaseSha === options.sha ? existing.activatedAtMillis : now;
      const marker = { ...validated, enabled: true, activatedAtMillis, activatedBy: OPERATOR };
      await request({ api: "firestore", path: `${database}/documents:commit`, method: "POST", body: { writes: [{ update: { name: `${database}/documents/${CONFIGURATION_PATH}`, fields: firestoreFields(marker) },
        currentDocument: inspection.marker?.updateTime ? { updateTime: inspection.marker.updateTime } : { exists: false } }] } });
      result.activated = true; result.requiresScheduledVerification = true;
    }
    if (options.phase === "verify") {
      const marker = firestoreData(inspection.marker), heartbeat = firestoreData(inspection.heartbeat);
      const activeConfiguration = validatePurchasingMonitoringConfiguration(marker, { projectId, requireEnabled: true });
      if (!same(activeConfiguration, { ...validated, enabled: true }) || inspection.policies.some(({ current }) => current.enabled !== true)) throw new Error("The active marker or enabled policies differ from the reviewed environment configuration.");
      if (!Number.isFinite(marker.activatedAtMillis) || !Number.isFinite(heartbeat.lastSuccessfulAtMillis)
        || heartbeat.lastSuccessfulAtMillis <= marker.activatedAtMillis || heartbeat.lastSuccessfulAtMillis > now
        || now - heartbeat.lastSuccessfulAtMillis > validated.evaluatorStaleMinutes * 60000 || heartbeat.failedHotels !== 0
        || !Number.isFinite(heartbeat.lastSuccessfulCycleAtMillis) || heartbeat.lastSuccessfulCycleAtMillis < marker.activatedAtMillis
        || !Number.isFinite(heartbeat.cycleStartedAtMillis) || heartbeat.cycleStartedAtMillis < marker.activatedAtMillis
        || heartbeat.lastSuccessfulCycleAtMillis > now || heartbeat.lastCycleFailedHotels !== 0 || !(heartbeat.lastCycleCheckedHotels > 0)) {
        throw new Error("Wait for a fresh successful scheduled evaluation and full hotel rotation after activation. Partial, failed or old heartbeats do not prove monitoring readiness.");
      }
      const series = await request({ api: "monitoring", path: `${base}/timeSeries`, params: {
        filter: `metric.type="logging.googleapis.com/user/${METRICS.success}" AND resource.type="cloud_run_revision" AND resource.labels.project_id="${projectId}"`,
        "interval.startTime": new Date(marker.activatedAtMillis).toISOString(), "interval.endTime": new Date(now).toISOString(), pageSize: "1" } });
      if (!series.timeSeries?.some(entry => entry.points?.some(point => Date.parse(point.interval?.endTime) > marker.activatedAtMillis))) {
        throw new Error("Wait for the real evaluator success log metric to be ingested after activation. A marker or simulation alone does not verify the independent alert signal.");
      }
      result.verified = true; result.lastSuccessfulAtMillis = heartbeat.lastSuccessfulAtMillis;
    }
  }
  return result;
}

function command(binary, args, purpose, env = process.env) {
  try { return execFileSync(binary, args, { cwd: ROOT, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
  catch { throw new Error(`Could not ${purpose}. No credentials or command output were printed.`); }
}
async function main() {
  const options = parsePurchasingMonitoringArgs(process.argv.slice(2));
  requirePurchasingMonitoringTarget(options);
  const environment = options.projectId === "hotel-toolkit" ? "production" : "staging";
  const configuration = { ...JSON.parse(await readFile(new URL(`../../config/purchasing-monitoring.${environment}.json`, import.meta.url), "utf8")), releaseSha: options.sha };
  validatePurchasingMonitoringConfiguration(configuration, { projectId: options.projectId });
  const manifest = JSON.parse(await readFile(new URL("../../firebase/firestore.indexes.json", import.meta.url), "utf8"));
  if (!Array.isArray(manifest.indexes) || manifest.fieldOverrides?.length) throw new Error("This helper supports additive composite-index preparation only; field overrides need separate review.");
  if (options.phase === "plan") {
    console.log(JSON.stringify({ projectId: options.projectId, environment, releaseSha: options.sha, dryRun: true, configuration,
      ...monitoringResources(configuration, options.projectNumber), requiredIndexes: manifest.indexes,
      mutationOrder: ["prepare IAM, additive indexes and internal evaluator policies", "verify all required indexes READY and deployed Rules", "activate internal policies and environment marker", "verify fresh scheduled heartbeat and scoped health"],
      notice: "Local plan only. No deployment, runtime readiness or provider delivery was verified." }, null, 2));
    return;
  }
  if (command("git", ["rev-parse", "HEAD"], "verify the checked-out release") !== options.sha
    || command("git", ["status", "--porcelain"], "verify a clean operator checkout")) throw new Error("Use a clean checkout of the exact reviewed release SHA.");
  const origin = command("git", ["remote", "get-url", "origin"], "verify repository identity");
  if (!/^(https:\/\/github\.com\/|git@github\.com:)SmekensRuben\/HotelSuite(?:\.git)?$/.test(origin)) throw new Error("Use the reviewed HotelSuite repository origin.");
  const observedNumber = command("gcloud", ["projects", "describe", options.projectId, "--format=value(projectNumber)"], "verify project identity");
  if (observedNumber !== options.projectNumber) throw new Error("Observed project number differs from the explicit project target.");
  if (command("gcloud", ["auth", "list", "--filter=status:ACTIVE", "--format=value(account)"], "verify release operator") !== OPERATOR) throw new Error("Use the reviewed release operator bestsmekens@gmail.com.");
  if (environment === "production" && options.phase !== "pause") {
    command(process.execPath, [fileURLToPath(new URL("./saas-release-check.mjs", import.meta.url))], "verify current main, CI, App Hosting and actual Functions deployment", { ...process.env, SAAS_RELEASE_SHA: options.sha });
  }
  const token = command("gcloud", ["auth", "print-access-token"], "obtain short-lived operator OAuth");
  if (!token) throw new Error("Short-lived operator OAuth is empty.");
  const request = createMonitoringRequest(options.projectId, token);
  if (environment === "staging" && options.phase !== "pause") {
    const release = await request({ api: "firestore", path: `projects/${options.projectId}/databases/(default)/documents/_staging/release` });
    if (firestoreData(release).state !== "ready" || firestoreData(release).sha !== options.sha) throw new Error("Complete the staging controller's exact-SHA release before monitoring setup.");
  }
  const rulesSource = await readFile(new URL("../../firebase/firestore.rules", import.meta.url), "utf8");
  const result = await runPurchasingMonitoringRelease({ request, options, configuration, indexes: manifest.indexes, rulesSource });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
