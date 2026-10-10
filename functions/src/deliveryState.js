const { moduleAllows } = require("./modulePolicy");
const { admin } = require("./config");
const { subscriptionIsActive } = require("./subscriptions");
const { permissionAllows, normalizedPermissions } = require("./authorization");

async function dispatchActorIsCurrent(actorUid, auth = admin.auth()) {
  if (typeof actorUid !== "string" || !actorUid) return false;
  try {
    const user = await auth.getUser(actorUid);
    return user.disabled !== true && user.emailVerified === true;
  } catch { return false; }
}

async function claimDispatch(db, hotelUid, orderId, dispatchId, auth) {
  const dispatchRef = db.doc(`hotels/${hotelUid}/dispatches/${dispatchId}`);
  const orderRef = db.doc(`hotels/${hotelUid}/orders/${orderId}`);
  return db.runTransaction(async (tx) => {
    const [dispatch, order, subscription] = await Promise.all([
      tx.get(dispatchRef), tx.get(orderRef), tx.get(db.doc(`hotelSubscriptions/${hotelUid}`)),
    ]);
    if (!dispatch.exists || dispatch.data().orderId !== orderId || dispatch.data().status !== "pending"
      || !order.exists || order.data().status !== "Created" || order.data().dispatchRequestId !== dispatchId
      || order.data().dispatchStatus !== "pending") return null;
    const data = dispatch.data();
    const [member, approver] = await Promise.all([
      tx.get(db.doc(`hotels/${hotelUid}/members/${data.actorUid}`)),
      tx.get(db.doc(`hotels/${hotelUid}/outlets/${data.order.outletId}/approvers/${data.actorUid}`)),
    ]);
    if (!await dispatchActorIsCurrent(data.actorUid, auth)
      || !subscription.exists || !subscriptionIsActive(subscription.data()) || !moduleAllows(subscription.data(), "procurement") || !member.exists || !approver.exists
      || !permissionAllows(normalizedPermissions(member.data().permissions), "orders", "approve")) {
      tx.update(dispatchRef, { status: "blocked", error: "Current account, subscription or approver access is no longer valid." });
      tx.update(orderRef, { dispatchStatus: "blocked", dispatchProgress: 100, dispatchStep: "Operator review required", dispatchError: "Current account, subscription or approver access is no longer valid." });
      return null;
    }
    tx.update(dispatchRef, { status: "processing", processingAt: admin.firestore.FieldValue.serverTimestamp() });
    tx.update(orderRef, { dispatchStatus: "processing", dispatchProgress: 20, dispatchStep: "Preparing delivery" });
    return data;
  });
}

async function completeDispatch(db, hotelUid, orderId, dispatchId, status, detail = {}) {
  return db.runTransaction(async (tx) => {
    const orderRef = db.doc(`hotels/${hotelUid}/orders/${orderId}`);
    const dispatchRef = db.doc(`hotels/${hotelUid}/dispatches/${dispatchId}`);
    const [order, dispatch] = await Promise.all([tx.get(orderRef), tx.get(dispatchRef)]);
    if (!order.exists || !dispatch.exists || order.data().dispatchRequestId !== dispatchId
      || !["processing", "queued"].includes(dispatch.data().status)) return false;
    const sent = status === "sent";
    const stamp = admin.firestore.FieldValue.serverTimestamp();
    tx.update(dispatchRef, { status, completedAt: stamp, ...detail });
    tx.update(orderRef, { ...(sent ? { status: "Ordered", dispatchedAt: stamp, dispatchedVia: detail.via || "email" } : {}),
      dispatchStatus: status, dispatchProgress: 100, dispatchStep: sent ? "Delivery accepted" : "Operator review required",
      dispatchError: sent ? "" : (detail.error || "Delivery could not be confirmed. Do not resend before checking the provider."), updatedAt: stamp });
    return true;
  });
}

module.exports = { claimDispatch, completeDispatch, dispatchActorIsCurrent };
