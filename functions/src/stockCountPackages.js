const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { admin } = require("./config");
const { requireHotelPermission } = require("./authorization");
const { requireDocumentId } = require("./subscriptions");
const { requireSaasRollout, gated } = require("./saasRollout");
const { units, decimal, convertQuantity } = require("./productPolicy");
const { isArchived } = require("./procurementResources");
const { validDate } = require("./importMonitoringPolicy");
const { loadSupplierPriceVersions, resolveSupplierPriceVersion } = require("./supplierPriceVersions");
const PAGE_SIZE = 25;
const label = (value, maximum = 200) => typeof value === "string" ? value.trim().slice(0, maximum) : "";

// This is a physical count helper, not an ordering or valuation projection. It
// deliberately does not require a known price or disclose supplier account data.
function packageOptions(product, supplierProductId, baseUnit, supplierName) {
  const unavailable = (reason) => ({ options: [], reason });
  if (isArchived(product) || product.active !== true || product.archivedAt) return unavailable("supplier-product-inactive");
  if (product.productPolicyVersion !== 1) return unavailable("package-configuration-not-reviewed");
  if (!Object.hasOwn(units, product.baseUnit)) return unavailable("package-unit-unknown");
  if (units[product.baseUnit].dimension !== units[baseUnit].dimension) return unavailable("package-unit-incompatible");
  if (!Array.isArray(product.purchaseOptions || []) || (product.purchaseOptions || []).length > 20
    || product.hasVariants && !product.purchaseOptions?.length) return unavailable("package-configuration-needs-review");
  const sources = [{ ...product, id: "default" }, ...(product.purchaseOptions || [])];
  const ids = sources.map((source) => source?.id);
  if (new Set(ids).size !== ids.length) return unavailable("package-identities-needs-review");
  const options = [];
  for (const source of sources) {
    try {
      const purchaseOptionId = requireDocumentId(source?.id, "Stored purchase option ID");
      if (!label(source.purchaseUnit, 100)) return unavailable("package-label-unknown");
      const quantity = decimal(source.baseUnitsPerPurchaseUnit, "Stored package quantity", { maximum: 1000000, positive: true });
      const catalogUnitsPerPackage = convertQuantity(quantity, product.baseUnit, baseUnit);
      if (catalogUnitsPerPackage <= 0 || catalogUnitsPerPackage > 1000000) return unavailable("package-quantity-outside-count-bound");
      options.push({ id: JSON.stringify([supplierProductId, purchaseOptionId]), supplierProductId, purchaseOptionId,
        supplierProductName: label(product.supplierProductName || product.name) || "Unnamed supplier product",
        supplierName: label(supplierName) || "Supplier name unavailable", purchaseUnit: label(source.purchaseUnit, 100),
        baseUnit, catalogUnitsPerPackage });
    } catch { return unavailable("package-quantity-or-identity-needs-review"); }
  }
  if (new Set(options.map((option) => option.id)).size !== options.length) return unavailable("package-identities-needs-review");
  return { options, reason: null };
}

