import { beforeEach, expect, it, vi } from "vitest";
import { getHotelOrderReceiving, recordHotelOrderReceipt } from "./firebaseOrders";
const mock = vi.hoisted(() => ({ call: vi.fn(), name: "" }));
vi.mock("../firebaseConfig", () => ({ functions: {}, db: {}, collection: vi.fn(), doc: vi.fn(), getDoc: vi.fn(), getDocs: vi.fn(), query: vi.fn(), orderBy: vi.fn(),
  httpsCallable: (_, name) => { mock.name = name; return mock.call; } }));
const snapshot = () => ({ hotelUid: "hotel-a", orderId: "order", policyVersion: 1, orderRevision: 7, releaseReady: true,
  supplierPricingPolicyVersion: 1, supplierReceiptBlockReason: null,
  availability: "available", receivingState: "partial", events: [], nextCursor: null,
  lines: [{ supplierProductId: "coffee", productName: "Coffee", purchaseUnit: "box", orderedQuantity: 2.5, acceptedQuantity: 1, rejectedQuantity: 0, outstandingQuantity: 1.5, excessQuantity: 0 }] });
beforeEach(() => { vi.resetAllMocks(); });
it("requests scoped paged receiving and keeps unknown historical quantities unavailable", async () => {
  mock.call.mockResolvedValue({ data: { ...snapshot(), availability: "review-required", receivingState: null, lines: null } });
  const result = await getHotelOrderReceiving({ hotelUid: "hotel-a", orderId: "order", afterEventId: "old" });
  expect(mock.name).toBe("getHotelOrderReceiving"); expect(result.lines).toBeNull();
  expect(mock.call).toHaveBeenCalledWith({ hotelUid: "hotel-a", orderId: "order", afterEventId: "old" });
});
it("rejects mixed tenants/orders, corrupt quantities and false available states", async () => {
  for (const data of [{ ...snapshot(), hotelUid: "hotel-b" }, { ...snapshot(), orderId: "other" }, { ...snapshot(), lines: null },
    { ...snapshot(), orderRevision: null }, { ...snapshot(), receivingState: null }, { ...snapshot(), lines: [{ ...snapshot().lines[0], acceptedQuantity: null }] },
    { ...snapshot(), events: [{ id: "event", kind: "unknown", actorUid: "person", createdAtMillis: 1, lines: [] }] }]) {
    mock.call.mockResolvedValue({ data });
    await expect(getHotelOrderReceiving({ hotelUid: "hotel-a", orderId: "order" })).rejects.toThrow(/incomplete|another hotel/);
  }
});
it("a corrupt or cross-order mutation acknowledgement stays unconfirmed for exact retry", async () => {
  for (const data of [null, {}, { hotelUid: "hotel-b", orderId: "order", eventId: "one", revision: 8, status: "Received" }]) {
    mock.call.mockResolvedValue({ data });
    await expect(recordHotelOrderReceipt({ hotelUid: "hotel-a", orderId: "order", requestId: "same-id" })).rejects.toThrow(/could not be verified/);
  }
  expect(mock.name).toBe("recordHotelOrderReceipt");
});
it("a partial Functions rollout cannot expose an old receiving policy as ready", async () => {
  mock.call.mockResolvedValue({ data: { ...snapshot(), supplierPricingPolicyVersion: undefined } });
  await expect(getHotelOrderReceiving({ hotelUid: "hotel-a", orderId: "order" })).rejects.toThrow(/incomplete/);
  mock.call.mockResolvedValue({ data: { hotelUid: "hotel-a", orderId: "order", eventId: "event", revision: 8, status: "Ordered" } });
  await recordHotelOrderReceipt({ hotelUid: "hotel-a", orderId: "order", requestId: "one" });
  expect(mock.call).toHaveBeenLastCalledWith(expect.objectContaining({ supplierPricingPolicyVersion: 1 }));
});
