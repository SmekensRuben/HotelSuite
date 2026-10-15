// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { functionsRuntimeParameters, prepareFunctionsRuntime } from "../../scripts/firebase/mcp-deployment-config.mjs";
import { FUNCTIONS_PROVIDER, FUNCTIONS_DEPLOY_ACCOUNT } from "../../scripts/firebase/functions-release-policy.mjs";

const require = createRequire(import.meta.url);
const { loadUserEnvs } = require("firebase-tools/lib/functions/env");
const { resolveBackend } = require("firebase-tools/lib/deploy/functions/build");
const { normalizePublicHotelMcpConfig } = require("../../functions/src/hotelMcpConfig.js");
const { load } = require("js-yaml");
const appOrigin = "https://hotel-toolkit--hotel-toolkit.europe-west4.hosted.app";
const issuer = "https://hotel-toolkit.web.app";
const client = { client_id: "codex-private", client_name: 'Codex "Hotel" O\'Reilly \\ Pilot #1',
  redirect_uris: ["http://127.0.0.1/callback"], token_endpoint_auth_method: "none" };
const baseEnv = () => ({ FIREBASE_PROJECT_ID: "hotel-toolkit", FIREBASE_WORKLOAD_IDENTITY_PROVIDER: FUNCTIONS_PROVIDER,
  FIREBASE_DEPLOY_SERVICE_ACCOUNT: FUNCTIONS_DEPLOY_ACCOUNT, FUNCTIONS_APP_BASE_URL: appOrigin });
const activeEnv = () => ({ ...baseEnv(), HOTEL_MCP_ENABLED: "true", HOTEL_MCP_PUBLIC_ORIGIN: issuer,
  HOTEL_MCP_CLIENTS_JSON: JSON.stringify([client], null, 2), HOTEL_MCP_ALLOWED_ORIGINS_JSON: '["https://browser.example.com"]' });
const disabled = { APP_BASE_URL: appOrigin, HOTEL_MCP_ENABLED: "false", HOTEL_MCP_PUBLIC_ORIGIN: "",
  HOTEL_MCP_CLIENTS_JSON: "[]", HOTEL_MCP_ALLOWED_ORIGINS_JSON: "[]" };

