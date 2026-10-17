import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { planStagingRetryInitialization, requireAppHostingBuildName, requireAppHostingEvidence, requireFrontendMarker, requireFunctionsSha, requireSelectedSource, requireSha, requireStagingAliases,
  requireStagingConfiguration, requireStagingWorkflow, STAGING_PROJECT, STAGING_REPOSITORY } from "./staging-release-policy.mjs";

const controllerRoot = fileURLToPath(new URL("../../", import.meta.url));
const firebaseCli = resolve(controllerRoot, "node_modules/firebase-tools/lib/bin/firebase.js");
const activationCli = resolve(controllerRoot, "scripts/firebase/staging-activation.mjs");
const generatedFiles = ["apphosting.yaml", "apphosting.staging.yaml"];
const output = (key, value) => {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
};
const git = (source, ...args) => execFileSync("git", ["-C", source, ...args], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 }).trim();
const gh = path => JSON.parse(execFileSync("gh", ["api", `repos/${STAGING_REPOSITORY}/${path}`], { encoding: "utf8" }));

export function resolveSelectedSha(env = process.env, api = gh) {
  requireStagingWorkflow(env);
  const kind = env.STAGING_SOURCE_KIND;
  const target = env.STAGING_SOURCE_TARGET;
  if (!target || target.length > 200 || /[\r\n]/.test(target)) throw new Error("An explicit source target is required.");
  let path;
  if (kind === "branch") path = `branches/${encodeURIComponent(target)}`;
  else if (kind === "pull-request" && /^[1-9][0-9]*$/.test(target)) path = `pulls/${target}`;
  else if (kind === "commit") path = `compare/${requireSha(target)}...main`;
  else throw new Error("Invalid source selection.");
  return requireSelectedSource({ kind, target, response: api(path) });
}

export function stagingReleasePlan(sha) {
  requireSha(sha);
  return { mode: "dry-run", projectId: STAGING_PROJECT, sha, productionTouched: false,
    requiredChecks: ["frontend tests", "Functions tests", "lint", "typecheck", "security rules emulators", "restore smoke",
      "dependency audit policy", "non-production build", "staging App Hosting build", "release policy tests"],
    phases: ["Resolve branch/PR once; check out and verify its exact SHA without cloud credentials",
      "Protected staging Environment approval; authenticate with staging-only WIF",
      "Recheck selected SHA, project number, local source, backend and disabled automatic rollouts",
      "Preflight data/schema; transactionally pause staging activation and acquire release ownership",
      "Deploy Firestore rules/indexes and Storage rules; attest deployed rules and propagation start",
      "Initialize only the two reviewed storage retry triggers with scoped force, then deploy Functions without global force; verify each RELEASE_SHA",
      "Generate only staging target config and public SHA metadata from the pinned checkout",
      "Upload local App Hosting source; await rollout; match archive URI and 100% serving traffic",
      "Verify served release.json against Functions SHA; wait for rules propagation; activate the same SHA",
      "Any failure leaves staging paused; rerun a verified SHA to recover"] };
}

function requireSource(source, sha, { generated = false } = {}) {
  if (git(source, "rev-parse", "HEAD") !== requireSha(sha)) throw new Error("The deployment checkout differs from the verified SHA.");
  requireStagingAliases(JSON.parse(readFileSync(resolve(source, ".firebaserc"), "utf8")));
  const exclusions = generated ? generatedFiles.map(name => `:(exclude)${name}`) : [];
  if (git(source, "diff", "--name-only", sha, "--", ".", ...exclusions)) throw new Error("Tracked deployment source differs from the verified commit.");
  const untracked = git(source, "ls-files", "--others", "--exclude-standard").split("\n").filter(Boolean);
  if (untracked.some(name => !["firebase.staging.generated.json"].includes(name))) {
    throw new Error("Unexpected untracked files are present in the staging source checkout.");
  }
  for (const directory of [source, resolve(source, "functions")]) {
    const dotenv = readdirSync(directory).filter(name => /^\.env(?:\.|$)/.test(name));
    if (dotenv.some(name => ![".env.example", ".env.test", ...(generated ? [`.env.${STAGING_PROJECT}`] : [])].includes(name))) {
      throw new Error("Unexpected local dotenv configuration is present; use a fresh exact-SHA checkout.");
    }
  }
  // Never package links that could escape the reviewed checkout.
  if (git(source, "ls-files", "--stage").split("\n").some(line => line.startsWith("120000 "))) {
    throw new Error("Staging source archives may not contain tracked symbolic links.");
  }
}

