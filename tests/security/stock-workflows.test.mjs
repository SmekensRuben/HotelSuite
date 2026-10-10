import { before, beforeEach, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, updateDoc } from "firebase/firestore";

const projectId = "demo-hotel-suite-a00";
if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) throw new Error("Firestore and Auth emulators are required.");
process.env.FIREBASE_CONFIG = JSON.stringify({ projectId, storageBucket: `${projectId}.appspot.com` });
const require = createRequire(import.meta.url);
const { admin } = require("../../functions/src/config");
const { createHotelStockCountHandler, mutateHotelStockCountHandler, listHotelStockCountSourcesHandler } = require("../../functions/src/stockCounts");
const { getHotelUserDisplayNameHandler } = require("../../functions/src/staffDisplay");
const { createHotelHandler } = require("../../functions/src/onboarding");
const db = admin.firestore(), auth = admin.auth();
const services = { firestore: db, auth };
const counter = { uid: "stock-counter", token: { email_verified: true } };
const operator = { uid: "stock-operator", token: { email_verified: true, platformAdmin: true } };
const request = (actor, data) => ({ auth: actor, data });
let environment;
const path = (id) => `hotels/hotel-a/stockCounts/${id}`;
const create = () => createHotelStockCountHandler(request(counter, { hotelUid: "hotel-a", name: "Weekly", type: "Weekly",
  requestId: "stock-request", locations: [{ locationId: "store", stockTemplateId: "template" }] }), services);
const counts = [{ supplierProductId: "coffee", outletId: "bar", quantity: 3, isCounted: true }];
const mutate = (id, action, revision, extra = {}) => mutateHotelStockCountHandler(request(counter, { hotelUid: "hotel-a",
  stockCountId: id, action, expectedRevision: revision,
  ...(action === "finish-count" ? {} : { locationId: "store", countedItems: counts }), ...extra }), services);
const denied = (promise, code) => assert.rejects(promise, (error) => error.code === code);
before(async () => { environment = await initializeTestEnvironment({ projectId,
  firestore: { host: "127.0.0.1", port: 8080, rules: await readFile("firebase/firestore.rules", "utf8") } }); });
