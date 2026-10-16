import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import ShoppingCartPage from "./ShoppingCartPage";

const mocks = vi.hoisted(() => ({ hotel: "hotel-a", permissions: ["orders.create"], actor: { currentUser: { uid: "buyer" } }, cart: vi.fn(), outlets: vi.fn(), outlet: vi.fn(), quantity: vi.fn(), note: vi.fn(), remove: vi.fn(), split: vi.fn(), pendingSubmission: vi.fn(), retrySubmission: vi.fn(), create: vi.fn(), preview: vi.fn(), navigate: vi.fn() }));
vi.mock("../../contexts/HotelContext", () => ({ useHotelContext: () => ({ hotelUid: mocks.hotel, permissions: mocks.permissions, subscriptionActive: true }) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key) => key }) }));
vi.mock("react-router-dom", () => ({ useNavigate: () => mocks.navigate, useParams: () => ({ cartId: "cart" }) }));
vi.mock("../../firebaseConfig", () => ({ auth: mocks.actor, signOut: vi.fn() }));
vi.mock("../layout/HeaderBar", () => ({ default: () => null }));
vi.mock("../catalog/PendingCartCommand", () => ({ default: () => null }));
vi.mock("../shared/Modal", () => ({ default: ({ open, children }) => open ? <section>{children}</section> : null }));
vi.mock("../../services/firebaseSettings", () => ({ getOutlets: mocks.outlets }));
vi.mock("../../services/firebaseOrders", () => ({ createOrdersFromShoppingCart: mocks.create, previewOrdersFromShoppingCart: mocks.preview, getPendingCartSubmission: mocks.pendingSubmission, retryPendingCartSubmission: mocks.retrySubmission }));
vi.mock("../../services/firebaseShoppingCarts", () => ({ getShoppingCart: mocks.cart, removeShoppingCartItem: mocks.remove, updateShoppingCartItemNote: mocks.note, updateShoppingCartItemOutlet: mocks.outlet, updateShoppingCartItemQty: mocks.quantity, splitShoppingCartItem: mocks.split }));
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
  mocks.outlet.mockResolvedValue({ revision: 9 }); mocks.note.mockResolvedValue({ revision: 9 }); mocks.quantity.mockResolvedValue({ revision: 9 }); mocks.split.mockResolvedValue({ revision: 9 }); mocks.pendingSubmission.mockReturnValue(null); mocks.retrySubmission.mockResolvedValue({ deliveryDateAdjustments: [] }); mocks.create.mockResolvedValue({ deliveryDateAdjustments: [] });
  mocks.preview.mockResolvedValue({ priceFingerprint: "reviewed-price", orders: [{ supplierId: "drinks", supplierName: "Drinks supplier", outletId: "bar", outletName: "Lobby bar", deliveryDate: "2026-10-16", totalAmount: 28, currency: "EUR", priceBasis: "net", products: [{ ...cart("bar").items[0], pricePerPurchaseUnit: 14, priceValidity: "current", pricingDateBasis: "delivery-date", pricingDate: "2026-10-16", priceSourceReference: "October list.xlsx" }] }] });
});

it("searches outlets and sends their stable identity with the reviewed cart revision", async () => {
  mocks.cart.mockResolvedValueOnce(cart()).mockResolvedValue({ ...cart("kitchen"), revision: 9 });
  render(<ShoppingCartPage />);
  const combo = await screen.findByRole("combobox", { name: "Outlet for Orange juice" });
  fireEvent.change(combo, { target: { value: "kitchen" } });
  fireEvent.click(await screen.findByRole("option", { name: "Main kitchen" }));
  await waitFor(() => expect(mocks.outlet).toHaveBeenCalledWith("hotel-a", "cart", "juice", "kitchen", "case", 8, { lineId: "legacy-0", expectedLineRevision: 0 }));
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
  await waitFor(() => expect(screen.getByRole("button", { name: "Create" })).not.toBeDisabled());
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  await waitFor(() => expect(mocks.create).toHaveBeenCalledWith("hotel-a", "cart", expect.any(String), "buyer", 8, "reviewed-price"));
  view.unmount(); await act(async () => pending.resolve({ deliveryDateAdjustments: [] }));
  expect(mocks.navigate).not.toHaveBeenCalled();
});

