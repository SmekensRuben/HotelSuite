import { beforeEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ invoke: vi.fn(), callable: vi.fn() }));
vi.mock("../firebaseConfig", () => ({ functions: {}, httpsCallable: mock.callable }));
import { getPlatformHotel, getPlatformSupport, retryPlatformImport, listPlatformAudit } from "./firebasePlatform";
beforeEach(() => { vi.clearAllMocks(); mock.callable.mockReturnValue(mock.invoke); });
it("rejects an absent or cross-hotel response identity instead of presenting another hotel's data", async () => {
  for (const data of [{ name: "missing identity" }, { hotelUid: "other" }]) {
    mock.invoke.mockResolvedValueOnce({ data });
    await expect(getPlatformHotel("selected")).rejects.toThrow("another hotel");
  }
});
it("pins support hotel and session inputs and requires a matching response", async () => {
  mock.invoke.mockResolvedValue({ data: { hotelUid: "selected", session: { readOnly: true } } });
  await getPlatformSupport("selected", "session-1");
  expect(mock.invoke).toHaveBeenCalledWith({ hotelUid: "selected", sessionId: "session-1" });
});
it("allows the bounded import recovery timeout and preserves the explicit idempotency key", async () => {
  mock.invoke.mockResolvedValue({ data: { hotelUid: "selected", state: "complete" } });
  const input = { hotelUid: "selected", runId: "run-1", requestId: "request-1", reason: "Source fixed" };
  await retryPlatformImport(input);
  expect(mock.callable).toHaveBeenCalledWith({}, "retryPlatformImport", { timeout: 540000 });
  expect(mock.invoke).toHaveBeenCalledWith(input);
});
it("requires a matching hotel filter on scoped audit responses", async () => {
  mock.invoke.mockResolvedValue({ data: { hotelUid: "selected", events: [], nextCursor: null } });
  expect((await listPlatformAudit(null, "selected")).events).toEqual([]);
});
