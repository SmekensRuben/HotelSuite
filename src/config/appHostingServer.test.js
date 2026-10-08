// @vitest-environment node
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAppServer } from "../../scripts/serve-app.mjs";
let root, server, base;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "hotelsuite-static-test-"));
  await mkdir(join(root, "dist/assets"), { recursive: true });
  await writeFile(join(root, "dist/index.html"), "<h1>Hotel Toolkit</h1>");
  await writeFile(join(root, "dist/assets/app-1234abcd.js"), "console.log('client');");
  await writeFile(join(root, "private.txt"), "private");
  await symlink(join(root, "private.txt"), join(root, "dist/private.txt"));
  server = createAppServer(join(root, "dist"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = "http://127.0.0.1:" + server.address().port;
});
afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (root) await rm(root, { recursive: true, force: true });
});
describe("App Hosting production static server", () => {
  it("serves deep HTML links with fresh markup and caches fingerprinted assets", async () => {
    const page = await fetch(base + "/settings/subscriptions", { headers: { accept: "text/html" } });
    expect(page.status).toBe(200); expect(await page.text()).toContain("Hotel Toolkit");
    expect(page.headers.get("cache-control")).toBe("no-cache");
    const asset = await fetch(base + "/assets/app-1234abcd.js");
    expect(asset.headers.get("content-type")).toContain("javascript");
    expect(asset.headers.get("cache-control")).toContain("immutable");
    expect((await fetch(base + "/assets/missing.js")).status).toBe(404);
  });
  it("rejects traversal, external symlinks, malformed encodings and mutation methods", async () => {
    expect((await fetch(base + "/%2e%2e%2fprivate.txt")).status).toBe(403);
    expect((await fetch(base + "/private.txt")).status).toBe(403);
    expect((await fetch(base + "/%zz")).status).toBe(400);
    expect((await fetch(base + "/", { method: "POST" })).status).toBe(405);
  });
  it("supports HEAD without returning a response body", async () => {
    const response = await fetch(base + "/", { method: "HEAD" });
    expect(response.status).toBe(200); expect(await response.text()).toBe("");
  });
});
