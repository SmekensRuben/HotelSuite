import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { initializeTestEnvironment, assertFails } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc } from "firebase/firestore";
import { ref, getBytes, uploadBytes } from "firebase/storage";

const projectId = "demo-hotel-suite-a00";
for (const key of ["FIRESTORE_EMULATOR_HOST", "FIREBASE_AUTH_EMULATOR_HOST", "FIREBASE_STORAGE_EMULATOR_HOST"]) {
  if (!/^(127\.0\.0\.1|localhost):\d+$/.test(process.env[key] || "")) throw new Error("Only local emulators are allowed.");
}
process.env.FIREBASE_CONFIG = JSON.stringify({ projectId, storageBucket: `${projectId}.appspot.com` });
const require = createRequire(import.meta.url);
const { admin } = require("../../functions/src/config");
const { compileMemberAccess } = require("../../functions/src/modulePolicy");
const { SAAS_RULES_VERSION } = require("../../functions/src/saasRollout");
const { DEFAULT_AI_CONFIGURATION } = require("../../functions/src/supplierAiPolicy");
const { uploadSupplierAiImport, readSupplierAiImport, runSupplierAiImportJob, savePrivate } = require("../../functions/src/supplierAiImports");
const { readHotelSupplierAiImportRowsHandler: review, correctHotelSupplierAiImportRowHandler: correct,
  commitHotelSupplierAiImportRowsHandler: commit } = require("../../functions/src/supplierAiProposal");
const { getPlatformSupplierAiImportSettingsHandler: settings, listPlatformSupplierAiUsageHandler: usage } = require("../../functions/src/supplierAiPlatform");
const { mutateHotelSupplierProductHandler } = require("../../functions/src/products");
const { requireHotelImportTarget } = require("../../functions/src/fileImportTypes");
const { digest } = require("../../functions/src/validation");
const db = admin.firestore(), auth = admin.auth(), bucket = admin.storage().bucket();
const baseServices = { firestore: db, auth, bucket };
const subscription = { modules: ["procurement"], modulePolicyVersion: 1, status: "active", validUntil: null };
const access = compileMemberAccess({ hotelAdmin: false, moduleRoles: { procurement: ["module-manager"] } }, subscription);
const identities = Object.fromEntries(["manager", "other-manager", "hotel-b", "operator"].map((uid) => [uid, { uid,
  token: { email_verified: true, auth_time: Math.floor(Date.now() / 1000), ...(uid === "operator" ? { platformAdmin: true } : {}) } }]));
