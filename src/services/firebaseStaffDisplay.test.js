import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ call: vi.fn(), auth: { currentUser: { uid: "buyer" } } }));
vi.mock("../firebaseConfig", () => ({ auth: mocks.auth, functions: {}, httpsCallable: (_functions, endpoint) => async (input) => ({ data: await mocks.call(endpoint, input) }) }));
import { getHotelUserDisplayName, getHotelUserDisplayNames } from "./firebaseUserManagement";
import { invalidateProcurementReads } from "./procurementReadPool";
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

beforeEach(() => {
  vi.clearAllMocks(); invalidateProcurementReads(); mocks.auth.currentUser = { uid: "buyer" };
  mocks.call.mockImplementation(async (_endpoint, input) => ({ hotelUid: input.hotelUid, users: input.userIds.map((userId) => ({ userId, displayName: `Employee ${userId}` })) }));
});

describe("optional hotel-scoped staff labels", () => {
  it("batches and deduplicates simultaneous created/updated lookups instead of issuing N calls", async () => {
    expect(await Promise.all([
      getHotelUserDisplayName("hotel-a", "ada"), getHotelUserDisplayName("hotel-a", "grace"), getHotelUserDisplayName("hotel-a", "ada"),
    ])).toEqual(["Employee ada", "Employee grace", "Employee ada"]);
    expect(mocks.call).toHaveBeenCalledTimes(1);
    expect(mocks.call).toHaveBeenCalledWith("getHotelUserDisplayNames", { hotelUid: "hotel-a", userIds: ["ada", "grace"] });
  });

  it("chunks larger views at the server's 100-actor bound", async () => {
    const userIds = Array.from({ length: 121 }, (_, index) => `user-${index}`);
    const names = await getHotelUserDisplayNames("hotel-a", userIds);
    expect(Object.keys(names)).toHaveLength(121);
    expect(mocks.call.mock.calls.map(([, input]) => input.userIds.length)).toEqual([100, 21]);
  });

  it("labels unavailable or unidentified staff explicitly and never displays raw document IDs", async () => {
    mocks.call.mockResolvedValue({ hotelUid: "hotel-a", users: [{ userId: "former-staff-id", displayName: null }, { userId: "unknown-id", displayName: "unknown-id" }] });
    expect(await getHotelUserDisplayNames("hotel-a", ["former-staff-id", "unknown-id"])).toEqual({ "former-staff-id": "Unknown hotel user", "unknown-id": "Unknown hotel user" });
  });

  it("rejects foreign scope, unexpected actors and incomplete projection responses", async () => {
    for (const data of [
      { hotelUid: "hotel-b", users: [{ userId: "ada", displayName: "Other hotel staff" }] },
      { hotelUid: "hotel-a", users: [{ userId: "foreign", displayName: "Foreign profile" }] },
      { hotelUid: "hotel-a", users: [] },
    ]) {
      mocks.call.mockResolvedValueOnce(data);
      await expect(getHotelUserDisplayNames("hotel-a", ["ada"])).rejects.toThrow("response");
    }
  });

  it("does not reuse a failed label read", async () => {
    mocks.call.mockRejectedValueOnce(new Error("Offline"));
    await expect(getHotelUserDisplayName("hotel-a", "ada")).rejects.toThrow("Offline");
    await expect(getHotelUserDisplayName("hotel-a", "ada")).resolves.toBe("Employee ada");
    expect(mocks.call).toHaveBeenCalledTimes(2);
  });

  it("separates hotel batches and rejects old names after authorization changes", async () => {
    const pending = deferred(); mocks.call.mockReturnValueOnce(pending.promise);
    const old = getHotelUserDisplayName("hotel-a", "ada");
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    invalidateProcurementReads();
    const current = getHotelUserDisplayName("hotel-b", "ada");
    pending.resolve({ hotelUid: "hotel-a", users: [{ userId: "ada", displayName: "Old staff" }] });
    await expect(old).rejects.toThrow("Hotel access changed");
    await expect(current).resolves.toBe("Employee ada");
    expect(mocks.call.mock.calls.map(([, input]) => input.hotelUid)).toEqual(["hotel-a", "hotel-b"]);
  });
});
