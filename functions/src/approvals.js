const { onDocumentCreated, admin, logger, getAppBaseUrl } = require("./config");
const { hotelHasActiveSubscription } = require("./subscriptions");
const { permissionAllows, normalizedPermissions } = require("./authorization");
const { digest } = require("./validation");

async function orderApprovalNotificationHandler(event, services = {}) {
  if (!event.data?.exists) return;
  const { hotelUid, orderId } = event.params;
  const db = services.firestore || admin.firestore();
  if (!await hotelHasActiveSubscription(db, hotelUid, "procurement")) return;
  const order = event.data.data();
  if (!order.outletId) return;
  const approvers = await db.collection(`hotels/${hotelUid}/outlets/${order.outletId}/approvers`).limit(20).get();
  if (approvers.empty) return;
  const members = await db.getAll(...approvers.docs.map((a) => db.doc(`hotels/${hotelUid}/members/${a.id}`)));
  const auth = services.auth || admin.auth();
  const users = await Promise.all(members.filter((m) => m.exists && permissionAllows(normalizedPermissions(m.data().permissions), "orders", "approve"))
    .map((m) => auth.getUser(m.id).catch((error) => {
      if (error.code === "auth/user-not-found") return null;
      throw error;
    })));
  const to = [...new Set(users.filter((u) => u && u.emailVerified && !u.disabled && u.email).map((u) => u.email))];
  if (!to.length) return;
  const ref = db.doc(`hotels/${hotelUid}/mailQueue/approval-${digest(orderId)}`);
  const baseUrl = services.appBaseUrl || getAppBaseUrl();
  await db.runTransaction(async (tx) => {
    const current = await tx.get(ref);
    if (current.exists) return;
    tx.create(ref, { type: "order-approval", hotelUid, orderId, recipientUids: users.filter((u) => u && u.emailVerified && !u.disabled && u.email).map((u) => u.uid), status: "queued", queuedAt: admin.firestore.FieldValue.serverTimestamp(),
      payload: { to, subject: `Order approval required: ${orderId}`,
        text: `An order is waiting for your confirmation.\n\nOutlet: ${order.outletName || order.outletId}\nSupplier: ${order.supplierName || order.supplierId}\nDelivery date: ${order.deliveryDate}\n\nSelect this hotel before opening the order: ${baseUrl}/orders/${encodeURIComponent(orderId)}` } });
  });
  logger.info("Order approval notification queued", { hotelUid, orderId, recipients: to.length });
}

const sendOrderApprovalEmailToApprovers = onDocumentCreated("hotels/{hotelUid}/orders/{orderId}", orderApprovalNotificationHandler);
module.exports = { sendOrderApprovalEmailToApprovers, orderApprovalNotificationHandler };
