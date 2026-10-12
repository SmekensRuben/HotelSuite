// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createIndexRequest, prepareCatalogInventoryIndexes, validateReviewedInventoryIndexes, indexSignature,
  INDEX_PROJECT, INDEX_PROJECT_NUMBER, INDEX_DATABASE, INDEX_OPERATOR } from "../../scripts/firebase/catalog-inventory-indexes.mjs";

const releaseSha = "a".repeat(40);
const configuration = JSON.parse(readFileSync(new URL("../../firebase/firestore.indexes.json", import.meta.url), "utf8"));
const resource = `projects/${INDEX_PROJECT}/databases/${INDEX_DATABASE}`;
const indexResource = (group, id) => `${resource}/collectionGroups/${group}/indexes/${id}`;
const database = () => ({ name: resource, type: "FIRESTORE_NATIVE", databaseEdition: "STANDARD" });
const reviewed = () => validateReviewedInventoryIndexes(configuration);
const index = (definition, id, state = "READY") => ({ ...structuredClone(definition), name: indexResource(definition.collectionGroup, id), state,
  fields: [...definition.fields, { fieldPath: "__name__", order: definition.fields.at(-1).order }] });
const base = () => ({ configuration, projectId: INDEX_PROJECT, projectNumber: INDEX_PROJECT_NUMBER, databaseId: INDEX_DATABASE, operator: INDEX_OPERATOR, releaseSha });

function fakeApi({ initial = reviewed().map((definition, number) => index(definition, `existing-${number}`)), db = database(), readyAfter = 0,
  pages = null, operationFailure = false, createConflict = false } = {}) {
  const stored = structuredClone(initial), calls = [], operations = new Map();
  let sequence = 0, waits = 0, elapsed = 0;
  const request = async (call) => {
    calls.push(structuredClone(call));
    if (call.method === "GET" && call.path === resource) return structuredClone(db);
    if (operations.has(call.path)) return { name: call.path, done: waits >= readyAfter,
      ...(operationFailure ? { error: { code: 9, message: "private operation detail" }, metadata: { state: "FAILED" } } : {}) };
    const match = /^projects\/hotel-toolkit\/databases\/\(default\)\/collectionGroups\/(inventoryCheckpoints|inventoryMovements)\/indexes$/.exec(call.path);
    if (!match) throw new Error("Unexpected API resource; no live requests are available in this fixture.");
    const group = match[1];
    if (call.method === "GET") {
      // Reproduce the live Standard/Native API contract independently of the helper.
      if ((call.params?.pageSize ?? 0) !== 0) {
        const error = new Error("Invalid page size. Only 0 is supported.");
        error.status = 400; throw error;
      }
      if (pages) return pages(call, stored);
      return { indexes: stored.filter((value) => value.collectionGroup === group).map((value) => ({ ...value,
        state: value.state === "CREATING" && waits >= readyAfter ? "READY" : value.state })) };
    }
    if (call.method === "POST") {
      sequence++;
      const definition = { collectionGroup: group, ...call.body }, name = `${resource}/operations/create-${sequence}`;
      stored.push(index(definition, `created-${sequence}`, "CREATING")); operations.set(name, true);
      if (createConflict) { const error = new Error("conflict"); error.status = 409; throw error; }
      return { name, done: false };
    }
    throw new Error("An additive index rollout cannot delete, patch or change data.");
  };
  return { request, stored, calls, now: () => elapsed, sleep: async (ms) => { elapsed += ms; waits++; },
    writeCalls: () => calls.filter((call) => call.method !== "GET") };
}
function prepare(api, patch = {}) {
  return prepareCatalogInventoryIndexes({ ...base(), request: api.request, now: api.now, sleep: api.sleep, timeoutMs: 1000, pollIntervalMs: 100, ...patch });
}

