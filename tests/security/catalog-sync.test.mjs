import { before, beforeEach, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { initializeTestEnvironment, assertFails } from "@firebase/rules-unit-testing";
import { collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc } from "firebase/firestore";

const projectId = "demo-hotel-suite-a00";
for (const key of ["FIRESTORE_EMULATOR_HOST", "FIREBASE_AUTH_EMULATOR_HOST"]) {
  if (!/^(127\.0\.0\.1|localhost):\d+$/.test(process.env[key] || "")) throw new Error("Only local emulators are allowed.");
}
process.env.FIREBASE_CONFIG = JSON.stringify({ projectId, storageBucket: `${projectId}.appspot.com` });
const require = createRequire(import.meta.url);
const { admin } = require("../../functions/src/config");
const { SAAS_RULES_VERSION } = require("../../functions/src/saasRollout");
const { requireHotelImportTarget } = require("../../functions/src/fileImportTypes");
const { digest } = require("../../functions/src/validation");
const { mutateHotelCatalogProductHandler } = require("../../functions/src/products");
const { DEFAULT_AI_CONFIGURATION } = require("../../functions/src/supplierAiPolicy");
const { prepareSupplierPriceVersion, writeSupplierPriceVersion } = require("../../functions/src/supplierPriceVersions");
const environmentPolicy = require("../../functions/src/environmentPolicy");
function allowInjectedCatalogProvider(context) {
  const requireExternalActions = environmentPolicy.requireExternalActions;
  // Exercise real authorization and accounting with the injected fake provider.
  // Every actual transport keeps the emulator's fail-closed environment guard.
  context.mock.method(environmentPolicy, "requireExternalActions", (action) => {
    if (action !== "AI catalog suggestions") return requireExternalActions(action);
  });
  assert.throws(() => environmentPolicy.requireExternalActions("Supplier AI requests"), { code: "failed-precondition" });
}
const syncApi = () => require("../../functions/src/catalogSync");
const skuApi = () => require("../../functions/src/catalogSkuSettings");
const aiApi = () => require("../../functions/src/catalogSyncAi");
const db = admin.firestore(), auth = admin.auth();
const services = { firestore: db, auth, now: () => Date.parse("2026-10-14T12:00:00Z") };
const grants = ["catalogproducts.read", "catalogproducts.create", "catalogproducts.update", "catalogproducts.delete",
  "supplierproducts.read", "supplierproducts.update", "suppliers.read", "catalogsettings.read", "catalogsettings.update"];
const identities = Object.fromEntries(["manager", "same-hotel", "hotel-b", "operator", "claimed-admin"].map((uid) => [uid, {
  uid, token: { email_verified: true, auth_time: Math.floor(Date.now() / 1000),
    ...(uid === "operator" ? { platformAdmin: true } : {}), ...(uid === "claimed-admin" ? { hotelAdmin: true } : {}) },
}]));
const request = (data, actor = "manager") => ({ auth: identities[actor], data });
const denied = (promise) => assert.rejects(promise, { code: "permission-denied" });
const privateCollections = ["catalogSyncJobs", "catalogSyncOperations", "catalogSyncAudit", "catalogSkuConfiguration",
  "catalogSkuKeys", "catalogSkuLegacyIndex", "catalogSkuOperations", "catalogSkuAudit"];
const catalog = (patch = {}) => ({ name: "Fictional milk", baseUnit: "l", active: true, inventoryTracked: true, allergens: [], internalSku: "", ...patch });
const supplierProduct = (sku, patch = {}) => ({ supplierId: "vendor", supplierSku: sku, supplierProductName: "Fictional milk",
  currency: "EUR", pricingModel: "Per Purchase Unit", pricePerBaseUnit: null, pricePerPurchaseUnit: 12,
  purchaseUnit: "Case", baseUnit: "ml", baseUnitsPerPurchaseUnit: 6000, purchaseOptions: [{ id: "bottle", purchaseUnit: "Bottle", baseUnitsPerPurchaseUnit: 1000, pricePerPurchaseUnit: 3, gtin: "1234567890123" }],
  priceBasis: "net", vatRate: null, priceValidFrom: "2026-10-01", priceValidUntil: "2026-10-31", catalogProductId: null,
  active: true, productPolicyVersion: 1, revision: 1, gtin: "1234567890123", image: { status: "ready", assetId: "retained-image" },
  imageRevision: 7, priceUpdatedOn: admin.firestore.Timestamp.fromMillis(1700000000000),
  priceConfirmedOn: admin.firestore.Timestamp.fromMillis(1700000000001), priceSourceReference: "Retained supplier price agreement.xlsx",
  priceOptionReliability: { default: { lastPriceConfirmedAt: admin.firestore.Timestamp.fromMillis(1700000000001) } },
  ...patch });
let environment, sequence = 0;
const next = () => `sync-test-${++sequence}`;
const preview = (patch = {}, actor = "manager") => syncApi().readHotelCatalogSyncWorkspaceHandler(request({ hotelUid: "hotel-a", requestId: next(), ...patch }, actor), services);
const read = (jobId, actor = "manager") => syncApi().readHotelCatalogSyncWorkspaceHandler(request({ hotelUid: "hotel-a", jobId }, actor), services);
const apply = (data, actor = "manager") => syncApi().applyHotelCatalogSyncHandler(request(data, actor), services);
const choice = (row, target) => ({ rowId: row.rowId, reviewRevision: row.reviewRevision, expectedSupplierRevision: row.expectedSupplierRevision, target, acknowledged: true });
const newTarget = (group = "milk", product = catalog()) => ({ kind: "new", createGroupId: group, product });
const existingTarget = (id = "milk", revision = 1) => ({ kind: "existing", catalogProductId: id, expectedCatalogRevision: revision });
const bySource = (workspace, id) => {
  const row = workspace.rows.find((entry) => entry.supplierProductId === id);
  assert.ok(row, `Expected the hotel-local source ${id} in the review.`); return row;
};
const command = (workspace, choices, requestId = next()) => ({ hotelUid: "hotel-a", jobId: workspace.jobId, requestId, choices });
const readEvidence = async (paths) => Object.fromEntries(await Promise.all(paths.map(async (path) => {
  const snapshot = await db.doc(path).get(); return [path, { data: snapshot.data(), updateTime: snapshot.updateTime }];
})));
const financial = (value) => Object.fromEntries(Object.entries(value).filter(([key]) => !["catalogProductId", "revision", "updatedAt", "updatedBy"].includes(key)));

before(async () => { environment = await initializeTestEnvironment({ projectId, firestore: {
  host: "127.0.0.1", port: Number(process.env.FIRESTORE_EMULATOR_HOST.split(":").at(-1)), rules: await readFile("firebase/firestore.rules", "utf8"),
} }); });
beforeEach(async () => {
  await environment.clearFirestore();
  const users = await auth.listUsers(); if (users.users.length) await auth.deleteUsers(users.users.map((user) => user.uid));
  for (const identity of Object.values(identities)) {
    await auth.createUser({ uid: identity.uid, email: `${identity.uid}@example.test`, emailVerified: true });
    await auth.setCustomUserClaims(identity.uid, identity.uid === "operator" ? { platformAdmin: true } : identity.uid === "claimed-admin" ? { hotelAdmin: true } : {});
    identity.token.auth_time = Math.floor(Date.now() / 1000);
  }
  await db.doc("platformConfiguration/saasProcurement").set({ enabled: true, rulesVersion: SAAS_RULES_VERSION });
  for (const hotelUid of ["hotel-a", "hotel-b"]) {
    await db.doc(`hotels/${hotelUid}`).set({ name: hotelUid, currency: "EUR", timeZone: "Europe/Brussels" });
    await db.doc(`hotelSubscriptions/${hotelUid}`).set({ status: "active", validUntil: null, modules: ["procurement"], modulePolicyVersion: 1 });
    await db.doc(`hotels/${hotelUid}/suppliers/vendor`).set({ name: "Fictional vendor", active: true, accountNumber: "PRIVATE supplier credential" });
    await db.doc(`hotels/${hotelUid}/catalogproducts/milk`).set({ ...catalog({ internalSku: "LEGACY-MILK" }), productPolicyVersion: 1, revision: 1 });
    await db.doc(`hotels/${hotelUid}/catalogproducts/mass`).set({ ...catalog({ name: "Fictional flour", baseUnit: "kg", internalSku: "LEGACY-FLOUR" }), productPolicyVersion: 1, revision: 1 });
    for (const [id, product] of Object.entries({ milkSix: supplierProduct("MILK6"), milkThree: supplierProduct("MILK3", { baseUnitsPerPurchaseUnit: 3000 }),
      linked: supplierProduct("LINKED", { catalogProductId: "milk" }), mass: supplierProduct("MASS", { supplierProductName: "Fictional flour", baseUnit: "g", baseUnitsPerPurchaseUnit: 1000, purchaseOptions: [] }),
      tiny: supplierProduct("TINY", { supplierProductName: "Fictional flour", baseUnit: "g", baseUnitsPerPurchaseUnit: 0.000001, purchaseOptions: [] }) })) {
      await db.doc(`hotels/${hotelUid}/supplierproducts/${id}`).set(product);
    }
    await db.doc(`hotels/${hotelUid}/orders/historical`).set({ status: "Finalized", products: [{ supplierProductId: "milkSix", catalogProductId: null, pricePerPurchaseUnit: 12, quantity: 3 }] });
    await db.doc(`hotels/${hotelUid}/inventoryMovements/receipt`).set({ kind: "receipt", catalogProductId: "milk", quantity: 18, netValue: 36, currency: "EUR" });
    await db.doc(`hotels/${hotelUid}/stockCounts/finished`).set({ status: "Finished", countedItems: [{ catalogProductId: "milk", quantity: 12, totalValue: 24 }] });
  }
  for (const uid of ["manager", "same-hotel"]) await db.doc(`hotels/hotel-a/members/${uid}`).set({ permissions: grants });
  await db.doc("hotels/hotel-b/members/hotel-b").set({ permissions: grants });
  await db.doc("hotels/hotel-a/members/claimed-admin").set({ hotelAdmin: true, permissions: [] });
});
after(async () => environment.cleanup());

describe("catalog synchronization and automatic SKUs with real hotel-local Firebase boundaries", () => {
  it("keeps private jobs, AI attempts, SKU settings, reservations and receipts inaccessible to every browser role and generic import", async () => {
    const paths = privateCollections.map((name) => `hotels/hotel-a/${name}/record`);
    paths.push("hotels/hotel-a/catalogSyncJobs/record/rows/row", "hotels/hotel-a/catalogSyncJobs/record/aiOperations/attempt");
    for (const path of paths) await db.doc(path).set({ immutable: true, nextNumber: 1, hotelUid: "hotel-a" });
    for (const actor of Object.keys(identities)) {
      const browser = environment.authenticatedContext(actor, identities[actor].token).firestore();
      for (const path of paths) {
        const reference = doc(browser, path);
        await assertFails(getDoc(reference)); await assertFails(setDoc(reference, { immutable: false, platformAdmin: true, hotelUid: "hotel-b" }));
        await assertFails(updateDoc(reference, { immutable: false })); await assertFails(deleteDoc(reference));
      }
      for (const name of privateCollections) await assertFails(getDocs(collection(browser, `hotels/hotel-a/${name}`)));
    }
    for (const name of privateCollections) for (const suffix of ["record", "record/entries/nested"]) {
      assert.throws(() => requireHotelImportTarget(`hotels/hotel-a/${name}/${suffix}`, "hotel-a"), /catalog synchronization/);
    }
  });
  it("creates one reviewed catalog identity for a group, links both sources atomically and preserves financial and historical evidence", async () => {
    const workspace = await preview(), first = bySource(workspace, "milkSix"), second = bySource(workspace, "milkThree");
    assert.equal(workspace.rows.some((row) => row.supplierProductId === "linked"), false);
    const original = await db.getAll(db.doc("hotels/hotel-a/supplierproducts/milkSix"), db.doc("hotels/hotel-a/supplierproducts/milkThree"));
    const paths = ["hotels/hotel-a/orders/historical", "hotels/hotel-a/inventoryMovements/receipt", "hotels/hotel-a/stockCounts/finished", "hotels/hotel-b/supplierproducts/milkSix"];
    const before = await readEvidence(paths);
    const input = command(workspace, [choice(first, newTarget()), choice(second, newTarget())]);
    const result = await apply(input);
    const linked = await db.getAll(...original.map((snapshot) => snapshot.ref));
    assert.ok(linked[0].data().catalogProductId); assert.equal(linked[0].data().catalogProductId, linked[1].data().catalogProductId);
    const created = await db.doc(`hotels/hotel-a/catalogproducts/${linked[0].data().catalogProductId}`).get();
    assert.equal(created.data().baseUnit, "l"); assert.match(created.data().internalSku, /^CAT-\d{6}$/);
    linked.forEach((snapshot, index) => assert.deepEqual(financial(snapshot.data()), financial(original[index].data())));
    assert.deepEqual(await readEvidence(paths), before);
    const replayBefore = await readEvidence([...paths, created.ref.path, ...linked.map((snapshot) => snapshot.ref.path)]);
    assert.deepEqual(await apply(input), result); assert.deepEqual(await readEvidence(Object.keys(replayBefore)), replayBefore);
    assert.equal((await db.collection("hotels/hotel-a/catalogproducts").get()).size, 3);
  });
  it("rejects stale sources and targets, archived targets, foreign IDs, incompatible dimensions and imprecise conversions without partial links or SKU allocation", async () => {
    for (const mode of ["stale-source", "stale-target", "already-linked", "archived", "foreign", "dimension", "precision"]) {
      const workspace = await preview(), first = bySource(workspace, "milkSix"), second = bySource(workspace, mode === "precision" ? "tiny" : "mass");
      const input = command(workspace, [choice(first, newTarget()), choice(second, existingTarget(mode === "foreign" ? "foreign-only" : "mass"))]);
      if (mode === "stale-source") await db.doc("hotels/hotel-a/supplierproducts/milkSix").update({ revision: first.expectedSupplierRevision + 1 });
      if (mode === "already-linked") await db.doc("hotels/hotel-a/supplierproducts/milkSix").update({ catalogProductId: "milk" });
      if (mode === "stale-target") await db.doc("hotels/hotel-a/catalogproducts/mass").update({ revision: 2 });
      if (mode === "archived") await db.doc("hotels/hotel-a/catalogproducts/mass").update({ active: false, archived: true });
      if (mode === "dimension") await db.doc("hotels/hotel-a/catalogproducts/mass").update({ baseUnit: "l" });
      if (mode === "foreign") await db.doc("hotels/hotel-b/catalogproducts/foreign-only").set({ ...catalog(), revision: 1, productPolicyVersion: 1 });
      const before = await readEvidence(["hotels/hotel-a/supplierproducts/milkSix", "hotels/hotel-a/supplierproducts/mass", "hotels/hotel-a/supplierproducts/tiny"]);
      await assert.rejects(apply(input), (error) => ["aborted", "not-found", "failed-precondition", "invalid-argument"].includes(error.code), mode);
      assert.deepEqual(await readEvidence(Object.keys(before)), before, mode);
      assert.equal((await db.collection("hotels/hotel-a/catalogproducts").get()).size, 2, mode);
      assert.equal((await db.doc("hotels/hotel-a/catalogSkuConfiguration/settings").get()).exists, false, mode);
      await db.doc("hotels/hotel-a/supplierproducts/milkSix").update({ revision: 1, catalogProductId: null });
      await db.doc("hotels/hotel-a/catalogproducts/mass").set({ ...catalog({ name: "Fictional flour", baseUnit: "kg", internalSku: "LEGACY-FLOUR" }), productPolicyVersion: 1, revision: 1 });
    }
  });
  it("checks every approved package including future agreements without changing their prices or historical evidence", async () => {
    const sourceRef = db.doc("hotels/hotel-a/supplierproducts/mass");
    const plan = { productId: "mass", expected: 1, previous: (await sourceRef.get()).data(), catalog: null, previousCatalog: null };
    plan.next = { ...plan.previous, baseUnitsPerPurchaseUnit: 0.000001, pricePerPurchaseUnit: 18,
      priceValidFrom: "2026-11-01", priceValidUntil: "2026-11-30" };
    prepareSupplierPriceVersion(plan, [], { kind: "supplier-list", confirmsUnitPrice: true, providedPriceOptionIds: ["default"],
      sourceReference: "Fictional November agreement.xlsx · row-3", sourceIssuedOn: "2026-10-10", sourceImportId: "approved-import", sourceProposalId: "row-3" }, "2026-10-14");
    await db.runTransaction(async (tx) => {
      writeSupplierPriceVersion(tx, db, "hotel-a", plan, "manager", admin.firestore.Timestamp.fromMillis(services.now()));
      tx.set(sourceRef, { ...plan.next, revision: 2 });
    });
    const versions = await db.collection("hotels/hotel-a/supplierPriceVersions/mass/entries").get();
    const confirmations = await db.collection("hotels/hotel-a/supplierPriceConfirmations/mass/entries").get();
    assert.equal(versions.size, 2); assert.equal(confirmations.size, 1);
    const original = await sourceRef.get();
    assert.equal(original.data().baseUnitsPerPurchaseUnit, 1000, "future agreement retains the present package");
    assert.equal(original.data().pricePerPurchaseUnit, 12, "future agreement retains the present price");
    const history = await readEvidence([...versions.docs, ...confirmations.docs].map((snapshot) => snapshot.ref.path)
      .concat(["hotels/hotel-a/orders/historical", "hotels/hotel-a/inventoryMovements/receipt", "hotels/hotel-a/stockCounts/finished"]));
    const workspace = await preview(), first = bySource(workspace, "milkSix"), second = bySource(workspace, "mass");
    assert.doesNotMatch(JSON.stringify(second), /pricePer|priceSource|priceConfirmed|sourceReference|currency|November agreement/);
    await assert.rejects(apply(command(workspace, [choice(first, newTarget()), choice(second, existingTarget("mass"))])), { code: "failed-precondition" });
    assert.deepEqual((await sourceRef.get()).data(), original.data());
    assert.equal((await db.doc("hotels/hotel-a/supplierproducts/milkSix").get()).data().catalogProductId, null);
    assert.equal((await db.doc("hotels/hotel-a/catalogSkuConfiguration/settings").get()).exists, false);
    await db.doc("hotels/hotel-a/catalogproducts/mass").update({ baseUnit: "g", revision: 2 });
    const compatible = await preview();
    await apply(command(compatible, [choice(bySource(compatible, "mass"), existingTarget("mass", 2))]));
    assert.deepEqual(financial((await sourceRef.get()).data()), financial(original.data()));
    assert.deepEqual(await readEvidence(Object.keys(history)), history);
  });
  it("checks job owner, hotel membership, all read and mutation rights and live Auth even for exact receipt replay", async () => {
    for (const actor of ["hotel-b", "operator", "claimed-admin"]) await denied(preview({}, actor));
    await denied(preview({ hotelUid: "hotel-b" }));
    const workspace = await preview(), input = command(workspace, [choice(bySource(workspace, "milkSix"), newTarget())]);
    for (const actor of ["same-hotel", "hotel-b", "operator", "claimed-admin"]) { await denied(read(workspace.jobId, actor)); await denied(apply(input, actor)); }
    const member = db.doc("hotels/hotel-a/members/manager");
    for (const permission of ["supplierproducts.read", "catalogproducts.read", "suppliers.read", "supplierproducts.update", "catalogproducts.create"]) {
      await member.set({ permissions: grants.filter((entry) => entry !== permission) }); await denied(apply(input));
    }
    await member.set({ permissions: grants }); await apply(input);
    await member.set({ permissions: grants.filter((entry) => entry !== "supplierproducts.update") }); await denied(apply(input));
    await member.set({ permissions: grants }); await db.doc("hotelSubscriptions/hotel-a").update({ status: "canceled" }); await denied(apply(input));
    await db.doc("hotelSubscriptions/hotel-a").update({ status: "active" }); await auth.updateUser("manager", { disabled: true }); await denied(apply(input));
    await auth.updateUser("manager", { disabled: false }); await member.delete(); await denied(apply(input));
  });
  it("protects SKU settings against tenant and administrator claims, stale writes and exact replay after revocation", async () => {
    const input = { hotelUid: "hotel-a", requestId: next(), expectedRevision: 0,
      settings: { enabled: true, prefix: "HT-", padding: 4, nextNumber: 1 } };
    for (const actor of ["hotel-b", "operator", "claimed-admin"]) {
      await denied(skuApi().getHotelCatalogSkuSettingsHandler(request({ hotelUid: "hotel-a" }, actor), services));
      await denied(skuApi().saveHotelCatalogSkuSettingsHandler(request(input, actor), services));
    }
    const result = await skuApi().saveHotelCatalogSkuSettingsHandler(request(input), services);
    const reference = db.doc("hotels/hotel-a/catalogSkuConfiguration/settings"), before = await reference.get();
    assert.deepEqual(await skuApi().saveHotelCatalogSkuSettingsHandler(request(input), services), result);
    assert.equal((await reference.get()).updateTime.isEqual(before.updateTime), true);
    await assert.rejects(skuApi().saveHotelCatalogSkuSettingsHandler(request({ ...input, requestId: next() }), services), { code: "aborted" });
    await assert.rejects(skuApi().saveHotelCatalogSkuSettingsHandler(request({ ...input, settings: { ...input.settings, prefix: "CHANGED-" } }), services), { code: "already-exists" });
    await db.doc("hotels/hotel-a/members/manager").set({ permissions: grants.filter((permission) => permission !== "catalogsettings.update") });
    await denied(skuApi().saveHotelCatalogSkuSettingsHandler(request(input), services));
    await db.doc("hotels/hotel-a/members/manager").set({ permissions: grants }); await auth.updateUser("manager", { disabled: true });
    await denied(skuApi().getHotelCatalogSkuSettingsHandler(request({ hotelUid: "hotel-a" }), services));
    await denied(skuApi().saveHotelCatalogSkuSettingsHandler(request(input), services));
    assert.deepEqual((await reference.get()).data(), before.data());
  });
  it("serializes automatic SKU allocation, retains archived and case-folded reservations and respects explicit disabled numbering", async () => {
    await skuApi().saveHotelCatalogSkuSettingsHandler(request({ hotelUid: "hotel-a", requestId: next(), expectedRevision: 0,
      settings: { enabled: true, prefix: "HT-", padding: 4, nextNumber: 1 } }), services);
    const inputs = ["first", "second"].map((id) => ({ hotelUid: "hotel-a", action: "create", productId: id, requestId: next(), expectedRevision: 0,
      product: catalog({ name: `Fictional ${id}` }) }));
    await Promise.all(inputs.map((input) => mutateHotelCatalogProductHandler(request(input), services)));
    const created = await db.getAll(...inputs.map((input) => db.doc(`hotels/hotel-a/catalogproducts/${input.productId}`)));
    assert.deepEqual(created.map((snapshot) => snapshot.data().internalSku).sort(), ["HT-0001", "HT-0002"]);
    const settings = await skuApi().getHotelCatalogSkuSettingsHandler(request({ hotelUid: "hotel-a" }), services);
    assert.equal(settings.nextNumber, 3);
    const first = created[0], replayBefore = await first.ref.get();
    await mutateHotelCatalogProductHandler(request(inputs[0]), services);
    assert.equal((await first.ref.get()).updateTime.isEqual(replayBefore.updateTime), true);
    assert.equal((await skuApi().getHotelCatalogSkuSettingsHandler(request({ hotelUid: "hotel-a" }), services)).nextNumber, 3);
    await mutateHotelCatalogProductHandler(request({ hotelUid: "hotel-a", action: "archive", productId: first.id, expectedRevision: 1, requestId: next() }), services);
    await assert.rejects(mutateHotelCatalogProductHandler(request({ hotelUid: "hotel-a", action: "create", productId: "reuse", expectedRevision: 0,
      requestId: next(), product: catalog({ internalSku: first.data().internalSku.toLowerCase() }) }), services), { code: "already-exists" });
    await skuApi().saveHotelCatalogSkuSettingsHandler(request({ hotelUid: "hotel-a", requestId: next(), expectedRevision: settings.revision,
      settings: { enabled: false, prefix: settings.prefix, padding: settings.padding, nextNumber: settings.nextNumber } }), services);
    await mutateHotelCatalogProductHandler(request({ hotelUid: "hotel-a", action: "create", productId: "disabled", expectedRevision: 0,
      requestId: next(), product: catalog() }), services);
    assert.equal((await db.doc("hotels/hotel-a/catalogproducts/disabled").get()).data().internalSku, "");
    assert.equal((await skuApi().getHotelCatalogSkuSettingsHandler(request({ hotelUid: "hotel-a" }), services)).nextNumber, 3);
  });
  it("reserves explicit SKUs once under concurrent case-insensitive creation and keeps hotel numbering independent", async () => {
    const results = await Promise.allSettled(["MANUAL-1", "manual-1"].map((internalSku, index) => mutateHotelCatalogProductHandler(request({
      hotelUid: "hotel-a", action: "create", productId: `manual-${index}`, expectedRevision: 0, requestId: next(), product: catalog({ internalSku }),
    }), services)));
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.find((result) => result.status === "rejected").reason.code, "already-exists");
    for (const [hotelUid, actor] of [["hotel-a", "manager"], ["hotel-b", "hotel-b"]]) {
      const settings = await skuApi().getHotelCatalogSkuSettingsHandler(request({ hotelUid }, actor), services);
      await skuApi().saveHotelCatalogSkuSettingsHandler(request({ hotelUid, expectedRevision: settings.revision, requestId: next(),
        settings: { enabled: true, prefix: "OWN-", padding: 4, nextNumber: 1 } }, actor), services);
      await mutateHotelCatalogProductHandler(request({ hotelUid, action: "create", productId: "local", expectedRevision: 0, requestId: next(), product: catalog() }, actor), services);
      assert.equal((await db.doc(`hotels/${hotelUid}/catalogproducts/local`).get()).data().internalSku, "OWN-0001");
    }
    assert.equal((await db.collection("hotels/hotel-a/catalogSkuKeys").get()).size, 2);
    assert.equal((await db.collection("hotels/hotel-b/catalogSkuKeys").get()).size, 1);
  });
  it("assigns SKUs to selected blank legacy articles atomically without rewriting local fields or historical evidence", async () => {
    const legacy = { name: "Locally corrected flour", baseUnit: "kg", internalSku: "", productPolicyVersion: 0, revision: 4,
      active: true, legacyPrice: 899, localCorrection: { supplierDescription: "Keep this description" }, imageUrl: "retained local image" };
    for (const id of ["legacy-one", "legacy-two"]) await db.doc(`hotels/hotel-a/catalogproducts/${id}`).set(legacy);
    const input = { hotelUid: "hotel-a", requestId: next(), expectedSettingsRevision: 0,
      products: ["legacy-one", "legacy-two"].map((productId) => ({ productId, expectedRevision: 4 })) };
    const history = await readEvidence(["hotels/hotel-a/orders/historical", "hotels/hotel-a/inventoryMovements/receipt", "hotels/hotel-a/stockCounts/finished"]);
    const result = await skuApi().assignHotelCatalogSkusHandler(request(input), services);
    assert.equal(result.assigned.length, 2); assert.equal(new Set(result.assigned.map((entry) => entry.internalSku)).size, 2);
    const snapshots = await db.getAll(...input.products.map(({ productId }) => db.doc(`hotels/hotel-a/catalogproducts/${productId}`)));
    for (const snapshot of snapshots) {
      const after = { ...snapshot.data() };
      for (const key of ["internalSku", "internalSkuCanonical", "revision", "updatedAt", "updatedBy"]) delete after[key];
      const expected = { ...legacy }; delete expected.internalSku; delete expected.revision;
      assert.deepEqual(after, expected); assert.equal(snapshot.data().revision, 5);
    }
    assert.deepEqual(await readEvidence(Object.keys(history)), history);
    const proof = await readEvidence([...Object.keys(history), ...snapshots.map((snapshot) => snapshot.ref.path), "hotels/hotel-a/catalogSkuConfiguration/settings"]);
    assert.deepEqual(await skuApi().assignHotelCatalogSkusHandler(request(input), services), result);
    assert.deepEqual(await readEvidence(Object.keys(proof)), proof);
    await db.doc("hotels/hotel-a/members/manager").set({ permissions: grants.filter((permission) => permission !== "catalogproducts.update") });
    await denied(skuApi().assignHotelCatalogSkusHandler(request(input), services));
    assert.deepEqual(await readEvidence(Object.keys(proof)), proof);
  });
  it("keeps optional AI suggestions private, hotel-scoped and advisory with one immutable charged attempt on replay", async (context) => {
    allowInjectedCatalogProvider(context);
    await db.doc("platformConfiguration/aiSupplierProductImport").set({ ...DEFAULT_AI_CONFIGURATION, enabled: true });
    const workspace = await preview(), row = bySource(workspace, "milkSix");
    let counted = 0, paid = 0;
    const provider = { countInput: async () => { counted++; return 500; }, respond: async (body) => {
      paid++; const wire = JSON.parse(body.input[0].content[0].text);
      assert.doesNotMatch(JSON.stringify(wire), /price|currency|PRIVATE|credential|1299|sourceReference/i);
      return { id: "fictional-catalog-suggestion", model: "gpt-6-luna", status: "completed",
        usage: { input_tokens: 500, output_tokens: 100, total_tokens: 600 }, output: [{ type: "message", content: [{ type: "output_text",
          text: JSON.stringify({ suggestions: wire.rows.map((source) => ({ rowId: source.rowId, catalogProductId: null,
            reason: "Keep this article separate until its specifications are confirmed.", specificDifferences: [] })) }) }] }] };
    } };
    const input = { hotelUid: "hotel-a", jobId: workspace.jobId, requestId: next(), expectedRevision: workspace.revision, rowIds: [row.rowId] };
    const refine = (data = input, actor = "manager", extra = {}) => aiApi().refineHotelCatalogSyncSuggestionsHandler(request(data, actor), { ...services, provider, ...extra });
    for (const actor of ["same-hotel", "hotel-b", "operator", "claimed-admin"]) await denied(refine(input, actor));
    assert.equal(counted, 0); assert.equal(paid, 0);
    const paths = ["hotels/hotel-a/supplierproducts/milkSix", "hotels/hotel-a/orders/historical", "hotels/hotel-a/inventoryMovements/receipt", "hotels/hotel-a/stockCounts/finished"];
    const before = await readEvidence(paths), result = await refine();
    assert.equal(result.status, "ready"); assert.equal(result.suggestions.length, 1);
    assert.doesNotMatch(JSON.stringify(result), /"(?:usage|model|configuration|inputTokens|outputTokens|knownCostMicros|reservedCostMicros|budget|apiKey)"/);
    assert.equal(counted, 1); assert.equal(paid, 1);
    assert.equal((await db.collection("hotels/hotel-a/catalogproducts").get()).size, 2);
    assert.deepEqual(await readEvidence(paths), before);
    const operation = db.doc(`hotels/hotel-a/catalogSyncJobs/${workspace.jobId}/aiOperations/${digest("manager", input.requestId)}`);
    const charged = await operation.get(); assert.equal(charged.data().status, "ready"); assert.ok(charged.data().knownCostMicros > 0);
    assert.deepEqual(await refine(), result); assert.equal((await operation.get()).updateTime.isEqual(charged.updateTime), true);
    assert.equal(counted, 1); assert.equal(paid, 1);
    await db.doc("hotels/hotel-a/members/manager").set({ permissions: grants.filter((permission) => permission !== "supplierproducts.update") });
    await denied(refine()); assert.equal(paid, 1);
  });
  it("retains unknown AI billing evidence and refuses another paid request while allowing ordinary manual catalog review", async (context) => {
    allowInjectedCatalogProvider(context);
    await db.doc("platformConfiguration/aiSupplierProductImport").set({ ...DEFAULT_AI_CONFIGURATION, enabled: true });
    const workspace = await preview(), row = bySource(workspace, "milkSix"); let paid = 0;
    const extra = { ...services, provider: { countInput: async () => 500, respond: async () => { paid++; throw new Error("Fictional lost response with PRIVATE provider details"); } } };
    const input = { hotelUid: "hotel-a", jobId: workspace.jobId, requestId: next(), expectedRevision: workspace.revision, rowIds: [row.rowId] };
    const refine = (data) => aiApi().refineHotelCatalogSyncSuggestionsHandler(request(data), extra);
    const result = await refine(input); assert.equal(result.status, "response-unknown"); assert.doesNotMatch(JSON.stringify(result), /PRIVATE|provider details|budget|cost|gpt/i);
    const operation = db.doc(`hotels/hotel-a/catalogSyncJobs/${workspace.jobId}/aiOperations/${digest("manager", input.requestId)}`), before = await operation.get();
    assert.ok(before.data().reservedCostMicros > 0); assert.equal(before.data().knownCostMicros, 0);
    assert.deepEqual(await refine(input), result); assert.equal((await operation.get()).updateTime.isEqual(before.updateTime), true);
    await assert.rejects(refine({ ...input, requestId: next() }), { code: "failed-precondition" }); assert.equal(paid, 1);
    const reviewed = await read(workspace.jobId), current = bySource(reviewed, "milkSix");
    await apply(command(reviewed, [choice(current, newTarget())]));
    assert.ok((await db.doc("hotels/hotel-a/supplierproducts/milkSix").get()).data().catalogProductId);
    assert.equal((await operation.get()).data().reservedCostMicros, before.data().reservedCostMicros);
  });
  it("rechecks live account authority after AI I/O without publishing suggestions or losing known billing evidence", async (context) => {
    allowInjectedCatalogProvider(context);
    await db.doc("platformConfiguration/aiSupplierProductImport").set({ ...DEFAULT_AI_CONFIGURATION, enabled: true });
    const workspace = await preview(), row = bySource(workspace, "milkSix"); let paid = 0;
    const input = { hotelUid: "hotel-a", jobId: workspace.jobId, requestId: next(), expectedRevision: workspace.revision, rowIds: [row.rowId] };
    await denied(aiApi().refineHotelCatalogSyncSuggestionsHandler(request(input), { ...services, provider: {
      countInput: async () => 500, respond: async (body) => {
        paid++; await auth.updateUser("manager", { disabled: true });
        const wire = JSON.parse(body.input[0].content[0].text);
        return { id: "fictional-revoked-response", model: "gpt-6-luna", status: "completed", usage: { input_tokens: 500, output_tokens: 100, total_tokens: 600 },
          output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ suggestions: wire.rows.map((source) => ({
            rowId: source.rowId, catalogProductId: null, reason: "Review the article specifications.", specificDifferences: [] })) }) }] }] };
      },
    } }));
    const stored = (await db.doc(`hotels/hotel-a/catalogSyncJobs/${workspace.jobId}/rows/${row.rowId}`).get()).data();
    assert.equal(stored.reviewRevision, row.reviewRevision); assert.equal(stored.aiSuggestion ?? null, null);
    const operation = (await db.doc(`hotels/hotel-a/catalogSyncJobs/${workspace.jobId}/aiOperations/${digest("manager", input.requestId)}`).get()).data();
    assert.equal(operation.status, "failed"); assert.ok(operation.knownCostMicros > 0); assert.equal(operation.reservedCostMicros, 0); assert.equal(paid, 1);
  });
});
