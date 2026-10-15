import { projectSupplierFormatCandidate, projectSupplierSourceInterpretation, validSupplierDate } from "./supplierImportFormat";
import { supplierAiImportCategoryCounts, supplierAiImportSummary } from "./supplierAiImportSummary";

import purchaseUnits from "../../functions/src/supplierPurchaseUnits.json";
export const PURCHASE_UNITS = Object.freeze(purchaseUnits);
export const SUPPLIER_IMPORT_FILTERS = ["all", "attention", "pending", "approved", "skipped", "applied", "price-change", "packaging-change", "new-article", "exception", "confirmation", "product-change", "unchanged"];
const id = (value) => typeof value === "string" && value.length > 0 && value.length <= 128 && value.trim() === value && !/[\\/\u0000-\u001f]/.test(value) && ![".", ".."].includes(value);
const count = (value, max = 1000) => Number.isSafeInteger(value) && value >= 0 && value <= max;
const text = (value, max = 2000) => typeof value === "string" && value.length <= max ? value : null;
const internal = /\b(?:openai|tokens?|budget|billing|reasoning|fallback|secret|api[-_\s]?key|bearer|gpt[-\s][a-z0-9][a-z0-9._-]*|AI[-_\s]?(?:model|cost|usage))\b|(?:CostUsd|CostMicros|reservedCost|sk-[a-z0-9])/i;
const fields = ["id", "supplierId", "supplierSku", "supplierProductName", "brand", "catalogProductId", "catalogProductName", "baseUnit", "purchaseUnit", "baseUnitsPerPurchaseUnit", "pricingModel", "pricePerPurchaseUnit", "pricePerBaseUnit", "priceBasis", "currency", "vatRate", "priceValidFrom", "priceValidUntil", "gtin", "active", "revision", "purchaseOptions"];
const findingFields = new Set([...fields, "price", "contract", "sourceAnchors", "packInference", "sourceInterpretation", "sourceFormat", "sourceIssuedOn", "assortmentMode", "documentPurpose"]);
const scalar = (value) => value === null || typeof value === "boolean" || typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
function projectProduct(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = Object.fromEntries(fields.filter((field) => field !== "purchaseOptions" && Object.hasOwn(value, field) && scalar(value[field])).map((field) => [field, value[field]]));
  if (Array.isArray(value.purchaseOptions)) result.purchaseOptions = value.purchaseOptions.slice(0, 20).map((option) => Object.fromEntries(["id", "purchaseUnit", "baseUnitsPerPurchaseUnit", "pricePerPurchaseUnit", "gtin"].filter((field) => Object.hasOwn(option || {}, field) && scalar(option[field])).map((field) => [field, option[field]])));
  return result;
}
function projectValue(field, value) {
  if (scalar(value)) return value;
  if (field === "purchaseOptions") return projectProduct({ purchaseOptions: value })?.purchaseOptions ?? null;
  if (field === "packInference") return projectInference(value);
  return null;
}
function projectInference(value) {
  if (!value || !count(value.piecesPerPurchaseUnit, 1000000) || value.piecesPerPurchaseUnit < 1 || typeof value.pieceQuantity !== "number" || !Number.isFinite(value.pieceQuantity) || value.pieceQuantity <= 0 || !["g", "kg", "ml", "l", "each"].includes(value.pieceUnit)) return null;
  return { piecesPerPurchaseUnit: value.piecesPerPurchaseUnit, pieceQuantity: value.pieceQuantity, pieceUnit: value.pieceUnit, provenance: text(value.provenance, 100) || "inference" };
}
function messages(value) {
  return (Array.isArray(value) ? value : []).slice(0, 100).filter((entry) => findingFields.has(entry?.field) && ["info", "warning", "error"].includes(entry.severity) && text(entry.code, 160) !== null && !internal.test(entry.code)).map((entry) => ({ field: entry.field, code: entry.code, severity: entry.severity, message: internal.test(entry.message || "") ? "Ask your hotel administrator to help verify this import check." : text(entry.message, 2000) || "Check this value against the source document.", ...(Object.hasOwn(entry, "before") ? { before: projectValue(entry.field, entry.before) } : {}), ...(Object.hasOwn(entry, "after") ? { after: projectValue(entry.field, entry.after) } : {}), ...(text(entry.provenance, 100) && !internal.test(entry.provenance) ? { provenance: entry.provenance } : {}) }));
}
const recurringCategories = ["price-change", "packaging-change", "new-article", "exception", "confirmation", "unchanged", "product-change"];
export function projectRecurringSupplierReview(value) {
  if (!value || !recurringCategories.includes(value.category)) return null;
  const comparison = value.physicalPriceComparison;
  const numeric = (item) => item === null || typeof item === "number" && Number.isFinite(item);
  const physical = comparison && numeric(comparison.before) && numeric(comparison.after) && numeric(comparison.percentChange)
    && [null, "kg", "l", "each"].includes(comparison.unit) && (comparison.currency === null || /^[A-Z]{3}$/.test(comparison.currency))
    ? { before: comparison.before, after: comparison.after, unit: comparison.unit, currency: comparison.currency, comparable: comparison.comparable === true,
      percentChange: comparison.percentChange, reason: text(comparison.reason, 500) } : null;
  return { category: value.category, physicalPriceComparison: physical, sourceIssuedOn: validSupplierDate(value.sourceIssuedOn) ? value.sourceIssuedOn : null,
    confirmsUnitPrice: value.confirmsUnitPrice === true, formatStatus: ["confirmed", "review-required", "unconfirmed"].includes(value.formatStatus) ? value.formatStatus : "unconfirmed",
    assortmentMode: ["full", "partial", "unknown"].includes(value.assortmentMode) ? value.assortmentMode : "unknown",
    comparisonBasis: value.comparisonBasis === "approved-period" ? "approved-period" : "current", comparedPriceVersionId: id(value.comparedPriceVersionId) ? value.comparedPriceVersionId : null };
}
export function projectSupplierImportRow(value) {
  if (!value || !id(value.rowId) || !Number.isSafeInteger(value.reviewRevision) || value.reviewRevision < 1 || !["new", "changed", "unchanged", "blocked"].includes(value.category)) throw new Error("The product review could not be verified. Refresh the import.");
  const committed = value.committed === true || Boolean(value.committed && ["created", "updated", "unchanged"].includes(value.committed.status));
  const result = { rowId: value.rowId, reviewRevision: value.reviewRevision, category: value.category, product: projectProduct(value.product), previousProduct: projectProduct(value.previousProduct), issues: messages(value.issues), normalizationFindings: messages(value.normalizationFindings), changes: (Array.isArray(value.changes) ? value.changes : []).slice(0, 50).filter((change) => findingFields.has(change?.field)).map((change) => ({ field: change.field, before: projectValue(change.field, change.before), after: projectValue(change.field, change.after) })), sourceAnchors: (Array.isArray(value.sourceAnchors) ? value.sourceAnchors : []).slice(0, 25).map((source) => ({ ...(id(source.sourceId) ? { sourceId: source.sourceId } : {}), anchor: text(source.anchor, 500), quote: text(source.quote, 10000), sourceExcerpt: text(source.sourceExcerpt, 16000), verified: source.verified === true, excerptTruncated: source.excerptTruncated === true })), originalInput: projectProduct(value.originalInput), packInference: projectInference(value.packInference), committed, canApprove: !committed && value.canApprove === true, bulkEligible: !committed && value.bulkEligible === true };
  if (value.review && ["pending", "approved", "skipped"].includes(value.review.status)) result.review = { status: value.review.status, reviewRevision: Number.isSafeInteger(value.review.reviewRevision) ? value.review.reviewRevision : value.reviewRevision };
  if (value.lastOutcome && ["created", "updated", "unchanged", "blocked"].includes(value.lastOutcome.status)) result.lastOutcome = { status: value.lastOutcome.status, ...(value.lastOutcome.error ? { error: { code: text(value.lastOutcome.error.code, 80) && !internal.test(value.lastOutcome.error.code) ? value.lastOutcome.error.code : "unavailable", message: text(value.lastOutcome.error.message, 2000) && !internal.test(value.lastOutcome.error.message) ? value.lastOutcome.error.message : "This product could not be applied. Check its current values and revalidate corrections." } } : {}) };
  if (value.purchaseUnitMapping && text(value.purchaseUnitMapping.sourceUnit, 100)) result.purchaseUnitMapping = { sourceUnit: value.purchaseUnitMapping.sourceUnit, suggestedUnit: PURCHASE_UNITS.includes(value.purchaseUnitMapping.suggestedUnit) ? value.purchaseUnitMapping.suggestedUnit : null, status: ["confirmed", "unconfirmed", "known"].includes(value.purchaseUnitMapping.status) ? value.purchaseUnitMapping.status : "unconfirmed" };
  result.recurringReview = projectRecurringSupplierReview(value.recurringReview);
  result.previousPriceAgreement = value.previousPriceAgreement && id(value.previousPriceAgreement.versionId)
    ? { versionId: value.previousPriceAgreement.versionId, product: projectProduct(value.previousPriceAgreement.product) } : null;
  result.sourceInterpretation = projectSupplierSourceInterpretation(value.sourceInterpretation);
  return result;
}
const reviewKeys = ["pending", "approved", "skipped", "applied", "failed"];
export function projectReviewCounts(value, totalRows = 1000) {
  if (!value || reviewKeys.some((key) => !count(value[key], totalRows))) return null;
  // Failed attempts can overlap pending rows; the four states are exclusive.
  if (reviewKeys.slice(0, 4).reduce((sum, key) => sum + value[key], 0) !== totalRows) return null;
  return Object.fromEntries(reviewKeys.map((key) => [key, value[key]]));
}
export function projectSupplierImportWorkspace(value) {
  if (!value || !id(value.hotelUid) || !id(value.jobId) || !id(value.supplierId) || !count(value.totalRows) || value.importReviewVersion !== 1 || !Array.isArray(value.rows) || value.rows.length > 25) throw new Error("The import workspace could not be verified. Refresh after the service update finishes.");
  const rows = value.rows.map(projectSupplierImportRow);
  if (new Set(rows.map((row) => row.rowId)).size !== rows.length) throw new Error("The import contains duplicate review references.");
  const result = { hotelUid: value.hotelUid, jobId: value.jobId, supplierId: value.supplierId, importReviewVersion: 1, status: text(value.status, 80), totalRows: value.totalRows, counts: supplierAiImportCategoryCounts(value.counts, value.totalRows), reviewCounts: projectReviewCounts(value.reviewCounts, value.totalRows), outcomeCounts: value.outcomeCounts && ["created", "updated", "unchanged"].every((key) => count(value.outcomeCounts[key], value.totalRows)) ? Object.fromEntries(["created", "updated", "unchanged"].map((key) => [key, value.outcomeCounts[key]])) : null, rows, summary: supplierAiImportSummary(value.summary, { totalRows: value.totalRows }), sourceFormat: ["csv", "xlsx", "pdf", "docx", "eml", "txt"].includes(value.sourceFormat) ? value.sourceFormat : null, profileId: id(value.profileId) ? value.profileId : "default", nextCursor: value.nextCursor == null ? null : id(value.nextCursor) ? value.nextCursor : undefined, index: null, mappingGroups: [] };
  if (result.nextCursor === undefined) throw new Error("The import pagination could not be verified.");
  if (Array.isArray(value.index) && value.index.length === value.totalRows) {
    result.index = value.index.map((entry) => {
      if (!id(entry.rowId) || !Number.isSafeInteger(entry.reviewRevision) || entry.reviewRevision < 1 || !["new", "changed", "unchanged", "blocked"].includes(entry.category) || !["pending", "approved", "skipped", "applied"].includes(entry.reviewStatus)) throw new Error("The complete product index could not be verified.");
      return { rowId: entry.rowId, reviewRevision: entry.reviewRevision, category: entry.category, requiresUpdate: typeof entry.requiresUpdate === "boolean" ? entry.requiresUpdate : ["changed", "unchanged"].includes(entry.category), name: text(entry.name, 1000) || "Product name missing", sku: text(entry.sku, 200) || "", reviewStatus: entry.reviewStatus, committedStatus: ["created", "updated", "unchanged", "blocked"].includes(entry.committedStatus) ? entry.committedStatus : null, needsAttention: entry.needsAttention === true, bulkEligible: entry.bulkEligible === true, recurringReview: projectRecurringSupplierReview(entry.recurringReview) };
    });
    if (new Set(result.index.map((row) => row.rowId)).size !== result.index.length) throw new Error("The complete product index contains duplicate references.");
  }
  result.mappingGroups = (Array.isArray(value.mappingGroups) ? value.mappingGroups : []).slice(0, 100).filter((group) => text(group.sourceUnit, 100) && count(group.count, value.totalRows) && group.count > 0 && Array.isArray(group.rowIds) && group.rowIds.length <= 1000 && group.rowIds.every((row) => id(row.rowId) && Number.isSafeInteger(row.reviewRevision) && row.reviewRevision >= 1)).map((group) => ({ sourceUnit: group.sourceUnit, suggestedUnit: PURCHASE_UNITS.includes(group.suggestedUnit) ? group.suggestedUnit : null, purchaseUnit: PURCHASE_UNITS.includes(group.purchaseUnit) ? group.purchaseUnit : null, status: ["unmapped", "mapped", "conflict"].includes(group.status) ? group.status : "unmapped", count: group.count, rowIds: group.rowIds.map((row) => ({ rowId: row.rowId, reviewRevision: row.reviewRevision })) }));
  const application = value.formatApplication;
  result.formatApplication = application && id(application.operationId) && id(application.requestId) && typeof application.complete === "boolean"
    && count(application.totalRows) && count(application.processed, application.totalRows) && Number.isSafeInteger(application.profileRevision) && application.profileRevision >= 1
    ? { operationId: application.operationId, requestId: application.requestId, complete: application.complete, processed: application.processed, totalRows: application.totalRows, profileRevision: application.profileRevision } : null;
  if (application && !result.formatApplication) throw new Error("The saved format application could not be verified. Reopen the original import before making changes.");
  const assortment = value.assortmentSummary;
  result.assortmentSummary = assortment && ["full", "partial", "unknown"].includes(assortment.mode) && assortment.policy === "preserve-existing"
    && (assortment.missingOfferCount === null || count(assortment.missingOfferCount, 10000)) && Array.isArray(assortment.missingOffers)
    ? { mode: assortment.mode, policy: "preserve-existing", missingOfferCount: assortment.missingOfferCount, complete: assortment.complete === true,
      missingOffers: assortment.missingOffers.slice(0, 20).filter((offer) => id(offer.productId)).map((offer) => ({ productId: offer.productId, supplierSku: text(offer.supplierSku, 200), supplierProductName: text(offer.supplierProductName, 200) })) } : null;
  result.sourceFormatCandidate = projectSupplierFormatCandidate(value.sourceFormatCandidate);
  result.sourceInterpretation = projectSupplierSourceInterpretation(value.sourceInterpretation);
  result.mappingGroupsTruncated = value.mappingGroupsTruncated === true;
  return result;
}
export function filterSupplierImportIndex(index = [], filter = "all", search = "") {
  const needle = search.trim().toLowerCase();
  return index.filter((row) => (!needle || `${row.name} ${row.sku}`.toLowerCase().includes(needle)) && (filter === "all" || (recurringCategories.includes(filter) ? row.recurringReview?.category === filter : filter === "attention" ? row.needsAttention : filter === "applied" ? ["created", "updated", "unchanged"].includes(row.committedStatus) : !["created", "updated", "unchanged"].includes(row.committedStatus) && row.reviewStatus === filter)));
}
