import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { before, beforeEach, after, test } from "node:test";
import assert from "node:assert/strict";
import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { doc, getDoc } from "firebase/firestore";
import { seedStagingData, stagingCredentialsFingerprint, resetStagingData, setSubscriptionScenario, withStagingDataOperation } from "../../scripts/firebase/staging-data.mjs";
import { buildStagingData, HOTEL_IDS, MANIFEST_PATH, PROVENANCE, fixtureUsers } from "../../scripts/firebase/staging-data-fixtures.mjs";

if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) throw new Error("Only local emulators are allowed.");
const projectId = "demo-hotel-suite-a00";
process.env.FIREBASE_CONFIG = JSON.stringify({ projectId, storageBucket: `${projectId}.appspot.com` });
const require = createRequire(import.meta.url), { admin } = require("../../functions/src/config");
const { SAAS_RULES_VERSION } = require("../../functions/src/saasRollout");
const { getHotelPurchaseRequestHandler, mutateHotelPurchaseRequestHandler } = require("../../functions/src/purchaseRequests");
const { getHotelInventoryPeriodHandler } = require("../../functions/src/inventoryReports");
const { confirmOrderHandler } = require("../../functions/src/orders");
const { recordHotelOrderReceiptHandler } = require("../../functions/src/orderReceiving");
const { createHotelStockCountHandler, mutateHotelStockCountHandler } = require("../../functions/src/stockCounts");
const db = admin.firestore(), auth = admin.auth(), services = { firestore: db, auth, now: () => Date.parse("2026-10-16T12:00:00Z") };
const fixture = buildStagingData({ businessDate: "2026-10-16" });
const credentials = { users: fixture.users.map((user) => ({ ...user, password: "EmulatorOnly-GeneratedFixture-123!" })) };
const input = (role, data, hotelUid = HOTEL_IDS[0]) => ({ auth: { uid: `${hotelUid}-${role}`, token: { email: `${hotelUid}-${role}@example.invalid`, email_verified: true, auth_time: Math.floor(Date.now() / 1000) } }, data: { hotelUid, ...data } });
let environment;
before(async () => {
  environment = await initializeTestEnvironment({ projectId, firestore: { host: "127.0.0.1", port: Number(process.env.FIRESTORE_EMULATOR_HOST.split(":").at(-1)), rules: await readFile("firebase/firestore.rules", "utf8") } });
});
beforeEach(async () => {
  await environment.clearFirestore();
  const current = await auth.listUsers(); if (current.users.length) await auth.deleteUsers(current.users.map((user) => user.uid));
});
after(async () => environment.cleanup());
const seed = () => seedStagingData({ db, auth, fixture, credentials });
const activate = () => db.doc("platformConfiguration/saasProcurement").set({ enabled: true, rulesVersion: SAAS_RULES_VERSION });

