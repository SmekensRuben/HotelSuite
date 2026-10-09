// Public release metadata only. No GitHub credential is needed for this repository.
const sha = process.env.SAAS_RELEASE_SHA;
if (!/^[a-f0-9]{40}$/.test(sha || "")) throw new Error("An exact SAAS_RELEASE_SHA is required.");
const base = "https://api.github.com/repos/SmekensRuben/HotelSuite/";
async function read(path) {
  const response = await fetch(`${base}${path}`, { headers: { Accept: "application/vnd.github+json", "User-Agent": "HotelSuite-reviewed-rollout" } });
  if (!response.ok) throw new Error(`Release metadata is unavailable (${response.status}). No rollout was performed.`);
  return response.json();
}
const main = await read("git/ref/heads/main");
if (main.object.sha !== sha) throw new Error("The reviewed release is no longer current main. Review the new release first.");
const checks = await read(`commits/${sha}/check-runs?per_page=100`);
for (const [name, app] of [["verify", "github-actions"], ["App Hosting - Rollout (hotel-toolkit/europe-west4/hotel-toolkit)", "firebase-app-hosting"]]) {
  const check = checks.check_runs.find((c) => c.name === name && c.app.slug === app);
  if (check?.conclusion !== "success") throw new Error(`${name} has not succeeded for this release.`);
}
const runs = await read(`actions/workflows/deploy-functions.yml/runs?branch=main&head_sha=${sha}&per_page=10`);
const run = runs.workflow_runs.find((r) => r.head_sha === sha && r.conclusion === "success");
if (!run) throw new Error("Wait for the successful automatic Functions deployment.");
const jobs = await read(`actions/runs/${run.id}/jobs`);
const steps = jobs.jobs.find((j) => j.name === "deploy" && j.conclusion === "success")?.steps || [];
for (const name of ["Deploy Functions to hotel-toolkit", "Record deployed Functions inventory"]) {
  if (!steps.some((s) => s.name === name && s.conclusion === "success")) throw new Error("A skipped release does not qualify as a deployment.");
}
console.log(`Verified current main ${sha}, CI, App Hosting and actual Functions deployment.`);
