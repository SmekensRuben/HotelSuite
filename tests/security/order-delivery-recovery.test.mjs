import { before, beforeEach, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { initializeTestEnvironment, assertFails } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, updateDoc, deleteDoc } from "firebase/firestore";

const projectId = "demo-hotel-suite-a00";
for (const key of ["FIRESTORE_EMULATOR_HOST", "FIREBASE_AUTH_EMULATOR_HOST", "FIREBASE_STORAGE_EMULATOR_HOST"]) {
  if (!/^(127\.0\.0\.1|localhost):\d+$/.test(process.env[key] || "")) throw new Error("Only real local emulators are allowed.");
}
process.env.FIREBASE_CONFIG = JSON.stringify({ projectId, storageBucket: `${projectId}.appspot.com` });
const require = createRequire(import.meta.url);
const { admin } = require("../../functions/src/config");
const { SAAS_RULES_VERSION } = require("../../functions/src/saasRollout");
const { digest } = require("../../functions/src/validation");
const api = () => require("../../functions/src/deliveryRecovery");
const delivery = () => require("../../functions/src/deliveryState");
const db = admin.firestore(), auth = admin.auth();
const services = { firestore: db, auth, now: () => Date.parse("2026-10-16T10:00:00Z") };
const orderPath = "hotels/hotel-a/orders/order", dispatchPath = "hotels/hotel-a/dispatches/dispatch";
const mailPath = `hotels/hotel-a/mailQueue/order-${digest("order", "dispatch")}`;
const identities = Object.fromEntries(["recovery", "approver", "wildcard", "viewer", "foreign", "operator"].map((uid) => [uid, {
  uid, token: { email: `${uid}@example.test`, email_verified: true, auth_time: Math.floor(Date.now() / 1000), ...(uid === "operator" ? { platformAdmin: true } : {}) },
}]));
let environment, sequence = 0;
const next = () => `delivery-recovery-${++sequence}`;
const request = (data, actor = "recovery") => ({ auth: identities[actor], data });
const input = (patch = {}) => ({ hotelUid: "hotel-a", orderId: "order", expectedRevision: 3, requestId: next(), action: "record-review", source: "supplier-contact", evidence: "Supplier could not confirm transport receipt", reason: "Investigate an uncertain dispatch", ...patch });
const review = (data, actor = "recovery") => api().reviewOrderDeliveryHandler(request(data, actor), services);
const read = (data = {}, actor = "recovery") => api().getHotelOrderDeliveryHandler(request({ hotelUid: "hotel-a", orderId: "order", ...data }, actor), services);
const rejected = (promise, code = "permission-denied") => assert.rejects(promise, { code });
const snapshot = async (path) => (await db.doc(path).get()).data();
async function seedDispatch(patch = {}) {
  await db.doc(orderPath).set({ status: "Created", revision: 3, dispatchRequestId: "dispatch", dispatchStatus: patch.status || "needs-review" });
  await db.doc(dispatchPath).set({ orderId: "order", status: "needs-review", externalAttempt: true, actorUid: "approver",
    order: { outletId: "kitchen" }, supplier: { orderSystem: "Email" }, ...patch });
  await db.doc(mailPath).set({ type: "order-confirmation", orderId: "order", dispatchRequestId: "dispatch", status: patch.status || "needs-review", externalAttempt: patch.externalAttempt ?? true });
}

before(async () => {
  environment = await initializeTestEnvironment({ projectId,
    firestore: { host: "127.0.0.1", port: Number(process.env.FIRESTORE_EMULATOR_HOST.split(":").at(-1)), rules: await readFile("firebase/firestore.rules", "utf8") } });
});
beforeEach(async () => {
  await environment.clearFirestore();
  const users = await auth.listUsers(); if (users.users.length) await auth.deleteUsers(users.users.map((user) => user.uid));
  for (const identity of Object.values(identities)) {
    await auth.createUser({ uid: identity.uid, email: identity.token.email, emailVerified: true });
    await auth.setCustomUserClaims(identity.uid, identity.uid === "operator" ? { platformAdmin: true } : {});
    identity.token.auth_time = Math.floor(Date.now() / 1000);
  }
  await db.doc("platformConfiguration/saasProcurement").set({ enabled: true, rulesVersion: SAAS_RULES_VERSION });
  for (const hotelUid of ["hotel-a", "hotel-b"]) {
    await db.doc(`hotels/${hotelUid}`).set({ hotelName: hotelUid });
    await db.doc(`hotelSubscriptions/${hotelUid}`).set({ status: "active", validUntil: null, modules: ["procurement"], modulePolicyVersion: 1 });
  }
  await db.doc("hotels/hotel-a/members/recovery").set({ permissions: ["orders.read", "orders.recover"] });
  await db.doc("hotels/hotel-a/members/approver").set({ permissions: ["orders.read", "orders.approve"] });
  await db.doc("hotels/hotel-a/members/wildcard").set({ permissions: ["orders.*"], hotelAdmin: true });
  await db.doc("hotels/hotel-a/members/viewer").set({ permissions: ["orders.read"] });
  await db.doc("hotels/hotel-b/members/foreign").set({ permissions: ["orders.read", "orders.recover"] });
  await db.doc("hotels/hotel-a/outlets/kitchen/approvers/approver").set({ active: true });
});
after(async () => environment.cleanup());

