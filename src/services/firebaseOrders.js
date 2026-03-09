import {
  db,
  collection,
  doc,
  addDoc,
  getDoc,
  getDocs,
  query,
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

  const groupedBySupplier = items.reduce((acc, item) => {
    const supplierId = String(item.supplierId || "Onbekend").trim() || "Onbekend";
    if (!acc[supplierId]) acc[supplierId] = [];
    acc[supplierId].push(item);
    return acc;
  }, {});

  const ordersCol = collection(db, `hotels/${hotelUid}/orders`);
  const createdOrderIds = [];

  for (const [supplierId, supplierItems] of Object.entries(groupedBySupplier)) {
    const totalAmount = supplierItems.reduce(
      (sum, item) => sum + (Number(item.pricePerPurchaseUnit || 0) * Number(item.qtyPurchaseUnits || 0)),
      0
    );

    const orderPayload = {
      status: "Created",
      deliveryDate,
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

  return createdOrderIds;
}

export async function createOrderFromShoppingCart(hotelUid, shoppingCartId, deliveryDate, actor) {
  const orderIds = await createOrdersFromShoppingCart(hotelUid, shoppingCartId, deliveryDate, actor);
  return orderIds[0] || null;
}
