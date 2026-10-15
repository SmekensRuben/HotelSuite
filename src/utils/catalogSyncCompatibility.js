const qualifierFields = ["form", "state", "organic", "gluten", "dairy", "lactose", "animalSource", "plantSource", "sugar", "colaVariant", "sweetener", "alcohol", "grade", "concentration", "fat", "allergens", "productKind", "bones", "carbonation", "flavour", "flavourKind"];
const stringList = (value) => Array.isArray(value) ? [...new Set(value.filter((item) => typeof item === "string").map((item) => item.slice(0, 100)))].slice(0, 30).sort() : [];
export function projectCatalogSyncPhysicalIdentity(value) {
  if (!value || !["mass", "volume", "count"].includes(value.dimension)) return null;
  const spec = value.eachSpec;
  return { dimension: value.dimension, brand: typeof value.brand === "string" ? value.brand.slice(0, 200) : null,
    qualifiers: Object.fromEntries(qualifierFields.map((field) => [field, stringList(value.qualifiers?.[field])])),
    eachSpec: spec && ["kg", "l", "g", "ml", "each"].includes(spec.unit) && ["mass", "volume", "count"].includes(spec.dimension) && typeof spec.quantity === "number" && Number.isFinite(spec.quantity) && spec.quantity > 0 ? { unit: spec.unit, quantity: spec.quantity, dimension: spec.dimension } : null,
    eachSpecUnknown: value.eachSpecUnknown === true, hasUnparsedNotes: value.hasUnparsedNotes === true };
}
/** Read-only cautions from server-established facts; unknown identity never becomes proof. */
export function previewCatalogSyncCompatibility(source, target) {
  const a = projectCatalogSyncPhysicalIdentity(source), b = projectCatalogSyncPhysicalIdentity(target);
  if (!a || !b) return { blocked: false, reasons: [], warnings: ["Some physical identity facts are not established. Verify quality, brand, allergens and the exact size of one counted item against the source."] };
  const reasons = [], warnings = [];
  if (a.dimension !== b.dimension) reasons.push("The physical dimensions differ; mass, volume and item counts cannot share this identity.");
  if (a.brand && b.brand && a.brand !== b.brand) reasons.push("The identified brands differ. Keep distinct brand requirements as separate catalog articles.");
  else if (!a.brand || !b.brand) warnings.push("One or both brands are unknown. Verify the intended brand requirement.");
  for (const field of qualifierFields) {
    const left = a.qualifiers[field], right = b.qualifiers[field];
    if (left.length && right.length && JSON.stringify(left) !== JSON.stringify(right)) reasons.push(`The declared ${field.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()} differs. Keep these physical articles separate.`);
    else if (Boolean(left.length) !== Boolean(right.length)) warnings.push(`The ${field.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()} is only established on one article. Verify it explicitly.`);
  }
  if (a.dimension === "count" || b.dimension === "count") {
    if (a.eachSpec && b.eachSpec && JSON.stringify(a.eachSpec) !== JSON.stringify(b.eachSpec)) reasons.push("One counted item has a different physical size or measure. Keep different bottle or item sizes separate.");
    else if (!a.eachSpec || !b.eachSpec || a.eachSpecUnknown || b.eachSpecUnknown) warnings.push("The physical specification of one counted item is incomplete. A supplier box quantity cannot prove that the items are interchangeable.");
  }
  if (a.hasUnparsedNotes || b.hasUnparsedNotes) warnings.push("Free-text notes contain additional details. Review them; they are not treated as proven physical specifications.");
  return { blocked: reasons.length > 0, reasons: [...new Set(reasons)], warnings: [...new Set(warnings)] };
}