describe("reviewed periodic inventory index manifest", () => {
  it("accepts exactly the four reviewed composite indexes with no field overrides", () => {
    expect(reviewed()).toHaveLength(4);
    expect(new Set(reviewed().map(indexSignature)).size).toBe(4);
  });
  it("compares serving fields while excluding Firestore's appended document-name field", () => {
    const definition = reviewed()[0];
    expect(indexSignature(index(definition, "i"))).toBe(indexSignature(definition));
    expect(indexSignature({ ...definition, fields: [...definition.fields].reverse() })).not.toBe(indexSignature(definition));
  });
  it.each([
    { ...configuration, indexes: configuration.indexes.slice(1) },
    { ...configuration, fieldOverrides: [{ collectionGroup: "users", fieldPath: "email", indexes: [] }] },
    { ...configuration, indexes: [...configuration.indexes.slice(0, 3), configuration.indexes[0]] },
    { ...configuration, indexes: configuration.indexes.map((value, i) => i ? value : { ...value, collectionGroup: "users" }) },
    { ...configuration, indexes: configuration.indexes.map((value, i) => i ? value : { ...value, apiScope: "DATASTORE_MODE_API" }) },
  ])("rejects unreviewed index/override definitions", (value) => expect(() => validateReviewedInventoryIndexes(value)).toThrow());
});

describe("private index API diagnostics", () => {
  it("passes the fixed API request contract through without adding a page size or retries", async () => {
    const calls = [], data = { indexes: [] };
    const request = createIndexRequest({ request: async (call) => { calls.push(call); return { data }; } });
    const path = `${resource}/collectionGroups/inventoryCheckpoints/indexes`;
    expect(await request({ method: "GET", path, params: { pageToken: "next" } })).toBe(data);
    expect(calls).toEqual([{ method: "GET", url: `https://firestore.googleapis.com/v1/${path}`, params: { pageToken: "next" },
      data: undefined, timeout: 30000, retry: false }]);
  });
  it.each([400, 409])("reports only the operation and allowlisted status, retaining HTTP %s for control flow", async (http) => {
    const provider = new Error("private transport detail");
    provider.response = { status: http, data: { error: { status: "INVALID_ARGUMENT", message: "private API payload" } } };
    provider.config = { headers: { Authorization: "Bearer private OAuth credential" } };
    const request = createIndexRequest({ request: async () => { throw provider; } });
    let failure;
    try { await request({ method: "GET", path: `${resource}/collectionGroups/inventoryMovements/indexes` }); }
    catch (error) { failure = error; }
    expect(failure.status).toBe(http);
    expect(failure.message).toContain(`list indexes, HTTP ${http}, INVALID_ARGUMENT`);
    expect(failure.cause).toBeUndefined(); expect(failure.response).toBeUndefined(); expect(failure.config).toBeUndefined();
    expect(failure.stack).not.toMatch(/private transport detail|private API payload|private OAuth credential/);
  });
  it("does not print unrecognized provider statuses or raw transport errors", async () => {
    const provider = new Error("private transport detail");
    provider.response = { data: { error: { status: "private provider status" } } };
    const request = createIndexRequest({ request: async () => { throw provider; } });
    await expect(request({ method: "GET", path: resource })).rejects.toThrow("read database, transport error");
    try { await request({ method: "GET", path: resource }); }
    catch (error) { expect(error.stack).not.toContain("private"); }
  });
});