it("reviews effective prices and source evidence for the delivery date before allowing creation", async () => {
  const pending = deferred(); mocks.cart.mockResolvedValue(cart("bar")); mocks.preview.mockReturnValueOnce(pending.promise);
  render(<ShoppingCartPage />); fireEvent.click(await screen.findByRole("button", { name: "Create Order" }));
  expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
  expect(screen.getByRole("status")).toHaveTextContent("Reviewing applicable prices");
  const result = { priceFingerprint: "dated-price", orders: [{ supplierId: "drinks", supplierName: "Drinks supplier", outletId: "bar", outletName: "Lobby bar", deliveryDate: "2026-10-16", totalAmount: 30, currency: "EUR", priceBasis: "net", products: [{ ...cart("bar").items[0], pricePerPurchaseUnit: 15, priceValidity: "unknown", pricingDateBasis: "delivery-date", pricingDate: "2026-10-16", priceSourceReference: "Price agreement.pdf" }] }] };
  await act(async () => pending.resolve(result));
  expect(screen.getByText("30.00 EUR")).toBeInTheDocument();
  expect(screen.getByText(/Validity unknown · delivery date: 2026-10-16/)).toBeInTheDocument();
  expect(screen.getByText("Source: Price agreement.pdf")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  await waitFor(() => expect(mocks.create).toHaveBeenCalledWith("hotel-a", "cart", expect.any(String), "buyer", 8, "dated-price"));
});

it("blocks expired prices and can retry an applicable-price review without creating an order", async () => {
  mocks.cart.mockResolvedValue(cart("bar")); mocks.preview.mockRejectedValueOnce(new Error("No approved price applies (expired)."));
  render(<ShoppingCartPage />); fireEvent.click(await screen.findByRole("button", { name: "Create Order" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("expired");
  expect(screen.getByRole("button", { name: "Create" })).toBeDisabled(); expect(mocks.create).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Review prices again" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Create" })).not.toBeDisabled());
  expect(mocks.preview).toHaveBeenCalledTimes(2);
});

it("keeps the reviewed request available for idempotent recovery after an uncertain creation", async () => {
  mocks.cart.mockResolvedValue(cart("bar")); mocks.create.mockRejectedValueOnce(new Error("Connection interrupted"));
  render(<ShoppingCartPage />); fireEvent.click(await screen.findByRole("button", { name: "Create Order" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Create" })).not.toBeDisabled());
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  const retry = await screen.findByRole("button", { name: "Retry saved creation" });
  expect(screen.getByText(/Creation could not be confirmed/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  expect(screen.getByRole("combobox", { name: "Outlet for Orange juice" })).toBeDisabled();
  expect(mocks.preview).toHaveBeenCalledTimes(1);
  fireEvent.click(retry);
  await waitFor(() => expect(mocks.retrySubmission).toHaveBeenCalledWith("hotel-a", "cart"));
  expect(mocks.create).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith("/orders"));
});

it("addresses identical packages by line and leaves the other outlet quantity unchanged", async () => {
  const source = cart("bar"); source.items[0] = { ...source.items[0], lineId: "bar-line", lineRevision: 2, addedByName: "Alex" };
  source.items.push({ ...source.items[0], lineId: "kitchen-line", lineRevision: 4, qtyPurchaseUnits: 3, outletId: "kitchen", addedByName: "Jamie" });
  mocks.cart.mockResolvedValueOnce(source).mockResolvedValue({ ...source, revision: 9, items: [source.items[0], { ...source.items[1], qtyPurchaseUnits: 4, lineRevision: 5 }] });
  render(<ShoppingCartPage />);
  const inputs = await screen.findAllByRole("spinbutton");
  fireEvent.change(inputs[1], { target: { value: "4" } }); fireEvent.blur(inputs[1]);
  await waitFor(() => expect(mocks.quantity).toHaveBeenCalledWith("hotel-a", "cart", "juice", 4, "case", 8, { lineId: "kitchen-line", expectedLineRevision: 4 }));
  await waitFor(() => expect(screen.getAllByRole("spinbutton")[1]).toHaveValue(4));
  expect(screen.getAllByRole("spinbutton")[0]).toHaveValue(2);
  expect(screen.getAllByRole("combobox")[0]).toHaveValue("Lobby bar"); expect(screen.getAllByRole("combobox")[1]).toHaveValue("Main kitchen");
  expect(screen.getByText(/Added by Alex/)).toBeInTheDocument(); expect(screen.getByText(/Added by Jamie/)).toBeInTheDocument();
});

it("splits five cases into two for the bar and three for the kitchen without changing the note", async () => {
  const source = { ...cart("bar"), items: [{ ...cart("bar").items[0], lineId: "bar-line", lineRevision: 2, qtyPurchaseUnits: 5, note: "Keep chilled" }] };
  const remaining = { ...source.items[0], qtyPurchaseUnits: 2, lineRevision: 3 };
  mocks.cart.mockResolvedValueOnce(source).mockResolvedValue({ ...source, revision: 9, items: [remaining, { ...remaining, lineId: "kitchen-line", lineRevision: 0, outletId: "kitchen", qtyPurchaseUnits: 3 }] });
  render(<ShoppingCartPage />); fireEvent.click(await screen.findByRole("button", { name: "Split by outlet" }));
  fireEvent.change(screen.getByLabelText("Quantity to move"), { target: { value: "3" } });
  fireEvent.focus(screen.getByRole("combobox", { name: "Destination outlet" })); fireEvent.click(await screen.findByRole("option", { name: "Main kitchen" }));
  fireEvent.click(screen.getByRole("button", { name: "Split quantity" }));
  await waitFor(() => expect(mocks.split).toHaveBeenCalledWith("hotel-a", "cart", expect.objectContaining({ lineId: "bar-line", lineRevision: 2, note: "Keep chilled" }), 3, "kitchen", 8));
  await waitFor(() => expect(screen.getAllByRole("spinbutton")).toHaveLength(2));
  expect(screen.getAllByRole("spinbutton")[0]).toHaveValue(2); expect(screen.getAllByRole("spinbutton")[1]).toHaveValue(3);
  expect(screen.getAllByRole("button", { name: "Edit note" })).toHaveLength(2);
});

it("retains a conflicting note and requires explicit review of the changed line before retrying", async () => {
  const source = { ...cart("bar"), items: [{ ...cart("bar").items[0], lineId: "bar-line", lineRevision: 2, note: "Original note" }] };
  const changed = { ...source, revision: 9, items: [{ ...source.items[0], lineRevision: 3, note: "Colleague's note" }] };
  mocks.cart.mockResolvedValueOnce(source).mockResolvedValue(changed);
  mocks.note.mockRejectedValueOnce(Object.assign(new Error("This line changed. Refresh and review it."), { details: { cartRequestUncommitted: true } }));
  render(<ShoppingCartPage />); fireEvent.click(await screen.findByRole("button", { name: "Edit note" }));
  fireEvent.change(screen.getByLabelText("Note"), { target: { value: "My draft note" } }); fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(mocks.note).toHaveBeenCalledWith("hotel-a", "cart", "juice", "My draft note", "case", 8, { lineId: "bar-line", expectedLineRevision: 2 }));
  fireEvent.click(await screen.findByRole("button", { name: "Refresh saved line" }));
  await screen.findByText("Saved note: Colleague's note");
  expect(screen.getByLabelText("Note")).toHaveValue("My draft note"); expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "I reviewed this line; keep my note" }));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(mocks.note).toHaveBeenLastCalledWith("hotel-a", "cart", "juice", "My draft note", "case", 9, { lineId: "bar-line", expectedLineRevision: 3 }));
});

