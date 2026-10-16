import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { parseAppHostingBootstrapArgs } from "./bootstrap-staging-apphosting.mjs";

const script = new URL("./bootstrap-staging.sh", import.meta.url).pathname;
function run(args) {
  const directory = mkdtempSync(join(tmpdir(), "staging-bootstrap-"));
  const evidence = join(directory, "contacts");
  for (const tool of ["gcloud", "npx", "node", "jq"]) {
    writeFileSync(join(directory, tool), `#!/bin/sh\nprintf '%s\\n' '${tool}' >> "$BOOTSTRAP_TEST_CONTACTS"\nexit 91\n`, { mode: 0o700 });
  }
  try {
    const result = spawnSync("/bin/bash", [script, ...args], {
      env: { ...process.env, PATH: `${directory}:/usr/bin:/bin`, BOOTSTRAP_TEST_CONTACTS: evidence }, encoding: "utf8",
    });
    let contacts = "";
    try { contacts = readFileSync(evidence, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
    return { ...result, contacts };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("default and explicit dry-run have no cloud, dependency, or credential contact", () => {
  for (const args of [[], ["--dry-run"], ["--help"]]) {
    const result = run(args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.contacts, "");
    assert.match(result.stdout, /hotel-toolkit-staging/);
  }
});

test("production or arbitrary target fails before any commands", () => {
  for (const target of ["hotel-toolkit", "test-breakfast", "hotel-toolkit-staging-copy"]) {
    const result = run(["--apply", "--confirm-project", target]);
    assert.notEqual(result.status, 0);
    assert.equal(result.contacts, "");
    assert.match(result.stderr, /alternate target projects are forbidden/);
  }
});

test("cloud writes require explicit confirmation, locations, billing, and creation parent", () => {
  for (const args of [
    ["--apply"],
    ["--apply", "--confirm-project", "hotel-toolkit-staging"],
    ["--apply", "--confirm-project", "hotel-toolkit-staging", "--billing-account", "ABCDEF-123456-ABCDEF", "--firestore-location", "europe-west4", "--storage-location", "us-west1", "--create-project"],
  ]) {
    const result = run(args);
    assert.notEqual(result.status, 0);
    assert.equal(result.contacts, "");
  }
});

test("ambiguous modes, malformed arguments, and injection-shaped inputs are rejected offline", () => {
  for (const args of [
    ["--apply", "--dry-run"], ["--preflight", "--apply"], ["--billing-account"],
    ["--organization", "123", "--no-organization"], ["--project", "hotel-toolkit"],
    ["--billing-account", "$(touch should-not-exist)"], ["--firestore-location", "x; echo unsafe"],
  ]) {
    const result = run(args);
    assert.notEqual(result.status, 0);
    assert.equal(result.contacts, "");
  }
});

test("App Hosting bootstrap helper requires the fixed target before credential access", () => {
  assert.throws(() => parseAppHostingBootstrapArgs(["--apply", "--project", "hotel-toolkit", "--app-id", "1:358734544002:web:example"]), /no other project\/backend is allowed/);
  assert.deepEqual(parseAppHostingBootstrapArgs([]), { apply: false });
  assert.deepEqual(parseAppHostingBootstrapArgs(["--dry-run"]), { apply: false });
  assert.deepEqual(parseAppHostingBootstrapArgs(["--apply", "--project", "hotel-toolkit-staging", "--app-id", "1:123456789:web:abcdef"]), { apply: true, appId: "1:123456789:web:abcdef" });
});

test("immutable Storage location must match the existing shared trigger region", () => {
  const result = run(["--apply", "--storage-location", "europe-west4"]);
  assert.notEqual(result.status, 0);
  assert.equal(result.contacts, "");
  assert.match(result.stderr, /Storage must use us-west1/);
});

test("bootstrap prepares build identities and artifact policies in every exported Functions region", () => {
  const discovery = spawnSync(process.execPath, ["-e",
    'const functions = require(process.argv[1]); process.stdout.write(JSON.stringify([...new Set(Object.values(functions).filter(fn => fn.__endpoint).flatMap(fn => fn.__endpoint.region || ["us-central1"]))]));',
    new URL("../../functions/index.js", import.meta.url).pathname], {
    env: { PATH: process.env.PATH, NODE_ENV: "production", GCLOUD_PROJECT: "hotel-toolkit-staging", DEPLOYMENT_ENV: "staging",
      APP_BASE_URL: "https://hotel-toolkit-staging--hotel-toolkit-staging.europe-west4.hosted.app",
      FIREBASE_CONFIG: JSON.stringify({ projectId: "hotel-toolkit-staging", storageBucket: "hotel-toolkit-staging.firebasestorage.app" }) },
    encoding: "utf8",
  });
  assert.equal(discovery.status, 0, discovery.stderr);
  const regions = JSON.parse(discovery.stdout);
  assert.ok(regions.length > 0, "Discover real Functions endpoint regions without cloud credentials.");
  const loop = readFileSync(script, "utf8").match(/^for function_region in ([^;\n]+); do$/m);
  assert.ok(loop, "Locate the bootstrap's regional build/artifact preparation.");
  const prepared = new Set(loop[1].split(/\s+/));
  for (const region of regions) assert.ok(prepared.has(region), `Missing build/artifact setup for Functions region ${region}.`);
});

function runServiceEnablement(failService) {
  const directory = mkdtempSync(join(tmpdir(), "staging-service-enablement-"));
  const evidence = join(directory, "calls.jsonl");
  const source = readFileSync(script, "utf8");
  const start = source.indexOf("gcloud services enable ");
  const end = source.indexOf('\nif ! jq -e --arg id "$project_id"', start);
  assert.ok(start >= 0 && end > start, "Locate the real bootstrap service-enablement commands");
  writeFileSync(join(directory, "gcloud"), `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.BOOTSTRAP_TEST_CALLS, JSON.stringify(args) + "\\n");
const services = args.slice(2).filter((arg) => !arg.startsWith("--"));
if (services.length > 20 || services.includes(process.env.BOOTSTRAP_TEST_FAIL_SERVICE)) process.exit(1);
`, { mode: 0o700 });
  try {
    const result = spawnSync("/bin/bash", ["-euc", `project_id=hotel-toolkit-staging\n${source.slice(start, end)}`], {
      env: { ...process.env, PATH: `${directory}:/usr/bin:/bin`, BOOTSTRAP_TEST_CALLS: evidence,
        BOOTSTRAP_TEST_FAIL_SERVICE: failService || "" }, encoding: "utf8",
    });
    const calls = readFileSync(evidence, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    return { ...result, calls };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("real bootstrap enables every required API within Google's 20-service request limit", () => {
  const result = runServiceEnablement();
  assert.equal(result.status, 0, result.stderr);
  const services = [];
  for (const args of result.calls) {
    assert.deepEqual(args.slice(0, 2), ["services", "enable"]);
    assert.ok(args.includes("--project=hotel-toolkit-staging"));
    assert.ok(args.includes("--quiet"));
    const batch = args.slice(2).filter((arg) => !arg.startsWith("--"));
    assert.ok(batch.length > 0 && batch.length <= 20);
    services.push(...batch);
  }
  assert.deepEqual(services.sort(), [
    "firebase", "firebaseapphosting", "firebaseextensions", "firebaserules", "firebasestorage",
    "iam", "iamcredentials", "sts", "cloudresourcemanager", "serviceusage", "cloudbilling",
    "identitytoolkit", "firestore", "storage", "cloudfunctions", "cloudbuild", "run", "compute",
    "artifactregistry", "eventarc", "pubsub", "cloudscheduler", "secretmanager", "developerconnect",
  ].map((service) => `${service}.googleapis.com`).sort());
});

test("bootstrap stops enabling APIs when a batch fails", () => {
  const result = runServiceEnablement("firebase.googleapis.com");
  assert.notEqual(result.status, 0);
  assert.equal(result.calls.length, 1, "Do not continue to another batch after a failure");
});
