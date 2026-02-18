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
  where
} from "../firebaseConfig";

// Simple in-memory cache for indexed products per hotel
const productsIndexedCache = {};

export function clearProductsIndexedCache(hotelUid) {
  if (hotelUid) {
    delete productsIndexedCache[hotelUid];
  }
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
