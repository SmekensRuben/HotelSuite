const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { admin } = require("./config");
const { requireHotelPermission } = require("./authorization");
const { requireDocumentId } = require("./subscriptions");
const { revision, digest } = require("./validation");
const { gated, requireSaasRollout, SAAS_RULES_VERSION } = require("./saasRollout");
const { validTimeZone } = require("./hotelSetupPolicy");
const { localDate } = require("./importMonitoringPolicy");
const policy = require("./supplierConfirmationPolicy");
const stamp = () => admin.firestore.FieldValue.serverTimestamp();
function orderRevision(order) {
  const value = order.revision ?? 0;
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) throw new HttpsError("failed-precondition", "The order revision needs review.");
  return value;
}
const emptyState = () => ({ response: null, responseId: null, review: null, reviewId: null, eventCount: 0, reviewState: null });
async function loadConfirmationState(db, tx, ref, order, hotelUid, orderId) {
  const summary = order.supplierConfirmation;
  if (summary === undefined) {
    if (!(await tx.get(ref.collection("supplierConfirmations").limit(1))).empty) throw new HttpsError("failed-precondition", "Supplier confirmation history exists without its summary. Reconcile the order.");
    return emptyState();
  }
  if (!summary || summary.policyVersion !== policy.POLICY_VERSION || !Number.isSafeInteger(summary.eventCount)
    || summary.eventCount < 1 || summary.eventCount > policy.EVENT_LIMIT) throw new HttpsError("failed-precondition", "Supplier confirmation summary needs reconciliation.");
  const responseId = requireDocumentId(summary.responseId, "Stored supplier response ID");
  const responseEvent = (await tx.get(ref.collection("supplierConfirmations").doc(responseId))).data();
  const response = policy.verifiedResponse(responseEvent, order, hotelUid, orderId);
  const reviewId = summary.reviewId === null ? null : requireDocumentId(summary.reviewId, "Stored supplier review ID");
  const reviewEvent = reviewId ? (await tx.get(ref.collection("supplierConfirmations").doc(reviewId))).data() : null;
  const review = reviewEvent ? policy.verifiedReview(reviewEvent, response, responseId, hotelUid, orderId) : null;
  if (reviewId && !review || responseEvent.revision > orderRevision(order)
    || reviewEvent && (reviewEvent.revision <= responseEvent.revision || reviewEvent.revision > orderRevision(order))) {
    throw new HttpsError("failed-precondition", "Supplier response and review revisions need reconciliation.");
  }
  const reviewState = response.responseType === "accepted" ? "not-required" : review?.decision === "accept" ? "accepted" : review?.decision === "follow-up" ? "follow-up" : "pending";
  if (summary.responseType !== response.responseType || summary.reviewState !== reviewState || summary.respondedOn !== response.respondedOn
    || summary.requiresAttention !== (response.responseType !== "accepted" && reviewState !== "accepted")) throw new HttpsError("failed-precondition", "Supplier confirmation summary disagrees with its immutable response.");
  const latest = await tx.get(ref.collection("supplierConfirmations").orderBy("revision", "desc").limit(1));
  if (latest.docs[0]?.id !== (reviewId || responseId)) throw new HttpsError("failed-precondition", "Supplier confirmation summary is not the latest event. Reconcile this order.");
  if (policy.stableDigest(latest.docs[0].data().result?.supplierConfirmation) !== policy.stableDigest(summary)) throw new HttpsError("failed-precondition", "Supplier confirmation summary and event acknowledgement disagree.");
  return { response, responseId, review, reviewId, eventCount: summary.eventCount, reviewState };
}
function summary(state) {
  return { policyVersion: policy.POLICY_VERSION, responseId: state.responseId, reviewId: state.reviewId,
    responseType: state.response.responseType, respondedOn: state.response.respondedOn, eventCount: state.eventCount,
    reviewState: state.reviewState, requiresAttention: state.response.responseType !== "accepted" && state.reviewState !== "accepted" };
}
async function changeConfirmation(request, services, kind) {
  const db = services.firestore || admin.firestore(), input = request.data || {};
  const allowed = ["hotelUid", "orderId", "requestId", "expectedRevision", "expectedActorUid", kind === "response" ? "response" : "review"];
  if (Object.keys(input).some((key) => !allowed.includes(key))) throw new HttpsError("invalid-argument", "Unsupported supplier confirmation command field.");
  const hotelUid = requireDocumentId(input.hotelUid, "hotelUid"), orderId = requireDocumentId(input.orderId, "orderId");
  const requestId = requireDocumentId(input.requestId, "requestId"), expected = revision(input.expectedRevision);
  const expectedActorUid = requireDocumentId(input.expectedActorUid, "expectedActorUid");
  if (request.auth?.uid !== expectedActorUid) throw new HttpsError("permission-denied", "Sign in as the user who prepared this confirmation command.");
  const ref = db.doc(`hotels/${hotelUid}/orders/${orderId}`);
  const eventId = `sc-${digest(orderId, expectedActorUid, requestId).slice(0, 48)}`;
  const eventRef = ref.collection("supplierConfirmations").doc(eventId);
  const fingerprint = policy.stableDigest(kind, expected, input[kind === "response" ? "response" : "review"]);
  return db.runTransaction(async (tx) => {
    const actor = { ...request };
    await requireHotelPermission(db, actor, hotelUid, "orders", "read", tx, services.auth);
    await requireHotelPermission(db, actor, hotelUid, "orders", kind === "response" ? "recordconfirmation" : "reviewconfirmation", tx, services.auth);
    await requireSaasRollout(db, tx);
    const [orderDoc, previousEvent, member, hotel] = await tx.getAll(ref, eventRef, db.doc(`hotels/${hotelUid}/members/${expectedActorUid}`), db.doc(`hotels/${hotelUid}`));
    if (previousEvent.exists) {
      if (previousEvent.data().fingerprint !== fingerprint || previousEvent.data().kind !== kind) throw new HttpsError("already-exists", "This saved confirmation request was used with different details.");
      return previousEvent.data().result;
    }
    try {
      if (!orderDoc.exists) throw new HttpsError("not-found", "Order not found.");
      const order = orderDoc.data();
      if (order.status === "Finalized") throw new HttpsError("failed-precondition", "Finalized orders keep immutable supplier and receiving history.");
      policy.submittedContract(order);
      if (orderRevision(order) !== expected) throw new HttpsError("aborted", "This order changed. Refresh the supplier response before continuing.");
      const previous = await loadConfirmationState(db, tx, ref, order, hotelUid, orderId);
      if (previous.eventCount >= policy.EVENT_LIMIT) throw new HttpsError("resource-exhausted", "This order reached the supplier confirmation history limit.");
      let response, review, duplicateRef;
      if (kind === "response") {
        response = policy.normalizeResponse(input.response, order);
        if (!validTimeZone(hotel.data()?.timeZone)) throw new HttpsError("failed-precondition", "Set the hotel's time zone before dating supplier responses.");
        if (response.respondedOn > localDate(services.now?.() ?? Date.now(), hotel.data().timeZone)) throw new HttpsError("invalid-argument", "The supplier response date cannot be in the future.");
        if (previous.response && response.respondedOn < previous.response.respondedOn) throw new HttpsError("aborted", "An older supplier response cannot replace the latest decision. Review it separately with the supplier.");
        duplicateRef = ref.collection("supplierConfirmationReferences").doc(policy.stableDigest(response));
        if ((await tx.get(duplicateRef)).exists) throw new HttpsError("already-exists", "This exact supplier response is already recorded. Use its history or record the supplier's corrected response.");
      } else {
        if (!previous.response || input.review?.responseId !== previous.responseId) throw new HttpsError("aborted", "Review only the latest supplier response. Refresh this order.");
        response = previous.response;
        review = policy.normalizeReview(input.review, response);
        if (previous.review && policy.stableDigest(previous.review) === policy.stableDigest(review)) throw new HttpsError("already-exists", "This review decision is already recorded.");
      }
      const next = { response, responseId: kind === "response" ? eventId : previous.responseId, review: review || null,
        reviewId: kind === "review" ? eventId : null, eventCount: previous.eventCount + 1,
        reviewState: response.responseType === "accepted" ? "not-required" : review?.decision === "accept" ? "accepted" : review?.decision === "follow-up" ? "follow-up" : "pending" };
      const aggregate = summary(next);
      const result = { hotelUid, orderId, requestId, actorUid: expectedActorUid, eventId, revision: expected + 1, supplierConfirmation: aggregate };
      const actorName = [member.data()?.firstName, member.data()?.lastName].filter((part) => typeof part === "string" && part.trim()).join(" ").slice(0, 161) || null;
      tx.create(eventRef, { policyVersion: policy.POLICY_VERSION, hotelUid, orderId, kind, revision: expected + 1, fingerprint,
        actorUid: expectedActorUid, actorName, ...(kind === "response" ? { response } : { review }), result, createdAt: stamp() });
      if (duplicateRef) tx.create(duplicateRef, { eventId, createdAt: stamp() });
      tx.update(ref, { supplierConfirmation: aggregate, revision: expected + 1, updatedAt: stamp(), updatedBy: expectedActorUid });
      tx.create(db.doc(`hotels/${hotelUid}/orderAudit/${eventId}`), { orderId, action: `supplier-${kind}`, eventId, actorUid: expectedActorUid, revision: expected + 1, createdAt: stamp() });
      return result;
    } catch (error) {
      if (error instanceof HttpsError) throw new HttpsError(error.code, error.message, { confirmationRequestUncommitted: true });
      throw error;
    }
  });
}
const recordHotelSupplierConfirmationHandler = (request, services = {}) => changeConfirmation(request, services, "response");
const reviewHotelSupplierConfirmationHandler = (request, services = {}) => changeConfirmation(request, services, "review");
async function getHotelSupplierConfirmationsHandler(request, services = {}) {
  const db = services.firestore || admin.firestore(), input = request.data || {};
  if (Object.keys(input).some((key) => !["hotelUid", "orderId", "afterEventId"].includes(key))) throw new HttpsError("invalid-argument", "Unsupported supplier confirmation query field.");
  const hotelUid = requireDocumentId(input.hotelUid, "hotelUid"), orderId = requireDocumentId(input.orderId, "orderId");
  const cursor = input.afterEventId == null ? null : requireDocumentId(input.afterEventId, "afterEventId");
  const ref = db.doc(`hotels/${hotelUid}/orders/${orderId}`);
  return db.runTransaction(async (tx) => {
    await requireHotelPermission(db, { ...request }, hotelUid, "orders", "read", tx, services.auth);
    const [orderDoc, hotel, release] = await tx.getAll(ref, db.doc(`hotels/${hotelUid}`), db.doc("platformConfiguration/saasProcurement"));
    if (!orderDoc.exists) throw new HttpsError("not-found", "Order not found.");
    const order = orderDoc.data(), currentRevision = orderRevision(order);
    let contract = null, state = emptyState(), availability = "available", reason = null;
    try { contract = policy.submittedContract(order); state = await loadConfirmationState(db, tx, ref, order, hotelUid, orderId); }
    catch (error) {
      if (!(error instanceof HttpsError) || !["failed-precondition", "invalid-argument"].includes(error.code)) throw error;
      availability = order.status === "Created" && !order.supplierConfirmation ? "not-dispatched" : "review-required";
      reason = availability === "not-dispatched" ? "Send the order before recording the supplier's business response." : "The dispatched order or supplier evidence needs reconciliation before further changes.";
    }
    let query = ref.collection("supplierConfirmations").orderBy("revision", "desc");
    if (cursor) {
      const after = await tx.get(ref.collection("supplierConfirmations").doc(cursor));
      if (!after.exists || !Number.isSafeInteger(after.data().revision)) throw new HttpsError("failed-precondition", "Supplier history cursor is unavailable. Refresh history.");
      query = query.startAfter(after);
    }
    const events = await tx.get(query.limit(26)), page = events.docs.slice(0, 25);
    const responseRefs = page.filter((doc) => doc.data().kind === "review").map((doc) => ref.collection("supplierConfirmations").doc(requireDocumentId(doc.data().review?.responseId, "Reviewed response ID")));
    const responses = responseRefs.length ? await tx.getAll(...responseRefs) : [];
    const responseMap = new Map(responses.map((doc) => [doc.id, doc.data()]));
    const history = page.map((doc) => {
      const event = doc.data();
      if (!contract) return null;
      const response = event.kind === "response" ? policy.verifiedResponse(event, order, hotelUid, orderId)
        : event.kind === "review" ? policy.verifiedResponse(responseMap.get(event.review?.responseId), order, hotelUid, orderId) : null;
      if (!response || event.revision > currentRevision) throw new HttpsError("failed-precondition", "A supplier history event needs reconciliation.");
      const review = event.kind === "review" ? policy.verifiedReview(event, response, event.review.responseId, hotelUid, orderId) : null;
      return { id: doc.id, kind: event.kind, revision: event.revision, actorName: typeof event.actorName === "string" ? event.actorName.slice(0, 161) : null,
        createdAtMillis: event.createdAt?.toMillis?.() ?? null, response: event.kind === "response" ? response : null, review };
    }).filter(Boolean);
    return { hotelUid, orderId, policyVersion: policy.POLICY_VERSION, orderRevision: currentRevision, status: order.status,
      availability, reason, releaseReady: release.data()?.enabled === true && release.data().rulesVersion === SAAS_RULES_VERSION,
      today: validTimeZone(hotel.data()?.timeZone) ? localDate(services.now?.() ?? Date.now(), hotel.data().timeZone) : null,
      submittedLines: contract?.lines ?? [], current: state.response ? { ...summary(state), response: state.response, review: state.review } : null,
      events: history, nextCursor: events.size > 25 ? page.at(-1).id : null };
  }, { readOnly: true });
}
// Validate the historical terms used by one receipt, independently of today's latest response.
async function verifyReceiptSupplierTerms(db, tx, hotelUid, orderId, order, evidence, receipt, receiptRevision, preloaded) {
  if (evidence === undefined) return null;
  if (!evidence || evidence.policyVersion !== policy.POLICY_VERSION) throw new HttpsError("failed-precondition", "Receipt supplier pricing evidence needs reconciliation.");
  const ref = db.doc(`hotels/${hotelUid}/orders/${orderId}`);
  const responseId = requireDocumentId(evidence.responseId, "Receipt supplier response ID");
  const responseRef = ref.collection("supplierConfirmations").doc(responseId);
  const event = (preloaded ? preloaded.get(responseRef.path) : await tx.get(responseRef))?.data();
  const response = policy.verifiedResponse(event, order, hotelUid, orderId);
  const reviewId = evidence.reviewId === null ? null : requireDocumentId(evidence.reviewId, "Receipt supplier review ID");
  const reviewRef = reviewId ? ref.collection("supplierConfirmations").doc(reviewId) : null;
  const reviewEvent = reviewRef ? (preloaded ? preloaded.get(reviewRef.path) : await tx.get(reviewRef))?.data() : null;
  const review = reviewId ? policy.verifiedReview(reviewEvent, response, responseId, hotelUid, orderId) : null;
  if (!Number.isSafeInteger(receiptRevision) || event.revision >= receiptRevision || reviewEvent && (reviewEvent.revision <= event.revision || reviewEvent.revision >= receiptRevision)) {
    throw new HttpsError("failed-precondition", "Supplier terms were not reviewed before the receipt.");
  }
  const expected = policy.receivingTerms({ response, responseId, review, reviewId }, receipt);
  if (!expected || policy.stableDigest(expected) !== policy.stableDigest(evidence)) throw new HttpsError("failed-precondition", "Frozen receipt prices disagree with the supplier response and hotel review.");
  return expected;
}
const options = { region: "us-central1", cors: true };
module.exports = { loadConfirmationState, verifyReceiptSupplierTerms, recordHotelSupplierConfirmationHandler, reviewHotelSupplierConfirmationHandler, getHotelSupplierConfirmationsHandler,
  recordHotelSupplierConfirmation: onCall(options, gated(recordHotelSupplierConfirmationHandler)),
  reviewHotelSupplierConfirmation: onCall(options, gated(reviewHotelSupplierConfirmationHandler)),
  getHotelSupplierConfirmations: onCall(options, getHotelSupplierConfirmationsHandler) };
