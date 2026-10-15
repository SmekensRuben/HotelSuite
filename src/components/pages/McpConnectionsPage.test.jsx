import React from "react";
import { act, fireEvent, render as renderComponent, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ actor: { uid: "manager", emailVerified: true }, isPlatformAdmin: false, hotelUids: [], list: vi.fn(), revoke: vi.fn() }));
vi.mock("../../contexts/AuthContext", () => ({ useAuthContext: () => ({ currentUser: mocks.actor, authLoading: false, isPlatformAdmin: mocks.isPlatformAdmin, hotelUids: mocks.hotelUids }) }));
vi.mock("../../services/firebaseMcpConnections", () => ({ listMcpConnections: mocks.list, revokeMcpConnection: mocks.revoke }));
import McpConnectionsPage from "./McpConnectionsPage";

const id = "a".repeat(43);
const connection = { id, clientName: "Codex", scopes: ["products:read", "products:propose"], createdAt: 1900000000000, expiresAt: 2000000000000 };
const response = { connections: [connection], configuration: { enabled: true, resourceUrl: "https://toolkit.example/mcp" } };
beforeEach(() => { vi.clearAllMocks(); mocks.actor = { uid: "manager", emailVerified: true }; mocks.isPlatformAdmin = false; mocks.hotelUids = []; mocks.list.mockResolvedValue(response); mocks.revoke.mockResolvedValue({ revoked: true }); });
const render = (element) => renderComponent(element, { wrapper: MemoryRouter });

it("loads personal connections without selecting a hotel and exposes no credential fields", async () => {
  render(<McpConnectionsPage />);
  expect(await screen.findByDisplayValue("https://toolkit.example/mcp")).toHaveAttribute("readonly");
  expect(screen.getByRole("heading", { name: "Codex" })).toBeInTheDocument();
  expect(screen.getByText(/do not need to select a hotel/)).toBeInTheDocument();
  expect(screen.getByText(/preregistered OAuth client ID/)).toBeInTheDocument();
  expect(mocks.list).toHaveBeenCalledWith();
  expect(screen.queryByLabelText(/token|secret|password/i)).not.toBeInTheDocument();
});
it.each([
  { isPlatformAdmin: true, hotelUids: [], destination: "/platform" },
  { isPlatformAdmin: false, hotelUids: ["hotel-a"], destination: "/dashboard" },
  { isPlatformAdmin: false, hotelUids: [], destination: "/access" },
])("returns to the appropriate workspace at $destination", async ({ isPlatformAdmin, hotelUids, destination }) => {
  mocks.isPlatformAdmin = isPlatformAdmin; mocks.hotelUids = hotelUids;
  render(<McpConnectionsPage />);
  expect(screen.getByRole("link", { name: "Back to workspace" })).toHaveAttribute("href", destination);
  await screen.findByRole("heading", { name: "Codex" });
});
it("requires confirmation before revocation and allows cancellation", async () => {
  render(<McpConnectionsPage />);
  fireEvent.click(await screen.findByRole("button", { name: "Revoke Codex connection" }));
  expect(mocks.revoke).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Keep connection" }));
  expect(screen.queryByRole("button", { name: "Confirm revocation" })).not.toBeInTheDocument();
  expect(mocks.revoke).not.toHaveBeenCalled();
});
it("revokes only the selected personal grant and refreshes the list", async () => {
  render(<McpConnectionsPage />);
  fireEvent.click(await screen.findByRole("button", { name: "Revoke Codex connection" }));
  mocks.list.mockResolvedValueOnce({ ...response, connections: [] });
  fireEvent.click(screen.getByRole("button", { name: "Confirm revocation" }));
  await waitFor(() => expect(mocks.revoke).toHaveBeenCalledWith(id));
  expect(await screen.findByText("Codex connection revoked.")).toBeInTheDocument();
  expect(screen.getByText("No authorized MCP clients yet.")).toBeInTheDocument();
});
it("keeps failed revocation visible for a safe retry", async () => {
  mocks.revoke.mockRejectedValueOnce(new Error("Network interrupted. Retry revocation."));
  render(<McpConnectionsPage />);
  fireEvent.click(await screen.findByRole("button", { name: "Revoke Codex connection" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm revocation" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Network interrupted");
  expect(screen.getByRole("heading", { name: "Codex" })).toBeInTheDocument();
  mocks.list.mockResolvedValueOnce({ ...response, connections: [] });
  fireEvent.click(screen.getByRole("button", { name: "Confirm revocation" }));
  expect(await screen.findByText("Codex connection revoked.")).toBeInTheDocument();
  expect(mocks.revoke).toHaveBeenCalledTimes(2);
});
it("offers retry after a connection-list error", async () => {
  mocks.list.mockRejectedValueOnce(new Error("Connection list unavailable."));
  render(<McpConnectionsPage />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Connection list unavailable");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByRole("heading", { name: "Codex" });
});
it("distinguishes missing hosting configuration from having no grants", async () => {
  mocks.list.mockResolvedValue({ connections: [], configuration: { enabled: false, resourceUrl: null } });
  render(<McpConnectionsPage />);
  expect(await screen.findByText(/not enabled for this environment/)).toBeInTheDocument();
  expect(screen.getByText("No authorized MCP clients yet.")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Copy MCP server URL" })).not.toBeInTheDocument();
});
it("discards a pending revocation acknowledgement after the account changes", async () => {
  let resolve;
  mocks.revoke.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  const view = render(<McpConnectionsPage />);
  fireEvent.click(await screen.findByRole("button", { name: "Revoke Codex connection" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm revocation" }));
  mocks.actor = { uid: "other", emailVerified: true };
  mocks.list.mockResolvedValue({ ...response, connections: [] });
  view.rerender(<McpConnectionsPage />);
  await screen.findByText("No authorized MCP clients yet.");
  await act(async () => resolve({ revoked: true }));
  expect(screen.queryByText("Codex connection revoked.")).not.toBeInTheDocument();
});
