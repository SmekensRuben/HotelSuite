import { before, beforeEach, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { initializeTestEnvironment } from "@firebase/rules-unit-testing";

const projectId = "demo-hotel-suite-a00";
for (const key of ["FIRESTORE_EMULATOR_HOST", "FIREBASE_AUTH_EMULATOR_HOST", "FIREBASE_STORAGE_EMULATOR_HOST"]) {
  if (!/^(127\.0\.0\.1|localhost):\d+$/.test(process.env[key] || "")) throw new Error("Only real local emulators are allowed.");
}
process.env.FIREBASE_CONFIG = JSON.stringify({ projectId, storageBucket: `${projectId}.appspot.com` });
const require = createRequire(import.meta.url);
const { admin } = require("../../functions/src/config");
const { SAAS_RULES_VERSION } = require("../../functions/src/saasRollout");
const { pricingTerms } = require("../../functions/src/supplierPricePolicy");
const { purchaseTerms } = require("../../functions/src/supplierPriceVersions");
const { digest } = require("../../functions/src/validation");
const api = () => require("../../functions/src/purchaseRequests");
const db = admin.firestore(), auth = admin.auth();
const services = { firestore: db, auth, now: () => Date.parse("2026-10-15T10:00:00Z"), appBaseUrl: "https://hotel.example.test" };
const grants = ["purchaserequests.read", "purchaserequests.create", "purchaserequests.update", "purchaserequests.submit", "purchaserequests.approve", "purchaserequests.cancel", "purchasebudgets.read", "purchasebudgets.update", "purchasebudgets.settings", "suppliers.read", "supplierproducts.read"];
const identities = Object.fromEntries(["requester", "manager", "foreign"].map((uid) => [uid, { uid, token: { email_verified: true, auth_time: Math.floor(Date.now() / 1000) } }]));
let environment, sequence = 0;
const next = () => `purchase-line-supplier-${++sequence}`;
const request = (data, actor = "requester") => ({ auth: identities[actor], data: { hotelUid: "hotel-a", ...data } });
const mutate = (action, fields = {}, actor = "requester") => api().mutateHotelPurchaseRequestHandler(request({ requestId: next(), action, ...fields }, actor), services);
const transition = (action, result, fields = {}, actor = "requester") => mutate(action, { purchaseRequestId: result.purchaseRequestId, expectedRevision: result.revision, ...fields }, actor);
const freeLine = (id, supplierId, unitPrice = 50) => ({ id, kind: "free", supplierId, description: `${id} service`, quantity: 1, unitPrice, unit: "service" });
const productLine = (id, supplierId, supplierProductId, patch = {}) => ({ id, kind: "supplier", supplierId, supplierProductId, purchaseOptionId: "default", description: "", quantity: 1, unit: "", ...patch });
const draft = (lines = [freeLine("repair", "supplier-a"), freeLine("delivery", "supplier-b")], patch = {}) => ({ title: "Fictional mixed supplier request", description: "Goods and repair services", motivation: "Keep hotel equipment operational", costCentreId: "kitchen", budgetCategoryId: "maintenance", budgetMonth: "2026-10", lines, attachmentIds: [], ...patch });
const create = (value = draft()) => mutate("create", { expectedRevision: 0, draft: value });
const detail = (result, actor = "requester") => api().getHotelPurchaseRequestHandler(request({ purchaseRequestId: result.purchaseRequestId }, actor), services);
const budget = async () => (await db.doc("hotels/hotel-a/purchaseBudgets/2026-10__maintenance").get()).data();
const rejected = (promise, code = "failed-precondition") => assert.rejects(promise, { code });
async function evidence(result) {
  const paths = ["purchaseRequests", "purchaseRequestOperations", "purchaseBudgets", "mailQueue"];
  if (result) paths.push(`purchaseRequests/${result.purchaseRequestId}/history`);
  return Object.fromEntries(await Promise.all(paths.map(async (path) => [path, (await db.collection(`hotels/hotel-a/${path}`).get()).docs.map((snapshot) => [snapshot.id, snapshot.data()])])));
}
async function seedProduct(id, supplierId, patch = {}) {
  const catalog = { name: `${id} catalog product`, baseUnit: patch.baseUnit || "kg", internalSku: `CAT-${id}` };
  const product = { supplierId, supplierSku: `${id}-SKU`, supplierProductName: `${id} product`, brand: "Fictional brand", active: true, productPolicyVersion: 1, catalogProductId: id,
    currency: "EUR", priceBasis: "gross", vatRate: 0.06, pricingModel: "Per Purchase Unit", pricePerBaseUnit: null, pricePerPurchaseUnit: 999,
    baseUnit: "kg", purchaseUnit: "case", baseUnitsPerPurchaseUnit: 6, purchaseOptions: [{ id: "single", purchaseUnit: "bag", baseUnitsPerPurchaseUnit: 1, pricePerPurchaseUnit: 1.06 }],
    priceValidFrom: "2026-01-01", priceValidUntil: "2026-10-31", currentPriceVersionId: "v1", latestApprovedPriceVersionId: "v2", revision: 3, ...patch };
  await db.doc(`hotels/hotel-a/catalogproducts/${id}`).set(catalog);
  await db.doc(`hotels/hotel-a/supplierproducts/${id}`).set(product);
  for (const [versionId, revision, from, until, price] of [["v1", 1, "2026-01-01", "2026-10-31", 12.72], ["v2", 2, "2026-11-01", null, 19.08]]) {
    const approved = { ...product, pricePerPurchaseUnit: price, priceValidFrom: from, priceValidUntil: until }, terms = pricingTerms(approved, catalog);
    await db.doc(`hotels/hotel-a/supplierPriceVersions/${id}/entries/${versionId}`).set({ supplierPriceVersionPolicyVersion: 1, supplierProductId: id, supplierId, revision,
      productTerms: purchaseTerms(approved), terms, termsFingerprint: digest(terms), sourceIssuedOn: "2026-10-01", sourceReference: `${supplierId} list ${revision}` });
  }
}

before(async () => {
  environment = await initializeTestEnvironment({ projectId,
    firestore: { host: "127.0.0.1", port: Number(process.env.FIRESTORE_EMULATOR_HOST.split(":").at(-1)), rules: await readFile("firebase/firestore.rules", "utf8") } });
});
beforeEach(async () => {
  await environment.clearFirestore();
  const users = await auth.listUsers(); if (users.users.length) await auth.deleteUsers(users.users.map((user) => user.uid));
  for (const identity of Object.values(identities)) {
    await auth.createUser({ uid: identity.uid, email: `${identity.uid}@example.test`, emailVerified: true, displayName: identity.uid });
    identity.token.auth_time = Math.floor(Date.now() / 1000);
  }
  await db.doc("platformConfiguration/saasProcurement").set({ enabled: true, rulesVersion: SAAS_RULES_VERSION });
  for (const hotelUid of ["hotel-a", "hotel-b"]) {
    await db.doc(`hotels/${hotelUid}`).set({ hotelName: hotelUid, currency: "EUR", timeZone: "Europe/Brussels" });
    await db.doc(`hotelSubscriptions/${hotelUid}`).set({ status: "active", validUntil: null, modules: ["procurement"], modulePolicyVersion: 1 });
  }
  for (const uid of ["requester", "manager"]) await db.doc(`hotels/hotel-a/members/${uid}`).set({ permissions: grants });
  await db.doc("hotels/hotel-b/members/foreign").set({ permissions: grants });
  for (const [id, name] of [["supplier-a", "Fictional Parts"], ["supplier-b", "Fictional Repairs"]]) await db.doc(`hotels/hotel-a/suppliers/${id}`).set({ name, active: true, priceDateBasis: "order-date" });
  await db.doc("hotels/hotel-b/suppliers/foreign-only").set({ name: "Other hotel's supplier", active: true });
  await api().saveHotelPurchaseRequestSettingsHandler(request({ requestId: next(), expectedRevision: 0, settings: { currency: "EUR", costCentres: [{ id: "kitchen", name: "Kitchen" }], budgetCategories: [{ id: "maintenance", name: "Maintenance" }],
    approvalSteps: [{ id: "manager", name: "Department approval", thresholdMinor: 0 }], approvers: [{ uid: "manager", stepIds: ["manager"], limitMinor: 1000000, canApproveOverBudget: false }], overBudgetMode: "block" } }), services);
  await api().saveHotelPurchaseBudgetsHandler(request({ requestId: next(), budgets: [{ month: "2026-10", categoryId: "maintenance", budgetMinor: 50000, openingUsedMinor: 5000, expectedRevision: 0 }] }), services);
});
after(async () => environment.cleanup());

describe("per-line purchase request suppliers with real Auth and Firestore", () => {
  it("snapshots mixed supplier products and services while reserving and approving one request total exactly once", async () => {
    await seedProduct("coffee", "supplier-a");
    const created = await create(draft([productLine("coffee", "supplier-a", "coffee", { quantity: 2 }), freeLine("repair", "supplier-b", 76)]));
    assert.equal(created.request.totalMinor, 10000);
    assert.equal(created.request.supplierId, ""); assert.equal(created.request.supplier, null);
    assert.deepEqual(created.request.suppliers, [{ id: "supplier-a", name: "Fictional Parts" }, { id: "supplier-b", name: "Fictional Repairs" }]);
    assert.deepEqual(created.request.lines.map((line) => line.supplier), created.request.suppliers);
    assert.equal(created.request.lines[0].priceVersionId, "v1"); assert.equal(created.request.lines[0].unitPrice, 12);
    assert.equal(created.request.lines[1].priceSource, "quote");
    const submitInput = { action: "submit", requestId: next(), purchaseRequestId: created.purchaseRequestId, expectedRevision: created.revision, approverUid: "manager" };
    const submitted = await api().mutateHotelPurchaseRequestHandler(request(submitInput), services);
    assert.equal((await budget()).pendingMinor, 10000); assert.equal((await budget()).committedMinor || 0, 0);
    const before = await evidence(submitted);
    const { resolvePurchaseRequestNotification } = require("../../functions/src/purchaseRequestNotifications");
    const notification = await db.runTransaction((tx) => resolvePurchaseRequestNotification(tx, db, "hotel-a", before.mailQueue[0][1], services));
    assert.deepEqual(notification.to, ["manager@example.test"]);
    assert.match(notification.text, /Amount: 100\.00 EUR excluding VAT/);
    assert.match(notification.text, /Supplier: Fictional Parts/); assert.match(notification.text, /Supplier: Fictional Repairs/);
    assert.deepEqual(await api().mutateHotelPurchaseRequestHandler(request(submitInput), services), submitted);
    assert.deepEqual(await evidence(submitted), before);
    const approved = await transition("approve", submitted, {}, "manager");
    assert.equal(approved.request.status, "approved"); assert.equal((await budget()).pendingMinor, 0); assert.equal((await budget()).committedMinor, 10000);
    assert.deepEqual(approved.request.lines, created.request.lines);
    const mail = await db.collection("hotels/hotel-a/mailQueue").get();
    assert.equal(mail.size, 2); assert.deepEqual(mail.docs.map((snapshot) => snapshot.data().event).sort(), ["approved", "submit"]);
  });

  it("keeps a common header summary only when every row has the same explicit supplier", async () => {
    const same = await create(draft([freeLine("parts", "supplier-a"), freeLine("repair", "supplier-a")]));
    assert.equal(same.request.supplierId, "supplier-a"); assert.deepEqual(same.request.supplier, { id: "supplier-a", name: "Fictional Parts" });
    assert.deepEqual(same.request.suppliers, [{ id: "supplier-a", name: "Fictional Parts" }]);
    const mixed = await create(draft([freeLine("parts", "supplier-a"), freeLine("repair", "supplier-b")], { supplierId: "foreign-only" }));
    assert.equal(mixed.request.supplierId, ""); assert.equal(mixed.request.supplier, null);
    assert.deepEqual(mixed.request.lines.map((line) => line.supplierId), ["supplier-a", "supplier-b"]);
  });

  it("does not inherit a header supplier when a row explicitly clears its supplier and requires completion before submission", async () => {
    const created = await create(draft([freeLine("selected", "supplier-a"), freeLine("unselected", "")], { supplierId: "supplier-a" }));
    assert.equal(created.request.lines[1].supplierId, ""); assert.equal(created.request.lines[1].supplier, null);
    assert.equal(created.request.supplierId, ""); assert.equal(created.request.supplier, null);
    const before = await evidence(created);
    const preview = (await detail(created)).submissionApprovalRoute; assert.ok(preview.error);
    await rejected(transition("submit", created, { approverUid: "manager" }));
    assert.deepEqual(await evidence(created), before);
    const completed = await transition("save", created, { draft: draft([freeLine("selected", "supplier-a"), freeLine("unselected", "supplier-b")]) });
    assert.equal((await transition("submit", completed, { approverUid: "manager" })).request.status, "pending");
  });

  it("rejects unknown, foreign, archived and mismatched suppliers atomically on create, save and revision", async () => {
    await seedProduct("coffee", "supplier-a");
    await db.doc("hotels/hotel-a/suppliers/archived").set({ name: "Archived supplier", active: true, archived: true });
    await db.doc("hotels/hotel-a/suppliers/inactive").set({ name: "Inactive supplier", active: false });
    const created = await create();
    for (const supplierId of ["missing", "foreign-only", "archived", "inactive"]) {
      const before = await evidence(created);
      await rejected(create(draft([freeLine("invalid", supplierId)])));
      await rejected(transition("save", created, { draft: draft([freeLine("invalid", supplierId)]) }));
      assert.deepEqual(await evidence(created), before);
    }
    const before = await evidence(created);
    await rejected(create(draft([productLine("mismatch", "supplier-b", "coffee", { unitPrice: 1 })])));
    await rejected(transition("save", created, { draft: draft([productLine("mismatch", "supplier-b", "coffee", { unitPrice: 1 })]) }));
    assert.deepEqual(await evidence(created), before);
    const submitted = await transition("submit", created, { approverUid: "manager" });
    const approved = await transition("approve", submitted, {}, "manager");
    const financial = await evidence(approved);
    await rejected(transition("revise", approved, { reason: "Review suppliers", draft: draft([productLine("mismatch", "supplier-b", "coffee", { unitPrice: 1 })]) }));
    assert.deepEqual(await evidence(approved), financial);
    await rejected(detail(approved, "foreign"), "permission-denied");
  });

  it("resolves each supplier's approved price version and purchase package independently", async () => {
    await seedProduct("coffee", "supplier-a");
    await seedProduct("soap", "supplier-b", { baseUnit: "l", purchaseUnit: "carton", baseUnitsPerPurchaseUnit: 12, purchaseOptions: [{ id: "single", purchaseUnit: "bottle", baseUnitsPerPurchaseUnit: 1, pricePerPurchaseUnit: 3.5 }], priceBasis: "net", vatRate: null });
    const created = await create(draft([productLine("coffee", "supplier-a", "coffee", { quantity: 2 }), productLine("soap", "supplier-b", "soap", { purchaseOptionId: "single", quantity: 3 })]));
    assert.equal(created.request.totalMinor, 3450);
    assert.deepEqual(created.request.lines.map((line) => [line.supplierId, line.unitPrice, line.unit, line.baseUnit, line.baseUnitsPerPurchaseUnit, line.priceVersionId]), [
      ["supplier-a", 12, "case", "kg", 6, "v1"], ["supplier-b", 3.5, "bottle", "l", 1, "v1"],
    ]);
    assert.equal(created.request.lines[0].supplierProductName, "coffee product"); assert.equal(created.request.lines[1].supplierProductName, "soap product");
  });

  it("requires an explicit net quotation for the specific delivery-date or foreign-currency supplier only", async () => {
    await seedProduct("coffee", "supplier-a"); await seedProduct("soap", "supplier-b");
    await db.doc("hotels/hotel-a/suppliers/supplier-b").update({ priceDateBasis: "delivery-date" });
    const lines = [productLine("coffee", "supplier-a", "coffee"), productLine("soap", "supplier-b", "soap")];
    await rejected(create(draft(lines)));
    const quoted = await create(draft([lines[0], { ...lines[1], unitPrice: 5.25 }]));
    assert.equal(quoted.request.lines[0].priceSource, "supplier"); assert.equal(quoted.request.lines[0].unitPrice, 12);
    assert.equal(quoted.request.lines[1].priceSource, "quote"); assert.equal(quoted.request.lines[1].unitPrice, 5.25);
    await db.doc("hotels/hotel-a/suppliers/supplier-b").update({ priceDateBasis: "order-date" });
    await seedProduct("soap", "supplier-b", { currency: "GBP" });
    await rejected(create(draft(lines)));
    assert.equal((await create(draft([lines[0], { ...lines[1], unitPrice: 5.25 }]))).request.currency, "EUR");
  });

  it("submits and approves frozen per-line supplier names, products, packages and prices after source records change", async () => {
    await seedProduct("coffee", "supplier-a");
    const created = await create(draft([productLine("coffee", "supplier-a", "coffee"), freeLine("repair", "supplier-b")]));
    const frozen = structuredClone(created.request.lines), suppliers = structuredClone(created.request.suppliers);
    await db.doc("hotels/hotel-a/suppliers/supplier-a").update({ name: "Changed later", archived: true });
    await db.doc("hotels/hotel-a/suppliers/supplier-b").delete();
    await db.doc("hotels/hotel-a/supplierproducts/coffee").update({ supplierProductName: "Changed product", pricePerPurchaseUnit: 10000, purchaseUnit: "changed case", active: false });
    await db.doc("hotels/hotel-a/supplierPriceVersions/coffee/entries/v1").delete();
    const submitted = await transition("submit", created, { approverUid: "manager" });
    const approved = await transition("approve", submitted, {}, "manager");
    assert.deepEqual(approved.request.lines, frozen); assert.deepEqual(approved.request.suppliers, suppliers);
    assert.equal(approved.request.totalMinor, 6200); assert.equal((await budget()).committedMinor, 6200);
    const history = (await detail(approved)).history;
    for (const event of history) assert.deepEqual(event.snapshot.lines, frozen);
  });

  it("keeps one combined reservation through a returned mixed request and a new approval revision", async () => {
    const created = await create(), submitted = await transition("submit", created, { approverUid: "manager" });
    const originalHistory = (await detail(submitted)).history;
    const returned = await transition("return", submitted, { reason: "Adjust the repair estimate" }, "manager");
    const saved = await transition("save", returned, { draft: draft([freeLine("repair", "supplier-a", 80), freeLine("delivery", "supplier-b", 70)]) });
    assert.equal((await budget()).pendingMinor, 10000);
    const pending = await transition("submit", saved, { approverUid: "manager" });
    assert.equal((await budget()).pendingMinor, 15000);
    const approved = await transition("approve", pending, {}, "manager");
    assert.equal((await budget()).committedMinor, 15000); assert.equal((await budget()).pendingMinor, 0);
    const revised = await transition("revise", approved, { reason: "An additional repair is required", draft: draft([freeLine("repair", "supplier-a", 90), freeLine("delivery", "supplier-b", 70)]) });
    assert.equal((await budget()).pendingMinor, 15000); assert.equal((await budget()).committedMinor, 0);
    const resubmitted = await transition("submit", revised, { approverUid: "manager" });
    assert.equal((await budget()).pendingMinor, 16000);
    await transition("approve", resubmitted, {}, "manager");
    assert.equal((await budget()).committedMinor, 16000); assert.equal((await budget()).pendingMinor, 0);
    const history = (await detail(resubmitted)).history;
    for (const event of originalHistory) assert.deepEqual(history.find((current) => current.revision === event.revision), event);
  });

  it("retains legacy header-only commands, receipts and frozen history without inventing per-line supplier fields on reads", async () => {
    const oldLine = { id: "repair", kind: "free", description: "Repair service", quantity: 1, unitPrice: 50, unit: "service" };
    const oldDraft = draft([oldLine], { supplierId: "supplier-a" }), requestId = next();
    const input = { action: "create", requestId, expectedRevision: 0, draft: oldDraft };
    const created = await api().mutateHotelPurchaseRequestHandler(request(input), services);
    const { canonicalDigest } = api().purchaseRequestInternals;
    const receiptRef = db.doc(`hotels/hotel-a/purchaseRequestOperations/p-${digest("requester", requestId).slice(0, 48)}`);
    const receipt = (await receiptRef.get()).data();
    const legacyFingerprint = canonicalDigest({ kind: "request", payload: { id: created.purchaseRequestId, action: "create", expected: 0, draft: oldDraft, approverUid: null, nextApproverUid: null, reason: "" } });
    assert.equal(receipt.fingerprint, legacyFingerprint, "The absent line key must preserve the original command fingerprint.");
    const oldRequest = structuredClone(created.request); delete oldRequest.suppliers;
    for (const line of oldRequest.lines) { delete line.supplierId; delete line.supplier; }
    const oldResult = { ...created, request: oldRequest }, snapshotFingerprint = canonicalDigest(oldRequest);
    await db.doc(`hotels/hotel-a/purchaseRequests/${created.purchaseRequestId}`).set({ ...oldRequest, snapshotFingerprint });
    await db.doc(`hotels/hotel-a/purchaseRequests/${created.purchaseRequestId}/history/000001`).update({ snapshot: oldRequest, snapshotFingerprint });
    await receiptRef.update({ fingerprint: legacyFingerprint, result: oldResult, resultFingerprint: canonicalDigest(oldResult) });
    const read = await detail(created); assert.deepEqual(read.request, oldRequest); assert.deepEqual(read.history[0].snapshot, oldRequest);
    assert.deepEqual(await api().mutateHotelPurchaseRequestHandler(request(input), services), oldResult);
    const submitted = await transition("submit", created, { approverUid: "manager" });
    assert.equal(submitted.request.supplier.name, "Fictional Parts"); assert.equal(Object.hasOwn(submitted.request.lines[0], "supplierId"), false);
    await transition("approve", submitted, {}, "manager");
    assert.deepEqual((await detail(submitted)).history.find((event) => event.revision === 1).snapshot, oldRequest);
    const before = await evidence(submitted);
    assert.deepEqual(await api().mutateHotelPurchaseRequestHandler(request(input), services), oldResult);
    assert.deepEqual(await evidence(submitted), before);
  });
});
