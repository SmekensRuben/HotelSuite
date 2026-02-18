// src/services/firebaseSettings.js
import {
  collection,
  db,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  writeBatch,
} from "../firebaseConfig";
import { getSelectedHotelUid } from "../utils/hotelUtils";

// *** ALGEMENE SETTINGS ***
export async function getSettings(hotelUid) {
  if (!hotelUid) return {};
  const settingsDoc = doc(db, `hotels/${hotelUid}/settings`, hotelUid);
  const snapshot = await getDoc(settingsDoc);
  return snapshot.exists() ? snapshot.data() : {};
}

export async function setSettings(hotelUid, settingsObj) {
  if (!hotelUid) return;
  const settingsDoc = doc(db, `hotels/${hotelUid}/settings`, hotelUid);
  await setDoc(settingsDoc, settingsObj, { merge: true });
}

// *** OUTLETS ***
export async function getOutlets(hotelUid) {
  if (!hotelUid) return [];

  const outletsCol = collection(db, `hotels/${hotelUid}/outlets`);
  const snapshot = await getDocs(outletsCol);

  const outlets = snapshot.docs.map(docSnap => {
    const data = docSnap.data() || {};
    const normalizedId = String(data.id || docSnap.id || "").trim();

    return {
      ...data,
      id: normalizedId || undefined,
      name: data.name || normalizedId,
      subOutlets: Array.isArray(data.subOutlets)
        ? data.subOutlets.map(sub => ({
            ...sub,
            subType: sub?.subType || "",
          }))
        : [],
      menuCategories: Array.isArray(data.menuCategories) ? data.menuCategories : [],
      costCenterIds: Array.isArray(data.costCenterIds)
        ? data.costCenterIds
            .map(id => (id === null || id === undefined ? "" : String(id).trim()))
            .filter(Boolean)
        : [],
    };
  });

  return outlets.sort((a, b) =>
    String(a?.name || "").localeCompare(String(b?.name || ""), undefined, {
      sensitivity: "base",
      numeric: true,
    })
  );
}

export async function setOutlets(hotelUid, outlets) {
  if (!hotelUid) return [];

  const outletsCol = collection(db, `hotels/${hotelUid}/outlets`);
  const existingSnapshot = await getDocs(outletsCol);

  const batch = writeBatch(db);
  const incomingIds = new Set();
  const normalizedOutlets = outlets.map(outlet => {
    const cleaned = {
      ...outlet,
      subOutlets: Array.isArray(outlet.subOutlets)
        ? outlet.subOutlets.map(sub => ({
            ...sub,
            subType: sub?.subType || "",
          }))
        : [],
      menuCategories: Array.isArray(outlet.menuCategories)
        ? outlet.menuCategories
        : [],
      costCenterIds: Array.isArray(outlet.costCenterIds)
        ? outlet.costCenterIds
            .map(id => (id === null || id === undefined ? "" : String(id).trim()))
            .filter(Boolean)
        : [],
    };

    let docId = String(cleaned.id || cleaned.name || "").trim();
    let docRef;
    if (docId) {
      docRef = doc(db, `hotels/${hotelUid}/outlets`, docId);
    } else {
      docRef = doc(outletsCol);
      docId = docRef.id;
    }

    cleaned.id = docId;
    incomingIds.add(docId);
    batch.set(docRef, cleaned);

    return cleaned;
  });

  existingSnapshot.forEach(docSnap => {
    if (!incomingIds.has(docSnap.id)) {
      batch.delete(docSnap.ref);
    }
  });

  await batch.commit();

  return normalizedOutlets;
}

export async function transferOutletsToCollection(hotelUid) {
  if (!hotelUid) return { transferred: 0 };

  const settingsDoc = doc(db, `hotels/${hotelUid}/settings`, hotelUid);
  const snap = await getDoc(settingsDoc);
  if (!snap.exists()) {
    return { transferred: 0 };
  }

  const outlets = Array.isArray(snap.data().outlets) ? snap.data().outlets : [];
  if (!outlets.length) {
    return { transferred: 0 };
  }

  const outletsCol = collection(db, `hotels/${hotelUid}/outlets`);
  let transferred = 0;
  const chunkSize = 400;

  for (let i = 0; i < outlets.length; i += chunkSize) {
    const batch = writeBatch(db);
    outlets.slice(i, i + chunkSize).forEach(outlet => {
      const rawId = outlet?.id ?? outlet?.name ?? "";
      const outletId = String(rawId).trim();
      const outletRef = outletId
        ? doc(db, `hotels/${hotelUid}/outlets`, outletId)
        : doc(outletsCol);
      batch.set(outletRef, outlet);
      transferred += 1;
    });
    await batch.commit();
  }

  return { transferred };
}