function run(command, args, { cwd, env = process.env, capture = false } = {}) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", stdio: capture ? "pipe" : "inherit", maxBuffer: 30 * 1024 * 1024 });
  if (capture) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.signal || result.status}); staging remains paused.`);
  return result.stdout || "";
}

function firebase(source, args, { json = false, capture = false } = {}) {
  const command = [firebaseCli, ...args, "--project", STAGING_PROJECT, "--non-interactive"];
  if (json) return JSON.parse(execFileSync(process.execPath, [...command, "--json"], {
    cwd: source, env: process.env, encoding: "utf8", maxBuffer: 30 * 1024 * 1024,
  }));
  return run(process.execPath, command, { cwd: source, capture });
}

export async function readAppHostingJson(path, token, { request = fetch, pause = ms => new Promise(resolveWait => setTimeout(resolveWait, ms)) } = {}) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    let response;
    try {
      response = await request(`https://firebaseapphosting.googleapis.com/v1beta/${path}`, {
        method: "GET", headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000),
      });
    } catch {
      if (attempt === 3) throw new Error("App Hosting evidence request failed after three network attempts; staging remains paused.");
      await pause(250 * attempt);
      continue;
    }
    // Retry transport failures only. An HTTP refusal or invalid response must
    // never be treated as successful release evidence.
    if (!response.ok) throw new Error(`App Hosting evidence request failed (${response.status}).`);
    try { return await response.json(); }
    catch { throw new Error("App Hosting evidence response is not valid JSON; staging remains paused."); }
  }
}

async function apiGet(path) {
  const token = execFileSync("gcloud", ["auth", "print-access-token"], { encoding: "utf8" }).trim();
  return readAppHostingJson(path, token);
}

async function listRollouts(config) {
  const entries = [];
  const seenTokens = new Set();
  let token;
  do {
    const response = await apiGet(`${config.backendName}/rollouts?pageSize=100${token ? `&pageToken=${encodeURIComponent(token)}` : ""}`);
    if (response.unreachable?.length || !Array.isArray(response.rollouts || [])) throw new Error("Cannot read a complete App Hosting rollout inventory.");
    entries.push(...(response.rollouts || []));
    token = response.nextPageToken;
    if (entries.length > 10000 || (token && seenTokens.has(token))) throw new Error("App Hosting rollout inventory exceeded reviewed pagination bounds.");
    if (token) seenTokens.add(token);
  } while (token);
  return entries;
}

function requireGeneratedHashes(source, hashes) {
  for (const [name, expected] of Object.entries(hashes)) {
    if (createHash("sha256").update(readFileSync(resolve(source, name))).digest("hex") !== expected) {
      throw new Error("Generated staging target configuration changed after preparation; deployment is refused.");
    }
  }
}

