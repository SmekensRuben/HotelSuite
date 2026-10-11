import { describe, expect, it } from "vitest";
import { publicDemoLink } from "./publicDemoLink";

describe("public demo contact", () => {
  it("uses a configured HTTPS booking URL", () => {
    expect(publicDemoLink({ url: "https://example.com/book?team=hotel" })).toBe(
      "https://example.com/book?team=hotel",
    );
  });
  it("can compose an email request without claiming it has been sent", () => {
    expect(publicDemoLink({ email: "demo@example.com" })).toBe(
      "mailto:demo@example.com?subject=Hotel%20Toolkit%20demo",
    );
  });
  it.each([
    "javascript:alert(1)",
    "data:text/html,hello",
    "http://example.com",
    "https://user:password@example.com",
    "invalid",
  ])("rejects unsafe or invalid URL %s", (url) => {
    expect(publicDemoLink({ url })).toBeNull();
  });
  it.each([
    "",
    "not-an-email",
    "demo@example.com?body=injected",
    "demo@example.com\nBcc:other@example.com",
    "demo%0aBcc%3aother@example.com",
  ])("does not invent or accept malformed email %s", (email) => {
    expect(publicDemoLink({ email })).toBeNull();
  });
});
