import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import ShoppingCartPage from "./ShoppingCartPage";

const mocks = vi.hoisted(() => ({ hotel: "hotel-a", cart: vi.fn(), outlets: vi.fn(), outlet: vi.fn(), create: vi.fn(), navigate: vi.fn() }));
vi.mock("../../contexts/HotelContext", () => ({ useHotelContext: () => ({ hotelUid: mocks.hotel }) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key) => key }) }));
vi.mock("react-router-dom", () => ({ useNavigate: () => mocks.navigate, useParams: () => ({ cartId: "cart" }) }));
vi.mock("../../firebaseConfig", () => ({ auth: { currentUser: { uid: "buyer" } }, signOut: vi.fn() }));
vi.mock("../layout/HeaderBar", () => ({ default: () => null }));
vi.mock("../catalog/PendingCartCommand", () => ({ default: () => null }));
vi.mock("../shared/Modal", () => ({ default: ({ open, children }) => open ? <section>{children}</section> : null }));
vi.mock("../../services/firebaseSettings", () => ({ getOutlets: mocks.outlets }));
vi.mock("../../services/firebaseOrders", () => ({ createOrdersFromShoppingCart: mocks.create }));
vi.mock("../../services/firebaseShoppingCarts", () => ({ getShoppingCart: mocks.cart, removeShoppingCartItem: vi.fn(), updateShoppingCartItemNote: vi.fn(), updateShoppingCartItemOutlet: mocks.outlet, updateShoppingCartItemQty: vi.fn() }));
const cart = (outletId = "") => ({ id: "cart", revision: 8, items: [{ supplierProductId: "juice", purchaseOptionId: "case", supplierProductName: "Orange juice", supplierName: "Drinks supplier", pricePerPurchaseUnit: 12, currency: "EUR", priceBasis: "net", baseUnitsPerPurchaseUnit: 6000, baseUnit: "ml", purchaseUnit: "case", qtyPurchaseUnits: 2, outletId }] });
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
beforeEach(() => {
  vi.clearAllMocks(); mocks.hotel = "hotel-a";
  mocks.cart.mockResolvedValue(cart()); mocks.outlets.mockResolvedValue([{ id: "bar", name: "Lobby bar" }, { id: "kitchen", name: "Main kitchen" }]);
  mocks.outlet.mockResolvedValue({ revision: 9 }); mocks.create.mockResolvedValue({ deliveryDateAdjustments: [] });
});

it("searches outlets and sends their stable identity with the reviewed cart revision", async () => {
  render(<ShoppingCartPage />);
  const combo = await screen.findByRole("combobox", { name: "Outlet for Orange juice" });
  fireEvent.change(combo, { target: { value: "kitchen" } });
  fireEvent.click(await screen.findByRole("option", { name: "Main kitchen" }));
  await waitFor(() => expect(mocks.outlet).toHaveBeenCalledWith("hotel-a", "cart", "juice", "kitchen", "case", 8));
  expect(mocks.cart).toHaveBeenCalledTimes(2);
  expect(screen.getByText("6000 ml")).toBeInTheDocument();
});

it("does not silently commit an unmatched typed outlet", async () => {
  render(<ShoppingCartPage />);
  const combo = await screen.findByRole("combobox", { name: "Outlet for Orange juice" });
  fireEvent.change(combo, { target: { value: "unlisted outlet" } }); fireEvent.blur(combo);
  expect(mocks.outlet).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Create Order" })).toBeDisabled();
});

it("ignores a late order creation after leaving the scoped cart", async () => {
  mocks.cart.mockResolvedValue(cart("bar"));
  const pending = deferred(); mocks.create.mockReturnValueOnce(pending.promise);
  const view = render(<ShoppingCartPage />);
  fireEvent.click(await screen.findByRole("button", { name: "Create Order" }));
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  await waitFor(() => expect(mocks.create).toHaveBeenCalledWith("hotel-a", "cart", expect.any(String), "buyer", 8));
  view.unmount(); await act(async () => pending.resolve({ deliveryDateAdjustments: [] }));
  expect(mocks.navigate).not.toHaveBeenCalled();
});
