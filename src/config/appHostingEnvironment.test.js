import { describe, expect, it } from "vitest";
import { prepareAppHostingEnvironment } from "../../scripts/apphosting-environment.mjs";
const config = { apiKey: "fictional-key", authDomain: "demo-hotel.firebaseapp.com", projectId: "demo-hotel",
  storageBucket: "demo-hotel.firebasestorage.app", messagingSenderId: "123", appId: "1:123:web:fictional" };
const env = { EXPECTED_FIREBASE_PROJECT_ID: "demo-hotel", FIREBASE_WEBAPP_CONFIG: JSON.stringify(config) };

describe("explicit Firebase App Hosting environment", () => {
  it("maps the linked web app without inventing deployment or MFA policies", () => {
    expect(prepareAppHostingEnvironment(env)).toMatchObject({ VITE_FIREBASE_API_KEY: config.apiKey,
      VITE_FIREBASE_PROJECT_ID: config.projectId, VITE_FIREBASE_APP_ID: config.appId });
    expect(prepareAppHostingEnvironment(env).VITE_AUTH_REQUIRE_MFA).toBeUndefined();
    expect(prepareAppHostingEnvironment(env).VITE_DEPLOYMENT_ENV).toBeUndefined();
  });
  it("fails without a complete, valid, explicitly matched web app", () => {
    for (const values of [{}, { ...env, FIREBASE_WEBAPP_CONFIG: "invalid" }, { ...env, FIREBASE_WEBAPP_CONFIG: "[]" },
      { ...env, EXPECTED_FIREBASE_PROJECT_ID: "other-project" }, { ...env, EXPECTED_FIREBASE_PROJECT_ID: "" },
      { ...env, FIREBASE_WEBAPP_CONFIG: JSON.stringify({ ...config, storageBucket: "" }) }]) {
      expect(() => prepareAppHostingEnvironment(values)).toThrow();
    }
  });
  it("rejects conflicting Vite overrides and leaves server secrets outside the mapped client fields", () => {
    expect(() => prepareAppHostingEnvironment({ ...env, VITE_FIREBASE_PROJECT_ID: "other-project" })).toThrow(/conflicts/);
    const prepared = prepareAppHostingEnvironment({ ...env, MEILI_API_KEY: "server-only-value" });
    expect(Object.keys(prepared).filter((key) => key.startsWith("VITE_"))).not.toContain("VITE_MEILI_API_KEY");
  });
});
