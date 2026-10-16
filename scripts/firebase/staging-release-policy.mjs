export const STAGING_PROJECT = "hotel-toolkit-staging";
export const STAGING_REPOSITORY = "SmekensRuben/HotelSuite";
export const STAGING_REPOSITORY_ID = 1161047380;
export const STAGING_WORKFLOW_REF = `${STAGING_REPOSITORY}/.github/workflows/deploy-staging.yml@refs/heads/main`;
export const STAGING_DEPLOY_ACCOUNT = `github-staging-deploy@${STAGING_PROJECT}.iam.gserviceaccount.com`;

export function requireSha(value) {
  if (!/^[a-f0-9]{40}$/.test(value || "")) throw new Error("A complete lowercase 40-character commit SHA is required.");
  return value;
}

export function requireStagingAliases(configuration) {
  const alias = configuration?.projects?.[STAGING_PROJECT];
  if (alias !== undefined && alias !== STAGING_PROJECT) throw new Error("Firebase aliases must not redirect the explicit staging project ID.");
}

export function requireStagingWorkflow(env) {
  if (env.GITHUB_ACTIONS !== "true" || env.GITHUB_EVENT_NAME !== "workflow_dispatch"
    || env.GITHUB_REPOSITORY !== STAGING_REPOSITORY || env.GITHUB_REF !== "refs/heads/main"
    || env.GITHUB_WORKFLOW_REF !== STAGING_WORKFLOW_REF) {
    throw new Error("Staging releases must use the trusted manual workflow on HotelSuite main.");
  }
}

export function requireStagingConfiguration(env) {
  if (env.FIREBASE_PROJECT_ID !== STAGING_PROJECT || env.GCLOUD_PROJECT !== STAGING_PROJECT
    || env.DEPLOYMENT_ENV !== "staging" || env.RELEASE_TARGET !== "staging") {
    throw new Error("Staging requires explicit, consistent hotel-toolkit-staging project and environment settings.");
  }
  for (const key of ["GOOGLE_CLOUD_PROJECT", "GCP_PROJECT", "CLOUDSDK_CORE_PROJECT"]) {
    if (env[key] && env[key] !== STAGING_PROJECT) throw new Error("An ambient cloud project conflicts with staging.");
  }
  for (const key of ["FIRESTORE_EMULATOR_HOST", "FIREBASE_AUTH_EMULATOR_HOST", "FIREBASE_STORAGE_EMULATOR_HOST", "STORAGE_EMULATOR_HOST"]) {
    if (env[key]) throw new Error("A remote staging release cannot use emulator endpoints.");
  }
  if (env.FIREBASE_CONFIG) {
    let config;
    try { config = JSON.parse(env.FIREBASE_CONFIG); } catch { throw new Error("Ambient Firebase configuration must be explicit JSON for staging."); }
    if (config.projectId !== STAGING_PROJECT || (config.storageBucket && config.storageBucket !== `${STAGING_PROJECT}.firebasestorage.app`)) {
      throw new Error("Ambient Firebase configuration conflicts with staging.");
    }
  }
  const number = env.STAGING_PROJECT_NUMBER;
  if (!/^[0-9]{6,20}$/.test(number || "") || number === "358734544002") {
    throw new Error("Configure the distinct staging project number.");
  }
  const provider = `projects/${number}/locations/global/workloadIdentityPools/hotelsuite-staging-github/providers/staging-deploy`;
  if (env.STAGING_WORKLOAD_IDENTITY_PROVIDER !== provider || env.STAGING_DEPLOY_SERVICE_ACCOUNT !== STAGING_DEPLOY_ACCOUNT) {
    throw new Error("Only the dedicated staging Workload Identity provider and service account are accepted.");
  }
  if (env.STAGING_APPHOSTING_BACKEND_ID !== STAGING_PROJECT || env.STAGING_APPHOSTING_REGION !== "europe-west4") {
    throw new Error("Use the reviewed hotel-toolkit-staging App Hosting backend in europe-west4.");
  }
  const origin = `https://${STAGING_PROJECT}--${STAGING_PROJECT}.europe-west4.hosted.app`;
  if (env.STAGING_APP_BASE_URL !== origin) throw new Error("The staging frontend origin must be its dedicated App Hosting origin.");
  return { projectId: STAGING_PROJECT, projectNumber: number, backendId: STAGING_PROJECT, region: "europe-west4", origin,
    backendName: `projects/${STAGING_PROJECT}/locations/europe-west4/backends/${STAGING_PROJECT}` };
}

