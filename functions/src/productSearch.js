const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { admin, MEILI_API_KEY, MEILI_HOST, MEILI_INDEX, SUPPLIER_PRODUCTS_INDEX_UID, logger } = require("./config");
const { meiliJson, getIndexUid } = require("./common");
const { requireHotelPermission } = require("./authorization");
const { requireDocumentId } = require("./subscriptions");

function boundedString(value, maximum = 128) {
  if (value == null) return "";
  if (typeof value !== "string" || value.length > maximum) throw new HttpsError("invalid-argument", "Invalid search field.");
  return value.trim();
}

function buildSearchRequest(input) {
  const hotelUid = requireDocumentId(input.hotelUid, "hotelUid");
  const collection = input.collection;
  if (!["catalogproducts", "supplierproducts"].includes(collection)) throw new HttpsError("invalid-argument", "Invalid product collection.");
  const limit = input.pageSize ?? 50;
  const offset = input.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0 || offset > 10000) {
    throw new HttpsError("invalid-argument", "Invalid search pagination.");
  }
  const criteria = input.criteria || {};
  const filter = [`hotelUid = ${JSON.stringify(hotelUid)}`];
  const fields = collection === "catalogproducts" ? ["category", "subcategory"] : ["supplierId"];
  for (const field of fields) {
    const value = boundedString(criteria[field]);
    if (value) filter.push(`${field} = ${JSON.stringify(value)}`);
  }
  if (collection === "supplierproducts" && typeof criteria.active === "boolean") filter.push(`active = ${criteria.active}`);
  return { hotelUid, collection, body: { q: boundedString(criteria.searchTerm, 500), filter, limit, offset,
    ...(collection === "supplierproducts" ? { attributesToSearchOn: ["supplierName", "supplierSku", "supplierProductName"] } : {}) } };
}

async function searchHotelProductsHandler(request, services = {}) {
  const query = buildSearchRequest(request.data || {});
  const db = services.firestore || admin.firestore();
  await requireHotelPermission(db, request, query.hotelUid, query.collection, "read", undefined, services.auth);
  let payload;
  try {
    payload = await (services.search || ((body) => {
      const index = query.collection === "catalogproducts" ? getIndexUid() : SUPPLIER_PRODUCTS_INDEX_UID;
      return meiliJson(`/indexes/${encodeURIComponent(index)}/search`, { method: "POST", body });
    }))(query.body);
  } catch (error) {
    logger.warn("Product search unavailable", { hotelUid: query.hotelUid, collection: query.collection });
    throw new HttpsError("unavailable", "Search is temporarily unavailable.");
  }
  const hits = Array.isArray(payload?.hits) ? payload.hits.slice(0, query.body.limit) : [];
  const ids = [...new Set(hits.filter((hit) => hit.hotelUid === query.hotelUid).map((hit) => hit.documentId || hit.id))]
    .filter((id) => typeof id === "string" && id.length <= 128 && id && !id.includes("/") && ![".", ".."].includes(id));
  // Never return indexed customer data directly. Hydrate only documents from the
  // authorized hotel's canonical Firestore collection, including for stale hits.
  const snapshots = await Promise.all(ids.map((id) => db.doc(`hotels/${query.hotelUid}/${query.collection}/${id}`).get()));
  const products = snapshots.filter((snapshot) => snapshot.exists).map((snapshot) => ({ ...snapshot.data(), id: snapshot.id }));
  const nextOffset = query.body.offset + hits.length;
  const hasMore = hits.length > 0 && nextOffset < Math.min(Number(payload?.estimatedTotalHits || 0), 10000);
  return { products, cursor: hasMore ? { offset: nextOffset } : null, hasMore };
}

const searchHotelProducts = onCall({ region: "us-central1", cors: true,
  secrets: [MEILI_API_KEY, MEILI_HOST, MEILI_INDEX], timeoutSeconds: 30 }, searchHotelProductsHandler);
module.exports = { buildSearchRequest, searchHotelProductsHandler, searchHotelProducts };
