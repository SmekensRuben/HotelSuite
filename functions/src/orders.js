const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { admin } = require("./config");
const { requireHotelPermission, permissionAllows, normalizedPermissions } = require("./authorization");
const { requireDocumentId } = require("./subscriptions");
const { text, revision, digest } = require("./validation");
const { gated } = require("./saasRollout");

const stamp = () => admin.firestore.FieldValue.serverTimestamp();
function dateOnly(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)
    || !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw new HttpsError("invalid-argument", "Use a valid delivery date.");
  }
  return value;
}
function deliveryDate(requested, days) {
  dateOnly(requested);
  if (!Array.isArray(days) || !days.length) return requested;
  const valid = days.filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
  if (!valid.length) throw new HttpsError("failed-precondition", "Review the supplier's delivery weekdays.");
  const date = new Date(`${requested}T00:00:00Z`);
  for (let n = 0; n < 7; n++) {
    if (valid.includes(date.getUTCDay())) return date.toISOString().slice(0, 10);
    date.setUTCDate(date.getUTCDate() + 1);
  }
  throw new HttpsError("failed-precondition", "No delivery day available.");
}

function cartInput(items) {
  if (!Array.isArray(items) || !items.length || items.length > 100) throw new HttpsError("invalid-argument", "An order must contain 1–100 product lines.");
  const seen = new Set();
  return items.map((item) => {
    const supplierProductId = requireDocumentId(item.supplierProductId, "supplierProductId");
    const outletId = requireDocumentId(item.outletId, "outletId");
    const quantity = Number(item.qtyPurchaseUnits);
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 100000 || Math.abs(quantity * 1000 - Math.round(quantity * 1000)) > 1e-8) throw new HttpsError("invalid-argument", "Quantities must be positive, at most 100000, with up to three decimals.");
    const key = `${supplierProductId}/${outletId}`;
    if (seen.has(key)) throw new HttpsError("invalid-argument", "Merge duplicate product lines before submitting.");
    seen.add(key);
    return { supplierProductId, outletId, qtyPurchaseUnits: quantity, note: text(item.note || "", "Product note", 1000) };
  });
}

async function canonicalLines(db, tx, hotelUid, items) {
  const input = cartInput(items);
  const productIds = [...new Set(input.map((i) => i.supplierProductId))];
  const productSnaps = await tx.getAll(...productIds.map((id) => db.doc(`hotels/${hotelUid}/supplierproducts/${id}`)));
  const products = new Map(productSnaps.map((s) => [s.id, s]));
  const supplierIds = [...new Set(productSnaps.map((s) => {
    if (!s.exists || s.data().active === false) throw new HttpsError("failed-precondition", "A product is missing or inactive.");
    return requireDocumentId(s.data().supplierId, "Product supplier ID");
  }))];
  const outletIds = [...new Set(input.map((i) => i.outletId))];
  const refs = [...supplierIds.map((id) => db.doc(`hotels/${hotelUid}/suppliers/${id}`)), ...outletIds.map((id) => db.doc(`hotels/${hotelUid}/outlets/${id}`))];
  const snapshots = await tx.getAll(...refs);
  if (snapshots.some((s) => !s.exists)) throw new HttpsError("failed-precondition", "A supplier or outlet no longer exists in this hotel.");
  const suppliers = new Map(snapshots.slice(0, supplierIds.length).map((s) => [s.id, s.data()]));
  const outlets = new Map(snapshots.slice(supplierIds.length).map((s) => [s.id, s.data()]));
  const lines = input.map((item) => {
    const p = products.get(item.supplierProductId).data();
    const price = Number(p.pricePerPurchaseUnit);
    if (!Number.isFinite(price) || price < 0 || price > 1000000) throw new HttpsError("failed-precondition", "A product needs a valid catalog price.");
    const currency = p.currency || "EUR";
    if (!/^[A-Z]{3}$/.test(currency)) throw new HttpsError("failed-precondition", "A product needs a valid currency.");
    const line = { ...item, supplierId: p.supplierId, supplierName: suppliers.get(p.supplierId).name || p.supplierId,
      outletName: outlets.get(item.outletId).name || item.outletId, pricePerPurchaseUnit: price, currency };
    for (const field of ["supplierSku", "supplierProductName", "purchaseUnit", "pricingModel", "baseUnit"]) line[field] = String(p[field] || "").slice(0, 200);
    line.baseUnitsPerPurchaseUnit = Number(p.baseUnitsPerPurchaseUnit || 0);
    if (!Number.isFinite(line.baseUnitsPerPurchaseUnit)) line.baseUnitsPerPurchaseUnit = 0;
    return line;
  });
  return { lines, suppliers, outlets };
}

