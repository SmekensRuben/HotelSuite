import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import PlatformAiPage from "./PlatformAiPage";

const mocks = vi.hoisted(() => ({ auth: { currentUser: null }, context: {}, get: vi.fn(), save: vi.fn(), usage: vi.fn() }));
vi.mock("../../firebaseConfig", () => ({ auth: mocks.auth }));
vi.mock("../../contexts/AuthContext", () => ({ useAuthContext: () => mocks.context }));
vi.mock("../../services/firebasePlatformAi", () => ({ getPlatformSupplierAiImportSettings: mocks.get, savePlatformSupplierAiImportSettings: mocks.save, listPlatformSupplierAiUsage: mocks.usage }));
vi.mock("../../services/firebasePlatform", () => ({ platformError: (error) => error.code === "functions/aborted" ? "Another administrator changed this record. Refresh before saving again." : error.message }));

const configuration = { enabled: false, model: "gpt-6-luna", reasoningEffort: "low", fallbackEnabled: false, fallbackModel: null,
  maxCostPerImportUsd: 0.25, maxMonthlyCostPerHotelUsd: 10, maxInputTokens: 200000, maxOutputTokens: 32000,
  maxConcurrentJobsPerHotel: 2, maxImportsPerHotelPerDay: 20, maxCallsPerImport: 32, revision: 3, policyVersion: 1 };
const settings = { configured: true, revision: 3, configuration, secretName: "OPENAI_API_KEY", secretVerification: "not_verified",
  capabilities: { models: ["gpt-6-luna"], reasoningEfforts: ["none", "low"], fallback: false } };
const usage = { state: "available", importsStarted: 2, attemptedCalls: 3, succeededCalls: 2, unknownCalls: 1, countingCalls: 3,
  inputTokens: 12000, outputTokens: 3000, knownCostUsd: 0.003, reservedCostUsd: 0.02, actualCostUsd: null };
const page = () => ({ month: new Date().toISOString().slice(0, 7), hotels: [{ id: "hotel-a", name: "Hotel A", usage }], nextCursor: null });
const actor = () => ({ uid: "operator", emailVerified: true });
const view = () => render(<MemoryRouter><PlatformAiPage /></MemoryRouter>);
beforeEach(() => {
  vi.clearAllMocks(); mocks.auth.currentUser = actor(); mocks.context = { currentUser: mocks.auth.currentUser, isPlatformAdmin: true, authLoading: false, hotelUids: [] };
  mocks.get.mockResolvedValue(settings); mocks.usage.mockResolvedValue(page());
  mocks.save.mockResolvedValue({ ...settings, revision: 4, configuration: { ...configuration, revision: 4 } });
});
afterEach(cleanup);

it("offers shared settings to an operator with no hotel, without exposing an editable fallback or API key", async () => {
  view(); await screen.findByRole("button", { name: "Save AI settings" });
  expect(screen.getByText("gpt-6-luna")).toBeInTheDocument();
  expect(screen.getByText(/Automatic fallback is off/)).toBeInTheDocument();
  expect(screen.getByText(/availability and provider access have not been verified/)).toBeInTheDocument();
  expect(screen.getByRole("checkbox", { name: /Enable AI imports/ })).not.toBeChecked();
  expect(screen.queryByRole("combobox", { name: /model|fallback/i })).not.toBeInTheDocument();
  expect(screen.queryByRole("textbox", { name: /API key/i })).not.toBeInTheDocument();
});

it("blocks hotel users locally and makes no settings or cross-hotel usage requests", () => {
  mocks.context.isPlatformAdmin = false; view();
  expect(screen.getByRole("alert")).toHaveTextContent(/platform access/);
  expect(mocks.get).not.toHaveBeenCalled(); expect(mocks.usage).not.toHaveBeenCalled();
});

it("shows known spend and reservations separately and keeps an unknown total explicit", async () => {
  view(); await screen.findByText("Hotel A");
  expect(screen.getByText(/Total cost is unknown: 1 paid response/)).toBeInTheDocument();
  expect(screen.getByText("Known spend")).toBeInTheDocument();
  expect(screen.getByText("Reserved possible charges")).toBeInTheDocument();
  expect(screen.getByText("$0.003")).toBeInTheDocument(); expect(screen.getByText("$0.02")).toBeInTheDocument();
  expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
});

it("does not convert corrupt hotel usage into a successful zero-usage row", async () => {
  mocks.usage.mockResolvedValue({ ...page(), hotels: [{ id: "hotel-a", name: "Hotel A", usage: { state: "unavailable" } }, { id: "hotel-b", name: "Hotel B", usage: { state: "none" } }] });
  view(); await screen.findByText("Usage is unavailable. Totals cannot be verified.");
  expect(screen.getByText("No recorded AI import usage for this month.")).toBeInTheDocument();
  const failed = screen.getByText("Hotel A").closest("article");
  expect(within(failed).queryByText("Known spend")).not.toBeInTheDocument();
});

