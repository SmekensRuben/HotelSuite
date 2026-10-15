const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { createHotelMcpOAuthProvider, normalizeHotelMcpConfig } = require("./hotelMcpAuth");

const clock = 1_800_000_000_000;
const config = {
  enabled: true, issuerUrl: "https://mcp.example.com", appUrl: "https://app.example.com",
  clients: [{ client_id: "codex-private", client_name: "Codex", redirect_uris: ["http://127.0.0.1:3333/callback"], token_endpoint_auth_method: "none" }],
};

function fixture() {
  const records = new Map();
  const snapshot = (path) => ({ id: path.split("/").at(-1), exists: records.has(path), data: () => structuredClone(records.get(path)) });
  let queue = Promise.resolve();
  const db = {
    doc: (path) => ({ path, get: async () => snapshot(path), set: async (data) => { records.set(path, structuredClone(data)); }, update: async (data) => { records.set(path, { ...records.get(path), ...structuredClone(data) }); } }),
    collection: (path) => {
      const filters = [];
      const query = {
        where: (field, operator, value) => { filters.push((entry) => operator === "==" ? entry[field] === value : entry[field] > value); return query; },
        limit: () => query,
        get: async () => ({ docs: [...records.keys()].filter((key) => key.startsWith(`${path}/`) && filters.every((filter) => filter(records.get(key)))).map(snapshot) }),
      };
      return query;
    },
    runTransaction: (callback) => {
      const execute = async () => {
        const writes = [];
        const result = await callback({ get: (ref) => ref.get(), set: (ref, value) => writes.push(() => ref.set(value)), update: (ref, value) => writes.push(() => ref.update(value)) });
        for (const write of writes) await write();
        return result;
      };
      const result = queue.then(execute); queue = result.catch(() => {}); return result;
    },
  };
  let instant = clock;
  let user = { uid: "hotel-user", emailVerified: true, customClaims: { platformAdmin: true } };
  const auth = { getUser: async (uid) => { if (uid !== user.uid) throw new Error("Unknown user"); return user; } };
  const provider = createHotelMcpOAuthProvider({ db, auth, config, now: () => instant });
  const request = (data = {}, uid = "hotel-user") => ({ data, auth: { uid, token: { email_verified: true, auth_time: clock / 1000 } } });
  const client = provider.config.clients[0];
  const verifier = "a".repeat(64);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  async function begin({ scopes = ["hotel-toolkit:read", "hotel-toolkit:propose"], resource = new URL("https://mcp.example.com/mcp") } = {}) {
    let url;
    await provider.authorize(client, { redirectUri: client.redirect_uris[0], state: "client-state", codeChallenge: challenge, resource, scopes }, { redirect: (destination) => { url = destination; } });
    return new URL(url).searchParams.get("requestId");
  }
  async function grant() {
    const requestId = await begin();
    const decision = await provider.handlers.completeConsent(request({ requestId, approve: true }));
    const code = new URL(decision.redirectUrl).searchParams.get("code");
    const tokens = await provider.exchangeAuthorizationCode(client, code, undefined, client.redirect_uris[0], new URL("https://mcp.example.com/mcp"));
    return { requestId, code, tokens };
  }
  return { db, records, provider, client, request, begin, grant, verifier, challenge, auth,
    setUser: (next) => { user = next; }, setTime: (next) => { instant = next; } };
}

test("private MCP configuration requires HTTPS root issuer and explicit client redirect allowlists", () => {
  assert.equal(normalizeHotelMcpConfig({}).enabled, false);
  assert.equal(normalizeHotelMcpConfig(config).resourceUrl, "https://mcp.example.com/mcp");
  for (const change of [{ issuerUrl: "http://mcp.example.com" }, { issuerUrl: "https://mcp.example.com/path" }, { clients: [] }, { clients: [{ ...config.clients[0], redirect_uris: ["https://user:password@attacker.example/callback"] }] }, { clients: [{ ...config.clients[0], token_endpoint_auth_method: "client_secret_post", client_secret: "short" }] }]) {
    assert.throws(() => normalizeHotelMcpConfig({ ...config, ...change }));
  }
});

test("OAuth consent is personal, explicit, short-lived and shows only approved scope metadata", async () => {
  const f = fixture(); const requestId = await f.begin();
  assert.equal([...f.records.keys()].some((path) => path.includes(requestId)), false);
  const consent = await f.provider.handlers.getConsent(f.request({ requestId }));
  assert.equal(consent.client.name, "Codex");
  assert.equal(consent.client.redirectOrigin, "http://127.0.0.1:3333");
  assert.deepEqual(consent.scopes.map((scope) => scope.id), ["hotel-toolkit:read", "hotel-toolkit:propose"]);
  assert.equal([...f.records.keys()].some((path) => path.startsWith("hotelMcpOAuthConnections/")), false);
  const result = await f.provider.handlers.completeConsent(f.request({ requestId, approve: false }));
  const url = new URL(result.redirectUrl);
  assert.equal(url.searchParams.get("error"), "access_denied");
  assert.equal(url.searchParams.get("state"), "client-state");
  assert.equal(url.searchParams.get("iss"), "https://mcp.example.com/");
  assert.equal(url.searchParams.has("code"), false);
  await assert.rejects(f.provider.handlers.completeConsent(f.request({ requestId, approve: true })), { code: "failed-precondition" });
  const expired = await f.begin(); f.setTime(clock + 600_001);
  await assert.rejects(f.provider.handlers.getConsent(f.request({ requestId: expired })), { code: "failed-precondition" });
});

