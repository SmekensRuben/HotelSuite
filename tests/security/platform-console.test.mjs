import { before, beforeEach, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { doc, getDoc, getDocs, collection, setDoc } from "firebase/firestore";
import { ref, getBytes, uploadString } from "firebase/storage";

const projectId = "demo-hotel-suite-a00";
if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST || !process.env.FIREBASE_STORAGE_EMULATOR_HOST) throw new Error("Only local emulators are allowed.");
process.env.FIREBASE_CONFIG = JSON.stringify({ projectId, storageBucket: `${projectId}.appspot.com` });
const require = createRequire(import.meta.url);
const { admin } = require("../../functions/src/config");
const consoleApi = require("../../functions/src/platformConsole");
const monitoring = require("../../functions/src/platformMonitoring");
const support = require("../../functions/src/platformSupport");
const usersApi = require("../../functions/src/platformUsers");
const { createHotel } = require("../../functions/src/onboarding");
const { requireHotelPermission } = require("../../functions/src/authorization");
const { recordImportReceived, syncImportTelemetry } = require("../../functions/src/importTelemetry");
const { importRunId } = require("../../functions/src/importProcessing");
const { SAAS_RULES_VERSION } = require("../../functions/src/saasRollout");
const db = admin.firestore(), auth = admin.auth();
const operator = { uid: "operator", token: { email_verified: true, platformAdmin: true, email: "operator@example.test" } };
const otherOperator = { uid: "other-operator", token: { email_verified: true, platformAdmin: true, email: "other@example.test" } };
const member = { uid: "member", token: { email_verified: true, email: "member@example.test" } };
const now = Date.parse("2026-10-10T09:00:00Z");
const services = { firestore: db, auth, now: () => now };
const request = (actor, data) => ({ auth: actor, data });
const rejected = (promise, code) => assert.rejects(promise, (error) => error.code === code);
const policy = { label: "Daily arrivals", timeZone: "Europe/Brussels", expectedBy: "08:00", graceMinutes: 30, weekdays: [0, 1, 2, 3, 4, 5, 6], businessDateOffsetDays: 0, startsOn: "2026-10-01", enabled: true, paused: false, acceptEmpty: false };
let environment;
before(async () => {
  environment = await initializeTestEnvironment({ projectId,
    firestore: { host: "127.0.0.1", port: 8080, rules: await readFile("firebase/firestore.rules", "utf8") },
    storage: { host: "127.0.0.1", port: 9199, rules: await readFile("firebase/storage.rules", "utf8") } });
});
beforeEach(async () => {
  await environment.clearFirestore(); await environment.clearStorage();
  const current = await auth.listUsers(); if (current.users.length) await auth.deleteUsers(current.users.map((user) => user.uid));
  for (const actor of [operator, otherOperator, member]) {
    await auth.createUser({ uid: actor.uid, email: actor.token.email, emailVerified: true });
    await db.doc(`users/${actor.uid}`).set({ firstName: actor.uid, hotelUid: actor === member ? ["hotel-a"] : [], privateProfile: "DO_NOT_EXPOSE" });
    if (actor.token.platformAdmin) await auth.setCustomUserClaims(actor.uid, { platformAdmin: true });
  }
  await db.doc("platformConfiguration/saasProcurement").set({ enabled: true, rulesVersion: SAAS_RULES_VERSION });
  for (const id of ["hotel-a", "hotel-b"]) {
    await db.doc(`hotels/${id}`).set({ hotelName: id, guestList: "DO_NOT_EXPOSE", integrationPassword: "DO_NOT_EXPOSE" });
    await db.doc(`hotelSubscriptions/${id}`).set({ modules: ["procurement", "frontoffice"], modulePolicyVersion: 1, status: "active", validUntil: null, revision: 1 });
    await db.doc(`hotels/${id}/catalogproducts/product`).set({ name: "Fixture" });
    await db.doc(`hotels/${id}/fileImportTypes/arrivals`).set({ fileType: "arrivals", name: "Daily arrivals", enabled: true, password: "DO_NOT_EXPOSE" });
  }
  await db.doc("hotels/hotel-a/members/member").set({ permissions: ["catalogproducts.read", "imports.read"], hotelAdmin: false });
  await environment.withSecurityRulesDisabled(async (context) => uploadString(ref(context.storage(), "hotels/hotel-a/catalogproducts/product/images/test.jpg"), "fixture", "raw", { contentType: "image/jpeg" }));
});
after(async () => environment.cleanup());

