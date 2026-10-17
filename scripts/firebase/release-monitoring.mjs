// Per-release monitoring checks reuse installed configuration. One-time setup
// remains in purchasing-monitoring-release.mjs and is never repeated here.
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createMonitoringRequest, firestoreData, firestoreFields, inspectPurchasingMonitoring, listAll,
  monitoringResources, ownedPolicy, requirePrepared, requirePurchasingMonitoringTarget } from "./purchasing-monitoring-release.mjs";

const require = createRequire(import.meta.url);
const { CONFIGURATION_PATH, validatePurchasingMonitoringConfiguration } = require("../../functions/src/purchasingMonitoringConfig.js");
const PROJECT = "hotel-toolkit", NUMBER = "358734544002";
const BASE = `projects/${PROJECT}`, DATABASE = `${BASE}/databases/(default)`;

function requireTarget(projectId, projectNumber) {
  if (projectId !== PROJECT || projectNumber !== NUMBER) throw new Error("Release monitoring supports only the explicit production project and number.");
  requirePurchasingMonitoringTarget({ projectId, projectNumber }, {});
}

async function checkProject(request) {
  const project = await request({ api: "resource", path: BASE });
  if (project.projectId !== PROJECT || String(project.projectNumber) !== NUMBER || project.lifecycleState !== "ACTIVE") {
    throw new Error("Observed monitoring project identity or lifecycle mismatch.");
  }
}

async function committedFirestoreArtifacts({ rulesSource, indexes }) {
  const [rules, manifest] = await Promise.all([
    rulesSource === undefined ? readFile(new URL("../../firebase/firestore.rules", import.meta.url), "utf8") : rulesSource,
    indexes === undefined ? readFile(new URL("../../firebase/firestore.indexes.json", import.meta.url), "utf8").then(JSON.parse) : { indexes },
  ]);
  if (typeof rules !== "string" || !rules.trim() || !Array.isArray(manifest.indexes) || manifest.fieldOverrides?.length) {
    throw new Error("Readiness requires the committed Firestore Rules and supported composite-index manifest.");
  }
  return { rulesSource: rules, indexes: manifest.indexes };
}

export async function assessPurchasingReadiness({ request, projectId, projectNumber, sha, verifyExecution = false, notBeforeMillis, now = Date.now(), rulesSource, indexes }) {
  requireTarget(projectId, projectNumber);
  if (verifyExecution && (!Number.isSafeInteger(notBeforeMillis) || notBeforeMillis < 1 || notBeforeMillis >= now)) {
    throw new Error("Scheduled verification requires an explicit earlier post-deployment verification baseline.");
  }
  if (verifyExecution && !/^[a-f0-9]{40}$/.test(sha || "")) throw new Error("Scheduled verification requires the candidate release SHA.");
  const firestore = await committedFirestoreArtifacts({ rulesSource, indexes });
  await checkProject(request);
  const marker = await request({ api: "firestore", path: `${DATABASE}/documents/${CONFIGURATION_PATH}`, allowMissing: true });
  const configuration = validatePurchasingMonitoringConfiguration(firestoreData(marker), { projectId, requireEnabled: true });
  // The installed marker describes compatible monitoring policy. Its SHA may
  // predate this candidate, which receives separate deployment verification.
  const inspection = await inspectPurchasingMonitoring({ request, options: { projectId, projectNumber, sha: configuration.releaseSha },
    configuration, ...firestore });
  const current = validatePurchasingMonitoringConfiguration(firestoreData(inspection.marker), { projectId, requireEnabled: true });
  if (JSON.stringify(current) !== JSON.stringify(configuration)) throw new Error("The installed monitoring configuration changed during readiness inspection. Retry the read-only check.");
  requirePrepared(inspection);
  if (inspection.policies.some(({ current }) => current.enabled !== true)) throw new Error("Enable the prepared purchasing monitoring policies before a controlled release.");
  const result = { prepared: true, verified: false, projectId, environment: configuration.environment,
    configurationReleaseSha: configuration.releaseSha };
  if (!verifyExecution) return result;
  if (inspection.runtimeEnvironment.RELEASE_MODE !== "controlled" || inspection.runtimeEnvironment.RELEASE_SHA !== sha
    || inspection.runtimeEnvironment.DEPLOYMENT_ENV !== "production") throw new Error("The deployed evaluator must use the candidate release SHA, controlled mode and production environment.");
  const heartbeat = firestoreData(inspection.heartbeat), maximumAge = configuration.evaluatorStaleMinutes * 60000;
  const afterDeployment = value => Number.isFinite(value) && value > notBeforeMillis && value <= now;
  const fresh = value => afterDeployment(value) && now - value <= maximumAge;
  if (!fresh(heartbeat.lastSuccessfulAtMillis) || !fresh(heartbeat.lastSuccessfulCycleAtMillis)
    || !afterDeployment(heartbeat.cycleStartedAtMillis) || heartbeat.failedHotels !== 0
    || heartbeat.cycleFailedHotels !== 0 || heartbeat.lastCycleFailedHotels !== 0 || !(heartbeat.lastCycleCheckedHotels > 0)) {
    throw new Error("Wait for a fresh successful scheduled evaluation and complete hotel rotation after the Functions deployment.");
  }
  const series = await request({ api: "monitoring", path: `${BASE}/timeSeries`, params: {
    filter: `metric.type="logging.googleapis.com/user/hotelsuite_purchasing_monitoring_evaluations" AND resource.type="cloud_run_revision" AND resource.labels.project_id="${projectId}"`,
    "interval.startTime": new Date(Math.max(notBeforeMillis, now - maximumAge)).toISOString(),
    "interval.endTime": new Date(now).toISOString(), pageSize: "100" } });
  if (!series.timeSeries?.some(entry => entry.points?.some(point => fresh(Date.parse(point.interval?.endTime))
    && Number(point.value?.int64Value ?? point.value?.doubleValue) > 0))) {
    throw new Error("Wait for a real evaluator success log metric after the Functions deployment.");
  }
  return { ...result, verified: true, lastSuccessfulAtMillis: heartbeat.lastSuccessfulAtMillis };
}