async function canonicalAccount(db, tx, hotelUid, supplierId, outletId, supplier) {
  const matches = await tx.get(db.collection(`hotels/${hotelUid}/supplierOutletAccounts`).where("supplierId", "==", supplierId).where("outletId", "==", outletId).limit(2));
  if (matches.size > 1) throw new HttpsError("failed-precondition", "Duplicate supplier/outlet accounts need review.");
  return text(matches.docs[0]?.data().accountNumber || supplier.accountNumber || "", "Supplier account", 100);
}

async function createOrdersFromCartHandler(request, services = {}) {
  const db = services.firestore || admin.firestore();
  const input = request.data || {};
  const hotelUid = requireDocumentId(input.hotelUid, "hotelUid");
  const cartId = requireDocumentId(input.shoppingCartId, "shoppingCartId");
  const requestId = requireDocumentId(input.requestId, "requestId");
  const requestedDate = dateOnly(input.deliveryDate);
  const cartRevision = revision(input.expectedCartRevision);
  const operation = db.doc(`hotels/${hotelUid}/orderOperations/${digest(request.auth?.uid, requestId)}`);
  const fingerprint = digest(cartId, requestedDate, cartRevision);
  return db.runTransaction(async (tx) => {
    await requireHotelPermission(db, request, hotelUid, "orders", "create", tx);
    const [op, cart] = await Promise.all([tx.get(operation), tx.get(db.doc(`hotels/${hotelUid}/shoppingCarts/${cartId}`))]);
    if (op.exists) {
      if (op.data().fingerprint !== fingerprint) throw new HttpsError("already-exists", "This order request was used with different details.");
      return op.data().result;
    }
    if (!cart.exists) throw new HttpsError("not-found", "Shopping cart not found.");
    if ((cart.data().revision || 0) !== cartRevision) throw new HttpsError("aborted", "The cart changed. Refresh and review it before creating orders.");
    const { lines, suppliers } = await canonicalLines(db, tx, hotelUid, cart.data().items);
    const groups = new Map();
    for (const line of lines) {
      const key = `${line.supplierId}/${line.outletId}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(line);
    }
    if (groups.size > 25) throw new HttpsError("invalid-argument", "Create at most 25 supplier/outlet orders at a time.");
    const accounts = new Map();
    for (const [key, products] of groups) {
      const [supplierId, outletId] = key.split("/");
      accounts.set(key, await canonicalAccount(db, tx, hotelUid, supplierId, outletId, suppliers.get(supplierId)));
      if (new Set(products.map((p) => p.currency)).size !== 1) throw new HttpsError("failed-precondition", "An order cannot mix currencies.");
    }
    const result = { orderIds: [], deliveryDateAdjustments: [] };
    for (const [key, products] of groups) {
      const [supplierId, outletId] = key.split("/");
      const supplier = suppliers.get(supplierId);
      const resolvedDate = deliveryDate(requestedDate, supplier.deliveryDays);
      const orderId = `o-${digest(hotelUid, request.auth.uid, requestId, key).slice(0, 40)}`;
      result.orderIds.push(orderId);
      if (resolvedDate !== requestedDate) result.deliveryDateAdjustments.push({ supplierId, supplierName: supplier.name || supplierId, requestedDeliveryDate: requestedDate, resolvedDeliveryDate: resolvedDate });
      tx.create(db.doc(`hotels/${hotelUid}/orders/${orderId}`), { supplierId, supplierName: supplier.name || supplierId,
        outletId, outletName: products[0].outletName, accountNumber: accounts.get(key), products,
        totalAmount: Math.round(products.reduce((sum, p) => sum + p.pricePerPurchaseUnit * p.qtyPurchaseUnits, 0) * 100) / 100,
        currency: products[0].currency, deliveryDate: resolvedDate, shoppingCartId: cartId, status: "Created", revision: 1,
        createdBy: request.auth.uid, createdAt: stamp(), updatedAt: stamp(), dispatchStatus: "" });
    }
    tx.update(cart.ref, { items: [], revision: cartRevision + 1, updatedAt: stamp() });
    tx.create(operation, { fingerprint, result, actorUid: request.auth.uid, createdAt: stamp() });
    return result;
  });
}

function editable(order) {
  if (order.status !== "Created" || order.dispatchRequestId) throw new HttpsError("failed-precondition", "Only unsubmitted Created orders can be changed.");
}
async function updateOrderHandler(request, services = {}) {
  const db = services.firestore || admin.firestore();
  const input = request.data || {};
  const hotelUid = requireDocumentId(input.hotelUid, "hotelUid");
  const orderId = requireDocumentId(input.orderId, "orderId");
  const expected = revision(input.expectedRevision);
  const payload = input.payload || {};
  if (Object.keys(payload).some((k) => !["products", "deliveryDate"].includes(k))) throw new HttpsError("invalid-argument", "Only product quantities, notes and the delivery date can be edited.");
  return db.runTransaction(async (tx) => {
    await requireHotelPermission(db, request, hotelUid, "orders", "update", tx);
    const snap = await tx.get(db.doc(`hotels/${hotelUid}/orders/${orderId}`));
    if (!snap.exists) throw new HttpsError("not-found", "Order not found.");
    const order = snap.data(); editable(order);
    if ((order.revision || 0) !== expected) throw new HttpsError("aborted", "Order changed. Reload before saving.");
    const products = payload.products ?? order.products;
    if (!Array.isArray(products)) throw new HttpsError("invalid-argument", "Product lines are required.");
    // Editing cannot add unrelated products, change the supplier or move the order to another outlet.
    const originalIds = new Set(order.products.map((p) => p.supplierProductId));
    const normalized = products.map((p) => ({ ...p, outletId: order.outletId }));
    if (normalized.some((p) => !originalIds.has(p.supplierProductId))) throw new HttpsError("invalid-argument", "Use the shopping cart to add new products.");
    const { lines, suppliers } = await canonicalLines(db, tx, hotelUid, normalized);
    if (lines.some((p) => p.supplierId !== order.supplierId)) throw new HttpsError("failed-precondition", "A product's supplier has changed. Recreate the order.");
    if (new Set(lines.map((p) => p.currency)).size !== 1) throw new HttpsError("failed-precondition", "An order cannot mix currencies.");
    const resolved = deliveryDate(payload.deliveryDate ?? order.deliveryDate, suppliers.get(order.supplierId).deliveryDays);
    const accountNumber = await canonicalAccount(db, tx, hotelUid, order.supplierId, order.outletId, suppliers.get(order.supplierId));
    tx.update(snap.ref, { products: lines, deliveryDate: resolved, totalAmount: Math.round(lines.reduce((sum, p) => sum + p.pricePerPurchaseUnit * p.qtyPurchaseUnits, 0) * 100) / 100,
      currency: lines[0].currency, accountNumber, revision: expected + 1, updatedAt: stamp(), updatedBy: request.auth.uid });
    return { revision: expected + 1 };
  });
}

async function deleteOrderHandler(request, services = {}) {
  const db = services.firestore || admin.firestore();
  const hotelUid = requireDocumentId(request.data?.hotelUid, "hotelUid");
  const orderId = requireDocumentId(request.data?.orderId, "orderId");
  return db.runTransaction(async (tx) => {
    await requireHotelPermission(db, request, hotelUid, "orders", "delete", tx);
    const order = await tx.get(db.doc(`hotels/${hotelUid}/orders/${orderId}`));
    if (!order.exists) return { deleted: false };
    editable(order.data()); tx.delete(order.ref);
    tx.create(db.collection(`hotels/${hotelUid}/orderAudit`).doc(), { orderId, action: "delete", actorUid: request.auth.uid, createdAt: stamp() });
    return { deleted: true };
  });
}

async function confirmOrderHandler(request, services = {}) {
  const db = services.firestore || admin.firestore();
  const input = request.data || {};
  const hotelUid = requireDocumentId(input.hotelUid, "hotelUid");
  const orderId = requireDocumentId(input.orderId, "orderId");
  const requestId = requireDocumentId(input.requestId, "requestId");
  const expected = revision(input.expectedRevision);
  const dispatchId = digest(hotelUid, orderId, request.auth?.uid, requestId);
  return db.runTransaction(async (tx) => {
    await requireHotelPermission(db, request, hotelUid, "orders", "approve", tx);
    const ref = db.doc(`hotels/${hotelUid}/orders/${orderId}`);
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "Order not found.");
    const order = snap.data();
    const approver = await tx.get(db.doc(`hotels/${hotelUid}/outlets/${requireDocumentId(order.outletId, "Order outlet")}/approvers/${request.auth.uid}`));
    if (!approver.exists) throw new HttpsError("permission-denied", "Only designated outlet approvers can confirm this order.");
    if (order.dispatchRequestId === dispatchId) return { dispatchId, status: order.dispatchStatus };
    editable(order);
    if ((order.revision || 0) !== expected) throw new HttpsError("aborted", "Order changed. Reload before confirming.");
    const [supplier, hotel] = await Promise.all([tx.get(db.doc(`hotels/${hotelUid}/suppliers/${requireDocumentId(order.supplierId, "Order supplier")}`)), tx.get(db.doc(`hotels/${hotelUid}`))]);
    if (!supplier.exists || !hotel.exists) throw new HttpsError("failed-precondition", "Hotel or supplier configuration is missing.");
    const { supplierPublicView } = require("./suppliers");
    const publicSupplier = supplierPublicView(supplier.id, supplier.data());
    publicSupplier.orderSystem ||= "Email";
    if (!["Email", "SFTP csv"].includes(publicSupplier.orderSystem)) throw new HttpsError("failed-precondition", "Review the supplier's delivery method.");
    if (publicSupplier.orderSystem === "Email") {
      try { require("./validation").email(publicSupplier.orderEmail); }
      catch { throw new HttpsError("failed-precondition", "Configure the supplier's order email first."); }
    }
    const { lines } = await canonicalLines(db, tx, hotelUid, (order.products || []).map((p) => ({ ...p, outletId: order.outletId })));
    const accountNumber = await canonicalAccount(db, tx, hotelUid, order.supplierId, order.outletId, supplier.data());
    if (accountNumber !== (order.accountNumber || "") || deliveryDate(order.deliveryDate, publicSupplier.deliveryDays) !== order.deliveryDate) {
      throw new HttpsError("failed-precondition", "Supplier account or delivery days changed. Edit and review this order before confirming.");
    }
    if (lines.some((p, i) => p.supplierId !== order.supplierId || p.pricePerPurchaseUnit !== order.products[i].pricePerPurchaseUnit || p.currency !== order.currency)) {
      throw new HttpsError("failed-precondition", "Catalog pricing or supplier details changed. Edit and review this order before confirming.");
    }
    const snapshot = { id: orderId, products: lines, deliveryDate: dateOnly(order.deliveryDate),
      supplierId: order.supplierId, supplierName: publicSupplier.name, outletId: order.outletId, outletName: order.outletName,
      accountNumber, currency: order.currency,
      hotelName: hotel.data().hotelName || hotel.data().name || hotelUid,
      dispatchRequestedByEmail: request.auth.token?.email || "", supplierOrderReference: orderId };
    tx.create(db.doc(`hotels/${hotelUid}/dispatches/${dispatchId}`), { orderId, status: "pending", actorUid: request.auth.uid,
      order: snapshot, supplier: publicSupplier, createdAt: stamp() });
    tx.update(ref, { dispatchRequestId: dispatchId, dispatchStatus: "pending", dispatchProgress: 5, dispatchStep: "Awaiting delivery worker",
      dispatchError: "", dispatchRequestedByEmail: snapshot.dispatchRequestedByEmail, revision: expected + 1, updatedAt: stamp(), updatedBy: request.auth.uid });
    tx.create(db.doc(`hotels/${hotelUid}/orderAudit/${dispatchId}`), { orderId, action: "approve", actorUid: request.auth.uid, revision: expected + 1, createdAt: stamp() });
    return { dispatchId, status: "pending" };
  });
}

async function setOutletApproversHandler(request, services = {}) {
  const db = services.firestore || admin.firestore();
  const hotelUid = requireDocumentId(request.data?.hotelUid, "hotelUid");
  const outletId = requireDocumentId(request.data?.outletId, "outletId");
  if (!Array.isArray(request.data?.userIds) || request.data.userIds.length > 20) throw new HttpsError("invalid-argument", "Choose at most twenty approvers.");
  const ids = [...new Set(request.data.userIds.map((id) => requireDocumentId(id, "Approver UID")))];
  await requireHotelPermission(db, request, hotelUid, "outlets", "approvers");
  // Auth supplies canonical addresses; browser-supplied recipient details are never trusted.
  const auth = services.auth || admin.auth();
  const users = await Promise.all(ids.map((uid) => auth.getUser(uid)));
  if (users.some((u) => u.disabled || !u.emailVerified || !u.email)) throw new HttpsError("failed-precondition", "Approvers must have an enabled account and verified email.");
  return db.runTransaction(async (tx) => {
    await requireHotelPermission(db, request, hotelUid, "outlets", "approvers", tx);
    const outlet = await tx.get(db.doc(`hotels/${hotelUid}/outlets/${outletId}`));
    if (!outlet.exists) throw new HttpsError("not-found", "Outlet not found.");
    const members = ids.length ? await tx.getAll(...ids.map((id) => db.doc(`hotels/${hotelUid}/members/${id}`))) : [];
    if (members.some((m) => !m.exists || !permissionAllows(normalizedPermissions(m.data().permissions), "orders", "approve"))) throw new HttpsError("failed-precondition", "Every approver must belong to this hotel and have orders.approve.");
    const existing = await tx.get(db.collection(`hotels/${hotelUid}/outlets/${outletId}/approvers`));
    existing.docs.filter((s) => !ids.includes(s.id)).forEach((s) => tx.delete(s.ref));
    users.forEach((u) => tx.set(db.doc(`hotels/${hotelUid}/outlets/${outletId}/approvers/${u.uid}`), { email: u.email, displayName: u.displayName || u.email, updatedAt: stamp(), updatedBy: request.auth.uid }));
    tx.create(db.collection(`hotels/${hotelUid}/orderAudit`).doc(), { outletId, action: "set-approvers", userIds: ids, actorUid: request.auth.uid, createdAt: stamp() });
    return { count: ids.length };
  });
}

async function saveSupplierOutletAccountHandler(request, services = {}) {
  const db = services.firestore || admin.firestore();
  const input = request.data || {};
  const hotelUid = requireDocumentId(input.hotelUid, "hotelUid");
  const supplierId = requireDocumentId(input.supplierId, "supplierId");
  const outletId = requireDocumentId(input.outletId, "outletId");
  const accountNumber = text(input.accountNumber, "Account number", 100, true);
  const ref = db.doc(`hotels/${hotelUid}/supplierOutletAccounts/${digest(supplierId, outletId)}`);
  return db.runTransaction(async (tx) => {
    await requireHotelPermission(db, request, hotelUid, "suppliers", "update", tx);
    const [supplier, outlet, existing] = await Promise.all([tx.get(db.doc(`hotels/${hotelUid}/suppliers/${supplierId}`)),
      tx.get(db.doc(`hotels/${hotelUid}/outlets/${outletId}`)), tx.get(db.collection(`hotels/${hotelUid}/supplierOutletAccounts`).where("supplierId", "==", supplierId).where("outletId", "==", outletId).limit(2))]);
    if (!supplier.exists || !outlet.exists) throw new HttpsError("not-found", "Choose a supplier and outlet belonging to this hotel.");
    if (existing.size > 1) throw new HttpsError("failed-precondition", "Duplicate account assignments need review.");
    const target = existing.docs[0]?.ref || ref;
    tx.set(target, { supplierId, outletId, supplierName: supplier.data().name || supplierId,
      outletName: outlet.data().name || outletId, accountNumber, updatedAt: stamp(), updatedBy: request.auth.uid }, { merge: true });
    return { id: target.id };
  });
}

const options = { region: "us-central1", cors: true };
module.exports = { dateOnly, deliveryDate, cartInput, canonicalLines, createOrdersFromCartHandler, updateOrderHandler, deleteOrderHandler, confirmOrderHandler, setOutletApproversHandler, saveSupplierOutletAccountHandler,
  createOrdersFromCart: onCall(options, gated(createOrdersFromCartHandler)), updateHotelOrder: onCall(options, gated(updateOrderHandler)),
  deleteHotelOrder: onCall(options, gated(deleteOrderHandler)), confirmHotelOrder: onCall(options, gated(confirmOrderHandler)), setHotelOutletApprovers: onCall(options, gated(setOutletApproversHandler)),
  saveSupplierOutletAccount: onCall(options, gated(saveSupplierOutletAccountHandler)) };
