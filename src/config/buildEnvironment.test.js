import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const validate = (values = {}) => execFileSync(process.execPath, ["scripts/validate-client-environment.mjs"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    NODE_ENV: "test",
    GITHUB_REF_NAME: "main",
    VERCEL_ENV: "",
    VITE_DEPLOYMENT_ENV: "test",
    VITE_AUTH_REQUIRE_MFA: "false",
    VITE_FIREBASE_API_KEY: "fictional-build-key",
    VITE_FIREBASE_AUTH_DOMAIN: "demo-hotel-suite-a00.firebaseapp.com",
    VITE_FIREBASE_PROJECT_ID: "demo-hotel-suite-a00",
    VITE_FIREBASE_STORAGE_BUCKET: "demo-hotel-suite-a00.appspot.com",
    VITE_FIREBASE_MESSAGING_SENDER_ID: "000000000000",
    VITE_FIREBASE_APP_ID: "fictional-build-app",
    EXPECTED_FIREBASE_PROJECT_ID: "demo-hotel-suite-a00",
    PRODUCTION_FIREBASE_PROJECT_ID: "hotel-toolkit",
    ...values,
  },
  stdio: "pipe",
}).toString();

describe("Firebase build environment", () => {
  it("allows the verification workflow to use the non-production fixture on main", () => {
    expect(validate()).toContain("Validated test client build");
  });

  it("continues to reject a fixture that points at a configured production project", () => {
    expect(() => validate({ PRODUCTION_FIREBASE_PROJECT_ID: "demo-hotel-suite-a00" })).toThrow();
  });

  it("requires production configuration for a main release build", () => {
    expect(() => validate({ NODE_ENV: "production", VITE_DEPLOYMENT_ENV: "test" })).toThrow();
  });

  it("allows a Vercel preview to intentionally use the production Firebase project", () => {
    expect(validate({ NODE_ENV: "production", VERCEL_ENV: "preview", GITHUB_REF_NAME: "",
      VITE_DEPLOYMENT_ENV: "production", VITE_FIREBASE_PROJECT_ID: "hotel-toolkit",
      EXPECTED_FIREBASE_PROJECT_ID: "hotel-toolkit" })).toContain("Validated production client build for Firebase project hotel-toolkit.");
  });

  it("allows a Vercel preview to use a separate test Firebase project", () => {
    expect(validate({ VERCEL_ENV: "preview", GITHUB_REF_NAME: "" })).toContain("Validated test client build");
  });

  it("rejects a preview labeling the known production Firebase project as test", () => {
    expect(() => validate({ VERCEL_ENV: "preview", VITE_DEPLOYMENT_ENV: "test",
      VITE_FIREBASE_PROJECT_ID: "hotel-toolkit", EXPECTED_FIREBASE_PROJECT_ID: "hotel-toolkit",
      PRODUCTION_FIREBASE_PROJECT_ID: "" })).toThrow(/a test build points at the production Firebase project/);
  });

  it("requires production configuration for Vercel production deployments", () => {
    expect(() => validate({ NODE_ENV: "production", VERCEL_ENV: "production", GITHUB_REF_NAME: "" })).toThrow(/a production release build/);
  });

  it("retains the explicit project match and required-variable checks for shared previews", () => {
    const preview = { VERCEL_ENV: "preview", VITE_DEPLOYMENT_ENV: "production", VITE_FIREBASE_PROJECT_ID: "hotel-toolkit" };
    expect(() => validate(preview)).toThrow(/does not match EXPECTED_FIREBASE_PROJECT_ID/);
    expect(() => validate({ ...preview, EXPECTED_FIREBASE_PROJECT_ID: "hotel-toolkit", VITE_FIREBASE_API_KEY: "" })).toThrow(/missing VITE_FIREBASE_API_KEY/);
  });
});
