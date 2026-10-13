import { normalizeOrderPriceBasis } from "../utils/orderPricing";
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
    totalAmount: typeof data.totalAmount === "number" && Number.isFinite(data.totalAmount) && data.totalAmount >= 0 ? data.totalAmount : null,
    supplierId: data.supplierId || "",
    outletId: data.outletId || "",
    outletName: data.outletName || "",
    accountNumber: data.accountNumber || "",
    priceBasis: normalizeOrderPriceBasis(data.priceBasis),
    currency: typeof data.currency === "string" && /^[A-Z]{3}$/.test(data.currency) ? data.currency : null,
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

export async function getHotelOrderReceiving({ hotelUid, orderId, afterEventId = null }) {
  const { data } = await httpsCallable(functions, "getHotelOrderReceiving")({ hotelUid, orderId, afterEventId });
  const validQuantity = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
  if (!data || data.hotelUid !== hotelUid || data.orderId !== orderId || data.policyVersion !== 1
    || data.supplierPricingPolicyVersion !== 1 || !(data.supplierReceiptBlockReason === null || typeof data.supplierReceiptBlockReason === "string" && data.supplierReceiptBlockReason.length <= 2000)
    || !Number.isSafeInteger(data.orderRevision) || data.orderRevision < 0 || typeof data.releaseReady !== "boolean"
    || !["available", "not-started", "review-required"].includes(data.availability)
    || !Array.isArray(data.events) || !(data.nextCursor === null || typeof data.nextCursor === "string")
    || data.events.some((event) => !event || typeof event.id !== "string" || !["receipt", "reversal", "finalization"].includes(event.kind)
      || typeof event.actorUid !== "string" || !Array.isArray(event.lines)
      || event.createdAtMillis !== null && !Number.isFinite(event.createdAtMillis))
    || data.availability === "available" && !["awaiting", "partial", "complete", "closed"].includes(data.receivingState)
    || data.availability === "available" && (!Array.isArray(data.lines) || !data.lines.length || data.lines.length > 100
      || data.lines.some((line) => !line || typeof line.supplierProductId !== "string"
        || ["orderedQuantity", "acceptedQuantity", "rejectedQuantity", "outstandingQuantity", "excessQuantity"].some((key) => !validQuantity(line[key]))
        || line.orderedQuantity <= 0))) {
    throw new Error("The receiving response is incomplete or belongs to another hotel/order.");
  }
  return data;
}
async function receivingCommand(name, input) {
  const { data } = await httpsCallable(functions, name)(input);
  if (!data || data.hotelUid !== input.hotelUid || data.orderId !== input.orderId || typeof data.eventId !== "string"
    || !Number.isSafeInteger(data.revision) || data.revision < 1 || !["Ordered", "Received", "Finalized"].includes(data.status)) {
    throw new Error("The receiving result could not be verified. Retry the same saved request.");
  }
  return data;
}
// Older Functions reject this field instead of accepting goods with a stale pricing policy.
export const recordHotelOrderReceipt = (input) => receivingCommand("recordHotelOrderReceipt", { ...input, supplierPricingPolicyVersion: 1 });
export const reverseHotelOrderReceipt = (input) => receivingCommand("reverseHotelOrderReceipt", input);
export const finalizeHotelOrderReceiving = (input) => receivingCommand("finalizeHotelOrderReceiving", input);
