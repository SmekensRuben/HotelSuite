import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { requireReleaseMode, requireReleaseSha, requireStagingReleaseEvidence, requireProductionReview } from "./release-mode-policy.mjs";
import { artifactEvidence, inspectControlledRelease } from "./check-controlled-release.mjs";

const PRODUCTION_SHA = "a".repeat(40), STAGING_SHA = "b".repeat(40), TREE = "c".repeat(40), OTHER_TREE = "d".repeat(40);
const RUN_ID = 100, ARTIFACT_ID = 200;

function proof() {
  return {
    productionCommit: { sha: PRODUCTION_SHA, tree: { sha: TREE } },
    stagingCommit: { sha: STAGING_SHA, tree: { sha: TREE } },
    run: { id: RUN_ID, event: "workflow_dispatch", head_branch: "main", head_sha: STAGING_SHA,
      status: "completed", conclusion: "success", path: ".github/workflows/deploy-staging.yml",
      repository: { id: 1161047380 }, head_repository: { id: 1161047380 } },
    jobs: [{ name: `Deploy verified SHA ${STAGING_SHA}`, conclusion: "success", steps: [
      { name: "Deploy and activate one coordinated staging release", conclusion: "success" } ] }],
    artifact: { id: ARTIFACT_ID, name: `staging-release-${STAGING_SHA}`, expired: false, workflow_run: { id: RUN_ID } },
    evidence: { sha: STAGING_SHA, projectId: "hotel-toolkit-staging", backendSha: STAGING_SHA, frontendSha: STAGING_SHA,
      functionsVerified: true, appHostingVerified: true, frontendMarkerVerified: true, functions: ["checkPlatformImportHealth"],
      appHostingBuild: "projects/hotel-toolkit-staging/locations/europe-west4/backends/hotel-toolkit-staging/builds/accepted-build",
      appHostingRollout: "projects/79412748471/locations/europe-west4/backends/hotel-toolkit-staging/rollouts/accepted-rollout" },
  };
}

function inspectionFixture(state = proof(), { overrides = {} } = {}) {
  const calls = [], downloads = [];
  const api = async path => {
    calls.push(path);
    const override = overrides[path];
    if (override !== undefined) return typeof override === "function" ? override(path) : structuredClone(override);
    if (path === `git/commits/${PRODUCTION_SHA}`) return structuredClone(state.productionCommit);
    if (path === `git/commits/${STAGING_SHA}`) return structuredClone(state.stagingCommit);
    if (path === "actions/workflows/deploy-staging.yml/runs?branch=main&event=workflow_dispatch&status=success&per_page=20") {
      return { workflow_runs: [structuredClone(state.run)] };
    }
    if (path === `actions/runs/${RUN_ID}`) return structuredClone(state.run);
    if (path === `actions/runs/${RUN_ID}/artifacts?per_page=100`) return { artifacts: [structuredClone(state.artifact)] };
    if (path === `actions/runs/${RUN_ID}/jobs?per_page=100`) return { jobs: structuredClone(state.jobs) };
    throw new Error(`Unexpected release proof read ${path}`);
  };
  const readEvidence = async (runId, artifact) => { downloads.push({ runId, artifactId: artifact.id }); return structuredClone(state.evidence); };
  return { api, readEvidence, calls, downloads };
}
const inspect = (fixture, patch = {}) => inspectControlledRelease({ sha: PRODUCTION_SHA, api: fixture.api,
  readEvidence: fixture.readEvidence, ...patch });
const pinned = (patch = {}) => ({ runId: RUN_ID, artifactId: ARTIFACT_ID, stagingSha: STAGING_SHA, tree: TREE, ...patch });
const review = (patch = {}) => ({ state: "approved", user: { login: "release-reviewer" }, environments: [{ name: "production" }], ...patch });

