const { randomBytes, createHash } = require("node:crypto");
const { HttpsError } = require("firebase-functions/v2/https");
const {
  InvalidGrantError, InvalidScopeError, InvalidTargetError, InvalidTokenError,
} = require("@modelcontextprotocol/sdk/server/auth/errors.js");
const { requireCurrentVerifiedUser } = require("./validation");
const { normalizeHotelMcpConfig } = require("./hotelMcpConfig");

const MCP_SCOPES = Object.freeze([
  { id: "hotel-toolkit:read", label: "Read permitted product data", description: "Discover accessible hotels and read product and reference data allowed by your current hotel permissions." },
  { id: "hotel-toolkit:propose", label: "Prepare product proposals", description: "Save product proposals for human review in Hotel Toolkit. This never approves or publishes products." },
]);
const ACCESS_MS = 10 * 60 * 1000;
const CONNECTION_MS = 30 * 24 * 60 * 60 * 1000;
const CONSENT_MS = 10 * 60 * 1000;
const CODE_MS = 60 * 1000;
const OPAQUE_ID = /^[A-Za-z0-9_-]{43}$/;
const opaque = () => randomBytes(32).toString("base64url");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const expiry = (milliseconds) => ({ expiresAt: new Date(milliseconds), expiresAtMs: milliseconds });

function validScopes(values) {
  const scopes = values?.length ? [...new Set(values)] : [MCP_SCOPES[0].id];
  if (scopes.some((scope) => !MCP_SCOPES.some((entry) => entry.id === scope))
    || (scopes.includes("hotel-toolkit:propose") && !scopes.includes("hotel-toolkit:read"))) {
    throw new InvalidScopeError("Request supported scopes; preparing proposals also requires read access.");
  }
  return scopes;
}

function requireOpaque(value, field) {
  if (typeof value !== "string" || !OPAQUE_ID.test(value)) throw new HttpsError("invalid-argument", `${field} is invalid.`);
  return value;
}

