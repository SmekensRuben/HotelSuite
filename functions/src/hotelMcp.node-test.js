const test = require("node:test");
const assert = require("node:assert/strict");
const { readHotelMcpRuntimeConfig, hotelMcp, getHotelMcpConsent, completeHotelMcpConsent, listHotelMcpConnections, revokeHotelMcpConnection } = require("./hotelMcp");

function configuration(values, action) {
  const keys = ["HOTEL_MCP_ENABLED", "HOTEL_MCP_PUBLIC_ORIGIN", "HOTEL_MCP_CLIENTS_JSON", "HOTEL_MCP_ALLOWED_ORIGINS_JSON", "APP_BASE_URL"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) { if (values[key] === undefined) delete process.env[key]; else process.env[key] = values[key]; }
  try { return action(); }
  finally { for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } }
}
const client = { client_id: "codex-private", redirect_uris: ["http://127.0.0.1/callback"], token_endpoint_auth_method: "none" };
const enabled = { HOTEL_MCP_ENABLED: "true", HOTEL_MCP_PUBLIC_ORIGIN: "https://mcp.example.test", APP_BASE_URL: "https://app.example.test", HOTEL_MCP_CLIENTS_JSON: JSON.stringify([client]) };

test("private MCP is disabled without adding required operator parameters or exposing a server", () => {
  configuration({}, () => assert.deepEqual(readHotelMcpRuntimeConfig(), { enabled: false }));
  assert.ok(hotelMcp.__endpoint.httpsTrigger);
  for (const callable of [getHotelMcpConsent, completeHotelMcpConsent, listHotelMcpConnections, revokeHotelMcpConnection]) assert.ok(callable.__endpoint.callableTrigger);
});

test("enabled MCP uses the configured public PKCE clients and canonical app and issuer settings", () => {
  configuration(enabled, () => assert.deepEqual(readHotelMcpRuntimeConfig(), { enabled: true,
    issuerUrl: "https://mcp.example.test", appUrl: "https://app.example.test", clients: [client], allowedOrigins: [] }));
});

test("pilot runtime rejects secret-bearing OAuth configuration and malformed client JSON", () => {
  for (const clients of [[{ ...client, client_secret: "not-a-parameter-value" }], [{ ...client, token_endpoint_auth_method: "client_secret_post" }], {}]) {
    configuration({ ...enabled, HOTEL_MCP_CLIENTS_JSON: JSON.stringify(clients) }, () => assert.throws(readHotelMcpRuntimeConfig, /public PKCE clients/));
  }
  configuration({ ...enabled, HOTEL_MCP_CLIENTS_JSON: "not-json" }, () => assert.throws(readHotelMcpRuntimeConfig));
});