const request = (data, actor = "manager") => ({ auth: identities[actor], data });
// The source declares the full purchase-package price, rather than leaving a
// bare "price" column ambiguous between package and inventory-unit pricing.
const bytes = Buffer.from("sku,name,Net Purchase Price,currency,package\nMILK6,Milk six pack,15,EUR,6 l net\n");
const uploadData = (patch = {}) => ({ hotelUid: "hotel-a", supplierId: "dairy", requestId: "import-one", fileName: "offers.csv", mimeType: "text/csv", importSettings: JSON.stringify({ policyVersion: 2, priceBasis: "net", currency: "EUR", vatRate: null }), ...patch });
let environment, calls;
const provider = { countInput: async () => 500, respond: async (body) => {
  calls++;
  const source = JSON.parse(body.input[0].content[0].text).units.find((unit) => unit.text.includes("MILK6"));
  assert.ok(source, "All source rows must reach the request.");
  const row = { supplierSku: "MILK6", supplierProductName: "Milk six pack", currency: "EUR", pricingModel: "Per Purchase Unit",
    purchaseUnit: "Case", baseUnit: "l", priceBasis: "net", gtin: null, priceValidFrom: null, priceValidUntil: null,
    pricePerBaseUnit: null, pricePerPurchaseUnit: 15, baseUnitsPerPurchaseUnit: 6, vatRate: null,
    sourceAnchors: [{ sourceId: source.sourceId, quote: "MILK6" }] };
  return { id: "fictional-response", model: "gpt-6-luna", status: "completed", usage: { input_tokens: 500, output_tokens: 100, total_tokens: 600 },
    output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ rows: [row] }) }] }] };
} };
const services = { ...baseServices, provider };
async function uploaded() { return uploadSupplierAiImport(request(), uploadData(), bytes, services); }
async function ready() { const job = await uploaded(); const result = await runSupplierAiImportJob("hotel-a", job.jobId, services); assert.equal(result.status, "review", JSON.stringify(result)); return job; }
const rejectPermission = (promise) => assert.rejects(promise, { code: "permission-denied" });
function assertCustomerPrivacy(value) {
  assert.doesNotMatch(JSON.stringify(value), /"(?:usage|configuration|model|fallbackModel|fallbackEnabled|inputTokens|outputTokens|reasoningTokens|priceVersion|actualCostUsd|knownCostUsd|reservedCostUsd|knownCostMicros|reservedCostMicros|limitUsd|maxCostPerImportUsd|maxMonthlyCostPerHotelUsd)"/);
  if (value.error) assert.doesNotMatch(value.error.message, /cost|budget|reserv|paid|bill|usage|accounting|token|model|reasoning|provider|secret|configuration|fallback|USD|\$|gpt|openai/i);
}
before(async () => { environment = await initializeTestEnvironment({ projectId,
  firestore: { host: "127.0.0.1", port: Number(process.env.FIRESTORE_EMULATOR_HOST.split(":").at(-1)), rules: await readFile("firebase/firestore.rules", "utf8") },
  storage: { host: "127.0.0.1", port: Number(process.env.FIREBASE_STORAGE_EMULATOR_HOST.split(":").at(-1)), rules: await readFile("firebase/storage.rules", "utf8") } }); });
