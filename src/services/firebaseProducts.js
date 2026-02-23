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

const MEILI_HOST =
  (import.meta.env.NEXT_PUBLIC_MEILI_HOST || import.meta.env.VITE_MEILI_HOST || "")
    .trim()
    .replace(/\/$/, "");
const MEILI_SEARCH_KEY =
  (import.meta.env.NEXT_PUBLIC_MEILI_SEARCH_KEY || import.meta.env.VITE_MEILI_SEARCH_KEY || "")
    .trim();
const MEILI_INDEX =
  (import.meta.env.NEXT_PUBLIC_MEILI_INDEX || import.meta.env.VITE_MEILI_INDEX || "catalogproducts")
    .trim() || "catalogproducts";

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

function withCatalogNameLower(productData, entityCollection) {
  if (entityCollection !== "catalogproducts") {
    return productData;
  }

  const nextData = { ...productData };
  if (typeof nextData.name === "string") {
    nextData.nameLower = nextData.name.trim().toLowerCase();
  }
  return nextData;
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

    if (entityCollection === "catalogproducts" && normalizedSearchTerm) {
      return searchCatalogProductsWithMeili(hotelUid, normalizedSearchTerm, pageSize, options.cursor);
    }

    const constraints = [];

    if (normalizedSearchTerm) {
      constraints.push(where("nameLower", ">=", normalizedSearchTerm));
      constraints.push(where("nameLower", "<=", `${normalizedSearchTerm}\uf8ff`));
      constraints.push(orderBy("nameLower"));
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

async function searchCatalogProductsWithMeili(hotelUid, searchTerm, pageSize, cursor) {
  if (!MEILI_HOST || !MEILI_SEARCH_KEY) {
    return searchCatalogProductsWithFirestore(hotelUid, searchTerm, pageSize, cursor);
  }

  const offset = Number(cursor?.offset || 0);
  const response = await fetch(`${MEILI_HOST}/indexes/${encodeURIComponent(MEILI_INDEX)}/search`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${MEILI_SEARCH_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      q: searchTerm,
      limit: pageSize,
      offset,
      filter: `hotelUid = \"${String(hotelUid).replace(/\"/g, "\\\"")}\"`,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Meili search failed (${response.status}): ${errorText}`);
  }

  const payload = await response.json();
  const hitIds = (payload?.hits || []).map((hit) => String(hit.id || "")).filter(Boolean);

  if (hitIds.length === 0) {
    return {
      products: [],
      cursor: null,
      hasMore: false,
    };
  }

  const docsById = await fetchProductsByIds(hotelUid, "catalogproducts", hitIds);
  const orderedProducts = hitIds
    .map((id) => docsById.get(id))
    .filter(Boolean);

  const estimatedTotalHits = Number(payload?.estimatedTotalHits || 0);
  const nextOffset = offset + hitIds.length;
  const hasMore = nextOffset < estimatedTotalHits;

  return {
    products: orderedProducts,
    cursor: hasMore ? { offset: nextOffset } : null,
    hasMore,
  };
}

async function searchCatalogProductsWithFirestore(hotelUid, searchTerm, pageSize, cursor) {
  const productsCol = collection(db, `hotels/${hotelUid}/catalogproducts`);
  const constraints = [
    where("nameLower", ">=", searchTerm),
    where("nameLower", "<=", `${searchTerm}\uf8ff`),
    orderBy("nameLower"),
    orderBy(documentId()),
    limit(pageSize),
  ];

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

async function fetchProductsByIds(hotelUid, entityCollection, ids = []) {
  const productsCol = collection(db, `hotels/${hotelUid}/${entityCollection}`);
  const chunks = [];

  for (let index = 0; index < ids.length; index += 30) {
    chunks.push(ids.slice(index, index + 30));
  }

  const docsById = new Map();
  for (const chunk of chunks) {
    const productsQuery = query(productsCol, where(documentId(), "in", chunk));
    const snap = await getDocs(productsQuery);
    snap.docs.forEach((docSnap) => {
      docsById.set(docSnap.id, { id: docSnap.id, ...docSnap.data() });
    });
  }

  return docsById;
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
    const documentId = String(product.documentId || product.id || "").trim();
    if (!documentId) {
      skipped += 1;
      continue;
    }

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
  const normalizedProductData = withCatalogNameLower(productData, entityCollection);
  const payload = {
    ...normalizedProductData,
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
  const normalizedProductData = withCatalogNameLower(productData, entityCollection);
  const payload = {
    ...normalizedProductData,
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
