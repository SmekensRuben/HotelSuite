const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { admin } = require("./config");
const { requireHotelPermission } = require("./authorization");
const { requireDocumentId } = require("./subscriptions");
const { revision, text, digest } = require("./validation");
const { gated, requireSaasRollout, SAAS_RULES_VERSION } = require("./saasRollout");
const policy = require("./orderReceivingPolicy");
const { validTimeZone } = require("./hotelSetupPolicy");
const { localDate } = require("./importMonitoringPolicy");
const { multiplyQuantities, calculateNetValue, derivedPrice } = require("./productPolicy");
const { loadConfirmationState } = require("./supplierConfirmations");
const { receivingTerms } = require("./supplierConfirmationPolicy");
const { prepareReceiptMovement, prepareReversalMovement } = require("./inventoryMovements");
const { listInventoryStockPoints } = require("./procurementResources");
const stamp = () => admin.firestore.FieldValue.serverTimestamp();
const referenceKey = (value) => digest(value.normalize("NFKC").replace(/\s+/g, " ").toLowerCase());
function orderRevision(data) {
  const value = data.revision === undefined ? 0 : data.revision;
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) throw new HttpsError("failed-precondition", "The stored order revision needs review.");
  return value;
}

async function changeReceiving(request, services, kind) {
  const db = services.firestore || admin.firestore(), input = request.data || {};
  const hotelUid = requireDocumentId(input.hotelUid, "hotelUid"), orderId = requireDocumentId(input.orderId, "orderId");
  const requestId = requireDocumentId(input.requestId, "requestId"), expected = revision(input.expectedRevision);
  const allowed = ["hotelUid", "orderId", "requestId", "expectedRevision", ...(kind === "receipt" ? ["receivedOn", "deliveryReference", "note", "lines", "inventoryLocationId", "supplierPricingPolicyVersion"] : kind === "reversal" ? ["receiptId", "reason"] : ["acceptShortfall", "reason"])];
  if (Object.keys(input).some((key) => !allowed.includes(key))) throw new HttpsError("invalid-argument", "Unsupported receiving field.");
  if (kind === "receipt" && input.supplierPricingPolicyVersion !== undefined && input.supplierPricingPolicyVersion !== 1) throw new HttpsError("failed-precondition", "This supplier pricing policy is unsupported. Reload the application.");
  const details = kind === "receipt" ? policy.normalizeReceipt(input)
    : kind === "reversal" ? { receiptId: requireDocumentId(input.receiptId, "receiptId"), reason: text(input.reason, "Reversal reason", 1000, true) }
      : { acceptShortfall: input.acceptShortfall, reason: text(input.reason ?? "", "Finalization reason", 1000) };
  if (kind === "receipt" && input.inventoryLocationId != null) details.inventoryLocationId = requireDocumentId(input.inventoryLocationId, "inventoryLocationId");
  const orderRef = db.doc(`hotels/${hotelUid}/orders/${orderId}`);
  const eventId = `r-${digest(orderId, request.auth?.uid, requestId).slice(0, 48)}`;
  const eventRef = orderRef.collection("receipts").doc(eventId);
  const fingerprint = digest(kind, expected, details);
  return db.runTransaction(async (tx) => {
    await requireHotelPermission(db, { ...request }, hotelUid, "orders", kind === "receipt" ? "receive" : "finalize", tx, services.auth);
    await requireSaasRollout(db, tx);
    const [order, previousEvent] = await Promise.all([tx.get(orderRef), tx.get(eventRef)]);
    if (previousEvent.exists) {
      if (previousEvent.data().fingerprint !== fingerprint) throw new HttpsError("already-exists", "This receiving request was used with different details.");
      return previousEvent.data().result;
    }
    try {
      if (!order.exists) throw new HttpsError("not-found", "Order not found.");
      const source = order.data();
      if (source.status === "Finalized") throw new HttpsError("failed-precondition", "Finalized receiving history is immutable.");
      if (orderRevision(source) !== expected) throw new HttpsError("aborted", "This order changed. Refresh and review its receiving quantities.");
      const previous = policy.receivingState(source);
      const member = await tx.get(db.doc(`hotels/${hotelUid}/members/${request.auth.uid}`));
      const actorName = [member.data().firstName, member.data().lastName].filter((value) => typeof value === "string" && value.trim()).join(" ").slice(0, 161) || null;
      if (!source.receiving && !(await tx.get(orderRef.collection("receipts").limit(1))).empty) {
        throw new HttpsError("failed-precondition", "Receiving events exist without their aggregate. Reconcile this order before continuing.");
      }
      let next, referenceRef, reversalRef, supplierTerms, movement = null;
      if (kind === "receipt") {
        referenceRef = orderRef.collection("receiptReferences").doc(referenceKey(details.deliveryReference));
        if ((await tx.get(referenceRef)).exists) throw new HttpsError("already-exists", "This delivery reference has already been recorded. Review the receipt history.");
        next = policy.applyReceipt(previous, details);
        if (details.lines.some((line) => line.acceptedQuantity > 0)) {
          supplierTerms = receivingTerms(await loadConfirmationState(db, tx, orderRef, source, hotelUid, orderId), details, previous.lines);
          if (!details.inventoryLocationId) throw new HttpsError("invalid-argument", "Select the physical location receiving these goods.");
          const inventory = receiptInventoryLines(source.products, details.lines, supplierTerms);
          movement = await prepareReceiptMovement(db, tx, { hotelUid, locationId: details.inventoryLocationId,
            movementId: eventId, orderId, receiptId: eventId, kind: "receipt", receivedOn: details.receivedOn,
            actorUid: request.auth.uid, ...inventory });
        }
      } else if (kind === "reversal") {
        const original = await tx.get(orderRef.collection("receipts").doc(details.receiptId));
        reversalRef = orderRef.collection("receiptReversals").doc(details.receiptId);
        const reversed = await tx.get(reversalRef);
        if (!original.exists || original.data().orderId !== orderId || original.data().kind !== "receipt") throw new HttpsError("not-found", "Receipt not found in this order.");
        if (reversed.exists) throw new HttpsError("already-exists", "This receipt has already been reversed.");
        if (!original.data().inventoryMovement?.movementId && original.data().lines?.some((line) => line.acceptedQuantity > 0)) {
          throw new HttpsError("failed-precondition", "This historical accepted receipt has no verified inventory movement. Review its inventory reconciliation before reversing it.");
        }
        next = policy.applyReversal(previous, original.data());
        if (original.data().inventoryMovement?.movementId) movement = await prepareReversalMovement(db, tx, {
          hotelUid, movementId: eventId, originalMovementId: original.data().inventoryMovement.movementId,
          orderId, receiptId: eventId, actorUid: request.auth.uid });
      } else next = policy.finalizeState(previous, details);
      const status = kind === "finalization" ? "Finalized" : next.state === "complete" ? "Received" : "Ordered";
      const result = { hotelUid, orderId, eventId, status, revision: expected + 1, receivingState: next.state };
      const event = { policyVersion: policy.RECEIVING_POLICY_VERSION, kind, hotelUid, orderId, actorUid: request.auth.uid, actorName,
        fingerprint, ...details, result, revision: expected + 1, createdAt: stamp() };
      if (supplierTerms) event.supplierConfirmationTerms = supplierTerms;
      if (kind !== "finalization") event.inventoryMovement = movement?.metadata ?? (movement ? {
        movementId: movement.movementId, locationId: movement.locationId, sequence: movement.sequence, inventoryPolicyVersion: 1 } : null);
      if (kind === "receipt") event.lines = details.lines.map((line) => ({ ...line,
        productName: previous.lines.find((item) => policy.lineKey(item) === policy.lineKey(line)).productName,
        purchaseUnit: previous.lines.find((item) => policy.lineKey(item) === policy.lineKey(line)).purchaseUnit }));
      if (movement) movement.write(tx);
      tx.update(orderRef, { receiving: { ...next, updatedAt: stamp(), updatedBy: request.auth.uid }, status,
        revision: expected + 1, updatedAt: stamp(), updatedBy: request.auth.uid });
      tx.create(eventRef, event);
      if (referenceRef) tx.create(referenceRef, { eventId, createdAt: stamp() });
      if (reversalRef) tx.create(reversalRef, { eventId, actorUid: request.auth.uid, reason: details.reason, createdAt: stamp() });
      tx.create(db.doc(`hotels/${hotelUid}/orderAudit/${eventId}`), { orderId, action: `receiving-${kind}`, eventId, actorUid: request.auth.uid, revision: expected + 1, createdAt: stamp() });
      return result;
    } catch (error) {
      // Only failures after proving this request absent can release a saved client command.
      // Gate/Auth failures cannot establish the outcome of an earlier uncertain attempt.
      if (error instanceof HttpsError) throw new HttpsError(error.code, error.message, { receivingRequestUncommitted: true });
      throw error;
    }
  });
}
const recordHotelOrderReceiptHandler = (request, services = {}) => changeReceiving(request, services, "receipt");
const reverseHotelOrderReceiptHandler = (request, services = {}) => changeReceiving(request, services, "reversal");
const finalizeHotelOrderReceivingHandler = (request, services = {}) => changeReceiving(request, services, "finalization");