// *** CATEGORIEËN ***
export async function getCategories() {
  const hotelId = getSelectedHotelUid();
  const settingsDoc = doc(db, `hotels/${hotelId}/settings`, hotelId);
  const snapshot = await getDoc(settingsDoc);
  return snapshot.exists() && snapshot.data().categories
    ? snapshot.data().categories
    : {};
}

export async function addCategory(key, label, vat, type, parentId = "") {
  const hotelId = getSelectedHotelUid();
  const settingsDoc = doc(db, `hotels/${hotelId}/settings`, hotelId);
  // Voeg de nieuwe categorie toe of update bestaande
  const snapshot = await getDoc(settingsDoc);
  let categories = {};
  if (snapshot.exists() && snapshot.data().categories) {
    categories = { ...snapshot.data().categories };
  }
  categories[key] = { label, vat, type, parentId };
  await updateDoc(settingsDoc, { categories });
}

export async function deleteCategory(key) {
  const hotelId = getSelectedHotelUid();
  const settingsDoc = doc(db, `hotels/${hotelId}/settings`, hotelId);
  // Firestore kan geen veld direct deleten uit een map met updateDoc({ ... }), dus eerst ophalen, verwijderen en dan wegschrijven
  const snapshot = await getDoc(settingsDoc);
  if (snapshot.exists() && snapshot.data().categories) {
    const categories = { ...snapshot.data().categories };
    delete categories[key];
    await updateDoc(settingsDoc, { categories });
  }
}

// *** PRODUCT-CATEGORIEËN ***
export async function getProductCategories() {
  const hotelId = getSelectedHotelUid();
  const settingsDoc = doc(db, `hotels/${hotelId}/settings`, hotelId);
  const snapshot = await getDoc(settingsDoc);
  return snapshot.exists() && snapshot.data().productCategories
    ? snapshot.data().productCategories
    : {};
}

export async function addProductCategory(key, label, vat, type, parentId = "") {
  const hotelId = getSelectedHotelUid();
  const settingsDoc = doc(db, `hotels/${hotelId}/settings`, hotelId);
  const snapshot = await getDoc(settingsDoc);
  let productCategories = {};
  if (snapshot.exists() && snapshot.data().productCategories) {
    productCategories = { ...snapshot.data().productCategories };
  }
  productCategories[key] = { label, vat, type, parentId };
  await updateDoc(settingsDoc, { productCategories });
}

export async function deleteProductCategory(key) {
  const hotelId = getSelectedHotelUid();
  const settingsDoc = doc(db, `hotels/${hotelId}/settings`, hotelId);
  const snapshot = await getDoc(settingsDoc);
  if (snapshot.exists() && snapshot.data().productCategories) {
    const productCategories = { ...snapshot.data().productCategories };
    delete productCategories[key];
    await updateDoc(settingsDoc, { productCategories });
  }
}

// LOCATIONS - analoog aan outlets
export async function getLocations(hotelUid) {
  // Haal het settings document op voor dit hotel
  const docRef = doc(db, `hotels/${hotelUid}/settings`, hotelUid);
  const docSnap = await getDoc(docRef);
  return docSnap.exists() && Array.isArray(docSnap.data().locations)
    ? docSnap.data().locations
    : [];
}

export async function setLocations(hotelUid, locations) {
  // Zet locaties als veld in settings document
  const docRef = doc(db, `hotels/${hotelUid}/settings`, hotelUid);
  // setDoc({ merge: true }) voorkomt dat je bestaande data overschrijft
  await setDoc(docRef, { locations }, { merge: true });
}




// *** UNITS ***
export async function getUnits(hotelUid) {
  if (!hotelUid) return [];
  const unitsDoc = doc(db, "units", hotelUid);
  const snap = await getDoc(unitsDoc);
  return snap.exists() && snap.data().units ? snap.data().units : [];
}

export async function setUnits(hotelUid, units) {
  if (!hotelUid) return;
  const unitsDoc = doc(db, "units", hotelUid);
  await setDoc(unitsDoc, { units });
}