async function getHotelStockCountPackageOptionsHandler(request, services = {}) {
  const input = request.data;
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).some((key) => !["hotelUid", "stockCountId", "locationId", "catalogProductId", "afterSupplierProductId"].includes(key))) {
    throw new HttpsError("invalid-argument", "Unsupported stock count package request.");
  }
  const hotelUid = requireDocumentId(input.hotelUid, "hotelUid"), stockCountId = requireDocumentId(input.stockCountId, "stockCountId"),
    locationId = requireDocumentId(input.locationId, "locationId"), catalogProductId = requireDocumentId(input.catalogProductId, "catalogProductId");
  const after = input.afterSupplierProductId == null ? null : requireDocumentId(input.afterSupplierProductId, "afterSupplierProductId");
  const db = services.firestore || admin.firestore();
  return db.runTransaction(async (tx) => {
    const actor = { ...request };
    await requireHotelPermission(db, actor, hotelUid, "stockcounts", "read", tx, services.auth);
    await requireHotelPermission(db, actor, hotelUid, "stockcounts", "update", tx, services.auth);
    await requireSaasRollout(db, tx);
    const countPath = `hotels/${hotelUid}/stockCounts/${stockCountId}`;
    const [parent, location] = await tx.getAll(db.doc(countPath), db.doc(`${countPath}/locations/${locationId}`));
    if (!parent.exists || !location.exists || !Array.isArray(parent.data().locations)
      || !parent.data().locations.some((row) => row.locationId === locationId)) throw new HttpsError("not-found", "Stock count location not found in this hotel.");
    const count = parent.data(), frozen = location.data();
    if (count.inventoryPolicyVersion !== 1 || frozen.inventoryPolicyVersion !== 1
      || count.currency !== frozen.currency || count.businessDate !== frozen.businessDate || !validDate(count.businessDate)) throw new HttpsError("failed-precondition", "The stock count snapshot policy needs reconciliation.");
    if (!["Started", "In Progress"].includes(count.status) || !["Not Started", "In Progress"].includes(frozen.status)) {
      throw new HttpsError("failed-precondition", "Package entry is available only for an unfinished catalog count.");
    }
    const template = frozen.stockTemplate?.items, counted = frozen.countedItems || [];
    if (!Array.isArray(template) || template.length > 250 || !Array.isArray(counted) || counted.length > 250) throw new HttpsError("failed-precondition", "The stock count products need reconciliation.");
    const rows = [...template, ...counted].filter((row) => row.catalogProductId === catalogProductId);
    const baseUnit = rows[0]?.baseUnit;
    if (!rows.length) throw new HttpsError("not-found", "Save this catalog product in the stock count before using package entry.");
    if (!Object.hasOwn(units, baseUnit) || rows.some((row) => row.baseUnit !== baseUnit)) throw new HttpsError("failed-precondition", "The frozen count unit needs reconciliation.");
    const response = { hotelUid, stockCountId, locationId, catalogProductId, inventoryPolicyVersion: 1,
      catalogBaseUnit: baseUnit, options: [], unavailable: [], nextCursor: null };
    const catalog = await tx.get(db.doc(`hotels/${hotelUid}/catalogproducts/${catalogProductId}`));
    if (!catalog.exists || isArchived(catalog.data()) || catalog.data().inventoryTracked !== true) {
      return { ...response, unavailable: [{ supplierProductId: null, reason: "catalog-product-not-available-for-package-entry" }] };
    }
    // The frozen row governs conversion. A different current unit is never used
    // to reinterpret a historical count, even when dimension compatible.
    if (catalog.data().baseUnit !== baseUnit) return { ...response,
      unavailable: [{ supplierProductId: null, reason: "catalog-unit-differs-from-frozen-count" }] };
    let query = db.collection(`hotels/${hotelUid}/supplierproducts`).where("catalogProductId", "==", catalogProductId)
      .orderBy(admin.firestore.FieldPath.documentId()).limit(PAGE_SIZE + 1);
    if (after) {
      const cursor = await tx.get(db.doc(`hotels/${hotelUid}/supplierproducts/${after}`));
      if (!cursor.exists || cursor.data().catalogProductId !== catalogProductId) throw new HttpsError("failed-precondition", "Package pagination changed. Reload the package choices.");
      query = query.startAfter(cursor);
    }
    const snapshot = await tx.get(query), page = snapshot.docs.slice(0, PAGE_SIZE);
    const supplierIds = [...new Set(page.map((row) => row.data().supplierId).filter((id) => typeof id === "string" && id.trim() === id && id.length > 0 && id.length <= 128 && !id.includes("/") && ![".", ".."].includes(id)))];
    const suppliers = supplierIds.length ? await tx.getAll(...supplierIds.map((id) => db.doc(`hotels/${hotelUid}/suppliers/${id}`))) : [];
    const supplierData = new Map(suppliers.filter((row) => row.exists && !isArchived(row.data())).map((row) => [row.id, row.data()]));
    const approvedPackages = new Map();
    await Promise.all(page.map(async (row) => {
      const data = row.data();
      if (!supplierData.has(data.supplierId)) return;
      try {
        const versions = await loadSupplierPriceVersions(tx, db, hotelUid, row.id);
        const resolved = resolveSupplierPriceVersion(data, versions, { orderDate: count.businessDate, deliveryDate: count.businessDate,
          pricingDateBasis: supplierData.get(data.supplierId).priceDateBasis });
        // Price expiry does not make a physical package disappear. This helper
        // projects only reviewed content at the frozen count business date; it
        // never imports the version price or source into counts or valuation.
        approvedPackages.set(row.id, versions.length && !resolved.versionId
          ? { product: null, reason: "package-terms-not-effective-on-count-date" } : { product: resolved.product, reason: null });
      } catch (error) {
        if (!(error instanceof HttpsError) || error.code !== "failed-precondition") throw error;
        approvedPackages.set(row.id, { product: null, reason: "approved-package-evidence-needs-review" });
      }
    }));
    for (const row of page) {
      const data = row.data();
      if (!supplierData.has(data.supplierId)) { response.unavailable.push({ supplierProductId: row.id, reason: "supplier-unavailable" }); continue; }
      const approved = approvedPackages.get(row.id);
      if (!approved?.product) { response.unavailable.push({ supplierProductId: row.id, reason: approved?.reason ?? "approved-package-evidence-needs-review" }); continue; }
      const projected = packageOptions(approved.product, row.id, baseUnit, supplierData.get(data.supplierId).name);
      response.options.push(...projected.options);
      if (projected.reason) response.unavailable.push({ supplierProductId: row.id, reason: projected.reason });
    }
    response.nextCursor = snapshot.docs.length > PAGE_SIZE ? page.at(-1).id : null;
    return response;
  });
}
module.exports = { packageOptions, getHotelStockCountPackageOptionsHandler,
  getHotelStockCountPackageOptions: onCall({ region: "us-central1", cors: true, maxInstances: 5, concurrency: 8, timeoutSeconds: 60 }, gated(getHotelStockCountPackageOptionsHandler)) };
