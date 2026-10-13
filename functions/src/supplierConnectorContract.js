const { HttpsError } = require("firebase-functions/v2/https");
const { requireDocumentId } = require("./subscriptions");
const { text } = require("./validation");
const { submittedContract, normalizeResponse } = require("./supplierConfirmationPolicy");
const CONTRACT_VERSION = 1;
// Pure adapter boundary for the first supplier pilot. It does not dispatch an
// order, authenticate a webhook, read secrets or imply that a supplier API exists.
function supplierOrderEnvelope(context, order) {
  const contract = submittedContract(order);
  const hotelUid = requireDocumentId(context.hotelUid, "Connector hotel ID"), orderId = requireDocumentId(context.orderId, "Connector order ID");
  const connectionId = requireDocumentId(context.connectionId, "Connector connection ID");
  const customerAccountNumber = text(order.accountNumber, "Frozen supplier customer account", 120, true);
  if (context.supplierId !== contract.supplierId || context.customerAccountNumber !== customerAccountNumber) {
    throw new HttpsError("failed-precondition", "The connection does not match this hotel's frozen supplier and customer account.");
  }
  return { contractVersion: CONTRACT_VERSION, hotelUid, orderId, connectionId, supplierId: contract.supplierId, customerAccountNumber,
    submittedDigest: contract.sourceDigest, currency: contract.currency, deliveryDate: contract.deliveryDate,
    lines: contract.lines.map((line) => ({ supplierProductId: line.supplierProductId, orderLineId: line.orderLineId ?? line.supplierProductId,
      purchaseOptionId: line.purchaseOptionId ?? "default", supplierSku: line.supplierSku, productName: line.productName,
      quantity: line.orderedQuantity, purchaseUnit: line.purchaseUnit, pricePerPurchaseUnit: line.orderedPrice, priceBasis: line.priceBasis, vatRate: line.vatRate })) };
}
function supplierResponseEnvelope(expected, message, order) {
  if (!message || typeof message !== "object" || Array.isArray(message) || message.contractVersion !== CONTRACT_VERSION
    || ["hotelUid", "orderId", "connectionId", "supplierId", "customerAccountNumber", "submittedDigest"].some((key) => message[key] !== expected[key])
    || Object.keys(message).some((key) => !["contractVersion", "hotelUid", "orderId", "connectionId", "supplierId", "customerAccountNumber", "submittedDigest", "supplierMessageId", "response"].includes(key))) {
    throw new HttpsError("invalid-argument", "Supplier response correlation does not match the frozen hotel/order/customer envelope.");
  }
  const rebuilt = supplierOrderEnvelope(expected, order);
  if (rebuilt.submittedDigest !== expected.submittedDigest) throw new HttpsError("failed-precondition", "The submitted order changed after the connector envelope was prepared.");
  return { ...rebuilt, supplierMessageId: text(message.supplierMessageId, "Supplier message ID", 200, true),
    response: normalizeResponse(message.response, order) };
}
module.exports = { CONTRACT_VERSION, supplierOrderEnvelope, supplierResponseEnvelope };
