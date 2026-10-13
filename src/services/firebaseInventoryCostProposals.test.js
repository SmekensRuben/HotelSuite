import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ call: vi.fn(), auth: { currentUser: { uid: "counter" } } }));
vi.mock("../firebaseConfig", () => ({ auth: mocks.auth, functions: {}, httpsCallable: (_functions, name) => { expect(name).toBe("getHotelInventoryCostProposal"); return mocks.call; } }));
import { getInventoryCostProposal } from "./firebaseInventoryCostProposals";
import { invalidateProcurementReads } from "./procurementReadPool";
const input = { hotelUid: "hotel-a", purpose: "movement", locationId: "store", catalogProductId: "juice", businessDate: "2026-10-12" };
const expected = { baseUnit: "l", currency: "EUR", businessDate: input.businessDate };
const source = { anchorStockCountId: "opening", anchorCheckpointId: "checkpoint", openingBusinessDate: "2026-10-01", openingQuantity: 10, openingNetValue: 20,
  recordedMovementQuantity: 20, recordedMovementNetValue: 60, weightedSourceQuantity: 30, weightedSourceNetValue: 80, postingCutoffSequence: 3, movementCount: 2 };
const proposal = { ...input, stockCountId: null, costProposalPolicyVersion: 1, status: "available", available: true, netUnitCost: 2.666667,
  baseUnit: "l", currency: "EUR", asOfMillis: 1791800000000, source, reasons: [], costBasis: "Recorded evidence estimate, not live stock valuation." };
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
beforeEach(() => { vi.clearAllMocks(); mocks.auth.currentUser = { uid: "counter" }; invalidateProcurementReads(); mocks.call.mockResolvedValue({ data: proposal }); });
it("uses a read-only scoped callable and sends only actual movement context", async () => {
  expect(await getInventoryCostProposal({ ...input, netUnitCost: 999, manualSnapshot: "spoof" }, expected)).toEqual(proposal);
  expect(mocks.call).toHaveBeenCalledWith(input);
});
it("leaves the count's frozen date authority on the server", async () => {
  const count = { ...input, purpose: "stockcount", stockCountId: "count" }; delete count.businessDate;
  mocks.call.mockResolvedValue({ data: { ...proposal, purpose: "stockcount", stockCountId: "count" } });
  await getInventoryCostProposal(count, expected); expect(mocks.call).toHaveBeenCalledWith(count);
});
it("keeps known zero available and unknown evidence unavailable without a numeric substitute", async () => {
  mocks.call.mockResolvedValueOnce({ data: { ...proposal, netUnitCost: 0, source: { ...source, openingNetValue: 0, recordedMovementNetValue: 0, weightedSourceNetValue: 0 } } });
  expect((await getInventoryCostProposal(input, expected)).netUnitCost).toBe(0);
  const unknown = { ...proposal, status: "unavailable", available: false, netUnitCost: null, source: null, reasons: [{ code: "no-opening", detail: "A completed opening count is unavailable." }] };
  mocks.call.mockResolvedValueOnce({ data: unknown }); expect(await getInventoryCostProposal(input, expected)).toEqual(unknown);
});
it("rejects scope, date, unit, currency, precision or incomplete available evidence drift", async () => {
  for (const patch of [{ hotelUid: "other" }, { locationId: "bar" }, { catalogProductId: "milk" }, { stockCountId: "foreign" }, { purpose: "stockcount" },
    { businessDate: "2026-10-13" }, { baseUnit: "ml" }, { currency: "USD" }, { costProposalPolicyVersion: 2 }, { netUnitCost: null },
    { netUnitCost: 0.1234567 }, { source: null }, { source: { ...source, weightedSourceQuantity: 0 } }, { source: { ...source, openingNetValue: null } },
    { reasons: [{ code: "incomplete", detail: "Unknown source" }] }, { available: false }, { costBasis: {} }]) {
    mocks.call.mockResolvedValueOnce({ data: { ...proposal, ...patch } }); await expect(getInventoryCostProposal(input, expected)).rejects.toThrow();
  }
});
it("rejects malformed requests before Firebase and invalid unavailable responses", async () => {
  for (const patch of [{ hotelUid: "bad/path" }, { locationId: "" }, { businessDate: "2026-02-29" }, { purpose: "supplier" }]) expect(() => getInventoryCostProposal({ ...input, ...patch }, expected)).toThrow();
  expect(mocks.call).not.toHaveBeenCalled();
  mocks.call.mockResolvedValueOnce({ data: { ...proposal, available: false, status: "unavailable", netUnitCost: 0, reasons: [] } });
  await expect(getInventoryCostProposal(input, expected)).rejects.toThrow(/incomplete or invalid/);
});
it("shares concurrent calculations only and drops results after Auth or access invalidation", async () => {
  const waiting = deferred(); mocks.call.mockReturnValueOnce(waiting.promise);
  const a = getInventoryCostProposal(input, expected), b = getInventoryCostProposal(input, expected);
  await Promise.resolve(); expect(mocks.call).toHaveBeenCalledTimes(1);
  waiting.resolve({ data: proposal }); expect(await a).toEqual(await b);
  await getInventoryCostProposal(input, expected); expect(mocks.call).toHaveBeenCalledTimes(2);
  const stale = deferred(); mocks.call.mockReturnValueOnce(stale.promise);
  const old = getInventoryCostProposal(input, expected); await Promise.resolve(); mocks.auth.currentUser = { uid: "counter" };
  stale.resolve({ data: proposal }); await expect(old).rejects.toThrow(/access changed/);
  const invalidated = deferred(); mocks.call.mockReturnValueOnce(invalidated.promise);
  const oldAccess = getInventoryCostProposal(input, expected); await Promise.resolve(); invalidateProcurementReads(input.hotelUid);
  invalidated.resolve({ data: proposal }); await expect(oldAccess).rejects.toThrow(/access changed/);
});
