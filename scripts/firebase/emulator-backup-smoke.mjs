import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeTestEnvironment, assertFails } from "@firebase/rules-unit-testing";
import { doc, getDoc } from "firebase/firestore";
import { ref, getBytes, getDownloadURL } from "firebase/storage";

// Handler injection must use the same SDK installation as Functions; FieldPath
// and Timestamp constructors from a second installation are not interchangeable.
const requireFunctions = createRequire(new URL("../../functions/package.json", import.meta.url));
const { deleteApp, initializeApp } = requireFunctions("firebase-admin/app");
const { getAuth } = requireFunctions("firebase-admin/auth");
const { getFirestore, Timestamp } = requireFunctions("firebase-admin/firestore");
const { getStorage } = requireFunctions("firebase-admin/storage");

const projectId = process.env.GCLOUD_PROJECT || "demo-hotel-suite-a00";
if (projectId !== "demo-hotel-suite-a00") throw new Error("Only the fictional restore project is permitted.");
for (const key of ["FIRESTORE_EMULATOR_HOST", "FIREBASE_AUTH_EMULATOR_HOST", "FIREBASE_STORAGE_EMULATOR_HOST"]) {
  if (!/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(process.env[key] || "")) {
    throw new Error(`${key} must explicitly address a local emulator.`);
  }
}

