import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { normalizePublicHotelMcpConfig } from "../../functions/src/hotelMcpConfig.js";
import { requireFunctionsConfiguration } from "./functions-release-policy.mjs";

function jsonParameter(env, key) {
  const value = env[key] || "[]";
  if (typeof value !== "string" || Buffer.byteLength(value) > 32768) throw new Error(`${key} must contain at most 32 KiB of JSON.`);
  try { return JSON.parse(value); } catch { throw new Error(`${key} must contain valid JSON.`); }
}

export function functionsRuntimeParameters(env) {
  const appOrigin = requireFunctionsConfiguration(env);
  const flag = env.HOTEL_MCP_ENABLED;
  if (flag !== undefined && flag !== "" && flag !== "false" && flag !== "true") {
    throw new Error("HOTEL_MCP_ENABLED must be exactly true or false, or unset to keep MCP disabled.");
  }
  const parameters = { APP_BASE_URL: appOrigin, HOTEL_MCP_ENABLED: "false", HOTEL_MCP_PUBLIC_ORIGIN: "",
    HOTEL_MCP_CLIENTS_JSON: "[]", HOTEL_MCP_ALLOWED_ORIGINS_JSON: "[]" };
  // Disabling must also work when an operator is repairing invalid activation settings.
  if (flag !== "true") return parameters;
  const config = normalizePublicHotelMcpConfig({ enabled: true, issuerUrl: env.HOTEL_MCP_PUBLIC_ORIGIN,
    appUrl: appOrigin, clients: jsonParameter(env, "HOTEL_MCP_CLIENTS_JSON"),
    allowedOrigins: jsonParameter(env, "HOTEL_MCP_ALLOWED_ORIGINS_JSON") });
  return { ...parameters, HOTEL_MCP_ENABLED: "true", HOTEL_MCP_PUBLIC_ORIGIN: new URL(config.issuerUrl).origin,
    HOTEL_MCP_CLIENTS_JSON: JSON.stringify(config.clients.map(({ client_id, client_name, redirect_uris, token_endpoint_auth_method }) => (
      { client_id, client_name, redirect_uris, token_endpoint_auth_method }
    ))),
    HOTEL_MCP_ALLOWED_ORIGINS_JSON: JSON.stringify(config.allowedOrigins.filter((origin) => origin !== appOrigin)) };
}

export function prepareFunctionsRuntime(env, destination = "functions/.env.hotel-toolkit") {
  const parameters = functionsRuntimeParameters(env);
  // Quote and escape the complete values: formatted JSON, quotes, backslashes and
  // comment characters must survive the Firebase CLI dotenv parser unchanged.
  const dotenv = Object.entries(parameters).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join("\n") + "\n";
  writeFileSync(destination, dotenv, { mode: 0o600 });
  return parameters;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const parameters = prepareFunctionsRuntime(process.env);
    console.log(`Prepared APP_BASE_URL and validated MCP parameters (enabled=${parameters.HOTEL_MCP_ENABLED}) for hotel-toolkit.`);
  } catch (error) {
    // Validation errors describe fields, never echo operator-supplied values.
    console.error(error.message);
    process.exitCode = 1;
  }
}