// *** LEVERANCIERS ***
export async function getSuppliers() {
  const hotelId = getSelectedHotelUid();
  const settingsDoc = doc(db, `hotels/${hotelId}/settings`, hotelId);
  const snapshot = await getDoc(settingsDoc);
  if (!snapshot.exists() || !snapshot.data().suppliers) return [];
  const obj = snapshot.data().suppliers;
  return Object.entries(obj).map(([key, value]) => ({ key, ...value }));
}

export async function addSupplier(supplierObj) {
  const hotelId = getSelectedHotelUid();
  const settingsDoc = doc(db, `hotels/${hotelId}/settings`, hotelId);
  // Voeg supplier toe aan de map suppliers
  const snapshot = await getDoc(settingsDoc);
  let suppliers = {};
  if (snapshot.exists() && snapshot.data().suppliers) {
    suppliers = { ...snapshot.data().suppliers };
  }
  suppliers[supplierObj.name] = supplierObj;
  await updateDoc(settingsDoc, { suppliers });
}

export async function deleteSupplier(name) {
  const hotelId = getSelectedHotelUid();
  const settingsDoc = doc(db, `hotels/${hotelId}/settings`, hotelId);
  // Firestore: verwijder veld uit object
  const snapshot = await getDoc(settingsDoc);
  if (snapshot.exists() && snapshot.data().suppliers) {
    const suppliers = { ...snapshot.data().suppliers };
    delete suppliers[name];
    await updateDoc(settingsDoc, { suppliers });
  }
}

// *** SALES & PROMO CATEGORIEN ***
export async function getSalesPromoCategories(hotelUid) {
  if (!hotelUid) return [];
  const docRef = doc(db, `hotels/${hotelUid}/settings`, hotelUid);
  const snap = await getDoc(docRef);
  return snap.exists() && Array.isArray(snap.data().salesAndPromoCategories)
    ? snap.data().salesAndPromoCategories
    : [];
}

export async function setSalesPromoCategories(hotelUid, categories) {
  if (!hotelUid) return;
  const docRef = doc(db, `hotels/${hotelUid}/settings`, hotelUid);
  await setDoc(docRef, { salesAndPromoCategories: categories }, { merge: true });
}

// *** SALES & PROMO TYPES ***
const mapSalesPromoType = type => {
  if (typeof type === "string") {
    return { name: type, checklist: [] };
  }
  if (type && typeof type === "object") {
    const name = typeof type.name === "string" ? type.name.trim() : "";
    if (!name) return null;
    const checklist = Array.isArray(type.checklist)
      ? type.checklist.filter(item => typeof item === "string" && item.trim()).map(item => item.trim())
      : [];
    return { name, checklist };
  }
  return null;
};

export async function getSalesPromoTypes(hotelUid) {
  if (!hotelUid) return [];
  const docRef = doc(db, `hotels/${hotelUid}/settings`, hotelUid);
  const snap = await getDoc(docRef);
  if (!snap.exists()) return [];
  const raw = snap.data().salesPromoTypes;
  if (!Array.isArray(raw)) return [];
  return raw
    .map(mapSalesPromoType)
    .filter(Boolean);
}

export async function setSalesPromoTypes(hotelUid, types) {
  if (!hotelUid) return;
  const docRef = doc(db, `hotels/${hotelUid}/settings`, hotelUid);
  const sanitized = Array.isArray(types)
    ? types
        .map(mapSalesPromoType)
        .filter(Boolean)
    : [];
  await setDoc(docRef, { salesPromoTypes: sanitized }, { merge: true });
}

// *** SALES & PROMO PRODUCTS ***
export async function getSalesPromoProducts(hotelUid) {
  if (!hotelUid) return [];
  const docRef = doc(db, `hotels/${hotelUid}/settings`, hotelUid);
  const snap = await getDoc(docRef);
  return snap.exists() && Array.isArray(snap.data().salesPromoProducts)
    ? snap.data().salesPromoProducts
    : [];
}

export async function setSalesPromoProducts(hotelUid, products) {
  if (!hotelUid) return;
  const docRef = doc(db, `hotels/${hotelUid}/settings`, hotelUid);
  await setDoc(docRef, { salesPromoProducts: products }, { merge: true });
}

// *** CATEGORIE-MAPPING ***
export async function getCategoryMappings() {
  const hotelId = getSelectedHotelUid();
  const docRef = doc(db, `hotels/${hotelId}/settings`, hotelId);
  const snap = await getDoc(docRef);
  return snap.exists() && snap.data().categoryMappings
    ? snap.data().categoryMappings
    : {};
}

