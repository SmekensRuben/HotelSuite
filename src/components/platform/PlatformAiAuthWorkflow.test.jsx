import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HotelProvider } from "../../contexts/HotelContext";
import PlatformRoute from "../shared/PlatformRoute";
import PlatformAiPage from "./PlatformAiPage";

// Keep the actual provider, route, page, query hook and platform service together.
// A forced SDK refresh can emit onIdTokenChanged, unlike isolated service mocks.
const mocks = vi.hoisted(() => ({ auth: { currentUser: null }, observers: new Set(), claims: {},
  forcedRefreshes: 0, invoke: vi.fn(), getDoc: vi.fn(), tokenObserver: vi.fn() }));
vi.mock("../../firebaseConfig", () => ({ auth: mocks.auth, authPolicy: { requireMfa: false }, db: {}, functions: {},
  doc: (_db, path, id) => ({ path: id ? `${path}/${id}` : path }), getDoc: mocks.getDoc,
  onSnapshot: vi.fn(() => () => {}), httpsCallable: (_functions, name) => (data) => mocks.invoke(name, data) }));
vi.mock("../../services/firebaseSettings", () => ({ getHotelBootstrap: vi.fn() }));
vi.mock("../../i18n", () => ({ default: { changeLanguage: vi.fn() } }));
vi.mock("../../utils/hotelUtils", () => ({ getSelectedHotelUid: () => null, setSelectedHotelUid: vi.fn() }));

const configuration = { enabled: false, model: "gpt-6-luna", reasoningEffort: "low", fallbackEnabled: false, fallbackModel: null,
  maxCostPerImportUsd: 0.25, maxMonthlyCostPerHotelUsd: 10, maxInputTokens: 200000, maxOutputTokens: 32000,
  maxConcurrentJobsPerHotel: 2, maxImportsPerHotelPerDay: 20, maxCallsPerImport: 32, revision: 0, policyVersion: 1 };
const settings = { configured: false, revision: 0, configuration, secretName: "OPENAI_API_KEY", secretVerification: "not_verified",
  capabilities: { models: ["gpt-6-luna"], reasoningEfforts: ["none", "low"], fallback: false } };
const usage = () => ({ month: new Date().toISOString().slice(0, 7), hotels: [{ id: "hotel-a", name: "Hotel A", usage: {
  state: "none", importsStarted: 0, attemptedCalls: 0, succeededCalls: 0, unknownCalls: 0, countingCalls: 0,
  inputTokens: 0, outputTokens: 0, knownCostUsd: 0, reservedCostUsd: 0, actualCostUsd: 0 } }], nextCursor: null });
const show = () => render(<HotelProvider><MemoryRouter initialEntries={["/platform/ai"]}><Routes>
  <Route path="/platform/ai" element={<PlatformRoute><PlatformAiPage /></PlatformRoute>} />
  <Route path="/access" element={<p>Hotel assignment needed</p>} />
  <Route path="/login" element={<p>Login</p>} />
</Routes></MemoryRouter></HotelProvider>);
const calls = (name) => mocks.invoke.mock.calls.filter(([method]) => method === name).length;
const notify = async () => { await Promise.all([...mocks.observers].map((callback) => callback(mocks.auth.currentUser))); };
beforeEach(() => {
  vi.clearAllMocks(); mocks.observers.clear(); mocks.claims = { platformAdmin: true }; mocks.forcedRefreshes = 0;
  mocks.auth.currentUser = { uid: "operator", emailVerified: true, getIdTokenResult: vi.fn(async (force) => {
    if (force) {
      // Bound the broken behavior so this regression fails without a runaway loop.
      if (++mocks.forcedRefreshes > 8) throw new Error("Excessive forced token refreshes");
      queueMicrotask(() => { void notify(); });
    }
    return { claims: { ...mocks.claims } };
  }) };
  mocks.tokenObserver.mockImplementation((callback) => {
    mocks.observers.add(callback); queueMicrotask(() => { if (mocks.observers.has(callback)) void callback(mocks.auth.currentUser); });
    return () => mocks.observers.delete(callback);
  });
  mocks.auth.onIdTokenChanged = mocks.tokenObserver;
  mocks.getDoc.mockResolvedValue({ exists: () => false });
  mocks.invoke.mockImplementation(async (name) => ({ data: name === "getPlatformSupplierAiImportSettings" ? settings : usage() }));
});
afterEach(cleanup);

it("loads settings and usage once through the real auth route without a token-refresh remount loop", async () => {
  show(); await screen.findByRole("button", { name: "Save AI settings" }); await screen.findByText("Hotel A");
  await act(async () => {});
  expect(calls("getPlatformSupplierAiImportSettings")).toBe(1);
  expect(calls("listPlatformSupplierAiUsage")).toBe(1);
  expect(mocks.forcedRefreshes).toBe(0);
  expect(mocks.tokenObserver).toHaveBeenCalledTimes(1);
  expect(screen.queryByText(/Checking platform access/i)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Refresh usage" }));
  await waitFor(() => expect(calls("listPlatformSupplierAiUsage")).toBe(2));
  await screen.findByText("Hotel A");
  expect(calls("getPlatformSupplierAiImportSettings")).toBe(1);
  expect(mocks.forcedRefreshes).toBe(0);
});

it("settles after an ordinary same-user token event without starting another refresh cycle", async () => {
  show(); await screen.findByText("Hotel A");
  let resolveProfile, refreshing;
  mocks.getDoc.mockReturnValueOnce(new Promise((resolve) => { resolveProfile = resolve; }));
  act(() => { refreshing = notify(); });
  await screen.findByText("Checking platform access...");
  await act(async () => { resolveProfile({ exists: () => false }); await refreshing; });
  await screen.findByRole("button", { name: "Save AI settings" }); await screen.findByText("Hotel A");
  await act(async () => {});
  expect(calls("getPlatformSupplierAiImportSettings")).toBe(2);
  expect(calls("listPlatformSupplierAiUsage")).toBe(2);
  expect(mocks.forcedRefreshes).toBe(0);
  expect(screen.queryByText(/Checking platform access/i)).not.toBeInTheDocument();
});

it("still removes platform access and ignores a delayed settings response after claim revocation", async () => {
  let resolveSettings;
  mocks.invoke.mockImplementation(async (name) => name === "getPlatformSupplierAiImportSettings"
    ? new Promise((resolve) => { resolveSettings = resolve; }) : { data: usage() });
  show(); await waitFor(() => expect(calls("getPlatformSupplierAiImportSettings")).toBe(1));
  mocks.claims = {};
  await act(notify);
  await screen.findByText("Hotel assignment needed");
  await act(async () => { resolveSettings({ data: settings }); });
  expect(screen.queryByRole("button", { name: "Save AI settings" })).not.toBeInTheDocument();
  expect(screen.queryByText("Hotel A")).not.toBeInTheDocument();
  expect(calls("getPlatformSupplierAiImportSettings")).toBe(1);
  expect(mocks.forcedRefreshes).toBe(0);
});
