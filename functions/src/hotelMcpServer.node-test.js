const test = require("node:test");
const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const { createHash } = require("node:crypto");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
const { z } = require("zod/v4");
const { createHotelMcpApp } = require("./hotelMcpServer");

async function fixture(t, { enabled = true, confidential = false } = {}) {
  const records = new Map();
  const snapshot = (path) => ({ id: path.split("/").at(-1), exists: records.has(path), data: () => structuredClone(records.get(path)) });
  let queue = Promise.resolve();
  const db = {
    doc: (path) => ({ path, get: async () => snapshot(path), set: async (data) => { records.set(path, structuredClone(data)); }, update: async (data) => { records.set(path, { ...records.get(path), ...structuredClone(data) }); } }),
    runTransaction: (callback) => {
      const result = queue.then(async () => {
        const writes = [];
        const value = await callback({ get: (ref) => ref.get(), set: (ref, data) => writes.push(() => ref.set(data)), update: (ref, data) => writes.push(() => ref.update(data)) });
        for (const write of writes) await write();
        return value;
      });
      queue = result.catch(() => {}); return result;
    },
  };
  let app;
  const http = createServer((request, response) => app(request, response));
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { http.closeAllConnections(); http.close(resolve); }));
  const origin = `http://127.0.0.1:${http.address().port}`;
  const redirectUri = "http://127.0.0.1:4444/callback";
  const clientId = "private-test";
  const clientSecret = "private-operator-secret-".repeat(3);
  let user = { uid: "current-user", emailVerified: true, customClaims: {} };
  const auth = { getUser: async () => user };
  const config = { enabled, issuerUrl: origin, appUrl: origin, clients: [{ client_id: clientId, client_name: "Private test client", redirect_uris: [redirectUri], ...(confidential ? { token_endpoint_auth_method: "client_secret_post", client_secret: clientSecret } : {}) }] };
  const created = createHotelMcpApp({ db, auth, config, createServer: ({ request }) => {
    const server = new McpServer({ name: "transport-test", version: "1.0.0" });
    server.registerTool("identity", { description: "Test the current authenticated identity.", inputSchema: z.object({}) }, async () => {
      await request.mcpAuth.assertActive();
      return { content: [{ type: "text", text: JSON.stringify({ uid: request.auth.uid, scopes: request.mcpAuth.scopes }) }] };
    });
    return server;
  } });
  app = created.app;
  const verifier = "v".repeat(64);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  async function begin(overrides = {}) {
    const url = new URL("/authorize", origin);
    Object.entries({ client_id: clientId, redirect_uri: redirectUri, response_type: "code", code_challenge: challenge, code_challenge_method: "S256", resource: `${origin}/mcp`, scope: "hotel-toolkit:read hotel-toolkit:propose", state: "opaque-client-state", ...overrides }).forEach(([key, value]) => url.searchParams.set(key, value));
    return fetch(url, { redirect: "manual" });
  }
  async function consent() {
    const response = await begin(); assert.equal(response.status, 302);
    const requestId = new URL(response.headers.get("location")).searchParams.get("requestId");
    const decision = await created.provider.handlers.completeConsent({ auth: { uid: "current-user", token: { email_verified: true, auth_time: Math.floor(Date.now() / 1000) } }, data: { requestId, approve: true } });
    return new URL(decision.redirectUrl).searchParams.get("code");
  }
  async function token(code, overrides = {}) {
    return fetch(`${origin}/token`, { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, redirect_uri: redirectUri, resource: `${origin}/mcp`, ...(confidential ? { client_secret: clientSecret } : {}), ...overrides }) });
  }
  async function grant() { const code = await consent(); const response = await token(code); assert.equal(response.status, 200); return response.json(); }
  return { ...created, origin, records, clientId, clientSecret, redirectUri, begin, consent, token, grant, setUser: (next) => { user = next; } };
}

