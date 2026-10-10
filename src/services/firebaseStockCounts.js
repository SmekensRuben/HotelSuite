import { collection, db, doc, getDoc, getDocs, functions, httpsCallable } from "../firebaseConfig";

export const STOCK_COUNT_TYPES = ["Ad Hoc", "Daily", "Weekly", "Month-End"];
export const STOCK_COUNT_STATUSES = ["Started", "In Progress", "Finished"];


function normalizeDate(value) {
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate();
  if (value instanceof Date) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function normalizeStockTemplateItem(item = {}) {
  return {
    ...item,
    supplierProductId: String(item?.supplierProductId || "").trim(),
    outletId: String(item?.outletId || "").trim(),
  };
}

function normalizeStockTemplate(template = {}) {
  const id = String(template?.id || template?.stockTemplateId || "").trim();
  return {
    ...template,
    id,
    name: String(template?.name || template?.stockTemplateName || "").trim(),
    items: Array.isArray(template?.items)
      ? template.items.map(normalizeStockTemplateItem).filter((item) => item.supplierProductId)
      : [],
  };
}

function normalizeStockCountLocation(location = {}) {
  const stockTemplateId = String(location?.stockTemplateId || location?.stockTemplate?.id || "").trim();
  const stockTemplateName = String(location?.stockTemplateName || location?.stockTemplate?.name || "").trim();
  const stockTemplate = normalizeStockTemplate({
    ...(location?.stockTemplate || {}),
    id: location?.stockTemplate?.id || stockTemplateId,
    name: location?.stockTemplate?.name || stockTemplateName,
  });

  return {
    locationId: String(location?.locationId || location?.id || "").trim(),
    locationName: String(location?.locationName || "").trim(),
    stockTemplateId,
    stockTemplateName,
    stockTemplate,
    countedItems: normalizeCountedItems(location?.countedItems),
    countedValue: getStockCountLocationValue(location),
    status: String(location?.status || "Not Started").trim() || "Not Started",
    updatedAt: normalizeDate(location?.updatedAt),
    finishedAt: normalizeDate(location?.finishedAt),
    finishedBy: location?.finishedBy || null,
  };
}

function getStockCountLocationValue(location = {}) {
  if (!Array.isArray(location?.countedItems) && Number.isFinite(Number(location?.countedValue))) {
    return Number(location.countedValue || 0);
  }

  return normalizeCountedItems(location?.countedItems).reduce(
    (sum, item) => sum + Number(item?.totalValue || 0),
    0
  );
}

function deriveStockCountStatus(data = {}, locations = []) {
  const currentStatus = String(data?.status || "").trim();
  if (currentStatus === "Finished" || currentStatus === "In Progress") return currentStatus;

  const normalizedLocations = Array.isArray(locations) ? locations : [];
  const hasProgress = normalizedLocations.some((location) => {
    const status = String(location?.status || "").trim();
    return status === "In Progress" || status === "Finished" || getStockCountLocationValue(location) > 0;
  });

  return hasProgress ? "In Progress" : "Started";
}

function normalizeStockCount(data = {}, fallbackId = "") {
  const locations = Array.isArray(data.locations) ? data.locations : [];
  const normalizedLocations = locations.map(normalizeStockCountLocation).filter((location) => location.locationId);
  const createdAt = normalizeDate(data.createdAt);
  const locationCountedValue = normalizedLocations.reduce(
    (sum, location) => sum + getStockCountLocationValue(location),
    0
  );
  const countedValue = locationCountedValue || Number(data?.countedValue || 0);

  return {
    id: String(data.id || fallbackId || "").trim() || fallbackId,
    name: String(data.name || "").trim(),
    type: STOCK_COUNT_TYPES.includes(data.type) ? data.type : "Ad Hoc",
    status: deriveStockCountStatus(data, normalizedLocations),
    revision: Number.isSafeInteger(data.revision) ? data.revision : 0,
    locations: normalizedLocations,
    countedValue,
    createdAt,
    createdAtLabel: createdAt ? createdAt.toLocaleDateString() : "—",
    locationCount: normalizedLocations.length,
    locationSummary: normalizedLocations.length === 1 ? "1 location" : `${normalizedLocations.length} locations`,
  };
}


function normalizeCountedItems(items) {
  return Array.isArray(items)
    ? items
        .map((item) => ({
          supplierProductId: String(item?.supplierProductId || "").trim(),
          outletId: String(item?.outletId || "").trim(),
          quantity: Number(item?.quantity || 0),
          pricePerPurchaseUnit: Number(item?.pricePerPurchaseUnit || 0),
          totalValue: Number(item?.totalValue || 0),
          countedAt: item?.countedAt || null,
          countedBy: item?.countedBy || null,
          isCounted: item?.isCounted !== false,
          isTemplateItem: item?.isTemplateItem !== false,
          supplierProductName: String(item?.supplierProductName || item?.name || "").trim(),
          supplierName: String(item?.supplierName || "").trim(),
          baseUnitsPerPurchaseUnit: item?.baseUnitsPerPurchaseUnit ?? "",
          baseUnit: String(item?.baseUnit || "").trim(),
          purchaseUnit: String(item?.purchaseUnit || "").trim(),
          content: String(item?.content || "").trim(),
          outletName: String(item?.outletName || "").trim(),
        }))
        .filter((item) => item.supplierProductId)
    : [];
}

export async function getStockCounts(hotelUid) {
  if (!hotelUid) return [];

  const stockCountsCol = collection(db, `hotels/${hotelUid}/stockCounts`);
  const snapshot = await getDocs(stockCountsCol);

  const stockCounts = await Promise.all(
    snapshot.docs.map(async (docSnap) => {
      const stockCountData = docSnap.data() || {};
      const locationsSnapshot = await getDocs(collection(db, `hotels/${hotelUid}/stockCounts/${docSnap.id}/locations`));
      const locations = locationsSnapshot.docs.map((locationDoc) => ({
        ...(locationDoc.data() || {}),
        locationId: locationDoc.id,
      }));
      const fallbackLocations = Array.isArray(stockCountData.locations) ? stockCountData.locations : [];

      return normalizeStockCount(
        { ...stockCountData, locations: locations.length ? locations : fallbackLocations },
        docSnap.id
      );
    })
  );

  return stockCounts.sort((a, b) => {
    const aTime = a.createdAt?.getTime?.() || 0;
    const bTime = b.createdAt?.getTime?.() || 0;
    return bTime - aTime || a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

export async function getStockCountById(hotelUid, stockCountId) {
  if (!hotelUid || !stockCountId) return null;

  const stockCountRef = doc(db, `hotels/${hotelUid}/stockCounts`, stockCountId);
  const snapshot = await getDoc(stockCountRef);
  if (!snapshot.exists()) return null;

  const stockCountData = snapshot.data() || {};
  const locationOrder = Array.isArray(stockCountData.locations)
    ? stockCountData.locations.map((location) => String(location?.locationId || "").trim()).filter(Boolean)
    : [];
  const orderByLocationId = Object.fromEntries(locationOrder.map((locationId, index) => [locationId, index]));
  const locationsSnapshot = await getDocs(collection(db, `hotels/${hotelUid}/stockCounts/${stockCountId}/locations`));
  const locations = locationsSnapshot.docs
    .map((locationDoc) => ({ ...(locationDoc.data() || {}), locationId: locationDoc.id }))
    .sort((a, b) => {
      const aIndex = orderByLocationId[String(a?.locationId || "").trim()] ?? Number.MAX_SAFE_INTEGER;
      const bIndex = orderByLocationId[String(b?.locationId || "").trim()] ?? Number.MAX_SAFE_INTEGER;
      return aIndex - bIndex || String(a?.locationName || "").localeCompare(String(b?.locationName || ""), undefined, {
        sensitivity: "base",
        numeric: true,
      });
    });

  return normalizeStockCount({ ...stockCountData, locations }, snapshot.id);
}

// Only editable quantities/identities cross the command boundary. The server owns
// price snapshots, totals, status transitions, timestamps and actors.
function commandItems(items) {
  if (!Array.isArray(items)) throw new Error("countedItems must be an array");
  return items.map((item) => ({ supplierProductId: item.supplierProductId, outletId: item.outletId,
    quantity: item.quantity, isCounted: item.isCounted !== false }));
}
async function mutateStockCount(hotelUid, stockCountId, payload, expectedRevision) {
  if (!hotelUid || !stockCountId) throw new Error("hotelUid and stockCountId are required");
  const current = expectedRevision == null ? await getStockCountById(hotelUid, stockCountId) : null;
  if (expectedRevision == null && !current) throw new Error("Stock count not found");
  const result = await httpsCallable(functions, "mutateHotelStockCount")({ hotelUid, stockCountId,
    ...payload, expectedRevision: expectedRevision ?? current.revision });
  return result.data;
}
export async function getStockCountSources(hotelUid) {
  if (!hotelUid) throw new Error("hotelUid is required");
  const locations = [], seen = new Set();
  let afterLocationId = null;
  while (true) {
    const result = await httpsCallable(functions, "listHotelStockCountSources")({ hotelUid, afterLocationId });
    locations.push(...result.data.locations);
    if (locations.length > 1000) throw new Error("More than 1,000 stock locations require operator review.");
    const cursor = result.data.nextCursor;
    if (!cursor) return locations;
    if (seen.has(cursor)) throw new Error("Stock location pagination did not advance. Please retry.");
    seen.add(cursor); afterLocationId = cursor;
  }
}
export async function createStockCount(hotelUid, input) {
  if (!hotelUid) throw new Error("hotelUid is required");
  const payload = { hotelUid, name: input?.name, type: input?.type,
    locations: (input?.locations || []).map((location) => ({ locationId: location.locationId,
      stockTemplateId: location.stockTemplateId || location.stockTemplate?.id })) };
  const storageKey = `hotelsuite.stockCount.create:${hotelUid}`;
  const fingerprint = JSON.stringify(payload);
  let operation;
  try { operation = JSON.parse(sessionStorage.getItem(storageKey) || "null"); } catch { operation = null; }
  if (!operation || operation.fingerprint !== fingerprint) {
    operation = { fingerprint, requestId: crypto.randomUUID() };
    sessionStorage.setItem(storageKey, JSON.stringify(operation));
  }
  const result = await httpsCallable(functions, "createHotelStockCount")({ ...payload, requestId: operation.requestId });
  sessionStorage.removeItem(storageKey);
  return { id: result.data.stockCountId, ...result.data };
}
export async function updateStockCountLocationCounts(hotelUid, stockCountId, locationId, countedItems, _updatedBy, expectedRevision) {
  return mutateStockCount(hotelUid, stockCountId, { action: "save-location", locationId,
    countedItems: commandItems(countedItems) }, expectedRevision);
}
export async function finishStockCountLocation(hotelUid, stockCountId, locationId, countedItems,
  templateItemsToAdd = [], _updatedBy, expectedRevision) {
  return mutateStockCount(hotelUid, stockCountId, { action: "finish-location", locationId,
    countedItems: commandItems(countedItems), templateItemsToAdd: templateItemsToAdd.map((item) =>
      ({ supplierProductId: item.supplierProductId, outletId: item.outletId })) }, expectedRevision);
}
export async function finishStockCount(hotelUid, stockCountId, _updatedBy, expectedRevision) {
  return mutateStockCount(hotelUid, stockCountId, { action: "finish-count" }, expectedRevision);
}
export async function updateStockCountLocationStatus(hotelUid, stockCountId, locationId, status, _updatedBy, expectedRevision) {
  return mutateStockCount(hotelUid, stockCountId, { action: "set-location-status", locationId, status }, expectedRevision);
}
