import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("../firebaseConfig", () => ({ functions: {}, auth: { currentUser: { uid: "user" } }, httpsCallable: () => mocks.call }));
import { addSupplierProductToShoppingCart, updateShoppingCartItemNote, updateShoppingCartItemOutlet, updateShoppingCartItemQty, removeShoppingCartItem, retryPendingCartCommand } from "./firebaseShoppingCarts";
describe("cart purchase option identity", () => {
  beforeEach(() => { vi.clearAllMocks(); sessionStorage.clear(); mocks.call.mockResolvedValue({ data: { cartId: "cart" } }); });
  it("sends independent package identities for every command", async () => {
    await addSupplierProductToShoppingCart("hotel", "cart", { id: "milk" }, 2, "case6");
    await updateShoppingCartItemQty("hotel", "cart", "milk", 3, "case6");
    await updateShoppingCartItemNote("hotel", "cart", "milk", "Note", "case6");
    await updateShoppingCartItemOutlet("hotel", "cart", "milk", "kitchen", "case6");
    await removeShoppingCartItem("hotel", "cart", "milk", "case6");
    expect(mocks.call.mock.calls.map(([input]) => input.purchaseOptionId)).toEqual(Array(5).fill("case6"));
  });
  it("preserves the default identity for historical cart callers", async () => {
    await updateShoppingCartItemQty("hotel", "cart", "milk", 3);
    expect(mocks.call).toHaveBeenCalledWith(expect.objectContaining({ purchaseOptionId: "default" }));
  });
  it("locks a cart after an uncertain add and replays its original revision and request ID", async () => {
    mocks.call.mockRejectedValueOnce(new Error("Lost response")).mockResolvedValue({ data: { cartId: "cart" } });
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
    mocks.call.mockRejectedValueOnce(Object.assign(new Error("Stale revision"), { details: { cartRequestUncommitted: true } })).mockResolvedValue({ data: { cartId: "cart" } });
    await expect(updateShoppingCartItemQty("hotel", "cart", "milk", 2, "case6", 7)).rejects.toThrow("Stale revision");
    await updateShoppingCartItemQty("hotel", "cart", "milk", 2, "case6", 8);
    expect(mocks.call.mock.calls[1][0].expectedRevision).toBe(8);
    expect(mocks.call.mock.calls[1][0].requestId).not.toBe(mocks.call.mock.calls[0][0].requestId);
  });

});
