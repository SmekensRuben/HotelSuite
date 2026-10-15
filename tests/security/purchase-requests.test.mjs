import { before, beforeEach, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { initializeTestEnvironment, assertFails } from "@firebase/rules-unit-testing";
import { collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc } from "firebase/firestore";
import { ref, getBytes, getMetadata, uploadBytes, deleteObject } from "firebase/storage";

const projectId = "demo-hotel-suite-a00";
for (const key of ["FIRESTORE_EMULATOR_HOST", "FIREBASE_AUTH_EMULATOR_HOST", "FIREBASE_STORAGE_EMULATOR_HOST"]) {
  if (!/^(127\.0\.0\.1|localhost):\d+$/.test(process.env[key] || "")) throw new Error("Only real local emulators are allowed.");
}
process.env.FIREBASE_CONFIG = JSON.stringify({ projectId, storageBucket: `${projectId}.appspot.com` });
const require = createRequire(import.meta.url);
const { admin } = require("../../functions/src/config");
const { SAAS_RULES_VERSION } = require("../../functions/src/saasRollout");
const { requireHotelImportTarget } = require("../../functions/src/fileImportTypes");
const api = () => require("../../functions/src/purchaseRequests");
const db = admin.firestore(), auth = admin.auth(), bucket = admin.storage().bucket();
const services = { firestore: db, auth, bucket, now: () => Date.parse("2026-10-15T10:00:00Z"), appBaseUrl: "https://hotel.example.test" };
const grants = ["purchaserequests.read", "purchaserequests.create", "purchaserequests.update", "purchaserequests.submit", "purchaserequests.approve", "purchaserequests.cancel", "purchasebudgets.read", "purchasebudgets.update", "purchasebudgets.settings", "suppliers.read", "supplierproducts.read"];
const identities = Object.fromEntries(["requester", "manager", "finance", "viewer", "foreign", "operator", "claimed-admin"].map((uid) => [uid, {
  uid, token: { email: `${uid}@example.test`, email_verified: true, auth_time: Math.floor(Date.now() / 1000),
    ...(uid === "operator" ? { platformAdmin: true } : {}), ...(uid === "claimed-admin" ? { hotelAdmin: true } : {}) },
}]));
const request = (data, actor = "requester") => ({ auth: identities[actor], data });
const rejected = (promise, code = "permission-denied") => assert.rejects(promise, { code });
const privateCollections = ["purchaseRequests", "purchaseRequestOperations", "purchaseBudgets", "purchaseRequestAttachments", "purchaseRequestNotifications"];
let environment, sequence = 0;
const next = () => `purchase-request-test-${++sequence}`;
const draft = (amount = 150, patch = {}) => ({ supplierId: "supplier", title: "Fictional freezer repair", description: "Repair the freezer", motivation: "The compressor is broken", costCentreId: "kitchen", budgetCategoryId: "maintenance", budgetMonth: "2026-10", lines: [{ id: "repair", kind: "free", description: "Compressor repair", quantity: 1, unitPrice: amount, unit: "service" }], attachmentIds: [], ...patch });
const mutate = (action, fields = {}, actor = "requester") => api().mutateHotelPurchaseRequestHandler(request({ hotelUid: "hotel-a", requestId: next(), action, ...fields }, actor), services);
const create = (amount = 150, patch = {}) => mutate("create", { expectedRevision: 0, draft: draft(amount, patch) });
const transition = (action, result, fields = {}, actor = "requester") => mutate(action, { purchaseRequestId: result.purchaseRequestId, expectedRevision: result.revision, ...fields }, actor);
const readBudget = async () => (await db.doc("hotels/hotel-a/purchaseBudgets/2026-10__maintenance").get()).data();
const evidence = async (paths) => Object.fromEntries(await Promise.all(paths.map(async (path) => [path, (await db.doc(path).get()).data()])));
const get = (result, actor = "requester") => api().getHotelPurchaseRequestHandler(request({ hotelUid: "hotel-a", purchaseRequestId: result.purchaseRequestId }, actor), services);
async function configure({ twoSteps = false, amount = 50000, openingUsedMinor = 0, overBudgetMode = "block" } = {}) {
  const settings = { currency: "EUR", costCentres: [{ id: "kitchen", name: "Kitchen" }], budgetCategories: [{ id: "maintenance", name: "Maintenance" }], approvalSteps: [{ id: "manager", name: "Department manager", thresholdMinor: 0 }, ...(twoSteps ? [{ id: "finance", name: "Finance", thresholdMinor: 0 }] : [])], approvers: [
    { uid: "manager", stepIds: ["manager"], limitMinor: 1000000, canApproveOverBudget: false },
    { uid: "finance", stepIds: twoSteps ? ["finance"] : ["manager"], limitMinor: 1000000, canApproveOverBudget: true },
    { uid: "requester", stepIds: twoSteps ? ["manager", "finance"] : ["manager"], limitMinor: 1000000, canApproveOverBudget: true },
  ], overBudgetMode };
  await api().saveHotelPurchaseRequestSettingsHandler(request({ hotelUid: "hotel-a", requestId: next(), expectedRevision: 0, settings }), services);
  await api().saveHotelPurchaseBudgetsHandler(request({ hotelUid: "hotel-a", requestId: next(), budgets: [{ month: "2026-10", categoryId: "maintenance", budgetMinor: amount, openingUsedMinor, expectedRevision: 0 }] }), services);
}

before(async () => {
  environment = await initializeTestEnvironment({ projectId,
    firestore: { host: "127.0.0.1", port: Number(process.env.FIRESTORE_EMULATOR_HOST.split(":").at(-1)), rules: await readFile("firebase/firestore.rules", "utf8") },
    storage: { host: "127.0.0.1", port: Number(process.env.FIREBASE_STORAGE_EMULATOR_HOST.split(":").at(-1)), rules: await readFile("firebase/storage.rules", "utf8") } });
});
beforeEach(async () => {
  await environment.clearFirestore(); await environment.clearStorage();
  const [files] = await bucket.getFiles(); await Promise.all(files.map((file) => file.delete()));
  const users = await auth.listUsers(); if (users.users.length) await auth.deleteUsers(users.users.map((user) => user.uid));
  for (const identity of Object.values(identities)) {
    await auth.createUser({ uid: identity.uid, email: identity.token.email, emailVerified: true });
    await auth.setCustomUserClaims(identity.uid, identity.uid === "operator" ? { platformAdmin: true } : identity.uid === "claimed-admin" ? { hotelAdmin: true } : {});
    identity.token.auth_time = Math.floor(Date.now() / 1000);
  }
  await db.doc("platformConfiguration/saasProcurement").set({ enabled: true, rulesVersion: SAAS_RULES_VERSION });
  for (const hotelUid of ["hotel-a", "hotel-b"]) {
    await db.doc(`hotels/${hotelUid}`).set({ hotelName: hotelUid, currency: "EUR", timeZone: "Europe/Brussels" });
    await db.doc(`hotelSubscriptions/${hotelUid}`).set({ status: "active", validUntil: null, modules: ["procurement"], modulePolicyVersion: 1 });
    await db.doc(`hotels/${hotelUid}/suppliers/supplier`).set({ name: "Fictional repair company", active: true });
  }
  for (const uid of ["requester", "manager", "finance"]) await db.doc(`hotels/hotel-a/members/${uid}`).set({ permissions: grants });
  await db.doc("hotels/hotel-a/members/viewer").set({ permissions: ["purchaserequests.read", "purchasebudgets.read"] });
  await db.doc("hotels/hotel-b/members/foreign").set({ permissions: grants });
  await db.doc("hotels/hotel-a/members/claimed-admin").set({ hotelAdmin: true, permissions: [] });
});
after(async () => environment.cleanup());

describe("purchase requests with real tenant, budget and approval boundaries", () => {
  it("denies direct browser access to financial state, decisions, history, settings and command receipts", async () => {
    const paths = privateCollections.map((name) => `hotels/hotel-a/${name}/record`);
    paths.push("hotels/hotel-a/purchaseRequests/record/history/1", "hotels/hotel-a/purchaseRequests/record/attachments/file", "hotels/hotel-a/settings/purchaseRequests");
    for (const path of paths) await db.doc(path).set({ immutable: true, pendingMinor: 15000 });
    for (const actor of ["requester", "viewer", "foreign", "operator", "claimed-admin"]) {
      const browser = environment.authenticatedContext(actor, identities[actor].token).firestore();
      for (const path of paths) {
        const reference = doc(browser, path);
        await assertFails(getDoc(reference)); await assertFails(setDoc(reference, { pendingMinor: 0 }));
        await assertFails(updateDoc(reference, { immutable: false })); await assertFails(deleteDoc(reference));
      }
      for (const name of privateCollections) await assertFails(getDocs(collection(browser, `hotels/hotel-a/${name}`)));
    }
    for (const name of privateCollections) for (const suffix of ["record", "record/history/1", "record/attachments/file"])
      assert.throws(() => requireHotelImportTarget(`hotels/hotel-a/${name}/${suffix}`, "hotel-a"));
    assert.throws(() => requireHotelImportTarget("hotels/hotel-a/settings/purchaseRequests", "hotel-a"));
  });
  it("keeps attachment bytes and download-token metadata private for every browser role", async () => {
    const path = `private/purchase-requests/hotel-a/request/${"a".repeat(32)}`;
    await bucket.file(path).save(Buffer.from("Confidential fictional quotation"), { contentType: "application/pdf" });
    for (const actor of ["requester", "viewer", "foreign", "operator", "claimed-admin", null]) {
      const browser = actor ? environment.authenticatedContext(actor, identities[actor].token) : environment.unauthenticatedContext();
      const file = ref(browser.storage(), path);
      await assertFails(getBytes(file)); await assertFails(getMetadata(file));
      await assertFails(uploadBytes(file, new Uint8Array([1]), { contentType: "application/pdf" })); await assertFails(deleteObject(file));
    }
  });
  it("moves one reservation to a final commitment without double-counting and safely replays each command", async () => {
    await configure({ openingUsedMinor: 30000 });
    const created = await create();
    const initial = await readBudget();
    assert.equal(initial.pendingMinor || 0, 0);
    const input = { hotelUid: "hotel-a", requestId: next(), action: "submit", purchaseRequestId: created.purchaseRequestId, expectedRevision: created.revision, approverUid: "manager" };
    const submitted = await api().mutateHotelPurchaseRequestHandler(request(input), services);
    assert.deepEqual(await api().mutateHotelPurchaseRequestHandler(request(input), services), submitted);
    const pending = await readBudget(); assert.equal(pending.pendingMinor, 15000);
    const approval = { hotelUid: "hotel-a", requestId: next(), action: "approve", purchaseRequestId: submitted.purchaseRequestId, expectedRevision: submitted.revision };
    const approved = await api().mutateHotelPurchaseRequestHandler(request(approval, "manager"), services);
    const final = await readBudget();
    assert.equal(final.pendingMinor, 0); assert.equal(final.committedMinor, 15000);
    assert.equal(final.budgetMinor - final.openingUsedMinor - final.pendingMinor - final.committedMinor, 5000);
    assert.deepEqual(await api().mutateHotelPurchaseRequestHandler(request(approval, "manager"), services), approved);
    assert.deepEqual(await readBudget(), final);
    await transition("cancel", approved, { reason: "Repair no longer required" });
    const cancelled = await readBudget(); assert.equal(cancelled.pendingMinor, 0); assert.equal(cancelled.committedMinor, 0);
  });
  it("requires the assigned next approver, prevents self-approval and cannot skip mandatory steps", async () => {
    await configure({ twoSteps: true });
    const created = await create();
    await rejected(transition("submit", created, { approverUid: "requester" }));
    await rejected(transition("submit", created, { approverUid: "finance" }));
    const submitted = await transition("submit", created, { approverUid: "manager" });
    await rejected(transition("approve", submitted), "permission-denied");
    await rejected(transition("approve", submitted, {}, "finance"), "permission-denied");
    await assert.rejects(transition("approve", submitted, {}, "manager"), (error) => ["invalid-argument", "failed-precondition"].includes(error.code));
    const intermediate = await transition("approve", submitted, { nextApproverUid: "finance" }, "manager");
    const reserved = await readBudget(); assert.equal(reserved.pendingMinor, 15000); assert.equal(reserved.committedMinor || 0, 0);
    await rejected(transition("approve", intermediate, {}, "manager"), "permission-denied");
    await transition("approve", intermediate, {}, "finance");
    const final = await readBudget(); assert.equal(final.pendingMinor, 0); assert.equal(final.committedMinor, 15000);
  });
  it("retains returned reservations, adjusts the same fixed month on resubmission and preserves old snapshots", async () => {
    await configure();
    const created = await create();
    const submitted = await transition("submit", created, { approverUid: "manager" });
    const historyPath = `hotels/hotel-a/purchaseRequests/${created.purchaseRequestId}/history/${String(submitted.revision).padStart(6, "0")}`;
    const before = await evidence([historyPath]);
    const returned = await transition("return", submitted, { reason: "Please include labour" }, "manager");
    assert.equal((await readBudget()).pendingMinor, 15000);
    const saved = await transition("save", returned, { draft: draft(175) });
    assert.equal((await readBudget()).pendingMinor, 15000);
    const resubmitted = await transition("submit", saved, { approverUid: "manager" });
    assert.equal((await readBudget()).pendingMinor, 17500);
    assert.equal((await get(resubmitted)).request.budgetMonth, "2026-10");
    assert.deepEqual(await evidence([historyPath]), before);
    await transition("reject", resubmitted, { reason: "Use the maintenance contract instead" }, "manager");
    assert.equal((await readBudget()).pendingMinor, 0);
  });
  it("allows an excess budget only through an additional independent authorized decision", async () => {
    await configure({ amount: 10000, overBudgetMode: "approval" });
    const created = await create();
    const submitted = await transition("submit", created, { approverUid: "manager" });
    assert.equal((await readBudget()).pendingMinor, 15000);
    await rejected(transition("approve", submitted, { nextApproverUid: "manager" }, "manager"));
    const intermediate = await transition("approve", submitted, { nextApproverUid: "finance" }, "manager");
    assert.equal((await readBudget()).committedMinor || 0, 0);
    await transition("approve", intermediate, {}, "finance");
    const final = await readBudget(); assert.equal(final.pendingMinor, 0); assert.equal(final.committedMinor, 15000);
    assert.equal(final.budgetMinor - final.committedMinor, -5000);
  });
  it("requires a fresh approval revision for changed commitments while retaining the original approval snapshot", async () => {
    await configure();
    const created = await create();
    const submitted = await transition("submit", created, { approverUid: "manager" });
    const approved = await transition("approve", submitted, {}, "manager");
    const historyPath = `hotels/hotel-a/purchaseRequests/${created.purchaseRequestId}/history/${String(approved.revision).padStart(6, "0")}`;
    const original = await evidence([historyPath]);
    await rejected(transition("save", approved, { draft: draft(200) }), "failed-precondition");
    const revised = await transition("revise", approved, { reason: "Include an additional replacement part", draft: draft(200) });
    assert.equal(revised.request.status, "returned"); assert.deepEqual(revised.request.approvals, []);
    let budget = await readBudget(); assert.equal(budget.pendingMinor, 15000); assert.equal(budget.committedMinor, 0);
    const resubmitted = await transition("submit", revised, { approverUid: "manager" });
    budget = await readBudget(); assert.equal(budget.pendingMinor, 20000); assert.equal(budget.committedMinor, 0);
    await transition("approve", resubmitted, {}, "manager");
    budget = await readBudget(); assert.equal(budget.pendingMinor, 0); assert.equal(budget.committedMinor, 20000);
    assert.deepEqual(await evidence([historyPath]), original);
  });
  it("pins authorized document bytes to current and historical revisions without browser download tokens", async () => {
    await configure();
    const { uploadPurchaseRequestAttachment, readPurchaseRequestAttachment, purchaseRequestDocumentHandler } = require("../../functions/src/purchaseRequestFiles");
    const created = await create(), fileId = "b".repeat(32), bytes = Buffer.from("Fictional repair quotation: 150 EUR net");
    const input = { hotelUid: "hotel-a", purchaseRequestId: created.purchaseRequestId, fileId, expectedRevision: created.revision, fileName: "quotation.txt", contentType: "text/plain" };
    const uploaded = await uploadPurchaseRequestAttachment(request({}), input, bytes, services);
    assert.deepEqual(await uploadPurchaseRequestAttachment(request({}), input, bytes, services), uploaded);
    const [metadata] = await bucket.file(uploaded.attachment.filePath).getMetadata();
    assert.equal(metadata.metadata?.firebaseStorageDownloadTokens, undefined);
    const saved = await transition("save", created, { draft: draft(150, { attachmentIds: [fileId] }) });
    const submitted = await transition("submit", saved, { approverUid: "manager" });
    assert.deepEqual((await readPurchaseRequestAttachment(request({}, "viewer"), { ...input, revision: submitted.revision }, services)).bytes, bytes);
    await rejected(readPurchaseRequestAttachment(request({}, "foreign"), input, services));
    await rejected(uploadPurchaseRequestAttachment(request({}), { ...input, fileId: "c".repeat(32), expectedRevision: submitted.revision }, bytes, services));
    const response = { statuses: [], set() {}, status(code) { this.statuses.push(code); return this; }, json() {}, send() {} };
    await purchaseRequestDocumentHandler({ method: "GET", headers: {}, query: { ...input, token: "untrusted" } }, response, services);
    assert.deepEqual(response.statuses, [401]);
    await db.doc("hotels/hotel-a/members/viewer").delete();
    await rejected(readPurchaseRequestAttachment(request({}, "viewer"), input, services));
    assert.equal((await readBudget()).pendingMinor, 15000);
  });
  it("serializes competing submissions and conflicting budget edits without partial history or extra reservations", async () => {
    await configure({ amount: 20000 });
    const first = await create(), second = await create();
    const outcomes = await Promise.allSettled([transition("submit", first, { approverUid: "manager" }), transition("submit", second, { approverUid: "manager" })]);
    assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1);
    const budget = await readBudget(); assert.equal(budget.pendingMinor, 15000); assert.equal(budget.committedMinor || 0, 0);
    const winner = outcomes.find((result) => result.status === "fulfilled").value;
    const competing = await Promise.allSettled([transition("approve", winner, {}, "manager"), transition("withdraw", winner, { reason: "Changed requirements" })]);
    assert.equal(competing.filter((result) => result.status === "fulfilled").length, 1);
    const final = await readBudget(); assert.equal(final.pendingMinor, 0); assert.ok([0, 15000].includes(final.committedMinor));
    const before = await readBudget();
    await rejected(api().saveHotelPurchaseBudgetsHandler(request({ hotelUid: "hotel-a", requestId: next(), budgets: [{ month: "2026-10", categoryId: "maintenance", budgetMinor: 1, openingUsedMinor: 0, expectedRevision: 0 }] }), services), "aborted");
    assert.deepEqual(await readBudget(), before);
  });
  it("enforces current membership, subscription, explicit authority and verified non-revoked users at every read and decision", async () => {
    await configure();
    const created = await create();
    for (const actor of ["foreign", "operator", "claimed-admin"]) await rejected(get(created, actor));
    await rejected(api().getHotelPurchaseRequestSettingsHandler(request({ hotelUid: "hotel-a" }, "viewer"), services));
    await db.doc("hotels/hotel-a/members/requester").update({ permissions: ["purchaserequests.*", "purchasebudgets.*"] });
    await rejected(transition("submit", created, { approverUid: "manager" }));
    await rejected(api().getHotelPurchaseRequestSettingsHandler(request({ hotelUid: "hotel-a" }), services));
    await db.doc("hotels/hotel-a/members/requester").update({ permissions: grants });
    const submitted = await transition("submit", created, { approverUid: "manager" });
    for (const patch of [{ modules: [] }, { status: "suspended" }]) {
      await db.doc("hotelSubscriptions/hotel-a").update(patch);
      await rejected(get(submitted)); await rejected(transition("approve", submitted, {}, "manager"));
      await db.doc("hotelSubscriptions/hotel-a").update({ status: "active", modules: ["procurement"] });
    }
    await db.doc("hotels/hotel-a/members/manager").delete();
    await rejected(transition("approve", submitted, {}, "manager"));
    await auth.updateUser("requester", { disabled: true }); await rejected(get(submitted));
    await auth.updateUser("requester", { disabled: false, emailVerified: false }); await rejected(get(submitted));
    await auth.updateUser("requester", { emailVerified: true });
    identities.requester.token.auth_time = 1;
    await auth.revokeRefreshTokens("requester"); await rejected(get(submitted));
    assert.equal((await readBudget()).pendingMinor, 15000);
  });
});