async function configure() {
  return monitoring.savePlatformImportMonitorHandler(request(operator, { hotelUid: "hotel-a", typeId: "arrivals", expectedRevision: 0, policy }), services);
}
async function sourceRun(overrides = {}) {
  const descriptor = { hotelUid: "hotel-a", bucket: `${projectId}.appspot.com`, name: "imports/hotel-a/arrivals/source.csv", generation: "1", fileType: "arrivals" };
  const id = importRunId(descriptor), reference = db.doc(`hotels/hotel-a/importRuns/${id}`);
  await reference.set({ descriptor, configuration: { targetDateOverride: "2026-10-10", password: "DO_NOT_EXPOSE" }, state: "complete", receivedAtMillis: now - 3600000,
    createdAt: now - 3600000, updatedAt: now, result: { writtenCount: 3, firstWrittenPath: "DO_NOT_EXPOSE" }, ...overrides });
  return { id, reference, descriptor };
}

describe("platform authority is independent from hotel work", () => {
  it("uses the deployed callable wrapper with a zero-hotel operator and returns sanitized administration DTOs", async () => {
    const hotels = await consoleApi.listPlatformHotels.run(request(operator, {}));
    assert.equal(hotels.hotels.length, 2);
    const hotel = await consoleApi.getPlatformHotel.run(request(operator, { hotelUid: "hotel-a" }));
    assert.equal(hotel.memberCount, 1);
    assert.equal(JSON.stringify({ hotels, hotel }).includes("DO_NOT_EXPOSE"), false);
    assert.deepEqual((await db.doc("users/operator").get()).data().hotelUid, []);
  });
  it("creates a hotel through its gated callable without assigning the platform operator to its workspace", async () => {
    await createHotel.run(request(operator, { hotelUid: "new-hotel", name: "New hotel", status: "active", modules: ["procurement"], requestId: "create-1" }));
    assert.equal((await db.doc("hotels/new-hotel").get()).exists, true);
    assert.equal((await db.doc("hotels/new-hotel/members/operator").get()).exists, false);
    assert.deepEqual((await db.doc("users/operator").get()).data().hotelUid, []);
    assert.equal((await db.collection("platformAudit").get()).size, 1);
  });
  it("rejects normal, unverified, disabled and live-revoked operators even when their ID token claims platform authority", async () => {
    await rejected(consoleApi.getPlatformHotel.run(request(member, { hotelUid: "hotel-a" })), "permission-denied");
    await rejected(consoleApi.getPlatformHotel.run(request({ ...operator, token: { ...operator.token, email_verified: false } }, { hotelUid: "hotel-a" })), "permission-denied");
    await auth.updateUser(operator.uid, { disabled: true });
    await rejected(consoleApi.getPlatformHotel.run(request(operator, { hotelUid: "hotel-a" })), "permission-denied");
    await auth.updateUser(operator.uid, { disabled: false }); await auth.setCustomUserClaims(operator.uid, {});
    await rejected(consoleApi.getPlatformHotel.run(request(operator, { hotelUid: "hotel-a" })), "permission-denied");
  });
  it("enforces canonical membership, action rights and licensed modules for an operator doing hotel work", async () => {
    await rejected(requireHotelPermission(db, request(operator, {}), "hotel-a", "catalogproducts", "read", undefined, auth), "permission-denied");
    await db.doc("hotels/hotel-a/members/operator").set({ permissions: ["catalogproducts.read"] });
    await requireHotelPermission(db, request(operator, {}), "hotel-a", "catalogproducts", "read", undefined, auth);
    await rejected(requireHotelPermission(db, request(operator, {}), "hotel-a", "catalogproducts", "update", undefined, auth), "permission-denied");
    await rejected(requireHotelPermission(db, request(operator, {}), "hotel-b", "catalogproducts", "read", undefined, auth), "permission-denied");
    await db.doc("hotelSubscriptions/hotel-a").update({ modules: [] });
    await rejected(requireHotelPermission(db, request(operator, {}), "hotel-a", "catalogproducts", "read", undefined, auth), "permission-denied");
  });
  it("denies platform browser access to hotel data, other profiles and platform metadata; ordinary permitted hotel reads still work", async () => {
    const platform = environment.authenticatedContext(operator.uid, operator.token);
    await assertFails(getDoc(doc(platform.firestore(), "hotels/hotel-a/catalogproducts/product")));
    await assertFails(getDoc(doc(platform.firestore(), "hotels/hotel-a")));
    await assertFails(getDoc(doc(platform.firestore(), "users/member")));
    await assertFails(getDocs(collection(platform.firestore(), "users")));
    await assertFails(setDoc(doc(platform.firestore(), "hotels/hotel-a/importMonitors/arrivals"), policy));
    await assertFails(getBytes(ref(platform.storage(), "hotels/hotel-a/catalogproducts/product/images/test.jpg")));
    const employee = environment.authenticatedContext(member.uid, member.token);
    await assertSucceeds(getDoc(doc(employee.firestore(), "hotels/hotel-a/catalogproducts/product")));
    await assertSucceeds(getBytes(ref(employee.storage(), "hotels/hotel-a/catalogproducts/product/images/test.jpg")));
    await assertFails(getDoc(doc(employee.firestore(), "hotels/hotel-b/catalogproducts/product")));
    await assertSucceeds(getDoc(doc(platform.firestore(), "users/operator")));
  });
  it("validates revisions and commits sanitized audit events atomically with hotel details", async () => {
    const payload = { hotelUid: "hotel-a", name: "Renamed", timeZone: "Europe/Brussels", contactName: "Contact", contactEmail: "contact@example.test", expectedRevision: 0 };
    await consoleApi.updatePlatformHotelHandler(request(operator, payload), services);
    await rejected(consoleApi.updatePlatformHotelHandler(request(operator, payload), services), "aborted");
    assert.equal((await db.doc("hotels/hotel-a").get()).data().platformRevision, 1);
    const history = await consoleApi.listPlatformAuditHandler(request(operator, { hotelUid: "hotel-a" }), services);
    assert.equal(history.events.length, 1);
    assert.equal(JSON.stringify(history).includes("contact@example.test"), false);
  });
  it("provides backend-only bounded user administration, including users with zero hotel assignments", async () => {
    const result = await usersApi.listPlatformUsers.run(request(operator, {}));
    assert.equal(result.users.find((user) => user.id === operator.uid).hotelUid.length, 0);
    assert.equal(JSON.stringify(result).includes("DO_NOT_EXPOSE"), false);
    const detail = await usersApi.getPlatformUserAccess.run(request(operator, { userId: member.uid }));
    assert.deepEqual(Object.keys(detail.memberships), ["hotel-a"]);
    await rejected(usersApi.listPlatformUsers.run(request(member, {})), "permission-denied");
    await db.doc("users/member").update({ hotelUid: "malformed-assignment" });
    await rejected(usersApi.getPlatformUserAccess.run(request(operator, { userId: member.uid })), "failed-precondition");
  });
});

