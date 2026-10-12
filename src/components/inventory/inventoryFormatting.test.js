import { describe, expect, it } from "vitest";
import { formatInventoryUnitCost, formatInventoryValue, parseInventoryDecimal } from "./inventoryFormatting";
describe("quantity and cost display contracts", () => {
  it("keeps zero separate from unknown and unknown currency", () => {
    expect(formatInventoryValue(null, "EUR")).toBe("Unavailable");
    expect(formatInventoryValue(10, null)).toBe("Unavailable");
    expect(formatInventoryValue(0, "USD")).toContain("0.00");
  });
  it("does not present small positive per-gram costs as free", () => {
    expect(formatInventoryUnitCost(0.002333, "EUR")).toContain("0.002333");
    expect(formatInventoryUnitCost(0.0000001, "EUR")).toContain("<");
    expect(formatInventoryUnitCost(0, "EUR")).toContain("0.00");
  });
  it("accepts precise base quantities and rejects rounding or invalid values", () => {
    expect(parseInventoryDecimal("1.000001")).toBe(1.000001);
    expect(parseInventoryDecimal("", { optional: true })).toBeNull();
    expect(() => parseInventoryDecimal("0.1234567")).toThrow("six decimal");
    expect(() => parseInventoryDecimal("-1")).toThrow();
    expect(() => parseInventoryDecimal("1e3")).toThrow();
  });
});
