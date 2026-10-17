import test from "node:test";
import assert from "node:assert/strict";
import { BACKEND, PROJECT, PROJECT_NUMBER, ORIGIN, DEPLOY_ACCOUNT, createProductionRequest, canonicalProductionResource,
  requireProductionTarget, inspectProductionHosting, requireServingCommit, publishProductionHosting } from "./production-apphosting.mjs";
import { RELEASE_ROLE, MONITORING_PERMISSIONS, reviewedReleasePermissions, configureProductionHosting, parseProductionSetupArgs } from "./production-apphosting-setup.mjs";

const SHA = "a".repeat(40), OTHER_SHA = "b".repeat(40);
const REPOSITORY = `projects/${PROJECT}/locations/europe-west4/connections/github/gitRepositoryLinks/hotelsuite`;
const CATALOG = { includedPermissions: ["firebaseapphosting.backends.get", "firebaseapphosting.backends.list", "firebaseapphosting.backends.update",
  "firebaseapphosting.builds.get", "firebaseapphosting.builds.list", "firebaseapphosting.builds.create", "firebaseapphosting.builds.delete",
  "firebaseapphosting.rollouts.get", "firebaseapphosting.rollouts.list", "firebaseapphosting.rollouts.create", "firebaseapphosting.rollouts.delete",
  "firebaseapphosting.traffic.get", "firebaseapphosting.traffic.update", "firebaseapphosting.operations.get", "firebaseapphosting.operations.list"] };
const build = (patch = {}) => ({ name: `${BACKEND}/builds/new`, source: { codebase: { commit: SHA } }, state: "READY", ...patch });
const rollout = (patch = {}) => ({ name: `${BACKEND}/rollouts/new`, build: `${BACKEND}/builds/new`, state: "SUCCEEDED", ...patch });
function fixture({ disabled = true, initialRole = false, alreadyGranted = false, state = "success", overrides = {} } = {}) {
  const calls = [];
  const backend = { name: BACKEND, environment: "production", uri: ORIGIN, appId: `1:${PROJECT_NUMBER}:web:abc123`, codebase: { repository: REPOSITORY } };
  const traffic = { name: `${BACKEND}/traffic`, rolloutPolicy: { disabled }, current: { splits: [{ build: `${BACKEND}/builds/new`, percent: 100 }] } };
  let started = false, role = initialRole ? { name: RELEASE_ROLE, title: "HotelSuite production release", stage: "GA", includedPermissions: reviewedReleasePermissions(CATALOG), etag: "role-etag" } : null;
  let policy = { version: 3, etag: "policy-etag", bindings: [{ role: "roles/firebase.viewer", members: ["serviceAccount:preserved@example.com"] },
    ...(alreadyGranted ? [{ role: RELEASE_ROLE, members: [`serviceAccount:${DEPLOY_ACCOUNT}`] }] : []) ] };
  const request = async (api, name, options = {}) => {
    calls.push({ api, name, ...structuredClone(options) });
    const override = overrides[`${api}:${name}`];
    if (override !== undefined) return typeof override === "function" ? override(options) : structuredClone(override);
    if (api === "hosting") {
      if (name === BACKEND) return structuredClone(backend);
      if (name === `${BACKEND}/traffic`) {
        if (options.method === "PATCH") { traffic.rolloutPolicy.disabled = options.body.rolloutPolicy.disabled; return { name: `projects/${PROJECT}/locations/europe-west4/operations/setup`, done: true }; }
        return { ...structuredClone(traffic), ...(state === "partial-traffic" ? { current: { splits: [{ build: `${BACKEND}/builds/new`, percent: 50 }] } } : {}) };
      }
      if (name === `${BACKEND}/rollouts`) return { rollouts: started ? [rollout({ state: state === "queued" ? "PENDING" : state === "failed" ? "FAILED" : "SUCCEEDED" })] : [] };
      if (name === `${BACKEND}/builds/new`) return build(state === "wrong-sha" ? { source: { codebase: { commit: OTHER_SHA } } } : {});
    }
    if (api === "repository") return { name: REPOSITORY, cloneUri: "https://github.com/SmekensRuben/HotelSuite.git" };
    if (api === "project") {
      if (name.endsWith(":getIamPolicy")) return structuredClone(policy);
      if (name.endsWith(":setIamPolicy")) { policy = options.body.policy; return policy; }
      return { projectId: PROJECT, projectNumber: PROJECT_NUMBER, lifecycleState: "ACTIVE" };
    }
    if (api === "iam") {
      if (name.endsWith(`/serviceAccounts/${DEPLOY_ACCOUNT}`)) return { email: DEPLOY_ACCOUNT };
      if (name === "roles/firebaseapphosting.admin") return CATALOG;
      if (name === "roles/developerconnect.readTokenAccessor") return { includedPermissions: ["developerconnect.gitRepositoryLinks.fetchReadToken"] };
      if (options.method === "POST") { role = { ...options.body.role, name: RELEASE_ROLE }; return role; }
      if (options.method === "PATCH") { role = options.body; return role; }
      if (name === RELEASE_ROLE) return structuredClone(role);
    }
    throw new Error(`Unexpected fixture request ${api}:${name}`);
  };
  return { request, calls, backend, traffic, get role() { return role; }, get policy() { return policy; }, run: async args => { calls.push({ cli: args }); started = true; } };
}
const changes = fixture => fixture.calls.filter(call => ["PATCH", "POST", "PUT", "DELETE"].includes(call.method) && !call.name.endsWith(":getIamPolicy"));
const publish = fixture => publishProductionHosting({ request: fixture.request, sha: SHA, run: fixture.run, timeoutMs: 2, pollMs: 1, pause: async () => {} });
const setup = (fixture, apply = false) => configureProductionHosting({ request: fixture.request, apply, projectNumber: PROJECT_NUMBER, operator: "bestsmekens@gmail.com", pause: async () => {} });

