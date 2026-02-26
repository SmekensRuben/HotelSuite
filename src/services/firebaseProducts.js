import {
  db,
  collection,
  doc,
  addDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  getDocs,
  getDoc,
  Timestamp,
  writeBatch,
  query,
  where,
  orderBy,
  limit,
  startAfter,
  documentId,
  serverTimestamp,
  storage,
  ref,
  uploadBytes,
  getDownloadURL
} from "../firebaseConfig";

// Simple in-memory cache for indexed products per hotel
const productsIndexedCache = {};
const entityProductsCache = {};

const MEILI_HOST = (import.meta.env.VITE_MEILI_HOST || import.meta.env.NEXT_PUBLIC_MEILI_HOST || "")
  .trim()
  .replace(/\/$/, "");
const MEILI_SEARCH_KEY = (import.meta.env.VITE_MEILI_SEARCH_KEY || import.meta.env.NEXT_PUBLIC_MEILI_SEARCH_KEY || "")
  .trim();
const CATALOG_PRODUCTS_MEILI_INDEX = "catalogproducts";
const SUPPLIER_PRODUCTS_MEILI_INDEX = "supplierproducts";

export function clearProductsIndexedCache(hotelUid) {
  if (hotelUid) {
    delete productsIndexedCache[hotelUid];
  }
}

function getEntityCacheKey(hotelUid, entityCollection) {
  return `${hotelUid}:${entityCollection}`;
}

function clearEntityProductsCache(hotelUid, entityCollection) {
  if (!hotelUid) return;

  if (entityCollection) {
    delete entityProductsCache[getEntityCacheKey(hotelUid, entityCollection)];
    return;
  }

  Object.keys(entityProductsCache).forEach((key) => {
    if (key.startsWith(`${hotelUid}:`)) {
      delete entityProductsCache[key];
    }
  });
}

async function refreshSalesSnapshotsForProduct(hotelUid, lightspeedId) {
  if (!hotelUid || !lightspeedId) return;
  const indexesCol = collection(
    db,
    `hotels/${hotelUid}/indexes/receiptMasterIndex/receiptsForLightspeedSync`
  );
  const snap = await getDocs(indexesCol);
  for (const docSnap of snap.docs) {
    const data = docSnap.data() || {};
    const productIndex = data.productIndex || {};
    if (productIndex[String(lightspeedId)]) {
      // no-op: analytics snapshots removed
    }
  }
}

// Return alle producten (met id's toegevoegd)
export async function getProducts(hotelUid) {
  if (!hotelUid) return [];
  const productsCol = collection(db, `hotels/${hotelUid}/products`);
  const snap = await getDocs(productsCol);
  return snap.docs.map(docSnap => ({
    ...docSnap.data(),
    id: docSnap.id
  }));
}

export async function addProduct(hotelUid, product) {
  if (!hotelUid) return;
  const productsCol = collection(db, `hotels/${hotelUid}/products`);
  const docRef = await addDoc(productsCol, product);
  await refreshSalesSnapshotsForProduct(hotelUid, product.lightspeedId);
  await rebuildProductCategoryIndex(hotelUid, product.category || "");
  clearProductsIndexedCache(hotelUid);
  return docRef.id;
}

export async function updateProduct(hotelUid, productId, product) {
  if (!hotelUid || !productId) return;
  const productDoc = doc(db, `hotels/${hotelUid}/products`, productId);
  const currentSnap = await getDoc(productDoc);
  let oldCategory = "";
  if (currentSnap.exists()) {
    const current = currentSnap.data();
    oldCategory = current.category || "";
  }

  await updateDoc(productDoc, product);
  await refreshSalesSnapshotsForProduct(hotelUid, product.lightspeedId);

  const newCategory =
    product.category !== undefined ? product.category : oldCategory;
  await rebuildProductCategoryIndex(hotelUid, newCategory);
  if (oldCategory !== newCategory) {
    await rebuildProductCategoryIndex(hotelUid, oldCategory);
  }
  clearProductsIndexedCache(hotelUid);
}