describe("monitoring evidence, incidents and telemetry", () => {
  it("keeps unconfigured imports unknown, validates explicit schedules and rejects stale policy saves", async () => {
    const before = await consoleApi.getPlatformMonitoringHandler(request(operator, { hotelUid: "hotel-a" }), services);
    assert.equal(before.monitors[0].health.status, "not-configured");
    await configure();
    await rejected(configure(), "aborted");
    const after = await consoleApi.getPlatformMonitoringHandler(request(operator, { hotelUid: "hotel-a" }), services);
    assert.equal(after.monitors[0].health.status, "overdue");
    assert.equal(after.monitors[0].health.expectedBusinessDate, "2026-10-10");
    assert.equal(JSON.stringify(after).includes("DO_NOT_EXPOSE"), false);
  });
  it("persists missing occurrences; acknowledgment does not heal them; late success resolves the correct occurrence", async () => {
    await configure(); await monitoring.reconcileHotelMonitoring(db, "hotel-a", now);
    const first = (await db.collection("platformIncidents").get()).docs[0];
    await monitoring.acknowledgePlatformIncidentHandler(request(operator, { incidentId: first.id, reason: "Investigating source delivery" }), services);
    assert.equal((await first.ref.get()).data().state, "open");
    await monitoring.reconcileHotelMonitoring(db, "hotel-a", now + 86400000);
    assert.equal((await first.ref.get()).data().state, "open");
    await sourceRun(); await monitoring.reconcileHotelMonitoring(db, "hotel-a", now + 86400000);
    const resolved = (await first.ref.get()).data();
    assert.equal(resolved.state, "resolved"); assert.equal(resolved.acknowledgedBy, operator.uid);
    assert.equal((await db.collection("platformIncidents").get()).docs.filter((row) => row.data().state === "open").length, 1);
  });
  it("distinguishes empty, downstream failure and unavailable record counts without false success", async () => {
    await configure(); const run = await sourceRun({ result: { writtenCount: 0 } });
    const health = async () => (await consoleApi.readHotelMonitoring(db, "hotel-a", now)).monitors[0].health.status;
    assert.equal(await health(), "empty");
    await run.reference.update({ result: { writtenCount: 5 }, downstreamStatus: "failed" }); assert.equal(await health(), "partial");
    await run.reference.update({ result: {}, downstreamStatus: "complete" }); assert.equal(await health(), "unknown");
    await run.reference.update({ result: { writtenCount: 0 } });
    await monitoring.savePlatformImportMonitorHandler(request(operator, { hotelUid: "hotel-a", typeId: "arrivals", expectedRevision: 1, policy: { ...policy, acceptEmpty: true } }), services);
    assert.equal(await health(), "healthy");
  });
  it("projects current run authority, excludes source secrets and rejects a cross-hotel descriptor", async () => {
    const run = await sourceRun();
    await recordImportReceived(db, "hotel-a", run.id, { metadata: { fileType: "arrivals", targetDateOverride: "2026-10-10", password: "DO_NOT_EXPOSE" }, timeCreated: "2026-10-10T08:00:00Z" });
    await syncImportTelemetry(db, "hotel-a", run.id);
    const data = (await db.doc(`hotels/hotel-a/importTelemetry/${run.id}`).get()).data();
    assert.equal(data.status, "succeeded"); assert.equal(data.writtenCount, 3);
    assert.equal(JSON.stringify(data).includes("DO_NOT_EXPOSE"), false);
    await run.reference.update({ descriptor: { ...run.descriptor, hotelUid: "hotel-b" } });
    await assert.rejects(syncImportTelemetry(db, "hotel-a", run.id), /ownership/);
  });
  it("preserves an earlier incident's policy when an operator changes the expected business-date offset", async () => {
    await configure(); await monitoring.reconcileHotelMonitoring(db, "hotel-a", now);
    const earlier = (await db.collection("platformIncidents").get()).docs[0];
    await monitoring.savePlatformImportMonitorHandler(request(operator, { hotelUid: "hotel-a", typeId: "arrivals", expectedRevision: 1, policy: { ...policy, businessDateOffsetDays: -1 } }), services);
    const run = await sourceRun({ configuration: { targetDateOverride: "2026-10-09" } });
    await monitoring.reconcileHotelMonitoring(db, "hotel-a", now + 1000);
    assert.equal((await earlier.ref.get()).data().state, "open");
    assert.equal((await earlier.ref.get()).data().expectedBusinessDate, "2026-10-10");
    await run.reference.update({ configuration: { targetDateOverride: "2026-10-10" }, updatedAt: now + 2000 });
    await monitoring.reconcileHotelMonitoring(db, "hotel-a", now + 2000);
    assert.equal((await earlier.ref.get()).data().state, "resolved");
  });
  it("bounds hotel pages and worker rotation while keeping absence of a monitor explicit", async () => {
    await Promise.all(Array.from({ length: 25 }, (_, i) => db.doc(`hotels/z-${String(i).padStart(2, "0")}`).set({ hotelName: "Fixture" })));
    const first = await consoleApi.listPlatformHotelsHandler(request(operator, {}), services);
    assert.equal(first.hotels.length, 25); assert.ok(first.nextCursor);
    const second = await consoleApi.listPlatformHotelsHandler(request(operator, { afterHotelUid: first.nextCursor }), services);
    assert.equal(second.hotels.length, 2); assert.equal(second.nextCursor, null);
    const cycle = await monitoring.runPlatformMonitoringWorker(services);
    assert.equal(cycle.checkedHotels, 25); assert.equal(cycle.failedHotels, 0);
    assert.equal((await monitoring.runPlatformMonitoringWorker(services)).checkedHotels, 2);
    assert.equal((await db.doc("hotels/hotel-a/platformHealth/imports").get()).data().status, "not-configured");
  });
});

