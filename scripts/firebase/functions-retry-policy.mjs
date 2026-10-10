import { FUNCTIONS_PROJECT } from "./functions-release-policy.mjs";

// Enabling retries is an explicit release decision, never a blanket --force.
export const REVIEWED_IMPORT_RETRY = Object.freeze({
  id: "processImportedFileToFirestore", region: "us-west1", platform: "gcfv2",
  eventType: "google.cloud.storage.object.v1.finalized",
});

const matchesSelector = id => id === REVIEWED_IMPORT_RETRY.id || id.startsWith(`${REVIEWED_IMPORT_RETRY.id}-`);
const hasOnlyBucketFilter = trigger => Object.keys(trigger?.eventFilters || {}).length === 1
  && typeof trigger.eventFilters.bucket === "string"
  && Object.keys(trigger.eventFilterPathPatterns || {}).length === 0;

export function requireRetryInventory(inventory) {
  if (inventory?.status !== "success" || !Array.isArray(inventory.result)) {
    throw new Error("Cannot confirm deployed Functions inventory; no retry policy will be forced.");
  }
  const selected = inventory.result.filter(endpoint => matchesSelector(String(endpoint.id || "")));
  const endpoint = selected[0];
  if (selected.length !== 1 || endpoint.id !== REVIEWED_IMPORT_RETRY.id
    || endpoint.project !== FUNCTIONS_PROJECT || endpoint.region !== REVIEWED_IMPORT_RETRY.region
    || endpoint.platform !== REVIEWED_IMPORT_RETRY.platform || (endpoint.codebase || "default") !== "default"
    || endpoint.eventTrigger?.eventType !== REVIEWED_IMPORT_RETRY.eventType
    || !hasOnlyBucketFilter(endpoint.eventTrigger)
    || ![`${FUNCTIONS_PROJECT}.appspot.com`, `${FUNCTIONS_PROJECT}.firebasestorage.app`].includes(endpoint.eventTrigger?.eventFilters?.bucket)
    || typeof endpoint.eventTrigger.retry !== "boolean") {
    throw new Error("The deployed import trigger does not match the reviewed retry transition; operator review is required.");
  }
  return endpoint;
}

export function planReviewedRetryActivation(functionExports, inventory) {
  const deployed = requireRetryInventory(inventory);
  const names = Object.keys(functionExports).filter(matchesSelector);
  const wanted = functionExports[REVIEWED_IMPORT_RETRY.id]?.__endpoint;
  if (names.length !== 1 || names[0] !== REVIEWED_IMPORT_RETRY.id
    || wanted?.platform !== REVIEWED_IMPORT_RETRY.platform || wanted.region?.length !== 1
    || wanted.region[0] !== REVIEWED_IMPORT_RETRY.region
    || wanted.eventTrigger?.eventType !== REVIEWED_IMPORT_RETRY.eventType
    || !hasOnlyBucketFilter(wanted.eventTrigger)
    || wanted.eventTrigger?.eventFilters?.bucket !== deployed.eventTrigger.eventFilters.bucket
    || wanted.eventTrigger.retry !== true) {
    throw new Error("The source import trigger does not match the reviewed retry transition; no deployment will be forced.");
  }
  if (deployed.eventTrigger.retry) return [];
  return ["deploy", "--only", `functions:default:${REVIEWED_IMPORT_RETRY.id}`,
    "--project", FUNCTIONS_PROJECT, "--non-interactive", "--force"];
}
