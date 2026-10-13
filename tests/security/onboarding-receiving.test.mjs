import { before, beforeEach, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { initializeTestEnvironment, assertFails } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, updateDoc, deleteDoc } from "firebase/firestore";

if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) throw new Error("Local Firestore and Auth emulators are required.");
const projectId = "demo-hotel-suite-a00";
process.env.FIREBASE_CONFIG = JSON.stringify({ projectId, storageBucket: `${projectId}.appspot.com` });
const require = createRequire(import.meta.url);
const { admin } = require("../../functions/src/config");
const { getHotelSetupReadinessHandler } = require("../../functions/src/hotelSetup");
const { createHotelHandler } = require("../../functions/src/onboarding");
const { digest } = require("../../functions/src/validation");
const { SAAS_RULES_VERSION } = require("../../functions/src/saasRollout");
const { recordHotelOrderReceipt, recordHotelOrderReceiptHandler, reverseHotelOrderReceiptHandler, finalizeHotelOrderReceivingHandler, getHotelOrderReceivingHandler } = require("../../functions/src/orderReceiving");
let environment, db, auth, operator, primary, backup, sequence = 0;
const req = (user, data = {}) => ({ auth: { uid: user.uid, token: { email_verified: true, email: user.email, platformAdmin: user.platformAdmin === true } }, data });
const services = () => ({ firestore: db, auth });
async function user(label, platformAdmin = false) {
  const uid = `setup-${++sequence}-${label}`;
  const record = await auth.createUser({ uid, email: `${uid}@example.test`, emailVerified: true });
  if (platformAdmin) await auth.setCustomUserClaims(uid, { platformAdmin: true });
  return { uid, email: record.email, platformAdmin };
}
async function assign(person, hotelUid = "hotel-a", permissions = ["orders.*", "orders.receive", "orders.finalize", "stockcounts.read", "stockcounts.create"], hotelAdmin = true) {
  await db.doc(`users/${person.uid}`).set({ hotelUid: [hotelUid], firstName: "Employee", privateInfo: "do-not-expose" });
  await db.doc(`hotels/${hotelUid}/members/${person.uid}`).set({ hotelAdmin, permissions, revision: 1 });
}
before(async () => {
  environment = await initializeTestEnvironment({ projectId, firestore: { rules: await readFile("firebase/firestore.rules", "utf8") } });
  db = admin.firestore(); auth = admin.auth();
});

