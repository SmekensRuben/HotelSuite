import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ call: vi.fn(), auth: { currentUser: { uid: "buyer-a" } } }));
vi.mock("../firebaseConfig", () => ({ functions: {}, db: {}, auth: mocks.auth, httpsCallable: () => mocks.call }));
import { createOrdersFromShoppingCart, getPendingCartSubmission, retryPendingCartSubmission } from "./firebaseOrders";

const submit = (patch = {}) => createOrdersFromShoppingCart("hotel-a", "cart", patch.date || "2026-10-17", "untrusted-actor", patch.revision ?? 4, patch.fingerprint || "reviewed-prices");
const success = { data: { orderIds: ["order-bar", "order-kitchen"], deliveryDateAdjustments: [] } };
describe("durable shared cart submission recovery", () => {
  beforeEach(() => { vi.clearAllMocks(); sessionStorage.clear(); localStorage.clear(); mocks.auth.currentUser = { uid: "buyer-a" }; mocks.call.mockResolvedValue(success); });

  it("retains and replays the exact actor-scoped request after an uncertain response and remount", async () => {
    mocks.call.mockRejectedValueOnce(new Error("Response lost"));
    await expect(submit()).rejects.toThrow("Response lost");
    const original = mocks.call.mock.calls[0][0];
    expect(getPendingCartSubmission("hotel-a", "cart")).toEqual(original);
    expect(localStorage.getItem("cart-submission:buyer-a:hotel-a:cart")).not.toBeNull();
    sessionStorage.clear();
    await expect(submit({ date: "2026-10-18" })).rejects.toThrow("uncertain result");
    await expect(submit({ revision: 5 })).rejects.toThrow("uncertain result");
    await expect(submit({ fingerprint: "changed-prices" })).rejects.toThrow("uncertain result");
    await retryPendingCartSubmission("hotel-a", "cart");
    expect(mocks.call).toHaveBeenCalledTimes(2);
    expect(mocks.call.mock.calls[1][0]).toEqual(original);
    expect(getPendingCartSubmission("hotel-a", "cart")).toBeNull();
  });

  it("separates pending submissions by authenticated user, hotel and cart", async () => {
    mocks.call.mockRejectedValueOnce(new Error("Response lost")); await expect(submit()).rejects.toThrow();
    const original = getPendingCartSubmission("hotel-a", "cart");
    expect(getPendingCartSubmission("hotel-b", "cart")).toBeNull();
    expect(getPendingCartSubmission("hotel-a", "other-cart")).toBeNull();
    mocks.auth.currentUser = { uid: "buyer-b" };
    expect(getPendingCartSubmission("hotel-a", "cart")).toBeNull();
    await submit();
    expect(mocks.call.mock.calls[1][0].requestId).not.toBe(original.requestId);
    mocks.auth.currentUser = { uid: "buyer-a" };
    expect(getPendingCartSubmission("hotel-a", "cart")).toEqual(original);
  });

  it("retains uncertain work on permission errors until the server proves non-commit", async () => {
    mocks.call.mockRejectedValueOnce(Object.assign(new Error("Access changed"), { code: "functions/permission-denied" }));
    await expect(submit()).rejects.toThrow("Access changed");
    expect(getPendingCartSubmission("hotel-a", "cart")).not.toBeNull();
    mocks.call.mockRejectedValueOnce(Object.assign(new Error("Cart changed"), { code: "functions/aborted", details: { orderRequestUncommitted: true } }));
    await expect(retryPendingCartSubmission("hotel-a", "cart")).rejects.toThrow("Cart changed");
    expect(getPendingCartSubmission("hotel-a", "cart")).toBeNull();
    await submit({ revision: 5 });
    expect(mocks.call.mock.calls[2][0].expectedCartRevision).toBe(5);
  });

  it("keeps the original user's request if authentication changes before acknowledgement", async () => {
    let resolve;
    mocks.call.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const pending = submit();
    mocks.auth.currentUser = { uid: "buyer-b" }; resolve(success);
    await expect(pending).rejects.toThrow("original user");
    expect(localStorage.getItem("cart-submission:buyer-a:hotel-a:cart")).not.toBeNull();
    expect(getPendingCartSubmission("hotel-a", "cart")).toBeNull();
  });

  it("does not clear recovery on malformed or incomplete success responses", async () => {
    for (const data of [{}, { orderIds: [], deliveryDateAdjustments: [] }, { orderIds: ["same", "same"], deliveryDateAdjustments: [] }, { orderIds: ["order"] }]) {
      mocks.call.mockResolvedValueOnce({ data });
      await expect(submit()).rejects.toThrow("could not be verified");
      expect(getPendingCartSubmission("hotel-a", "cart")).not.toBeNull();
    }
    const requestIds = mocks.call.mock.calls.map(([input]) => input.requestId);
    expect(new Set(requestIds).size).toBe(1);
    await retryPendingCartSubmission("hotel-a", "cart");
    expect(getPendingCartSubmission("hotel-a", "cart")).toBeNull();
  });

  it("does not remove a different pending request saved by another tab", async () => {
    let resolve;
    mocks.call.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const pending = submit();
    const replacement = { ...getPendingCartSubmission("hotel-a", "cart"), requestId: "another-tab-request" };
    localStorage.setItem("cart-submission:buyer-a:hotel-a:cart", JSON.stringify(replacement));
    resolve(success); await pending;
    expect(getPendingCartSubmission("hotel-a", "cart")).toEqual(replacement);
  });

  it("requires storage before sending and never bypasses a malformed saved request", async () => {
    localStorage.setItem("cart-submission:buyer-a:hotel-a:cart", JSON.stringify({ hotelUid: "hotel-b", shoppingCartId: "cart" }));
    await expect(submit()).rejects.toThrow("needs recovery"); expect(mocks.call).not.toHaveBeenCalled();
  });
});
