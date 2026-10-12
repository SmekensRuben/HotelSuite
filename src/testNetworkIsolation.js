// Unit tests use mocked services. Standard fetch and HTTP(S) requests are limited
// to loopback fixture servers. This guard is not a general process sandbox.
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";

export function isLocalTestRequest(input) {
  try {
    let url;
    if (typeof input === "string" || input instanceof URL) url = new URL(String(input));
    else {
      // Node HTTP options use hostname/host, never an arbitrary `url` property.
      const rawHost = input?.hostname || input?.host || "localhost";
      const host = rawHost === "::1" ? "[::1]" : rawHost;
      url = new URL(`${input?.protocol || "http:"}//${host}`);
    }
    return ["http:", "https:"].includes(url.protocol) && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch { return false; }
}
function requireLocal(input) {
  if (!isLocalTestRequest(input)) throw new Error("External network access is blocked in unit tests. Mock the service or use a local emulator.");
}
export function installUnitNetworkIsolation() {
  const key = Symbol.for("hotelsuite.unit-test-local-network-only");
  if (globalThis[key]) return;
  globalThis[key] = true;
  if (typeof globalThis.fetch === "function") {
    const original = globalThis.fetch.bind(globalThis);
    globalThis.fetch = async (input, options) => {
      // Fetch coerces arbitrary objects to strings. Validate and pass the same
      // frozen target rather than trusting an unrelated `url` property.
      const target = typeof Request === "function" && input instanceof Request ? new Request(input) : String(input);
      requireLocal(typeof target === "string" ? target : target.url);
      // A local fixture must not redirect a mocked-service test to an API.
      return original(target, { ...options, redirect: "error" });
    };
  }
  for (const client of [http, https]) {
    const request = client.request, get = client.get;
    const frozenArguments = (input, rest) => {
      const target = typeof input === "string" || Object.prototype.toString.call(input) === "[object URL]" ? String(input) : { ...input };
      const args = [...rest];
      if (args[0] && typeof args[0] === "object") args[0] = { ...args[0] };
      requireLocal(target);
      const overrides = args[0];
      if (overrides && typeof overrides === "object" && (overrides.hostname || overrides.host || overrides.protocol)) requireLocal(overrides);
      return [target, ...args];
    };
    client.request = function (input, ...rest) { return request.call(this, ...frozenArguments(input, rest)); };
    client.get = function (input, ...rest) { return get.call(this, ...frozenArguments(input, rest)); };
  }
  syncBuiltinESMExports();
}
