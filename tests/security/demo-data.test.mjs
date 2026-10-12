import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { before, beforeEach, after, test } from "node:test";
import assert from "node:assert/strict";
import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc } from "firebase/firestore";
if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) throw new Error("Only local emulators are allowed.");
const projectId = "demo-hotel-suite-a00";
process.env.FIREBASE_CONFIG = JSON.stringify({ projectId, storageBucket: `${projectId}.appspot.com` });
const require = createRequire(import.meta.url);
const { admin } = require("../../functions/src/config");
const { manageHotelDemoData } = require("../../functions/src/demoData");
const { TEST_HOTEL_UID, DATASET_ID, SUPPLIER_IDS, manifestPath } = require("../../functions/src/demoDataPolicy");
const { SAAS_RULES_VERSION } = require("../../functions/src/saasRollout");
const { getHotelInventoryPeriodHandler } = require("../../functions/src/inventoryReports");
const { createHotelStockCountHandler, mutateHotelStockCountHandler } = require("../../functions/src/stockCounts");
const { confirmOrderHandler, createOrdersFromCartHandler } = require("../../functions/src/orders");
const { recordHotelOrderReceiptHandler } = require("../../functions/src/orderReceiving");
const { dispatchOrderHandler } = require("../../functions/src/sftpDispatch");
const db = admin.firestore(), auth = admin.auth();
const operator = { uid: "seed-operator", token: { platformAdmin: true, email_verified: true, email: "operator@example.test" } };
const staff = { uid: "seed-counter", token: { email_verified: true, email: "counter@example.test" } };
const outsider = { uid: "seed-outsider", token: { email_verified: true, email: "outsider@example.test" } };
const req = (actor, data) => ({ auth: actor, data });
const seed = (action = "apply", actor = operator, extra = {}) => manageHotelDemoData.run(req(actor, { hotelUid: TEST_HOTEL_UID, datasetId: DATASET_ID, action, ...extra }));
const services = { firestore: db, auth };
const denied = (promise, code) => assert.rejects(promise, { code });
let environment;
before(async () => { environment = await initializeTestEnvironment({ projectId,
  firestore: { host: "127.0.0.1", port: 8080, rules: await readFile("firebase/firestore.rules", "utf8") } }); });
beforeEach(async () => {
  await environment.clearFirestore();
  const current = await auth.listUsers(); if (current.users.length) await auth.deleteUsers(current.users.map((u) => u.uid));
  for (const actor of [operator, staff, outsider]) {
    await auth.createUser({ uid: actor.uid, email: actor.token.email, emailVerified: true });
    if (actor.token.platformAdmin) await auth.setCustomUserClaims(actor.uid, { platformAdmin: true });
    await db.doc(`users/${actor.uid}`).set({ hotelUid: actor === operator ? [] : [actor === staff ? TEST_HOTEL_UID : "real-hotel"] });
  }
  await db.doc("platformConfiguration/saasProcurement").set({ enabled: true, rulesVersion: SAAS_RULES_VERSION });
  await db.doc(`hotels/${TEST_HOTEL_UID}`).set({ name: "Test hotel", timeZone: "Europe/Brussels" });
  await db.doc(`hotels/${TEST_HOTEL_UID}/settings/bootstrap`).set({ currency: "EUR" });
  for (const id of [TEST_HOTEL_UID, "real-hotel"]) await db.doc(`hotelSubscriptions/${id}`).set({ status: "active", validUntil: null, modules: ["procurement"], modulePolicyVersion: 1 });
  await db.doc(`hotels/${TEST_HOTEL_UID}/members/${staff.uid}`).set({ hotelAdmin: true, permissions: ["catalogproducts.*", "supplierproducts.*", "suppliers.*", "outlets.*", "locations.*", "orders.*", "orders.receive", "orders.finalize", "stockcounts.*"] });
  await db.doc(`hotels/real-hotel/members/${outsider.uid}`).set({ permissions: ["catalogproducts.*", "orders.*", "stockcounts.*"] });
  await db.doc("hotels/real-hotel/catalogproducts/untouched").set({ name: "Real article" });
});
after(async () => environment.cleanup());

