// Public release metadata only. Legacy external frontend checks remain valid for one-time setup.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = "https://api.github.com/repos/SmekensRuben/HotelSuite/";
export const MANAGED_FRONTEND_STEP = "Publish and verify exact App Hosting release";
const FUNCTION_STEPS = ["Deploy Functions to hotel-toolkit", "Record deployed Functions inventory"];
const passedStep = (job, name) => job.steps?.some(step => step.name === name && step.conclusion === "success");

export async function verifySaasRelease({ sha, read }) {
  if (!/^[a-f0-9]{40}$/.test(sha || "")) throw new Error("An exact SAAS_RELEASE_SHA is required.");
  const main = await read("git/ref/heads/main");
  if (main.object?.sha !== sha) throw new Error("The reviewed release is no longer current main. Review the new release first.");
  const checks = await read(`commits/${sha}/check-runs?per_page=100`);
  if (!checks.check_runs?.some(check => check.name === "verify" && check.app?.slug === "github-actions" && check.conclusion === "success")) throw new Error("verify has not succeeded for this release.");
  const externalFrontend = checks.check_runs.some(check => check.name === "App Hosting - Rollout (hotel-toolkit/europe-west4/hotel-toolkit)"
    && check.app?.slug === "firebase-app-hosting" && check.conclusion === "success");
  const runs = await read(`actions/workflows/deploy-functions.yml/runs?branch=main&head_sha=${sha}&per_page=10`);
  let functionsDeployed = false, frontendPublished = false;
  for (const run of runs.workflow_runs || []) {
    if (run.head_sha !== sha || run.conclusion !== "success" || run.status !== "completed") continue;
    const jobs = await read(`actions/runs/${run.id}/jobs?per_page=100`);
    for (const job of jobs.jobs || []) {
      if (job.conclusion !== "success" || !FUNCTION_STEPS.every(name => passedStep(job, name))) continue;
      functionsDeployed = true;
      if (passedStep(job, MANAGED_FRONTEND_STEP)) frontendPublished = true;
    }
  }
  if (!functionsDeployed) throw new Error("Wait for the successful automatic Functions deployment with actual deploy and inventory steps; a skipped release does not qualify.");
  if (!externalFrontend && !frontendPublished) throw new Error("Wait for a successful exact-commit external App Hosting rollout or verified managed production frontend publication.");
  return { sha, functionsDeployed: true, frontend: frontendPublished ? "managed-production-workflow" : "external-app-hosting-check" };
}

async function read(path) {
  const response = await fetch(`${BASE}${path}`, { headers: { Accept: "application/vnd.github+json", "User-Agent": "HotelSuite-reviewed-rollout" }, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Release metadata is unavailable (${response.status}). No rollout was performed.`);
  return response.json();
}
async function main() {
  const result = await verifySaasRelease({ sha: process.env.SAAS_RELEASE_SHA, read });
  console.log(`Verified current main ${result.sha}, CI, ${result.frontend} and actual Functions deployment.`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
