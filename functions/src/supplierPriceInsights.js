const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { admin } = require("./config");
const { requireDocumentId } = require("./subscriptions");
const { requireHotelPermission } = require("./authorization");
const { gated, requireSaasRollout } = require("./saasRollout");
const { pricingTerms, projectOptions, assessPriceValidity, SUPPLIER_PRICE_POLICY_VERSION } = require("./supplierPricePolicy");
const { loadSupplierPriceVersions, resolveSupplierPriceVersion } = require("./supplierPriceVersions");
const { validTimeZone } = require("./hotelSetupPolicy");
const { localDate, validDate } = require("./importMonitoringPolicy");

const MAX_PAGE = 50;
const dateValue = (value) => typeof value?.toDate === "function" ? value.toDate().toISOString()
  : typeof value?.seconds === "number" ? new Date(value.seconds * 1000).toISOString() : null;
const label = (value) => typeof value === "string" ? value.trim().slice(0, 200) || null : null;
const contractDate = (value) => validDate(value) ? value : null;

function reliabilityProjection(resolved) {
  return { currentVersionId: resolved.versionId, lastPriceChangeAt: dateValue(resolved.lastPriceChangeAt),
    lastPriceConfirmedAt: dateValue(resolved.lastPriceConfirmedAt), sourceReference: resolved.sourceReference,
    sourceIssuedOn: resolved.sourceIssuedOn, latestSourceIssuedOn: resolved.latestSourceIssuedOn,
    latestConfirmationSourceReference: resolved.latestConfirmationSourceReference, latestConfirmationSourceIssuedOn: resolved.latestConfirmationSourceIssuedOn,
    priceValidity: resolved.priceValidity, needsReview: resolved.needsReview, reasons: resolved.reasons,
    hasScheduledVersions: resolved.hasScheduledVersions, pricingDateBasis: resolved.pricingDateBasis,
    pricingAgreementKnown: resolved.pricingAgreementKnown, assessmentDate: resolved.pricingDate, optionsNeedingReview: resolved.optionsNeedingReview,
    optionReliability: Object.fromEntries(Object.entries(resolved.optionReliability).map(([id, data]) => [id, {
      lastPriceConfirmedAt: dateValue(data.lastPriceConfirmedAt), sourceReference: data.sourceReference ?? null,
      sourceIssuedOn: data.sourceIssuedOn ?? null, confirmationMatchesCurrentTerms: data.confirmationMatchesCurrentTerms !== false }])) };
}
function versionProjection(version, today, product) {
  const currentlyProjected = product.currentPriceVersionId === version.id;
  return { id: version.id, revision: version.revision, observation: version.observation ?? "approved",
    approvedAt: dateValue(version.approvedAt), lastPriceChangeAt: dateValue(version.lastPriceChangeAt),
    lastPriceConfirmedAt: dateValue(currentlyProjected ? product.priceConfirmedOn ?? version.lastPriceConfirmedAt : version.lastPriceConfirmedAt),
    sourceReference: version.sourceReference, sourceIssuedOn: version.sourceIssuedOn, sourceKind: version.sourceKind,
    contractualValidFrom: contractDate(version.productTerms.priceValidFrom), contractualValidUntil: contractDate(version.productTerms.priceValidUntil),
    priceValidity: assessPriceValidity(version.productTerms, today), currency: version.terms.currency,
    catalogProductId: version.terms.catalogProductId, catalogBaseUnit: version.terms.catalogBaseUnit,
    options: projectOptions(version.terms), confirmedOptionIds: version.confirmedOptionIds ?? [] };
}

