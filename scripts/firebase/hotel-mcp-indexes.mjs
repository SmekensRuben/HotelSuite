// Additive preparation for the two reviewed MCP list indexes. Node 22+ and gcloud only.
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MCP_INDEX_PROJECT = "hotel-toolkit";
export const MCP_INDEX_PROJECT_NUMBER = "358734544002";
const DATABASE = "(default)";
const RESOURCE = `projects/${MCP_INDEX_PROJECT}/databases/${DATABASE}`;
const API = "https://firestore.googleapis.com/v1/";
export const HOTEL_MCP_INDEXES = [
  { collectionGroup: "hotelMcpOAuthConnections", queryScope: "COLLECTION", fields: [
    { fieldPath: "uid", order: "ASCENDING" }, { fieldPath: "revokedAt", order: "ASCENDING" }, { fieldPath: "expiresAtMs", order: "ASCENDING" },
  ] },
  { collectionGroup: "hotelMcpProposalBatches", queryScope: "COLLECTION", fields: [
    { fieldPath: "ownerUid", order: "ASCENDING" }, { fieldPath: "createdAtMillis", order: "DESCENDING" }, { fieldPath: "__name__", order: "DESCENDING" },
  ] },
];

export function mcpIndexSignature(index) {
  if (!Array.isArray(index.fields) || index.fields.length < 2) throw new Error("An index response has no valid field definition.");
  const fields = structuredClone(index.fields);
  // Firestore appends the document-name field using the last ordered field's
  // direction. Preserve an explicit direction: ascending cannot serve our descending cursor.
  if (fields.at(-1)?.fieldPath !== "__name__") {
    fields.push({ fieldPath: "__name__", order: fields.findLast(field => field.order)?.order || "ASCENDING" });
  }
  return JSON.stringify({ collectionGroup: index.collectionGroup, queryScope: index.queryScope,
    fields: fields.map(field => Object.fromEntries(Object.entries(field).sort(([left], [right]) => left.localeCompare(right)))) });
}

function requireTarget(projectId, projectNumber, databaseId) {
  if (projectId !== MCP_INDEX_PROJECT || String(projectNumber) !== MCP_INDEX_PROJECT_NUMBER || databaseId !== DATABASE) {
    throw new Error("Explicit hotel-toolkit, its verified project number and the default database are required. No index was changed.");
  }
}

function collectionGroup(name) {
  const prefix = `${RESOURCE}/collectionGroups/`;
  if (typeof name !== "string" || !name.startsWith(prefix)) throw new Error("An index response belongs to an unexpected resource.");
  const match = /^([^/]+)\/indexes\/([A-Za-z0-9_-]+)$/.exec(name.slice(prefix.length));
  if (!match || [".", ".."].includes(match[1])) throw new Error("An index response has an invalid resource name.");
  return match[1];
}

async function inspectIndexes(request) {
  const existing = [], tokens = new Set();
  let pageToken;
  for (let page = 0; page < 20; page++) {
    // Standard/Native index listing uses its default page size; do not send pageSize.
    const response = await request({ method: "GET", path: `${RESOURCE}/collectionGroups/-/indexes`, params: pageToken ? { pageToken } : {} });
    if (!response || !Array.isArray(response.indexes ?? [])) throw new Error("The index metadata response is invalid.");
    if (existing.length + (response.indexes ?? []).length > 2000) throw new Error("Index listing exceeded the 2000-index metadata limit.");
    for (const index of response.indexes ?? []) existing.push({ ...index, collectionGroup: collectionGroup(index.name) });
    const next = response.nextPageToken;
    if (next === undefined || next === "") break;
    if (typeof next !== "string" || next.length > 10000 || tokens.has(next)) throw new Error("The index pagination token is invalid or repeated.");
    if (page === 19) throw new Error("Index listing exceeded the 20-page metadata limit.");
    tokens.add(next); pageToken = next;
  }
  return HOTEL_MCP_INDEXES.map(definition => {
    const candidates = existing.filter(index => index.collectionGroup === definition.collectionGroup
      && (index.apiScope === undefined || index.apiScope === "ANY_API") && mcpIndexSignature(index) === mcpIndexSignature(definition));
    if (candidates.length > 1) throw new Error("Duplicate matching MCP indexes need operator review.");
    const candidate = candidates[0], state = candidate?.state ?? "MISSING";
    if (!["MISSING", "CREATING", "READY"].includes(state)) throw new Error("A required MCP index needs operator repair. No index is deleted or replaced.");
    return { ...structuredClone(definition), state, name: candidate?.name ?? null };
  });
}

