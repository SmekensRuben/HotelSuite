import { beforeEach, describe, expect, it, vi } from "vitest";
import { getHotelSubscriptions } from "./firebaseSubscriptions";
const { getDocs } = vi.hoisted(() => ({ getDocs: vi.fn() }));
vi.mock("../firebaseConfig", () => ({ db: {}, collection: (_db, path) => path, getDocs, functions: {}, httpsCallable: vi.fn() }));
const hotel = { id: "testhotel", data: () => ({ name: "Test Hotel" }) };

describe("subscription overview reads", () => {
  beforeEach(() => getDocs.mockReset());
  it("uses existing hotel names and joins records by document ID", async () => {
    getDocs.mockResolvedValueOnce({ docs: [hotel] }).mockResolvedValueOnce({ docs: [{ id: "testhotel", data: () => ({ status: "active", revision: 2 }) }] });
    expect(await getHotelSubscriptions()).toEqual([{ hotelUid: "testhotel", hotelName: "Test Hotel", subscription: { status: "active", revision: 2 } }]);
  });
  it("keeps discovered hotels on read denial without pretending they have no subscription", async () => {
    getDocs.mockResolvedValueOnce({ docs: [hotel] }).mockRejectedValueOnce({ code: "permission-denied" });
    await expect(getHotelSubscriptions()).rejects.toMatchObject({ code: "permission-denied", hotelRecords: [{ hotelUid: "testhotel", hotelName: "Test Hotel" }] });
  });
});