test("production target and resource guards reject staging, conflicts and traversal", () => {
  assert.throws(() => requireProductionTarget("hotel-toolkit-staging", {}));
  assert.throws(() => requireProductionTarget(PROJECT, { GCLOUD_PROJECT: "hotel-toolkit-staging" }));
  assert.throws(() => requireProductionTarget(PROJECT, { FUNCTIONS_EMULATOR: "true" }));
  assert.equal(canonicalProductionResource(BACKEND.replace(PROJECT, PROJECT_NUMBER)), BACKEND);
  assert.throws(() => canonicalProductionResource(`${BACKEND}/../staging`));
  assert.throws(() => canonicalProductionResource(BACKEND.replace(PROJECT, "hotel-toolkit-staging")));
});

test("preflight checks production app, environment, origin, repository and disabled automatic rollouts without mutation", async () => {
  const state = fixture(); await inspectProductionHosting(state.request); assert.deepEqual(changes(state), []);
  for (const patch of [{ environment: "staging" }, { appId: "1:123456:web:abc" }, { uri: "https://other.example.com" }, { overrideEnv: [{ variable: "VITE_DEPLOYMENT_ENV", value: "staging" }] }]) {
    const bad = fixture(); Object.assign(bad.backend, patch); await assert.rejects(inspectProductionHosting(bad.request));
  }
  await assert.rejects(inspectProductionHosting(fixture({ disabled: false }).request), /Automatic production App Hosting rollouts/);
  await assert.rejects(inspectProductionHosting(fixture({ overrides: { [`repository:${REPOSITORY}`]: { name: REPOSITORY, cloneUri: "https://github.com/other/repo" } } }).request), /Git connection/);
});

test("preflight and publisher reject existing queued, active and unknown rollouts before mutation", async () => {
  for (const state of ["PENDING", "BUILDING", "ROLLING_OUT", "STATE_UNSPECIFIED", undefined]) {
    const current = fixture({ overrides: { [`hosting:${BACKEND}/rollouts`]: { rollouts: [rollout({ state })] } } });
    await assert.rejects(inspectProductionHosting(current.request), /unfinished or unknown rollout/);
    await assert.rejects(publish(current), /unfinished or unknown rollout/);
    assert.equal(current.calls.some(call => call.cli), false); assert.deepEqual(changes(current), []);
  }
});

