const { onDocumentWritten, logger, admin, RESEND_API_KEY, RESEND_FROM } = require("./config");
const { enqueueOrderEmail } = require("./mailQueue");
const { sendOrderBySftp } = require("./sftpTransport");
const { claimDispatch, completeDispatch } = require("./deliveryState");

async function dispatchOrderHandler(event, services = {}) {
  if (!event.data?.after?.exists) return;
  const after = event.data.after.data();
  const before = event.data.before?.exists ? event.data.before.data() : {};
  const dispatchId = after.dispatchRequestId;
  if (!dispatchId || before.dispatchRequestId === dispatchId) return;
  const { hotelUid, orderId } = event.params;
  const db = services.firestore || admin.firestore();
  const dispatch = await claimDispatch(db, hotelUid, orderId, dispatchId);
  if (!dispatch) return;
  let externalAttempt = false;
  try {
    if (dispatch.supplier.orderSystem === "SFTP csv") {
      const secret = await db.doc(`hotels/${hotelUid}/supplierSecrets/${dispatch.supplier.id}`).get();
      if (!secret.exists) throw new Error("Missing private supplier connection.");
      const result = await (services.sendSftp || sendOrderBySftp)(dispatch.order, secret.data(), { hotelUid, orderId, markExternalAttempt: () => { externalAttempt = true; } });
      await completeDispatch(db, hotelUid, orderId, dispatchId, "sent", { via: "sftp", remotePath: result.remotePath });
    } else {
      await (services.enqueueEmail || enqueueOrderEmail)({ hotelUid, orderId, dispatchRequestId: dispatchId,
        order: dispatch.order, supplier: dispatch.supplier, supplierId: dispatch.supplier.id,
        hotel: { hotelName: dispatch.order.hotelName } }, { firestore: db });
      // The mail worker owns final delivery status. Never reset it after a fast send.
    }
  } catch {
    const error = externalAttempt
      ? "SFTP delivery is unconfirmed. Check the supplier's stable order file before any recovery."
      : "Delivery preparation failed. Review supplier configuration before recovery.";
    await completeDispatch(db, hotelUid, orderId, dispatchId, externalAttempt ? "needs-review" : "failed", { error, externalAttempt });
    logger.error("Order delivery requires review", { hotelUid, orderId, dispatchId, externalAttempt });
    // No automatic resend after an ambiguous external side effect.
  }
}

const sendOrderedSupplierOrder = onDocumentWritten({ document: "hotels/{hotelUid}/orders/{orderId}", secrets: [RESEND_API_KEY, RESEND_FROM] }, dispatchOrderHandler);
module.exports = { sendOrderedSupplierOrder, dispatchOrderHandler };