async function getHotelSupplierPriceInsightsHandler(request, services = {}) {
  const input = request.data;
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).some((key) => !["hotelUid", "mode", "catalogProductId", "supplierProductId", "pageSize", "afterProductId", "beforeRevision"].includes(key))) {
    throw new HttpsError("invalid-argument", "Unsupported supplier price insight request.");
  }
  const hotelUid = requireDocumentId(input.hotelUid, "hotelUid");
  const pageSize = input.pageSize ?? 25;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE) throw new HttpsError("invalid-argument", "Request between 1 and 50 supplier price records.");
  if (!["comparison", "history"].includes(input.mode)) throw new HttpsError("invalid-argument", "Choose comparison or history.");
  const comparison = input.mode === "comparison";
  if (comparison && (input.supplierProductId !== undefined || input.beforeRevision !== undefined)
    || !comparison && (input.catalogProductId !== undefined || input.afterProductId !== undefined)) {
    throw new HttpsError("invalid-argument", "Use only the selected price insight mode's identifiers.");
  }
  const resourceId = requireDocumentId(comparison ? input.catalogProductId : input.supplierProductId, comparison ? "catalogProductId" : "supplierProductId");
  const after = input.afterProductId === undefined || input.afterProductId === null ? null : requireDocumentId(input.afterProductId, "afterProductId");
  const before = input.beforeRevision ?? null;
  if (before !== null && (!Number.isSafeInteger(before) || before < 1)) throw new HttpsError("invalid-argument", "Use a positive whole history revision.");
  const db = services.firestore || admin.firestore();
  return db.runTransaction(async (tx) => {
    const actor = { ...request };
    for (const feature of ["catalogproducts", "supplierproducts", "suppliers"]) await requireHotelPermission(db, actor, hotelUid, feature, "read", tx, services.auth);
    await requireSaasRollout(db, tx);
    if (comparison) {
      const catalog = await tx.get(db.doc(`hotels/${hotelUid}/catalogproducts/${resourceId}`));
      if (!catalog.exists) throw new HttpsError("not-found", "Catalog product not found in this hotel.");
      let query = db.collection(`hotels/${hotelUid}/supplierproducts`).where("catalogProductId", "==", resourceId)
        .orderBy(admin.firestore.FieldPath.documentId());
      if (after) query = query.startAfter(after);
      const found = await tx.get(query.limit(pageSize + 1)), documents = found.docs.slice(0, pageSize);
      const supplierIds = [...new Set(documents.map((document) => document.data().supplierId).filter((id) => typeof id === "string" && id && !id.includes("/") && ![".", ".."].includes(id)))];
      const sources = supplierIds.length ? await tx.getAll(...supplierIds.map((id) => db.doc(`hotels/${hotelUid}/suppliers/${id}`))) : [];
      const suppliers = new Map(supplierIds.map((id, index) => [id, sources[index]]));
      const data = catalog.data();
      const hotel = await tx.get(db.doc(`hotels/${hotelUid}`));
      const timeZone = validTimeZone(hotel.data()?.timeZone) ? hotel.data().timeZone : null;
      const today = timeZone ? localDate(services.now?.() ?? Date.now(), timeZone) : null;
      const versionSets = await Promise.all(documents.map((document) => loadSupplierPriceVersions(tx, db, hotelUid, document.id)));
      return { hotelUid, mode: "comparison", policyVersion: SUPPLIER_PRICE_POLICY_VERSION,
        assessmentDate: today, timeZone,
        catalog: { id: resourceId, name: label(data.name), baseUnit: data.baseUnit ?? null,
          active: data.active !== false && data.archived !== true },
        products: documents.map((document, index) => {
          const source = document.data(), supplier = suppliers.get(source.supplierId), supplierData = supplier?.data();
          const resolved = today ? resolveSupplierPriceVersion(source, versionSets[index], { orderDate: today, deliveryDate: today, pricingDateBasis: supplierData?.priceDateBasis }) : null;
          const product = resolved?.product ?? source;
          return { id: document.id, supplierId: product.supplierId ?? null,
            supplierName: supplier?.exists ? label(supplierData.name) : null,
            supplierSku: label(product.supplierSku), name: label(product.supplierProductName),
            active: product.active === true && product.archived !== true && supplier?.exists === true && supplierData.active !== false && supplierData.archived !== true && data.active !== false && data.archived !== true,
            currency: product.currency ?? null, priceBasis: product.priceBasis ?? null, vatRate: product.vatRate ?? null,
            sourcePriceRecordedAt: dateValue(product.priceUpdatedOn),
            contractualValidFrom: contractDate(product.priceValidFrom), contractualValidUntil: contractDate(product.priceValidUntil),
            priceValidity: assessPriceValidity(product, today),
            options: projectOptions(pricingTerms(product, data)), reliability: resolved ? reliabilityProjection(resolved) : null,
            scheduledVersionCount: today ? versionSets[index].filter((version) => version.productTerms.priceValidFrom > today).length : null };
        }), nextProductId: found.docs.length > pageSize ? documents.at(-1).id : null };
    }
    const product = await tx.get(db.doc(`hotels/${hotelUid}/supplierproducts/${resourceId}`));
    if (!product.exists) throw new HttpsError("not-found", "Supplier product not found in this hotel.");
    const hotel = await tx.get(db.doc(`hotels/${hotelUid}`));
    const timeZone = validTimeZone(hotel.data()?.timeZone) ? hotel.data().timeZone : null;
    const today = timeZone ? localDate(services.now?.() ?? Date.now(), timeZone) : null;
    const supplierId = product.data().supplierId;
    const supplier = supplierId ? await tx.get(db.doc(`hotels/${hotelUid}/suppliers/${requireDocumentId(supplierId, "Supplier ID")}`)) : null;
    const versions = await loadSupplierPriceVersions(tx, db, hotelUid, resourceId);
    const resolved = today ? resolveSupplierPriceVersion(product.data(), versions, { orderDate: today, deliveryDate: today, pricingDateBasis: supplier?.data()?.priceDateBasis }) : null;
    let query = db.collection(`hotels/${hotelUid}/supplierPriceHistory/${resourceId}/entries`).orderBy("revision", "desc");
    if (before !== null) query = query.startAfter(before);
    const found = await tx.get(query.limit(pageSize + 1)), documents = found.docs.slice(0, pageSize);
    return { hotelUid, mode: "history", supplierProductId: resourceId, policyVersion: SUPPLIER_PRICE_POLICY_VERSION,
      assessmentDate: today, timeZone, reliability: resolved ? reliabilityProjection(resolved) : null,
      versions: [...versions].reverse().map((version) => versionProjection(version, today, product.data())),
      entries: documents.map((document) => {
        const data = document.data();
        if (data.supplierPricePolicyVersion !== SUPPLIER_PRICE_POLICY_VERSION || data.supplierProductId !== resourceId || !Number.isSafeInteger(data.revision)) {
          throw new HttpsError("failed-precondition", "Supplier price history evidence needs review.");
        }
        return { revision: data.revision, observation: data.observation, observedAt: dateValue(data.observedAt),
          approvedVersionId: data.approvedVersionId ?? null, priceChanged: data.priceChanged ?? data.observation !== "price-confirmed",
          priceConfirmedAt: dateValue(data.priceConfirmedAt), sourceReference: data.sourceReference ?? null, sourceIssuedOn: contractDate(data.sourceIssuedOn),
          currency: data.terms.currency, catalogBaseUnit: data.terms.catalogBaseUnit, catalogProductId: data.terms.catalogProductId,
          options: projectOptions(data.terms),
          previous: data.previousTerms ? { currency: data.previousTerms.currency, catalogBaseUnit: data.previousTerms.catalogBaseUnit,
            catalogProductId: data.previousTerms.catalogProductId, options: projectOptions(data.previousTerms),
            contractualValidityNeedsReview: assessPriceValidity({ priceValidFrom: data.previousTerms.contractualValidFrom, priceValidUntil: data.previousTerms.contractualValidUntil }, null) === "invalid",
            contractualValidFrom: contractDate(data.previousTerms.contractualValidFrom), contractualValidUntil: contractDate(data.previousTerms.contractualValidUntil) } : null,
          contractualValidityNeedsReview: assessPriceValidity({ priceValidFrom: data.terms.contractualValidFrom, priceValidUntil: data.terms.contractualValidUntil }, null) === "invalid",
          previousObservationDate: null, contractualValidFrom: contractDate(data.terms.contractualValidFrom), contractualValidUntil: contractDate(data.terms.contractualValidUntil) };
      }), nextRevision: found.docs.length > pageSize ? documents.at(-1).data().revision : null };
  }, { readOnly: true });
}

module.exports = { MAX_PAGE, getHotelSupplierPriceInsightsHandler,
  getHotelSupplierPriceInsights: onCall({ region: "us-central1", cors: true, timeoutSeconds: 60 }, gated(getHotelSupplierPriceInsightsHandler)) };
