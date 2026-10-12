import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("../../firebaseConfig", () => ({ auth: { currentUser: { uid: "user" } }, functions: {}, httpsCallable: () => mocks.call }));
vi.mock("../../services/firebaseSuppliers", () => ({ getSuppliers: vi.fn() }));
import PendingProductCommand from "./PendingProductCommand";
import PendingCartCommand from "./PendingCartCommand";
import { updateSupplierProduct } from "../../services/firebaseProducts";
import { addSupplierProductToShoppingCart } from "../../services/firebaseShoppingCarts";

describe("saved command reconciliation after remount", () => {
  beforeEach(() => { vi.clearAllMocks(); sessionStorage.clear(); });
  it("replays a product's saved revision and values through the recovery control", async () => {
    mocks.call.mockRejectedValueOnce(new Error("Lost response")).mockResolvedValue({ data: { hotelUid: "hotel", productId: "offer", revision: 8 } });
    await expect(updateSupplierProduct("hotel", "offer", { supplierProductName: "Milk", supplierSku: "new" }, undefined, { expectedRevision: 7 })).rejects.toThrow();
    const original = mocks.call.mock.calls[0][0];
    const completed = vi.fn();
    render(<PendingProductCommand hotelUid="hotel" collection="supplierproducts" productId="offer" onComplete={completed} />);
    fireEvent.click(screen.getByRole("button", { name: "Retry saved request" }));
    await waitFor(() => expect(completed).toHaveBeenCalledWith({ hotelUid: "hotel", productId: "offer", revision: 8 }));
    expect(mocks.call.mock.calls[1][0]).toEqual(original);
    expect(screen.queryByText("A saved product request needs reconciliation")).not.toBeInTheDocument();
  });
  it("replays an uncertain add once rather than allowing a second add command", async () => {
    mocks.call.mockRejectedValueOnce(new Error("Lost response")).mockResolvedValue({ data: { cartId: "cart", revision: 8 } });
    await expect(addSupplierProductToShoppingCart("hotel", "cart", { id: "offer" }, 2, "case6", 7)).rejects.toThrow();
    const original = mocks.call.mock.calls[0][0];
    const completed = vi.fn();
    render(<PendingCartCommand hotelUid="hotel" cartId="cart" onComplete={completed} />);
    fireEvent.click(screen.getByRole("button", { name: "Retry saved cart request" }));
    await waitFor(() => expect(completed).toHaveBeenCalledWith({ cartId: "cart", revision: 8 }));
    expect(mocks.call.mock.calls[1][0]).toEqual(original);
    expect(screen.queryByText("A saved cart request needs reconciliation")).not.toBeInTheDocument();
  });
});
