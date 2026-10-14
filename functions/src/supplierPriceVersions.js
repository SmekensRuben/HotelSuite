const { HttpsError } = require("firebase-functions/v2/https");
const { digest, text } = require("./validation");
const { validDate } = require("./importMonitoringPolicy");
const productPolicy = require("./productPolicy");
const { pricingTerms, assessPriceValidity, priceValueChanged } = require("./supplierPricePolicy");

const SUPPLIER_PRICE_VERSION_POLICY_VERSION = 1;
const MAX_PRICE_VERSIONS = 100;
const MAX_PRICE_CONFIRMATIONS = 1000;
const PRICE_FIELDS = ["currency", "priceBasis", "vatRate", "pricingModel", "pricePerBaseUnit", "pricePerPurchaseUnit", "purchaseUnit", "baseUnit", "baseUnitsPerPurchaseUnit", "purchaseOptions", "priceValidFrom", "priceValidUntil"];
const METADATA_FIELDS = ["currentPriceVersionId", "latestApprovedPriceVersionId", "latestApprovedPurchaseTerms", "priceUpdatedOn", "priceConfirmedOn", "priceSourceReference", "priceSourceIssuedOn", "latestPriceSourceIssuedOn", "priceConfirmationSourceReference", "priceOptionReliability"];
const nullish = (value) => value === undefined ? null : value;

