import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const validate = (values = {}) => execFileSync(process.execPath, ["scripts/validate-client-environment.mjs"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    NODE_ENV: "test",
    GITHUB_REF_NAME: "main",
    VERCEL_ENV: "",
    ...values,
  },
  stdio: "pipe",
}).toString();

describe("main branch build environment", () => {
  it("allows the verification workflow to use the non-production fixture on main", () => {
    expect(validate()).toContain("Validated test client build");
  });

  it("continues to reject a fixture that points at a configured production project", () => {
    expect(() => validate({ PRODUCTION_FIREBASE_PROJECT_ID: "demo-hotel-suite-a00" })).toThrow();
  });

  it("requires production configuration for a main release build", () => {
    expect(() => validate({ NODE_ENV: "production", VITE_DEPLOYMENT_ENV: "test" })).toThrow();
  });
});
