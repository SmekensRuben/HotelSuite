import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import ShoppingCartPage from "./ShoppingCartPage";

const mocks = vi.hoisted(() => ({ hotel: "hotel-a", permissions: ["orders.create"], actor: { currentUser: { uid: "buyer" } }, cart: vi.fn(), outlets: vi.fn(), outlet: vi.fn(), create: vi.fn(), navigate: vi.fn() }));
vi.mock("../../contexts/HotelContext", () => ({ useHotelContext: () => ({ hotelUid: mocks.hotel, permissions: mocks.permissions, subscriptionActive: true }) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key) => key }) }));
vi.mock("react-router-dom", () => ({ useNavigate: () => mocks.navigate, useParams: () => ({ cartId: "cart" }) }));
vi.mock("../../firebaseConfig", () => ({ auth: mocks.actor, signOut: vi.fn() }));
vi.mock("../layout/HeaderBar", () => ({ default: () => null }));
vi.mock("../catalog/PendingCartCommand", () => ({ default: () => null }));
vi.mock("../shared/Modal", () => ({ default: ({ open, children }) => open ? <section>{children}</section> : null }));
vi.mock("../../services/firebaseSettings", () => ({ getOutlets: mocks.outlets }));
vi.mock("../../services/firebaseOrders", () => ({ createOrdersFromShoppingCart: mocks.create }));
vi.mock("../../services/firebaseShoppingCarts", () => ({ getShoppingCart: mocks.cart, removeShoppingCartItem: vi.fn(), updateShoppingCartItemNote: vi.fn(), updateShoppingCartItemOutlet: mocks.outlet, updateShoppingCartItemQty: vi.fn() }));
const cart = (outletId = "") => ({ id: "cart", revision: 8, items: [{ supplierProductId: "juice", purchaseOptionId: "case", supplierProductName: "Orange juice", supplierName: "Drinks supplier", pricePerPurchaseUnit: 12, currency: "EUR", priceBasis: "net", baseUnitsPerPurchaseUnit: 6000, baseUnit: "ml", purchaseUnit: "case", qtyPurchaseUnits: 2, outletId }] });
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
it("supports fractional kg quantities with the server's three-decimal quantity precision", async () => {
  const weighed = cart("kitchen"); weighed.items[0] = { ...weighed.items[0], purchaseUnit: "kg", baseUnit: "kg", baseUnitsPerPurchaseUnit: 1, qtyPurchaseUnits: 2.5, pricePerPurchaseUnit: 8 };
  mocks.cart.mockResolvedValue(weighed); render(<ShoppingCartPage />);
  const input = await screen.findByRole("spinbutton"); expect(input).toHaveValue(2.5);
  expect(input).toHaveAttribute("min", "0.001"); expect(input).toHaveAttribute("step", "0.001");
});
beforeEach(() => {
  vi.clearAllMocks(); mocks.hotel = "hotel-a"; mocks.permissions = ["orders.create"]; mocks.actor.currentUser = { uid: "buyer" };
  mocks.cart.mockResolvedValue(cart()); mocks.outlets.mockResolvedValue([{ id: "bar", name: "Lobby bar" }, { id: "kitchen", name: "Main kitchen" }]);
  mocks.outlet.mockResolvedValue({ revision: 9 }); mocks.create.mockResolvedValue({ deliveryDateAdjustments: [] });
});

it("searches outlets and sends their stable identity with the reviewed cart revision", async () => {
  mocks.cart.mockResolvedValueOnce(cart()).mockResolvedValue({ ...cart("kitchen"), revision: 9 });
  render(<ShoppingCartPage />);
  const combo = await screen.findByRole("combobox", { name: "Outlet for Orange juice" });
  fireEvent.change(combo, { target: { value: "kitchen" } });
  fireEvent.click(await screen.findByRole("option", { name: "Main kitchen" }));
  await waitFor(() => expect(mocks.outlet).toHaveBeenCalledWith("hotel-a", "cart", "juice", "kitchen", "case", 8));
  await waitFor(() => expect(mocks.cart).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.getByRole("combobox", { name: "Outlet for Orange juice" })).toHaveValue("Main kitchen"));
  expect(screen.getByText("6000 ml")).toBeInTheDocument();
});

it("shows an outlet selection immediately as pending and keeps the row until acknowledgement and refresh", async () => {
  const mutation = deferred(), read = deferred(); mocks.outlet.mockReturnValueOnce(mutation.promise);
  mocks.cart.mockResolvedValueOnce(cart()).mockReturnValueOnce(read.promise);
  render(<ShoppingCartPage />);
  const combo = await screen.findByRole("combobox", { name: "Outlet for Orange juice" });
  fireEvent.focus(combo); fireEvent.click(await screen.findByRole("option", { name: "Main kitchen" }));
  expect(combo).toHaveValue("Main kitchen"); expect(combo).toBeDisabled();
  expect(screen.getByText("Saving selected outlet…")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Create Order" })).toBeDisabled();
  expect(mocks.cart).toHaveBeenCalledTimes(1);
  await act(async () => mutation.resolve({ revision: 9 }));
  expect(screen.getByText("Awaiting updated cart…")).toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "Outlet for Orange juice" })).toHaveValue("Main kitchen");
  expect(screen.queryByText("Loading shopping cart...")).not.toBeInTheDocument();
  await act(async () => read.resolve({ ...cart("kitchen"), revision: 9 }));
  expect(screen.queryByText("Awaiting updated cart…")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Create Order" })).not.toBeDisabled();
});

