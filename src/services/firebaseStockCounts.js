import { collection, db, doc, getDoc, getDocs, functions, httpsCallable, auth } from "../firebaseConfig";

import { poolProcurementRead } from "./procurementReadPool";
import { reportPurchasingError } from "./firebasePurchasingTelemetry";

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
    catalogProductId: String(item?.catalogProductId || "").trim(),
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
      ? template.items.map(normalizeStockTemplateItem)
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
    ...location,
    currency: location.currency || null,
    inventoryPolicyVersion: location.inventoryPolicyVersion || null,
    revision: Number.isSafeInteger(location.revision) ? location.revision : 0,
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
  if (location.inventoryPolicyVersion === 1 || location.stockTemplate?.items?.some((item) => item.catalogProductId)) {
    const items = normalizeCountedItems(location.countedItems);
    if (items.some((item) => !item.isCounted) || location.costComplete === false) return null;
    const counted = items.filter((item) => item.isCounted);
    if (!counted.length || counted.some((item) => item.totalValue == null)) return null;
    const currencies = new Set(counted.map((item) => item.currency || location.currency).filter(Boolean));
    return currencies.size === 1 ? counted.reduce((sum, item) => sum + item.totalValue, 0) : null;
  }
  if (!Array.isArray(location?.countedItems) && typeof location.countedValue === "number" && Number.isFinite(location.countedValue)) return location.countedValue;
  return normalizeCountedItems(location?.countedItems).reduce((sum, item) => sum + (item.totalValue ?? 0), 0);
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
  const countedValue = data.inventoryPolicyVersion === 1
    ? (normalizedLocations.length && normalizedLocations.every((location) => location.countedValue != null) ? locationCountedValue : null)
    : locationCountedValue || Number(data?.countedValue || 0);

  return {
    ...data,
    currency: data.currency || null,
    businessDate: data.businessDate || null,
    inventoryPolicyVersion: data.inventoryPolicyVersion || null,
    id: String(data.id || fallbackId || "").trim() || fallbackId,
    name: String(data.name || `${data.type || "Ad Hoc"} · ${data.businessDate || "Stock count"}`).trim(),
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


function finiteOrNull(value) { return typeof value === "number" && Number.isFinite(value) ? value : null; }

function normalizeCountedItems(items) {
  return Array.isArray(items)
    ? items
        .map((item) => ({
          ...item,
          catalogProductId: String(item?.catalogProductId || "").trim(),
          supplierProductId: String(item?.supplierProductId || "").trim(),
          outletId: String(item?.outletId || "").trim(),
          quantity: item.catalogProductId ? finiteOrNull(item.quantity) : Number(item?.quantity || 0),
          unitCost: finiteOrNull(item.unitCost),
          currency: item.currency || null,
          pricePerPurchaseUnit: Number(item?.pricePerPurchaseUnit || 0),
          totalValue: item.catalogProductId ? finiteOrNull(item.totalValue) : Number(item?.totalValue || 0),
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
        .filter((item) => item.catalogProductId || item.supplierProductId)
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
  return items.map((item) => item.catalogProductId
    ? { catalogProductId: item.catalogProductId, quantity: item.quantity, isCounted: item.isCounted !== false, unitCost: item.unitCost ?? null }
    : { supplierProductId: item.supplierProductId, outletId: item.outletId, quantity: item.quantity, isCounted: item.isCounted !== false });
}
function countMutationStorageKey(hotelUid, stockCountId, locationId = null) {
  if (!hotelUid || !stockCountId || !auth.currentUser?.uid) throw new Error("Sign in and select a hotel and stock count before saving.");
  return `hotelsuite.stockCount.mutation:${JSON.stringify([auth.currentUser.uid, hotelUid, stockCountId, locationId])}`;
}
function readPendingCountMutation(storageKey, hotelUid, stockCountId, locationId) {
  const raw = localStorage.getItem(storageKey);
  if (!raw) return null;
  try {
    const payload = JSON.parse(raw);
    if (payload.hotelUid !== hotelUid || payload.stockCountId !== stockCountId || (payload.locationId ?? null) !== locationId
      || typeof payload.requestId !== "string" || !payload.requestId
      || !["save-location", "finish-location", "set-location-status", "finish-count"].includes(payload.action)) throw new Error("Invalid saved command");
    return payload;
  } catch { throw new Error("The saved stock count change cannot be read. Its outcome needs review before another change can be sent."); }
}
export function getPendingStockCountMutation(hotelUid, stockCountId, locationId = null) {
  if (!hotelUid || !stockCountId || !auth.currentUser?.uid) return null;
  return readPendingCountMutation(countMutationStorageKey(hotelUid, stockCountId, locationId), hotelUid, stockCountId, locationId);
}
async function sendStockCountMutation(payload, storageKey) {
  const requestedActor = auth.currentUser;
  const clearOwnCommand = () => {
    const pending = readPendingCountMutation(storageKey, payload.hotelUid, payload.stockCountId, payload.locationId ?? null);
    if (pending?.requestId === payload.requestId) localStorage.removeItem(storageKey);
    notifyCountCreation();
  };
  try {
    const result = await httpsCallable(functions, "mutateHotelStockCount")(payload);
    if (auth.currentUser !== requestedActor) throw new Error("The signed-in account changed while saving. Sign in with the original account to confirm its saved change.");
    if (result.data?.hotelUid !== payload.hotelUid || result.data.stockCountId !== payload.stockCountId
      || !Number.isSafeInteger(result.data.revision) || result.data.revision < 0
      || payload.locationId && (result.data.locationId !== payload.locationId || !Number.isSafeInteger(result.data.locationRevision) || result.data.locationRevision < 0)) {
      throw new Error("Stock count mutation response scope is invalid. Retry the saved change to confirm its outcome.");
    }
    clearOwnCommand();
    return result.data;
  } catch (error) {
    if (auth.currentUser === requestedActor) reportPurchasingError(payload.hotelUid, "stock-counts", error);
    if (auth.currentUser === requestedActor && error?.details?.countMutationUncommitted === true) clearOwnCommand();
    notifyCountCreation();
    throw error;
  }
}
export async function retryPendingStockCountMutation(hotelUid, stockCountId, locationId = null) {
  const storageKey = countMutationStorageKey(hotelUid, stockCountId, locationId);
  const pending = readPendingCountMutation(storageKey, hotelUid, stockCountId, locationId);
  if (!pending) throw new Error("No saved stock count change is awaiting confirmation.");
  return sendStockCountMutation(pending, storageKey);
}
async function mutateStockCount(hotelUid, stockCountId, payload, expectedRevision) {
  const storageKey = countMutationStorageKey(hotelUid, stockCountId, payload.locationId ?? null);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error("Reload this stock count before saving; its loaded revision is required.");
  const command = { hotelUid, stockCountId, ...payload,
    ...(payload.locationId ? { expectedLocationRevision: expectedRevision } : { expectedRevision }) };
  let pending = readPendingCountMutation(storageKey, hotelUid, stockCountId, payload.locationId ?? null);
  if (pending) {
    const { requestId: _requestId, ...original } = pending;
    if (JSON.stringify(original) !== JSON.stringify(command)) throw new Error("A previous stock count change is awaiting confirmation. Retry that saved change before sending another.");
  } else {
    pending = { ...command, requestId: crypto.randomUUID() };
    localStorage.setItem(storageKey, JSON.stringify(pending));
    notifyCountCreation();
  }
  return sendStockCountMutation(pending, storageKey);
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
function countCreationStorageKey(hotelUid) {
  if (!hotelUid || !auth.currentUser?.uid) throw new Error("Sign in before creating a stock count.");
  return `hotelsuite.stockCount.create:${auth.currentUser.uid}:${hotelUid}`;
}
function pendingCountCreation(hotelUid) {
  const raw = sessionStorage.getItem(countCreationStorageKey(hotelUid));
  if (!raw) return null;
  try {
    const saved = JSON.parse(raw), payload = JSON.parse(saved.fingerprint);
    if (typeof saved.requestId !== "string" || !saved.requestId || payload.hotelUid !== hotelUid) throw new Error("Invalid saved command");
    return { ...saved, payload };
  } catch { throw new Error("The saved stock count request cannot be read. Its outcome needs review; no replacement request was created."); }
}
function notifyCountCreation() { window.dispatchEvent(new Event("stock-count-command-changed")); }
export function getPendingCountCreation(hotelUid) {
  if (!hotelUid || !auth.currentUser?.uid) return null;
  return pendingCountCreation(hotelUid)?.payload || null;
}
export async function retryPendingCountCreation(hotelUid) {
  const pending = getPendingCountCreation(hotelUid);
  if (!pending) throw new Error("No saved stock count creation is available.");
  return createStockCount(hotelUid, pending);
}
export async function createStockCount(hotelUid, input) {
  if (!hotelUid) throw new Error("hotelUid is required");
  const payload = { hotelUid, ...(input?.name ? { name: input.name } : {}), type: input?.type,
    ...(input?.businessDate ? { businessDate: input.businessDate } : {}),
    ...(input?.reason ? { reason: input.reason } : {}),
    ...(input?.periodMonth != null ? { periodMonth: input.periodMonth } : {}),
    ...(input?.periodYear != null ? { periodYear: input.periodYear } : {}),
    locations: (input?.locations || []).map((location) => ({
      ...(location.outletId ? { outletId: location.outletId } : {}),
      ...(location.locationId ? { locationId: location.locationId } : {}),
      ...(location.stockTemplateId || location.stockTemplate?.id ? { stockTemplateId: location.stockTemplateId || location.stockTemplate.id } : {}) })) };
  if (!auth.currentUser?.uid) throw new Error("Sign in before creating a stock count.");
  const storageKey = countCreationStorageKey(hotelUid);
  const fingerprint = JSON.stringify(payload);
  let operation = pendingCountCreation(hotelUid);
  if (operation && operation.fingerprint !== fingerprint) throw new Error("A previous count creation is awaiting confirmation. Retry the same request before changing it.");
  if (!operation) {
    operation = { fingerprint, requestId: crypto.randomUUID() };
    sessionStorage.setItem(storageKey, JSON.stringify(operation)); notifyCountCreation();
  }
  try {
    const result = await httpsCallable(functions, "createHotelStockCount")({ ...payload, requestId: operation.requestId });
    if (result.data?.hotelUid !== hotelUid || result.data.inventoryPolicyVersion !== 1 || typeof result.data.stockCountId !== "string" || !result.data.stockCountId) throw new Error("Stock count creation response scope or policy is invalid. Retry the same request.");
    sessionStorage.removeItem(storageKey); notifyCountCreation();
    return { id: result.data.stockCountId, ...result.data };
  } catch (error) {
    reportPurchasingError(hotelUid, "stock-counts", error);
    if (error?.details?.countRequestUncommitted === true) sessionStorage.removeItem(storageKey);
    notifyCountCreation();
    throw error;
  }
}
export async function updateStockCountLocationCounts(hotelUid, stockCountId, locationId, countedItems, _updatedBy, expectedLocationRevision) {
  return mutateStockCount(hotelUid, stockCountId, { action: "save-location", locationId,
    countedItems: commandItems(countedItems) }, expectedLocationRevision);
}
export async function finishStockCountLocation(hotelUid, stockCountId, locationId, countedItems,
  templateItemsToAdd = [], _updatedBy, expectedLocationRevision) {
  return mutateStockCount(hotelUid, stockCountId, { action: "finish-location", locationId,
    countedItems: commandItems(countedItems), templateItemsToAdd: templateItemsToAdd.map((item) =>
      (item.catalogProductId ? { catalogProductId: item.catalogProductId } : { supplierProductId: item.supplierProductId, outletId: item.outletId })) }, expectedLocationRevision);
}
export async function finishStockCount(hotelUid, stockCountId, _updatedBy, expectedRevision) {
  return mutateStockCount(hotelUid, stockCountId, { action: "finish-count" }, expectedRevision);
}
export async function updateStockCountLocationStatus(hotelUid, stockCountId, locationId, status, _updatedBy, expectedLocationRevision) {
  return mutateStockCount(hotelUid, stockCountId, { action: "set-location-status", locationId, status }, expectedLocationRevision);
}

export async function getStockCountProductChoices(hotelUid, stockCountId, locationId,
  { afterProductId = null, search = "", barcode = "" } = {}) {
  const identifier = (value) => typeof value === "string" && value.length > 0 && value.length <= 128 && !value.includes("/");
  const cursor = (value) => identifier(value) || typeof value === "string" && /^barcode:[A-Za-z0-9_-]+$/.test(value) && value.length <= 512;
  if (![hotelUid, stockCountId, locationId].every(identifier) || afterProductId !== null && !cursor(afterProductId)) throw new Error("Stock count product scope or pagination is invalid.");
  if (typeof search !== "string" || search.length > 200 || typeof barcode !== "string" || barcode.length > 100) throw new Error("Stock count product search is invalid.");
  const input = { hotelUid, stockCountId, locationId, afterProductId, search, barcode };
  return poolProcurementRead(hotelUid, "stock-count-products", async () => {
    const result = await httpsCallable(functions, "listHotelStockCountProducts")(input), data = result.data;
    const units = new Set(["g", "kg", "ml", "l", "each"]);
    if (!data || data.hotelUid !== hotelUid || data.stockCountId !== stockCountId || data.locationId !== locationId || data.inventoryPolicyVersion !== 1
      || !Array.isArray(data.products) || data.products.length > 25 || new Set(data.products.map((product) => product?.id)).size !== data.products.length
      || data.nextCursor !== null && (!cursor(data.nextCursor) || data.nextCursor === afterProductId)
      || data.products.some((product) => !product || !identifier(product.id) || typeof product.name !== "string" || !product.name || product.name.length > 200
        || !units.has(product.baseUnit) || !Array.isArray(product.barcodes) || product.barcodes.length > 100
        || product.barcodes.some((value) => typeof value !== "string" || !value || value.length > 100))) {
      throw new Error("Stock count product response has invalid scope, products or pagination. Reload before adding products.");
    }
    return data;
  }, JSON.stringify(input));
}


// Name/physical-package projection for an actual frozen count row. It exposes
// neither supplier price contracts nor account details to ordinary counters.
export async function getStockCountPackageOptions(hotelUid, stockCountId, locationId, catalogProductId,
  { afterSupplierProductId = null, baseUnit } = {}) {
  const identifiers = [hotelUid, stockCountId, locationId, catalogProductId];
  if (identifiers.some((value) => typeof value !== "string" || !value || value.includes("/"))) throw new Error("A hotel, stock count, location and catalog product are required.");
  if (afterSupplierProductId !== null && (typeof afterSupplierProductId !== "string" || !afterSupplierProductId || afterSupplierProductId.includes("/"))) throw new Error("Package pagination is invalid.");
  const input = { hotelUid, stockCountId, locationId, catalogProductId, afterSupplierProductId };
  return poolProcurementRead(hotelUid, "stock-count-packages", async () => {
    const result = await httpsCallable(functions, "getHotelStockCountPackageOptions")(input), data = result.data;
    const units = new Set(["g", "kg", "ml", "l", "each"]);
    const label = (value, maximum) => typeof value === "string" && value.length > 0 && value.length <= maximum;
    const identifier = (value) => label(value, 128) && !value.includes("/");
    if (!data || data.hotelUid !== hotelUid || data.stockCountId !== stockCountId || data.locationId !== locationId
      || data.catalogProductId !== catalogProductId || data.inventoryPolicyVersion !== 1 || !units.has(data.catalogBaseUnit)
      || baseUnit !== undefined && data.catalogBaseUnit !== baseUnit
      || !Array.isArray(data.options) || data.options.length > 525 || !Array.isArray(data.unavailable) || data.unavailable.length > 25
      || data.nextCursor !== null && (!identifier(data.nextCursor) || data.nextCursor === afterSupplierProductId)
      || new Set(data.options.map((option) => option?.id)).size !== data.options.length
      || data.options.some((option) => !option || !identifier(option.supplierProductId) || !identifier(option.purchaseOptionId)
        || option.id !== JSON.stringify([option.supplierProductId, option.purchaseOptionId]) || option.baseUnit !== data.catalogBaseUnit
        || !label(option.supplierProductName, 200) || !label(option.supplierName, 200) || !label(option.purchaseUnit, 100)
        || typeof option.catalogUnitsPerPackage !== "number" || !Number.isFinite(option.catalogUnitsPerPackage)
        || option.catalogUnitsPerPackage <= 0 || option.catalogUnitsPerPackage > 1000000)
      || data.unavailable.some((entry) => !entry || entry.supplierProductId !== null && !identifier(entry.supplierProductId)
        || !label(entry.reason, 100))) throw new Error("Package choices returned an invalid scope, unit or pagination. Reload before counting.");
    return data;
  }, JSON.stringify([input, baseUnit]));
}
