const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { admin } = require("./config");
const { requireHotelPermission } = require("./authorization");
const { requireDocumentId, requireHotelSubscription } = require("./subscriptions");
const { text, revision, digest } = require("./validation");
const { gated } = require("./saasRollout");

const TYPES = ["Ad Hoc", "Daily", "Weekly", "Month-End"];
const MAX_LOCATIONS = 50;
const MAX_ITEMS = 250;
const MAX_DOCUMENT_BYTES = 750000;
const stamp = () => admin.firestore.FieldValue.serverTimestamp();
const key = (item) => JSON.stringify([item.supplierProductId, item.outletId]);
function strictObject(value, fields, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((name) => !fields.includes(name))) {
    throw new HttpsError("invalid-argument", `${field} contains unsupported fields.`);
  }
  return value;
}
function boundedArray(value, field, minimum = 0, maximum = MAX_ITEMS) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new HttpsError("invalid-argument", `${field} must contain ${minimum}–${maximum} entries.`);
  }
  return value;
}
function itemIdentity(value, field) {
  return { supplierProductId: requireDocumentId(value.supplierProductId, `${field}.supplierProductId`),
    outletId: requireDocumentId(value.outletId, `${field}.outletId`) };
}
function unique(items, field) {
  if (new Set(items.map(key)).size !== items.length) throw new HttpsError("invalid-argument", `${field} contains duplicates.`);
  return items;
}
function countsInput(value) {
  return unique(boundedArray(value, "countedItems").map((item) => {
    strictObject(item, ["supplierProductId", "outletId", "quantity", "isCounted"], "countedItems");
    const quantity = item.quantity;
    if (typeof quantity !== "number" || !Number.isFinite(quantity) || quantity < 0 || quantity > 1000000
      || Math.abs(quantity * 1000 - Math.round(quantity * 1000)) > 1e-6
      || typeof item.isCounted !== "boolean" || (!item.isCounted && quantity !== 0)) {
      throw new HttpsError("invalid-argument", "Quantity must be a non-negative number with at most three decimals; uncounted items must be zero.");
    }
    return { ...itemIdentity(item, "countedItems"), quantity, isCounted: item.isCounted };
  }), "countedItems");
}
function summary(location) {
  return { locationId: location.locationId, locationName: location.locationName,
    stockTemplateId: location.stockTemplateId, stockTemplateName: location.stockTemplateName,
    status: location.status, countedValue: canonicalValue(location.countedItems || []) };
}
function canonicalValue(items) {
  let sum = 0;
  for (const item of items) {
    if (typeof item.quantity !== "number" || !Number.isFinite(item.quantity) || item.quantity < 0
      || typeof item.pricePerPurchaseUnit !== "number" || !Number.isFinite(item.pricePerPurchaseUnit) || item.pricePerPurchaseUnit < 0) {
      throw new HttpsError("failed-precondition", "Stored stock quantities or prices need operator review.");
    }
    sum += item.isCounted === false ? 0 : Math.round(item.quantity * item.pricePerPurchaseUnit * 10000) / 10000;
  }
  if (!Number.isFinite(sum) || sum > 1e12) throw new HttpsError("resource-exhausted", "Stock valuation exceeds the supported bound.");
  return Math.round(sum * 10000) / 10000;
}
function boundDocument(value) {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_DOCUMENT_BYTES) throw new HttpsError("resource-exhausted", "Stock snapshot is too large.");
  return value;
}
async function canonicalCatalogItem(db, tx, hotelUid, identity) {
  const [product, outlet] = await Promise.all([
    tx.get(db.doc(`hotels/${hotelUid}/supplierproducts/${identity.supplierProductId}`)),
    tx.get(db.doc(`hotels/${hotelUid}/outlets/${identity.outletId}`)),
  ]);
  if (!product.exists || !outlet.exists) throw new HttpsError("failed-precondition", "A supplier product or outlet no longer exists in this hotel.");
  const data = product.data();
  const price = data.pricePerPurchaseUnit;
  if (typeof price !== "number" || !Number.isFinite(price) || price < 0 || price > 1000000) {
    throw new HttpsError("failed-precondition", "A supplier product needs a valid purchase-unit price before counting.");
  }
  const label = (value) => typeof value === "string" ? value.slice(0, 200) : "";
  const baseUnits = data.baseUnitsPerPurchaseUnit;
  return { ...identity, supplierProductName: label(data.supplierProductName || data.name),
    supplierName: label(data.supplierName), pricePerPurchaseUnit: price,
    baseUnitsPerPurchaseUnit: typeof baseUnits === "number" && Number.isFinite(baseUnits) ? baseUnits : label(baseUnits),
    baseUnit: label(data.baseUnit), purchaseUnit: label(data.purchaseUnit), content: label(data.content),
    outletName: label(outlet.data().name || identity.outletId) };
}
async function authorize(db, tx, request, hotelUid, action, services) {
  await requireHotelPermission(db, request, hotelUid, "stockcounts", action, tx, services.auth);
  // Operational counts require an active hotel even for platform operators.
  await requireHotelSubscription(db, hotelUid, tx, "procurement");
}
async function listHotelStockCountSourcesHandler(request, services = {}) {
  const input = strictObject(request.data, ["hotelUid", "afterLocationId"], "Stock sources");
  const hotelUid = requireDocumentId(input.hotelUid, "hotelUid");
  const afterLocationId = input.afterLocationId == null ? null : requireDocumentId(input.afterLocationId, "afterLocationId");
  const db = services.firestore || admin.firestore();
  await authorize(db, undefined, request, hotelUid, "create", services);
  let query = db.collection(`hotels/${hotelUid}/locations`).orderBy(admin.firestore.FieldPath.documentId());
  if (afterLocationId) query = query.startAfter(afterLocationId);
  const snapshot = await query.limit(MAX_LOCATIONS + 1).get();
  const page = snapshot.docs.slice(0, MAX_LOCATIONS);
  const locations = await Promise.all(page.map(async (location) => {
    const templates = await db.collection(`${location.ref.path}/stockTemplates`).orderBy(admin.firestore.FieldPath.documentId()).limit(MAX_ITEMS + 1).get();
    if (templates.docs.length > MAX_ITEMS) throw new HttpsError("resource-exhausted", "A location has more than 250 templates; operator review is required.");
    return { locationId: location.id, locationName: text(location.data().name, "Location name", 200, true),
      templates: templates.docs.map((template) => ({ id: template.id, name: text(template.data().name, "Template name", 200, true) })) };
  }));
  return { locations, nextCursor: snapshot.docs.length > MAX_LOCATIONS ? page.at(-1).id : null };
}
async function createHotelStockCountHandler(request, services = {}) {
  const input = strictObject(request.data, ["hotelUid", "name", "type", "locations", "requestId"], "Stock count");
  const hotelUid = requireDocumentId(input.hotelUid, "hotelUid");
  const name = text(input.name, "Name", 200, true);
  if (!TYPES.includes(input.type)) throw new HttpsError("invalid-argument", "Choose a supported stock count type.");
  const requested = boundedArray(input.locations, "locations", 1, MAX_LOCATIONS).map((value) => {
    strictObject(value, ["locationId", "stockTemplateId"], "locations");
    return { locationId: requireDocumentId(value.locationId, "locationId"),
      stockTemplateId: requireDocumentId(value.stockTemplateId, "stockTemplateId") };
  });
  if (new Set(requested.map((location) => location.locationId)).size !== requested.length) throw new HttpsError("invalid-argument", "Select each location once.");
  const requestId = requireDocumentId(input.requestId, "requestId");
  const stockCountId = digest(request.auth?.uid || "", hotelUid, requestId).slice(0, 40);
  const fingerprint = digest(name, input.type, requested);
  const db = services.firestore || admin.firestore();
  const countRef = db.doc(`hotels/${hotelUid}/stockCounts/${stockCountId}`);
  return db.runTransaction(async (tx) => {
    await authorize(db, tx, request, hotelUid, "create", services);
    const existing = await tx.get(countRef);
    if (existing.exists) {
      if (existing.data().creationFingerprint !== fingerprint) throw new HttpsError("already-exists", "This request ID was already used with different count details.");
      return { stockCountId, revision: existing.data().revision, status: existing.data().status };
    }
    const locations = [];
    let itemCount = 0;
    for (const requestedLocation of requested) {
      const { locationId, stockTemplateId } = requestedLocation;
      const [location, template] = await Promise.all([
        tx.get(db.doc(`hotels/${hotelUid}/locations/${locationId}`)),
        tx.get(db.doc(`hotels/${hotelUid}/locations/${locationId}/stockTemplates/${stockTemplateId}`)),
      ]);
      if (!location.exists || !template.exists) throw new HttpsError("not-found", "Location or stock template not found in this hotel.");
      const identities = unique(boundedArray(template.data().items, "Stored template items").map((item) => itemIdentity(item, "Template")), "Template items");
      itemCount += identities.length;
      if (itemCount > 1000) throw new HttpsError("resource-exhausted", "Split counts exceeding 1,000 template items into smaller counts.");
      const items = await Promise.all(identities.map((identity) => canonicalCatalogItem(db, tx, hotelUid, identity)));
      locations.push(boundDocument({ id: locationId, locationId,
        locationName: text(location.data().name, "Location name", 200, true), stockTemplateId,
        stockTemplateName: text(template.data().name, "Template name", 200, true),
        stockTemplate: { id: stockTemplateId, name: template.data().name, items },
        countedItems: [], countedValue: 0, status: "Not Started", revision: 0,
        createdBy: request.auth.uid, createdAt: stamp() }));
    }
    tx.create(countRef, boundDocument({ id: stockCountId, name, type: input.type, status: "Started",
      locations: locations.map(summary), countedValue: 0, revision: 0,
      creationFingerprint: fingerprint, createdBy: request.auth.uid, createdAt: stamp() }));
    for (const location of locations) tx.create(db.doc(`${countRef.path}/locations/${location.locationId}`), location);
    return { stockCountId, revision: 0, status: "Started" };
  });
}
async function mutateHotelStockCountHandler(request, services = {}) {
  const action = request.data?.action;
  const input = strictObject(request.data, ["hotelUid", "stockCountId", "action", "expectedRevision",
    ...(action === "finish-count" ? [] : ["locationId"]),
    ...(["save-location", "finish-location"].includes(action) ? ["countedItems"] : []),
    ...(action === "finish-location" ? ["templateItemsToAdd"] : []),
    ...(action === "set-location-status" ? ["status"] : [])], "Stock mutation");
  const hotelUid = requireDocumentId(input.hotelUid, "hotelUid");
  const stockCountId = requireDocumentId(input.stockCountId, "stockCountId");
  const expectedRevision = revision(input.expectedRevision);
  if (!["save-location", "finish-location", "finish-count", "set-location-status"].includes(input.action)) throw new HttpsError("invalid-argument", "Unsupported stock mutation.");
  const locationId = input.action === "finish-count" ? null : requireDocumentId(input.locationId, "locationId");
  const countedItems = ["save-location", "finish-location"].includes(input.action) ? countsInput(input.countedItems) : null;
  const additions = input.action === "finish-location" ? unique(boundedArray(input.templateItemsToAdd || [], "templateItemsToAdd").map((item) => {
    strictObject(item, ["supplierProductId", "outletId"], "templateItemsToAdd");
    return itemIdentity(item, "templateItemsToAdd");
  }), "templateItemsToAdd") : [];
  if (input.action === "set-location-status" && !["Not Started", "In Progress"].includes(input.status)) throw new HttpsError("invalid-argument", "Finishing a location requires the dedicated finish command.");
  const db = services.firestore || admin.firestore();
  const countRef = db.doc(`hotels/${hotelUid}/stockCounts/${stockCountId}`);
  return db.runTransaction(async (tx) => {
    await authorize(db, tx, request, hotelUid, "update", services);
    if (additions.length) await requireHotelPermission(db, request, hotelUid, "locations", "update", tx, services.auth);
    const parent = await tx.get(countRef);
    if (!parent.exists) throw new HttpsError("not-found", "Stock count not found.");
    const data = parent.data();
    if (data.status === "Finished") throw new HttpsError("failed-precondition", "Finished stock counts are immutable.");
    if (!["Started", "In Progress"].includes(data.status)
      || (data.revision != null && (!Number.isSafeInteger(data.revision) || data.revision < 0))) {
      throw new HttpsError("failed-precondition", "Stock count state needs operator review.");
    }
    if ((data.revision || 0) !== expectedRevision) throw new HttpsError("aborted", "Stock count changed. Reload before saving.");
    const ids = boundedArray(data.locations, "Stored locations", 1, MAX_LOCATIONS).map((location) => requireDocumentId(location.locationId, "Stored location ID"));
    if (new Set(ids).size !== ids.length) throw new HttpsError("failed-precondition", "Stock count locations need operator review.");
    const snapshots = await Promise.all(ids.map((id) => tx.get(db.doc(`${countRef.path}/locations/${id}`))));
    if (snapshots.some((snapshot) => !snapshot.exists)) throw new HttpsError("failed-precondition", "A stock count location is missing.");
    const locations = snapshots.map((snapshot, index) => ({ ...snapshot.data(), locationId: ids[index] }));
    if (locations.some((location) => !["Not Started", "In Progress", "Finished"].includes(location.status))) {
      throw new HttpsError("failed-precondition", "Stock location state needs operator review.");
    }
    if (input.action === "finish-count") {
      if (locations.some((location) => location.status !== "Finished")) throw new HttpsError("failed-precondition", "Finish every location before finishing the stock count.");
    } else {
      const index = ids.indexOf(locationId);
      if (index < 0) throw new HttpsError("not-found", "Stock count location not found.");
      const current = locations[index];
      if (current.status === "Finished") throw new HttpsError("failed-precondition", "Finished stock count locations are immutable.");
      const templateItems = boundedArray(current.stockTemplate?.items, "Stored snapshot items");
      const byKey = new Map(templateItems.map((item) => [key(item), item]));
      if (countedItems) {
        const nextItems = [];
        // Firestore transforms cannot occur inside array elements.
        const countedAt = admin.firestore.Timestamp.now();
        for (const item of countedItems) {
          const snapshotted = byKey.get(key(item));
          const canonical = snapshotted || await canonicalCatalogItem(db, tx, hotelUid, item);
          nextItems.push({ ...canonical, quantity: item.quantity, isCounted: item.isCounted,
            totalValue: item.isCounted ? Math.round(item.quantity * canonical.pricePerPurchaseUnit * 10000) / 10000 : 0,
            isTemplateItem: Boolean(snapshotted), countedBy: request.auth.uid, countedAt });
        }
        current.countedItems = nextItems;
      }
      current.countedValue = canonicalValue(current.countedItems || []);
      current.status = input.action === "finish-location" ? "Finished" : input.action === "set-location-status"
        ? input.status : current.countedItems.length ? "In Progress" : "Not Started";
      if (current.status === "Not Started" && (current.countedItems || []).length) throw new HttpsError("failed-precondition", "A location with counted items cannot be reset to Not Started.");
      current.updatedAt = stamp(); current.updatedBy = request.auth.uid;
      current.revision = (current.revision || 0) + 1;
      if (current.status === "Finished") { current.finishedAt = stamp(); current.finishedBy = request.auth.uid; }
      if (additions.length) {
        const templateRef = db.doc(`hotels/${hotelUid}/locations/${locationId}/stockTemplates/${requireDocumentId(current.stockTemplateId, "Stored template ID")}`);
        const template = await tx.get(templateRef);
        if (!template.exists) throw new HttpsError("failed-precondition", "The source template no longer exists. Finish without template additions.");
        const existingItems = boundedArray(template.data().items, "Current template items");
        const existingKeys = new Set(existingItems.map(key));
        const countedByKey = new Map(current.countedItems.map((item) => [key(item), item]));
        const newItems = [];
        for (const identity of additions) {
          const counted = countedByKey.get(key(identity));
          if (!counted) throw new HttpsError("invalid-argument", "Only recorded stock items can be added to the template.");
          if (!existingKeys.has(key(identity))) {
            existingKeys.add(key(identity));
            const { quantity: _quantity, totalValue: _totalValue, countedAt: _at, countedBy: _by,
              isCounted: _counted, ...templateItem } = counted;
            newItems.push({ ...templateItem, isTemplateItem: true });
          }
        }
        const nextTemplateItems = boundedArray([...existingItems, ...newItems], "Updated template items");
        // Read the live template before writes; never replace concurrent changes with a stale snapshot.
        tx.update(templateRef, boundDocument({ items: nextTemplateItems, updatedAt: stamp(), updatedBy: request.auth.uid }));
      }
      tx.set(db.doc(`${countRef.path}/locations/${locationId}`), boundDocument(current));
    }
    const summaries = locations.map(summary);
    const countedValue = Math.round(summaries.reduce((sum, location) => sum + location.countedValue, 0) * 10000) / 10000;
    if (!Number.isFinite(countedValue) || countedValue > 1e12) throw new HttpsError("resource-exhausted", "Stock valuation exceeds the supported bound.");
    const status = input.action === "finish-count" ? "Finished" : locations.some((location) => location.status !== "Not Started") ? "In Progress" : "Started";
    const nextRevision = expectedRevision + 1;
    tx.update(countRef, boundDocument({ locations: summaries, countedValue, status, revision: nextRevision,
      updatedBy: request.auth.uid, updatedAt: stamp(),
      ...(status === "Finished" ? { finishedBy: request.auth.uid, finishedAt: stamp() } : {}) }));
    return { stockCountId, status, countedValue, revision: nextRevision };
  });
}
const options = { region: "us-central1", cors: true, maxInstances: 5, concurrency: 8, timeoutSeconds: 120 };
module.exports = { countsInput, canonicalValue, createHotelStockCountHandler, mutateHotelStockCountHandler,
  listHotelStockCountSourcesHandler, listHotelStockCountSources: onCall(options, gated(listHotelStockCountSourcesHandler)),
  createHotelStockCount: onCall(options, gated(createHotelStockCountHandler)),
  mutateHotelStockCount: onCall(options, gated(mutateHotelStockCountHandler)) };