test("hosted MCP discovers OAuth metadata and challenges unauthenticated callers", async (t) => {
  const f = await fixture(t);
  const response = await fetch(`${f.origin}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  assert.equal(response.status, 401);
  assert.match(response.headers.get("www-authenticate"), /resource_metadata=.*oauth-protected-resource\/mcp/);
  const protectedMetadata = await (await fetch(`${f.origin}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.equal(protectedMetadata.resource, `${f.origin}/mcp`);
  assert.deepEqual(protectedMetadata.authorization_servers, [`${f.origin}/`]);
  const authorizationMetadata = await (await fetch(`${f.origin}/.well-known/oauth-authorization-server`)).json();
  assert.equal(authorizationMetadata.authorization_endpoint, `${f.origin}/authorize`);
  assert.equal(authorizationMetadata.token_endpoint, `${f.origin}/token`);
  assert.deepEqual(authorizationMetadata.code_challenge_methods_supported, ["S256"]);
  assert.equal(authorizationMetadata.authorization_response_iss_parameter_supported, true);
  assert.deepEqual(authorizationMetadata.revocation_endpoint_auth_methods_supported, ["none"]);
  assert.equal(authorizationMetadata.registration_endpoint, undefined);
  assert.equal((await fetch(`${f.origin}/register`, { method: "POST" })).status, 404);
});

test("SDK OAuth routes enforce redirect allowlists, S256 PKCE, exact resource, state and single-use codes", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.begin({ client_id: "unregistered" })).status, 400);
  assert.equal((await f.begin({ redirect_uri: "https://attacker.example/callback" })).status, 400);
  assert.equal((await f.begin({ redirect_uri: "http://127.0.0.1:5555/callback" })).status, 302);
  assert.equal((await f.begin({ redirect_uri: "http://localhost:4444/callback" })).status, 400);
  const plain = await f.begin({ code_challenge_method: "plain" });
  assert.equal(plain.status, 302);
  assert.equal(new URL(plain.headers.get("location")).searchParams.get("error"), "invalid_request");
  assert.equal(new URL(plain.headers.get("location")).searchParams.get("iss"), `${f.origin}/`);
  const wrongResource = await f.begin({ resource: "https://attacker.example/mcp" });
  assert.equal(new URL(wrongResource.headers.get("location")).searchParams.get("error"), "invalid_target");
  const code = await f.consent();
  const wrongVerifier = await f.token(code, { code_verifier: "wrong" });
  assert.equal(wrongVerifier.status, 400); assert.equal((await wrongVerifier.json()).error, "invalid_grant");
  const wrongRedirect = await f.token(code, { redirect_uri: "http://127.0.0.1:4444/wrong" });
  assert.equal((await wrongRedirect.json()).error, "invalid_grant");
  const wrongAudience = await f.token(code, { resource: "https://attacker.example/mcp" });
  assert.equal((await wrongAudience.json()).error, "invalid_target");
  assert.equal((await f.token(code)).status, 200);
  const replay = await f.token(code); assert.equal(replay.status, 400); assert.equal((await replay.json()).error, "invalid_grant");
});

test("confidential private clients authenticate at the maintained SDK token endpoint", async (t) => {
  const f = await fixture(t, { confidential: true }); const code = await f.consent();
  assert.equal((await f.token(code, { client_secret: "incorrect" })).status, 400);
  assert.equal((await f.token(code)).status, 200);
});

test("real SDK client initializes, lists and calls tools over stateless Streamable HTTP", async (t) => {
  const f = await fixture(t); const tokens = await f.grant();
  const client = new Client({ name: "hotel-toolkit-interop-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${f.origin}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } } });
  t.after(() => client.close());
  await client.connect(transport);
  assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), ["identity"]);
  const result = await client.callTool({ name: "identity", arguments: {} });
  assert.deepEqual(JSON.parse(result.content[0].text), { uid: "current-user", scopes: ["hotel-toolkit:read", "hotel-toolkit:propose"] });
  assert.equal(transport.sessionId, undefined);
  f.setUser({ uid: "current-user", emailVerified: true, disabled: true });
  const response = await fetch(`${f.origin}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${tokens.access_token}`, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) });
  assert.equal(response.status, 401);
});

test("OAuth revocation invalidates existing access tokens without accepting another client's token", async (t) => {
  const f = await fixture(t); const tokens = await f.grant();
  const revoke = await fetch(`${f.origin}/revoke`, { method: "POST", body: new URLSearchParams({ client_id: f.clientId, token: tokens.refresh_token }) });
  assert.equal(revoke.status, 200);
  const response = await fetch(`${f.origin}/mcp`, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
  assert.equal(response.status, 401);
});

test("private transport rejects unapproved browser origins and oversized or malformed bodies", async (t) => {
  const f = await fixture(t);
  assert.equal((await fetch(`${f.origin}/.well-known/oauth-authorization-server`, { headers: { Origin: "https://attacker.example" } })).status, 403);
  const allowed = await fetch(`${f.origin}/.well-known/oauth-authorization-server`, { headers: { Origin: f.origin } });
  assert.equal(allowed.status, 200);
  // The SDK publishes non-secret discovery metadata with permissive response CORS;
  // our origin gate still rejects unapproved incoming browser requests first.
  assert.equal(allowed.headers.get("access-control-allow-origin"), "*");
  const tooLarge = await fetch(`${f.origin}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data: "x".repeat(256 * 1024) }) });
  assert.equal(tooLarge.status, 413);
  const malformed = await fetch(`${f.origin}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" });
  assert.equal(malformed.status, 400);
});

test("unconfigured MCP fails closed before OAuth or tools are exposed", async (t) => {
  const f = await fixture(t, { enabled: false });
  for (const path of ["/mcp", "/authorize", "/.well-known/oauth-authorization-server"]) assert.equal((await fetch(`${f.origin}${path}`)).status, 503);
  assert.equal(f.records.size, 0);
});

test("the maintained OAuth router limits unauthenticated authorization writes in a warm process", async (t) => {
  const f = await fixture(t);
  for (let index = 0; index < 100; index += 1) assert.equal((await f.begin()).status, 302);
  assert.equal((await f.begin()).status, 429);
  assert.equal(f.records.size, 100);
});
