const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { admin } = require("./config");
const { requireHotelPermission } = require("./authorization");
const { requireDocumentId } = require("./subscriptions");
const { text, digest, revision: validRevision } = require("./validation");
const { gated } = require("./saasRollout");
const { resolvePurchaseOption } = require("./productPolicy");
const { isArchived } = require("./procurementResources");
const { loadSupplierPriceVersions } = require("./supplierPriceVersions");
const { assessPriceValidity } = require("./supplierPricePolicy");

function normalizeCartItems(items) {
  const ids = new Set();
  return items.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new HttpsError("failed-precondition", "Review the cart's product lines.");
    const lineId = requireDocumentId(item.lineId ?? `legacy-${index}`, "Cart line ID");
    if (ids.has(lineId)) throw new HttpsError("failed-precondition", "Cart line identities need review.");
    ids.add(lineId);
    return { ...item, lineId, lineRevision: validRevision(item.lineRevision ?? 0) };
  });
}

function quantity(value, allowZero = false) {
  const n = value;
  if (typeof n !== "number" || !Number.isFinite(n) || n < (allowZero ? 0 : 0.001) || n > 100000 || Math.abs(n * 1000 - Math.round(n * 1000)) > 1e-8) throw new HttpsError("invalid-argument", "Use a quantity from 0.001 to 100000, with up to three decimals.");
  return n;
}