beforeEach(async () => {
  await environment.clearFirestore();
  const identities = await auth.listUsers();
  if (identities.users.length) await auth.deleteUsers(identities.users.map((user) => user.uid));
  await auth.createUser({ uid: counter.uid, email: "counter@example.test", emailVerified: true });
  await auth.createUser({ uid: operator.uid, email: "operator@example.test", emailVerified: true });
  await auth.setCustomUserClaims(operator.uid, { platformAdmin: true });
  await Promise.all([
    db.doc("hotels/hotel-a").set({ hotelName: "Stock fixture" }), db.doc("hotels/hotel-b").set({ hotelName: "Other hotel" }),
    db.doc("hotelSubscriptions/hotel-a").set({ status: "active", validUntil: null }),
    db.doc("hotelSubscriptions/hotel-b").set({ status: "active", validUntil: null }),
    db.doc(`hotels/hotel-a/members/${counter.uid}`).set({ permissions: ["stockcounts.create", "stockcounts.update", "stockcounts.read"] }),
    db.doc("users/stock-person").set({ firstName: "Ada", lastName: "Lovelace", email: "private@example.test", hotelUid: ["hotel-a", "hotel-b"] }),
    db.doc("hotels/hotel-a/members/stock-person").set({ permissions: [] }),
    db.doc("hotels/hotel-a/locations/store").set({ name: "Store" }),
    db.doc("hotels/hotel-a/locations/store/stockTemplates/template").set({ name: "Weekly", items: [{ supplierProductId: "coffee", outletId: "bar" }] }),
    db.doc("hotels/hotel-a/supplierproducts/coffee").set({ name: "Coffee", pricePerPurchaseUnit: 12.5 }),
    db.doc("hotels/hotel-a/outlets/bar").set({ name: "Bar" }),
  ]);
});
after(async () => environment.cleanup());
describe("stock commands and staff display with real Auth and Firestore emulators", () => {
  it("stock creation source list returns bounded same-hotel metadata without unrelated read grants", async () => {
    const source = await listHotelStockCountSourcesHandler(request(counter, { hotelUid: "hotel-a" }), services);
    assert.deepEqual(source, { locations: [{ locationId: "store", locationName: "Store", templates: [{ id: "template", name: "Weekly" }] }], nextCursor: null });
    await denied(listHotelStockCountSourcesHandler(request(counter, { hotelUid: "hotel-b" }), services), "permission-denied");
    await db.doc(`hotels/hotel-a/members/${counter.uid}`).update({ permissions: ["stockcounts.read", "stockcounts.update"] });
    await denied(listHotelStockCountSourcesHandler(request(counter, { hotelUid: "hotel-a" }), services), "permission-denied");
    await db.doc(`hotels/hotel-a/members/${counter.uid}`).update({ permissions: ["stockcounts.create"] });
    const batch = db.batch();
    for (let index = 0; index < 50; index++) batch.set(db.doc(`hotels/hotel-a/locations/location-${String(index).padStart(3, "0")}`), { name: `Location ${index}` });
    await batch.commit();
    const first = await listHotelStockCountSourcesHandler(request(counter, { hotelUid: "hotel-a" }), services);
    assert.equal(first.locations.length, 50); assert.equal(first.nextCursor, "location-049");
    const second = await listHotelStockCountSourcesHandler(request(counter, { hotelUid: "hotel-a", afterLocationId: first.nextCursor }), services);
    assert.deepEqual(second.locations.map((location) => location.locationId), ["store"]); assert.equal(second.nextCursor, null);
  });
  it("normal stock user completes protected commands while all direct stock mutation paths stay denied", async () => {
    const { stockCountId } = await create();
    const client = environment.authenticatedContext(counter.uid, counter.token).firestore();
    const platformClient = environment.authenticatedContext(operator.uid, operator.token).firestore();
    await assertSucceeds(getDoc(doc(client, path(stockCountId))));
    await assertFails(updateDoc(doc(client, path(stockCountId)), { status: "Finished", countedValue: 1, finishedBy: "spoof" }));
    await assertFails(updateDoc(doc(client, `${path(stockCountId)}/locations/store`), { countedValue: 1 }));
    await assertFails(setDoc(doc(platformClient, `${path(stockCountId)}/locations/injected`), { status: "Finished" }));
    await mutate(stockCountId, "finish-location", 0);
    const countedItem = (await db.doc(`${path(stockCountId)}/locations/store`).get()).data().countedItems[0];
    assert.equal(countedItem.countedBy, counter.uid);
    assert.equal(Number.isFinite(countedItem.countedAt.toMillis()), true);
    const finished = await mutate(stockCountId, "finish-count", 1);
    assert.equal(finished.countedValue, 37.5); assert.equal(finished.status, "Finished");
    assert.equal((await db.doc(path(stockCountId)).get()).data().finishedBy, counter.uid);
    await denied(mutate(stockCountId, "save-location", 2), "failed-precondition");
    await assertFails(updateDoc(doc(client, `${path(stockCountId)}/locations/store`), { status: "Not Started" }));
  });
  it("real concurrent finish transactions have one winner and never lose aggregate valuation", async () => {
    const { stockCountId } = await create();
    const results = await Promise.allSettled([mutate(stockCountId, "finish-location", 0), mutate(stockCountId, "finish-location", 0)]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.find((result) => result.status === "rejected").reason.code, "aborted");
    assert.equal((await db.doc(path(stockCountId)).get()).data().countedValue, 37.5);
  });
  it("removed, disabled and unverified users cannot issue stock commands even with stale verified token", async () => {
    for (const action of ["disable", "unverify", "remove-member"]) {
      await auth.updateUser(counter.uid, { emailVerified: true, disabled: false });
      await db.doc(`hotels/hotel-a/members/${counter.uid}`).set({ permissions: ["stockcounts.create"] });
      if (action === "disable") await auth.updateUser(counter.uid, { disabled: true });
      if (action === "unverify") await auth.updateUser(counter.uid, { emailVerified: false });
      if (action === "remove-member") await db.doc(`hotels/hotel-a/members/${counter.uid}`).delete();
      await denied(create(), "permission-denied");
    }
  });
  it("hotel staff display works for a normal user without global user profile access", async () => {
    assert.deepEqual(await getHotelUserDisplayNameHandler(request(counter, { hotelUid: "hotel-a", userId: "stock-person" }), services), { displayName: "Ada Lovelace" });
    const client = environment.authenticatedContext(counter.uid, counter.token).firestore();
    await assertFails(getDoc(doc(client, "users/stock-person")));
    await denied(getHotelUserDisplayNameHandler(request(counter, { hotelUid: "hotel-b", userId: "stock-person" }), services), "permission-denied");
  });
  it("onboarding creates canonical split settings with unknown capacity and rejects stale admin claim", async () => {
    await createHotelHandler(request(operator, { hotelUid: "new-stock-hotel", name: "New hotel", status: "active", requestId: "create-new" }), services);
    assert.deepEqual((await db.doc("hotels/new-stock-hotel/settings/bootstrap").get()).data(), { hotelName: "New hotel", currency: "EUR", language: "en" });
    assert.deepEqual((await db.doc("hotels/new-stock-hotel/settings/propertySettings").get()).data(), {});
    assert.equal((await db.doc("hotels/new-stock-hotel/settings/new-stock-hotel").get()).exists, false);
    await auth.setCustomUserClaims(operator.uid, {});
    await denied(createHotelHandler(request(operator, { hotelUid: "stale-stock-hotel", name: "Stale", status: "active", requestId: "create-stale" }), services), "permission-denied");
  });
});
