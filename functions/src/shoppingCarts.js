const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { admin } = require("./config");
const { requireHotelPermission } = require("./authorization");
const { requireDocumentId } = require("./subscriptions");
const { text, digest } = require("./validation");
const { gated } = require("./saasRollout");

function quantity(value, allowZero = false) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < (allowZero ? 0 : 0.001) || n > 100000 || Math.abs(n * 1000 - Math.round(n * 1000)) > 1e-8) throw new HttpsError("invalid-argument", "Use a quantity from 0.001 to 100000, with up to three decimals.");
  return n;
}

async function mutateShoppingCartHandler(request, services = {}) {
  const db = services.firestore || admin.firestore();
  const input = request.data || {};
  const hotelUid = requireDocumentId(input.hotelUid, "hotelUid");
  if (!["get-or-create", "add", "quantity", "note", "outlet", "remove"].includes(input.action)) throw new HttpsError("invalid-argument", "Invalid cart action.");
  const operationRef = db.doc(`hotels/${hotelUid}/cartOperations/${digest(request.auth?.uid, requireDocumentId(input.requestId, "requestId"))}`);
  const fingerprint = digest(input.action, input.cartId || null, input.productId || null, input.value ?? null);
  return db.runTransaction(async (tx) => {
    await requireHotelPermission(db, request, hotelUid, "orders", "create", tx);
    const op = await tx.get(operationRef);
    if (op.exists) {
      if (op.data().fingerprint !== fingerprint) throw new HttpsError("already-exists", "This cart request was already used.");
      return op.data().result;
    }
    let cart;
    if (input.action === "get-or-create") {
      const latest = await tx.get(db.collection(`hotels/${hotelUid}/shoppingCarts`).orderBy("updatedAt", "desc").limit(1));
      cart = latest.docs[0];
      if (!cart) {
        const ref = db.doc(`hotels/${hotelUid}/shoppingCarts/shared`);
        cart = await tx.get(ref);
      }
    } else cart = await tx.get(db.doc(`hotels/${hotelUid}/shoppingCarts/${requireDocumentId(input.cartId, "cartId")}`));
    if (input.action !== "get-or-create" && !cart.exists) throw new HttpsError("not-found", "Shopping cart not found.");
    const storedItems = cart.data()?.items ?? [];
    if (!Array.isArray(storedItems) || storedItems.length > 100) throw new HttpsError("failed-precondition", "Review the cart's product lines.");
    let items = [...storedItems];
    if (input.action !== "get-or-create") {
      const productId = requireDocumentId(input.productId, "productId");
      const index = items.findIndex((i) => i.supplierProductId === productId);
      if (input.action === "add") {
        const product = await tx.get(db.doc(`hotels/${hotelUid}/supplierproducts/${productId}`));
        if (!product.exists || product.data().active === false) throw new HttpsError("not-found", "Choose an active product from this hotel.");
        const p = product.data();
        const qty = quantity(input.value);
        if (index >= 0) items[index] = { ...items[index], qtyPurchaseUnits: quantity(Number(items[index].qtyPurchaseUnits) + qty) };
        else {
          const item = { supplierProductId: productId, supplierId: requireDocumentId(p.supplierId, "Product supplier ID"), qtyPurchaseUnits: qty, outletId: "", note: "" };
          for (const key of ["supplierName", "supplierSku", "supplierProductName", "purchaseUnit", "pricingModel", "pricePerPurchaseUnit", "currency", "baseUnit", "baseUnitsPerPurchaseUnit", "imageUrl"]) if (p[key] !== undefined) item[key] = p[key];
          items.push(item);
        }
      } else {
        if (index < 0) throw new HttpsError("not-found", "This product is no longer in the cart.");
        if (input.action === "remove") items.splice(index, 1);
        if (input.action === "quantity") {
          const qty = quantity(input.value, true);
          if (qty === 0) items.splice(index, 1); else items[index] = { ...items[index], qtyPurchaseUnits: qty };
        }
        if (input.action === "note") items[index] = { ...items[index], note: text(input.value, "Product note", 1000) };
        if (input.action === "outlet") {
          const outletId = input.value === "" ? "" : requireDocumentId(input.value, "outletId");
          if (outletId && !(await tx.get(db.doc(`hotels/${hotelUid}/outlets/${outletId}`))).exists) throw new HttpsError("not-found", "Choose an outlet from this hotel.");
          items[index] = { ...items[index], outletId };
        }
      }
      if (items.length > 100) throw new HttpsError("invalid-argument", "Use at most 100 product lines per cart.");
    }
    const revision = (cart.data()?.revision || 0) + (input.action !== "get-or-create" ? 1 : 0);
    const result = { cartId: cart.id, revision };
    if (!cart.exists || input.action !== "get-or-create") tx.set(cart.ref, {
      ...(cart.exists ? {} : { createdAt: admin.firestore.FieldValue.serverTimestamp(), createdBy: request.auth.uid }),
      items, revision, updatedAt: admin.firestore.FieldValue.serverTimestamp(), updatedBy: request.auth.uid,
    }, { merge: true });
    tx.create(operationRef, { fingerprint, result, actorUid: request.auth.uid, createdAt: admin.firestore.FieldValue.serverTimestamp() });
    return result;
  });
}

module.exports = { quantity, mutateShoppingCartHandler, mutateHotelShoppingCart: onCall({ region: "us-central1", cors: true }, gated(mutateShoppingCartHandler)) };
