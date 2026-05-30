import { collection, db, doc, getDoc, getDocs, serverTimestamp, setDoc, updateDoc } from "../firebaseConfig";

export const STOCK_COUNT_TYPES = ["Ad Hoc", "Daily", "Weekly", "Month-End"];

function normalizeDate(value) {
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate();
  if (value instanceof Date) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function normalizeStockCount(data = {}, fallbackId = "") {
  const locations = Array.isArray(data.locations) ? data.locations : [];
  const createdAt = normalizeDate(data.createdAt);

  return {
    id: String(data.id || fallbackId || "").trim() || fallbackId,
    name: String(data.name || "").trim(),
    type: STOCK_COUNT_TYPES.includes(data.type) ? data.type : "Ad Hoc",
    locations: locations.map((location) => ({
      locationId: String(location?.locationId || "").trim(),
      locationName: String(location?.locationName || "").trim(),
      stockTemplateId: String(location?.stockTemplateId || "").trim(),
      stockTemplateName: String(location?.stockTemplateName || "").trim(),
      countedItems: normalizeCountedItems(location?.countedItems),
    })),
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

  return normalizeStockCount(snapshot.data(), snapshot.id);
}

export async function createStockCount(hotelUid, input) {
  if (!hotelUid) throw new Error("hotelUid is verplicht");

  const name = String(input?.name || "").trim();
  if (!name) throw new Error("Name is verplicht");

  const type = STOCK_COUNT_TYPES.includes(input?.type) ? input.type : "Ad Hoc";
  const locations = Array.isArray(input?.locations)
    ? input.locations
        .map((location) => ({
          locationId: String(location?.locationId || "").trim(),
          locationName: String(location?.locationName || "").trim(),
          stockTemplateId: String(location?.stockTemplateId || "").trim(),
          stockTemplateName: String(location?.stockTemplateName || "").trim(),
          countedItems: [],
        }))
        .filter((location) => location.locationId)
    : [];

  if (!locations.length) throw new Error("Selecteer minimaal één locatie");

  const stockCountsCol = collection(db, `hotels/${hotelUid}/stockCounts`);
  const stockCountRef = doc(stockCountsCol);
  const payload = {
    id: stockCountRef.id,
    name,
    type,
    locations,
    createdBy: input?.createdBy || null,
    createdAt: serverTimestamp(),
  };

  await setDoc(stockCountRef, payload);
  return { ...payload, createdAt: new Date() };
}

export async function updateStockCountLocationCounts(hotelUid, stockCountId, locationId, countedItems, updatedBy) {
  if (!hotelUid || !stockCountId || !locationId) {
    throw new Error("hotelUid, stockCountId en locationId zijn verplicht");
  }

  const stockCount = await getStockCountById(hotelUid, stockCountId);
  if (!stockCount) throw new Error("Stock count niet gevonden");

  const normalizedLocationId = String(locationId || "").trim();
  const nextLocations = (stockCount.locations || []).map((location) => {
    if (String(location?.locationId || "").trim() !== normalizedLocationId) return location;

    return {
      ...location,
      countedItems: normalizeCountedItems(countedItems),
      updatedAt: new Date(),
      updatedBy: updatedBy || null,
    };
  });

  const stockCountRef = doc(db, `hotels/${hotelUid}/stockCounts`, stockCountId);
  await updateDoc(stockCountRef, {
    locations: nextLocations,
    updatedAt: new Date(),
    updatedBy: updatedBy || null,
  });
}
