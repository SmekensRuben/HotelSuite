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
const { mutateHotelProcurementResourceHandler } = require("../../functions/src/procurementResources");
const { getHotelStockTemplateDisplayHandler } = require("../../functions/src/stockTemplates");
const { getHotelUserDisplayNamesHandler } = require("../../functions/src/staffDisplay");
const { createHotelStockCountHandler, mutateHotelStockCountHandler, listHotelStockCountSourcesHandler } = require("../../functions/src/stockCounts");
const db = admin.firestore(), auth = admin.auth(), services = { firestore: db, auth, now: () => Date.parse("2026-10-12T12:00:00Z") };
const staff = { uid: "resource-staff", token: { email_verified: true } }, outsider = { uid: "resource-outsider", token: { email_verified: true } };
const platform = { uid: "resource-platform", token: { email_verified: true, platformAdmin: true } };
const request = (data, actor = staff) => ({ auth: actor, data });
const denied = (result, code) => assert.rejects(result, (error) => error.code === code);
let environment, sequence = 0;
const next = () => `resource-request-${++sequence}`;
const archive = (collection = "locations", resourceId = "store", patch = {}, actor = staff) => mutateHotelProcurementResourceHandler(request({
  hotelUid: "hotel-a", collection, resourceId, action: "archive", expectedRevision: 0, requestId: next(), ...patch }, actor), services);
const client = (actor = staff) => environment.authenticatedContext(actor.uid, actor.token).firestore();
const createCount = () => createHotelStockCountHandler(request({ hotelUid: "hotel-a", name: "Physical", type: "Weekly", requestId: next(),
  businessDate: "2026-10-10", locations: [{ locationId: "store", stockTemplateId: "weekly" }] }), services);
before(async () => { environment = await initializeTestEnvironment({ projectId, firestore: { rules: await readFile("firebase/firestore.rules", "utf8") } }); });
beforeEach(async () => {
  await environment.clearFirestore();
  const users = await auth.listUsers(); if (users.users.length) await auth.deleteUsers(users.users.map((user) => user.uid));
  for (const actor of [staff, outsider, platform]) await auth.createUser({ uid: actor.uid, email: `${actor.uid}@example.test`, emailVerified: true });
  await auth.setCustomUserClaims(platform.uid, { platformAdmin: true });
  await db.doc("platformConfiguration/saasProcurement").set({ enabled: true, rulesVersion: SAAS_RULES_VERSION });
  for (const hotelUid of ["hotel-a", "hotel-b"]) {
    await db.doc(`hotels/${hotelUid}`).set({ currency: "EUR", timeZone: "Europe/Brussels" });
    await db.doc(`hotelSubscriptions/${hotelUid}`).set({ modules: ["procurement"], modulePolicyVersion: 1, status: "active", validUntil: null });
    await db.doc(`hotels/${hotelUid}/locations/store`).set({ name: "Store" });
    await db.doc(`hotels/${hotelUid}/outlets/bar`).set({ name: "Bar" });
    await db.doc(`hotels/${hotelUid}/catalogproducts/juice`).set({ name: "Orange juice", baseUnit: "l", inventoryTracked: true, active: true, price: "NEVER-PROJECT" });
    await db.doc(`hotels/${hotelUid}/locations/store/stockTemplates/weekly`).set({ name: "Weekly", items: [{ catalogProductId: "juice" }] });
  }
  await db.doc(`hotels/hotel-a/members/${staff.uid}`).set({ permissions: ["locations.*", "outlets.*", "stockcounts.*"] });
  await db.doc(`hotels/hotel-b/members/${outsider.uid}`).set({ permissions: ["locations.*", "outlets.*", "stockcounts.*"] });
  await db.doc(`hotels/hotel-a/outlets/bar/approvers/${staff.uid}`).set({ email: "approver@example.test" });
  await db.doc("hotels/hotel-a/orders/history").set({ outletId: "bar", outletName: "Historical bar", status: "Finalized" });
});
after(async () => environment.cleanup());

