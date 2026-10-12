const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { admin } = require("./config");
const { requireHotelPermission } = require("./authorization");
const { requireDocumentId, requireHotelSubscription } = require("./subscriptions");
const { text, revision, digest } = require("./validation");
const { gated, enforceRequestRollout } = require("./saasRollout");
const inventory = require("./inventoryPolicy");
const movements = require("./inventoryMovements");
const { compatibleUnits } = require("./productPolicy");
const { validTimeZone } = require("./hotelSetupPolicy");
const { localDate } = require("./importMonitoringPolicy");

const TYPES = ["Ad Hoc", "Daily", "Weekly", "Month-End"];
const MAX_LOCATIONS = 50;
const MAX_ITEMS = 250;
const MAX_DOCUMENT_BYTES = 750000;
const stamp = () => admin.firestore.FieldValue.serverTimestamp();
const key = (item) => item.catalogProductId ? `catalog:${item.catalogProductId}` : JSON.stringify([item.supplierProductId, item.outletId]);
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
    status: location.status, ...(location.inventoryPolicyVersion === 1 ? { inventoryPolicyVersion: 1,
      currency: location.currency, ...inventory.valuation(location.countedItems || []),
      checkpointId: location.checkpointId || null, checkpointSequence: location.checkpointSequence || null }
      : { countedValue: canonicalValue(location.countedItems || []) }) };
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
async function canonicalInventoryItem(db, tx, hotelUid, identity, hotelCurrency) {
  let catalogProductId;
  if (identity.catalogProductId) catalogProductId = requireDocumentId(identity.catalogProductId, "catalogProductId");
  else {
    const legacy = itemIdentity(identity, "Template");
    const [supplier, outlet] = await Promise.all([tx.get(db.doc(`hotels/${hotelUid}/supplierproducts/${legacy.supplierProductId}`)),
      tx.get(db.doc(`hotels/${hotelUid}/outlets/${legacy.outletId}`))]);
    if (!supplier.exists || !outlet.exists || !supplier.data().catalogProductId) throw new HttpsError("failed-precondition", `Template supplier product ${legacy.supplierProductId} needs a valid catalog link in this hotel.`);
    catalogProductId = requireDocumentId(supplier.data().catalogProductId, "Stored catalogProductId");
    const catalog = await tx.get(db.doc(`hotels/${hotelUid}/catalogproducts/${catalogProductId}`));
    if (!catalog.exists || !compatibleUnits(supplier.data().baseUnit, catalog.data().baseUnit)) throw new HttpsError("failed-precondition", `Template supplier product ${legacy.supplierProductId} has an incompatible or missing catalog unit.`);
  }
  const catalog = await tx.get(db.doc(`hotels/${hotelUid}/catalogproducts/${catalogProductId}`));
  if (!catalog.exists || catalog.data().inventoryTracked !== true || catalog.data().active === false || catalog.data().archived === true) throw new HttpsError("failed-precondition", `Catalog product ${catalogProductId} must be active and explicitly tracked for inventory.`);
  return { catalogProductId, catalogProductName: text(catalog.data().name, "Catalog product name", 200, true),
    baseUnit: inventory.unit(catalog.data().baseUnit), currency: hotelCurrency, unitCost: null };
}
async function authorize(db, tx, request, hotelUid, action, services) {
  await requireHotelPermission(db, { ...request }, hotelUid, "stockcounts", action, tx, services.auth);
  // Operational counts require an active hotel even for platform operators.
  await requireHotelSubscription(db, hotelUid, tx, "procurement");
  await enforceRequestRollout(db, request, tx);
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
      templates: templates.docs.filter((template) => template.data().archived !== true).map((template) => ({ id: template.id, name: text(template.data().name, "Template name", 200, true) })) };
  }));
  return { locations, nextCursor: snapshot.docs.length > MAX_LOCATIONS ? page.at(-1).id : null };
}
async function createHotelStockCountHandler(request, services = {}) {
  const input = strictObject(request.data, ["hotelUid", "name", "type", "locations", "requestId", "businessDate"], "Stock count");
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
  const fingerprint = digest(name, input.type, requested, input.businessDate ?? null);
  const db = services.firestore || admin.firestore();
  const countRef = db.doc(`hotels/${hotelUid}/stockCounts/${stockCountId}`);
  return db.runTransaction(async (tx) => {
    await authorize(db, tx, request, hotelUid, "create", services);
    const existing = await tx.get(countRef);
    if (existing.exists) {
      if (existing.data().creationFingerprint !== fingerprint) throw new HttpsError("already-exists", "This request ID was already used with different count details.");
      return { hotelUid, inventoryPolicyVersion: existing.data().inventoryPolicyVersion || null, stockCountId, revision: existing.data().revision, status: existing.data().status };
    }
    try {
    const [hotel, bootstrap] = await Promise.all([tx.get(db.doc(`hotels/${hotelUid}`)), tx.get(db.doc(`hotels/${hotelUid}/settings/bootstrap`))]);
    if (!hotel.exists) throw new HttpsError("failed-precondition", "Hotel settings are unavailable.");
    const hotelCurrency = inventory.currency(bootstrap.exists ? bootstrap.data().currency : hotel.data().currency);
    if (bootstrap.exists && hotel.data().currency != null && hotel.data().currency !== hotelCurrency) throw new HttpsError("failed-precondition", "Hotel currency settings disagree. Reconcile them before starting a count.");
    let businessDate = input.businessDate;
    if (businessDate == null) {
      if (!validTimeZone(hotel.data().timeZone)) throw new HttpsError("failed-precondition", "Set the hotel time zone or provide an explicit inventory business date.");
      businessDate = localDate(services.now?.() ?? Date.now(), hotel.data().timeZone);
    }
    businessDate = inventory.businessDate(businessDate);
    const today = validTimeZone(hotel.data().timeZone) ? localDate(services.now?.() ?? Date.now(), hotel.data().timeZone) : new Date(services.now?.() ?? Date.now()).toISOString().slice(0, 10);
    if (businessDate > today) throw new HttpsError("invalid-argument", "A physical stock count cannot have a future business date.");
    const locations = [];
    let itemCount = 0;
    for (const requestedLocation of requested) {
      const { locationId, stockTemplateId } = requestedLocation;
      const [location, template] = await Promise.all([
        tx.get(db.doc(`hotels/${hotelUid}/locations/${locationId}`)),
        tx.get(db.doc(`hotels/${hotelUid}/locations/${locationId}/stockTemplates/${stockTemplateId}`)),
      ]);
      if (!location.exists || !template.exists) throw new HttpsError("not-found", "Location or stock template not found in this hotel.");
      if (template.data().archived === true) throw new HttpsError("failed-precondition", "Choose an active stock template.");
      const identities = boundedArray(template.data().items, "Stored template items", 1);
      itemCount += identities.length;
      if (itemCount > 1000) throw new HttpsError("resource-exhausted", "Split counts exceeding 1,000 template items into smaller counts.");
      const resolved = await Promise.all(identities.map((identity) => canonicalInventoryItem(db, tx, hotelUid, identity, hotelCurrency)));
      const items = [...new Map(resolved.map((item) => [item.catalogProductId, item])).values()];
      const countingStartedSequence = await movements.readLocationSequence(db, tx, hotelUid, locationId);
      locations.push(boundDocument({ id: locationId, locationId,
        inventoryPolicyVersion: 1, currency: hotelCurrency, businessDate, countingStartedSequence,
        locationName: text(location.data().name, "Location name", 200, true), stockTemplateId,
        stockTemplateName: text(template.data().name, "Template name", 200, true),
        stockTemplate: { id: stockTemplateId, name: template.data().name, items },
        countedItems: [], countedValue: null, knownCountedValue: 0, costComplete: false, status: "Not Started", revision: 0,
        createdBy: request.auth.uid, createdAt: stamp() }));
    }
    tx.create(countRef, boundDocument({ id: stockCountId, name, type: input.type, status: "Started",
      inventoryPolicyVersion: 1, currency: hotelCurrency, businessDate,
      locations: locations.map(summary), countedValue: null, revision: 0,
      creationFingerprint: fingerprint, createdBy: request.auth.uid, createdAt: stamp() }));
    for (const location of locations) tx.create(db.doc(`${countRef.path}/locations/${location.locationId}`), location);
    return { hotelUid, inventoryPolicyVersion: 1, stockCountId, revision: 0, status: "Started" };
    } catch (error) {
      if (error instanceof HttpsError) throw new HttpsError(error.code, error.message, { countRequestUncommitted: true });
      throw error;
    }
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
  let countedItems = null;
  const additions = input.action === "finish-location" ? unique(boundedArray(input.templateItemsToAdd || [], "templateItemsToAdd").map((item) => {
    strictObject(item, ["supplierProductId", "outletId", "catalogProductId"], "templateItemsToAdd");
    return item.catalogProductId ? { catalogProductId: requireDocumentId(item.catalogProductId, "catalogProductId") } : itemIdentity(item, "templateItemsToAdd");
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
    const canonical = data.inventoryPolicyVersion === 1;
    if (["save-location", "finish-location"].includes(input.action)) countedItems = canonical ? inventory.countItems(input.countedItems) : countsInput(input.countedItems);
    if (additions.some((item) => Boolean(item.catalogProductId) !== canonical)) throw new HttpsError("invalid-argument", "Template additions must use the count's product identity policy.");
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
    if (canonical && locations.some((location) => location.inventoryPolicyVersion !== 1 || location.currency !== data.currency
      || location.businessDate !== data.businessDate)) throw new HttpsError("failed-precondition", "Catalog count location policy, currency or business date needs reconciliation.");
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
      const byKey = new Map([...templateItems, ...(current.countedItems || [])].map((item) => [key(item), item]));
      if (countedItems) {
        if (canonical && (current.countedItems || []).some((item) => !countedItems.some((next) => next.catalogProductId === item.catalogProductId))) {
          throw new HttpsError("failed-precondition", "Previously included catalog products must remain in this count; explicitly count zero when absent.");
        }
        const nextItems = [];
        // Firestore transforms cannot occur inside array elements.
        const countedAt = admin.firestore.Timestamp.now();
        for (const item of countedItems) {
          const snapshotted = byKey.get(key(item));
          const source = snapshotted || (canonical ? await canonicalInventoryItem(db, tx, hotelUid, item, inventory.currency(data.currency)) : await canonicalCatalogItem(db, tx, hotelUid, item));
          nextItems.push({ ...source, quantity: item.quantity, isCounted: item.isCounted,
            ...(canonical ? { unitCost: item.unitCost, costSource: item.unitCost == null ? "unknown" : "operator-opening-estimate",
              totalValue: !item.isCounted || item.unitCost == null && item.quantity > 0 ? null : inventory.money(item.quantity * (item.unitCost || 0)) }
              : { totalValue: item.isCounted ? Math.round(item.quantity * source.pricePerPurchaseUnit * 10000) / 10000 : 0 }),
            isTemplateItem: templateItems.some((entry) => key(entry) === key(item)), countedBy: request.auth.uid, countedAt });
        }
        current.countedItems = nextItems;
      }
      if (canonical) {
        Object.assign(current, inventory.valuation(current.countedItems || []));
        if (input.action === "finish-location") inventory.completeCount(templateItems, current.countedItems || []);
      } else {
        current.countedValue = canonicalValue(current.countedItems || []);
        if (input.action === "finish-location") {
          const countedByKey = new Map((current.countedItems || []).map((item) => [key(item), item]));
          if (templateItems.some((item) => countedByKey.get(key(item))?.isCounted !== true)
            || (current.countedItems || []).some((item) => item.isCounted !== true)) throw new HttpsError("failed-precondition", "Explicitly count every included historical product, including zero, before finishing this location.");
        }
      }
      current.status = input.action === "finish-location" ? "Finished" : input.action === "set-location-status"
        ? input.status : current.countedItems.length ? "In Progress" : "Not Started";
      if (current.status === "Not Started" && (current.countedItems || []).length) throw new HttpsError("failed-precondition", "A location with counted items cannot be reset to Not Started.");
      current.updatedAt = stamp(); current.updatedBy = request.auth.uid;
      current.revision = (current.revision || 0) + 1;
      if (current.status === "Finished") { current.finishedAt = stamp(); current.finishedBy = request.auth.uid; }
      const checkpoint = canonical && input.action === "finish-location" ? await movements.prepareCheckpoint(db, tx, {
        hotelUid, locationId, stockCountId, stockCountName: data.name, currency: data.currency,
        businessDate: data.businessDate, countingStartedSequence: current.countingStartedSequence,
        items: current.countedItems, actorUid: request.auth.uid,
      }) : null;
      if (checkpoint) { current.checkpointId = checkpoint.checkpointId; current.checkpointSequence = checkpoint.sequence; }
      if (additions.length) {
        const templateRef = db.doc(`hotels/${hotelUid}/locations/${locationId}/stockTemplates/${requireDocumentId(current.stockTemplateId, "Stored template ID")}`);
        const template = await tx.get(templateRef);
        if (!template.exists) throw new HttpsError("failed-precondition", "The source template no longer exists. Finish without template additions.");
        if (template.data().archived === true) throw new HttpsError("failed-precondition", "The source template is archived. Finish without template additions.");
        const templateRevision = template.data().revision ?? 0;
        if (!Number.isSafeInteger(templateRevision) || templateRevision < 0 || templateRevision >= Number.MAX_SAFE_INTEGER) throw new HttpsError("failed-precondition", "The source template revision needs review.");
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
            newItems.push(canonical ? { catalogProductId: identity.catalogProductId } : { ...templateItem, isTemplateItem: true });
          }
        }
        const nextTemplateItems = boundedArray([...existingItems, ...newItems], "Updated template items");
        // Read the live template before writes; never replace concurrent changes with a stale snapshot.
        tx.update(templateRef, boundDocument({ items: nextTemplateItems, revision: templateRevision + 1, updatedAt: stamp(), updatedBy: request.auth.uid }));
      }
      if (checkpoint) checkpoint.write();
      tx.set(db.doc(`${countRef.path}/locations/${locationId}`), boundDocument(current));
    }
    const summaries = locations.map(summary);
    const countedValue = canonical && summaries.some((location) => location.countedValue == null) ? null
      : Math.round(summaries.reduce((sum, location) => sum + location.countedValue, 0) * 10000) / 10000;
    if (countedValue != null && (!Number.isFinite(countedValue) || countedValue > 1e12)) throw new HttpsError("resource-exhausted", "Stock valuation exceeds the supported bound.");
    const status = input.action === "finish-count" ? "Finished" : locations.some((location) => location.status !== "Not Started") ? "In Progress" : "Started";
    const nextRevision = expectedRevision + 1;
    tx.update(countRef, boundDocument({ locations: summaries, countedValue, status, revision: nextRevision,
      updatedBy: request.auth.uid, updatedAt: stamp(),
      ...(status === "Finished" ? { finishedBy: request.auth.uid, finishedAt: stamp() } : {}) }));
    return { hotelUid, inventoryPolicyVersion: canonical ? 1 : null, stockCountId, status, countedValue, revision: nextRevision };
  });
}
const options = { region: "us-central1", cors: true, maxInstances: 5, concurrency: 8, timeoutSeconds: 120 };
module.exports = { countsInput, canonicalValue, createHotelStockCountHandler, mutateHotelStockCountHandler,
  listHotelStockCountSourcesHandler, listHotelStockCountSources: onCall(options, gated(listHotelStockCountSourcesHandler)),
  createHotelStockCount: onCall(options, gated(createHotelStockCountHandler)),
  mutateHotelStockCount: onCall(options, gated(mutateHotelStockCountHandler)) };