describe("order delivery recovery boundaries and durable transport evidence", () => {
  it("requires explicit hotel recovery authority and keeps review history private and tenant scoped", async () => {
    await seedDispatch(); const command = input();
    for (const actor of ["approver", "wildcard", "viewer", "foreign"]) await rejected(review(command, actor));
    await rejected(review({ ...command, hotelUid: "hotel-b" })); await rejected(read({}, "foreign"));
    const result = await review(command); assert.equal(result.status, "needs-review");
    const view = await read({}, "viewer"); assert.equal(view.outcome, "unknown"); assert.equal(view.events.length, 1);
    assert.equal(view.events[0].reason, command.reason); assert.equal(view.events[0].source, command.source);
    for (const actor of ["recovery", "wildcard", "foreign", "operator"]) {
      const browser = environment.authenticatedContext(actor, identities[actor].token).firestore();
      for (const path of [dispatchPath, mailPath, `hotels/hotel-a/orderAudit/${view.events[0].id}`]) {
        const reference = doc(browser, path);
        await assertFails(getDoc(reference)); await assertFails(setDoc(reference, { status: "sent" }));
        await assertFails(updateDoc(reference, { status: "sent" })); await assertFails(deleteDoc(reference));
      }
      await assertFails(updateDoc(doc(browser, orderPath), { status: "Ordered" }));
    }
    await db.doc("hotels/hotel-a/orderAudit/unrelated").set({ orderId: "other-order", revision: 1 });
    await rejected(read({ afterEventId: "unrelated" }), "invalid-argument");
  });

  it("records one uncertain outcome without resending and prevents delayed workers from overwriting it", async () => {
    await seedDispatch({ status: "processing", externalAttempt: true, processingAt: admin.firestore.Timestamp.fromMillis(services.now() - 900000) });
    const command = input(), beforeDispatches = (await db.collection("hotels/hotel-a/dispatches").get()).size;
    const result = await review(command); assert.deepEqual(await review(command), result);
    await assert.rejects(review({ ...command, reason: "Conflicting rationale" }), (error) => {
      assert.equal(error.code, "already-exists");
      assert.notEqual(error.details?.deliveryRequestUncommitted, true, "An existing committed receipt must never be advertised as uncommitted.");
      return true;
    });
    assert.equal((await db.collection("hotels/hotel-a/orderAudit").get()).size, 1);
    assert.equal((await db.collection("hotels/hotel-a/dispatches").get()).size, beforeDispatches);
    assert.equal(await delivery().completeDispatch(db, "hotel-a", "order", "dispatch", "sent", { providerId: "late-response" }), false);
    assert.equal((await snapshot(orderPath)).status, "Created"); assert.equal((await snapshot(dispatchPath)).status, "needs-review");
    await rejected(review(input({ expectedRevision: 4, action: "retry-preparation", source: "configuration-review" })), "failed-precondition");
    await db.doc("hotels/hotel-a/members/recovery").update({ permissions: ["orders.read"] });
    await rejected(review(command));
  });

  it("accepts matching transport evidence once without implying supplier acceptance or issuing another dispatch", async () => {
    await seedDispatch(); const command = input({ action: "record-receipt", source: "email-provider", evidence: "Provider dashboard receipt msg-fixture" });
    await rejected(review({ ...command, source: "configuration-review" }), "invalid-argument");
    const outcomes = await Promise.allSettled([review(command), review({ ...command, requestId: next() })]);
    assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
    assert.equal(outcomes.find((outcome) => outcome.status === "rejected").reason.code, "aborted");
    const current = await snapshot(orderPath); assert.equal(current.status, "Ordered");
    assert.equal(current.supplierConfirmation, undefined); assert.match(current.dispatchStep, /supplier acceptance tracked separately/i);
    assert.equal((await db.collection("hotels/hotel-a/dispatches").get()).size, 1);
    assert.equal((await db.collection("hotels/hotel-a/mailQueue").get()).size, 1);
    assert.equal((await read()).outcome, "transport-accepted");
  });

  it("records positively verified supplier receipt without accepting commercial terms or reopening the send fence", async () => {
    await seedDispatch();
    const command = input({ action: "record-receipt", source: "supplier-contact", evidence: "Supplier dispatch desk confirmed receipt of this exact order by reference", reason: "Close the uncertain delivery after direct receipt verification" });
    const result = await review(command);
    assert.deepEqual(await review(command), result);
    const current = await snapshot(orderPath), currentDispatch = await snapshot(dispatchPath), view = await read();
    assert.equal(current.status, "Ordered"); assert.equal(current.supplierConfirmation, undefined);
    assert.equal((await db.collection(`${orderPath}/supplierConfirmations`).get()).size, 0);
    assert.match(current.dispatchStep, /supplier receipt verified; acceptance tracked separately/i);
    assert.equal(currentDispatch.receiptSource, "supplier-contact"); assert.equal(view.outcome, "receipt-verified");
    assert.equal(view.canRetryPreparation, false); assert.equal(view.events.length, 1);
    assert.equal(view.events[0].source, command.source); assert.equal(view.events[0].evidence, command.evidence);
    assert.equal(await delivery().markDispatchExternalAttempt(db, "hotel-a", "order", "dispatch"), false);
    assert.equal(await delivery().completeDispatch(db, "hotel-a", "order", "dispatch", "sent", { providerId: "late-provider-response" }), false);
    assert.equal((await db.collection("hotels/hotel-a/dispatches").get()).size, 1);
    assert.equal((await db.collection("hotels/hotel-a/mailQueue").get()).size, 1);
    await rejected(review(input({ expectedRevision: 4, action: "retry-preparation", source: "configuration-review" })), "failed-precondition");
  });

  it("retries proven preparation failures only with current outlet approval authority", async () => {
    await seedDispatch({ status: "failed", externalAttempt: false });
    const command = input({ action: "retry-preparation", source: "configuration-review", evidence: "Email configuration corrected before any send" });
    await rejected(review(command));
    await db.doc("hotels/hotel-a/members/recovery").update({ permissions: ["orders.read", "orders.recover", "orders.approve"] });
    await rejected(review(command));
    await db.doc("hotels/hotel-a/outlets/kitchen/approvers/recovery").set({ active: true });
    const result = await review(command); assert.deepEqual(await review(command), result);
    assert.equal((await snapshot(dispatchPath)).status, "superseded"); assert.equal((await snapshot(mailPath)).status, "superseded");
    assert.equal((await db.collection("hotels/hotel-a/dispatches").get()).size, 2);
    const replacement = await snapshot(`hotels/hotel-a/dispatches/${result.dispatchId}`);
    assert.equal(replacement.actorUid, "recovery"); assert.equal(replacement.externalAttempt, false);
    assert.equal(await delivery().markDispatchExternalAttempt(db, "hotel-a", "order", "dispatch"), false);
  });

  it("persists the external-attempt fence before transport, rejects duplicates and refuses retry after a crash", async () => {
    await seedDispatch({ status: "processing", externalAttempt: false, processingAt: admin.firestore.Timestamp.fromMillis(services.now() - 900000) });
    const outcomes = await Promise.all([
      delivery().markDispatchExternalAttempt(db, "hotel-a", "order", "dispatch", mailPath.split("/").at(-1)),
      delivery().markDispatchExternalAttempt(db, "hotel-a", "order", "dispatch", mailPath.split("/").at(-1)),
    ]);
    assert.deepEqual(outcomes.sort(), [false, true]);
    assert.equal((await snapshot(dispatchPath)).externalAttempt, true); assert.equal((await snapshot(mailPath)).externalAttempt, true);
    assert.equal((await read()).outcome, "unknown");
    await rejected(review(input({ action: "retry-preparation", source: "configuration-review" })), "failed-precondition");
    assert.equal((await db.collection("hotels/hotel-a/dispatches").get()).size, 1);
  });
});
