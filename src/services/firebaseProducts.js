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
  writeBatch,
  query,
  where,
  orderBy,
  limit,
  startAfter,
  documentId,
  storage,
  ref,
  uploadBytes,
  getDownloadURL,
  auth,
  functions,
  httpsCallable
} from "../firebaseConfig";
import { getSuppliers } from "./firebaseSuppliers";
import { invalidateProcurementReads, poolProcurementRead, procurementReadScope, requireServerSnapshot } from "./procurementReadPool";

export function clearProductsIndexedCache(hotelUid) {
  invalidateProcurementReads(hotelUid);
}

function clearEntityProductsCache(hotelUid) {
  invalidateProcurementReads(hotelUid);
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
  return poolProcurementRead(hotelUid, "productMasterIndex", async () => {
    const indexCol = collection(
      db,
      `hotels/${hotelUid}/indexes/productMasterIndex/productsPerCategory`
    );
    const snapshot = requireServerSnapshot(await getDocs(indexCol));
    const result = [];
    snapshot.docs.forEach(docSnap => {
      const map = docSnap.data().productMap || {};
      Object.entries(map).forEach(([id, data]) => {
        result.push({ ...data, id });
      });
    });
    return result;
  });
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

  const cursorKey = options.cursor?.ref?.path || (Number.isSafeInteger(options.cursor?.offset) ? options.cursor.offset : options.cursor?.id || null);
  const resource = JSON.stringify([entityCollection, options.pageSize || 0, cursorKey,
    options.searchTerm || "", options.category || "", options.subcategory || "", options.supplierId || "", options.active ?? null]);
  return poolProcurementRead(hotelUid, resource, () => loadEntityProducts(hotelUid, entityCollection, options), options.scopeKey);
}

export function normalizeProductPageSize(value) {
  if (value === undefined || value === null || value === 0) return 0;
  const pageSize = Number(value);
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) throw new Error("Product page size must be a positive whole number.");
  return Math.min(pageSize, 100);
}

async function loadEntityProducts(hotelUid, entityCollection, options) {

  const productsCol = collection(db, `hotels/${hotelUid}/${entityCollection}`);
  const pageSize = normalizeProductPageSize(options.pageSize);

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

    if (entityCollection === "supplierproducts" && (normalizedSearchTerm || normalizedSupplierId || normalizedActive !== null || options.cursor?.offset !== undefined)) {
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
    const snap = requireServerSnapshot(await getDocs(pagedQuery));
    const products = snap.docs.map((docSnap) => ({ ...docSnap.data(), id: docSnap.id }));
    const cursor = snap.docs.length > 0 ? snap.docs[snap.docs.length - 1] : null;
    return {
      products,
      cursor,
      hasMore: snap.docs.length === pageSize,
    };
  }

  const snap = requireServerSnapshot(await getDocs(productsCol));
  const products = snap.docs.map((docSnap) => ({ ...docSnap.data(), id: docSnap.id }));
  return products;
}

async function searchThroughBackend(hotelUid, entityCollection, criteria, pageSize, cursor, fallback) {
  if (cursor?.ref) return fallback(hotelUid, criteria, pageSize, cursor);
  try {
    const result = await httpsCallable(functions, "searchHotelProducts")({
      hotelUid, collection: entityCollection, criteria, pageSize, offset: cursor?.offset || 0,
    });
    if (!Array.isArray(result.data?.products) || typeof result.data.hasMore !== "boolean"
      || (result.data.hasMore && (!Number.isSafeInteger(result.data.cursor?.offset) || result.data.cursor.offset <= (cursor?.offset || 0)))) {
      throw new Error("Product search response or pagination is invalid.");
    }
    if (!cursor && !result.data.products.length) return fallback(hotelUid, criteria, pageSize, null);
    return result.data;
  } catch (error) {
    if (!cursor && ["functions/unavailable", "functions/not-found"].includes(error?.code)) {
      return fallback(hotelUid, criteria, pageSize, null);
    }
    throw error;
  }
}

