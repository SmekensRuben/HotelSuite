// Release policy is independent of Firebase's production/staging environment.
export const PRODUCTION_REVIEW_ENVIRONMENT = "production";
const SHA = /^[a-f0-9]{40}$/;

export function requireReleaseMode(value) {
  if (!["development", "controlled"].includes(value)) {
    throw new Error("Set repository variable RELEASE_MODE explicitly to development or controlled. Missing or invalid values never enable development releases.");
  }
  return value;
}

export function requireReleaseSha(value) {
  if (!SHA.test(value || "")) throw new Error("A complete release commit SHA is required.");
  return value;
}

export function requireStagingReleaseEvidence({ run, jobs, artifact, evidence, productionCommit, stagingCommit }) {
  const sha = requireReleaseSha(evidence?.sha);
  if (run?.event !== "workflow_dispatch" || run.head_branch !== "main" || run.status !== "completed" || run.conclusion !== "success"
    || run.repository?.id !== 1161047380 || run.head_repository?.id !== 1161047380
    || run.path !== ".github/workflows/deploy-staging.yml") throw new Error("Controlled releases require a successful trusted staging workflow from HotelSuite main.");
  if (!jobs?.some(job => job.name === `Deploy verified SHA ${sha}` && job.conclusion === "success"
    && job.steps?.some(step => step.name === "Deploy and activate one coordinated staging release" && step.conclusion === "success"))) {
    throw new Error("A staging artifact without successful deployment and final activation is insufficient.");
  }
  if (artifact?.expired || artifact?.name !== `staging-release-${sha}` || artifact.workflow_run?.id !== run.id
    || evidence.projectId !== "hotel-toolkit-staging" || evidence.backendSha !== sha || evidence.frontendSha !== sha
    || evidence.functionsVerified !== true || evidence.appHostingVerified !== true || evidence.frontendMarkerVerified !== true
    || !Array.isArray(evidence.functions) || !evidence.functions.length
    || !/^projects\/(hotel-toolkit-staging|79412748471)\/locations\/europe-west4\/backends\/hotel-toolkit-staging\/builds\/[A-Za-z0-9_-]+$/.test(evidence.appHostingBuild || "")
    || !/^projects\/(hotel-toolkit-staging|79412748471)\/locations\/europe-west4\/backends\/hotel-toolkit-staging\/rollouts\/[A-Za-z0-9_-]+$/.test(evidence.appHostingRollout || "")) {
    throw new Error("Staging deployment evidence is expired, incomplete, or belongs to another project/version.");
  }
  requireReleaseSha(productionCommit?.sha);
  requireReleaseSha(productionCommit?.tree?.sha);
  if (stagingCommit?.sha !== sha || stagingCommit.tree?.sha !== productionCommit.tree.sha) {
    throw new Error("Stage the exact application tree now on main. A related ancestor or a different merged tree is not accepted.");
  }
  return { stagingSha: sha, tree: productionCommit.tree.sha, runId: run.id, artifactId: artifact.id };
}

export function requireProductionReview(reviews, { runAttempt }) {
  if (String(runAttempt) !== "1") throw new Error("Controlled retries require a new workflow_dispatch run and a new production review; rerun approval history is not attempt-scoped.");
  const relevant = Array.isArray(reviews) ? reviews.filter(review => review.environments?.some(environment => environment.name === PRODUCTION_REVIEW_ENVIRONMENT)) : [];
  if (relevant.length !== 1 || relevant[0].state !== "approved" || !relevant[0].user?.login) {
    throw new Error("Configure required reviewers on the production GitHub Environment and approve this exact run after staging acceptance. Missing, unprotected or unreadable approval evidence blocks release.");
  }
  return relevant[0].user.login;
}
