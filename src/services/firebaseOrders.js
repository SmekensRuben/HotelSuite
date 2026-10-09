import { functions, httpsCallable } from "../firebaseConfig";
import {
  db,
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  orderBy,
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
    status: ORDER_STATUSES.includes(data.status) ? data.status : "Unknown",
    products: Array.isArray(data.products) ? data.products : [],
    totalAmount: Number(data.totalAmount || 0),
    supplierId: data.supplierId || "",
    outletId: data.outletId || "",
    outletName: data.outletName || "",
    accountNumber: data.accountNumber || "",
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

export async function updateOrder(hotelUid, orderId, payload, actor, expectedRevision) {
  if (expectedRevision === undefined) expectedRevision = (await getOrderById(hotelUid, orderId))?.revision || 0;
  return (await httpsCallable(functions, "updateHotelOrder")({ hotelUid, orderId, payload, expectedRevision })).data;
}

export async function deleteOrder(hotelUid, orderId) {
  return (await httpsCallable(functions, "deleteHotelOrder")({ hotelUid, orderId })).data;
}

export async function confirmOrder(hotelUid, orderId, expectedRevision, requestId) {
  return (await httpsCallable(functions, "confirmHotelOrder")({ hotelUid, orderId, expectedRevision, requestId })).data;
}

export async function createOrdersFromShoppingCart(hotelUid, shoppingCartId, deliveryDate, actor, expectedCartRevision) {
  if (expectedCartRevision === undefined) throw new Error("Refresh and review the cart before submitting.");
  const storageKey = `order-request:${hotelUid}:${shoppingCartId}:${deliveryDate}:${expectedCartRevision}`;
  let requestId = sessionStorage.getItem(storageKey);
  if (!requestId) {
    requestId = crypto.randomUUID();
    sessionStorage.setItem(storageKey, requestId);
  }
  const result = (await httpsCallable(functions, "createOrdersFromCart")({ hotelUid, shoppingCartId, deliveryDate, requestId, expectedCartRevision })).data;
  sessionStorage.removeItem(storageKey);
  return result;
}

export async function createOrderFromShoppingCart(hotelUid, shoppingCartId, deliveryDate, actor, expectedCartRevision) {
  const result = await createOrdersFromShoppingCart(hotelUid, shoppingCartId, deliveryDate, actor, expectedCartRevision);
  return result?.orderIds?.[0] || null;
}

export async function reviewOrderDelivery(input) {
  return (await httpsCallable(functions, "reviewHotelOrderDelivery")(input)).data;
}