export async function pausePurchasingMonitoring({ request, projectId, projectNumber, apply = false }) {
  requireTarget(projectId, projectNumber);
  await checkProject(request);
  const marker = await request({ api: "firestore", path: `${DATABASE}/documents/${CONFIGURATION_PATH}`, allowMissing: true });
  // Derive ownership from the project, never an old or malformed marker. Pause
  // cannot require a functioning evaluator or erase previously recorded policy.
  const resources = monitoringResources({ projectId, environment: "production", evaluatorStaleMinutes: 45 }, projectNumber);
  const policies = await listAll(request, { api: "monitoring", path: `${BASE}/alertPolicies` }, "alertPolicies");
  const owned = resources.policies.flatMap(desired => {
    const matches = policies.filter(policy => ownedPolicy(policy, desired, projectId));
    if (policies.some(policy => policy.displayName === desired.displayName && !ownedPolicy(policy, desired, projectId))) {
      throw new Error("A purchasing monitoring policy name has conflicting ownership. Review it before pausing.");
    }
    if (matches.length > 1) throw new Error("Duplicate owned purchasing monitoring policies need operator review before pausing.");
    return matches;
  });
  if (marker && !marker.updateTime) throw new Error("The existing monitoring marker requires an optimistic update version before pausing.");
  if (apply) {
    if (marker && firestoreData(marker).enabled !== false) await request({ api: "firestore", path: `${DATABASE}/documents:commit`, method: "POST", body: {
      writes: [{ update: { name: `${DATABASE}/documents/${CONFIGURATION_PATH}`, fields: firestoreFields({ enabled: false }) },
        updateMask: { fieldPaths: ["enabled"] }, currentDocument: { updateTime: marker.updateTime } }] } });
    for (const policy of owned) {
      if (policy.enabled !== false) await request({ api: "monitoring", path: policy.name, method: "PATCH", params: { updateMask: "enabled" },
        body: { name: policy.name, enabled: false } });
    }
  }
  return { projectId, configured: Boolean(marker), policyCount: owned.length, paused: apply, dryRun: !apply };
}

export function parseReleaseMonitoringArgs(args) {
  const options = { phase: args[0], projectId: PROJECT, projectNumber: NUMBER, apply: false };
  const seen = new Set(), values = new Map([["--project", "projectId"], ["--sha", "sha"], ["--not-before-millis", "notBeforeMillis"]]);
  for (let index = 1; index < args.length; index++) {
    const flag = args[index];
    if (seen.has(flag) || !values.has(flag) && !["--apply", "--dry-run"].includes(flag)) throw new Error("Use unique supported release monitoring arguments.");
    seen.add(flag);
    if (flag === "--apply") options.apply = true;
    else if (flag !== "--dry-run") {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}.`);
      options[values.get(flag)] = flag === "--not-before-millis" ? Number(value) : value;
    }
  }
  requireTarget(options.projectId, options.projectNumber);
  if (!["preflight", "verify", "pause"].includes(options.phase) || !/^[a-f0-9]{40}$/.test(options.sha || "")
    || options.apply && (options.phase !== "pause" || seen.has("--dry-run"))
    || options.phase === "verify" && (!Number.isSafeInteger(options.notBeforeMillis) || options.notBeforeMillis < 1)
    || options.phase !== "verify" && seen.has("--not-before-millis")) {
    throw new Error("Use preflight|verify|pause --project hotel-toolkit --sha <40-character SHA> [--not-before-millis <post-deployment baseline> for verify] [--apply for pause].");
  }
  return options;
}

async function main() {
  const options = parseReleaseMonitoringArgs(process.argv.slice(2));
  requirePurchasingMonitoringTarget(options);
  let token;
  try { token = execFileSync("gcloud", ["auth", "print-access-token"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
  catch { throw new Error("Could not obtain short-lived release OAuth. No credential or command output was printed."); }
  if (!token) throw new Error("Short-lived release OAuth is empty.");
  const request = createMonitoringRequest(options.projectId, token);
  const result = options.phase === "pause" ? await pausePurchasingMonitoring({ ...options, request })
    : await assessPurchasingReadiness({ ...options, request, verifyExecution: options.phase === "verify" });
  console.log(JSON.stringify({ ...result, releaseSha: options.sha, phase: options.phase }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
