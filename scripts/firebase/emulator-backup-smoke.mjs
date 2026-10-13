import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
const { recordHotelInventoryAdjustmentHandler, reverseHotelInventoryAdjustmentHandler } = require("../../functions/src/inventoryAdjustments");
const { recordHotelSupplierConfirmationHandler, reviewHotelSupplierConfirmationHandler, getHotelSupplierConfirmationsHandler } = require("../../functions/src/supplierConfirmations");
const { recordHotelOrderReceiptHandler: recordConfirmedReceipt } = require("../../functions/src/orderReceiving");
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
// A temporary test proof survives the two emulator processes; it is not hotel
// data, and contains only fictional fixture payloads and timestamp evidence.
const procurementProofPath = join(tmpdir(), `hotelsuite-restore-proof-${digest(import.meta.url, projectId).slice(0, 16)}.json`);
const procurementRequest = (fixture, data) => ({ auth: { uid: fixture.actorUid, token: { email_verified: true } }, data: { hotelUid: fixture.hotelUid, ...data } });
const offerInput = (fixture, price) => ({ supplierId: "restore-dairy", supplierSku: "RESTORE-MILK6", supplierProductName: "Fictional milk six-pack",
  currency: fixture.currency, pricingModel: "Per Purchase Unit", pricePerBaseUnit: null, pricePerPurchaseUnit: price,
  baseUnit: "ml", purchaseUnit: "Case", baseUnitsPerPurchaseUnit: 6000, catalogProductId: "milk", imageUrl: "", active: true,
  priceBasis: "net", vatRate: null, purchaseOptions: [], priceValidFrom: "2026-10-01", priceValidUntil: "2026-10-31" });
const offerCommand = (fixture, action) => ({ action, productId: "restore-priced-milk", expectedRevision: action === "create" ? 0 : 1,
  requestId: `restore-price-${action}`, product: offerInput(fixture, action === "create" ? 12 : 15) });
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
  "hotels/restore-hotel-a/members/restore-a": { permissions: ["orders.read", "orders.receive", "orders.finalize", "stockcounts.read", "users.read", "users.create", "users.update", "users.delete"], hotelAdmin: true, moduleRoles: { procurement: ["receiving-supervisor"] }, additionalPermissions: [], rolePolicyVersion: 1, revision: 2 },
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
  documents[`${root}/members/${actorUid}`].permissions.push("supplierproducts.create", "supplierproducts.update", "inventorymovements.read", "inventorymovements.create", "inventorymovements.reverse", "orders.read", "orders.recordconfirmation", "orders.reviewconfirmation", "orders.receive");
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
    "inventoryAdjustmentReversals", "inventoryMovements", "inventoryLocationStates", "inventoryCheckpoints", "inventoryPeriodReports", "supplierPriceHistory/restore-priced-milk/entries", "orderAudit",
    ...["supplierConfirmations", "supplierConfirmationReferences", "receipts", "receiptReferences"].map((name) => `orders/${confirmationOrderId}/${name}`)];
  const rows = (await Promise.all(collections.map((name) => database.collection(`${root}/${name}`).get()))).flatMap((snapshot) => snapshot.docs);
  rows.push(await database.doc(`${root}/supplierproducts/restore-priced-milk`).get());
  rows.push(await database.doc(`${root}/orders/${confirmationOrderId}`).get());
  return Object.fromEntries(rows.map((doc) => [doc.ref.path, { data: canonical(doc.data()), updateTime: canonical(doc.updateTime) }]).sort(([left], [right]) => left.localeCompare(right)));
}
async function verifyProcurementReplay(fixture, proof) {
  const before = await procurementEvidence(fixture);
  assert.deepEqual(Object.fromEntries(Object.entries(before).map(([path, row]) => [path, row.data])), proof,
    "Restored supplier price history, movement legs, reversals, states and v1/v2 payload timestamps must match the actual exported evidence.");
  for (const action of ["create", "update"]) {
    const result = await mutateHotelSupplierProductHandler(procurementRequest(fixture, offerCommand(fixture, action)), procurementServices);
    assert.equal(result.productId, "restore-priced-milk"); assert.equal(result.revision, action === "create" ? 1 : 2);
  }
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
    const proof = {};
    for (const fixture of inventoryFixtures) {
      for (const action of ["create", "update"]) await mutateHotelSupplierProductHandler(procurementRequest(fixture, offerCommand(fixture, action)), procurementServices);
      const history = await database.collection(`hotels/${fixture.hotelUid}/supplierPriceHistory/restore-priced-milk/entries`).orderBy("revision").get();
      assert.deepEqual(history.docs.map((doc) => [doc.data().revision, doc.data().observation, doc.data().terms.currency, doc.data().terms.options[0].pricePerPurchaseUnit]),
        [[1, "initial-create", fixture.currency, 12], [2, "terms-changed", fixture.currency, 15]]);
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
      proof[fixture.hotelUid] = Object.fromEntries(Object.entries(await procurementEvidence(fixture)).map(([path, row]) => [path, row.data]));
    }
    await writeFile(procurementProofPath, JSON.stringify(proof), { mode: 0o600 });
    console.log("Seeded fictional two-hotel data, supplier responses and approved-price receipts, protected supplier price changes, paired manual transfer/reversal/waste/return evidence, immutable v1/v2 reports, Auth users/claims and private Storage bytes.");
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
    for (const fixture of inventoryFixtures) await verifyProcurementReplay(fixture, proof[fixture.hotelUid]);
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
    console.log("Verified two-hotel data, unchanged v1 period replay (50 inferred usage; weighted cost 290/130), supplier response/review/approved-price receipt restore and exact replay, supplier price-history restore, exact paired manual movement/reversal replay and immutable v2 reports with explicit unknown costs, frozen timestamps/updateTimes, entitlements, roles, platform history, Auth and private Storage bytes/metadata.");
  } else throw new Error("Expected seed or verify mode.");
} finally {
  await deleteApp(app);
  if (process.argv[2] === "verify") await unlink(procurementProofPath).catch((error) => { if (error.code !== "ENOENT") throw error; });
}
