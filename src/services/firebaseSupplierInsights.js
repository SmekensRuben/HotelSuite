import { functions, httpsCallable } from "../firebaseConfig";
import { poolProcurementRead } from "./procurementReadPool";

const documentId = (value) => typeof value === "string" && value.length > 0 && value.length <= 1500 && !value.includes("/") && ![".", ".."].includes(value);
const nullableString = (value) => value === null || typeof value === "string";
const nullableNumber = (value) => value === null || typeof value === "number" && Number.isFinite(value) && value >= 0;
const nullableDate = (value) => value === null || typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T12:00:00Z`)) && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
const validTimeZone = (value) => { try { if (typeof value !== "string" || !value || value.length > 80) return false; new Intl.DateTimeFormat("en", { timeZone: value }).format(0); return true; } catch { return false; } };
function expectedValidity(product, assessmentDate) {
  const from = product.contractualValidFrom, until = product.contractualValidUntil;
  if (from === null && until === null) return "unknown";
  if (from && until && from > until) return "invalid";
  if (!assessmentDate) return "unavailable";
  if (from && assessmentDate < from) return "future";
  if (until && assessmentDate > until) return "expired";
  return "current";
}
function validateOptions(options) {
  if (!Array.isArray(options) || options.length > 21) throw new Error("Supplier price options are invalid.");
  for (const option of options) {
    if (!nullableString(option?.id) || !nullableString(option.purchaseUnit) || typeof option.available !== "boolean"
      || !nullableString(option.reason) || !nullableNumber(option.baseUnitsPerPurchaseUnit) || !nullableNumber(option.pricePerPurchaseUnit)
      || !nullableNumber(option.catalogUnitsPerPurchaseUnit) || !nullableNumber(option.netPricePerPurchaseUnit) || !nullableNumber(option.netPricePerCatalogUnit)
      || option.available && (option.catalogUnitsPerPurchaseUnit <= 0 || option.netPricePerPurchaseUnit === null || option.netPricePerCatalogUnit === null)) {
      throw new Error("Supplier price option response is invalid.");
    }
  }
}
const validityStates = new Set(["current", "unknown", "future", "expired", "unavailable", "invalid"]);
function validateReliability(value) {
  if (value === undefined || value === null) return;
  if (!value || typeof value !== "object" || typeof value.needsReview !== "boolean" || typeof value.hasScheduledVersions !== "boolean"
    || !validityStates.has(value.priceValidity) || !["order-date", "delivery-date"].includes(value.pricingDateBasis)
    || typeof value.pricingAgreementKnown !== "boolean" || !Array.isArray(value.reasons) || value.reasons.length > 25
    || value.reasons.some((reason) => typeof reason !== "string" || reason.length > 160)
    || !nullableString(value.currentVersionId) || !nullableString(value.lastPriceChangeAt) || !nullableString(value.lastPriceConfirmedAt)
    || !nullableString(value.sourceReference) || !nullableDate(value.sourceIssuedOn) || !nullableDate(value.latestSourceIssuedOn)) throw new Error("Supplier price reliability response is invalid.");
}
function validateVersions(versions, assessmentDate) {
  if (versions === undefined) return;
  if (!Array.isArray(versions) || versions.length > 100 || new Set(versions.map((version) => version?.id)).size !== versions.length) throw new Error("Approved supplier price versions are invalid.");
  for (const version of versions) {
    if (!documentId(version?.id) || !Number.isSafeInteger(version.revision) || version.revision < 0
      || !nullableString(version.approvedAt) || !nullableString(version.sourceReference) || !nullableDate(version.sourceIssuedOn)
      || !nullableString(version.currency) || !nullableString(version.catalogBaseUnit)
      || !nullableDate(version.contractualValidFrom) || !nullableDate(version.contractualValidUntil)
      || !validityStates.has(version.priceValidity) || version.priceValidity !== expectedValidity(version, assessmentDate)) throw new Error("Approved supplier price period could not be verified.");
    validateOptions(version.options);
  }
}
async function load(hotelUid, payload, options) {
  if (!documentId(hotelUid)) throw new Error("hotelUid is required.");
  const pageSize = options.pageSize ?? 25;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 50) throw new Error("Choose a supplier insight page size between 1 and 50.");
  return poolProcurementRead(hotelUid, `supplier-insights:${JSON.stringify({ ...payload, pageSize })}`, async () => {
    const { data } = await httpsCallable(functions, "getHotelSupplierPriceInsights")({ hotelUid, ...payload, pageSize });
    if (data?.hotelUid !== hotelUid || data.mode !== payload.mode || data.policyVersion !== 1) throw new Error("Supplier insight response scope is invalid.");
    if (payload.mode === "comparison") {
      if (data.catalog?.id !== payload.catalogProductId || !nullableString(data.catalog.baseUnit) || !Array.isArray(data.products) || data.products.length > pageSize
        || !nullableString(data.nextProductId) || new Set(data.products.map((product) => product.id)).size !== data.products.length
        || !nullableDate(data.assessmentDate) || (data.timeZone !== null && !validTimeZone(data.timeZone))
        || (data.assessmentDate === null) !== (data.timeZone === null)) throw new Error("Supplier comparison response is invalid.");
      for (const product of data.products) {
        if (!documentId(product.id) || typeof product.active !== "boolean" || !nullableString(product.currency)
          || !["current", "unknown", "future", "expired", "unavailable", "invalid"].includes(product.priceValidity)
          || !nullableDate(product.contractualValidFrom) || !nullableDate(product.contractualValidUntil)
          || product.priceValidity === "unknown" && (product.contractualValidFrom !== null || product.contractualValidUntil !== null)
          || product.priceValidity === "current" && (!data.assessmentDate || product.contractualValidFrom === null && product.contractualValidUntil === null)
          || product.priceValidity !== "invalid" && product.priceValidity !== expectedValidity(product, data.assessmentDate)) throw new Error("Supplier comparison record is invalid.");
        validateOptions(product.options);
        validateReliability(product.reliability);
      }
      if (data.nextProductId !== null && data.nextProductId !== data.products.at(-1)?.id) throw new Error("Supplier comparison cursor is invalid.");
    } else {
      if (data.supplierProductId !== payload.supplierProductId || !Array.isArray(data.entries) || data.entries.length > pageSize
        || !nullableNumber(data.nextRevision)) throw new Error("Supplier history response is invalid.");
      let prior = payload.beforeRevision ?? Infinity;
      for (const entry of data.entries) {
        if (!Number.isSafeInteger(entry.revision) || entry.revision < 1 || entry.revision >= prior
          || !nullableString(entry.currency) || !nullableString(entry.catalogBaseUnit) || !nullableString(entry.observedAt)
          || !nullableDate(entry.contractualValidFrom) || !nullableDate(entry.contractualValidUntil)) throw new Error("Supplier history order or terms are invalid.");
        prior = entry.revision;
        validateOptions(entry.options);
        if (entry.previous) {
          if (!nullableDate(entry.previous.contractualValidFrom) || !nullableDate(entry.previous.contractualValidUntil)) throw new Error("Previous supplier contract dates are invalid.");
          validateOptions(entry.previous.options);
        }
      }
      if (data.nextRevision !== null && data.nextRevision !== data.entries.at(-1)?.revision) throw new Error("Supplier history cursor is invalid.");
      validateReliability(data.reliability);
      validateVersions(data.versions, data.assessmentDate);
    }
    return data;
  }, options.scopeKey);
}

export function getSupplierPriceComparison(hotelUid, catalogProductId, options = {}) {
  if (!documentId(catalogProductId)) throw new Error("catalogProductId is required.");
  if (options.afterProductId != null && !documentId(options.afterProductId)) throw new Error("Invalid supplier comparison cursor.");
  return load(hotelUid, { mode: "comparison", catalogProductId, ...(options.afterProductId ? { afterProductId: options.afterProductId } : {}) }, options);
}

export function getSupplierPriceHistory(hotelUid, supplierProductId, options = {}) {
  if (!documentId(supplierProductId)) throw new Error("supplierProductId is required.");
  if (options.beforeRevision != null && (!Number.isSafeInteger(options.beforeRevision) || options.beforeRevision < 1)) throw new Error("Invalid supplier history cursor.");
  return load(hotelUid, { mode: "history", supplierProductId, ...(options.beforeRevision != null ? { beforeRevision: options.beforeRevision } : {}) }, options);
}
