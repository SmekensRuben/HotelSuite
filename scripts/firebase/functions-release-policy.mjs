export const FUNCTIONS_PROJECT = "hotel-toolkit";
export const FUNCTIONS_REPOSITORY = "SmekensRuben/HotelSuite";
export const FUNCTIONS_PROVIDER = "projects/358734544002/locations/global/workloadIdentityPools/hotelsuite-github/providers/main-deploy";
export const FUNCTIONS_DEPLOY_ACCOUNT = "github-functions-deploy@hotel-toolkit.iam.gserviceaccount.com";

export function requireFunctionsConfiguration(env) {
  if (env.FIREBASE_PROJECT_ID !== FUNCTIONS_PROJECT) throw new Error("Functions must target hotel-toolkit explicitly.");
  if (env.FIREBASE_WORKLOAD_IDENTITY_PROVIDER !== FUNCTIONS_PROVIDER) throw new Error("Configure the reviewed HotelSuite Workload Identity provider.");
  if (env.FIREBASE_DEPLOY_SERVICE_ACCOUNT !== FUNCTIONS_DEPLOY_ACCOUNT) throw new Error("Configure the HotelSuite Functions deployment service account.");
  const value = env.FUNCTIONS_APP_BASE_URL;
  let url;
  try { url = new URL(value); } catch { throw new Error("FUNCTIONS_APP_BASE_URL must be an HTTPS origin."); }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash
    || !/^[a-z0-9.-]+$/i.test(url.hostname) || !url.hostname.includes(".") || /[\r\n]/.test(value)) {
    throw new Error("FUNCTIONS_APP_BASE_URL must be an HTTPS origin without credentials, paths or query parameters.");
  }
  return url.origin;
}

export function requireFunctionsRelease({ eventName, event, repository, ref, checkedOutSha, mainSha, verifiedRuns }) {
  if (repository !== FUNCTIONS_REPOSITORY || ref !== "refs/heads/main") throw new Error("Only HotelSuite main can deploy Functions.");
  if (!/^[a-f0-9]{40}$/.test(checkedOutSha)) throw new Error("A complete checked-out commit SHA is required.");
  if (eventName === "workflow_run") {
    const run = event.workflow_run;
    if (run?.name !== "Verify HotelSuite" || run.event !== "push" || run.head_branch !== "main"
      || run.head_repository?.id !== 1161047380 || run.head_repository?.full_name !== FUNCTIONS_REPOSITORY
      || run.conclusion !== "success" || run.status !== "completed" || run.head_sha !== checkedOutSha) {
      throw new Error("Deployment requires successful push verification of this exact main commit.");
    }
  } else if (eventName !== "workflow_dispatch") {
    throw new Error("This event cannot deploy Functions.");
  }
  if (checkedOutSha !== mainSha) return false;
  if (!verifiedRuns.some(run => run.head_sha === checkedOutSha && run.head_branch === "main" && run.event === "push"
    && run.status === "completed" && run.conclusion === "success" && run.head_repository?.id === 1161047380)) {
    throw new Error("The exact main commit has no successful Verify HotelSuite push run.");
  }
  return true;
}