beforeEach(async () => {
  calls = 0; await environment.clearFirestore(); await environment.clearStorage(); await bucket.deleteFiles({ prefix: "private/supplier-ai-imports/" });
  const users = await auth.listUsers(); if (users.users.length) await auth.deleteUsers(users.users.map((user) => user.uid));
  for (const identity of Object.values(identities)) {
    await auth.createUser({ uid: identity.uid, email: `${identity.uid}@example.test`, password: "Emulator-only-123!", emailVerified: true });
    if (identity.uid === "operator") await auth.setCustomUserClaims(identity.uid, { platformAdmin: true });
    identity.token.auth_time = Math.floor(Date.now() / 1000);
  }
  await db.doc("platformConfiguration/saasProcurement").set({ enabled: true, rulesVersion: SAAS_RULES_VERSION });
  await db.doc("platformConfiguration/aiSupplierProductImport").set({ ...DEFAULT_AI_CONFIGURATION, enabled: true });
  for (const hotel of ["hotel-a", "hotel-b"]) {
    await db.doc(`hotels/${hotel}`).set({ name: hotel, currency: "EUR" }); await db.doc(`hotelSubscriptions/${hotel}`).set(subscription);
    await db.doc(`hotels/${hotel}/suppliers/dairy`).set({ name: "Fictional dairy" });
    await db.doc(`hotels/${hotel}/catalogproducts/milk`).set({ name: "Milk", baseUnit: "l", active: true, inventoryTracked: true, productPolicyVersion: 1, revision: 1 });
  }
  for (const actor of ["manager", "other-manager"]) await db.doc(`hotels/hotel-a/members/${actor}`).set(access);
  await db.doc("hotels/hotel-b/members/hotel-b").set(access);
  await mutateHotelSupplierProductHandler(request({ hotelUid: "hotel-a", productId: "milk", action: "create", requestId: "seed", expectedRevision: 0,
    product: { supplierId: "dairy", supplierSku: "MILK6", supplierProductName: "Milk six pack", currency: "EUR", pricingModel: "Per Purchase Unit",
      pricePerBaseUnit: null, pricePerPurchaseUnit: 12, baseUnit: "l", purchaseUnit: "Case", baseUnitsPerPurchaseUnit: 6,
      catalogProductId: "milk", active: true, priceBasis: "net", vatRate: null, purchaseOptions: [] } }), services);
});
after(async () => environment.cleanup());
describe("supplier AI import with ordinary hotel accounts and real Firebase boundaries", () => {
  it("creates a private reviewed draft, then commits once while preserving recorded financial evidence", async () => {
    const snapshot = { currency: "EUR", quantity: 6, unitCost: 2, total: 12, revision: 4 };
    await db.doc("hotels/hotel-a/orders/finalized").set(snapshot);
    const job = await ready(); assert.equal(calls, 1);
    const customerStatus = await readSupplierAiImport(request(), { hotelUid: "hotel-a", jobId: job.jobId }, services);
    assertCustomerPrivacy(job); assertCustomerPrivacy(customerStatus);
    assert.deepEqual(customerStatus.importSettings, { policyVersion: 2, priceBasis: "net", currency: "EUR", vatRate: null });
    assert.equal(customerStatus.summary.version, 2); assert.equal(customerStatus.summary.totalRows, 1);
    assert.deepEqual(customerStatus.progress, { completedChunks: 1, totalChunks: 1 });
    const month = new Date().toISOString().slice(0, 7), operatorReport = await usage(request({ month }, "operator"), services);
    const recordedUsage = operatorReport.hotels.find((row) => row.id === "hotel-a").usage;
    assert.ok(recordedUsage.knownCostUsd > 0); assert.equal(recordedUsage.actualCostUsd, recordedUsage.knownCostUsd);
    assert.equal((await db.doc("hotels/hotel-a/supplierproducts/milk").get()).data().pricePerPurchaseUnit, 12);
    const page = await review(request({ hotelUid: "hotel-a", jobId: job.jobId, limit: 25 }), services);
    assert.equal(page.rows.length, 1); assert.equal(page.rows[0].category, "changed");
    const data = { hotelUid: "hotel-a", jobId: job.jobId, requestId: "confirm-one", rows: [{ rowId: page.rows[0].rowId, reviewRevision: page.rows[0].reviewRevision, acknowledged: true }] };
    const result = await commit(request(data), services); assert.equal(result.outcomes[0].status, "updated");
    assert.deepEqual(await commit(request(data), services), result);
    assert.equal((await db.doc("hotels/hotel-a/supplierproducts/milk").get()).data().pricePerPurchaseUnit, 15);
    assert.deepEqual((await db.doc("hotels/hotel-a/orders/finalized").get()).data(), snapshot);
    assert.equal((await db.collection("hotels/hotel-a/supplierPriceHistory/milk/entries").get()).size, 2);
    await runSupplierAiImportJob("hotel-a", job.jobId, services); assert.equal(calls, 1);
  });
  it("denies another same-hotel importer, another hotel and an operator access to a private job", async () => {
    const job = await ready();
    for (const actor of ["other-manager", "hotel-b", "operator"]) {
      const data = { hotelUid: "hotel-a", jobId: job.jobId };
      await rejectPermission(readSupplierAiImport(request(null, actor), data, services));
      await rejectPermission(review(request(data, actor), services));
      await rejectPermission(correct(request({ ...data, rowId: "r-000000", expectedReviewRevision: 1, patch: {} }, actor), services));
      await rejectPermission(commit(request({ ...data, requestId: "forged", rows: [{ rowId: "r-000000", reviewRevision: 1, acknowledged: true }] }, actor), services));
    }
    await rejectPermission(uploadSupplierAiImport(request(), uploadData({ hotelUid: "hotel-b" }), bytes, services));
  });
  it("keeps browser clients and generic imports away from AI control, private sources and billing", async () => {
    const job = await uploaded(), stored = (await db.doc(`hotels/hotel-a/supplierAiImportJobs/${job.jobId}`).get()).data();
    for (const actor of ["manager", "operator"]) {
      const context = environment.authenticatedContext(actor, identities[actor].token);
      for (const path of ["platformConfiguration/aiSupplierProductImport", "platformAiConfigurationOperations/forged", `hotels/hotel-a/supplierAiImportJobs/${job.jobId}`,
        "hotels/hotel-a/supplierAiImportRequests/import-one", "hotels/hotel-a/supplierAiImportWork/forged", "hotels/hotel-a/aiUsageMonths/2026-10", "hotels/hotel-a/aiImportAdministration/state"]) {
        await assertFails(getDoc(doc(context.firestore(), path))); await assertFails(setDoc(doc(context.firestore(), path), { enabled: true }));
      }
      const storage = context.storage(`gs://${bucket.name}`);
      await assertFails(getBytes(ref(storage, stored.source.path))); await assertFails(uploadBytes(ref(storage, stored.source.path), bytes));
    }
    for (const collection of ["supplierAiImportJobs", "supplierAiImportRequests", "supplierAiImportWork", "aiUsageMonths", "aiImportAdministration"]) assert.throws(() => requireHotelImportTarget(`hotels/hotel-a/${collection}/forged`, "hotel-a"), /protected AI/);
  });
  it("holds unresolved charged-request cost and never automatically rebills a duplicate worker", async () => {
    const job = await uploaded(); let paid = 0;
    const failed = { ...services, provider: { countInput: async () => 500, respond: async () => { paid++; throw new Error("lost-response"); } } };
    await runSupplierAiImportJob("hotel-a", job.jobId, failed); await runSupplierAiImportJob("hotel-a", job.jobId, failed);
    assert.equal(paid, 1);
    const status = await readSupplierAiImport(request(), { hotelUid: "hotel-a", jobId: job.jobId }, services);
    assert.equal(status.status, "response_unknown"); assertCustomerPrivacy(status);
    const stored = (await db.doc(`hotels/hotel-a/supplierAiImportJobs/${job.jobId}`).get()).data();
    assert.ok(stored.reservedCostMicros > 0); assert.equal(stored.unknownCalls, 1);
    const attempt = (await db.doc(`hotels/hotel-a/supplierAiImportJobs/${job.jobId}/attempts/chunk-0000`).get()).data();
    assert.equal(attempt.costMicros, null); assert.equal(attempt.inputTokens, null); assert.equal(attempt.outputTokens, null);
    const month = new Date().toISOString().slice(0, 7), report = await usage(request({ month }, "operator"), services);
    assert.equal(report.hotels.find((row) => row.id === "hotel-a").usage.actualCostUsd, null);
    assert.ok(report.hotels.find((row) => row.id === "hotel-a").usage.reservedCostUsd > 0);
    await rejectPermission(usage(request({ month }), services));
    assert.equal((await db.doc("hotels/hotel-a/supplierproducts/milk").get()).data().pricePerPurchaseUnit, 12);
  });
  it("exposes only file limits in customer availability and keeps operator pricing configuration restricted", async () => {
    const availability = await readSupplierAiImport(request(), { hotelUid: "hotel-a" }, services);
    assert.deepEqual(availability, { available: true, importPolicyVersion: 2, reason: null, limits: { maxFileBytes: 10485760, maxPages: 50, maxProducts: 1000 }, defaults: { currency: "EUR" } });
    assertCustomerPrivacy(availability);
    await rejectPermission(settings(request(), services));
    const operator = await settings(request(null, "operator"), services);
    assert.equal(operator.configuration.model, "gpt-6-luna"); assert.equal(operator.configuration.maxCostPerImportUsd, 0.25);
  });
  it("requires typed business settings before creating any source, quota reservation or private job", async () => {
    for (const importSettings of [undefined, "broken", "null", "[]", JSON.stringify({ policyVersion: 2, priceBasis: "net", currency: "EUR" }),
      JSON.stringify({ policyVersion: 2, priceBasis: "net", currency: "EUR", vatRate: "0.21" }),
      JSON.stringify({ policyVersion: 2, priceBasis: "net", currency: "ZZZ", vatRate: null }),
      JSON.stringify({ policyVersion: 2, priceBasis: "net", currency: "EUR", vatRate: null, model: "forged" })]) {
      await assert.rejects(uploadSupplierAiImport(request(), uploadData({ importSettings }), bytes, services), { code: "invalid-argument" });
    }
    assert.equal((await db.collection("hotels/hotel-a/supplierAiImportJobs").get()).size, 0);
    assert.equal((await db.collection("hotels/hotel-a/supplierAiImportRequests").get()).size, 0);
    assert.equal((await db.collection("hotels/hotel-a/aiUsageMonths").get()).size, 0);
    assert.equal((await bucket.getFiles({ prefix: "private/supplier-ai-imports/hotel-a/" }))[0].length, 0); assert.equal(calls, 0);
  });
  it("pins user-chosen settings to the original import and rejects changed replay without another provider request", async () => {
    const job = await ready(), stored = (await db.doc(`hotels/hotel-a/supplierAiImportJobs/${job.jobId}`).get()).data();
    assert.equal(stored.importPolicyVersion, 2); assert.deepEqual(stored.importSettings, { policyVersion: 2, priceBasis: "net", currency: "EUR", vatRate: null });
    for (const patch of [{ currency: "USD" }, { priceBasis: "gross" }, { vatRate: 0.21 }]) {
      const importSettings = JSON.stringify({ ...stored.importSettings, ...patch });
      await assert.rejects(uploadSupplierAiImport(request(), uploadData({ importSettings }), bytes, services), { code: "already-exists" });
    }
    const replay = await uploaded(); assert.equal(replay.jobId, job.jobId); assert.deepEqual(replay.importSettings, stored.importSettings); assertCustomerPrivacy(replay);
    assert.equal(calls, 1); assert.equal((await db.collection("hotels/hotel-a/supplierAiImportJobs").get()).size, 1);
    const month = new Date().toISOString().slice(0, 7), ledger = (await db.doc(`hotels/hotel-a/aiUsageMonths/${month}`).get()).data();
    assert.equal(ledger.importsStarted, 1); assert.equal(ledger.attemptedCalls, 1);
  });
  it("suggests only the selected hotel's consistent known currency and keeps missing values unknown", async () => {
    await db.doc("hotels/hotel-b").update({ currency: "GBP" });
    assert.equal((await readSupplierAiImport(request(), { hotelUid: "hotel-a" }, services)).defaults.currency, "EUR");
    assert.equal((await readSupplierAiImport(request(null, "hotel-b"), { hotelUid: "hotel-b" }, services)).defaults.currency, "GBP");
    await rejectPermission(readSupplierAiImport(request(), { hotelUid: "hotel-b" }, services));
    await db.doc("hotels/hotel-a/settings/bootstrap").set({ currency: "USD" });
    assert.equal((await readSupplierAiImport(request(), { hotelUid: "hotel-a" }, services)).defaults.currency, null);
    await db.doc("hotels/hotel-a/settings/bootstrap").delete(); await db.doc("hotels/hotel-a").set({ name: "hotel-a" });
    assert.equal((await readSupplierAiImport(request(), { hotelUid: "hotel-a" }, services)).defaults.currency, null);
    const job = await uploaded(); assert.deepEqual(job.importSettings, { policyVersion: 2, priceBasis: "net", currency: "EUR", vatRate: null }, "Only the user's explicit import currency makes the missing hotel currency usable");
  });
  it("returns legacy draft settings and summary as unavailable without recalculating retained results", async () => {
    const job = await ready(), jobRef = db.doc(`hotels/hotel-a/supplierAiImportJobs/${job.jobId}`), existing = (await jobRef.get()).data();
    const { importSettings: _settings, importPolicyVersion: _version, ...legacy } = existing;
    await jobRef.set(legacy);
    const rows = await db.collection(`${jobRef.path}/rows`).get(), originalRows = rows.docs.map((row) => row.data());
    const status = await readSupplierAiImport(request(), { hotelUid: "hotel-a", jobId: job.jobId }, services);
    assert.equal(status.importSettings, null); assert.equal(status.summary, null); assertCustomerPrivacy(status);
    await runSupplierAiImportJob("hotel-a", job.jobId, services); assert.equal(calls, 1);
    assert.deepEqual((await db.collection(`${jobRef.path}/rows`).get()).docs.map((row) => row.data()), originalRows);
    assert.equal((await jobRef.get()).data().fingerprint, existing.fingerprint);
  });
  it("recovers a legacy lost upload acknowledgement only for the original source, owner and request", async () => {
    const created = await uploaded(), currentRef = db.doc(`hotels/hotel-a/supplierAiImportJobs/${created.jobId}`), current = (await currentRef.get()).data();
    const fingerprint = digest(current.supplierId, current.fileName, current.mimeType, current.sha256);
    const jobId = digest(current.hotelUid, current.requestId, current.ownerUid, fingerprint), path = `private/supplier-ai-imports/hotel-a/${jobId}/source`;
    const source = await savePrivate(bucket, path, bytes, "application/octet-stream");
    const { importSettings: _settings, importPolicyVersion: _version, ...base } = current;
    const legacy = { ...base, jobId, fingerprint, source };
    await db.doc(`hotels/hotel-a/supplierAiImportJobs/${jobId}`).set(legacy); await currentRef.delete();
    const receiptRef = db.doc("hotels/hotel-a/supplierAiImportRequests/import-one"), { importSettings: _receiptSettings, importPolicyVersion: _receiptVersion, ...receipt } = (await receiptRef.get()).data();
    await receiptRef.set({ ...receipt, jobId, fingerprint });
    const result = await uploadSupplierAiImport(request(), uploadData({ importSettings: undefined }), bytes, services);
    assert.equal(result.jobId, jobId); assert.equal(result.status, "queued"); assert.equal(result.importSettings, null); assert.equal(result.summary, null); assertCustomerPrivacy(result);
    await assert.rejects(uploadSupplierAiImport(request(), uploadData({ importSettings: undefined, requestId: "new-legacy" }), bytes, services), { code: "invalid-argument" });
    await assert.rejects(uploadSupplierAiImport(request(), uploadData({ importSettings: undefined }), Buffer.from("different source"), services), { code: "already-exists" });
    await assert.rejects(uploadSupplierAiImport(request(null, "other-manager"), uploadData({ importSettings: undefined }), bytes, services), { code: "already-exists" });
    const ready = await runSupplierAiImportJob("hotel-a", jobId, services);
    assert.equal(ready.status, "review"); assert.equal(ready.importSettings, null); assert.equal(ready.summary, null); assert.equal(calls, 1);
    const row = (await review(request({ hotelUid: "hotel-a", jobId }), services)).rows[0];
    assert.equal(row.normalizationVersion, null); assert.equal(row.originalInput, null); assert.equal(row.normalizationFindings, null);
    const rawRow = (await db.doc(`hotels/hotel-a/supplierAiImportJobs/${jobId}/rows/${row.rowId}`).get()).data();
    for (const field of ["normalizationVersion", "originalInput", "normalizationFindings"]) assert.equal(Object.hasOwn(rawRow, field), false, "Legacy stored rows must not acquire policy 2 normalization metadata");
  });
  it("rechecks account revocation and permits a valid human commit after billable AI is disabled", async () => {
    const job = await ready(), page = await review(request({ hotelUid: "hotel-a", jobId: job.jobId }), services);
    await db.doc("platformConfiguration/aiSupplierProductImport").update({ enabled: false });
    const data = { hotelUid: "hotel-a", jobId: job.jobId, requestId: "disabled-confirm", rows: [{ rowId: page.rows[0].rowId, reviewRevision: page.rows[0].reviewRevision, acknowledged: true }] };
    await auth.updateUser("manager", { disabled: true }); await rejectPermission(commit(request(data), services));
    await auth.updateUser("manager", { disabled: false }); assert.equal((await commit(request(data), services)).outcomes[0].status, "updated");
    await rejectPermission(settings(request(), services));
    assert.equal((await settings(request(null, "operator"), services)).configuration.enabled, false);
  });
});
