import { auth, functions, httpsCallable } from "../firebaseConfig";
import { requireServerSnapshot } from "./procurementReadPool";
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

export async function getShoppingCart(hotelUid, shoppingCartId, { minimumRevision = 0 } = {}) {
  if (!hotelUid || !shoppingCartId) return null;
  const actor = auth.currentUser;
  const cartRef = doc(db, `hotels/${hotelUid}/shoppingCarts`, shoppingCartId);
  const cartSnap = requireServerSnapshot(await getDoc(cartRef));
  if (auth.currentUser !== actor) throw new Error("Your sign-in changed. Reload this cart before continuing.");

  if (!cartSnap.exists()) return null;

  const data = cartSnap.data() || {};
  if (!Number.isSafeInteger(data.revision ?? 0) || (data.revision ?? 0) < minimumRevision) throw new Error("The cart has not caught up with the saved request. Refresh the cart before continuing.");
  return {
    id: cartSnap.id,
    ...data,
    createdAtDate: normalizeTimestamp(data.createdAt),
    updatedAtDate: normalizeTimestamp(data.updatedAt),
    items: Array.isArray(data.items) ? data.items : [],
  };
}

function pendingCartKey(hotelUid, cartId = "active") {
  const actor = auth.currentUser?.uid;
  if (!hotelUid || !actor) throw new Error("A signed-in hotel user is required.");
  return `cart-command:${actor}:${hotelUid}:${cartId}`;
}
function notifyCartCommand() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event("cart-command-changed"));
}
export function getPendingCartCommand(hotelUid, cartId = "active") {
  if (!hotelUid || !auth.currentUser?.uid) return null;
  const saved = sessionStorage.getItem(pendingCartKey(hotelUid, cartId));
  return saved ? JSON.parse(JSON.parse(saved).input) : null;
}
export async function retryPendingCartCommand(hotelUid, cartId = "active") {
  const input = getPendingCartCommand(hotelUid, cartId);
  if (!input) throw new Error("No pending cart request is available.");
  return mutateCart(hotelUid, input);
}
async function mutateCart(hotelUid, input) {
  const actor = auth.currentUser;
  const key = pendingCartKey(hotelUid, input.cartId || "active");
  const serialized = JSON.stringify(input);
  const saved = sessionStorage.getItem(key);
  let pending = saved ? JSON.parse(saved) : null;
  if (pending && pending.input !== serialized) throw new Error("The previous cart request has an uncertain result. Retry the saved request before changing this cart.");
  if (!pending) {
    pending = { input: serialized, requestId: crypto.randomUUID() };
    sessionStorage.setItem(key, JSON.stringify(pending));
  }
  try {
    const { data } = await httpsCallable(functions, "mutateHotelShoppingCart")({ hotelUid, ...input, requestId: pending.requestId });
    if (auth.currentUser !== actor) throw new Error("Your sign-in changed. The saved cart request must be reconciled by its original user.");
    if (typeof data?.cartId !== "string" || !data.cartId || (input.cartId && data.cartId !== input.cartId)) throw new Error("Cart response could not be validated. Retry the saved request.");
    if (!Number.isSafeInteger(data.revision) || data.revision < 0) throw new Error("Cart revision could not be validated. Retry the saved request.");
    sessionStorage.removeItem(key); notifyCartCommand();
    return data;
  } catch (error) {
    if (error?.details?.cartRequestUncommitted === true) sessionStorage.removeItem(key);
    notifyCartCommand();
    throw error;
  }
}

export async function getOrCreateShoppingCart(hotelUid) {
  if (!hotelUid) return null;
  const { cartId, revision } = await mutateCart(hotelUid, { action: "get-or-create" });
  return getShoppingCart(hotelUid, cartId, { minimumRevision: revision });
}
export async function addSupplierProductToShoppingCart(hotelUid, cartId, product, qty = 1, purchaseOptionId = "default", expectedRevision = 0) {
  return mutateCart(hotelUid, { cartId, action: "add", productId: product.id, purchaseOptionId, value: qty, expectedRevision });
}
export async function updateShoppingCartItemQty(hotelUid, cartId, productId, value, purchaseOptionId = "default", expectedRevision = 0) {
  return mutateCart(hotelUid, { cartId, action: "quantity", productId, purchaseOptionId, value, expectedRevision });
}
export async function updateShoppingCartItemNote(hotelUid, cartId, productId, value, purchaseOptionId = "default", expectedRevision = 0) {
  return mutateCart(hotelUid, { cartId, action: "note", productId, purchaseOptionId, value, expectedRevision });
}
export async function updateShoppingCartItemOutlet(hotelUid, cartId, productId, value, purchaseOptionId = "default", expectedRevision = 0) {
  return mutateCart(hotelUid, { cartId, action: "outlet", productId, purchaseOptionId, value, expectedRevision });
}
export async function removeShoppingCartItem(hotelUid, cartId, productId, purchaseOptionId = "default", expectedRevision = 0) {
  return mutateCart(hotelUid, { cartId, action: "remove", productId, purchaseOptionId, expectedRevision });
}
