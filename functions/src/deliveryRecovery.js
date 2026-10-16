const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { admin } = require("./config");
const { requirePlatformAdministrator, requireDocumentId, subscriptionIsActive } = require("./subscriptions");
const { requireVerifiedUser, text, revision, digest } = require("./validation");
const { requireHotelPermission, permissionAllows, normalizedPermissions } = require("./authorization");
const { moduleAllows } = require("./modulePolicy");
const { gated, enforceRequestRollout } = require("./saasRollout");
const { dispatchActorIsCurrent } = require("./deliveryState");
const RECOVERY_ACTIONS = ["record-receipt", "record-review", "retry-preparation"];
const SOURCES = ["email-provider", "sftp-transfer", "supplier-contact", "configuration-review"];
const millis = (value) => value?.toMillis?.() ?? (Number.isFinite(value) ? value : null);

async function requireDeliveryPermission(db, request, hotelUid, action, tx, services) {
  if (request.auth?.token?.platformAdmin === true) {
    await requirePlatformAdministrator(request, services.auth);
    await enforceRequestRollout(db, request, tx);
  } else await requireHotelPermission(db, { ...request }, hotelUid, "orders", action, tx, services.auth);
}
function deliveryReviewState(order, dispatch, now = Date.now()) {
  if (!dispatch || order.dispatchMode === "simulation") return { outcome: order.dispatchMode === "simulation" ? "simulated" : "legacy-review", canRecordReceipt: false, canRetryPreparation: false, canRecordReview: false };
  const status = dispatch.status;
  const stale = ["processing", "queued", "pending"].includes(status)
    && millis(dispatch.processingAt || dispatch.createdAt) !== null && millis(dispatch.processingAt || dispatch.createdAt) < now - 600000;
  const reviewable = ["failed", "blocked", "needs-review"].includes(status) || stale;
  const safeFailure = ["failed", "blocked"].includes(status) && dispatch.externalAttempt === false;
  const outcome = status === "sent" ? dispatch.receiptSource === "supplier-contact" ? "receipt-verified" : "transport-accepted" : safeFailure ? "preparation-failed" : reviewable ? "unknown" : "in-progress";
  return { outcome, canRecordReceipt: reviewable && !safeFailure, canRetryPreparation: safeFailure, canRecordReview: reviewable };
}
async function getHotelOrderDeliveryHandler(request, services = {}) {
  const db = services.firestore || admin.firestore(), input = request.data || {};
  const hotelUid = requireDocumentId(input.hotelUid, "hotelUid"), orderId = requireDocumentId(input.orderId, "orderId");
  const afterEventId = input.afterEventId == null ? null : requireDocumentId(input.afterEventId, "afterEventId");
  return db.runTransaction(async (tx) => {
    await requireDeliveryPermission(db, request, hotelUid, "read", tx, services);
    const order = await tx.get(db.doc(`hotels/${hotelUid}/orders/${orderId}`));
    if (!order.exists) throw new HttpsError("not-found", "Order not found.");
    const value = order.data();
    const dispatch = value.dispatchRequestId ? await tx.get(db.doc(`hotels/${hotelUid}/dispatches/${requireDocumentId(value.dispatchRequestId, "Dispatch ID")}`)) : null;
    const data = dispatch?.exists && dispatch.data().orderId === orderId ? dispatch.data() : null;
    let history = db.collection(`hotels/${hotelUid}/orderAudit`).where("orderId", "==", orderId).orderBy("revision", "desc");
    if (afterEventId) {
      const cursor = await tx.get(db.doc(`hotels/${hotelUid}/orderAudit/${afterEventId}`));
      if (!cursor.exists || cursor.data().orderId !== orderId) throw new HttpsError("invalid-argument", "This history cursor does not belong to this order.");
      history = history.startAfter(cursor);
    }
    const events = await tx.get(history.limit(51));
    return { hotelUid, orderId, policyVersion: 1, orderRevision: value.revision || 0,
      dispatchId: data ? dispatch.id : null, status: data?.status || value.dispatchStatus || "none",
      ...(value.dispatchEnvironment === "staging" ? { environment: "staging", simulated: true } : {}),
      ...deliveryReviewState(value, data, services.now?.() ?? Date.now()),
      method: data?.supplier?.orderSystem === "SFTP csv" ? "sftp" : "email",
      externalAttempt: typeof data?.externalAttempt === "boolean" ? data.externalAttempt : null,
      providerId: data?.providerId || null, remotePath: data?.remotePath || null, error: data?.error || value.dispatchError || "",
      events: events.docs.slice(0, 50).filter((event) => RECOVERY_ACTIONS.includes(event.data().action)).map((event) => {
        const entry = event.data();
        return { id: event.id, action: entry.action, evidence: entry.evidence || "", source: entry.source || "legacy-review", reason: entry.reason || "Not recorded in this legacy review",
          actorUid: entry.actorUid, createdAtMillis: millis(entry.createdAt) ?? entry.createdAtMillis ?? null, revision: entry.revision,
          dispatchId: entry.dispatchId, replacementDispatchId: entry.replacementDispatchId || null, outcome: entry.outcome || null };
      }), nextCursor: events.docs.length > 50 ? events.docs[49].id : null };
  });
}