test("OAuth grants bind resource and supported scopes without implicit write consent", async () => {
  const f = fixture();
  for (const resource of [undefined, new URL("https://other.example/mcp")]) {
    await assert.rejects(f.provider.authorize(f.client, { resource, codeChallenge: f.challenge }, { redirect() {} }), { errorCode: "invalid_target" });
  }
  await assert.rejects(f.begin({ scopes: ["hotel-toolkit:propose"] }), { errorCode: "invalid_scope" });
  await assert.rejects(f.begin({ scopes: ["platform:admin"] }), { errorCode: "invalid_scope" });
  const id = await f.begin({ scopes: [] });
  assert.deepEqual((await f.provider.handlers.getConsent(f.request({ requestId: id }))).scopes.map((scope) => scope.id), ["hotel-toolkit:read"]);
});

test("authorization code is single-use, client-bound, redirect-bound and resource-bound", async () => {
  const f = fixture(); const id = await f.begin();
  const { redirectUrl } = await f.provider.handlers.completeConsent(f.request({ requestId: id, approve: true }));
  const code = new URL(redirectUrl).searchParams.get("code");
  assert.equal(await f.provider.challengeForAuthorizationCode(f.client, code), f.challenge);
  await assert.rejects(f.provider.challengeForAuthorizationCode({ client_id: "other" }, code), { errorCode: "invalid_grant" });
  await assert.rejects(f.provider.exchangeAuthorizationCode(f.client, code, undefined, "http://127.0.0.1:3333/wrong", new URL("https://mcp.example.com/mcp")), { errorCode: "invalid_grant" });
  await assert.rejects(f.provider.exchangeAuthorizationCode(f.client, code, undefined, f.client.redirect_uris[0], new URL("https://other.example/mcp")), { errorCode: "invalid_target" });
  const attempts = await Promise.allSettled([1, 2].map(() => f.provider.exchangeAuthorizationCode(f.client, code, undefined, f.client.redirect_uris[0], new URL("https://mcp.example.com/mcp"))));
  assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
  assert.equal(attempts.find((attempt) => attempt.status === "rejected").reason.errorCode, "invalid_grant");
});

test("only token hashes are persisted and verified requests carry current Firebase identity", async () => {
  const f = fixture(); const { tokens } = await f.grant();
  const stored = JSON.stringify([...f.records]);
  assert.equal(stored.includes(tokens.access_token), false);
  assert.equal(stored.includes(tokens.refresh_token), false);
  const info = await f.provider.verifyAccessToken(tokens.access_token);
  const request = await f.provider.toRequest(info);
  assert.equal(request.auth.uid, "hotel-user");
  assert.equal(request.auth.token.platformAdmin, true);
  assert.equal(request.mcpAuth.connectionId.length, 43);
  assert.deepEqual(request.mcpAuth.scopes, ["hotel-toolkit:read", "hotel-toolkit:propose"]);
  assert.equal(typeof request.mcpAuth.assertActive, "function");
  assert.equal(info.resource.href, "https://mcp.example.com/mcp");
  await assert.rejects(f.provider.verifyAccessToken(tokens.refresh_token), { errorCode: "invalid_token" });
});

test("rotating refresh tokens detect replay and revoke every access token in the connection", async () => {
  const f = fixture(); const { tokens } = await f.grant();
  const rotated = await f.provider.exchangeRefreshToken(f.client, tokens.refresh_token, undefined, new URL("https://mcp.example.com/mcp"));
  assert.notEqual(tokens.refresh_token, rotated.refresh_token);
  await f.provider.verifyAccessToken(rotated.access_token);
  await assert.rejects(f.provider.exchangeRefreshToken(f.client, tokens.refresh_token, undefined, new URL("https://mcp.example.com/mcp")), { errorCode: "invalid_grant" });
  for (const token of [tokens.access_token, rotated.access_token]) await assert.rejects(f.provider.verifyAccessToken(token), { errorCode: "invalid_token" });
});

test("refresh can narrow scopes and cannot restore previously removed write consent", async () => {
  const f = fixture(); const { tokens } = await f.grant();
  const readOnly = await f.provider.exchangeRefreshToken(f.client, tokens.refresh_token, ["hotel-toolkit:read"], new URL("https://mcp.example.com/mcp"));
  assert.deepEqual((await f.provider.verifyAccessToken(tokens.access_token)).scopes, ["hotel-toolkit:read"]);
  await assert.rejects(f.provider.exchangeRefreshToken(f.client, readOnly.refresh_token, ["hotel-toolkit:read", "hotel-toolkit:propose"], new URL("https://mcp.example.com/mcp")), { errorCode: "invalid_scope" });
});

