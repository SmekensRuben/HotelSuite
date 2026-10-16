// Existing transport unit tests use explicit fake clients. Select the production
// policy contract in their isolated Node test process; this grants no credentials.
function activateProductionTestEnvironment() {
  process.env.DEPLOYMENT_ENV = "production";
  process.env.GCLOUD_PROJECT = "hotel-toolkit";
  process.env.FIREBASE_CONFIG = JSON.stringify({ projectId: "hotel-toolkit", storageBucket: "hotel-toolkit.appspot.com" });
  for (const key of ["GOOGLE_CLOUD_PROJECT", "GCP_PROJECT", "FUNCTIONS_EMULATOR", "FIRESTORE_EMULATOR_HOST", "FIREBASE_AUTH_EMULATOR_HOST", "STORAGE_EMULATOR_HOST", "FIREBASE_STORAGE_EMULATOR_HOST"]) delete process.env[key];
}
module.exports = { activateProductionTestEnvironment };
