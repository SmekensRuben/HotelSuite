import { projectCatalogSyncPhysicalIdentity } from "./catalogSyncCompatibility";
const id = (value) => typeof value === "string" && value.length > 0 && value.length <= 128 && value.trim() === value && !/[\\/\u0000-\u001f]/.test(value) && ![".", ".."].includes(value);
const text = (value, max = 4000) => typeof value === "string" ? value.slice(0, max) : "";
const revision = (value) => Number.isSafeInteger(value) && value >= 0;
const units = new Set(["g", "kg", "ml", "l", "each"]);
const internal = /\b(?:openai|tokens?|budget|billing|secret|api[-_\s]?key|bearer|gpt[-\s][a-z0-9]|AI[-_\s]?(?:model|cost|usage))\b|(?:sk-[a-z0-9])/i;
export const catalogSyncId = id;
export const catalogSyncRevision = revision;
export const catalogSyncMessage = (value) => typeof value === "string" && !internal.test(value) ? text(value, 2000) : "This proposal could not be verified. Ask your hotel administrator for help.";
const list = (value) => (Array.isArray(value) ? value : []).slice(0, 30).map((item) => catalogSyncMessage(typeof item === "string" ? item : item?.message));
const productFields = ["name", "brand", "description", "category", "subcategory", "gtin", "internalSku", "storageType", "notes", "imageUrl"];
export function catalogSyncProduct(value = {}) {
  return { ...Object.fromEntries(productFields.map((field) => [field, text(value[field])])), active: value.active !== false, inventoryTracked: value.inventoryTracked === true, baseUnit: units.has(value.baseUnit) ? value.baseUnit : "", baseQtyPerUnit: typeof value.baseQtyPerUnit === "number" && Number.isFinite(value.baseQtyPerUnit) && value.baseQtyPerUnit > 0 ? value.baseQtyPerUnit : null, allergens: (Array.isArray(value.allergens) ? value.allergens : []).slice(0, 30).filter((item) => typeof item === "string").map((item) => text(item, 100)) };
}
const eachSpec = (value) => value && units.has(value.unit) && typeof value.quantity === "number" && Number.isFinite(value.quantity) && value.quantity > 0 && ["mass", "volume", "count"].includes(value.dimension) ? { unit: value.unit, quantity: value.quantity, dimension: value.dimension } : null;
function evidence(value = {}) {
  const qualifiers = (input = {}) => Object.fromEntries(["form", "state", "organic", "gluten", "dairy", "lactose", "animalSource", "plantSource", "sugar", "colaVariant", "sweetener", "alcohol", "grade", "concentration", "fat", "allergens", "productKind", "bones", "carbonation", "flavour", "flavourKind"].filter((field) => Array.isArray(input[field])).map((field) => [field, list(input[field])]));
  return { sourceBrand: text(value.sourceBrand, 200), catalogBrand: text(value.catalogBrand, 200), unitDimension: ["mass", "volume", "count"].includes(value.unitDimension) ? value.unitDimension : null, sourceQualifiers: qualifiers(value.sourceQualifiers), catalogQualifiers: qualifiers(value.catalogQualifiers), sourceEachSpec: eachSpec(value.sourceEachSpec), catalogEachSpec: eachSpec(value.catalogEachSpec) };
}
export function projectCatalogSyncRow(value) {
  if (!id(value?.rowId) || !id(value.supplierProductId) || !revision(value.expectedSupplierRevision) || !revision(value.reviewRevision) || value.reviewRevision < 1 || !value.supplierProduct || !Array.isArray(value.existingMatches)) throw new Error("The catalog proposal could not be verified. Start a fresh review.");
  const source = value.supplierProduct;
  const physical = (option) => ({ id: id(option.id) ? option.id : "default", purchaseUnit: text(option.purchaseUnit, 100), baseUnitsPerPurchaseUnit: typeof option.baseUnitsPerPurchaseUnit === "number" && Number.isFinite(option.baseUnitsPerPurchaseUnit) && option.baseUnitsPerPurchaseUnit > 0 ? option.baseUnitsPerPurchaseUnit : null, gtin: text(option.gtin, 100) });
  const result = { rowId: value.rowId, supplierProductId: value.supplierProductId, expectedSupplierRevision: value.expectedSupplierRevision, reviewRevision: value.reviewRevision, status: text(value.status, 100), groupKey: id(value.groupKey) ? value.groupKey : value.rowId, supplierProduct: { supplierId: id(source.supplierId) ? source.supplierId : null, supplierSku: text(source.supplierSku, 200), supplierProductName: text(source.supplierProductName, 1000), baseUnit: units.has(source.baseUnit) ? source.baseUnit : "", sourceEachSpec: eachSpec(source.sourceEachSpec), physicalIdentity: projectCatalogSyncPhysicalIdentity(source.physicalIdentity), ...physical(source), brand: text(source.brand, 200), category: text(source.category, 100), allergens: Array.isArray(source.allergens) ? source.allergens.filter((item) => typeof item === "string").slice(0, 30) : null, purchaseOptions: (Array.isArray(source.purchaseOptions) ? source.purchaseOptions : []).slice(0, 20).map(physical) }, warnings: list(value.warnings), existingMatches: value.existingMatches.slice(0, 10).map((match) => {
    if (!id(match.catalogProductId) || !revision(match.expectedCatalogRevision)) throw new Error("An existing catalog suggestion could not be verified.");
    return { catalogProductId: match.catalogProductId, expectedCatalogRevision: match.expectedCatalogRevision, product: { ...catalogSyncProduct(match.product), physicalIdentity: projectCatalogSyncPhysicalIdentity(match.product.physicalIdentity) }, status: text(match.status, 100), matchKind: text(match.matchKind, 100), score: typeof match.score === "number" && Number.isFinite(match.score) ? match.score : null, reasons: list(match.reasons), warnings: list(match.warnings), evidence: evidence(match.evidence) };
  }), proposedNewProduct: catalogSyncProduct(value.proposedNewProduct), applied: null };
  if (value.applied) { if (!id(value.applied.catalogProductId) || !revision(value.applied.supplierRevision) || !["linked", "created-and-linked"].includes(value.applied.status)) throw new Error("The applied catalog result could not be verified."); result.applied = { catalogProductId: value.applied.catalogProductId, supplierRevision: value.applied.supplierRevision, status: value.applied.status }; }
  if (value.aiSuggestion) result.aiSuggestion = { catalogProductId: id(value.aiSuggestion.catalogProductId) ? value.aiSuggestion.catalogProductId : null, reason: catalogSyncMessage(value.aiSuggestion.reason), specificDifferences: list(value.aiSuggestion.specificDifferences) };
  return result;
}
export function projectCatalogSyncWorkspace(value, hotelUid) {
  if (value?.hotelUid !== hotelUid || !id(value.jobId) || !revision(value.revision) || !["review", "completed"].includes(value.status) || !Array.isArray(value.rows) || value.rows.length > 25 || (value.nextCursor != null && !id(value.nextCursor))) throw new Error("The catalog sync workspace could not be verified.");
  const rows = value.rows.map(projectCatalogSyncRow);
  if (new Set(rows.map((row) => row.rowId)).size !== rows.length) throw new Error("Catalog proposals contain duplicate references.");
  return { hotelUid, jobId: value.jobId, revision: value.revision, status: value.status, supplierId: id(value.supplierId) ? value.supplierId : null, rows, nextCursor: value.nextCursor || null, scannedSuppliers: Number.isSafeInteger(value.scannedSuppliers) && value.scannedSuppliers >= 0 && value.scannedSuppliers <= 250 ? value.scannedSuppliers : null, catalogPool: { count: Number.isSafeInteger(value.catalogPool?.count) && value.catalogPool.count >= 0 ? value.catalogPool.count : null, complete: value.catalogPool?.complete === true, limit: Number.isSafeInteger(value.catalogPool?.limit) ? value.catalogPool.limit : 500 } };
}
export function catalogSyncChoices(value) {
  if (!Array.isArray(value) || !value.length || value.length > 25) throw new Error("Review between 1 and 25 supplier offers before applying.");
  const choices = value.map((choice) => {
    if (!id(choice.rowId) || !revision(choice.expectedSupplierRevision) || !revision(choice.reviewRevision) || choice.reviewRevision < 1 || choice.acknowledged !== true) throw new Error("Each choice needs its reviewed revision and explicit exchangeability confirmation.");
    let target;
    if (choice.target?.kind === "existing" && id(choice.target.catalogProductId) && revision(choice.target.expectedCatalogRevision)) target = { kind: "existing", catalogProductId: choice.target.catalogProductId, expectedCatalogRevision: choice.target.expectedCatalogRevision };
    else if (choice.target?.kind === "new" && id(choice.target.createGroupId)) { const raw = choice.target.product; if (!raw || !Array.isArray(raw.allergens ?? []) || (raw.allergens ?? []).length > 30 || (raw.allergens ?? []).some((allergen) => typeof allergen !== "string" || allergen.length > 100)) throw new Error("Use at most 30 explicit allergen labels, each at most 100 characters."); const product = catalogSyncProduct(raw); if (!product.name.trim() || !units.has(product.baseUnit)) throw new Error("Enter a name and supported physical unit for a new catalog article."); target = { kind: "new", createGroupId: choice.target.createGroupId, product }; }
    else throw new Error("Choose an existing catalog article or a reviewed new article.");
    return { rowId: choice.rowId, reviewRevision: choice.reviewRevision, expectedSupplierRevision: choice.expectedSupplierRevision, target, acknowledged: true };
  });
  if (new Set(choices.map((choice) => choice.rowId)).size !== choices.length) throw new Error("Each supplier offer can appear only once in an apply request.");
  return choices;
}
