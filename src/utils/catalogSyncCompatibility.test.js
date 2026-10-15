import { expect, it } from "vitest";
import { previewCatalogSyncCompatibility, projectCatalogSyncPhysicalIdentity } from "./catalogSyncCompatibility";
const identity = (patch = {}) => ({ dimension: "count", brand: "acme", qualifiers: { form: ["whole"], allergens: ["milk"] }, eachSpec: { quantity: 0.25, unit: "kg", dimension: "mass" }, ...patch });
it("blocks different physical dimensions and each item sizes even if package counts agree", () => {
  expect(previewCatalogSyncCompatibility(identity(), identity({ dimension: "mass" })).blocked).toBe(true);
  const result = previewCatalogSyncCompatibility(identity(), identity({ eachSpec: { quantity: 0.5, unit: "kg", dimension: "mass" } })); expect(result.blocked).toBe(true); expect(result.reasons.join(" ")).toContain("different physical size");
});
it("blocks known brand, allergen, quality and form conflicts from trusted parsed facts", () => {
  expect(previewCatalogSyncCompatibility(identity(), identity({ brand: "another" })).blocked).toBe(true);
  expect(previewCatalogSyncCompatibility(identity(), identity({ qualifiers: { form: ["grated"], allergens: ["soy"] } })).blocked).toBe(true);
  expect(previewCatalogSyncCompatibility(identity({ qualifiers: { carbonation: ["still"], flavourKind: ["plain"] } }), identity({ qualifiers: { carbonation: ["sparkling"], flavourKind: ["flavoured"] } })).blocked).toBe(true);
});
it("keeps unknown or incomplete identity visible for explicit human review rather than inventing proof", () => {
  const unknown = previewCatalogSyncCompatibility(null, identity()); expect(unknown.blocked).toBe(false); expect(unknown.warnings).toHaveLength(1);
  const each = previewCatalogSyncCompatibility(identity({ brand: null, eachSpec: null }), identity({ hasUnparsedNotes: true })); expect(each.blocked).toBe(false); expect(each.warnings.join(" ")).toContain("supplier box quantity cannot prove"); expect(each.warnings.join(" ")).toContain("Free-text notes");
});
it("projects known physical facts without exposing internal or arbitrary model fields", () => { const result = projectCatalogSyncPhysicalIdentity({ ...identity(), model: "secret", qualifiers: { form: ["whole"], arbitraryInternal: ["secret"] } }); expect(result.model).toBeUndefined(); expect(result.qualifiers.arbitraryInternal).toBeUndefined(); expect(result.eachSpec.quantity).toBe(0.25); });
