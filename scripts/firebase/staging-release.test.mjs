import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { planStagingRetryInitialization, requireAppHostingEvidence, requireFrontendMarker, requireFunctionsSha, requireSelectedSource,
  requireStagingAliases, requireStagingConfiguration, requireStagingWorkflow, STAGING_DEPLOY_ACCOUNT, STAGING_PROJECT, STAGING_REPOSITORY, STAGING_WORKFLOW_REF } from "./staging-release-policy.mjs";
import { resolveSelectedSha } from "./staging-release.mjs";

const sha = "a".repeat(40);
const otherSha = "b".repeat(40);
const number = "123456789012";
const stagingEnv = {
  GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REPOSITORY: STAGING_REPOSITORY,
  GITHUB_REF: "refs/heads/main", GITHUB_WORKFLOW_REF: STAGING_WORKFLOW_REF,
  FIREBASE_PROJECT_ID: STAGING_PROJECT, GCLOUD_PROJECT: STAGING_PROJECT, DEPLOYMENT_ENV: "staging", RELEASE_TARGET: "staging",
  STAGING_PROJECT_NUMBER: number,
  STAGING_WORKLOAD_IDENTITY_PROVIDER: `projects/${number}/locations/global/workloadIdentityPools/hotelsuite-staging-github/providers/staging-deploy`,
  STAGING_DEPLOY_SERVICE_ACCOUNT: STAGING_DEPLOY_ACCOUNT, STAGING_APPHOSTING_BACKEND_ID: STAGING_PROJECT,
  STAGING_APPHOSTING_REGION: "europe-west4", STAGING_APP_BASE_URL: `https://${STAGING_PROJECT}--${STAGING_PROJECT}.europe-west4.hosted.app`,
};
const config = requireStagingConfiguration(stagingEnv);

test("Firebase alias lookup cannot redirect an explicit staging project to production", () => {
  assert.doesNotThrow(() => requireStagingAliases({ projects: { default: "test-breakfast", staging: STAGING_PROJECT } }));
  assert.throws(() => requireStagingAliases({ projects: { [STAGING_PROJECT]: "hotel-toolkit" } }));
});