const app = initializeApp({ projectId, storageBucket: `${projectId}.appspot.com` });
const database = getFirestore(app);
const auth = getAuth(app);
const bucket = getStorage(app).bucket();
const revisionTime = Timestamp.fromMillis(1700000000000);
const subscriptionExpiry = Timestamp.fromMillis(1893456000000);
const roomingToken = "a".repeat(48);
const attachmentA = "a".repeat(32), attachmentB = "b".repeat(32);
const objects = {
  [`private/contracts/restore-hotel-a/contract-a/${attachmentA}`]: Buffer.from("fictional private attachment A"),
  [`private/contracts/restore-hotel-b/contract-b/${attachmentB}`]: Buffer.from("fictional private attachment B"),
};
const roomTypeDays = ["2026-10-10", "2026-10-11"].map((date) => ({ date, roomTypes: [{ code: "DBL", name: "Double", quantity: 2 }] }));
const reservations = [{ id: "reservation-a", firstName: "Fictional", lastName: "Guest", arrivalDate: "2026-10-10", departureDate: "2026-10-12", roomType: "DBL", numberOfAdults: 1, numberOfChildren: 0, comment: "", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" }];
const receivingLines = [{ supplierProductId: "coffee", productName: "Fictional coffee", purchaseUnit: "box", orderedQuantity: 3, acceptedQuantity: 3, rejectedQuantity: 1 }];
const digest = (...values) => createHash("sha256").update(JSON.stringify(values)).digest("hex");
const receivingDetails = { receivedOn: "2023-11-14", deliveryReference: "RESTORE-DN", note: "",
  lines: [{ supplierProductId: "coffee", acceptedQuantity: 3, rejectedQuantity: 1, reason: "Damaged packaging" }] };
const receiptId = `r-${digest("receiving-a", "restore-a", "restore-receipt").slice(0, 48)}`;
const receivingResult = { hotelUid: "restore-hotel-a", orderId: "receiving-a", eventId: receiptId, status: "Received", revision: 2, receivingState: "complete" };
const require = createRequire(import.meta.url);
const { checkpointId, prepareCheckpoint, readLocationSequence } = require("../../functions/src/inventoryMovements");
const { getHotelInventoryPeriodHandler } = require("../../functions/src/inventoryReports");
const { mutateHotelSupplierProductHandler } = require("../../functions/src/products");
const { readHotelCatalogSyncWorkspaceHandler, applyHotelCatalogSyncHandler } = require("../../functions/src/catalogSync");
const { getHotelCatalogSkuSettingsHandler, saveHotelCatalogSkuSettingsHandler, assignHotelCatalogSkusHandler } = require("../../functions/src/catalogSkuSettings");
const { refineHotelCatalogSyncSuggestionsHandler } = require("../../functions/src/catalogSyncAi");
const { resolveSupplierPriceVersion } = require("../../functions/src/supplierPriceVersions");
const { uploadSupplierProductImage, readSupplierProductImage, sourcePath } = require("../../functions/src/supplierProductImages");
const sharp = requireFunctions("sharp");
const { recordHotelInventoryAdjustmentHandler, reverseHotelInventoryAdjustmentHandler } = require("../../functions/src/inventoryAdjustments");
const { recordHotelSupplierConfirmationHandler, reviewHotelSupplierConfirmationHandler, getHotelSupplierConfirmationsHandler } = require("../../functions/src/supplierConfirmations");
const { recordHotelOrderReceiptHandler: recordConfirmedReceipt } = require("../../functions/src/orderReceiving");
const { DEFAULT_AI_CONFIGURATION } = require("../../functions/src/supplierAiPolicy");
const { uploadSupplierAiImport, readSupplierAiImport, runSupplierAiImportJob } = require("../../functions/src/supplierAiImports");
const { readHotelSupplierAiImportRowsHandler } = require("../../functions/src/supplierAiProposal");
const { readHotelSupplierAiImportWorkspaceHandler, decideHotelSupplierAiImportRowsHandler, applyHotelSupplierImportFormatHandler } = require("../../functions/src/supplierAiReview");
const { readHotelSupplierPurchaseUnitMappingsHandler, saveHotelSupplierPurchaseUnitMappingHandler,
  mappingScope, mappingProfileRef } = require("../../functions/src/supplierImportMappings");
const inventoryFixtures = [
  { hotelUid: "restore-hotel-a", currency: "EUR", actorUid: "restore-a", platform: false },
  { hotelUid: "restore-hotel-b", currency: "GBP", actorUid: "restore-b-counter", platform: false },
];
const inventoryReportId = (hotelUid) => `hotels/${hotelUid}/inventoryPeriodReports/p-${digest("store", "opening", "closing", 1).slice(0, 48)}`;
const inventoryRequest = (fixture) => ({ auth: { uid: fixture.actorUid, token: { email_verified: true,
  ...(fixture.platform ? { platformAdmin: true } : {}) } },
data: { hotelUid: fixture.hotelUid, locationId: "store", openingStockCountId: "opening", closingStockCountId: "closing" } });
const inventoryServices = { firestore: database, auth, now: () => revisionTime.toMillis() };
const procurementServices = { firestore: database, auth, now: () => Date.parse("2026-10-12T10:00:00Z") };
const imageServices = { firestore: database, auth, bucket };
const aiServices = { firestore: database, auth, bucket };
const aiUpload = { hotelUid: "restore-hotel-a", supplierId: "restore-dairy", requestId: "restore-ai-unknown", fileName: "offers.csv", mimeType: "text/csv", reviewWorkspaceVersion: "1", importSettings: JSON.stringify({ policyVersion: 2, priceBasis: "net", currency: "EUR", vatRate: null }) };
const aiBytes = Buffer.from("SKU,Name,Price\nRESTORE-MILK6,Fictional milk,15\n");
const aiRequest = (authTime) => ({ auth: { uid: "restore-a", token: { email_verified: true, auth_time: authTime } } });
const jsonData = (value) => JSON.parse(JSON.stringify(value));
async function seedUnknownAiImport() {
  const authTime = Math.floor(Date.now() / 1000); let paid = 0;
  const services = { ...aiServices, provider: { countInput: async () => 500, respond: async () => { paid++; throw new Error("Fictional lost paid response"); } } };
  const job = await uploadSupplierAiImport(aiRequest(authTime), aiUpload, aiBytes, services);
  await runSupplierAiImportJob(aiUpload.hotelUid, job.jobId, services); assert.equal(paid, 1);
  const root = `hotels/${aiUpload.hotelUid}`, jobPath = `${root}/supplierAiImportJobs/${job.jobId}`;
  const stored = (await database.doc(jobPath).get()).data(), attempts = await database.collection(`${jobPath}/attempts`).get();
  const paths = [jobPath, `${root}/supplierAiImportRequests/${aiUpload.requestId}`, `${root}/aiUsageMonths/${stored.month}`, `${root}/aiImportAdministration/state`, ...attempts.docs.map((row) => row.ref.path)];
  const records = Object.fromEntries(await Promise.all(paths.map(async (path) => [path, jsonData((await database.doc(path).get()).data())])));
  const [metadata] = await bucket.file(stored.source.path).getMetadata();
  assert.equal(stored.status, "response_unknown"); assert.ok(stored.reservedCostMicros > 0);
  return { jobId: job.jobId, authTime, records, source: { path: stored.source.path, generation: metadata.generation, sha256: bytesHash(aiBytes) } };
}
async function verifyUnknownAiImport(proof) {
  for (const [path, data] of Object.entries(proof.records)) assert.deepEqual(jsonData((await database.doc(path).get()).data()), data, `AI accounting restore differs: ${path}`);
  const [metadata] = await bucket.file(proof.source.path).getMetadata();
  assert.equal(metadata.generation, proof.source.generation); assert.equal(bytesHash((await bucket.file(proof.source.path).download())[0]), proof.source.sha256);
  let calls = 0; const forbidden = { ...aiServices, provider: { countInput: async () => { calls++; throw new Error("Restore must never initiate provider work"); }, respond: async () => { calls++; throw new Error("Restore must never rebill"); } } };
  // Auth restoration may advance the valid-after watermark. Simulate a fresh
  // sign-in instead of weakening current-account authorization for old tokens.
  const user = await auth.getUser("restore-a");
  const freshAuthTime = Math.ceil(Math.max(Date.now(), Date.parse(user.tokensValidAfterTime) || 0) / 1000);
  if (proof.authTime * 1000 < Date.parse(user.tokensValidAfterTime)) await assert.rejects(readSupplierAiImport(aiRequest(proof.authTime), { hotelUid: aiUpload.hotelUid, jobId: proof.jobId }, forbidden), (error) => error.code === "permission-denied");
  const status = await readSupplierAiImport(aiRequest(freshAuthTime), { hotelUid: aiUpload.hotelUid, jobId: proof.jobId }, forbidden);
  assert.equal(status.status, "response_unknown");
  assert.doesNotMatch(JSON.stringify(status), /"(?:usage|configuration|model|inputTokens|outputTokens|priceVersion|actualCostUsd|knownCostUsd|reservedCostUsd|maxCostPerImportUsd)"/);
  const restored = (await database.doc(`hotels/${aiUpload.hotelUid}/supplierAiImportJobs/${proof.jobId}`).get()).data();
  assert.ok(restored.reservedCostMicros > 0); assert.equal(restored.unknownCalls, 1);
  const restoredAttempt = (await database.doc(`hotels/${aiUpload.hotelUid}/supplierAiImportJobs/${proof.jobId}/attempts/chunk-0000`).get()).data();
  assert.equal(restoredAttempt.costMicros, null); assert.equal(restoredAttempt.inputTokens, null); assert.equal(restoredAttempt.outputTokens, null);
  await runSupplierAiImportJob(aiUpload.hotelUid, proof.jobId, forbidden);
  const replay = await uploadSupplierAiImport(aiRequest(freshAuthTime), aiUpload, aiBytes, forbidden);
  assert.equal(replay.jobId, proof.jobId); assert.equal(replay.status, "response_unknown"); assert.equal(calls, 0);
  for (const [path, data] of Object.entries(proof.records)) assert.deepEqual(jsonData((await database.doc(path).get()).data()), data, `Restore replay changed AI receipt: ${path}`);
}
const aiMappingScope = { hotelUid: "restore-hotel-a", supplierId: "restore-dairy", sourceFormat: "csv", profileId: "default" };
const aiMappingCommand = { ...aiMappingScope, requestId: "restore-purchase-units", expectedRevision: 0,
  mappings: [{ sourceUnit: "FL", purchaseUnit: "Bottle" }, { sourceUnit: "TR", purchaseUnit: "Tray" }] };
const recurringFormatScope = { ...aiMappingScope, profileId: "recurring-price-list" };
const recurringFormatCommand = { ...recurringFormatScope, requestId: "restore-recurring-format", expectedRevision: 0,
  mappings: [], interpretation: { version: 1, header: ["SKU", "Name", "Net Price", "Pack count", "Content", "Unit", "Valid from"], sheetName: null,
    columns: { supplierSku: 0, supplierProductName: 1, pricePerPurchaseUnit: 2, packCount: 3, contentQuantity: 4, contentUnit: 5, priceValidFrom: 6 },
    defaults: { currency: "EUR", priceBasis: "net", pricingModel: "Per Purchase Unit" }, assortmentMode: "partial", documentPurpose: "price-list",
    decimalSeparator: ".", dateFormat: "YYYY-MM-DD" } };
const reviewedAiUpload = { ...aiUpload, requestId: "restore-ai-reviewed", reviewWorkspaceVersion: "1", recurringImportVersion: "1" };
const reviewedAiBytes = Buffer.from("SKU,Name,Net Purchase Price,Currency,Purchase Unit,Package Content\nRESTORE-MILK6,Fictional milk six-pack,18,EUR,FL,6000\n");
const reviewedFormatCommand = { ...aiMappingScope, requestId: "restore-reviewed-format", expectedRevision: 1, mappings: [],
  interpretation: { version: 1, header: ["SKU", "Name", "Net Purchase Price", "Currency", "Purchase Unit", "Package Content"], sheetName: null,
    columns: { supplierSku: 0, supplierProductName: 1, pricePerPurchaseUnit: 2, currency: 3, purchaseUnit: 4, baseUnitsPerPurchaseUnit: 5 },
    defaults: { baseUnit: "ml", priceBasis: "net" }, assortmentMode: "partial", documentPurpose: "price-list", decimalSeparator: ".", dateFormat: "YYYY-MM-DD" } };
async function reviewRecords(jobId) {
  const root = `hotels/${aiUpload.hotelUid}`, jobRef = database.doc(`${root}/supplierAiImportJobs/${jobId}`);
  const records = {};
  async function collect(reference) {
    const snapshot = await reference.get(); if (snapshot.exists) records[reference.path] = jsonData(snapshot.data());
    for (const collection of await reference.listCollections()) for (const row of (await collection.get()).docs) await collect(row.ref);
  }
  await collect(jobRef);
  await collect(database.doc(`${root}/supplierAiImportRequests/${reviewedAiUpload.requestId}`));
  await collect(mappingProfileRef(database, aiUpload.hotelUid, mappingScope(aiMappingScope)));
  const operationId = `m-${digest("restore-a", aiMappingCommand.requestId).slice(0, 48)}`;
  for (const collection of ["supplierImportMappingOperations", "supplierImportMappingAudit"]) await collect(database.doc(`${root}/${collection}/${operationId}`));
  await collect(mappingProfileRef(database, aiUpload.hotelUid, mappingScope(recurringFormatScope)));
  const formatOperationId = `m-${digest("restore-a", recurringFormatCommand.requestId).slice(0, 48)}`;
  for (const collection of ["supplierImportMappingOperations", "supplierImportMappingAudit"]) await collect(database.doc(`${root}/${collection}/${formatOperationId}`));
  const reviewedFormatOperationId = `m-${digest("restore-a", reviewedFormatCommand.requestId).slice(0, 48)}`;
  for (const collection of ["supplierImportMappingOperations", "supplierImportMappingAudit"]) await collect(database.doc(`${root}/${collection}/${reviewedFormatOperationId}`));
  return records;
}
async function seedReviewedAiImport() {
  const authTime = Math.floor(Date.now() / 1000), actor = aiRequest(authTime); let paid = 0;
  const mappings = await saveHotelSupplierPurchaseUnitMappingHandler({ ...actor, data: aiMappingCommand }, aiServices);
  assert.equal(mappings.revision, 1);
  const format = await saveHotelSupplierPurchaseUnitMappingHandler({ ...actor, data: recurringFormatCommand }, aiServices);
  assert.equal(format.revision, 1); assert.equal(format.interpretation.documentPurpose, "price-list");
  const services = { ...aiServices, provider: { countInput: async () => 500, respond: async (body) => {
    paid++;
    const source = JSON.parse(body.input[0].content[0].text).units.find((unit) => unit.text.includes("RESTORE-MILK6"));
    assert.ok(source);
    const row = { supplierSku: "RESTORE-MILK6", supplierProductName: "Fictional milk six-pack", currency: "EUR", pricingModel: "Per Purchase Unit",
      purchaseUnit: "FL", baseUnit: "ml", priceBasis: "net", gtin: null, priceValidFrom: null, priceValidUntil: null,
      pricePerBaseUnit: null, pricePerPurchaseUnit: 18, baseUnitsPerPurchaseUnit: 6000, vatRate: null,
      sourceAnchors: [{ sourceId: source.sourceId, quote: "RESTORE-MILK6" }] };
    return { id: "fictional-restore-reviewed-response", model: "gpt-6-luna", status: "completed",
      usage: { input_tokens: 500, output_tokens: 100, total_tokens: 600 },
      output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ rows: [row] }) }] }] };
  } } };
  const job = await uploadSupplierAiImport(actor, reviewedAiUpload, reviewedAiBytes, services);
  assert.equal((await runSupplierAiImportJob(aiUpload.hotelUid, job.jobId, services)).status, "review"); assert.equal(paid, 1);
  const confirmed = await saveHotelSupplierPurchaseUnitMappingHandler({ ...actor, data: reviewedFormatCommand }, aiServices);
  assert.equal(confirmed.revision, 2);
  const formatApplication = { hotelUid: aiUpload.hotelUid, jobId: job.jobId, requestId: "restore-apply-format", expectedMappingRevision: 2 };
  const appliedFormat = await applyHotelSupplierImportFormatHandler({ ...actor, data: formatApplication }, aiServices);
  assert.equal(appliedFormat.completed, true);
  const row = (await readHotelSupplierAiImportRowsHandler({ ...actor, data: { hotelUid: aiUpload.hotelUid, jobId: job.jobId } }, aiServices)).rows[0];
  assert.equal(row.product.purchaseUnit, "Bottle"); assert.equal(row.product.baseUnitsPerPurchaseUnit, 6000);
  const decision = { hotelUid: aiUpload.hotelUid, jobId: job.jobId, requestId: "restore-approve-product", bulk: false,
    rows: [{ rowId: row.rowId, reviewRevision: row.reviewRevision, action: "approve", acknowledged: true }] };
  const outcome = await decideHotelSupplierAiImportRowsHandler({ ...actor, data: decision }, aiServices);
  const stored = (await database.doc(`hotels/${aiUpload.hotelUid}/supplierAiImportJobs/${job.jobId}`).get()).data();
  assert.equal(stored.importReviewVersion, 1);
  assert.equal((await database.doc(`hotels/${aiUpload.hotelUid}/supplierAiImportJobs/${job.jobId}/rows/${row.rowId}`).get()).data().review.status, "approved");
  const [metadata] = await bucket.file(stored.source.path).getMetadata();
  const resultObjects = [];
  for (const attempt of (await database.collection(`hotels/${aiUpload.hotelUid}/supplierAiImportJobs/${job.jobId}/attempts`).get()).docs) {
    const result = attempt.data().result;
    if (result?.path) {
      const [resultMetadata] = await bucket.file(result.path).getMetadata();
      resultObjects.push({ path: result.path, generation: resultMetadata.generation,
        sha256: bytesHash((await bucket.file(result.path).download())[0]) });
    }
  }
  return { jobId: job.jobId, decision, outcome, formatApplication, appliedFormat, formatSource: stored.sourceFormatObject, records: await reviewRecords(job.jobId),
    source: { path: stored.source.path, generation: metadata.generation, sha256: bytesHash(reviewedAiBytes) }, resultObjects };
}
async function verifyReviewedAiImport(proof) {
  assert.deepEqual(await reviewRecords(proof.jobId), proof.records, "Restored mapping snapshots, approved rows, decision receipts and original paid attempts must match exported evidence.");
  const user = await auth.getUser("restore-a"), authTime = Math.ceil(Math.max(Date.now(), Date.parse(user.tokensValidAfterTime) || 0) / 1000), actor = aiRequest(authTime);
  let calls = 0; const services = { ...aiServices, provider: {
    countInput: async () => { calls++; throw new Error("Restore must not initiate provider work"); },
    respond: async () => { calls++; throw new Error("Restore must not repeat paid work"); } } };
  const rowRef = database.doc(`hotels/${aiUpload.hotelUid}/supplierAiImportJobs/${proof.jobId}/rows/${proof.decision.rows[0].rowId}`);
  const before = await rowRef.get();
  const profile = await readHotelSupplierPurchaseUnitMappingsHandler({ ...actor, data: aiMappingScope }, services);
  assert.equal(profile.revision, 2); assert.deepEqual(profile.mappings, aiMappingCommand.mappings);
  const format = await readHotelSupplierPurchaseUnitMappingsHandler({ ...actor, data: recurringFormatScope }, services);
  assert.equal(format.revision, 1); assert.deepEqual(format.interpretation, recurringFormatCommand.interpretation);
  assert.deepEqual(await saveHotelSupplierPurchaseUnitMappingHandler({ ...actor, data: recurringFormatCommand }, services),
    proof.records[`hotels/${aiUpload.hotelUid}/supplierImportMappingOperations/m-${digest("restore-a", recurringFormatCommand.requestId).slice(0, 48)}`].result);
  assert.deepEqual(await saveHotelSupplierPurchaseUnitMappingHandler({ ...actor, data: aiMappingCommand }, services),
    proof.records[`hotels/${aiUpload.hotelUid}/supplierImportMappingOperations/m-${digest("restore-a", aiMappingCommand.requestId).slice(0, 48)}`].result);
  assert.deepEqual(await saveHotelSupplierPurchaseUnitMappingHandler({ ...actor, data: reviewedFormatCommand }, services),
    proof.records[`hotels/${aiUpload.hotelUid}/supplierImportMappingOperations/m-${digest("restore-a", reviewedFormatCommand.requestId).slice(0, 48)}`].result);
  assert.deepEqual(await applyHotelSupplierImportFormatHandler({ ...actor, data: proof.formatApplication }, services), proof.appliedFormat);
  const [formatMetadata] = await bucket.file(proof.formatSource.path).getMetadata();
  assert.equal(formatMetadata.generation, proof.formatSource.generation);
  assert.equal(bytesHash((await bucket.file(proof.formatSource.path).download())[0]), proof.formatSource.sha256);
  const workspace = await readHotelSupplierAiImportWorkspaceHandler({ ...actor, data: { hotelUid: aiUpload.hotelUid, jobId: proof.jobId, filter: "approved", includeIndex: true } }, services);
  assert.equal(workspace.rows.length, 1); assert.equal(workspace.rows[0].review.status, "approved");
  assert.deepEqual(await decideHotelSupplierAiImportRowsHandler({ ...actor, data: proof.decision }, services), proof.outcome);
  assert.equal((await rowRef.get()).updateTime.isEqual(before.updateTime), true);
  await runSupplierAiImportJob(aiUpload.hotelUid, proof.jobId, services);
  const replay = await uploadSupplierAiImport(actor, reviewedAiUpload, reviewedAiBytes, services); assert.equal(replay.jobId, proof.jobId); assert.equal(calls, 0);
  const [metadata] = await bucket.file(proof.source.path).getMetadata(); assert.equal(metadata.generation, proof.source.generation);
  assert.equal(bytesHash((await bucket.file(proof.source.path).download())[0]), proof.source.sha256);
  assert.ok(proof.resultObjects.length > 0, "A restored reviewed import must preserve its successful original AI result bytes.");
  for (const result of proof.resultObjects) {
    const [resultMetadata] = await bucket.file(result.path).getMetadata(); assert.equal(resultMetadata.generation, result.generation);
    assert.equal(bytesHash((await bucket.file(result.path).download())[0]), result.sha256);
  }
  assert.deepEqual(await reviewRecords(proof.jobId), proof.records, "An exact restored approval or mapping replay must not rewrite original source, review, mapping or billing receipts.");
}
let imageRulesEnvironment;
// A temporary test proof survives the two emulator processes; it is not hotel
// data, and contains only fictional fixture payloads and timestamp evidence.
const procurementProofPath = join(tmpdir(), `hotelsuite-restore-proof-${digest(import.meta.url, projectId).slice(0, 16)}.json`);
const procurementRequest = (fixture, data) => ({ auth: { uid: fixture.actorUid, token: { email_verified: true } }, data: { hotelUid: fixture.hotelUid, ...data } });
const offerInput = (fixture, price) => ({ supplierId: "restore-dairy", supplierSku: "RESTORE-MILK6", supplierProductName: "Fictional milk six-pack",
  currency: fixture.currency, pricingModel: "Per Purchase Unit", pricePerBaseUnit: null, pricePerPurchaseUnit: price,
  baseUnit: "ml", purchaseUnit: "Case", baseUnitsPerPurchaseUnit: 6000, catalogProductId: "milk", active: true,
  priceBasis: "net", vatRate: null, purchaseOptions: [], priceValidFrom: "2026-10-01", priceValidUntil: "2026-10-31" });