test("staging seed is create-only, repeatable, tenant-isolated and preserves the release activation boundary", async () => {
  await db.doc("platformConfiguration/saasProcurement").set({ enabled: false, rulesVersion: SAAS_RULES_VERSION });
  const first = await seed(); assert.equal(first.hotels, 2); assert.equal(first.users, 10);
  assert.equal((await db.doc("platformConfiguration/saasProcurement").get()).data().enabled, false);
  await assert.rejects(getHotelPurchaseRequestHandler(input("purchaser", { purchaseRequestId: "staging-request-draft" }), services), { code: "failed-precondition" });
  await activate();
  const own = environment.authenticatedContext(`${HOTEL_IDS[0]}-purchaser`, { email_verified: true }).firestore();
  await assertSucceeds(getDoc(doc(own, `hotels/${HOTEL_IDS[0]}/catalogproducts/demo-v1-catalog-milk`)));
  await assertFails(getDoc(doc(own, `hotels/${HOTEL_IDS[1]}/catalogproducts/demo-v1-catalog-milk`)));
  const revoked = environment.authenticatedContext(`${HOTEL_IDS[0]}-revoked`, { email_verified: true }).firestore();
  await assertFails(getDoc(doc(revoked, `hotels/${HOTEL_IDS[0]}/catalogproducts/demo-v1-catalog-milk`)));
  await assertFails(getDoc(doc(own, MANIFEST_PATH)));
  const productRef = db.doc(`hotels/${HOTEL_IDS[0]}/catalogproducts/demo-v1-catalog-milk`);
  await productRef.update({ name: "STAGING manually reviewed milk" });
  assert.equal((await seed()).alreadySeeded, true);
  const manifestBefore = await db.doc(MANIFEST_PATH).get();
  assert.equal(manifestBefore.data().credentialFingerprint, stagingCredentialsFingerprint(credentials));
  assert.equal(JSON.stringify(manifestBefore.data()).includes(credentials.users[0].password), false);
  await assert.rejects(seedStagingData({ db, auth, fixture, credentials: { users: credentials.users.map((row) => ({ ...row, password: `${row.password}-different` })) } }), /credentials do not match/);
  assert((await db.doc(MANIFEST_PATH).get()).updateTime.isEqual(manifestBefore.updateTime));
  assert.equal((await productRef.get()).data().name, "STAGING manually reviewed milk");
  for (const saved of credentials.users) {
    const response = await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=emulator-only`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: saved.email, password: saved.password, returnSecureToken: true }),
    });
    assert.equal(response.status, 200, `The original credentials must still sign in ${saved.uid}`);
    const login = await response.json(); assert.equal(login.localId, saved.uid); assert.equal(typeof login.idToken, "string");
    const user = await auth.getUser(saved.uid);
    assert.equal(user.emailVerified, true); assert.notEqual(user.customClaims.platformAdmin, true);
  }
});

test("seeded requests, budgets and immutable inventory evidence work through actual protected handlers", async () => {
  await seed(); await activate();
  const read = await getHotelPurchaseRequestHandler(input("purchaser", { purchaseRequestId: "staging-request-pending" }), services);
  assert.equal(read.request.totalMinor, 15000); assert.equal(read.budget.pendingMinor, 15000);
  await assert.rejects(mutateHotelPurchaseRequestHandler(input("counter", { purchaseRequestId: "staging-request-pending", requestId: "deny-counter", action: "approve", expectedRevision: 1 }), services), { code: "permission-denied" });
  const approved = await mutateHotelPurchaseRequestHandler(input("approver", { purchaseRequestId: "staging-request-pending", requestId: "approve-fixture", action: "approve", expectedRevision: 1 }), services);
  assert.equal(approved.request.status, "approved"); assert.equal(approved.budget.pendingMinor, 0); assert.equal(approved.budget.committedMinor, 15000);
  await assert.rejects(getHotelPurchaseRequestHandler({ ...input("purchaser", {}), data: { hotelUid: HOTEL_IDS[1], purchaseRequestId: "staging-request-pending" } }, services), { code: "permission-denied" });
  await assert.rejects(getHotelPurchaseRequestHandler(input("revoked", { purchaseRequestId: "staging-request-pending" }), services), { code: "permission-denied" });
  const report = await getHotelInventoryPeriodHandler(input("counter", { openingStockCountId: "demo-v1-count-opening", closingStockCountId: "demo-v1-count-closing", locationId: "demo-v1-location-1" }), services);
  assert.equal(report.currentlyComplete, true);
  assert.equal(report.items.find((item) => item.catalogProductId === "demo-v1-catalog-milk").inferredUsageQuantity, 50);
});

test("subscription exception scenarios deny ordinary access, restore cleanly and never change the other hotel", async () => {
  await seed(); await activate();
  const read = () => getHotelPurchaseRequestHandler(input("purchaser", { purchaseRequestId: "staging-request-draft" }, HOTEL_IDS[1]), services);
  for (const subscription of ["suspended", "expired"]) {
    await setSubscriptionScenario({ db, subscription });
    await assert.rejects(read(), { code: "permission-denied" });
    assert.equal((await db.doc(`hotelSubscriptions/${HOTEL_IDS[0]}`).get()).data().status, "active");
  }
  await setSubscriptionScenario({ db, subscription: "active" }); assert.equal((await read()).request.status, "draft");
  await db.doc(`hotelSubscriptions/${HOTEL_IDS[1]}`).update({ modules: [] });
  await assert.rejects(read(), { code: "permission-denied" });
  await db.doc(`hotelSubscriptions/${HOTEL_IDS[1]}`).update({ modules: ["procurement"] });
  assert.equal((await read()).request.status, "draft");
});

test("reset removes only owned synthetic tenants/users and their scenario work; seeding after reset restores the baseline", async () => {
  await seed(); await activate();
  await db.doc("hotels/unrelated/catalogproducts/keep").set({ value: "untouched" });
  await db.doc("hotelSubscriptions/unrelated").set({ status: "suspended" });
  await auth.createUser({ uid: "unrelated-user", email: "unrelated@example.invalid" });
  await db.doc(`hotels/${HOTEL_IDS[0]}/purchaseRequests/manual-scenario/history/1`).set({ syntheticScenario: true });
  await resetStagingData({ db, auth });
  assert.equal((await db.doc(MANIFEST_PATH).get()).exists, false);
  assert.equal((await db.collection(`hotels/${HOTEL_IDS[0]}/purchaseRequests`).get()).size, 0);
  assert.equal((await db.doc("hotels/unrelated/catalogproducts/keep").get()).data().value, "untouched");
  assert.equal((await db.doc("hotelSubscriptions/unrelated").get()).data().status, "suspended");
  assert.equal((await auth.getUser("unrelated-user")).uid, "unrelated-user");
  assert.equal((await db.doc("platformConfiguration/saasProcurement").get()).data().enabled, true);
  assert.equal((await resetStagingData({ db, auth })).alreadyReset, true);
  assert.equal((await seed()).alreadySeeded, false); assert.equal((await db.doc(`hotels/${HOTEL_IDS[0]}/purchaseRequests/staging-request-pending`).get()).data().revision, 1);
});

test("collisions and ownership changes fail before destructive writes", async () => {
  await db.doc(`hotels/${HOTEL_IDS[0]}`).set({ name: "Do not overwrite" });
  await assert.rejects(seed(), /collision/); assert.equal((await auth.listUsers()).users.length, 0);
  await db.doc(`hotels/${HOTEL_IDS[0]}`).delete(); await seed();
  await db.doc(`hotelSubscriptions/${HOTEL_IDS[1]}`).set({ status: "active" });
  await assert.rejects(resetStagingData({ db, auth }), /unowned/);
  assert.equal((await auth.listUsers()).users.length, fixtureUsers().length);
  assert.equal((await db.doc(`hotels/${HOTEL_IDS[0]}`).get()).exists, true);
});

test("data operations are mutually exclusive with deployment and release their lock on failure", async () => {
  let executed = false;
  await db.doc("_staging/release").set({ state: "deploying" });
  await assert.rejects(withStagingDataOperation(db, "reset", async () => { executed = true; }), /deployment/);
  assert.equal(executed, false);
  await db.doc("_staging/release").set({ state: "paused" });
  await assert.rejects(withStagingDataOperation(db, "seed", async () => {
    await assert.rejects(withStagingDataOperation(db, "reset", async () => {}), /operation is running/);
    throw new Error("Injected failure");
  }), /Injected failure/);
  assert.equal((await db.doc("_staging/dataOperation").get()).data().status, "idle");
});

test("partially provisioned Auth identity can be completed after a claim-write failure", async () => {
  const user = fixture.users[0];
  await db.doc(MANIFEST_PATH).set({ stagingData: PROVENANCE, status: "provisioning", businessDate: fixture.businessDate, authProvisioningUid: user.uid, credentialFingerprint: stagingCredentialsFingerprint(credentials), summary: fixture.summary });
  await auth.createUser({ uid: user.uid, email: user.email, displayName: user.displayName, emailVerified: true, password: credentials.users[0].password });
  await assert.rejects(seedStagingData({ db, auth, fixture, credentials: { users: credentials.users.map((row) => ({ ...row, password: `${row.password}-different` })) } }), /credentials do not match/);
  assert.equal((await auth.listUsers()).users.length, 1);
  assert.equal((await auth.getUser(user.uid)).customClaims?.stagingDataset, undefined);
  await seed();
  assert.equal((await auth.getUser(user.uid)).customClaims.stagingDataset, fixture.datasetId);
  assert.equal((await db.doc(MANIFEST_PATH).get()).data().status, "complete");
});


test("seeded buyers receive a simulated confirmed order and stock controllers finish a complete physical count", async (t) => {
  await seed(); await activate();
  // Keep SDKs on the local emulator; select only the staging simulation branch.
  // The separate environment-policy tests verify real runtime classification.
  t.mock.method(require("../../functions/src/environmentPolicy"), "isStagingEnvironment", () => true);
  const orderId = "demo-v1-order-draft-breakfast", locationId = "demo-v1-location-1";
  await assert.rejects(confirmOrderHandler(input("purchaser", { orderId, expectedRevision: 1, requestId: "buyer-cannot-approve" }), services), { code: "permission-denied" });
  const confirmation = await confirmOrderHandler(input("approver", { orderId, expectedRevision: 1, requestId: "staging-confirm" }), services);
  assert.equal(confirmation.simulated, true);
  const order = (await db.doc(`hotels/${HOTEL_IDS[0]}/orders/${orderId}`).get()).data();
  assert.equal(order.status, "Ordered"); assert.equal(order.dispatchEnvironment, "staging");
  assert.equal((await db.doc(`hotels/${HOTEL_IDS[0]}/dispatches/${confirmation.dispatchId}`).get()).data().status, "simulated");
  await recordHotelOrderReceiptHandler(input("purchaser", { orderId, expectedRevision: 2, requestId: "staging-receive", receivedOn: "2026-10-16", deliveryReference: "STAGING-RECEIPT-1", inventoryLocationId: locationId,
    lines: order.products.map((line) => ({ supplierProductId: line.supplierProductId, orderLineId: line.orderLineId, acceptedQuantity: line.qtyPurchaseUnits, rejectedQuantity: 0 })) }), services);
  assert.equal((await db.doc(`hotels/${HOTEL_IDS[0]}/orders/${orderId}`).get()).data().status, "Received");
  const count = await createHotelStockCountHandler(input("counter", { requestId: "staging-physical-count", name: "STAGING completed physical count", type: "Ad Hoc", businessDate: "2026-10-16",
    locations: [{ locationId, stockTemplateId: "demo-v1-template-1" }] }), services);
  const template = (await db.doc(`hotels/${HOTEL_IDS[0]}/stockCounts/${count.stockCountId}/locations/${locationId}`).get()).data().stockTemplate;
  const counts = template.items.map((item) => ({ catalogProductId: item.catalogProductId, quantity: 0, isCounted: true, unitCost: 1 }));
  await assert.rejects(mutateHotelStockCountHandler(input("counter", { stockCountId: count.stockCountId, locationId, action: "finish-location", expectedRevision: 0, countedItems: counts.slice(1) }), services), { code: "failed-precondition" });
  await mutateHotelStockCountHandler(input("counter", { stockCountId: count.stockCountId, locationId, action: "finish-location", expectedRevision: 0, countedItems: counts }), services);
  const completed = await mutateHotelStockCountHandler(input("counter", { stockCountId: count.stockCountId, action: "finish-count", expectedRevision: 1 }), services);
  assert.equal(completed.status, "Finished"); assert.equal(completed.countedValue, 0);
  assert.equal((await db.collection(`hotels/${HOTEL_IDS[0]}/mailQueue`).get()).size, 0);
});