export async function deleteProduct(hotelUid, productId) {
  if (!hotelUid || !productId) return;
  const productDoc = doc(db, `hotels/${hotelUid}/products`, productId);
  const snap = await getDoc(productDoc);
  const category = snap.exists() ? snap.data().category || "" : "";
  await deleteDoc(productDoc);
  await rebuildProductCategoryIndex(hotelUid, category);
  clearProductsIndexedCache(hotelUid);
}

// Rebuild the product master index for quick lookups
export async function rebuildProductMasterIndex(hotelUid) {
  if (!hotelUid) return;

  // Haal alle producten op
  const productsCol = collection(db, `hotels/${hotelUid}/products`);
  const snapshot = await getDocs(productsCol);

  // Verzamel unieke categorieën
  const categoriesSet = new Set();
  snapshot.docs.forEach(docSnap => {
    const data = docSnap.data();
    categoriesSet.add(data.category || "_uncategorized");
  });

  // Bouw voor elke categorie de index opnieuw op
  for (const catId of categoriesSet) {
    await rebuildProductCategoryIndex(hotelUid, catId);
  }

  console.log("Alle productcategorie-indexen opnieuw opgebouwd!");
  clearProductsIndexedCache(hotelUid);
}


// Haal alle producten via de per-categorie index
export async function getProductsIndexed(hotelUid) {
  if (!hotelUid) return [];
  if (productsIndexedCache[hotelUid]) {
    return productsIndexedCache[hotelUid];
  }
  const indexCol = collection(
    db,
    `hotels/${hotelUid}/indexes/productMasterIndex/productsPerCategory`
  );
  const snapshot = await getDocs(indexCol);
  const result = [];
  snapshot.docs.forEach(docSnap => {
    const map = docSnap.data().productMap || {};
    Object.entries(map).forEach(([id, data]) => {
      result.push({ ...data, id });
    });
  });
  productsIndexedCache[hotelUid] = result;
  return result;
}

export async function rebuildProductCategoryIndex(hotelUid, categoryId) {
  if (!hotelUid) throw new Error("hotelUid is verplicht!");
  const cat = categoryId || "";

  const productsCol = collection(db, `hotels/${hotelUid}/products`);
  const q = query(productsCol, where("category", "==", cat));
  const snapshot = await getDocs(q);

  const productMap = {};
  snapshot.docs.forEach(docSnap => {
    const data = docSnap.data();
    productMap[docSnap.id] = { ...data, id: docSnap.id };
  });

  const indexCol = collection(
    db,
    `hotels/${hotelUid}/indexes/productMasterIndex/productsPerCategory`
  );
  const docId = cat || "_uncategorized";
  const ref = doc(indexCol, docId);

  if (Object.keys(productMap).length > 0) {
    await setDoc(ref, { productMap });
  } else {
    await deleteDoc(ref);
  }

  console.log(`Product category index rebuilt for ${docId}`);
  clearProductsIndexedCache(hotelUid);
}

export async function removeOutletFromProducts(hotelUid, outletName) {
  if (!hotelUid || !outletName) return;

  const productsCol = collection(db, `hotels/${hotelUid}/products`);
  const q = query(productsCol, where("outlets", "array-contains", outletName));
  const snapshot = await getDocs(q);

  if (snapshot.empty) return;

  const batch = writeBatch(db);
  snapshot.forEach(docSnap => {
    const data = docSnap.data() || {};
    const newOutlets = (data.outlets || []).filter(o => o !== outletName);
    batch.update(docSnap.ref, { outlets: newOutlets });
  });

  await batch.commit();

  await rebuildProductMasterIndex(hotelUid);
  clearProductsIndexedCache(hotelUid);
}

export async function renameOutletInProducts(hotelUid, oldName, newName) {
  if (!hotelUid || !oldName || !newName || oldName === newName) return;

  const productsCol = collection(db, `hotels/${hotelUid}/products`);
  const q = query(productsCol, where("outlets", "array-contains", oldName));
  const snapshot = await getDocs(q);

  if (snapshot.empty) return;

  const batch = writeBatch(db);
  snapshot.forEach(docSnap => {
    const data = docSnap.data() || {};
    const newOutlets = (data.outlets || []).map(o => (o === oldName ? newName : o));
    batch.update(docSnap.ref, { outlets: newOutlets });
  });

  await batch.commit();

  await rebuildProductMasterIndex(hotelUid);
  clearProductsIndexedCache(hotelUid);
}