test("zero-hotel platform operator atomically seeds and ordinary users read the right hotel only", async () => {
  const preview = await seed("preview"); assert.equal(preview.canApply, true);
  assert.equal((await db.collection(`hotels/${TEST_HOTEL_UID}/catalogproducts`).get()).size, 0);
  const loaded = await seed(); assert.equal(loaded.summary.catalogProducts, 12); assert.equal(loaded.summary.approvers, 1);
  assert.deepEqual((await db.doc(`users/${operator.uid}`).get()).data().hotelUid, []);
  assert.equal((await db.doc(`hotels/${TEST_HOTEL_UID}/members/${operator.uid}`).get()).exists, false);
  assert.deepEqual((await db.doc("hotels/real-hotel/catalogproducts/untouched").get()).data(), { name: "Real article" });
  assert.equal((await db.collection("platformAudit").get()).size, 1);
  assert.equal((await db.collection(`hotels/${TEST_HOTEL_UID}/mailQueue`).get()).size, 0);
  const own = environment.authenticatedContext(staff.uid, staff.token).firestore(), foreign = environment.authenticatedContext(outsider.uid, outsider.token).firestore();
  await assertSucceeds(getDoc(doc(own, `hotels/${TEST_HOTEL_UID}/catalogproducts/demo-v1-catalog-milk`)));
  await assertFails(getDoc(doc(foreign, `hotels/${TEST_HOTEL_UID}/catalogproducts/demo-v1-catalog-milk`)));
  await assertFails(getDoc(doc(own, manifestPath(TEST_HOTEL_UID))));
  await assertFails(setDoc(doc(own, manifestPath(TEST_HOTEL_UID)), { status: "complete" }));
});
test("normal/hotel admins, arbitrary targets and revoked live platform authority cannot seed", async () => {
  await denied(seed("apply", staff), "permission-denied");
  await denied(seed("apply", operator, { hotelUid: "real-hotel" }), "invalid-argument");
  await denied(seed("apply", operator, { datasetId: "future-version" }), "invalid-argument");
  await auth.setCustomUserClaims(operator.uid, {});
  await denied(seed(), "permission-denied");
  await auth.setCustomUserClaims(operator.uid, { platformAdmin: true });
  await auth.updateUser(operator.uid, { disabled: true });
  await denied(seed(), "permission-denied");
  assert.equal((await db.collection(`hotels/${TEST_HOTEL_UID}/catalogproducts`).get()).size, 0);
});
test("disabled release/module and existing IDs fail without partial writes", async () => {
  await db.doc("platformConfiguration/saasProcurement").update({ enabled: false }); await denied(seed(), "failed-precondition");
  await db.doc("platformConfiguration/saasProcurement").update({ enabled: true });
  await db.doc(`hotelSubscriptions/${TEST_HOTEL_UID}`).update({ modules: [] }); await denied(seed(), "permission-denied");
  await db.doc(`hotelSubscriptions/${TEST_HOTEL_UID}`).update({ modules: ["procurement"] });
  const collision = db.doc(`hotels/${TEST_HOTEL_UID}/orders/demo-v1-order-draft-pantry`); await collision.set({ keep: true });
  assert.equal((await seed("preview")).canApply, false); await denied(seed(), "already-exists");
  assert.equal((await db.collection(`hotels/${TEST_HOTEL_UID}/catalogproducts`).get()).size, 0);
  assert.deepEqual((await collision.get()).data(), { keep: true });
});
test("concurrent apply converges once and later replays preserve user edits and evidence update times", async () => {
  const results = await Promise.all([seed(), seed()]); assert(results.some((r) => r.alreadyLoaded));
  const product = db.doc(`hotels/${TEST_HOTEL_UID}/catalogproducts/demo-v1-catalog-milk`);
  await product.update({ name: "Edited test milk" });
  const ref = db.doc(manifestPath(TEST_HOTEL_UID)), before = await ref.get();
  const repeated = await seed(); assert.equal(repeated.alreadyLoaded, true);
  assert.equal((await product.get()).data().name, "Edited test milk");
  assert((await ref.get()).updateTime.isEqual(before.updateTime));
  assert.equal((await db.collection("platformAudit").get()).size, 1);
});
test("ordinary stock user obtains the actual reconciled 50-litre period and unknown-cost bar example", async () => {
  const loaded = await seed();
  const common = { hotelUid: TEST_HOTEL_UID, openingStockCountId: loaded.summary.openingStockCountId, closingStockCountId: loaded.summary.closingStockCountId };
  const report = await getHotelInventoryPeriodHandler(req(staff, { ...common, locationId: loaded.summary.periodLocationId }), services);
  const milk = report.items.find((item) => item.catalogProductId === loaded.summary.milkCatalogProductId);
  assert.equal(report.currentlyComplete, true); assert.equal(milk.inferredUsageQuantity, 50); assert.equal(milk.periodUnitCost, 290 / 130);
  const bar = await getHotelInventoryPeriodHandler(req(staff, { ...common, locationId: "demo-v1-location-2" }), services);
  assert.equal(bar.coverage.quantityComplete, true); assert.equal(bar.coverage.costComplete, false);
  assert.equal(bar.items.find((i) => i.catalogProductId === "demo-v1-catalog-water").netReceiptQuantity, 12);
  await denied(getHotelInventoryPeriodHandler(req(outsider, { ...common, locationId: loaded.summary.periodLocationId }), services), "permission-denied");
});
test("normal approver confirms a draft through the existing protected workflow without outbound delivery", async () => {
  await seed(); const orderId = "demo-v1-order-draft-breakfast";
  // Edited real contacts remain unable to override the private demo mode.
  await db.doc(`hotels/${TEST_HOTEL_UID}/suppliers/${SUPPLIER_IDS[0]}`).update({ orderEmail: "someone@example.test" });
  const confirmed = await confirmOrderHandler(req(staff, { hotelUid: TEST_HOTEL_UID, orderId, expectedRevision: 1, requestId: "demo-confirm" }), services);
  assert.equal(confirmed.status, "sent");
  const order = (await db.doc(`hotels/${TEST_HOTEL_UID}/orders/${orderId}`).get()).data();
  assert.equal(order.status, "Ordered"); assert.equal(order.dispatchMode, "simulation");
  assert.equal((await db.doc(`hotels/${TEST_HOTEL_UID}/dispatches/${confirmed.dispatchId}`).get()).data().status, "simulated");
  let sends = 0;
  await dispatchOrderHandler({ params: { hotelUid: TEST_HOTEL_UID, orderId }, data: { before: { exists: false }, after: { exists: true, data: () => order } } },
    { ...services, enqueueEmail: async () => { sends++; }, sendSftp: async () => { sends++; } });
  assert.equal(sends, 0); assert.equal((await db.collection(`hotels/${TEST_HOTEL_UID}/mailQueue`).get()).size, 0);
  await recordHotelOrderReceiptHandler(req(staff, { hotelUid: TEST_HOTEL_UID, orderId, expectedRevision: 2, requestId: "new-receipt",
    receivedOn: order.deliveryDate, deliveryReference: "TEST-NEW-DELIVERY", inventoryLocationId: "demo-v1-location-1",
    lines: order.products.map((p) => ({ supplierProductId: p.supplierProductId, orderLineId: p.orderLineId, acceptedQuantity: p.qtyPurchaseUnits, rejectedQuantity: 0 })) }), services);
  assert.equal((await db.doc(`hotels/${TEST_HOTEL_UID}/orders/${orderId}`).get()).data().status, "Received");
});
test("seed templates and in-progress counts support ordinary creation/save and enforce completeness", async () => {
  await seed();
  const created = await createHotelStockCountHandler(req(staff, { hotelUid: TEST_HOTEL_UID, requestId: "new-count", name: "Test count", type: "Ad Hoc",
    locations: [{ locationId: "demo-v1-location-1", stockTemplateId: "demo-v1-template-1" }] }), services);
  assert.equal(created.inventoryPolicyVersion, 1);
  const payload = { hotelUid: TEST_HOTEL_UID, stockCountId: "demo-v1-count-in-progress", locationId: "demo-v1-location-1", expectedRevision: 0,
    countedItems: [{ catalogProductId: "demo-v1-catalog-milk", quantity: 72.5, unitCost: 2, isCounted: true }] };
  await denied(mutateHotelStockCountHandler(req(staff, { ...payload, action: "finish-location" }), services), "failed-precondition");
  await mutateHotelStockCountHandler(req(staff, { ...payload, action: "save-location" }), services);
  assert.equal((await db.doc(`hotels/${TEST_HOTEL_UID}/stockCounts/demo-v1-count-in-progress/locations/demo-v1-location-1`).get()).data().countedItems[0].quantity, 72.5);
});
test("dispatch worker checks the claimed supplier too and blocks malformed pending demo delivery", async () => {
  await seed(); const orderId = "demo-v1-order-draft-breakfast", dispatchId = "malformed-demo-dispatch";
  const ref = db.doc(`hotels/${TEST_HOTEL_UID}/orders/${orderId}`), initial = (await ref.get()).data();
  const after = { ...initial, supplierId: "unrelated-public-id", dispatchRequestId: dispatchId, dispatchStatus: "pending" };
  await ref.set(after);
  await db.doc(`hotels/${TEST_HOTEL_UID}/dispatches/${dispatchId}`).set({ orderId, actorUid: staff.uid, status: "pending",
    order: { ...initial, outletId: "demo-v1-outlet-1" }, supplier: { id: SUPPLIER_IDS[0], orderSystem: "Email", orderEmail: "someone@example.test" } });
  let sends = 0;
  await dispatchOrderHandler({ params: { hotelUid: TEST_HOTEL_UID, orderId }, data: { before: { exists: false }, after: { exists: true, data: () => after } } },
    { ...services, enqueueEmail: async () => { sends++; }, sendSftp: async () => { sends++; } });
  assert.equal(sends, 0); assert.equal((await ref.get()).data().dispatchStatus, "blocked");
});

test("new orders from demo purchase options expose simulation before confirmation", async () => {
  await seed();
  await db.doc(`hotels/${TEST_HOTEL_UID}/shoppingCarts/test-cart`).set({ revision: 0, items: [{ supplierProductId: "demo-v1-offer-milk-case", outletId: "demo-v1-outlet-1", purchaseOptionId: "single", qtyPurchaseUnits: 2 }] });
  const created = await createOrdersFromCartHandler(req(staff, { hotelUid: TEST_HOTEL_UID, shoppingCartId: "test-cart", expectedCartRevision: 0,
    requestId: "new-demo-option", deliveryDate: "2026-10-15" }), services);
  const order = (await db.doc(`hotels/${TEST_HOTEL_UID}/orders/${created.orderIds[0]}`).get()).data();
  assert.equal(order.dispatchMode, "simulation"); assert.equal(order.status, "Created");
  assert.equal(order.products[0].purchaseOptionId, "single"); assert.equal(order.products[0].inventoryTerms.catalogUnitsPerPurchaseUnit, 1);
  assert.equal(order.totalAmount, 7);
});