async function reviewOrderDeliveryHandler(request, services = {}) {
  requireVerifiedUser(request);
  const db = services.firestore || admin.firestore(), input = request.data || {};
  const hotelUid = requireDocumentId(input.hotelUid, "hotelUid"), orderId = requireDocumentId(input.orderId, "orderId");
  const expected = revision(input.expectedRevision), requestId = requireDocumentId(input.requestId, "requestId");
  const evidence = text(input.evidence, "Evidence reference or findings", 1000, true), reason = text(input.reason, "Recovery reason", 500, true);
  if (!RECOVERY_ACTIONS.includes(input.action) || !SOURCES.includes(input.source)) throw new HttpsError("invalid-argument", "Choose a supported recovery action and evidence source.");
  const operationId = digest("delivery-recovery", hotelUid, orderId, request.auth.uid, requestId);
  const fingerprint = digest(orderId, expected, input.action, input.source, evidence, reason);
  try {
    return await db.runTransaction(async (tx) => {
      await requireDeliveryPermission(db, request, hotelUid, "recover", tx, services);
      const orderRef = db.doc(`hotels/${hotelUid}/orders/${orderId}`), auditRef = db.doc(`hotels/${hotelUid}/orderAudit/${operationId}`);
      const [order, operation] = await Promise.all([tx.get(orderRef), tx.get(auditRef)]);
      if (operation.exists) {
        if (operation.data().fingerprint !== fingerprint) throw new HttpsError("already-exists", "This recovery request was already used with different details.");
        return operation.data().result;
      }
      if (!order.exists) throw new HttpsError("not-found", "Order not found.");
      if ((order.data().revision || 0) !== expected) throw new HttpsError("aborted", "Order changed. Refresh before recording a recovery decision.");
      if (order.data().status !== "Created") throw new HttpsError("failed-precondition", "Only an unresolved dispatch can be recovered. Refresh the order.");
      const dispatchId = requireDocumentId(order.data().dispatchRequestId, "Dispatch ID");
      const dispatchRef = db.doc(`hotels/${hotelUid}/dispatches/${dispatchId}`), dispatch = await tx.get(dispatchRef);
      if (!dispatch.exists || dispatch.data().orderId !== orderId) throw new HttpsError("failed-precondition", "This legacy delivery needs a platform operator review.");
      const data = dispatch.data(), review = deliveryReviewState(order.data(), data, services.now?.() ?? Date.now());
      const eligible = { "record-receipt": review.canRecordReceipt, "record-review": review.canRecordReview, "retry-preparation": review.canRetryPreparation };
      if (!eligible[input.action]) throw new HttpsError("failed-precondition", "This action is not safe for the current delivery state. Refresh and review the delivery evidence.");
      const mailRef = db.doc(`hotels/${hotelUid}/mailQueue/order-${digest(orderId, dispatchId)}`), mail = await tx.get(mailRef);
      const stamp = admin.firestore.FieldValue.serverTimestamp();
      let nextStatus = data.status, nextDispatchId = dispatchId;
      if (input.action === "retry-preparation") {
        if (input.source !== "configuration-review") throw new HttpsError("invalid-argument", "A preparation retry requires a configuration review.");
        if (mail.exists && (mail.data().externalAttempt !== false || !["failed", "blocked"].includes(mail.data().status))) {
          throw new HttpsError("failed-precondition", "The mail worker may have attempted delivery. Verify the transport receipt; do not resend.");
        }
        const actorUid = request.auth.token?.platformAdmin === true ? data.actorUid : request.auth.uid;
        const [subscription, member, approver] = await Promise.all([
          tx.get(db.doc(`hotelSubscriptions/${hotelUid}`)), tx.get(db.doc(`hotels/${hotelUid}/members/${actorUid}`)),
          tx.get(db.doc(`hotels/${hotelUid}/outlets/${requireDocumentId(data.order.outletId, "Order outlet")}/approvers/${actorUid}`)),
        ]);
        if (!await dispatchActorIsCurrent(actorUid, services.auth) || !subscription.exists || !subscriptionIsActive(subscription.data())
          || !moduleAllows(subscription.data(), "procurement") || !member.exists || !approver.exists
          || !permissionAllows(normalizedPermissions(member.data().permissions), "orders", "approve")) {
          throw new HttpsError("permission-denied", "Preparation recovery also requires current orders.approve permission and designation as this outlet's approver.");
        }
        nextDispatchId = digest(dispatchId, operationId); nextStatus = "pending";
        tx.update(dispatchRef, { status: "superseded", replacementDispatchId: nextDispatchId, reviewedBy: request.auth.uid, evidence, source: input.source, reason });
        if (mail.exists) tx.update(mailRef, { status: "superseded", reviewedBy: request.auth.uid });
        tx.create(db.doc(`hotels/${hotelUid}/dispatches/${nextDispatchId}`), { orderId, status: "pending", externalAttempt: false, actorUid,
          order: data.order, supplier: data.supplier, createdAt: stamp, recoveryOf: dispatchId });
        tx.update(orderRef, { dispatchRequestId: nextDispatchId, dispatchStatus: "pending", dispatchProgress: 5, dispatchStep: "Preparation retry approved",
          dispatchError: "", recoveryOperationId: operationId, revision: expected + 1, updatedAt: stamp });
      } else {
        const receipt = input.action === "record-receipt";
        if (receipt && !["supplier-contact", data.supplier.orderSystem === "SFTP csv" ? "sftp-transfer" : "email-provider"].includes(input.source)) throw new HttpsError("invalid-argument", "Use the matching transport receipt or a verified supplier receipt. Supplier acceptance is recorded separately.");
        // Freeze uncertain workers before recording evidence; this action never resends.
        nextStatus = receipt ? "sent" : review.outcome === "preparation-failed" ? data.status : "needs-review";
        tx.update(dispatchRef, { status: nextStatus, manuallyReconciled: receipt, evidence, source: input.source, reason,
          reviewedBy: request.auth.uid, reviewedAt: stamp, ...(receipt ? { completedAt: stamp, receiptSource: input.source } : {}) });
        if (mail.exists) tx.update(mailRef, { status: nextStatus, manuallyReconciled: receipt, reviewedBy: request.auth.uid, reviewedAt: stamp });
        tx.update(orderRef, { ...(receipt ? { status: "Ordered", dispatchedAt: stamp, dispatchedVia: data.supplier.orderSystem === "SFTP csv" ? "sftp" : "email" } : {}),
          dispatchStatus: nextStatus, dispatchProgress: 100, dispatchStep: receipt ? input.source === "supplier-contact" ? "Supplier receipt verified; acceptance tracked separately" : "Transport receipt verified; supplier acceptance tracked separately" : review.outcome === "preparation-failed" ? "Preparation review recorded; no send attempted" : "Delivery evidence recorded; outcome remains unknown",
          ...(receipt ? { dispatchError: "" } : {}), recoveryOperationId: operationId, revision: expected + 1, updatedAt: stamp });
      }
      const result = { hotelUid, orderId, status: nextStatus, dispatchId: nextDispatchId, revision: expected + 1 };
      tx.create(auditRef, { orderId, action: input.action, evidence, source: input.source, reason, actorUid: request.auth.uid, fingerprint,
        dispatchId, replacementDispatchId: nextDispatchId, previousStatus: data.status, outcome: nextStatus, createdAt: stamp,
        createdAtMillis: services.now?.() ?? Date.now(), revision: expected + 1, result });
      return result;
    });
  } catch (error) {
    if (error instanceof HttpsError && ["aborted", "failed-precondition", "invalid-argument"].includes(error.code)) {
      // A response loss can follow a successful commit. Release the browser's
      // saved command only after a fresh authorized read proves no receipt exists.
      try {
        const absent = await db.runTransaction(async (tx) => {
          await requireDeliveryPermission(db, { ...request }, hotelUid, "recover", tx, services);
          return !(await tx.get(db.doc(`hotels/${hotelUid}/orderAudit/${operationId}`))).exists;
        });
        if (absent) error.details = { ...(error.details || {}), deliveryRequestUncommitted: true };
      } catch { /* Preserve the command until its result can be verified. */ }
    }
    throw error;
  }
}

module.exports = { deliveryReviewState, reviewOrderDeliveryHandler, getHotelOrderDeliveryHandler,
  getHotelOrderDelivery: onCall({ region: "us-central1", cors: true }, gated(getHotelOrderDeliveryHandler)),
  reviewHotelOrderDelivery: onCall({ region: "us-central1", cors: true }, gated(reviewOrderDeliveryHandler)) };
