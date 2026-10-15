import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ actor: { uid: "manager", emailVerified: true, email: "manager@example.com" }, get: vi.fn(), complete: vi.fn() }));
vi.mock("../../contexts/AuthContext", () => ({ useAuthContext: () => ({ currentUser: mocks.actor, authLoading: false }) }));
vi.mock("../../services/firebaseMcpConnections", () => ({ getMcpConsent: mocks.get, completeMcpConsent: mocks.complete }));
import McpAuthorizePage from "./McpAuthorizePage";

const id = "a".repeat(43), origin = "https://chatgpt.com";
const consent = { requestId: id, client: { name: "ChatGPT", redirectOrigin: origin }, scopes: [{ id: "products:read", label: "Read product data", description: "Search catalog and supplier products." }], expiresAt: 2000000000000 };
beforeEach(() => { vi.clearAllMocks(); mocks.actor = { uid: "manager", emailVerified: true, email: "manager@example.com" }; mocks.get.mockResolvedValue(consent); mocks.complete.mockResolvedValue({ redirectUrl: `${origin}/callback?code=authorized` }); });
const show = (onRedirect = vi.fn(), path = `/mcp/authorize?requestId=${id}`) => ({ onRedirect, ...render(<MemoryRouter initialEntries={[path]}><McpAuthorizePage onRedirect={onRedirect} /></MemoryRouter>) });

it("requires explicit consent and explains the existing hotel and approval boundaries", async () => {
  show();
  await screen.findByText("ChatGPT wants to connect");
  expect(screen.getByText("Read product data")).toBeInTheDocument();
  expect(screen.getByText(/does not grant access to additional hotels/)).toBeInTheDocument();
  expect(screen.getByText(/cannot approve its own proposals/)).toBeInTheDocument();
  expect(mocks.complete).not.toHaveBeenCalled();
  expect(screen.getByRole("link", { name: "Manage my MCP connections" })).toHaveAttribute("href", "/settings/connections");
});
it("denies through the server and returns only to its validated client address", async () => {
  const redirectUrl = `${origin}/callback?error=access_denied&state=original`;
  mocks.complete.mockResolvedValue({ redirectUrl });
  const { onRedirect } = show();
  fireEvent.click(await screen.findByRole("button", { name: "Deny connection" }));
  await waitFor(() => expect(mocks.complete).toHaveBeenCalledWith(id, false, origin));
  expect(onRedirect).toHaveBeenCalledWith(redirectUrl);
  expect(await screen.findByText(/Connection declined/)).toBeInTheDocument();
});
it("allows the connection with the loaded request and client origin", async () => {
  const { onRedirect } = show();
  fireEvent.click(await screen.findByRole("button", { name: "Allow connection" }));
  await waitFor(() => expect(mocks.complete).toHaveBeenCalledWith(id, true, origin));
  expect(onRedirect).toHaveBeenCalledWith(`${origin}/callback?code=authorized`);
});
it("shows an expired request error, permits retry, and cannot approve before a request loads", async () => {
  mocks.get.mockRejectedValueOnce(new Error("This authorization request expired. Start again from your client."));
  show();
  expect(await screen.findByRole("alert")).toHaveTextContent("expired");
  expect(screen.queryByRole("button", { name: "Allow connection" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByRole("button", { name: "Allow connection" });
  expect(mocks.get).toHaveBeenCalledTimes(2);
});
it("keeps failed consent on screen and does not redirect", async () => {
  mocks.complete.mockRejectedValue(new Error("Your hotel access changed. Reconnect."));
  const { onRedirect } = show();
  fireEvent.click(await screen.findByRole("button", { name: "Allow connection" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Your hotel access changed");
  expect(onRedirect).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Deny connection" })).toBeEnabled();
});
it("ignores return URLs in the browser query and does not fetch without a request reference", () => {
  show(vi.fn(), "/mcp/authorize?returnTo=https://untrusted.example");
  expect(screen.getByRole("alert")).toHaveTextContent("authorization link");
  expect(mocks.get).not.toHaveBeenCalled();
  expect(mocks.complete).not.toHaveBeenCalled();
});
it("discards a pending consent result when the account changes", async () => {
  let resolve;
  mocks.complete.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  const { onRedirect, rerender } = show();
  fireEvent.click(await screen.findByRole("button", { name: "Allow connection" }));
  mocks.actor = { uid: "other", emailVerified: true, email: "other@example.com" };
  rerender(<MemoryRouter initialEntries={[`/mcp/authorize?requestId=${id}`]}><McpAuthorizePage onRedirect={onRedirect} /></MemoryRouter>);
  await screen.findByText("other@example.com");
  await act(async () => resolve({ redirectUrl: `${origin}/callback?code=old-account` }));
  expect(onRedirect).not.toHaveBeenCalled();
});
it("never starts consent for an unverified account", () => {
  mocks.actor = { uid: "unverified", emailVerified: false };
  show(); expect(screen.getByRole("alert")).toHaveTextContent("verified"); expect(mocks.get).not.toHaveBeenCalled();
});
