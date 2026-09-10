import { describe, expect, it } from "vitest";
import { getLocalIsoDate, parseLighthouseRows } from "./lighthouseImport";

const headers = [
  "Day", "Date", "My OTB", "Market demand", "Gent Marriott Hotel",
  "Pillows Grand\nBoutique Hotel\nReylof Ghent", "NH Collection Gent",
  "Yalo Urban\nBoutique Hotel\nGent", "1898 The Post & Porter's house", "Novotel Gent Centrum",
];

describe("parseLighthouseRows", () => {
  it("finds the Lighthouse header and maps only the requested columns", () => {
    const result = parseLighthouseRows([
      ["Lighthouse report"],
      headers,
      ["Thu", "10/09/2026", "89%", "93%", "239", "240", "239", "No flex", "No flex", "190"],
    ]);
    expect(result).toEqual([{ stayDate: "2026-09-10", data: {
      "My OTB": "89%",
      "Market demand": "93%",
      "Gent Marriott Hotel": "239",
      "Pillows Grand Boutique Hotel Reylof Ghent": "240",
      "NH Collection Gent": "239",
      "Yalo Urban Boutique Hotel Gent": "No flex",
      "Novotel Gent Centrum": "190",
    } }]);
  });

  it("rejects a sheet without all required headers", () => {
    expect(() => parseLighthouseRows([["Date", "My OTB"]])).toThrow("vereiste kolommen");
  });

  it("formats dates without UTC conversion", () => {
    expect(getLocalIsoDate(new Date(2026, 8, 10, 23, 30))).toBe("2026-09-10");
  });
});