it("does not treat a failed or stale post-mutation read as a confirmed outlet", async () => {
  mocks.cart.mockResolvedValueOnce(cart("bar")).mockRejectedValueOnce(new Error("Cart server offline"));
  render(<ShoppingCartPage />);
  const combo = await screen.findByRole("combobox", { name: "Outlet for Orange juice" });
  fireEvent.focus(combo); fireEvent.click(await screen.findByRole("option", { name: "Main kitchen" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Cart server offline");
  expect(screen.getByText(/Selection not confirmed/)).toBeInTheDocument();
  expect(combo).toHaveValue("Main kitchen"); expect(screen.getByRole("button", { name: "Create Order" })).toBeDisabled();
  mocks.cart.mockResolvedValueOnce(cart("bar")); fireEvent.click(screen.getByRole("button", { name: "Refresh cart" }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("not caught up"));
  expect(screen.getByRole("button", { name: "Create Order" })).toBeDisabled();
  mocks.cart.mockResolvedValueOnce({ ...cart("kitchen"), revision: 9 }); fireEvent.click(screen.getByRole("button", { name: "Refresh cart" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Create Order" })).not.toBeDisabled());
  expect(mocks.outlet).toHaveBeenCalledTimes(1);
});

it("uses the current authoritative outlet if another update changed it before the refresh", async () => {
  mocks.cart.mockResolvedValueOnce(cart()).mockResolvedValue({ ...cart("bar"), revision: 10 });
  render(<ShoppingCartPage />);
  const combo = await screen.findByRole("combobox", { name: "Outlet for Orange juice" });
  fireEvent.focus(combo); fireEvent.click(await screen.findByRole("option", { name: "Main kitchen" }));
  await waitFor(() => expect(combo).toHaveValue("Lobby bar"));
  expect(screen.getByText(/The cart changed again/)).toBeInTheDocument();
  expect(screen.queryByText("Saving selected outlet…")).not.toBeInTheDocument();
});

it("keeps different currencies, net, gross and unknown price bases separate in the compact summary", async () => {
  const items = [
    { ...cart("bar").items[0], supplierProductId: "gross", priceBasis: "gross", pricePerPurchaseUnit: 15.9, qtyPurchaseUnits: 1 },
    { ...cart("bar").items[0], supplierProductId: "net", priceBasis: "net", pricePerPurchaseUnit: 8, qtyPurchaseUnits: 1 },
    { ...cart("bar").items[0], supplierProductId: "unknown", priceBasis: "unknown", pricePerPurchaseUnit: 12, qtyPurchaseUnits: 1 },
    { ...cart("bar").items[0], supplierProductId: "gbp", priceBasis: "net", currency: "GBP", pricePerPurchaseUnit: 8, qtyPurchaseUnits: 1 },
    { ...cart("bar").items[0], supplierProductId: "free", priceBasis: "net", pricePerPurchaseUnit: 0, qtyPurchaseUnits: 1 },
    { ...cart("bar").items[0], supplierProductId: "missing", pricePerPurchaseUnit: null, qtyPurchaseUnits: 1 },
  ];
  mocks.cart.mockResolvedValue({ ...cart(), items }); render(<ShoppingCartPage />);
  const summary = await screen.findByRole("region", { name: "Cart summary" });
  expect(summary).toHaveTextContent("Gross (including VAT)"); expect(summary).toHaveTextContent("Net (excluding VAT)");
  expect(summary).toHaveTextContent("Unknown (VAT treatment unavailable)");
  expect(summary).toHaveTextContent("15.90"); expect(summary).toHaveTextContent("12.00"); expect(summary).toHaveTextContent("GBP");
  expect(summary.querySelectorAll("dd").length).toBe(4);
  expect(summary).toHaveTextContent("Some prices or currencies are unavailable");
  expect(screen.getByRole("button", { name: "Create Order" })).toBeDisabled();
});

it("blocks outlet edits and order creation by an old actor before a rerender", async () => {
  mocks.cart.mockResolvedValue(cart("bar")); render(<ShoppingCartPage />);
  const combo = await screen.findByRole("combobox", { name: "Outlet for Orange juice" });
  mocks.actor.currentUser = { uid: "other-buyer" };
  fireEvent.focus(combo); fireEvent.click(await screen.findByRole("option", { name: "Main kitchen" }));
  expect(mocks.outlet).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Create Order" })); fireEvent.click(screen.getByRole("button", { name: "Create" }));
  expect(mocks.create).not.toHaveBeenCalled();
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