const offerCommand = (fixture, action) => ({ action, productId: "restore-priced-milk", expectedRevision: action === "create" ? 0 : 1,
  requestId: `restore-price-${action}`, product: offerInput(fixture, action === "create" ? 12 : 15) });
const futurePriceCommand = (fixture) => ({ action: "update", productId: "restore-priced-milk", expectedRevision: 2,
  requestId: "restore-future-price", product: { ...offerInput(fixture, 21), priceValidFrom: "2026-11-01", priceValidUntil: "2026-11-30" } });
async function verifyScheduledPrice(fixture) {
  const product = (await database.doc(`hotels/${fixture.hotelUid}/supplierproducts/restore-priced-milk`).get()).data();
  assert.equal(product.pricePerPurchaseUnit, 15, "A scheduled price must not replace the current October agreement.");
  const found = await database.collection(`hotels/${fixture.hotelUid}/supplierPriceVersions/restore-priced-milk/entries`).get();
  const versions = found.docs.map((document) => ({ ...document.data(), id: document.id }));
  assert.equal(versions.length, 3);
  const current = resolveSupplierPriceVersion(product, versions, { orderDate: "2026-10-12", pricingDateBasis: "order-date" });
  const scheduled = resolveSupplierPriceVersion(product, versions, { orderDate: "2026-10-12", deliveryDate: "2026-11-02", pricingDateBasis: "delivery-date" });
  assert.equal(current.product.pricePerPurchaseUnit, 15); assert.equal(current.hasScheduledVersions, true);
  assert.equal(scheduled.product.pricePerPurchaseUnit, 21); assert.equal(scheduled.priceValidity, "current");
}
const adjustmentCommand = (fixture, kind, reasonType = null) => ({ requestId: `restore-${reasonType || kind}`, expectedActorUid: fixture.actorUid,
  kind, reasonType, catalogProductId: "milk", quantity: kind === "transfer" ? 6 : reasonType === "waste" ? 3 : reasonType === "breakage" ? 1 : 2,
  sourceLocationId: "movements-store", destinationLocationId: kind === "transfer" ? "movements-bar" : null,
  businessDate: "2026-10-05", note: `Fictional ${reasonType || kind} evidence`, reference: `RESTORE-${reasonType || kind}`,
  netUnitCost: reasonType === "waste" ? null : 2.5, currency: reasonType === "waste" ? null : fixture.currency });
const transferId = (fixture) => `a-${digest(fixture.actorUid, fixture.hotelUid, "restore-transfer").slice(0, 48)}`;
const reverseCommand = (fixture) => ({ adjustmentId: transferId(fixture), requestId: "restore-reverse-transfer", expectedActorUid: fixture.actorUid,
  businessDate: "2026-10-06", note: "Fictional compensating correction", reference: "RESTORE-CORRECTION" });
const periodV2Request = (fixture, locationId) => procurementRequest(fixture, { locationId,
  openingStockCountId: "adjustment-opening", closingStockCountId: "adjustment-closing", reportPolicyVersion: 2 });
