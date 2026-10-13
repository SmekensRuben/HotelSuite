import { before, beforeEach, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { initializeTestEnvironment, assertFails } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, updateDoc, deleteDoc } from "firebase/firestore";
const projectId = "demo-hotel-suite-a00";
if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) throw new Error("Local Auth and Firestore emulators are required.");
process.env.FIREBASE_CONFIG = JSON.stringify({ projectId, storageBucket: `${projectId}.appspot.com` });
const require = createRequire(import.meta.url);
const { admin } = require("../../functions/src/config");
const { SAAS_RULES_VERSION } = require("../../functions/src/saasRollout");
const { recordHotelSupplierConfirmationHandler: record, reviewHotelSupplierConfirmationHandler: review, getHotelSupplierConfirmationsHandler: get } = require("../../functions/src/supplierConfirmations");
const { recordHotelOrderReceiptHandler: receive, reverseHotelOrderReceiptHandler: reverse, finalizeHotelOrderReceivingHandler: finalize } = require("../../functions/src/orderReceiving");
const { createHotelStockCountHandler, mutateHotelStockCountHandler } = require("../../functions/src/stockCounts");
const { getHotelInventoryCostProposalHandler } = require("../../functions/src/inventoryCostProposals");
const db = admin.firestore(), auth = admin.auth();
const staff = { uid: "supplier-response-staff", token: { email_verified: true } }, outsider = { uid: "supplier-response-outsider", token: { email_verified: true } };
const platform = { uid: "supplier-response-platform", token: { email_verified: true, platformAdmin: true } };
const services = { firestore: db, auth, now: () => Date.parse("2026-10-13T10:00:00Z") };
const permissions = ["orders.read", "orders.recordconfirmation", "orders.reviewconfirmation", "orders.receive", "orders.finalize", "stockcounts.*", "inventorymovements.create"];
const orderRef = () => db.doc("hotels/hotel-a/orders/order-a");
let environment, serial = 0;
const next = () => `supplier-command-${++serial}`;
const request = (data, actor = staff) => ({ auth: actor, data });
const rejected = (promise, code) => assert.rejects(promise, (error) => error.code === code);
const source = (patch = {}) => ({ status: "Ordered", dispatchStatus: "sent", dispatchRequestId: "original-dispatch", revision: 2, supplierId: "vendor", supplierName: "Vendor", outletId: "bar",
  accountNumber: "C-42", currency: "EUR", priceBasis: "gross", totalAmount: 106, deliveryDate: "2026-10-14", products: [{ supplierProductId: "juice", orderLineId: "juice-case", purchaseOptionId: "default",
    supplierProductName: "Juice case", supplierSku: "J6", purchaseUnit: "Case of 6", qtyPurchaseUnits: 10, pricePerPurchaseUnit: 10.6, currency: "EUR", priceBasis: "gross", vatRate: 0.06, netPricePerPurchaseUnit: 10,
    inventoryTerms: { inventoryPolicyVersion: 1, available: true, inventoryTracked: true, catalogProductId: "orange", catalogProductName: "Orange juice", catalogBaseUnit: "l", catalogUnitsPerPurchaseUnit: 6, currency: "EUR", netUnitCost: 1.666667 } }], ...patch });
const response = (patch = {}) => ({ responseType: "accepted", channel: "email", supplierReference: "REF-1", respondedOn: "2026-10-13", note: "", lines: [
  { supplierProductId: "juice", orderLineId: "juice-case", confirmedQuantity: 10, deliveryDate: "2026-10-14", priceMode: "as-ordered", substitute: null, reason: "" }], ...patch });
const command = (patch = {}) => ({ hotelUid: "hotel-a", orderId: "order-a", requestId: next(), expectedActorUid: staff.uid, expectedRevision: 2, response: response(), ...patch });
const changed = (linePatch = {}, patch = {}) => response({ responseType: "changes-proposed", lines: [{ ...response().lines[0], confirmedQuantity: 8, reason: "Supplier changed its terms", ...linePatch }], ...patch });
const receipt = (revision, patch = {}) => ({ hotelUid: "hotel-a", orderId: "order-a", requestId: next(), expectedRevision: revision, receivedOn: "2026-10-13", deliveryReference: next(), inventoryLocationId: "store",
  lines: [{ supplierProductId: "juice", orderLineId: "juice-case", acceptedQuantity: 2, rejectedQuantity: 0 }], ...patch });