test("publisher pins the full git commit through the locked CLI and verifies completed build, rollout and all serving traffic", async () => {
  const state = fixture(), result = await publish(state);
  assert.equal(result.sha, SHA); assert.equal(result.servingPercent, 100);
  assert.deepEqual(state.calls.find(call => call.cli).cli, ["apphosting:rollouts:create", PROJECT, "--git-commit", SHA, "--project", PROJECT, "--non-interactive", "--force"]);
  const unsafe = fixture({ disabled: false }); await assert.rejects(publish(unsafe)); assert.equal(unsafe.calls.some(call => call.cli), false);
});

test("queued rollout, another commit, partial traffic and failed build never count as a production release", async () => {
  for (const state of ["queued", "wrong-sha", "partial-traffic", "failed"]) await assert.rejects(publish(fixture({ state })));
  const valid = { build: build(), rollout: rollout(), traffic: fixture().traffic, sha: SHA };
  assert.throws(() => requireServingCommit({ ...valid, build: build({ state: "FAILED" }) }));
  assert.throws(() => requireServingCommit({ ...valid, sha: OTHER_SHA }));
});

test("setup defaults to offline plan/read-only preflight and accepts only explicit exact-project apply", () => {
  assert.deepEqual(parseProductionSetupArgs(["plan", "--project", PROJECT]), { phase: "plan", apply: false });
  assert.deepEqual(parseProductionSetupArgs(["preflight", "--project", PROJECT]), { phase: "preflight", apply: false });
  assert.throws(() => parseProductionSetupArgs(["apply", "--project", PROJECT]));
  assert.throws(() => parseProductionSetupArgs(["apply", "--project", PROJECT, "--confirm-project", "hotel-toolkit-staging"]));
});

test("setup preflight reports changes without making them; the narrow role excludes backend/traffic/IAM administration", async () => {
  const state = fixture({ disabled: false }), result = await setup(state);
  assert.equal(result.dryRun, true); assert.equal(result.automaticRolloutsDisabled, false); assert.deepEqual(changes(state), []);
  assert.ok(result.includedPermissions.includes("developerconnect.gitRepositoryLinks.fetchReadToken"));
  for (const permission of MONITORING_PERMISSIONS) assert.ok(result.includedPermissions.includes(permission));
  assert.equal(result.includedPermissions.some(permission => /\.delete$|\.setIamPolicy$|\.backends\.update$|\.traffic\.update$/.test(permission)), false);
});

test("setup disables independent auto-rollouts before additive IAM, preserves existing grants and verifies the result", async () => {
  const state = fixture({ disabled: false }), result = await setup(state, true);
  assert.equal(result.verified, true); assert.equal(changes(state)[0].api, "hosting");
  assert.equal(changes(state).some(call => call.name.includes("/builds") || call.name.includes("/rollouts")), false);
  assert.equal(state.policy.etag, "policy-etag"); assert.equal(state.policy.bindings[0].role, "roles/firebase.viewer");
  assert.deepEqual(state.policy.bindings.at(-1), { role: RELEASE_ROLE, members: [`serviceAccount:${DEPLOY_ACCOUNT}`] });
  const again = fixture({ initialRole: true, alreadyGranted: true }); await setup(again, true); assert.deepEqual(changes(again), []);
});

test("setup re-enables a disabled custom role instead of falsely reporting ready", async () => {
  const state = fixture({ initialRole: true, alreadyGranted: true }); state.role.stage = "DISABLED";
  assert.equal((await setup(state)).customRoleReady, false);
  assert.equal((await setup(state, true)).verified, true); assert.equal(state.role.stage, "GA");
  assert.deepEqual(changes(state).map(call => call.api), ["iam"]);
});

test("setup checks project number, operator and current role catalog before any change", async () => {
  for (const patch of [{ projectNumber: "79412748471" }, { operator: "other@example.com" }]) {
    const state = fixture(); await assert.rejects(configureProductionHosting({ request: state.request, apply: true, projectNumber: PROJECT_NUMBER, operator: "bestsmekens@gmail.com", ...patch })); assert.deepEqual(state.calls, []);
  }
  assert.throws(() => reviewedReleasePermissions({ includedPermissions: ["firebaseapphosting.backends.get"] }));
});

test("HTTP failures do not expose tokens or provider response payloads", async () => {
  const request = createProductionRequest("private-token", async () => ({ ok: false, status: 403, json: async () => ({ error: "private-token confidential-response-content" }) }));
  await assert.rejects(request("hosting", BACKEND), error => !error.message.includes("private-token") && !error.message.includes("confidential-response-content"));
});

