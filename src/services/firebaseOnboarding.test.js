import { beforeEach, expect, it, vi } from "vitest";
import { getHotelSetupReadiness } from "./firebaseOnboarding";
const mocks = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("../firebaseConfig", () => ({ functions: {}, httpsCallable: (_, name) => { expect(name).toBe("getHotelSetupReadiness"); return mocks.call; } }));
const data = () => ({ hotelUid: "hotel-a", schemaVersion: 1, status: "unknown", computedAtMillis: 1,
  checks: [{ id: "integrity", label: "Integrity", detail: "Unknown evidence", status: "unknown", required: true }],
  integrity: { issues: [], issueCount: 0, issuesTruncated: false, inspectionTruncated: false }, recentInvitations: [] });
beforeEach(() => { vi.resetAllMocks(); });
it("uses the platform callable with a selected hotel and preserves unknown evidence", async () => {
  mocks.call.mockResolvedValue({ data: data() });
  expect((await getHotelSetupReadiness("hotel-a")).status).toBe("unknown");
  expect(mocks.call).toHaveBeenCalledWith({ hotelUid: "hotel-a" });
});
it("rejects missing, corrupt and cross-hotel readiness responses", async () => {
  for (const response of [null, {}, { ...data(), hotelUid: "hotel-b" }, { ...data(), checks: [] },
    { ...data(), computedAtMillis: NaN }, { ...data(), status: "success" }, { ...data(), status: "ready" },
    { ...data(), integrity: { issues: [] } }]) {
    mocks.call.mockResolvedValue({ data: response });
    await expect(getHotelSetupReadiness("hotel-a")).rejects.toThrow(/incomplete|another hotel/);
  }
});
