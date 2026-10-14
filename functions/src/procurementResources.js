const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { admin } = require("./config");
const { requireHotelPermission } = require("./authorization");
const { requireDocumentId } = require("./subscriptions");
const { revision, digest, text } = require("./validation");
const { gated, requireSaasRollout } = require("./saasRollout");

const stamp = () => admin.firestore.FieldValue.serverTimestamp();
const isArchived = (resource) => resource?.archived === true || resource?.active === false;
const outletStockPointId = (outletId) => requireDocumentId(`outlet:${requireDocumentId(outletId, "outletId")}`, "Outlet stock point ID");
function inventoryRole(value) {
  const role = value ?? "outlet";
  if (!["outlet", "central_storage"].includes(role)) throw new HttpsError("invalid-argument", "Choose an outlet or central storage inventory role.");
  return role;
}
function assertOutletStockPoint(locationId, source, outletId) {
  if (source && (locationId !== outletStockPointId(outletId) || source.stockPointPolicyVersion !== 1
    || source.stockPointType !== "outlet" || source.outletId !== outletId || source.resourcePolicyVersion !== 1
    || !Number.isSafeInteger(source.revision) || source.revision < 0)) {
    throw new HttpsError("failed-precondition", "The outlet stock point needs reconciliation.");
  }
}
// Resolve before writing: callers can still read other transfer/receipt evidence.
async function prepareInventoryStockPoint(db, tx, hotelUid, locationId) {
  requireDocumentId(hotelUid, "hotelUid"); requireDocumentId(locationId, "locationId");
  const ref = db.doc(`hotels/${hotelUid}/locations/${locationId}`), snapshot = await tx.get(ref);
  const source = snapshot.exists ? snapshot.data() : null, isOutletDefault = locationId.startsWith("outlet:");
  const outletId = isOutletDefault ? requireDocumentId(locationId.slice(7), "outletId") : source?.outletId ?? null;
  if (!isOutletDefault && (!source || isArchived(source) || source.stockPointType === "outlet")) {
    throw new HttpsError("failed-precondition", "Choose an active inventory stock point in this hotel.");
  }
  let outlet = null;
  if (outletId != null) {
    const parent = await tx.get(db.doc(`hotels/${hotelUid}/outlets/${requireDocumentId(outletId, "outletId")}`));
    if (!parent.exists || isArchived(parent.data())) throw new HttpsError("failed-precondition", "Choose an active outlet in this hotel.");
    outlet = parent.data();
  }
  if (isOutletDefault) {
    assertOutletStockPoint(locationId, source, outletId);
    if (source && isArchived(source)) throw new HttpsError("failed-precondition", "The outlet stock point is archived.");
  }
  const outletName = outlet ? text(outlet.name, "Outlet name", 200, true) : null;
  const locationName = isOutletDefault ? outletName : text(source.name, "Location name", 200, true);
  return { locationId, locationName, outletId, outletName, inventoryRole: outlet ? inventoryRole(outlet.inventoryRole) : null,
    isOutletDefault, stockPointType: isOutletDefault ? "outlet" : "location", write: () => {
      if (isOutletDefault && !snapshot.exists) tx.create(ref, { name: outletName, outletId,
        stockPointPolicyVersion: 1, stockPointType: "outlet", resourcePolicyVersion: 1, revision: 0, createdAt: stamp() });
    } };
}
async function listInventoryStockPoints(db, tx, hotelUid) {
  const [outlets, locations] = await Promise.all(["outlets", "locations"].map((collection) => tx.get(
    db.collection(`hotels/${hotelUid}/${collection}`).orderBy(admin.firestore.FieldPath.documentId()).limit(201))));
  if (outlets.docs.length > 200 || locations.docs.length > 200) throw new HttpsError("resource-exhausted", "Stock point selection supports up to 200 outlets and 200 locations.");
  const outletMap = new Map(outlets.docs.map((outlet) => [outlet.id, outlet.data()]));
  const locationMap = new Map(locations.docs.map((location) => [location.id, location.data()]));
  const choices = outlets.docs.filter((outlet) => !isArchived(outlet.data())).map((outlet) => {
    const id = outletStockPointId(outlet.id), point = locationMap.get(id);
    assertOutletStockPoint(id, point, outlet.id);
    if (point && isArchived(point)) return null;
    const name = text(outlet.data().name, "Outlet name", 200, true);
    return { id, name, stockPointType: "outlet", outletId: outlet.id, outletName: name, inventoryRole: inventoryRole(outlet.data().inventoryRole) };
  }).filter(Boolean);
  for (const location of locations.docs) {
    const source = location.data();
    if (location.id.startsWith("outlet:") || source.stockPointType === "outlet" || isArchived(source)) continue;
    const outletId = source.outletId ?? null, outlet = outletId ? outletMap.get(outletId) : null;
    if (outletId && (!outlet || isArchived(outlet))) continue;
    choices.push({ id: location.id, name: text(source.name, "Location name", 200, true), stockPointType: "location", outletId,
      outletName: outlet ? text(outlet.name, "Outlet name", 200, true) : null, inventoryRole: outlet ? inventoryRole(outlet.inventoryRole) : null });
  }
  return choices.sort((a, b) => a.id.localeCompare(b.id));
}