describe("additive operator index preparation", () => {
  it.each(["preflight", "apply", "verify"])("uses the supported default list size in %s, including apply polling", async (mode) => {
    const api = fakeApi(mode === "apply" ? { initial: [], readyAfter: 1 } : {});
    const result = await prepare(api, { mode });
    expect(result.ready).toBe(true);
    const lists = api.calls.filter((call) => call.path.endsWith("/indexes") && call.method === "GET");
    expect(lists.length).toBeGreaterThanOrEqual(mode === "apply" ? 6 : 2);
    expect(lists.every((call) => (call.params?.pageSize ?? 0) === 0)).toBe(true);
    expect(api.writeCalls()).toHaveLength(mode === "apply" ? 4 : 0);
  });
  it("accepts default-size pages exceeding 100 entries without recreating READY indexes or changing extras", async () => {
    const extras = Array.from({ length: 125 }, (_, number) => index({ collectionGroup: "inventoryCheckpoints", queryScope: "COLLECTION",
      fields: [{ fieldPath: `extra${number}`, order: "ASCENDING" }, { fieldPath: "sequence", order: "ASCENDING" }] }, `extra-${number}`));
    const initial = [...extras, ...reviewed().map((definition, number) => index(definition, `required-${number}`))];
    const api = fakeApi({ initial });
    const result = await prepare(api, { mode: "apply" });
    expect(result.ready).toBe(true); expect(result.created).toBe(0);
    expect(api.writeCalls()).toEqual([]); expect(api.stored).toEqual(initial);
  });
  it.each([false, true])("refuses more than 2000 indexes per group before creation (paginated: %s)", async (paginated) => {
    const entries = Array.from({ length: 2001 }, (_, number) => index(reviewed()[0], `bounded-${number}`));
    const api = fakeApi({ pages: (call) => {
      if (call.path.includes("inventoryMovements")) return { indexes: [] };
      if (!paginated) return { indexes: entries };
      return call.params.pageToken ? { indexes: entries.slice(1500) } : { indexes: entries.slice(0, 1500), nextPageToken: "remaining" };
    } });
    await expect(prepare(api, { mode: "apply" })).rejects.toThrow("2000-index limit");
    expect(api.writeCalls()).toEqual([]);
  });
  it("read-only preflight reports missing indexes and preserves unrelated definitions", async () => {
    const extra = index({ collectionGroup: "inventoryMovements", queryScope: "COLLECTION", fields: [{ fieldPath: "actorUid", order: "ASCENDING" }, { fieldPath: "sequence", order: "ASCENDING" }] }, "unrelated");
    const api = fakeApi({ initial: [extra, index(reviewed()[0], "first")] });
    const result = await prepare(api);
    expect(result.ready).toBe(false); expect(result.created).toBe(0);
    expect(result.indexes.map((value) => value.state)).toEqual(["READY", "MISSING", "MISSING", "MISSING"]);
    expect(api.writeCalls()).toEqual([]); expect(api.stored).toContainEqual(extra);
  });
  it("creates only missing reviewed indexes and waits for all four READY without deleting extras", async () => {
    const extra = index({ collectionGroup: "inventoryCheckpoints", queryScope: "COLLECTION", fields: [{ fieldPath: "actorUid", order: "ASCENDING" }, { fieldPath: "sequence", order: "ASCENDING" }] }, "unrelated");
    const api = fakeApi({ initial: [extra, index(reviewed()[0], "first")], readyAfter: 2 }), progress = [];
    const result = await prepare(api, { mode: "apply", log: (value) => progress.push(value) });
    expect(result.ready).toBe(true); expect(result.created).toBe(3); expect(api.writeCalls()).toHaveLength(3);
    expect(api.writeCalls().every((call) => call.method === "POST" && Object.keys(call.body).join(",") === "queryScope,fields")).toBe(true);
    expect(progress.some((value) => value.includes("waiting without pausing"))).toBe(true);
    expect(api.stored).toContainEqual(extra);
  });
  it("does not recreate existing CREATING indexes and read-only verification requires READY", async () => {
    const api = fakeApi({ initial: reviewed().map((definition, number) => index(definition, `i-${number}`, "CREATING")), readyAfter: 2 });
    await expect(prepare(api, { mode: "verify" })).rejects.toThrow("must be READY");
    const result = await prepare(api, { mode: "apply" });
    expect(result.ready).toBe(true); expect(result.created).toBe(0); expect(api.writeCalls()).toEqual([]);
  });
  it.each(["NEEDS_REPAIR", "FAILED", "STATE_UNSPECIFIED"])("stops before any create on required index state %s", async (state) => {
    const api = fakeApi({ initial: [index(reviewed()[0], "failed", state)] });
    await expect(prepare(api, { mode: "apply" })).rejects.toThrow(`state ${state}`);
    expect(api.writeCalls()).toEqual([]);
  });
  it("reports asynchronous operation failure without printing provider error details", async () => {
    const api = fakeApi({ initial: [], operationFailure: true });
    await expect(prepare(api, { mode: "apply" })).rejects.toThrow("Index creation failed");
    try { await prepare(fakeApi({ initial: [], operationFailure: true }), { mode: "apply" }); }
    catch (error) { expect(error.message).not.toContain("private operation detail"); }
  });
  it("times out honestly when builds remain CREATING, retaining the additive builds for later retry", async () => {
    const api = fakeApi({ initial: [], readyAfter: 100 });
    await expect(prepare(api, { mode: "apply", timeoutMs: 200, pollIntervalMs: 100 })).rejects.toThrow("Timed out");
    expect(api.writeCalls()).toHaveLength(4); expect(api.stored).toHaveLength(4);
    expect(api.writeCalls().every((call) => call.method === "POST")).toBe(true);
  });
  it("handles concurrent create conflicts with verification rather than blind mutation retries", async () => {
    const api = fakeApi({ initial: [], createConflict: true, readyAfter: 1 });
    const result = await prepare(api, { mode: "apply" });
    expect(result.ready).toBe(true); expect(api.writeCalls()).toHaveLength(4);
  });
  it.each([
    { projectId: "another" }, { projectNumber: "123" }, { databaseId: "another" }, { operator: "another@example.com" }, { releaseSha: "main" },
  ])("rejects a different project/database/operator or unpinned release before any API call", async (patch) => {
    const api = fakeApi(); await expect(prepare(api, patch)).rejects.toThrow(); expect(api.calls).toEqual([]);
  });
  it.each([
    { name: "projects/another/databases/(default)" }, { type: "DATASTORE_MODE" }, { type: undefined }, { databaseEdition: "ENTERPRISE" },
    { databaseEdition: undefined }, { firestoreDataAccessMode: "DATA_ACCESS_MODE_DISABLED" }, { deleteTime: "2026-10-12T00:00:00Z" },
  ])("inspects edition/type and refuses incompatible or unknown database metadata before listing/creation", async (patch) => {
    const api = fakeApi({ db: { ...database(), ...patch } });
    await expect(prepare(api, { mode: "apply" })).rejects.toThrow("Standard edition");
    expect(api.calls).toHaveLength(1); expect(api.writeCalls()).toEqual([]);
  });
  it("reads all bounded list pages before deciding an index is missing", async () => {
    const api = fakeApi({ pages: (call, stored) => {
      const group = call.path.split("/").at(-2), selected = stored.filter((value) => value.collectionGroup === group);
      return call.params.pageToken ? { indexes: selected.slice(1) } : { indexes: selected.slice(0, 1), nextPageToken: "next" };
    } });
    const result = await prepare(api, { mode: "verify" });
    expect(result.ready).toBe(true); expect(api.calls.filter((call) => call.params?.pageToken === "next")).toHaveLength(2);
    expect(api.writeCalls()).toEqual([]);
  });
  it("rejects repeated pagination tokens and a mismatched index resource", async () => {
    const looping = fakeApi({ pages: () => ({ indexes: [], nextPageToken: "repeated" }) });
    await expect(prepare(looping, { mode: "apply" })).rejects.toThrow("repeated"); expect(looping.writeCalls()).toEqual([]);
    const foreign = fakeApi({ initial: [{ ...index(reviewed()[0], "i"), name: "projects/another/databases/(default)/collectionGroups/inventoryCheckpoints/indexes/i" }] });
    await expect(prepare(foreign, { mode: "apply" })).rejects.toThrow("unexpected resource"); expect(foreign.writeCalls()).toEqual([]);
  });
  it("bounds pagination and individual polling delays", async () => {
    let page = 0;
    const tooMany = fakeApi({ pages: () => ({ indexes: [], nextPageToken: `page-${++page}` }) });
    await expect(prepare(tooMany)).rejects.toThrow("20-page limit"); expect(tooMany.writeCalls()).toEqual([]);
    await expect(prepare(fakeApi(), { pollIntervalMs: 30001 })).rejects.toThrow("30 seconds");
    await expect(prepare(fakeApi(), { timeoutMs: 1800001 })).rejects.toThrow("30 minutes");
  });
});

describe("SaaS operator rollout integration", () => {
  it("downloads pinned index evidence and prepares READY indexes before pausing, then verifies before enable", () => {
    const source = readFileSync(new URL("../../scripts/firebase/rollout-saas-pilot.sh", import.meta.url), "utf8");
    expect(source).toContain("firebase/firestore.indexes.json"); expect(source).toContain("scripts/firebase/catalog-inventory-indexes.mjs");
    expect(source.indexOf("catalog-inventory-indexes.mjs apply")).toBeGreaterThan(source.indexOf('if [[ "$apply" != true ]]'));
    expect(source.indexOf("catalog-inventory-indexes.mjs apply")).toBeLessThan(source.indexOf("saas-rollout.mjs pause"));
    expect(source.indexOf("catalog-inventory-indexes.mjs verify")).toBeLessThan(source.indexOf("saas-rollout.mjs enable"));
    expect(source).toContain('${release_sha}');
  });
});