describe("controlled read-only support and checkpoint-preserving recovery", () => {
  it("binds sessions to actor and hotel, expires and ends them, and exposes only sanitized diagnostics", async () => {
    await db.doc("hotels/hotel-a/mailQueue/test").set({ status: "needs-review", payload: { to: ["DO_NOT_EXPOSE"], token: "DO_NOT_EXPOSE" } });
    const session = await support.startPlatformSupportHandler(request(operator, { hotelUid: "hotel-a", requestId: "support-1", reason: "Inspect daily imports" }), services);
    const input = { hotelUid: "hotel-a", sessionId: session.sessionId };
    const result = await support.getPlatformSupportHandler(request(operator, input), services);
    assert.equal(result.session.readOnly, true); assert.equal(result.mail.statuses["needs-review"], 1);
    assert.equal(JSON.stringify(result).includes("DO_NOT_EXPOSE"), false);
    await rejected(support.getPlatformSupportHandler(request(otherOperator, input), services), "permission-denied");
    await rejected(support.getPlatformSupportHandler(request(operator, { ...input, hotelUid: "hotel-b" }), services), "permission-denied");
    await rejected(support.getPlatformSupportHandler(request(operator, input), { ...services, now: () => now + 31 * 60000 }), "permission-denied");
    await support.endPlatformSupportHandler(request(operator, { sessionId: session.sessionId }), services);
    await rejected(support.getPlatformSupportHandler(request(operator, input), services), "permission-denied");
    assert.equal((await db.doc("hotels/hotel-a/members/operator").get()).exists, false);
  });
  it("resumes a pinned failed source once per request without resetting durable checkpoints", async () => {
    const run = await sourceRun({ state: "failed", errorCode: "import-processing-failed", leaseUntil: 0 });
    const checkpoint = run.reference.collection("chunks").doc("00000000"); await checkpoint.set({ inputHash: "committed-hash", summary: { writtenCount: 3 } });
    let executions = 0;
    const recoveryServices = { ...services, bucketName: run.descriptor.bucket,
      loadSource: async () => ({ ...run.descriptor, metadata: { hotelUid: "hotel-a", fileType: "arrivals" } }),
      executeImport: async () => { executions++; assert.equal((await checkpoint.get()).data().inputHash, "committed-hash"); await run.reference.update({ state: "complete" }); } };
    const payload = { hotelUid: "hotel-a", runId: run.id, requestId: "resume-1", reason: "Source issue fixed" };
    assert.equal((await support.retryPlatformImportHandler(request(operator, payload), recoveryServices)).state, "complete");
    assert.equal((await support.retryPlatformImportHandler(request(operator, payload), recoveryServices)).state, "complete");
    assert.equal(executions, 1); assert.equal((await checkpoint.get()).data().inputHash, "committed-hash");
    await rejected(support.retryPlatformImportHandler(request(operator, { ...payload, requestId: "resume-2" }), recoveryServices), "failed-precondition");
    const history = await consoleApi.readHotelMonitoring(db, "hotel-a", now);
    assert.equal(history.recoveries.length, 1); assert.equal(history.recoveries[0].state, "complete");
  });
  it("rejects busy runs, cross-hotel sources and inactive access, and never executes replacement generations", async () => {
    const run = await sourceRun({ state: "processing", leaseUntil: now + 300000 });
    const input = { hotelUid: "hotel-a", runId: run.id, requestId: "resume-1", reason: "Inspect stuck run" };
    await rejected(support.retryPlatformImportHandler(request(operator, input), services), "failed-precondition");
    await run.reference.update({ state: "failed", leaseUntil: 0, descriptor: { ...run.descriptor, hotelUid: "hotel-b" } });
    await rejected(support.retryPlatformImportHandler(request(operator, input), services), "failed-precondition");
    await run.reference.update({ descriptor: run.descriptor }); await db.doc("hotelSubscriptions/hotel-a").update({ status: "suspended" });
    await rejected(support.retryPlatformImportHandler(request(operator, input), services), "permission-denied");
    await db.doc("hotelSubscriptions/hotel-a").update({ status: "active" });
    let executed = false;
    const result = await support.retryPlatformImportHandler(request(operator, input), { ...services,
      loadSource: async () => ({ ...run.descriptor, generation: "2", metadata: { hotelUid: "hotel-a", fileType: "arrivals" } }),
      executeImport: async () => { executed = true; } });
    assert.equal(result.state, "failed"); assert.equal(executed, false);
  });
  it("rechecks authority after storage I/O and records a failed recovery if the platform claim was revoked", async () => {
    const run = await sourceRun({ state: "failed", leaseUntil: 0 }); let executed = false;
    const result = await support.retryPlatformImportHandler(request(operator, { hotelUid: "hotel-a", runId: run.id, requestId: "resume-1", reason: "Investigate failure" }), { ...services,
      loadSource: async () => { await auth.setCustomUserClaims(operator.uid, {}); return { ...run.descriptor, metadata: { hotelUid: "hotel-a", fileType: "arrivals" } }; },
      executeImport: async () => { executed = true; } });
    assert.equal(executed, false); assert.equal(result.state, "failed");
  });
  it("runs real Storage/parser/Firestore recovery and keeps append-mode rows and committed chunk hashes unchanged", async () => {
    const { processImportedFileToFirestore } = require("../../functions/src/fileImportTypes");
    const file = admin.storage().bucket().file("imports/hotel-a/platform-recovery-fixture.csv");
    try {
      const configuration = { fileType: "catalogcsv", parserType: "csv", hasHeaderRow: true, enabled: true,
        basePath: "hotels/{hotelUid}", targetPath: "catalogproducts", writeMode: "append",
        columnMappings: [{ sourceField: "ID", databaseField: "name", targetType: "string" }] };
      await db.doc("hotels/hotel-a/fileImportTypes/catalogcsv").set(configuration);
      await file.save("ID\nFixture one\nFixture two\n", { metadata: { contentType: "text/csv", metadata: { hotelUid: "hotel-a", fileType: "catalogcsv", targetDateOverride: "2026-10-10" } } });
      const [object] = await file.getMetadata();
      await processImportedFileToFirestore.run({ data: object });
      const runId = importRunId(object), source = db.doc(`hotels/hotel-a/importRuns/${runId}`);
      const chunks = (await source.collection("chunks").get()).docs.map((row) => [row.id, row.data().inputHash]);
      assert.ok(chunks.length > 0);
      const before = (await db.collection("hotels/hotel-a/catalogproducts").get()).docs.map((row) => row.id).sort();
      assert.equal(before.length, 3);
      await source.update({ state: "failed", leaseUntil: 0, errorCode: "fixture-post-checkpoint-crash" });
      const result = await support.retryPlatformImport.run(request(operator, { hotelUid: "hotel-a", runId, requestId: "actual-recovery", reason: "Resume committed fixture source" }));
      assert.equal(result.state, "complete");
      assert.deepEqual((await source.collection("chunks").get()).docs.map((row) => [row.id, row.data().inputHash]), chunks);
      assert.deepEqual((await db.collection("hotels/hotel-a/catalogproducts").get()).docs.map((row) => row.id).sort(), before);
      assert.equal((await db.doc(`hotels/hotel-a/importTelemetry/${runId}`).get()).data().writtenCount, 2);
    } finally { await file.delete({ ignoreNotFound: true }); }
  });
});
