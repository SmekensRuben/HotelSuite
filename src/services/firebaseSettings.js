import { functions, httpsCallable } from "../firebaseConfig";
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
import { runTransaction } from "firebase/firestore";

// Each settings domain has its own authority; never read the retired shared document.
export async function getHotelBootstrap(hotelUid) {
  if (!hotelUid) return {};
  const settingsDoc = doc(db, `hotels/${hotelUid}/settings/bootstrap`);
  const snapshot = await getDoc(settingsDoc);
  return snapshot.exists() ? snapshot.data() : {};
}

export async function getPropertySettings(hotelUid) {
  if (!hotelUid) return {};
  const snapshot = await getDoc(doc(db, `hotels/${hotelUid}/settings/propertySettings`));
  return snapshot.exists() ? snapshot.data() : {};
}

export const MAX_SETTINGS_BATCH_MUTATIONS = 400;
const requireId = (value, label = "ID") => {
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > 128 || value.includes("/") || [".", ".."].includes(value) || /^__.*__$/.test(value) || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} must be a nonempty ID of at most 128 characters.`);
  }
  return value;
};
const requireName = (value, label = "Name") => {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name || name.length > 200 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error(`${label} must contain 1 to 200 characters without control characters.`);
  return name;
};
const taxonomyPath = (hotelUid, domain, kind) =>
  `hotels/${requireId(hotelUid, "Hotel ID")}/settings/${domain}/${kind}`;

async function getTaxonomy(hotelUid, domain) {
  if (!hotelUid) return { categories: [], subcategories: [] };
  const [categories, subcategories] = await Promise.all([
    getDocs(collection(db, taxonomyPath(hotelUid, domain, "categories"))),
    getDocs(collection(db, taxonomyPath(hotelUid, domain, "subcategories"))),
  ]);
  const records = (snapshot) => snapshot.docs.map((record) => ({ ...record.data(), id: record.id }));
  return { categories: records(categories), subcategories: records(subcategories) };
}

async function createTaxonomyRecord(hotelUid, domain, kind, input) {
  const reference = doc(collection(db, taxonomyPath(hotelUid, domain, kind)));
  const payload = { name: requireName(input?.name) };
  if (kind === "subcategories") payload.categoryId = requireId(input?.categoryId, "Category ID");
  await setDoc(reference, payload);
  return { id: reference.id, ...payload };
}

async function updateTaxonomyRecord(hotelUid, domain, kind, id, input) {
  const payload = { name: requireName(input?.name) };
  if (kind === "subcategories") payload.categoryId = requireId(input?.categoryId, "Category ID");
  await updateDoc(doc(db, taxonomyPath(hotelUid, domain, kind), requireId(id)), payload);
}

async function deleteTaxonomyCategory(hotelUid, domain, categoryId) {
  requireId(categoryId, "Category ID");
  // Read current children rather than replacing the page's possibly stale taxonomy.
  const snapshot = await getDocs(collection(db, taxonomyPath(hotelUid, domain, "subcategories")));
  const linked = snapshot.docs.filter((record) => record.data().categoryId === categoryId);
  if (linked.length + 1 > MAX_SETTINGS_BATCH_MUTATIONS) {
    throw new Error("This category has too many subcategories to delete at once. Delete subcategories first.");
  }
  const categoryRef = doc(db, taxonomyPath(hotelUid, domain, "categories"), categoryId);
  await runTransaction(db, async (transaction) => {
    // A child moved to another category after enumeration must survive deletion.
    const current = await Promise.all([transaction.get(categoryRef), ...linked.map((record) => transaction.get(record.ref))]);
    current.slice(1).forEach((record) => {
      if (record.exists() && record.data().categoryId === categoryId) transaction.delete(record.ref);
    });
    transaction.delete(categoryRef);
  });
}

async function deleteTaxonomySubcategory(hotelUid, domain, subcategoryId) {
  await deleteDoc(doc(db, taxonomyPath(hotelUid, domain, "subcategories"), requireId(subcategoryId)));
}

export const getCatalogTaxonomy = (hotelUid) => getTaxonomy(hotelUid, "catalog");
export const createCatalogCategory = (hotelUid, input) => createTaxonomyRecord(hotelUid, "catalog", "categories", input);
export const updateCatalogCategory = (hotelUid, id, input) => updateTaxonomyRecord(hotelUid, "catalog", "categories", id, input);
export const deleteCatalogCategory = (hotelUid, id) => deleteTaxonomyCategory(hotelUid, "catalog", id);
export const createCatalogSubcategory = (hotelUid, input) => createTaxonomyRecord(hotelUid, "catalog", "subcategories", input);
export const updateCatalogSubcategory = (hotelUid, id, input) => updateTaxonomyRecord(hotelUid, "catalog", "subcategories", id, input);
export const deleteCatalogSubcategory = (hotelUid, id) => deleteTaxonomySubcategory(hotelUid, "catalog", id);
export const getContractTaxonomy = (hotelUid) => getTaxonomy(hotelUid, "contracts");
export const createContractCategory = (hotelUid, input) => createTaxonomyRecord(hotelUid, "contracts", "categories", input);
export const updateContractCategory = (hotelUid, id, input) => updateTaxonomyRecord(hotelUid, "contracts", "categories", id, input);
export const deleteContractCategory = (hotelUid, id) => deleteTaxonomyCategory(hotelUid, "contracts", id);
export const createContractSubcategory = (hotelUid, input) => createTaxonomyRecord(hotelUid, "contracts", "subcategories", input);
export const updateContractSubcategory = (hotelUid, id, input) => updateTaxonomyRecord(hotelUid, "contracts", "subcategories", id, input);
export const deleteContractSubcategory = (hotelUid, id) => deleteTaxonomySubcategory(hotelUid, "contracts", id);

const operaMappingsPath = (hotelUid) => `hotels/${requireId(hotelUid, "Hotel ID")}/settings/opera/userMappings`;
const operaMappingId = (operaUser) => requireId(requireName(operaUser, "Opera username"), "Opera username");

export async function getOperaSettings(hotelUid) {
  if (!hotelUid) return { operaUserMappings: {} };
  const snapshot = await getDocs(collection(db, operaMappingsPath(hotelUid)));
  return { operaUserMappings: Object.fromEntries(snapshot.docs.map((record) => {
    const data = record.data();
    return [data.operaUser, data.employeeName];
  })) };
}

export async function createOperaUserMapping(hotelUid, input) {
  const payload = { operaUser: requireName(input?.operaUser, "Opera username"), employeeName: requireName(input?.employeeName, "Employee name") };
  const reference = doc(db, operaMappingsPath(hotelUid), operaMappingId(payload.operaUser));
  await runTransaction(db, async (transaction) => {
    if ((await transaction.get(reference)).exists()) throw new Error("This Opera username already has a mapping. Edit the existing mapping.");
    transaction.set(reference, payload);
  });
}

export async function updateOperaUserMapping(hotelUid, operaUser, employeeName) {
  await updateDoc(doc(db, operaMappingsPath(hotelUid), operaMappingId(operaUser)), { employeeName: requireName(employeeName, "Employee name") });
}

export async function deleteOperaUserMapping(hotelUid, operaUser) {
  await deleteDoc(doc(db, operaMappingsPath(hotelUid), operaMappingId(operaUser)));
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


export async function createOutlet(hotelUid, outletInput) {
  if (!hotelUid) return null;

  const cleanedName = String(outletInput?.name || "").trim();
  if (!cleanedName) return null;

  const outletsCol = collection(db, `hotels/${hotelUid}/outlets`);
  const outletRef = doc(outletsCol);

  const payload = {
    id: outletRef.id,
    name: cleanedName,
    subOutlets: [],
    menuCategories: [],
    costCenterIds: [],
    createdBy: outletInput?.createdBy || null,
  };

  await setDoc(outletRef, payload);
  return payload;
}

export async function getOutletById(hotelUid, outletId) {
  if (!hotelUid || !outletId) return null;

  const outletRef = doc(db, `hotels/${hotelUid}/outlets`, outletId);
  const snap = await getDoc(outletRef);
  if (!snap.exists()) return null;

  const data = snap.data() || {};
  return {
    ...data,
    id: String(data.id || snap.id || "").trim() || snap.id,
    name: String(data.name || "").trim(),
  };
}

export async function updateOutlet(hotelUid, outletId, outletInput) {
  if (!hotelUid || !outletId) throw new Error("hotelUid en outletId zijn verplicht");

  const cleanedName = String(outletInput?.name || "").trim();
  if (!cleanedName) throw new Error("Outlet name is verplicht");

  const outletRef = doc(db, `hotels/${hotelUid}/outlets`, outletId);
  await updateDoc(outletRef, {
    name: cleanedName,
    updatedAt: new Date(),
    updatedBy: outletInput?.updatedBy || null,
  });
}

export async function getOutletApprovers(hotelUid, outletId) {
  if (!hotelUid || !outletId) return [];

  const approversCol = collection(db, `hotels/${hotelUid}/outlets/${outletId}/approvers`);
  const snapshot = await getDocs(approversCol);

  return snapshot.docs.map((docSnap) => {
    const data = docSnap.data() || {};
    return {
      id: docSnap.id,
      email: String(data.email || "").trim(),
      firstName: String(data.firstName || "").trim(),
      lastName: String(data.lastName || "").trim(),
      displayName: String(data.displayName || "").trim(),
    };
  });
}

export async function setOutletApprovers(hotelUid, outletId, approvers) {
  return (await httpsCallable(functions, "setHotelOutletApprovers")({ hotelUid, outletId,
    userIds: (Array.isArray(approvers) ? approvers : []).map((a) => a.id) })).data;
}

export async function getLocations(hotelUid) {
  if (!hotelUid) return [];

  const locationsCol = collection(db, `hotels/${hotelUid}/locations`);
  const snapshot = await getDocs(locationsCol);

  const locations = snapshot.docs.map((docSnap) => {
    const data = docSnap.data() || {};
    const normalizedId = String(data.id || docSnap.id || "").trim();

    return {
      ...data,
      id: normalizedId || undefined,
      name: String(data.name || normalizedId).trim(),
    };
  });

  return locations.sort((a, b) =>
    String(a?.name || "").localeCompare(String(b?.name || ""), undefined, {
      sensitivity: "base",
      numeric: true,
    })
  );
}

export async function createLocation(hotelUid, locationInput) {
  if (!hotelUid) return null;

  const cleanedName = String(locationInput?.name || "").trim();
  if (!cleanedName) return null;

  const locationsCol = collection(db, `hotels/${hotelUid}/locations`);
  const locationRef = doc(locationsCol);

  const payload = {
    id: locationRef.id,
    name: cleanedName,
    createdBy: locationInput?.createdBy || null,
  };

  await setDoc(locationRef, payload);
  return payload;
}

export async function getLocationById(hotelUid, locationId) {
  if (!hotelUid || !locationId) return null;

  const locationRef = doc(db, `hotels/${hotelUid}/locations`, locationId);
  const snap = await getDoc(locationRef);
  if (!snap.exists()) return null;

  const data = snap.data() || {};
  return {
    ...data,
    id: String(data.id || snap.id || "").trim() || snap.id,
    name: String(data.name || "").trim(),
  };
}

export async function updateLocation(hotelUid, locationId, locationInput) {
  if (!hotelUid || !locationId) throw new Error("hotelUid en locationId zijn verplicht");

  const cleanedName = String(locationInput?.name || "").trim();
  if (!cleanedName) throw new Error("Location name is verplicht");

  const locationRef = doc(db, `hotels/${hotelUid}/locations`, locationId);
  await updateDoc(locationRef, {
    name: cleanedName,
    updatedAt: new Date(),
    updatedBy: locationInput?.updatedBy || null,
  });
}

export async function getLocationStockTemplates(hotelUid, locationId) {
  if (!hotelUid || !locationId) return [];
  const templatesCol = collection(db, `hotels/${hotelUid}/locations/${locationId}/stockTemplates`);
  const snapshot = await getDocs(templatesCol);
  return snapshot.docs
    .map((docSnap) => {
      const data = docSnap.data() || {};
      return {
        ...data,
        id: String(data.id || docSnap.id || "").trim() || docSnap.id,
        name: String(data.name || "").trim(),
        items: Array.isArray(data.items) ? data.items : [],
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }));
}

export async function createLocationStockTemplate(hotelUid, locationId, templateName) {
  if (!hotelUid || !locationId) throw new Error("hotelUid en locationId zijn verplicht");
  const cleanedName = String(templateName || "").trim();
  if (!cleanedName) throw new Error("Template name is verplicht");
  const templatesCol = collection(db, `hotels/${hotelUid}/locations/${locationId}/stockTemplates`);
  const templateRef = doc(templatesCol);
  const payload = { id: templateRef.id, name: cleanedName, items: [], createdAt: new Date() };
  await setDoc(templateRef, payload);
  return payload;
}

export async function getLocationStockTemplateById(hotelUid, locationId, templateId) {
  if (!hotelUid || !locationId || !templateId) return null;
  const templateRef = doc(db, `hotels/${hotelUid}/locations/${locationId}/stockTemplates`, templateId);
  const snap = await getDoc(templateRef);
  if (!snap.exists()) return null;
  const data = snap.data() || {};
  return {
    ...data,
    id: String(data.id || snap.id || "").trim() || snap.id,
    name: String(data.name || "").trim(),
    items: Array.isArray(data.items) ? data.items : [],
  };
}

export async function addLocationStockTemplateItem(hotelUid, locationId, templateId, itemInput) {
  if (!hotelUid || !locationId || !templateId) throw new Error("hotelUid, locationId en templateId zijn verplicht");
  const template = await getLocationStockTemplateById(hotelUid, locationId, templateId);
  if (!template) throw new Error("Stock template niet gevonden");

  const nextItem = {
    supplierProductId: String(itemInput?.supplierProductId || "").trim(),
    outletId: String(itemInput?.outletId || "").trim(),
  };

  if (!nextItem.supplierProductId || !nextItem.outletId) {
    throw new Error("Supplier product en outlet zijn verplicht");
  }

  const hasDuplicate = (template.items || []).some((item) => {
    const supplierProductId = String(item?.supplierProductId || "").trim();
    const outletId = String(item?.outletId || "").trim();
    return supplierProductId === nextItem.supplierProductId && outletId === nextItem.outletId;
  });
  if (hasDuplicate) return;

  const templateRef = doc(db, `hotels/${hotelUid}/locations/${locationId}/stockTemplates`, templateId);
  await updateDoc(templateRef, { items: [...template.items, nextItem], updatedAt: new Date() });
}


export async function updateLocationStockTemplateItems(hotelUid, locationId, templateId, items) {
  if (!hotelUid || !locationId || !templateId) {
    throw new Error("hotelUid, locationId en templateId zijn verplicht");
  }

  const normalizedItems = Array.isArray(items)
    ? items
        .map((item) => ({
          supplierProductId: String(item?.supplierProductId || "").trim(),
          outletId: String(item?.outletId || "").trim(),
        }))
        .filter((item) => item.supplierProductId && item.outletId)
    : [];

  const templateRef = doc(db, `hotels/${hotelUid}/locations/${locationId}/stockTemplates`, templateId);
  await updateDoc(templateRef, { items: normalizedItems, updatedAt: new Date() });
}

export async function removeLocationStockTemplateItem(hotelUid, locationId, templateId, supplierProductId, outletId) {
  if (!hotelUid || !locationId || !templateId || !supplierProductId || !outletId) {
    throw new Error("hotelUid, locationId, templateId, supplierProductId en outletId zijn verplicht");
  }
  const template = await getLocationStockTemplateById(hotelUid, locationId, templateId);
  if (!template) throw new Error("Stock template niet gevonden");

  const normalizedSupplierProductId = String(supplierProductId || "").trim();
  const normalizedOutletId = String(outletId || "").trim();
  const nextItems = (template.items || []).filter((item) => {
    const itemSupplierProductId = String(item?.supplierProductId || "").trim();
    const itemOutletId = String(item?.outletId || "").trim();
    return itemSupplierProductId !== normalizedSupplierProductId || itemOutletId !== normalizedOutletId;
  });
  const templateRef = doc(db, `hotels/${hotelUid}/locations/${locationId}/stockTemplates`, templateId);
  await updateDoc(templateRef, { items: nextItems, updatedAt: new Date() });
}

// *** FILE IMPORT SETTINGS ***
export async function getFileImportSettings(hotelUid) {
  if (!hotelUid) return [];

  const settingsCol = collection(db, `hotels/${hotelUid}/fileImportSettings`);
  const snapshot = await getDocs(settingsCol);

  const fileImportSettings = snapshot.docs.map((docSnap) => {
    const data = docSnap.data() || {};
    return {
      id: String(data.id || docSnap.id || "").trim() || docSnap.id,
      reportName: String(data.reportName || "").trim(),
      fromEmail: String(data.fromEmail || "").trim(),
      toEmail: String(data.toEmail || "").trim(),
      subjectContains: String(data.subjectContains || data.subject || "").trim(),
      fileType: String(data.fileType || "").trim(),
    };
  });

  return fileImportSettings.sort((a, b) =>
    String(a?.reportName || "").localeCompare(String(b?.reportName || ""), undefined, {
      sensitivity: "base",
      numeric: true,
    })
  );
}

export async function createFileImportSetting(hotelUid, input) {
  if (!hotelUid) return null;

  const reportName = String(input?.reportName || "").trim();
  if (!reportName) return null;

  const fileImportSettingsCol = collection(db, `hotels/${hotelUid}/fileImportSettings`);
  const fileImportSettingRef = doc(fileImportSettingsCol);

  const payload = {
    id: fileImportSettingRef.id,
    reportName,
    fromEmail: String(input?.fromEmail || "").trim(),
    toEmail: String(input?.toEmail || "").trim(),
    subjectContains: String(input?.subjectContains || "").trim(),
    fileType: String(input?.fileType || "").trim(),
    createdBy: input?.createdBy || null,
    createdAt: new Date(),
  };

  await setDoc(fileImportSettingRef, payload);
  return payload;
}

export async function getFileImportSettingById(hotelUid, fileImportSettingId) {
  if (!hotelUid || !fileImportSettingId) return null;

  const fileImportSettingRef = doc(
    db,
    `hotels/${hotelUid}/fileImportSettings`,
    fileImportSettingId
  );
  const snap = await getDoc(fileImportSettingRef);
  if (!snap.exists()) return null;

  const data = snap.data() || {};
  return {
    id: String(data.id || snap.id || "").trim() || snap.id,
    reportName: String(data.reportName || "").trim(),
    fromEmail: String(data.fromEmail || "").trim(),
    toEmail: String(data.toEmail || "").trim(),
    subjectContains: String(data.subjectContains || data.subject || "").trim(),
    fileType: String(data.fileType || "").trim(),
    createdBy: data.createdBy || null,
    createdAt: data.createdAt || null,
    updatedBy: data.updatedBy || null,
    updatedAt: data.updatedAt || null,
  };
}

export async function updateFileImportSetting(hotelUid, fileImportSettingId, input) {
  if (!hotelUid || !fileImportSettingId) {
    throw new Error("hotelUid en fileImportSettingId zijn verplicht");
  }

  const reportName = String(input?.reportName || "").trim();
  if (!reportName) {
    throw new Error("Report name is verplicht");
  }

  const fileImportSettingRef = doc(
    db,
    `hotels/${hotelUid}/fileImportSettings`,
    fileImportSettingId
  );

  await updateDoc(fileImportSettingRef, {
    reportName,
    fromEmail: String(input?.fromEmail || "").trim(),
    toEmail: String(input?.toEmail || "").trim(),
    subjectContains: String(input?.subjectContains || "").trim(),
    fileType: String(input?.fileType || "").trim(),
    updatedBy: input?.updatedBy || null,
    updatedAt: new Date(),
  });
}

export async function deleteFileImportSetting(hotelUid, fileImportSettingId) {
  if (!hotelUid || !fileImportSettingId) {
    throw new Error("hotelUid en fileImportSettingId zijn verplicht");
  }

  const fileImportSettingRef = doc(
    db,
    `hotels/${hotelUid}/fileImportSettings`,
    fileImportSettingId
  );
  await deleteDoc(fileImportSettingRef);
}

// *** FILE IMPORT TYPES ***
/**
 * @typedef {Object} FileImportColumnMapping
 * @property {string} databaseField
 * @property {"string"|"number"|"array"|"date"|"list"|"map"} targetType
 * @property {string} [sourceField]
 * @property {string} [mapKeySourceField]
 * @property {string} [mapValueSourceField]
 * @property {"string"|"number"|"array"|"date"} [mapValueType]
 * @property {string} [mapExcludedKeys]
 * @property {FileImportColumnMapping[]} [childMappings]
 */
function normalizeFileImportDelimiter(value) {
  const original = String(value ?? "");
  const raw = original.toLowerCase().trim();

  if (original === "	" || raw === "tab") return "	";
  if (!raw || raw === "," || raw === "comma") return ",";
  if (raw === ";" || raw === "semicolon" || raw === "semi-colon") return ";";
  if (raw === "|") return "|";

  return original.trim();
}

function normalizeMappingTargetType(value) {
  const normalized = String(value || "string").trim().toLowerCase();
  return ["string", "number", "array", "date", "list", "map"].includes(normalized) ? normalized : "string";
}

function normalizeMapValueType(value) {
  const normalized = String(value || "string").trim().toLowerCase();
  return ["string", "number", "array", "date"].includes(normalized) ? normalized : "string";
}

function normalizeMappingSeparator(value) {
  const original = String(value ?? ",");
  const raw = original.toLowerCase().trim();

  if (original === "\t" || raw === "tab") return "\t";
  if (!raw || raw === "," || raw === "comma") return ",";
  if (raw === ";" || raw === "semicolon" || raw === "semi-colon") return ";";
  if (raw === "|" || raw === "pipe") return "|";

  return ",";
}

function normalizeDateFormat(value) {
  const normalized = String(value || "").trim();
  const supportedFormats = new Set([
    "yyyy-MM-dd",
    "MM/dd/yyyy",
    "dd/MM/yyyy",
    "dd-MM-yyyy",
    "dd-MM-yy",
    "dd-MMM-yy",
    "MM-dd-yyyy",
    "yyyy/MM/dd",
    "dd.MM.yyyy",
    "dd.MM.yy",
    "MM.dd.yyyy",
  ]);

  return supportedFormats.has(normalized) ? normalized : "";
}

function normalizeColumnMapping(mapping = {}) {
  return {
    sourceField: String(mapping?.sourceField || mapping?.csvHeader || "").trim(),
    databaseField: String(mapping?.databaseField || "").trim(),
    targetType: normalizeMappingTargetType(mapping?.targetType),
    seperator: normalizeMappingSeparator(mapping?.seperator),
    importFormat: normalizeDateFormat(mapping?.importFormat),
    targetFormat: normalizeDateFormat(mapping?.targetFormat),
    listItemKeyField: String(mapping?.listItemKeyField || "").trim(),
    mapKeySourceField: String(mapping?.mapKeySourceField || "").trim(),
    mapValueSourceField: String(mapping?.mapValueSourceField || "").trim(),
    mapValueType: normalizeMapValueType(mapping?.mapValueType),
    mapExcludedKeys: String(mapping?.mapExcludedKeys ?? "Total").trim(),
    childMappings: Array.isArray(mapping?.childMappings)
      ? mapping.childMappings.map((childMapping) => normalizeColumnMapping(childMapping))
      : [],
  };
}

function sanitizeColumnMappings(columnMappings, parserType) {
  return columnMappings
    .map((mapping) => {
      const normalizedMapping = normalizeColumnMapping(mapping);

      if (normalizedMapping.targetType === "list") {
        if (!["xml", "csv", "json"].includes(parserType)) {
          throw new Error("List target type is alleen beschikbaar voor CSV, XML en JSON imports");
        }

        normalizedMapping.seperator = ",";
        normalizedMapping.importFormat = "";
        normalizedMapping.targetFormat = "";
        normalizedMapping.childMappings = sanitizeColumnMappings(
          normalizedMapping.childMappings,
          parserType
        );
        const childDatabaseFields = new Set(
          normalizedMapping.childMappings
            .map((childMapping) => String(childMapping?.databaseField || "").trim())
            .filter(Boolean)
        );
        if (!childDatabaseFields.has(normalizedMapping.listItemKeyField)) {
          normalizedMapping.listItemKeyField = "";
        }
        return normalizedMapping;
      }

      if (normalizedMapping.targetType === "map") {
        if (!normalizedMapping.databaseField || !normalizedMapping.mapKeySourceField || !normalizedMapping.mapValueSourceField) {
          throw new Error("Map mappings vereisen een Database Field, Key Source Field en Value Source Field");
        }
        normalizedMapping.sourceField = "";
        normalizedMapping.seperator = ",";
        normalizedMapping.importFormat = "";
        normalizedMapping.targetFormat = "";
        normalizedMapping.listItemKeyField = "";
        normalizedMapping.childMappings = [];
        return normalizedMapping;
      }

      normalizedMapping.listItemKeyField = "";
      normalizedMapping.mapKeySourceField = "";
      normalizedMapping.mapValueSourceField = "";
      normalizedMapping.mapValueType = "string";
      normalizedMapping.mapExcludedKeys = "";
      normalizedMapping.childMappings = [];

      if (normalizedMapping.targetType === "date") {
        if (!normalizedMapping.importFormat || !normalizedMapping.targetFormat) {
          throw new Error("Date mappings vereisen zowel een Import Format als Target Format");
        }
      } else {
        normalizedMapping.importFormat = "";
        normalizedMapping.targetFormat = "";
      }

      if (normalizedMapping.targetType !== "array") {
        normalizedMapping.seperator = ",";
      }

      return normalizedMapping;
    })
    .filter((mapping) => mapping.sourceField || mapping.databaseField);
}

function normalizeIdFormat(value) {
  return Array.isArray(value)
    ? value
        .map((entry) => String(entry || "").trim())
        .filter(Boolean)
    : [];
}

function normalizeTargetDateOffsetDays(value) {
  if (value === "" || value === null || value === undefined) return 0;
  const parsedValue = Number(value);
  return Number.isInteger(parsedValue) ? parsedValue : 0;
}

function normalizeFileImportType(data = {}, fallbackId = "") {
  return {
    id: String(data.id || fallbackId || "").trim() || fallbackId,
    fileType: String(data.fileType || "").trim(),
    parserType: String(data.parserType || "csv").trim().toLowerCase() || "csv",
    delimiter: normalizeFileImportDelimiter(data.delimiter),
    recordNodeName: String(data.recordNodeName || "").trim(),
    hasHeaderRow: Boolean(data.hasHeaderRow),
    targetCollection: String(data.targetCollection || "").trim(),
    basePath: String(data.basePath || "").trim(),
    targetPath: String(data.targetPath || "").trim(),
    idFormat: normalizeIdFormat(data.idFormat),
    targetDateSourceType:
      String(data.targetDateSourceType || "currentDate").trim() || "currentDate",
    targetDateSourceField: String(data.targetDateSourceField || "").trim(),
    targetDateOffsetDays: normalizeTargetDateOffsetDays(data.targetDateOffsetDays),
    recordParsingMode: String(data.recordParsingMode || "auto").trim() || "auto",
    expectedColumnCount:
      data.expectedColumnCount === null || data.expectedColumnCount === undefined || data.expectedColumnCount === ""
        ? null
        : Number(data.expectedColumnCount),
    writeMode: String(data.writeMode || "").trim(),
    enabled: Boolean(data.enabled),
    columnMappings: Array.isArray(data.columnMappings)
      ? data.columnMappings.map((mapping) => normalizeColumnMapping(mapping))
      : [],
    createdBy: data.createdBy || null,
    createdAt: data.createdAt || null,
    updatedBy: data.updatedBy || null,
    updatedAt: data.updatedAt || null,
  };
}

function buildFileImportTypePayload(input, existingId = null) {
  const payload = {
    id: String(input?.id || existingId || "").trim() || existingId,
    fileType: String(input?.fileType || "").trim(),
    parserType: String(input?.parserType || "csv").trim().toLowerCase() || "csv",
    delimiter: normalizeFileImportDelimiter(input?.delimiter),
    recordNodeName: String(input?.recordNodeName || "").trim(),
    hasHeaderRow: Boolean(input?.hasHeaderRow),
    targetCollection: String(input?.targetCollection || "").trim(),
    basePath: String(input?.basePath || "").trim(),
    targetPath: String(input?.targetPath || "").trim(),
    idFormat: normalizeIdFormat(input?.idFormat),
    targetDateSourceType:
      String(input?.targetDateSourceType || "currentDate").trim() || "currentDate",
    targetDateSourceField: String(input?.targetDateSourceField || "").trim(),
    targetDateOffsetDays: normalizeTargetDateOffsetDays(input?.targetDateOffsetDays),
    recordParsingMode: String(input?.recordParsingMode || "auto").trim() || "auto",
    expectedColumnCount:
      input?.expectedColumnCount === null || input?.expectedColumnCount === undefined || input?.expectedColumnCount === ""
        ? null
        : Number(input.expectedColumnCount),
    writeMode: String(input?.writeMode || "").trim(),
    enabled: Boolean(input?.enabled),
    columnMappings: Array.isArray(input?.columnMappings)
      ? sanitizeColumnMappings(
          input.columnMappings,
          String(input?.parserType || "csv").trim().toLowerCase() || "csv"
        )
      : [],
  };

  if (!payload.fileType) {
    throw new Error("File type is verplicht");
  }

  if (!["csv", "xml", "json"].includes(payload.parserType)) {
    throw new Error("Parser type moet CSV, XML of JSON zijn");
  }

  if (payload.parserType === "xml" && !payload.recordNodeName) {
    throw new Error("Record Node Name is verplicht voor XML imports");
  }

  if (payload.targetDateSourceType !== "currentDate" && payload.targetDateSourceType !== "databaseField") {
    payload.targetDateSourceType = "currentDate";
  }

  if (!["auto", "direct", "buffered"].includes(payload.recordParsingMode)) {
    payload.recordParsingMode = "auto";
  }

  if (!Number.isFinite(payload.expectedColumnCount) || payload.expectedColumnCount <= 0) {
    payload.expectedColumnCount = null;
  }

  if (payload.targetDateSourceType === "databaseField") {
    if (!payload.targetDateSourceField) {
      throw new Error("Date database field is verplicht wanneer Date Source op Database Field staat");
    }

    const availableDatabaseFields = new Set(payload.columnMappings.map((mapping) => mapping.databaseField));
    if (!availableDatabaseFields.has(payload.targetDateSourceField)) {
      throw new Error("Date database field moet overeenkomen met een database field uit de column mappings");
    }
  } else {
    payload.targetDateSourceField = "";
  }

  if (payload.idFormat.length > 0) {
    const availableDatabaseFields = new Set(payload.columnMappings.map((mapping) => mapping.databaseField));
    payload.idFormat = payload.idFormat.filter((databaseField) => availableDatabaseFields.has(databaseField));
  }

  return payload;
}

export async function getFileImportTypes(hotelUid) {
  if (!hotelUid) return [];

  const fileImportTypesCol = collection(db, `hotels/${hotelUid}/fileImportTypes`);
  const snapshot = await getDocs(fileImportTypesCol);

  const fileImportTypes = snapshot.docs.map((docSnap) =>
    normalizeFileImportType(docSnap.data() || {}, docSnap.id)
  );

  return fileImportTypes.sort((a, b) =>
    String(a?.fileType || "").localeCompare(String(b?.fileType || ""), undefined, {
      sensitivity: "base",
      numeric: true,
    })
  );
}

export async function createFileImportType(hotelUid, input) {
  if (!hotelUid) return null;

  const fileImportTypesCol = collection(db, `hotels/${hotelUid}/fileImportTypes`);
  const fileImportTypeRef = doc(fileImportTypesCol);
  const basePayload = buildFileImportTypePayload(input, fileImportTypeRef.id);

  const payload = {
    ...basePayload,
    createdBy: input?.createdBy || null,
    createdAt: new Date(),
  };

  await setDoc(fileImportTypeRef, payload);
  return payload;
}

export async function getFileImportTypeById(hotelUid, fileImportTypeId) {
  if (!hotelUid || !fileImportTypeId) return null;

  const fileImportTypeRef = doc(db, `hotels/${hotelUid}/fileImportTypes`, fileImportTypeId);
  const snap = await getDoc(fileImportTypeRef);
  if (!snap.exists()) return null;

  return normalizeFileImportType(snap.data() || {}, snap.id);
}

export async function updateFileImportType(hotelUid, fileImportTypeId, input) {
  if (!hotelUid || !fileImportTypeId) {
    throw new Error("hotelUid en fileImportTypeId zijn verplicht");
  }

  const fileImportTypeRef = doc(db, `hotels/${hotelUid}/fileImportTypes`, fileImportTypeId);
  const payload = buildFileImportTypePayload(input, fileImportTypeId);

  await updateDoc(fileImportTypeRef, {
    ...payload,
    updatedBy: input?.updatedBy || null,
    updatedAt: new Date(),
  });
}

export async function deleteFileImportType(hotelUid, fileImportTypeId) {
  if (!hotelUid || !fileImportTypeId) {
    throw new Error("hotelUid en fileImportTypeId zijn verplicht");
  }

  const fileImportTypeRef = doc(db, `hotels/${hotelUid}/fileImportTypes`, fileImportTypeId);
  await deleteDoc(fileImportTypeRef);
}
