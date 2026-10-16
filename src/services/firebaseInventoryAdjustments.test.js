import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ call: vi.fn(), auth: { currentUser: { uid: "operator" } } }));
vi.mock("../firebaseConfig", () => ({ auth: mocks.auth, functions: {}, httpsCallable: (_functions, name) => async (input) => ({ data: await mocks.call(name, input) }) }));
import { getInventoryAdjustmentChoices, getInventoryAdjustments, getPendingInventoryAdjustment, recordInventoryAdjustment, reverseInventoryAdjustment, retryPendingInventoryAdjustment } from "./firebaseInventoryAdjustments";
import { invalidateProcurementReads } from "./procurementReadPool";
const input = () => ({ hotelUid: "hotel-a", kind: "transfer", catalogProductId: "juice", quantity: 12.5, sourceLocationId: "store", destinationLocationId: "bar", businessDate: "2026-10-12", note: "Moved sealed bottles", reference: "TRANSFER-1", netUnitCost: null, currency: null });
const result = (request) => ({ hotelUid: request.hotelUid, actorUid: request.expectedActorUid, requestId: request.requestId, inventoryAdjustmentPolicyVersion: 1, adjustmentId: "adjustment-1", kind: request.kind, businessDate: request.businessDate, movementIds: ["source", "destination"] });
const history = () => ({ hotelUid: "hotel-a", inventoryAdjustmentPolicyVersion: 1, adjustments: [{ id: "adjustment-1", adjustmentId: "adjustment-1", kind: "waste", reasonType: "breakage", businessDate: "2026-10-12", catalogProductId: "juice", catalogProductName: "Orange juice", baseUnit: "l", quantity: 0.5, sourceLocationId: "store", sourceLocationName: "Storeroom", actorUid: "operator", postedAtMillis: 1234, netUnitCost: null, netValue: null, currency: null }], nextCursor: null });
beforeEach(() => { vi.clearAllMocks(); sessionStorage.clear(); invalidateProcurementReads(); mocks.auth.currentUser = { uid: "operator" }; mocks.call.mockImplementation(async (_endpoint, request) => result(request)); });

