import { describe, it, expect } from "vitest";
import { countPackageQuantity } from "./countPackageQuantity";
const option = (amount = 6, unit = "l") => ({ catalogUnitsPerPackage: amount, baseUnit: unit });
describe("exact package counting", () => {
  it("counts two six-litre cases plus half a litre without changing costs", () => {
    expect(countPackageQuantity([{ option: option(), quantity: "2" }], "0.5", "l")).toEqual({ counted: true, quantity: 12.5, text: "12.5" });
  });
  it("combines different whole packages and loose six-decimal quantities exactly", () => {
    expect(countPackageQuantity([{ option: option(0.1), quantity: "3" }, { option: option(0.2), quantity: "2" }], "0.000001", "l")).toEqual({ counted: true, quantity: 0.700001, text: "0.700001" });
    expect(countPackageQuantity([{ option: option(0.000001, "kg"), quantity: "1000000" }], "0", "kg").text).toBe("1");
  });
  it("preserves untouched versus explicit zero and needs no package for loose stock", () => {
    expect(countPackageQuantity([{ option: null, quantity: "" }], "", "l")).toEqual({ counted: false, quantity: null, text: "" });
    expect(countPackageQuantity([], "0", "l")).toEqual({ counted: true, quantity: 0, text: "0" });
    expect(countPackageQuantity([{ option: option(), quantity: "0" }], "", "l")).toEqual({ counted: true, quantity: 0, text: "0" });
  });
  it("rejects unknown or wrong units and unavailable contents rather than inventing ratios", () => {
    for (const invalid of [null, option(null), option("6"), option(NaN), option(0), option(2, "kg")]) expect(() => countPackageQuantity([{ option: invalid, quantity: "1" }], "", "l")).toThrow();
    expect(() => countPackageQuantity([], "1", "litre")).toThrow("unit is unavailable");
  });
  it("rejects negative, overprecision, fractional full packages, exponents and totals beyond the canonical bound", () => {
    for (const value of ["-1", "0.0000001", "1e2", "1000001", "Infinity", " "]) expect(() => countPackageQuantity([], value, "l")).toThrow();
    expect(() => countPackageQuantity([{ option: option(), quantity: "0.5" }], "", "l")).toThrow("whole number");
    expect(() => countPackageQuantity([{ option: option(), quantity: "166667" }], "", "l")).toThrow("cannot exceed");
    expect(countPackageQuantity([{ option: option(1), quantity: "999999" }], "1", "l").text).toBe("1000000");
    expect(() => countPackageQuantity(Array.from({ length: 11 }, () => ({ option: option(), quantity: "" })), "0", "l")).toThrow("ten package entries");
  });
  it("is deterministic and preserves the exact sum independently of entry order", () => {
    const entries = [{ option: option(0.1), quantity: "1" }, { option: option(0.2), quantity: "1" }, { option: option(0.3), quantity: "1" }];
    expect(countPackageQuantity(entries, "0.4", "l").text).toBe("1");
    expect(countPackageQuantity(entries.toReversed(), "0.4", "l")).toEqual(countPackageQuantity(entries, "0.4", "l"));
  });
});
