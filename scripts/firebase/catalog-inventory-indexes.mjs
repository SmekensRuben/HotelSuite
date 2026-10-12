// Additive operator preparation for the reviewed periodic-inventory indexes.
// Index API: https://firebase.google.com/docs/firestore/reference/rest/v1/projects.databases.collectionGroups.indexes
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const INDEX_PROJECT = "hotel-toolkit";
export const INDEX_PROJECT_NUMBER = "358734544002";
export const INDEX_DATABASE = "(default)";
export const INDEX_OPERATOR = "bestsmekens@gmail.com";
const DATABASE_RESOURCE = `projects/${INDEX_PROJECT}/databases/${INDEX_DATABASE}`;
const API = "https://firestore.googleapis.com/v1/";
const EXPECTED_INDEXES = [
  { collectionGroup: "inventoryCheckpoints", queryScope: "COLLECTION", fields: [{ fieldPath: "locationId", order: "ASCENDING" }, { fieldPath: "sequence", order: "DESCENDING" }] },
  { collectionGroup: "inventoryCheckpoints", queryScope: "COLLECTION", fields: [{ fieldPath: "locationId", order: "ASCENDING" }, { fieldPath: "sequence", order: "ASCENDING" }] },
  { collectionGroup: "inventoryMovements", queryScope: "COLLECTION", fields: [{ fieldPath: "locationId", order: "ASCENDING" }, { fieldPath: "sequence", order: "ASCENDING" }] },
  { collectionGroup: "inventoryMovements", queryScope: "COLLECTION", fields: [{ fieldPath: "locationId", order: "ASCENDING" }, { fieldPath: "receivedOn", order: "ASCENDING" }] },
];