test("staging configuration refuses production, aliases, ambient projects, emulators and foreign identity", () => {
  for (const override of [
    { FIREBASE_PROJECT_ID: "hotel-toolkit" }, { GCLOUD_PROJECT: "test-breakfast" }, { RELEASE_TARGET: "production" },
    { DEPLOYMENT_ENV: "test" }, { STAGING_PROJECT_NUMBER: "358734544002" }, { STAGING_DEPLOY_SERVICE_ACCOUNT: "github-functions-deploy@hotel-toolkit.iam.gserviceaccount.com" },
    { STAGING_WORKLOAD_IDENTITY_PROVIDER: "projects/358734544002/locations/global/workloadIdentityPools/hotelsuite-github/providers/main-deploy" },
    { STAGING_APP_BASE_URL: "https://hotel-toolkit--hotel-toolkit.europe-west4.hosted.app" }, { STAGING_APPHOSTING_BACKEND_ID: "hotel-toolkit" },
    { GOOGLE_CLOUD_PROJECT: "hotel-toolkit" }, { FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080" }, { FIREBASE_CONFIG: '{"projectId":"hotel-toolkit"}' },
  ]) assert.throws(() => requireStagingConfiguration({ ...stagingEnv, ...override }));
});

test("only manual main workflow can authenticate a selected staging source", () => {
  assert.doesNotThrow(() => requireStagingWorkflow(stagingEnv));
  for (const override of [{ GITHUB_REF: "refs/heads/feature" }, { GITHUB_EVENT_NAME: "pull_request_target" },
    { GITHUB_WORKFLOW_REF: STAGING_WORKFLOW_REF.replace("deploy-staging", "deploy-functions") }, { GITHUB_REPOSITORY: "fork/HotelSuite" }]) {
    assert.throws(() => requireStagingWorkflow({ ...stagingEnv, ...override }));
  }
});

test("branch resolution freezes one complete SHA and does not interpret branch text as shell", () => {
  const requests = [];
  const result = resolveSelectedSha({ ...stagingEnv, STAGING_SOURCE_KIND: "branch", STAGING_SOURCE_TARGET: "feature/safe-release" }, path => {
    requests.push(path); return { commit: { sha } };
  });
  assert.equal(result, sha);
  assert.deepEqual(requests, ["branches/feature%2Fsafe-release"]);
  assert.throws(() => requireSelectedSource({ kind: "branch", target: "main", response: { commit: { sha: "abc123" } } }));
  assert.throws(() => requireSelectedSource({ kind: "branch", target: "-main", response: { commit: { sha } } }));
});

test("pull requests require an open same-repository head and use head SHA instead of merge SHA", () => {
  const repo = { id: 1161047380, full_name: STAGING_REPOSITORY };
  const pr = { number: 12, state: "open", merge_commit_sha: otherSha, base: { repo }, head: { repo, sha } };
  assert.equal(requireSelectedSource({ kind: "pull-request", target: "12", response: pr }), sha);
  for (const response of [{ ...pr, state: "closed" }, { ...pr, head: { ...pr.head, repo: { id: 2, full_name: "fork/HotelSuite" } } },
    { ...pr, base: { repo: { id: 2, full_name: "fork/HotelSuite" } } }]) {
    assert.throws(() => requireSelectedSource({ kind: "pull-request", target: "12", response }));
  }
});

test("rollback selection is limited to commits already on protected main", () => {
  assert.equal(requireSelectedSource({ kind: "commit", target: sha, response: { status: "ahead", merge_base_commit: { sha } } }), sha);
  assert.throws(() => requireSelectedSource({ kind: "commit", target: sha, response: { status: "diverged", merge_base_commit: { sha: otherSha } } }));
});

const endpoint = { id: "example", project: STAGING_PROJECT, codebase: "default", region: "us-west1",
  environmentVariables: { RELEASE_SHA: sha, DEPLOYMENT_ENV: "staging" }, secretEnvironmentVariables: [] };
test("every deployed Function must carry the same SHA, isolated project and zero provider secrets", () => {
  const inventory = result => ({ status: "success", result });
  assert.deepEqual(requireFunctionsSha(inventory([endpoint]), sha), ["example(us-west1)"]);
  for (const bad of [{ ...endpoint, project: "hotel-toolkit" }, { ...endpoint, environmentVariables: { ...endpoint.environmentVariables, RELEASE_SHA: otherSha } },
    { ...endpoint, secretEnvironmentVariables: [{ key: "RESEND_API_KEY" }] }]) {
    assert.throws(() => requireFunctionsSha(inventory([endpoint, bad]), sha));
  }
  assert.throws(() => requireFunctionsSha(inventory([]), sha));
});

test("frontend marker refuses stale, production or missing metadata", () => {
  assert.doesNotThrow(() => requireFrontendMarker({ environment: "staging", projectId: STAGING_PROJECT, sha }, sha));
  for (const marker of [{ environment: "staging", projectId: STAGING_PROJECT, sha: otherSha },
    { environment: "production", projectId: "hotel-toolkit", sha }, {}]) assert.throws(() => requireFrontendMarker(marker, sha));
});

const archiveUri = `gs://firebaseapphosting-sources-${number}-europe-west4/isolated-source.zip`;
const build = { name: `${config.backendName}/builds/release-1`, state: "READY", source: { archive: { userStorageUri: archiveUri } } };
const hostingEvidence = {
  config, archiveUri, build,
  backend: { name: config.backendName, uri: config.origin, environment: "staging", appId: `1:${number}:web:abc123` },
  traffic: { rolloutPolicy: { disabled: true }, current: { splits: [{ build: build.name, percent: 100 }] } },
  rollout: { name: `${config.backendName}/rollouts/release-1`, state: "SUCCEEDED", build: build.name },
};
test("App Hosting evidence must bind the exact upload to completed build and all serving traffic", () => {
  assert.doesNotThrow(() => requireAppHostingEvidence(hostingEvidence));
  for (const change of [
    { archiveUri: archiveUri.replace(number, "358734544002") }, { build: { ...build, state: "BUILDING" } },
    { build: { ...build, source: { archive: { userStorageUri: `${archiveUri}.other` } } } },
    { rollout: { ...hostingEvidence.rollout, state: "FAILED" } },
    { backend: { ...hostingEvidence.backend, codebase: { repository: "uncontrolled-auto-rollout" } } },
    { backend: { ...hostingEvidence.backend, appId: "1:358734544002:web:production" } },
    { backend: { ...hostingEvidence.backend, overrideEnv: [{ variable: "EXPECTED_FIREBASE_PROJECT_ID", value: "hotel-toolkit" }] } },
    { traffic: { ...hostingEvidence.traffic, rolloutPolicy: { disabled: false } } },
    { traffic: { ...hostingEvidence.traffic, current: { splits: [{ build: build.name, percent: 50 }] } } },
  ]) assert.throws(() => requireAppHostingEvidence({ ...hostingEvidence, ...change }));
});

const retrySource = () => Object.fromEntries(["processImportedFileToFirestore", "processSupplierProductImage"].map(id => [id, {
  platform: "gcfv2", region: ["us-west1"], eventTrigger: { eventType: "google.cloud.storage.object.v1.finalized", retry: true,
    eventFilters: { bucket: `${STAGING_PROJECT}.firebasestorage.app` } },
}]));
test("first-release retry opt-in is limited to the two exact reviewed storage selectors", () => {
  const endpoints = retrySource();
  assert.deepEqual(planStagingRetryInitialization(endpoints, { status: "success", result: [] }),
    ["functions:default:processImportedFileToFirestore", "functions:default:processSupplierProductImage"]);
  const inventory = Object.entries(endpoints).map(([id, item]) => ({ ...item, id, project: STAGING_PROJECT, region: "us-west1" }));
  assert.deepEqual(planStagingRetryInitialization(endpoints, { status: "success", result: inventory }), []);
  for (const mutation of [source => { source.processImportedFileToFirestore.region = ["europe-west4"]; },
    source => { source.processImportedFileToFirestore.eventTrigger.eventFilters.bucket = "hotel-toolkit.firebasestorage.app"; },
    source => { source["processImportedFileToFirestore-unsafe"] = source.processImportedFileToFirestore; }]) {
    const source = retrySource(); mutation(source);
    assert.throws(() => planStagingRetryInitialization(source, { status: "success", result: [] }));
  }
  assert.throws(() => planStagingRetryInitialization(endpoints, { status: "success", result: [{ ...inventory[0], project: "hotel-toolkit" }] }));
});

test("offline dry-run is executable without cloud credentials and production/ambiguous arguments fail closed", () => {
  const script = fileURLToPath(new URL("./staging-release.mjs", import.meta.url));
  const env = { PATH: process.env.PATH };
  const plan = JSON.parse(execFileSync(process.execPath, [script, "--dry-run", "--project", STAGING_PROJECT, "--sha", sha], { env, encoding: "utf8" }));
  assert.equal(plan.projectId, STAGING_PROJECT);
  assert.equal(plan.sha, sha);
  assert.equal(plan.productionTouched, false);
  for (const args of [["--dry-run", "--project", "hotel-toolkit", "--sha", sha],
    ["--apply", "--dry-run", "--project", STAGING_PROJECT, "--sha", sha],
    ["--dryrun", "--project", STAGING_PROJECT, "--sha", sha]]) {
    assert.notEqual(spawnSync(process.execPath, [script, ...args], { env, encoding: "utf8" }).status, 0);
  }
});

test("workflow keeps source verification without identity and protects the entire deploy with one staging concurrency slot", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/deploy-staging.yml", import.meta.url), "utf8");
  const verification = workflow.slice(workflow.indexOf("  verify:"), workflow.indexOf("  deploy:"));
  assert.doesNotMatch(verification, /id-token: write|google-github-actions\/auth|secrets\./);
  assert.match(workflow, /group: staging-hotel-toolkit-staging\s+cancel-in-progress: false/);
  assert.match(workflow, /environment:\s+name: staging/);
  assert.doesNotMatch(workflow, /vars\.FIREBASE_(WORKLOAD_IDENTITY_PROVIDER|DEPLOY_SERVICE_ACCOUNT)/);
  assert.match(workflow, /npm run test:security/);
  assert.match(workflow, /npm run audit:policy/);
  assert.match(workflow, /npm run test:staging/);
});
