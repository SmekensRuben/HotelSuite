import { expect, it } from "vitest";
import { PURCHASE_UNITS, projectSupplierImportRow, projectSupplierImportWorkspace, projectReviewCounts, filterSupplierImportIndex } from "./supplierImportWorkspace";

const row = (index = 1) => ({ rowId: `r-${String(index).padStart(6, "0")}`, reviewRevision: 1, category: "new", product: { supplierProductName: "Butter 10g", purchaseUnit: "Box", baseUnit: "kg", baseUnitsPerPurchaseUnit: 1, pricePerPurchaseUnit: null, active: false }, canApprove: true, bulkEligible: false, issues: [], review: { status: "pending", reviewRevision: 1 }, sourceAnchors: [] });
const entry = (index = 1) => ({ rowId: row(index).rowId, reviewRevision: 1, category: "new", name: "Butter 10g", sku: "001", reviewStatus: "pending", needsAttention: true, bulkEligible: false });
const workspace = () => ({ hotelUid: "hotel-a", jobId: "job", supplierId: "supplier", status: "review", importReviewVersion: 1, totalRows: 250, counts: { new: 200, changed: 30, unchanged: 20, blocked: 0 }, reviewCounts: { pending: 220, approved: 10, skipped: 5, applied: 15, failed: 2 }, outcomeCounts: { created: 15, updated: 0, unchanged: 0 }, rows: Array.from({ length: 25 }, (_, index) => row(index + 1)), index: Array.from({ length: 250 }, (_, index) => entry(index + 1)), nextCursor: "r-000025", sourceFormat: "xlsx", profileId: "default" });
it("retains complete document totals while only 25 products are loaded", () => {
  const result = projectSupplierImportWorkspace(workspace()); expect(result.totalRows).toBe(250); expect(result.rows).toHaveLength(25); expect(result.index).toHaveLength(250); expect(result.counts.new).toBe(200); expect(result.reviewCounts.approved).toBe(10);
});
it("keeps missing or corrupt full counts/index unavailable instead of deriving totals from loaded rows", () => {
  const value = workspace(); value.index.pop(); value.counts.new = 25; value.reviewCounts.pending = 25;
  const result = projectSupplierImportWorkspace(value); expect(result.index).toBeNull(); expect(result.counts).toBeNull(); expect(result.reviewCounts).toBeNull();
  expect(projectReviewCounts(null, 250)).toBeNull();
});
it("projects customer business data and source evidence without forwarding operator fields", () => {
  const value = row(); value.providerCostUsd = 4; value.product.configuration = { model: "gpt-private" }; value.product.currency = "EUR"; value.product.pricePerPurchaseUnit = 12.5; value.product.purchaseOptions = [{ id: "option", purchaseUnit: "Box", pricePerPurchaseUnit: 12.5, providerCostUsd: 4 }];
  value.sourceAnchors = [{ sourceId: "s1", quote: "Purchase cost 12.50", sourceExcerpt: "<script>untrusted source</script>", verified: true, providerCostUsd: 5 }]; value.issues = [{ field: "pricePerPurchaseUnit", code: "missing-price", severity: "warning", message: "OpenAI token budget exceeded" }, { field: "usage", code: "provider", severity: "error", message: "secret" }];
  const result = projectSupplierImportRow(value); expect(result.product.pricePerPurchaseUnit).toBe(12.5); expect(result.sourceAnchors[0].sourceExcerpt).toContain("<script>"); expect(result.issues).toHaveLength(1); expect(JSON.stringify(result)).not.toMatch(/providerCostUsd|gpt-private|configuration|OpenAI|token budget|secret/);
});
it("preserves inferred 100 pieces as metadata without adding purchase options or changing mass", () => {
  const value = row(); value.packInference = { piecesPerPurchaseUnit: 100, pieceQuantity: 10, pieceUnit: "g", provenance: "inference", costUsd: 1 }; const result = projectSupplierImportRow(value);
  expect(result.packInference).toEqual({ piecesPerPurchaseUnit: 100, pieceQuantity: 10, pieceUnit: "g", provenance: "inference" }); expect(result.product.baseUnit).toBe("kg"); expect(result.product.baseUnitsPerPurchaseUnit).toBe(1); expect(result.product.purchaseOptions).toBeUndefined();
});
it("does not conflate unchanged proposals with explicit skipped decisions or applied unchanged outcomes", () => {
  const index = [{ ...entry(1), category: "unchanged", needsAttention: false }, { ...entry(2), category: "unchanged", reviewStatus: "skipped", needsAttention: false }, { ...entry(3), category: "unchanged", committedStatus: "unchanged", reviewStatus: "approved", needsAttention: false }];
  expect(filterSupplierImportIndex(index, "pending").map((item) => item.rowId)).toEqual([entry(1).rowId]); expect(filterSupplierImportIndex(index, "skipped").map((item) => item.rowId)).toEqual([entry(2).rowId]); expect(filterSupplierImportIndex(index, "applied").map((item) => item.rowId)).toEqual([entry(3).rowId]);
});
it("rejects duplicate references and unsupported workspace protocols instead of opening an unsafe draft", () => {
  expect(() => projectSupplierImportWorkspace({ ...workspace(), importReviewVersion: undefined })).toThrow(/workspace/); const value = workspace(); value.index[1] = value.index[0]; expect(() => projectSupplierImportWorkspace(value)).toThrow(/duplicate/);
});
it("supports package labels and measured kg without changing an explicit source content contract", () => {
  for (const unit of ["Bottle", "Bag", "Bucket", "Box", "Tray", "Jar", "Piece", "kg"]) expect(PURCHASE_UNITS).toContain(unit);
  const value = row(); value.product = { ...value.product, purchaseUnit: "kg", baseUnit: "g", baseUnitsPerPurchaseUnit: 1000 };
  value.purchaseUnitMapping = { sourceUnit: "KG", suggestedUnit: "kg", status: "known" };
  const projected = projectSupplierImportRow(value); expect(projected.product.baseUnit).toBe("g"); expect(projected.product.baseUnitsPerPurchaseUnit).toBe(1000);
  expect(projected.purchaseUnitMapping.suggestedUnit).toBe("kg");
});
it("keeps applied server receipt objects read-only and accepts the actual applied index status", () => {
  const value = row(); value.committed = { status: "created", productId: "product", revision: 1 }; value.canApprove = true; value.bulkEligible = true; const projected = projectSupplierImportRow(value); expect(projected.committed).toBe(true); expect(projected.canApprove).toBe(false); expect(projected.bulkEligible).toBe(false);
  const complete = workspace(); complete.index[0].reviewStatus = "applied"; complete.index[0].committedStatus = "created"; expect(projectSupplierImportWorkspace(complete).index[0].reviewStatus).toBe("applied");
});
