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
if (environment.VERCEL_ENV === "preview" && deploymentEnvironment !== "test") {
  throw new Error("Build stopped: a Vercel preview must use VITE_DEPLOYMENT_ENV=test.");
}
if (environment.VERCEL_ENV === "preview" && projectId === "hotel-toolkit") {
  throw new Error("Build stopped: a Vercel preview points at the known production Firebase project hotel-toolkit.");
}
if (environment.GITHUB_REF_NAME === "main" && deploymentEnvironment !== "production") {
  throw new Error("Build stopped: the main-branch production build must use VITE_DEPLOYMENT_ENV=production.");
}
const productionProjectId = String(environment.PRODUCTION_FIREBASE_PROJECT_ID || "").trim();
if (deploymentEnvironment === "test" && productionProjectId && projectId === productionProjectId) {
  throw new Error("Build stopped: a test build points at the production Firebase project.");
}

console.log(`Validated ${deploymentEnvironment} client build for Firebase project ${projectId}.`);
