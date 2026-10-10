const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { admin } = require("./config");
const { requirePlatformAdministrator, requireDocumentId, subscriptionIsActive } = require("./subscriptions");
const { requireVerifiedUser, text, revision, digest } = require("./validation");
const { permissionAllows, normalizedPermissions } = require("./authorization");
const { gated, enforceRequestRollout } = require("./saasRollout");
const { dispatchActorIsCurrent } = require("./deliveryState");

async function reviewOrderDeliveryHandler(request, services = {}) {
  requireVerifiedUser(request); await requirePlatformAdministrator(request, services.auth);
  const db = services.firestore || admin.firestore();
  const input = request.data || {};
  const hotelUid = requireDocumentId(input.hotelUid, "hotelUid");
  const orderId = requireDocumentId(input.orderId, "orderId");
  const expected = revision(input.expectedRevision);
  const operationId = digest(request.auth.uid, requireDocumentId(input.requestId, "requestId"));
  const evidence = text(input.evidence, "Provider receipt or configuration review", 1000, true);
  if (!["record-receipt", "retry-preparation"].includes(input.action)) throw new HttpsError("invalid-argument", "Choose a supported delivery recovery action.");
  return db.runTransaction(async (tx) => {
    await enforceRequestRollout(db, request, tx);
    const orderRef = db.doc(`hotels/${hotelUid}/orders/${orderId}`);
    const order = await tx.get(orderRef);
    if (!order.exists) throw new HttpsError("not-found", "Order not found.");
    if (order.data().recoveryOperationId === operationId) return { status: order.data().dispatchStatus };
    if ((order.data().revision || 0) !== expected) throw new HttpsError("aborted", "Order changed. Refresh before recording a recovery decision.");
    const dispatchId = requireDocumentId(order.data().dispatchRequestId, "Dispatch ID");
    const dispatchRef = db.doc(`hotels/${hotelUid}/dispatches/${dispatchId}`);
    const dispatch = await tx.get(dispatchRef);
    if (!dispatch.exists || dispatch.data().orderId !== orderId) throw new HttpsError("failed-precondition", "This legacy delivery needs a separate operator review.");
    const status = dispatch.data().status;
    const processingTime = dispatch.data().processingAt?.toMillis?.() || Date.now();
    if (!["failed", "blocked", "needs-review"].includes(status)
      && !(status === "processing" && processingTime < Date.now() - 600000)) {
      throw new HttpsError("failed-precondition", "Wait for the active worker before reviewing this delivery.");
    }
    const stamp = admin.firestore.FieldValue.serverTimestamp();
    let nextStatus;
    let nextDispatchId = dispatchId;
    if (input.action === "record-receipt") {
      // This records an operator-verified receipt; it never sends another order.
      nextStatus = "sent";
      tx.update(dispatchRef, { status: "sent", manuallyReconciled: true, evidence, reviewedBy: request.auth.uid, completedAt: stamp });
      tx.update(orderRef, { status: "Ordered", dispatchStatus: "sent", dispatchProgress: 100, dispatchStep: "Provider receipt verified by operator",
        dispatchError: "", dispatchedAt: stamp, dispatchedVia: dispatch.data().supplier.orderSystem === "SFTP csv" ? "sftp" : "email",
        recoveryOperationId: operationId, revision: expected + 1, updatedAt: stamp });
    } else {
      // Any possible external attempt permanently excludes this automatic recovery path.
      if (status !== "failed" || dispatch.data().externalAttempt !== false) throw new HttpsError("failed-precondition", "An unconfirmed delivery cannot be resent. Verify the provider receipt first.");
      const [subscription, member, approver] = await Promise.all([
        tx.get(db.doc(`hotelSubscriptions/${hotelUid}`)), tx.get(db.doc(`hotels/${hotelUid}/members/${dispatch.data().actorUid}`)),
        tx.get(db.doc(`hotels/${hotelUid}/outlets/${dispatch.data().order.outletId}/approvers/${dispatch.data().actorUid}`)),
      ]);
      if (!await dispatchActorIsCurrent(dispatch.data().actorUid, services.auth)
        || !subscription.exists || !subscriptionIsActive(subscription.data()) || !member.exists || !approver.exists
        || !permissionAllows(normalizedPermissions(member.data().permissions), "orders", "approve")) throw new HttpsError("failed-precondition", "Restore the subscription and designated approver access before recovery.");
      nextDispatchId = digest(dispatchId, operationId);
      nextStatus = "pending";
      tx.update(dispatchRef, { status: "superseded", replacementDispatchId: nextDispatchId, reviewedBy: request.auth.uid, evidence });
      tx.create(db.doc(`hotels/${hotelUid}/dispatches/${nextDispatchId}`), { orderId, status: "pending", actorUid: dispatch.data().actorUid,
        order: dispatch.data().order, supplier: dispatch.data().supplier, createdAt: stamp, recoveryOf: dispatchId });
      tx.update(orderRef, { dispatchRequestId: nextDispatchId, dispatchStatus: "pending", dispatchProgress: 5, dispatchStep: "Preparation retry approved by operator",
        dispatchError: "", recoveryOperationId: operationId, revision: expected + 1, updatedAt: stamp });
    }
    tx.create(db.doc(`hotels/${hotelUid}/orderAudit/${operationId}`), { orderId, action: input.action, evidence, actorUid: request.auth.uid,
      dispatchId, replacementDispatchId: nextDispatchId, createdAt: stamp, revision: expected + 1 });
    return { status: nextStatus };
  });
}

module.exports = { reviewOrderDeliveryHandler, reviewHotelOrderDelivery: onCall({ region: "us-central1", cors: true }, gated(reviewOrderDeliveryHandler)) };
