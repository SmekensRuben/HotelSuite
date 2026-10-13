import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auth: { currentUser: null }, invoke: vi.fn(), callable: vi.fn() }));
vi.mock("../firebaseConfig", () => ({ auth: mocks.auth, functions: {}, httpsCallable: mocks.callable }));
import { getPlatformSupplierAiImportSettings, savePlatformSupplierAiImportSettings, listPlatformSupplierAiUsage } from "./firebasePlatformAi";

const configuration = { enabled: false, model: "gpt-6-luna", reasoningEffort: "low", fallbackEnabled: false, fallbackModel: null,
  maxCostPerImportUsd: 0.25, maxMonthlyCostPerHotelUsd: 10, maxInputTokens: 200000, maxOutputTokens: 32000,
  maxConcurrentJobsPerHotel: 2, maxImportsPerHotelPerDay: 20, maxCallsPerImport: 32, revision: 3, policyVersion: 1 };
const settings = { configured: true, revision: 3, configuration, secretName: "OPENAI_API_KEY", secretVerification: "not_verified",
  capabilities: { models: ["gpt-6-luna"], reasoningEfforts: ["none", "low"], fallback: false } };
const usage = { state: "available", importsStarted: 2, attemptedCalls: 3, succeededCalls: 2, unknownCalls: 1, countingCalls: 3,
  inputTokens: 12000, outputTokens: 3000, knownCostUsd: 0.003, reservedCostUsd: 0.02, actualCostUsd: null };
const usagePage = { month: "2026-10", hotels: [{ id: "hotel-a", name: "Hotel A", usage }], nextCursor: null };
const actor = () => ({ uid: "operator", emailVerified: true, getIdTokenResult: vi.fn(async () => ({ claims: { platformAdmin: true } })) });
beforeEach(() => { vi.clearAllMocks(); mocks.auth.currentUser = actor(); mocks.callable.mockReturnValue(mocks.invoke); mocks.invoke.mockResolvedValue({ data: settings }); });

it("loads operator settings without a hotel or secret value and checks current claims without forcing token events", async () => {
  expect(await getPlatformSupplierAiImportSettings()).toEqual(settings);
  expect(mocks.callable).toHaveBeenCalledWith({}, "getPlatformSupplierAiImportSettings");
  expect(mocks.invoke).toHaveBeenCalledWith({});
  expect(mocks.auth.currentUser.getIdTokenResult.mock.calls).toEqual([[], []]);
  expect(JSON.stringify(settings)).not.toContain("secretValue");
});

it("does not make a platform request for a normal hotel user, unverified account or absent actor", async () => {
  for (const user of [null, { ...actor(), emailVerified: false }, { ...actor(), getIdTokenResult: vi.fn(async () => ({ claims: {} })) }]) {
    mocks.auth.currentUser = user;
    await expect(getPlatformSupplierAiImportSettings()).rejects.toThrow(/platform access/);
  }
  expect(mocks.invoke).not.toHaveBeenCalled();
});

it("rejects a replaced actual Auth object even when its UID is unchanged", async () => {
  let resolve; mocks.invoke.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  const pending = getPlatformSupplierAiImportSettings();
  await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(1));
  mocks.auth.currentUser = actor(); resolve({ data: settings });
  await expect(pending).rejects.toThrow(/platform access/);
});

it("rejects an operator claim revoked while a response is in flight", async () => {
  const user = mocks.auth.currentUser;
  user.getIdTokenResult.mockResolvedValueOnce({ claims: { platformAdmin: true } }).mockResolvedValueOnce({ claims: {} });
  await expect(getPlatformSupplierAiImportSettings()).rejects.toThrow(/platform access/);
});

it("rejects unsupported model, fallback, absent cost cap or mismatched revision responses", async () => {
  for (const data of [{ ...settings, configuration: { ...configuration, model: "gpt-6-sol" } },
    { ...settings, configuration: { ...configuration, fallbackEnabled: true, fallbackModel: "gpt-6-sol" } },
    { ...settings, configuration: { ...configuration, maxCostPerImportUsd: null } },
    { ...settings, revision: 4 }]) {
    mocks.invoke.mockResolvedValueOnce({ data }); await expect(getPlatformSupplierAiImportSettings()).rejects.toThrow(/verified/);
  }
});

