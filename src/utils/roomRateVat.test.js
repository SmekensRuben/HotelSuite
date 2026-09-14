import { describe, expect, it } from "vitest";
import { RATE_BASIS, normalizeRoomVatPercentage, toRoomRateExVat, toRoomRateInclVat } from "./roomRateVat";

describe("room-rate VAT normalization", () => {
  it("converts 100 excluding VAT to 112 including VAT", () => expect(toRoomRateInclVat(100, 12)).toBeCloseTo(112, 12));
  it("converts 112 including VAT to 100 excluding VAT", () => expect(toRoomRateExVat(112, 12)).toBeCloseTo(100, 12));
  it("does not round intermediate floor values", () => expect(toRoomRateInclVat(164.65, 12)).toBeCloseTo(184.408, 12));
  it("supports UI rounding only at presentation", () => expect(toRoomRateInclVat(164.65, 12).toFixed(2)).toBe("184.41"));
  it("supports zero VAT", () => expect(toRoomRateInclVat(99.123, 0)).toBe(99.123));
  it("rejects missing, negative, and invalid VAT", () => {
    expect(() => normalizeRoomVatPercentage()).toThrow(/required/);
    expect(() => normalizeRoomVatPercentage(-1)).toThrow(/zero or greater/);
    expect(() => normalizeRoomVatPercentage("bad")).toThrow(/zero or greater/);
  });
  it("defines explicit bases for future external-rate normalization", () => expect(RATE_BASIS).toEqual({ EXCL_VAT: "EXCL_VAT", INCL_VAT: "INCL_VAT" }));
});
