// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { prepareHotelMcpIndexes, HOTEL_MCP_INDEXES, MCP_INDEX_PROJECT, MCP_INDEX_PROJECT_NUMBER,
  mcpIndexSignature, parseHotelMcpIndexArgs, createHotelMcpIndexRequest } from "../../scripts/firebase/hotel-mcp-indexes.mjs";

const resource = "projects/hotel-toolkit/databases/(default)";
const indexResource = (group, id) => `${resource}/collectionGroups/${group}/indexes/${id}`;
const database = { name: resource, type: "FIRESTORE_NATIVE", databaseEdition: "STANDARD" };
const live = (definition, id, state = "READY") => ({ ...structuredClone(definition), name: indexResource(definition.collectionGroup, id), state });
const config = () => JSON.parse(readFileSync("firebase/firestore.indexes.json", "utf8"));
function fixture(initial = [], { readyAfter = 0, pages, createError, operationError } = {}) {
  const stored = structuredClone(initial), calls = [], waits = [];
  let instant = 0, listings = 0;
  const request = async call => {
    calls.push(structuredClone(call));
    if (call.method === "GET" && call.path === resource) return database;
    if (call.method === "GET" && call.path === `${resource}/collectionGroups/-/indexes`) {
      listings++;
      if (pages) return pages(call.params, listings);
      return { indexes: stored.map(index => ({ ...index, state: index.state === "CREATING" && waits.length >= readyAfter ? "READY" : index.state })) };
    }
    if (call.method === "POST") {
      if (createError) return createError(call, stored);
      const group = call.path.split("/").at(-2), id = `new-${stored.length}`;
      stored.push(live({ collectionGroup: group, ...call.body }, id, "CREATING"));
      return { name: `${resource}/operations/${id}` };
    }
    if (call.method === "GET" && call.path.startsWith(`${resource}/operations/`)) return { name: call.path, ...(operationError ? { error: operationError } : {}) };
    throw new Error("Unexpected API operation");
  };
  return { calls, stored, waits, prepare: options => prepareHotelMcpIndexes({ request, projectId: MCP_INDEX_PROJECT,
    projectNumber: MCP_INDEX_PROJECT_NUMBER, now: () => instant, sleep: async ms => { waits.push(ms); instant += ms; }, ...options }) };
}

