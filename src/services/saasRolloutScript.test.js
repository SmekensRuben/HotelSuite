// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const releaseSha = "a".repeat(40);
const storageAgent = "service-358734544002@gcp-sa-firebasestorage.iam.gserviceaccount.com";
const storageRole = "roles/firebaserules.firestoreServiceAgent";
const script = resolve("scripts/firebase/rollout-saas-pilot.sh");
const fixtures = [];

afterEach(() => {
  for (const directory of fixtures.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function runRollout(options = [], { existingRole = false, denyGrant = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "hotelsuite-rollout-test-"));
  fixtures.push(directory);
  const bin = join(directory, "bin");
  const log = join(directory, "commands.jsonl");
  mkdirSync(bin);
  // Every cloud/network/runtime operation is fake. Python still evaluates the
  // real project-policy JSON, and Bash runs the complete production wrapper.
  const commandFixture = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
fs.appendFileSync(process.env.ROLLOUT_TEST_LOG, JSON.stringify({ command, args }) + "\\n");
function unsupported() { console.error("Unexpected test command: " + command + " " + args.join(" ")); process.exit(99); }
if (command === "gcloud") {
  if (args[0] === "auth" && args[1] === "list") console.log("bestsmekens@gmail.com");
  else if (args[0] === "projects" && args[1] === "describe" && args[2] === "hotel-toolkit") console.log("358734544002");
  else if (args[0] === "projects" && args[1] === "get-iam-policy" && args[2] === "hotel-toolkit") console.log(process.env.ROLLOUT_TEST_POLICY);
  else if (args[0] === "projects" && args[1] === "add-iam-policy-binding") {
    if (process.env.ROLLOUT_TEST_DENY_GRANT === "true") { console.error("Project policy update denied"); process.exit(1); }
  } else if (args[0] === "iam" && args[1] === "service-accounts") {
    console.error("iam.serviceAccounts.get denied on the Google-managed account"); process.exit(1);
  } else unsupported();
} else if (command === "curl") {
  const destination = args[args.indexOf("--output") + 1];
  if (!destination || !args.some((a) => a.startsWith("https://raw.githubusercontent.com/SmekensRuben/HotelSuite/"))) unsupported();
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, "{}");
} else if (command === "mktemp") {
  console.log(fs.mkdtempSync(path.join(process.env.ROLLOUT_TEST_ROOT, "hotelsuite-rollout-")));
} else if (command === "node") {
  if (args[0] !== "-e" && args[0] !== "scripts/firebase/saas-release-check.mjs" && args[0] !== "scripts/firebase/saas-rollout.mjs") unsupported();
} else if (command !== "npm" && command !== "sleep") unsupported();
`;
  for (const command of ["gcloud", "curl", "node", "npm", "sleep", "mktemp"]) {
    writeFileSync(join(bin, command), commandFixture, { mode: 0o700 });
  }
  const result = spawnSync("bash", [script, "--release-sha", releaseSha, ...options], {
    encoding: "utf8",
    timeout: 10000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      ROLLOUT_TEST_ROOT: directory,
      ROLLOUT_TEST_LOG: log,
      ROLLOUT_TEST_DENY_GRANT: String(denyGrant),
      ROLLOUT_TEST_POLICY: JSON.stringify({ bindings: existingRole ? [{ role: storageRole, members: [`serviceAccount:${storageAgent}`] }] : [] }),
    },
  });
  const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  const grants = calls.filter(({ command, args }) => command === "gcloud" && args[1] === "add-iam-policy-binding");
  const phases = calls.filter(({ command, args }) => command === "node" && args[0] === "scripts/firebase/saas-rollout.mjs").map(({ args }) => args[1]);
  return { ...result, calls, grants, phases };
}

describe("Cloud Shell rollout IAM boundary", () => {
  it("runs the read-only preflight without a role grant or mutation", () => {
    const result = runRollout();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Read-only preflight completed");
    expect(result.grants).toEqual([]);
    expect(result.phases).toEqual(["preflight"]);
  });

  it("requires explicit approval when the project role is missing", () => {
    const result = runRollout(["--apply"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("--grant-storage-rules-access");
    expect(result.grants).toEqual([]);
    expect(result.phases).toEqual(["preflight"]);
  });

  it("can grant the exact project role and complete rollout without account-inspection permission", () => {
    const result = runRollout(["--apply", "--grant-storage-rules-access"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls.some(({ command, args }) => command === "gcloud" && args[0] === "iam")).toBe(false);
    expect(result.grants).toEqual([{ command: "gcloud", args: ["projects", "add-iam-policy-binding", "hotel-toolkit", `--member=serviceAccount:${storageAgent}`, `--role=${storageRole}`, "--condition=None"] }]);
    expect(result.phases).toEqual(["preflight", "pause", "preflight", "deploy-rules", "migrate", "enable"]);
    expect(result.stdout).toContain("SaaS procurement pilot enabled");
  });

  it("reuses the existing project binding without granting additional access", () => {
    const result = runRollout(["--apply"], { existingRole: true });
    expect(result.status, result.stderr).toBe(0);
    expect(result.grants).toEqual([]);
    expect(result.phases.at(-1)).toBe("enable");
  });

  it("stops before pausing or publishing Rules if the actual project grant is denied", () => {
    const result = runRollout(["--apply", "--grant-storage-rules-access"], { denyGrant: true });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Project policy update denied");
    expect(result.grants).toHaveLength(1);
    expect(result.phases).toEqual(["preflight"]);
    expect(result.stdout).not.toContain("SaaS procurement pilot enabled");
  });
});