const documents = {
  "platformConfiguration/saasProcurement": { enabled: true, rulesVersion: createRequire(import.meta.url)("../../functions/src/platformReleasePolicy.json").saasRulesVersion },
  "platformConfiguration/aiSupplierProductImport": { ...DEFAULT_AI_CONFIGURATION, enabled: true },
  "hotels/restore-hotel-a": { name: "Fictional hotel A", timeZone: "Europe/Brussels" },
  "hotels/restore-hotel-b": { name: "Fictional hotel B", timeZone: "Europe/London" },
  "users/restore-platform": { firstName: "Fictional operator", hotelUid: [], accessRevision: 0 },
  "platformSupportSessions/restore-session": { actorUid: "restore-platform", hotelUid: "restore-hotel-a", state: "active", reason: "Fictional diagnosis", expiresAt: revisionTime },
  "platformAudit/restore-audit": { hotelUid: "restore-hotel-a", actorUid: "restore-platform", action: "support-started", createdAt: revisionTime },
  "hotels/restore-hotel-a/platformAudit/restore-audit": { hotelUid: "restore-hotel-a", actorUid: "restore-platform", action: "support-started", createdAt: revisionTime },
  "platformIncidents/restore-incident": { hotelUid: "restore-hotel-a", state: "open", code: "overdue", acknowledgedBy: "restore-platform", lastDetectedAtMillis: revisionTime.toMillis() },
  "hotels/restore-hotel-a/importTelemetry/restore-run": { runId: "restore-run", fileType: "arrivals", status: "failed", writtenCount: null, receivedAtMillis: revisionTime.toMillis(), updatedAtMillis: revisionTime.toMillis() },
  "hotels/restore-hotel-a/importRecovery/restore-recovery": { runId: "restore-run", actorUid: "restore-platform", state: "failed", startedAtMillis: revisionTime.toMillis() },
  "users/restore-a": { firstName: "Fictional", lastName: "A", hotelUid: ["restore-hotel-a"], accessRevision: 2 },
  "users/restore-b": { firstName: "Fictional", lastName: "B", hotelUid: ["restore-hotel-b"], accessRevision: 1 },
  "users/restore-b-counter": { firstName: "Fictional", lastName: "Counter B", hotelUid: ["restore-hotel-b"], accessRevision: 1 },
  "hotels/restore-hotel-a/members/restore-a": { permissions: ["orders.read", "orders.receive", "orders.finalize", "stockcounts.read", "catalogproducts.read", "users.read", "users.create", "users.update", "users.delete"], hotelAdmin: true, moduleRoles: { procurement: ["receiving-supervisor"] }, additionalPermissions: [], rolePolicyVersion: 1, revision: 2 },
  "hotels/restore-hotel-a/memberAdministration/state": { revision: 4, updatedAt: revisionTime, updatedBy: "restore-a" },
  "hotels/restore-hotel-a/accessAudit/member-a": { action: "update-member", uid: "restore-a", actorUid: "restore-a", hotelAdmin: true, revision: 2, createdAt: revisionTime },
  "hotels/restore-hotel-a/settings/bootstrap": { hotelName: "Fictional hotel A", currency: "EUR" },
  "hotels/restore-hotel-a/settings/propertySettings": { hotelRooms: 100 },
  "hotels/restore-hotel-b/members/restore-b": { permissions: ["orders.read"], enabled: true },
  "hotels/restore-hotel-b/members/restore-b-counter": { permissions: ["stockcounts.read"], revision: 1 },
  "hotelSubscriptions/restore-hotel-a": { status: "active", validUntil: subscriptionExpiry, modules: ["procurement", "groups", "contracts", "revenue"], modulePolicyVersion: 1, seatLimit: null, revision: 3 },
  "hotelSubscriptions/restore-hotel-b": { status: "trialing", validUntil: subscriptionExpiry, modules: ["procurement", "contracts"], modulePolicyVersion: 1, seatLimit: 10, revision: 1 },
  "hotels/restore-hotel-a/orders/order-a": { status: "Finalized", revision: 4, total: 42.5, updatedAt: revisionTime },
  "hotels/restore-hotel-a/orderAudit/audit-a": { orderId: "order-a", actorUid: "restore-a", action: "finalize", revision: 4, createdAt: revisionTime },
  "hotels/restore-hotel-a/orders/receiving-a": { status: "Finalized", revision: 3, totalAmount: 36, currency: "EUR",
    products: [{ supplierProductId: "coffee", supplierProductName: "Fictional coffee", purchaseUnit: "box", qtyPurchaseUnits: 3, pricePerPurchaseUnit: 12 }],
    receiving: { policyVersion: 1, state: "closed", eventCount: 2, lines: receivingLines, finalizationReason: "Rejected box replaced", closedWithShortfall: false } },
  [`hotels/restore-hotel-a/orders/receiving-a/receipts/${receiptId}`]: { policyVersion: 1, kind: "receipt", hotelUid: "restore-hotel-a", orderId: "receiving-a",
    actorUid: "restore-a", deliveryReference: "RESTORE-DN", receivedOn: "2023-11-14", revision: 2, createdAt: revisionTime,
    note: "", fingerprint: digest("receipt", 1, receivingDetails), result: receivingResult,
    lines: [{ supplierProductId: "coffee", productName: "Fictional coffee", purchaseUnit: "box", acceptedQuantity: 3, rejectedQuantity: 1, reason: "Damaged packaging" }] },
  "hotels/restore-hotel-a/orders/receiving-a/receipts/final-a": { policyVersion: 1, kind: "finalization", hotelUid: "restore-hotel-a", orderId: "receiving-a",
    actorUid: "restore-a", reason: "Rejected box replaced", acceptShortfall: false, revision: 3, createdAt: revisionTime },
  [`hotels/restore-hotel-a/orders/receiving-a/receiptReferences/${digest("restore-dn")}`]: { eventId: receiptId, createdAt: revisionTime },
  "hotels/restore-hotel-a/groups/group-a": { arrival: "2026-10-10", departure: "2026-10-12", roomTypeDays, roomingListToken: roomingToken, roomingListStatus: "Submitted" },
  [`roomingListLinks/${roomingToken}`]: { hotelUid: "restore-hotel-a", groupId: "group-a", groupName: "Fictional group", arrival: "2026-10-10", departure: "2026-10-12", roomTypeDays, roomTypes: ["DBL"], reservations, status: "Submitted", currentVersionNumber: 2, revision: 5, activeRequestId: null, changeRequestNumber: 1, publicAccessEnabled: true, publicAccessExpiresAt: subscriptionExpiry, createdBy: "restore-a", createdAt: revisionTime, updatedAt: revisionTime },
  [`roomingListLinks/${roomingToken}/versions/2`]: { number: 2, status: "Official", reservations, sourceRequestId: "change-a", createdAt: "2026-10-01T00:00:00Z" },
  [`roomingListLinks/${roomingToken}/changeRequests/change-a`]: { number: 1, status: "Approved", baseVersionNumber: 1, reservations, approvedBy: "restore-a", approvedVersionNumber: 2, approvedAt: "2026-10-01T00:00:00Z" },
  "hotels/restore-hotel-a/quotes/quote-a": { revision: 2, analysisStatus: "CURRENT", analysisModelVersion: "historical-fixture", contributionModelVersion: "historical-fixture", analysisContributionSnapshot: { economicFloorRateInclVat: 150, totalRequestedGroupRoomNights: 20 } },
  "hotels/restore-hotel-a/contracts/contract-a": { revision: 1, contractName: "Fictional contract", contractFiles: [{ fileId: attachmentA, fileName: "fixture.pdf", filePath: `private/contracts/restore-hotel-a/contract-a/${attachmentA}`, size: objects[`private/contracts/restore-hotel-a/contract-a/${attachmentA}`].length }] },
  [`hotels/restore-hotel-a/contractAttachments/${attachmentA}`]: { contractId: "contract-a", status: "attached", requestId: "restore-operation" },
  "hotels/restore-hotel-b/settings/bootstrap": { hotelName: "Fictional hotel B", currency: "GBP" },
  "hotels/restore-hotel-b/orders/order-a": { status: "Created", revision: 1, total: 9 },
  "hotels/restore-hotel-b/contracts/contract-b": { revision: 1, contractName: "Fictional contract B", contractFiles: [{ fileId: attachmentB, fileName: "fixture-b.pdf", filePath: `private/contracts/restore-hotel-b/contract-b/${attachmentB}`, size: objects[`private/contracts/restore-hotel-b/contract-b/${attachmentB}`].length }] },
  [`hotels/restore-hotel-b/contractAttachments/${attachmentB}`]: { contractId: "contract-b", status: "attached", requestId: "restore-operation-b" },
};
for (const fixture of inventoryFixtures) {
  const { hotelUid, currency, actorUid } = fixture;
  const root = `hotels/${hotelUid}`;
  documents[`${root}/locations/store`] = { name: "Fictional physical store" };
  documents[`${root}/catalogproducts/milk`] = { name: "Fictional milk", baseUnit: "l", inventoryTracked: true, active: true, productPolicyVersion: 1 };
  documents[`${root}/inventoryLocationStates/store`] = { inventoryPolicyVersion: 1, sequence: 3,
    latestCheckpointId: checkpointId("closing", "store"), latestCheckpointBusinessDate: "2026-10-10", updatedAt: revisionTime };
  for (const [stockCountId, sequence, businessDate, quantity, unitCost] of [
    ["opening", 1, "2026-10-01", 100, 2], ["closing", 3, "2026-10-10", 80, null],
  ]) {
    const countedItem = { catalogProductId: "milk", catalogProductName: "Fictional milk", baseUnit: "l", currency,
      quantity, unitCost, isCounted: true, totalValue: unitCost == null ? null : quantity * unitCost,
      costSource: unitCost == null ? "unknown" : "operator-opening-estimate" };
    const checkpoint = checkpointId(stockCountId, "store");
    documents[`${root}/stockCounts/${stockCountId}`] = { name: `Fictional ${stockCountId} count`, inventoryPolicyVersion: 1,
      status: "Finished", revision: 2, currency, businessDate, locations: [{ locationId: "store", status: "Finished" }], finishedAt: revisionTime };
    documents[`${root}/stockCounts/${stockCountId}/locations/store`] = { locationId: "store", inventoryPolicyVersion: 1,
      status: "Finished", revision: 1, currency, businessDate, checkpointId: checkpoint, checkpointSequence: sequence,
      stockTemplate: { id: "fixture", name: "Fictional template", items: [{ catalogProductId: "milk", catalogProductName: "Fictional milk", baseUnit: "l", currency, unitCost: null }] },
      countedItems: [countedItem], countedValue: countedItem.totalValue, finishedAt: revisionTime };
    documents[`${root}/inventoryCheckpoints/${checkpoint}`] = { id: checkpoint, inventoryPolicyVersion: 1, hotelUid,
      locationId: "store", stockCountId, stockCountName: `Fictional ${stockCountId} count`, businessDate, currency, sequence,
      items: [{ catalogProductId: "milk", catalogProductName: "Fictional milk", baseUnit: "l", quantity, unitCost }],
      coverageIssues: [], actorUid, finishedAt: revisionTime };
  }
  documents[`${root}/inventoryMovements/fixture-receipt`] = { id: "fixture-receipt", inventoryPolicyVersion: 1,
    kind: "receipt", hotelUid, locationId: "store", orderId: "fixture-inventory-order", receiptId: "fixture-inventory-receipt",
    receivedOn: "2026-10-05", sequence: 2, actorUid, coverageGaps: [], backdatedAgainstCheckpoint: false, postedAt: revisionTime,
    lines: [{ catalogProductId: "milk", catalogProductName: "Fictional milk", baseUnit: "l", quantity: 30, netUnitCost: 3, netValue: 90, currency }] };
  documents[`${root}/members/${actorUid}`].permissions.push("catalogproducts.read", "catalogproducts.create", "catalogproducts.update", "catalogsettings.read", "catalogsettings.update", "supplierproducts.read", "supplierproducts.create", "supplierproducts.update", "suppliers.read", "inventorymovements.read", "inventorymovements.create", "inventorymovements.reverse", "orders.read", "orders.recordconfirmation", "orders.reviewconfirmation", "orders.receive");
  documents[`${root}/suppliers/restore-dairy`] = { name: "Fictional dairy supplier", active: true };
  for (const location of ["movements-store", "movements-bar"]) documents[`${root}/locations/${location}`] = { name: `Fictional ${location}`, active: true };
}