function createHotelMcpOAuthProvider({ db, auth, config: rawConfig, now = Date.now }) {
  const config = normalizeHotelMcpConfig(rawConfig);
  const ref = (kind, value) => db.doc(`hotelMcpOAuth${kind}/${hash(value)}`);
  const connectionRef = (id) => db.doc(`hotelMcpOAuthConnections/${id}`);
  function requireEnabled() {
    if (!config.enabled) throw new HttpsError("failed-precondition", "The private Hotel Toolkit MCP connection is not configured.");
  }
  function requireResource(resource) {
    if (!resource || String(resource) !== config.resourceUrl) throw new InvalidTargetError("Use the configured Hotel Toolkit MCP resource URL.");
  }
  async function currentConnection(id, reader = (document) => document.get()) {
    const snapshot = await reader(connectionRef(id));
    const connection = snapshot.exists ? snapshot.data() : null;
    if (!connection || connection.revokedAt || connection.expiresAtMs <= now()
      || connection.resource !== config.resourceUrl || !config.clients.some((client) => client.client_id === connection.clientId)) {
      throw new InvalidTokenError("This connection has expired or was revoked.");
    }
    let user;
    try { user = await auth.getUser(connection.uid); } catch { throw new InvalidTokenError("This account is no longer available."); }
    const revokedAt = Date.parse(user?.tokensValidAfterTime || "");
    if (!user || user.uid !== connection.uid || user.disabled || user.emailVerified !== true
      || !Number.isFinite(connection.authTime)
      || (Number.isFinite(revokedAt) && connection.authTime * 1000 < revokedAt)) {
      throw new InvalidTokenError("The current account no longer permits this connection.");
    }
    return { connection, user };
  }
  function tokensFor(connection, id, accessToken, refreshToken, instant) {
    const common = { connectionId: id, uid: connection.uid, clientId: connection.clientId, resource: connection.resource, scopes: connection.scopes };
    return {
      access: { ...common, kind: "access", issuedAt: instant, ...expiry(Math.min(instant + ACCESS_MS, connection.expiresAtMs)) },
      refresh: { ...common, kind: "refresh", issuedAt: instant, usedAt: null, ...expiry(connection.expiresAtMs) },
      response: { access_token: accessToken, refresh_token: refreshToken, token_type: "Bearer", expires_in: Math.floor(Math.min(ACCESS_MS, connection.expiresAtMs - instant) / 1000), scope: connection.scopes.join(" ") },
    };
  }
  const provider = {
    config,
    clientsStore: { async getClient(id) { requireEnabled(); return config.clients.find((client) => client.client_id === id); } },
    async authorize(client, params, response) {
      requireEnabled();
      requireResource(params.resource);
      const scopes = validScopes(params.scopes);
      if (!/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge)) throw new InvalidGrantError("A valid S256 PKCE challenge is required.");
      if (params.state && (params.state.length > 1024 || /[\u0000-\u001f]/.test(params.state))) throw new InvalidGrantError("The OAuth state is invalid.");
      const requestId = opaque();
      const instant = now();
      await ref("Authorizations", requestId).set({
        clientId: client.client_id, redirectUri: params.redirectUri, state: params.state || "", scopes,
        codeChallenge: params.codeChallenge, resource: config.resourceUrl, createdAt: instant,
        usedAt: null, ...expiry(instant + CONSENT_MS),
      });
      const destination = new URL(`${config.appUrl}/mcp/authorize`);
      destination.searchParams.set("requestId", requestId);
      response.redirect(destination.href);
    },
    async challengeForAuthorizationCode(client, authorizationCode) {
      if (typeof authorizationCode !== "string" || !OPAQUE_ID.test(authorizationCode)) throw new InvalidGrantError("Invalid authorization code.");
      const snapshot = await ref("Codes", authorizationCode).get();
      const code = snapshot.exists ? snapshot.data() : null;
      if (!code || code.clientId !== client.client_id || code.usedAt || code.expiresAtMs <= now()) throw new InvalidGrantError("Invalid or expired authorization code.");
      return code.codeChallenge;
    },
    async exchangeAuthorizationCode(client, authorizationCode, _codeVerifier, redirectUri, resource) {
      requireEnabled();
      requireResource(resource);
      if (typeof authorizationCode !== "string" || !OPAQUE_ID.test(authorizationCode)) throw new InvalidGrantError("Invalid authorization code.");
      const accessToken = opaque(); const refreshToken = opaque();
      return db.runTransaction(async (transaction) => {
        const codeSnapshot = await transaction.get(ref("Codes", authorizationCode));
        const code = codeSnapshot.exists ? codeSnapshot.data() : null;
        if (!code || code.usedAt || code.expiresAtMs <= now() || code.clientId !== client.client_id
          || !redirectUri || redirectUri !== code.redirectUri || code.resource !== config.resourceUrl) throw new InvalidGrantError("Invalid, expired or previously used authorization code.");
        let connection;
        try { ({ connection } = await currentConnection(code.connectionId, (document) => transaction.get(document))); }
        catch { throw new InvalidGrantError("This connection is no longer valid."); }
        const instant = now();
        const tokens = tokensFor(connection, code.connectionId, accessToken, refreshToken, instant);
        transaction.update(ref("Codes", authorizationCode), { usedAt: instant });
        transaction.set(ref("Tokens", accessToken), tokens.access);
        transaction.set(ref("Tokens", refreshToken), tokens.refresh);
        transaction.update(connectionRef(code.connectionId), { refreshHash: hash(refreshToken) });
        return tokens.response;
      });
    },
    async exchangeRefreshToken(client, refreshToken, scopes, resource) {
      requireEnabled(); requireResource(resource);
      if (typeof refreshToken !== "string" || !OPAQUE_ID.test(refreshToken)) throw new InvalidGrantError("Invalid refresh token.");
      const accessToken = opaque(); const nextRefreshToken = opaque();
      const result = await db.runTransaction(async (transaction) => {
        const tokenSnapshot = await transaction.get(ref("Tokens", refreshToken));
        const token = tokenSnapshot.exists ? tokenSnapshot.data() : null;
        if (!token || token.kind !== "refresh" || token.clientId !== client.client_id || token.expiresAtMs <= now()) throw new InvalidGrantError("Invalid refresh token.");
        let connection;
        try { ({ connection } = await currentConnection(token.connectionId, (document) => transaction.get(document))); }
        catch { throw new InvalidGrantError("This connection is no longer valid."); }
        if (token.usedAt || connection.refreshHash !== hash(refreshToken)) {
          transaction.update(connectionRef(token.connectionId), { revokedAt: now(), revocationReason: "refresh-token-reuse" });
          return { replayed: true };
        }
        const requested = scopes ? validScopes(scopes) : connection.scopes;
        if (requested.some((scope) => !connection.scopes.includes(scope))) throw new InvalidScopeError("Refresh cannot expand the approved scopes.");
        const instant = now();
        const narrowedConnection = { ...connection, scopes: requested };
        const tokens = tokensFor(narrowedConnection, token.connectionId, accessToken, nextRefreshToken, instant);
        transaction.update(ref("Tokens", refreshToken), { usedAt: instant });
        transaction.set(ref("Tokens", accessToken), tokens.access);
        transaction.set(ref("Tokens", nextRefreshToken), tokens.refresh);
        transaction.update(connectionRef(token.connectionId), { refreshHash: hash(nextRefreshToken), scopes: requested });
        return { tokens: tokens.response };
      });
      if (result.replayed) throw new InvalidGrantError("Refresh token reuse revoked this connection. Connect again.");
      return result.tokens;
    },
    async verifyAccessToken(token) {
      requireEnabled();
      if (typeof token !== "string" || !OPAQUE_ID.test(token)) throw new InvalidTokenError("Invalid access token.");
      const snapshot = await ref("Tokens", token).get();
      const data = snapshot.exists ? snapshot.data() : null;
      if (!data || data.kind !== "access" || data.expiresAtMs <= now() || data.resource !== config.resourceUrl) throw new InvalidTokenError("Invalid or expired access token.");
      const { connection } = await currentConnection(data.connectionId);
      const scopes = data.scopes.filter((scope) => connection.scopes.includes(scope));
      return { token, clientId: data.clientId, scopes, expiresAt: data.expiresAtMs / 1000, resource: new URL(data.resource), extra: { uid: connection.uid, connectionId: data.connectionId, authTime: connection.authTime } };
    },
    async revokeToken(client, request) {
      if (typeof request.token !== "string" || !OPAQUE_ID.test(request.token)) return;
      const snapshot = await ref("Tokens", request.token).get();
      const data = snapshot.exists ? snapshot.data() : null;
      if (data?.clientId === client.client_id) await connectionRef(data.connectionId).update({ revokedAt: now(), revocationReason: "client-revocation" });
    },
    async toRequest(authInfo) {
      const id = authInfo.extra?.connectionId;
      const { connection, user } = await currentConnection(id);
      return {
        auth: { uid: user.uid, token: { ...user.customClaims, email_verified: true, auth_time: connection.authTime } },
        mcpAuth: {
          scopes: authInfo.scopes, connectionId: id, clientId: connection.clientId, resource: config.resourceUrl,
          assertActive: async () => {
            const active = await currentConnection(id);
            if (authInfo.scopes.some((scope) => !active.connection.scopes.includes(scope))) throw new InvalidTokenError("The approved connection scopes changed.");
          },
        },
      };
    },
  };

  const handlers = {
    async getConsent(request) {
      requireEnabled(); await requireCurrentVerifiedUser(request, auth);
      const requestId = requireOpaque(request.data?.requestId, "requestId");
      const snapshot = await ref("Authorizations", requestId).get();
      const data = snapshot.exists ? snapshot.data() : null;
      if (!data || data.usedAt || data.expiresAtMs <= now()) throw new HttpsError("failed-precondition", "This connection request expired or has already been used. Start again in your AI client.");
      const client = config.clients.find((entry) => entry.client_id === data.clientId);
      if (!client) throw new HttpsError("failed-precondition", "This client is no longer available.");
      return { requestId, client: { name: client.client_name, redirectOrigin: new URL(data.redirectUri).origin }, scopes: MCP_SCOPES.filter((scope) => data.scopes.includes(scope.id)), expiresAt: data.expiresAtMs };
    },
    async completeConsent(request) {
      requireEnabled(); await requireCurrentVerifiedUser(request, auth);
      const requestId = requireOpaque(request.data?.requestId, "requestId");
      if (typeof request.data?.approve !== "boolean") throw new HttpsError("invalid-argument", "Choose whether to approve this connection.");
      const authTime = Number(request.auth.token?.auth_time);
      if (!Number.isFinite(authTime) || authTime <= 0) throw new HttpsError("unauthenticated", "Sign in again before connecting your AI client.");
      const code = opaque(); const connectionId = opaque();
      return db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(ref("Authorizations", requestId));
        const data = snapshot.exists ? snapshot.data() : null;
        if (!data || data.usedAt || data.expiresAtMs <= now() || !config.clients.some((client) => client.client_id === data.clientId)) {
          throw new HttpsError("failed-precondition", "This connection request expired or has already been used. Start again in your AI client.");
        }
        const instant = now();
        const redirect = new URL(data.redirectUri);
        if (data.state) redirect.searchParams.set("state", data.state);
        redirect.searchParams.set("iss", config.issuerUrl);
        transaction.update(ref("Authorizations", requestId), { usedAt: instant, decidedBy: request.auth.uid, approved: request.data.approve });
        if (!request.data.approve) {
          redirect.searchParams.set("error", "access_denied");
          return { redirectUrl: redirect.href };
        }
        const client = config.clients.find((entry) => entry.client_id === data.clientId);
        transaction.set(connectionRef(connectionId), {
          uid: request.auth.uid, clientId: data.clientId, clientName: client.client_name, scopes: data.scopes,
          resource: data.resource, authTime, createdAt: instant, revokedAt: null,
          ...expiry(instant + CONNECTION_MS),
        });
        transaction.set(ref("Codes", code), { connectionId, clientId: data.clientId, redirectUri: data.redirectUri, resource: data.resource, codeChallenge: data.codeChallenge, usedAt: null, ...expiry(instant + CODE_MS) });
        redirect.searchParams.set("code", code);
        return { redirectUrl: redirect.href };
      });
    },
    async listConnections(request) {
      await requireCurrentVerifiedUser(request, auth);
      const snapshots = await db.collection("hotelMcpOAuthConnections")
        .where("uid", "==", request.auth.uid).where("revokedAt", "==", null)
        .where("expiresAtMs", ">", now()).limit(100).get();
      return {
        connections: snapshots.docs.map((document) => ({ id: document.id, ...document.data() }))
          .filter((connection) => !connection.revokedAt && connection.expiresAtMs > now())
          .map((connection) => ({ id: connection.id, clientName: connection.clientName, scopes: connection.scopes, createdAt: connection.createdAt, expiresAt: connection.expiresAtMs })),
        configuration: { enabled: config.enabled, resourceUrl: config.resourceUrl || null },
      };
    },
    async revokeConnection(request) {
      await requireCurrentVerifiedUser(request, auth);
      const id = requireOpaque(request.data?.connectionId, "connectionId");
      await db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(connectionRef(id));
        if (!snapshot.exists || snapshot.data().uid !== request.auth.uid) throw new HttpsError("not-found", "The connection was not found.");
        transaction.update(connectionRef(id), { revokedAt: now(), revocationReason: "user-revocation" });
      });
      return { revoked: true };
    },
  };
  return { ...provider, handlers };
}

function createHotelMcpAuthHandlers(options) {
  return createHotelMcpOAuthProvider(options).handlers;
}

module.exports = { MCP_SCOPES, normalizeHotelMcpConfig, createHotelMcpOAuthProvider, createHotelMcpAuthHandlers };