// Retain resource identities, subcollections and historical snapshots. Archive
// removes a resource from new work without orphaning earlier orders/counts.
async function mutateHotelProcurementResourceHandler(request, services = {}) {
  const input = request.data || {};
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).some((key) => !["hotelUid", "collection", "resourceId", "action", "expectedRevision", "requestId", "resource"].includes(key))
    || !["locations", "outlets"].includes(input.collection) || !["create", "update", "archive"].includes(input.action)) {
    throw new HttpsError("invalid-argument", "Unsupported procurement resource command.");
  }
  const hotelUid = requireDocumentId(input.hotelUid, "hotelUid");
  const resourceId = requireDocumentId(input.resourceId, "resourceId");
  const expectedRevision = revision(input.expectedRevision);
  const requestId = requireDocumentId(input.requestId, "requestId");
  if (input.collection === "locations" && resourceId.startsWith("outlet:")) throw new HttpsError("invalid-argument", "Manage outlet stock points through their outlet.");
  let payload = null;
  if (input.action !== "archive") {
    const fields = input.collection === "outlets" ? ["name", "inventoryRole"] : ["name", "outletId"];
    if (!input.resource || typeof input.resource !== "object" || Array.isArray(input.resource)
      || Object.keys(input.resource).some((field) => !fields.includes(field))) throw new HttpsError("invalid-argument", "Unsupported resource fields.");
    payload = { name: text(input.resource.name, "Resource name", 200, true) };
    if (input.collection === "outlets" && (input.action === "create" || input.resource.inventoryRole != null)) payload.inventoryRole = inventoryRole(input.resource.inventoryRole);
    if (input.collection === "locations" && Object.hasOwn(input.resource, "outletId")) payload.outletId = input.resource.outletId == null ? null : requireDocumentId(input.resource.outletId, "outletId");
    if (input.collection === "locations" && input.action === "create" && !payload.outletId) throw new HttpsError("invalid-argument", "Choose the outlet that owns this location.");
  } else if (input.resource !== undefined) throw new HttpsError("invalid-argument", "Archive commands do not accept resource fields.");
  const db = services.firestore || admin.firestore();
  const ref = db.doc(`hotels/${hotelUid}/${input.collection}/${resourceId}`);
  const operation = db.doc(`hotels/${hotelUid}/procurementResourceOperations/${digest(request.auth?.uid, requestId)}`);
  const audit = db.doc(`hotels/${hotelUid}/procurementResourceAudit/${digest(request.auth?.uid, requestId)}`);
  const fingerprint = digest(input);
  return db.runTransaction(async (tx) => {
    await requireHotelPermission(db, { ...request }, hotelUid, input.collection, input.action === "archive" ? "delete" : input.action, tx, services.auth);
    await requireSaasRollout(db, tx);
    const previousOperation = await tx.get(operation);
    if (previousOperation.exists) {
      if (previousOperation.data().fingerprint !== fingerprint) {
        throw new HttpsError("already-exists", "This resource request ID was used for different details.");
      }
      return previousOperation.data().result;
    }
    try {
      const snapshot = await tx.get(ref);
      if (input.action === "create" ? snapshot.exists : !snapshot.exists) throw new HttpsError(input.action === "create" ? "already-exists" : "not-found", input.action === "create" ? "This resource already exists." : "This resource does not exist in the selected hotel.");
      const source = snapshot.data() || {}, storedRevision = source.revision ?? 0;
      if (!Number.isSafeInteger(storedRevision) || storedRevision < 0 || storedRevision >= Number.MAX_SAFE_INTEGER) {
        throw new HttpsError("failed-precondition", "The resource revision needs review.");
      }
      if (expectedRevision !== storedRevision) throw new HttpsError("aborted", "This resource changed. Reload before saving it.");
      if (isArchived(source)) throw new HttpsError("failed-precondition", "This resource is already archived.");
      let defaultRef = null, defaultPoint = null;
      if (input.collection === "outlets") {
        defaultRef = db.doc(`hotels/${hotelUid}/locations/${outletStockPointId(resourceId)}`);
        defaultPoint = await tx.get(defaultRef);
        assertOutletStockPoint(defaultRef.id, defaultPoint.exists ? defaultPoint.data() : null, resourceId);
      } else if (payload && (payload.outletId ?? source.outletId)) {
        const linkedOutletId = Object.hasOwn(payload, "outletId") ? payload.outletId : source.outletId;
        if (linkedOutletId) {
          const outlet = await tx.get(db.doc(`hotels/${hotelUid}/outlets/${linkedOutletId}`));
          if (!outlet.exists || isArchived(outlet.data())) throw new HttpsError("failed-precondition", "Choose an active outlet in this hotel.");
        }
        // Stock already recorded at a detail point cannot silently change owners.
        if (input.action === "update" && Object.hasOwn(payload, "outletId") && payload.outletId !== (source.outletId ?? null)) {
          const state = await tx.get(db.doc(`hotels/${hotelUid}/inventoryLocationStates/${resourceId}`));
          if (state.exists) throw new HttpsError("failed-precondition", "A location with inventory history cannot change outlets. Create another location instead.");
        }
      }
      const result = { hotelUid, collection: input.collection, resourceId, revision: storedRevision + 1, archived: input.action === "archive" };
      const saved = { ...payload, resourcePolicyVersion: 1, revision: result.revision, updatedBy: request.auth.uid, updatedAt: stamp() };
      if (input.action === "archive") tx.update(ref, { ...saved, archived: true, active: false, archivedBy: request.auth.uid, archivedAt: stamp() });
      else if (input.action === "create") tx.create(ref, { ...saved, createdBy: request.auth.uid, createdAt: stamp(), ...(input.collection === "outlets" ? { subOutlets: [], menuCategories: [], costCenterIds: [] } : {}) });
      else tx.update(ref, saved);
      if (defaultRef && input.action !== "archive") {
        const point = { name: payload.name, stockPointPolicyVersion: 1, stockPointType: "outlet", outletId: resourceId };
        if (defaultPoint.exists) tx.update(defaultRef, { name: point.name });
        else tx.create(defaultRef, { ...point, resourcePolicyVersion: 1, revision: 0, createdAt: stamp() });
      }
      tx.create(operation, { fingerprint, result, actorUid: request.auth.uid, createdAt: stamp() });
      tx.create(audit, { collection: input.collection, resourceId, action: input.action, actorUid: request.auth.uid,
        revision: result.revision, createdAt: stamp() });
      return result;
    } catch (error) {
      if (error instanceof HttpsError) throw new HttpsError(error.code, error.message, { resourceRequestUncommitted: true });
      throw error;
    }
  });
}