// A stored ZIP entry exercises the real unzip boundary without another package
// or a remote artifact. ZIP uses the standard CRC-32 checksum for its content.
function evidenceArchive(contents, filename = "staging-release-evidence.json") {
  const data = Buffer.from(contents), name = Buffer.from(filename);
  let checksum = 0xffffffff;
  for (const byte of data) {
    checksum ^= byte;
    for (let bit = 0; bit < 8; bit++) checksum = (checksum >>> 1) ^ ((checksum & 1) ? 0xedb88320 : 0);
  }
  checksum = (checksum ^ 0xffffffff) >>> 0;
  const local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
  local.writeUInt32LE(checksum, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
  central.writeUInt32LE(checksum, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length + data.length, 16);
  return Buffer.concat([local, name, data, central, name, end]);
}

function artifactTransport(archive) {
  const calls = [];
  return { calls, run(binary, args, options) {
    calls.push({ binary, args, options });
    if (binary === "gh") return archive;
    assert.equal(binary, "unzip");
    assert.equal(statSync(args[1]).mode & 0o777, 0o600);
    return execFileSync(binary, args, options);
  } };
}

test("artifact transport downloads the immutable ID and reads a real bounded ZIP entry", () => {
  const evidence = proof().evidence, archive = evidenceArchive(JSON.stringify(evidence));
  const transport = artifactTransport(archive);
  const artifact = { ...proof().artifact, digest: `sha256:${createHash("sha256").update(archive).digest("hex")}` };
  assert.deepEqual(artifactEvidence(RUN_ID, artifact, transport), evidence);
  assert.deepEqual(transport.calls.map(({ binary }) => binary), ["gh", "unzip"]);
  assert.deepEqual(transport.calls[0].args, ["api", `repos/SmekensRuben/HotelSuite/actions/artifacts/${ARTIFACT_ID}/zip`]);
  assert.equal(transport.calls[0].options.maxBuffer, 10 * 1024 * 1024);
  assert.equal(transport.calls[1].options.maxBuffer, 100000);
  assert.equal(existsSync(dirname(transport.calls[1].args[1])), false, "The temporary archive is removed after parsing.");
});

test("artifact transport rejects invalid identity or digest before reading archive content", () => {
  const archive = evidenceArchive("{}"), invalid = [
    { ...proof().artifact, id: 0 }, { ...proof().artifact, id: "200" },
    { ...proof().artifact, workflow_run: { id: RUN_ID + 1 } },
  ];
  for (const artifact of invalid) {
    const transport = artifactTransport(archive);
    assert.throws(() => artifactEvidence(RUN_ID, artifact, transport), /unavailable or invalid/);
    assert.equal(transport.calls.length, 0);
  }
  const transport = artifactTransport(archive);
  assert.throws(() => artifactEvidence(RUN_ID, { ...proof().artifact, digest: `sha256:${"0".repeat(64)}` }, transport), /unavailable or invalid/);
  assert.deepEqual(transport.calls.map(({ binary }) => binary), ["gh"]);
});

test("missing, malformed and oversized artifact entries fail closed and remove their temporary archives", () => {
  for (const archive of [evidenceArchive("{}", "unrelated.json"), evidenceArchive("not-json"), evidenceArchive(" ".repeat(100001)), Buffer.from("not a ZIP archive")]) {
    const transport = artifactTransport(archive);
    assert.throws(() => artifactEvidence(RUN_ID, proof().artifact, transport), /unavailable or invalid/);
    assert.equal(existsSync(dirname(transport.calls[1].args[1])), false);
  }
});

test("artifact transport failures redact GitHub credentials and payloads", () => {
  assert.throws(() => artifactEvidence(RUN_ID, proof().artifact, { run() {
    throw new Error("private-token confidential artifact response");
  } }), error => /unavailable or invalid/.test(error.message) && !/private-token|confidential/.test(error.message));
});

test("release mode must be explicitly development or controlled", () => {
  assert.equal(requireReleaseMode("development"), "development");
  assert.equal(requireReleaseMode("controlled"), "controlled");
  for (const value of [undefined, null, "", "production", "staging", "Development", " controlled ", false]) {
    assert.throws(() => requireReleaseMode(value), /RELEASE_MODE/);
  }
});

test("release SHA validation requires the complete immutable lowercase commit identifier", () => {
  assert.equal(requireReleaseSha(PRODUCTION_SHA), PRODUCTION_SHA);
  for (const value of [undefined, "main", "a".repeat(39), "a".repeat(41), "A".repeat(40), "g".repeat(40)]) {
    assert.throws(() => requireReleaseSha(value));
  }
});

test("staging acceptance can cross a merge commit only when the complete Git tree is identical", () => {
  const state = proof();
  assert.notEqual(state.productionCommit.sha, state.stagingCommit.sha);
  assert.deepEqual(requireStagingReleaseEvidence(state), { stagingSha: STAGING_SHA, tree: TREE, runId: RUN_ID, artifactId: ARTIFACT_ID });
  state.productionCommit.tree.sha = OTHER_TREE;
  assert.throws(() => requireStagingReleaseEvidence(state), /exact application tree/);
});

test("the staging workflow must have successfully completed in the trusted main repository", () => {
  for (const patch of [{ conclusion: "failure" }, { status: "in_progress" }, { event: "push" },
    { head_branch: "feature/monitoring" }, { repository: { id: 1 } }, { head_repository: { id: 1 } },
    { path: ".github/workflows/unrelated.yml" }]) {
    const state = proof(); Object.assign(state.run, patch);
    assert.throws(() => requireStagingReleaseEvidence(state), /successful trusted staging workflow/);
  }
});

test("an always-uploaded staging artifact does not prove successful coordinated deployment and activation", () => {
  const invalidJobs = [[], [{ name: `Deploy verified SHA ${STAGING_SHA}`, conclusion: "failure", steps: [
    { name: "Deploy and activate one coordinated staging release", conclusion: "success" } ] }],
  [{ name: `Deploy verified SHA ${STAGING_SHA}`, conclusion: "success", steps: [] }],
  [{ name: `Deploy verified SHA ${STAGING_SHA}`, conclusion: "success", steps: [
    { name: "Deploy and activate one coordinated staging release", conclusion: "skipped" } ] }],
  [{ name: `Deploy verified SHA ${PRODUCTION_SHA}`, conclusion: "success", steps: [
    { name: "Deploy and activate one coordinated staging release", conclusion: "success" } ] }]];
  for (const jobs of invalidJobs) assert.throws(() => requireStagingReleaseEvidence({ ...proof(), jobs }), /final activation/);
});

test("staging evidence rejects foreign projects, mismatched versions, expired artifacts and partial verification", () => {
  const changes = [
    state => { state.artifact.expired = true; },
    state => { state.artifact.workflow_run.id = RUN_ID + 1; },
    state => { state.artifact.name = `staging-release-${PRODUCTION_SHA}`; },
    state => { state.evidence.projectId = "hotel-toolkit"; },
    state => { state.evidence.backendSha = PRODUCTION_SHA; },
    state => { state.evidence.frontendSha = PRODUCTION_SHA; },
    state => { state.evidence.functionsVerified = false; },
    state => { state.evidence.appHostingVerified = false; },
    state => { state.evidence.frontendMarkerVerified = false; },
    state => { state.evidence.functions = []; },
    state => { state.evidence.appHostingBuild = "projects/hotel-toolkit/locations/europe-west4/backends/hotel-toolkit/builds/foreign"; },
    state => { state.evidence.appHostingRollout = "projects/hotel-toolkit-staging/locations/us-central1/backends/hotel-toolkit-staging/rollouts/wrong-region"; },
    state => { state.stagingCommit.sha = PRODUCTION_SHA; },
  ];
  for (const change of changes) {
    const state = proof(); change(state);
    assert.throws(() => requireStagingReleaseEvidence(state));
  }
});

test("production review accepts a single native approval for the protected production environment", () => {
  assert.equal(requireProductionReview([review()], { runAttempt: "1" }), "release-reviewer");
  assert.equal(requireProductionReview([review({ environments: [{ name: "staging" }] }), review()], { runAttempt: 1 }), "release-reviewer");
});

test("missing, unreadable, unprotected, rejected and ambiguous production reviews block release", () => {
  for (const reviews of [undefined, [], { status: 403 }, [review({ environments: [] })],
    [review({ environments: [{ name: "staging" }] })], [review({ state: "rejected" })],
    [review({ user: {} })], [review(), review({ user: { login: "another-reviewer" } })]]) {
    assert.throws(() => requireProductionReview(reviews, { runAttempt: "1" }), /Missing, unprotected or unreadable approval/);
  }
});

test("approval history from another run attempt cannot authorize a controlled rerun", () => {
  for (const runAttempt of [undefined, "", 0, 2, "2", "01"]) {
    assert.throws(() => requireProductionReview([review()], { runAttempt }), /new workflow_dispatch run/);
  }
});

test("controlled inspection reads a successful exact-tree staging deployment despite different commit SHAs", async () => {
  const fixture = inspectionFixture();
  assert.deepEqual(await inspect(fixture), { stagingSha: STAGING_SHA, tree: TREE, runId: RUN_ID, artifactId: ARTIFACT_ID });
  assert.deepEqual(fixture.downloads, [{ runId: RUN_ID, artifactId: ARTIFACT_ID }]);
  assert.ok(fixture.calls.includes(`actions/runs/${RUN_ID}/jobs?per_page=100`));
});

test("inspection skips other application trees before downloading any staging acceptance evidence", async () => {
  const state = proof(); state.stagingCommit.tree.sha = OTHER_TREE;
  const fixture = inspectionFixture(state);
  await assert.rejects(inspect(fixture), /No matching successful staging release/);
  assert.deepEqual(fixture.downloads, []);
});

test("inspection rejects partial deployment artifacts even when upload succeeded", async () => {
  const state = proof(); state.jobs[0].steps[0].conclusion = "failure";
  const fixture = inspectionFixture(state);
  await assert.rejects(inspect(fixture), /final activation/);
});

test("pinned staging evidence is revalidated and cannot silently change after approval selection", async () => {
  const fixture = inspectionFixture();
  assert.equal((await inspect(fixture, { pinned: pinned() })).artifactId, ARTIFACT_ID);
  assert.equal(fixture.calls.some(path => path.startsWith("actions/workflows/")), false);
  for (const selection of [pinned({ stagingSha: PRODUCTION_SHA }), pinned({ tree: OTHER_TREE }), pinned({ artifactId: ARTIFACT_ID + 1 })]) {
    await assert.rejects(inspect(inspectionFixture(), { pinned: selection }));
  }
  const changedTree = proof(); changedTree.stagingCommit.tree.sha = OTHER_TREE;
  await assert.rejects(inspect(inspectionFixture(changedTree), { pinned: pinned() }), /exact application tree/);
});

test("expired or absent staging evidence and oversized inventories cannot authorize a controlled release", async () => {
  const expired = proof(); expired.artifact.expired = true;
  for (const fixture of [inspectionFixture(expired), inspectionFixture(proof(), { overrides: {
    "actions/workflows/deploy-staging.yml/runs?branch=main&event=workflow_dispatch&status=success&per_page=20": { workflow_runs: [] },
  } })]) {
    await assert.rejects(inspect(fixture), /No matching successful staging release/);
    assert.deepEqual(fixture.downloads, []);
  }
  const fixture = inspectionFixture(proof(), { overrides: { [`actions/runs/${RUN_ID}/artifacts?per_page=100`]: {
    artifacts: Array.from({ length: 100 }, () => proof().artifact),
  } } });
  await assert.rejects(inspect(fixture), /inventory exceeds/);
  assert.deepEqual(fixture.downloads, []);
});

test("an unavailable GitHub evidence API fails closed instead of treating a 403 as acceptance", async () => {
  const fixture = inspectionFixture(proof(), { overrides: { [`actions/runs/${RUN_ID}/jobs?per_page=100`]: () => {
    const error = new Error("GitHub evidence unavailable"); error.status = 403; throw error;
  } } });
  await assert.rejects(inspect(fixture), error => error.status === 403);
  assert.deepEqual(fixture.downloads, []);
});
