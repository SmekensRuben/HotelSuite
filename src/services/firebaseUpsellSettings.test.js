import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../firebaseConfig", () => ({ db: {}, collection: vi.fn((_db, path) => path), doc: vi.fn((_db, path, id) => id ? `${path}/${id}` : path), getDoc: vi.fn(), getDocs: vi.fn(), setDoc: vi.fn(), updateDoc: vi.fn(), deleteDoc: vi.fn(), serverTimestamp: vi.fn(() => "server-time"), writeBatch: vi.fn() }));
import { deleteDoc, getDoc, getDocs, setDoc, writeBatch } from "../firebaseConfig";
import { deleteUpsellPackageCode, getUpsellSettings, saveUpsellDailyExpectedOccupancy, saveUpsellPackageCode, saveUpsellRevenueTargetRules } from "./firebaseUpsells";
beforeEach(() => vi.clearAllMocks());

describe("private typed upsell configuration", () => {
  it("assembles only the authorized typed subcollections without reading the legacy root", async () => {
    getDocs.mockImplementation(async (path) => ({ docs: path.endsWith("packagecodes") ? [{ id: "BREAKFAST", data: () => ({ packageCode: "BREAKFAST", category: "Food", description: "Breakfast" }) }] : path.endsWith("occupancy") ? [{ id: "2026-10-10", data: () => ({ expectedOccupancy: 80 }) }] : [{ id: "target", data: () => ({ startDate: "2026-10-10", endDate: "2026-10-11", minimumTargetRevenuePerOccupiedRoom: 2, reachTargetRevenuePerOccupiedRoom: 3, stretchTargetRevenuePerOccupiedRoom: 4 }) }] }));
    expect(await getUpsellSettings("hotel")).toMatchObject({ packageCodes: [{ packageCode: "BREAKFAST" }], dailyExpectedOccupancy: { "2026-10-10": 80 }, revenueTargetRules: [{ id: "target", minimumTargetRevenuePerOccupiedRoom: 2 }] });
    expect(getDoc).not.toHaveBeenCalled();
  });
  it("removes deleted occupancy dates in the same commit as new values", async () => {
    getDocs.mockResolvedValue({ docs: [{ id: "2026-10-09", ref: "old" }, { id: "2026-10-10", ref: "current" }] });
    const batch = { set: vi.fn(), delete: vi.fn(), commit: vi.fn().mockResolvedValue() }; writeBatch.mockReturnValue(batch);
    await saveUpsellDailyExpectedOccupancy("hotel", { "2026-10-10": 90 });
    expect(batch.set).toHaveBeenCalledWith("hotels/hotel/settings/upsells/occupancy/2026-10-10", { date: "2026-10-10", expectedOccupancy: 90, updatedAt: "server-time" });
    expect(batch.delete).toHaveBeenCalledWith("old"); expect(batch.commit).toHaveBeenCalledOnce(); expect(setDoc).not.toHaveBeenCalled();
  });
  it("replaces revenue rules atomically and surfaces a rejected commit", async () => {
    getDocs.mockResolvedValue({ docs: [{ id: "old", ref: "old-ref" }] });
    const batch = { set: vi.fn(), delete: vi.fn(), commit: vi.fn().mockRejectedValue(new Error("denied")) }; writeBatch.mockReturnValue(batch);
    await expect(saveUpsellRevenueTargetRules("hotel", [{ id: "new", startDate: "2026-10-10", endDate: "2026-10-11", minimumTargetRevenuePerOccupiedRoom: 2 }])).rejects.toThrow("denied");
    expect(batch.delete).toHaveBeenCalledWith("old-ref"); expect(setDoc).not.toHaveBeenCalled();
  });
  it("does not update the denied root marker when package codes change", async () => {
    await saveUpsellPackageCode("hotel", { packageCode: "BREAKFAST" });
    expect(setDoc).toHaveBeenCalledTimes(1); expect(setDoc.mock.calls[0][0]).toBe("hotels/hotel/settings/upsells/packagecodes/BREAKFAST");
    await deleteUpsellPackageCode("hotel", "BREAKFAST"); expect(deleteDoc).toHaveBeenCalledWith("hotels/hotel/settings/upsells/packagecodes/BREAKFAST");
  });
});
