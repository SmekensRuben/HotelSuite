import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ call: vi.fn(), getDoc: vi.fn(), auth: { currentUser: { uid: "user" } } }));
vi.mock("../firebaseConfig", () => ({ functions: {}, db: {}, auth: mocks.auth, httpsCallable: () => mocks.call, doc: (...path) => path, getDoc: mocks.getDoc }));
import { addSupplierProductToShoppingCart, getShoppingCart, updateShoppingCartItemNote, updateShoppingCartItemOutlet, updateShoppingCartItemQty, removeShoppingCartItem, retryPendingCartCommand } from "./firebaseShoppingCarts";
describe("cart purchase option identity", () => {
  beforeEach(() => { vi.clearAllMocks(); sessionStorage.clear(); mocks.auth.currentUser = { uid: "user" }; mocks.call.mockResolvedValue({ data: { cartId: "cart", revision: 8 } }); });
  it("sends independent package identities for every command", async () => {
    await addSupplierProductToShoppingCart("hotel", "cart", { id: "milk" }, 2, "case6");
    await updateShoppingCartItemQty("hotel", "cart", "milk", 3, "case6");
    await updateShoppingCartItemNote("hotel", "cart", "milk", "Note", "case6");
    await updateShoppingCartItemOutlet("hotel", "cart", "milk", "kitchen", "case6");
    await removeShoppingCartItem("hotel", "cart", "milk", "case6");
    expect(mocks.call.mock.calls.map(([input]) => input.purchaseOptionId)).toEqual(Array(5).fill("case6"));
  });
  it("sends decimal quantities from HTML inputs as numbers and preserves unknown-command replay", async () => {
    mocks.call.mockRejectedValueOnce(new Error("Lost response"));
    await expect(updateShoppingCartItemQty("hotel", "cart", "weighed", "0.25", "default", 7)).rejects.toThrow("Lost response");
    const original = mocks.call.mock.calls[0][0]; expect(original.value).toBe(0.25);
    await retryPendingCartCommand("hotel", "cart"); expect(mocks.call.mock.calls[1][0]).toEqual(original);
  });
  it("keeps blank quantities unknown and rejects unsupported precision before reserving a command", async () => {
    for (const value of ["", " ", null, undefined, "0.0001", -1]) await expect(updateShoppingCartItemQty("hotel", "cart", "weighed", value)).rejects.toThrow("explicit purchase quantity");
    expect(mocks.call).not.toHaveBeenCalled(); expect(sessionStorage.length).toBe(0);
    await updateShoppingCartItemQty("hotel", "cart", "weighed", "0");
    expect(mocks.call).toHaveBeenCalledWith(expect.objectContaining({ value: 0 }));
  });
  it("preserves the default identity for historical cart callers", async () => {
    await updateShoppingCartItemQty("hotel", "cart", "milk", 3);
    expect(mocks.call).toHaveBeenCalledWith(expect.objectContaining({ purchaseOptionId: "default" }));
  });
  it("locks a cart after an uncertain add and replays its original revision and request ID", async () => {
    mocks.call.mockRejectedValueOnce(new Error("Lost response")).mockResolvedValue({ data: { cartId: "cart", revision: 8 } });
    await expect(addSupplierProductToShoppingCart("hotel", "cart", { id: "milk" }, 2, "case6", 7)).rejects.toThrow("Lost response");
    const original = mocks.call.mock.calls[0][0];
    await expect(addSupplierProductToShoppingCart("hotel", "cart", { id: "milk" }, 3, "case6", 8)).rejects.toThrow("uncertain result");
    await expect(updateShoppingCartItemNote("hotel", "cart", "milk", "New", "case6", 8)).rejects.toThrow("uncertain result");
    await retryPendingCartCommand("hotel", "cart");
    expect(mocks.call).toHaveBeenCalledTimes(2);
    expect(mocks.call.mock.calls[1][0]).toEqual(original);
    expect(original.expectedRevision).toBe(7);
  });
  it("allows changed commands only after current server non-commit proof", async () => {
    mocks.call.mockRejectedValueOnce(Object.assign(new Error("Stale revision"), { details: { cartRequestUncommitted: true } })).mockResolvedValue({ data: { cartId: "cart", revision: 9 } });
    await expect(updateShoppingCartItemQty("hotel", "cart", "milk", 2, "case6", 7)).rejects.toThrow("Stale revision");
    await updateShoppingCartItemQty("hotel", "cart", "milk", 2, "case6", 8);
    expect(mocks.call.mock.calls[1][0].expectedRevision).toBe(8);
    expect(mocks.call.mock.calls[1][0].requestId).not.toBe(mocks.call.mock.calls[0][0].requestId);
  });

  it("does not confirm a cached or earlier cart revision after an acknowledged outlet mutation", async () => {
    const snapshot = (revision, fromCache = false) => ({ id: "cart", exists: () => true, metadata: { fromCache }, data: () => ({ revision, items: [] }) });
    mocks.getDoc.mockResolvedValueOnce(snapshot(9, true)).mockResolvedValueOnce(snapshot(8)).mockResolvedValueOnce(snapshot(9));
    await expect(getShoppingCart("hotel", "cart", { minimumRevision: 9 })).rejects.toThrow("verified with the server");
    await expect(getShoppingCart("hotel", "cart", { minimumRevision: 9 })).rejects.toThrow("not caught up");
    await expect(getShoppingCart("hotel", "cart", { minimumRevision: 9 })).resolves.toEqual(expect.objectContaining({ revision: 9 }));
  });

  it("preserves the original actor's saved intent when sign-in changes before the response", async () => {
    let resolve;
    mocks.call.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const pending = updateShoppingCartItemOutlet("hotel", "cart", "milk", "kitchen", "case6", 7);
    mocks.auth.currentUser = { uid: "other-user" };
    resolve({ data: { cartId: "cart", revision: 8 } });
    await expect(pending).rejects.toThrow("original user");
    expect(sessionStorage.getItem("cart-command:user:hotel:cart")).not.toBeNull();
    expect(sessionStorage.getItem("cart-command:other-user:hotel:cart")).toBeNull();
  });

  it("keeps an incomplete revision response recoverable using the same request ID", async () => {
    mocks.call.mockResolvedValueOnce({ data: { cartId: "cart" } }).mockResolvedValueOnce({ data: { cartId: "cart", revision: 8 } });
    await expect(updateShoppingCartItemOutlet("hotel", "cart", "milk", "kitchen", "case6", 7)).rejects.toThrow("revision could not be validated");
    await retryPendingCartCommand("hotel", "cart");
    expect(mocks.call.mock.calls[1][0]).toEqual(mocks.call.mock.calls[0][0]);
  });

});