it("restores a saved submission after reload and blocks edits until the original request is reconciled", async () => {
  mocks.pendingSubmission.mockReturnValue({ deliveryDate: "2026-10-17", expectedCartRevision: 8, requestId: "saved" });
  mocks.cart.mockResolvedValue(cart("bar"));
  render(<ShoppingCartPage />);
  const retry = await screen.findByRole("button", { name: "Retry saved order creation" });
  await screen.findByRole("combobox", { name: "Outlet for Orange juice" });
  expect(screen.getByRole("spinbutton")).toBeDisabled(); expect(screen.getByRole("button", { name: "Create Order" })).toBeDisabled();
  fireEvent.click(retry);
  await waitFor(() => expect(mocks.retrySubmission).toHaveBeenCalledWith("hotel-a", "cart"));
  await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith("/orders"));
  expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.preview).not.toHaveBeenCalled();
});

it("replays a saved creation even when a refreshed cart now has unassigned lines and unknown prices", async () => {
  mocks.cart.mockResolvedValueOnce(cart("bar")).mockResolvedValue({ ...cart(), revision: 9, items: [{ ...cart().items[0], pricePerPurchaseUnit: null }] });
  mocks.create.mockRejectedValueOnce(new Error("Connection interrupted"));
  render(<ShoppingCartPage />); fireEvent.click(await screen.findByRole("button", { name: "Create Order" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Create" })).not.toBeDisabled());
  fireEvent.click(screen.getByRole("button", { name: "Create" })); await screen.findByRole("button", { name: "Retry saved creation" });
  fireEvent.click(screen.getByRole("button", { name: "Refresh cart" }));
  await screen.findByText("Some prices or currencies are unavailable. Review these offers before creating orders.");
  expect(screen.getByRole("button", { name: "Retry saved creation" })).not.toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Retry saved creation" }));
  await waitFor(() => expect(mocks.retrySubmission).toHaveBeenCalledWith("hotel-a", "cart"));
  expect(mocks.create).toHaveBeenCalledTimes(1);
});

it("switches an open creation dialog to exact recovery when another tab saves a submission", async () => {
  mocks.cart.mockResolvedValue(cart("bar")); render(<ShoppingCartPage />);
  fireEvent.click(await screen.findByRole("button", { name: "Create Order" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Create" })).not.toBeDisabled());
  mocks.pendingSubmission.mockReturnValue({ deliveryDate: "2026-10-20", expectedCartRevision: 8, requestId: "other-tab" });
  act(() => window.dispatchEvent(new Event("storage")));
  expect(screen.getByLabelText("Delivery Date")).toBeDisabled();
  expect(screen.getByText(/Saved delivery date: 2026-10-20/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Retry saved creation" }));
  await waitFor(() => expect(mocks.retrySubmission).toHaveBeenCalledWith("hotel-a", "cart"));
  expect(mocks.create).not.toHaveBeenCalled();
});