async function getHotelLocationOutletChoicesHandler(request, services = {}) {
  const input = request.data || {};
  if (Object.keys(input).some((key) => !["hotelUid", "action"].includes(key)) || !["create", "update"].includes(input.action)) throw new HttpsError("invalid-argument", "Choose a location create or update action.");
  const hotelUid = requireDocumentId(input.hotelUid, "hotelUid"), db = services.firestore || admin.firestore();
  return db.runTransaction(async (tx) => {
    await requireHotelPermission(db, { ...request }, hotelUid, "locations", input.action, tx, services.auth);
    await requireSaasRollout(db, tx);
    const outlets = await tx.get(db.collection(`hotels/${hotelUid}/outlets`).orderBy(admin.firestore.FieldPath.documentId()).limit(201));
    if (outlets.docs.length > 200) throw new HttpsError("resource-exhausted", "The outlet picker supports up to 200 outlets.");
    return { hotelUid, outlets: outlets.docs.filter((outlet) => !isArchived(outlet.data())).map((outlet) => ({ id: outlet.id,
      name: text(outlet.data().name, "Outlet name", 200, true), inventoryRole: inventoryRole(outlet.data().inventoryRole) })) };
  }, { readOnly: true });
}
module.exports = { isArchived, outletStockPointId, inventoryRole, assertOutletStockPoint, prepareInventoryStockPoint, listInventoryStockPoints, mutateHotelProcurementResourceHandler, getHotelLocationOutletChoicesHandler,
  getHotelLocationOutletChoices: onCall({ region: "us-central1", cors: true }, gated(getHotelLocationOutletChoicesHandler)),
  mutateHotelProcurementResource: onCall({ region: "us-central1", cors: true, timeoutSeconds: 120 }, gated(mutateHotelProcurementResourceHandler)) };