describe("immutable inventory adjustment adapter", () => {
  it("reviews an exact exception event and rejects a substituted event or hotel", async () => {
    const data = { ...history(), requestedAdjustmentId: "adjustment-1" };
    mocks.call.mockResolvedValue(data);
    await expect(getInventoryAdjustments("hotel-a", null, "adjustment-1")).resolves.toEqual(data);
    expect(mocks.call).toHaveBeenLastCalledWith("listHotelInventoryAdjustments", { hotelUid: "hotel-a", afterAdjustmentId: null, adjustmentId: "adjustment-1" });
    for (const patch of [{ hotelUid: "hotel-b" }, { requestedAdjustmentId: "other" }, { adjustments: [{ ...data.adjustments[0], adjustmentId: "other" }] }]) {
      mocks.call.mockResolvedValue({ ...data, ...patch });
      await expect(getInventoryAdjustments("hotel-a", null, "adjustment-1")).rejects.toThrow("scope");
    }
  });
  it("sends canonical quantities and preserves explicitly unknown cost", async () => {
    await recordInventoryAdjustment(input());
    expect(mocks.call).toHaveBeenCalledWith("recordHotelInventoryAdjustment", { ...input(), requestId: expect.any(String), expectedActorUid: "operator" });
    expect(getPendingInventoryAdjustment("hotel-a")).toBeNull();
  });
  it("distinguishes known zero cost from unknown and requires explicit currency", async () => {
    await recordInventoryAdjustment({ ...input(), netUnitCost: 0, currency: "EUR" });
    expect(mocks.call.mock.calls[0][1]).toMatchObject({ netUnitCost: 0, currency: "EUR" });
    await expect(recordInventoryAdjustment({ ...input(), netUnitCost: 1, currency: null })).rejects.toThrow("Optional cost");
    await expect(recordInventoryAdjustment({ ...input(), quantity: 0 })).rejects.toThrow("positive");
    await expect(recordInventoryAdjustment({ ...input(), quantity: 0.0000001 })).rejects.toThrow("positive");
    await expect(recordInventoryAdjustment({ ...input(), destinationLocationId: "store" })).rejects.toThrow("locations");
    await expect(recordInventoryAdjustment({ ...input(), businessDate: "2026-02-30" })).rejects.toThrow("business date");
    expect(mocks.call).toHaveBeenCalledTimes(1);
  });
  it("retains the exact request after timeout and replays it after remount rather than changing the event", async () => {
    mocks.call.mockRejectedValueOnce(new Error("Response lost"));
    await expect(recordInventoryAdjustment(input())).rejects.toThrow("Response lost");
    const original = mocks.call.mock.calls[0][1];
    expect(getPendingInventoryAdjustment("hotel-a")).toMatchObject({ operation: "record", input: input() });
    await expect(recordInventoryAdjustment({ ...input(), quantity: 13 })).rejects.toThrow("uncertain");
    await retryPendingInventoryAdjustment("hotel-a");
    expect(mocks.call.mock.calls[1][1]).toEqual(original);
    expect(getPendingInventoryAdjustment("hotel-a")).toBeNull();
  });
  it("does not clear uncertain commands on permission or gate failure", async () => {
    mocks.call.mockRejectedValue(Object.assign(new Error("Permission denied"), { code: "functions/permission-denied" }));
    await expect(recordInventoryAdjustment(input())).rejects.toThrow("Permission");
    expect(getPendingInventoryAdjustment("hotel-a")).not.toBeNull();
  });
  it("only releases pending requests after server proof of non-commit", async () => {
    mocks.call.mockRejectedValueOnce(Object.assign(new Error("Location archived"), { details: { inventoryAdjustmentRequestUncommitted: true } }));
    await expect(recordInventoryAdjustment(input())).rejects.toThrow("archived");
    expect(getPendingInventoryAdjustment("hotel-a")).toBeNull();
    await recordInventoryAdjustment({ ...input(), sourceLocationId: "kitchen" });
    expect(mocks.call.mock.calls[1][1].requestId).not.toBe(mocks.call.mock.calls[0][1].requestId);
  });
  it("partitions uncertain operations by hotel and actor", async () => {
    mocks.call.mockRejectedValue(new Error("Offline"));
    await expect(recordInventoryAdjustment(input())).rejects.toThrow("Offline");
    expect(getPendingInventoryAdjustment("hotel-b")).toBeNull();
    mocks.auth.currentUser = { uid: "another-operator" };
    expect(getPendingInventoryAdjustment("hotel-a")).toBeNull();
    await expect(recordInventoryAdjustment(input())).rejects.toThrow("Offline");
    expect(mocks.call.mock.calls[1][1].requestId).not.toBe(mocks.call.mock.calls[0][1].requestId);
  });
  it("retains malformed responses and corrupt local evidence without replacement", async () => {
    mocks.call.mockResolvedValue({ ...result(input()), hotelUid: "hotel-b" });
    await expect(recordInventoryAdjustment(input())).rejects.toThrow("could not be verified");
    expect(getPendingInventoryAdjustment("hotel-a")).not.toBeNull();
    sessionStorage.setItem("inventory-adjustment-command:operator:hotel-a", "broken");
    expect(() => getPendingInventoryAdjustment("hotel-a")).toThrow("no new request");
    await expect(recordInventoryAdjustment(input())).rejects.toThrow("no new request");
    expect(mocks.call).toHaveBeenCalledTimes(1);
  });
  it("refuses to dispatch if storage cannot preserve the intent", async () => {
    const storage = vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => { throw new Error("Full"); });
    await expect(recordInventoryAdjustment(input())).rejects.toThrow("No request was sent");
    expect(mocks.call).not.toHaveBeenCalled(); storage.mockRestore();
  });
  it("reverses by immutable original identity and retains the saved reversal on uncertainty", async () => {
    const reversal = { hotelUid: "hotel-a", adjustmentId: "original", businessDate: "2026-10-12", reference: "FIX-1", note: "Duplicate entry" };
    mocks.call.mockRejectedValueOnce(new Error("Timeout")).mockImplementationOnce(async (_name, request) => ({ hotelUid: "hotel-a", actorUid: request.expectedActorUid, requestId: request.requestId, inventoryAdjustmentPolicyVersion: 1, originalAdjustmentId: "original", reversalAdjustmentId: "reversed", movementIds: ["reverse-source", "reverse-destination"] }));
    await expect(reverseInventoryAdjustment(reversal)).rejects.toThrow("Timeout");
    const original = mocks.call.mock.calls[0][1];
    await retryPendingInventoryAdjustment("hotel-a");
    expect(mocks.call.mock.calls[1]).toEqual(["reverseHotelInventoryAdjustment", original]);
    expect(original).not.toHaveProperty("quantity");
  });
  it("binds the original actor at dispatch and retains evidence if the acknowledgement has a different actor or request", async () => {
    mocks.call.mockImplementationOnce(async (_endpoint, request) => {
      expect(request.expectedActorUid).toBe("operator");
      return { ...result(request), actorUid: "another-operator" };
    });
    await expect(recordInventoryAdjustment(input())).rejects.toThrow("could not be verified");
    const original = getPendingInventoryAdjustment("hotel-a");
    expect(original.actorUid).toBe("operator");
    mocks.call.mockImplementationOnce(async (_endpoint, request) => ({ ...result(request), requestId: "different-id" }));
    await expect(retryPendingInventoryAdjustment("hotel-a")).rejects.toThrow("could not be verified");
    expect(getPendingInventoryAdjustment("hotel-a")).toEqual(original);
  });
});
describe("bounded authorized movement projections", () => {
  it("uses the protected eligible source projection with explicit bounded prefix pagination", async () => {
    const response = { hotelUid: "hotel-a", kind: "catalogproducts", inventoryAdjustmentPolicyVersion: 1, hotelCurrency: "EUR", query: "orange", choices: [{ id: "juice", name: "Orange juice", baseUnit: "l" }], nextCursor: "juice" };
    mocks.call.mockResolvedValue(response);
    await expect(getInventoryAdjustmentChoices("hotel-a", "catalogproducts", null, " Orange ")).resolves.toEqual(response);
    expect(mocks.call).toHaveBeenCalledWith("listHotelInventoryAdjustmentChoices", { hotelUid: "hotel-a", kind: "catalogproducts", afterId: null, query: "orange" });
  });
  it("does not silently guess missing currency or incompatible units", async () => {
    mocks.call.mockResolvedValue({ hotelUid: "hotel-a", kind: "catalogproducts", inventoryAdjustmentPolicyVersion: 1, hotelCurrency: null, choices: [{ id: "juice", name: "Orange juice", baseUnit: "bottle" }], nextCursor: null });
    await expect(getInventoryAdjustmentChoices("hotel-a", "catalogproducts")).rejects.toThrow("scope, currency");
    mocks.call.mockResolvedValue({ hotelUid: "hotel-b", kind: "locations", inventoryAdjustmentPolicyVersion: 1, hotelCurrency: null, choices: [], nextCursor: null });
    await expect(getInventoryAdjustmentChoices("hotel-a", "locations")).rejects.toThrow("scope");
  });
  it("accepts empty scanned pages but rejects a repeated pagination cursor", async () => {
    mocks.call.mockResolvedValue({ hotelUid: "hotel-a", kind: "locations", inventoryAdjustmentPolicyVersion: 1, hotelCurrency: null, choices: [], nextCursor: "next" });
    await expect(getInventoryAdjustmentChoices("hotel-a", "locations")).resolves.toMatchObject({ choices: [], nextCursor: "next" });
    await expect(getInventoryAdjustmentChoices("hotel-a", "locations", "next")).rejects.toThrow("pagination");
  });
  it("preserves unknown event costs and rejects another hotel's evidence", async () => {
    mocks.call.mockResolvedValue(history());
    await expect(getInventoryAdjustments("hotel-a")).resolves.toMatchObject({ adjustments: [{ netUnitCost: null, netValue: null }] });
    mocks.call.mockResolvedValue({ ...history(), hotelUid: "hotel-b" });
    await expect(getInventoryAdjustments("hotel-a")).rejects.toThrow("scope");
  });
  it("rejects an old authenticated session completing after access changed", async () => {
    let resolve; mocks.call.mockReturnValue(new Promise((done) => { resolve = done; }));
    const pending = getInventoryAdjustments("hotel-a");
    await Promise.resolve(); mocks.auth.currentUser = { uid: "another-operator" }; resolve(history());
    await expect(pending).rejects.toThrow("access changed");
  });
});
