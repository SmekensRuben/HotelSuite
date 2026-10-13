import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import OrderCreatePage from "./OrderCreatePage";

const mocks = vi.hoisted(() => ({ hotel: "hotel-a", permissions: ["orders.create"], actor: { currentUser: { uid: "buyer" } }, products: vi.fn(), suppliers: vi.fn(), cart: vi.fn(), read: vi.fn(), add: vi.fn() }));
vi.mock("../../contexts/HotelContext", () => ({ useHotelContext: () => ({ hotelUid: mocks.hotel, permissions: mocks.permissions, subscriptionActive: true }) }));
vi.mock("../../firebaseConfig", () => ({ auth: mocks.actor, signOut: vi.fn() }));
vi.mock("../../services/firebaseProducts", () => ({ getSupplierProducts: mocks.products }));
vi.mock("../../services/firebaseSuppliers", () => ({ getSuppliers: mocks.suppliers }));
vi.mock("../../services/firebaseShoppingCarts", () => ({ getOrCreateShoppingCart: mocks.cart, getShoppingCart: mocks.read, addSupplierProductToShoppingCart: mocks.add, getPendingCartCommand: () => null, retryPendingCartCommand: vi.fn() }));
vi.mock("react-router-dom", () => ({ useNavigate: () => vi.fn() }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key) => key }) }));
vi.mock("../layout/HeaderBar", () => ({ default: () => null }));
const offer = { id: "juice", supplierProductName: "Orange juice", supplierId: "drinks", currency: "EUR", priceBasis: "net", pricePerPurchaseUnit: 12, purchaseUnit: "case", baseUnitsPerPurchaseUnit: 6, baseUnit: "l", active: true };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
beforeEach(() => {
  vi.clearAllMocks(); mocks.hotel = "hotel-a"; mocks.permissions = ["orders.create"]; mocks.actor.currentUser = { uid: "buyer" };
  mocks.products.mockResolvedValue({ products: [offer], hasMore: false }); mocks.suppliers.mockResolvedValue([]);
  mocks.cart.mockResolvedValue({ id: "cart", revision: 4, items: [] }); mocks.read.mockResolvedValue({ id: "cart", revision: 5, items: [{ ...offer, supplierProductId: "juice", qtyPurchaseUnits: 1 }] }); mocks.add.mockResolvedValue({ cartId: "cart", revision: 5 });
});

it("never offers an Add click before the initial cart is ready and submits the first enabled click", async () => {
  const initial = deferred(); mocks.cart.mockReturnValueOnce(initial.promise);
  render(<OrderCreatePage />);
  const add = await screen.findByRole("button", { name: "Add" });
  expect(add).toBeDisabled(); expect(screen.getByRole("status")).toHaveTextContent("Preparing your shopping cart");
  fireEvent.click(add); expect(mocks.add).not.toHaveBeenCalled();
  await act(async () => initial.resolve({ id: "cart", revision: 4, items: [] }));
  expect(add).not.toBeDisabled(); fireEvent.click(add);
  await waitFor(() => expect(mocks.add).toHaveBeenCalledTimes(1));
  expect(mocks.add).toHaveBeenCalledWith("hotel-a", "cart", expect.objectContaining({ id: "juice" }), 1, "default", 4);
  await waitFor(() => expect(mocks.read).toHaveBeenCalledWith("hotel-a", "cart", { minimumRevision: 5 }));
  expect(mocks.cart).toHaveBeenCalledTimes(1);
});

it("does not let a slow or failed optional supplier filter postpone cart readiness", async () => {
  const suppliers = deferred(); mocks.suppliers.mockReturnValueOnce(suppliers.promise);
  render(<OrderCreatePage />);
  const add = await screen.findByRole("button", { name: "Add" });
  await waitFor(() => expect(add).not.toBeDisabled());
  fireEvent.click(add); await waitFor(() => expect(mocks.add).toHaveBeenCalledTimes(1));
  await act(async () => suppliers.reject(new Error("Supplier filter offline")));
  expect(screen.getByText(/Supplier filter unavailable/)).toHaveTextContent("Supplier filter offline");
  await waitFor(() => expect(screen.getByRole("button", { name: "Add" })).not.toBeDisabled());
});

it("keeps additions blocked when the post-add cart is not authoritative yet", async () => {
  mocks.read.mockResolvedValueOnce({ id: "cart", revision: 4, items: [] });
  render(<OrderCreatePage />);
  fireEvent.click(await screen.findByRole("button", { name: "Add" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("could not be verified");
  expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Refresh cart" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Add" })).not.toBeDisabled());
  expect(mocks.read.mock.calls[1]).toEqual(["hotel-a", "cart", { minimumRevision: 5 }]);
  expect(mocks.add).toHaveBeenCalledTimes(1);
});

it("blocks an old actor's Add handler before React has rerendered the sign-in change", async () => {
  render(<OrderCreatePage />);
  const add = await screen.findByRole("button", { name: "Add" }); await waitFor(() => expect(add).not.toBeDisabled());
  mocks.actor.currentUser = { uid: "other-buyer" };
  fireEvent.click(add); expect(mocks.add).not.toHaveBeenCalled();
});

it("does not apply a previous actor's delayed cart after the same hotel rerenders", async () => {
  const original = deferred(); mocks.cart.mockReturnValueOnce(original.promise);
  const view = render(<OrderCreatePage />);
  await screen.findByRole("button", { name: "Add" });
  mocks.actor.currentUser = { uid: "other-buyer" }; mocks.cart.mockResolvedValue({ id: "other-cart", revision: 1, items: [] });
  view.rerender(<OrderCreatePage />); await waitFor(() => expect(screen.getByRole("button", { name: "Add" })).not.toBeDisabled());
  await act(async () => original.resolve({ id: "old-cart", revision: 99, items: Array(3).fill(offer) }));
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  await waitFor(() => expect(mocks.add).toHaveBeenCalledWith("hotel-a", "other-cart", expect.anything(), 1, "default", 1));
});