describe("MCP-only index preparation", () => {
  it("embeds exactly the two reviewed MCP indexes from the versioned manifest", () => {
    expect(HOTEL_MCP_INDEXES).toEqual(config().indexes.filter(index => index.collectionGroup.startsWith("hotelMcp")));
    expect(HOTEL_MCP_INDEXES).toHaveLength(2);
  });

  it("reports missing indexes without writes or waits in preflight", async () => {
    const api = fixture(); const result = await api.prepare({ mode: "preflight" });
    expect(result).toMatchObject({ projectId: "hotel-toolkit", databaseId: "(default)", mode: "preflight", ready: false, created: 0 });
    expect(result.indexes.map(index => index.state)).toEqual(["MISSING", "MISSING"]);
    expect(api.calls.every(call => call.method === "GET")).toBe(true);
    expect(api.waits).toEqual([]);
    await expect(api.prepare({ mode: "verify" })).rejects.toThrow("Both MCP indexes must be READY");
    expect(api.calls.every(call => call.method === "GET")).toBe(true);
  });

  it("verifies existing indexes with implicit document-name ordering without changing unrelated indexes", async () => {
    const connections = live(HOTEL_MCP_INDEXES[0], "connections");
    connections.fields.push({ fieldPath: "__name__", order: "ASCENDING" });
    const proposals = live(HOTEL_MCP_INDEXES[1], "proposals");
    const other = live(config().indexes[0], "inventory");
    const api = fixture([connections, proposals, other]);
    const result = await api.prepare({ mode: "verify" });
    expect(result.ready).toBe(true); expect(result.created).toBe(0);
    expect(result.indexes.map(index => index.name)).toEqual([connections.name, proposals.name]);
    expect(api.calls.every(call => call.method === "GET")).toBe(true);
  });

  it("preserves descending document-name cursor direction and query scope", async () => {
    const wrongDirection = live(HOTEL_MCP_INDEXES[1], "wrong"); wrongDirection.fields.at(-1).order = "ASCENDING";
    expect(mcpIndexSignature(wrongDirection)).not.toBe(mcpIndexSignature(HOTEL_MCP_INDEXES[1]));
    const wrongScope = live(HOTEL_MCP_INDEXES[0], "wrong-scope"); wrongScope.queryScope = "COLLECTION_GROUP";
    const api = fixture([wrongDirection, wrongScope]);
    expect((await api.prepare()).indexes.map(index => index.state)).toEqual(["MISSING", "MISSING"]);
  });

  it("creates only missing reviewed indexes and waits until READY without deleting other indexes", async () => {
    const retained = live(HOTEL_MCP_INDEXES[0], "existing");
    const unrelated = live(config().indexes[0], "inventory");
    const api = fixture([retained, unrelated], { readyAfter: 1 });
    const result = await api.prepare({ mode: "apply" });
    expect(result).toMatchObject({ ready: true, created: 1 });
    expect(api.calls.filter(call => call.method === "POST")).toEqual([{ method: "POST",
      path: `${resource}/collectionGroups/hotelMcpProposalBatches/indexes`,
      body: { queryScope: "COLLECTION", fields: HOTEL_MCP_INDEXES[1].fields } }]);
    expect(api.calls.every(call => ["GET", "POST"].includes(call.method))).toBe(true);
    expect(api.stored.slice(0, 2)).toEqual([retained, unrelated]);
    expect(api.waits).toEqual([15000]);
  });

  it("resumes CREATING indexes and does not recreate READY indexes", async () => {
    const api = fixture(HOTEL_MCP_INDEXES.map((index, i) => live(index, `old-${i}`, i ? "CREATING" : "READY")), { readyAfter: 1 });
    expect(await api.prepare({ mode: "apply" })).toMatchObject({ ready: true, created: 0 });
    expect(api.calls.every(call => call.method === "GET")).toBe(true);
  });

  it("handles concurrent creation by checking serving metadata rather than retrying POST", async () => {
    const api = fixture([], { createError(call, stored) {
      stored.push(live({ collectionGroup: call.path.split("/").at(-2), ...call.body }, `concurrent-${stored.length}`));
      throw Object.assign(new Error("Concurrent creation"), { status: 409 });
    } });
    expect(await api.prepare({ mode: "apply" })).toMatchObject({ ready: true, created: 0 });
    expect(api.calls.filter(call => call.method === "POST")).toHaveLength(2);
  });

  it("surfaces failed build operations without exposing provider details or replacing indexes", async () => {
    const api = fixture([], { operationError: { message: "private-provider-detail" } });
    await expect(api.prepare({ mode: "apply" })).rejects.toThrow("MCP index build failed");
    expect(api.calls.every(call => ["GET", "POST"].includes(call.method))).toBe(true);
  });

  it("bounds waits even when time does not advance and leaves building indexes intact", async () => {
    const api = fixture(HOTEL_MCP_INDEXES.map((index, i) => live(index, `building-${i}`, "CREATING")), { readyAfter: Infinity });
    await expect(api.prepare({ mode: "apply", timeoutMs: 20, pollIntervalMs: 10, now: () => 0 })).rejects.toThrow("Timed out");
    expect(api.waits).toEqual([10, 10]);
    expect(api.calls.every(call => call.method === "GET")).toBe(true);
  });

  it.each(["NEEDS_REPAIR", "FAILED", "STATE_UNSPECIFIED"])("stops before any creation when a required index is %s", async state => {
    const api = fixture([live(HOTEL_MCP_INDEXES[0], "bad", state)]);
    await expect(api.prepare({ mode: "apply" })).rejects.toThrow("operator repair");
    expect(api.calls.every(call => call.method === "GET")).toBe(true);
  });

  it.each([{ projectId: "other" }, { projectNumber: "123" }, { databaseId: "other" }, { mode: "delete" },
    { timeoutMs: 1800001 }, { pollIntervalMs: 30001 }])("rejects unsafe target or bounds before API reads: %j", async options => {
    const api = fixture(); await expect(api.prepare(options)).rejects.toThrow(); expect(api.calls).toEqual([]);
  });

  it.each([{ type: "DATASTORE_MODE" }, { databaseEdition: "ENTERPRISE" }, { name: "projects/other/databases/(default)" },
    { firestoreDataAccessMode: "DATA_ACCESS_MODE_DISABLED" }, { deleteTime: "2026-10-15T00:00:00Z" }])("rejects an unexpected database: %j", async changed => {
    const request = vi.fn().mockResolvedValue({ ...database, ...changed });
    await expect(prepareHotelMcpIndexes({ request, projectId: MCP_INDEX_PROJECT, projectNumber: MCP_INDEX_PROJECT_NUMBER })).rejects.toThrow("existing Standard edition");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("follows default-sized metadata pages without losing indexes from other groups", async () => {
    const api = fixture([], { pages(params) {
      expect(params).not.toHaveProperty("pageSize");
      return params.pageToken ? { indexes: [live(HOTEL_MCP_INDEXES[1], "proposals")] }
        : { indexes: [live(HOTEL_MCP_INDEXES[0], "connections")], nextPageToken: "next-page" };
    } });
    expect((await api.prepare({ mode: "verify" })).ready).toBe(true);
    expect(api.calls.at(-1).params).toEqual({ pageToken: "next-page" });
  });

  it.each([
    ["repeated token", () => ({ nextPageToken: "repeated" }), "pagination token"],
    ["too many pages", (_params, page) => ({ nextPageToken: `next-${page}` }), "20-page"],
    ["too many indexes", () => ({ indexes: Array(2001).fill(live(HOTEL_MCP_INDEXES[0], "many")) }), "2000-index"],
    ["wrong project", () => ({ indexes: [{ ...live(HOTEL_MCP_INDEXES[0], "foreign"), name: "projects/other/databases/(default)/collectionGroups/hotelMcpOAuthConnections/indexes/id" }] }), "unexpected resource"],
    ["malformed response", () => ({ indexes: {} }), "metadata response"],
    ["duplicate indexes", () => ({ indexes: [live(HOTEL_MCP_INDEXES[0], "one"), live(HOTEL_MCP_INDEXES[0], "two")] }), "Duplicate"],
  ])("rejects %s without any writes", async (_label, pages, message) => {
    const api = fixture([], { pages });
    await expect(api.prepare({ mode: "apply" })).rejects.toThrow(message);
    expect(api.calls.every(call => call.method === "GET")).toBe(true);
  });
});

describe("standalone operator boundaries", () => {
  it.each(["preflight", "apply", "verify"])("requires explicit project selection for %s", mode => {
    expect(parseHotelMcpIndexArgs([mode, "--project", "hotel-toolkit"])).toBe(mode);
    expect(() => parseHotelMcpIndexArgs([mode])).toThrow("--project hotel-toolkit");
    expect(() => parseHotelMcpIndexArgs([mode, "--project", "test-breakfast"])).toThrow("Usage");
  });

  it("rejects extra options before looking up gcloud or contacting Google", () => {
    expect(() => execFileSync(process.execPath, ["scripts/firebase/hotel-mcp-indexes.mjs", "apply", "--project", "hotel-toolkit", "--force"],
      { encoding: "utf8", env: { PATH: "/missing" }, stdio: ["ignore", "pipe", "pipe"] })).toThrow("Usage:");
  });

  it("uses short-lived in-memory bearer authentication and explicit quota project without forwarding tokens into URLs or output", async () => {
    const token = "private-test-token", calls = [];
    const request = createHotelMcpIndexRequest(token, async (url, options) => {
      calls.push({ url: url.href, options }); return { ok: true, json: async () => ({ indexes: [] }) };
    });
    await request({ method: "GET", path: `${resource}/collectionGroups/-/indexes`, params: { pageToken: "next" } });
    expect(calls[0].url).toBe(`https://firestore.googleapis.com/v1/${resource}/collectionGroups/-/indexes?pageToken=next`);
    expect(calls[0].url).not.toContain(token);
    expect(calls[0].options.headers).toMatchObject({ Authorization: `Bearer ${token}`, "X-Goog-User-Project": "hotel-toolkit" });
    expect(calls[0].options.signal).toBeInstanceOf(AbortSignal);
  });

  it("sanitizes HTTP, transport and invalid JSON failures without printing provider messages or credentials", async () => {
    const marker = "private-provider-credential-marker";
    for (const fetcher of [async () => { throw new Error(marker); }, async () => ({ ok: false, status: 403, json: async () => ({ error: { message: marker } }) }),
      async () => ({ ok: true, json: async () => { throw new Error(marker); } })]) {
      const request = createHotelMcpIndexRequest(marker, fetcher);
      try { await request({ method: "GET", path: resource }); throw new Error("Expected failure"); }
      catch (error) { expect(error.message).not.toContain(marker); expect(error.message).toContain("Firestore index administration"); }
    }
  });
});
