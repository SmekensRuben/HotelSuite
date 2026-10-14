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
const { getHotelStockCountPackageOptionsHandler } = require("../../functions/src/stockCountPackages");
const { mutateHotelSupplierProductHandler } = require("../../functions/src/products");
const { getHotelSupplierPriceInsightsHandler } = require("../../functions/src/supplierPriceInsights");
const { resolveSupplierPriceVersion, purchaseTerms } = require("../../functions/src/supplierPriceVersions");
const { pricingTerms } = require("../../functions/src/supplierPricePolicy");
const { digest } = require("../../functions/src/validation");
const { recordHotelInventoryAdjustmentHandler, reverseHotelInventoryAdjustmentHandler, listHotelInventoryAdjustmentsHandler } = require("../../functions/src/inventoryAdjustments");
const { requireHotelImportTarget } = require("../../functions/src/fileImportTypes");
const db = admin.firestore(), auth = admin.auth();
const services = { firestore: db, auth, now: () => Date.parse("2026-10-12T12:00:00Z") };
const staff = { uid: "extension-counter", token: { email_verified: true } };
const outsider = { uid: "extension-outsider", token: { email_verified: true } };
const platform = { uid: "extension-platform", token: { email_verified: true, platformAdmin: true } };
const request = (data, actor = staff) => ({ auth: actor, data });
const deny = (result, code) => assert.rejects(result, (error) => error.code === code);
const offer = (patch = {}) => ({ supplierId: "drinks", supplierSku: "JUICE6", supplierProductName: "Orange juice case", currency: "EUR",
  pricingModel: "Per Purchase Unit", pricePerBaseUnit: null, pricePerPurchaseUnit: 15.9, baseUnit: "ml", purchaseUnit: "Case",
  baseUnitsPerPurchaseUnit: 6000, catalogProductId: "juice", active: true, priceBasis: "gross", vatRate: 0.06, purchaseOptions: [], ...patch });
let environment, serial = 0;
const next = () => `extension-command-${++serial}`;
const transferInput = (patch = {}) => ({ hotelUid: "hotel-a", requestId: next(), expectedActorUid: staff.uid,
  kind: "transfer", catalogProductId: "juice", quantity: 6, sourceLocationId: "store", destinationLocationId: "bar",
  businessDate: "2026-10-11", reference: "Physical transfer", note: "Moved sealed juice packages", netUnitCost: null, currency: null, ...patch });
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
    await db.doc(`hotels/${hotelUid}/locations/store`).set({ name: "Kitchen store" });
    await db.doc(`hotels/${hotelUid}/locations/bar`).set({ name: "Bar store" });
    await db.doc(`hotels/${hotelUid}/suppliers/drinks`).set({ name: "Drinks supplier", active: true });
    await db.doc(`hotels/${hotelUid}/catalogproducts/juice`).set({ name: "Orange juice", baseUnit: "l", inventoryTracked: true, active: true, productPolicyVersion: 1 });
    await db.doc(`hotels/${hotelUid}/supplierproducts/offer`).set({ ...offer(), productPolicyVersion: 1 });
    await db.doc(`hotels/${hotelUid}/stockCounts/count`).set({ inventoryPolicyVersion: 1, currency: "EUR", businessDate: "2026-10-10", status: "In Progress", locations: [{ locationId: "store" }] });
    await db.doc(`hotels/${hotelUid}/stockCounts/count/locations/store`).set({ inventoryPolicyVersion: 1, currency: "EUR", businessDate: "2026-10-10", status: "In Progress",
      stockTemplate: { items: [{ catalogProductId: "juice", catalogProductName: "Orange juice", baseUnit: "l" }] }, countedItems: [] });
  }
  await db.doc(`hotels/hotel-a/members/${staff.uid}`).set({ permissions: ["stockcounts.read", "stockcounts.update", "inventorymovements.read", "inventorymovements.create"] });
  await db.doc(`hotels/hotel-b/members/${outsider.uid}`).set({ permissions: ["stockcounts.*", "inventorymovements.*", "inventorymovements.reverse"] });
});
after(async () => environment.cleanup());

