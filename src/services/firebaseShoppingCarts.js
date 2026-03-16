import {
  db,
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  serverTimestamp,
  query,
  orderBy,
  limit,
} from "../firebaseConfig";

function normalizeTimestamp(value) {
  if (!value) return null;
  if (typeof value?.toDate === "function") return value.toDate();
  if (value instanceof Date) return value;
  return null;
}

export async function getShoppingCarts(hotelUid) {
  if (!hotelUid) return [];

  const cartsCol = collection(db, `hotels/${hotelUid}/shoppingCarts`);
  const cartsQuery = query(cartsCol, orderBy("updatedAt", "desc"));
  const snap = await getDocs(cartsQuery);

  return snap.docs.map((docSnap) => {
    const data = docSnap.data() || {};
    return {
      id: docSnap.id,
      ...data,
      createdAtDate: normalizeTimestamp(data.createdAt),
      updatedAtDate: normalizeTimestamp(data.updatedAt),
      items: Array.isArray(data.items) ? data.items : [],
    };
  });
}

export async function getShoppingCart(hotelUid, shoppingCartId) {
  if (!hotelUid || !shoppingCartId) return null;

  const cartRef = doc(db, `hotels/${hotelUid}/shoppingCarts`, shoppingCartId);
  const cartSnap = await getDoc(cartRef);

  if (!cartSnap.exists()) return null;

  const data = cartSnap.data() || {};
  return {
    id: cartSnap.id,
    ...data,
    createdAtDate: normalizeTimestamp(data.createdAt),
    updatedAtDate: normalizeTimestamp(data.updatedAt),
    items: Array.isArray(data.items) ? data.items : [],
  };
}

export async function getOrCreateShoppingCart(hotelUid, createdBy) {
  if (!hotelUid) return null;

  const cartsCol = collection(db, `hotels/${hotelUid}/shoppingCarts`);
  const lastCartQuery = query(cartsCol, orderBy("updatedAt", "desc"), limit(1));
  const snap = await getDocs(lastCartQuery);

  if (!snap.empty) {
    const existingCartId = snap.docs[0].id;
    return getShoppingCart(hotelUid, existingCartId);
  }

  const cartRef = doc(cartsCol);
  await setDoc(cartRef, {
    createdBy: createdBy || "unknown",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    items: [],
  });

  return getShoppingCart(hotelUid, cartRef.id);
}

function mapSupplierProductToCartItem(supplierProduct, qtyPurchaseUnits) {
  const firstVariant = Array.isArray(supplierProduct?.variants) ? supplierProduct.variants[0] : null;

  return {
    supplierId: supplierProduct?.supplierId || "",
    supplierName: supplierProduct?.supplierName || supplierProduct?.supplierId || "",
    supplierProductId: supplierProduct?.id || "",
    variantId: firstVariant?.id || "",
    qtyPurchaseUnits: Number(qtyPurchaseUnits) > 0 ? Number(qtyPurchaseUnits) : 1,
    supplierSku: supplierProduct?.supplierSku || "",
    supplierProductName: supplierProduct?.supplierProductName || "",
    purchaseUnit: supplierProduct?.purchaseUnit || "",
    pricingModel: supplierProduct?.pricingModel || "",
    pricePerPurchaseUnit: Number(supplierProduct?.pricePerPurchaseUnit || 0),
    currency: supplierProduct?.currency || "EUR",
    baseUnit: supplierProduct?.baseUnit || "",
    baseUnitsPerPurchaseUnit: Number(supplierProduct?.baseUnitsPerPurchaseUnit || 0),
    imageUrl: supplierProduct?.imageUrl || "",
    outletId: "",
    updatedAt: new Date().toISOString(),
  };
}

export async function addSupplierProductToShoppingCart(hotelUid, shoppingCartId, supplierProduct, qtyPurchaseUnits = 1) {
  if (!hotelUid || !shoppingCartId || !supplierProduct?.id) return;

  const cartRef = doc(db, `hotels/${hotelUid}/shoppingCarts`, shoppingCartId);
  const cartSnap = await getDoc(cartRef);
  if (!cartSnap.exists()) return;

  const data = cartSnap.data() || {};
  const currentItems = Array.isArray(data.items) ? data.items : [];

  const existingIndex = currentItems.findIndex(
    (item) => item.supplierProductId === supplierProduct.id
  );

  const nextItems = [...currentItems];
  if (existingIndex >= 0) {
    const previousQty = Number(nextItems[existingIndex].qtyPurchaseUnits || 0);
    nextItems[existingIndex] = {
      ...nextItems[existingIndex],
      qtyPurchaseUnits: previousQty + (Number(qtyPurchaseUnits) > 0 ? Number(qtyPurchaseUnits) : 1),
      updatedAt: new Date().toISOString(),
    };
  } else {
    nextItems.push(mapSupplierProductToCartItem(supplierProduct, qtyPurchaseUnits));
  }

  await updateDoc(cartRef, {
    items: nextItems,
    updatedAt: serverTimestamp(),
  });
}

export async function updateShoppingCartItemQty(hotelUid, shoppingCartId, supplierProductId, qtyPurchaseUnits) {
  if (!hotelUid || !shoppingCartId || !supplierProductId) return;

  const cartRef = doc(db, `hotels/${hotelUid}/shoppingCarts`, shoppingCartId);
  const cartSnap = await getDoc(cartRef);
  if (!cartSnap.exists()) return;

  const data = cartSnap.data() || {};
  const currentItems = Array.isArray(data.items) ? data.items : [];
  const parsedQty = Number(qtyPurchaseUnits);

  const nextItems = currentItems
    .map((item) => {
      if (item.supplierProductId !== supplierProductId) return item;
      return {
        ...item,
        qtyPurchaseUnits: parsedQty,
        updatedAt: new Date().toISOString(),
      };
    })
    .filter((item) => Number(item.qtyPurchaseUnits) > 0);

  await updateDoc(cartRef, {
    items: nextItems,
    updatedAt: serverTimestamp(),
  });
}


export async function updateShoppingCartItemOutlet(hotelUid, shoppingCartId, supplierProductId, outletId) {
  if (!hotelUid || !shoppingCartId || !supplierProductId) return;

  const cartRef = doc(db, `hotels/${hotelUid}/shoppingCarts`, shoppingCartId);
  const cartSnap = await getDoc(cartRef);
  if (!cartSnap.exists()) return;

  const data = cartSnap.data() || {};
  const currentItems = Array.isArray(data.items) ? data.items : [];

  const nextItems = currentItems.map((item) => {
    if (item.supplierProductId !== supplierProductId) return item;
    return {
      ...item,
      outletId: String(outletId || "").trim(),
      updatedAt: new Date().toISOString(),
    };
  });

  await updateDoc(cartRef, {
    items: nextItems,
    updatedAt: serverTimestamp(),
  });
}

export async function removeShoppingCartItem(hotelUid, shoppingCartId, supplierProductId) {
  if (!hotelUid || !shoppingCartId || !supplierProductId) return;

  const cartRef = doc(db, `hotels/${hotelUid}/shoppingCarts`, shoppingCartId);
  const cartSnap = await getDoc(cartRef);
  if (!cartSnap.exists()) return;

  const data = cartSnap.data() || {};
  const currentItems = Array.isArray(data.items) ? data.items : [];

  const nextItems = currentItems.filter((item) => item.supplierProductId !== supplierProductId);

  await updateDoc(cartRef, {
    items: nextItems,
    updatedAt: serverTimestamp(),
  });
}
