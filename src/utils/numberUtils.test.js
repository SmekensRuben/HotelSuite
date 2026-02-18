import { describe, expect, it } from "vitest";
import { parseLocalizedNumber } from "./numberUtils";

describe("parseLocalizedNumber", () => {
  it("parses numbers with dot decimal", () => {
    expect(parseLocalizedNumber("54.34")).toBe(54.34);
  });

  it("parses numbers with comma decimal", () => {
    expect(parseLocalizedNumber("54,34")).toBe(54.34);
  });

  it("parses numbers with thousand separators", () => {
    expect(parseLocalizedNumber("1.234,56")).toBe(1234.56);
  });

  it("returns NaN for non-numeric strings", () => {
    expect(Number.isNaN(parseLocalizedNumber("abc"))).toBe(true);
  });
});
