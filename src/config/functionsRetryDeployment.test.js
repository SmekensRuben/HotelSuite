// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { planReviewedRetryActivation } from "../../scripts/firebase/functions-retry-policy.mjs";
import { deployReviewedFunctions } from "../../scripts/firebase/deploy-reviewed-functions.mjs";
import { FUNCTIONS_PROVIDER, FUNCTIONS_DEPLOY_ACCOUNT } from "../../scripts/firebase/functions-release-policy.mjs";

const require = createRequire(import.meta.url);
const backend = require("firebase-tools/lib/deploy/functions/backend");
const prompts = require("firebase-tools/lib/deploy/functions/prompts");
const { endpointMatchesFilter } = require("firebase-tools/lib/deploy/functions/functionsDeployHelper");
const id = "processImportedFileToFirestore";
const endpoint = () => ({ id, project: "hotel-toolkit", region: "us-west1", platform: "gcfv2", codebase: "default",
  eventTrigger: { eventType: "google.cloud.storage.object.v1.finalized", eventFilters: { bucket: "hotel-toolkit.firebasestorage.app" }, retry: false } });
const inventory = () => ({ status: "success", result: [endpoint()] });
const functionExports = () => ({ [id]: { __endpoint: { ...endpoint(), region: ["us-west1"],
  eventTrigger: { ...endpoint().eventTrigger, retry: true } } } });
const env = () => ({ GITHUB_ACTIONS: "true", FIREBASE_FUNCTIONS_DEPLOY_ENABLED: "true", FIREBASE_PROJECT_ID: "hotel-toolkit",
  FIREBASE_WORKLOAD_IDENTITY_PROVIDER: FUNCTIONS_PROVIDER, FIREBASE_DEPLOY_SERVICE_ACCOUNT: FUNCTIONS_DEPLOY_ACCOUNT,
  FUNCTIONS_APP_BASE_URL: "https://hotel-toolkit--hotel-toolkit.europe-west4.hosted.app" });

describe("reviewed import retry release", () => {
  it("reproduces the exact production CLI failure, then accepts only the reviewed transition", async () => {
    const old = endpoint();
    const wanted = { ...old, eventTrigger: { ...old.eventTrigger, retry: true } };
    await expect(prompts.promptForFailurePolicies({ nonInteractive: true }, backend.of(wanted), backend.of(old)))
      .rejects.toThrow("Pass the --force option to deploy functions with a failure policy");
    const args = planReviewedRetryActivation(functionExports(), inventory());
    expect(args).toEqual(["deploy", "--only", `functions:default:${id}`, "--project", "hotel-toolkit", "--non-interactive", "--force"]);
    await expect(prompts.promptForFailurePolicies({ nonInteractive: true, force: args.includes("--force") }, backend.of(wanted), backend.of(old)))
      .resolves.toBeUndefined();
    await expect(prompts.promptForFailurePolicies({ nonInteractive: true }, backend.of(wanted), backend.of(wanted)))
      .resolves.toBeUndefined();
  });

  it("keeps implicit deletion blocked during the full deployment", async () => {
    const calls = [];
    deployReviewedFunctions({ env: env(), loadFunctions: functionExports, run: args => {
      calls.push(args); return JSON.stringify(inventory());
    } });
    const fullRelease = calls.at(-1);
    expect(fullRelease).toEqual(["deploy", "--only", "functions", "--project", "hotel-toolkit", "--non-interactive"]);
    await expect(prompts.promptForFunctionDeletion([{ ...endpoint(), id: "obsoleteFunction" }], {
      nonInteractive: fullRelease.includes("--non-interactive"), force: fullRelease.includes("--force"),
    })).rejects.toThrow("Aborting because deletion cannot proceed in non-interactive mode");
  });

  it("does not redeploy the forced transition after retries are enabled", () => {
    const active = inventory(); active.result[0].eventTrigger.retry = true;
    const run = vi.fn(() => JSON.stringify(active));
    deployReviewedFunctions({ env: env(), loadFunctions: functionExports, run });
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls.flat(2)).not.toContain("--force");
  });

  it("aborts a failed scoped deploy before attempting the full release", () => {
    const run = vi.fn(args => { if (args[0] === "deploy") throw new Error("scoped deployment failed"); return JSON.stringify(inventory()); });
    expect(() => deployReviewedFunctions({ env: env(), loadFunctions: functionExports, run })).toThrow("scoped deployment failed");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it.each(["project", "region", "platform", "codebase"])("refuses a deployed %s migration", field => {
    const current = inventory(); current.result[0][field] = "different";
    expect(() => planReviewedRetryActivation(functionExports(), current)).toThrow("operator review");
  });
  it.each(["eventType", "eventFilters", "eventFilterPathPatterns", "retry"])("refuses unknown or changed deployed %s", field => {
    const current = inventory(); current.result[0].eventTrigger[field] = field === "eventFilters" ? { bucket: "another.appspot.com" }
      : field === "eventFilterPathPatterns" ? { name: "imports/*" } : "unknown";
    expect(() => planReviewedRetryActivation(functionExports(), current)).toThrow("operator review");
  });
  it("refuses a region move or missing source export that could delete the reviewed function", () => {
    const source = functionExports(); source[id].__endpoint.region = ["europe-west1"];
    expect(() => planReviewedRetryActivation(source, inventory())).toThrow("source import trigger");
    expect(() => planReviewedRetryActivation({}, inventory())).toThrow("source import trigger");
  });
  it("refuses a changed source trigger or disabled retry policy", () => {
    for (const change of [{ retry: false }, { eventType: "google.cloud.storage.object.v1.deleted" },
      { eventFilters: { bucket: "another.appspot.com" } }, { eventFilterPathPatterns: { name: "imports/*" } }]) {
      const source = functionExports(); Object.assign(source[id].__endpoint.eventTrigger, change);
      expect(() => planReviewedRetryActivation(source, inventory())).toThrow("source import trigger");
    }
  });
  it("accounts for the CLI's prefix selectors before forcing anything", () => {
    const other = { ...endpoint(), id: `${id}-legacy` };
    expect(endpointMatchesFilter(other, { codebase: "default", idChunks: [id] })).toBe(true);
    const current = inventory(); current.result.push(other);
    expect(() => planReviewedRetryActivation(functionExports(), current)).toThrow("operator review");
    const source = functionExports(); source[other.id] = source[id];
    expect(() => planReviewedRetryActivation(source, inventory())).toThrow("source import trigger");
  });
  it("refuses multiple deployed regions and missing or malformed inventory", () => {
    const current = inventory(); current.result.push({ ...endpoint(), region: "us-central1" });
    for (const value of [current, { status: "success", result: [] }, { status: "error", result: [endpoint()] }, {}]) {
      expect(() => planReviewedRetryActivation(functionExports(), value)).toThrow();
    }
  });
  it.each(["GITHUB_ACTIONS", "FIREBASE_FUNCTIONS_DEPLOY_ENABLED", "FIREBASE_PROJECT_ID"])("stops before any command with invalid %s", field => {
    const run = vi.fn();
    expect(() => deployReviewedFunctions({ env: { ...env(), [field]: "wrong" }, run, loadFunctions: functionExports })).toThrow();
    expect(run).not.toHaveBeenCalled();
  });
});
