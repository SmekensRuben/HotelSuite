import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: { currentUser: null }, call: vi.fn(), endpoint: vi.fn() }));
vi.mock("../firebaseConfig", () => ({ auth: mocks.auth, functions: {}, httpsCallable: (_, name) => { mocks.endpoint(name); return mocks.call; } }));
import { invalidateProcurementReads } from "./procurementReadPool";
import { getPurchaseRequestNotifications, retryPurchaseRequestNotification } from "./firebasePurchaseRequestNotifications";
beforeEach(() => { vi.clearAllMocks(); invalidateProcurementReads(); mocks.auth.currentUser = { uid: "requester" }; mocks.call.mockResolvedValue({ data: { notifications: [] } }); });
it("reads only one hotel's request statuses and recovers a server-verified failure", async () => {
  await getPurchaseRequestNotifications("hotel-a", "request-a");
  expect(mocks.endpoint).toHaveBeenCalledWith("readHotelPurchaseRequestNotifications");
  expect(mocks.call).toHaveBeenCalledWith({ hotelUid: "hotel-a", purchaseRequestId: "request-a" });
  await retryPurchaseRequestNotification("hotel-a", "mail-a");
  expect(mocks.endpoint).toHaveBeenCalledWith("retryPurchaseRequestNotification");
  expect(mocks.call).toHaveBeenCalledWith({ hotelUid: "hotel-a", mailId: "mail-a" });
});
it("discards a delayed recovery response after current account authority changes", async () => {
  let resolve; mocks.call.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  const retry = retryPurchaseRequestNotification("hotel-a", "mail-a");
  mocks.auth.currentUser = { uid: "requester" }; resolve({ data: { status: "queued" } });
  await expect(retry).rejects.toThrow("hotel access changed");
});
