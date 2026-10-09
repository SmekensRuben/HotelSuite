import { before, beforeEach, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { doc, getDoc, getDocs, collection, updateDoc, setDoc } from "firebase/firestore";

// This suite must never reach a production project or an external mail/SFTP server.
const projectId = "demo-hotel-suite-a00";
if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) throw new Error("Firestore and Auth emulators are required.");
process.env.FIREBASE_CONFIG = JSON.stringify({ projectId, storageBucket: `${projectId}.appspot.com` });
const require = createRequire(import.meta.url);
const { admin } = require("../../functions/src/config");
const { createHotelHandler, inviteHotelUserHandler, listHotelUsersHandler, getHotelOnboardingStatusHandler } = require("../../functions/src/onboarding");
const { saveSupplierHandler, listSuppliersHandler, getSupplierConnectionHandler, migrateSupplierCredentialsHandler } = require("../../functions/src/suppliers");
const { mutateShoppingCartHandler } = require("../../functions/src/shoppingCarts");
const { createOrdersFromCartHandler, updateOrderHandler, deleteOrderHandler, confirmOrderHandler, setOutletApproversHandler } = require("../../functions/src/orders");
const { dispatchOrderHandler } = require("../../functions/src/sftpDispatch");
const { processMailQueueHandler, enqueueOrderEmail } = require("../../functions/src/mailQueue");
const { setHotelSubscriptionHandler } = require("../../functions/src/subscriptions");
const { reviewOrderDeliveryHandler } = require("../../functions/src/deliveryRecovery");
const { requireSaasRollout, gated } = require("../../functions/src/saasRollout");
const db = admin.firestore();
const auth = admin.auth();
const services = { firestore: db, auth, appBaseUrl: "https://pilot.example.test" };
const operator = { uid: "operator", token: { email_verified: true, platformAdmin: true, email: "operator@example.test" } };
let environment;
let sequence = 0;
let managerA, managerB, purchaserA, approverA, viewerA;
const request = (identity, data) => ({ auth: identity, data });
const rejected = (promise, code) => assert.rejects(promise, (error) => error.code === code);
const identity = (user) => ({ uid: user.uid, token: { email_verified: true, email: user.email } });
const client = (user, extra = {}) => environment.authenticatedContext(user.uid, { email_verified: true, ...extra }).firestore();
const nextId = () => `request-${++sequence}`;

async function invite(hotelUid, role, address) {
  const result = await inviteHotelUserHandler(request(operator, { hotelUid, role, email: address, firstName: "Pilot", lastName: role, requestId: nextId() }), services);
  const user = await auth.updateUser(result.uid, { emailVerified: true });
  return identity(user);
}
async function supplier(hotelUid = "hotel-a", actor = managerA) {
  const result = await saveSupplierHandler(request(actor, { hotelUid, requestId: nextId(), expectedRevision: 0,
    supplier: { name: "Pilot supplier", orderSystem: "Email", orderEmail: "supplier@example.test", orderEmailCc: [], deliveryDays: [1, 2, 3, 4, 5] },
    credentials: { username: "portal-user", password: "fictional-private-password" } }), services);
  await db.doc(`hotels/${hotelUid}/supplierproducts/product`).set({ supplierId: result.supplierId, supplierProductName: "Coffee", supplierSku: "C-1", pricePerPurchaseUnit: 12.50, currency: "EUR", active: true });
  return result.supplierId;
}
async function cart(hotelUid = "hotel-a", actor = purchaserA) {
  const { cartId } = await mutateShoppingCartHandler(request(actor, { hotelUid, action: "get-or-create", requestId: nextId() }), services);
  await mutateShoppingCartHandler(request(actor, { hotelUid, cartId, action: "add", productId: "product", value: 2, requestId: nextId() }), services);
  const result = await mutateShoppingCartHandler(request(actor, { hotelUid, cartId, action: "outlet", productId: "product", value: "restaurant", requestId: nextId() }), services);
  return { shoppingCartId: cartId, expectedCartRevision: result.revision };
}
async function order() {
  await supplier();
  const input = { hotelUid: "hotel-a", ...await cart(), deliveryDate: "2026-10-10", requestId: nextId() };
  const result = await createOrdersFromCartHandler(request(purchaserA, input), services);
  return result.orderIds[0];
}
async function designate() {
  await setOutletApproversHandler(request(managerA, { hotelUid: "hotel-a", outletId: "restaurant", userIds: [approverA.uid] }), services);
}
function eventFor(snapshot, before = {}) {
  return { params: { hotelUid: "hotel-a", orderId: snapshot.id }, data: { before: { exists: true, data: () => before }, after: snapshot } };
}
async function confirm(orderId) {
  await designate();
  return confirmOrderHandler(request(approverA, { hotelUid: "hotel-a", orderId, requestId: nextId(), expectedRevision: 1 }), services);
}