function purchaseTerms(product) {
  const result = Object.fromEntries(PRICE_FIELDS.map((field) => [field, nullish(product?.[field])]));
  if (Array.isArray(result.purchaseOptions)) result.purchaseOptions = result.purchaseOptions.map(({ gtin, ...option }) => option);
  return result;
}
function assessSourceFreshness(sourceIssuedOn, latestSourceIssuedOn) {
  if (!validDate(sourceIssuedOn)) return "unknown";
  return validDate(latestSourceIssuedOn) && sourceIssuedOn < latestSourceIssuedOn ? "older" : "current";
}
function normalizePriceEvidence(evidence) {
  if (evidence === undefined || evidence === null) return null;
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)
    || !["supplier-list", "manual"].includes(evidence.kind) || typeof evidence.confirmsUnitPrice !== "boolean") {
    throw new HttpsError("invalid-argument", "A reviewed price source and explicit unit-price evidence are required.");
  }
  const issued = evidence.sourceIssuedOn ?? null;
  if (issued !== null && !validDate(issued)) throw new HttpsError("invalid-argument", "Price source date must be YYYY-MM-DD or unknown.");
  const reference = evidence.sourceReference == null ? null : text(evidence.sourceReference, "Price source reference", 1000, true);
  const ids = evidence.providedPriceOptionIds ?? (evidence.confirmsUnitPrice ? ["default"] : []);
  if (!Array.isArray(ids) || ids.length > 21 || ids.some((id) => typeof id !== "string" || !id || id.includes("/")) || new Set(ids).size !== ids.length) {
    throw new HttpsError("invalid-argument", "Price evidence must identify its proven purchase options.");
  }
  return { kind: evidence.kind, confirmsUnitPrice: evidence.confirmsUnitPrice, providedPriceOptionIds: ids, allowPriceChange: evidence.allowPriceChange === true, sourceReference: reference,
    sourceIssuedOn: issued, sourceImportId: evidence.sourceImportId == null ? null : text(evidence.sourceImportId, "Source import ID", 200, true),
    sourceProposalId: evidence.sourceProposalId == null ? null : text(evidence.sourceProposalId, "Source proposal ID", 200, true) };
}
async function loadSupplierPriceVersions(tx, db, hotelUid, productId) {
  const found = await tx.get(db.collection(`hotels/${hotelUid}/supplierPriceVersions/${productId}/entries`).limit(MAX_PRICE_VERSIONS + 1));
  if (found.docs.length > MAX_PRICE_VERSIONS) throw new HttpsError("failed-precondition", "Supplier price history exceeds the supported version window. Review a paged price-history extension before ordering or approving more prices.");
  const confirmations = await tx.get(db.collection(`hotels/${hotelUid}/supplierPriceConfirmations/${productId}/entries`).limit(MAX_PRICE_CONFIRMATIONS + 1));
  if (confirmations.docs.length > MAX_PRICE_CONFIRMATIONS) throw new HttpsError("failed-precondition", "Supplier price confirmation history exceeds the supported evidence window. Review a paged confirmation extension before continuing.");
  const versionIds = new Set(found.docs.map((document) => document.id));
  const versionRevisions = new Set();
  const confirmedByVersion = new Map();
  for (const document of confirmations.docs) {
    const confirmation = document.data();
    if (confirmation.supplierPriceVersionPolicyVersion !== SUPPLIER_PRICE_VERSION_POLICY_VERSION || confirmation.supplierProductId !== productId
      || !Number.isSafeInteger(confirmation.revision) || !Array.isArray(confirmation.confirmedOptionIds) || !versionIds.has(confirmation.versionId)) throw new HttpsError("failed-precondition", "Supplier price confirmation evidence needs review.");
    const entries = confirmedByVersion.get(confirmation.versionId) ?? [];
    entries.push(confirmation); confirmedByVersion.set(confirmation.versionId, entries);
  }
  return found.docs.map((document) => {
    const stored = document.data();
    const version = { ...stored, id: document.id };
    if (stored.id !== undefined && stored.id !== document.id || versionRevisions.has(version.revision) || version.supplierPriceVersionPolicyVersion !== SUPPLIER_PRICE_VERSION_POLICY_VERSION || version.supplierProductId !== productId
      || !Number.isSafeInteger(version.revision) || version.revision < 0 || version.revision === 0 && version.observation !== "retained-prior-terms" || !version.productTerms || !version.terms || version.termsFingerprint !== digest(version.terms)
      || assessPriceValidity(version.productTerms, "2000-01-01") === "invalid") {
      throw new HttpsError("failed-precondition", "Approved supplier price evidence needs review.");
    }
    versionRevisions.add(version.revision);
    for (const confirmation of (confirmedByVersion.get(version.id) ?? []).sort((left, right) => left.revision - right.revision)) {
      version.lastPriceConfirmedAt = confirmation.confirmedAt;
      version.lastConfirmationSourceReference = confirmation.sourceReference ?? null;
      version.lastConfirmationSourceIssuedOn = confirmation.sourceIssuedOn ?? null;
      version.optionReliability = { ...version.optionReliability };
      for (const id of confirmation.confirmedOptionIds) version.optionReliability[id] = {
        lastPriceConfirmedAt: confirmation.confirmedAt, sourceReference: confirmation.sourceReference ?? null,
        sourceIssuedOn: confirmation.sourceIssuedOn ?? null, confirmationMatchesCurrentTerms: true };
    }
    return version;
  }).sort((left, right) => left.revision - right.revision);
}
function reviewReasons(validity, basisKnown, issued) {
  const reasons = [];
  if (validity !== "current") reasons.push(`price-validity-${validity}`);
  if (!basisKnown) reasons.push("supplier-pricing-date-agreement-unknown");
  if (!validDate(issued)) reasons.push("price-source-date-unknown");
  return reasons;
}
function unavailableProduct(product) {
  return { ...product, pricePerBaseUnit: null, pricePerPurchaseUnit: null,
    purchaseOptions: (Array.isArray(product.purchaseOptions) ? product.purchaseOptions : []).map((option) => ({ ...option, pricePerPurchaseUnit: null })) };
}
function resolveSupplierPriceVersion(product, versions, { orderDate, deliveryDate, pricingDateBasis } = {}) {
  const agreementKnown = ["order-date", "delivery-date"].includes(pricingDateBasis);
  const basis = agreementKnown ? pricingDateBasis : "order-date";
  const date = basis === "delivery-date" ? deliveryDate : orderDate;
  if (!validDate(date)) throw new HttpsError("failed-precondition", `A valid ${basis === "delivery-date" ? "delivery" : "order"} business date is required to select an approved supplier price.`);
  const latest = [...versions].sort((left, right) => left.revision - right.revision).at(-1);
  const eligible = versions.filter((version) => !version.productTerms.priceValidFrom || version.productTerms.priceValidFrom <= date);
  // Contractual starts outrank observation dates within dated agreements. A
  // newly reviewed undated agreement can replace current terms, but cannot
  // erase an already scheduled period that starts after that undated review.
  const dated = eligible.filter((version) => version.productTerms.priceValidFrom)
    .sort((left, right) => left.productTerms.priceValidFrom.localeCompare(right.productTerms.priceValidFrom) || left.revision - right.revision).at(-1);
  const undated = eligible.filter((version) => !version.productTerms.priceValidFrom)
    .sort((left, right) => left.revision - right.revision).at(-1);
  const scheduledAfterUndatedReview = dated && undated && validDate(undated.approvedBusinessDate)
    && dated.productTerms.priceValidFrom > undated.approvedBusinessDate;
  const selected = !dated ? undated : !undated ? dated
    : dated.revision > undated.revision || scheduledAfterUndatedReview ? dated : undated;
  // Missing immutable evidence must not be replaced with a newer convenience
  // projection after a partial restore or outside the approved date window.
  const declaredVersionIds = [product.currentPriceVersionId, product.latestApprovedPriceVersionId].filter(Boolean);
  if (declaredVersionIds.some((id) => !versions.some((version) => version.id === id))) {
    throw new HttpsError("failed-precondition", "Approved supplier price evidence needs reconciliation.");
  }
  const projected = selected ? { ...product, ...purchaseTerms(selected.productTerms),
    purchaseOptions: (selected.productTerms.purchaseOptions || []).map((option) => ({ ...option,
      gtin: product.purchaseOptions?.find((current) => current.id === option.id)?.gtin ?? null })) } : product;
  let validity = assessPriceValidity(projected, date);
  if (versions.length && !selected) validity = "future";
  const usable = !["future", "expired", "invalid", "unavailable"].includes(validity);
  const versionId = selected?.id ?? null;
  const isProjectedCurrent = product.currentPriceVersionId === versionId && versionId !== null;
  const sourceIssuedOn = selected?.sourceIssuedOn ?? product.priceSourceIssuedOn ?? null;
  const optionReliability = (isProjectedCurrent ? product.priceOptionReliability : selected?.optionReliability) ?? {};
  const latestConfirmationSourceIssuedOn = optionReliability.default?.sourceIssuedOn ?? selected?.lastConfirmationSourceIssuedOn ?? null;
  const reasons = reviewReasons(validity, agreementKnown, latestConfirmationSourceIssuedOn ?? sourceIssuedOn);
  const optionIds = ["default", ...(projected.purchaseOptions || []).map((option) => option.id)];
  const optionsNeedingReview = optionIds.filter((id) => !optionReliability[id]?.lastPriceConfirmedAt || optionReliability[id]?.confirmationMatchesCurrentTerms === false);
  if (optionsNeedingReview.length) reasons.push("purchase-option-price-confirmation-unknown");
  return { product: usable ? projected : unavailableProduct(projected), versionId,
    priceValidity: validity, pricingDateBasis: basis, pricingAgreementKnown: agreementKnown, pricingDate: date,
    sourceReference: selected?.sourceReference ?? product.priceSourceReference ?? null, sourceIssuedOn,
    lastPriceChangeAt: selected?.lastPriceChangeAt ?? product.priceUpdatedOn ?? null,
    lastPriceConfirmedAt: isProjectedCurrent ? product.priceConfirmedOn ?? selected?.lastPriceConfirmedAt ?? null : selected?.lastPriceConfirmedAt ?? product.priceConfirmedOn ?? null,
    latestConfirmationSourceReference: isProjectedCurrent ? product.priceConfirmationSourceReference ?? selected?.lastConfirmationSourceReference ?? selected?.sourceReference ?? null : selected?.lastConfirmationSourceReference ?? selected?.sourceReference ?? null,
    latestConfirmationSourceIssuedOn,
    latestSourceIssuedOn: product.latestPriceSourceIssuedOn ?? latest?.sourceIssuedOn ?? null,
    hasScheduledVersions: versions.some((version) => version.productTerms.priceValidFrom && version.productTerms.priceValidFrom > date),
    optionReliability, optionsNeedingReview, needsReview: reasons.length > 0, reasons };
}

