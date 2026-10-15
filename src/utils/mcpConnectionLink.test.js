import { describe, expect, it } from "vitest";
import { mcpConnectionReturnPath } from "./mcpConnectionLink";

describe("personal MCP login return links", () => {
  it("preserves only a known connection page or exact opaque consent request", () => {
    const consent = `/mcp/authorize?requestId=${"a".repeat(43)}`;
    expect(mcpConnectionReturnPath(consent)).toBe(consent);
    expect(mcpConnectionReturnPath("/settings/connections")).toBe("/settings/connections");
  });
  it.each([undefined, "https://external.example/mcp/authorize", "//external.example", "/platform", "/mcp/authorize?requestId=invalid", `/mcp/authorize?requestId=${"a".repeat(43)}&redirect=https://external.example`, "/settings/connections#fragment", "/settings/connections?redirect=external"])("rejects an untrusted or unrelated return destination %j", (value) => {
    expect(mcpConnectionReturnPath(value)).toBeNull();
  });
});
