import { before, beforeEach, after, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, collection, query, where, getDocs } from "firebase/firestore";
const projectId = "demo-hotel-suite-a00";
if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) throw new Error("Only local emulators are allowed.");
process.env.FIREBASE_CONFIG = JSON.stringify({ projectId, storageBucket: `${projectId}.appspot.com` });
const require = createRequire(import.meta.url);
const { admin } = require("../../functions/src/config");
const { saveSupplierOutletAccount, saveSupplierOutletAccountHandler } = require("../../functions/src/orders");
const { compileMemberAccess } = require("../../functions/src/modulePolicy");
const { SAAS_RULES_VERSION } = require("../../functions/src/saasRollout");
const { requireHotelImportTarget } = require("../../functions/src/fileImportTypes");
const db = admin.firestore(), auth = admin.auth();
const services = { firestore: db, auth };
const identities = Object.fromEntries(["manager", "other-manager", "viewer", "hotel-admin", "operator"].map((uid) => [uid, { uid, token: { email_verified: true, ...(uid === "operator" ? { platformAdmin: true } : {}) } }]));
const req = (actor, data) => ({ auth: identities[actor], data });
const rejected = (promise, code) => assert.rejects(promise, (error) => error.code === code);
const input = { hotelUid: "hotel-a", supplierId: "supplier", outletId: "bar", accountNumber: "BAR-001", requestId: "create", expectedRevision: 0, expectedActorUid: "manager" };
const subscription = { modules: ["procurement"], modulePolicyVersion: 1, status: "active", validUntil: null };
let environment;
before(async () => { environment = await initializeTestEnvironment({ projectId, firestore: { host: "127.0.0.1", port: 8080, rules: await readFile("firebase/firestore.rules", "utf8") } }); });
beforeEach(async () => {
  await environment.clearFirestore(); const users = await auth.listUsers(); if (users.users.length) await auth.deleteUsers(users.users.map((user) => user.uid));
  await db.doc("platformConfiguration/saasProcurement").set({ enabled: true, rulesVersion: SAAS_RULES_VERSION });
  for (const actor of Object.values(identities)) {
    await auth.createUser({ uid: actor.uid, email: `${actor.uid}@example.test`, emailVerified: true });
    if (actor.uid === "operator") await auth.setCustomUserClaims(actor.uid, { platformAdmin: true });
  }
  for (const hotel of ["hotel-a", "hotel-b"]) {
    await db.doc(`hotels/${hotel}`).set({ name: hotel }); await db.doc(`hotelSubscriptions/${hotel}`).set(subscription);
    await db.doc(`hotels/${hotel}/suppliers/supplier`).set({ name: "Supplier" }); await db.doc(`hotels/${hotel}/outlets/bar`).set({ name: "Lobby bar" });
  }
  for (const uid of ["manager", "other-manager", "viewer", "hotel-admin"]) {
    const access = compileMemberAccess({ hotelAdmin: uid === "hotel-admin", moduleRoles: uid === "hotel-admin" ? {} : { procurement: [uid === "viewer" ? "viewer" : "module-manager"] } }, subscription);
    await db.doc(`hotels/hotel-a/members/${uid}`).set(access);
  }
});
after(async () => environment.cleanup());
const create = () => saveSupplierOutletAccount.run(req("manager", input));
it("lets a genuine normal module manager create and edit a stable account, with atomic revisions and idempotent replay", async () => {
  const created = await create(); assert.equal(created.revision, 1);
  const change = { ...input, accountId: created.id, expectedRevision: 1, accountNumber: "BAR-002", requestId: "edit" };
  const saved = await saveSupplierOutletAccount.run(req("manager", change)); assert.deepEqual(saved, { id: created.id, revision: 2 });
  assert.deepEqual(await saveSupplierOutletAccount.run(req("manager", change)), saved);
  const record = (await db.doc(`hotels/hotel-a/supplierOutletAccounts/${created.id}`).get()).data();
  assert.equal(record.accountNumber, "BAR-002"); assert.equal(record.updatedBy, "manager"); assert.equal(record.createdBy, "manager");
  assert.equal((await db.collection("hotels/hotel-a/supplierAudit").get()).size, 2);
  assert.equal((await db.collection("hotels/hotel-a/supplierAccountOperations").get()).size, 2);
  await rejected(saveSupplierOutletAccount.run(req("manager", { ...change, accountNumber: "DIFFERENT" })), "already-exists");
});
it("preserves legacy account IDs, rejects stale writers and makes new-account duplicates explicit", async () => {
  const legacy = db.doc("hotels/hotel-a/supplierOutletAccounts/legacy-id"); await legacy.set({ supplierId: "supplier", outletId: "bar", accountNumber: "OLD" });
  await rejected(create(), "already-exists");
  const change = { ...input, accountId: "legacy-id", expectedRevision: 0, requestId: "edit-legacy", accountNumber: "NEW" };
  const saved = await saveSupplierOutletAccountHandler(req("manager", change), services); assert.equal(saved.id, "legacy-id"); assert.equal(saved.revision, 1);
  await rejected(saveSupplierOutletAccountHandler(req("other-manager", { ...change, expectedActorUid: "other-manager", requestId: "stale" }), services), "aborted");
  assert.equal((await legacy.get()).data().accountNumber, "NEW"); assert.equal((await db.collection("hotels/hotel-a/supplierOutletAccounts").get()).size, 1);
  // An older create client can no longer silently overwrite an existing assignment.
  await rejected(saveSupplierOutletAccountHandler(req("manager", { hotelUid: "hotel-a", supplierId: "supplier", outletId: "bar", accountNumber: "OLD-CLIENT" }), services), "already-exists");
});
it("allows an account editor without outlet-directory rights and lets exactly one simultaneous writer win", async () => {
  const created = await create();
  await db.doc("hotels/hotel-a/members/manager").update({ permissions: ["suppliers.read", "suppliers.update"] });
  const change = { ...input, accountId: created.id, expectedRevision: 1, requestId: "race-a", accountNumber: "A" };
  const results = await Promise.allSettled([
    saveSupplierOutletAccount.run(req("manager", change)),
    saveSupplierOutletAccount.run(req("other-manager", { ...change, requestId: "race-b", expectedActorUid: "other-manager", accountNumber: "B" })),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.find((result) => result.status === "rejected").reason.code, "aborted");
  assert.equal((await db.doc(`hotels/hotel-a/supplierOutletAccounts/${created.id}`).get()).data().revision, 2);
});
it("checks fresh Auth, hotel rights and subscription on edits and receipt replays without granting operator/admin bypasses", async () => {
  const created = await create(), change = { ...input, accountId: created.id, expectedRevision: 1, requestId: "edit" };
  for (const actor of ["viewer", "hotel-admin", "operator"]) await rejected(saveSupplierOutletAccount.run(req(actor, { ...change, expectedActorUid: actor })), "permission-denied");
  await rejected(saveSupplierOutletAccount.run(req("manager", { ...change, hotelUid: "hotel-b" })), "permission-denied");
  await rejected(saveSupplierOutletAccount.run(req("manager", { ...change, expectedActorUid: "other-manager" })), "permission-denied");
  await auth.updateUser("manager", { disabled: true }); await rejected(create(), "permission-denied");
  await auth.updateUser("manager", { disabled: false, emailVerified: false }); await rejected(create(), "permission-denied");
  await auth.updateUser("manager", { emailVerified: true }); await db.doc("hotelSubscriptions/hotel-a").update({ modules: [] }); await rejected(create(), "permission-denied");
});
it("keeps browser writes and operation receipts private, supports filtered ordinary reads and blocks generic import forgery", async () => {
  const created = await create(), client = environment.authenticatedContext("manager", identities.manager.token).firestore();
  await assertSucceeds(getDocs(query(collection(client, "hotels/hotel-a/supplierOutletAccounts"), where("supplierId", "==", "supplier"))));
  await assertFails(setDoc(doc(client, `hotels/hotel-a/supplierOutletAccounts/${created.id}`), { accountNumber: "FORGED" }, { merge: true }));
  const receipt = (await db.collection("hotels/hotel-a/supplierAccountOperations").get()).docs[0].id;
  await assertFails(getDoc(doc(client, `hotels/hotel-a/supplierAccountOperations/${receipt}`)));
  await assertFails(setDoc(doc(client, `hotels/hotel-a/supplierAccountOperations/${receipt}`), { result: "FORGED" }));
  assert.throws(() => requireHotelImportTarget("hotels/hotel-a/supplierAccountOperations/forged", "hotel-a"));
});
it("preserves independent sent order/dispatch snapshots and rejects duplicate, archived or reassigned account edits", async () => {
  const created = await create(), change = { ...input, accountId: created.id, expectedRevision: 1, requestId: "edit", accountNumber: "NEW" };
  const historical = { status: "Ordered", accountNumber: "BAR-001", currency: "EUR", products: [{ price: 12 }] };
  await db.doc("hotels/hotel-a/orders/sent").set(historical); await db.doc("hotels/hotel-a/dispatches/sent").set({ order: historical });
  await saveSupplierOutletAccount.run(req("manager", change));
  assert.deepEqual((await db.doc("hotels/hotel-a/orders/sent").get()).data(), historical);
  assert.deepEqual((await db.doc("hotels/hotel-a/dispatches/sent").get()).data(), { order: historical });
  const next = { ...change, expectedRevision: 2, requestId: "next" };
  await db.doc("hotels/hotel-a/outlets/bar").update({ archived: true }); await rejected(saveSupplierOutletAccount.run(req("manager", next)), "failed-precondition");
  await db.doc("hotels/hotel-a/outlets/bar").update({ archived: false });
  await db.doc("hotels/hotel-a/supplierOutletAccounts/duplicate").set({ supplierId: "supplier", outletId: "bar", accountNumber: "DUP" });
  await rejected(saveSupplierOutletAccount.run(req("manager", next)), "failed-precondition");
  await db.doc("hotels/hotel-a/supplierOutletAccounts/duplicate").delete();
  await rejected(saveSupplierOutletAccount.run(req("manager", { ...next, accountId: "missing" })), "not-found");
  await rejected(saveSupplierOutletAccount.run(req("manager", { ...next, accountNumber: "" })), "invalid-argument");
  await db.doc(`hotels/hotel-a/supplierOutletAccounts/${created.id}`).update({ revision: "broken" });
  await rejected(saveSupplierOutletAccount.run(req("manager", next)), "failed-precondition");
});