function prepareSource(source, config, sha) {
  const stagingYaml = readFileSync(resolve(source, "apphosting.staging.yaml"), "utf8");
  if (/variable:\s*VITE_RELEASE_SHA\b/.test(stagingYaml)) throw new Error("The committed staging config must not contain a stale release SHA.");
  const generatedYaml = `scripts:\n  runCommand: npm start\nrunConfig:\n  minInstances: 0\n${stagingYaml.trimEnd()}\n  - variable: VITE_RELEASE_SHA\n    value: "${sha}"\n    availability: [BUILD]\n`;
  for (const name of generatedFiles) writeFileSync(resolve(source, name), generatedYaml);
  const parameters = { APP_BASE_URL: config.origin, DEPLOYMENT_ENV: "staging", RELEASE_SHA: sha,
    HOTEL_MCP_ENABLED: "false", HOTEL_MCP_PUBLIC_ORIGIN: "", HOTEL_MCP_CLIENTS_JSON: "[]", HOTEL_MCP_ALLOWED_ORIGINS_JSON: "[]" };
  writeFileSync(resolve(source, `functions/.env.${STAGING_PROJECT}`), Object.entries(parameters)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`).join("\n") + "\n", { mode: 0o600 });
  const firebaseConfig = {
    firestore: { rules: "firebase/firestore.rules", indexes: "firebase/firestore.indexes.json" }, storage: { rules: "firebase/storage.rules" },
    functions: [{ source: "functions", codebase: "default", ignore: ["node_modules", ".git", "*.log", "*.local", "testSupport", "**/*.node-test.js"] }],
    apphosting: { backendId: config.backendId, rootDir: ".", alwaysDeployFromSource: true,
      ignore: ["node_modules", "**/node_modules", ".git", "**/.git", "dist", "build", "work", "**/.env*", "**/*creds*.json", "*.log"] },
  };
  writeFileSync(resolve(source, "firebase.staging.generated.json"), JSON.stringify(firebaseConfig, null, 2) + "\n");
  return Object.fromEntries([...generatedFiles, "firebase.staging.generated.json", `functions/.env.${STAGING_PROJECT}`]
    .map(name => [name, createHash("sha256").update(readFileSync(resolve(source, name))).digest("hex")]));
}

function activation(source, sha, phase, evidence) {
  const args = [activationCli, "--project", STAGING_PROJECT, "--sha", sha, "--source", source, "--phase", phase];
  if (phase !== "preflight") args.push("--apply");
  if (evidence) args.push("--evidence", evidence);
  run(process.execPath, args, { cwd: controllerRoot });
}

async function deploy(source, sha, reportPath) {
  requireStagingWorkflow(process.env);
  const config = requireStagingConfiguration(process.env);
  if (process.env.STAGING_DEPLOY_ENABLED !== "true") throw new Error("Staging bootstrap is incomplete; STAGING_DEPLOY_ENABLED must be true.");
  if (resolveSelectedSha() !== sha) throw new Error("The selected source moved after verification. Start a fresh release run.");
  requireSource(source, sha);
  const project = JSON.parse(execFileSync("gcloud", ["projects", "describe", STAGING_PROJECT, "--format=json"], { encoding: "utf8" }));
  if (project.projectId !== STAGING_PROJECT || String(project.projectNumber) !== config.projectNumber) throw new Error("The resolved cloud project is not the configured staging project.");
  const account = execFileSync("gcloud", ["auth", "list", "--filter=status:ACTIVE", "--format=value(account)"], { encoding: "utf8" }).trim();
  if (account !== process.env.STAGING_DEPLOY_SERVICE_ACCOUNT) throw new Error("The active credential is not the dedicated staging deployment account.");
  const [backend, traffic] = await Promise.all([apiGet(config.backendName), apiGet(`${config.backendName}/traffic`)]);
  requireAppHostingEvidence({ backend, traffic, config });
  activation(source, sha, "preflight");
  activation(source, sha, "deploying");
  const generatedHashes = prepareSource(source, config, sha);
  const deployArgs = ["deploy", "--config", "firebase.staging.generated.json", "--only"];
  firebase(source, [...deployArgs, "firestore:rules,firestore:indexes,storage"]);
  activation(source, sha, "rules");
  const rulesPublishedAt = Date.now();
  const endpoints = JSON.parse(execFileSync(process.execPath, ["-e",
    'const functions = require(process.argv[1]); process.stdout.write(JSON.stringify(Object.fromEntries(Object.entries(functions).filter(([,value]) => value.__endpoint).map(([key,value]) => [key,value.__endpoint]))));',
    resolve(source, "functions/index.js")], { cwd: source, encoding: "utf8", maxBuffer: 20 * 1024 * 1024,
    // This is approved staging source, not a sandbox. Do not hand discovery
    // GitHub tokens, OIDC request variables or credential paths unnecessarily.
    env: { PATH: process.env.PATH, NODE_ENV: "production", GCLOUD_PROJECT: STAGING_PROJECT, DEPLOYMENT_ENV: "staging",
      APP_BASE_URL: config.origin, FIREBASE_CONFIG: JSON.stringify({ projectId: STAGING_PROJECT, storageBucket: `${STAGING_PROJECT}.firebasestorage.app` }) } }));
  const retrySelectors = planStagingRetryInitialization(endpoints, firebase(source, ["functions:list"], { json: true }));
  requireGeneratedHashes(source, generatedHashes);
  for (const selector of retrySelectors) firebase(source, [...deployArgs, selector, "--force"]);
  firebase(source, [...deployArgs, "functions"]);
  requireSource(source, sha, { generated: true });
  requireGeneratedHashes(source, generatedHashes);
  const functions = requireFunctionsSha(firebase(source, ["functions:list"], { json: true }), sha);
  const knownRollouts = new Set((await listRollouts(config)).map(item => item.name));
  const deploymentOutput = firebase(source, [...deployArgs, "apphosting"], { capture: true });
  const archives = [...deploymentOutput.matchAll(/Uploaded at (gs:\/\/[^\s\u001b]+\.zip)/g)].map(match => match[1]);
  if (archives.length !== 1) throw new Error("Cannot uniquely identify this release's App Hosting source archive.");
  const newRollouts = (await listRollouts(config)).filter(item => !knownRollouts.has(item.name));
  if (newRollouts.length !== 1) throw new Error("Concurrent or missing App Hosting rollout detected; activation is refused.");
  const rollout = newRollouts[0];
  const build = await apiGet(requireAppHostingBuildName(rollout.build, config));
  const freshTraffic = await apiGet(`${config.backendName}/traffic`);
  requireAppHostingEvidence({ backend, traffic: freshTraffic, rollout, build, archiveUri: archives[0], config });
  const markerResponse = await fetch(`${config.origin}/release.json?sha=${sha}`, { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(30000) });
  if (!markerResponse.ok) throw new Error("The served staging frontend release marker is unavailable.");
  requireFrontendMarker(await markerResponse.json(), sha);
  const evidence = { projectId: STAGING_PROJECT, sha, backendSha: sha, frontendSha: sha,
    functionsVerified: true, appHostingVerified: true, frontendMarkerVerified: true, functions, generatedHashes,
    appHostingBuild: build.name, appHostingRollout: rollout.name, sourceArchive: archives[0] };
  writeFileSync(reportPath, JSON.stringify(evidence, null, 2) + "\n");
  // Keep the global workflow concurrency slot while Security Rules propagate.
  while (Date.now() - rulesPublishedAt < 10 * 60 * 1000) {
    console.log("Staging remains paused while the required Security Rules propagation interval completes.");
    await new Promise(resolveWait => setTimeout(resolveWait, Math.min(30000, 10 * 60 * 1000 - (Date.now() - rulesPublishedAt))));
  }
  // Refresh both live components immediately before the independent activation check.
  requireFunctionsSha(firebase(source, ["functions:list"], { json: true }), sha);
  requireAppHostingEvidence({ backend: await apiGet(config.backendName), traffic: await apiGet(`${config.backendName}/traffic`),
    rollout, build, archiveUri: archives[0], config });
  activation(source, sha, "ready", reportPath);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `Staging is active at ${config.origin} for commit \`${sha}\`. Functions, rules, indexes, uploaded frontend source and served release marker were verified.\n`);
}

