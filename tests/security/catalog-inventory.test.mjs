import { before, beforeEach, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, updateDoc, deleteDoc } from "firebase/firestore";

const projectId = "demo-hotel-suite-a00";
if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) throw new Error("Local Auth and Firestore emulators are required.");
process.env.FIREBASE_CONFIG = JSON.stringify({ projectId, storageBucket: `${projectId}.appspot.com` });
const require = createRequire(import.meta.url);
const { admin } = require("../../functions/src/config");
const { SAAS_RULES_VERSION } = require("../../functions/src/saasRollout");
const { mutateHotelCatalogProductHandler, mutateHotelSupplierProductHandler, importHotelProductsHandler } = require("../../functions/src/products");
const { mutateShoppingCartHandler } = require("../../functions/src/shoppingCarts");
const { createOrdersFromCartHandler, updateOrderHandler, confirmOrderHandler } = require("../../functions/src/orders");
const { mutateHotelStockTemplateHandler } = require("../../functions/src/stockTemplates");
const { createHotelStockCountHandler, mutateHotelStockCountHandler, listHotelStockCountSourcesHandler } = require("../../functions/src/stockCounts");
const { recordHotelOrderReceiptHandler, reverseHotelOrderReceiptHandler } = require("../../functions/src/orderReceiving");
const { getHotelInventoryPeriodHandler } = require("../../functions/src/inventoryReports");
const { getHotelInventoryCostProposalHandler } = require("../../functions/src/inventoryCostProposals");
const { requireHotelImportTarget } = require("../../functions/src/fileImportTypes");
const db = admin.firestore(), auth = admin.auth();
const staff = { uid: "catalog-inventory-staff", token: { email_verified: true, email: "staff@example.test" } };
const platform = { uid: "catalog-inventory-platform", token: { email_verified: true, platformAdmin: true, email: "platform@example.test" } };
const outsider = { uid: "catalog-inventory-outsider", token: { email_verified: true, email: "outsider@example.test" } };
const services = { firestore: db, auth, now: () => Date.parse("2026-10-12T12:00:00Z") };
let environment, sequence = 0;
const next = () => `catalog-command-${++sequence}`;
const request = (data, actor = staff) => ({ auth: actor, data });
const rejected = (result, code) => assert.rejects(result, (error) => error.code === code);
const client = (actor = staff) => environment.authenticatedContext(actor.uid, actor.token).firestore();
const catalog = (patch = {}) => ({ name: "Bottled water", baseUnit: "each", active: true, inventoryTracked: true, allergens: [], ...patch });
const offer = (patch = {}) => ({ supplierId: "vendor", supplierSku: "WATER24", supplierProductName: "Water crate", currency: "EUR", pricingModel: "Per Purchase Unit",
  pricePerBaseUnit: null, pricePerPurchaseUnit: 24, baseUnit: "each", purchaseUnit: "Crate of 24", baseUnitsPerPurchaseUnit: 24,
  catalogProductId: "water", imageUrl: "", active: true, priceBasis: "net", vatRate: null,
  purchaseOptions: [{ id: "bottle", purchaseUnit: "Bottle", baseUnitsPerPurchaseUnit: 1, pricePerPurchaseUnit: 1.25 }], ...patch });
const catalogCommand = (patch = {}, actor = staff) => mutateHotelCatalogProductHandler(request({ hotelUid: "hotel-a", action: "create", expectedRevision: 0, requestId: next(), product: catalog(), ...patch }, actor), services);
const offerCommand = (patch = {}, actor = staff) => mutateHotelSupplierProductHandler(request({ hotelUid: "hotel-a", action: "create", expectedRevision: 0, requestId: next(), product: offer(), ...patch }, actor), services);
const template = (patch = {}, actor = staff) => {
  const data = { hotelUid: "hotel-a", locationId: "store", templateId: "new", action: "create", expectedRevision: 0, requestId: next(), ...patch };
  if (["create", "rename"].includes(data.action)) data.name ??= "New";
  else delete data.name;
  return mutateHotelStockTemplateHandler(request(data, actor), services);
};
async function count(quantity, businessDate = "2026-10-10", unitCost = null) {
  const created = await createHotelStockCountHandler(request({ hotelUid: "hotel-a", name: "Physical count", type: "Weekly", requestId: next(), businessDate,
    locations: [{ locationId: "store", stockTemplateId: "weekly" }] }), services);
  await mutateHotelStockCountHandler(request({ hotelUid: "hotel-a", stockCountId: created.stockCountId, expectedRevision: 0, action: "finish-location", locationId: "store",
    countedItems: [{ catalogProductId: "water", quantity, isCounted: true, unitCost }] }), services);
  await mutateHotelStockCountHandler(request({ hotelUid: "hotel-a", stockCountId: created.stockCountId, expectedRevision: 1, action: "finish-count" }), services);
  return created.stockCountId;
}
async function frozenOrder({ orderId = "receipt-order", currency = "EUR", netPrice = 24, quantity = 10, terms = {} } = {}) {
  await db.doc(`hotels/hotel-a/orders/${orderId}`).set({ status: "Ordered", dispatchStatus: "sent", revision: 1, currency, supplierId: "vendor", outletId: "bar",
    products: [{ supplierProductId: "water-offer", orderLineId: "water-line", purchaseOptionId: "default", supplierProductName: "Water crate", purchaseUnit: "Crate of 24",
      qtyPurchaseUnits: quantity, pricePerPurchaseUnit: netPrice, netPricePerPurchaseUnit: netPrice,
      inventoryTerms: { inventoryPolicyVersion: 1, available: true, inventoryTracked: true, catalogProductId: "water", catalogProductName: "Bottled water",
        catalogBaseUnit: "each", catalogUnitsPerPurchaseUnit: 24, currency, netUnitCost: netPrice == null ? null : netPrice / 24, ...terms } }] });
  return orderId;
}
const receipt = (patch = {}, actor = staff) => recordHotelOrderReceiptHandler(request({ hotelUid: "hotel-a", orderId: "receipt-order", requestId: next(), expectedRevision: 1,
  receivedOn: "2026-10-11", deliveryReference: next(), inventoryLocationId: "store", lines: [{ supplierProductId: "water-offer", orderLineId: "water-line", acceptedQuantity: 1.25, rejectedQuantity: 0 }], ...patch }, actor), services);
