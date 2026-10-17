import test from "node:test";
import assert from "node:assert/strict";
import { verifySaasRelease, MANAGED_FRONTEND_STEP } from "./saas-release-check.mjs";

const SHA = "a".repeat(40);
const step = (name, conclusion = "success") => ({ name, conclusion });
const deployed = [step("Deploy Functions to hotel-toolkit"), step("Record deployed Functions inventory")];
function fixture({ external = false, managed = false, verify = true, steps = deployed, jobConclusion = "success", runConclusion = "success", mainSha = SHA } = {}) {
  const paths = [];
  const read = async path => {
    paths.push(path);
    if (path === "git/ref/heads/main") return { object: { sha: mainSha } };
    if (path.startsWith("commits/")) return { check_runs: [
      { name: "verify", app: { slug: "github-actions" }, conclusion: verify ? "success" : "failure" },
      ...(external ? [{ name: "App Hosting - Rollout (hotel-toolkit/europe-west4/hotel-toolkit)", app: { slug: "firebase-app-hosting" }, conclusion: "success" }] : []),
    ] };
    if (path.startsWith("actions/workflows/")) return { workflow_runs: [{ id: 42, head_sha: SHA, conclusion: runConclusion, status: "completed" }] };
    if (path.startsWith("actions/runs/")) return { jobs: [{ name: "production", conclusion: jobConclusion, steps: [...steps, ...(managed ? [step(MANAGED_FRONTEND_STEP)] : [])] }] };
    throw new Error("Unexpected metadata path");
  };
  return { read, paths };
}
const check = options => verifySaasRelease({ sha: SHA, read: fixture(options).read });

test("legacy external App Hosting plus real Functions deployment still authorizes one-time activation", async () => {
  assert.equal((await check({ external: true })).frontend, "external-app-hosting-check");
});

test("managed frontend publication authorizes later setup without an independent auto-rollout check", async () => {
  assert.equal((await check({ managed: true })).frontend, "managed-production-workflow");
});

test("skipped, failed or incomplete deploy jobs cannot claim either component was released", async () => {
  for (const options of [{ external: true, steps: [] }, { managed: true, steps: [deployed[0]] },
    { managed: true, jobConclusion: "skipped" }, { external: true, runConclusion: "failure" },
    { external: true, steps: [step(deployed[0].name, "skipped"), deployed[1]] }]) await assert.rejects(check(options), /Functions deployment/);
  await assert.rejects(check({}), /frontend publication/);
});

test("exact current main and CI remain mandatory even with successful managed publication", async () => {
  await assert.rejects(check({ managed: true, mainSha: "b".repeat(40) }), /current main/);
  await assert.rejects(check({ managed: true, verify: false }), /verify has not succeeded/);
  await assert.rejects(verifySaasRelease({ sha: "main", read: async () => { throw new Error("must not read"); } }), /exact SAAS_RELEASE_SHA/);
});
