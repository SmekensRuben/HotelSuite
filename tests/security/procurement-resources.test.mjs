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
  it("browser writes cannot create, rename or forge stock points even with all resource permissions and platform claims", async () => {
    await db.doc(`hotels/hotel-a/members/${platform.uid}`).set({ permissions: ["locations.*", "outlets.*"] });
    for (const actor of [staff, platform]) {
      const browser = client(actor);
      for (const collection of ["locations", "outlets"]) {
        const existing = doc(browser, `hotels/hotel-a/${collection}/${collection === "locations" ? "store" : "bar"}`);
        await assertSucceeds(getDoc(existing));
        await assertFails(setDoc(doc(browser, `hotels/hotel-a/${collection}/new`), { name: "New" }));
        await assertFails(updateDoc(existing, { name: "Renamed" }));
        await assertFails(deleteDoc(existing));
        await assertFails(updateDoc(existing, { archived: true }));
        await assertFails(updateDoc(existing, { archived: false, active: true }));
        await assertFails(setDoc(existing, { name: "Replacement" }));
        await assertFails(setDoc(doc(browser, `hotels/hotel-a/${collection}/forged`), { name: "Forged", archived: false, revision: 1 }));
      }
      await assertFails(updateDoc(doc(browser, "hotels/hotel-a/outlets/bar"), { inventoryRole: "central_storage" }));
      await assertFails(updateDoc(doc(browser, "hotels/hotel-a/locations/store"), { outletId: "bar" }));
      await assertFails(setDoc(doc(browser, "hotels/hotel-a/locations/outlet:bar"), {
        name: "Forged outlet point", stockPointPolicyVersion: 1, stockPointType: "outlet", outletId: "bar",
      }));
    }
  });
  it("protected create and rename retain ownership, generate default outlet points and require current same-hotel action authority", async () => {
    const createOutlet = { hotelUid: "hotel-a", collection: "outlets", resourceId: "central", action: "create", expectedRevision: 0,
      requestId: next(), resource: { name: "Central store", inventoryRole: "central_storage" } };
    const createdOutlet = await mutateHotelProcurementResourceHandler(request(createOutlet), services);
    assert.deepEqual(await mutateHotelProcurementResourceHandler(request(createOutlet), services), createdOutlet);
    assert.equal(createdOutlet.revision, 1);
    const defaultRef = doc(client(), "hotels/hotel-a/locations/outlet:central");
    const defaultPoint = (await assertSucceeds(getDoc(defaultRef))).data();
    assert.equal(defaultPoint.stockPointPolicyVersion, 1);
    assert.equal(defaultPoint.stockPointType, "outlet");
    assert.equal(defaultPoint.outletId, "central");
    await assertFails(updateDoc(defaultRef, { outletId: "bar" }));

    const createLocation = { hotelUid: "hotel-a", collection: "locations", resourceId: "cellar", action: "create", expectedRevision: 0,
      requestId: next(), resource: { name: "Cellar", outletId: "central" } };
    await mutateHotelProcurementResourceHandler(request(createLocation), services);
    const renamed = await mutateHotelProcurementResourceHandler(request({ ...createLocation, action: "update", expectedRevision: 1,
      requestId: next(), resource: { name: "Wine cellar", outletId: "central" } }), services);
    assert.equal(renamed.revision, 2);
    const locationRef = doc(client(), "hotels/hotel-a/locations/cellar");
    assert.equal((await assertSucceeds(getDoc(locationRef))).data().name, "Wine cellar");
    await archive("locations", "cellar", { expectedRevision: 2 });
    assert.equal((await assertSucceeds(getDoc(locationRef))).data().archived, true);
    await assertFails(updateDoc(locationRef, { name: "Archived renamed" }));

    for (const actor of [outsider, platform]) {
      await denied(mutateHotelProcurementResourceHandler(request({ ...createOutlet, resourceId: next(), requestId: next() }, actor), services), "permission-denied");
    }
    await denied(mutateHotelProcurementResourceHandler(request({ ...createOutlet, hotelUid: "hotel-b", requestId: next() }), services), "permission-denied");
    await db.doc(`hotels/hotel-a/members/${staff.uid}`).update({ permissions: ["locations.read", "outlets.read"] });
    await denied(mutateHotelProcurementResourceHandler(request(createOutlet), services), "permission-denied");
    await denied(mutateHotelProcurementResourceHandler(request({ ...createLocation, action: "update", expectedRevision: 2, requestId: next() }), services), "permission-denied");
  });
  it("resource reads stay scoped to hotel, feature permission and procurement entitlement", async () => {
    const browser = client();
    await assertSucceeds(getDoc(doc(browser, "hotels/hotel-a/locations/store")));
    await assertSucceeds(getDoc(doc(browser, "hotels/hotel-a/outlets/bar")));
    await assertFails(getDoc(doc(browser, "hotels/hotel-b/locations/store")));
    await assertFails(getDoc(doc(browser, "hotels/hotel-b/outlets/bar")));
    await assertFails(getDoc(doc(client(outsider), "hotels/hotel-a/outlets/bar")));
    await db.doc(`hotels/hotel-a/members/${staff.uid}`).update({ permissions: ["orders.read"] });
    await assertSucceeds(getDoc(doc(browser, "hotels/hotel-a/outlets/bar")));
    await assertFails(getDoc(doc(browser, "hotels/hotel-a/locations/store")));
    await db.doc("hotelSubscriptions/hotel-a").update({ modules: ["revenue"] });
    await assertFails(getDoc(doc(browser, "hotels/hotel-a/outlets/bar")));
  });
  it("protected commands reject forged server fields, reserved outlet points and foreign ownership without creating records", async () => {
    const create = { hotelUid: "hotel-a", collection: "locations", resourceId: "new", action: "create", expectedRevision: 0,
      resource: { name: "New", outletId: "bar" } };
    for (const fields of [{ stockPointPolicyVersion: 1 }, { stockPointType: "outlet" }, { resourcePolicyVersion: 1 }, { revision: 0 }, { archived: false }]) {
      await denied(mutateHotelProcurementResourceHandler(request({ ...create, requestId: next(), resource: { ...create.resource, ...fields } }), services), "invalid-argument");
    }
    await denied(mutateHotelProcurementResourceHandler(request({ ...create, resourceId: "outlet:bar", requestId: next() }), services), "invalid-argument");
    await db.doc("hotels/hotel-b/outlets/foreign").set({ name: "Foreign outlet" });
    await denied(mutateHotelProcurementResourceHandler(request({ ...create, requestId: next(), resource: { name: "New", outletId: "foreign" } }), services), "failed-precondition");
    assert.equal((await db.doc("hotels/hotel-a/locations/new").get()).exists, false);
    assert.equal((await db.collection("hotels/hotel-a/procurementResourceOperations").get()).size, 0);
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
    assert.equal(sources.locations.some((location) => location.locationId === "store"), false);
    assert.equal(sources.locations.some((location) => location.locationId === "outlet:bar"), true);
    await denied(createCount(), "failed-precondition");
    await mutateHotelStockCountHandler(request({ hotelUid: "hotel-a", stockCountId: existing.stockCountId, action: "finish-location", locationId: "store", expectedRevision: 0,
      countedItems: [{ catalogProductId: "juice", quantity: 3, isCounted: true, unitCost: null }] }), services);
    await mutateHotelStockCountHandler(request({ hotelUid: "hotel-a", stockCountId: existing.stockCountId, action: "finish-count", expectedRevision: 1 }), services);
    assert.equal((await db.doc(`hotels/hotel-a/stockCounts/${existing.stockCountId}`).get()).data().status, "Finished");
    assert.equal((await db.doc("hotels/hotel-a/locations/store/stockTemplates/weekly").get()).exists, true);
  });
  it("old release gates cannot enable resource archival and private lifecycle evidence remains inaccessible", async () => {
    for (const rulesVersion of ["saas-platform-v4", "saas-platform-v5"]) {
      await db.doc("platformConfiguration/saasProcurement").set({ enabled: true, rulesVersion });
      await denied(archive(), "failed-precondition");
      assert.equal((await db.doc("hotels/hotel-a/locations/store").get()).data().archived, undefined);
      await denied(mutateHotelProcurementResourceHandler(request({ hotelUid: "hotel-a", collection: "outlets", resourceId: "new", action: "create",
        expectedRevision: 0, requestId: next(), resource: { name: "New outlet" } }), services), "failed-precondition");
      assert.equal((await db.doc("hotels/hotel-a/outlets/new").get()).exists, false);
    }
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
