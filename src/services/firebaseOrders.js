import {
  db,
  collection,
  doc,
  addDoc,
  getDoc,
  getDocs,
  query,
  where,
  orderBy,
  serverTimestamp,
  updateDoc,
  deleteDoc,
} from "../firebaseConfig";

const ORDER_STATUSES = ["Created", "Ordered", "Received", "Finalized", "Canceled"];

function normalizeTimestamp(value) {
  if (!value) return null;
  if (typeof value?.toDate === "function") return value.toDate();
  if (value instanceof Date) return value;
  return null;
}

function normalizeOrder(docSnap) {
  const data = docSnap.data() || {};
  return {
    id: docSnap.id,
    ...data,
    createdAtDate: normalizeTimestamp(data.createdAt),
    updatedAtDate: normalizeTimestamp(data.updatedAt),
    deliveryDate: data.deliveryDate || "",
    status: ORDER_STATUSES.includes(data.status) ? data.status : "Created",
    products: Array.isArray(data.products) ? data.products : [],
    totalAmount: Number(data.totalAmount || 0),
    supplierId: data.supplierId || "",
    currency: data.currency || "EUR",
  };
}


function parseIsoDateOnly(value) {
  const rawValue = String(value || "").trim();
  if (!rawValue) return null;
  const date = new Date(`${rawValue}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toIsoDateOnly(dateValue) {
  const year = dateValue.getFullYear();
  const month = String(dateValue.getMonth() + 1).padStart(2, "0");
  const day = String(dateValue.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizeLookupValue(value) {
  return String(value || "").trim().toLowerCase();
}

function resolveSupplierDeliveryDate(requestedDate, supplierDeliveryDays) {
  if (!Array.isArray(supplierDeliveryDays) || supplierDeliveryDays.length === 0) {
    return requestedDate;
  }

  const allowedDays = new Set(
    supplierDeliveryDays
      .map((day) => Number(day))
      .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
  );

  if (allowedDays.size === 0) return requestedDate;

  const baseDate = parseIsoDateOnly(requestedDate);
  if (!baseDate) return requestedDate;

  const candidateDate = new Date(baseDate);
  for (let offset = 0; offset <= 7; offset += 1) {
    const weekday = candidateDate.getDay();
    if (allowedDays.has(weekday)) {
      return toIsoDateOnly(candidateDate);
    }
    candidateDate.setDate(candidateDate.getDate() + 1);
  }

  return requestedDate;
}

export function listOrderStatuses() {
  return ORDER_STATUSES;
}

export async function getOrders(hotelUid) {
  if (!hotelUid) return [];

  const ordersCol = collection(db, `hotels/${hotelUid}/orders`);
  const ordersQuery = query(ordersCol, orderBy("createdAt", "desc"));
  const snap = await getDocs(ordersQuery);

  return snap.docs.map((docSnap) => normalizeOrder(docSnap));
}

export async function getOrderById(hotelUid, orderId) {
  if (!hotelUid || !orderId) return null;
  const orderRef = doc(db, `hotels/${hotelUid}/orders`, orderId);
  const snap = await getDoc(orderRef);
  if (!snap.exists()) return null;
  return normalizeOrder(snap);
}

export async function updateOrder(hotelUid, orderId, payload, actor) {
  if (!hotelUid || !orderId) throw new Error("hotelUid en orderId zijn verplicht");

  const orderRef = doc(db, `hotels/${hotelUid}/orders`, orderId);
  const snap = await getDoc(orderRef);
  if (!snap.exists()) throw new Error("Order niet gevonden");

  const current = snap.data() || {};
  if (String(current.status || "") !== "Created") {
    throw new Error("Enkel orders met status Created kunnen bewerkt worden");
  }

  if (String(payload?.status || "") === "Ordered") {
    throw new Error("Gebruik Confirm Order om verzending te starten; status wordt pas Ordered na succesvolle verzending");
  }

  const nextPayload = {
    ...payload,
    updatedAt: serverTimestamp(),
    updatedBy: actor || "unknown",
  };

  if (Array.isArray(payload?.products)) {
    const totalAmount = payload.products.reduce(
      (sum, item) => sum + Number(item.pricePerPurchaseUnit || 0) * Number(item.qtyPurchaseUnits || 0),
      0
    );
    nextPayload.totalAmount = totalAmount;
    nextPayload.currency = payload.products[0]?.currency || current.currency || "EUR";
  }

  await updateDoc(orderRef, nextPayload);
}

export async function deleteOrder(hotelUid, orderId) {
  if (!hotelUid || !orderId) throw new Error("hotelUid en orderId zijn verplicht");

  const orderRef = doc(db, `hotels/${hotelUid}/orders`, orderId);
  const snap = await getDoc(orderRef);
  if (!snap.exists()) throw new Error("Order niet gevonden");

  const current = snap.data() || {};
  if (String(current.status || "") !== "Created") {
    throw new Error("Enkel orders met status Created kunnen verwijderd worden");
  }

  await deleteDoc(orderRef);
}

export async function createOrdersFromShoppingCart(hotelUid, shoppingCartId, deliveryDate, actor) {
  if (!hotelUid || !shoppingCartId || !deliveryDate) {
    throw new Error("hotelUid, shoppingCartId en deliveryDate zijn verplicht");
  }

  const cartRef = doc(db, `hotels/${hotelUid}/shoppingCarts`, shoppingCartId);
  const cartSnap = await getDoc(cartRef);

  if (!cartSnap.exists()) {
    throw new Error("Shopping cart niet gevonden");
  }

  const cartData = cartSnap.data() || {};
  const items = Array.isArray(cartData.items) ? cartData.items : [];
  if (items.length === 0) {
    throw new Error("Shopping cart is leeg");
  }

  const itemsWithoutOutlet = items.filter((item) => !String(item.outletId || "").trim());
  if (itemsWithoutOutlet.length > 0) {
    throw new Error("Selecteer een outlet voor alle supplierproducten in de shopping cart");
  }

  const suppliersSnap = await getDocs(collection(db, `hotels/${hotelUid}/suppliers`));
  const suppliersById = {};
  const suppliersByName = {};
  suppliersSnap.forEach((supplierDoc) => {
    const supplierData = supplierDoc.data() || {};
    const supplierRecord = {
      id: supplierDoc.id,
      ...supplierData,
    };
    suppliersById[supplierDoc.id] = supplierRecord;

    const nameKey = normalizeLookupValue(supplierData.name);
    if (nameKey && !suppliersByName[nameKey]) {
      suppliersByName[nameKey] = supplierRecord;
    }
  });

  const resolveSupplier = (supplierValue) => {
    const directId = String(supplierValue || "").trim();
    if (directId && suppliersById[directId]) return suppliersById[directId];
    const byName = suppliersByName[normalizeLookupValue(supplierValue)];
    return byName || null;
  };

  const uniqueSupplierProductIds = [...new Set(items
    .map((item) => String(item?.supplierProductId || "").trim())
    .filter(Boolean))];

  const supplierProductsById = {};
  if (uniqueSupplierProductIds.length > 0) {
    const chunkSize = 10;
    for (let index = 0; index < uniqueSupplierProductIds.length; index += chunkSize) {
      const productChunk = uniqueSupplierProductIds.slice(index, index + chunkSize);
      const supplierProductsQuery = query(
        collection(db, `hotels/${hotelUid}/supplierproducts`),
        where("__name__", "in", productChunk)
      );
      const supplierProductsSnap = await getDocs(supplierProductsQuery);
      supplierProductsSnap.forEach((productDoc) => {
        supplierProductsById[productDoc.id] = { id: productDoc.id, ...(productDoc.data() || {}) };
      });
    }
  }

  const normalizedCartItems = items.map((item) => {
    const cartSupplierValue = String(item.supplierId || "").trim();
    const resolvedSupplier = resolveSupplier(cartSupplierValue);
    const resolvedSupplierId = resolvedSupplier?.id || cartSupplierValue || "Onbekend";

    const supplierProductId = String(item.supplierProductId || "").trim();
    const supplierProduct = supplierProductsById[supplierProductId];
    if (!supplierProduct) {
      throw new Error(`Supplier product niet gevonden in catalogus: ${supplierProductId}`);
    }

    const productSupplierValue = String(supplierProduct.supplierId || "").trim();
    const productSupplier = resolveSupplier(productSupplierValue);
    const productResolvedSupplierId = productSupplier?.id || productSupplierValue;

    if (!productResolvedSupplierId || productResolvedSupplierId !== resolvedSupplierId) {
      throw new Error(
        `Supplier product ${supplierProductId} hoort niet bij supplier ${cartSupplierValue || resolvedSupplierId || "Onbekend"}`
      );
    }

    return {
      ...item,
      supplierId: resolvedSupplierId,
    };
  });

  const groupedBySupplier = normalizedCartItems.reduce((acc, item) => {
    const supplierId = String(item.supplierId || "Onbekend").trim() || "Onbekend";
    if (!acc[supplierId]) acc[supplierId] = [];
    acc[supplierId].push(item);
    return acc;
  }, {});

  const ordersCol = collection(db, `hotels/${hotelUid}/orders`);
  const createdOrderIds = [];
  const deliveryDateAdjustments = [];

  for (const [supplierId, supplierItems] of Object.entries(groupedBySupplier)) {
    const totalAmount = supplierItems.reduce(
      (sum, item) => sum + (Number(item.pricePerPurchaseUnit || 0) * Number(item.qtyPurchaseUnits || 0)),
      0
    );

    const supplier = suppliersById[supplierId] || {};
    const resolvedDeliveryDate = resolveSupplierDeliveryDate(deliveryDate, supplier.deliveryDays);

    if (resolvedDeliveryDate !== deliveryDate) {
      deliveryDateAdjustments.push({
        supplierId,
        supplierName: String(supplier.name || "").trim() || supplierId,
        requestedDeliveryDate: deliveryDate,
        resolvedDeliveryDate,
      });
    }

    const orderPayload = {
      status: "Created",
      deliveryDate: resolvedDeliveryDate,
      shoppingCartId,
      supplierId,
      createdBy: actor || "unknown",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      products: supplierItems,
      totalAmount,
      currency: supplierItems[0]?.currency || "EUR",
    };

    const orderRef = await addDoc(ordersCol, orderPayload);
    createdOrderIds.push(orderRef.id);
  }

  await updateDoc(cartRef, {
    items: [],
    updatedAt: serverTimestamp(),
  });

  return {
    orderIds: createdOrderIds,
    deliveryDateAdjustments,
  };
}

export async function createOrderFromShoppingCart(hotelUid, shoppingCartId, deliveryDate, actor) {
  const result = await createOrdersFromShoppingCart(hotelUid, shoppingCartId, deliveryDate, actor);
  return result?.orderIds?.[0] || null;
}
