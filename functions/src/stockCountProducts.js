const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { admin } = require("./config");
const { requireHotelPermission } = require("./authorization");
const { requireDocumentId, requireHotelSubscription } = require("./subscriptions");
const { text } = require("./validation");
const { requireSaasRollout, gated } = require("./saasRollout");
const { compatibleUnits } = require("./productPolicy");
const { isArchived } = require("./procurementResources");
const { unit } = require("./inventoryPolicy");

const PAGE_SIZE = 25;
const BARCODE_PAGE_SIZE = 100;
const barcodeText = (value) => typeof value === "string" && value.trim().length > 0 && value.trim().length <= 100 ? value.trim() : null;
function barcodeCursor(value) {
  if (value == null) return null;
  if (typeof value !== "string" || !/^barcode:[A-Za-z0-9_-]+$/.test(value) || value.length > 512) throw new HttpsError("invalid-argument", "Barcode pagination is invalid.");
  const id = Buffer.from(value.slice(8), "base64url").toString("utf8");
  if (`barcode:${Buffer.from(id, "utf8").toString("base64url")}` !== value) throw new HttpsError("invalid-argument", "Barcode pagination is invalid.");
  return requireDocumentId(id, "Barcode offer cursor");
}
function projectProduct(row) {
  const data = row.data();
  return { id: row.id, name: text(data.name, "Catalog product name", 200, true), baseUnit: unit(data.baseUnit),
    barcodes: [barcodeText(data.gtin)].filter(Boolean) };
}

