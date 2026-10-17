const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { runtimePolicy, PRODUCTION_FIREBASE_PROJECT_ID, STAGING_FIREBASE_PROJECT_ID } = require("./environmentPolicy");
const production = { GCLOUD_PROJECT: PRODUCTION_FIREBASE_PROJECT_ID, DEPLOYMENT_ENV: "production" };
const staging = { GCLOUD_PROJECT: STAGING_FIREBASE_PROJECT_ID, DEPLOYMENT_ENV: "staging" };

test("external actions require a consistent production project identity", () => {
  assert.equal(runtimePolicy(production).externalActions, true);
  assert.equal(runtimePolicy({ GCLOUD_PROJECT: PRODUCTION_FIREBASE_PROJECT_ID }).externalActions, true);
  assert.equal(runtimePolicy({ FIREBASE_CONFIG: JSON.stringify({ projectId: PRODUCTION_FIREBASE_PROJECT_ID }) }).externalActions, true);
  for (const env of [{}, { DEPLOYMENT_ENV: "production" }, { ...production, GCLOUD_PROJECT: "other-project" },
    { ...production, FIREBASE_CONFIG: "broken-json" }, { ...production, FIREBASE_CONFIG: JSON.stringify({ projectId: STAGING_FIREBASE_PROJECT_ID }) },
    { ...production, GOOGLE_CLOUD_PROJECT: STAGING_FIREBASE_PROJECT_ID }, { ...production, GCP_PROJECT: STAGING_FIREBASE_PROJECT_ID },
    { ...production, DEPLOYMENT_ENV: "staging" }, { ...production, DEPLOYMENT_ENV: "test" },
    { ...staging, DEPLOYMENT_ENV: "production" }, { GCLOUD_PROJECT: STAGING_FIREBASE_PROJECT_ID }]) {
    assert.equal(runtimePolicy(env).externalActions, false, JSON.stringify(env));
    assert.equal(runtimePolicy(env).simulate, false, JSON.stringify(env));
  }
});

test("staging simulation requires the fixed project and explicit staging mode", () => {
  assert.deepEqual(runtimePolicy(staging), { environment: "staging", projectId: STAGING_FIREBASE_PROJECT_ID, externalActions: false, simulate: true });
  assert.equal(runtimePolicy({ ...staging, STAGING_FIREBASE_PROJECT_ID: "other-project", GCLOUD_PROJECT: "other-project" }).simulate, false);
  for (const key of ["FUNCTIONS_EMULATOR", "FIRESTORE_EMULATOR_HOST", "FIREBASE_AUTH_EMULATOR_HOST", "STORAGE_EMULATOR_HOST", "FIREBASE_STORAGE_EMULATOR_HOST"]) {
    assert.equal(runtimePolicy({ ...production, [key]: key === "FUNCTIONS_EMULATOR" ? "true" : "localhost:9000" }).externalActions, false);
  }
});

function inspectDeployment(projectId, deploymentEnvironment) {
  const script = `
    const endpoints = require('./index');
    (async () => {
      const secrets = Object.fromEntries(Object.entries(endpoints).filter(([, value]) => value?.__endpoint?.secretEnvironmentVariables?.length)
        .map(([name, value]) => [name, value.__endpoint.secretEnvironmentVariables.map(item => item.key)]));
      const scheduled = Object.entries(endpoints).filter(([, value]) => value?.__endpoint?.scheduleTrigger);
      // The internal monitoring evaluator is intentionally allowed in staging;
      // its database behavior is verified by the emulator monitoring suite.
      const providerWorkers = scheduled.filter(([name]) => name !== 'checkPlatformImportHealth');
      const results = process.env.DEPLOYMENT_ENV === 'production' ? [] : await Promise.all(providerWorkers.map(async ([name, handler]) => ({name, result: await handler.run({})})));
      const declaredSecrets = require('firebase-functions/params').declaredParams.filter(param => param.constructor.name === 'SecretParam').map(param => param.name);
      console.log(JSON.stringify({ secrets, declaredSecrets, scheduled: scheduled.map(([name]) => name), results }));
    })().catch(error => { console.error(error); process.exitCode = 1; });`;
  const env = { ...process.env, GCLOUD_PROJECT: projectId, DEPLOYMENT_ENV: deploymentEnvironment,
    FIREBASE_CONFIG: JSON.stringify({ projectId, storageBucket: `${projectId}.appspot.com` }) };
  for (const key of ["GOOGLE_CLOUD_PROJECT", "GCP_PROJECT", "FUNCTIONS_EMULATOR", "FIRESTORE_EMULATOR_HOST", "FIREBASE_AUTH_EMULATOR_HOST", "STORAGE_EMULATOR_HOST", "FIREBASE_STORAGE_EMULATOR_HOST"]) delete env[key];
  const result = spawnSync(process.execPath, ["-e", script], { cwd: require("node:path").join(__dirname, ".."), env, encoding: "utf8", timeout: 30000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return JSON.parse(result.stdout.trim().split("\n").at(-1));
}

test("staging binds no provider secrets and scheduled provider workers skip before accessing Firebase", () => {
  const deployment = inspectDeployment(STAGING_FIREBASE_PROJECT_ID, "staging");
  assert.deepEqual(deployment.secrets, {});
  assert.deepEqual(deployment.declaredSecrets, []);
  assert.ok(deployment.scheduled.length >= 12);
  assert.ok(deployment.scheduled.includes("checkPlatformImportHealth"));
  assert.equal(deployment.results.length, deployment.scheduled.length - 1);
  for (const { name, result } of deployment.results) assert.deepEqual(result, { skipped: true, reason: "scheduled-workers-disabled", environment: "staging" }, name);
});

test("production discovery retains the existing provider bindings", () => {
  const deployment = inspectDeployment(PRODUCTION_FIREBASE_PROJECT_ID, "production");
  assert.deepEqual(deployment.secrets.processMailQueue, ["RESEND_API_KEY", "RESEND_FROM"]);
  assert.deepEqual(deployment.secrets.searchHotelProducts, ["MEILI_API_KEY", "MEILI_HOST", "MEILI_INDEX"]);
  assert.deepEqual(deployment.secrets.processSupplierProductAiImport, ["OPENAI_API_KEY"]);
  assert.ok(deployment.declaredSecrets.includes("RESEND_API_KEY"));
  assert.ok(deployment.scheduled.includes("sendScheduledOccupancyMail"));
});
