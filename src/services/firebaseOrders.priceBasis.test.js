import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ getDoc: vi.fn() }));
vi.mock("../firebaseConfig", () => ({ db: {}, doc: (...parts) => parts.join("/"), getDoc: mocks.getDoc }));
import { getOrderById } from "./firebaseOrders";
beforeEach(() => vi.clearAllMocks());
it.each(["net", "gross", "unknown"])("preserves an explicit %s order basis without changing recorded amounts", async (priceBasis) => {
  mocks.getDoc.mockResolvedValue({ exists: () => true, id: "order", data: () => ({ priceBasis, totalAmount: 121, currency: "EUR", products: [{ pricePerPurchaseUnit: 121, priceBasis, vatRate: 0.21 }] }) });
  const order = await getOrderById("hotel", "order");
  expect(order.priceBasis).toBe(priceBasis); expect(order.totalAmount).toBe(121); expect(order.products[0].pricePerPurchaseUnit).toBe(121);
});
it.each([undefined, null, "", "net-price"])("keeps missing or unsupported historical basis %s unknown", async (priceBasis) => {
  mocks.getDoc.mockResolvedValue({ exists: () => true, id: "order", data: () => ({ priceBasis, totalAmount: 121, currency: "EUR" }) });
  expect((await getOrderById("hotel", "order")).priceBasis).toBe("unknown");
});
