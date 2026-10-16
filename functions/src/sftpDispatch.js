const { onDocumentWritten, logger, admin, RESEND_API_KEY, RESEND_FROM } = require("./config");
const { enqueueOrderEmail } = require("./mailQueue");
const { sendOrderBySftp } = require("./sftpTransport");
const { claimDispatch, completeDispatch, markDispatchExternalAttempt } = require("./deliveryState");

async function dispatchOrderHandler(event, services = {}) {
  if (!event.data?.after?.exists) return;
  const after = event.data.after.data();
  const before = event.data.before?.exists ? event.data.before.data() : {};
  const dispatchId = after.dispatchRequestId;
  if (!dispatchId || before.dispatchRequestId === dispatchId) return;
  const { hotelUid, orderId } = event.params;
  const db = services.firestore || admin.firestore();
  // Reserved demo suppliers never reach email/SFTP, even if a malformed pending
  // dispatch or edited public contact information is encountered.
  if (await require("./demoDataPolicy").demoSupplierMode(db, hotelUid, after.supplierId)) return;
  const dispatch = await claimDispatch(db, hotelUid, orderId, dispatchId, services.auth);
  if (!dispatch) return;
  let externalAttempt = false;
  try {
    if (await require("./demoDataPolicy").demoSupplierMode(db, hotelUid, dispatch.supplier.id)) {
      await completeDispatch(db, hotelUid, orderId, dispatchId, "blocked", { externalAttempt: false, error: "Demo supplier delivery must be simulated by the protected confirmation workflow." });
      return;
    }
    const policy = require("./environmentPolicy");
    if (policy.isStagingEnvironment()) {
      await completeDispatch(db, hotelUid, orderId, dispatchId, "simulated", { via: "simulation", deliveryMode: "simulation", environment: "staging",
        externalAttempt: false, simulationReason: "Staging simulation: no supplier contacted" });
      return;
    }
    policy.requireExternalActions("Supplier deliveries");
    if (dispatch.supplier.orderSystem === "SFTP csv") {
      const secret = await db.doc(`hotels/${hotelUid}/supplierSecrets/${dispatch.supplier.id}`).get();
      if (!secret.exists) throw new Error("Missing private supplier connection.");
      const result = await (services.sendSftp || sendOrderBySftp)(dispatch.order, secret.data(), { hotelUid, orderId, markExternalAttempt: async () => {
        const allowed = await markDispatchExternalAttempt(db, hotelUid, orderId, dispatchId);
        if (!allowed) throw new Error("Delivery was retired before transfer.");
        externalAttempt = true;
      } });
      await completeDispatch(db, hotelUid, orderId, dispatchId, "sent", { via: "sftp", remotePath: result.remotePath, externalAttempt: true });
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