describe("MCP repository-variable activation", () => {
  it("passes all four repository variables through the existing guarded release workflow", () => {
    const workflow = load(readFileSync(".github/workflows/deploy-functions.yml", "utf8"));
    const deploy = workflow.jobs.deploy;
    for (const key of ["HOTEL_MCP_ENABLED", "HOTEL_MCP_PUBLIC_ORIGIN", "HOTEL_MCP_CLIENTS_JSON", "HOTEL_MCP_ALLOWED_ORIGINS_JSON"]) {
      expect(deploy.env[key]).toBe(`\${{ vars.${key} }}`);
    }
    expect(deploy.env.FUNCTIONS_APP_BASE_URL).toBe(appOrigin);
    expect(deploy.steps.find((step) => step.run === "bash scripts/firebase/check-functions-runtime.sh").if).toBe("steps.release.outputs.deploy == 'true'");
    expect(deploy.steps.find((step) => step.run === "node scripts/firebase/deploy-reviewed-functions.mjs").if).toBe("steps.current.outputs.deploy == 'true'");
  });

  it.each([undefined, "", "false"])("keeps MCP disabled for activation=%s even with incomplete stored settings", (flag) => {
    expect(functionsRuntimeParameters({ ...baseEnv(), HOTEL_MCP_ENABLED: flag, HOTEL_MCP_PUBLIC_ORIGIN: "invalid",
      HOTEL_MCP_CLIENTS_JSON: "unfinished JSON", HOTEL_MCP_ALLOWED_ORIGINS_JSON: "*" })).toEqual(disabled);
  });

  it.each(["TRUE", "False", " true ", "yes", "1", "false\nAPP_BASE_URL=attacker"])("rejects an ambiguous activation flag: %s", (flag) => {
    expect(() => functionsRuntimeParameters({ ...baseEnv(), HOTEL_MCP_ENABLED: flag })).toThrow("HOTEL_MCP_ENABLED");
  });

  it.each(["FIREBASE_PROJECT_ID", "FIREBASE_WORKLOAD_IDENTITY_PROVIDER", "FIREBASE_DEPLOY_SERVICE_ACCOUNT", "FUNCTIONS_APP_BASE_URL"])("preserves the existing %s guard", (key) => {
    expect(() => functionsRuntimeParameters({ ...activeEnv(), [key]: "different" })).toThrow();
  });

  it.each(["", "http://example.com", "https://localhost", "https://127.0.0.1", "https://[::1]", "https://10.0.0.1", "https://gateway.internal",
    "https://gateway.localhost", "https://gateway.local", "https://gateway.home.arpa", "https://bad..example.com", "https://user:password@example.com",
    "https://example.com:8443", "https://example.com/mcp", "https://example.com?x=1", "https://example.com#fragment", "https://example.com\nAPP_BASE_URL=other"])("rejects an invalid public issuer: %s", (origin) => {
    expect(() => functionsRuntimeParameters({ ...activeEnv(), HOTEL_MCP_PUBLIC_ORIGIN: origin })).toThrow();
  });

  it.each(["HOTEL_MCP_CLIENTS_JSON", "HOTEL_MCP_ALLOWED_ORIGINS_JSON"])("reports malformed %s without echoing supplied values", (key) => {
    const marker = "operator-supplied-confidential-marker";
    expect(() => functionsRuntimeParameters({ ...activeEnv(), [key]: marker })).toThrow(`${key} must contain valid JSON`);
    try { functionsRuntimeParameters({ ...activeEnv(), [key]: marker }); } catch (error) { expect(error.message).not.toContain(marker); }
    expect(() => functionsRuntimeParameters({ ...activeEnv(), [key]: " ".repeat(32769) })).toThrow("32 KiB");
  });

  it.each([[], {}, [null], [{ ...client, client_id: "bad id" }], [client, client], Array.from({ length: 21 }, (_, index) => ({ ...client, client_id: `client-${index}` })),
    [{ ...client, client_secret: "" }], [{ ...client, client_secret: "must-never-be-published" }], [{ ...client, token_endpoint_auth_method: "client_secret_post" }],
    [{ ...client, token_endpoint_auth_method: "client_secret_basic" }], [{ ...client, clientSecret: "unsupported" }], [{ ...client, client_name: "" }],
    [{ ...client, client_name: "x".repeat(101) }], [{ ...client, client_name: "client\ninjected" }], [{ ...client, redirect_uris: [] }],
    [{ ...client, redirect_uris: Array(11).fill("http://127.0.0.1/callback") }]].map((clients) => [clients]))("rejects invalid, duplicate or secret-bearing client registrations %#", (clients) => {
    expect(() => functionsRuntimeParameters({ ...activeEnv(), HOTEL_MCP_CLIENTS_JSON: JSON.stringify(clients) })).toThrow();
  });

  it.each(["http://remote.example.com/callback", "https://client.example.com/*", "https://client.example.com/callback#fragment",
    "https://name:secret@client.example.com/callback", "https://client.example.com", " https://client.example.com/callback",
    "https://127.0.0.2/callback", "https://client.example.com/path/../callback", "javascript:callback()"])("rejects unsafe or noncanonical callback %s", (uri) => {
    expect(() => functionsRuntimeParameters({ ...activeEnv(), HOTEL_MCP_CLIENTS_JSON: JSON.stringify([{ ...client, redirect_uris: [uri] }]) })).toThrow();
  });

  it.each(["*", {}, ["*"], ["http://browser.example.com"], ["https://browser.example.com/path"], ["https://localhost"], Array(21).fill(issuer)].map((origins) => [origins]))("rejects invalid browser-origin allowlists %#", (origins) => {
    expect(() => functionsRuntimeParameters({ ...activeEnv(), HOTEL_MCP_ALLOWED_ORIGINS_JSON: JSON.stringify(origins) })).toThrow();
  });

  it("defaults extra browser origins to empty and retains exact HTTPS/query and loopback callbacks", () => {
    const callbacks = ["https://client.example.com/callback?workspace=exact", "http://127.0.0.1/callback", "http://localhost:41000/callback", "http://[::1]/callback"];
    const values = functionsRuntimeParameters({ ...activeEnv(), HOTEL_MCP_ALLOWED_ORIGINS_JSON: "",
      HOTEL_MCP_CLIENTS_JSON: JSON.stringify([{ client_id: "public-client", redirect_uris: callbacks }]) });
    expect(values.HOTEL_MCP_ALLOWED_ORIGINS_JSON).toBe("[]");
    expect(JSON.parse(values.HOTEL_MCP_CLIENTS_JSON)[0]).toEqual({ client_id: "public-client", client_name: "public-client",
      redirect_uris: callbacks, token_endpoint_auth_method: "none" });
  });

  it("preserves active JSON through the actual Firebase dotenv parser, non-interactive resolver and runtime validator", async () => {
    const directory = mkdtempSync(join(tmpdir(), "hotelsuite-mcp-config-"));
    try {
      const destination = join(directory, ".env.hotel-toolkit");
      const parameters = prepareFunctionsRuntime(activeEnv(), destination);
      expect(statSync(destination).mode & 0o777).toBe(0o600);
      const userEnvs = loadUserEnvs({ functionsSource: directory, projectDir: directory, projectId: "hotel-toolkit" });
      expect(userEnvs).toEqual(parameters);
      const { envs } = await resolveBackend({ build: { endpoints: {}, params: Object.keys(parameters).map((name) => (
        { name, type: name === "HOTEL_MCP_ENABLED" ? "boolean" : "string" }
      )) }, firebaseConfig: { projectId: "hotel-toolkit" }, codebase: "default", nonInteractive: true, userEnvs });
      const config = normalizePublicHotelMcpConfig({ enabled: envs.HOTEL_MCP_ENABLED.asBoolean(), issuerUrl: envs.HOTEL_MCP_PUBLIC_ORIGIN.asString(),
        appUrl: envs.APP_BASE_URL.asString(), clients: JSON.parse(envs.HOTEL_MCP_CLIENTS_JSON.asString()),
        allowedOrigins: JSON.parse(envs.HOTEL_MCP_ALLOWED_ORIGINS_JSON.asString()) });
      expect(config.clients[0].client_name).toBe(client.client_name);
      expect(config.clients[0].redirect_uris).toEqual(client.redirect_uris);
      expect(config.clients[0].token_endpoint_auth_method).toBe("none");
      expect(config.resourceUrl).toBe(`${issuer}/mcp`);
      expect(config.appUrl).toBe(appOrigin);
      expect(config.allowedOrigins).toEqual([appOrigin, "https://browser.example.com"]);
      expect(config.enabled).toBe(true);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("validates before replacing an existing parameter file", () => {
    const directory = mkdtempSync(join(tmpdir(), "hotelsuite-mcp-invalid-"));
    try {
      const destination = join(directory, ".env.hotel-toolkit");
      writeFileSync(destination, "previous configuration\n");
      expect(() => prepareFunctionsRuntime({ ...activeEnv(), HOTEL_MCP_CLIENTS_JSON: "[]" }, destination)).toThrow();
      expect(readFileSync(destination, "utf8")).toBe("previous configuration\n");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