function indexFields(fields) {
  if (!Array.isArray(fields)) throw new Error("An index response has no field definition.");
  // Firestore appends this tie breaker to composite indexes. Only the trailing
  // field is removed; an explicitly positioned document-name field is distinct.
  const result = fields.at(-1)?.fieldPath === "__name__" ? fields.slice(0, -1) : fields;
  return result.map((field) => ({ fieldPath: field.fieldPath,
    ...(field.order ? { order: field.order } : {}), ...(field.arrayConfig ? { arrayConfig: field.arrayConfig } : {}),
    ...(field.vectorConfig ? { vectorConfig: field.vectorConfig } : {}) }));
}
export function indexSignature(index) {
  return JSON.stringify({ collectionGroup: index.collectionGroup, queryScope: index.queryScope, fields: indexFields(index.fields) });
}
export function validateReviewedInventoryIndexes(configuration) {
  if (!configuration || !Array.isArray(configuration.indexes) || configuration.indexes.length !== EXPECTED_INDEXES.length
    || !Array.isArray(configuration.fieldOverrides) || configuration.fieldOverrides.length !== 0
    || Object.keys(configuration).some((key) => !["indexes", "fieldOverrides"].includes(key))) {
    throw new Error("The reviewed inventory index manifest must contain exactly four additive indexes and no field overrides.");
  }
  const expected = new Set(EXPECTED_INDEXES.map(indexSignature)), seen = new Set();
  for (const index of configuration.indexes) {
    if (!index || Object.keys(index).some((key) => !["collectionGroup", "queryScope", "fields"].includes(key))
      || !Array.isArray(index.fields) || index.fields.length !== 2
      || index.fields.some((field) => !field || Object.keys(field).some((key) => !["fieldPath", "order"].includes(key)))) {
      throw new Error("An inventory index contains an unreviewed option.");
    }
    const key = indexSignature(index);
    if (!expected.has(key) || seen.has(key)) throw new Error("The inventory index manifest differs from this reviewed release policy.");
    seen.add(key);
  }
  return configuration.indexes.map((index) => structuredClone(index));
}
function requireTarget({ projectId, projectNumber, databaseId, operator, releaseSha }) {
  if (projectId !== INDEX_PROJECT || String(projectNumber) !== INDEX_PROJECT_NUMBER || databaseId !== INDEX_DATABASE || operator !== INDEX_OPERATOR) {
    throw new Error("The reviewed project, project number, default database and release operator are required. No index was changed.");
  }
  if (!/^[a-f0-9]{40}$/.test(releaseSha ?? "")) throw new Error("An exact reviewed release SHA is required. No index was changed.");
}
function requireDatabase(database) {
  if (database?.name !== DATABASE_RESOURCE || database.type !== "FIRESTORE_NATIVE"
    || database.databaseEdition !== "STANDARD" || database.deleteTime
    || database.firestoreDataAccessMode === "DATA_ACCESS_MODE_DISABLED") {
    throw new Error("The default database must be an existing Standard edition Firestore Native database with Firestore access. Unknown or different configuration needs operator review; no database is provisioned or changed.");
  }
}
function indexParent(collectionGroup) { return `${DATABASE_RESOURCE}/collectionGroups/${collectionGroup}`; }
function validateIndexName(name, collectionGroup) {
  const prefix = `${indexParent(collectionGroup)}/indexes/`;
  if (typeof name !== "string" || !name.startsWith(prefix) || !/^[A-Za-z0-9_-]+$/.test(name.slice(prefix.length))) {
    throw new Error("An index response belongs to an unexpected resource.");
  }
}
async function listIndexes(request, collectionGroup) {
  const result = [], tokens = new Set();
  let pageToken;
  for (let page = 0; page < 20; page++) {
    const response = await request({ method: "GET", path: `${indexParent(collectionGroup)}/indexes`, params: { pageSize: 100, ...(pageToken ? { pageToken } : {}) } });
    if (!response || !Array.isArray(response.indexes ?? []) || (response.indexes ?? []).length > 100) throw new Error("The bounded index list response is invalid.");
    for (const index of response.indexes ?? []) {
      validateIndexName(index.name, collectionGroup);
      result.push({ ...index, collectionGroup });
    }
    const next = response.nextPageToken;
    if (next === undefined || next === "") return result;
    if (typeof next !== "string" || next.length > 10000 || tokens.has(next)) throw new Error("The index list pagination token is invalid or repeated.");
    tokens.add(next); pageToken = next;
  }
  throw new Error("Index listing exceeded the bounded 20-page limit. Review the index inventory before proceeding.");
}
async function inspectIndexes(request, reviewed) {
  const groups = [...new Set(reviewed.map((index) => index.collectionGroup))];
  const existing = (await Promise.all(groups.map((group) => listIndexes(request, group)))).flat();
  return reviewed.map((index) => {
    const candidates = existing.filter((item) => indexSignature(item) === indexSignature(index)
      && (item.apiScope === undefined || item.apiScope === "ANY_API"));
    if (candidates.length > 1) throw new Error("Duplicate matching inventory indexes need operator review.");
    const candidate = candidates[0];
    const state = candidate?.state ?? "MISSING";
    if (!["MISSING", "CREATING", "READY"].includes(state)) throw new Error(`Required ${index.collectionGroup} index state ${state} needs operator repair. No automatic deletion or replacement is performed.`);
    return { ...index, state, name: candidate?.name ?? null };
  });
}
function operationName(value) {
  const prefix = `${DATABASE_RESOURCE}/operations/`;
  if (typeof value !== "string" || !value.startsWith(prefix) || !/^[A-Za-z0-9_-]+$/.test(value.slice(prefix.length))) throw new Error("Index creation returned an unexpected operation resource.");
  return value;
}
async function verifyOperations(request, operations) {
  for (const name of operations) {
    const operation = await request({ method: "GET", path: name });
    if (operation?.name !== name || typeof operation.done !== "boolean" && operation.done !== undefined) throw new Error("The index creation operation response is invalid.");
    if (operation.error || ["FAILED", "CANCELLED"].includes(operation.metadata?.state)) throw new Error(`Index creation failed for ${name}. Inspect the Firestore index operation; Rules and application data were not changed by this helper.`);
  }
}