test("disabled, unverified, deleted and Firebase-revoked identities invalidate existing tokens and in-flight actions", async () => {
  for (const change of [{ disabled: true }, { emailVerified: false }, { uid: "deleted" }, { tokensValidAfterTime: new Date(clock + 1000).toISOString() }]) {
    const f = fixture(); const { tokens } = await f.grant();
    const request = await f.provider.toRequest(await f.provider.verifyAccessToken(tokens.access_token));
    f.setUser({ uid: "hotel-user", emailVerified: true, ...change });
    await assert.rejects(f.provider.verifyAccessToken(tokens.access_token), { errorCode: "invalid_token" });
    await assert.rejects(request.mcpAuth.assertActive(), { errorCode: "invalid_token" });
    await assert.rejects(f.provider.exchangeRefreshToken(f.client, tokens.refresh_token, undefined, new URL("https://mcp.example.com/mcp")), { errorCode: "invalid_grant" });
  }
});

test("connection listing and revocation stay scoped to the authenticated account", async () => {
  const f = fixture(); const { tokens } = await f.grant();
  const result = await f.provider.handlers.listConnections(f.request());
  assert.equal(result.connections.length, 1);
  assert.equal(Object.hasOwn(result.connections[0], "uid"), false);
  assert.equal(Object.hasOwn(result.connections[0], "refreshHash"), false);
  f.setUser({ uid: "other-user", emailVerified: true });
  assert.equal((await f.provider.handlers.listConnections(f.request({}, "other-user"))).connections.length, 0);
  await assert.rejects(f.provider.handlers.revokeConnection(f.request({ connectionId: result.connections[0].id }, "other-user")), { code: "not-found" });
  f.setUser({ uid: "hotel-user", emailVerified: true });
  assert.deepEqual(await f.provider.handlers.revokeConnection(f.request({ connectionId: result.connections[0].id })), { revoked: true });
  await assert.rejects(f.provider.verifyAccessToken(tokens.access_token), { errorCode: "invalid_token" });
  assert.equal((await f.provider.handlers.listConnections(f.request())).connections.length, 0);
});

test("access and connection expiration are enforced without relying on Firestore TTL cleanup", async () => {
  const f = fixture(); const { tokens } = await f.grant();
  f.setTime(clock + 600_001);
  await assert.rejects(f.provider.verifyAccessToken(tokens.access_token), { errorCode: "invalid_token" });
  const rotated = await f.provider.exchangeRefreshToken(f.client, tokens.refresh_token, undefined, new URL("https://mcp.example.com/mcp"));
  f.setTime(clock + 30 * 24 * 60 * 60 * 1000 + 1);
  await assert.rejects(f.provider.exchangeRefreshToken(f.client, rotated.refresh_token, undefined, new URL("https://mcp.example.com/mcp")), { errorCode: "invalid_grant" });
});

test("connection listing reports incomplete index setup without hiding grants and recovers after preparation", async () => {
  const f = fixture(); await f.grant();
  const originalCollection = f.db.collection;
  let queryFailure = Object.assign(new Error("9 FAILED_PRECONDITION: The query requires an index. https://console.firebase.google.com/private-user"), { code: 9 }), reads = 0;
  const clauses = [];
  f.db.collection = (path) => {
    assert.equal(path, "hotelMcpOAuthConnections");
    const query = originalCollection(path), get = query.get, where = query.where, limit = query.limit;
    query.where = (...args) => { clauses.push(args); return where(...args); };
    query.limit = (value) => { assert.equal(value, 100); return limit(value); };
    query.get = async () => { reads += 1; if (queryFailure) throw queryFailure; return get(); };
    return query;
  };
  const before = JSON.stringify([...f.records]);
  await assert.rejects(f.provider.handlers.listConnections(f.request()), (error) => {
    assert.equal(error.code, "failed-precondition");
    assert.deepEqual(error.details, { reason: "mcp-index-required", area: "connections", indexKey: "hotelMcpOAuthConnections" });
    assert.equal(error.message.includes("private-user"), false);
    return true;
  });
  assert.deepEqual(clauses, [["uid", "==", "hotel-user"], ["revokedAt", "==", null], ["expiresAtMs", ">", clock]]);
  assert.equal(reads, 1); assert.equal(JSON.stringify([...f.records]), before);
  queryFailure = null;
  assert.equal((await f.provider.handlers.listConnections(f.request())).connections.length, 1);
  assert.equal(JSON.stringify([...f.records]), before);
  queryFailure = Object.assign(new Error("Unavailable"), { code: 14 });
  await assert.rejects(f.provider.handlers.listConnections(f.request()), (error) => error === queryFailure);
  f.setUser({ uid: "hotel-user", emailVerified: true, disabled: true });
  const beforeDenied = reads;
  await assert.rejects(f.provider.handlers.listConnections(f.request()), { code: "permission-denied" });
  assert.equal(reads, beforeDenied);
});