async function searchSupplierProducts(hotelUid, criteria, pageSize, cursor) {
  return searchThroughBackend(hotelUid, "supplierproducts", criteria, pageSize, cursor, searchSupplierProductsWithFirestore);
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
  const snap = requireServerSnapshot(await getDocs(pagedQuery));
  let products = snap.docs.map((docSnap) => ({ ...docSnap.data(), id: docSnap.id }));

  if (searchTerm) {
    const lowerTerm = searchTerm.toLowerCase();
    products = products.filter((product) => {
      const supplierSku = String(product.supplierSku || "").toLowerCase();
      const supplierProductName = String(product.supplierProductName || "").toLowerCase();
      const brand = String(product.brand || "").toLowerCase();
      const candidateSupplierName = String(product.supplierName || "").toLowerCase();
      return (
        supplierSku.includes(lowerTerm)
        || supplierProductName.includes(lowerTerm)
        || brand.includes(lowerTerm)
        || candidateSupplierName.includes(lowerTerm)
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
  return searchThroughBackend(hotelUid, "catalogproducts", criteria, pageSize, cursor, searchCatalogProductsWithFirestore);
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
  const snap = requireServerSnapshot(await getDocs(pagedQuery));
  const products = snap.docs.map((docSnap) => ({ ...docSnap.data(), id: docSnap.id }));
  const nextCursor = snap.docs.length > 0 ? snap.docs[snap.docs.length - 1] : null;

  return {
    products,
    cursor: nextCursor,
    hasMore: snap.docs.length === pageSize,
  };
}

const PRODUCT_METADATA = new Set(["documentId", "id", "revision", "productPolicyVersion", "createdAt", "updatedAt", "createdBy", "updatedBy", "priceUpdatedOn", "supplierName", "archivedAt", "archivedBy", "image", "imageRevision",
  "internalSkuCanonical", "currentPriceVersionId", "latestApprovedPriceVersionId", "latestApprovedPurchaseTerms", "priceConfirmedOn", "priceSourceReference", "priceSourceIssuedOn", "latestPriceSourceIssuedOn", "priceConfirmationSourceReference", "priceOptionReliability"]);
function productPayload(product = {}) {
  return Object.fromEntries(Object.entries(product).filter(([key, value]) => !PRODUCT_METADATA.has(key) && value !== undefined));
}

function commandStorageKey(hotelUid, resource) {
  const actor = auth.currentUser?.uid;
  if (!hotelUid || !actor) throw new Error("A signed-in hotel user is required.");
  return `product-command:${actor}:${hotelUid}:${resource}`;
}

function notifyProductCommand() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event("product-command-changed"));
}

function productOperationScope(hotelUid, resource) {
  const actor = auth.currentUser, scope = procurementReadScope(hotelUid, resource);
  if (!actor?.uid || !scope) throw new Error("A signed-in hotel user is required.");
  const current = () => auth.currentUser === actor && scope.current();
  return {
    current,
    assertCurrent: () => { if (!current()) throw new Error("Hotel access changed during this product request. Reload and retry the saved request with the original account before changing it."); },
  };
}

export function getPendingProductCommand(hotelUid, entityCollection, productId = "create") {
  if (!hotelUid || !auth.currentUser?.uid) return null;
  const saved = sessionStorage.getItem(commandStorageKey(hotelUid, `${entityCollection}:${productId}`));
  return saved ? JSON.parse(JSON.parse(saved).input) : null;
}

export async function retryPendingProductCommand(hotelUid, entityCollection, productId = "create") {
  const input = getPendingProductCommand(hotelUid, entityCollection, productId);
  if (!input) throw new Error("No pending product request is available.");
  const endpoint = entityCollection === "catalogproducts" ? "mutateHotelCatalogProduct" : "mutateHotelSupplierProduct";
  return productCommand(hotelUid, endpoint, input, `${entityCollection}:${productId}`);
}

async function productCommand(hotelUid, endpoint, input, resource) {
  const operation = productOperationScope(hotelUid, resource);
  const key = commandStorageKey(hotelUid, resource);
  const serializedInput = JSON.stringify(input);
  const existing = sessionStorage.getItem(key);
  let pending = existing ? JSON.parse(existing) : null;
  if (pending && pending.input !== serializedInput) {
    throw new Error("The previous request has an uncertain result. Retry the original values before making another change.");
  }
  if (!pending) {
    pending = { input: serializedInput, requestId: crypto.randomUUID() };
    sessionStorage.setItem(key, JSON.stringify(pending));
  }
  try {
    operation.assertCurrent();
    const { data } = await httpsCallable(functions, endpoint)({ hotelUid, ...input, requestId: pending.requestId });
    operation.assertCurrent();
    if (data?.hotelUid !== hotelUid || typeof data.productId !== "string" || !data.productId || !Number.isSafeInteger(data.revision) || data.revision < 0) throw new Error("Product response could not be validated. Retry the saved request.");
    sessionStorage.removeItem(key);
    notifyProductCommand();
    clearEntityProductsCache(hotelUid);
    return data;
  } catch (error) {
    if (operation.current() && error?.details?.productRequestUncommitted === true) sessionStorage.removeItem(key);
    clearEntityProductsCache(hotelUid);
    notifyProductCommand();
    throw error;
  }
}

async function importEntityProducts(hotelUid, products, options, entityCollection) {
  if (!Array.isArray(products) || products.length === 0 || products.length > 500) throw new Error("Import between 1 and 500 products per file.");
  const operation = productOperationScope(hotelUid, `import:${entityCollection}`);
  const key = commandStorageKey(hotelUid, `import:${entityCollection}`);
  const onExisting = options.onExisting === "overwrite" ? "overwrite" : "skip";
  const source = JSON.stringify({ products, onExisting });
  const saved = sessionStorage.getItem(key);
  let plan = saved ? JSON.parse(saved) : null;
  if (plan && plan.source !== source) {
    const previous = JSON.parse(plan.source);
    const completedRows = plan.offset * 25;
    if (!plan.failedUncommitted || previous.onExisting !== onExisting || previous.products.length !== products.length || JSON.stringify(previous.products.slice(0, completedRows)) !== JSON.stringify(products.slice(0, completedRows))) {
      throw new Error("Retry the previous import file and strategy to reconcile its result first. Already imported rows cannot be changed during a retry.");
    }
    const suppliers = entityCollection === "supplierproducts" ? await getSuppliers(hotelUid) : [];
    operation.assertCurrent();
    for (let batchIndex = plan.offset; batchIndex < plan.batches.length; batchIndex += 1) {
      for (let row = 0; row < plan.batches[batchIndex].products.length; row += 1) {
        const sourceProduct = products[batchIndex * 25 + row];
        const entry = plan.batches[batchIndex].products[row];
        const product = productPayload(sourceProduct);
        if (product.hasVariants || product.variants?.length) throw new Error("Legacy variants require explicit review and purchaseOptions before import.");
        delete product.hasVariants; delete product.variants;
        if (entityCollection === "supplierproducts") {
          const matches = suppliers.filter((supplier) => supplier.id === product.supplierId || String(supplier.name || "").toLowerCase() === String(product.supplierId || "").toLowerCase());
          if (matches.length !== 1) throw new Error("Select one existing hotel supplier for each import row.");
          product.supplierId = matches[0].id;
        }
        if ((sourceProduct.documentId || sourceProduct.id || entry.productId) !== entry.productId) throw new Error("Keep the saved product IDs when correcting an import.");
        const current = await getEntityProduct(hotelUid, entry.productId, entityCollection);
        operation.assertCurrent();
        entry.product = product;
        entry.expectedRevision = sourceProduct.revision ?? current?.revision ?? 0;
      }
      plan.batches[batchIndex].requestId = crypto.randomUUID();
    }
    plan.source = source;
    plan.failedUncommitted = false;
    operation.assertCurrent();
    sessionStorage.setItem(key, JSON.stringify(plan));
  }
  if (!plan) {
    let suppliers = [];
    if (entityCollection === "supplierproducts") suppliers = await getSuppliers(hotelUid);
    operation.assertCurrent();
    const existingSupplierProducts = entityCollection === "supplierproducts" ? await getSupplierProducts(hotelUid) : [];
    operation.assertCurrent();
    const entries = [];
    for (const sourceProduct of products) {
      const product = productPayload(sourceProduct);
      if (product.hasVariants || product.variants?.length) throw new Error("Legacy variants require explicit review and purchaseOptions before import.");
      delete product.hasVariants; delete product.variants;
      if (entityCollection === "supplierproducts") {
        const candidate = String(product.supplierId || "").trim();
        const matches = suppliers.filter((supplier) => supplier.id === candidate || String(supplier.name || "").toLowerCase() === candidate.toLowerCase());
        if (matches.length !== 1) throw new Error(`Supplier '${candidate}' must identify one existing hotel supplier.`);
        product.supplierId = matches[0].id;
      }
      const matchingOffers = entityCollection === "supplierproducts" && !sourceProduct.documentId && !sourceProduct.id
        ? existingSupplierProducts.filter((offer) => offer.supplierId === product.supplierId && String(offer.supplierSku || "").trim() === String(product.supplierSku || "").trim()) : [];
      if (matchingOffers.length > 1) throw new Error("More than one existing offer has this supplier and SKU; resolve the ambiguity before importing.");
      const productId = sourceProduct.documentId || sourceProduct.id || matchingOffers[0]?.id || crypto.randomUUID();
      const current = (sourceProduct.documentId || sourceProduct.id) ? await getEntityProduct(hotelUid, productId, entityCollection) : matchingOffers[0] || null;
      operation.assertCurrent();
      const expectedRevision = sourceProduct.revision ?? current?.revision ?? 0;
      entries.push({ productId, expectedRevision, product });
    }
    plan = { source, offset: 0, imported: 0, skipped: 0, batches: [] };
    for (let offset = 0; offset < entries.length; offset += 25) {
      plan.batches.push({ products: entries.slice(offset, offset + 25), requestId: crypto.randomUUID() });
    }
    operation.assertCurrent();
    sessionStorage.setItem(key, JSON.stringify(plan));
  }
  try {
    while (plan.offset < plan.batches.length) {
      operation.assertCurrent();
      plan.failedUncommitted = false;
      sessionStorage.setItem(key, JSON.stringify(plan));
      const { data } = await httpsCallable(functions, "importHotelProducts")({ hotelUid, collection: entityCollection, onExisting, ...plan.batches[plan.offset] });
      operation.assertCurrent();
      if (data?.hotelUid !== hotelUid || !Number.isSafeInteger(data.imported) || data.imported < 0 || !Number.isSafeInteger(data.skipped) || data.skipped < 0 || data.imported + data.skipped !== plan.batches[plan.offset].products.length) throw new Error("Import response could not be validated. Retry the saved file.");
      plan.imported += data.imported;
      plan.skipped += data.skipped;
      plan.offset += 1;
      sessionStorage.setItem(key, JSON.stringify(plan));
    }
  } catch (error) {
    if (operation.current() && error?.details?.productRequestUncommitted === true) {
      plan.failedUncommitted = true;
      sessionStorage.setItem(key, JSON.stringify(plan));
      error.message = `${error.message} Confirmed earlier batches: ${plan.imported} imported, ${plan.skipped} skipped. Retry this file, correcting only the remaining rows if needed.`;
    }
    clearEntityProductsCache(hotelUid, entityCollection);
    throw error;
  }
  operation.assertCurrent();
  sessionStorage.removeItem(key);
  clearEntityProductsCache(hotelUid, entityCollection);
  return { imported: plan.imported, skipped: plan.skipped };
}

export async function importCatalogProducts(hotelUid, products, options = {}) {
  return importEntityProducts(hotelUid, products, options, "catalogproducts");
}
export async function importSupplierProducts(hotelUid, products, options = {}) {
  return importEntityProducts(hotelUid, products, options, "supplierproducts");
}

export async function getCatalogProduct(hotelUid, productId) {
  return getEntityProduct(hotelUid, productId, "catalogproducts");
}

export async function getSupplierProduct(hotelUid, productId) {
  return getEntityProduct(hotelUid, productId, "supplierproducts");
}

async function getEntityProduct(hotelUid, productId, entityCollection) {
  if (!hotelUid || !productId) return null;
  return poolProcurementRead(hotelUid, `${entityCollection}:detail:${productId}`, async () => {
    const productDoc = doc(db, `hotels/${hotelUid}/${entityCollection}`, productId);
    const snap = requireServerSnapshot(await getDoc(productDoc));
    if (!snap.exists()) return null;
    return { ...snap.data(), id: snap.id };
  });
}

export async function createCatalogProduct(hotelUid, productData) {
  const result = await productCommand(hotelUid, "mutateHotelCatalogProduct", { action: "create", expectedRevision: 0, product: productPayload(productData) }, "catalogproducts:create");
  return result.productId;
}
export async function createSupplierProduct(hotelUid, productData) {
  const result = await productCommand(hotelUid, "mutateHotelSupplierProduct", { action: "create", expectedRevision: 0, product: productPayload(productData) }, "supplierproducts:create");
  return result.productId;
}

export async function uploadCatalogProductImage(hotelUid, file) {
  return uploadEntityProductImage(hotelUid, file, "catalogproducts");
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

export async function updateCatalogProduct(hotelUid, productId, productData, actor, options = {}) {
  const result = await productCommand(hotelUid, "mutateHotelCatalogProduct", { action: "update", productId, expectedRevision: options.expectedRevision ?? productData.revision ?? 0, product: productPayload(productData) }, `catalogproducts:${productId}`);
  return result.productId;
}
export async function updateSupplierProduct(hotelUid, productId, productData, actor, options = {}) {
  const result = await productCommand(hotelUid, "mutateHotelSupplierProduct", { action: "update", productId, expectedRevision: options.expectedRevision ?? productData.revision ?? 0, product: productPayload(productData) }, `supplierproducts:${productId}`);
  return result.productId;
}
export async function deleteCatalogProduct(hotelUid, productId, expectedRevision = 0) {
  return productCommand(hotelUid, "mutateHotelCatalogProduct", { action: "archive", productId, expectedRevision }, `catalogproducts:${productId}`);
}
export async function deleteSupplierProduct(hotelUid, productId, expectedRevision = 0) {
  return productCommand(hotelUid, "mutateHotelSupplierProduct", { action: "archive", productId, expectedRevision }, `supplierproducts:${productId}`);
}