export async function getCatalogProducts(hotelUid, options = {}) {
  return getEntityProducts(hotelUid, "catalogproducts", options);
}

export async function getSupplierProducts(hotelUid, options = {}) {
  return getEntityProducts(hotelUid, "supplierproducts", options);
}

async function getEntityProducts(hotelUid, entityCollection, options = {}) {
  if (!hotelUid) return options.pageSize ? { products: [], cursor: null, hasMore: false } : [];

  const productsCol = collection(db, `hotels/${hotelUid}/${entityCollection}`);
  const pageSize = Number(options.pageSize) || 0;

  if (pageSize > 0) {
    const normalizedSearchTerm = String(options.searchTerm || "").trim().toLowerCase();
    const normalizedCategory = String(options.category || "").trim();
    const normalizedSubcategory = String(options.subcategory || "").trim();
    const normalizedSupplierId = String(options.supplierId || "").trim();
    const normalizedActive =
      options.active === true || options.active === false ? options.active : null;

    if (entityCollection === "catalogproducts" && (normalizedSearchTerm || normalizedCategory || normalizedSubcategory)) {
      return searchCatalogProductsWithMeili(
        hotelUid,
        {
          searchTerm: normalizedSearchTerm,
          category: normalizedCategory,
          subcategory: normalizedSubcategory,
        },
        pageSize,
        options.cursor
      );
    }

    if (entityCollection === "supplierproducts") {
      return searchSupplierProducts(
        hotelUid,
        {
          searchTerm: normalizedSearchTerm,
          supplierId: normalizedSupplierId,
          active: normalizedActive,
        },
        pageSize,
        options.cursor
      );
    }

    const constraints = [];

    if (normalizedSearchTerm) {
      constraints.push(where("nameLower", ">=", normalizedSearchTerm));
      constraints.push(where("nameLower", "<=", `${normalizedSearchTerm}\uf8ff`));
      constraints.push(orderBy("nameLower"));
      constraints.push(orderBy(documentId()));
    } else if (normalizedCategory && normalizedSubcategory) {
      constraints.push(where("category", "==", normalizedCategory));
      constraints.push(where("subcategory", "==", normalizedSubcategory));
      constraints.push(orderBy(documentId()));
    } else if (normalizedCategory) {
      constraints.push(where("category", "==", normalizedCategory));
      constraints.push(orderBy(documentId()));
    } else if (normalizedSubcategory) {
      constraints.push(where("subcategory", "==", normalizedSubcategory));
      constraints.push(orderBy(documentId()));
    } else {
      constraints.push(orderBy(documentId()));
    }

    constraints.push(limit(pageSize));

    if (options.cursor) {
      constraints.push(startAfter(options.cursor));
    }

    const pagedQuery = query(productsCol, ...constraints);
    const snap = await getDocs(pagedQuery);
    const products = snap.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }));
    const cursor = snap.docs.length > 0 ? snap.docs[snap.docs.length - 1] : null;
    return {
      products,
      cursor,
      hasMore: snap.docs.length === pageSize,
    };
  }

  const cacheKey = getEntityCacheKey(hotelUid, entityCollection);
  if (entityProductsCache[cacheKey]) {
    return entityProductsCache[cacheKey];
  }

  const snap = await getDocs(productsCol);
  const products = snap.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }));
  entityProductsCache[cacheKey] = products;
  return products;
}

