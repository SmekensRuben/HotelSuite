import { describe, expect, it } from "vitest";
import { deriveExplicitQuoteMealBasis, getMealBasisDataQualityWarnings, GROUP_QUOTE_INPUT_SCHEMA_VERSION } from "./groupMealBasis";

describe("explicit group meal basis", () => {
  it("derives product identity independently of breakfast quantity", () => {
    expect(deriveExplicitQuoteMealBasis([{ mealBasis: "BB", breakfastPax: 20, rooms: 50 }])).toBe("BB");
    expect(deriveExplicitQuoteMealBasis([{ mealBasis: "RO", breakfastPax: 20, rooms: 50 }])).toBe("RO");
    expect(deriveExplicitQuoteMealBasis([{ mealBasis: "BB", breakfastPax: 50 }, { mealBasis: "RO", breakfastPax: 0 }])).toBe("MIXED");
  });

  it("does not fabricate a product for old rows and versions new input semantics", () => {
    expect(deriveExplicitQuoteMealBasis([{ breakfastPax: 20 }])).toBe("LEGACY_UNKNOWN");
    expect(GROUP_QUOTE_INPUT_SCHEMA_VERSION).toBe("group-quote-v3-meal-basis");
  });

  it("reports unusual combinations without mutating them", () => {
    const rows = [{ date: "a", mealBasis: "BB", breakfastPax: 0 }, { date: "b", mealBasis: "RO", breakfastPax: 20 }];
    expect(getMealBasisDataQualityWarnings(rows).map((warning) => warning.code)).toEqual(["BB_WITH_ZERO_BREAKFAST_PAX", "RO_WITH_BREAKFAST_PAX"]);
    expect(rows).toEqual([{ date: "a", mealBasis: "BB", breakfastPax: 0 }, { date: "b", mealBasis: "RO", breakfastPax: 20 }]);
  });
});
