// The existing production workflow owns releases; App Hosting automatic rollouts stay disabled.
import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireFunctionsConfiguration } from "./functions-release-policy.mjs";

export const PROJECT = "hotel-toolkit";
export const PROJECT_NUMBER = "358734544002";
export const BACKEND = `projects/${PROJECT}/locations/europe-west4/backends/${PROJECT}`;
export const ORIGIN = "https://hotel-toolkit--hotel-toolkit.europe-west4.hosted.app";
export const DEPLOY_ACCOUNT = `github-functions-deploy@${PROJECT}.iam.gserviceaccount.com`;
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const FIREBASE_CLI = fileURLToPath(new URL("../../node_modules/firebase-tools/lib/bin/firebase.js", import.meta.url));
const API = { hosting: "https://firebaseapphosting.googleapis.com/v1beta/", repository: "https://developerconnect.googleapis.com/v1/",
  project: "https://cloudresourcemanager.googleapis.com/v1/", iam: "https://iam.googleapis.com/v1/" };
const SHA = /^[a-f0-9]{40}$/;

export function requireProductionTarget(projectId, env = process.env) {
  if (projectId !== PROJECT) throw new Error("App Hosting must explicitly target hotel-toolkit.");
  for (const key of ["FIRESTORE_EMULATOR_HOST", "FIREBASE_AUTH_EMULATOR_HOST", "FIREBASE_STORAGE_EMULATOR_HOST", "STORAGE_EMULATOR_HOST", "FUNCTIONS_EMULATOR"]) {
    if (env[key]) throw new Error("Remove emulator settings before production App Hosting operations.");
  }
  for (const key of ["GCLOUD_PROJECT", "GOOGLE_CLOUD_PROJECT", "GCP_PROJECT", "CLOUDSDK_CORE_PROJECT", "FIREBASE_PROJECT_ID"]) {
    if (env[key] && env[key] !== PROJECT) throw new Error("An ambient project conflicts with the explicit production target.");
  }
}

export function canonicalProductionResource(name) {
  if (typeof name !== "string" || !new RegExp(`^projects/(${PROJECT}|${PROJECT_NUMBER})(?:[/:][A-Za-z0-9_./:@-]+)?$`).test(name)
    || name.split("/").some(part => part === "." || part === "..")) throw new Error("Unexpected production resource identity.");
  return name.replace(`projects/${PROJECT_NUMBER}/`, `projects/${PROJECT}/`);
}

export function createProductionRequest(getToken, fetchRequest = fetch) {
  return async (api, name, { method = "GET", body, params = {}, allowMissing = false } = {}) => {
    const roleCatalog = api === "iam" && ["roles/firebaseapphosting.admin", "roles/developerconnect.readTokenAccessor"].includes(name);
    const path = roleCatalog ? name : canonicalProductionResource(name);
    if (!API[api]) throw new Error("Unexpected production API.");
    const url = new URL(path, API[api]);
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
    let response;
    try { response = await fetchRequest(url, { method, headers: { Authorization: `Bearer ${typeof getToken === "function" ? await getToken() : getToken}`,
      "Content-Type": "application/json", "X-Goog-User-Project": PROJECT }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) }); }
    catch { throw new Error(`Production ${api} request failed (transport error); no credential or provider payload was printed.`); }
    if (allowMissing && response.status === 404) return null;
    if (!response.ok) throw new Error(`Production ${api} request failed (HTTP ${response.status}); no credential or provider payload was printed.`);
    try { return await response.json(); } catch { throw new Error(`Production ${api} returned invalid JSON.`); }
  };
}