const period = (openingStockCountId, closingStockCountId, patch = {}, actor = staff) => getHotelInventoryPeriodHandler(request({ hotelUid: "hotel-a", locationId: "store", openingStockCountId, closingStockCountId, ...patch }, actor), services);

before(async () => { environment = await initializeTestEnvironment({ projectId, firestore: { rules: await readFile("firebase/firestore.rules", "utf8") } }); });
beforeEach(async () => {
  await environment.clearFirestore();
  const users = await auth.listUsers(); if (users.users.length) await auth.deleteUsers(users.users.map((user) => user.uid));
  for (const actor of [staff, platform, outsider]) await auth.createUser({ uid: actor.uid, email: actor.token.email, emailVerified: true });
  await auth.setCustomUserClaims(platform.uid, { platformAdmin: true });
  await db.doc("platformConfiguration/saasProcurement").set({ enabled: true, rulesVersion: SAAS_RULES_VERSION });
  for (const hotel of ["hotel-a", "hotel-b"]) {
    await db.doc(`hotels/${hotel}`).set({ name: hotel, currency: "EUR", timeZone: "Europe/Brussels" });
    await db.doc(`hotels/${hotel}/settings/bootstrap`).set({ currency: "EUR" });
    await db.doc(`hotelSubscriptions/${hotel}`).set({ status: "active", validUntil: null, modules: ["procurement"], modulePolicyVersion: 1 });
    await db.doc(`hotels/${hotel}/catalogproducts/water`).set({ ...catalog(), productPolicyVersion: 1, revision: 1 });
    await db.doc(`hotels/${hotel}/locations/store`).set({ name: "Store" });
    await db.doc(`hotels/${hotel}/outlets/bar`).set({ name: "Bar" });
    await db.doc(`hotels/${hotel}/suppliers/vendor`).set({ name: "Vendor", orderSystem: "Email", orderEmail: "supplier@example.test" });
  }
  await db.doc(`hotels/hotel-a/members/${staff.uid}`).set({ permissions: ["catalogproducts.*", "supplierproducts.*", "locations.*", "stockcounts.*", "orders.*", "orders.receive", "orders.finalize"] });
  await db.doc(`hotels/hotel-b/members/${outsider.uid}`).set({ permissions: ["catalogproducts.*", "supplierproducts.*", "locations.*", "stockcounts.*", "orders.*", "orders.receive", "orders.finalize"] });
  await db.doc(`hotels/hotel-a/outlets/bar/approvers/${staff.uid}`).set({});
  await db.doc("hotels/hotel-a/locations/store/stockTemplates/weekly").set({ name: "Weekly", items: [{ catalogProductId: "water" }] });
});
after(async () => environment.cleanup());