async function getHotelOrderReceivingHandler(request, services = {}) {
  const db = services.firestore || admin.firestore(), input = request.data || {};
  const hotelUid = requireDocumentId(input.hotelUid, "hotelUid"), orderId = requireDocumentId(input.orderId, "orderId");
  const cursor = input.afterEventId == null ? null : requireDocumentId(input.afterEventId, "afterEventId");
  const ref = db.doc(`hotels/${hotelUid}/orders/${orderId}`);
  return db.runTransaction(async (tx) => {
    await requireHotelPermission(db, { ...request }, hotelUid, "orders", "read", tx, services.auth);
    const [order, release, hotel] = await tx.getAll(ref, db.doc("platformConfiguration/saasProcurement"), db.doc(`hotels/${hotelUid}`));
    if (!order.exists) throw new HttpsError("not-found", "Order not found.");
    let query = ref.collection("receipts").orderBy("createdAt", "desc");
    if (cursor) {
      const after = await tx.get(ref.collection("receipts").doc(cursor));
      if (!after.exists) throw new HttpsError("not-found", "Receiving history cursor no longer exists. Refresh history.");
      query = query.startAfter(after);
    }
    const events = await tx.get(query.limit(26));
    const locations = await listInventoryStockPoints(db, tx, hotelUid);
    const page = events.docs.slice(0, 25);
    const originals = page.filter((event) => event.data().kind === "receipt");
    const reversed = originals.length ? await tx.getAll(...originals.map((event) => ref.collection("receiptReversals").doc(event.id))) : [];
    const reversals = new Set(reversed.filter((doc) => doc.exists).map((doc) => doc.id));
    const data = order.data();
    let availability = "available", reason = null, aggregate = null;
    if (!["Ordered", "Received", "Finalized"].includes(data.status)) {
      availability = "not-started"; reason = "Receiving starts after supplier dispatch is confirmed.";
    } else {
      try {
        if (!data.receiving && !events.empty) throw new HttpsError("failed-precondition", "Receiving aggregate is missing.");
        aggregate = policy.receivingState(data);
      }
      catch (error) { if (!["failed-precondition", "invalid-argument"].includes(error.code)) throw error; availability = "review-required"; reason = "Historical receiving data has no verified baseline or needs reconciliation. Review the source record before making changes."; }
    }
    let supplierReceiptBlockReason = null, supplierState = null;
    if (aggregate && data.status !== "Finalized") {
      try {
        supplierState = await loadConfirmationState(db, tx, ref, data, hotelUid, orderId);
        receivingTerms(supplierState, { lines: [{ acceptedQuantity: 1 }] });
      } catch (error) {
        if (!(error instanceof HttpsError)) throw error;
        supplierReceiptBlockReason = error.message;
      }
    }
    return { hotelUid, orderId, policyVersion: policy.RECEIVING_POLICY_VERSION, orderRevision: orderRevision(data),
      supplierReceiptBlockReason, supplierPricingPolicyVersion: 1,
      today: validTimeZone(hotel.data()?.timeZone) ? localDate(services.now?.() ?? Date.now(), hotel.data().timeZone) : null,
      status: data.status, availability, reason, receivingState: aggregate?.state ?? null,
      releaseReady: release.data()?.enabled === true && release.data().rulesVersion === SAAS_RULES_VERSION,
      inventoryLocations: locations.slice(0, 100),
      inventoryLocationsTruncated: locations.length > 100,
      inventoryCoverageReasons: [...new Set((data.products || []).map((product) => product.inventoryTerms?.reason
        ?? (product.inventoryTerms ? null : "historical-inventory-terms-unavailable")).filter(Boolean))],
      lines: aggregate ? policy.summary(aggregate).map((line) => {
        const confirmed = supplierState?.response?.lines.find((item) => policy.lineKey(item) === policy.lineKey(line));
        const acceptedTerms = supplierState?.response?.responseType === "accepted" || supplierState?.review?.decision === "accept";
        return { ...line, supplierConfirmedQuantity: acceptedTerms && confirmed ? confirmed.confirmedQuantity : null,
          supplierOutstandingQuantity: acceptedTerms && confirmed ? Math.max(0, policy.milli(confirmed.confirmedQuantity, "Confirmed quantity") - policy.milli(line.acceptedQuantity, "Accepted quantity")) / 1000 : null };
      }) : null, finalizationReason: aggregate?.finalizationReason ?? null,
      events: page.map((event) => { const row = event.data();
        if (!["receipt", "reversal", "finalization"].includes(row.kind) || typeof row.actorUid !== "string"
          || !Array.isArray(row.lines ?? []) || (row.lines || []).some((line) => !line || typeof line !== "object")) {
          throw new HttpsError("failed-precondition", "A receiving history record needs review.");
        }
        return { id: event.id, kind: row.kind, actorUid: row.actorUid, actorName: typeof row.actorName === "string" ? row.actorName.slice(0, 161) : null,
        receivedOn: row.receivedOn ?? null, deliveryReference: row.deliveryReference ?? null, note: row.note ?? null,
        reason: row.reason ?? null, receiptId: row.receiptId ?? null, reversed: reversals.has(event.id),
        inventoryMovement: row.inventoryMovement ?? null,
        supplierResponseId: row.supplierConfirmationTerms?.responseId ?? null,
        revision: row.revision, createdAtMillis: row.createdAt?.toMillis?.() ?? null,
        lines: Array.isArray(row.lines) ? row.lines.map(({ supplierProductId, orderLineId, acceptedQuantity, rejectedQuantity, productName, purchaseUnit, reason }) =>
          ({ supplierProductId, ...(orderLineId ? { orderLineId } : {}), acceptedQuantity, rejectedQuantity, productName, purchaseUnit, reason })) : [] }; }),
      nextCursor: events.size > 25 ? page.at(-1).id : null, computedAtMillis: services.now?.() ?? Date.now() };
  }, { readOnly: true });
}
const options = { region: "us-central1", cors: true };
function receiptInventoryLines(products, incoming, supplierTerms = null) {
  const lines = [], coverageGaps = [];
  for (const receipt of incoming) {
    if (receipt.acceptedQuantity === 0) continue;
    const product = products.find((item) => policy.lineKey(item) === policy.lineKey(receipt));
    const terms = product?.inventoryTerms;
    if (terms?.inventoryPolicyVersion === 1 && terms.inventoryTracked === false
      && terms.catalogProductId && terms.reason === "catalog-product-not-inventory-tracked") continue;
    if (!terms || terms.inventoryPolicyVersion !== 1 || !terms.catalogProductId || !terms.catalogBaseUnit
      || typeof terms.catalogUnitsPerPurchaseUnit !== "number" || !(terms.catalogUnitsPerPurchaseUnit > 0)) {
      coverageGaps.push({ orderLineId: policy.lineKey(receipt), reason: terms?.reason || "The frozen order has no verified catalog conversion." });
      continue;
    }
    const quantity = multiplyQuantities(receipt.acceptedQuantity, terms.catalogUnitsPerPurchaseUnit);
    const approved = supplierTerms?.lines.find((line) => policy.lineKey(line) === policy.lineKey(receipt));
    const changedPrice = approved && approved.priceMode !== "as-ordered";
    const netPrice = changedPrice ? approved.currency === terms.currency ? approved.netPricePerPurchaseUnit : null : product.netPricePerPurchaseUnit;
    let netValue = null, netUnitCost = terms.netUnitCost;
    if (changedPrice) {
      netUnitCost = null;
      if (netPrice !== null) {
        try { netUnitCost = derivedPrice(netPrice, terms.catalogUnitsPerPurchaseUnit, true); }
        catch (error) { if (!(error instanceof HttpsError)) throw error; }
      }
    }
    try { netValue = calculateNetValue(receipt.acceptedQuantity, netPrice); }
    catch (error) { if (!(error instanceof HttpsError)) throw error; }
    lines.push({ catalogProductId: terms.catalogProductId, catalogProductName: terms.catalogProductName,
      baseUnit: terms.catalogBaseUnit, quantity, netUnitCost, netValue, currency: terms.currency,
      ...(netValue == null ? { coverageReason: changedPrice ? "Reviewed supplier price has no available net value." : terms.reason || "Receipt value is unknown or outside supported precision." } : {}) });
  }
  return { lines, coverageGaps };
}
module.exports = { receiptInventoryLines, recordHotelOrderReceiptHandler, reverseHotelOrderReceiptHandler, finalizeHotelOrderReceivingHandler, getHotelOrderReceivingHandler,
  recordHotelOrderReceipt: onCall(options, gated(recordHotelOrderReceiptHandler)), reverseHotelOrderReceipt: onCall(options, gated(reverseHotelOrderReceiptHandler)),
  finalizeHotelOrderReceiving: onCall(options, gated(finalizeHotelOrderReceivingHandler)), getHotelOrderReceiving: onCall(options, getHotelOrderReceivingHandler) };