function prepareSupplierPriceVersion(plan, versions, evidenceInput, today) {
  const evidence = normalizePriceEvidence(evidenceInput);
  const approved = { ...plan.next };
  plan.priorPriceVersion = null;
  if (plan.previous && !versions.length) {
    const priorTerms = pricingTerms(plan.previous, plan.previousCatalog);
    const prior = { supplierPriceVersionPolicyVersion: SUPPLIER_PRICE_VERSION_POLICY_VERSION, id: `prior-${String(plan.expected).padStart(16, "0")}`,
      supplierProductId: plan.productId, supplierId: plan.previous.supplierId, revision: plan.expected, observation: "retained-prior-terms",
      termsFingerprint: digest(priorTerms), terms: priorTerms, productTerms: purchaseTerms(plan.previous),
      sourceKind: "legacy", sourceReference: plan.previous.priceSourceReference ?? null, sourceIssuedOn: plan.previous.priceSourceIssuedOn ?? null,
      approvedBusinessDate: null, approvedAt: null, lastPriceChangeAt: plan.previous.priceUpdatedOn ?? null,
      lastPriceConfirmedAt: plan.previous.priceConfirmedOn ?? null, optionReliability: plan.previous.priceOptionReliability ?? {}, confirmedOptionIds: [], confirmsUnitPrice: false };
    versions = [prior];
    plan.priorPriceVersion = prior;
  }
  // A source without an established unit price can update supported product
  // information, but cannot replace or confirm the recorded pricing contract.
  if (evidence?.kind === "supplier-list" && !evidence.confirmsUnitPrice && !evidence.allowPriceChange && plan.previous) {
    for (const field of ["pricePerBaseUnit", "pricePerPurchaseUnit", "priceBasis", "vatRate", "currency", "priceValidFrom", "priceValidUntil"]) approved[field] = plan.previous[field] ?? null;
    approved.purchaseOptions = (approved.purchaseOptions || []).map((option) => ({ ...option,
      pricePerPurchaseUnit: plan.previous.purchaseOptions?.find((prior) => prior.id === option.id)?.pricePerPurchaseUnit ?? null }));
    if (approved.pricingModel === "Per Base Unit") {
      approved.pricePerPurchaseUnit = approved.pricePerBaseUnit === null ? null : productPolicy.derivedPrice(approved.pricePerBaseUnit, approved.baseUnitsPerPurchaseUnit);
    } else {
      approved.pricePerBaseUnit = null;
      if (approved.pricePerPurchaseUnit !== null) try { approved.pricePerBaseUnit = productPolicy.derivedPrice(approved.pricePerPurchaseUnit, approved.baseUnitsPerPurchaseUnit, true); } catch { /* Keep an unrepresentable display price explicitly unavailable. */ }
    }
  }
  const terms = pricingTerms(approved, plan.catalog), fingerprint = digest(terms);
  const latest = versions.at(-1);
  const matching = [...versions].reverse().find((version) => version.termsFingerprint === fingerprint
    && [plan.previous?.currentPriceVersionId, plan.previous?.latestApprovedPriceVersionId, latest?.id].includes(version.id));
  const differsFromPrevious = !plan.previous || digest(pricingTerms(plan.previous, plan.previousCatalog)) !== fingerprint;
  const termsChanged = !matching && (differsFromPrevious || versions.length > 0);
  const pricedOptions = new Map([["default", approved.pricePerPurchaseUnit], ...(approved.purchaseOptions || []).map((option) => [option.id, option.pricePerPurchaseUnit])]);
  const proposedConfirmedIds = evidence?.providedPriceOptionIds ?? [...pricedOptions.keys()];
  if (proposedConfirmedIds.some((id) => !pricedOptions.has(id))) throw new HttpsError("invalid-argument", "Price evidence refers to an unavailable purchase option.");
  const knownConfirmedIds = proposedConfirmedIds.filter((id) => typeof pricedOptions.get(id) === "number" && Number.isFinite(pricedOptions.get(id)));
  const confirms = knownConfirmedIds.length > 0 && (evidence ? evidence.confirmsUnitPrice : termsChanged);
  const providedOptionIds = confirms ? knownConfirmedIds : [];
  const latestIssued = [plan.previous?.latestPriceSourceIssuedOn, ...versions.map((version) => version.sourceIssuedOn)].filter(validDate).sort().at(-1) ?? null;
  if (evidence?.kind === "supplier-list" && (termsChanged || confirms) && assessSourceFreshness(evidence.sourceIssuedOn, latestIssued) === "older") {
    throw new HttpsError("failed-precondition", "This supplier price source is older than a reviewed agreement. Keep the newer price and review the older source separately.");
  }
  plan.approvedProduct = approved;
  plan.next = { ...approved };
  plan.priceChanged = termsChanged;
  plan.priceValueChanged = termsChanged && priceValueChanged(plan.previous, approved);
  plan.priceEvidence = evidence;
  plan.priceConfirms = confirms;
  plan.priceConfirmedOptionIds = providedOptionIds;
  plan.priceVersion = null;
  plan.priceVersionId = matching?.id ?? null;
  plan.pricePreviousTerms = matching?.terms ?? (plan.previous ? pricingTerms(plan.previous, plan.previousCatalog) : null);
  if (termsChanged) {
    if (versions.length >= MAX_PRICE_VERSIONS) throw new HttpsError("failed-precondition", "Supplier price history reached the supported version window. Review a paged price-history extension before approving another version.");
    const id = String(plan.expected + 1).padStart(16, "0");
    plan.priceVersionId = id;
    plan.priceVersion = { supplierPriceVersionPolicyVersion: SUPPLIER_PRICE_VERSION_POLICY_VERSION, id,
      supplierProductId: plan.productId, supplierId: approved.supplierId, revision: plan.expected + 1,
      termsFingerprint: fingerprint, terms, productTerms: purchaseTerms(approved),
      sourceKind: evidence?.kind ?? "manual", sourceReference: evidence?.sourceReference ?? "Manual product review",
      sourceIssuedOn: evidence?.sourceIssuedOn ?? null, sourceImportId: evidence?.sourceImportId ?? null,
      sourceProposalId: evidence?.sourceProposalId ?? null, confirmsUnitPrice: confirms, approvedBusinessDate: today,
      confirmedOptionIds: providedOptionIds };
  }
  plan.priceVersions = versions;
  plan.priceAssessmentDate = today;
  plan.latestPriceSourceIssuedOn = evidence?.kind === "supplier-list" && confirms && validDate(evidence.sourceIssuedOn)
    ? [latestIssued, evidence.sourceIssuedOn].filter(validDate).sort().at(-1) : latestIssued;
  if (approved.priceValidFrom && approved.priceValidFrom > today) {
    if (plan.previous) for (const field of PRICE_FIELDS) plan.next[field] = nullish(plan.previous[field]);
    else plan.next = unavailableProduct(plan.next);
  }
  for (const field of METADATA_FIELDS) if (plan.previous?.[field] !== undefined) plan.next[field] = plan.previous[field];
  return plan;
}
function writeSupplierPriceVersion(tx, db, hotelUid, plan, actorUid, now) {
  if (plan.priorPriceVersion) tx.create(db.doc(`hotels/${hotelUid}/supplierPriceVersions/${plan.productId}/entries/${plan.priorPriceVersion.id}`), plan.priorPriceVersion);
  const priorOptionReliability = plan.previous?.priceOptionReliability ?? {};
  const previousOption = (id) => id === "default" ? plan.previous : plan.previous?.purchaseOptions?.find((option) => option.id === id);
  const currentOption = (id) => id === "default" ? plan.approvedProduct : plan.approvedProduct.purchaseOptions?.find((option) => option.id === id);
  const optionFingerprint = (product, option) => digest(product?.currency ?? null, product?.priceBasis ?? null, product?.vatRate ?? null, product?.baseUnit ?? null, product?.priceValidFrom ?? null, product?.priceValidUntil ?? null, product?.pricingModel ?? null,
    option?.pricePerPurchaseUnit ?? null, option?.purchaseUnit ?? null, option?.baseUnitsPerPurchaseUnit ?? null);
  const optionReliability = Object.fromEntries(["default", ...(plan.approvedProduct.purchaseOptions || []).map((option) => option.id)].map((id) => [id,
    plan.priceConfirmedOptionIds.includes(id) ? { lastPriceConfirmedAt: now, sourceReference: plan.priceEvidence?.sourceReference ?? "Manual product review", sourceIssuedOn: plan.priceEvidence?.sourceIssuedOn ?? null, confirmationMatchesCurrentTerms: true }
      : { ...(priorOptionReliability[id] ?? { lastPriceConfirmedAt: null, sourceReference: null, sourceIssuedOn: null }),
        confirmationMatchesCurrentTerms: Boolean(priorOptionReliability[id]?.lastPriceConfirmedAt) && optionFingerprint(plan.previous, previousOption(id)) === optionFingerprint(plan.approvedProduct, currentOption(id)) }]));
  if (plan.priceVersion) {
    const version = { ...plan.priceVersion, approvedBy: actorUid, approvedAt: now, lastPriceChangeAt: plan.priceValueChanged ? now : plan.previous?.priceUpdatedOn ?? null,
      lastPriceConfirmedAt: plan.priceConfirms ? now : plan.previous?.priceConfirmedOn ?? null, optionReliability };
    tx.create(db.doc(`hotels/${hotelUid}/supplierPriceVersions/${plan.productId}/entries/${version.id}`), version);
    plan.priceVersions = [...plan.priceVersions, version];
    plan.next.latestApprovedPriceVersionId = version.id;
    plan.next.latestApprovedPurchaseTerms = { versionId: version.id, ...purchaseTerms(plan.approvedProduct) };
  }
  if (plan.priceConfirms && plan.priceVersionId) {
    tx.create(db.doc(`hotels/${hotelUid}/supplierPriceConfirmations/${plan.productId}/entries/${String(plan.expected + 1).padStart(16, "0")}`), {
      supplierPriceVersionPolicyVersion: SUPPLIER_PRICE_VERSION_POLICY_VERSION, supplierProductId: plan.productId,
      versionId: plan.priceVersionId, revision: plan.expected + 1, actorUid, confirmedAt: now, confirmedOptionIds: plan.priceConfirmedOptionIds,
      sourceKind: plan.priceEvidence?.kind ?? "manual", sourceReference: plan.priceEvidence?.sourceReference ?? "Manual product review",
      sourceIssuedOn: plan.priceEvidence?.sourceIssuedOn ?? null, sourceImportId: plan.priceEvidence?.sourceImportId ?? null,
      sourceProposalId: plan.priceEvidence?.sourceProposalId ?? null });
  }
  if (plan.priceVersions.length) {
    const current = resolveSupplierPriceVersion(plan.next, plan.priceVersions,
      { orderDate: plan.priceAssessmentDate, pricingDateBasis: "order-date" });
    plan.next.currentPriceVersionId = current.versionId;
    if (current.versionId && !["future", "expired", "invalid", "unavailable"].includes(current.priceValidity)) {
      Object.assign(plan.next, Object.fromEntries(PRICE_FIELDS.map((field) => [field, nullish(current.product[field])])));
      plan.next.priceUpdatedOn = current.lastPriceChangeAt;
      if (plan.priceConfirms && current.versionId === plan.priceVersionId) {
        plan.next.priceConfirmedOn = now;
        plan.next.priceConfirmationSourceReference = plan.priceEvidence?.sourceReference ?? "Manual product review";
        plan.next.priceOptionReliability = optionReliability;
      } else {
        plan.next.priceConfirmedOn = current.lastPriceConfirmedAt;
        plan.next.priceOptionReliability = current.optionReliability;
      }
      plan.next.priceSourceReference = current.sourceReference;
      plan.next.priceSourceIssuedOn = current.sourceIssuedOn;
    }
  }
  plan.next.latestPriceSourceIssuedOn = plan.latestPriceSourceIssuedOn;
}

module.exports = { SUPPLIER_PRICE_VERSION_POLICY_VERSION, MAX_PRICE_VERSIONS, MAX_PRICE_CONFIRMATIONS, PRICE_FIELDS, METADATA_FIELDS, purchaseTerms,
  assessSourceFreshness, normalizePriceEvidence, loadSupplierPriceVersions, resolveSupplierPriceVersion,
  prepareSupplierPriceVersion, writeSupplierPriceVersion };