async function searchSupplierProducts(hotelUid, criteria, pageSize, cursor) {
  const searchTerm = String(criteria?.searchTerm || "").trim();
  const supplierId = String(criteria?.supplierId || "").trim();
  const active = criteria?.active;

  if (!MEILI_HOST || !MEILI_SEARCH_KEY) {
    return searchSupplierProductsWithFirestore(
      hotelUid,
      { searchTerm, supplierId, active },
      pageSize,
      cursor
    );
  }

  const meiliFilters = [`hotelUid = \"${String(hotelUid).replace(/\"/g, "\\\\\"")}\"`];
  if (supplierId) {
    meiliFilters.push(`supplierId = \"${supplierId.replace(/\"/g, "\\\\\"")}\"`);
  }
  if (active === true || active === false) {
    meiliFilters.push(`active = ${active}`);
  }

  const offset = Number(cursor?.offset || 0);
  const response = await fetch(`${MEILI_HOST}/indexes/${encodeURIComponent(SUPPLIER_PRODUCTS_MEILI_INDEX)}/search`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${MEILI_SEARCH_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      q: searchTerm,
      limit: pageSize,
      offset,
      filter: meiliFilters,
      sort: ["supplierProductName:asc"],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Meili search failed (${response.status}): ${errorText}`);
  }

  const payload = await response.json();
  const hits = Array.isArray(payload?.hits) ? payload.hits : [];
  const products = hits
    .map((hit) => {
      const fallbackId = [hit?.supplierId, hit?.supplierSku]
        .map((value) => String(value || "").trim())
        .filter(Boolean)
        .join("_");
      const id = String(hit?.id || hit?.documentId || fallbackId || "").trim();
      if (!id) return null;
      return { id, ...hit };
    })
    .filter(Boolean);

  const estimatedTotalHits = Number(payload?.estimatedTotalHits || 0);
  const nextOffset = offset + products.length;
  const hasMore = nextOffset < estimatedTotalHits;

  const hasNoCriteria = !searchTerm && !supplierId && active !== true && active !== false;
  if (offset === 0 && hasNoCriteria && products.length === 0) {
    return searchSupplierProductsWithFirestore(
      hotelUid,
      { searchTerm, supplierId, active },
      pageSize,
      null
    );
  }

  return {
    products,
    cursor: hasMore ? { offset: nextOffset } : null,
    hasMore,
  };
}

async function searchSupplierProductsWithFirestore(hotelUid, criteria, pageSize, cursor) {
  const searchTerm = String(criteria?.searchTerm || "").trim();
  const supplierId = String(criteria?.supplierId || "").trim();
  const active = criteria?.active;
  const productsCol = collection(db, `hotels/${hotelUid}/supplierproducts`);
  const constraints = [];

  if (supplierId) {
    constraints.push(where("supplierId", "==", supplierId));
  }

  if (active === true || active === false) {
    constraints.push(where("active", "==", active));
  }

  constraints.push(orderBy(documentId()));
  constraints.push(limit(pageSize));

  if (cursor) {
    constraints.push(startAfter(cursor));
  }

  const pagedQuery = query(productsCol, ...constraints);
  const snap = await getDocs(pagedQuery);
  let products = snap.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }));

  if (searchTerm) {
    const lowerTerm = searchTerm.toLowerCase();
    products = products.filter((product) => {
      const supplierSku = String(product.supplierSku || "").toLowerCase();
      const supplierProductName = String(product.supplierProductName || "").toLowerCase();
      const candidateSupplierId = String(product.supplierId || "").toLowerCase();
      return (
        supplierSku.includes(lowerTerm)
        || supplierProductName.includes(lowerTerm)
        || candidateSupplierId.includes(lowerTerm)
      );
    });
  }
  const nextCursor = snap.docs.length > 0 ? snap.docs[snap.docs.length - 1] : null;

  return {
    products,
    cursor: nextCursor,
    hasMore: snap.docs.length === pageSize,
  };
}

async function searchCatalogProductsWithMeili(hotelUid, criteria, pageSize, cursor) {
  const searchTerm = String(criteria?.searchTerm || "").trim();
  const category = String(criteria?.category || "").trim();
  const subcategory = String(criteria?.subcategory || "").trim();

  if (!MEILI_HOST || !MEILI_SEARCH_KEY) {
    return searchCatalogProductsWithFirestore(hotelUid, {
      searchTerm,
      category,
      subcategory,
    }, pageSize, cursor);
  }

  const meiliFilters = [`hotelUid = \"${String(hotelUid).replace(/\"/g, "\\\\\"")}\"`];
  if (category) {
    meiliFilters.push(`category = \"${category.replace(/\"/g, "\\\\\"")}\"`);
  }
  if (subcategory) {
    meiliFilters.push(`subcategory = \"${subcategory.replace(/\"/g, "\\\\\"")}\"`);
  }

  const offset = Number(cursor?.offset || 0);
  const response = await fetch(`${MEILI_HOST}/indexes/${encodeURIComponent(CATALOG_PRODUCTS_MEILI_INDEX)}/search`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${MEILI_SEARCH_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      q: searchTerm,
      limit: pageSize,
      offset,
      filter: meiliFilters,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Meili search failed (${response.status}): ${errorText}`);
  }

  const payload = await response.json();
  const hits = Array.isArray(payload?.hits) ? payload.hits : [];
  const products = hits
    .map((hit) => {
      const id = String(hit?.id || hit?.documentId || "").trim();
      if (!id) return null;
      return { id, ...hit };
    })
    .filter(Boolean);

  const estimatedTotalHits = Number(payload?.estimatedTotalHits || 0);
  const nextOffset = offset + products.length;
  const hasMore = nextOffset < estimatedTotalHits;

  return {
    products,
    cursor: hasMore ? { offset: nextOffset } : null,
    hasMore,
  };
}

async function searchCatalogProductsWithFirestore(hotelUid, criteria, pageSize, cursor) {
  const searchTerm = String(criteria?.searchTerm || "").trim();
  const category = String(criteria?.category || "").trim();
  const subcategory = String(criteria?.subcategory || "").trim();
  const productsCol = collection(db, `hotels/${hotelUid}/catalogproducts`);
  const constraints = [];

  if (searchTerm) {
    constraints.push(where("nameLower", ">=", searchTerm));
    constraints.push(where("nameLower", "<=", `${searchTerm}\uf8ff`));
    constraints.push(orderBy("nameLower"));
    constraints.push(orderBy(documentId()));
  } else if (category && subcategory) {
    constraints.push(where("category", "==", category));
    constraints.push(where("subcategory", "==", subcategory));
    constraints.push(orderBy(documentId()));
  } else if (category) {
    constraints.push(where("category", "==", category));
    constraints.push(orderBy(documentId()));
  } else if (subcategory) {
    constraints.push(where("subcategory", "==", subcategory));
    constraints.push(orderBy(documentId()));
  } else {
    constraints.push(orderBy(documentId()));
  }

  constraints.push(limit(pageSize));

  if (cursor) {
    constraints.push(startAfter(cursor));
  }

  const pagedQuery = query(productsCol, ...constraints);
  const snap = await getDocs(pagedQuery);
  const products = snap.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }));
  const nextCursor = snap.docs.length > 0 ? snap.docs[snap.docs.length - 1] : null;

  return {
    products,
    cursor: nextCursor,
    hasMore: snap.docs.length === pageSize,
  };
}

function sanitizeCatalogProductPayload(product = {}) {
  const {
    documentId,
    id,
    createdAt,
    updatedAt,
    createdBy,
    updatedBy,
    ...payload
  } = product;

  const cleanedPayload = Object.fromEntries(
    Object.entries(payload).filter(([, value]) => value !== undefined)
  );

  return cleanedPayload;
}

function sanitizeSupplierProductPayload(product = {}) {
  const {
    documentId,
    id,
    createdAt,
    updatedAt,
    createdBy,
    updatedBy,
    priceUpdatedOn,
    ...payload
  } = product;

  const cleanedPayload = Object.fromEntries(
    Object.entries(payload).filter(([, value]) => value !== undefined)
  );

  return cleanedPayload;
}

export async function importCatalogProducts(hotelUid, products, options = {}) {
  if (!hotelUid) throw new Error("hotelUid is verplicht!");
  const strategy = options.onExisting === "overwrite" ? "overwrite" : "skip";
  const actor = options.actor || "unknown";

  const productsCol = collection(db, `hotels/${hotelUid}/catalogproducts`);
  const snapshot = await getDocs(productsCol);
  const existingIds = new Set(snapshot.docs.map((docSnap) => docSnap.id));

  let imported = 0;
  let skipped = 0;

  for (const product of products) {
    const providedDocumentId = String(product.documentId || product.id || "").trim();
    const documentId = providedDocumentId || doc(productsCol).id;

    const payload = sanitizeCatalogProductPayload(product);
    const exists = existingIds.has(documentId);

    if (exists && strategy === "skip") {
      skipped += 1;
      continue;
    }

    const now = Timestamp.now();
    const docRef = doc(db, `hotels/${hotelUid}/catalogproducts`, documentId);
    if (exists) {
      await setDoc(
        docRef,
        {
          ...payload,
          updatedAt: now,
          updatedBy: actor,
        },
        { merge: true }
      );
    } else {
      await setDoc(docRef, {
        ...payload,
        active: payload.active ?? true,
        createdAt: now,
        createdBy: actor,
        updatedAt: now,
        updatedBy: actor,
      });
      existingIds.add(documentId);
    }

    imported += 1;
  }

  return { imported, skipped };
}

export async function importSupplierProducts(hotelUid, products, options = {}) {
  if (!hotelUid) throw new Error("hotelUid is verplicht!");
  const strategy = options.onExisting === "overwrite" ? "overwrite" : "skip";
  const actor = options.actor || "unknown";

  const productsCol = collection(db, `hotels/${hotelUid}/supplierproducts`);
  const snapshot = await getDocs(productsCol);
  const existingIds = new Set(snapshot.docs.map((docSnap) => docSnap.id));

  let imported = 0;
  let skipped = 0;

  for (const product of products) {
    const supplierId = String(product.supplierId || "").trim();
    const supplierSku = String(product.supplierSku || "").trim();
    const providedDocumentId = String(product.documentId || product.id || "").trim();
    const generatedSupplierDocumentId = `${supplierId}_${supplierSku}`;
    const documentId = providedDocumentId || generatedSupplierDocumentId;
    if (!supplierId || !supplierSku) {
      skipped += 1;
      continue;
    }

    const payload = sanitizeSupplierProductPayload({
      ...product,
      supplierId,
      supplierSku,
    });
    const exists = existingIds.has(documentId);

    if (exists && strategy === "skip") {
      skipped += 1;
      continue;
    }

    const now = Timestamp.now();
    const docRef = doc(db, `hotels/${hotelUid}/supplierproducts`, documentId);
    if (exists) {
      await setDoc(
        docRef,
        {
          ...payload,
          updatedAt: now,
          updatedBy: actor,
          priceUpdatedOn: now,
        },
        { merge: true }
      );
    } else {
      await setDoc(docRef, {
        ...payload,
        active: payload.active ?? true,
        createdAt: now,
        createdBy: actor,
        updatedAt: now,
        updatedBy: actor,
        priceUpdatedOn: now,
      });
      existingIds.add(documentId);
    }

    imported += 1;
  }

  clearEntityProductsCache(hotelUid, "supplierproducts");
  return { imported, skipped };
}

export async function getCatalogProduct(hotelUid, productId) {
  return getEntityProduct(hotelUid, productId, "catalogproducts");
}

export async function getSupplierProduct(hotelUid, productId) {
  return getEntityProduct(hotelUid, productId, "supplierproducts");
}

async function getEntityProduct(hotelUid, productId, entityCollection) {
  if (!hotelUid || !productId) return null;
  const productDoc = doc(db, `hotels/${hotelUid}/${entityCollection}`, productId);
  const snap = await getDoc(productDoc);
  if (!snap.exists()) return null;
  return { id: snap.id, ...snap.data() };
}

export async function createCatalogProduct(hotelUid, productData, actor) {
  return createEntityProduct(hotelUid, productData, actor, "catalogproducts");
}

export async function createSupplierProduct(hotelUid, productData, actor, options = {}) {
  return createEntityProduct(hotelUid, productData, actor, "supplierproducts", options);
}

async function createEntityProduct(hotelUid, productData, actor, entityCollection, options = {}) {
  if (!hotelUid) throw new Error("hotelUid is verplicht!");
  const productsCol = collection(db, `hotels/${hotelUid}/${entityCollection}`);
  const includeSupplierPriceTimestamp = entityCollection === "supplierproducts";
  const payload = {
    ...productData,
    active: productData.active ?? true,
    createdAt: serverTimestamp(),
    createdBy: actor || "unknown",
    updatedAt: serverTimestamp(),
    updatedBy: actor || "unknown",
    ...(includeSupplierPriceTimestamp ? { priceUpdatedOn: serverTimestamp() } : {}),
  };

  if (includeSupplierPriceTimestamp) {
    const supplierId = String(productData.supplierId || "").trim();
    const supplierSku = String(productData.supplierSku || "").trim();
    if (!supplierId || !supplierSku) {
      throw new Error("supplierId en supplierSku zijn verplicht voor supplier products");
    }
    const supplierProductId = `${supplierId}_${supplierSku}`;
    const productRef = doc(productsCol, supplierProductId);
    if (!options.overwriteExisting) {
      const existingSnap = await getDoc(productRef);
      if (existingSnap.exists()) {
        const error = new Error("Supplier product bestaat al");
        error.code = "supplier-product-exists";
        error.productId = supplierProductId;
        throw error;
      }
    }
    await setDoc(productRef, payload);
    clearEntityProductsCache(hotelUid, entityCollection);
    return supplierProductId;
  }

  const docRef = await addDoc(productsCol, payload);
  clearEntityProductsCache(hotelUid, entityCollection);
  return docRef.id;
}


export async function uploadCatalogProductImage(hotelUid, file) {
  return uploadEntityProductImage(hotelUid, file, "catalogproducts");
}

export async function uploadSupplierProductImage(hotelUid, file) {
  return uploadEntityProductImage(hotelUid, file, "supplierproducts");
}

async function uploadEntityProductImage(hotelUid, file, entityCollection) {
  if (!hotelUid || !file) return "";
  const fileExtension = file.name?.split(".").pop();
  const safeExtension = fileExtension ? `.${fileExtension}` : "";
  const filePath = `hotels/${hotelUid}/${entityCollection}/images/${Date.now()}-${Math.random().toString(36).slice(2)}${safeExtension}`;
  const fileRef = ref(storage, filePath);
  await uploadBytes(fileRef, file);
  return getDownloadURL(fileRef);
}

export async function updateCatalogProduct(hotelUid, productId, productData, actor) {
  return updateEntityProduct(hotelUid, productId, productData, actor, "catalogproducts");
}

export async function updateSupplierProduct(hotelUid, productId, productData, actor) {
  return updateEntityProduct(hotelUid, productId, productData, actor, "supplierproducts");
}

async function updateEntityProduct(hotelUid, productId, productData, actor, entityCollection) {
  if (!hotelUid || !productId) throw new Error("hotelUid en productId zijn verplicht!");
  const productDoc = doc(db, `hotels/${hotelUid}/${entityCollection}`, productId);
  const includeSupplierPriceTimestamp = entityCollection === "supplierproducts";
  const payload = {
    ...productData,
    updatedAt: serverTimestamp(),
    updatedBy: actor || "unknown",
    ...(includeSupplierPriceTimestamp ? { priceUpdatedOn: serverTimestamp() } : {}),
  };
  await updateDoc(productDoc, payload);
  clearEntityProductsCache(hotelUid, entityCollection);
}

export async function deleteCatalogProduct(hotelUid, productId) {
  return deleteEntityProduct(hotelUid, productId, "catalogproducts");
}

export async function deleteSupplierProduct(hotelUid, productId) {
  return deleteEntityProduct(hotelUid, productId, "supplierproducts");
}

async function deleteEntityProduct(hotelUid, productId, entityCollection) {
  if (!hotelUid || !productId) return;
  const productDoc = doc(db, `hotels/${hotelUid}/${entityCollection}`, productId);
  await deleteDoc(productDoc);
  clearEntityProductsCache(hotelUid, entityCollection);
}
