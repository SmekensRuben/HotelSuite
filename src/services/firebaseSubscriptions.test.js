import { beforeEach, describe, expect, it, vi } from "vitest";
import { getHotelSubscriptions, saveHotelSubscription } from "./firebaseSubscriptions";
import { subscriptionIsActive } from "../utils/subscription";
const { callable, httpsCallable } = vi.hoisted(() => ({ callable: vi.fn(), httpsCallable: vi.fn() }));
vi.mock("../firebaseConfig", () => ({ functions: {}, httpsCallable,
  Timestamp: { fromMillis: (millis) => ({ toMillis: () => millis, toDate: () => new Date(millis) }) } }));
const hotel = { hotelUid: "testhotel", hotelName: "Test Hotel", subscription: null };

describe("subscription overview reads", () => {
  beforeEach(() => { callable.mockReset(); httpsCallable.mockReset().mockReturnValue(callable); });
  it("uses the authenticated callable and preserves a hotel's missing subscription", async () => {
    callable.mockResolvedValue({ data: { hotels: [hotel], nextCursor: null } });
    expect(await getHotelSubscriptions()).toEqual([hotel]);
    expect(httpsCallable).toHaveBeenCalledWith({}, "listHotelSubscriptions");
    expect(callable).toHaveBeenCalledWith({ afterHotelUid: null });
  });
  it("loads subsequent pages and restores Timestamp semantics for expiry and editing", async () => {
    callable.mockResolvedValueOnce({ data: { hotels: [hotel], nextCursor: "testhotel" } })
      .mockResolvedValueOnce({ data: { hotels: [{ hotelUid: "z", hotelName: "Last Hotel",
        subscription: { status: "trialing", planId: "standard", revision: 2, validUntilMillis: 2000 } }], nextCursor: null } });
    const hotels = await getHotelSubscriptions();
    expect(hotels).toHaveLength(2);
    expect(callable).toHaveBeenNthCalledWith(2, { afterHotelUid: "testhotel" });
    expect(hotels[1].subscription.revision).toBe(2);
    expect(hotels[1].subscription.validUntil.toDate().toISOString()).toBe("1970-01-01T00:00:02.000Z");
    expect(subscriptionIsActive(hotels[1].subscription, 1999)).toBe(true);
    expect(subscriptionIsActive(hotels[1].subscription, 2000)).toBe(false);
  });
  it("propagates access denial without falling back to direct database reads", async () => {
    callable.mockRejectedValue({ code: "functions/permission-denied" });
    await expect(getHotelSubscriptions()).rejects.toMatchObject({ code: "functions/permission-denied" });
  });
  it("rejects incomplete pages instead of presenting partial subscriptions for editing", async () => {
    callable.mockResolvedValueOnce({ data: { hotels: [hotel], nextCursor: "testhotel" } }).mockRejectedValueOnce({ code: "functions/unavailable" });
    await expect(getHotelSubscriptions()).rejects.toMatchObject({ code: "functions/unavailable" });
  });
  it("rejects corrupt expiry and repeated cursors", async () => {
    callable.mockResolvedValue({ data: { hotels: [{ ...hotel, subscription: { revision: 1, validUntilMillis: "bad" } }], nextCursor: null } });
    await expect(getHotelSubscriptions()).rejects.toThrow("record is invalid");
    callable.mockResolvedValue({ data: { hotels: [hotel], nextCursor: "testhotel" } });
    await expect(getHotelSubscriptions()).rejects.toThrow("cursor is invalid");
  });
  it("keeps saves on the validated backend endpoint with the expected revision", async () => {
    callable.mockResolvedValue({ data: { revision: 3 } });
    const input = { hotelUid: "testhotel", status: "active", planId: "standard", validUntil: null, expectedRevision: 2 };
    expect(await saveHotelSubscription(input)).toEqual({ revision: 3 });
    expect(httpsCallable).toHaveBeenCalledWith({}, "setHotelSubscription");
    expect(callable).toHaveBeenCalledWith(input);
  });
});