it("pins saves to their revision and request ID and rejects fallback before network I/O", async () => {
  const input = { configuration, expectedRevision: 3, requestId: "settings-request" };
  mocks.invoke.mockResolvedValueOnce({ data: { ...settings, revision: 4, configuration: { ...configuration, revision: 4 } } });
  await savePlatformSupplierAiImportSettings(input);
  expect(mocks.invoke).toHaveBeenCalledWith(input);
  mocks.invoke.mockResolvedValueOnce({ data: settings });
  await expect(savePlatformSupplierAiImportSettings(input)).rejects.toThrow(/acknowledgement/);
  const calls = mocks.invoke.mock.calls.length;
  await expect(savePlatformSupplierAiImportSettings({ ...input, configuration: { ...configuration, fallbackEnabled: true } })).rejects.toThrow(/verified/);
  expect(mocks.invoke).toHaveBeenCalledTimes(calls);
});

it("preserves unknown charges as null and rejects zero totals for unknown paid responses", async () => {
  mocks.invoke.mockResolvedValueOnce({ data: usagePage });
  expect((await listPlatformSupplierAiUsage({ month: "2026-10" })).hotels[0].usage.actualCostUsd).toBeNull();
  mocks.invoke.mockResolvedValueOnce({ data: { ...usagePage, hotels: [{ ...usagePage.hotels[0], usage: { ...usage, actualCostUsd: 0 } }] } });
  await expect(listPlatformSupplierAiUsage({ month: "2026-10" })).rejects.toThrow(/verified/);
});

it("requires bounded, matching usage pages and rejects missing accounting fields or repeated cursors", async () => {
  for (const data of [{ ...usagePage, month: "2026-11" }, { ...usagePage, nextCursor: "current" },
    { ...usagePage, hotels: [usagePage.hotels[0], usagePage.hotels[0]] },
    { ...usagePage, hotels: [{ ...usagePage.hotels[0], usage: { ...usage, reservedCostUsd: undefined } }] }]) {
    mocks.invoke.mockResolvedValueOnce({ data });
    await expect(listPlatformSupplierAiUsage({ month: "2026-10", cursor: "current" })).rejects.toThrow(/verified/);
  }
  const calls = mocks.invoke.mock.calls.length;
  await expect(listPlatformSupplierAiUsage({ month: "2026-13" })).rejects.toThrow(/month/);
  await expect(listPlatformSupplierAiUsage({ month: "2026-10", pageSize: 51 })).rejects.toThrow(/month/);
  expect(mocks.invoke).toHaveBeenCalledTimes(calls);
});

it("keeps corrupt usage unavailable rather than manufacturing zero spend", async () => {
  mocks.invoke.mockResolvedValueOnce({ data: { ...usagePage, hotels: [{ id: "hotel-a", name: "Hotel A", usage: { state: "unavailable" } }] } });
  expect((await listPlatformSupplierAiUsage({ month: "2026-10" })).hotels[0].usage).toEqual({ state: "unavailable" });
});

it("accepts pending cost with a held reservation even before an unknown response is recorded", async () => {
  mocks.invoke.mockResolvedValueOnce({ data: { ...usagePage, hotels: [{ ...usagePage.hotels[0], usage: { ...usage, unknownCalls: 0 } }] } });
  expect((await listPlatformSupplierAiUsage({ month: "2026-10" })).hotels[0].usage.actualCostUsd).toBeNull();
});

it("verifies the original applied revision when an idempotent settings replay returns newer settings", async () => {
  const input = { configuration, expectedRevision: 3, requestId: "settings-request" };
  mocks.invoke.mockResolvedValueOnce({ data: { ...settings, revision: 6, configuration: { ...configuration, revision: 6 }, replayed: true, appliedRevision: 4 } });
  expect((await savePlatformSupplierAiImportSettings(input)).revision).toBe(6);
  mocks.invoke.mockResolvedValueOnce({ data: { ...settings, revision: 6, configuration: { ...configuration, revision: 6 }, replayed: true, appliedRevision: 5 } });
  await expect(savePlatformSupplierAiImportSettings(input)).rejects.toThrow(/acknowledgement/);
});