async function finishAdjustmentCheckpoints(fixture, phase) {
  const stockCountId = `adjustment-${phase}`, businessDate = phase === "opening" ? "2026-10-01" : "2026-10-10";
  const quantities = phase === "opening" ? [100, 0] : [90, 0];
  await database.doc(`hotels/${fixture.hotelUid}/stockCounts/${stockCountId}`).set({ name: `Fictional ${stockCountId}`, status: "Finished",
    inventoryPolicyVersion: 1, currency: fixture.currency, businessDate, revision: 2,
    locations: [{ locationId: "movements-store", status: "Finished" }, { locationId: "movements-bar", status: "Finished" }] });
  await database.runTransaction(async (tx) => {
    const prepared = await Promise.all(["movements-store", "movements-bar"].map(async (locationId, index) => {
      const countingStartedSequence = await readLocationSequence(database, tx, fixture.hotelUid, locationId);
      return prepareCheckpoint(database, tx, { hotelUid: fixture.hotelUid, locationId, stockCountId, stockCountName: `Fictional ${stockCountId}`,
        businessDate, currency: fixture.currency, actorUid: fixture.actorUid, countingStartedSequence,
        items: [{ catalogProductId: "milk", catalogProductName: "Fictional milk", baseUnit: "l", quantity: quantities[index], unitCost: index === 0 ? 2.5 : null }] });
    }));
    for (const entry of prepared) entry.write();
  });
}
function verifyV2(result, fixture, locationId) {
  assert.equal(result.hotelUid, fixture.hotelUid); assert.equal(result.currency, fixture.currency); assert.equal(result.reportPolicyVersion, 2);
  const row = result.items[0]; assert.equal(row.netReceiptQuantity, 0); assert.equal(row.transferInQuantity, 0); assert.equal(row.transferOutQuantity, 0);
  assert.equal(row.wasteQuantity, locationId === "movements-store" ? 3 : 0); assert.equal(row.breakageQuantity, locationId === "movements-store" ? 1 : 0);
  assert.equal(row.physicalReturnQuantity, locationId === "movements-store" ? 2 : 0); assert.equal(row.residualQuantity, locationId === "movements-store" ? 4 : 0);
  assert.equal(row.residualValue, locationId === "movements-store" ? null : 0); assert.equal(result.coverage.costComplete, locationId === "movements-bar");
  assert.equal(result.coverage.quantityComplete, true); assert.equal(result.currentlyComplete, true);
}
function canonical(value) {
  if (value == null || typeof value !== "object") return value;
  if (typeof value.toJSON === "function") return canonical(value.toJSON());
  if (Array.isArray(value)) return value.map(canonical);
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}
const confirmationOrderId = "supplier-confirmed-order";
const confirmationCommand = (fixture) => ({ orderId: confirmationOrderId, expectedActorUid: fixture.actorUid, expectedRevision: 1, requestId: "restore-supplier-response",
  response: { responseType: "changes-proposed", channel: "email", supplierReference: "RESTORE-SUPPLIER-REPLY", respondedOn: "2026-10-12", note: "", lines: [
    { supplierProductId: "restore-priced-milk", orderLineId: "milk-case", confirmedQuantity: 2, deliveryDate: "2026-10-13", priceMode: "quoted", pricePerPurchaseUnit: 18, substitute: null, reason: "Supplier revised the net package price" }] } });
const confirmationId = (fixture) => `sc-${digest(confirmationOrderId, fixture.actorUid, "restore-supplier-response").slice(0, 48)}`;
const confirmationReview = (fixture) => ({ orderId: confirmationOrderId, expectedActorUid: fixture.actorUid, expectedRevision: 2, requestId: "restore-supplier-review",
  review: { responseId: confirmationId(fixture), decision: "accept", reason: "Reviewed supplier's new package price" } });
const confirmedReceipt = () => ({ orderId: confirmationOrderId, expectedRevision: 3, requestId: "restore-confirmed-receipt", supplierPricingPolicyVersion: 1,
  receivedOn: "2026-10-12", deliveryReference: "RESTORE-CONFIRMED-DN", inventoryLocationId: "confirmed-store", lines: [{ supplierProductId: "restore-priced-milk", orderLineId: "milk-case", acceptedQuantity: 1, rejectedQuantity: 0 }] });
async function supplierConfirmationReplay(fixture) {
  const result = await recordHotelSupplierConfirmationHandler(procurementRequest(fixture, confirmationCommand(fixture)), procurementServices);
  assert.equal(result.eventId, confirmationId(fixture));
  await reviewHotelSupplierConfirmationHandler(procurementRequest(fixture, confirmationReview(fixture)), procurementServices);
  const receipt = await recordConfirmedReceipt(procurementRequest(fixture, confirmedReceipt()), procurementServices);
  const movement = (await database.doc(`hotels/${fixture.hotelUid}/inventoryMovements/${receipt.eventId}`).get()).data();
  assert.equal(movement.lines[0].quantity, 6); assert.equal(movement.lines[0].netValue, 18); assert.equal(movement.lines[0].currency, fixture.currency);
  const response = await getHotelSupplierConfirmationsHandler(procurementRequest(fixture, { orderId: confirmationOrderId }), procurementServices);
  assert.equal(response.current.reviewState, "accepted"); assert.equal(response.events.length, 2);
}
async function seedSupplierConfirmation(fixture) {
  const root = `hotels/${fixture.hotelUid}`;
  await database.doc(`${root}/locations/confirmed-store`).set({ name: "Fictional supplier-confirmed receiving store" });
  await database.doc(`${root}/orders/${confirmationOrderId}`).set({ status: "Ordered", dispatchStatus: "sent", dispatchRequestId: "restore-supplier-dispatch", revision: 1,
    supplierId: "restore-dairy", currency: fixture.currency, deliveryDate: "2026-10-13", accountNumber: "RESTORE-ACCOUNT", priceBasis: "net", totalAmount: 24,
    products: [{ supplierProductId: "restore-priced-milk", orderLineId: "milk-case", purchaseOptionId: "default", supplierProductName: "Fictional milk case", purchaseUnit: "Case of 6", qtyPurchaseUnits: 2,
      pricePerPurchaseUnit: 12, netPricePerPurchaseUnit: 12, priceBasis: "net", vatRate: null, currency: fixture.currency,
      inventoryTerms: { inventoryPolicyVersion: 1, available: true, inventoryTracked: true, catalogProductId: "milk", catalogProductName: "Fictional milk", catalogBaseUnit: "l", catalogUnitsPerPurchaseUnit: 6, netUnitCost: 2, currency: fixture.currency } }] });
  await supplierConfirmationReplay(fixture);
}
async function procurementEvidence(fixture) {
  const root = `hotels/${fixture.hotelUid}`, collections = ["productOperations", "productAudit", "productSkuKeys", "inventoryAdjustments", "inventoryAdjustmentOperations",
    "inventoryAdjustmentReversals", "inventoryMovements", "inventoryLocationStates", "inventoryCheckpoints", "inventoryPeriodReports", "supplierPriceHistory/restore-priced-milk/entries",
    "supplierPriceVersions/restore-priced-milk/entries", "supplierPriceConfirmations/restore-priced-milk/entries", "orderAudit",
    "supplierProductImages", "supplierProductImageOperations",
    ...["supplierConfirmations", "supplierConfirmationReferences", "receipts", "receiptReferences"].map((name) => `orders/${confirmationOrderId}/${name}`)];
  const rows = (await Promise.all(collections.map((name) => database.collection(`${root}/${name}`).get()))).flatMap((snapshot) => snapshot.docs);
  rows.push(await database.doc(`${root}/supplierproducts/restore-priced-milk`).get());
  rows.push(await database.doc(`${root}/orders/${confirmationOrderId}`).get());
  return Object.fromEntries(rows.map((doc) => [doc.ref.path, { data: canonical(doc.data()), updateTime: canonical(doc.updateTime) }]).sort(([left], [right]) => left.localeCompare(right)));
}