describe("procurement extensions with ordinary hotel users and actual Firestore transactions", () => {
  it("private histories and movement evidence reject client read/create/update/delete including platform administrators", async () => {
    const paths = ["supplierPriceHistory/offer/entries/0000000001", "supplierPriceVersions/offer/entries/0000000001",
      "supplierPriceConfirmations/offer/entries/0000000001", "inventoryAdjustments/event", "inventoryAdjustmentOperations/command",
      "inventoryAdjustmentReversals/reversal", "futureServerOnlyEvidence/record"];
    for (const path of paths) await db.doc(`hotels/hotel-a/${path}`).set({ immutable: true });
    for (const actor of [staff, outsider, platform]) {
      const browser = environment.authenticatedContext(actor.uid, actor.token).firestore();
      for (const path of paths) {
        const ref = doc(browser, `hotels/hotel-a/${path}`);
        await assertFails(getDoc(ref)); await assertFails(setDoc(ref, { immutable: false }));
        await assertFails(updateDoc(ref, { immutable: false })); await assertFails(deleteDoc(ref));
      }
    }
    for (const path of paths.slice(0, -1)) assert.throws(() => requireHotelImportTarget(`hotels/hotel-a/${path}`, "hotel-a"));
    assert.equal(SAAS_RULES_VERSION, "saas-platform-v6", "The reviewed stock-point policy requires protected outlet and location commands.");
  });
  it("ordinary counters get exact package quantities without catalog, supplier or price access", async () => {
    const input = { hotelUid: "hotel-a", stockCountId: "count", locationId: "store", catalogProductId: "juice" };
    const response = await getHotelStockCountPackageOptionsHandler(request(input), services);
    assert.equal(response.catalogBaseUnit, "l"); assert.equal(response.options[0].catalogUnitsPerPackage, 6);
    assert.equal(JSON.stringify(response).includes("pricePerPurchaseUnit"), false);
    await assertFails(getDoc(doc(environment.authenticatedContext(staff.uid, staff.token).firestore(), "hotels/hotel-a/supplierproducts/offer")));
    await deny(getHotelStockCountPackageOptionsHandler(request({ ...input, hotelUid: "hotel-b" }), services), "permission-denied");
    await db.doc(`hotels/hotel-a/members/${staff.uid}`).update({ permissions: ["stockcounts.read"] });
    await deny(getHotelStockCountPackageOptionsHandler(request(input), services), "permission-denied");
  });
  it("count-only users resolve approved dated packages without financial disclosures or changes to frozen count evidence", async () => {
    await db.doc(`hotels/hotel-a/members/${staff.uid}`).set({ permissions: ["stockcounts.read", "stockcounts.update"] });
    const timestamp = admin.firestore.Timestamp.fromDate(new Date("2026-10-05T12:00:00Z"));
    const version = (hotelUid, id, revision, patch = {}) => {
      const product = { ...offer({ pricePerPurchaseUnit: 1299, priceValidFrom: "2026-10-01", priceValidUntil: "2026-10-31", ...patch }), productPolicyVersion: 1 };
      const terms = pricingTerms(product, { baseUnit: "l" });
      return { hotelUid, id, supplierPriceVersionPolicyVersion: 1, supplierProductId: "offer", supplierId: "drinks", revision,
        termsFingerprint: digest(terms), terms, productTerms: purchaseTerms(product), approvedAt: timestamp,
        sourceKind: "supplier-list", sourceReference: "PRIVATE supplier agreement.xlsx", sourceIssuedOn: "2026-10-05",
        lastPriceChangeAt: timestamp, optionReliability: {} };
    };
    const currentId = "0000000000000001", futureId = "0000000000000002";
    const protectedRefs = [db.doc(`hotels/hotel-a/supplierPriceVersions/offer/entries/${currentId}`),
      db.doc(`hotels/hotel-a/supplierPriceVersions/offer/entries/${futureId}`),
      db.doc(`hotels/hotel-a/supplierPriceConfirmations/offer/entries/${currentId}`)];
    await protectedRefs[0].set(version("hotel-a", currentId, 1));
    await protectedRefs[1].set(version("hotel-a", futureId, 2, { priceValidFrom: "2026-11-01", priceValidUntil: "2026-11-15",
      baseUnitsPerPurchaseUnit: 3000, pricePerPurchaseUnit: 4999, currency: "USD", vatRate: 0.21,
      purchaseOptions: [{ id: "bottle", purchaseUnit: "Bottle", baseUnitsPerPurchaseUnit: 500, pricePerPurchaseUnit: 333 }] }));
    await protectedRefs[2].set({ supplierPriceVersionPolicyVersion: 1, supplierProductId: "offer", versionId: currentId, revision: 1,
      confirmedOptionIds: ["default"], confirmedAt: timestamp, sourceReference: "PRIVATE price confirmation.xlsx", sourceIssuedOn: "2026-10-05" });
    await db.doc(`hotels/hotel-b/supplierPriceVersions/offer/entries/${currentId}`).set(version("hotel-b", currentId, 1, { baseUnitsPerPurchaseUnit: 99000 }));
    const countRefs = [db.doc("hotels/hotel-a/stockCounts/count"), db.doc("hotels/hotel-a/stockCounts/count/locations/store")];
    const productRef = db.doc("hotels/hotel-a/supplierproducts/offer"), input = { hotelUid: "hotel-a", stockCountId: "count", locationId: "store", catalogProductId: "juice" };
    for (const [businessDate, expected] of [["2026-10-10", [6]], ["2026-11-01", [3, 0.5]], ["2026-11-20", [3, 0.5]]]) {
      await Promise.all(countRefs.map((reference) => reference.update({ businessDate })));
      const refs = [...countRefs, productRef, ...protectedRefs], before = await db.getAll(...refs);
      const response = await getHotelStockCountPackageOptionsHandler(request(input), services);
      assert.deepEqual(response.options.map((option) => option.catalogUnitsPerPackage), expected, businessDate);
      assert.equal(response.catalogBaseUnit, "l");
      assert.doesNotMatch(JSON.stringify(response), /price|source|confirmation|currency|vat|PRIVATE|USD|1299|4999|333/i);
      const after = await db.getAll(...refs);
      after.forEach((snapshot, index) => {
        assert.deepEqual(snapshot.data(), before[index].data());
        assert.equal(snapshot.updateTime.isEqual(before[index].updateTime), true);
      });
    }
    const browser = environment.authenticatedContext(staff.uid, staff.token).firestore();
    for (const reference of [...protectedRefs, productRef]) await assertFails(getDoc(doc(browser, reference.path)));
    await deny(getHotelStockCountPackageOptionsHandler(request({ ...input, hotelUid: "hotel-b" }), services), "permission-denied");
    await deny(getHotelSupplierPriceInsightsHandler(request({ hotelUid: "hotel-a", mode: "history", supplierProductId: "offer" }), services), "permission-denied");
  });
  it("transfers and compensating reversals preserve both frozen legs with separate supervisor authority", async () => {
    const input = transferInput(), first = await recordHotelInventoryAdjustmentHandler(request(input), services);
    assert.equal(first.actorUid, staff.uid); assert.equal(first.requestId, input.requestId);
    assert.deepEqual(await recordHotelInventoryAdjustmentHandler(request(input), services), first);
    const legs = await db.getAll(...first.movementIds.map((id) => db.doc(`hotels/hotel-a/inventoryMovements/${id}`)));
    assert.deepEqual(legs.map((leg) => leg.data().lines[0].quantity), [-6, 6]);
    assert.ok(legs.every((leg) => leg.data().lines[0].netValue === null));
    const reverse = { hotelUid: "hotel-a", adjustmentId: first.adjustmentId, requestId: next(), expectedActorUid: staff.uid,
      businessDate: "2026-10-12", reference: "Correction", note: "The physical transfer was recorded twice elsewhere" };
    await deny(reverseHotelInventoryAdjustmentHandler(request(reverse), services), "permission-denied");
    await db.doc(`hotels/hotel-a/members/${staff.uid}`).update({ permissions: ["inventorymovements.read", "inventorymovements.create", "inventorymovements.reverse"] });
    await db.doc("hotels/hotel-a/locations/bar").update({ archived: true, active: false });
    const corrected = await reverseHotelInventoryAdjustmentHandler(request(reverse), services);
    const offsets = await db.getAll(...corrected.movementIds.map((id) => db.doc(`hotels/hotel-a/inventoryMovements/${id}`)));
    assert.deepEqual(offsets.map((leg) => leg.data().lines[0].quantity), [6, -6]);
    assert.deepEqual(await reverseHotelInventoryAdjustmentHandler(request(reverse), services), corrected);
    assert.deepEqual((await db.getAll(...first.movementIds.map((id) => db.doc(`hotels/hotel-a/inventoryMovements/${id}`)))).map((leg) => leg.data().lines[0].quantity), [-6, 6]);
  });
  it("foreign hotel, wrong actor, canceled subscription and revoked Auth cannot post or enumerate events", async () => {
    await deny(recordHotelInventoryAdjustmentHandler(request(transferInput({ hotelUid: "hotel-b" })), services), "permission-denied");
    await deny(recordHotelInventoryAdjustmentHandler(request(transferInput({ expectedActorUid: outsider.uid })), services), "failed-precondition");
    await deny(listHotelInventoryAdjustmentsHandler(request({ hotelUid: "hotel-b" }), services), "permission-denied");
    await db.doc("hotelSubscriptions/hotel-a").update({ status: "canceled" });
    await deny(recordHotelInventoryAdjustmentHandler(request(transferInput()), services), "permission-denied");
    await db.doc("hotelSubscriptions/hotel-a").update({ status: "active" }); await auth.updateUser(staff.uid, { disabled: true });
    await deny(recordHotelInventoryAdjustmentHandler(request(transferInput()), services), "permission-denied");
    assert.equal((await db.collection("hotels/hotel-a/inventoryMovements").get()).size, 0);
  });
  it("price comparisons need explicit read grants and real price saves produce one immutable observed revision", async () => {
    const input = { hotelUid: "hotel-a", mode: "comparison", catalogProductId: "juice" };
    await deny(getHotelSupplierPriceInsightsHandler(request(input), services), "permission-denied");
    await db.doc(`hotels/hotel-a/members/${staff.uid}`).update({ permissions: ["catalogproducts.read", "supplierproducts.read", "suppliers.read", "supplierproducts.update"] });
    const command = { hotelUid: "hotel-a", action: "update", productId: "offer", expectedRevision: 0, requestId: next(), product: offer({ pricePerPurchaseUnit: 31.8 }) };
    const saved = await mutateHotelSupplierProductHandler(request(command), services);
    assert.equal(saved.revision, 1);
    assert.deepEqual(await mutateHotelSupplierProductHandler(request(command), services), saved);
    const histories = await db.collection("hotels/hotel-a/supplierPriceHistory/offer/entries").get();
    assert.equal(histories.size, 1); assert.ok(histories.docs[0].data().observedAt.toMillis() > 0);
    const prices = await getHotelSupplierPriceInsightsHandler(request(input), services);
    assert.equal(prices.products[0].options[0].catalogUnitsPerPurchaseUnit, 6);
    assert.equal(prices.products[0].options[0].netPricePerCatalogUnit, 5);
    await deny(getHotelSupplierPriceInsightsHandler(request({ ...input, hotelUid: "hotel-b" }), services), "permission-denied");
  });
  it("approved price projections recheck hotel, all read grants, subscription and current account on every request", async () => {
    const grants = ["catalogproducts.read", "supplierproducts.read", "suppliers.read", "supplierproducts.update"];
    const member = db.doc(`hotels/hotel-a/members/${staff.uid}`);
    await member.update({ permissions: grants });
    await mutateHotelSupplierProductHandler(request({ hotelUid: "hotel-a", action: "update", productId: "offer",
      expectedRevision: 0, requestId: next(), product: offer({ pricePerPurchaseUnit: 31.8 }) }), services);
    const input = { hotelUid: "hotel-a", mode: "history", supplierProductId: "offer" };
    assert.equal((await getHotelSupplierPriceInsightsHandler(request(input), services)).entries.length, 1);
    for (const actor of [outsider, platform]) await deny(getHotelSupplierPriceInsightsHandler(request(input, actor), services), "permission-denied");
    for (const missing of ["catalogproducts.read", "supplierproducts.read", "suppliers.read"]) {
      await member.update({ permissions: grants.filter((permission) => permission !== missing) });
      await deny(getHotelSupplierPriceInsightsHandler(request(input), services), "permission-denied");
    }
    await member.update({ permissions: grants });
    await db.doc("hotelSubscriptions/hotel-a").update({ status: "canceled" });
    await deny(getHotelSupplierPriceInsightsHandler(request(input), services), "permission-denied");
    await db.doc("hotelSubscriptions/hotel-a").update({ status: "active" });
    await auth.updateUser(staff.uid, { disabled: true });
    await deny(getHotelSupplierPriceInsightsHandler(request(input), services), "permission-denied");
    await auth.updateUser(staff.uid, { disabled: false });
    await member.delete();
    await deny(getHotelSupplierPriceInsightsHandler(request(input), services), "permission-denied");
    assert.equal((await db.collection("hotels/hotel-a/supplierPriceHistory/offer/entries").get()).size, 1);
  });
  it("future approved prices remain private evidence and leave current and historical financial snapshots unchanged", async () => {
    await db.doc(`hotels/hotel-a/members/${staff.uid}`).update({ permissions: ["catalogproducts.read", "supplierproducts.read", "suppliers.read", "supplierproducts.update"] });
    const historic = { status: "Finalized", products: [{ supplierProductId: "offer", pricePerPurchaseUnit: 15.9,
      netPricePerPurchaseUnit: 15, currency: "EUR", qtyPurchaseUnits: 4 }] };
    const evidence = { quantity: 24, unitCost: 2.5, value: 60, currency: "EUR" };
    await db.doc("hotels/hotel-a/orders/historic").set(historic);
    await db.doc("hotels/hotel-a/inventoryMovements/historic").set(evidence);
    await mutateHotelSupplierProductHandler(request({ hotelUid: "hotel-a", action: "update", productId: "offer", expectedRevision: 0,
      requestId: next(), product: offer({ pricePerPurchaseUnit: 31.8, priceValidFrom: "2026-10-01", priceValidUntil: "2026-10-31" }) }), services);
    const future = { hotelUid: "hotel-a", action: "update", productId: "offer", expectedRevision: 1, requestId: next(),
      product: offer({ pricePerPurchaseUnit: 47.7, priceValidFrom: "2026-11-01", priceValidUntil: "2026-11-30" }) };
    await mutateHotelSupplierProductHandler(request(future), services);
    const product = (await db.doc("hotels/hotel-a/supplierproducts/offer").get()).data();
    assert.equal(product.pricePerPurchaseUnit, 31.8);
    const records = await db.collection("hotels/hotel-a/supplierPriceVersions/offer/entries").get();
    const versions = records.docs.map((document) => ({ ...document.data(), id: document.id }));
    assert.equal(versions.length, 3, "The legacy starting price is retained as a baseline version.");
    const selected = resolveSupplierPriceVersion(product, versions, { orderDate: "2026-10-12", deliveryDate: "2026-11-02", pricingDateBasis: "delivery-date" });
    assert.equal(selected.product.pricePerPurchaseUnit, 47.7); assert.equal(selected.priceValidity, "current");
    assert.deepEqual((await db.doc("hotels/hotel-a/orders/historic").get()).data(), historic);
    assert.deepEqual((await db.doc("hotels/hotel-a/inventoryMovements/historic").get()).data(), evidence);
    await db.doc(`hotels/hotel-a/members/${staff.uid}`).update({ permissions: ["catalogproducts.read", "supplierproducts.read", "suppliers.read"] });
    await deny(mutateHotelSupplierProductHandler(request(future), services), "permission-denied");
    assert.equal((await db.collection("hotels/hotel-a/supplierPriceVersions/offer/entries").get()).size, 3);
  });
});
