import { expect, it } from "vitest";
import { catalogLocationDraft, reviewCatalogDraft, resolveCatalogDraft } from "./stockCountDraftReview";

const item = (id) => ({ catalogProductId: id, catalogProductName: id, baseUnit: "each" });

it("keeps articles added by both counters without adding their quantities together", () => {
  const location = { stockTemplate: { items: [item("juice")] }, countedItems: [
    { ...item("juice"), quantity: 8, isCounted: true, unitCost: 2 },
    { ...item("water"), quantity: 5, isCounted: true, unitCost: null },
  ] };
  const review = reviewCatalogDraft(location, [item("juice"), item("tea")], {
    quantities: { juice: "3", tea: "0" }, costs: { juice: "1" },
  });
  expect(() => resolveCatalogDraft(location, review, {})).toThrow(/every changed article/);
  const resolved = resolveCatalogDraft(location, review, { juice: "mine" });
  expect(resolved.quantities).toEqual({ juice: "3", water: "5", tea: "0" });
  expect(resolved.costs).toEqual({ juice: "1", water: "", tea: "" });
  expect(resolved.additional.map((row) => row.catalogProductId).sort()).toEqual(["tea", "water"]);
});

it("distinguishes uncounted and unknown from explicit zero in recovery and review", () => {
  const location = { stockTemplate: { items: [item("juice")] }, countedItems: [
    { ...item("juice"), quantity: null, isCounted: false, unitCost: null },
  ] };
  expect(catalogLocationDraft(location)).toMatchObject({ quantities: { juice: "" }, costs: { juice: "" } });
  const review = reviewCatalogDraft(location, [item("juice")], { quantities: { juice: "0" }, costs: { juice: "0" } });
  expect(review[0].differs).toBe(true);
  expect(resolveCatalogDraft(location, review, { juice: "saved" })).toMatchObject({ quantities: { juice: "" }, costs: { juice: "" } });
});
