import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: { currentUser: { uid: "owner" } }, call: vi.fn(), endpoint: vi.fn() }));
vi.mock("../firebaseConfig", () => ({ auth: mocks.auth, functions: {}, httpsCallable: (_, endpoint) => { mocks.endpoint(endpoint); return mocks.call; } }));
import { invalidateProcurementReads } from "./procurementReadPool";
import { listProductProposalBatches, readProductProposalBatch, reviewProductProposals, retryProductProposalReview, getPendingProductProposalReview } from "./firebaseProductProposals";

const data = (input = {}) => ({ hotelUid: input.hotelUid || "hotel-a", batchId: input.batchId || "batch-1", revision: 1, status: "review", requestId: input.requestId, rows: [{ rowId: "row-1", kind: "catalog", action: "create", status: "ready", issues: [], proposed: { name: "Milk", baseUnit: "l" }, patch: { name: "Milk", baseUnit: "l" } }], summary: { total: 1 } });
const input = () => ({ expectedRevision: 1, action: "approve", rowIds: ["row-1"] });
beforeEach(() => { vi.clearAllMocks(); sessionStorage.clear(); invalidateProcurementReads(); mocks.auth.currentUser = { uid: "owner" }; });

it("reads private paginated batches and validates the selected hotel and batch", async () => {
  mocks.call.mockResolvedValueOnce({ data: { hotelUid: "hotel-a", batches: [{ batchId: "batch-1" }], nextCursor: "next-1" } }).mockResolvedValueOnce({ data: data() }).mockResolvedValueOnce({ data: data({ hotelUid: "hotel-b" }) });
  expect((await listProductProposalBatches("hotel-a", { limit: 25 })).nextCursor).toBe("next-1");
  expect(mocks.endpoint).toHaveBeenCalledWith("listHotelProductProposalBatches");
  expect((await readProductProposalBatch("hotel-a", "batch-1")).rows).toHaveLength(1);
  await expect(readProductProposalBatch("hotel-a", "batch-1")).rejects.toThrow("another hotel or batch");
});
it("retries an uncertain approval using the exact original request and refuses changed choices", async () => {
  mocks.call.mockRejectedValueOnce(new Error("Response lost")).mockImplementation(async (request) => ({ data: data(request) }));
  await expect(reviewProductProposals("hotel-a", "batch-1", input())).rejects.toThrow("Response lost");
  const original = mocks.call.mock.calls[0][0]; expect(getPendingProductProposalReview("hotel-a", "batch-1").requestId).toBe(original.requestId);
  await expect(reviewProductProposals("hotel-a", "batch-1", { ...input(), action: "skip" })).rejects.toThrow("Recover the original");
  await retryProductProposalReview("hotel-a", "batch-1");
  expect(mocks.call.mock.calls[1][0]).toEqual(original); expect(getPendingProductProposalReview("hotel-a", "batch-1")).toBeNull();
});
it("preserves replacement patches without turning omitted source information into clears", async () => {
  mocks.call.mockImplementation(async (request) => ({ data: data(request) }));
  const corrections = [{ rowId: "row-1", product: { name: "Milk", pricePerPurchaseUnit: null, allergens: [] }, catalogRowId: null }];
  await reviewProductProposals("hotel-a", "batch-1", { expectedRevision: 1, action: "correct", rowIds: ["row-1"], corrections });
  const sent = mocks.call.mock.calls[0][0].corrections[0].product;
  expect(sent.pricePerPurchaseUnit).toBeNull(); expect(sent.allergens).toEqual([]); expect(sent).not.toHaveProperty("brand");
});
it("releases retry identity only with explicit proof of an uncommitted review", async () => {
  mocks.call.mockRejectedValueOnce(Object.assign(new Error("Revision changed"), { details: { productProposalRequestUncommitted: true } })).mockRejectedValueOnce(Object.assign(new Error("Access revoked"), { code: "functions/permission-denied" }));
  await expect(reviewProductProposals("hotel-a", "batch-1", input())).rejects.toThrow("Revision changed"); expect(getPendingProductProposalReview("hotel-a", "batch-1")).toBeNull();
  await expect(reviewProductProposals("hotel-a", "batch-1", input())).rejects.toThrow("Access revoked"); expect(getPendingProductProposalReview("hotel-a", "batch-1")).not.toBeNull();
});
it("keeps cross-hotel and different-account review identities separate", async () => {
  mocks.call.mockRejectedValue(new Error("Offline"));
  await expect(reviewProductProposals("hotel-a", "batch-1", input())).rejects.toThrow();
  await expect(reviewProductProposals("hotel-b", "batch-1", input())).rejects.toThrow();
  mocks.auth.currentUser = { uid: "other-owner" }; expect(getPendingProductProposalReview("hotel-a", "batch-1")).toBeNull();
  await expect(reviewProductProposals("hotel-a", "batch-1", input())).rejects.toThrow();
  expect(new Set(mocks.call.mock.calls.map(([request]) => request.requestId)).size).toBe(3);
});
it("drops delayed responses after a same-UID authenticated identity change", async () => {
  let resolve; mocks.call.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  const result = reviewProductProposals("hotel-a", "batch-1", input());
  const request = mocks.call.mock.calls[0][0]; mocks.auth.currentUser = { uid: "owner" }; resolve({ data: data(request) });
  await expect(result).rejects.toThrow("Hotel access changed"); expect(getPendingProductProposalReview("hotel-a", "batch-1")).not.toBeNull();
});
it("holds malformed acknowledgements for recovery and rejects repeated row IDs before calling", async () => {
  mocks.call.mockResolvedValue({ data: data() });
  await expect(reviewProductProposals("hotel-a", "batch-1", { ...input(), rowIds: ["row-1", "row-1"] })).rejects.toThrow("valid review action"); expect(mocks.call).not.toHaveBeenCalled();
  await expect(reviewProductProposals("hotel-a", "batch-1", input())).rejects.toThrow("acknowledgement"); expect(getPendingProductProposalReview("hotel-a", "batch-1")).not.toBeNull();
});
it("recovers an interrupted approval from the server after browser retry storage was lost", async () => {
  const original = { hotelUid: "hotel-a", batchId: "batch-1", requestId: "original-approval", expectedRevision: 1, action: "approve", rowIds: ["supplier-row", "catalog-row"] };
  mocks.call.mockResolvedValueOnce({ data: { ...data(), processing: true, pendingReview: original } }).mockImplementationOnce(async (request) => ({ data: { ...data(request), processing: false, pendingReview: null } }));
  await readProductProposalBatch("hotel-a", "batch-1"); expect(getPendingProductProposalReview("hotel-a", "batch-1").requestId).toBe("original-approval");
  await retryProductProposalReview("hotel-a", "batch-1"); expect(mocks.call.mock.calls[1][0]).toEqual(original); expect(getPendingProductProposalReview("hotel-a", "batch-1")).toBeNull();
});
it("sends correction rows only through their replacement patches as required by the callable", async () => {
  mocks.call.mockImplementation(async (request) => ({ data: data(request) }));
  await reviewProductProposals("hotel-a", "batch-1", { ...input(), action: "correct", corrections: [{ rowId: "row-1", product: { name: "Corrected milk" } }] });
  expect(mocks.call.mock.calls[0][0]).not.toHaveProperty("rowIds"); expect(mocks.call.mock.calls[0][0].corrections[0].product.name).toBe("Corrected milk");
});
