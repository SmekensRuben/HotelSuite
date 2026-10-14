import { beforeEach, expect, it, vi } from "vitest";
import { previewOrdersFromShoppingCart } from "./firebaseOrders";

const mocks = vi.hoisted(() => ({ callable: vi.fn(), invoke: vi.fn(), auth: { currentUser: { uid: "buyer" } } }));
vi.mock("../firebaseConfig", () => ({ auth: mocks.auth, functions: {}, httpsCallable: mocks.callable, db: {}, collection: vi.fn(), doc: vi.fn(), getDoc: vi.fn(), getDocs: vi.fn(), query: vi.fn(), orderBy: vi.fn() }));
const response = () => ({ hotelUid: "hotel-a", shoppingCartId: "cart", requestedDeliveryDate: "2026-11-02", cartRevision: 4,
  priceFingerprint: "approved-price", orders: [{ totalAmount: 36, currency: "EUR", products: [{ supplierProductId: "juice", pricePerPurchaseUnit: 18, priceValidity: "current" }] }] });
const preview = () => previewOrdersFromShoppingCart("hotel-a", "cart", "2026-11-02", 4);
beforeEach(() => { vi.clearAllMocks(); mocks.auth.currentUser = { uid: "buyer" }; mocks.callable.mockReturnValue(mocks.invoke); mocks.invoke.mockResolvedValue({ data: response() }); });

it("requests server-approved prices for the selected hotel, delivery date and reviewed cart revision", async () => {
  expect(await preview()).toEqual(response());
  expect(mocks.callable).toHaveBeenCalledWith({}, "previewOrdersFromCart");
  expect(mocks.invoke).toHaveBeenCalledWith({ hotelUid: "hotel-a", shoppingCartId: "cart", deliveryDate: "2026-11-02", expectedCartRevision: 4 });
});

it.each([
  (value) => { value.hotelUid = "hotel-b"; },
  (value) => { value.requestedDeliveryDate = "2026-10-31"; },
  (value) => { value.cartRevision = 3; },
  (value) => { value.priceFingerprint = ""; },
  (value) => { value.orders[0].products[0].pricePerPurchaseUnit = null; },
  (value) => { value.orders[0].products[0].priceValidity = "expired"; },
])("rejects an unverified or stale preview response", async (mutate) => {
  const result = response(); mutate(result); mocks.invoke.mockResolvedValue({ data: result });
  await expect(preview()).rejects.toThrow("could not be verified");
});

it("discards a late preview after the signed-in actor changes", async () => {
  let resolve; mocks.invoke.mockImplementation(() => new Promise((done) => { resolve = done; }));
  const pending = preview(); mocks.auth.currentUser = { uid: "other-buyer" }; resolve({ data: response() });
  await expect(pending).rejects.toThrow("sign-in changed");
});
