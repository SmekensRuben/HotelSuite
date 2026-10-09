import { readFileSync, appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { FUNCTIONS_REPOSITORY, requireFunctionsRelease, requireFunctionsConfiguration } from "./functions-release-policy.mjs";

if (process.env.GITHUB_ACTIONS !== "true") throw new Error("This release check runs only in GitHub Actions.");
const checkedOutSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
const api = path => JSON.parse(execFileSync("gh", ["api", `repos/${FUNCTIONS_REPOSITORY}/${path}`], { encoding: "utf8" }));
const mainSha = api("git/ref/heads/main").object.sha;
const verifiedRuns = api(`actions/workflows/verify.yml/runs?branch=main&event=push&head_sha=${checkedOutSha}&status=success&per_page=10`).workflow_runs;
let deploy = requireFunctionsRelease({ eventName: process.env.GITHUB_EVENT_NAME, event, repository: process.env.GITHUB_REPOSITORY,
  ref: process.env.GITHUB_REF, checkedOutSha, mainSha, verifiedRuns });
let message = `Skipping outdated commit ${checkedOutSha}; current main is ${mainSha}.`;
if (deploy && process.env.FIREBASE_FUNCTIONS_DEPLOY_ENABLED !== "true") {
  deploy = false;
  message = "Functions deployment setup is pending. Run the reviewed Cloud Shell setup, provision runtime secrets, then set FIREBASE_FUNCTIONS_DEPLOY_ENABLED=true. No Functions were deployed.";
} else if (deploy) {
  requireFunctionsConfiguration(process.env);
  message = `Verified current main commit ${checkedOutSha} for Functions deployment to hotel-toolkit.`;
}
console.log(message);
appendFileSync(process.env.GITHUB_OUTPUT, `deploy=${deploy}\n`);
appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n`);
