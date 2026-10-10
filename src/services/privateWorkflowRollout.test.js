import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execute = promisify(execFile);
async function runRollout(apply, failure = null) {
  const directory = await mkdtemp(join(tmpdir(), "private-workflow-wrapper-"));
  const bin = join(directory, "bin"), workspace = join(directory, "workspace"), runtime = join(directory, "runtime"), log = join(directory, "calls.jsonl"), installLog = join(directory, "install.json");
  await mkdir(bin); await mkdir(workspace);
  await writeFile(join(workspace, "previous-rules.json"), "preserved Rules backup");
  await writeFile(join(workspace, "previous-private-records.json"), "preserved private records");
  const fake = "#!" + process.execPath + '\n' + `
const fs = require("node:fs"), path = require("node:path");
const name = path.basename(process.argv[1]), args = process.argv.slice(2);
if (name === "gcloud") { process.stdout.write(args[0] === "auth" ? "bestsmekens@gmail.com\\n" : "358734544002\\n"); }
else if (name === "mktemp") {
 const destination = args.at(-1).startsWith("/tmp/") ? process.env.PRIVATE_FIXTURE_RUNTIME : process.env.PRIVATE_FIXTURE_WORKSPACE;
 fs.mkdirSync(destination, { recursive: true }); process.stdout.write(destination + "\\n");
}
else if (name === "curl") {
 const source = args.find((arg) => arg.startsWith("https://raw.githubusercontent.com/SmekensRuben/HotelSuite/"));
 const file = new URL(source).pathname.split("/").slice(4).join("/");
 fs.copyFileSync(path.join(process.env.PRIVATE_FIXTURE_SOURCE, file), args[args.indexOf("--output") + 1]);
}
else if (name === "df") {
 const available = process.env.PRIVATE_FIXTURE_FAILURE === (args[0] === "-Pi" ? "inodes" : "disk") ? "0" : "4000000";
 process.stdout.write("Filesystem total used available capacity mount\\nfixture 4000000 0 " + available + " 0% /tmp\\n");
}
else if (name === "npm") {
 fs.writeFileSync(process.env.PRIVATE_FIXTURE_INSTALL_LOG, JSON.stringify(args));
 fs.mkdirSync(path.join(process.env.PRIVATE_FIXTURE_RUNTIME, "node_modules"));
 fs.writeFileSync(path.join(process.env.PRIVATE_FIXTURE_RUNTIME, "partial-download"), "rebuildable");
 if (process.env.PRIVATE_FIXTURE_FAILURE === "install") process.exit(1);
}
else if (name === "node" && args[0] !== "-e") {
 fs.appendFileSync(process.env.PRIVATE_FIXTURE_LOG, JSON.stringify(args) + "\\n");
 if (process.env.PRIVATE_FIXTURE_FAILURE === args.slice(0, 2).join(":")) process.exit(1);
}
`;
  for (const name of ["node", "gcloud", "mktemp", "curl", "npm", "sleep", "df"]) await writeFile(join(bin, name), fake, { mode: 0o700 });
  let failed = false;
  try {
    try { await execute("bash", [resolve("scripts/firebase/rollout-private-workflows.sh"), "--release-sha", "a".repeat(40), ...(apply ? ["--apply"] : [])], { env: { ...process.env, PATH: bin + ":" + process.env.PATH, PRIVATE_FIXTURE_WORKSPACE: workspace, PRIVATE_FIXTURE_RUNTIME: runtime, PRIVATE_FIXTURE_SOURCE: process.cwd(), PRIVATE_FIXTURE_LOG: log, PRIVATE_FIXTURE_INSTALL_LOG: installLog, PRIVATE_FIXTURE_FAILURE: failure || "" }, timeout: 20000 }); }
    catch { failed = true; }
    const calls = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse);
    const installArgs = await readFile(installLog, "utf8").then(JSON.parse).catch(() => null);
    const runtimeRemoved = await lstat(runtime).then(() => false).catch(() => true);
    const linkRemoved = await lstat(join(workspace, "node_modules")).then(() => false).catch(() => true);
    const backups = await Promise.all(["previous-rules.json", "previous-private-records.json"].map((file) => readFile(join(workspace, file), "utf8")));
    return { calls, failed, installArgs, runtimeRemoved, linkRemoved, backups, runtime };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
describe("actual Cloud Shell private rollout wrapper with fake provider CLIs", () => {
  it("defaults to read-only release and data preflights", async () => {
    const result = await runRollout(false);
    expect(result.failed).toBe(false); expect(result.calls).toHaveLength(3);
    expect(result.calls.map((c) => c[1]).filter(Boolean)).toEqual(["preflight", "preflight"]);
    expect(result.installArgs).toEqual(["ci", "--prefix", result.runtime, "--cache", join(result.runtime, "npm-cache"), "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"]);
    expect(result.runtimeRemoved && result.linkRemoved).toBe(true);
    expect(result.backups).toEqual(["preserved Rules backup", "preserved private records"]);
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
    expect(result.runtimeRemoved && result.linkRemoved).toBe(true);
  }, 25000);
  it("cleans a partial dependency install and preserves backups before any cloud mutation", async () => {
    const result = await runRollout(true, "install");
    expect(result.failed).toBe(true);
    expect(result.calls).toHaveLength(1);
    expect(result.runtimeRemoved && result.linkRemoved).toBe(true);
    expect(result.backups).toEqual(["preserved Rules backup", "preserved private records"]);
  }, 25000);
  it.each(["disk", "inodes"])("stops before installation or cloud mutations when temporary %s space is exhausted", async (failure) => {
    const result = await runRollout(true, failure);
    expect(result.failed).toBe(true);
    expect(result.installArgs).toBe(null);
    expect(result.calls).toHaveLength(1);
    expect(result.backups).toEqual(["preserved Rules backup", "preserved private records"]);
  }, 25000);
});
