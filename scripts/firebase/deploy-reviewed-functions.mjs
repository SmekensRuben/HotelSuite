import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { FUNCTIONS_PROJECT, requireFunctionsConfiguration } from "./functions-release-policy.mjs";
import { requireRetryInventory, planReviewedRetryActivation } from "./functions-retry-policy.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const firebaseCli = fileURLToPath(new URL("../../node_modules/firebase-tools/lib/bin/firebase.js", import.meta.url));
const require = createRequire(import.meta.url);
const imageRetryId = "processSupplierProductImage";
const imageRetryRegion = "us-west1";
const storageFinalizeEvent = "google.cloud.storage.object.v1.finalized";
const matchesImageSelector = (id) => id === imageRetryId || id.startsWith(`${imageRetryId}-`);
const hasOtherTrigger = (endpoint) => ["httpsTrigger", "callableTrigger", "scheduleTrigger", "taskQueueTrigger", "blockingTrigger"]
  .some((key) => endpoint[key] !== undefined);
function imageStorageTrigger(trigger, bucket) {
  return trigger?.eventType === storageFinalizeEvent && typeof trigger.retry === "boolean"
    && Object.keys(trigger.eventFilters || {}).length === 1 && trigger.eventFilters.bucket === bucket
    && Object.keys(trigger.eventFilterPathPatterns || {}).length === 0;
}

// Only this reviewed new trigger may be created with retries; all other changes
// remain subject to the unforced full release and its deletion/retry prompts.
export function planReviewedImageRetryActivation(functionExports, inventory, bucket) {
  if (inventory?.status !== "success" || !Array.isArray(inventory.result)
    || ![`${FUNCTIONS_PROJECT}.appspot.com`, `${FUNCTIONS_PROJECT}.firebasestorage.app`].includes(bucket)) {
    throw new Error("Cannot confirm the reviewed product image retry inventory or bucket.");
  }
  const names = Object.keys(functionExports).filter(matchesImageSelector);
  const wanted = functionExports[imageRetryId]?.__endpoint;
  if (names.length !== 1 || names[0] !== imageRetryId || wanted?.platform !== "gcfv2"
    || wanted.project !== undefined && wanted.project !== FUNCTIONS_PROJECT
    || wanted.codebase !== undefined && wanted.codebase !== "default"
    || wanted.region?.length !== 1 || wanted.region[0] !== imageRetryRegion
    || hasOtherTrigger(wanted)
    || !imageStorageTrigger(wanted.eventTrigger, bucket) || wanted.eventTrigger.retry !== true) {
    throw new Error("The source product image trigger does not match the reviewed retry policy; no deployment will be forced.");
  }
  const selected = inventory.result.filter((endpoint) => matchesImageSelector(String(endpoint.id || "")));
  if (selected.length > 1) throw new Error("The deployed product image selector is ambiguous; operator review is required.");
  const deployed = selected[0];
  if (deployed && (deployed.id !== imageRetryId || deployed.project !== FUNCTIONS_PROJECT
    || deployed.region !== imageRetryRegion || deployed.platform !== "gcfv2" || (deployed.codebase || "default") !== "default"
    || hasOtherTrigger(deployed)
    || !imageStorageTrigger(deployed.eventTrigger, bucket))) {
    throw new Error("The deployed product image trigger does not match the reviewed retry policy; operator review is required.");
  }
  if (deployed?.eventTrigger.retry === true) return [];
  return ["deploy", "--only", `functions:default:${imageRetryId}`, "--project", FUNCTIONS_PROJECT, "--non-interactive", "--force"];
}

function runFirebase(args, { capture = false } = {}) {
  if (capture) return execFileSync(process.execPath, [firebaseCli, ...args], { cwd: root, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  const result = spawnSync(process.execPath, [firebaseCli, ...args], { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Firebase deployment failed (${result.signal || result.status}).`);
}

export function deployReviewedFunctions({ env = process.env, run = runFirebase,
  loadFunctions = config => {
    process.env.FIREBASE_CONFIG = JSON.stringify(config);
    return require("../../functions/index.js");
  } } = {}) {
  if (env.GITHUB_ACTIONS !== "true" || env.FIREBASE_FUNCTIONS_DEPLOY_ENABLED !== "true") {
    throw new Error("Reviewed Functions deployment requires the enabled GitHub release workflow.");
  }
  requireFunctionsConfiguration(env);
  const inventory = JSON.parse(run(["functions:list", "--project", FUNCTIONS_PROJECT, "--non-interactive", "--json"], { capture: true }));
  const deployed = requireRetryInventory(inventory);
  const functionExports = loadFunctions({ projectId: FUNCTIONS_PROJECT, storageBucket: deployed.eventTrigger.eventFilters.bucket });
  const retryArgs = planReviewedRetryActivation(functionExports, inventory);
  const imageRetryArgs = planReviewedImageRetryActivation(functionExports, inventory, deployed.eventTrigger.eventFilters.bucket);
  if (retryArgs.length) {
    console.log("Enabling reviewed retries for processImportedFileToFirestore(us-west1) only.");
    run(retryArgs);
  }
  if (imageRetryArgs.length) {
    console.log("Enabling reviewed retries for processSupplierProductImage(us-west1) only.");
    run(imageRetryArgs);
  }
  // Keep the full deployment unforced: removals and further retry changes stop CI.
  run(["deploy", "--only", "functions", "--project", FUNCTIONS_PROJECT, "--non-interactive"]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) deployReviewedFunctions();
