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

async function mutateCart(hotelUid, input) {
  const key = `cart-request:${hotelUid}:${JSON.stringify(input)}`;
  let requestId = sessionStorage.getItem(key);
  if (!requestId) { requestId = crypto.randomUUID(); sessionStorage.setItem(key, requestId); }
  const { data } = await httpsCallable(functions, "mutateHotelShoppingCart")({ hotelUid, ...input, requestId });
  sessionStorage.removeItem(key);
  return data;
}

export async function getOrCreateShoppingCart(hotelUid) {
  if (!hotelUid) return null;
  const { cartId } = await mutateCart(hotelUid, { action: "get-or-create" });
  return getShoppingCart(hotelUid, cartId);
}
export async function addSupplierProductToShoppingCart(hotelUid, cartId, product, qty = 1) {
  return mutateCart(hotelUid, { cartId, action: "add", productId: product.id, value: qty });
}
export async function updateShoppingCartItemQty(hotelUid, cartId, productId, value) {
  return mutateCart(hotelUid, { cartId, action: "quantity", productId, value });
}
export async function updateShoppingCartItemNote(hotelUid, cartId, productId, value) {
  return mutateCart(hotelUid, { cartId, action: "note", productId, value });
}
export async function updateShoppingCartItemOutlet(hotelUid, cartId, productId, value) {
  return mutateCart(hotelUid, { cartId, action: "outlet", productId, value });
}
export async function removeShoppingCartItem(hotelUid, cartId, productId) {
  return mutateCart(hotelUid, { cartId, action: "remove", productId });
}
