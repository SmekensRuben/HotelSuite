// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { deployMcpGateway, requireMcpGatewayConfiguration } from "../../scripts/firebase/deploy-mcp-gateway.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const readConfig = () => JSON.parse(readFileSync(new URL("../../firebase.mcp.json", import.meta.url), "utf8"));
const require = createRequire(import.meta.url);
const { Config } = require("firebase-tools/lib/config");
const { hostingConfig } = require("firebase-tools/lib/hosting/config");

describe("MCP gateway publication", () => {
  it("is a valid independent Hosting site with exact function routes and no frontend fallback", () => {
    const config = new Config(readConfig(), { projectDir: root });
    const normalized = hostingConfig({ config, projectDir: root, project: "hotel-toolkit", only: "hosting" });
    expect(normalized).toHaveLength(1);
    expect(normalized[0].site).toBe("hotel-toolkit");
    expect(normalized[0].public).toBe("firebase/mcp-gateway");
    expect(normalized[0].rewrites.map(rewrite => rewrite.source)).toEqual([
      "/mcp", "/authorize", "/token", "/revoke", "/.well-known/oauth-authorization-server",
      "/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp",
    ]);
    for (const rewrite of normalized[0].rewrites) {
      expect(rewrite.function).toEqual({ functionId: "hotelMcp", region: "us-central1" });
      expect(rewrite.destination).toBeUndefined();
    }
    expect(Object.keys(config.src)).toEqual(["hosting"]);
    expect(requireMcpGatewayConfiguration(readConfig())).toEqual(normalized[0]);
  });

  it("prints a local plan without invoking Firebase even when a different Firebase alias is selected", () => {
    const run = vi.fn(); const log = vi.fn();
    expect(deployMcpGateway({ args: [], run, log })).toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join("\n")).toContain("Dry-run only");
    const output = execFileSync(process.execPath, ["scripts/firebase/deploy-mcp-gateway.mjs"], { cwd: root, encoding: "utf8" });
    expect(output).toContain("MCP issuer: https://hotel-toolkit.web.app");
    expect(output).toContain("--only hosting --config firebase.mcp.json --project hotel-toolkit --non-interactive");
  });

  it("publishes only the explicit gateway site with the locked CLI and no frontend build", () => {
    const run = vi.fn();
    expect(deployMcpGateway({ args: ["--apply"], run, log: vi.fn() })).toBe(true);
    expect(run).toHaveBeenCalledExactlyOnceWith([
      "deploy", "--only", "hosting", "--config", "firebase.mcp.json", "--project", "hotel-toolkit", "--non-interactive",
    ]);
  });

  it.each([["--project", "test-breakfast"], ["--force"], ["--apply", "--apply"]])("rejects extra deployment arguments: %j", (...args) => {
    const run = vi.fn();
    expect(() => deployMcpGateway({ args, run, log: vi.fn() })).toThrow("Usage:");
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    ["a frontend directory", config => { config.hosting.public = "dist"; }],
    ["an alias-selected site", config => { delete config.hosting.site; config.hosting.target = "default"; }],
    ["another site", config => { config.hosting.site = "test-breakfast"; }],
    ["a SPA fallback", config => { config.hosting.rewrites.push({ source: "**", destination: "/index.html" }); }],
    ["an unreviewed function", config => { config.hosting.rewrites[0].function.functionId = "anotherFunction"; }],
    ["an ambiguous region", config => { delete config.hosting.rewrites[0].function.region; }],
    ["extra deployment resources", config => { config.functions = { source: "functions" }; }],
    ["Hosting deployment hooks", config => { config.hosting.predeploy = ["npm run build"]; }],
  ])("rejects %s", (_label, mutate) => {
    const config = readConfig(); mutate(config);
    expect(() => requireMcpGatewayConfiguration(config)).toThrow("only the reviewed");
  });
});
