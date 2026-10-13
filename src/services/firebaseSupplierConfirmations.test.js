import { beforeEach, expect, it, vi } from "vitest";
import { getSupplierConfirmations, recordSupplierConfirmation, reviewSupplierConfirmation } from "./firebaseSupplierConfirmations";
import { invalidateProcurementReads } from "./procurementReadPool";
const mock = vi.hoisted(() => ({ call: vi.fn(), name: "", auth: { currentUser: { uid: "buyer" } } }));
vi.mock("../firebaseConfig", () => ({ functions: {}, auth: mock.auth, httpsCallable: (_, name) => { mock.name = name; return mock.call; } }));
const line = () => ({ supplierProductId: "coffee", orderLineId: "case", purchaseOptionId: "default", productName: "Coffee", purchaseUnit: "Case", orderedQuantity: 10, orderedPrice: 10.6,
  deliveryDate: "2026-10-14", currency: "EUR", priceBasis: "gross", vatRate: 0.06 });
const response = () => ({ responseType: "accepted", channel: "email", supplierReference: "CONF-1", respondedOn: "2026-10-13", note: "", sourceDigest: "a".repeat(64),
  lines: [{ ...line(), confirmedQuantity: 10, confirmedDeliveryDate: "2026-10-14", priceMode: "as-ordered", pricePerPurchaseUnit: 10.6, netPricePerPurchaseUnit: 10, substitute: null, reason: "", deviations: [] }] });
const summary = () => ({ policyVersion: 1, responseId: "response", reviewId: null, responseType: "accepted", respondedOn: "2026-10-13", eventCount: 1, reviewState: "not-required", requiresAttention: false });
const snapshot = (patch = {}) => ({ hotelUid: "hotel-a", orderId: "one", policyVersion: 1, orderRevision: 3, status: "Ordered", availability: "available", reason: null,
  releaseReady: true, today: "2026-10-13", submittedLines: [line()], current: { ...summary(), response: response(), review: null },
  events: [{ id: "response", kind: "response", revision: 3, actorName: "Hotel Buyer", createdAtMillis: 1, response: response(), review: null }], nextCursor: null, ...patch });
const input = { hotelUid: "hotel-a", orderId: "one" };
beforeEach(() => { vi.clearAllMocks(); invalidateProcurementReads(); mock.auth.currentUser = { uid: "buyer" }; });
it("returns one coherent hotel/order response and preserves genuine zero and unknown prices", async () => {
  for (const value of [null, 0]) {
    const data = snapshot(); data.current.response.responseType = "changes-proposed"; data.current.responseType = "changes-proposed";
    data.current.reviewState = "pending"; data.current.requiresAttention = true;
    data.current.response.lines[0] = { ...data.current.response.lines[0], priceMode: value === null ? "unknown" : "quoted", pricePerPurchaseUnit: value, netPricePerPurchaseUnit: value, deviations: ["price"], reason: "Supplier quote" };
    mock.call.mockResolvedValue({ data });
    const result = await getSupplierConfirmations(input);
    expect(result.current.response.lines[0].netPricePerPurchaseUnit).toBe(value);
  }
  expect(mock.name).toBe("getHotelSupplierConfirmations");
});
it("rejects missing, corrupt and cross-tenant/order evidence rather than displaying accepted terms", async () => {
  const invalid = [snapshot({ hotelUid: "hotel-b" }), snapshot({ orderId: "other" }), snapshot({ orderRevision: null }), snapshot({ submittedLines: [] }), snapshot({ submittedLines: [null] }),
    snapshot({ current: { ...snapshot().current, reviewState: "accepted" } }), snapshot({ current: { ...snapshot().current, review: { decision: "accept" } } }),
    snapshot({ events: [{ id: "event", kind: "review", revision: 3, actorName: null, createdAtMillis: 1, response: null, review: {} }] })];
  const wrongProduct = snapshot(); wrongProduct.current.response.lines[0].supplierProductId = "foreign"; invalid.push(wrongProduct);
  const emptyUnknown = snapshot(); emptyUnknown.current.response.lines[0].confirmedQuantity = null; invalid.push(emptyUnknown);
  const inventedFreeUnknown = snapshot(); inventedFreeUnknown.current.response.lines[0].priceMode = "unknown"; inventedFreeUnknown.current.response.lines[0].pricePerPurchaseUnit = 0; invalid.push(inventedFreeUnknown);
  const contradictoryReview = snapshot(); contradictoryReview.current.response.responseType = "changes-proposed"; contradictoryReview.current.responseType = "changes-proposed";
  contradictoryReview.current.response.lines[0] = { ...contradictoryReview.current.response.lines[0], confirmedQuantity: 8, deviations: ["quantity"], reason: "Short supply" };
  contradictoryReview.current.reviewId = "review"; contradictoryReview.current.reviewState = "accepted"; contradictoryReview.current.review = { responseId: "response", decision: "follow-up", reason: "Unresolved change" }; invalid.push(contradictoryReview);
  for (const data of invalid) { mock.call.mockResolvedValue({ data }); await expect(getSupplierConfirmations(input)).rejects.toThrow(/incomplete|disagree/); }
});
it("unconfirmed and historical unavailable snapshots remain explicit, not invented acceptance", async () => {
  for (const data of [snapshot({ current: null, events: [] }), snapshot({ availability: "review-required", current: null, events: [], reason: "Source record needs reconciliation" })]) {
    mock.call.mockResolvedValue({ data }); expect((await getSupplierConfirmations(input)).current).toBeNull();
  }
});
it("only concurrent requests share a read; settled operational responses are fetched again", async () => {
  let resolve; const pending = new Promise((done) => { resolve = done; }); mock.call.mockReturnValue(pending);
  const first = getSupplierConfirmations(input), second = getSupplierConfirmations(input);
  await Promise.resolve(); expect(mock.call).toHaveBeenCalledTimes(1);
  resolve({ data: snapshot() }); await Promise.all([first, second]);
  mock.call.mockResolvedValue({ data: snapshot() }); await getSupplierConfirmations(input);
  expect(mock.call).toHaveBeenCalledTimes(2);
});
it("a new Auth object with the same UID invalidates a pending operational response", async () => {
  let resolve; mock.call.mockReturnValue(new Promise((done) => { resolve = done; }));
  const pending = getSupplierConfirmations(input); await Promise.resolve(); mock.auth.currentUser = { uid: "buyer" };
  resolve({ data: snapshot() }); await expect(pending).rejects.toThrow(/access changed/);
});
it("mutation acknowledgements must match the exact actor, request, revision, hotel and order", async () => {
  const command = { ...input, requestId: "saved-id", expectedActorUid: "buyer", expectedRevision: 2 };
  const result = { ...input, requestId: "saved-id", actorUid: "buyer", eventId: "response", revision: 3, supplierConfirmation: summary() };
  for (const data of [{ ...result, actorUid: "other" }, { ...result, requestId: "other" }, { ...result, revision: 4 }, { ...result, hotelUid: "hotel-b" },
    { ...result, orderId: "other" }, { ...result, supplierConfirmation: {} }, null]) {
    mock.call.mockResolvedValue({ data }); await expect(recordSupplierConfirmation(command)).rejects.toThrow(/could not be verified/);
  }
  mock.call.mockResolvedValue({ data: result }); expect(await recordSupplierConfirmation(command)).toEqual(result);
  expect(mock.name).toBe("recordHotelSupplierConfirmation"); await reviewSupplierConfirmation(command); expect(mock.name).toBe("reviewHotelSupplierConfirmation");
});