async function openingCount() {
  const created = await createHotelStockCountHandler(request({ hotelUid: "hotel-a", name: "Opening", type: "Weekly", requestId: next(), businessDate: "2026-10-12", locations: [{ locationId: "store", stockTemplateId: "weekly" }] }), services);
  await mutateHotelStockCountHandler(request({ hotelUid: "hotel-a", stockCountId: created.stockCountId, expectedRevision: 0, action: "finish-location", locationId: "store", countedItems: [{ catalogProductId: "orange", quantity: 10, isCounted: true, unitCost: 2 }] }), services);
  await mutateHotelStockCountHandler(request({ hotelUid: "hotel-a", stockCountId: created.stockCountId, expectedRevision: 1, action: "finish-count" }), services);
}
before(async () => { environment = await initializeTestEnvironment({ projectId, firestore: { rules: await readFile("firebase/firestore.rules", "utf8") } }); });
beforeEach(async () => {
  await environment.clearFirestore();
  const users = await auth.listUsers(); if (users.users.length) await auth.deleteUsers(users.users.map((user) => user.uid));
  for (const actor of [staff, outsider, platform]) await auth.createUser({ uid: actor.uid, email: `${actor.uid}@example.test`, emailVerified: true });
  await auth.setCustomUserClaims(platform.uid, { platformAdmin: true });
  await db.doc("platformConfiguration/saasProcurement").set({ enabled: true, rulesVersion: SAAS_RULES_VERSION });
  for (const hotel of ["hotel-a", "hotel-b"]) {
    await db.doc(`hotels/${hotel}`).set({ currency: "EUR", timeZone: "Europe/Brussels" });
    await db.doc(`hotels/${hotel}/settings/bootstrap`).set({ currency: "EUR" });
    await db.doc(`hotelSubscriptions/${hotel}`).set({ status: "active", validUntil: null, modulePolicyVersion: 1, modules: ["procurement"] });
    await db.doc(`hotels/${hotel}/orders/order-a`).set(source());
    await db.doc(`hotels/${hotel}/locations/store`).set({ name: "Kitchen store" });
    await db.doc(`hotels/${hotel}/locations/store/stockTemplates/weekly`).set({ name: "Weekly", items: [{ catalogProductId: "orange" }] });
    await db.doc(`hotels/${hotel}/catalogproducts/orange`).set({ name: "Orange juice", baseUnit: "l", inventoryTracked: true, active: true, productPolicyVersion: 1 });
  }
  await db.doc(`hotels/hotel-a/members/${staff.uid}`).set({ permissions, firstName: "Hotel", lastName: "Buyer" });
  await db.doc(`hotels/hotel-b/members/${outsider.uid}`).set({ permissions });
});
after(async () => environment.cleanup());
describe("supplier confirmations with genuine ordinary-hotel Auth and Firestore transactions", () => {
  it("a sent order remains unconfirmed until the hotel records supplier evidence, preserving its submitted snapshot", async () => {
    const initial = await get(request({ hotelUid: "hotel-a", orderId: "order-a" }), services);
    assert.equal(initial.current, null); assert.equal(initial.availability, "available");
    const input = command(), saved = await record(request(input), services);
    assert.deepEqual(await record(request(input), services), saved);
    const data = (await orderRef().get()).data();
    for (const key of ["products", "deliveryDate", "currency", "totalAmount", "status", "dispatchRequestId", "dispatchStatus"]) assert.deepEqual(data[key], source()[key]);
    const read = await get(request({ hotelUid: "hotel-a", orderId: "order-a" }), services);
    assert.equal(read.current.responseType, "accepted"); assert.equal(read.current.reviewState, "not-required");
    assert.equal(read.events[0].actorName, "Hotel Buyer");
    await rejected(record(request({ ...input, response: response({ note: "Changed replay" }) }), services), "already-exists");
    await rejected(record(request(command({ expectedRevision: 3 })), services), "already-exists");
    assert.equal((await orderRef().collection("supplierConfirmations").get()).size, 1);
  });
  it("explicit read/action rights, tenant, current Auth, module and actor scopes apply to response/review/read", async () => {
    for (const actor of [outsider, platform]) await rejected(record(request(command({ expectedActorUid: actor.uid }), actor), services), "permission-denied");
    await rejected(record(request(command({ hotelUid: "hotel-b" })), services), "permission-denied");
    await rejected(record(request(command({ expectedActorUid: outsider.uid })), services), "permission-denied");
    for (const keys of [["orders.*"], ["orders.recordconfirmation"]]) {
      await db.doc(`hotels/hotel-a/members/${staff.uid}`).update({ permissions: keys });
      await rejected(record(request(command()), services), "permission-denied");
    }
    await db.doc(`hotels/hotel-a/members/${staff.uid}`).update({ permissions });
    await db.doc("hotelSubscriptions/hotel-a").update({ modules: [] }); await rejected(get(request({ hotelUid: "hotel-a", orderId: "order-a" }), services), "permission-denied");
    await db.doc("hotelSubscriptions/hotel-a").update({ modules: ["procurement"], status: "canceled" }); await rejected(record(request(command()), services), "permission-denied");
    await db.doc("hotelSubscriptions/hotel-a").update({ status: "active" }); await auth.updateUser(staff.uid, { disabled: true }); await rejected(record(request(command()), services), "permission-denied");
  });
  it("private supplier response and duplicate guard history cannot be read or changed directly, even by platform admins", async () => {
    const saved = await record(request(command()), services);
    const paths = [`orders/order-a/supplierConfirmations/${saved.eventId}`, "orders/order-a/supplierConfirmationReferences/any"];
    await db.doc(`hotels/hotel-a/${paths[1]}`).set({ eventId: saved.eventId });
    for (const actor of [staff, outsider, platform]) {
      const browser = environment.authenticatedContext(actor.uid, actor.token).firestore();
      for (const path of paths) {
        const ref = doc(browser, `hotels/hotel-a/${path}`);
        await assertFails(getDoc(ref)); await assertFails(setDoc(ref, {})); await assertFails(updateDoc(ref, { changed: true })); await assertFails(deleteDoc(ref));
      }
    }
  });
  it("stale, older and future commands cannot silently supersede a newer response; same reference corrections are legitimate", async () => {
    await record(request(command()), services);
    await rejected(record(request(command({ response: response({ supplierReference: "second" }) })), services), "aborted");
    await rejected(record(request(command({ expectedRevision: 3, response: response({ respondedOn: "2026-10-12" }) })), services), "aborted");
    await rejected(record(request(command({ expectedRevision: 3, response: response({ respondedOn: "2026-10-14" }) })), services), "invalid-argument");
    const corrected = await record(request(command({ expectedRevision: 3, response: changed() })), services);
    assert.equal(corrected.supplierConfirmation.reviewState, "pending");
    await rejected(review(request({ hotelUid: "hotel-a", orderId: "order-a", requestId: next(), expectedActorUid: staff.uid, expectedRevision: 4,
      review: { responseId: "old-response", decision: "accept", reason: "Wrong version" } }), services), "aborted");
  });
  it("concurrent response writers cannot both commit against the same reviewed revision", async () => {
    const results = await Promise.allSettled([record(request(command({ response: response({ supplierReference: "CONCURRENT-A" }) })), services),
      record(request(command({ response: response({ supplierReference: "CONCURRENT-B" }) })), services)]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const failure = results.find((result) => result.status === "rejected").reason;
    assert.equal(failure.code, "aborted"); assert.equal(failure.details.confirmationRequestUncommitted, true);
    assert.equal((await orderRef().collection("supplierConfirmations").get()).size, 1); assert.equal((await orderRef().get()).data().revision, 3);
  });
  it("receiving follows the reviewed supplier promise and requires an explicit overdelivery reason", async () => {
    const saved = await record(request(command({ response: changed({ confirmedQuantity: 1 }) })), services);
    await review(request({ hotelUid: "hotel-a", orderId: "order-a", expectedActorUid: staff.uid, expectedRevision: 3, requestId: next(), review: { responseId: saved.eventId, decision: "accept", reason: "Supplier shortage acknowledged" } }), services);
    await rejected(receive(request(receipt(4)), services), "invalid-argument");
    const actual = await receive(request(receipt(4, { lines: [{ supplierProductId: "juice", orderLineId: "juice-case", acceptedQuantity: 2, rejectedQuantity: 0, reason: "Two cases arrived physically and were accepted" }] })), services);
    assert.equal(actual.status, "Ordered", "The original ten-case shortfall still needs supervisor acknowledgement.");
  });
  it("unreviewed changes block accepted inventory; explicit reviewed gross prices affect only subsequent receipts and reconcile weighted costs", async () => {
    await openingCount();
    const before = await receive(request(receipt(2)), services);
    const originalEvent = (await orderRef().collection("receipts").doc(before.eventId).get()).data();
    const originalMovement = (await db.doc(`hotels/hotel-a/inventoryMovements/${before.eventId}`).get()).data();
    assert.equal(originalMovement.lines[0].netValue, 20);
    const saved = await record(request(command({ expectedRevision: 3, response: changed({ priceMode: "quoted", pricePerPurchaseUnit: 21.2 }) })), services);
    await rejected(receive(request(receipt(4)), services), "failed-precondition");
    const reviewInput = { hotelUid: "hotel-a", orderId: "order-a", expectedActorUid: staff.uid, expectedRevision: 4, requestId: next(), review: { responseId: saved.eventId, decision: "accept", reason: "Hotel buyer accepts the revised package price" } };
    await db.doc(`hotels/hotel-a/members/${staff.uid}`).update({ permissions: permissions.filter((key) => key !== "orders.reviewconfirmation") });
    await rejected(review(request(reviewInput), services), "permission-denied");
    await db.doc(`hotels/hotel-a/members/${staff.uid}`).update({ permissions });
    const reviewed = await review(request(reviewInput), services); assert.deepEqual(await review(request(reviewInput), services), reviewed);
    const received = await receive(request(receipt(5)), services);
    const movement = (await db.doc(`hotels/hotel-a/inventoryMovements/${received.eventId}`).get()).data();
    assert.equal(movement.lines[0].quantity, 12); assert.equal(movement.lines[0].netValue, 40);
    const event = (await orderRef().collection("receipts").doc(received.eventId).get()).data();
    assert.equal(event.supplierConfirmationTerms.responseId, saved.eventId); assert.equal(event.supplierConfirmationTerms.reviewId, reviewed.eventId);
    assert.deepEqual((await orderRef().collection("receipts").doc(before.eventId).get()).data(), originalEvent);
    assert.deepEqual((await db.doc(`hotels/hotel-a/inventoryMovements/${before.eventId}`).get()).data(), originalMovement);
    assert.deepEqual((await orderRef().get()).data().products, source().products);
    const cost = await getHotelInventoryCostProposalHandler(request({ hotelUid: "hotel-a", purpose: "movement", locationId: "store", catalogProductId: "orange", businessDate: "2026-10-13" }), services);
    assert.equal(cost.available, true, JSON.stringify(cost)); assert.equal(cost.source.weightedSourceQuantity, 34); assert.equal(cost.source.weightedSourceNetValue, 80);
    assert.ok(Math.abs(cost.netUnitCost - 80 / 34) <= 0.000001);
    await orderRef().collection("receipts").doc(received.eventId).update({ "supplierConfirmationTerms.lines": [{ ...event.supplierConfirmationTerms.lines[0], netPricePerPurchaseUnit: 0 }] });
    const corrupt = await getHotelInventoryCostProposalHandler(request({ hotelUid: "hotel-a", purpose: "movement", locationId: "store", catalogProductId: "orange", businessDate: "2026-10-13" }), services);
    assert.equal(corrupt.available, false); assert.equal(corrupt.netUnitCost, null);
  });
  it("a later rejection does not revalue old approved receipts and does not prevent exact reversal or explicit shortfall closure", async () => {
    const saved = await record(request(command({ response: changed({ priceMode: "quoted", pricePerPurchaseUnit: 21.2 }) })), services);
    await review(request({ hotelUid: "hotel-a", orderId: "order-a", expectedActorUid: staff.uid, expectedRevision: 3, requestId: next(), review: { responseId: saved.eventId, decision: "accept", reason: "Approved new price" } }), services);
    const received = await receive(request(receipt(4)), services);
    const later = await record(request(command({ expectedRevision: 5, response: response({ responseType: "rejected", lines: [], note: "Supplier canceled the remainder" }) })), services);
    await rejected(receive(request(receipt(6)), services), "failed-precondition");
    const reversed = await reverse(request({ hotelUid: "hotel-a", orderId: "order-a", expectedRevision: 6, requestId: next(), receiptId: received.eventId, reason: "Receipt was entered twice" }), services);
    assert.equal((await db.doc(`hotels/hotel-a/inventoryMovements/${reversed.eventId}`).get()).data().lines[0].netValue, -40);
    await rejected(finalize(request({ hotelUid: "hotel-a", orderId: "order-a", expectedRevision: 7, requestId: next(), acceptShortfall: false, reason: "Supplier rejected" }), services), "failed-precondition");
    await finalize(request({ hotelUid: "hotel-a", orderId: "order-a", expectedRevision: 7, requestId: next(), acceptShortfall: true, reason: "Canceled remainder acknowledged" }), services);
    await rejected(record(request(command({ expectedRevision: 8 })), services), "failed-precondition");
    assert.equal(later.supplierConfirmation.requiresAttention, true);
  });
  for (const value of [null, 0]) it(`approved ${value === null ? "unknown prices remain null" : "explicit zero is a genuine zero"} in new receipt evidence`, async () => {
      const saved = await record(request(command({ response: changed(value === null ? { priceMode: "unknown" } : { priceMode: "quoted", pricePerPurchaseUnit: 0 }) })), services);
      await review(request({ hotelUid: "hotel-a", orderId: "order-a", expectedActorUid: staff.uid, expectedRevision: 3, requestId: next(), review: { responseId: saved.eventId, decision: "accept", reason: "Reviewed the explicit price availability" } }), services);
      const result = await receive(request(receipt(4)), services);
      assert.equal((await db.doc(`hotels/hotel-a/inventoryMovements/${result.eventId}`).get()).data().lines[0].netValue, value);
  });
  it("unresolved and replacement proposals cannot authorize original-product inventory", async () => {
    const saved = await record(request(command({ response: changed({ substitute: { description: "Apple juice", supplierSku: "APPLE12", purchaseUnit: "12 bottles" } }) })), services);
    const input = { hotelUid: "hotel-a", orderId: "order-a", expectedActorUid: staff.uid, expectedRevision: 3, requestId: next(), review: { responseId: saved.eventId, decision: "accept", reason: "Accept replacement" } };
    await rejected(review(request(input), services), "failed-precondition");
    await review(request({ ...input, requestId: next(), review: { ...input.review, decision: "follow-up", reason: "Ask supplier for verified replacement terms" } }), services);
    await rejected(receive(request(receipt(4)), services), "failed-precondition");
    assert.equal((await db.collection("hotels/hotel-a/inventoryMovements").get()).size, 0);
  });
  it("history pages are bounded and summary/source corruption is explicit rather than silent fallback", async () => {
    for (let index = 0; index < 27; index++) await record(request(command({ expectedRevision: index + 2, response: response({ supplierReference: `REF-${index}` }) })), services);
    const page = await get(request({ hotelUid: "hotel-a", orderId: "order-a" }), services);
    assert.equal(page.events.length, 25); assert.ok(page.nextCursor);
    const more = await get(request({ hotelUid: "hotel-a", orderId: "order-a", afterEventId: page.nextCursor }), services);
    assert.equal(more.events.length, 2); assert.equal(more.nextCursor, null); assert.equal(page.orderRevision, more.orderRevision);
    await orderRef().update({ "supplierConfirmation.reviewState": "accepted" });
    const inconsistent = await get(request({ hotelUid: "hotel-a", orderId: "order-a" }), services);
    assert.equal(inconsistent.availability, "review-required"); assert.equal(inconsistent.current, null);
  });
  it("only proven uncommitted failures can release a saved request; a missing rollout or revoked replay cannot", async () => {
    await assert.rejects(record(request(command({ expectedRevision: 1 })), services), (error) => error.code === "aborted" && error.details.confirmationRequestUncommitted === true);
    const input = command(); await record(request(input), services);
    await db.doc("platformConfiguration/saasProcurement").update({ enabled: false });
    await assert.rejects(record(request(input), services), (error) => error.code === "failed-precondition" && !error.details?.confirmationRequestUncommitted);
    await db.doc("platformConfiguration/saasProcurement").update({ enabled: true });
    await auth.updateUser(staff.uid, { disabled: true });
    await assert.rejects(record(request(input), services), (error) => error.code === "permission-denied" && !error.details?.confirmationRequestUncommitted);
  });
});
