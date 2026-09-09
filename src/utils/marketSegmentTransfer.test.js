import { describe, expect, it } from "vitest";
import { createMarketSegmentsExport, parseMarketSegmentsImport } from "./marketSegmentTransfer";

describe("Market Segment transfer", () => {
  const segments = [{
    id: "ignored",
    title: "Leisure",
    prefixes: [{ prefix: "BAR", name: "Best Available Rate", description: "Public rates" }],
  }];

  it("exports and imports only supported Market Segment fields", () => {
    const result = parseMarketSegmentsImport(JSON.stringify(createMarketSegmentsExport(segments)));
    expect(result).toEqual([{ title: "Leisure", prefixes: segments[0].prefixes }]);
  });

  it("rejects incomplete prefix entries", () => {
    const exported = createMarketSegmentsExport([{ title: "Leisure", prefixes: [{ prefix: "BAR" }] }]);
    expect(() => parseMarketSegmentsImport(JSON.stringify(exported))).toThrow("not a valid Market Segments export");
  });
});