it("keeps held charges pending while an attempt is still running", async () => {
  mocks.usage.mockResolvedValue({ ...page(), hotels: [{ id: "hotel-a", name: "Hotel A", usage: { ...usage, unknownCalls: 0 } }] });
  view(); await screen.findByText(/Total cost is pending while a paid call is in progress/);
  expect(screen.queryByText(/Total cost is unknown/)).not.toBeInTheDocument();
  expect(screen.getByText("Reserved possible charges")).toBeInTheDocument();
});

it("saves explicit budgets with an optimistic revision and leaves fallback off", async () => {
  view(); await screen.findByLabelText("Maximum cost per import (USD)");
  fireEvent.click(screen.getByRole("checkbox", { name: /Enable AI imports/ }));
  fireEvent.change(screen.getByLabelText("Maximum cost per import (USD)"), { target: { value: "0.1" } });
  fireEvent.click(screen.getByRole("button", { name: "Save AI settings" }));
  await screen.findByText("AI import settings saved.");
  expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 3, requestId: expect.any(String),
    configuration: expect.objectContaining({ enabled: true, maxCostPerImportUsd: 0.1, fallbackEnabled: false, fallbackModel: null }) }));
});

it("preserves an uncertain save's exact command and prevents changing its contents before retry", async () => {
  mocks.save.mockRejectedValueOnce(new Error("Connection interrupted"));
  view(); await screen.findByRole("button", { name: "Save AI settings" });
  fireEvent.click(screen.getByRole("button", { name: "Save AI settings" }));
  await screen.findByText("Connection interrupted");
  expect(screen.getByLabelText("Maximum cost per import (USD)")).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Retry saving the same settings" }));
  await screen.findByText("AI import settings saved.");
  expect(mocks.save.mock.calls[0][0]).toEqual(mocks.save.mock.calls[1][0]);
});

it("reports concurrent settings edits and refreshes before a later save", async () => {
  mocks.save.mockRejectedValueOnce(Object.assign(new Error("stale"), { code: "functions/aborted" }));
  view(); await screen.findByRole("button", { name: "Save AI settings" });
  fireEvent.click(screen.getByRole("button", { name: "Save AI settings" }));
  await screen.findByText(/Another administrator changed this record/);
  mocks.get.mockResolvedValue({ ...settings, revision: 5, configuration: { ...configuration, revision: 5 } });
  fireEvent.click(screen.getByRole("button", { name: "Refresh settings" }));
  await screen.findByText("Policy 1 · Revision 5");
  fireEvent.click(screen.getByRole("button", { name: "Save AI settings" }));
  await waitFor(() => expect(mocks.save.mock.calls[1][0].expectedRevision).toBe(5));
});

it("clears data and fences late results when the actual operator object changes, including the same UID", async () => {
  let resolve; mocks.get.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  const rendered = view(); await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(1));
  mocks.auth.currentUser = actor(); mocks.context.currentUser = mocks.auth.currentUser;
  mocks.get.mockResolvedValue({ ...settings, configuration: { ...configuration, maxMonthlyCostPerHotelUsd: 8 } });
  rendered.rerender(<MemoryRouter><PlatformAiPage /></MemoryRouter>);
  await screen.findByLabelText("Monthly budget per hotel (USD)");
  await act(async () => resolve(settings));
  expect(screen.getByLabelText("Monthly budget per hotel (USD)")).toHaveValue(8);
});

it("removes previously loaded operator data immediately when the platform claim is lost", async () => {
  const rendered = view(); await screen.findByText("Hotel A");
  mocks.context.isPlatformAdmin = false;
  rendered.rerender(<MemoryRouter><PlatformAiPage /></MemoryRouter>);
  expect(screen.getByRole("alert")).toHaveTextContent(/platform access/);
  expect(screen.queryByText("Hotel A")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Maximum cost per import (USD)")).not.toBeInTheDocument();
});

it("pages hotel usage and resets the cursor when switching month", async () => {
  mocks.usage.mockResolvedValueOnce({ ...page(), nextCursor: "hotel-a" }).mockResolvedValue(page());
  view(); await screen.findByText("Hotel A");
  fireEvent.click(screen.getByRole("button", { name: "Next hotels" }));
  await waitFor(() => expect(mocks.usage).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "hotel-a", pageSize: 25 })));
  fireEvent.change(screen.getByLabelText("Usage month"), { target: { value: "2026-09" } });
  await waitFor(() => expect(mocks.usage).toHaveBeenLastCalledWith({ month: "2026-09", cursor: null, pageSize: 25 }));
});
