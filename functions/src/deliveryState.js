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
      tx.update(dispatchRef, { status: "blocked", externalAttempt: false, error: "Current account, subscription or approver access is no longer valid." });
      tx.update(orderRef, { dispatchStatus: "blocked", dispatchProgress: 100, dispatchStep: "Operator review required", dispatchError: "Current account, subscription or approver access is no longer valid." });
      return null;
    }
    tx.update(dispatchRef, { status: "processing", externalAttempt: false, processingAt: admin.firestore.FieldValue.serverTimestamp() });
    tx.update(orderRef, { dispatchStatus: "processing", dispatchProgress: 20, dispatchStep: "Preparing delivery" });
    return data;
  });
}

// Persist the possibility of an external side effect before contacting a transport.
// Recovery can retire a stale worker; that worker must win this fence before sending.
async function markDispatchExternalAttempt(db, hotelUid, orderId, dispatchId, mailId = null) {
  return db.runTransaction(async (tx) => {
    const orderRef = db.doc(`hotels/${hotelUid}/orders/${orderId}`), dispatchRef = db.doc(`hotels/${hotelUid}/dispatches/${dispatchId}`);
    const [order, dispatch, mail] = await Promise.all([tx.get(orderRef), tx.get(dispatchRef),
      mailId ? tx.get(db.doc(`hotels/${hotelUid}/mailQueue/${mailId}`)) : Promise.resolve(null)]);
    if (!order.exists || order.data().status !== "Created" || order.data().dispatchRequestId !== dispatchId
      || dispatch.data()?.status !== "processing" || dispatch.data().orderId !== orderId || dispatch.data().externalAttempt === true
      || mailId && mail.data()?.status !== "processing") return false;
    const stamp = admin.firestore.FieldValue.serverTimestamp();
    tx.update(dispatchRef, { externalAttempt: true, externalAttemptAt: stamp });
    if (mailId) tx.update(mail.ref, { externalAttempt: true, externalAttemptAt: stamp });
    return true;
  });
}

async function completeDispatch(db, hotelUid, orderId, dispatchId, status, detail = {}) {
  return db.runTransaction(async (tx) => {
    const orderRef = db.doc(`hotels/${hotelUid}/orders/${orderId}`);
    const dispatchRef = db.doc(`hotels/${hotelUid}/dispatches/${dispatchId}`);
    const [order, dispatch] = await Promise.all([tx.get(orderRef), tx.get(dispatchRef)]);
    if (!order.exists || !dispatch.exists || order.data().dispatchRequestId !== dispatchId
      || !["processing", "queued"].includes(dispatch.data().status)) return false;
    // A preparation catch may run after an outbox commit or a possible send.
    // It must never turn that uncertainty into permission to send again.
    if (status === "failed" && dispatch.data().status === "queued") return false;
    if (status === "failed" && dispatch.data().externalAttempt === true) {
      status = "needs-review";
      detail = { ...detail, externalAttempt: true, error: "The transport may have received this order. Check the transport receipt before recovery." };
    }
    const simulated = status === "simulated";
    const sent = status === "sent" || simulated;
    const stamp = admin.firestore.FieldValue.serverTimestamp();
    tx.update(dispatchRef, { status, completedAt: stamp, ...detail });
    tx.update(orderRef, { ...(sent ? { status: "Ordered", dispatchedAt: stamp, dispatchedVia: simulated ? "simulation" : detail.via || "email" } : {}),
      ...(simulated ? { dispatchMode: "simulation", dispatchEnvironment: "staging" } : {}),
      dispatchStatus: simulated ? "sent" : status, dispatchProgress: 100, dispatchStep: simulated ? "Staging simulation: no supplier contacted" : sent ? "Transport accepted; supplier acceptance tracked separately" : "Delivery review required",
      dispatchError: sent ? "" : (detail.error || "Delivery could not be confirmed. Do not resend before checking the provider."), updatedAt: stamp });
    return true;
  });
}

module.exports = { claimDispatch, completeDispatch, dispatchActorIsCurrent, markDispatchExternalAttempt };
