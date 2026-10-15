const test = require("node:test");
const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const express = require("express");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const { isMcpIndexError, readMcpIndexQuery } = require("./hotelMcpQuery");

const missing = () => Object.assign(new Error("9 FAILED_PRECONDITION: The query requires an index. Create it at https://console.firebase.google.com/project/private-project/firestore/indexes?create_composite=private-user-query"), { code: 9 });

test("MCP query recovery recognizes only missing or building indexes with a failed-precondition status", () => {
  for (const error of [missing(),
    { code: "FAILED_PRECONDITION", message: "The index is currently building and cannot be used yet." },
    { code: "failed-precondition", message: "The required index does not exist." },
    { code: "firestore/failed-precondition", message: "The query requires a composite index." },
    { code: "9", message: "9 FAILED_PRECONDITION", details: "The index is still being built." }]) assert.equal(isMcpIndexError(error), true);
  for (const error of [null, new Error("The query requires an index."),
    { code: 7, message: "The query requires an index." }, { code: 14, message: "The index is building." },
    { code: 9, message: "The database is not in the required state." },
    { code: "failed-precondition", message: "The index configuration changed." },
    { code: 9, message: "The required index is corrupt." }]) assert.equal(isMcpIndexError(error), false);
});

test("recognized MCP index errors expose only stable setup metadata and safe recovery copy", async () => {
  for (const [area, indexKey] of [["connections", "hotelMcpOAuthConnections"], ["proposals", "hotelMcpProposalBatches"]]) {
    let calls = 0;
    await assert.rejects(readMcpIndexQuery(area, async () => { calls += 1; throw missing(); }), (error) => {
      assert.ok(error instanceof HttpsError);
      assert.equal(error.code, "failed-precondition");
      assert.deepEqual(error.details, { reason: "mcp-index-required", area, indexKey });
      assert.match(error.message, /Ask your operator to finish setup, then retry/);
      assert.match(error.message, /have not been changed/);
      const wire = JSON.stringify(error.toJSON());
      for (const secret of ["console.firebase.google.com", "private-project", "private-user-query", "create_composite"]) assert.equal(wire.includes(secret), false);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test("unrelated preconditions, permission failures and unavailable queries retain their original error", async () => {
  for (const failure of [Object.assign(new Error("The database is not in the required state."), { code: 9 }),
    Object.assign(new Error("Permission denied."), { code: 7 }),
    Object.assign(new Error("The service is unavailable."), { code: 14 }),
    new HttpsError("permission-denied", "Current hotel access is required.")]) {
    await assert.rejects(readMcpIndexQuery("proposals", async () => { throw failure; }), (error) => error === failure);
  }
});

test("the installed callable HTTP wrapper masks raw index failures as 500 and preserves the new recovery error", async (t) => {
  t.mock.method(logger, "error", () => {});
  t.mock.method(logger, "debug", () => {});
  const app = express(); app.use(express.json());
  app.post("/raw", onCall({ cors: false }, async () => { throw missing(); }));
  app.post("/recovery", onCall({ cors: false }, async () => readMcpIndexQuery("proposals", async () => { throw missing(); })));
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const invoke = (path) => fetch(`${origin}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data: {} }) });
  const raw = await invoke("/raw");
  assert.equal(raw.status, 500);
  assert.deepEqual(await raw.json(), { error: { message: "INTERNAL", status: "INTERNAL" } });
  const recovery = await invoke("/recovery");
  assert.equal(recovery.status, 400);
  const result = await recovery.json();
  assert.equal(result.error.status, "FAILED_PRECONDITION");
  assert.deepEqual(result.error.details, { reason: "mcp-index-required", area: "proposals", indexKey: "hotelMcpProposalBatches" });
  assert.match(result.error.message, /Saved proposals have not been changed/);
  assert.equal(JSON.stringify(result).includes("private-user-query"), false);
});
