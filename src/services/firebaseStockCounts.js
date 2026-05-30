import { collection, db, doc, getDoc, getDocs, serverTimestamp, writeBatch } from "../firebaseConfig";

export const STOCK_COUNT_TYPES = ["Ad Hoc", "Daily", "Weekly", "Month-End"];

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

function buildStockTemplateItemKey(item = {}) {
  return `${String(item?.supplierProductId || "").trim()}::${String(item?.outletId || "").trim()}`;
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
    status: String(location?.status || "Not Started").trim() || "Not Started",
    updatedAt: normalizeDate(location?.updatedAt),
    finishedAt: normalizeDate(location?.finishedAt),
    finishedBy: location?.finishedBy || null,
  };
}

function normalizeStockCount(data = {}, fallbackId = "") {
  const locations = Array.isArray(data.locations) ? data.locations : [];
  const createdAt = normalizeDate(data.createdAt);

  return {
    id: String(data.id || fallbackId || "").trim() || fallbackId,
    name: String(data.name || "").trim(),
    type: STOCK_COUNT_TYPES.includes(data.type) ? data.type : "Ad Hoc",
    locations: locations.map(normalizeStockCountLocation).filter((location) => location.locationId),
    createdAt,
    createdAtLabel: createdAt ? createdAt.toLocaleDateString() : "—",
    locationCount: locations.length,
    locationSummary: locations.length === 1 ? "1 location" : `${locations.length} locations`,
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

  return snapshot.docs
    .map((docSnap) => normalizeStockCount(docSnap.data(), docSnap.id))
    .sort((a, b) => {
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

export async function createStockCount(hotelUid, input) {
  if (!hotelUid) throw new Error("hotelUid is verplicht");

  const name = String(input?.name || "").trim();
  if (!name) throw new Error("Name is verplicht");

  const type = STOCK_COUNT_TYPES.includes(input?.type) ? input.type : "Ad Hoc";
  const locations = Array.isArray(input?.locations)
    ? input.locations
        .map((location) => {
          const stockTemplate = normalizeStockTemplate({
            ...(location?.stockTemplate || {}),
            id: location?.stockTemplate?.id || location?.stockTemplateId,
            name: location?.stockTemplate?.name || location?.stockTemplateName,
          });

          return {
            locationId: String(location?.locationId || "").trim(),
            locationName: String(location?.locationName || "").trim(),
            stockTemplateId: String(location?.stockTemplateId || stockTemplate.id || "").trim(),
            stockTemplateName: String(location?.stockTemplateName || stockTemplate.name || "").trim(),
            stockTemplate,
            countedItems: [],
            status: "Not Started",
          };
        })
        .filter((location) => location.locationId)
    : [];

  if (!locations.length) throw new Error("Selecteer minimaal één locatie");

  const stockCountsCol = collection(db, `hotels/${hotelUid}/stockCounts`);
  const stockCountRef = doc(stockCountsCol);
  const locationSummaries = locations.map(({ locationId, locationName, stockTemplateId, stockTemplateName, status }) => ({
    locationId,
    locationName,
    stockTemplateId,
    stockTemplateName,
    status: status || "Not Started",
  }));
  const payload = {
    id: stockCountRef.id,
    name,
    type,
    locations: locationSummaries,
    createdBy: input?.createdBy || null,
    createdAt: serverTimestamp(),
  };

  const batch = writeBatch(db);
  batch.set(stockCountRef, payload);
  locations.forEach((location) => {
    const locationRef = doc(db, `hotels/${hotelUid}/stockCounts/${stockCountRef.id}/locations`, location.locationId);
    batch.set(locationRef, {
      ...location,
      id: location.locationId,
      createdAt: serverTimestamp(),
      createdBy: input?.createdBy || null,
    });
  });

  await batch.commit();
  return { ...payload, createdAt: new Date() };
}

export async function updateStockCountLocationCounts(hotelUid, stockCountId, locationId, countedItems, updatedBy) {
  if (!hotelUid || !stockCountId || !locationId) {
    throw new Error("hotelUid, stockCountId en locationId zijn verplicht");
  }

  const stockCount = await getStockCountById(hotelUid, stockCountId);
  if (!stockCount) throw new Error("Stock count niet gevonden");

  const normalizedLocationId = String(locationId || "").trim();
  const normalizedCountedItems = normalizeCountedItems(countedItems);
  const updatedAt = new Date();
  const nextLocations = (stockCount.locations || []).map((location) => {
    if (String(location?.locationId || "").trim() !== normalizedLocationId) return location;

    return {
      ...location,
      countedItems: normalizedCountedItems,
      status: location.status === "Finished" ? "Finished" : normalizedCountedItems.length ? "In Progress" : "Not Started",
      updatedAt,
      updatedBy: updatedBy || null,
    };
  });

  const stockCountRef = doc(db, `hotels/${hotelUid}/stockCounts`, stockCountId);
  const locationRef = doc(db, `hotels/${hotelUid}/stockCounts/${stockCountId}/locations`, normalizedLocationId);
  const locationPayload = nextLocations.find(
    (location) => String(location?.locationId || "").trim() === normalizedLocationId
  );

  const locationSummaries = nextLocations.map(({ locationId, locationName, stockTemplateId, stockTemplateName, status }) => ({
    locationId,
    locationName,
    stockTemplateId,
    stockTemplateName,
    status: status || "Not Started",
  }));

  const batch = writeBatch(db);
  batch.update(stockCountRef, {
    locations: locationSummaries,
    updatedAt,
    updatedBy: updatedBy || null,
  });
  if (locationPayload) {
    batch.set(locationRef, locationPayload, { merge: true });
  }
  await batch.commit();
}


export async function finishStockCountLocation(
  hotelUid,
  stockCountId,
  locationId,
  countedItems,
  templateItemsToAdd = [],
  updatedBy
) {
  if (!hotelUid || !stockCountId || !locationId) {
    throw new Error("hotelUid, stockCountId en locationId zijn verplicht");
  }

  const stockCount = await getStockCountById(hotelUid, stockCountId);
  if (!stockCount) throw new Error("Stock count niet gevonden");

  const normalizedLocationId = String(locationId || "").trim();
  const currentLocation = (stockCount.locations || []).find(
    (location) => String(location?.locationId || "").trim() === normalizedLocationId
  );
  if (!currentLocation) throw new Error("Stock count location niet gevonden");

  const normalizedCountedItems = normalizeCountedItems(countedItems);
  const normalizedTemplateItemsToAdd = Array.isArray(templateItemsToAdd)
    ? templateItemsToAdd.map(normalizeStockTemplateItem).filter((item) => item.supplierProductId && item.outletId)
    : [];
  const existingTemplateItems = Array.isArray(currentLocation.stockTemplate?.items)
    ? currentLocation.stockTemplate.items.map(normalizeStockTemplateItem).filter((item) => item.supplierProductId && item.outletId)
    : [];
  const templateItemKeys = new Set(existingTemplateItems.map(buildStockTemplateItemKey));
  const newTemplateItems = [];

  normalizedTemplateItemsToAdd.forEach((item) => {
    const key = buildStockTemplateItemKey(item);
    if (templateItemKeys.has(key)) return;
    templateItemKeys.add(key);
    newTemplateItems.push(item);
  });

  const updatedAt = new Date();
  const nextLocations = (stockCount.locations || []).map((location) => {
    if (String(location?.locationId || "").trim() !== normalizedLocationId) return location;

    return {
      ...location,
      stockTemplate: {
        ...(location.stockTemplate || {}),
        items: [...existingTemplateItems, ...newTemplateItems],
      },
      countedItems: normalizedCountedItems,
      status: "Finished",
      updatedAt,
      updatedBy: updatedBy || null,
      finishedAt: updatedAt,
      finishedBy: updatedBy || null,
    };
  });

  const stockCountRef = doc(db, `hotels/${hotelUid}/stockCounts`, stockCountId);
  const locationRef = doc(db, `hotels/${hotelUid}/stockCounts/${stockCountId}/locations`, normalizedLocationId);
  const locationPayload = nextLocations.find(
    (location) => String(location?.locationId || "").trim() === normalizedLocationId
  );
  const locationSummaries = nextLocations.map(({ locationId, locationName, stockTemplateId, stockTemplateName, status }) => ({
    locationId,
    locationName,
    stockTemplateId,
    stockTemplateName,
    status: status || "Not Started",
  }));

  const batch = writeBatch(db);
  batch.update(stockCountRef, {
    locations: locationSummaries,
    updatedAt,
    updatedBy: updatedBy || null,
  });
  batch.set(locationRef, locationPayload, { merge: true });

  if (newTemplateItems.length && currentLocation.stockTemplateId) {
    const templateRef = doc(
      db,
      `hotels/${hotelUid}/locations/${normalizedLocationId}/stockTemplates`,
      currentLocation.stockTemplateId
    );
    batch.update(templateRef, {
      items: [...existingTemplateItems, ...newTemplateItems],
      updatedAt,
      updatedBy: updatedBy || null,
    });
  }

  await batch.commit();
}

export async function updateStockCountLocationStatus(hotelUid, stockCountId, locationId, status, updatedBy) {
  if (!hotelUid || !stockCountId || !locationId) {
    throw new Error("hotelUid, stockCountId en locationId zijn verplicht");
  }

  const nextStatus = String(status || "").trim();
  if (!nextStatus) throw new Error("Status is verplicht");

  const stockCount = await getStockCountById(hotelUid, stockCountId);
  if (!stockCount) throw new Error("Stock count niet gevonden");

  const normalizedLocationId = String(locationId || "").trim();
  const updatedAt = new Date();
  const nextLocations = (stockCount.locations || []).map((location) => {
    if (String(location?.locationId || "").trim() !== normalizedLocationId) return location;

    return {
      ...location,
      status: nextStatus,
      updatedAt,
      updatedBy: updatedBy || null,
      ...(nextStatus === "Finished" ? { finishedAt: updatedAt, finishedBy: updatedBy || null } : {}),
    };
  });
  const locationPayload = nextLocations.find(
    (location) => String(location?.locationId || "").trim() === normalizedLocationId
  );
  if (!locationPayload) throw new Error("Stock count location niet gevonden");

  const stockCountRef = doc(db, `hotels/${hotelUid}/stockCounts`, stockCountId);
  const locationRef = doc(db, `hotels/${hotelUid}/stockCounts/${stockCountId}/locations`, normalizedLocationId);
  const locationSummaries = nextLocations.map(({ locationId, locationName, stockTemplateId, stockTemplateName, status }) => ({
    locationId,
    locationName,
    stockTemplateId,
    stockTemplateName,
    status: status || "Not Started",
  }));

  const batch = writeBatch(db);
  batch.update(stockCountRef, {
    locations: locationSummaries,
    updatedAt,
    updatedBy: updatedBy || null,
  });
  batch.set(locationRef, locationPayload, { merge: true });
  await batch.commit();
}