export function requireSelectedSource({ kind, target, response }) {
  if (kind === "branch") {
    if (!target || target.startsWith("-") || /[\s~^:?*\[\\]/.test(target) || target.includes("..")) {
      throw new Error("Provide one explicit repository branch name.");
    }
    return requireSha(response?.commit?.sha);
  }
  if (kind === "pull-request") {
    if (!/^[1-9][0-9]*$/.test(target) || response?.number !== Number(target) || response.state !== "open"
      || response.base?.repo?.id !== STAGING_REPOSITORY_ID || response.head?.repo?.id !== STAGING_REPOSITORY_ID
      || response.head.repo.full_name !== STAGING_REPOSITORY || response.base.repo.full_name !== STAGING_REPOSITORY) {
      throw new Error("Only an open pull request originating in HotelSuite itself can deploy to staging; fork code is refused.");
    }
    return requireSha(response.head.sha);
  }
  if (kind === "commit") {
    requireSha(target);
    if (!["ahead", "identical"].includes(response?.status) || response.merge_base_commit?.sha !== target) {
      throw new Error("A rollback commit must be an ancestor of the current protected main branch.");
    }
    return target;
  }
  throw new Error("Select a branch, pull-request, or previously merged commit.");
}

export function requireFunctionsSha(inventory, sha) {
  requireSha(sha);
  if (inventory?.status !== "success" || !Array.isArray(inventory.result) || !inventory.result.length) {
    throw new Error("Cannot verify a nonempty staging Functions inventory.");
  }
  for (const endpoint of inventory.result) {
    if (endpoint.project !== STAGING_PROJECT || (endpoint.codebase || "default") !== "default"
      || endpoint.environmentVariables?.RELEASE_SHA !== sha || endpoint.environmentVariables?.DEPLOYMENT_ENV !== "staging"
      || (endpoint.secretEnvironmentVariables || []).length) {
      throw new Error("A deployed Function has the wrong project, release SHA, environment, or a forbidden secret binding.");
    }
  }
  return inventory.result.map(({ id, region }) => `${id}(${region})`).sort();
}

export function requireFrontendMarker(marker, sha) {
  if (marker?.environment !== "staging" || marker.projectId !== STAGING_PROJECT || marker.sha !== requireSha(sha)) {
    throw new Error("The served staging frontend does not match the verified Functions commit.");
  }
}

// First deployment also needs Firebase's explicit retry opt-in. Keep force
// constrained to the same two idempotent storage triggers reviewed in production.
export function planStagingRetryInitialization(endpoints, inventory) {
  if (inventory?.status !== "success" || !Array.isArray(inventory.result)) throw new Error("Cannot inspect staging retry inventory.");
  const planned = [];
  for (const id of ["processImportedFileToFirestore", "processSupplierProductImage"]) {
    const sourceNames = Object.keys(endpoints).filter(name => name === id || name.startsWith(`${id}-`));
    const source = endpoints[id];
    const validTrigger = endpoint => endpoint?.platform === "gcfv2"
      && (endpoint.codebase === undefined || endpoint.codebase === "default")
      && (endpoint.project === undefined || endpoint.project === STAGING_PROJECT)
      && !["httpsTrigger", "callableTrigger", "scheduleTrigger", "taskQueueTrigger", "blockingTrigger"].some(key => endpoint[key] !== undefined)
      && endpoint.eventTrigger?.eventType === "google.cloud.storage.object.v1.finalized"
      && Object.keys(endpoint.eventTrigger.eventFilters || {}).length === 1
      && endpoint.eventTrigger.eventFilters.bucket === `${STAGING_PROJECT}.firebasestorage.app`
      && Object.keys(endpoint.eventTrigger.eventFilterPathPatterns || {}).length === 0;
    if (sourceNames.length !== 1 || sourceNames[0] !== id || !validTrigger(source)
      || source.region?.length !== 1 || source.region[0] !== "us-west1" || source.eventTrigger.retry !== true) {
      throw new Error("The source storage retry selector differs from the reviewed staging policy.");
    }
    const matches = inventory.result.filter(endpoint => endpoint.id === id || endpoint.id?.startsWith(`${id}-`));
    const existing = matches[0];
    if (matches.length > 1 || (existing && (existing.id !== id || existing.project !== STAGING_PROJECT || existing.region !== "us-west1"
      || !validTrigger(existing) || typeof existing.eventTrigger.retry !== "boolean"))) {
      throw new Error("An existing storage retry selector differs from the reviewed staging policy.");
    }
    if (existing?.eventTrigger.retry !== true) planned.push(`functions:default:${id}`);
  }
  return planned;
}

export function requireAppHostingEvidence({ backend, traffic, rollout, build, archiveUri, config }) {
  const names = [config.backendName, config.backendName.replace(`projects/${STAGING_PROJECT}/`, `projects/${config.projectNumber}/`)];
  if (!names.includes(backend?.name) || backend.environment !== "staging" || backend.codebase?.repository
    || (backend.overrideEnv || []).length || !backend.appId?.startsWith(`1:${config.projectNumber}:web:`)
    || backend.uri?.replace(/^https:\/\//, "").replace(/\/$/, "") !== new URL(config.origin).hostname) {
    throw new Error("The staging backend must use its dedicated origin, linked staging web app, staging environment and local source without environment overrides.");
  }
  if (traffic?.rolloutPolicy?.disabled !== true) throw new Error("Automatic staging App Hosting rollouts must be disabled.");
  if (!archiveUri) return;
  if (!new RegExp(`^gs://firebaseapphosting-sources-${config.projectNumber}-${config.region}(?:-[a-z0-9]+)?/[^/]+\\.zip$`).test(archiveUri)
    || !names.some(name => build?.name?.startsWith(`${name}/builds/`)) || build.state !== "READY"
    || build.source?.archive?.userStorageUri !== archiveUri || rollout?.build !== build.name
    || rollout.state !== "SUCCEEDED") {
    throw new Error("The completed App Hosting rollout must reference this release's uploaded staging source archive.");
  }
  const splits = traffic.current?.splits;
  if (!Array.isArray(splits) || splits.length !== 1 || splits[0].build !== build.name || Number(splits[0].percent) !== 100) {
    throw new Error("All current App Hosting traffic must serve the verified release build.");
  }
}