before(async () => {
  environment = await initializeTestEnvironment({ projectId, firestore: { host: "127.0.0.1", port: 8080, rules: await readFile("firebase/firestore.rules", "utf8") } });
});
beforeEach(async () => {
  await environment.clearFirestore();
  const users = await auth.listUsers();
  if (users.users.length) await auth.deleteUsers(users.users.map((u) => u.uid));
  await auth.createUser({ uid: operator.uid, email: operator.token.email, emailVerified: true });
  await auth.setCustomUserClaims(operator.uid, { platformAdmin: true });
  for (const hotelUid of ["hotel-a", "hotel-b"]) {
    await createHotelHandler(request(operator, { hotelUid, name: hotelUid, status: "active", requestId: nextId() }), services);
    await db.doc(`hotels/${hotelUid}/outlets/restaurant`).set({ name: "Restaurant" });
  }
  managerA = await invite("hotel-a", "manager", "manager-a@example.test");
  managerB = await invite("hotel-b", "manager", "manager-b@example.test");
  purchaserA = await invite("hotel-a", "purchaser", "purchaser-a@example.test");
  approverA = await invite("hotel-a", "approver", "approver-a@example.test");
  viewerA = await invite("hotel-a", "viewer", "viewer-a@example.test");
});
after(async () => environment.cleanup());