export async function addCategoryMapping(productCategoryKey, categoryKey) {
  const hotelId = getSelectedHotelUid();
  const docRef = doc(db, `hotels/${hotelId}/settings`, hotelId);
  const snap = await getDoc(docRef);
  let mappings = {};
  if (snap.exists() && snap.data().categoryMappings) {
    mappings = { ...snap.data().categoryMappings };
  }
  mappings[productCategoryKey] = categoryKey;
  await updateDoc(docRef, { categoryMappings: mappings });
}

export async function deleteCategoryMapping(productCategoryKey) {
  const hotelId = getSelectedHotelUid();
  const docRef = doc(db, `hotels/${hotelId}/settings`, hotelId);
  const snap = await getDoc(docRef);
  if (snap.exists() && snap.data().categoryMappings) {
    const mappings = { ...snap.data().categoryMappings };
    delete mappings[productCategoryKey];
    await updateDoc(docRef, { categoryMappings: mappings });
  }
}
// *** STAFF / PERSONEEL ***
function normalizeHoursHistory(history = []) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(entry => entry && (entry.date || entry.hours))
    .map((entry, index) => ({
      id:
        entry.id ||
        `${entry.date || "unknown"}-${index}-${Math.random().toString(36).slice(2, 8)}`,
      date: entry.date || "",
      hours:
        typeof entry.hours === "number"
          ? entry.hours
          : Number.parseFloat(entry.hours) || 0,
      note: entry.note || "",
    }));
}

function normalizeStaffRecord(value = {}, fallbackId = "") {
  const id = value?.id || value?.key || value?.name || fallbackId;
  return {
    id,
    key: id,
    ...value,
    contractHours:
      typeof value?.contractHours === "number"
        ? value.contractHours
        : value?.contractHours
        ? Number.parseFloat(value.contractHours) || null
        : null,
    hourlyWage:
      typeof value?.hourlyWage === "number"
        ? value.hourlyWage
        : value?.hourlyWage
        ? Number.parseFloat(value.hourlyWage) || null
        : null,
    hoursHistory: normalizeHoursHistory(value?.hoursHistory),
  };
}

async function getLegacyStaff(hotelId) {
  const docRef = doc(db, `hotels/${hotelId}/settings`, hotelId);
  const snap = await getDoc(docRef);
  if (!snap.exists() || !snap.data().staff) return [];
  const obj = snap.data().staff;
  return Object.entries(obj).map(([key, value]) => normalizeStaffRecord(value, key));
}

async function deleteLegacyStaffMember(hotelId, id) {
  const docRef = doc(db, `hotels/${hotelId}/settings`, hotelId);
  const snap = await getDoc(docRef);
  if (!snap.exists() || !snap.data().staff) return;
  const staff = { ...snap.data().staff };
  if (staff[id]) {
    delete staff[id];
    await updateDoc(docRef, { staff });
  }
}

