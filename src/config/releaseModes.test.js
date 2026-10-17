// @vitest-environment node
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { load } = require("js-yaml");
const workflow = load(readFileSync(".github/workflows/deploy-functions.yml", "utf8"));
const steps = workflow.jobs.deploy.steps;
const index = text => steps.findIndex(step => step.run?.includes(text));

describe("coordinated production release boundaries", () => {
  it("keeps cloud credentials out of selection and protected acceptance", () => {
    expect(workflow.permissions["id-token"]).toBeUndefined();
    expect(workflow.jobs.select.permissions?.["id-token"]).toBeUndefined();
    expect(workflow.jobs.approval.permissions?.["id-token"]).toBeUndefined();
    expect(workflow.jobs.approval.environment).toBe("production");
    expect(workflow.jobs.approval.if).toContain("needs.select.outputs.mode == 'controlled'");
    const authentication = steps.findIndex(step => step.uses?.startsWith("google-github-actions/auth@"));
    expect(index("check-controlled-release.mjs --require-approval")).toBeLessThan(authentication);
    expect(index("check-controlled-release.mjs --require-approval")).toBeGreaterThan(-1);
  });

  it("pins the checked-out and deployed candidate and revalidates mode after selection", () => {
    expect(workflow.jobs.select.env.RELEASE_MODE).toBe("${{ vars.RELEASE_MODE }}");
    expect(workflow.jobs.deploy.env.RELEASE_MODE).toBe("${{ vars.RELEASE_MODE }}");
    expect(workflow.jobs.deploy.env.EXPECTED_RELEASE_MODE).toBe("${{ needs.select.outputs.mode }}");
    expect(workflow.jobs.deploy.env.RELEASE_SHA).toBe("${{ needs.select.outputs.sha }}");
    expect(steps[0].with.ref).toBe("${{ needs.select.outputs.sha }}");
    expect(workflow.jobs.deploy.if).toContain("needs.approval.result == 'success'");
    expect(workflow.jobs.deploy.if).toContain("needs.select.outputs.mode == 'development'");
  });

  it("checks independent hosting before mutations and publishes frontend after Functions and controlled verification", () => {
    expect(index("production-apphosting.mjs preflight")).toBeLessThan(index("release-monitoring.mjs pause"));
    expect(index("production-apphosting.mjs preflight")).toBeLessThan(index("deploy-reviewed-functions.mjs"));
    expect(index("deploy-reviewed-functions.mjs")).toBeLessThan(index("release-monitoring.mjs verify"));
    expect(index("deploy-reviewed-functions.mjs")).toBeLessThan(index("FUNCTIONS_DEPLOY_COMPLETED_AT="));
    expect(index("FUNCTIONS_DEPLOY_COMPLETED_AT=")).toBeLessThan(index("release-monitoring.mjs verify"));
    expect(steps.find(step => step.run?.includes("release-monitoring.mjs verify")).run).toContain('"$FUNCTIONS_DEPLOY_COMPLETED_AT"');
    expect(index("release-monitoring.mjs verify")).toBeLessThan(index("production-apphosting.mjs publish"));
    expect(steps.find(step => step.run?.includes("release-monitoring.mjs verify")).if).toBe("env.RELEASE_MODE == 'controlled'");
    const pause = steps.filter(step => step.run?.includes("release-monitoring.mjs pause"));
    expect(pause).toHaveLength(2);
    expect(pause.every(step => step.if === "env.RELEASE_MODE == 'development'")).toBe(true);
    expect(pause[0].run).toContain("--dry-run");
    expect(pause[1].run).toContain("--apply");
  });

  it("retains serialization and disables the observed alternate Vercel main Git publication path", () => {
    expect(workflow.concurrency["cancel-in-progress"]).toBe(false);
    const vercel = JSON.parse(readFileSync("vercel.json", "utf8"));
    expect(vercel.git.deploymentEnabled.main).toBe(false);
    expect(vercel.rewrites).toEqual([{ source: "/(.*)", destination: "/" }]);
  });
});
