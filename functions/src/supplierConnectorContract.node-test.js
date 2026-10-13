const { test } = require("node:test");
const assert = require("node:assert/strict");
const { supplierOrderEnvelope, supplierResponseEnvelope } = require("./supplierConnectorContract");
const order = { status: "Ordered", dispatchStatus: "sent", supplierId: "supplier-a", accountNumber: "customer-42", currency: "EUR", deliveryDate: "2026-10-15",
  products: [{ supplierProductId: "product", orderLineId: "line-a", purchaseOptionId: "case", supplierSku: "SKU", supplierProductName: "Cases", purchaseUnit: "Case", qtyPurchaseUnits: 2, pricePerPurchaseUnit: 10, priceBasis: "net" }] };
const context = { hotelUid: "hotel-a", orderId: "order-a", connectionId: "supplier-connection", supplierId: "supplier-a", customerAccountNumber: "customer-42" };
const response = { responseType: "accepted", channel: "sftp", supplierReference: "reference", respondedOn: "2026-10-13", note: "", lines: [
  { supplierProductId: "product", orderLineId: "line-a", confirmedQuantity: 2, deliveryDate: "2026-10-15", priceMode: "as-ordered", substitute: null, reason: "" }] };
test("pilot envelope preserves stable identities, customer account, package and pricing without credentials", () => {
  const envelope = supplierOrderEnvelope(context, order);
  assert.equal(envelope.contractVersion, 1); assert.equal(envelope.lines[0].orderLineId, "line-a"); assert.equal(envelope.lines[0].purchaseUnit, "Case");
  assert.equal(envelope.lines[0].priceBasis, "net"); assert.equal(JSON.stringify(envelope).includes("password"), false);
  assert.deepEqual(supplierOrderEnvelope(context, order), envelope);
  assert.throws(() => supplierResponseEnvelope(envelope, { ...envelope, response }, order), (error) => error.code === "invalid-argument", "Do not treat an outgoing order as an incoming supplier response.");
});
test("response correlation rejects every cross-hotel, supplier, customer, connection, order and source mismatch", () => {
  const envelope = supplierOrderEnvelope(context, order);
  const { currency, deliveryDate, lines, ...correlation } = envelope;
  void currency; void deliveryDate; void lines;
  const message = { ...correlation, supplierMessageId: "message-001", response };
  assert.equal(supplierResponseEnvelope(envelope, message, order).response.responseType, "accepted");
  for (const key of ["hotelUid", "orderId", "connectionId", "supplierId", "customerAccountNumber", "submittedDigest"]) {
    assert.throws(() => supplierResponseEnvelope(envelope, { ...message, [key]: "other" }, order), (error) => error.code === "invalid-argument");
  }
  assert.throws(() => supplierResponseEnvelope(envelope, { ...message, authenticated: true }, order), (error) => error.code === "invalid-argument");
  assert.throws(() => supplierOrderEnvelope({ ...context, customerAccountNumber: "other" }, order), (error) => error.code === "failed-precondition");
});
test("a delayed response cannot attach to an edited submitted contract", () => {
  const envelope = supplierOrderEnvelope(context, order), { currency, deliveryDate, lines, ...correlation } = envelope;
  void currency; void deliveryDate; void lines;
  const changed = structuredClone(order); changed.products[0].qtyPurchaseUnits = 3;
  assert.throws(() => supplierResponseEnvelope(envelope, { ...correlation, supplierMessageId: "late", response }, changed), (error) => error.code === "failed-precondition");
});