export async function prepareCatalogInventoryIndexes({ request, configuration, mode = "preflight", projectId = INDEX_PROJECT,
  projectNumber, databaseId = INDEX_DATABASE, operator, releaseSha, timeoutMs = 1800000, pollIntervalMs = 15000,
  now = Date.now, sleep = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms)), log = () => {} }) {
  requireTarget({ projectId, projectNumber, databaseId, operator, releaseSha });
  if (!["preflight", "apply", "verify"].includes(mode)) throw new Error("Choose preflight, apply or verify.");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 1800000 || !Number.isInteger(pollIntervalMs) || pollIntervalMs < 1 || pollIntervalMs > 30000) throw new Error("Index wait bounds must be explicit and at most 30 minutes, with intervals at most 30 seconds.");
  const reviewed = validateReviewedInventoryIndexes(configuration);
  const database = await request({ method: "GET", path: DATABASE_RESOURCE });
  requireDatabase(database);
  let indexes = await inspectIndexes(request, reviewed);
  let created = 0;
  const operations = [];
  if (mode === "apply") {
    for (const index of indexes.filter((item) => item.state === "MISSING")) {
      const { queryScope, fields } = index;
      try {
        const operation = await request({ method: "POST", path: `${indexParent(index.collectionGroup)}/indexes`, body: { queryScope, fields } });
        operations.push(operationName(operation?.name));
        if (operation?.error) throw new Error("An index creation operation failed immediately.");
        created++;
        log(`Requested reviewed ${index.collectionGroup} index; existing unrelated indexes were preserved.`);
      } catch (error) {
        // A simultaneous operator may have created the same index after the
        // read. Never retry a create blindly; subsequent reads must prove READY.
        if (error.status !== 409) throw error;
        log(`A concurrent ${index.collectionGroup} index creation was reported; verifying its serving state.`);
      }
    }
    const start = now(), maxPolls = Math.ceil(timeoutMs / pollIntervalMs) + 1;
    for (let poll = 0; poll < maxPolls; poll++) {
      await verifyOperations(request, operations);
      indexes = await inspectIndexes(request, reviewed);
      if (indexes.every((index) => index.state === "READY")) break;
      const remaining = timeoutMs - (now() - start);
      log(`Inventory indexes: ${indexes.filter((index) => index.state === "READY").length}/${indexes.length} READY; waiting without pausing SaaS writes.`);
      if (remaining <= 0 || poll === maxPolls - 1) throw new Error("Timed out waiting for all reviewed inventory indexes to become READY. Index builds may continue; rerun the same reviewed release. Rules and SaaS activation were not changed by this helper.");
      await sleep(Math.min(pollIntervalMs, remaining));
    }
  }
  const ready = indexes.every((index) => index.state === "READY");
  if (mode === "verify" && !ready) throw new Error("Every reviewed inventory index must be READY before SaaS activation. No index or database was changed by this read-only verification.");
  return { projectId, databaseId, releaseSha, mode, databaseEdition: database.databaseEdition, databaseType: database.type, ready, created, indexes };
}

async function main() {
  const args = process.argv.slice(2), mode = args[0];
  if (args.length !== 1 || !["preflight", "apply", "verify"].includes(mode)) throw new Error("Use catalog-inventory-indexes.mjs preflight|apply|verify with the exact SAAS_RELEASE_SHA.");
  if (process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_AUTH_EMULATOR_HOST) throw new Error("Remove emulator configuration before an operator index check.");
  const releaseSha = process.env.SAAS_RELEASE_SHA;
  const projectNumber = execFileSync("gcloud", ["projects", "describe", INDEX_PROJECT, "--format=value(projectNumber)"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const operator = execFileSync("gcloud", ["auth", "list", "--filter=status:ACTIVE", "--format=value(account)"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  requireTarget({ projectId: INDEX_PROJECT, projectNumber, databaseId: INDEX_DATABASE, operator, releaseSha });
  const configuration = JSON.parse(await readFile(new URL("../../firebase/firestore.indexes.json", import.meta.url), "utf8"));
  validateReviewedInventoryIndexes(configuration);
  const policy = JSON.parse(await readFile(new URL("../../functions/src/platformReleasePolicy.json", import.meta.url), "utf8"));
  if (policy.saasRulesVersion !== "saas-platform-v4") throw new Error("The reviewed inventory Rules policy must be saas-platform-v4.");
  // A direct helper invocation must satisfy the same exact-main/CI/runtime
  // release authorization as the enclosing operator rollout.
  execFileSync(process.execPath, [fileURLToPath(new URL("./saas-release-check.mjs", import.meta.url))], { stdio: "inherit" });
  let token;
  try { token = execFileSync("gcloud", ["auth", "print-access-token"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
  catch { throw new Error("The reviewed operator's short-lived OAuth could not be obtained. No credential was printed or saved."); }
  if (!token) throw new Error("The operator OAuth response was empty.");
  // Resolve only from the lockfile-installed operator runtime. No new package,
  // service account key, ADC file or persistent token is created.
  const { OAuth2Client } = await import("google-auth-library");
  const client = new OAuth2Client();
  client.setCredentials({ access_token: token, expiry_date: Date.now() + 3000000 });
  const request = async ({ method, path, params, body }) => {
    try {
      const response = await client.request({ method, url: `${API}${path}`, params, data: body, timeout: 30000, retry: false });
      return response.data;
    } catch (error) {
      const failure = new Error(`Firestore index administration request failed (${error.response?.status ?? "transport error"}). No OAuth or API payload was printed.`);
      failure.status = error.response?.status;
      throw failure;
    }
  };
  const result = await prepareCatalogInventoryIndexes({ request, configuration, mode, projectNumber, operator, releaseSha, log: console.log });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
