const { onRequest, onCall } = require("firebase-functions/v2/https");
const { defineBoolean, defineString } = require("firebase-functions/params");
const { admin, logger, getAppBaseUrl, MEILI_HOST, MEILI_API_KEY, MEILI_INDEX } = require("./config");
const { createHotelMcpApp } = require("./hotelMcpServer");
const { createHotelMcpAuthHandlers } = require("./hotelMcpAuth");
const { normalizePublicHotelMcpConfig } = require("./hotelMcpConfig");

const HOTEL_MCP_ENABLED = defineBoolean("HOTEL_MCP_ENABLED", { default: false });
const HOTEL_MCP_PUBLIC_ORIGIN = defineString("HOTEL_MCP_PUBLIC_ORIGIN", { default: "" });
const HOTEL_MCP_CLIENTS_JSON = defineString("HOTEL_MCP_CLIENTS_JSON", { default: "[]" });
const HOTEL_MCP_ALLOWED_ORIGINS_JSON = defineString("HOTEL_MCP_ALLOWED_ORIGINS_JSON", { default: "[]" });

function readHotelMcpRuntimeConfig() {
  if (!HOTEL_MCP_ENABLED.value()) return { enabled: false };
  return normalizePublicHotelMcpConfig({ enabled: true, issuerUrl: HOTEL_MCP_PUBLIC_ORIGIN.value(), appUrl: getAppBaseUrl(),
    clients: JSON.parse(HOTEL_MCP_CLIENTS_JSON.value() || "[]"),
    allowedOrigins: JSON.parse(HOTEL_MCP_ALLOWED_ORIGINS_JSON.value() || "[]") });
}

function dependencies() {
  return { db: admin.firestore(), auth: admin.auth(), config: readHotelMcpRuntimeConfig() };
}

// Preserve the SDK's OAuth rate-limit stores across requests on a warm instance.
// Only configuration is shared; each MCP request still gets a fresh server and
// rechecks its bearer connection, Firebase account and hotel authorization.
let runtimeApp;
const hotelMcp = onRequest({
  region: "us-central1", cors: false, invoker: "public", timeoutSeconds: 120, memory: "512MiB", concurrency: 2, maxInstances: 10,
  secrets: require("./environmentPolicy").secretBindings([MEILI_HOST, MEILI_API_KEY, MEILI_INDEX]),
}, (request, response) => {
  try {
    runtimeApp ||= createHotelMcpApp(dependencies()).app;
    return runtimeApp(request, response);
  }
  catch {
    logger.error("The private Hotel Toolkit MCP configuration is invalid.");
    return response.status(503).set("Cache-Control", "no-store").json({ error: "temporarily_unavailable", error_description: "The private MCP connection needs operator configuration." });
  }
});

function personalHandler(name) {
  return async (request) => createHotelMcpAuthHandlers(dependencies())[name](request);
}
const getHotelMcpConsent = onCall({ region: "us-central1", cors: true }, personalHandler("getConsent"));
const completeHotelMcpConsent = onCall({ region: "us-central1", cors: true }, personalHandler("completeConsent"));
const listHotelMcpConnections = onCall({ region: "us-central1", cors: true }, personalHandler("listConnections"));
const revokeHotelMcpConnection = onCall({ region: "us-central1", cors: true }, personalHandler("revokeConnection"));

module.exports = { readHotelMcpRuntimeConfig, hotelMcp, getHotelMcpConsent, completeHotelMcpConsent, listHotelMcpConnections, revokeHotelMcpConnection };
