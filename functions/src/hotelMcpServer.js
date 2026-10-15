const express = require("express");
const { mcpAuthRouter, createOAuthMetadata } = require("@modelcontextprotocol/sdk/server/auth/router.js");
const { requireBearerAuth } = require("@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { InvalidTokenError } = require("@modelcontextprotocol/sdk/server/auth/errors.js");
const { MCP_SCOPES, createHotelMcpOAuthProvider } = require("./hotelMcpAuth");

const BODY_LIMIT = 256 * 1024;

function createHotelMcpApp({ db, auth, config, createServer, services = {}, now = Date.now }) {
  const provider = createHotelMcpOAuthProvider({ db, auth, config, now });
  const app = express();
  app.disable("x-powered-by");
  // Firebase Hosting forwards one trusted proxy hop. No user-supplied forwarded identity is accepted.
  app.set("trust proxy", 1);
  app.use((request, response, next) => {
    response.set("Cache-Control", "no-store");
    response.set("Referrer-Policy", "no-referrer");
    if (!provider.config.enabled) return response.status(503).json({ error: "temporarily_unavailable", error_description: "The private Hotel Toolkit MCP connection is not configured." });
    if (request.rawBody?.length > BODY_LIMIT || Number(request.get("content-length")) > BODY_LIMIT) {
      return response.status(413).json({ error: "invalid_request", error_description: "The request is too large." });
    }
    const origin = request.get("origin");
    if (origin && !provider.config.allowedOrigins.includes(origin)) return response.status(403).json({ error: "access_denied", error_description: "This browser origin is not permitted." });
    if (origin) {
      response.set("Access-Control-Allow-Origin", origin);
      response.vary("Origin");
      response.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      response.set("Access-Control-Allow-Headers", "Authorization, Content-Type, MCP-Protocol-Version, Mcp-Session-Id");
      response.set("Access-Control-Expose-Headers", "WWW-Authenticate, MCP-Protocol-Version");
    }
    if (request.method === "OPTIONS") return response.sendStatus(204);
    return next();
  });
  if (!provider.config.enabled) return { app, provider };
  // Bounded parsing runs before the SDK's protocol and OAuth routers.
  app.use(express.json({ limit: BODY_LIMIT }));
  app.use(express.urlencoded({ extended: false, limit: "16kb" }));
  const authorizationOptions = {
    provider, issuerUrl: new URL(provider.config.issuerUrl), resourceServerUrl: new URL(provider.config.resourceUrl),
    scopesSupported: MCP_SCOPES.map((scope) => scope.id), resourceName: "Hotel Toolkit products",
  };
  // RFC 9207 lets current clients bind a shared loopback callback to this issuer.
  // Consent responses already carry iss; add it to the SDK's OAuth error redirects too.
  app.use("/authorize", (_request, response, next) => {
    const redirect = response.redirect.bind(response);
    response.redirect = (first, second) => {
      const location = typeof first === "number" ? second : first;
      const target = new URL(location);
      if (target.searchParams.has("error")) target.searchParams.set("iss", provider.config.issuerUrl);
      return typeof first === "number" ? redirect(first, target.href) : redirect(target.href);
    };
    next();
  });
  const authorizationMetadata = {
    ...createOAuthMetadata(authorizationOptions),
    authorization_response_iss_parameter_supported: true,
    revocation_endpoint_auth_methods_supported: [...new Set(provider.config.clients.map((client) => client.token_endpoint_auth_method))],
  };
  app.get("/.well-known/oauth-authorization-server", (_request, response) => {
    response.set("Access-Control-Allow-Origin", "*").json(authorizationMetadata);
  });
  app.use(mcpAuthRouter(authorizationOptions));
  const authenticate = requireBearerAuth({
    verifier: provider, requiredScopes: ["hotel-toolkit:read"], expectedResource: new URL(provider.config.resourceUrl),
    resourceMetadataUrl: new URL("/.well-known/oauth-protected-resource/mcp", provider.config.issuerUrl).href,
  });
  app.all("/mcp", authenticate, async (request, response, next) => {
    let server; let transport;
    try {
      const actor = await provider.toRequest(request.auth);
      const factory = createServer || require("./hotelMcpTools").createHotelMcpServer;
      server = factory({ request: actor, services: { ...services, db, firestore: db, auth } });
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      response.on("close", () => { void transport.close(); void server.close(); });
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } catch (error) {
      if (!response.headersSent) return next(error);
      await transport?.close();
    }
  });
  app.use((error, _request, response, _next) => {
    if (response.headersSent) return;
    if (error instanceof InvalidTokenError) {
      response.set("WWW-Authenticate", `Bearer error="invalid_token", resource_metadata="${new URL("/.well-known/oauth-protected-resource/mcp", provider.config.issuerUrl).href}"`);
      response.status(401).json({ error: "invalid_token", error_description: "This connection is no longer valid." });
      return;
    }
    const status = error.type === "entity.too.large" ? 413 : error.type === "entity.parse.failed" ? 400 : 500;
    response.status(status).json({ error: status === 500 ? "server_error" : "invalid_request", error_description: status === 500 ? "The MCP request could not be completed." : "The request body is invalid or too large." });
  });
  return { app, provider };
}

module.exports = { createHotelMcpApp, BODY_LIMIT };
