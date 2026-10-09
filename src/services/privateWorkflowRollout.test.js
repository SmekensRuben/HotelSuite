import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execute = promisify(execFile);
async function runRollout(apply, failure = null) {
  const directory = await mkdtemp(join(tmpdir(), "private-workflow-wrapper-"));
  const bin = join(directory, "bin"), workspace = join(directory, "workspace"), log = join(directory, "calls.jsonl");
  await mkdir(bin); await mkdir(workspace);
  const fake = "#!" + process.execPath + '\n' + `
const fs = require("node:fs"), path = require("node:path");
const name = path.basename(process.argv[1]), args = process.argv.slice(2);
if (name === "gcloud") { process.stdout.write(args[0] === "auth" ? "bestsmekens@gmail.com\\n" : "358734544002\\n"); }
else if (name === "mktemp") process.stdout.write(process.env.PRIVATE_FIXTURE_WORKSPACE + "\\n");
else if (name === "curl") fs.writeFileSync(args[args.indexOf("--output") + 1], "fixture");
else if (name === "node" && args[0] !== "-e") {
 fs.appendFileSync(process.env.PRIVATE_FIXTURE_LOG, JSON.stringify(args) + "\\n");
 if (process.env.PRIVATE_FIXTURE_FAILURE === args.slice(0, 2).join(":")) process.exit(1);
}
`;
  for (const name of ["node", "gcloud", "mktemp", "curl", "npm", "sleep"]) await writeFile(join(bin, name), fake, { mode: 0o700 });
  let failed = false;
  try {
    try { await execute("bash", [resolve("scripts/firebase/rollout-private-workflows.sh"), "--release-sha", "a".repeat(40), ...(apply ? ["--apply"] : [])], { env: { ...process.env, PATH: bin + ":" + process.env.PATH, PRIVATE_FIXTURE_WORKSPACE: workspace, PRIVATE_FIXTURE_LOG: log, PRIVATE_FIXTURE_FAILURE: failure || "" }, timeout: 20000 }); }
    catch { failed = true; }
    const calls = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse);
    return { calls, failed };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
describe("actual Cloud Shell private rollout wrapper with fake provider CLIs", () => {
  it("defaults to read-only release and data preflights", async () => {
    const result = await runRollout(false);
    expect(result.failed).toBe(false); expect(result.calls).toHaveLength(3);
    expect(result.calls.map((c) => c[1]).filter(Boolean)).toEqual(["preflight", "preflight"]);
  }, 25000);
  it("pauses both gates, publishes before migration and enables only after final release verification", async () => {
    const result = await runRollout(true); expect(result.failed).toBe(false);
    expect(result.calls.map((c) => c.slice(0, 2).join(":"))).toEqual([
      "scripts/firebase/saas-release-check.mjs", "scripts/firebase/saas-rollout.mjs:preflight", "scripts/firebase/private-workflows-rollout.mjs:preflight",
      "scripts/firebase/saas-release-check.mjs", "scripts/firebase/private-workflows-rollout.mjs:pause", "scripts/firebase/saas-rollout.mjs:pause",
      "scripts/firebase/saas-rollout.mjs:preflight", "scripts/firebase/private-workflows-rollout.mjs:preflight", "scripts/firebase/saas-rollout.mjs:deploy-rules",
      "scripts/firebase/saas-release-check.mjs", "scripts/firebase/saas-rollout.mjs:preflight", "scripts/firebase/private-workflows-rollout.mjs:preflight",
      "scripts/firebase/saas-rollout.mjs:migrate", "scripts/firebase/private-workflows-rollout.mjs:migrate", "scripts/firebase/saas-release-check.mjs",
      "scripts/firebase/saas-rollout.mjs:enable", "scripts/firebase/private-workflows-rollout.mjs:enable",
    ]);
  }, 25000);
  it("never publishes or pauses when the file preflight fails", async () => {
    const result = await runRollout(true, "scripts/firebase/private-workflows-rollout.mjs:preflight");
    expect(result.failed).toBe(true); expect(result.calls.some((c) => ["pause", "deploy-rules", "migrate", "enable"].includes(c[1]))).toBe(false);
  }, 25000);
  it("does not enable either gate after a failed file migration", async () => {
    const result = await runRollout(true, "scripts/firebase/private-workflows-rollout.mjs:migrate");
    expect(result.failed).toBe(true); expect(result.calls.some((c) => c[1] === "enable")).toBe(false);
  }, 25000);
});