const imageRequest = (fixture) => ({ auth: { uid: fixture.actorUid, token: { email_verified: true, auth_time: Math.floor(Date.now() / 1000) } } });
const imageReadInput = (fixture, assetId, variant) => ({ hotelUid: fixture.hotelUid, productId: "restore-priced-milk", assetId, variant });
const bytesHash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const catalogSyncActor = (fixture, authTime = Math.floor(Date.now() / 1000)) => ({ auth: {
  uid: fixture.actorUid, token: { email_verified: true, auth_time: authTime },
} });
async function catalogSyncEvidence(fixture) {
  const root = `hotels/${fixture.hotelUid}`, records = {};
  async function collect(reference) {
    const snapshot = await reference.get();
    if (snapshot.exists) records[reference.path] = { data: jsonData(snapshot.data()), updateTime: jsonData(snapshot.updateTime) };
    for (const collection of await reference.listCollections()) for (const document of (await collection.get()).docs) await collect(document.ref);
  }
  for (const name of ["catalogSyncJobs", "catalogSyncOperations", "catalogSyncAudit", "catalogSkuConfiguration", "catalogSkuKeys", "catalogSkuLegacyIndex", "catalogSkuOperations", "catalogSkuAudit", "aiUsageMonths", "aiImportAdministration"]) {
    for (const document of (await database.collection(`${root}/${name}`).get()).docs) await collect(document.ref);
  }
  for (const id of ["restore-sync-six", "restore-sync-three", "restore-sync-unknown"]) await collect(database.doc(`${root}/supplierproducts/${id}`));
  for (const document of (await database.collection(`${root}/catalogproducts`).get()).docs) await collect(document.ref);
  return records;
}
async function seedCatalogSync(fixture) {
  const hotelUid = fixture.hotelUid, root = `hotels/${hotelUid}`, actor = catalogSyncActor(fixture);
  const services = { ...procurementServices, provider: { countInput: async () => 500, respond: async (body) => {
    const rows = JSON.parse(body.input[0].content[0].text).rows;
    return { id: "fictional-catalog-restore-suggestions", model: "gpt-6-luna", status: "completed", usage: { input_tokens: 500, output_tokens: 100, total_tokens: 600 },
      output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ suggestions: rows.map((row) => ({
        rowId: row.rowId, catalogProductId: null, reason: "Review the same physical milk before linking it.", specificDifferences: [],
      })) }) }] }] };
  } } };
  const settingsCommand = { hotelUid, requestId: "restore-catalog-numbering", expectedRevision: 0,
    settings: { enabled: true, prefix: fixture.hotelUid.endsWith("-a") ? "R-A-" : "R-B-", padding: 6, nextNumber: 100 } };
  const settingsResult = await saveHotelCatalogSkuSettingsHandler({ ...actor, data: settingsCommand }, services);
  await database.doc(`${root}/suppliers/restore-sync-vendor`).set({ name: "Fictional catalog sync vendor", active: true });
  for (const [id, quantity] of [["restore-sync-six", 6000], ["restore-sync-three", 3000]]) {
    await database.doc(`${root}/supplierproducts/${id}`).set({ supplierId: "restore-sync-vendor", supplierSku: id,
      supplierProductName: "Fictional milk", baseUnit: "ml", baseUnitsPerPurchaseUnit: quantity, purchaseUnit: "Case", purchaseOptions: [],
      active: true, catalogProductId: null, productPolicyVersion: 1, revision: 1, pricePerPurchaseUnit: 12, pricePerBaseUnit: null,
      currency: fixture.currency, priceBasis: "net", vatRate: null, pricingModel: "Per Purchase Unit", localCorrection: "Retained local package note",
      priceConfirmedOn: revisionTime, priceUpdatedOn: revisionTime, imageRevision: 5 });
  }
  await database.doc(`${root}/catalogproducts/restore-blank-sku`).set({ name: "Locally corrected legacy article", baseUnit: "each", active: true,
    internalSku: "", revision: 7, localCorrection: { description: "Keep local detail" }, productPolicyVersion: 0 });
  const previewCommand = { hotelUid, requestId: "restore-catalog-preview", supplierId: "restore-sync-vendor", limit: 25 };
  let workspace = await readHotelCatalogSyncWorkspaceHandler({ ...actor, data: previewCommand }, services);
  assert.equal(workspace.rows.length, 2);
  const aiCommand = { hotelUid, jobId: workspace.jobId, requestId: "restore-catalog-ai", expectedRevision: workspace.revision,
    rowIds: [workspace.rows[0].rowId] };
  const aiResult = await refineHotelCatalogSyncSuggestionsHandler({ ...actor, data: aiCommand }, services);
  assert.equal(aiResult.status, "ready");
  workspace = await readHotelCatalogSyncWorkspaceHandler({ ...actor, data: { hotelUid, jobId: workspace.jobId } }, services);
  const applyCommand = { hotelUid, jobId: workspace.jobId, requestId: "restore-catalog-apply", choices: workspace.rows.map((row) => ({
    rowId: row.rowId, reviewRevision: row.reviewRevision, expectedSupplierRevision: row.expectedSupplierRevision, acknowledged: true,
    target: { kind: "new", createGroupId: "shared-milk", product: { name: "Fictional milk", baseUnit: "l", active: true, inventoryTracked: true, allergens: [], internalSku: "" } },
  })) };
  const applyResult = await applyHotelCatalogSyncHandler({ ...actor, data: applyCommand }, services);
  const configuration = await getHotelCatalogSkuSettingsHandler({ ...actor, data: { hotelUid } }, services);
  const assignCommand = { hotelUid, requestId: "restore-adopt-blank-sku", expectedSettingsRevision: configuration.revision,
    products: [{ productId: "restore-blank-sku", expectedRevision: 7 }] };
  const assignResult = await assignHotelCatalogSkusHandler({ ...actor, data: assignCommand }, services);
  assert.equal(assignResult.assigned.length, 1);
  const catalogIds = await Promise.all(["restore-sync-six", "restore-sync-three"].map(async (id) => (await database.doc(`${root}/supplierproducts/${id}`).get()).data().catalogProductId));
  assert.ok(catalogIds[0]); assert.equal(catalogIds[0], catalogIds[1]);
  assert.equal((await getHotelCatalogSkuSettingsHandler({ ...actor, data: { hotelUid } }, services)).nextNumber, 102);
  const unknownPreviewCommand = { hotelUid, requestId: "restore-catalog-unknown-preview", supplierId: "restore-dairy", limit: 25 };
  // A separate unlinked source gives recovery a real frozen row without altering
  // the successfully applied group or its original immutable receipt.
  await database.doc(`${root}/supplierproducts/restore-sync-unknown`).set({ supplierId: "restore-sync-vendor", supplierSku: "RESTORE-UNKNOWN",
    supplierProductName: "Fictional milk", baseUnit: "ml", baseUnitsPerPurchaseUnit: 1000, purchaseUnit: "Bottle", purchaseOptions: [],
    active: true, catalogProductId: null, productPolicyVersion: 1, revision: 1 });
  unknownPreviewCommand.supplierId = "restore-sync-vendor";
  const unknownWorkspace = await readHotelCatalogSyncWorkspaceHandler({ ...actor, data: unknownPreviewCommand }, services);
  const unknownCommand = { hotelUid, jobId: unknownWorkspace.jobId, requestId: "restore-catalog-lost-response", expectedRevision: unknownWorkspace.revision,
    rowIds: [unknownWorkspace.rows[0].rowId] };
  const unknownResult = await refineHotelCatalogSyncSuggestionsHandler({ ...actor, data: unknownCommand }, { ...services,
    provider: { countInput: async () => 500, respond: async () => { throw new Error("Fictional lost paid catalog response"); } } });
  assert.equal(unknownResult.status, "response-unknown");
  const records = await catalogSyncEvidence(fixture);
  return { settingsCommand, settingsResult, previewCommand, aiCommand, aiResult, applyCommand, applyResult, assignCommand, assignResult,
    unknownPreviewCommand, unknownCommand, unknownResult, records: Object.fromEntries(Object.entries(records).map(([path, value]) => [path, value.data])) };
}
async function verifyCatalogSync(fixture, proof) {
  const before = await catalogSyncEvidence(fixture);
  assert.deepEqual(Object.fromEntries(Object.entries(before).map(([path, value]) => [path, value.data])), proof.records,
    "Restored catalog synchronization, numbering, reservations and pinned AI attempts must match exported evidence.");
  const account = await auth.getUser(fixture.actorUid), freshAuthTime = Math.ceil(Math.max(Date.now(), Date.parse(account.tokensValidAfterTime) || 0) / 1000);
  const actor = catalogSyncActor(fixture, freshAuthTime); let calls = 0;
  const services = { ...procurementServices, provider: { countInput: async () => { calls++; throw new Error("Restore must not count another catalog request."); },
    respond: async () => { calls++; throw new Error("Restore must not repeat paid catalog work."); } } };
  assert.deepEqual(await saveHotelCatalogSkuSettingsHandler({ ...actor, data: proof.settingsCommand }, services), proof.settingsResult);
  await readHotelCatalogSyncWorkspaceHandler({ ...actor, data: proof.previewCommand }, services);
  assert.deepEqual(await refineHotelCatalogSyncSuggestionsHandler({ ...actor, data: proof.aiCommand }, services), proof.aiResult);
  assert.deepEqual(await applyHotelCatalogSyncHandler({ ...actor, data: proof.applyCommand }, services), proof.applyResult);
  assert.deepEqual(await assignHotelCatalogSkusHandler({ ...actor, data: proof.assignCommand }, services), proof.assignResult);
  await readHotelCatalogSyncWorkspaceHandler({ ...actor, data: proof.unknownPreviewCommand }, services);
  assert.deepEqual(await refineHotelCatalogSyncSuggestionsHandler({ ...actor, data: proof.unknownCommand }, services), proof.unknownResult);
  assert.equal(calls, 0);
  assert.deepEqual(await catalogSyncEvidence(fixture), before, "Exact restored catalog and SKU replay must preserve original update times and all private evidence.");
  const other = inventoryFixtures.find((candidate) => candidate.hotelUid !== fixture.hotelUid);
  await assert.rejects(readHotelCatalogSyncWorkspaceHandler({ ...catalogSyncActor(other), data: { hotelUid: fixture.hotelUid, jobId: proof.applyCommand.jobId } }, services), { code: "permission-denied" });
  await assert.rejects(getHotelCatalogSkuSettingsHandler({ ...catalogSyncActor(other), data: { hotelUid: fixture.hotelUid } }, services), { code: "permission-denied" });
}
async function seedManagedImage(fixture) {
  const productRef = database.doc(`hotels/${fixture.hotelUid}/supplierproducts/restore-priced-milk`), before = (await productRef.get()).data();
  const bytes = await sharp({ create: { width: 640, height: 480, channels: 3,
    background: fixture.hotelUid === "restore-hotel-a" ? "#b96f43" : "#416f57" } }).png().toBuffer();
  const uploaded = await uploadSupplierProductImage(imageRequest(fixture), { hotelUid: fixture.hotelUid, productId: "restore-priced-milk",
    requestId: "restore-managed-image", expectedImageRevision: 0, mimeType: "image/png" }, bytes, imageServices);
  assert.equal(uploaded.status, "ready", "The real managed-image pipeline must finish before this fixture is exported.");
  const after = (await productRef.get()).data(), asset = (await database.doc(`hotels/${fixture.hotelUid}/supplierProductImages/${uploaded.assetId}`).get()).data();
  assert.equal(after.revision, before.revision); assert.equal(after.imageRevision, 1);
  for (const field of ["updatedAt", "priceUpdatedOn", "pricePerPurchaseUnit", "catalogProductId"]) assert.deepEqual(after[field], before[field]);
  const proof = { assetId: uploaded.assetId, imageRevision: uploaded.imageRevision, objects: {} };
  for (const variant of ["source", "thumbnail", "display"]) {
    const path = variant === "source" ? sourcePath(fixture.hotelUid, "restore-priced-milk", uploaded.assetId) : after.image[variant].path;
    const [metadata] = await bucket.file(path).getMetadata();
    const actual = variant === "source" ? (await bucket.file(path, { generation: metadata.generation }).download({ decompress: false }))[0]
      : (await readSupplierProductImage(imageRequest(fixture), imageReadInput(fixture, uploaded.assetId, variant), imageServices)).bytes;
    assert.equal(metadata.metadata?.firebaseStorageDownloadTokens, undefined); assert.equal(metadata.cacheControl, "private, no-store");
    assert.equal(metadata.metadata.sha256, bytesHash(actual));
    assert.equal(metadata.generation, variant === "source" ? asset.sourceGeneration : after.image[variant].generation);
    if (variant === "source") assert.deepEqual(actual, bytes);
    proof.objects[variant] = { path, generation: metadata.generation, sha256: bytesHash(actual), bytes: actual.toString("base64"),
      size: actual.length, contentType: variant === "source" ? "image/png" : "image/webp" };
  }
  return proof;
}

