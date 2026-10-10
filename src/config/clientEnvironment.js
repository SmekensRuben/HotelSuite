const REQUIRED_FIREBASE_VARIABLES = [
  "VITE_FIREBASE_API_KEY",
  "VITE_FIREBASE_AUTH_DOMAIN",
  "VITE_FIREBASE_PROJECT_ID",
  "VITE_FIREBASE_STORAGE_BUCKET",
  "VITE_FIREBASE_MESSAGING_SENDER_ID",
  "VITE_FIREBASE_APP_ID",
];

/** @param {Record<string, string | undefined>} environment */
export function readClientEnvironment(environment) {
  const deploymentEnvironment = String(environment.VITE_DEPLOYMENT_ENV || "").trim();
  if (!['test', 'production'].includes(deploymentEnvironment)) {
    throw new Error('VITE_DEPLOYMENT_ENV must be explicitly set to "test" or "production".');
  }

  const missing = REQUIRED_FIREBASE_VARIABLES.filter(
    (name) => !String(environment[name] || "").trim(),
  );
  if (missing.length) {
    throw new Error(`Missing required client environment variables: ${missing.join(", ")}`);
  }

  const requireMfaValue = String(environment.VITE_AUTH_REQUIRE_MFA || "").trim().toLowerCase();
  if (!['true', 'false'].includes(requireMfaValue)) {
    throw new Error('VITE_AUTH_REQUIRE_MFA must be explicitly set to "true" or "false".');
  }

  return {
    deploymentEnvironment,
    authPolicy: {
      requireMfa: requireMfaValue === "true",
    },
    firebaseConfig: {
      apiKey: String(environment.VITE_FIREBASE_API_KEY).trim(),
      authDomain: String(environment.VITE_FIREBASE_AUTH_DOMAIN).trim(),
      projectId: String(environment.VITE_FIREBASE_PROJECT_ID).trim(),
      storageBucket: String(environment.VITE_FIREBASE_STORAGE_BUCKET).trim(),
      messagingSenderId: String(environment.VITE_FIREBASE_MESSAGING_SENDER_ID).trim(),
      appId: String(environment.VITE_FIREBASE_APP_ID).trim(),
    },
  };
}

export { REQUIRED_FIREBASE_VARIABLES };
