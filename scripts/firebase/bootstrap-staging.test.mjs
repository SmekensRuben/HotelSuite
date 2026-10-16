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
