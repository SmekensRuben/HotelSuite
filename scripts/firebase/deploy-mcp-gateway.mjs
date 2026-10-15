import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const MCP_GATEWAY_PROJECT = "hotel-toolkit";
export const MCP_GATEWAY_ORIGIN = "https://hotel-toolkit.web.app";
const root = fileURLToPath(new URL("../../", import.meta.url));
const configPath = new URL("../../firebase.mcp.json", import.meta.url);
const publicPath = new URL("../../firebase/mcp-gateway/", import.meta.url);
const firebaseCli = fileURLToPath(new URL("../../node_modules/firebase-tools/lib/bin/firebase.js", import.meta.url));
const paths = ["/mcp", "/authorize", "/token", "/revoke", "/.well-known/oauth-authorization-server",
  "/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"];
const onlyKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));

export function requireMcpGatewayConfiguration(config) {
  const hosting = config?.hosting;
  if (!onlyKeys(config, ["hosting"]) || !onlyKeys(hosting, ["site", "public", "rewrites"])
    || hosting.site !== MCP_GATEWAY_PROJECT || hosting.public !== "firebase/mcp-gateway"
    || !Array.isArray(hosting.rewrites) || hosting.rewrites.length !== paths.length
    || new Set(hosting.rewrites.map(rewrite => rewrite?.source)).size !== paths.length
    || hosting.rewrites.some(rewrite => !onlyKeys(rewrite, ["source", "function"])
      || !paths.includes(rewrite.source) || !onlyKeys(rewrite.function, ["functionId", "region"])
      || rewrite.function.functionId !== "hotelMcp" || rewrite.function.region !== "us-central1")) {
    throw new Error("The MCP gateway must contain only the reviewed hotel-toolkit Hosting site and exact hotelMcp rewrites.");
  }
  return hosting;
}

function runFirebase(args) {
  const result = spawnSync(process.execPath, [firebaseCli, ...args], { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`MCP gateway publication failed (${result.signal || result.status}).`);
}

export function deployMcpGateway({ args = process.argv.slice(2), run = runFirebase, log = console.log } = {}) {
  if (args.length > 1 || args.some(argument => argument !== "--apply")) {
    throw new Error("Usage: node scripts/firebase/deploy-mcp-gateway.mjs [--apply]");
  }
  requireMcpGatewayConfiguration(JSON.parse(readFileSync(configPath, "utf8")));
  const files = readdirSync(publicPath, { withFileTypes: true });
  if (files.length !== 1 || files[0].name !== "404.html" || !files[0].isFile()) {
    throw new Error("The MCP gateway public directory must contain only the static 404.html page.");
  }
  const deployArgs = ["deploy", "--only", "hosting", "--config", "firebase.mcp.json", "--project", MCP_GATEWAY_PROJECT, "--non-interactive"];
  log(`Project: ${MCP_GATEWAY_PROJECT}; Hosting site: ${MCP_GATEWAY_PROJECT}; MCP issuer: ${MCP_GATEWAY_ORIGIN}`);
  log("Publishes a gateway-only Hosting version; all other paths return 404. Deploy hotelMcp(us-central1) first.");
  log(`Locked Firebase CLI: ${deployArgs.join(" ")}`);
  if (!args.includes("--apply")) {
    log("Dry-run only. Add --apply to publish this gateway. The App Hosting frontend is separate.");
    return false;
  }
  run(deployArgs);
  return true;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) deployMcpGateway();
