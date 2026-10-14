const policy = require("./productPolicy");

const PRICE_FIELDS = new Set(["pricePerBaseUnit", "pricePerPurchaseUnit", "priceValidFrom", "priceValidUntil"]);
const PACKAGE_FIELDS = new Set(["purchaseUnit", "baseUnitsPerPurchaseUnit", "purchaseOptions"]);

function sourceEstablishesUnitPrice(raw) {
  const interpretation = raw.sourceInterpretation;
  const priceField = raw.pricingModel === "Per Base Unit" ? "pricePerBaseUnit" : raw.pricingModel === "Per Purchase Unit" ? "pricePerPurchaseUnit" : null;
  if (!priceField || typeof raw[priceField] !== "number" || !Number.isFinite(raw[priceField]) || raw[priceField] < 0
    || (raw.sourceEvidenceIssues || []).length) return false;
  if (interpretation) return interpretation.unitPriceEstablished === true && interpretation.documentPurpose !== "statistics"
    && (interpretation.status === "confirmed" || interpretation.requiresFormatReview === false) && interpretation.providedFields?.includes(priceField) === true;
  // Legacy drafts can establish a price only from the actual extracted row,
  // never solely from the model's product fields or a header quotation.
  const number = String(raw[priceField]);
  const spellings = new Set([number, number.replace(".", ","), raw[priceField].toFixed(2), raw[priceField].toFixed(2).replace(".", ",")]);
  return (raw.sourceAnchors || []).some((anchor) => anchor.verified === true && typeof anchor.sourceExcerpt === "string"
    && [...spellings].some((spelling) => new RegExp(`(^|[^\\p{L}\\d.,])${spelling.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}\\d.,])`, "u").test(anchor.sourceExcerpt)));
}

function physicalPrice(product, unit) {
  if (!product) return null;
  try {
    const option = policy.resolvePurchaseOption(product);
    if (option.netPricePerPurchaseUnit === null || option.baseUnitsPerPurchaseUnit === null) return null;
    const quantity = policy.convertQuantity(option.baseUnitsPerPurchaseUnit, product.baseUnit, unit);
    return policy.derivedPrice(option.netPricePerPurchaseUnit, quantity, true);
  } catch { return null; }
}
function physicalPriceComparison(before, after) {
  const dimension = policy.units[after?.baseUnit]?.dimension;
  const unit = dimension === "mass" ? "kg" : dimension === "volume" ? "l" : dimension === "count" ? "each" : null;
  const oldValue = unit ? physicalPrice(before, unit) : null, newValue = unit ? physicalPrice(after, unit) : null;
  const sameCurrency = before?.currency && before.currency === after?.currency;
  const comparable = Boolean(before && unit && sameCurrency && oldValue !== null && newValue !== null);
  return { before: oldValue, after: newValue, unit, currency: after?.currency ?? null, comparable,
    percentChange: comparable && oldValue !== 0 ? Math.round(((newValue - oldValue) / oldValue) * 100000000) / 1000000 : null,
    reason: !before ? "No previous offer" : !sameCurrency ? "Currencies differ or are unknown" : oldValue === null || newValue === null ? "Net price or physical conversion is unavailable" : null };
}
function recurringReview(row) {
  const interpretation = row.sourceInterpretation;
  const priceComparison = physicalPriceComparison(row.previousPriceAgreement?.product || row.previousProduct, row.product);
  const fields = (row.changes || []).map((change) => change.field);
  const uncertain = row.category === "blocked" || (row.issues || []).some((entry) => entry.severity === "error" || entry.severity === "warning"
    && !["inactive-new-offer", "unlinked"].includes(entry.code));
  const established = sourceEstablishesUnitPrice({ ...(row.sourceInput || row.inputPatch), sourceAnchors: row.sourceAnchors,
    sourceEvidenceIssues: row.sourceEvidenceIssues, sourceInterpretation: interpretation });
  const category = uncertain ? "exception" : !row.previousProduct ? "new-article" : fields.some((field) => PACKAGE_FIELDS.has(field)) ? "packaging-change"
    : fields.length && fields.every((field) => PRICE_FIELDS.has(field)) ? "price-change" : fields.length ? "product-change"
      : established ? "confirmation" : "unchanged";
  return { category, physicalPriceComparison: priceComparison, confirmsUnitPrice: established,
    comparisonBasis: row.previousPriceAgreement ? "approved-period" : "current", comparedPriceVersionId: row.previousPriceAgreement?.versionId ?? null,
    sourceIssuedOn: interpretation?.sourceIssuedOn ?? null, formatStatus: interpretation?.status ?? null,
    assortmentMode: interpretation?.assortmentMode ?? "unknown" };
}
function priceEvidenceForRow(row, job) {
  const evidence = recurringReview(row);
  const raw = row.sourceInput || row.inputPatch || {};
  const priceField = raw.pricingModel === "Per Base Unit" ? "pricePerBaseUnit" : raw.pricingModel === "Per Purchase Unit" ? "pricePerPurchaseUnit" : null;
  const explicitCorrection = [...PRICE_FIELDS, "pricingModel", "currency", "priceBasis", "vatRate"].some((field) => Object.hasOwn(row.userPatch || {}, field));
  const sourcePrice = Boolean(priceField && typeof raw[priceField] === "number" && Number.isFinite(raw[priceField])
    && raw[priceField] >= 0 && row.sourceInterpretation?.documentPurpose !== "statistics" && row.sourceInterpretation?.unitPriceEstablished !== false);
  return { kind: "supplier-list", confirmsUnitPrice: evidence.confirmsUnitPrice,
    allowPriceChange: explicitCorrection || sourcePrice,
    providedPriceOptionIds: evidence.confirmsUnitPrice ? ["default"] : [],
    sourceReference: [job.fileName || "Supplier import", ...(row.sourceAnchors || []).map((anchor) => anchor.anchor || anchor.sourceId)].join(" · ").slice(0, 1000),
    sourceIssuedOn: evidence.sourceIssuedOn, sourceImportId: job.jobId ?? job.id ?? null, sourceProposalId: row.rowId };
}
module.exports = { sourceEstablishesUnitPrice, physicalPriceComparison, recurringReview, priceEvidenceForRow };
