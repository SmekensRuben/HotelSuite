import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ actor: { uid: "manager", emailVerified: true }, call: vi.fn() }));
vi.mock("../firebaseConfig", () => ({ auth: { get currentUser() { return mocks.actor; } }, functions: {}, httpsCallable: (_functions, endpoint) => (input) => mocks.call(endpoint, input) }));
import { completeMcpConsent, getMcpConsent, listMcpConnections, revokeMcpConnection } from "./firebaseMcpConnections";

const id = "a".repeat(43), expiresAt = 2000000000000;
const consent = { requestId: id, client: { name: "Codex", redirectOrigin: "http://localhost:1455" }, scopes: [{ id: "products:read", label: "Read product data", description: "Search products at hotels you can access." }], expiresAt };
const connection = { id, clientName: "Codex", scopes: ["products:read"], createdAt: 1900000000000, expiresAt };
beforeEach(() => { vi.clearAllMocks(); mocks.actor = { uid: "manager", emailVerified: true }; });

describe("personal MCP connections", () => {
  it("uses the signed-in verified identity without sending a user or hotel ID", async () => {
    mocks.call.mockResolvedValue({ data: consent });
    expect(await getMcpConsent(id)).toEqual(consent);
    expect(mocks.call).toHaveBeenCalledWith("getHotelMcpConsent", { requestId: id });
    mocks.actor.emailVerified = false;
    await expect(getMcpConsent(id)).rejects.toThrow("verified");
    expect(mocks.call).toHaveBeenCalledTimes(1);
  });
  it("requires an opaque server request reference", async () => {
    await expect(getMcpConsent("https://untrusted.example/return")).rejects.toThrow("authorization link");
    await expect(revokeMcpConnection("manager")).rejects.toThrow("valid MCP connection");
    expect(mocks.call).not.toHaveBeenCalled();
  });
  it("projects consent and connection metadata without retaining returned credentials", async () => {
    mocks.call.mockResolvedValueOnce({ data: { ...consent, accessToken: "private-token", client: { ...consent.client, secret: "private-secret" } } });
    expect(JSON.stringify(await getMcpConsent(id))).not.toMatch(/private-/);
    mocks.call.mockResolvedValueOnce({ data: { connections: [{ ...connection, refreshToken: "private-token" }], configuration: { enabled: true, resourceUrl: "https://toolkit.example/mcp", clientSecret: "private-secret" } } });
    expect(await listMcpConnections()).toEqual({ connections: [connection], configuration: { enabled: true, resourceUrl: "https://toolkit.example/mcp" } });
  });
  it("returns a denied authorization only to the server-validated client origin", async () => {
    mocks.call.mockResolvedValueOnce({ data: { redirectUrl: "http://localhost:1455/callback?error=access_denied&state=original" } });
    expect(await completeMcpConsent(id, false, "http://localhost:1455")).toEqual({ redirectUrl: "http://localhost:1455/callback?error=access_denied&state=original" });
    expect(mocks.call).toHaveBeenCalledWith("completeHotelMcpConsent", { requestId: id, approve: false });
    mocks.call.mockResolvedValueOnce({ data: { redirectUrl: "https://untrusted.example/callback?code=secret" } });
    await expect(completeMcpConsent(id, true, "https://chatgpt.com")).rejects.toThrow("return address changed");
  });
  it.each(["javascript:alert(1)", "http://remote.example/callback", "https://user:password@chatgpt.com/callback"])("refuses an unsafe callback URL: %s", async (redirectUrl) => {
    mocks.call.mockResolvedValue({ data: { redirectUrl } });
    await expect(completeMcpConsent(id, true, "https://chatgpt.com")).rejects.toThrow("could not be verified");
  });
  it("drops a response if the signed-in account changes, including another session for the same UID", async () => {
    mocks.call.mockImplementation(async () => { mocks.actor = { uid: "manager", emailVerified: true }; return { data: consent }; });
    await expect(getMcpConsent(id)).rejects.toThrow("account changed");
  });
  it("accepts only a confirmed revocation receipt", async () => {
    mocks.call.mockResolvedValueOnce({ data: { revoked: false } });
    await expect(revokeMcpConnection(id)).rejects.toThrow("could not be verified");
    mocks.call.mockResolvedValueOnce({ data: { revoked: true, accessToken: "discarded" } });
    expect(await revokeMcpConnection(id)).toEqual({ revoked: true });
    expect(mocks.call).toHaveBeenLastCalledWith("revokeHotelMcpConnection", { connectionId: id });
  });
  it("preserves a safe setup failure without treating unavailable connections as an empty list", async () => {
    mocks.call.mockRejectedValueOnce(Object.assign(new Error("Firebase: MCP setup is incomplete. Ask your operator to finish setup, then retry."), {
      code: "functions/failed-precondition", details: { reason: "mcp-index-required", area: "connections",
        indexKey: "hotelMcpOAuthConnections", rawProviderMessage: "private-provider-evidence", accessToken: "private-token" },
    }));
    const failure = await listMcpConnections().catch((error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toBe("MCP setup is incomplete. Ask your operator to finish setup, then retry.");
    expect(failure.code).toBe("functions/failed-precondition");
    expect(failure.details).toEqual({ reason: "mcp-index-required", area: "connections", indexKey: "hotelMcpOAuthConnections" });
    expect(JSON.stringify(failure)).not.toMatch(/private-/);
    mocks.call.mockResolvedValueOnce({ data: { connections: [connection], configuration: { enabled: true, resourceUrl: "https://toolkit.example/mcp" } } });
    expect((await listMcpConnections()).connections).toEqual([connection]);
  });
  it("retains ordinary callable error codes without copying unrecognized diagnostic details", async () => {
    mocks.call.mockRejectedValueOnce(Object.assign(new Error("Access denied"), { code: "functions/permission-denied", details: { raw: "private" } }));
    const failure = await listMcpConnections().catch((error) => error);
    expect(failure.code).toBe("functions/permission-denied"); expect(failure.details).toBeUndefined();
  });
});
