import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FUNCTIONS_REPOSITORY } from "./functions-release-policy.mjs";
import { requireReleaseMode, requireReleaseSha, requireStagingReleaseEvidence, requireProductionReview } from "./release-mode-policy.mjs";

function github(path) {
  try { return JSON.parse(execFileSync("gh", ["api", `repos/${FUNCTIONS_REPOSITORY}/${path}`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 5 * 1024 * 1024 })); }
  catch { throw new Error("Release evidence could not be read from GitHub. No credentials were printed."); }
}
export function artifactEvidence(runId, artifact, { run = execFileSync } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "hotelsuite-staging-proof-"));
  try {
    if (!Number.isSafeInteger(artifact.id) || artifact.id < 1 || artifact.workflow_run?.id !== runId) throw new Error("Invalid staging artifact identity.");
    // Fetch the immutable artifact ID, never a replaceable run/name lookup.
    const archive = run("gh", ["api", `repos/${FUNCTIONS_REPOSITORY}/actions/artifacts/${artifact.id}/zip`],
      { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 10 * 1024 * 1024 });
    if (artifact.digest && artifact.digest !== `sha256:${createHash("sha256").update(archive).digest("hex")}`) throw new Error("Staging artifact digest mismatch.");
    const path = join(directory, "evidence.zip");
    writeFileSync(path, archive, { mode: 0o600 });
    // Read just this bounded entry without extracting archive paths or symlinks.
    return JSON.parse(run("unzip", ["-p", path, "staging-release-evidence.json"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 100000 }));
  } catch { throw new Error("The selected staging artifact is unavailable or invalid. Run a fresh protected staging release."); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}

export async function inspectControlledRelease({ sha, pinned, api = github, readEvidence = artifactEvidence }) {
  requireReleaseSha(sha);
  const productionCommit = await api(`git/commits/${sha}`);
  const runs = pinned ? [await api(`actions/runs/${pinned.runId}`)]
    : (await api("actions/workflows/deploy-staging.yml/runs?branch=main&event=workflow_dispatch&status=success&per_page=20")).workflow_runs;
  for (const run of runs || []) {
    const artifacts = (await api(`actions/runs/${run.id}/artifacts?per_page=100`)).artifacts || [];
    if (artifacts.length >= 100) throw new Error("Staging artifact inventory exceeds the release evidence bound.");
    for (const artifact of artifacts.filter(item => !item.expired && /^staging-release-[a-f0-9]{40}$/.test(item.name)
      && (!pinned || item.id === pinned.artifactId))) {
      const stagingSha = artifact.name.slice("staging-release-".length);
      const stagingCommit = await api(`git/commits/${stagingSha}`);
      if (!pinned && stagingCommit.tree?.sha !== productionCommit.tree?.sha) continue;
      const jobs = (await api(`actions/runs/${run.id}/jobs?per_page=100`)).jobs;
      const evidence = await readEvidence(run.id, artifact);
      const result = requireStagingReleaseEvidence({ run, jobs, artifact, evidence, productionCommit, stagingCommit });
      if (pinned && (pinned.stagingSha !== result.stagingSha || pinned.tree !== result.tree)) throw new Error("The approved staging evidence changed. Start a new production workflow.");
      return result;
    }
  }
  throw new Error("No matching successful staging release was found in the latest 20 successful runs. Deploy this application's exact tree through Deploy HotelSuite staging, complete acceptance, then start a new production workflow.");
}

async function main() {
  if (process.env.GITHUB_ACTIONS !== "true" || process.env.GITHUB_REPOSITORY !== FUNCTIONS_REPOSITORY
    || process.env.GITHUB_REF !== "refs/heads/main") throw new Error("Release evidence checks run only in the HotelSuite main workflow.");
  const mode = requireReleaseMode(process.env.RELEASE_MODE), sha = requireReleaseSha(process.env.RELEASE_SHA);
  if (process.env.EXPECTED_RELEASE_MODE && mode !== process.env.EXPECTED_RELEASE_MODE) throw new Error("RELEASE_MODE changed after release selection. Start a new workflow run.");
  if ((await github("git/ref/heads/main")).object.sha !== sha) throw new Error("Main changed after release selection. Wait for the current main verification.");
  if (mode === "development") return;
  if (String(process.env.GITHUB_RUN_ATTEMPT) !== "1") throw new Error("Controlled retries need a new workflow_dispatch run, not a rerun.");
  const pinned = process.env.STAGING_RUN_ID ? { runId: Number(process.env.STAGING_RUN_ID), artifactId: Number(process.env.STAGING_ARTIFACT_ID),
    stagingSha: process.env.STAGING_ACCEPTED_SHA, tree: process.env.RELEASE_TREE } : null;
  const result = await inspectControlledRelease({ sha, pinned });
  if (process.argv.includes("--require-approval")) {
    const reviewer = requireProductionReview(await github(`actions/runs/${process.env.GITHUB_RUN_ID}/approvals`), { runAttempt: process.env.GITHUB_RUN_ATTEMPT });
    console.log(`Native production review verified for this run by ${reviewer}.`);
  }
  if (process.env.GITHUB_OUTPUT) for (const [key, value] of Object.entries({ staging_sha: result.stagingSha, tree: result.tree, staging_run_id: result.runId, artifact_id: result.artifactId })) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `Controlled candidate: \`${sha}\`; exact application tree: \`${result.tree}\`. Staging: \`${result.stagingSha}\`, [verified release](https://github.com/${FUNCTIONS_REPOSITORY}/actions/runs/${result.runId}).\n\nApprove the production Environment only after manual staging acceptance, including monitoring lifecycle, missing-evaluator detection and normal-user isolation. Approval attests acceptance of this pinned application tree.\n`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
