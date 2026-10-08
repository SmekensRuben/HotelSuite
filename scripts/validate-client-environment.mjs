import { loadEnv } from "vite";

const environment = {
  ...loadEnv(process.env.NODE_ENV || "production", process.cwd(), ""),
  ...process.env,
};

const required = [
  "VITE_DEPLOYMENT_ENV",
  "VITE_AUTH_REQUIRE_MFA",
  "VITE_FIREBASE_API_KEY",
  "VITE_FIREBASE_AUTH_DOMAIN",
  "VITE_FIREBASE_PROJECT_ID",
  "VITE_FIREBASE_STORAGE_BUCKET",
  "VITE_FIREBASE_MESSAGING_SENDER_ID",
  "VITE_FIREBASE_APP_ID",
  "EXPECTED_FIREBASE_PROJECT_ID",
];
const missing = required.filter((name) => !String(environment[name] || "").trim());
if (missing.length) {
  throw new Error(`Build stopped: missing ${missing.join(", ")}. No Firebase environment fallback is allowed.`);
}

const deploymentEnvironment = environment.VITE_DEPLOYMENT_ENV.trim();
const projectId = environment.VITE_FIREBASE_PROJECT_ID.trim();
const expectedProjectId = environment.EXPECTED_FIREBASE_PROJECT_ID.trim();
if (!['test', 'production'].includes(deploymentEnvironment)) {
  throw new Error('Build stopped: VITE_DEPLOYMENT_ENV must be "test" or "production".');
}
if (!['true', 'false'].includes(environment.VITE_AUTH_REQUIRE_MFA.trim().toLowerCase())) {
  throw new Error('Build stopped: VITE_AUTH_REQUIRE_MFA must be "true" or "false".');
}
if (projectId !== expectedProjectId) {
  throw new Error(`Build stopped: Firebase project ${projectId} does not match EXPECTED_FIREBASE_PROJECT_ID.`);
}
// Vercel's hosting target and the Firebase data environment are independent.
// Previews may intentionally share the production backend, provided the build
// declares production explicitly instead of labeling live data as test data.
if ((environment.GITHUB_REF_NAME === "main" || environment.VERCEL_ENV === "production")
  && process.env.NODE_ENV !== "test" && deploymentEnvironment !== "production") {
  throw new Error("Build stopped: a production release build must use VITE_DEPLOYMENT_ENV=production.");
}
const productionProjectId = String(environment.PRODUCTION_FIREBASE_PROJECT_ID || "").trim();
if (deploymentEnvironment === "test"
  && (projectId === "hotel-toolkit" || (productionProjectId && projectId === productionProjectId))) {
  throw new Error("Build stopped: a test build points at the production Firebase project.");
}

console.log(`Validated ${deploymentEnvironment} client build for Firebase project ${projectId}.`);