export async function inspectProductionHosting(request, { requireDisabled = true, requireNoInflight = true } = {}) {
  const [backend, traffic] = await Promise.all([request("hosting", BACKEND), request("hosting", `${BACKEND}/traffic`)]);
  if (canonicalProductionResource(backend.name) !== BACKEND || backend.environment !== "production"
    || backend.uri?.replace(/^https:\/\//, "").replace(/\/$/, "") !== new URL(ORIGIN).hostname || !new RegExp(`^1:${PROJECT_NUMBER}:web:[a-f0-9]+$`, "i").test(backend.appId || "")
    || (backend.overrideEnv || []).length) throw new Error("Production backend environment, origin, linked app or environment overrides need operator review.");
  if (canonicalProductionResource(traffic.name) !== `${BACKEND}/traffic`) throw new Error("Unexpected production traffic resource.");
  const repository = canonicalProductionResource(backend.codebase?.repository);
  if (!new RegExp(`^projects/${PROJECT}/locations/europe-west4/connections/[A-Za-z0-9_-]+/gitRepositoryLinks/[A-Za-z0-9_-]+$`).test(repository)) throw new Error("The production backend must retain its existing project-local Git connection.");
  const link = await request("repository", repository);
  if (canonicalProductionResource(link.name) !== repository || !/^(https:\/\/github\.com\/|git@github\.com:)SmekensRuben\/HotelSuite(?:\.git)?$/.test(link.cloneUri || "")) throw new Error("The production Git connection must point to SmekensRuben/HotelSuite.");
  if (requireDisabled && traffic.rolloutPolicy?.disabled !== true) throw new Error("Automatic production App Hosting rollouts must be disabled by the one-time setup before any release.");
  if (requireNoInflight) {
    const rollouts = await listRollouts(request);
    requireFinishedRollouts(rollouts);
  }
  return { backend, traffic, repository };
}

function requireFinishedRollouts(rollouts) {
  if (rollouts.some(rollout => !["SUCCEEDED", "FAILED", "CANCELLED", "CANCELED"].includes(rollout.state))) {
    throw new Error("Production App Hosting has an unfinished or unknown rollout. Wait for all existing rollouts to finish before releasing.");
  }
}

async function listRollouts(request) {
  const result = [], seen = new Set(); let pageToken;
  for (let page = 0; page < 30; page++) {
    const response = await request("hosting", `${BACKEND}/rollouts`, { params: { pageSize: "100", ...(pageToken ? { pageToken } : {}) } });
    if (response.unreachable?.length || !Array.isArray(response.rollouts || [])) throw new Error("Incomplete production rollout inventory.");
    for (const rollout of response.rollouts || []) {
      if (!new RegExp(`^${BACKEND}/rollouts/[A-Za-z0-9_-]+$`).test(canonicalProductionResource(rollout.name))) throw new Error("Unexpected production rollout resource.");
      result.push(rollout);
    }
    if (!response.nextPageToken) return result;
    if (seen.has(response.nextPageToken)) throw new Error("Repeated production rollout pagination token.");
    pageToken = response.nextPageToken; seen.add(pageToken);
  }
  throw new Error("Production rollout inventory exceeds bounded pagination.");
}

export function requireServingCommit({ build, rollout, traffic, sha }) {
  const buildName = canonicalProductionResource(build.name);
  if (!SHA.test(sha || "") || !new RegExp(`^${BACKEND}/builds/[A-Za-z0-9_-]+$`).test(buildName)
    || build.source?.codebase?.commit !== sha || build.state !== "READY" || rollout.state !== "SUCCEEDED"
    || canonicalProductionResource(rollout.build) !== buildName || traffic.rolloutPolicy?.disabled !== true) throw new Error("The completed production build and rollout must identify the exact release commit.");
  const splits = traffic.current?.splits;
  if (!Array.isArray(splits) || splits.length !== 1 || canonicalProductionResource(splits[0].build) !== buildName || Number(splits[0].percent) !== 100) throw new Error("Production traffic does not yet serve the verified commit at 100 percent.");
}

export async function publishProductionHosting({ request, sha, run, timeoutMs = 3600000, pollMs = 5000,
  now = Date.now, pause = ms => new Promise(resolvePause => setTimeout(resolvePause, ms)), log = () => {} }) {
  if (!SHA.test(sha || "") || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3600000
    || !Number.isInteger(pollMs) || pollMs < 1 || pollMs > 30000) throw new Error("Use an exact release SHA and bounded production rollout wait.");
  await inspectProductionHosting(request);
  const inventory = await listRollouts(request);
  requireFinishedRollouts(inventory);
  const previous = new Set(inventory.map(row => canonicalProductionResource(row.name)));
  // The CLI's --force only skips its rollout confirmation; the commit remains pinned.
  await run(["apphosting:rollouts:create", PROJECT, "--git-commit", sha, "--project", PROJECT, "--non-interactive", "--force"]);
  const started = now(), maxPolls = Math.ceil(timeoutMs / pollMs) + 1;
  for (let poll = 0; poll < maxPolls; poll++) {
    const { traffic } = await inspectProductionHosting(request, { requireNoInflight: false });
    const fresh = (await listRollouts(request)).filter(row => !previous.has(canonicalProductionResource(row.name)));
    const matches = [];
    for (const rollout of fresh) {
      const name = canonicalProductionResource(rollout.build);
      if (!new RegExp(`^${BACKEND}/builds/[A-Za-z0-9_-]+$`).test(name)) throw new Error("Unexpected production rollout build.");
      const build = await request("hosting", name);
      if (build.source?.codebase?.commit !== sha) continue;
      if (["FAILED", "CANCELLED", "CANCELED"].includes(build.state) || ["FAILED", "CANCELLED", "CANCELED"].includes(rollout.state)) throw new Error("The pinned production App Hosting build or rollout failed; inspect its cloud logs.");
      matches.push({ build, rollout });
    }
    if (matches.length > 1) throw new Error("Multiple new production rollouts target this commit; inspect concurrent operator activity.");
    if (matches.length === 1 && matches[0].build.state === "READY" && matches[0].rollout.state === "SUCCEEDED") {
      try {
        requireServingCommit({ ...matches[0], traffic, sha });
        return { projectId: PROJECT, sha, build: matches[0].build.name, rollout: matches[0].rollout.name, servingPercent: 100 };
      } catch (error) {
        if (!error.message.startsWith("Production traffic")) throw error;
      }
    }
    const remaining = timeoutMs - (now() - started);
    if (remaining <= 0 || poll === maxPolls - 1) throw new Error("Production App Hosting did not reach a verified READY build, SUCCEEDED rollout and 100 percent traffic before timeout.");
    log("Waiting for the pinned production App Hosting build, rollout and serving traffic.");
    await pause(Math.min(pollMs, remaining));
  }
}

export function gcloud(args, purpose) {
  try { return execFileSync("gcloud", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
  catch { throw new Error(`Could not ${purpose}; no credential or command output was printed.`); }
}
function parseArgs(args) {
  if (args.length !== 5 || !["preflight", "publish"].includes(args[0]) || args[1] !== "--project" || args[2] !== PROJECT || args[3] !== "--sha" || !SHA.test(args[4])) throw new Error("Use production-apphosting.mjs preflight|publish --project hotel-toolkit --sha <40-character SHA>.");
  return { phase: args[0], sha: args[4] };
}
async function main() {
  const { phase, sha } = parseArgs(process.argv.slice(2)); requireProductionTarget(PROJECT);
  if (gcloud(["projects", "describe", PROJECT, "--format=value(projectNumber)"], "verify the production project") !== PROJECT_NUMBER) throw new Error("Production project number mismatch.");
  const request = createProductionRequest(() => gcloud(["auth", "print-access-token"], "obtain short-lived release OAuth"));
  await inspectProductionHosting(request);
  if (phase === "preflight") { console.log("Verified production backend, Git repository and disabled automatic rollouts; no resource changed."); return; }
  if (process.env.GITHUB_ACTIONS !== "true" || process.env.GITHUB_REPOSITORY !== "SmekensRuben/HotelSuite" || process.env.GITHUB_REF !== "refs/heads/main"
    || process.env.GITHUB_WORKFLOW_REF !== "SmekensRuben/HotelSuite/.github/workflows/deploy-functions.yml@refs/heads/main"
    || !["workflow_run", "workflow_dispatch"].includes(process.env.GITHUB_EVENT_NAME)) throw new Error("Production publishing requires the existing trusted main release workflow.");
  requireFunctionsConfiguration(process.env);
  if (execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim() !== sha) throw new Error("The checked-out release must match the pinned App Hosting commit.");
  const result = await publishProductionHosting({ request, sha, log: console.log, run: async args => {
    const child = spawnSync(process.execPath, [FIREBASE_CLI, ...args], { cwd: ROOT, stdio: "inherit" });
    if (child.error || child.status !== 0) throw new Error("The locked Firebase App Hosting rollout command failed.");
  } });
  console.log(JSON.stringify(result, null, 2));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