describe("ordinary-user goods receiving boundaries", () => {
  let receiver;
  const orderRef = () => db.doc("hotels/hotel-a/orders/receiving-order");
  const input = (extra = {}) => ({ hotelUid: "hotel-a", orderId: "receiving-order", requestId: "receipt-one", expectedRevision: 1,
    receivedOn: "2026-10-12", deliveryReference: "DN-1", inventoryLocationId: "store", lines: [{ supplierProductId: "coffee", acceptedQuantity: 1.25, rejectedQuantity: 0 }], ...extra });
  const receive = (extra = {}, person = receiver) => recordHotelOrderReceiptHandler(req(person, input(extra)), services());
  const inspect = (person = receiver, extra = {}) => getHotelOrderReceivingHandler(req(person, { hotelUid: "hotel-a", orderId: "receiving-order", ...extra }), services());
  beforeEach(async () => {
    receiver = await user("receiver");
    await assign(receiver, "hotel-a", ["orders.read", "orders.receive"], false);
    await orderRef().set({ status: "Ordered", dispatchStatus: "sent", dispatchRequestId: "confirmed-dispatch", revision: 1, currency: "EUR", totalAmount: 60,
      supplierId: "vendor", outletId: "bar", products: [
        { supplierProductId: "coffee", supplierProductName: "Frozen Coffee", purchaseUnit: "box", qtyPurchaseUnits: 2.5, pricePerPurchaseUnit: 12 },
        { supplierProductId: "milk", supplierProductName: "Frozen Milk", purchaseUnit: "case", qtyPurchaseUnits: 3, pricePerPurchaseUnit: 10 } ] });
  });
  it("records partial then complete accepted delivery with immutable actor/date/unit evidence and no stock mutation", async () => {
    await db.doc("hotels/hotel-a/stockCounts/finished").set({ status: "Finished", countedValue: 999 });
    const stockBefore = (await db.doc("hotels/hotel-a/stockCounts/finished").get()).data();
    const first = await receive({ lines: [{ supplierProductId: "coffee", acceptedQuantity: 1.25, rejectedQuantity: 0.25, reason: "Damaged" }] });
    assert.equal(first.status, "Ordered");
    const partial = await inspect();
    assert.equal(partial.lines[0].outstandingQuantity, 1.25);
    assert.equal(partial.lines[0].rejectedQuantity, 0.25);
    assert.equal(partial.events[0].actorUid, receiver.uid);
    assert.equal(partial.events[0].lines[0].purchaseUnit, "box");
    const completed = await receive({ requestId: "receipt-two", expectedRevision: 2, deliveryReference: "DN-2", lines: [
      { supplierProductId: "coffee", acceptedQuantity: 1.25, rejectedQuantity: 0 }, { supplierProductId: "milk", acceptedQuantity: 3, rejectedQuantity: 0 } ] });
    assert.equal(completed.status, "Received");
    assert.equal((await inspect()).lines.every((line) => line.outstandingQuantity === 0), true);
    assert.equal((await orderRef().get()).data().totalAmount, 60);
    assert.equal((await orderRef().get()).data().dispatchRequestId, "confirmed-dispatch");
    assert.deepEqual((await db.doc("hotels/hotel-a/stockCounts/finished").get()).data(), stockBefore);
  });
  it("request replay returns the original result and normalized duplicate physical references are refused", async () => {
    const result = await receive();
    assert.deepEqual(await receive(), result);
    assert.equal((await orderRef().collection("receipts").get()).size, 1);
    assert.equal((await inspect()).lines[0].acceptedQuantity, 1.25);
    await assert.rejects(receive({ note: "Changed payload" }), { code: "already-exists" });
    await assert.rejects(receive({ requestId: "another", expectedRevision: 2, deliveryReference: " dn-1 " }), { code: "already-exists" });
  });
  it("concurrent receiving has one revision winner and never silently adds both quantities", async () => {
    const result = await Promise.allSettled([receive(), receive({ requestId: "other", deliveryReference: "DN-2" })]);
    assert.equal(result.filter((row) => row.status === "fulfilled").length, 1);
    assert.equal(result.find((row) => row.status === "rejected").reason.code, "aborted");
    assert.equal((await inspect()).lines[0].acceptedQuantity, 1.25);
    assert.equal((await orderRef().collection("receipts").get()).size, 1);
  });
  it("supervisor reverses by immutable compensating event, exactly once, with a reason", async () => {
    const original = await receive();
    const originalRef = orderRef().collection("receipts").doc(original.eventId);
    const before = (await originalRef.get()).data();
    const details = { hotelUid: "hotel-a", orderId: "receiving-order", receiptId: original.eventId, requestId: "reverse-one", expectedRevision: 2, reason: "Wrong quantity entered" };
    await assert.rejects(reverseHotelOrderReceiptHandler(req(receiver, details), services()), { code: "permission-denied" });
    const reversed = await reverseHotelOrderReceiptHandler(req(primary, details), services());
    assert.deepEqual(await reverseHotelOrderReceiptHandler(req(primary, details), services()), reversed);
    assert.deepEqual((await originalRef.get()).data(), before);
    const current = await inspect();
    assert.equal(current.lines[0].acceptedQuantity, 0);
    assert.equal(current.events.find((event) => event.id === original.eventId).reversed, true);
    await assert.rejects(reverseHotelOrderReceiptHandler(req(primary, { ...details, requestId: "reverse-two", expectedRevision: 3 }), services()), { code: "already-exists" });
    await assert.rejects(receive({ expectedRevision: 3, requestId: "reuse-note" }), { code: "already-exists" });
  });
  it("supervisor closes a shortage explicitly, retains the shortfall, and freezes further receiving/reversal", async () => {
    const original = await receive();
    const details = { hotelUid: "hotel-a", orderId: "receiving-order", expectedRevision: 2, requestId: "close-one", acceptShortfall: false, reason: "Supplier confirmed no remainder" };
    await assert.rejects(finalizeHotelOrderReceivingHandler(req(receiver, details), services()), { code: "permission-denied" });
    await assert.rejects(finalizeHotelOrderReceivingHandler(req(primary, details), services()), { code: "failed-precondition" });
    const valid = { ...details, acceptShortfall: true };
    const result = await finalizeHotelOrderReceivingHandler(req(primary, valid), services());
    assert.equal(result.status, "Finalized");
    assert.deepEqual(await finalizeHotelOrderReceivingHandler(req(primary, valid), services()), result);
    const current = await inspect();
    assert.equal(current.lines[0].outstandingQuantity, 1.25);
    assert.equal(current.receivingState, "closed");
    await assert.rejects(receive({ requestId: "late", expectedRevision: 3, deliveryReference: "DN-2" }), { code: "failed-precondition" });
    await assert.rejects(reverseHotelOrderReceiptHandler(req(primary, { hotelUid: "hotel-a", orderId: "receiving-order", receiptId: original.eventId, requestId: "late-reversal", expectedRevision: 3, reason: "Too late" }), services()), { code: "failed-precondition" });
  });
  it("admin/buyer/platform authority and another hotel never supply receiving or history rights", async () => {
    await assert.rejects(receive({}, backup), { code: "permission-denied" });
    await db.doc(`hotels/hotel-a/members/${backup.uid}`).update({ permissions: ["orders.*"] });
    await assert.rejects(receive({}, backup), { code: "permission-denied" });
    await db.doc(`hotels/hotel-a/members/${backup.uid}`).update({ permissions: ["orders.read", "orders.create", "orders.update", "orders.approve"] });
    await assert.rejects(receive({}, backup), { code: "permission-denied" });
    await assert.rejects(receive({}, operator), { code: "permission-denied" });
    await assert.rejects(inspect(operator), { code: "permission-denied" });
    await assert.rejects(receive({ hotelUid: "hotel-b" }), { code: "permission-denied" });
    await assert.rejects(inspect(receiver, { hotelUid: "hotel-b" }), { code: "permission-denied" });
  });
  it("direct receipt/aggregate/reference/reversal writes and browser history reads remain denied", async () => {
    const result = await receive();
    const client = environment.authenticatedContext(receiver.uid, { email_verified: true }).firestore();
    const path = `hotels/hotel-a/orders/receiving-order/receipts/${result.eventId}`;
    await assertFails(getDoc(doc(client, path)));
    await assertFails(setDoc(doc(client, path), { actorUid: "spoof", acceptedQuantity: 999 }));
    await assertFails(updateDoc(doc(client, path), { lines: [] }));
    await assertFails(deleteDoc(doc(client, path)));
    await assertFails(updateDoc(doc(client, "hotels/hotel-a/orders/receiving-order"), { status: "Finalized", receiving: {} }));
    for (const collection of ["receiptReferences", "receiptReversals"]) await assertFails(setDoc(doc(client, `hotels/hotel-a/orders/receiving-order/${collection}/spoof`), { eventId: result.eventId }));
  });
  it("current Auth, membership, module, subscription and release revocation block new receipts", async () => {
    for (const mutation of ["disabled", "unverified", "member", "module", "expiry", "release"]) {
      await auth.updateUser(receiver.uid, { disabled: false, emailVerified: true });
      await db.doc(`hotels/hotel-a/members/${receiver.uid}`).set({ permissions: ["orders.read", "orders.receive"] });
      await db.doc("hotelSubscriptions/hotel-a").update({ modules: ["procurement"], validUntil: null });
      await db.doc("platformConfiguration/saasProcurement").update({ enabled: true });
      if (mutation === "disabled") await auth.updateUser(receiver.uid, { disabled: true });
      if (mutation === "unverified") await auth.updateUser(receiver.uid, { emailVerified: false });
      if (mutation === "member") await db.doc(`hotels/hotel-a/members/${receiver.uid}`).delete();
      if (mutation === "module") await db.doc("hotelSubscriptions/hotel-a").update({ modules: [] });
      if (mutation === "expiry") await db.doc("hotelSubscriptions/hotel-a").update({ validUntil: admin.firestore.Timestamp.fromMillis(1) });
      if (mutation === "release") await db.doc("platformConfiguration/saasProcurement").update({ enabled: false });
      await assert.rejects(receive(), { code: mutation === "release" ? "failed-precondition" : "permission-denied" });
    }
    assert.equal((await orderRef().collection("receipts").get()).size, 0);
    assert.equal((await orderRef().get()).data().revision, 1);
  });
  it("missing historical baselines and lost aggregates never appear as valid zero receiving", async () => {
    await orderRef().update({ status: "Received" });
    const historical = await inspect();
    assert.equal(historical.availability, "review-required"); assert.equal(historical.lines, null);
    await assert.rejects(receive(), { code: "failed-precondition" });
    await orderRef().update({ status: "Ordered" });
    await receive();
    await orderRef().update({ receiving: admin.firestore.FieldValue.delete() });
    assert.equal((await inspect()).availability, "review-required");
    await assert.rejects(receive({ expectedRevision: 2, requestId: "next", deliveryReference: "DN-2" }), { code: "failed-precondition" });
  });
  it("exported callable enforces the real rollout guard and bounds malicious payloads", async () => {
    const before = (await orderRef().get()).data();
    await assert.rejects(recordHotelOrderReceipt.run(req(receiver, input({ actorUid: "spoof" }))), { code: "invalid-argument" });
    await assert.rejects(receive({ lines: [{ supplierProductId: "foreign", acceptedQuantity: 1, rejectedQuantity: 0 }] }), { code: "invalid-argument" });
    await assert.rejects(receive({ lines: [{ supplierProductId: "coffee", acceptedQuantity: null, rejectedQuantity: 0 }] }), { code: "invalid-argument" });
    await db.doc("platformConfiguration/saasProcurement").update({ enabled: false });
    await assert.rejects(recordHotelOrderReceipt.run(req(receiver, input())), { code: "failed-precondition" });
    assert.deepEqual((await orderRef().get()).data(), before);
    const paused = await inspect(); assert.equal(paused.releaseReady, false);
  });
  it("receipt history pages use order-scoped immutable cursors with no hidden truncation", async () => {
    const batch = db.batch();
    for (let index = 0; index < 26; index++) batch.set(orderRef().collection("receipts").doc(`event-${index}`), {
      kind: "reversal", policyVersion: 1, actorUid: primary.uid, reason: "History fixture", createdAt: admin.firestore.Timestamp.fromMillis(index + 1), revision: index + 1,
    });
    await batch.commit();
    const first = await inspect(); assert.equal(first.events.length, 25); assert.ok(first.nextCursor);
    const second = await inspect(receiver, { afterEventId: first.nextCursor });
    assert.equal(second.events.length, 1); assert.equal(second.nextCursor, null);
    assert.equal(new Set([...first.events, ...second.events].map((event) => event.id)).size, 26);
    await assert.rejects(inspect(receiver, { afterEventId: "hotel-b-cursor" }), { code: "not-found" });
  });
  it("gate failures retain uncertain outcomes; post-idempotence revision errors prove no commit", async () => {
    const recorded = await receive();
    await db.doc("platformConfiguration/saasProcurement").update({ enabled: false });
    await assert.rejects(receive(), (error) => error.code === "failed-precondition" && error.details?.receivingRequestUncommitted !== true);
    await db.doc("platformConfiguration/saasProcurement").update({ enabled: true });
    assert.deepEqual(await receive(), recorded);
    await assert.rejects(receive({ requestId: "new-stale", deliveryReference: "DN-2" }), (error) => error.code === "aborted" && error.details.receivingRequestUncommitted === true);
    assert.equal((await orderRef().collection("receipts").get()).size, 1);
  });
});
beforeEach(async () => {
  await environment.clearFirestore();
  operator = await user("operator", true); primary = await user("primary"); backup = await user("backup");
  await db.doc("platformConfiguration/saasProcurement").set({ enabled: true, rulesVersion: SAAS_RULES_VERSION });
  await db.doc("hotels/hotel-a").set({ name: "Hotel A", timeZone: "Europe/Brussels" });
  await db.doc("hotelSubscriptions/hotel-a").set({ status: "active", validUntil: null, modules: ["procurement"], modulePolicyVersion: 1, billingMode: "manual", seatLimit: null, revision: 1 });
  await db.doc("hotels/hotel-a/settings/bootstrap").set({ currency: "EUR" });
  await assign(primary); await assign(backup, "hotel-a", ["users.read"]);
  await db.doc(`hotels/hotel-a/outlets/bar/approvers/${primary.uid}`).set({});
  for (const [path, data] of [["outlets/bar", { name: "Bar" }], ["suppliers/vendor", { name: "Supplier", password: "do-not-expose" }],
    ["supplierproducts/coffee", { supplierId: "vendor", pricePerPurchaseUnit: 12, currency: "EUR", purchaseUnit: "box" }], ["locations/store", { name: "Store" }]]) {
    await db.doc(`hotels/hotel-a/${path}`).set(data);
  }
  await db.doc("hotels/hotel-a/locations/store/stockTemplates/weekly").set({ name: "Weekly", items: [{ supplierProductId: "coffee", outletId: "bar" }] });
});
after(async () => { await environment?.cleanup(); });
describe("real hotel setup assessment", () => {
  it("a zero-hotel platform operator sees a ready, sanitized dated report without any writes", async () => {
    const before = (await db.doc(`users/${primary.uid}`).get()).data();
    const result = await getHotelSetupReadinessHandler(req(operator, { hotelUid: "hotel-a" }), services());
    assert.equal(result.status, "ready");
    assert.equal(result.integrity.inspectedMembers, 2);
    assert.equal(JSON.stringify(result).includes("do-not-expose"), false);
    assert.deepEqual((await db.doc(`users/${primary.uid}`).get()).data(), before);
    assert.equal((await db.doc(`hotels/hotel-a/members/${operator.uid}`).get()).exists, false);
  });
  it("hotel administrators cannot request platform diagnostics even for their own hotel", async () => {
    await assert.rejects(getHotelSetupReadinessHandler(req(primary, { hotelUid: "hotel-a" }), services()), { code: "permission-denied" });
    await assertFails(getDoc(doc(environment.authenticatedContext(primary.uid, { email_verified: true }).firestore(), "platformConfiguration/saasProcurement")));
  });
  it("orphan Auth/profile records and profile-only assignments are reported, never automatically repaired", async () => {
    const extra = await user("profile-only");
    await db.doc(`users/${extra.uid}`).set({ hotelUid: ["hotel-a", "hotel-b"], secret: "other-hotel-secret" });
    await db.doc("hotels/hotel-a/members/deleted-identity").set({ permissions: [] });
    const result = await getHotelSetupReadinessHandler(req(operator, { hotelUid: "hotel-a" }), services());
    assert.equal(result.status, "blocked");
    assert.deepEqual(result.integrity.issues.find((issue) => issue.uid === "deleted-identity").codes, ["auth-account-missing", "profile-missing"]);
    assert.deepEqual(result.integrity.issues.find((issue) => issue.uid === extra.uid).codes, ["membership-missing"]);
    assert.equal(JSON.stringify(result).includes("hotel-b"), false);
    assert.equal((await db.doc("hotels/hotel-a/members/deleted-identity").get()).exists, true);
  });
  it("Auth lookup failures cannot be interpreted as missing accounts or green readiness", async () => {
    const failing = { getUser: (...args) => auth.getUser(...args), getUsers: async () => { throw new Error("Auth service denied"); } };
    await assert.rejects(getHotelSetupReadinessHandler(req(operator, { hotelUid: "hotel-a" }), { firestore: db, auth: failing }), /Auth service denied/);
    const partial = { ...failing, getUsers: async () => ({ users: [], notFound: [] }) };
    await assert.rejects(getHotelSetupReadinessHandler(req(operator, { hotelUid: "hotel-a" }), { firestore: db, auth: partial }), { code: "unavailable" });
  });
  it("paused rollout remains diagnosable and invitations expose status without action links/mail content", async () => {
    await db.doc("platformConfiguration/saasProcurement").update({ enabled: false });
    await db.doc("hotels/hotel-a/invitations/one").set({ uid: primary.uid, createdAt: admin.firestore.Timestamp.now() });
    await db.doc("hotels/hotel-a/mailQueue/invite-one").set({ status: "failed", payload: { text: "private-reset-link", to: ["secret@example.test"] } });
    const result = await getHotelSetupReadinessHandler(req(operator, { hotelUid: "hotel-a" }), services());
    assert.equal(result.status, "blocked");
    assert.equal(result.recentInvitations[0].status, "failed");
    assert.equal(JSON.stringify(result).includes("private-reset-link"), false);
    assert.equal(JSON.stringify(result).includes("secret@example.test"), false);
  });
  it("creation records the chosen time zone and matching canonical currencies without assigning the operator", async () => {
    const details = { hotelUid: "new-hotel", name: "New Hotel", timeZone: "Europe/Brussels", currency: "EUR", status: "active", modules: ["procurement"], requestId: "create-one" };
    const result = await createHotelHandler(req(operator, details), services());
    const root = (await db.doc("hotels/new-hotel").get()).data();
    assert.equal(root.timeZone, "Europe/Brussels"); assert.equal(root.currency, "EUR");
    assert.equal((await db.doc("hotels/new-hotel/settings/bootstrap").get()).data().currency, root.currency);
    assert.deepEqual(await createHotelHandler(req(operator, details), services()), result);
    const readiness = await getHotelSetupReadinessHandler(req(operator, { hotelUid: "new-hotel" }), services());
    assert.equal(readiness.checks.find((check) => check.id === "property").status, "ready");
    assert.equal((await db.doc(`hotels/new-hotel/members/${operator.uid}`).get()).exists, false);
    await assert.rejects(createHotelHandler(req(operator, { ...details, timeZone: "Invalid/Zone", requestId: "create-two" }), services()), { code: "invalid-argument" });
    await assert.rejects(createHotelHandler(req(operator, { ...details, timeZone: "UTC" }), services()), { code: "already-exists" });
    await assert.rejects(createHotelHandler(req(operator, { ...details, currency: "USD" }), services()), { code: "already-exists" });
    await assertFails(setDoc(doc(environment.authenticatedContext(primary.uid, { email_verified: true }).firestore(), "hotels/hotel-a/setupReadiness/current"), { status: "ready" }));
  });
  it("accepts an explicitly selected currency and refuses invalid currencies or hotel-user creation", async () => {
    const details = { hotelUid: "usd-hotel", name: "USD Hotel", timeZone: "America/New_York", currency: "USD", status: "active", modules: ["procurement"], requestId: "create-usd" };
    await createHotelHandler(req(operator, details), services());
    assert.equal((await db.doc("hotels/usd-hotel").get()).data().currency, "USD");
    assert.equal((await db.doc("hotels/usd-hotel/settings/bootstrap").get()).data().currency, "USD");
    for (const currency of ["", "eur", "ZZZ", null, "Euro"]) {
      await assert.rejects(createHotelHandler(req(operator, { ...details, currency, hotelUid: "invalid-hotel", requestId: "create-invalid" }), services()), { code: "invalid-argument" });
      assert.equal((await db.doc("hotels/invalid-hotel").get()).exists, false);
    }
    await assert.rejects(createHotelHandler(req(primary, { ...details, hotelUid: "staff-hotel", requestId: "create-staff" }), services()), { code: "permission-denied" });
    await auth.setCustomUserClaims(operator.uid, {});
    await assert.rejects(createHotelHandler(req(operator, details), services()), { code: "permission-denied" });
  });
  it("retains legacy omitted-currency retries without inventing an unknown hotel time zone", async () => {
    const details = { hotelUid: "legacy-hotel", name: "Legacy Hotel", status: "active", modules: ["procurement"], requestId: "create-legacy" };
    const result = await createHotelHandler(req(operator, details), services());
    assert.deepEqual(await createHotelHandler(req(operator, details), services()), result);
    const root = (await db.doc("hotels/legacy-hotel").get()).data();
    assert.equal(root.currency, "EUR"); assert.equal(root.timeZone, undefined);
    assert.equal((await db.doc("hotels/legacy-hotel/settings/bootstrap").get()).data().currency, "EUR");
    assert.deepEqual((await db.doc("hotels/legacy-hotel/settings/propertySettings").get()).data(), {});
    await assert.rejects(createHotelHandler(req(operator, { ...details, currency: "EUR" }), services()), { code: "already-exists" });
  });
  it("resumes receipts written by the prior create policy without silently rewriting their settings", async () => {
    const details = { hotelUid: "prior-policy-hotel", name: "Prior Policy Hotel", timeZone: "Europe/Brussels", status: "active", modules: ["procurement"], requestId: "prior-create" };
    const result = { hotelUid: details.hotelUid, name: details.name, status: details.status, validUntilMillis: null };
    const before = { name: details.name, timeZone: details.timeZone };
    await db.doc(`hotels/${details.hotelUid}`).set(before);
    await db.doc(`platformOperations/${digest(operator.uid, details.requestId)}`).set({ type: "create-hotel", actorUid: operator.uid,
      fingerprint: digest(details.hotelUid, details.name, details.status, 14, details.modules, null, details.timeZone), result });
    assert.deepEqual(await createHotelHandler(req(operator, details), services()), result);
    assert.deepEqual((await db.doc(`hotels/${details.hotelUid}`).get()).data(), before);
  });
  it("rechecks live platform authority inside creation transaction", async () => {
    const input = { hotelUid: "revoked-hotel", name: "Revoked Hotel", timeZone: "Europe/Brussels", currency: "EUR", status: "active", requestId: "create-revoked" };
    const revokedDuringTransaction = { doc: (...args) => db.doc(...args), runTransaction: async (operation) => {
      await auth.setCustomUserClaims(operator.uid, {});
      return db.runTransaction(operation);
    } };
    await assert.rejects(createHotelHandler(req(operator, input), { firestore: revokedDuringTransaction, auth }), { code: "permission-denied" });
    assert.equal((await db.doc("hotels/revoked-hotel").get()).exists, false);
    assert.equal((await db.doc("hotelSubscriptions/revoked-hotel").get()).exists, false);
  });
});