describe("catalog products and periodic inventory acceptance with real ordinary-hotel identity", () => {
  it("normal counters receive a read-only weighted proposal from finished quantities and accepted frozen receipt values", async () => {
    const openingId = await count(10, "2026-10-10", 2);
    await frozenOrder({ netPrice: 3, quantity: 20, terms: { catalogUnitsPerPurchaseUnit: 1, netUnitCost: 3 } });
    await receipt({ lines: [{ supplierProductId: "water-offer", orderLineId: "water-line", acceptedQuantity: 20, rejectedQuantity: 0 }] });
    const target = await createHotelStockCountHandler(request({ hotelUid: "hotel-a", name: "New physical count", type: "Weekly", requestId: next(), businessDate: "2026-10-12",
      locations: [{ locationId: "store", stockTemplateId: "weekly" }] }), services);
    await db.doc(`hotels/hotel-a/members/${staff.uid}`).update({ permissions: ["stockcounts.read", "stockcounts.update", "inventorymovements.create"] });
    const refs = [db.doc(`hotels/hotel-a/stockCounts/${openingId}`), db.doc(`hotels/hotel-a/stockCounts/${target.stockCountId}`), db.doc("hotels/hotel-a/inventoryLocationStates/store")];
    const before = await db.getAll(...refs);
    const input = { hotelUid: "hotel-a", purpose: "stockcount", stockCountId: target.stockCountId, locationId: "store", catalogProductId: "water" };
    const result = await getHotelInventoryCostProposalHandler(request(input), services);
    assert.equal(result.available, true, JSON.stringify(result));
    assert.equal(result.costProposalPolicyVersion, 1);
    assert.equal(result.currency, "EUR"); assert.equal(result.baseUnit, "each");
    assert.ok(Math.abs(result.netUnitCost - 80 / 30) <= 0.000001);
    assert.equal(result.source.weightedSourceQuantity, 30);
    assert.equal(result.source.weightedSourceNetValue, 80);
    const movement = await getHotelInventoryCostProposalHandler(request({ hotelUid: "hotel-a", purpose: "movement", locationId: "store", catalogProductId: "water", businessDate: "2026-10-12" }), services);
    assert.equal(movement.netUnitCost, result.netUnitCost);
    const after = await db.getAll(...refs);
    assert.deepEqual(after.map((doc) => doc.data()), before.map((doc) => doc.data()));
    assert.deepEqual(after.map((doc) => doc.updateTime.toMillis()), before.map((doc) => doc.updateTime.toMillis()));
    await assertFails(getDoc(doc(client(), "hotels/hotel-a/catalogproducts/water")));
    await assertFails(getDoc(doc(client(), "hotels/hotel-a/inventoryLocationStates/store")));
    await rejected(getHotelInventoryCostProposalHandler(request({ ...input, hotelUid: "hotel-b" }), services), "permission-denied");
    const anchorRef = db.doc(`hotels/hotel-a/inventoryCheckpoints/${result.source.anchorCheckpointId}`);
    const checkpoint = (await anchorRef.get()).data();
    await anchorRef.update({ items: checkpoint.items.map((item) => ({ ...item, unitCost: 99 })) });
    const inconsistent = await getHotelInventoryCostProposalHandler(request(input), services);
    assert.equal(inconsistent.available, false); assert.equal(inconsistent.netUnitCost, null);
  });
  it("cost proposals enforce the monetary read boundary, current action rights, subscription and revoked Auth", async () => {
    const input = { hotelUid: "hotel-a", purpose: "movement", locationId: "store", catalogProductId: "water", businessDate: "2026-10-12" };
    await db.doc(`hotels/hotel-a/members/${staff.uid}`).update({ permissions: ["inventorymovements.create"] });
    await rejected(getHotelInventoryCostProposalHandler(request(input), services), "permission-denied");
    await db.doc(`hotels/hotel-a/members/${staff.uid}`).update({ permissions: ["stockcounts.read"] });
    await rejected(getHotelInventoryCostProposalHandler(request(input), services), "permission-denied");
    await db.doc(`hotels/hotel-a/members/${staff.uid}`).update({ permissions: ["stockcounts.read", "inventorymovements.create"] });
    const unknown = await getHotelInventoryCostProposalHandler(request(input), services);
    assert.equal(unknown.available, false); assert.equal(unknown.netUnitCost, null);
    await rejected(getHotelInventoryCostProposalHandler(request(input, platform), services), "permission-denied");
    await db.doc("hotelSubscriptions/hotel-a").update({ status: "canceled" });
    await rejected(getHotelInventoryCostProposalHandler(request(input), services), "permission-denied");
    await db.doc("hotelSubscriptions/hotel-a").update({ status: "active" });
    await auth.updateUser(staff.uid, { disabled: true });
    await rejected(getHotelInventoryCostProposalHandler(request(input), services), "permission-denied");
  });
  it("normal user mutates stable supplier identities while SKU edits leave cart/template/history links intact", async () => {
    const created = await offerCommand();
    await db.doc("hotels/hotel-a/shoppingCarts/historical").set({ items: [{ supplierProductId: created.productId }] });
    await db.doc("hotels/hotel-a/orders/historical").set({ products: [{ supplierProductId: created.productId, supplierSku: "WATER24", pricePerPurchaseUnit: 24 }] });
    await db.doc("hotels/hotel-a/locations/store/stockTemplates/legacy").set({ name: "Legacy", items: [{ supplierProductId: created.productId, outletId: "bar" }] });
    const updated = await offerCommand({ action: "update", productId: created.productId, expectedRevision: 1, product: offer({ supplierSku: "NEW-SKU" }) });
    assert.equal(updated.productId, created.productId);
    assert.equal((await db.doc(`hotels/hotel-a/supplierproducts/${created.productId}`).get()).data().supplierSku, "NEW-SKU");
    assert.equal((await db.doc("hotels/hotel-a/shoppingCarts/historical").get()).data().items[0].supplierProductId, created.productId);
    assert.equal((await db.doc("hotels/hotel-a/orders/historical").get()).data().products[0].supplierSku, "WATER24");
    assert.equal((await db.doc("hotels/hotel-a/locations/store/stockTemplates/legacy").get()).data().items[0].supplierProductId, created.productId);
    assert.equal((await db.collection("hotels/hotel-a/supplierproducts").get()).size, 1);
  });
  it("product create/import and same-hotel catalog references never inherit platform or other-hotel authority", async () => {
    await rejected(catalogCommand({}, outsider), "permission-denied"); await rejected(catalogCommand({}, platform), "permission-denied");
    await rejected(catalogCommand({ hotelUid: "hotel-b" }), "permission-denied");
    await db.doc("hotels/hotel-b/catalogproducts/foreign").set(catalog());
    await rejected(offerCommand({ product: offer({ catalogProductId: "foreign" }) }), "failed-precondition");
    const data = { hotelUid: "hotel-a", collection: "supplierproducts", requestId: next(), onExisting: "skip", products: [
      { expectedRevision: 0, product: offer() }, { expectedRevision: 0, product: offer({ supplierSku: "OTHER", pricePerPurchaseUnit: null }) }] };
    const result = await importHotelProductsHandler(request(data), services);
    assert.equal(result.imported, 2); assert.deepEqual(await importHotelProductsHandler(request(data), services), result);
    assert.equal((await db.collection("hotels/hotel-a/supplierproducts").get()).size, 2);
    await rejected(importHotelProductsHandler(request(data, outsider), services), "permission-denied");
    const failed = { ...data, requestId: next(), products: [{ expectedRevision: 0, product: offer({ supplierSku: "SAFE" }) }, { expectedRevision: 0, product: offer({ supplierSku: "BAD", pricePerPurchaseUnit: "12" }) }] };
    await rejected(importHotelProductsHandler(request(failed), services), "invalid-argument");
    assert.equal((await db.collection("hotels/hotel-a/supplierproducts").get()).size, 2);
  });
  it("unknown order prices remain unknown rather than free, but explicit zero may enter a cart", async () => {
    const unknown = await offerCommand({ product: offer({ pricePerPurchaseUnit: null }) });
    const cart = await mutateShoppingCartHandler(request({ hotelUid: "hotel-a", action: "get-or-create", requestId: next() }), services);
    await rejected(mutateShoppingCartHandler(request({ hotelUid: "hotel-a", cartId: cart.cartId, expectedRevision: cart.revision, action: "add", productId: unknown.productId, value: 1, requestId: next() }), services), "failed-precondition");
    await offerCommand({ action: "update", productId: unknown.productId, expectedRevision: 1, product: offer({ pricePerPurchaseUnit: 0 }) });
    await mutateShoppingCartHandler(request({ hotelUid: "hotel-a", cartId: cart.cartId, expectedRevision: cart.revision, action: "add", productId: unknown.productId, value: 1, requestId: next() }), services);
    assert.equal((await db.doc(`hotels/hotel-a/shoppingCarts/${cart.cartId}`).get()).data().items[0].pricePerPurchaseUnit, 0);
  });
  it("different packages survive cart/order/receipt and a changed package requires renewed review", async () => {
    const product = await offerCommand();
    const cart = await mutateShoppingCartHandler(request({ hotelUid: "hotel-a", action: "get-or-create", requestId: next() }), services);
    let revision = cart.revision;
    for (const purchaseOptionId of ["default", "bottle"]) {
      revision = (await mutateShoppingCartHandler(request({ hotelUid: "hotel-a", cartId: cart.cartId, expectedRevision: revision, action: "add", productId: product.productId, purchaseOptionId, value: 1, requestId: next() }), services)).revision;
      revision = (await mutateShoppingCartHandler(request({ hotelUid: "hotel-a", cartId: cart.cartId, expectedRevision: revision, action: "outlet", productId: product.productId, purchaseOptionId, value: "bar", requestId: next() }), services)).revision;
    }
    const created = await createOrdersFromCartHandler(request({ hotelUid: "hotel-a", shoppingCartId: cart.cartId, expectedCartRevision: revision, deliveryDate: "2026-10-12", requestId: next() }), services);
    assert.equal(created.orderIds.length, 1);
    const orderId = created.orderIds[0], orderRef = db.doc(`hotels/hotel-a/orders/${orderId}`), before = (await orderRef.get()).data();
    assert.equal(before.products.length, 2); assert.equal(before.totalAmount, 25.25);
    assert.notEqual(before.products[0].orderLineId, before.products[1].orderLineId);
    await offerCommand({ action: "update", productId: product.productId, expectedRevision: 1, product: offer({ baseUnitsPerPurchaseUnit: 12 }) });
    await rejected(confirmOrderHandler(request({ hotelUid: "hotel-a", orderId, expectedRevision: 1, requestId: next() }), services), "failed-precondition");
    assert.deepEqual((await orderRef.get()).data(), before);
    await orderRef.update({ status: "Ordered", dispatchStatus: "sent" }); // Fictional supplier dispatch, no mail is sent.
    await rejected(receipt({ orderId, inventoryLocationId: "store", lines: [{ supplierProductId: product.productId, acceptedQuantity: 1, rejectedQuantity: 0 }] }), "invalid-argument");
    const received = await receipt({ orderId, lines: before.products.map((line) => ({ supplierProductId: line.supplierProductId, orderLineId: line.orderLineId, acceptedQuantity: 1, rejectedQuantity: 0 })) });
    const movement = (await db.doc(`hotels/hotel-a/inventoryMovements/${received.eventId}`).get()).data();
    assert.equal(movement.lines.reduce((sum, line) => sum + line.quantity, 0), 25);
    assert.equal(movement.lines.reduce((sum, line) => sum + line.netValue, 0), 25.25);
  });
  it("mixed net/gross or net/unknown order bases reject creation without writes or cart consumption", async () => {
    const products = [];
    for (const [basis, vatRate] of [["net", null], ["gross", 0.06], ["unknown", null]]) {
      products.push(await offerCommand({ product: offer({ supplierSku: `BASIS-${basis}`, priceBasis: basis, vatRate }) }));
    }
    for (const other of products.slice(1)) {
      await db.doc("hotels/hotel-a/shoppingCarts/mixed-bases").set({ revision: 1, items: [products[0], other].map((product) => ({ supplierProductId: product.productId, outletId: "bar", qtyPurchaseUnits: 1 })) });
      const before = (await db.doc("hotels/hotel-a/shoppingCarts/mixed-bases").get()).data();
      await rejected(createOrdersFromCartHandler(request({ hotelUid: "hotel-a", shoppingCartId: "mixed-bases", expectedCartRevision: 1, deliveryDate: "2026-10-12", requestId: next() }), services), "failed-precondition");
      assert.deepEqual((await db.doc("hotels/hotel-a/shoppingCarts/mixed-bases").get()).data(), before);
      assert.equal((await db.collection("hotels/hotel-a/orders").get()).size, 0);
      assert.equal((await db.collection("hotels/hotel-a/orderOperations").get()).size, 0);
    }
  });
  it("uniform gross order snapshots raw purchase totals; update and legacy confirmation cannot mix bases", async () => {
    const first = await offerCommand({ product: offer({ supplierSku: "GROSS-A", pricePerPurchaseUnit: 25.44, priceBasis: "gross", vatRate: 0.06 }) });
    const second = await offerCommand({ product: offer({ supplierSku: "GROSS-B", pricePerPurchaseUnit: 12.72, priceBasis: "gross", vatRate: 0.06 }) });
    await db.doc("hotels/hotel-a/shoppingCarts/gross-bases").set({ revision: 1, items: [first, second].map((product) => ({ supplierProductId: product.productId, outletId: "bar", qtyPurchaseUnits: 1 })) });
    const created = await createOrdersFromCartHandler(request({ hotelUid: "hotel-a", shoppingCartId: "gross-bases", expectedCartRevision: 1, deliveryDate: "2026-10-12", requestId: next() }), services);
    const orderRef = db.doc(`hotels/hotel-a/orders/${created.orderIds[0]}`), frozen = (await orderRef.get()).data();
    assert.equal(frozen.priceBasis, "gross"); assert.equal(frozen.totalAmount, 38.16);
    assert.deepEqual(frozen.products.map((line) => line.pricePerPurchaseUnit), [25.44, 12.72]);
    assert.deepEqual(frozen.products.map((line) => line.netPricePerPurchaseUnit), [24, 12]);
    assert.equal((await db.doc("hotels/hotel-a/shoppingCarts/gross-bases").get()).data().items.length, 0);
    await offerCommand({ action: "update", productId: first.productId, expectedRevision: 1,
      product: offer({ supplierSku: "GROSS-A", pricePerPurchaseUnit: 25.44, priceBasis: "net", vatRate: null }) });
    await rejected(updateOrderHandler(request({ hotelUid: "hotel-a", orderId: orderRef.id, expectedRevision: 1,
      payload: { products: frozen.products } }), services), "failed-precondition");
    assert.deepEqual((await orderRef.get()).data(), frozen);
    // Historical orders did not freeze inventory terms or a top-level price
    // basis. Raw package/price fields match, so mixing must be rejected by the
    // uniform-basis check rather than incidental snapshot mismatch.
    const legacy = { ...frozen, products: frozen.products.map(({ inventoryTerms: _terms, ...line }) => line) };
    delete legacy.priceBasis;
    await orderRef.set(legacy);
    await rejected(confirmOrderHandler(request({ hotelUid: "hotel-a", orderId: orderRef.id, expectedRevision: 1, requestId: next() }), services), "failed-precondition");
    assert.deepEqual((await orderRef.get()).data(), legacy);
    assert.equal((await db.collection("hotels/hotel-a/dispatches").get()).size, 0);
  });
  it("confirmation checks an explicit top-level basis and keeps an absent historical basis unknown", async () => {
    const product = await offerCommand();
    const ref = db.doc("hotels/hotel-a/orders/historical-price-basis");
    const legacy = { status: "Created", revision: 1, supplierId: "vendor", supplierName: "Vendor", outletId: "bar", outletName: "Bar", currency: "EUR", priceBasis: "gross",
      deliveryDate: "2026-10-12", accountNumber: "", totalAmount: 24,
      products: [{ supplierProductId: product.productId, purchaseOptionId: "default", supplierId: "vendor", supplierSku: "WATER24",
        qtyPurchaseUnits: 1, purchaseUnit: "Crate of 24", baseUnit: "each", baseUnitsPerPurchaseUnit: 24, pricePerPurchaseUnit: 24, currency: "EUR" }] };
    await ref.set(legacy);
    await rejected(confirmOrderHandler(request({ hotelUid: "hotel-a", orderId: ref.id, expectedRevision: 1, requestId: next() }), services), "failed-precondition");
    assert.deepEqual((await ref.get()).data(), legacy);
    assert.equal((await db.collection("hotels/hotel-a/dispatches").get()).size, 0);
    delete legacy.priceBasis; await ref.set(legacy);
    const result = await confirmOrderHandler(request({ hotelUid: "hotel-a", orderId: ref.id, expectedRevision: 1, requestId: next() }), services);
    assert.equal((await db.doc(`hotels/hotel-a/dispatches/${result.dispatchId}`).get()).data().order.priceBasis, "unknown");
    assert.equal((await ref.get()).data().priceBasis, undefined);
  });
  it("protected templates support same-hotel updates, exact retry, stale detection and deliberate legacy removal", async () => {
    const created = await template();
    const input = { hotelUid: "hotel-a", locationId: "store", templateId: "new", action: "add-item", expectedRevision: created.revision, requestId: next(), item: { catalogProductId: "water" } };
    const added = await mutateHotelStockTemplateHandler(request(input), services);
    assert.deepEqual(await mutateHotelStockTemplateHandler(request(input), services), added);
    await rejected(template({ action: "rename", expectedRevision: 1, name: "Stale" }), "aborted");
    await rejected(template({ hotelUid: "hotel-b" }), "permission-denied");
    await rejected(template({}, platform), "permission-denied");
    await db.doc("hotels/hotel-b/catalogproducts/foreign").set(catalog());
    await rejected(template({ action: "add-item", expectedRevision: 2, item: { catalogProductId: "foreign" } }), "failed-precondition");
    await db.doc("hotels/hotel-a/locations/store/stockTemplates/old").set({ name: "Old", items: [{ supplierProductId: "missing", outletId: "bar" }] });
    await template({ templateId: "old", action: "replace-items", expectedRevision: 0, items: [{ catalogProductId: "water" }], name: undefined });
    assert.deepEqual((await db.doc("hotels/hotel-a/locations/store/stockTemplates/old").get()).data().items, [{ catalogProductId: "water" }]);
  });
  it("all browser product/template/inventory mutation paths deny ordinary users and platform administrators", async () => {
    const created = await offerCommand();
    await assertSucceeds(getDoc(doc(client(), "hotels/hotel-a/catalogproducts/water")));
    const paths = [`catalogproducts/water`, `supplierproducts/${created.productId}`, "locations/store/stockTemplates/weekly", "productSkuKeys/forged", "productOperations/forged",
      "inventoryMovements/forged", "inventoryCheckpoints/forged", "inventoryLocationStates/store", "inventoryReversals/forged", "inventoryPeriodReports/forged", "stockTemplateOperations/forged"];
    for (const actor of [staff, platform]) for (const path of paths) {
      await assertFails(setDoc(doc(client(actor), `hotels/hotel-a/${path}`), { forged: true }));
      await assertFails(updateDoc(doc(client(actor), `hotels/hotel-a/${path}`), { forged: true }));
      await assertFails(deleteDoc(doc(client(actor), `hotels/hotel-a/${path}`)));
    }
    await assertFails(getDoc(doc(client(outsider), "hotels/hotel-a/catalogproducts/water")));
  });
  it("one bottle is counted as exactly one each, independent of supplier packs and unknown prices", async () => {
    const a = await offerCommand({ product: offer({ pricePerPurchaseUnit: null }) });
    const b = await offerCommand({ product: offer({ supplierSku: "WATER6", baseUnitsPerPurchaseUnit: 6, pricePerPurchaseUnit: 9 }) });
    await db.doc("hotels/hotel-a/locations/store/stockTemplates/weekly").set({ name: "Weekly", items: [
      { supplierProductId: a.productId, outletId: "bar" }, { supplierProductId: b.productId, outletId: "bar" }] });
    const id = await count(1);
    const location = (await db.doc(`hotels/hotel-a/stockCounts/${id}/locations/store`).get()).data();
    assert.equal(location.stockTemplate.items.length, 1); assert.equal(location.countedItems.length, 1);
    assert.equal(location.countedItems[0].quantity, 1); assert.equal(location.countedItems[0].baseUnit, "each");
    assert.equal(location.countedValue, null); assert.equal(location.costComplete, false);
  });
  it("incomplete new and legacy counts cannot finish; explicit zero is a valid completed count", async () => {
    const created = await createHotelStockCountHandler(request({ hotelUid: "hotel-a", name: "Incomplete", type: "Weekly", requestId: next(), businessDate: "2026-10-10", locations: [{ locationId: "store", stockTemplateId: "weekly" }] }), services);
    await rejected(mutateHotelStockCountHandler(request({ hotelUid: "hotel-a", stockCountId: created.stockCountId, expectedRevision: 0, action: "finish-location", locationId: "store", countedItems: [] }), services), "failed-precondition");
    const id = "legacy-unfinished";
    await db.doc(`hotels/hotel-a/stockCounts/${id}`).set({ name: "Historical", type: "Weekly", status: "Started", revision: 0, locations: [{ locationId: "store", status: "Not Started" }] });
    await db.doc(`hotels/hotel-a/stockCounts/${id}/locations/store`).set({ status: "Not Started", locationName: "Store", stockTemplate: { items: [
      { supplierProductId: "old-a", outletId: "bar", pricePerPurchaseUnit: 3 }, { supplierProductId: "old-b", outletId: "bar", pricePerPurchaseUnit: 4 }] }, countedItems: [] });
    await rejected(mutateHotelStockCountHandler(request({ hotelUid: "hotel-a", stockCountId: id, expectedRevision: 0, action: "finish-location", locationId: "store", countedItems: [
      { supplierProductId: "old-a", outletId: "bar", quantity: 0, isCounted: true }] }), services), "failed-precondition");
    const zeroId = await count(0); assert.equal((await db.doc(`hotels/hotel-a/stockCounts/${zeroId}`).get()).data().countedValue, 0);
  });
  it("immutable finished counts and frozen unit/cost snapshots do not change with catalog/supplier edits", async () => {
    const id = await count(10, "2026-10-10", 2), ref = db.doc(`hotels/hotel-a/stockCounts/${id}/locations/store`), before = (await ref.get()).data();
    await catalogCommand({ action: "update", productId: "water", expectedRevision: 1, product: catalog({ name: "Renamed" }) });
    await rejected(mutateHotelStockCountHandler(request({ hotelUid: "hotel-a", stockCountId: id, expectedRevision: 2, action: "save-location", locationId: "store", countedItems: [{ catalogProductId: "water", quantity: 999, isCounted: true, unitCost: 99 }] }), services), "failed-precondition");
    assert.deepEqual((await ref.get()).data(), before);
  });
  it("accepted receipts require this hotel's physical location; rejected goods alone make no stock movement", async () => {
    await frozenOrder();
    await rejected(receipt({ inventoryLocationId: undefined }), "invalid-argument");
    await db.doc("hotels/hotel-b/locations/foreign").set({ name: "Foreign store" });
    await rejected(receipt({ inventoryLocationId: "foreign" }), "failed-precondition");
    await rejected(receipt({}, outsider), "permission-denied");
    await receipt({ inventoryLocationId: undefined, lines: [{ supplierProductId: "water-offer", orderLineId: "water-line", acceptedQuantity: 0, rejectedQuantity: 1, reason: "Damaged" }] });
    assert.equal((await db.collection("hotels/hotel-a/inventoryMovements").get()).size, 0);
    assert.equal((await db.doc("hotels/hotel-a/orders/receipt-order").get()).data().receiving.lines[0].acceptedQuantity, 0);
  });
  it("receipt plus reversal is atomic, immutable, deduplicated and offsets accepted quantities/cost only", async () => {
    await frozenOrder();
    const command = { requestId: next(), deliveryReference: "Physical-DN", lines: [{ supplierProductId: "water-offer", orderLineId: "water-line", acceptedQuantity: 1.25, rejectedQuantity: 0.25, reason: "Broken" }] };
    const first = await receipt(command); assert.deepEqual(await receipt(command), first);
    const originalRef = db.doc(`hotels/hotel-a/inventoryMovements/${first.eventId}`), original = (await originalRef.get()).data();
    assert.equal(original.lines[0].quantity, 30); assert.equal(original.lines[0].netValue, 30);
    assert.equal((await db.collection("hotels/hotel-a/inventoryMovements").get()).size, 1);
    const input = { hotelUid: "hotel-a", orderId: "receipt-order", receiptId: first.eventId, requestId: next(), expectedRevision: 2, reason: "Incorrect delivery entry" };
    const reversed = await reverseHotelOrderReceiptHandler(request(input), services);
    assert.deepEqual(await reverseHotelOrderReceiptHandler(request(input), services), reversed);
    const compensating = (await db.doc(`hotels/hotel-a/inventoryMovements/${reversed.eventId}`).get()).data();
    assert.equal(compensating.lines[0].quantity, -30); assert.equal(compensating.lines[0].netValue, -30);
    assert.deepEqual((await originalRef.get()).data(), original);
    await rejected(reverseHotelOrderReceiptHandler(request({ ...input, requestId: next(), expectedRevision: 3 }), services), "already-exists");
    assert.equal((await db.collection("hotels/hotel-a/inventoryMovements").get()).size, 2);
  });
  it("100 opening +30 accepted receipt -80 closing proves 50 inferred usage without a live-stock claim", async () => {
    const opening = await count(100, "2026-10-10", 1); await frozenOrder(); await receipt();
    const closing = await count(80, "2026-10-12", 1), report = await period(opening, closing);
    assert.equal(report.items[0].openingQuantity, 100); assert.equal(report.items[0].netReceiptQuantity, 30);
    assert.equal(report.items[0].closingQuantity, 80); assert.equal(report.items[0].inferredUsageQuantity, 50);
    assert.equal(report.items[0].periodUnitCost, 1); assert.equal(report.items[0].inferredUsageValue, 50);
    assert.deepEqual(report.coverage, { quantityComplete: true, costComplete: true, issues: [] });
    assert.match(report.costBasis, /not.*live/i);
    assert.deepEqual(await period(opening, closing), report);
    await rejected(period(opening, closing, {}, outsider), "permission-denied");
    await rejected(period(opening, closing, { hotelUid: "hotel-b" }), "permission-denied");
  });
  it("mixed currencies and absent opening/receipt cost retain valid quantities but never invented values", async () => {
    for (const variant of ["currency", "opening", "receipt"]) {
      await environment.clearFirestore();
      // Keep identity, member and entitlement; only isolate each period evidence.
      await db.doc("hotels/hotel-a").set({ name: "A", currency: "EUR", timeZone: "Europe/Brussels" });
      await db.doc("hotels/hotel-a/settings/bootstrap").set({ currency: "EUR" });
      await db.doc("hotelSubscriptions/hotel-a").set({ status: "active", validUntil: null, modules: ["procurement"], modulePolicyVersion: 1 });
      await db.doc(`hotels/hotel-a/members/${staff.uid}`).set({ permissions: ["stockcounts.*", "orders.receive"] });
      await db.doc("platformConfiguration/saasProcurement").set({ enabled: true, rulesVersion: SAAS_RULES_VERSION });
      await db.doc("hotels/hotel-a/catalogproducts/water").set(catalog());
      await db.doc("hotels/hotel-a/locations/store").set({ name: "Store" });
      await db.doc("hotels/hotel-a/locations/store/stockTemplates/weekly").set({ name: "Weekly", items: [{ catalogProductId: "water" }] });
      const opening = await count(100, "2026-10-10", variant === "opening" ? null : 1);
      await frozenOrder({ currency: variant === "currency" ? "USD" : "EUR", netPrice: variant === "receipt" ? null : 24 }); await receipt();
      const closing = await count(80, "2026-10-12", 1), report = await period(opening, closing);
      assert.equal(report.items[0].inferredUsageQuantity, 50); assert.equal(report.items[0].inferredUsageValue, null, variant);
      assert.equal(report.items[0].periodUnitCost, null, variant); assert.equal(report.coverage.costComplete, false);
    }
  });
  it("late/backdated entries flag current coverage and do not rewrite the saved closed-period result", async () => {
    const opening = await count(100, "2026-10-10", 1), closing = await count(80, "2026-10-12", 1);
    const before = await period(opening, closing); assert.equal(before.items[0].inferredUsageQuantity, 20);
    await frozenOrder(); await receipt({ receivedOn: "2026-10-11" });
    const after = await period(opening, closing);
    assert.deepEqual(after.items, before.items); assert.deepEqual(after.coverage, before.coverage);
    assert.equal(after.currentlyComplete, false); assert.equal(after.postClosureIssues[0].code, "late-posting-after-closing");
  });
  it("stale verified tokens cannot mutate products/templates/counts/receipts after current Auth revocation", async () => {
    await frozenOrder(); await auth.updateUser(staff.uid, { disabled: true });
    await rejected(catalogCommand(), "permission-denied"); await rejected(template(), "permission-denied");
    await rejected(createHotelStockCountHandler(request({ hotelUid: "hotel-a", name: "Blocked", type: "Weekly", requestId: next(), businessDate: "2026-10-10", locations: [{ locationId: "store", stockTemplateId: "weekly" }] }), services), "permission-denied");
    await rejected(receipt(), "permission-denied");
    assert.equal((await db.collection("hotels/hotel-a/inventoryMovements").get()).size, 0);
  });
  it("real concurrent SKU claims yield one stable supplier identity", async () => {
    const outcomes = await Promise.allSettled([offerCommand(), offerCommand()]);
    assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(outcomes.find((result) => result.status === "rejected").reason.code, "already-exists");
    assert.equal((await db.collection("hotels/hotel-a/supplierproducts").get()).size, 1);
    assert.equal((await db.collection("hotels/hotel-a/productSkuKeys").get()).size, 1);
  });
  it("real concurrent receipts with one order revision yield one receipt and one atomic movement", async () => {
    await frozenOrder();
    const outcomes = await Promise.allSettled([receipt(), receipt()]);
    assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(outcomes.find((result) => result.status === "rejected").reason.code, "aborted");
    assert.equal((await db.collection("hotels/hotel-a/inventoryMovements").get()).size, 1);
    assert.equal((await db.collection("hotels/hotel-a/orders/receipt-order/receipts").get()).size, 1);
    assert.equal((await db.doc("hotels/hotel-a/inventoryLocationStates/store").get()).data().sequence, 1);
  });
  it("receipt racing count finalization serializes location postings and exposes the ambiguous physical cutoff", async () => {
    const opening = await count(100, "2026-10-10", 1); await frozenOrder();
    const closing = await createHotelStockCountHandler(request({ hotelUid: "hotel-a", name: "Closing physical count", type: "Weekly", requestId: next(), businessDate: "2026-10-12",
      locations: [{ locationId: "store", stockTemplateId: "weekly" }] }), services);
    const finished = mutateHotelStockCountHandler(request({ hotelUid: "hotel-a", stockCountId: closing.stockCountId, action: "finish-location", expectedRevision: 0,
      locationId: "store", countedItems: [{ catalogProductId: "water", quantity: 80, unitCost: 1, isCounted: true }] }), services);
    const received = receipt();
    await Promise.all([finished, received]);
    await mutateHotelStockCountHandler(request({ hotelUid: "hotel-a", stockCountId: closing.stockCountId, action: "finish-count", expectedRevision: 1 }), services);
    const checkpoints = (await db.collection("hotels/hotel-a/inventoryCheckpoints").get()).docs.map((doc) => doc.data());
    const movements = (await db.collection("hotels/hotel-a/inventoryMovements").get()).docs.map((doc) => doc.data());
    assert.deepEqual([...checkpoints, ...movements].map((item) => item.sequence).sort((a, b) => a - b), [1, 2, 3]);
    assert.equal(movements[0].lines[0].quantity, 30);
    assert.equal((await db.doc("hotels/hotel-a/inventoryLocationStates/store").get()).data().sequence, 3);
    const report = await period(opening, closing.stockCountId);
    assert.equal(report.currentlyComplete, false);
    assert.ok(report.coverage.issues.some((issue) => issue.code === "postings-during-count") || report.postClosureIssues.some((issue) => issue.code === "late-posting-after-closing"));
  });
  it("transaction retries recheck current Auth after revocation instead of caching the first attempt", async () => {
    const created = await offerCommand();
    await db.doc("hotels/hotel-a/shoppingCarts/retry-cart").set({ revision: 0, items: [{ supplierProductId: created.productId, outletId: "bar", qtyPurchaseUnits: 1 }] });
    const cases = [
      (retryServices) => mutateHotelCatalogProductHandler(request({ hotelUid: "hotel-a", action: "create", expectedRevision: 0, requestId: next(), product: catalog() }), retryServices),
      (retryServices) => mutateHotelStockTemplateHandler(request({ hotelUid: "hotel-a", locationId: "store", templateId: "retry", action: "create", expectedRevision: 0, requestId: next(), name: "Retry" }), retryServices),
      (retryServices) => createHotelStockCountHandler(request({ hotelUid: "hotel-a", name: "Retry", type: "Weekly", requestId: next(), businessDate: "2026-10-10", locations: [{ locationId: "store", stockTemplateId: "weekly" }] }), retryServices),
      (retryServices) => mutateShoppingCartHandler(request({ hotelUid: "hotel-a", action: "get-or-create", requestId: next() }), retryServices),
      (retryServices) => createOrdersFromCartHandler(request({ hotelUid: "hotel-a", shoppingCartId: "retry-cart", expectedCartRevision: 0, deliveryDate: "2026-10-12", requestId: next() }), retryServices),
    ];
    for (const command of cases) {
      await auth.updateUser(staff.uid, { disabled: false });
      let attempted = 0;
      const retryDb = { doc: (...args) => db.doc(...args), collection: (...args) => db.collection(...args),
        runTransaction: (callback, ...options) => db.runTransaction(async (tx) => {
          attempted++;
          const result = await callback(tx);
          if (attempted === 1) {
            await auth.updateUser(staff.uid, { disabled: true });
            // Force the real SDK retry path after a successful staged attempt.
            // The staged writes are rolled back, then the same command retries.
            const conflict = new Error("Injected transaction conflict"); conflict.code = 10; throw conflict;
          }
          return result;
        }, ...options) };
      await rejected(command({ ...services, firestore: retryDb }), "permission-denied");
      assert.equal(attempted, 2);
    }
    assert.equal((await db.collection("hotels/hotel-a/stockCounts").get()).size, 0);
    assert.equal((await db.collection("hotels/hotel-a/orders").get()).size, 0);
    assert.equal((await db.doc("hotels/hotel-a/locations/store/stockTemplates/retry").get()).exists, false);
    assert.equal((await db.collection("hotels/hotel-a/catalogproducts").get()).size, 1);
  });
  it("archived and empty templates cannot start new counts; existing count snapshots remain usable", async () => {
    const payload = { hotelUid: "hotel-a", name: "Snapshot before archive", type: "Weekly", businessDate: "2026-10-10", locations: [{ locationId: "store", stockTemplateId: "weekly" }] };
    const existing = await createHotelStockCountHandler(request({ ...payload, requestId: next() }), services);
    await template({ templateId: "weekly", action: "archive", expectedRevision: 0 });
    await rejected(createHotelStockCountHandler(request({ ...payload, requestId: next() }), services), "failed-precondition");
    const sources = await listHotelStockCountSourcesHandler(request({ hotelUid: "hotel-a" }), services);
    assert.equal(sources.locations[0].templates.some((item) => item.id === "weekly"), false);
    await template({ templateId: "empty", name: "Empty" });
    // Empty stored template items fail the bounded input contract before writes.
    await rejected(createHotelStockCountHandler(request({ ...payload, requestId: next(), locations: [{ locationId: "store", stockTemplateId: "empty" }] }), services), "invalid-argument");
    assert.equal((await db.collection("hotels/hotel-a/stockCounts").get()).size, 1);
    await mutateHotelStockCountHandler(request({ hotelUid: "hotel-a", stockCountId: existing.stockCountId, action: "finish-location", expectedRevision: 0,
      locationId: "store", countedItems: [{ catalogProductId: "water", quantity: 1, unitCost: 1, isCounted: true }] }), services);
    assert.equal((await db.doc(`hotels/hotel-a/stockCounts/${existing.stockCountId}/locations/store`).get()).data().status, "Finished");
  });
  it("generic imports cannot overwrite product contracts/templates/immutable inventory evidence", () => {
    for (const path of ["catalogproducts/water", "supplierproducts/offer", "productOperations/spoof", "productSkuKeys/spoof", "inventoryMovements/spoof",
      "inventoryLocationStates/store", "inventoryCheckpoints/spoof", "inventoryReversals/spoof", "inventoryPeriodReports/spoof", "stockTemplateOperations/spoof"]) {
      assert.throws(() => requireHotelImportTarget(`hotels/hotel-a/${path}`, "hotel-a"), /authorized hotel/i, path);
    }
    for (const path of ["locations/store", "locations/store/stockTemplates/weekly", "procurementResourceOperations/spoof", "procurementResourceAudit/spoof"]) {
      assert.throws(() => requireHotelImportTarget(`hotels/hotel-a/${path}`, "hotel-a"), /protected procurement resources or command evidence/i, path);
    }
    assert.doesNotThrow(() => requireHotelImportTarget("hotels/hotel-a/arrivals/example", "hotel-a"));
  });
});
