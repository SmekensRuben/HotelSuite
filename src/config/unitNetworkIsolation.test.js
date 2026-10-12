import http from "node:http";
import https from "node:https";
import { expect, it } from "vitest";
import { isLocalTestRequest } from "../testNetworkIsolation";
it("blocks real external Firebase/Cloud API requests before any payload is sent", async () => {
  await expect(fetch("https://us-central1-fictional-project.cloudfunctions.net/test"))
    .rejects.toThrow("External network access is blocked");
  expect(() => https.request("https://firestore.googleapis.com/v1/test")).toThrow("External network access is blocked");
  expect(() => http.get({ hostname: "outside.example.test", path: "/" })).toThrow("External network access is blocked");
  expect(() => http.request("http://localhost:3000/", { hostname: "outside.example.test" })).toThrow("External network access is blocked");
  expect(() => https.get("https://localhost:3000/", { host: "outside.example.test" })).toThrow("External network access is blocked");
  expect(() => http.request({ url: "http://localhost/", hostname: "outside.example.test" })).toThrow("External network access is blocked");
  await expect(fetch({ url: "http://localhost/", toString: () => "https://outside.example.test/api" })).rejects.toThrow("External network access is blocked");
});
it("does not follow a local fixture redirect to an external API even when the caller asks", async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(302, { location: "https://fictional-outside.example.test/" }); response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { await expect(fetch(`http://127.0.0.1:${server.address().port}/`, { redirect: "follow" })).rejects.toThrow(); }
  finally { await new Promise((resolve) => server.close(resolve)); }
});
it("permits local fixture servers and does not mistake lookalike hosts for localhost", () => {
  expect(isLocalTestRequest("http://127.0.0.1:8080/test")).toBe(true);
  expect(isLocalTestRequest("http://localhost:3000/")).toBe(true);
  expect(isLocalTestRequest("http://[::1]:3000/")).toBe(true);
  expect(isLocalTestRequest("https://localhost.example.test/")).toBe(false);
  expect(isLocalTestRequest("https://127.0.0.1.example.test/")).toBe(false);
  expect(isLocalTestRequest({ hostname: "outside.example.test" })).toBe(false);
});