describe("procurement resource lifecycle and names with ordinary hotel users", () => {
  it("normal create/rename remains permitted but client delete, archival injection and reactivation are denied", async () => {
    const browser = client();
    for (const collection of ["locations", "outlets"]) {
      const ref = doc(browser, `hotels/hotel-a/${collection}/new`);
      await assertSucceeds(setDoc(ref, { name: "New" }));
      await assertSucceeds(updateDoc(ref, { name: "Renamed" }));
      await assertFails(deleteDoc(ref));
      await assertFails(updateDoc(ref, { archived: true }));
      await assertFails(setDoc(doc(browser, `hotels/hotel-a/${collection}/forged`), { name: "Forged", archived: false, revision: 1 }));
      await archive(collection, "new");
      assert.equal((await assertSucceeds(getDoc(ref))).data().archived, true);
      await assertFails(updateDoc(ref, { archived: false, active: true }));
      await assertFails(setDoc(ref, { name: "Replacement" }));
      await assertFails(updateDoc(ref, { name: "Archived renamed" }));
    }
  });
  it("server archive preserves nested settings/history, exact replay and requires the hotel delete permission", async () => {
    const payload = { hotelUid: "hotel-a", collection: "outlets", resourceId: "bar", action: "archive", expectedRevision: 0, requestId: next() };
    const before = (await db.doc("hotels/hotel-a/orders/history").get()).data();
    const first = await mutateHotelProcurementResourceHandler(request(payload), services);
    assert.deepEqual(await mutateHotelProcurementResourceHandler(request(payload), services), first);
    assert.deepEqual((await db.doc("hotels/hotel-a/orders/history").get()).data(), before);
    assert.equal((await db.doc(`hotels/hotel-a/outlets/bar/approvers/${staff.uid}`).get()).exists, true);
    await db.doc(`hotels/hotel-a/members/${staff.uid}`).update({ permissions: ["outlets.update", "locations.read"] });
    await denied(mutateHotelProcurementResourceHandler(request(payload), services), "permission-denied");
    await denied(archive(), "permission-denied");
    await denied(archive("locations", "store", {}, outsider), "permission-denied");
    await denied(archive("locations", "store", {}, platform), "permission-denied");
    await denied(archive("locations", "store", { hotelUid: "hotel-b" }), "permission-denied");
  });
  it("archiving removes a location from new counting while already frozen counts can finish", async () => {
    const existing = await createCount(); await archive();
    const sources = await listHotelStockCountSourcesHandler(request({ hotelUid: "hotel-a" }), services);
    assert.deepEqual(sources.locations, []);
    await denied(createCount(), "failed-precondition");
    await mutateHotelStockCountHandler(request({ hotelUid: "hotel-a", stockCountId: existing.stockCountId, action: "finish-location", locationId: "store", expectedRevision: 0,
      countedItems: [{ catalogProductId: "juice", quantity: 3, isCounted: true, unitCost: null }] }), services);
    await mutateHotelStockCountHandler(request({ hotelUid: "hotel-a", stockCountId: existing.stockCountId, action: "finish-count", expectedRevision: 1 }), services);
    assert.equal((await db.doc(`hotels/hotel-a/stockCounts/${existing.stockCountId}`).get()).data().status, "Finished");
    assert.equal((await db.doc("hotels/hotel-a/locations/store/stockTemplates/weekly").get()).exists, true);
  });
  it("old release gates cannot enable resource archival and private lifecycle evidence remains inaccessible", async () => {
    await db.doc("platformConfiguration/saasProcurement").set({ enabled: true, rulesVersion: "saas-platform-v4" });
    await denied(archive(), "failed-precondition");
    assert.equal((await db.doc("hotels/hotel-a/locations/store").get()).data().archived, undefined);
    await db.doc("platformConfiguration/saasProcurement").set({ enabled: true, rulesVersion: SAAS_RULES_VERSION });
    await archive();
    for (const collection of ["procurementResourceOperations", "procurementResourceAudit"]) {
      const rows = await db.collection(`hotels/hotel-a/${collection}`).get(); assert.equal(rows.size, 1);
      for (const actor of [staff, platform]) {
        await assertFails(getDoc(doc(client(actor), rows.docs[0].ref.path)));
        await assertFails(setDoc(doc(client(actor), `hotels/hotel-a/${collection}/forged`), { actorUid: actor.uid }));
      }
    }
  });
  it("locations-only template readers get bounded names and units without broad catalog access", async () => {
    await db.doc(`hotels/hotel-a/members/${staff.uid}`).update({ permissions: ["locations.read"] });
    await assertFails(getDoc(doc(client(), "hotels/hotel-a/catalogproducts/juice")));
    const response = await getHotelStockTemplateDisplayHandler(request({ hotelUid: "hotel-a", locationId: "store", templateId: "weekly" }), services);
    assert.deepEqual(response.items, [{ catalogProductId: "juice", catalogProductName: "Orange juice", baseUnit: "l", available: true }]);
    assert.equal(JSON.stringify(response).includes("NEVER-PROJECT"), false);
    await denied(getHotelStockTemplateDisplayHandler(request({ hotelUid: "hotel-b", locationId: "store", templateId: "weekly" }), services), "permission-denied");
  });
  it("ordinary staff get the name of the proven seed operator without hotel assignment or access to foreign/global profiles", async () => {
    await db.doc(`hotels/hotel-a/members/${staff.uid}`).update({ permissions: ["stockcounts.read"] });
    await db.doc(`users/${platform.uid}`).set({ firstName: "Platform", lastName: "Operator", hotelUid: [], email: "private@example.test" });
    await db.doc(`users/${outsider.uid}`).set({ firstName: "Foreign", lastName: "Staff", hotelUid: ["hotel-b"] });
    await db.doc("hotels/hotel-a/demoDataSeeds/procurement-demo-v1").set({ datasetId: "procurement-demo-v1", status: "complete", actorUid: platform.uid });
    const response = await getHotelUserDisplayNamesHandler(request({ hotelUid: "hotel-a", userIds: [platform.uid, outsider.uid] }), services);
    assert.deepEqual(response.users, [{ userId: platform.uid, displayName: "Platform Operator" }, { userId: outsider.uid, displayName: null }]);
    await assertFails(getDoc(doc(client(), `users/${platform.uid}`)));
    await assertFails(setDoc(doc(client(), "hotels/hotel-a/demoDataSeeds/procurement-demo-v1"), { datasetId: "procurement-demo-v1", status: "complete", actorUid: outsider.uid }));
    assert.equal(JSON.stringify(response).includes("private@example.test"), false);
  });
});