// Counters can discover physical products without accessing purchasing prices.
// Name prefixes use the catalog's canonical nameLower index. Barcode scans page
// offers once and hydrate only matches; exhaust those pages before claiming that
// a code identifies exactly one product, including additional purchase packages.
async function listHotelStockCountProductsHandler(request, services = {}) {
  const input = request.data;
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).some((field) => !["hotelUid", "stockCountId", "locationId", "afterProductId", "search", "barcode"].includes(field))) {
    throw new HttpsError("invalid-argument", "Unsupported stock count product request.");
  }
  const hotelUid = requireDocumentId(input.hotelUid, "hotelUid"), stockCountId = requireDocumentId(input.stockCountId, "stockCountId"),
    locationId = requireDocumentId(input.locationId, "locationId");
  const search = text(input.search ?? "", "Search", 200).toLowerCase(), barcode = text(input.barcode ?? "", "Barcode", 100);
  const after = barcode ? barcodeCursor(input.afterProductId) : input.afterProductId == null ? null : requireDocumentId(input.afterProductId, "afterProductId");
  const db = services.firestore || admin.firestore();
  return db.runTransaction(async (tx) => {
    const actor = { ...request };
    await requireHotelPermission(db, actor, hotelUid, "stockcounts", "read", tx, services.auth);
    await requireHotelPermission(db, actor, hotelUid, "stockcounts", "update", tx, services.auth);
    await requireHotelSubscription(db, hotelUid, tx, "procurement");
    await requireSaasRollout(db, tx);
    const countPath = `hotels/${hotelUid}/stockCounts/${stockCountId}`;
    const [parent, location] = await tx.getAll(db.doc(countPath), db.doc(`${countPath}/locations/${locationId}`));
    if (!parent.exists || !location.exists || !Array.isArray(parent.data().locations)
      || !parent.data().locations.some((row) => row.locationId === locationId)) throw new HttpsError("not-found", "Stock count destination not found in this hotel.");
    const count = parent.data(), frozen = location.data();
    if (count.inventoryPolicyVersion !== 1 || frozen.inventoryPolicyVersion !== 1
      || count.currency !== frozen.currency || count.businessDate !== frozen.businessDate) {
      throw new HttpsError("failed-precondition", "The stock count snapshot policy needs reconciliation.");
    }
    if (!["Started", "In Progress"].includes(count.status) || !["Not Started", "In Progress"].includes(frozen.status)) {
      throw new HttpsError("failed-precondition", "Products can be added only to an unfinished catalog count.");
    }
    const response = { hotelUid, stockCountId, locationId, inventoryPolicyVersion: 1, products: [], nextCursor: null };
    if (barcode) {
      const catalogIds = new Set(), offersByCatalog = new Map();
      const recordMatches = (offers) => {
        for (const row of offers) {
          const offer = row.data();
          if (isArchived(offer) || offer.active !== true || offer.productPolicyVersion !== 1 || !offer.catalogProductId) continue;
          if (!Array.isArray(offer.purchaseOptions || []) || (offer.purchaseOptions || []).length > 20) throw new HttpsError("failed-precondition", "Supplier package barcode metadata needs review.");
          if (![offer.gtin, ...(offer.purchaseOptions || []).map((option) => option?.gtin)].some((code) => barcodeText(code) === barcode)) continue;
          const id = requireDocumentId(offer.catalogProductId, "Stored catalog product ID");
          catalogIds.add(id); offersByCatalog.set(id, [...(offersByCatalog.get(id) || []), offer]);
        }
      };
      let query = db.collection(`hotels/${hotelUid}/supplierproducts`).orderBy(admin.firestore.FieldPath.documentId()).limit(BARCODE_PAGE_SIZE + 1);
      if (after) {
        const cursor = await tx.get(db.doc(`hotels/${hotelUid}/supplierproducts/${after}`));
        if (!cursor.exists) throw new HttpsError("failed-precondition", "Barcode pagination changed. Scan the code again.");
        query = query.startAfter(cursor);
      } else {
        // Exact catalog/default-package matches are available on the first page;
        // remaining pages still reconcile all optional package barcode metadata.
        const [catalogMatches, defaultMatches] = await Promise.all([
          tx.get(db.collection(`hotels/${hotelUid}/catalogproducts`).where("gtin", "==", barcode).orderBy(admin.firestore.FieldPath.documentId()).limit(PAGE_SIZE + 1)),
          tx.get(db.collection(`hotels/${hotelUid}/supplierproducts`).where("gtin", "==", barcode).orderBy(admin.firestore.FieldPath.documentId()).limit(BARCODE_PAGE_SIZE + 1)),
        ]);
        if (catalogMatches.docs.length > PAGE_SIZE || defaultMatches.docs.length > BARCODE_PAGE_SIZE) throw new HttpsError("resource-exhausted", "This barcode matches too many products. Search by product name and review duplicate barcode metadata.");
        catalogMatches.docs.forEach((row) => catalogIds.add(row.id)); recordMatches(defaultMatches.docs);
      }
      const snapshot = await tx.get(query), page = snapshot.docs.slice(0, BARCODE_PAGE_SIZE);
      recordMatches(page);
      const catalogs = catalogIds.size ? await tx.getAll(...[...catalogIds].map((id) => db.doc(`hotels/${hotelUid}/catalogproducts/${id}`))) : [];
      for (const row of catalogs) {
        if (!row.exists || isArchived(row.data()) || row.data().inventoryTracked !== true) continue;
        const product = projectProduct(row);
        if (search && !product.name.toLowerCase().startsWith(search)) continue;
        if (barcodeText(row.data().gtin) !== barcode && !(offersByCatalog.get(row.id) || []).some((offer) => compatibleUnits(offer.baseUnit, product.baseUnit))) continue;
        response.products.push({ ...product, barcodes: [...new Set([...product.barcodes, barcode])].sort() });
      }
      if (response.products.length > PAGE_SIZE) throw new HttpsError("resource-exhausted", "This barcode matches too many products. Search by product name and review duplicate barcode metadata.");
      response.products.sort((a, b) => a.id.localeCompare(b.id));
      response.nextCursor = snapshot.docs.length > BARCODE_PAGE_SIZE ? `barcode:${Buffer.from(page.at(-1).id, "utf8").toString("base64url")}` : null;
      return response;
    }
    let query = db.collection(`hotels/${hotelUid}/catalogproducts`);
    query = search ? query.where("nameLower", ">=", search).where("nameLower", "<=", `${search}\uf8ff`).orderBy("nameLower") : query;
    query = query.orderBy(admin.firestore.FieldPath.documentId()).limit(PAGE_SIZE + 1);
    if (after) {
      const cursor = await tx.get(db.doc(`hotels/${hotelUid}/catalogproducts/${after}`));
      if (!cursor.exists || search && (typeof cursor.data().nameLower !== "string" || !cursor.data().nameLower.startsWith(search))) throw new HttpsError("failed-precondition", "Product pagination changed. Reload the product choices.");
      query = query.startAfter(cursor);
    }
    const snapshot = await tx.get(query), page = snapshot.docs.slice(0, PAGE_SIZE), products = [];
    for (const row of page) {
      const data = row.data();
      if (isArchived(data) || data.inventoryTracked !== true) continue;
      products.push(projectProduct(row));
    }
    return { ...response, products,
      nextCursor: snapshot.docs.length > PAGE_SIZE ? page.at(-1).id : null };
  });
}

module.exports = { listHotelStockCountProductsHandler,
  listHotelStockCountProducts: onCall({ region: "us-central1", cors: true, maxInstances: 5, concurrency: 8, timeoutSeconds: 120 }, gated(listHotelStockCountProductsHandler)) };