async function mutateShoppingCartHandler(request, services = {}) {
  const db = services.firestore || admin.firestore();
  const input = request.data || {};
  const hotelUid = requireDocumentId(input.hotelUid, "hotelUid");
  if (!["get-or-create", "add", "quantity", "note", "outlet", "remove", "split"].includes(input.action)) throw new HttpsError("invalid-argument", "Invalid cart action.");
  const operationRef = db.doc(`hotels/${hotelUid}/cartOperations/${digest(request.auth?.uid, requireDocumentId(input.requestId, "requestId"))}`);
  const purchaseOptionId = requireDocumentId(input.purchaseOptionId ?? "default", "purchaseOptionId");
  const fingerprintValues = [input.action, input.cartId || null, input.productId || null, purchaseOptionId, input.value ?? null, input.expectedRevision ?? null];
  // Preserve exact replay of requests saved by earlier clients.
  if (input.lineId !== undefined || input.expectedLineRevision !== undefined || input.outletId !== undefined) {
    fingerprintValues.push(input.lineId ?? null, input.expectedLineRevision ?? null, input.outletId ?? null);
  }
  const fingerprint = digest(...fingerprintValues);
  const lineScoped = input.action !== "add" && input.action !== "get-or-create" && input.lineId !== undefined && input.expectedLineRevision !== undefined;
  const actorName = String(request.auth?.token?.name || request.auth?.token?.email || request.auth?.uid || "").slice(0, 200);
  const now = services.now?.() ?? Date.now();
  const newLineId = `line-${digest(request.auth?.uid, input.requestId).slice(0, 32)}`;
  const added = { addedBy: request.auth?.uid, addedByName: actorName, addedAt: now };
  const updated = { updatedBy: request.auth?.uid, updatedByName: actorName, updatedAt: now };
  return db.runTransaction(async (tx) => {
    await requireHotelPermission(db, { ...request }, hotelUid, "orders", "create", tx, services.auth);
    const op = await tx.get(operationRef);
    if (op.exists) {
      if (op.data().fingerprint !== fingerprint) throw new HttpsError("already-exists", "This cart request was already used.");
      return op.data().result;
    }
    try {
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
    if (input.action !== "get-or-create" && !lineScoped && validRevision(input.expectedRevision) !== (cart.data()?.revision ?? 0)) {
      throw new HttpsError("aborted", "The shopping cart changed. Reload before editing its product lines.");
    }
    const storedItems = cart.data()?.items ?? [];
    if (!Array.isArray(storedItems) || storedItems.length > 100) throw new HttpsError("failed-precondition", "Review the cart's product lines.");
    let items = normalizeCartItems(storedItems);
    if (input.action !== "get-or-create") {
      const productId = requireDocumentId(input.productId, "productId");
      const matchesProduct = (item) => item.supplierProductId === productId && (item.purchaseOptionId ?? "default") === purchaseOptionId;
      const outletId = input.action === "add" ? (input.outletId ? requireDocumentId(input.outletId, "outletId") : "") : null;
      const matching = items.map((item, index) => ({ item, index })).filter(({ item }) => matchesProduct(item)
        && (input.action === "add" ? (item.outletId || "") === outletId : input.lineId === undefined || item.lineId === requireDocumentId(input.lineId, "lineId")));
      if (matching.length > 1) throw new HttpsError("failed-precondition", "This product has multiple cart lines. Refresh and choose the specific outlet line.");
      const index = matching[0]?.index ?? -1;
      if (lineScoped && index >= 0 && validRevision(input.expectedLineRevision) !== items[index].lineRevision) {
        throw new HttpsError("aborted", "This cart line changed. Your entry has not been saved. Refresh and review the latest quantity, outlet and note before trying again.");
      }
      const requireOutlet = async (id) => {
        if (!id) return;
        const outlet = await tx.get(db.doc(`hotels/${hotelUid}/outlets/${id}`));
        if (!outlet.exists || isArchived(outlet.data())) throw new HttpsError("not-found", "Choose an active outlet from this hotel.");
      };
      const requireSeparateOutlet = (id) => {
        if (items.some((item, otherIndex) => otherIndex !== index && matchesProduct(item) && (item.outletId || "") === id)) {
          throw new HttpsError("failed-precondition", "This package already has a line for that outlet. Update that line separately so its quantity and note stay clear.");
        }
      };
      if (input.action === "add") {
        await requireOutlet(outletId);
        const product = await tx.get(db.doc(`hotels/${hotelUid}/supplierproducts/${productId}`));
        if (!product.exists || product.data().active === false) throw new HttpsError("not-found", "Choose an active product from this hotel.");
        let p = product.data();
        // The cart is an editable estimate. A future-only offer can be added;
        // preview/creation select its actual dated agreement before ordering.
        const sourceOption = purchaseOptionId === "default" ? p : p.purchaseOptions?.find((option) => option.id === purchaseOptionId);
        if (sourceOption?.pricePerPurchaseUnit === null || sourceOption?.pricePerPurchaseUnit === undefined
          || p.hasVariants && !(p.purchaseOptions?.length > 0)) {
          const approved = (await loadSupplierPriceVersions(tx, db, hotelUid, productId)).at(-1);
          if (approved) p = { ...p, ...approved.productTerms, indicativePriceVersionId: approved.id };
        }
        const option = resolvePurchaseOption(p, purchaseOptionId);
        const qty = quantity(input.value);
        if (index >= 0) items[index] = { ...items[index], ...updated, lineRevision: items[index].lineRevision + 1, qtyPurchaseUnits: quantity(Number(items[index].qtyPurchaseUnits) + qty) };
        else {
          const item = { supplierProductId: productId, purchaseOptionId, supplierId: requireDocumentId(p.supplierId, "Product supplier ID"), qtyPurchaseUnits: qty, outletId, note: "", lineId: newLineId, lineRevision: 1, ...added, ...updated };
          for (const key of ["supplierName", "supplierSku", "supplierProductName", "pricingModel", "image", "imageRevision"]) if (p[key] !== undefined) item[key] = p[key];
          for (const key of ["purchaseUnit", "pricePerPurchaseUnit", "currency", "baseUnit", "baseUnitsPerPurchaseUnit", "priceBasis", "vatRate"]) item[key] = option[key];
          item.priceValidity = assessPriceValidity(p, new Date(services.now?.() ?? Date.now()).toISOString().slice(0, 10));
          if (p.indicativePriceVersionId) item.indicativePriceVersionId = p.indicativePriceVersionId;
          items.push(item);
        }
      } else {
        if (index < 0) throw new HttpsError("not-found", "This product is no longer in the cart.");
        const original = items[index];
        items[index] = { ...original, ...updated, lineRevision: original.lineRevision + 1 };
        if (input.action === "remove") items.splice(index, 1);
        if (input.action === "quantity") {
          const qty = quantity(input.value, true);
          if (qty === 0) items.splice(index, 1); else items[index] = { ...items[index], qtyPurchaseUnits: qty };
        }
        if (input.action === "note") items[index] = { ...items[index], note: text(input.value, "Product note", 1000) };
        if (input.action === "outlet") {
          const outletId = input.value === "" ? "" : requireDocumentId(input.value, "outletId");
          await requireOutlet(outletId);
          requireSeparateOutlet(outletId);
          items[index] = { ...items[index], outletId };
        }
        if (input.action === "split") {
          const splitQuantity = quantity(input.value?.quantity);
          const destination = requireDocumentId(input.value?.outletId, "outletId");
          if (destination === original.outletId) throw new HttpsError("invalid-argument", "Choose a different outlet for the split quantity.");
          if (splitQuantity >= original.qtyPurchaseUnits) throw new HttpsError("invalid-argument", "Split less than the current quantity, or change the outlet for the whole line.");
          await requireOutlet(destination);
          requireSeparateOutlet(destination);
          items[index] = { ...items[index], qtyPurchaseUnits: quantity(Math.round((original.qtyPurchaseUnits - splitQuantity) * 1000) / 1000) };
          items.push({ ...original, ...added, ...updated, lineId: newLineId, lineRevision: 1,
            qtyPurchaseUnits: splitQuantity, outletId: destination });
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
    } catch (error) {
      if (error instanceof HttpsError) throw new HttpsError(error.code, error.message, { cartRequestUncommitted: true });
      throw error;
    }
  });
}

module.exports = { quantity, normalizeCartItems, mutateShoppingCartHandler, mutateHotelShoppingCart: onCall({ region: "us-central1", cors: true }, gated(mutateShoppingCartHandler)) };
