import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: { currentUser: { uid: "buyer" } } }));
vi.mock("../firebaseConfig", () => ({ auth: mocks.auth }));
import { invalidateProcurementReads, poolProcurementRead } from "./procurementReadPool";
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

beforeEach(() => { invalidateProcurementReads(); mocks.auth.currentUser = { uid: "buyer" }; });

describe("scoped concurrent procurement reads", () => {
  it("shares concurrent reads but reloads settled operational data", async () => {
    const pending = deferred(), load = vi.fn(() => pending.promise);
    const first = poolProcurementRead("hotel-a", "catalog", load);
    const second = poolProcurementRead("hotel-a", "catalog", load);
    expect(first).toBe(second);
    pending.resolve(["first"]);
    expect(await first).toEqual(["first"]);
    expect(load).toHaveBeenCalledTimes(1);
    await poolProcurementRead("hotel-a", "catalog", load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("does not cache failed reads", async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error("Offline")).mockResolvedValue("fresh");
    await expect(poolProcurementRead("hotel-a", "catalog", load)).rejects.toThrow("Offline");
    await expect(poolProcurementRead("hotel-a", "catalog", load)).resolves.toBe("fresh");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("partitions hotels and explicit access scopes", async () => {
    const load = vi.fn(async () => "ready");
    await Promise.all([
      poolProcurementRead("hotel-a", "catalog", load, "read-grant-1"),
      poolProcurementRead("hotel-b", "catalog", load, "read-grant-1"),
      poolProcurementRead("hotel-a", "catalog", load, "read-grant-2"),
    ]);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("rejects the previous actor response and does not share a new actor's request", async () => {
    const pending = deferred(), load = vi.fn(() => pending.promise);
    const old = poolProcurementRead("hotel-a", "catalog", load);
    mocks.auth.currentUser = { uid: "other-buyer" };
    const current = poolProcurementRead("hotel-a", "catalog", load);
    pending.resolve("hotel-data");
    await expect(old).rejects.toThrow("Hotel access changed");
    await expect(current).resolves.toBe("hotel-data");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("partitions a new sign-in session even when the UID is unchanged", async () => {
    const pending = deferred(), load = vi.fn(() => pending.promise);
    const old = poolProcurementRead("hotel-a", "catalog", load);
    mocks.auth.currentUser = { uid: "buyer" };
    const current = poolProcurementRead("hotel-a", "catalog", load);
    pending.resolve("fresh-session");
    await expect(old).rejects.toThrow("Hotel access changed");
    await expect(current).resolves.toBe("fresh-session");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("invalidates all pending authorization scopes after access changes", async () => {
    const pending = deferred();
    const old = poolProcurementRead("hotel-a", "catalog", () => pending.promise);
    invalidateProcurementReads();
    const current = poolProcurementRead("hotel-a", "catalog", async () => "current");
    pending.resolve("obsolete");
    await expect(old).rejects.toThrow("Hotel access changed");
    await expect(current).resolves.toBe("current");
  });

  it("invalidates only the mutated hotel and preserves another hotel's concurrent request", async () => {
    const pending = deferred();
    const first = poolProcurementRead("hotel-a", "catalog", () => pending.promise);
    const other = poolProcurementRead("hotel-b", "catalog", () => pending.promise);
    invalidateProcurementReads("hotel-a"); pending.resolve("result");
    await expect(first).rejects.toThrow("Hotel access changed");
    await expect(other).resolves.toBe("result");
  });
});