test("production metadata GET retries dropped connections with the same target and identity", async () => {
  const calls = [], pauses = []; let tokenReads = 0;
  const request = createProductionRequest(async () => { tokenReads++; return "private-token"; }, async (url, options) => {
    calls.push({ url: String(url), options });
    if (calls.length < 3) throw new TypeError("socket closed private-token confidential-response-content");
    return { ok: true, status: 200, json: async () => ({ name: BACKEND }) };
  }, { pause: async ms => pauses.push(ms) });
  assert.deepEqual(await request("hosting", BACKEND, { params: { pageToken: "opaque + token" } }), { name: BACKEND });
  assert.equal(calls.length, 3); assert.equal(tokenReads, 1); assert.deepEqual(pauses, [250, 500]);
  assert.equal(new Set(calls.map(call => call.url)).size, 1);
  assert.equal(new URL(calls[0].url).searchParams.get("pageToken"), "opaque + token");
  for (const call of calls) {
    assert.equal(call.options.method, "GET"); assert.equal(call.options.headers.Authorization, "Bearer private-token");
    assert.equal(call.options.headers["X-Goog-User-Project"], PROJECT); assert.equal(call.options.body, undefined);
  }
  assert.notEqual(calls[0].options.signal, calls[1].options.signal);
});

test("persistent transport failures are bounded and production mutations or credential failures never retry", async () => {
  for (const method of ["GET", "POST", "PATCH", "PUT", "DELETE"]) {
    let calls = 0; const pauses = [];
    const request = createProductionRequest("private-token", async () => { calls++; throw new Error("private-token confidential-response-content"); },
      { pause: async ms => pauses.push(ms) });
    await assert.rejects(request("hosting", BACKEND, { method }), error => /transport error/.test(error.message)
      && !/private-token|confidential-response-content/.test(error.message));
    assert.equal(calls, method === "GET" ? 3 : 1); assert.deepEqual(pauses, method === "GET" ? [250, 500] : []);
  }
  let calls = 0;
  const request = createProductionRequest(() => { throw new Error("private-token"); }, async () => { calls++; });
  await assert.rejects(request("hosting", BACKEND), error => /credential lookup failed/.test(error.message) && !error.message.includes("private-token"));
  assert.equal(calls, 0);
});

test("HTTP failures, missing resources and malformed JSON are never retried or accepted as rollout evidence", async () => {
  for (const status of [400, 401, 403, 404, 429, 503]) {
    let calls = 0;
    const request = createProductionRequest("private-token", async () => { calls++; return { ok: false, status }; });
    await assert.rejects(request("hosting", BACKEND), new RegExp(`HTTP ${status}`)); assert.equal(calls, 1);
    if (status === 404) { assert.equal(await request("hosting", BACKEND, { allowMissing: true }), null); assert.equal(calls, 2); }
  }
  let calls = 0;
  const request = createProductionRequest("private-token", async () => { calls++; return { ok: true, json: async () => { throw new Error("private-token"); } }; });
  await assert.rejects(request("hosting", BACKEND), /invalid JSON/); assert.equal(calls, 1);
});

test("a dropped post-rollout evidence read recovers without starting another deployment", async () => {
  const state = fixture(); let published = false, drops = 0;
  const request = createProductionRequest("private-token", async (url, options) => {
    const endpoint = new URL(url), hosting = endpoint.hostname === "firebaseapphosting.googleapis.com";
    const name = endpoint.pathname.replace(hosting ? /^\/v1beta\// : /^\/v1\//, "");
    if (published && hosting && name === BACKEND && drops++ === 0) throw new TypeError("fetch failed");
    const result = await state.request(hosting ? "hosting" : "repository", name, { method: options.method });
    return { ok: true, status: 200, json: async () => result };
  }, { pause: async () => {} });
  const result = await publishProductionHosting({ request, sha: SHA, run: async args => { await state.run(args); published = true; }, timeoutMs: 1000, pollMs: 1 });
  assert.equal(result.sha, SHA); assert.equal(result.servingPercent, 100);
  assert.equal(state.calls.filter(call => call.cli).length, 1); assert.ok(drops > 0);
});