const createStaffContractTypeId = () => {
  if (typeof globalThis !== "undefined" && globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `staff_contract_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
};

const normalizeStaffContractType = (value = {}, fallbackId = "") => {
  const id = value?.id || fallbackId || createStaffContractTypeId();
  const coefficientRaw =
    value?.coefficient === null || value?.coefficient === undefined || value?.coefficient === ""
      ? 1
      : typeof value.coefficient === "number"
      ? value.coefficient
      : Number.parseFloat(value.coefficient);
  const coefficient = Number.isFinite(coefficientRaw) ? coefficientRaw : 1;
  return {
    id,
    name: String(value?.name || value?.label || "").trim(),
    coefficient,
  };
};

async function setStaffContractTypes(hotelUid, contractTypes) {
  if (!hotelUid) return [];
  const docRef = doc(db, `hotels/${hotelUid}/settings`, hotelUid);
  const normalized = Array.isArray(contractTypes)
    ? contractTypes.map(type => normalizeStaffContractType(type))
    : [];
  await setDoc(
    docRef,
    {
      staffContractTypes: normalized,
    },
    { merge: true }
  );
  return normalized;
}

export async function getStaffContractTypes(hotelUid = getSelectedHotelUid()) {
  if (!hotelUid) return [];
  const docRef = doc(db, `hotels/${hotelUid}/settings`, hotelUid);
  const snap = await getDoc(docRef);
  if (!snap.exists()) return [];
  const list = snap.data().staffContractTypes;
  if (!Array.isArray(list)) return [];
  return list.map((type, index) => normalizeStaffContractType(type, `staff_contract_${index}`));
}

export async function addStaffContractType(contractType) {
  const hotelUid = getSelectedHotelUid();
  if (!hotelUid) return null;
  const existing = await getStaffContractTypes(hotelUid);
  const newType = normalizeStaffContractType({ ...contractType, id: createStaffContractTypeId() });
  const updated = [...existing, newType];
  await setStaffContractTypes(hotelUid, updated);
  return newType;
}

export async function updateStaffContractType(id, updates) {
  const hotelUid = getSelectedHotelUid();
  if (!hotelUid || !id) return null;
  const existing = await getStaffContractTypes(hotelUid);
  const updated = existing.map(type => (type.id === id ? normalizeStaffContractType({ ...type, ...updates, id }) : type));
  await setStaffContractTypes(hotelUid, updated);
  return updated.find(type => type.id === id) || null;
}

export async function deleteStaffContractType(id) {
  const hotelUid = getSelectedHotelUid();
  if (!hotelUid || !id) return [];
  const existing = await getStaffContractTypes(hotelUid);
  const updated = existing.filter(type => type.id !== id);
  await setStaffContractTypes(hotelUid, updated);
  return updated;
}

export async function getStaff() {
  const hotelId = getSelectedHotelUid();
  if (!hotelId) return [];
  const staffCollection = collection(db, `hotels/${hotelId}/staff`);
  const staffSnap = await getDocs(staffCollection);
  const staff = staffSnap.docs.map(docSnap => normalizeStaffRecord(docSnap.data(), docSnap.id));
  if (staff.length > 0) {
    return staff;
  }
  return getLegacyStaff(hotelId);
}

function getStaffId(staffObj = {}) {
  if (!staffObj) return null;
  return staffObj.id || staffObj.key || staffObj.name || null;
}

export async function saveStaffMember(staffObj) {
  const hotelId = getSelectedHotelUid();
  if (!hotelId) return null;
  const id = getStaffId(staffObj);
  if (!id) {
    throw new Error("Personeelslid moet een id of naam hebben om op te slaan.");
  }
  const staffDocRef = doc(db, `hotels/${hotelId}/staff`, id);
  const existingSnap = await getDoc(staffDocRef);
  const existing = existingSnap.exists() ? existingSnap.data() : {};
  const mergedHistory = Array.isArray(staffObj?.hoursHistory)
    ? normalizeHoursHistory(staffObj.hoursHistory)
    : normalizeHoursHistory(existing.hoursHistory);

  const normalizedContractHours =
    staffObj.contractHours === null || staffObj.contractHours === undefined || staffObj.contractHours === ""
      ? null
      : typeof staffObj.contractHours === "number"
      ? staffObj.contractHours
      : Number.parseFloat(staffObj.contractHours) || null;

  const normalizedHourlyWage =
    staffObj.hourlyWage === null || staffObj.hourlyWage === undefined || staffObj.hourlyWage === ""
      ? null
      : typeof staffObj.hourlyWage === "number"
      ? staffObj.hourlyWage
      : Number.parseFloat(staffObj.hourlyWage) || null;

  const payload = {
    ...existing,
    ...staffObj,
    id,
    key: id,
    contractHours: normalizedContractHours,
    hourlyWage: normalizedHourlyWage,
    hoursHistory: mergedHistory,
  };

  await setDoc(staffDocRef, payload);
  await deleteLegacyStaffMember(hotelId, id);
  return normalizeStaffRecord(payload, id);
}

export async function addStaffMember(staffObj) {
  return saveStaffMember(staffObj);
}

export async function deleteStaffMember(id) {
  const hotelId = getSelectedHotelUid();
  if (!hotelId) return;
  const staffId = id || null;
  if (!staffId) return;
  const staffDocRef = doc(db, `hotels/${hotelId}/staff`, staffId);
  await deleteDoc(staffDocRef);
  await deleteLegacyStaffMember(hotelId, staffId);
}

export async function getStaffMember(id) {
  if (!id) return null;
  const hotelId = getSelectedHotelUid();
  if (!hotelId) return null;
  const staffDocRef = doc(db, `hotels/${hotelId}/staff`, id);
  const snap = await getDoc(staffDocRef);
  if (snap.exists()) {
    return normalizeStaffRecord(snap.data(), snap.id);
  }
  const legacyStaff = await getLegacyStaff(hotelId);
  return legacyStaff.find(member => member.id === id || member.key === id || member.name === id) || null;
}