async function main() {
  const args = process.argv.slice(2);
  const value = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
  if (args[0] === "resolve") {
    if (args.length !== 1) throw new Error("Resolve accepts only source selection from the trusted workflow environment.");
    const sha = resolveSelectedSha();
    output("sha", sha);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `Selected staging commit: \`${sha}\`. All verification and deployment steps use this immutable SHA.\n`);
    console.log(`Selected staging commit ${sha}.`);
    return;
  }
  const flags = new Set(["--project", "--sha", "--source", "--report", "--dry-run", "--apply"]);
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!flags.has(flag) || seen.has(flag)) throw new Error("Use unique, supported staging release arguments.");
    seen.add(flag);
    if (!["--dry-run", "--apply"].includes(flag) && (!args[++i] || args[i].startsWith("--"))) throw new Error(`Missing value for ${flag}.`);
  }
  if (seen.has("--dry-run") && seen.has("--apply")) throw new Error("Choose one staging release mode.");
  if (value("--project") !== STAGING_PROJECT) throw new Error("Pass --project hotel-toolkit-staging explicitly.");
  const sha = requireSha(value("--sha"));
  if (args.includes("--dry-run")) {
    console.log(JSON.stringify(stagingReleasePlan(sha), null, 2));
    return;
  }
  if (!args.includes("--apply")) throw new Error("Choose --dry-run or --apply explicitly.");
  const source = resolve(value("--source") || ".");
  const reportPath = resolve(value("--report") || "staging-release-evidence.json");
  if (!existsSync(dirname(reportPath))) throw new Error("The evidence output directory must already exist.");
  await deploy(source, sha, reportPath);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
