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
const { readHotelSupplierAiImportWorkspaceHandler: workspace, decideHotelSupplierAiImportRowsHandler: decide,
  completeHotelSupplierAiImportReviewHandler: completeReview, applyHotelSupplierAiImportMappingHandler: applyMapping,
  applyHotelSupplierImportFormatHandler: applyFormat } = require("../../functions/src/supplierAiReview");
const { readHotelSupplierPurchaseUnitMappingsHandler: readMappings, saveHotelSupplierPurchaseUnitMappingHandler: saveMappings,
  mappingProfileRef, mappingScope } = require("../../functions/src/supplierImportMappings");
const { getPlatformSupplierAiImportSettingsHandler: settings, listPlatformSupplierAiUsageHandler: usage } = require("../../functions/src/supplierAiPlatform");
const { mutateHotelSupplierProductHandler } = require("../../functions/src/products");
const { mutateShoppingCartHandler } = require("../../functions/src/shoppingCarts");
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
const bytes = Buffer.from("sku,name,Net Purchase Price,currency,Purchase Unit,Package Content\nMILK6,Milk six pack,15,EUR,Case,6\n");
const uploadData = (patch = {}) => ({ hotelUid: "hotel-a", supplierId: "dairy", requestId: "import-one", fileName: "offers.csv", mimeType: "text/csv", reviewWorkspaceVersion: "1", recurringImportVersion: "1", importSettings: JSON.stringify({ policyVersion: 2, priceBasis: "net", currency: "EUR", vatRate: null }), ...patch });
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
async function uploaded(patch = {}) { return uploadSupplierAiImport(request(), uploadData(patch), bytes, services); }
async function confirmFormat(jobId, overrides = {}) {
  const view = await workspace(request({ hotelUid: "hotel-a", jobId }), services);
  const { sourceFormat, formatFingerprint: _fingerprint, ...candidate } = view.sourceFormatCandidate;
  const scope = mappingData({ sourceFormat }), previous = await readMappings(request(scope), services);
  const saved = await saveMappings(request({ ...scope, requestId: `confirm-format-${jobId}`, expectedRevision: previous.revision, mappings: [],
    interpretation: { ...candidate, defaults: { baseUnit: "l", currency: "EUR", priceBasis: "net" }, ...overrides } }), services);
  const result = await applyFormat(request({ hotelUid: "hotel-a", jobId, requestId: `apply-format-${jobId}`, expectedMappingRevision: saved.revision }), services);
  assert.equal(result.completed, true); return saved;
}
async function ready() { const job = await uploaded(); const result = await runSupplierAiImportJob("hotel-a", job.jobId, services); assert.equal(result.status, "review", JSON.stringify(result)); await confirmFormat(job.jobId); return job; }
const decisionData = (jobId, row, action = "approve", requestId = `decision-${action}`) => ({ hotelUid: "hotel-a", jobId, requestId,
  rows: [{ rowId: row.rowId, reviewRevision: row.reviewRevision, action, acknowledged: true }], bulk: false });
async function approve(jobId, row, requestId) { return decide(request(decisionData(jobId, row, "approve", requestId)), services); }
const mappingData = (patch = {}) => ({ hotelUid: "hotel-a", supplierId: "dairy", sourceFormat: "csv", profileId: "default", ...patch });
const mappingCommand = (patch = {}) => mappingData({ requestId: "mapping-one", expectedRevision: 0,
  mappings: [{ sourceUnit: "FL", purchaseUnit: "Bottle" }, { sourceUnit: "TR", purchaseUnit: "Tray" }], ...patch });
