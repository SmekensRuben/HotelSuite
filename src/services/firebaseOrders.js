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
} from "../firebaseConfig";

const ORDER_STATUSES = ["Created", "Ordered", "Received", "Finalized", "Canceled"];

function normalizeTimestamp(value) {
  if (!value) return null;
  if (typeof value?.toDate === "function") return value.toDate();
  if (value instanceof Date) return value;
  return null;
}

export function listOrderStatuses() {
  return ORDER_STATUSES;
}

export async function getOrders(hotelUid) {
  if (!hotelUid) return [];

  const ordersCol = collection(db, `hotels/${hotelUid}/orders`);
  const ordersQuery = query(ordersCol, orderBy("createdAt", "desc"));
  const snap = await getDocs(ordersQuery);

  return snap.docs.map((docSnap) => {
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
    };
  });
}

export async function createOrderFromShoppingCart(hotelUid, shoppingCartId, deliveryDate, actor) {
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

  const totalAmount = items.reduce(
    (sum, item) => sum + (Number(item.pricePerPurchaseUnit || 0) * Number(item.qtyPurchaseUnits || 0)),
    0
  );

  const orderPayload = {
    status: "Created",
    deliveryDate,
    shoppingCartId,
    createdBy: actor || "unknown",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    products: items,
    totalAmount,
    currency: items[0]?.currency || "EUR",
  };

  const ordersCol = collection(db, `hotels/${hotelUid}/orders`);
  const orderRef = await addDoc(ordersCol, orderPayload);

  await updateDoc(cartRef, {
    items: [],
    updatedAt: serverTimestamp(),
  });

  return orderRef.id;
}
