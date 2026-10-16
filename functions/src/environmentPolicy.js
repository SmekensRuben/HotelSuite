const { HttpsError } = require("firebase-functions/v2/https");

const PRODUCTION_FIREBASE_PROJECT_ID = "hotel-toolkit";
const STAGING_FIREBASE_PROJECT_ID = "hotel-toolkit-staging";

// Project identity comes from the server runtime, never from a callable payload.
// Conflicting identities and malformed configuration fail closed, including when
// a copied production secret happens to be present in another project.
function runtimePolicy(env = process.env) {
  let config = {};
  try { config = env.FIREBASE_CONFIG ? JSON.parse(env.FIREBASE_CONFIG) : {}; }
  catch { return { environment: "blocked", projectId: null, externalActions: false, simulate: false }; }
  const identities = [env.GCLOUD_PROJECT, env.GOOGLE_CLOUD_PROJECT, env.GCP_PROJECT, config?.projectId]
    .filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim());
  const projectId = identities.length && identities.every((value) => value === identities[0]) ? identities[0] : null;
  const declared = String(env.DEPLOYMENT_ENV || "").trim();
  const production = projectId === PRODUCTION_FIREBASE_PROJECT_ID && (!declared || declared === "production");
  const staging = projectId === STAGING_FIREBASE_PROJECT_ID && declared === "staging";
  // Emulators must never contact paid or customer-facing providers, even if a
  // developer accidentally starts them with a production project configuration.
  const emulator = env.FUNCTIONS_EMULATOR === "true" || Boolean(env.FIRESTORE_EMULATOR_HOST || env.FIREBASE_AUTH_EMULATOR_HOST || env.STORAGE_EMULATOR_HOST || env.FIREBASE_STORAGE_EMULATOR_HOST);
  return { environment: emulator ? "emulator" : production ? "production" : staging ? "staging" : "blocked", projectId,
    externalActions: production && !emulator, simulate: staging && !emulator };
}

const externalActionsAllowed = () => runtimePolicy().externalActions;
const isStagingEnvironment = () => runtimePolicy().environment === "staging";
function requireExternalActions(action = "External integrations") {
  if (!externalActionsAllowed()) throw new HttpsError("failed-precondition", `${action} are disabled in this environment.`);
}
function secretBindings(secrets) { return externalActionsAllowed() ? secrets : []; }
function guardScheduledHandler(handler) {
  return async (...args) => {
    if (!externalActionsAllowed()) return { skipped: true, reason: "scheduled-workers-disabled", environment: runtimePolicy().environment };
    return handler(...args);
  };
}

module.exports = { PRODUCTION_FIREBASE_PROJECT_ID, STAGING_FIREBASE_PROJECT_ID, runtimePolicy,
  externalActionsAllowed, isStagingEnvironment, requireExternalActions, secretBindings, guardScheduledHandler };