async function verifyManagedImage(fixture, proof) {
  assert.ok(proof?.assetId, "Managed-image source/derivative backup evidence is required.");
  const productRef = database.doc(`hotels/${fixture.hotelUid}/supplierproducts/restore-priced-milk`), before = await productRef.get();
  const product = before.data(), assetRef = database.doc(`hotels/${fixture.hotelUid}/supplierProductImages/${proof.assetId}`), assetBefore = await assetRef.get();
  assert.equal(product.image.assetId, proof.assetId); assert.equal(product.imageRevision, proof.imageRevision);
  assert.equal(product.image.status, "ready"); assert.equal(assetBefore.data().status, "ready");
  for (const [variant, expected] of Object.entries(proof.objects)) {
    const file = bucket.file(expected.path, { generation: expected.generation }), [metadata] = await file.getMetadata();
    // Object generations are evidence. A restore that allocates a new generation
    // requires a reviewed media recovery process; never silently rewrite pins.
    assert.equal(metadata.generation, expected.generation, `Restored image generation changed: ${expected.path}`);
    assert.equal(metadata.generation, variant === "source" ? assetBefore.data().sourceGeneration : product.image[variant].generation);
    assert.equal(Number(metadata.size), expected.size); assert.equal(metadata.contentType, expected.contentType);
    assert.equal(metadata.cacheControl, "private, no-store"); assert.equal(metadata.metadata?.firebaseStorageDownloadTokens, undefined);
    const [bytes] = await file.download({ decompress: false });
    assert.deepEqual(bytes, Buffer.from(expected.bytes, "base64"), `Restored image bytes differ: ${expected.path}`);
    assert.equal(bytesHash(bytes), expected.sha256); assert.equal(metadata.metadata.sha256, expected.sha256);
    if (variant !== "source") {
      const delivered = await readSupplierProductImage(imageRequest(fixture), imageReadInput(fixture, proof.assetId, variant), imageServices);
      assert.deepEqual(delivered.bytes, bytes, "Authorized restored reads must return the exact pinned derivative bytes.");
      const decoded = await sharp(delivered.bytes).metadata();
      assert.equal(decoded.format, "webp"); assert.equal(decoded.width, variant === "thumbnail" ? 160 : 640); assert.equal(decoded.height, variant === "thumbnail" ? 120 : 480);
    }
  }
  const otherFixture = inventoryFixtures.find((value) => value.hotelUid !== fixture.hotelUid);
  await assert.rejects(readSupplierProductImage(imageRequest(otherFixture), imageReadInput(fixture, proof.assetId, "thumbnail"), imageServices), (error) => error.code === "permission-denied");
  await assert.rejects(readSupplierProductImage({ auth: { uid: "restore-platform", token: { email_verified: true, platformAdmin: true } } },
    imageReadInput(fixture, proof.assetId, "thumbnail"), imageServices), (error) => error.code === "permission-denied");
  imageRulesEnvironment ??= await initializeTestEnvironment({ projectId,
    firestore: { host: "127.0.0.1", port: Number(process.env.FIRESTORE_EMULATOR_HOST.split(":").at(-1)) },
    storage: { host: "127.0.0.1", port: Number(process.env.FIREBASE_STORAGE_EMULATOR_HOST.split(":").at(-1)) },
  });
  for (const context of [imageRulesEnvironment.authenticatedContext(fixture.actorUid, { email_verified: true }), imageRulesEnvironment.unauthenticatedContext()]) {
    const storage = context.storage(`gs://${bucket.name}`);
    for (const object of Object.values(proof.objects)) {
      await assertFails(getBytes(ref(storage, object.path))); await assertFails(getDownloadURL(ref(storage, object.path)));
    }
    await assertFails(getDoc(doc(context.firestore(), `hotels/${fixture.hotelUid}/supplierProductImages/${proof.assetId}`)));
  }
  const after = await productRef.get(), assetAfter = await assetRef.get();
  assert.deepEqual(after.data(), before.data()); assert.equal(after.updateTime.isEqual(before.updateTime), true);
  assert.deepEqual(assetAfter.data(), assetBefore.data()); assert.equal(assetAfter.updateTime.isEqual(assetBefore.updateTime), true);
}
async function verifyProcurementReplay(fixture, proof) {
  const before = await procurementEvidence(fixture);
  assert.deepEqual(Object.fromEntries(Object.entries(before).map(([path, row]) => [path, row.data])), proof,
    "Restored supplier price history, movement legs, reversals, states and v1/v2 payload timestamps must match the actual exported evidence.");
  for (const action of ["create", "update"]) {
    const result = await mutateHotelSupplierProductHandler(procurementRequest(fixture, offerCommand(fixture, action)), procurementServices);
    assert.equal(result.productId, "restore-priced-milk"); assert.equal(result.revision, action === "create" ? 1 : 2);
  }
  assert.equal((await mutateHotelSupplierProductHandler(procurementRequest(fixture, futurePriceCommand(fixture)), procurementServices)).revision, 3);
  await verifyScheduledPrice(fixture);
  const original = await recordHotelInventoryAdjustmentHandler(procurementRequest(fixture, adjustmentCommand(fixture, "transfer")), procurementServices);
  assert.equal(original.adjustmentId, transferId(fixture)); assert.equal(original.movementIds.length, 2);
  const reversed = await reverseHotelInventoryAdjustmentHandler(procurementRequest(fixture, reverseCommand(fixture)), procurementServices);
  assert.equal(reversed.originalAdjustmentId, original.adjustmentId); assert.equal(reversed.movementIds.length, 2);
  for (const [kind, reason] of [["waste", "waste"], ["waste", "breakage"], ["physical_return", null]]) {
    await recordHotelInventoryAdjustmentHandler(procurementRequest(fixture, adjustmentCommand(fixture, kind, reason)), procurementServices);
  }
  const legs = [...original.movementIds, ...reversed.movementIds].map((id) => before[`hotels/${fixture.hotelUid}/inventoryMovements/${id}`].data);
  assert.equal(legs[0].lines[0].quantity + legs[1].lines[0].quantity, 0);
  assert.equal(legs[0].lines[0].netValue + legs[1].lines[0].netValue, 0);
  for (let index = 0; index < 2; index++) { assert.equal(legs[index + 2].lines[0].quantity, -legs[index].lines[0].quantity); assert.equal(legs[index + 2].lines[0].netValue, -legs[index].lines[0].netValue); }
  for (const locationId of ["movements-store", "movements-bar"]) {
    const result = await getHotelInventoryPeriodHandler(periodV2Request(fixture, locationId), procurementServices); verifyV2(result, fixture, locationId);
    assert.deepEqual(await getHotelInventoryPeriodHandler(periodV2Request(fixture, locationId), { ...procurementServices, now: () => procurementServices.now() + 60000 }), result);
  }
  await supplierConfirmationReplay(fixture);
  assert.deepEqual(await procurementEvidence(fixture), before,
    "Exact restored command/report replay must not create extra history or legs, change frozen timestamps, or write any original updateTime.");
}

function verifyInventoryReport(result, fixture) {
  assert.equal(result.hotelUid, fixture.hotelUid);
  assert.equal(result.currency, fixture.currency);
  assert.equal(result.inventoryPolicyVersion, 1);
  assert.equal(result.recordedReceiptCount, 1);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].openingQuantity, 100);
  assert.equal(result.items[0].netReceiptQuantity, 30);
  assert.equal(result.items[0].closingQuantity, 80);
  assert.equal(result.items[0].inferredUsageQuantity, 50);
  assert.equal(result.items[0].periodUnitCost, 290 / 130);
  assert.equal(result.items[0].inferredUsageValue, Math.round(50 * 290 / 130 * 10000) / 10000);
  assert.deepEqual(result.coverage, { quantityComplete: true, costComplete: true, issues: [] });
  assert.deepEqual(result.movementIds, ["fixture-receipt"]);
  assert.deepEqual(result.intermediateCheckpointIds, []);
  assert.deepEqual(result.postClosureIssues, []);
  assert.equal(result.currentlyComplete, true);
  assert.equal(result.computedAtMillis, revisionTime.toMillis());
}
function expectedStoredInventoryReport(fixture) {
  const { hotelUid, currency } = fixture;
  const view = (stockCountId, businessDate, sequence) => ({ id: checkpointId(stockCountId, "store"), stockCountId,
    stockCountName: `Fictional ${stockCountId} count`, businessDate, sequence, currency, coverageIssues: [],
    finishedAtMillis: revisionTime.toMillis() });
  return { id: inventoryReportId(hotelUid).split("/").at(-1), inventoryPolicyVersion: 1, hotelUid, locationId: "store", currency,
    opening: view("opening", "2026-10-01", 1), closing: view("closing", "2026-10-10", 3),
    items: [{ catalogProductId: "milk", catalogProductName: "Fictional milk", baseUnit: "l", openingQuantity: 100,
      netReceiptQuantity: 30, closingQuantity: 80, inferredUsageQuantity: 50, periodUnitCost: 290 / 130,
      inferredUsageValue: Math.round(50 * 290 / 130 * 10000) / 10000 }],
    coverage: { quantityComplete: true, costComplete: true, issues: [] }, recordedReceiptCount: 1,
    computedAtMillis: revisionTime.toMillis(), movementIds: ["fixture-receipt"], intermediateCheckpointIds: [],
    costBasis: "Period estimate from explicit opening costs and frozen net order prices; not invoice cost or live on-hand stock." };
}