const confirmedInterpretation = (patch = {}) => ({ version: 1,
  header: ["sku", "name", "Net Purchase Price", "currency", "Purchase Unit", "Package Content"], sheetName: null,
  columns: { supplierSku: 0, supplierProductName: 1, pricePerPurchaseUnit: 2, currency: 3, purchaseUnit: 4, baseUnitsPerPurchaseUnit: 5 },
  defaults: { baseUnit: "l", priceBasis: "net", pricingModel: "Per Purchase Unit" },
  assortmentMode: "partial", documentPurpose: "price-list", decimalSeparator: ".", dateFormat: "YYYY-MM-DD", ...patch });
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
  it("imports and approves kg offers for an ordinary hotel user, accepts fractional purchases and rejects false mass contracts", async () => {
    const sourceBytes = Buffer.from("SKU,Name,Eenheid verpakking,Inhoud verpakking,Inhoud,Eenheid,Net price per kg,Currency\nWEIGH1,Fictional weighed item,KG,1,1,ST,8,EUR\n");
    const kgServices = { ...services, provider: { countInput: provider.countInput, respond: async (body) => {
      calls++;
      const source = JSON.parse(body.input[0].content[0].text).units.find((unit) => unit.text.includes("WEIGH1"));
      assert.ok(source, "The actual weighed product source must reach the provider request.");
      const row = { supplierSku: "WEIGH1", supplierProductName: "Fictional weighed item", purchaseUnit: "KG", baseUnit: "each", baseUnitsPerPurchaseUnit: 1,
        currency: "EUR", pricingModel: "Per Purchase Unit", priceBasis: "net", vatRate: null, gtin: null, priceValidFrom: null, priceValidUntil: null,
        pricePerPurchaseUnit: 8, pricePerBaseUnit: null, sourceAnchors: [{ sourceId: source.sourceId, quote: "WEIGH1" }] };
      return { id: "fictional-weight-response", model: "gpt-6-luna", status: "completed", usage: { input_tokens: 500, output_tokens: 100, total_tokens: 600 },
        output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ rows: [row] }) }] }] };
    } } };
    const job = await uploadSupplierAiImport(request(), uploadData({ requestId: "import-kg" }), sourceBytes, kgServices);
    assert.equal((await runSupplierAiImportJob("hotel-a", job.jobId, kgServices)).status, "review");
    await confirmFormat(job.jobId);
    const page = await review(request({ hotelUid: "hotel-a", jobId: job.jobId }), kgServices), original = page.rows[0];
    assert.equal(original.category, "new", JSON.stringify(original.issues)); assert.equal(original.product.purchaseUnit, "kg");
    assert.equal(original.product.baseUnit, "kg"); assert.equal(original.product.baseUnitsPerPurchaseUnit, 1);
    assert.equal(original.product.pricePerBaseUnit, 8); assert.equal(original.packInference, null);
    await db.doc("hotels/hotel-a/catalogproducts/weighed").set({ name: "Fictional weighed goods", baseUnit: "g", inventoryTracked: true, active: true, productPolicyVersion: 1, revision: 1 });
    const corrected = await correct(request({ hotelUid: "hotel-a", jobId: job.jobId, rowId: original.rowId, expectedReviewRevision: original.reviewRevision, patch: { active: true, catalogProductId: "weighed" } }), kgServices);
    await approve(job.jobId, corrected.row, "approve-kg");
    const result = await commit(request({ hotelUid: "hotel-a", jobId: job.jobId, requestId: "commit-kg", rows: [{ rowId: corrected.row.rowId, reviewRevision: corrected.row.reviewRevision, acknowledged: true }] }), kgServices);
    assert.equal(result.outcomes[0].status, "created"); const productId = result.outcomes[0].productId;
    const productRef = db.doc(`hotels/hotel-a/supplierproducts/${productId}`), before = await productRef.get();
    const stored = before.data();
    // Construct only the public mutation contract; server-owned metadata cannot
    // be supplied by the hotel user or used to bypass the kilogram validation.
    const fields = ["supplierId", "supplierSku", "supplierProductName", "currency", "pricingModel", "pricePerBaseUnit", "pricePerPurchaseUnit", "purchaseUnit", "baseUnit", "baseUnitsPerPurchaseUnit", "catalogProductId", "active", "priceBasis", "vatRate", "purchaseOptions", "priceValidFrom", "priceValidUntil", "gtin"];
    const invalid = Object.fromEntries(fields.filter((field) => Object.hasOwn(stored, field)).map((field) => [field, stored[field]])); invalid.baseUnit = "g"; invalid.baseUnitsPerPurchaseUnit = 1;
    await assert.rejects(mutateHotelSupplierProductHandler(request({ hotelUid: "hotel-a", productId, action: "update", requestId: "invalid-kg-content", expectedRevision: stored.revision, product: invalid }), services), /exactly 1 kg/);
    assert.equal((await productRef.get()).updateTime.isEqual(before.updateTime), true);
    const cart = await mutateShoppingCartHandler(request({ hotelUid: "hotel-a", action: "get-or-create", requestId: "kg-cart" }), services);
    await mutateShoppingCartHandler(request({ hotelUid: "hotel-a", action: "add", cartId: cart.cartId, requestId: "kg-cart-add", expectedRevision: cart.revision, productId, purchaseOptionId: "default", value: 2.5 }), services);
    assert.equal((await db.doc(`hotels/hotel-a/shoppingCarts/${cart.cartId}`).get()).data().items[0].qtyPurchaseUnits, 2.5);
    assert.equal(calls, 1); assertCustomerPrivacy(page);
  });
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
    await approve(job.jobId, page.rows[0]);
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
      await rejectPermission(workspace(request({ ...data, filter: "all", includeIndex: true }, actor), services));
      await rejectPermission(decide(request(decisionData(job.jobId, { rowId: "r-000000", reviewRevision: 1 }), actor), services));
      await rejectPermission(completeReview(request({ ...data, requestId: "forged-completion" }, actor), services));
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
    assert.deepEqual(availability, { available: true, aiAvailable: true, recurringFormatsAvailable: true, recurringImportVersion: 1, sourceFormatProfileVersion: 1, importPolicyVersion: 2, reviewWorkspaceVersion: 1, reason: null, limits: { maxFileBytes: 10485760, maxPages: 50, maxProducts: 1000 }, defaults: { currency: "EUR" } });
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
    const { importSettings: _settings, importPolicyVersion: _version, importReviewVersion: _reviewVersion,
      mappingProfileId: _profileId, purchaseUnitMappingSnapshot: _mappingSnapshot, reviewState: _reviewState, ...legacy } = existing;
    await jobRef.set(legacy);
    const rows = await db.collection(`${jobRef.path}/rows`).get(), originalRows = rows.docs.map((row) => row.data());
    const status = await readSupplierAiImport(request(), { hotelUid: "hotel-a", jobId: job.jobId }, services);
    assert.equal(status.importSettings, null); assert.equal(status.summary, null); assertCustomerPrivacy(status);
    await runSupplierAiImportJob("hotel-a", job.jobId, services); assert.equal(calls, 1);
    assert.deepEqual((await db.collection(`${jobRef.path}/rows`).get()).docs.map((row) => row.data()), originalRows);
    assert.equal((await jobRef.get()).data().fingerprint, existing.fingerprint);
  });
  it("recovers a legacy lost upload acknowledgement only for the original source, owner and request", async () => {
    const created = await uploaded({ recurringImportVersion: undefined }), currentRef = db.doc(`hotels/hotel-a/supplierAiImportJobs/${created.jobId}`), current = (await currentRef.get()).data();
    const fingerprint = digest(current.supplierId, current.fileName, current.mimeType, current.sha256);
    const jobId = digest(current.hotelUid, current.requestId, current.ownerUid, fingerprint), path = `private/supplier-ai-imports/hotel-a/${jobId}/source`;
    const source = await savePrivate(bucket, path, bytes, "application/octet-stream");
    const { importSettings: _settings, importPolicyVersion: _version, importReviewVersion: _reviewVersion,
      mappingProfileId: _profileId, purchaseUnitMappingSnapshot: _mappingSnapshot, reviewState: _reviewState, ...base } = current;
    const legacy = { ...base, jobId, fingerprint, source };
    await db.doc(`hotels/hotel-a/supplierAiImportJobs/${jobId}`).set(legacy); await currentRef.delete();
    const receiptRef = db.doc("hotels/hotel-a/supplierAiImportRequests/import-one"), { importSettings: _receiptSettings, importPolicyVersion: _receiptVersion,
      importReviewVersion: _receiptReviewVersion, mappingProfileId: _receiptProfileId, purchaseUnitMappingSnapshot: _receiptMappingSnapshot, ...receipt } = (await receiptRef.get()).data();
    await receiptRef.set({ ...receipt, jobId, fingerprint });
    const result = await uploadSupplierAiImport(request(), uploadData({ importSettings: undefined, reviewWorkspaceVersion: undefined, recurringImportVersion: undefined }), bytes, services);
    assert.equal(result.jobId, jobId); assert.equal(result.status, "queued"); assert.equal(result.importSettings, null); assert.equal(result.summary, null); assertCustomerPrivacy(result);
    await assert.rejects(uploadSupplierAiImport(request(), uploadData({ importSettings: undefined, reviewWorkspaceVersion: undefined, recurringImportVersion: undefined, requestId: "new-legacy" }), bytes, services), { code: "invalid-argument" });
    await assert.rejects(uploadSupplierAiImport(request(), uploadData({ importSettings: undefined, reviewWorkspaceVersion: undefined, recurringImportVersion: undefined }), Buffer.from("different source"), services), { code: "already-exists" });
    await assert.rejects(uploadSupplierAiImport(request(null, "other-manager"), uploadData({ importSettings: undefined, reviewWorkspaceVersion: undefined, recurringImportVersion: undefined }), bytes, services), { code: "already-exists" });
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
    await rejectPermission(approve(job.jobId, page.rows[0]));
    await auth.updateUser("manager", { disabled: false }); await approve(job.jobId, page.rows[0]);
    assert.equal((await commit(request(data), services)).outcomes[0].status, "updated");
    await rejectPermission(settings(request(), services));
    assert.equal((await settings(request(null, "operator"), services)).configuration.enabled, false);
  });
  it("persists explicit approval without changing a product, and replays the decision without new writes or paid work", async () => {
    const job = await ready(), row = (await review(request({ hotelUid: "hotel-a", jobId: job.jobId }), services)).rows[0];
    const jobRef = db.doc(`hotels/hotel-a/supplierAiImportJobs/${job.jobId}`), rowRef = db.doc(`${jobRef.path}/rows/${row.rowId}`);
    assert.equal((await jobRef.get()).data().importReviewVersion, 1);
    const blockedCommand = { hotelUid: "hotel-a", jobId: job.jobId, requestId: "unapproved-command",
      rows: [{ rowId: row.rowId, reviewRevision: row.reviewRevision, acknowledged: true }] };
    const unapproved = await commit(request(blockedCommand), services);
    assert.equal(unapproved.outcomes[0].status, "blocked");
    assert.equal((await db.doc("hotels/hotel-a/supplierproducts/milk").get()).data().pricePerPurchaseUnit, 12);
    const receiptRef = db.doc(`${jobRef.path}/commitOperations/c-${digest("manager", blockedCommand.requestId).slice(0, 48)}/rows/${row.rowId}`);
    const receiptBefore = await receiptRef.get(), failedRow = await rowRef.get(), failedJob = await jobRef.get();
    assert.deepEqual((await workspace(request({ hotelUid: "hotel-a", jobId: job.jobId }), services)).reviewCounts,
      { pending: 1, approved: 0, skipped: 0, applied: 0, failed: 1 });
    await assert.rejects(approve(job.jobId, row, "approve-failed-without-revalidation"), { code: "failed-precondition" });
    assert.equal((await rowRef.get()).updateTime.isEqual(failedRow.updateTime), true);
    assert.equal((await jobRef.get()).updateTime.isEqual(failedJob.updateTime), true); assert.equal(calls, 1);
    const refreshed = await correct(request({ hotelUid: "hotel-a", jobId: job.jobId, rowId: row.rowId,
      expectedReviewRevision: row.reviewRevision, patch: {} }), services);
    assert.equal(refreshed.row.reviewRevision, row.reviewRevision + 1); assert.equal(refreshed.row.lastOutcome, null);
    assert.deepEqual((await workspace(request({ hotelUid: "hotel-a", jobId: job.jobId }), services)).reviewCounts,
      { pending: 1, approved: 0, skipped: 0, applied: 0, failed: 0 });
    const command = decisionData(job.jobId, refreshed.row), first = await decide(request(command), services);
    const stored = await rowRef.get(), jobBefore = await jobRef.get();
    assert.equal(stored.data().review.status, "approved"); assert.equal(stored.data().review.reviewRevision, refreshed.row.reviewRevision);
    assertCustomerPrivacy(first);
    assert.deepEqual(await decide(request(command), services), first);
    const after = await rowRef.get(), jobAfter = await jobRef.get();
    assert.equal(after.updateTime.isEqual(stored.updateTime), true); assert.equal(jobAfter.updateTime.isEqual(jobBefore.updateTime), true);
    assert.equal((await db.doc("hotels/hotel-a/supplierproducts/milk").get()).data().pricePerPurchaseUnit, 12);
    await assert.rejects(decide(request({ ...command, rows: [{ ...command.rows[0], action: "skip" }] }), services), { code: "already-exists" });
    assert.deepEqual(await commit(request(blockedCommand), services), unapproved, "The original blocked command keeps its recorded outcome after fresh approval.");
    const receiptAfter = await receiptRef.get(); assert.deepEqual(receiptAfter.data(), receiptBefore.data());
    assert.equal(receiptAfter.updateTime.isEqual(receiptBefore.updateTime), true);
    assert.equal((await rowRef.get()).updateTime.isEqual(stored.updateTime), true); assert.equal((await jobRef.get()).updateTime.isEqual(jobBefore.updateTime), true);
    assert.equal((await db.collection("hotels/hotel-a/supplierPriceHistory/milk/entries").get()).size, 1);
    await runSupplierAiImportJob("hotel-a", job.jobId, services); assert.equal(calls, 1);
  });
  it("reconciles review decisions across the whole 250-product import rather than only the first loaded page", async () => {
    const source = Buffer.from("SKU,Name,Net Purchase Price,Currency,Purchase Unit,Package Content\n"
      + Array.from({ length: 250 }, (_, index) => `BULK-${String(index).padStart(3, "0")},Fictional product ${index},18,EUR,Case,6`).join("\n") + "\n");
    const bulkServices = { ...services, provider: { ...provider, respond: async (body) => {
      calls++;
      const rows = JSON.parse(body.input[0].content[0].text).units.filter((unit) => /^csv-row-\d+$/.test(unit.sourceId) && !unit.contextOnly)
        .map((unit) => ({ unit, cells: JSON.parse(unit.text) })).filter(({ cells }) => String(cells[0]).startsWith("BULK-"))
        .map(({ unit, cells }) => ({ supplierSku: cells[0], supplierProductName: cells[1], currency: "EUR", pricingModel: "Per Purchase Unit",
          purchaseUnit: "Case", baseUnit: "l", priceBasis: "net", gtin: null, priceValidFrom: null, priceValidUntil: null,
          pricePerBaseUnit: null, pricePerPurchaseUnit: 18, baseUnitsPerPurchaseUnit: 6, vatRate: null,
          sourceAnchors: [{ sourceId: unit.sourceId, quote: cells[0] }] }));
      return { id: `fictional-bulk-${calls}`, model: "gpt-6-luna", status: "completed",
        usage: { input_tokens: 500, output_tokens: 100, total_tokens: 600 },
        output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ rows }) }] }] };
    } } };
    const job = await uploadSupplierAiImport(request(), uploadData({ requestId: "import-250" }), source, bulkServices);
    let processed, originalPaidCalls;
    for (let resume = 0; resume < 5; resume++) {
      processed = await runSupplierAiImportJob("hotel-a", job.jobId, bulkServices);
      if (resume === 0) originalPaidCalls = calls;
      else assert.equal(calls, originalPaidCalls, "Reconciliation continuation must reuse the original paid chunk receipts.");
      if (processed.status === "review") break;
      assert.equal(processed.queued, true, JSON.stringify(processed));
    }
    assert.equal(processed.status, "review");
    await confirmFormat(job.jobId);
    const first = await workspace(request({ hotelUid: "hotel-a", jobId: job.jobId, limit: 25, includeIndex: true }), services);
    assert.equal(first.rows.length, 25); assert.equal(first.index.length, 250); assert.equal(first.totalRows, 250);
    assert.deepEqual(first.reviewCounts, { pending: 250, approved: 0, skipped: 0, applied: 0, failed: 0 });
    assert.equal(first.counts.new, 250); assert.equal(first.summary.totalRows, 250);
    await approve(job.jobId, first.rows[0], "approve-first-of-250");
    await decide(request(decisionData(job.jobId, first.rows[1], "skip", "skip-second-of-250")), services);
    const filtered = await workspace(request({ hotelUid: "hotel-a", jobId: job.jobId, filter: "approved", limit: 25, includeIndex: true }), services);
    assert.equal(filtered.rows.length, 1); assert.equal(filtered.index.length, 250);
    assert.deepEqual(filtered.reviewCounts, { pending: 248, approved: 1, skipped: 1, applied: 0, failed: 0 });
    const paidCalls = calls; await runSupplierAiImportJob("hotel-a", job.jobId, bulkServices); assert.equal(calls, paidCalls);
    assert.equal((await db.collection("hotels/hotel-a/supplierproducts").get()).size, 1,
      "Reviewing drafts must not create any of the proposed 250 products before confirmation.");
  });
  it("invalidates approval after correction and refuses a stale decision instead of importing unseen values", async () => {
    const job = await ready(), row = (await review(request({ hotelUid: "hotel-a", jobId: job.jobId }), services)).rows[0];
    await approve(job.jobId, row);
    const changed = await correct(request({ hotelUid: "hotel-a", jobId: job.jobId, rowId: row.rowId,
      expectedReviewRevision: row.reviewRevision, patch: { pricePerPurchaseUnit: 18 } }), services);
    assert.equal(changed.row.reviewRevision, row.reviewRevision + 1);
    const stored = (await db.doc(`hotels/hotel-a/supplierAiImportJobs/${job.jobId}/rows/${row.rowId}`).get()).data();
    assert.notEqual(stored.review?.status, "approved");
    await assert.rejects(approve(job.jobId, row, "stale-approval"), { code: "aborted" });
    const blockedCommand = { hotelUid: "hotel-a", jobId: job.jobId, requestId: "corrected-unapproved",
      rows: [{ rowId: row.rowId, reviewRevision: changed.row.reviewRevision, acknowledged: true }] };
    const withoutApproval = await commit(request(blockedCommand), services);
    assert.equal(withoutApproval.outcomes[0].status, "blocked");
    const jobRef = db.doc(`hotels/hotel-a/supplierAiImportJobs/${job.jobId}`), rowRef = db.doc(`${jobRef.path}/rows/${row.rowId}`);
    const receiptRef = db.doc(`${jobRef.path}/commitOperations/c-${digest("manager", blockedCommand.requestId).slice(0, 48)}/rows/${row.rowId}`);
    const receiptBefore = await receiptRef.get(), failedRow = await rowRef.get(), failedJob = await jobRef.get();
    await assert.rejects(approve(job.jobId, changed.row, "latest-approval-without-revalidation"), { code: "failed-precondition" });
    assert.equal((await rowRef.get()).updateTime.isEqual(failedRow.updateTime), true);
    assert.equal((await jobRef.get()).updateTime.isEqual(failedJob.updateTime), true); assert.equal(calls, 1);
    assert.deepEqual((await workspace(request({ hotelUid: "hotel-a", jobId: job.jobId }), services)).reviewCounts,
      { pending: 1, approved: 0, skipped: 0, applied: 0, failed: 1 });
    const refreshed = await correct(request({ hotelUid: "hotel-a", jobId: job.jobId, rowId: row.rowId,
      expectedReviewRevision: changed.row.reviewRevision, patch: {} }), services);
    assert.equal(refreshed.row.reviewRevision, changed.row.reviewRevision + 1); assert.equal(refreshed.row.lastOutcome, null);
    assert.equal(refreshed.row.product.pricePerPurchaseUnit, 18);
    await assert.rejects(approve(job.jobId, changed.row, "stale-corrected-approval"), { code: "aborted" });
    await approve(job.jobId, refreshed.row, "latest-approval");
    const result = await commit(request({ hotelUid: "hotel-a", jobId: job.jobId, requestId: "corrected-approved",
      rows: [{ rowId: row.rowId, reviewRevision: refreshed.row.reviewRevision, acknowledged: true }] }), services);
    assert.equal(result.outcomes[0].status, "updated");
    assert.deepEqual(await commit(request(blockedCommand), services), withoutApproval);
    const receiptAfter = await receiptRef.get(); assert.deepEqual(receiptAfter.data(), receiptBefore.data());
    assert.equal(receiptAfter.updateTime.isEqual(receiptBefore.updateTime), true);
    assert.deepEqual((await workspace(request({ hotelUid: "hotel-a", jobId: job.jobId }), services)).reviewCounts,
      { pending: 0, approved: 0, skipped: 0, applied: 1, failed: 0 });
    assert.equal((await db.collection("hotels/hotel-a/supplierPriceHistory/milk/entries").get()).size, 2);
    assert.equal((await db.doc("hotels/hotel-a/supplierproducts/milk").get()).data().pricePerPurchaseUnit, 18); assert.equal(calls, 1);
  });
  it("keeps skip and reset resumable and refuses completion until every proposal is applied or skipped", async () => {
    const job = await ready(), row = (await review(request({ hotelUid: "hotel-a", jobId: job.jobId }), services)).rows[0];
    const completion = { hotelUid: "hotel-a", jobId: job.jobId, requestId: "finish-reviewed-import" };
    assert.equal((await completeReview(request(completion), services)).completed, false);
    await decide(request(decisionData(job.jobId, row, "skip", "skip-first")), services);
    assert.equal((await db.doc(`hotels/hotel-a/supplierAiImportJobs/${job.jobId}/rows/${row.rowId}`).get()).data().review.status, "skipped");
    await decide(request(decisionData(job.jobId, row, "reset", "reset-first")), services);
    assert.equal((await completeReview(request({ ...completion, requestId: "not-finished" }), services)).completed, false);
    await decide(request(decisionData(job.jobId, row, "skip", "skip-final")), services);
    const result = await completeReview(request(completion), services); assertCustomerPrivacy(result);
    assert.deepEqual(await completeReview(request(completion), services), result);
    const jobRef = db.doc(`hotels/hotel-a/supplierAiImportJobs/${job.jobId}`), before = await jobRef.get();
    assert.equal(before.data().status, "completed");
    await runSupplierAiImportJob("hotel-a", job.jobId, services);
    const after = await jobRef.get(); assert.deepEqual(after.data(), before.data()); assert.equal(after.updateTime.isEqual(before.updateTime), true);
    assert.equal((await db.doc("hotels/hotel-a/supplierproducts/milk").get()).data().pricePerPurchaseUnit, 12); assert.equal(calls, 1);
  });
  it("rechecks current hotel permissions, subscription and account status for persisted review decisions", async () => {
    const job = await ready(), row = (await review(request({ hotelUid: "hotel-a", jobId: job.jobId }), services)).rows[0];
    await db.doc("hotels/hotel-a/members/manager").delete();
    await rejectPermission(workspace(request({ hotelUid: "hotel-a", jobId: job.jobId }), services));
    await rejectPermission(approve(job.jobId, row));
    await db.doc("hotels/hotel-a/members/manager").set(access);
    await db.doc("hotelSubscriptions/hotel-a").update({ status: "canceled" }); await rejectPermission(approve(job.jobId, row));
    await db.doc("hotelSubscriptions/hotel-a").set(subscription);
    await db.doc("hotels/hotel-a/members/manager").update({ permissions: access.permissions.filter((permission) => permission !== "supplierproducts.update") });
    await rejectPermission(approve(job.jobId, row));
    await db.doc("hotels/hotel-a/members/manager").set(access); await auth.updateUser("manager", { disabled: true });
    await rejectPermission(workspace(request({ hotelUid: "hotel-a", jobId: job.jobId }), services)); await rejectPermission(approve(job.jobId, row));
    await auth.updateUser("manager", { disabled: false }); await auth.revokeRefreshTokens("manager");
    const currentAccount = await auth.getUser("manager"), previousAuthTime = identities.manager.token.auth_time;
    identities.manager.token.auth_time = Math.floor(Date.parse(currentAccount.tokensValidAfterTime) / 1000) - 1;
    try {
      await rejectPermission(workspace(request({ hotelUid: "hotel-a", jobId: job.jobId }), services)); await rejectPermission(approve(job.jobId, row));
    } finally { identities.manager.token.auth_time = previousAuthTime; }
    assert.notEqual((await db.doc(`hotels/hotel-a/supplierAiImportJobs/${job.jobId}/rows/${row.rowId}`).get()).data().review?.status, "approved");
    assert.equal(calls, 1);
  });
  it("cannot approve unverified source evidence even after correcting the product fields", async () => {
    const job = await uploaded();
    const wrongEvidence = { ...services, provider: { ...provider, respond: async (body) => {
      const response = await provider.respond(body), payload = JSON.parse(response.output[0].content[0].text);
      payload.rows[0].sourceAnchors[0].quote = "A product quote which is absent from this source";
      response.output[0].content[0].text = JSON.stringify(payload); return response;
    } } };
    assert.equal((await runSupplierAiImportJob("hotel-a", job.jobId, wrongEvidence)).status, "review");
    const row = (await review(request({ hotelUid: "hotel-a", jobId: job.jobId }), services)).rows[0];
    assert.equal(row.category, "blocked"); await assert.rejects(approve(job.jobId, row), { code: "failed-precondition" });
    const changed = await correct(request({ hotelUid: "hotel-a", jobId: job.jobId, rowId: row.rowId,
      expectedReviewRevision: row.reviewRevision, patch: { supplierProductName: "Human corrected milk", pricePerPurchaseUnit: 15 } }), services);
    await assert.rejects(approve(job.jobId, changed.row, "still-unverified"), { code: "failed-precondition" });
    assert.equal((await db.doc("hotels/hotel-a/supplierproducts/milk").get()).data().pricePerPurchaseUnit, 12); assert.equal(calls, 1);
  });
  it("requires confirmation before persisting Sligro suggestions and isolates saved mappings by hotel, supplier, format and profile", async () => {
    await db.doc("hotels/hotel-a/suppliers/dairy").update({ name: "Sligro" });
    const suggested = await readMappings(request(mappingData()), services);
    assert.equal(suggested.revision, 0); assert.deepEqual(suggested.mappings, []);
    assert.equal(suggested.suggestions.find((entry) => entry.sourceUnit === "TR").purchaseUnit, "Tray");
    assert.equal(suggested.suggestions.find((entry) => entry.sourceUnit === "TR").needsConfirmation, true);
    assert.equal((await db.collection("hotels/hotel-a/supplierImportMappingProfiles").get()).size, 0);
    const command = mappingCommand(), saved = await saveMappings(request(command), services); assertCustomerPrivacy(saved);
    assert.equal(saved.revision, 1); assert.deepEqual(saved.mappings, command.mappings);
    const profileRef = mappingProfileRef(db, "hotel-a", mappingScope(command)), before = await profileRef.get();
    assert.equal(before.data().createdBy, "manager");
    assert.deepEqual(await saveMappings(request(command), services), saved);
    const after = await profileRef.get(); assert.deepEqual(after.data(), before.data()); assert.equal(after.updateTime.isEqual(before.updateTime), true);
    assert.deepEqual((await readMappings(request(mappingData(), "other-manager"), services)).mappings, command.mappings,
      "Confirmed supplier rules are shared within the hotel, unlike a user's private import job.");
    await db.doc("hotels/hotel-a/suppliers/other").set({ name: "Other supplier" });
    for (const scope of [mappingData({ sourceFormat: "xlsx" }), mappingData({ profileId: "volume-list" }), mappingData({ supplierId: "other" })]) {
      assert.deepEqual((await readMappings(request(scope), services)).mappings, []);
    }
    assert.deepEqual((await readMappings(request(mappingData({ hotelUid: "hotel-b" }), "hotel-b"), services)).mappings, []);
    await assert.rejects(saveMappings(request(mappingCommand({ requestId: "stale-profile", mappings: [{ sourceUnit: "BK", purchaseUnit: "Box" }] })), services), { code: "aborted" });
    await assert.rejects(saveMappings(request(mappingCommand({ mappings: [{ sourceUnit: "FL", purchaseUnit: "Bag" }] })), services), { code: "already-exists" });
    assert.equal((await db.collection("hotels/hotel-a/supplierImportMappingOperations").get()).size, 1);
    assert.equal((await db.collection("hotels/hotel-a/supplierImportMappingAudit").get()).size, 1); assert.equal(calls, 0);
  });
  it("applies a confirmed mapping only to matching unedited units and invalidates approval without rewriting paid evidence", async () => {
    await saveMappings(request(mappingCommand()), services);
    const source = Buffer.from("SKU,Name,Net Purchase Price,Currency,Purchase Unit,Package Content\n"
      + "MILK6,Milk six pack,18,EUR,FL,6\nOTHERFL,Other bottle,18,EUR,FL,6\nOTHERZK,Other bag,18,EUR,ZK,6\n");
    const mappedServices = { ...services, provider: { ...provider, respond: async (body) => {
      calls++;
      const rows = JSON.parse(body.input[0].content[0].text).units.filter((unit) => /^csv-row-\d+$/.test(unit.sourceId) && !unit.contextOnly)
        .map((unit) => ({ unit, cells: JSON.parse(unit.text) })).filter(({ cells }) => ["MILK6", "OTHERFL", "OTHERZK"].includes(cells[0]))
        .map(({ unit, cells }) => ({ supplierSku: cells[0], supplierProductName: cells[1], currency: "EUR", pricingModel: "Per Purchase Unit",
          purchaseUnit: cells[4], baseUnit: "l", priceBasis: "net", gtin: null, priceValidFrom: null, priceValidUntil: null,
          pricePerBaseUnit: null, pricePerPurchaseUnit: 18, baseUnitsPerPurchaseUnit: 6, vatRate: null,
          sourceAnchors: [{ sourceId: unit.sourceId, quote: cells[0] }] }));
      return { id: "fictional-mapping-response", model: "gpt-6-luna", status: "completed",
        usage: { input_tokens: 500, output_tokens: 100, total_tokens: 600 },
        output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ rows }) }] }] };
    } } };
    const input = uploadData({ requestId: "mapping-application-import" });
    const job = await uploadSupplierAiImport(request(), input, source, mappedServices);
    assert.equal((await runSupplierAiImportJob("hotel-a", job.jobId, mappedServices)).status, "review"); assert.equal(calls, 1);
    await confirmFormat(job.jobId);
    const rows = (await review(request({ hotelUid: "hotel-a", jobId: job.jobId }), services)).rows;
    const first = rows.find((row) => row.product.supplierSku === "MILK6"), second = rows.find((row) => row.product.supplierSku === "OTHERFL"), third = rows.find((row) => row.product.supplierSku === "OTHERZK");
    assert.equal(first.product.purchaseUnit, "Bottle"); assert.equal(second.product.purchaseUnit, "Bottle");
    const editedFirst = (await correct(request({ hotelUid: "hotel-a", jobId: job.jobId, rowId: first.rowId,
      expectedReviewRevision: first.reviewRevision, patch: { supplierProductName: "Verified milk name" } }), services)).row;
    const editedSecond = (await correct(request({ hotelUid: "hotel-a", jobId: job.jobId, rowId: second.rowId,
      expectedReviewRevision: second.reviewRevision, patch: { purchaseUnit: "Jar" } }), services)).row;
    await approve(job.jobId, editedFirst, "approve-before-remapping");
    const jobRef = db.doc(`hotels/hotel-a/supplierAiImportJobs/${job.jobId}`), stored = (await jobRef.get()).data();
    const attempts = (await db.collection(`${jobRef.path}/attempts`).get()).docs.map((doc) => doc.data());
    const replacement = await saveMappings(request(mappingCommand({ requestId: "confirm-box", expectedRevision: 2,
      mappings: [{ sourceUnit: "FL", purchaseUnit: "Box" }] })), services); assert.equal(replacement.revision, 3);
    const command = { hotelUid: "hotel-a", jobId: job.jobId, requestId: "apply-box", sourceUnit: "FL", purchaseUnit: "Box", expectedMappingRevision: 3,
      rows: [editedFirst, editedSecond, third].map((row) => ({ rowId: row.rowId, reviewRevision: row.reviewRevision })) };
    await assert.rejects(applyMapping(request({ ...command, requestId: "stale-mapping", expectedMappingRevision: 1 }), services), { code: "aborted" });
    const result = await applyMapping(request(command), services);
    assert.equal(result.outcomes.find((outcome) => outcome.rowId === first.rowId).status, "mapped");
    assert.equal(result.outcomes.find((outcome) => outcome.rowId === second.rowId).reason, "human-correction");
    assert.equal(result.outcomes.find((outcome) => outcome.rowId === third.rowId).status, "blocked");
    const mapped = (await db.doc(`${jobRef.path}/rows/${first.rowId}`).get()).data();
    assert.equal(mapped.product.purchaseUnit, "Box"); assert.equal(mapped.product.supplierProductName, "Verified milk name");
    assert.equal(mapped.reviewRevision, editedFirst.reviewRevision + 1); assert.equal(mapped.review.status, "pending");
    assert.equal((await db.doc(`${jobRef.path}/rows/${second.rowId}`).get()).data().product.purchaseUnit, "Jar");
    assert.equal((await db.doc(`${jobRef.path}/rows/${third.rowId}`).get()).data().reviewRevision, third.reviewRevision);
    assert.deepEqual(await applyMapping(request(command), services), result);
    const after = (await jobRef.get()).data();
    assert.deepEqual(after.purchaseUnitMappingSnapshot, stored.purchaseUnitMappingSnapshot); assert.equal(after.purchaseUnitMappingSnapshot.revision, 2);
    assert.equal(after.fingerprint, stored.fingerprint); assert.deepEqual(after.source, stored.source);
    assert.deepEqual((await db.collection(`${jobRef.path}/attempts`).get()).docs.map((doc) => doc.data()), attempts);
    assert.equal((await uploadSupplierAiImport(request(), input, source, mappedServices)).jobId, job.jobId);
    await runSupplierAiImportJob("hotel-a", job.jobId, mappedServices); assert.equal(calls, 1);
  });
  it("enforces live ordinary-hotel authorization for mapping reads, updates and receipt replay", async () => {
    for (const actor of ["hotel-b", "operator"]) {
      await rejectPermission(readMappings(request(mappingData(), actor), services));
      await rejectPermission(saveMappings(request(mappingCommand(), actor), services));
    }
    await rejectPermission(readMappings(request(mappingData({ hotelUid: "hotel-b" })), services));
    await saveMappings(request(mappingCommand()), services);
    const replacement = mappingCommand({ requestId: "mapping-change", expectedRevision: 1, mappings: [{ sourceUnit: "FL", purchaseUnit: "Jar" }] });
    const first = await saveMappings(request(replacement), services); assert.equal(first.revision, 2);
    await db.doc("hotels/hotel-a/members/manager").update({ permissions: access.permissions.filter((permission) => permission !== "supplierproducts.update") });
    await rejectPermission(saveMappings(request(replacement), services));
    await rejectPermission(saveMappings(request(mappingCommand({ requestId: "mapping-change-without-rights", expectedRevision: 2,
      mappings: [{ sourceUnit: "FL", purchaseUnit: "Bottle" }] })), services));
    await db.doc("hotels/hotel-a/members/manager").set(access); await db.doc("hotelSubscriptions/hotel-a").update({ status: "canceled" });
    await rejectPermission(readMappings(request(mappingData()), services)); await rejectPermission(saveMappings(request(replacement), services));
    await db.doc("hotelSubscriptions/hotel-a").set(subscription); await auth.updateUser("manager", { disabled: true });
    await rejectPermission(readMappings(request(mappingData()), services)); await rejectPermission(saveMappings(request(replacement), services));
    await auth.updateUser("manager", { disabled: false }); await db.doc("hotels/hotel-a/members/manager").delete();
    await rejectPermission(readMappings(request(mappingData()), services)); await rejectPermission(saveMappings(request(replacement), services));
    assert.equal((await db.collection("hotels/hotel-a/supplierImportMappingOperations").get()).size, 2); assert.equal(calls, 0);
  });
  it("denies browser and generic-import writes to saved mapping profiles, operations and audit evidence", async () => {
    await saveMappings(request(mappingCommand()), services);
    const profileRef = mappingProfileRef(db, "hotel-a", mappingScope(mappingData()));
    const operationId = `m-${digest("manager", "mapping-one").slice(0, 48)}`;
    for (const actor of ["manager", "operator", "hotel-b"]) {
      const context = environment.authenticatedContext(actor, identities[actor].token);
      for (const path of [profileRef.path, `hotels/hotel-a/supplierImportMappingOperations/${operationId}`,
        `hotels/hotel-a/supplierImportMappingAudit/${operationId}`]) {
        await assertFails(getDoc(doc(context.firestore(), path))); await assertFails(setDoc(doc(context.firestore(), path), { mappings: [] }));
      }
    }
    for (const collection of ["supplierImportMappingProfiles", "supplierImportMappingOperations", "supplierImportMappingAudit"]) {
      assert.throws(() => requireHotelImportTarget(`hotels/hotel-a/${collection}/forged`, "hotel-a"), /protected|operational/);
    }
    assert.deepEqual((await profileRef.get()).data().mappings, mappingCommand().mappings); assert.equal(calls, 0);
  });
  it("protects confirmed file interpretations against cross-hotel access, stale replacement and replay after permission revocation", async () => {
    const command = mappingCommand({ requestId: "format-first", mappings: [], interpretation: confirmedInterpretation() });
    for (const actor of ["hotel-b", "operator"]) await rejectPermission(saveMappings(request(command, actor), services));
    const saved = await saveMappings(request(command), services); assert.equal(saved.revision, 1);
    assert.deepEqual((await readMappings(request(mappingData(), "other-manager"), services)).interpretation, saved.interpretation);
    assert.equal((await readMappings(request(mappingData({ hotelUid: "hotel-b" }), "hotel-b"), services)).interpretation, undefined);
    const reference = mappingProfileRef(db, "hotel-a", mappingScope(command)), original = await reference.get();
    assert.deepEqual(await saveMappings(request(command), services), saved);
    assert.equal((await reference.get()).updateTime.isEqual(original.updateTime), true);
    const changed = mappingCommand({ requestId: "format-replaced", expectedRevision: 1, mappings: [],
      interpretation: confirmedInterpretation({ decimalSeparator: "," }) });
    await db.doc("hotels/hotel-a/members/manager").update({ permissions: access.permissions.filter((permission) => permission !== "supplierproducts.update") });
    await rejectPermission(saveMappings(request(changed), services));
    assert.equal((await reference.get()).data().revision, 1);
    await db.doc("hotels/hotel-a/members/manager").set(access);
    const replacement = await saveMappings(request(changed), services); assert.equal(replacement.revision, 2);
    await assert.rejects(saveMappings(request({ ...command, requestId: "stale-format" }), services), { code: "aborted" });
    await assert.rejects(saveMappings(request({ ...changed, interpretation: confirmedInterpretation({ assortmentMode: "full" }) }), services), { code: "already-exists" });
    await db.doc("hotels/hotel-a/members/manager").update({ permissions: access.permissions.filter((permission) => permission !== "supplierproducts.update") });
    await rejectPermission(saveMappings(request(changed), services));
    await db.doc("hotels/hotel-a/members/manager").set(access); await auth.updateUser("manager", { disabled: true });
    await rejectPermission(saveMappings(request(changed), services));
    await rejectPermission(readMappings(request(mappingData()), services));
    assert.equal((await db.collection("hotels/hotel-a/supplierImportMappingOperations").get()).size, 2);
    assert.equal((await db.collection("hotels/hotel-a/supplierImportMappingAudit").get()).size, 2); assert.equal(calls, 0);
  });
  it("rejects untrusted interpretation fields and statistics prices before writing a confirmed format", async () => {
    for (const interpretation of [confirmedInterpretation({ automaticApproval: true }),
      confirmedInterpretation({ defaults: { priceBasis: "net", priceValidFrom: "2026-10-01" } }),
      confirmedInterpretation({ documentPurpose: "statistics" }),
      confirmedInterpretation({ columns: { supplierSku: 0, pricePerPurchaseUnit: 2, pricePerBaseUnit: 3 } })]) {
      await assert.rejects(saveMappings(request(mappingCommand({ mappings: [], interpretation })), services), { code: "invalid-argument" });
    }
    assert.equal((await db.collection("hotels/hotel-a/supplierImportMappingProfiles").get()).size, 0);
    assert.equal((await db.collection("hotels/hotel-a/supplierImportMappingOperations").get()).size, 0); assert.equal(calls, 0);
  });
  it("applies a first-file format only with live owner and update authority and rechecks them after private source I/O", async () => {
    const job = await uploaded(); await runSupplierAiImportJob("hotel-a", job.jobId, services);
    const initial = (await review(request({ hotelUid: "hotel-a", jobId: job.jobId }), services)).rows[0];
    assert.equal(initial.category, "blocked");
    await assert.rejects(approve(job.jobId, initial), { code: "failed-precondition" });
    const saved = await saveMappings(request(mappingCommand({ requestId: "format-for-first-file", mappings: [], interpretation: confirmedInterpretation() })), services);
    const command = { hotelUid: "hotel-a", jobId: job.jobId, requestId: "apply-first-file", expectedMappingRevision: saved.revision };
    for (const actor of ["other-manager", "hotel-b", "operator"]) await rejectPermission(applyFormat(request(command, actor), services));
    await assert.rejects(applyFormat(request({ ...command, requestId: "stale-file-format", expectedMappingRevision: 0 }), services), { code: "aborted" });
    await db.doc("hotels/hotel-a/members/manager").update({ permissions: access.permissions.filter((permission) => permission !== "supplierproducts.update") });
    await rejectPermission(applyFormat(request(command), services));
    await db.doc("hotels/hotel-a/members/manager").set(access);
    const lostAuthorityServices = { ...services, bucket: { file: (...args) => {
      const object = bucket.file(...args);
      return { getMetadata: (...parameters) => object.getMetadata(...parameters), download: async (...parameters) => {
        const result = await object.download(...parameters); await auth.updateUser("manager", { disabled: true }); return result;
      } };
    } } };
    await rejectPermission(applyFormat(request(command), lostAuthorityServices));
    const rowRef = db.doc(`hotels/hotel-a/supplierAiImportJobs/${job.jobId}/rows/${initial.rowId}`), unchanged = await rowRef.get();
    assert.equal(unchanged.data().reviewRevision, initial.reviewRevision);
    await auth.updateUser("manager", { disabled: false });
    const result = await applyFormat(request(command), services); assert.equal(result.completed, true); assert.equal(result.rebuiltRows, 1);
    const rebuilt = await rowRef.get(); assert.equal(rebuilt.data().reviewRevision, initial.reviewRevision + 1);
    assert.equal(rebuilt.data().review.status, "pending"); assert.equal(rebuilt.data().category, "changed");
    assert.deepEqual(await applyFormat(request(command), services), result); assert.equal((await rowRef.get()).updateTime.isEqual(rebuilt.updateTime), true);
    await db.doc("hotels/hotel-a/members/manager").update({ permissions: access.permissions.filter((permission) => permission !== "supplierproducts.update") });
    await rejectPermission(applyFormat(request(command), services));
    const stored = (await db.doc(`hotels/hotel-a/supplierAiImportJobs/${job.jobId}`).get()).data();
    for (const actor of ["manager", "hotel-b", "operator"]) {
      const context = environment.authenticatedContext(actor, identities[actor].token);
      await assertFails(getBytes(ref(context.storage(), stored.sourceFormatObject.path)));
      await assertFails(uploadBytes(ref(context.storage(), stored.sourceFormatObject.path), Buffer.from("forged")));
    }
    assert.equal((await db.doc("hotels/hotel-a/supplierproducts/milk").get()).data().pricePerPurchaseUnit, 12); assert.equal(calls, 1);
  });
  it("processes a recurring future price list without AI, approves proven price changes together and preserves today's price", async () => {
    const first = await ready(), firstRow = (await review(request({ hotelUid: "hotel-a", jobId: first.jobId }), services)).rows[0];
    await approve(first.jobId, firstRow, "approve-current-list");
    await commit(request({ hotelUid: "hotel-a", jobId: first.jobId, requestId: "commit-current-list",
      rows: [{ rowId: firstRow.rowId, reviewRevision: firstRow.reviewRevision, acknowledged: true }] }), services);
    const productRef = db.doc("hotels/hotel-a/supplierproducts/milk"), current = (await productRef.get()).data();
    await db.doc("platformConfiguration/aiSupplierProductImport").update({ enabled: false });
    const forbiddenProvider = { ...services, provider: { countInput: async () => { throw new Error("A confirmed recurring format must not call AI."); },
      respond: async () => { throw new Error("A confirmed recurring format must not call AI."); } } };
    const today = new Date(), futureYear = today.getUTCFullYear() + 1;
    const settings = { policyVersion: 2, priceBasis: "net", currency: "EUR", vatRate: null,
      sourceIssuedOn: today.toISOString().slice(0, 10), priceValidFrom: `${futureYear}-01-01`, priceValidUntil: `${futureYear}-12-31` };
    const source = Buffer.from("sku,name,Net Purchase Price,currency,Purchase Unit,Package Content\nMILK6,Milk six pack,18,EUR,Case,6\n");
    const job = await uploadSupplierAiImport(request(), uploadData({ requestId: "recurring-future", fileName: "next-year.csv", importSettings: JSON.stringify(settings) }), source, forbiddenProvider);
    assert.equal((await runSupplierAiImportJob("hotel-a", job.jobId, forbiddenProvider)).status, "review");
    const view = await workspace(request({ hotelUid: "hotel-a", jobId: job.jobId }), services), row = view.rows[0];
    assert.equal(row.sourceInterpretation.status, "confirmed"); assert.equal(row.bulkEligible, true);
    assert.equal(row.recurringReview.category, "price-change");
    await decide(request({ ...decisionData(job.jobId, row, "approve", "approve-recurring-bulk"), bulk: true }), services);
    const command = { hotelUid: "hotel-a", jobId: job.jobId, requestId: "commit-recurring-future",
      rows: [{ rowId: row.rowId, reviewRevision: row.reviewRevision, acknowledged: true }] };
    const result = await commit(request(command), services); assert.equal(result.outcomes[0].status, "updated");
    assert.deepEqual(await commit(request(command), services), result);
    const after = (await productRef.get()).data();
    assert.equal(after.pricePerPurchaseUnit, 15); assert.equal(after.catalogProductId, current.catalogProductId);
    assert.equal(after.priceConfirmedOn.isEqual(current.priceConfirmedOn), true);
    const versions = (await db.collection("hotels/hotel-a/supplierPriceVersions/milk/entries").get()).docs.map((document) => document.data());
    const scheduled = versions.find((version) => version.productTerms.priceValidFrom === settings.priceValidFrom);
    assert.equal(scheduled.productTerms.pricePerPurchaseUnit, 18); assert.match(scheduled.sourceReference, /next-year\.csv/);
    assert.equal(calls, 1);
  });
});