describe("two-hotel SaaS pilot with real Auth and Firestore emulators", () => {
  it("blocks live write handlers until the reviewed Rules rollout is enabled", async () => {
    await rejected(requireSaasRollout(db), "failed-precondition");
    assert.deepEqual(await getHotelOnboardingStatusHandler(request(operator, {}), services), { enabled: false });
    await rejected(getHotelOnboardingStatusHandler(request(managerA, {}), services), "permission-denied");
    await rejected(listHotelUsersHandler(request(viewerA, { hotelUid: "hotel-a" }), services), "permission-denied");
    const handler = gated(async () => ({ changed: true }));
    await rejected(handler(request(operator, {})), "failed-precondition");
    await db.doc("platformConfiguration/saasProcurement").set({ enabled: true, rulesVersion: "wrong" });
    await rejected(handler(request(operator, {})), "failed-precondition");
    await db.doc("platformConfiguration/saasProcurement").set({ enabled: true, rulesVersion: "saas-procurement-v1" });
    assert.deepEqual(await handler(request(operator, {})), { changed: true });
    assert.deepEqual(await getHotelOnboardingStatusHandler(request(operator, {}), services), { enabled: true });
    const pausedDuringRequest = gated(async (input) => {
      await db.doc("platformConfiguration/saasProcurement").update({ enabled: false });
      return createHotelHandler(input, services);
    });
    await rejected(pausedDuringRequest(request(operator, { hotelUid: "race-hotel", name: "Race hotel", status: "active", requestId: nextId() })), "failed-precondition");
    assert.equal((await db.doc("hotels/race-hotel").get()).exists, false);
    await rejected(handler(request({ ...operator, token: { platformAdmin: true } }, {})), "permission-denied");
    await assertFails(getDoc(doc(client(managerA), "platformConfiguration/saasProcurement")));
    await assertFails(setDoc(doc(client(operator, { platformAdmin: true }), "platformConfiguration/saasProcurement"), { enabled: true }));
  });

  it("runs the uploadable operator preflight, migration and activation without granting access", async () => {
    const run = promisify(execFile);
    const command = (mode) => run(process.execPath, ["scripts/firebase/saas-rollout.mjs", mode, "--emulator", ...(mode === "preflight" ? [] : ["--rules-verified"])], { env: process.env, timeout: 30000 });
    await db.doc("hotels/hotel-a/suppliers/legacy").set({ name: "Legacy", password: "fictional-legacy-secret" });
    const membership = db.doc(`hotels/hotel-a/members/${managerA.uid}`);
    await membership.update({ permissions: ["auditUpsells.read", "orders.approve"] });
    const before = await db.doc("hotelSubscriptions/hotel-a").get();
    const preflight = await command("preflight");
    assert.match(preflight.stdout, /"legacySupplierRecords": 1/);
    assert.doesNotMatch(preflight.stdout, /fictional-legacy-secret/);
    assert.equal((await db.doc("hotels/hotel-a/suppliers/legacy").get()).data().password, "fictional-legacy-secret");
    await command("migrate");
    assert.equal((await db.doc("hotels/hotel-a/suppliers/legacy").get()).data().password, undefined);
    assert.equal((await db.doc("hotels/hotel-a/supplierSecrets/legacy").get()).data().password, "fictional-legacy-secret");
    assert.deepEqual((await membership.get()).data().permissions, ["auditupsells.read", "orders.approve"]);
    await command("enable");
    assert.equal((await db.doc("platformConfiguration/saasProcurement").get()).data().enabled, true);
    assert.deepEqual((await db.doc("hotelSubscriptions/hotel-a").get()).data(), before.data());
    assert.deepEqual((await auth.getUser(managerA.uid)).customClaims || {}, {});
    await membership.delete();
    await assert.rejects(command("preflight"), (error) => error.stdout.includes("Canonical membership is missing"));
  });

  it("resends invitations without changing existing roles and rejects changed supplier create retries", async () => {
    const before = (await db.doc(`hotels/hotel-a/members/${viewerA.uid}`).get()).data();
    const invitation = { hotelUid: "hotel-a", email: viewerA.token.email, role: "manager", resend: true, requestId: nextId() };
    const first = await inviteHotelUserHandler(request(operator, invitation), services);
    assert.deepEqual(await inviteHotelUserHandler(request(operator, invitation), services), first);
    assert.deepEqual((await db.doc(`hotels/hotel-a/members/${viewerA.uid}`).get()).data(), before);
    const create = { hotelUid: "hotel-a", requestId: nextId(), expectedRevision: 0, supplier: { name: "Supplier", orderSystem: "Email", orderEmailCc: [], deliveryDays: [] } };
    const saved = await saveSupplierHandler(request(managerA, create), services);
    assert.deepEqual(await saveSupplierHandler(request(managerA, create), services), saved);
    await rejected(saveSupplierHandler(request(managerA, { ...create, supplier: { ...create.supplier, name: "Changed" } }), services), "already-exists");
  });

  it("requires a new review when supplier account or delivery configuration changes", async () => {
    const id = await order();
    await designate();
    const initial = await db.doc(`hotels/hotel-a/orders/${id}`).get();
    await db.doc(`hotels/hotel-a/suppliers/${initial.data().supplierId}`).update({ accountNumber: "NEW-ACCOUNT" });
    await rejected(confirmOrderHandler(request(approverA, { hotelUid: "hotel-a", orderId: id, requestId: nextId(), expectedRevision: 1 }), services), "failed-precondition");
    await updateOrderHandler(request(purchaserA, { hotelUid: "hotel-a", orderId: id, expectedRevision: 1, payload: { deliveryDate: initial.data().deliveryDate, products: initial.data().products } }), services);
    const updated = await db.doc(`hotels/hotel-a/orders/${id}`).get();
    assert.equal(updated.data().accountNumber, "NEW-ACCOUNT");
    await confirmOrderHandler(request(approverA, { hotelUid: "hotel-a", orderId: id, requestId: nextId(), expectedRevision: 2 }), services);
  });

  it("preserves a fast mail worker's processing state while the dispatch event is still returning", async () => {
    const id = await order();
    const result = await confirm(id);
    const snapshot = await db.doc(`hotels/hotel-a/orders/${id}`).get();
    let sending, release;
    const started = new Promise((resolve) => { sending = resolve; });
    const receipt = new Promise((resolve) => { release = resolve; });
    let worker;
    await dispatchOrderHandler(eventFor(snapshot), { ...services, enqueueEmail: async (input) => {
      const mailId = await enqueueOrderEmail(input, services);
      const queued = await db.doc(`hotels/hotel-a/mailQueue/${mailId}`).get();
      worker = processMailQueueHandler({ params: { hotelUid: "hotel-a", mailId }, data: queued }, {
        ...services, from: "orders@example.test", send: async () => { sending(); await receipt; return { data: { id: "fast-worker-receipt" }, error: null }; },
      });
      await Promise.race([started, worker.then(() => { throw new Error("Mail worker finished before entering the fake provider."); })]);
      return mailId;
    } });
    assert.equal((await db.doc(`hotels/hotel-a/dispatches/${result.dispatchId}`).get()).data().status, "processing");
    release(); await worker;
    assert.equal((await db.doc(`hotels/hotel-a/orders/${id}`).get()).data().status, "Ordered");
  });
  it("creates bounded trials atomically and resumes onboarding without duplicate access or emails", async () => {
    const input = { hotelUid: "trial-hotel", name: "Trial hotel", status: "trialing", trialDays: 14, requestId: nextId() };
    const first = await createHotelHandler(request(operator, input), services);
    const again = await createHotelHandler(request(operator, input), services);
    assert.deepEqual(again, first);
    assert.ok(first.validUntilMillis > Date.now());
    const data = { hotelUid: "trial-hotel", email: "new-manager@example.test", role: "manager", requestId: nextId() };
    const invited = await inviteHotelUserHandler(request(operator, data), services);
    assert.deepEqual(await inviteHotelUserHandler(request(operator, data), services), invited);
    assert.equal((await db.collection("hotels/trial-hotel/mailQueue").get()).size, 1);
    assert.equal((await db.doc(`users/${invited.uid}`).get()).data().hotelUid.length, 1);
    assert.deepEqual((await auth.getUser(invited.uid)).customClaims || {}, {});
    const mail = (await db.collection("hotels/trial-hotel/mailQueue").get()).docs[0].data();
    assert.match(mail.payload.text, /Set your password:/);
    assert.match(mail.payload.text, /Verify your email:/);
    await rejected(createHotelHandler(request(managerA, input), services), "permission-denied");
    await rejected(createHotelHandler(request({ ...operator, token: { platformAdmin: true } }, input), services), "permission-denied");
    await rejected(inviteHotelUserHandler(request(operator, { ...data, role: "platformAdmin", requestId: nextId() }), services), "invalid-argument");
  });

  it("adds a second hotel to an existing account without changing its password, role or other memberships", async () => {
    await auth.updateUser(managerA.uid, { password: "Fictional-password-123" });
    const before = await db.doc(`hotels/hotel-a/members/${managerA.uid}`).get();
    await inviteHotelUserHandler(request(operator, { hotelUid: "hotel-b", email: managerA.token.email, role: "viewer", requestId: nextId() }), services);
    assert.deepEqual((await db.doc(`hotels/hotel-a/members/${managerA.uid}`).get()).data(), before.data());
    assert.deepEqual((await db.doc(`users/${managerA.uid}`).get()).data().hotelUid.sort(), ["hotel-a", "hotel-b"]);
    const mail = (await db.collection("hotels/hotel-b/mailQueue").get()).docs.find((s) => s.data().uid === managerA.uid).data();
    assert.doesNotMatch(mail.payload.text, /Set your password:/);
  });

  it("keeps secrets private, preserves blank passwords and rejects credential changes by ordinary purchasers", async () => {
    const id = await supplier();
    const publicData = (await listSuppliersHandler(request(viewerA, { hotelUid: "hotel-a", supplierId: id }), services)).supplier;
    assert.ok(publicData.credentialsConfigured);
    assert.equal(publicData.password, undefined);
    assert.equal(publicData.username, undefined);
    await assertFails(getDoc(doc(client(managerA), `hotels/hotel-a/supplierSecrets/${id}`)));
    await assertFails(getDoc(doc(client(operator, { platformAdmin: true }), `hotels/hotel-a/supplierSecrets/${id}`)));
    await rejected(getSupplierConnectionHandler(request(purchaserA, { hotelUid: "hotel-a", supplierId: id }), services), "permission-denied");
    const connection = await getSupplierConnectionHandler(request(managerA, { hotelUid: "hotel-a", supplierId: id }), services);
    assert.equal(connection.password, undefined);
    assert.equal(connection.passwordConfigured, true);
    await saveSupplierHandler(request(managerA, { hotelUid: "hotel-a", supplierId: id, expectedRevision: 1,
      supplier: publicData, credentials: { password: "" } }), services);
    assert.equal((await db.doc(`hotels/hotel-a/supplierSecrets/${id}`).get()).data().password, "fictional-private-password");
    await rejected(listSuppliersHandler(request(managerB, { hotelUid: "hotel-a" }), services), "permission-denied");
    await assertFails(updateDoc(doc(client(operator, { platformAdmin: true }), `hotels/hotel-a/suppliers/${id}`), { password: "forged" }));
  });

  it("migrates legacy credentials without returning values or overwriting a newer private password", async () => {
    await db.doc("hotels/hotel-a/suppliers/legacy").set({ name: "Legacy", password: "fictional-old-secret", sftpUser: "legacy-user" });
    await db.doc("hotels/hotel-a/supplierSecrets/legacy").set({ password: "fictional-new-secret" });
    const scan = await migrateSupplierCredentialsHandler(request(operator, { hotelUid: "hotel-a" }), services);
    assert.equal(scan.changed, 1); assert.equal(scan.applied, false);
    assert.match(JSON.stringify(scan), /scanned/); assert.doesNotMatch(JSON.stringify(scan), /fictional-/);
    await migrateSupplierCredentialsHandler(request(operator, { hotelUid: "hotel-a", apply: true }), services);
    assert.equal((await db.doc("hotels/hotel-a/suppliers/legacy").get()).data().password, undefined);
    assert.equal((await db.doc("hotels/hotel-a/supplierSecrets/legacy").get()).data().password, "fictional-new-secret");
  });

  it("creates orders using catalog prices and quantities exactly once, adjusting delivery weekdays", async () => {
    await supplier();
    const cartInput = await cart();
    const ref = db.doc(`hotels/hotel-a/shoppingCarts/${cartInput.shoppingCartId}`);
    const initial = (await ref.get()).data();
    await ref.update({ items: initial.items.map((p) => ({ ...p, pricePerPurchaseUnit: 0.01, supplierId: "hotel-b", supplierName: "forged" })) });
    const input = { hotelUid: "hotel-a", ...cartInput, deliveryDate: "2026-10-10", requestId: nextId() };
    const results = await Promise.all([createOrdersFromCartHandler(request(purchaserA, input), services), createOrdersFromCartHandler(request(purchaserA, input), services)]);
    assert.deepEqual(results[0], results[1]);
    const result = (await db.doc(`hotels/hotel-a/orders/${results[0].orderIds[0]}`).get()).data();
    assert.equal(result.totalAmount, 25);
    assert.equal(result.deliveryDate, "2026-10-12");
    assert.equal(result.createdBy, purchaserA.uid);
    assert.equal((await db.collection("hotels/hotel-a/orders").get()).size, 1);
    assert.deepEqual((await ref.get()).data().items, []);
    await rejected(createOrdersFromCartHandler(request(viewerA, { ...input, requestId: nextId() }), services), "permission-denied");
    await rejected(createOrdersFromCartHandler(request(managerB, { ...input, requestId: nextId() }), services), "permission-denied");
    await assertFails(setDoc(doc(client(managerA), "hotels/hotel-a/orders/forged"), { status: "Ordered" }));
  });

  it("rejects stale cart submissions, unauthorized approvers and every edit after confirmation", async () => {
    const id = await order();
    await designate();
    const input = { hotelUid: "hotel-a", orderId: id, expectedRevision: 1, requestId: nextId() };
    await rejected(confirmOrderHandler(request(purchaserA, input), services), "permission-denied");
    await rejected(confirmOrderHandler(request(managerA, input), services), "permission-denied");
    await confirmOrderHandler(request(approverA, input), services);
    await rejected(updateOrderHandler(request(managerA, { hotelUid: "hotel-a", orderId: id, expectedRevision: 2, payload: { deliveryDate: "2026-10-13" } }), services), "failed-precondition");
    await rejected(deleteOrderHandler(request(managerA, { hotelUid: "hotel-a", orderId: id }), services), "failed-precondition");
    await rejected(setOutletApproversHandler(request(managerA, { hotelUid: "hotel-a", outletId: "restaurant", userIds: [managerB.uid] }), services), "failed-precondition");
    await assertFails(setDoc(doc(client(managerA), `hotels/hotel-a/outlets/restaurant/approvers/${managerA.uid}`), { email: "forged@example.test" }));
    const fresh = await cart();
    await mutateShoppingCartHandler(request(purchaserA, { hotelUid: "hotel-a", cartId: fresh.shoppingCartId, action: "quantity", productId: "product", value: 3, requestId: nextId() }), services);
    await rejected(createOrdersFromCartHandler(request(purchaserA, { hotelUid: "hotel-a", ...fresh, deliveryDate: "2026-10-13", requestId: nextId() }), services), "aborted");
  });

  it("delivers one email through duplicate order and mail events and finalizes only after provider acknowledgement", async () => {
    const id = await order(); await confirm(id);
    const snapshot = await db.doc(`hotels/hotel-a/orders/${id}`).get();
    await Promise.all([dispatchOrderHandler(eventFor(snapshot), services), dispatchOrderHandler(eventFor(snapshot), services)]);
    const mails = await db.collection("hotels/hotel-a/mailQueue").where("type", "==", "order-confirmation").get();
    assert.equal(mails.size, 1);
    let calls = 0;
    const send = async (payload, options) => { calls++; assert.deepEqual(payload.to, ["supplier@example.test"]); assert.match(options.idempotencyKey, /^hotelsuite\//); return { data: { id: "fixture-provider-id" }, error: null }; };
    const mailEvent = { params: { hotelUid: "hotel-a", mailId: mails.docs[0].id }, data: mails.docs[0] };
    await Promise.all([processMailQueueHandler(mailEvent, { ...services, send, from: "pilot@example.test" }), processMailQueueHandler(mailEvent, { ...services, send, from: "pilot@example.test" })]);
    assert.equal(calls, 1);
    const final = (await snapshot.ref.get()).data();
    assert.equal(final.status, "Ordered"); assert.equal(final.dispatchStatus, "sent");
  });

  it("keeps an ambiguous email result under review and never sends a duplicate on event retry", async () => {
    const id = await order(); await confirm(id);
    const snapshot = await db.doc(`hotels/hotel-a/orders/${id}`).get();
    await dispatchOrderHandler(eventFor(snapshot), services);
    const mail = (await db.collection("hotels/hotel-a/mailQueue").where("type", "==", "order-confirmation").get()).docs[0];
    let calls = 0;
    const send = async () => { calls++; return { data: null, error: { message: "fictional-sensitive-provider-error" } }; };
    const event = { params: { hotelUid: "hotel-a", mailId: mail.id }, data: mail };
    await processMailQueueHandler(event, { ...services, send, from: "pilot@example.test" });
    await processMailQueueHandler(event, { ...services, send, from: "pilot@example.test" });
    assert.equal(calls, 1);
    const final = (await snapshot.ref.get()).data();
    assert.equal(final.status, "Created"); assert.equal(final.dispatchStatus, "needs-review");
    assert.doesNotMatch(JSON.stringify(final), /fictional-sensitive-provider-error/);
    await rejected(confirmOrderHandler(request(approverA, { hotelUid: "hotel-a", orderId: id, expectedRevision: 2, requestId: nextId() }), services), "failed-precondition");
    await rejected(reviewOrderDeliveryHandler(request(operator, { hotelUid: "hotel-a", orderId: id, expectedRevision: 2, requestId: nextId(), action: "retry-preparation", evidence: "Unconfirmed provider response" }), services), "failed-precondition");
    await rejected(reviewOrderDeliveryHandler(request(managerA, { hotelUid: "hotel-a", orderId: id, expectedRevision: 2, requestId: nextId(), action: "record-receipt", evidence: "Fixture receipt" }), services), "permission-denied");
    await reviewOrderDeliveryHandler(request(operator, { hotelUid: "hotel-a", orderId: id, expectedRevision: 2, requestId: nextId(), action: "record-receipt", evidence: "Provider fixture receipt verified" }), services);
    assert.equal((await snapshot.ref.get()).data().status, "Ordered");
    assert.equal(calls, 1);
  });

  it("retries preparation only when no external send occurred and blocks sending after approver revocation", async () => {
    const id = await order(); await confirm(id);
    let snapshot = await db.doc(`hotels/hotel-a/orders/${id}`).get();
    await dispatchOrderHandler(eventFor(snapshot), services);
    const mail = (await db.collection("hotels/hotel-a/mailQueue").where("type", "==", "order-confirmation").get()).docs[0];
    await mail.ref.update({ "payload.to": [] });
    let calls = 0;
    const send = async () => { calls++; return { data: { id: "fixture-delivery" } }; };
    await processMailQueueHandler({ params: { hotelUid: "hotel-a", mailId: mail.id }, data: mail }, { ...services, send, from: "pilot@example.test" });
    assert.equal(calls, 0); assert.equal((await snapshot.ref.get()).data().dispatchStatus, "failed");
    const recovery = { hotelUid: "hotel-a", orderId: id, expectedRevision: 2, requestId: nextId(), action: "retry-preparation", evidence: "Email configuration reviewed before any external send" };
    await reviewOrderDeliveryHandler(request(operator, recovery), services);
    await reviewOrderDeliveryHandler(request(operator, recovery), services);
    snapshot = await snapshot.ref.get();
    await dispatchOrderHandler(eventFor(snapshot, { dispatchRequestId: "old-dispatch" }), services);
    const pending = (await db.collection("hotels/hotel-a/mailQueue").where("status", "==", "queued").get()).docs.find((m) => m.data().type === "order-confirmation");
    await db.doc(`hotels/hotel-a/members/${approverA.uid}`).delete();
    await processMailQueueHandler({ params: { hotelUid: "hotel-a", mailId: pending.id }, data: pending }, { ...services, send, from: "pilot@example.test" });
    assert.equal(calls, 0); assert.equal((await snapshot.ref.get()).data().dispatchStatus, "blocked");
  });

  it("dispatches one SFTP order with private credentials through duplicated events", async () => {
    const id = await order();
    const orderData = (await db.doc(`hotels/hotel-a/orders/${id}`).get()).data();
    await db.doc(`hotels/hotel-a/suppliers/${orderData.supplierId}`).update({ orderSystem: "SFTP csv" });
    await db.doc(`hotels/hotel-a/supplierSecrets/${orderData.supplierId}`).set({ sftpPassword: "fictional-sftp-secret" });
    await confirm(id);
    const snapshot = await db.doc(`hotels/hotel-a/orders/${id}`).get();
    let calls = 0;
    const sendSftp = async (frozen, secret, context) => {
      calls++; assert.equal(frozen.products[0].pricePerPurchaseUnit, 12.5);
      assert.equal(secret.sftpPassword, "fictional-sftp-secret"); context.markExternalAttempt();
      return { remotePath: "/incoming/fixture.csv" };
    };
    await Promise.all([dispatchOrderHandler(eventFor(snapshot), { ...services, sendSftp }), dispatchOrderHandler(eventFor(snapshot), { ...services, sendSftp })]);
    assert.equal(calls, 1); assert.equal((await snapshot.ref.get()).data().dispatchedVia, "sftp");
  });

  it("enforces suspension, expiry, reactivation and membership revocation across both hotel boundaries", async () => {
    const id = await order();
    const orderRef = doc(client(purchaserA), `hotels/hotel-a/orders/${id}`);
    await assertSucceeds(getDoc(orderRef));
    for (const status of ["suspended", "canceled"]) {
      const current = (await db.doc("hotelSubscriptions/hotel-a").get()).data();
      await setHotelSubscriptionHandler(request(operator, { hotelUid: "hotel-a", status, planId: "standard", expectedRevision: current.revision }), services);
      await assertFails(getDoc(orderRef));
      await rejected(listSuppliersHandler(request(managerA, { hotelUid: "hotel-a" }), services), "permission-denied");
    }
    // The Functions unit suite checks the exact expiry boundary. Use an old expiry
    // here so Java and Node clock skew cannot make the integration fixture active.
    await db.doc("hotelSubscriptions/hotel-a").update({ status: "trialing", validUntil: admin.firestore.Timestamp.fromMillis(1) });
    await assertFails(getDoc(orderRef));
    const current = (await db.doc("hotelSubscriptions/hotel-a").get()).data();
    await setHotelSubscriptionHandler(request(operator, { hotelUid: "hotel-a", status: "active", planId: "standard", expectedRevision: current.revision }), services);
    await assertSucceeds(getDoc(orderRef));
    await assertFails(getDocs(collection(client(managerB), "hotels/hotel-a/orders")));
    const scoped = await listHotelUsersHandler(request(managerA, { hotelUid: "hotel-a" }), services);
    assert.equal(scoped.users.some((u) => u.id === managerB.uid), false);
    await db.doc(`hotels/hotel-a/members/${purchaserA.uid}`).delete();
    await assertFails(getDoc(orderRef));
  });
});
