import { expect, it } from "vitest";
import { formatOrderMoney, formatOrderSubtotal } from "./orderPricing";
it("distinguishes historical missing prices from explicit free goods", () => {
  expect(formatOrderMoney(null, "EUR")).toBe("Unavailable");
  expect(formatOrderMoney(undefined, "EUR")).toBe("Unavailable");
  expect(formatOrderMoney("", "EUR")).toBe("Unavailable");
  expect(formatOrderMoney("12", "EUR")).toBe("Unavailable");
  expect(formatOrderMoney(0, "EUR")).toBe("0.00 EUR");
});
it("does not invent a currency or a subtotal for missing quantity", () => {
  expect(formatOrderMoney(12, null)).toBe("12.00 (currency unknown)");
  expect(formatOrderSubtotal(null, 2, "EUR")).toBe("Unavailable");
  expect(formatOrderSubtotal(12, null, "EUR")).toBe("Unavailable");
  expect(formatOrderSubtotal(12.5, 0.5, "USD")).toBe("6.25 USD");
  expect(formatOrderMoney(Infinity, "EUR")).toBe("Unavailable");
});

it("labels net, gross and unknown bases without applying tax a second time", async () => {
  const { formatOrderPriceBasis, normalizeOrderPriceBasis } = await import("./orderPricing");
  expect(formatOrderPriceBasis("net")).toBe("Net (excluding VAT)");
  expect(formatOrderPriceBasis("gross")).toBe("Gross (including VAT)");
  for (const value of [undefined, null, "", "Net", "unknown"]) {
    expect(normalizeOrderPriceBasis(value)).toBe("unknown");
    expect(formatOrderPriceBasis(value)).toBe("Unknown (VAT treatment unavailable)");
  }
  expect(formatOrderMoney(121, "EUR")).toBe("121.00 EUR");
  expect(formatOrderSubtotal(121, 3, "EUR")).toBe("363.00 EUR");
});