try {
  if (process.argv[2] === "seed") {
    await Promise.all([
      auth.createUser({ uid: "restore-platform", email: "restore-platform@example.test", emailVerified: true }),
      auth.createUser({ uid: "restore-a", email: "restore-a@example.test", emailVerified: true, password: "Fictional-Restore-Only-42" }),
      auth.createUser({ uid: "restore-b", email: "restore-b@example.test", emailVerified: true, disabled: true }),
      auth.createUser({ uid: "restore-b-counter", email: "restore-b-counter@example.test", emailVerified: true }),
    ]);
    await auth.setCustomUserClaims("restore-a", { hotelUids: ["restore-hotel-a"], platformAdmin: false });
    await auth.setCustomUserClaims("restore-platform", { platformAdmin: true });
    await auth.setCustomUserClaims("restore-b-counter", { hotelUids: ["restore-hotel-b"], platformAdmin: false });
    const batch = database.batch();
    for (const [path, value] of Object.entries(documents)) batch.set(database.doc(path), value);
    await batch.commit();
    for (const [path, bytes] of Object.entries(objects)) {
      await bucket.file(path).save(bytes, { metadata: { contentType: "application/pdf", metadata: { fixture: "restore-only" } } });
    }
    // Use the deployed-code handler to create complete immutable report DTOs;
    // fixtures deliberately exercise independent opening and receipt costs.
    for (const fixture of inventoryFixtures) {
      const result = await getHotelInventoryPeriodHandler(inventoryRequest(fixture), inventoryServices);
      verifyInventoryReport(result, fixture);
      const snapshot = await database.doc(inventoryReportId(fixture.hotelUid)).get();
      assert.equal(snapshot.exists, true);
      assert.deepEqual(snapshot.data(), expectedStoredInventoryReport(fixture));
    }
    const proof = { managedImages: {}, catalogSync: {} };
    for (const fixture of inventoryFixtures) {
      for (const action of ["create", "update"]) await mutateHotelSupplierProductHandler(procurementRequest(fixture, offerCommand(fixture, action)), procurementServices);
      const history = await database.collection(`hotels/${fixture.hotelUid}/supplierPriceHistory/restore-priced-milk/entries`).orderBy("revision").get();
      assert.deepEqual(history.docs.map((doc) => [doc.data().revision, doc.data().observation, doc.data().terms.currency, doc.data().terms.options[0].pricePerPurchaseUnit]),
        [[1, "initial-create", fixture.currency, 12], [2, "terms-changed", fixture.currency, 15]]);
      await mutateHotelSupplierProductHandler(procurementRequest(fixture, futurePriceCommand(fixture)), procurementServices);
      await verifyScheduledPrice(fixture);
      proof.managedImages[fixture.hotelUid] = await seedManagedImage(fixture);
      await finishAdjustmentCheckpoints(fixture, "opening");
      const transfer = await recordHotelInventoryAdjustmentHandler(procurementRequest(fixture, adjustmentCommand(fixture, "transfer")), procurementServices);
      assert.equal(transfer.adjustmentId, transferId(fixture));
      await reverseHotelInventoryAdjustmentHandler(procurementRequest(fixture, reverseCommand(fixture)), procurementServices);
      for (const [kind, reason] of [["waste", "waste"], ["waste", "breakage"], ["physical_return", null]]) {
        await recordHotelInventoryAdjustmentHandler(procurementRequest(fixture, adjustmentCommand(fixture, kind, reason)), procurementServices);
      }
      await finishAdjustmentCheckpoints(fixture, "closing");
      for (const locationId of ["movements-store", "movements-bar"]) verifyV2(await getHotelInventoryPeriodHandler(periodV2Request(fixture, locationId), procurementServices), fixture, locationId);
      await seedSupplierConfirmation(fixture);
      proof.catalogSync[fixture.hotelUid] = await seedCatalogSync(fixture);
    }
    proof.reviewedAiImport = await seedReviewedAiImport();
    proof.unknownAiImport = await seedUnknownAiImport();
    // AI review decisions share productAudit with procurement commands. Capture
    // all evidence after every seed mutation, immediately before export, so the
    // immutable restore proof includes those decisions and their timestamps.
    for (const fixture of inventoryFixtures) {
      proof[fixture.hotelUid] = Object.fromEntries(Object.entries(await procurementEvidence(fixture)).map(([path, row]) => [path, row.data]));
      proof.catalogSync[fixture.hotelUid].records = Object.fromEntries(Object.entries(await catalogSyncEvidence(fixture)).map(([path, row]) => [path, row.data]));
    }
    assert.ok(Object.values(proof[aiUpload.hotelUid]).some((record) => record.action === "ai-import-review-decision"
      && record.jobId === proof.reviewedAiImport.jobId), "The final procurement evidence must include the original AI review audit.");
    await writeFile(procurementProofPath, JSON.stringify(proof), { mode: 0o600 });
    console.log("Seeded confirmed recurring file formats, an audited first-file interpretation, reviewed AI approval, original paid attempt/result bytes and pinned source/format generations.");
    console.log("Seeded fictional two-hotel data, supplier responses and approved-price receipts, protected supplier price changes, paired manual transfer/reversal/waste/return evidence, immutable v1/v2 reports, Auth users/claims, private Storage bytes and real managed product-image sources/derivatives with pinned generations.");
    console.log("Seeded two-hotel automatic SKU settings, reserved sequences, selective legacy adoption, atomic catalog synchronization receipts and known/unknown pinned optional suggestion attempts.");
  } else if (process.argv[2] === "verify") {
    for (const [path, expected] of Object.entries(documents)) {
      const snapshot = await database.doc(path).get();
      assert.equal(snapshot.exists, true, `Missing restored document: ${path}`);
      assert.deepEqual(snapshot.data(), expected, `Restored document differs: ${path}`);
    }
    const user = await auth.getUser("restore-a");
    assert.equal(user.email, "restore-a@example.test");
    assert.equal(user.emailVerified, true);
    assert.deepEqual(user.customClaims, { hotelUids: ["restore-hotel-a"], platformAdmin: false });
    assert.equal((await auth.getUser("restore-b")).disabled, true);
    const counterB = await auth.getUser("restore-b-counter");
    assert.equal(counterB.emailVerified, true);
    assert.equal(counterB.disabled, false);
    assert.deepEqual(counterB.customClaims, { hotelUids: ["restore-hotel-b"], platformAdmin: false });
    assert.deepEqual((await auth.getUser("restore-platform")).customClaims, { platformAdmin: true });
    assert.deepEqual((await database.doc("users/restore-platform").get()).data().hotelUid, []);
    for (const fixture of inventoryFixtures) {
      const reportRef = database.doc(inventoryReportId(fixture.hotelUid));
      const before = await reportRef.get();
      assert.equal(before.exists, true, "An immutable inventory report must be restored before invoking its handler.");
      assert.deepEqual(before.data(), expectedStoredInventoryReport(fixture), "Restored inventory report DTO or source evidence differs.");
      const stateRef = database.doc(`hotels/${fixture.hotelUid}/inventoryLocationStates/store`);
      const beforeState = await stateRef.get();
      const countsBefore = await Promise.all(["inventoryMovements", "inventoryCheckpoints", "inventoryPeriodReports"].map(async (name) => {
        const rows = await database.collection(`hotels/${fixture.hotelUid}/${name}`).get(); return [name, rows.docs.map((doc) => doc.id).sort()];
      }));
      const result = await getHotelInventoryPeriodHandler(inventoryRequest(fixture), inventoryServices);
      verifyInventoryReport(result, fixture);
      const repeated = await getHotelInventoryPeriodHandler(inventoryRequest(fixture), { ...inventoryServices, now: () => revisionTime.toMillis() + 60000 });
      assert.deepEqual(repeated, result, "Repeating a restored report must preserve its original computation snapshot.");
      const after = await reportRef.get();
      assert.deepEqual(after.data(), before.data(), "Restored period reports must not be silently recalculated.");
      assert.equal(after.updateTime.isEqual(before.updateTime), true, "A report retry must not write the stored snapshot.");
      const afterState = await stateRef.get();
      assert.deepEqual(afterState.data(), beforeState.data());
      assert.equal(afterState.updateTime.isEqual(beforeState.updateTime), true);
      const countsAfter = await Promise.all(["inventoryMovements", "inventoryCheckpoints", "inventoryPeriodReports"].map(async (name) => {
        const rows = await database.collection(`hotels/${fixture.hotelUid}/${name}`).get(); return [name, rows.docs.map((doc) => doc.id).sort()];
      }));
      assert.deepEqual(countsAfter, countsBefore, "Report retries must not create additional inventory evidence.");
    }
    const proof = JSON.parse(await readFile(procurementProofPath, "utf8"));
    await verifyReviewedAiImport(proof.reviewedAiImport);
    await verifyUnknownAiImport(proof.unknownAiImport);
    console.log("Verified confirmed recurring formats, audited format application, frozen upload snapshots, persisted approvals and original AI source/format/result hashes after restore; exact format/mapping/decision/upload/worker replay made zero provider calls and preserved all review receipts.");
    for (const fixture of inventoryFixtures) await verifyManagedImage(fixture, proof.managedImages[fixture.hotelUid]);
    for (const fixture of inventoryFixtures) await verifyProcurementReplay(fixture, proof[fixture.hotelUid]);
    for (const fixture of inventoryFixtures) await verifyCatalogSync(fixture, proof.catalogSync[fixture.hotelUid]);
    console.log("Verified two-hotel catalog/SKU restore, exact allocation/adoption/synchronization replay, immutable private attempt accounting and reservations, current authorization and zero optional suggestion calls.");
    await assert.rejects(recordHotelInventoryAdjustmentHandler({ auth: { uid: "restore-a", token: { email_verified: true } },
      data: { hotelUid: "restore-hotel-b", ...adjustmentCommand(inventoryFixtures[0], "transfer") } }, procurementServices),
    (error) => error.code === "permission-denied");
    await assert.rejects(getHotelInventoryPeriodHandler({ auth: { uid: "restore-a", token: { email_verified: true } },
      data: { hotelUid: "restore-hotel-b", locationId: "store", openingStockCountId: "opening", closingStockCountId: "closing" } }, inventoryServices),
    (error) => error.code === "permission-denied");
    const { requireSupportSession } = createRequire(import.meta.url)("../../functions/src/platformSupport");
    const { getHotelOrderReceivingHandler, recordHotelOrderReceiptHandler } = createRequire(import.meta.url)("../../functions/src/orderReceiving");
    const receiving = await getHotelOrderReceivingHandler({ auth: { uid: "restore-a", token: { email_verified: true } },
      data: { hotelUid: "restore-hotel-a", orderId: "receiving-a" } }, { firestore: database, auth });
    assert.equal(receiving.receivingState, "closed");
    assert.equal(receiving.lines[0].acceptedQuantity, 3);
    assert.equal(receiving.lines[0].rejectedQuantity, 1);
    assert.equal(receiving.lines[0].outstandingQuantity, 0);
    assert.equal(receiving.events.length, 2);
    const replay = await recordHotelOrderReceiptHandler({ auth: { uid: "restore-a", token: { email_verified: true } },
      data: { hotelUid: "restore-hotel-a", orderId: "receiving-a", requestId: "restore-receipt", expectedRevision: 1, ...receivingDetails } }, { firestore: database, auth });
    assert.deepEqual(replay, receivingResult);
    assert.equal((await database.doc("hotels/restore-hotel-a/orders/receiving-a").get()).data().revision, 3);
    await assert.rejects(requireSupportSession({ auth: { uid: "restore-platform", token: { email_verified: true, platformAdmin: true } },
      data: { hotelUid: "restore-hotel-a", sessionId: "restore-session" } }, { firestore: database, auth }), (error) => error.code === "permission-denied");
    for (const [path, bytes] of Object.entries(objects)) {
      const file = bucket.file(path);
      assert.deepEqual((await file.download())[0], bytes, `Restored bytes differ: ${path}`);
      const [metadata] = await file.getMetadata();
      assert.equal(metadata.contentType, "application/pdf");
      assert.equal(metadata.metadata.fixture, "restore-only");
    }
    console.log("Verified two-hotel data, unchanged v1 period replay (50 inferred usage; weighted cost 290/130), supplier response/review/approved-price receipt restore and exact replay, supplier price-history restore, exact paired manual movement/reversal replay and immutable v2 reports with explicit unknown costs, frozen timestamps/updateTimes, entitlements, roles, platform history, Auth, private Storage bytes/metadata and exact managed product-image hashes/generations with authorized reads and browser/cross-hotel denials. Restored unknown AI billing reservations, immutable attempts and pinned source generations remain unchanged; stale sessions are denied and fresh status/upload/worker replay makes zero provider calls.");
  } else throw new Error("Expected seed or verify mode.");
} finally {
  if (imageRulesEnvironment) await imageRulesEnvironment.cleanup();
  await deleteApp(app);
  if (process.argv[2] === "verify") await unlink(procurementProofPath).catch((error) => { if (error.code !== "ENOENT") throw error; });
}
