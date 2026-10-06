const REQUIRED_FIREBASE_VARIABLES = [
  "VITE_FIREBASE_API_KEY",
  "VITE_FIREBASE_AUTH_DOMAIN",
  "VITE_FIREBASE_PROJECT_ID",
  "VITE_FIREBASE_STORAGE_BUCKET",
  "VITE_FIREBASE_MESSAGING_SENDER_ID",
  "VITE_FIREBASE_APP_ID",
];

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

  return {
    deploymentEnvironment,
    firebaseConfig: {
      apiKey: environment.VITE_FIREBASE_API_KEY.trim(),
      authDomain: environment.VITE_FIREBASE_AUTH_DOMAIN.trim(),
      projectId: environment.VITE_FIREBASE_PROJECT_ID.trim(),
      storageBucket: environment.VITE_FIREBASE_STORAGE_BUCKET.trim(),
      messagingSenderId: environment.VITE_FIREBASE_MESSAGING_SENDER_ID.trim(),
      appId: environment.VITE_FIREBASE_APP_ID.trim(),
    },
  };
}

export { REQUIRED_FIREBASE_VARIABLES };
