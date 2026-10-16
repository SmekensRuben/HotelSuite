import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: { currentUser: null }, call: vi.fn(), endpoint: vi.fn() }));
vi.mock("../firebaseConfig", () => ({ auth: mocks.auth, functions: {}, httpsCallable: (_, endpoint) => { mocks.endpoint(endpoint); return mocks.call; } }));
import { invalidateProcurementReads } from "./procurementReadPool";
import { getPurchaseRequest, getPurchaseRequestContext, getPendingPurchaseRequestCommand, mutatePurchaseRequest, retryPurchaseRequestCommand, savePurchaseRequestSettings, savePurchaseBudgets, getPendingPurchaseBudgetCommand, retryPurchaseBudgetCommand } from "./firebasePurchaseRequests";
const input = () => ({ purchaseRequestId: "request-a", expectedRevision: 2, action: "submit", approverUid: "manager" });
const success = (value) => ({ data: { hotelUid: value.hotelUid, requestId: value.requestId, purchaseRequestId: value.purchaseRequestId || "created-request", revision: 3, request: { id: value.purchaseRequestId || "created-request", hotelUid: value.hotelUid, revision: 3, status: "pending" } } });
beforeEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); sessionStorage.clear(); mocks.auth.currentUser = { uid: "requester" }; invalidateProcurementReads(); });
it("persists and retries an uncertain command exactly while blocking changed approvers or amounts", async () => {
  mocks.call.mockRejectedValueOnce(new Error("Response lost")).mockImplementation(success);
  await expect(mutatePurchaseRequest("hotel-a", input())).rejects.toThrow("Response lost");
  const original = mocks.call.mock.calls[0][0];
  expect(getPendingPurchaseRequestCommand("hotel-a", "request-a").input).toEqual(input());
  await expect(mutatePurchaseRequest("hotel-a", { ...input(), approverUid: "someone-else" })).rejects.toThrow("previous result is uncertain");
  await retryPurchaseRequestCommand("hotel-a", "request-a");
  expect(mocks.call.mock.calls[1][0]).toEqual(original);
  expect(getPendingPurchaseRequestCommand("hotel-a", "request-a")).toBeNull();
});
it("reconciles a saved create command after an Auth instance changes without creating a second request", async () => {
  mocks.call.mockRejectedValueOnce(new Error("Offline")).mockImplementation(success);
  await expect(mutatePurchaseRequest("hotel-a", { expectedRevision: 0, action: "create", draft: { title: "Chinaware" } })).rejects.toThrow();
  const original = mocks.call.mock.calls[0][0]; mocks.auth.currentUser = { uid: "requester" };
  await retryPurchaseRequestCommand("hotel-a"); expect(mocks.call.mock.calls[1][0]).toEqual(original);
});
it("recovers the original reviewed approval route after reload instead of sending a newly calculated route", async () => {
  const reviewed = { ...input(), approverUid: "finance", expectedApprovalRouteFingerprint: "a".repeat(64) };
  mocks.call.mockRejectedValueOnce(new Error("Response lost")).mockImplementation(success);
  await expect(mutatePurchaseRequest("hotel-a", reviewed)).rejects.toThrow("Response lost");
  const original = mocks.call.mock.calls[0][0];
  mocks.auth.currentUser = { uid: "requester" };
  await expect(mutatePurchaseRequest("hotel-a", { ...reviewed, expectedApprovalRouteFingerprint: "b".repeat(64) })).rejects.toThrow("previous result is uncertain");
  expect(mocks.call).toHaveBeenCalledTimes(1);
  await retryPurchaseRequestCommand("hotel-a", "request-a");
  expect(mocks.call.mock.calls[1][0]).toEqual(original);
  expect(mocks.call.mock.calls[1][0].expectedApprovalRouteFingerprint).toBe(reviewed.expectedApprovalRouteFingerprint);
  expect(getPendingPurchaseRequestCommand("hotel-a", "request-a")).toBeNull();
});
it("recovers an uncertain self-approval with the exact reason and route instead of creating another registration", async () => {
  const reviewed = { purchaseRequestId: "request-a", expectedRevision: 2, action: "selfapprove", reason: "GM replacement within authority", expectedApprovalRouteFingerprint: "a".repeat(64) };
  mocks.call.mockRejectedValueOnce(new Error("Response lost")).mockImplementation(success);
  await expect(mutatePurchaseRequest("hotel-a", reviewed)).rejects.toThrow("Response lost");
  const original = mocks.call.mock.calls[0][0]; mocks.auth.currentUser = { uid: "requester" };
  await expect(mutatePurchaseRequest("hotel-a", { ...reviewed, reason: "Changed reason" })).rejects.toThrow("previous result is uncertain");
  await retryPurchaseRequestCommand("hotel-a", "request-a");
  expect(mocks.call.mock.calls[1][0]).toEqual(original);
  expect(getPendingPurchaseRequestCommand("hotel-a", "request-a")).toBeNull();
});
it("recovers the original per-line suppliers and quotations after an uncertain draft save", async () => {
  const saved = { purchaseRequestId: "request-a", expectedRevision: 2, action: "save", draft: { lines: [
    { id: "repair", kind: "free", supplierId: "supplier-a", description: "Repair", quantity: "1", unitPrice: "100", unit: "service" },
    { id: "plates", kind: "supplier", supplierId: "supplier-b", supplierProductId: "plates", purchaseOptionId: "case", quantity: "2", unitPrice: "15.25", unit: "case" },
  ] } };
  mocks.call.mockRejectedValueOnce(new Error("Response lost")).mockImplementation(success);
  await expect(mutatePurchaseRequest("hotel-a", saved)).rejects.toThrow("Response lost");
  const original = mocks.call.mock.calls[0][0];
  mocks.auth.currentUser = { uid: "requester" };
  const changed = structuredClone(saved); changed.draft.lines[0].supplierId = "supplier-b";
  await expect(mutatePurchaseRequest("hotel-a", changed)).rejects.toThrow("previous result is uncertain");
  expect(mocks.call).toHaveBeenCalledTimes(1);
  await retryPurchaseRequestCommand("hotel-a", "request-a");
  expect(mocks.call.mock.calls[1][0]).toEqual(original);
  expect(getPendingPurchaseRequestCommand("hotel-a", "request-a")).toBeNull();
});
it("unlocks a conflict only with explicit server proof that the command did not commit", async () => {
  mocks.call.mockRejectedValueOnce(Object.assign(new Error("Changed"), { details: { purchaseRequestUncommitted: true } }));
  await expect(mutatePurchaseRequest("hotel-a", input())).rejects.toThrow("Changed");
  expect(getPendingPurchaseRequestCommand("hotel-a", "request-a")).toBeNull();
  mocks.call.mockRejectedValueOnce(Object.assign(new Error("Denied"), { code: "functions/permission-denied" }));
  await expect(mutatePurchaseRequest("hotel-a", input())).rejects.toThrow("Denied");
  expect(getPendingPurchaseRequestCommand("hotel-a", "request-a")).not.toBeNull();
});
it("retains cross-hotel, wrong-request and malformed acknowledgements as uncertain", async () => {
  for (const change of [(value) => ({ ...success(value).data, hotelUid: "hotel-b" }), (value) => ({ ...success(value).data, purchaseRequestId: "other", request: null }), (value) => ({ ...success(value).data, requestId: "other" })]) {
    mocks.auth.currentUser = { uid: crypto.randomUUID() };
    mocks.call.mockImplementation(async (value) => ({ data: change(value) }));
    await expect(mutatePurchaseRequest("hotel-a", input())).rejects.toThrow();
    expect(getPendingPurchaseRequestCommand("hotel-a", "request-a")).not.toBeNull();
  }
});
it("drops delayed reads and writes when the active account or hotel authority changes", async () => {
  let resolve; mocks.call.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  const request = getPurchaseRequest("hotel-a", "request-a");
  mocks.auth.currentUser = { uid: "requester" }; resolve({ data: { hotelUid: "hotel-a", request: { id: "request-a" } } });
  await expect(request).rejects.toThrow("hotel access changed");
  mocks.call.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  const command = mutatePurchaseRequest("hotel-a", input()), sent = mocks.call.mock.calls[1][0];
  invalidateProcurementReads("hotel-a"); resolve(success(sent)); await expect(command).rejects.toThrow("hotel access changed");
});
it("isolates pending operations by actor, hotel and request, never accepting a payload hotel override", async () => {
  mocks.call.mockRejectedValue(new Error("Offline"));
  await expect(mutatePurchaseRequest("hotel-a", { ...input(), hotelUid: "hotel-b" })).rejects.toThrow();
  expect(mocks.call.mock.calls[0][0].hotelUid).toBe("hotel-a");
  expect(getPendingPurchaseRequestCommand("hotel-b", "request-a")).toBeNull();
  mocks.auth.currentUser = { uid: "other" }; expect(getPendingPurchaseRequestCommand("hotel-a", "request-a")).toBeNull();
});
it("shares exact retry protection with settings and annual budget changes", async () => {
  mocks.call.mockRejectedValueOnce(new Error("Offline")).mockImplementation(success);
  const budgets = { budgets: [{ month: "2026-10", categoryId: "chinaware", budgetMinor: 10000, openingUsedMinor: 0, expectedRevision: 0 }] };
  await expect(savePurchaseBudgets("hotel-a", budgets)).rejects.toThrow();
  expect(getPendingPurchaseBudgetCommand("hotel-a").input).toEqual(budgets);
  await retryPurchaseBudgetCommand("hotel-a");
  expect(mocks.call.mock.calls[0][0]).toEqual(mocks.call.mock.calls[1][0]);
  await savePurchaseRequestSettings("hotel-a", { expectedRevision: 0, settings: { currency: "EUR" } });
  expect(mocks.endpoint).toHaveBeenCalledWith("saveHotelPurchaseRequestSettings");
});
it("passes scoped context preview filters without needing general supplier or budget read permissions", async () => {
  mocks.call.mockResolvedValue({ data: { hotelUid: "hotel-a", budget: { exists: true, remainingMinor: 5000 }, supplierProducts: [] } });
  await getPurchaseRequestContext("hotel-a", { supplierId: "supplier", budgetMonth: "2026-10", budgetCategoryId: "chinaware", query: "plate" });
  expect(mocks.call).toHaveBeenCalledWith({ hotelUid: "hotel-a", supplierId: "supplier", budgetMonth: "2026-10", budgetCategoryId: "chinaware", query: "plate" });
});
it("keeps a create command recoverable when its response omits the created request identity", async () => {
  mocks.call.mockImplementation(async (value) => ({ data: { hotelUid: value.hotelUid, requestId: value.requestId, revision: 1 } }));
  await expect(mutatePurchaseRequest("hotel-a", { action: "create", expectedRevision: 0, draft: { title: "Chinaware" } })).rejects.toThrow("saved request acknowledgement");
  expect(getPendingPurchaseRequestCommand("hotel-a")).not.toBeNull();
});
it("sends no mutation unless the original command can be durably stored and read back", async () => {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage is blocked"); });
  await expect(mutatePurchaseRequest("hotel-a", input())).rejects.toThrow("Enable browser session storage");
  expect(mocks.call).not.toHaveBeenCalled();
  expect(getPendingPurchaseRequestCommand("hotel-a", "request-a")).toBeNull();
});
it("does not infer the absence of an earlier command when browser storage cannot be read", async () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("Storage is blocked"); });
  await expect(mutatePurchaseRequest("hotel-a", input())).rejects.toThrow("reconcile any earlier");
  expect(mocks.call).not.toHaveBeenCalled();
});
it("retains a known uncertain command when browser storage becomes unavailable before recovery", async () => {
  mocks.call.mockRejectedValueOnce(new Error("Response lost"));
  await expect(mutatePurchaseRequest("hotel-a", input())).rejects.toThrow("Response lost");
  const original = getPendingPurchaseRequestCommand("hotel-a", "request-a");
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage is blocked"); });
  await expect(retryPurchaseRequestCommand("hotel-a", "request-a")).rejects.toThrow("Enable browser session storage");
  expect(mocks.call).toHaveBeenCalledTimes(1);
  expect(getPendingPurchaseRequestCommand("hotel-a", "request-a")).toEqual(original);
});
