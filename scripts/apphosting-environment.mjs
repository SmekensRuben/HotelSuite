const CONFIG_FIELDS = {
  apiKey: "VITE_FIREBASE_API_KEY", authDomain: "VITE_FIREBASE_AUTH_DOMAIN",
  projectId: "VITE_FIREBASE_PROJECT_ID", storageBucket: "VITE_FIREBASE_STORAGE_BUCKET",
  messagingSenderId: "VITE_FIREBASE_MESSAGING_SENDER_ID", appId: "VITE_FIREBASE_APP_ID",
};

export function prepareAppHostingEnvironment(environment) {
  if (!environment.FIREBASE_WEBAPP_CONFIG) {
    throw new Error("App Hosting must supply FIREBASE_WEBAPP_CONFIG. Link the intended Firebase web app to this backend.");
  }
  let config;
  try { config = JSON.parse(environment.FIREBASE_WEBAPP_CONFIG); }
  catch { throw new Error("App Hosting supplied an invalid FIREBASE_WEBAPP_CONFIG."); }
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("App Hosting supplied an invalid FIREBASE_WEBAPP_CONFIG.");
  }
  if (!environment.EXPECTED_FIREBASE_PROJECT_ID || config.projectId !== environment.EXPECTED_FIREBASE_PROJECT_ID) {
    throw new Error("App Hosting web app does not match EXPECTED_FIREBASE_PROJECT_ID.");
  }
  const prepared = { ...environment };
  for (const [field, variable] of Object.entries(CONFIG_FIELDS)) {
    if (typeof config[field] !== "string" || !config[field].trim()) {
      throw new Error("App Hosting web-app configuration is missing " + field + ".");
    }
    if (environment[variable] && environment[variable] !== config[field]) {
      throw new Error("App Hosting override conflicts with the linked web app: " + variable + ".");
    }
    prepared[variable] = config[field];
  }
  // The regular validator still requires explicit deployment/MFA policies and
  // rejects test labels on live Firebase data. Only this hosting entry point
  // maps the provider's web-app config; Vercel/local builds keep their contract.
  return prepared;
}