export async function prepareHotelMcpIndexes({ request, projectId, projectNumber, databaseId = DATABASE, mode = "preflight",
  timeoutMs = 1800000, pollIntervalMs = 15000, now = Date.now,
  sleep = milliseconds => new Promise(done => setTimeout(done, milliseconds)), log = () => {} }) {
  requireTarget(projectId, projectNumber, databaseId);
  if (!["preflight", "apply", "verify"].includes(mode)) throw new Error("Choose preflight, apply or verify.");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 1800000
    || !Number.isInteger(pollIntervalMs) || pollIntervalMs < 1 || pollIntervalMs > 30000) throw new Error("Index wait bounds must be at most 30 minutes, with intervals at most 30 seconds.");
  const database = await request({ method: "GET", path: RESOURCE });
  if (database?.name !== RESOURCE || database.type !== "FIRESTORE_NATIVE" || database.databaseEdition !== "STANDARD"
    || database.deleteTime || database.firestoreDataAccessMode === "DATA_ACCESS_MODE_DISABLED") {
    throw new Error("An existing Standard edition Firestore Native default database with data access is required. No database is provisioned or changed.");
  }
  let indexes = await inspectIndexes(request), created = 0;
  if (mode === "apply") {
    const operations = [];
    for (const index of indexes.filter(item => item.state === "MISSING")) {
      try {
        const operation = await request({ method: "POST", path: `${RESOURCE}/collectionGroups/${index.collectionGroup}/indexes`,
          body: { queryScope: index.queryScope, fields: index.fields } });
        if (operation?.error) throw new Error("A reviewed MCP index creation failed. Inspect its Firestore operation.");
        const prefix = `${RESOURCE}/operations/`;
        if (typeof operation?.name !== "string" || !operation.name.startsWith(prefix)
          || !/^[A-Za-z0-9_-]+$/.test(operation.name.slice(prefix.length))) throw new Error("Index creation returned an unexpected operation resource.");
        operations.push(operation.name); created++;
        log(`Requested ${index.collectionGroup} index; unrelated indexes and application records are preserved.`);
      } catch (error) {
        if (error.status !== 409) throw error;
        log(`Concurrent ${index.collectionGroup} index creation detected; verifying its serving state.`);
      }
    }
    const started = now(), maxPolls = Math.ceil(timeoutMs / pollIntervalMs) + 1;
    for (let poll = 0; poll < maxPolls; poll++) {
      for (const name of operations) {
        const operation = await request({ method: "GET", path: name });
        if (operation?.name !== name || (operation.done !== undefined && typeof operation.done !== "boolean")) throw new Error("The index operation metadata is invalid.");
        if (operation.error || ["FAILED", "CANCELLED"].includes(operation.metadata?.state)) throw new Error("A reviewed MCP index build failed. Inspect Firestore index operations; no automatic replacement is attempted.");
      }
      indexes = await inspectIndexes(request);
      if (indexes.every(index => index.state === "READY")) break;
      const remaining = timeoutMs - (now() - started);
      log(`MCP indexes: ${indexes.filter(index => index.state === "READY").length}/${indexes.length} READY.`);
      if (remaining <= 0 || poll === maxPolls - 1) throw new Error("Timed out waiting for MCP indexes to become READY. Builds may continue; rerun apply or verify. Existing proposals and connections are preserved.");
      await sleep(Math.min(pollIntervalMs, remaining));
    }
  }
  const ready = indexes.every(index => index.state === "READY");
  if (mode === "verify" && !ready) throw new Error("Both MCP indexes must be READY. Run preflight, then apply to create missing indexes. No index was changed by verification.");
  return { projectId, databaseId, mode, ready, created, indexes };
}

export function createHotelMcpIndexRequest(token, fetchRequest = fetch) {
  return async ({ method, path, params = {}, body }) => {
    const operation = path === RESOURCE ? "read database" : path.startsWith(`${RESOURCE}/operations/`) ? "read index operation"
      : method === "POST" ? "create MCP index" : "list index metadata";
    let response;
    try {
      const url = new URL(path, API);
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
      response = await fetchRequest(url, { method, headers: { Authorization: `Bearer ${token}`,
        "X-Goog-User-Project": MCP_INDEX_PROJECT, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) });
    } catch { throw new Error(`Firestore index administration failed (${operation}, transport error). No credential or API payload was printed.`); }
    if (!response.ok) {
      const error = new Error(`Firestore index administration failed (${operation}, HTTP ${response.status}). No credential or API payload was printed.`);
      error.status = response.status; throw error;
    }
    try { return await response.json(); }
    catch { throw new Error(`Firestore index administration returned invalid JSON (${operation}).`); }
  };
}

export function parseHotelMcpIndexArgs(args) {
  if (args.length !== 3 || !["preflight", "apply", "verify"].includes(args[0]) || args[1] !== "--project" || args[2] !== MCP_INDEX_PROJECT) {
    throw new Error("Usage: node hotel-mcp-indexes.mjs preflight|apply|verify --project hotel-toolkit");
  }
  return args[0];
}

function gcloud(args, purpose) {
  try { return execFileSync("gcloud", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
  catch { throw new Error(`Could not ${purpose} using gcloud. No credential was printed or saved.`); }
}

async function main() {
  const mode = parseHotelMcpIndexArgs(process.argv.slice(2));
  const projectNumber = gcloud(["projects", "describe", MCP_INDEX_PROJECT, "--format=value(projectNumber)"], "verify the hotel-toolkit project number");
  requireTarget(MCP_INDEX_PROJECT, projectNumber, DATABASE);
  const operator = gcloud(["auth", "list", "--filter=status:ACTIVE", "--format=value(account)"], "verify the active operator");
  if (!operator || /[\r\n]/.test(operator)) throw new Error("Select one authenticated gcloud operator before preparing MCP indexes.");
  const token = gcloud(["auth", "print-access-token"], "obtain short-lived operator OAuth");
  if (!token) throw new Error("The operator OAuth response was empty. No credential was printed or saved.");
  const result = await prepareHotelMcpIndexes({ request: createHotelMcpIndexRequest(token), projectId: MCP_INDEX_PROJECT, projectNumber, mode, log: console.log });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
