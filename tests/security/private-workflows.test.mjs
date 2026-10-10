import { before, beforeEach, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { initializeTestEnvironment, assertFails } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc } from "firebase/firestore";
import { ref, getMetadata, getBytes, uploadString } from "firebase/storage";
import { attachmentDescriptor, inspectPrivateWorkflows, migratePrivateWorkflows } from "../../scripts/firebase/private-workflows-migration.mjs";
const projectId = "demo-hotel-suite-a00";
if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST || !process.env.FIREBASE_STORAGE_EMULATOR_HOST) throw new Error("Real local Auth, Firestore and Storage emulators are required.");
process.env.FIREBASE_CONFIG = JSON.stringify({ projectId, storageBucket: projectId + ".appspot.com" });
const require = createRequire(import.meta.url);
const { admin } = require("../../functions/src/config");
const { listHotelContractsHandler, listContractFollowersHandler, saveHotelContractHandler, uploadContractDocument, readContractFile, contractDocumentHandler } = require("../../functions/src/contractFiles");
const { createRoomingListHandler, getRoomingListHandler, mutateRoomingListHandler, reviewRoomingListHandler, setRoomingListAccessHandler } = require("../../functions/src/roomingLists");
const db = admin.firestore(), auth = admin.auth(), bucket = admin.storage().bucket();
const services = { firestore: db, auth, bucket, appBaseUrl: "https://pilot.example.test" };
let environment, token, counter = 0;
const nextId = () => "request-" + ++counter;
const member = { uid: "member-a", token: { email_verified: true, email: "member-a@example.test" } };
const other = { uid: "member-b", token: { email_verified: true, email: "member-b@example.test" } };
const viewer = { uid: "viewer", token: { email_verified: true, email: "viewer@example.test" } };
const operator = { uid: "operator", token: { email_verified: true, platformAdmin: true, email: "operator@example.test" } };
const request = (identity, data) => ({ auth: identity, data });
const rejected = (promise, code) => assert.rejects(promise, (e) => e.code === code);
const contract = { name: "Maintenance", startDate: "2026-10-01", endDate: "2027-10-01", pricePerMonth: 25, terminationPeriodDays: 30, category: "Maintenance", categoryId: "category", subcategory: "Lift", subcategoryId: "lift", reminderDays: [30, 7], followers: [] };
const reservation = (patch = {}) => ({ firstName: "Ada", lastName: "Lovelace", arrivalDate: "2026-10-12", departureDate: "2026-10-14", roomType: "KING", numberOfAdults: 1, numberOfChildren: 0, comment: "", ...patch });
async function saveContract(identity = member, patch = {}) {
  return saveHotelContractHandler(request(identity, { hotelUid: "hotel-a", contractId: "contract-a", requestId: nextId(), creating: true, expectedRevision: 0, contract, keepFileIds: [], ...patch }), services);
}
async function mutate(action, patch = {}) {
  const root = (await db.doc("roomingListLinks/" + token).get()).data();
  return mutateRoomingListHandler({ data: { token, action, expectedRevision: root.revision, requestId: nextId(), ...patch } }, services);
}
async function submitInitial() { await mutate("add", { reservationId: "reservation-a", reservation: reservation() }); await mutate("submit"); }
async function pendingChange() {
  await submitInitial(); const { request: change } = await mutate("start-change");
  await mutate("update", { reservationId: "reservation-a", reservation: reservation({ comment: "Updated" }) }); await mutate("submit-change"); return change.id;
}
before(async () => {
  environment = await initializeTestEnvironment({ projectId,
    firestore: { host: "127.0.0.1", port: 8080, rules: await readFile("firebase/firestore.rules", "utf8") },
    storage: { host: "127.0.0.1", port: 9199, rules: await readFile("firebase/storage.rules", "utf8") } });
});
beforeEach(async () => {
  await environment.clearFirestore(); await environment.clearStorage();
  // The Rules SDK clears only root objects in its default bucket. These tests
  // also own a separate Admin SDK fixture bucket with nested private objects.
  const [fixtureObjects] = await bucket.getFiles();
  await Promise.all(fixtureObjects.map((object) => object.delete()));
  const users = await auth.listUsers(); if (users.users.length) await auth.deleteUsers(users.users.map((u) => u.uid));
  for (const identity of [member, other, viewer, operator]) await auth.createUser({ uid: identity.uid, email: identity.token.email, emailVerified: true });
  await auth.setCustomUserClaims(operator.uid, { platformAdmin: true });
  await db.doc("platformConfiguration/saasProcurement").set({ enabled: true, rulesVersion: "saas-modules-v2" });
  await db.doc("platformConfiguration/privateWorkflows").set({ enabled: true, rulesVersion: "private-workflows-v1" });
  for (const id of ["hotel-a", "hotel-b"]) { await db.doc("hotels/" + id).set({ hotelName: id }); await db.doc("hotelSubscriptions/" + id).set({ modules: ["procurement", "contracts", "frontoffice", "groups", "revenue"], modulePolicyVersion: 1, status: "active", validUntil: null }); }
  await db.doc("hotels/hotel-a/members/member-a").set({ permissions: ["contracts.*", "roominglists.*"] });
  await db.doc("hotels/hotel-b/members/member-b").set({ permissions: ["contracts.*", "roominglists.*"] });
  await db.doc("hotels/hotel-a/members/viewer").set({ permissions: ["contracts.read", "roominglists.read"] });
  await db.doc("hotels/hotel-a/groups/group-a").set({ groupName: "Conference", arrival: "2026-10-12", departure: "2026-10-14", organiserEmail: "private@example.test",
    roomTypeDays: ["2026-10-12", "2026-10-13"].map((date) => ({ date, roomTypes: [{ code: "KING", name: "King", quantity: 1 }] })) });
  token = (await createRoomingListHandler(request(member, { hotelUid: "hotel-a", groupId: "group-a" }), services)).token;
});
after(async () => environment.cleanup());
describe("private documents with real emulator identity, Storage and transaction boundaries", () => {
  it("saves metadata with canonical actors, detects stale updates and safely resumes the same save", async () => {
    const input = { hotelUid: "hotel-a", contractId: "contract-a", requestId: nextId(), creating: true, expectedRevision: 0, contract, keepFileIds: [] };
    const first = await saveHotelContractHandler(request(member, input), services);
    assert.deepEqual(await saveHotelContractHandler(request(member, input), services), first);
    assert.equal((await db.doc("hotels/hotel-a/contracts/contract-a").get()).data().createdBy, member.uid);
    await rejected(saveHotelContractHandler(request(member, { ...input, contract: { ...contract, name: "Changed" } }), services), "already-exists");
    await rejected(saveContract(member, { creating: false, contract: { ...contract, name: "Changed" } }), "aborted");
    await rejected(saveContract(other), "permission-denied"); await rejected(saveContract(viewer), "permission-denied");
  });
  it("uploads binary files without tokens and rechecks current membership, subscription and attachment existence for downloads", async () => {
    const fileId = "a".repeat(32), requestId = nextId();
    await saveContract(member, { requestId, uploadFileIds: [fileId] });
    const input = { hotelUid: "hotel-a", contractId: "contract-a", fileId, fileName: "maintenance.pdf", creating: "true", requestId };
    await uploadContractDocument(request(member), input, Buffer.from("private fixture"), services);
    await uploadContractDocument(request(member), input, Buffer.from("private fixture"), services);
    const snapshot = (await db.doc("hotels/hotel-a/contracts/contract-a").get()).data();
    assert.equal(snapshot.contractFiles.length, 1);
    const [metadata] = await bucket.file(snapshot.contractFiles[0].filePath).getMetadata();
    assert.equal(metadata.metadata?.firebaseStorageDownloadTokens, undefined);
    assert.equal((await readContractFile(request(viewer), input, services)).bytes.toString(), "private fixture");
    await rejected(readContractFile(request(other), input, services), "permission-denied");
    await db.doc("hotelSubscriptions/hotel-a").update({ status: "suspended" });
    await rejected(readContractFile(request(viewer), input, services), "permission-denied");
    await rejected(readContractFile(request(operator), input, services), "permission-denied");
    await db.doc("hotelSubscriptions/hotel-a").update({ modules: ["procurement", "contracts", "frontoffice", "groups", "revenue"], modulePolicyVersion: 1, status: "active" });
    await db.doc("hotels/hotel-a/members/viewer").delete();
    await rejected(readContractFile(request(viewer), input, services), "permission-denied");
    await saveContract(member, { creating: false, expectedRevision: snapshot.revision, contract: { ...contract, name: "Revised" } });
    await rejected(readContractFile(request(member), input, services), "not-found");
    await rejected(uploadContractDocument(request(member), input, Buffer.from("private fixture"), services), "aborted");
  });
  it("rejects uploads not planned by an authorized save and enforces removal permissions", async () => {
    const fileId = "b".repeat(32), requestId = nextId(); await saveContract(member, { requestId, uploadFileIds: [fileId] });
    const input = { hotelUid: "hotel-a", contractId: "contract-a", fileId, fileName: "file.pdf", creating: "true", requestId };
    await rejected(uploadContractDocument(request(other), input, Buffer.from("fixture"), services), "permission-denied");
    await rejected(uploadContractDocument(request(member), { ...input, fileId: "c".repeat(32) }, Buffer.from("fixture"), services), "permission-denied");
    await rejected(uploadContractDocument(request(member), input, Buffer.alloc(0), services), "invalid-argument");
    await uploadContractDocument(request(member), input, Buffer.from("fixture"), services);
    await db.doc("hotels/hotel-a/members/member-a").update({ permissions: ["contracts.update", "contracts.read"] });
    await rejected(saveContract(member, { creating: false, expectedRevision: 2 }), "permission-denied");
  });
  it("serves only safe contract projections and derives followers from verified hotel membership and Auth", async () => {
    await saveContract();
    await db.doc("hotels/hotel-a/contracts/contract-a").update({ secretNote: "private internal field", contractFiles: [] });
    const result = await listHotelContractsHandler(request(viewer, { hotelUid: "hotel-a", contractId: "contract-a" }), services);
    assert.equal(result.contract.secretNote, undefined);
    await rejected(listContractFollowersHandler(request(viewer, { hotelUid: "hotel-a" }), services), "permission-denied");
    const directory = await listContractFollowersHandler(request(member, { hotelUid: "hotel-a" }), services);
    assert.deepEqual(directory.users.map((u) => u.id).sort(), [member.uid, viewer.uid].sort());
    await rejected(saveContract(member, { contractId: "contract-b", contract: { ...contract, followers: [{ id: other.uid, email: "forged@example.test" }] } }), "failed-precondition");
  });
  it("rejects disabled staff and removed platform claims even with a previously verified token", async () => {
    await saveContract(); await auth.updateUser(member.uid, { disabled: true });
    await rejected(listHotelContractsHandler(request(member, { hotelUid: "hotel-a" }), services), "permission-denied");
    await auth.setCustomUserClaims(operator.uid, {});
    await rejected(listHotelContractsHandler(request(operator, { hotelUid: "hotel-a" }), services), "permission-denied");
  });
  it("HTTP access rejects query credentials and verifies revocation without revealing metadata", async () => {
    const results = [];
    const res = { set() {}, status(value) { results.push(value); return this; }, json(body) { results.push(body); }, send(body) { results.push(body); } };
    await contractDocumentHandler({ method: "GET", headers: {}, query: { token: "fictional" } }, res, services);
    assert.equal(results[0], 401);
    const fakeAuth = { async verifyIdToken(_value, revoked) { assert.equal(revoked, true); throw new Error("revoked"); } };
    results.length = 0;
    await contractDocumentHandler({ method: "GET", headers: { authorization: "Bearer fictional-test-token" }, query: {} }, res, { ...services, auth: fakeAuth });
    assert.equal(results[0], 401); assert.equal(JSON.stringify(results).includes("fictional-test-token"), false);
  });
  it("denies raw Firestore, Storage metadata and token minting even for platform administrators", async () => {
    const fileId = "a".repeat(32), requestId = nextId();
    await saveContract(member, { requestId, uploadFileIds: [fileId] });
    await uploadContractDocument(request(member), { hotelUid: "hotel-a", contractId: "contract-a", fileId, fileName: "file.pdf", creating: "true", requestId }, Buffer.from("private fixture"), services);
    await bucket.file("hotels/hotel-a/contracts/contract-a/file.pdf").save(Buffer.from("legacy fixture"), { resumable: false });
    for (const identity of [member, operator]) {
      const context = environment.authenticatedContext(identity.uid, identity.token);
      for (const collection of ["contracts", "contractOperations", "contractAttachments", "contractAudit"]) {
        await assertFails(getDoc(doc(context.firestore(), "hotels/hotel-a/" + collection + "/contract-a")));
        await assertFails(setDoc(doc(context.firestore(), "hotels/hotel-a/" + collection + "/forged"), { filePath: "cross-hotel", status: "attached" }));
      }
      for (const path of ["hotels/hotel-a/contracts/contract-a/file.pdf", "private/contracts/hotel-a/contract-a/" + "a".repeat(32)]) {
        await assertFails(getMetadata(ref(context.storage("gs://" + bucket.name), path))); await assertFails(getBytes(ref(context.storage("gs://" + bucket.name), path))); await assertFails(uploadString(ref(context.storage("gs://" + bucket.name), path), "denied"));
      }
    }
  });
  it("makes no mutations while the separate private-workflow activation is paused", async () => {
    await db.doc("platformConfiguration/privateWorkflows").update({ enabled: false });
    await rejected(saveContract(), "failed-precondition");
    await rejected(mutate("add", { reservationId: "one", reservation: reservation() }), "failed-precondition");
    assert.equal((await db.doc("hotels/hotel-a/contracts/contract-a").get()).exists, false);
  });
});
describe("public organizer capabilities with backend capacity and private approvals", () => {
  it("projects only this group and rejects unknown, disabled, expired and suspended capabilities", async () => {
    const view = await getRoomingListHandler({ data: { token } }, services);
    assert.equal(view.groupName, "Conference"); for (const field of ["hotelUid", "groupId", "createdBy", "organiserEmail"]) assert.equal(view[field], undefined);
    await rejected(getRoomingListHandler({ data: { token: "f".repeat(48) } }, services), "not-found");
    const root = db.doc("roomingListLinks/" + token);
    await root.update({ publicAccessEnabled: false }); await rejected(getRoomingListHandler({ data: { token } }, services), "not-found");
    await root.update({ publicAccessEnabled: true, publicAccessExpiresAt: admin.firestore.Timestamp.fromMillis(1) }); await rejected(mutate("submit"), "not-found");
    await root.update({ publicAccessExpiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + 3600000) });
    await db.doc("hotelSubscriptions/hotel-a").update({ status: "suspended" }); await rejected(mutate("submit"), "permission-denied");
    await rejected(getRoomingListHandler(request(other, { token, internal: true }), services), "permission-denied");
  });
  it("serializes simultaneous submissions and never overbooks the last room", async () => {
    const input = { token, action: "add", expectedRevision: 0, reservation: reservation() };
    const results = await Promise.allSettled([1, 2].map((i) => mutateRoomingListHandler({ data: { ...input, reservationId: "reservation-" + i, requestId: nextId() } }, services)));
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(results.find((r) => r.status === "rejected").reason.code, "aborted");
    await rejected(mutate("add", { reservationId: "extra", reservation: reservation() }), "failed-precondition");
    const root = (await db.doc("roomingListLinks/" + token).get()).data(); assert.equal(root.reservations.length, 1);
  });
  it("replays the same request without adding a duplicate and rejects altered replay payloads", async () => {
    const input = { token, action: "add", expectedRevision: 0, reservation: reservation(), reservationId: "one", requestId: nextId() };
    const first = await mutateRoomingListHandler({ data: input }, services);
    assert.deepEqual(await mutateRoomingListHandler({ data: input }, services), first);
    await rejected(mutateRoomingListHandler({ data: { ...input, reservation: reservation({ comment: "changed" }) } }, services), "already-exists");
    assert.equal((await db.doc("roomingListLinks/" + token + "/operations/" + input.requestId).get()).data().result.revision, 1);
  });
  it("keeps official reservations unchanged until a verified authorized approval commits a new version", async () => {
    const id = await pendingChange();
    const root = db.doc("roomingListLinks/" + token), before = (await root.get()).data();
    assert.equal(before.reservations[0].comment, "");
    await rejected(mutate("update", { reservationId: "reservation-a", reservation: reservation() }), "failed-precondition");
    const input = { token, changeRequestId: id, expectedRevision: before.revision, requestId: nextId(), decision: "approve" };
    await rejected(reviewRoomingListHandler({ data: input }, services), "unauthenticated");
    await rejected(reviewRoomingListHandler(request(other, input), services), "permission-denied"); await rejected(reviewRoomingListHandler(request(viewer, input), services), "permission-denied");
    await rejected(reviewRoomingListHandler(request({ ...member, token: { email_verified: false } }, input), services), "permission-denied");
    const result = await reviewRoomingListHandler(request(member, input), services);
    assert.deepEqual(await reviewRoomingListHandler(request(member, input), services), result);
    assert.equal((await root.get()).data().reservations[0].comment, "Updated"); assert.equal((await root.get()).data().currentVersionNumber, 2);
    assert.equal((await root.collection("versions").get()).size, 2);
    const publicResult = await getRoomingListHandler({ data: { token } }, services); assert.equal(publicResult.changeRequests.length, 0); assert.equal(publicResult.versions.length, 0);
  });
  it("rejects stale reviews and changed capacity; rejection notes remain internal", async () => {
    const id = await pendingChange(), rootRef = db.doc("roomingListLinks/" + token), root = (await rootRef.get()).data();
    const input = { token, changeRequestId: id, expectedRevision: root.revision, requestId: nextId(), decision: "approve" };
    await rejected(reviewRoomingListHandler(request(member, { ...input, expectedRevision: root.revision - 1 }), services), "aborted");
    const restricted = root.roomTypeDays.map((day) => ({ ...day, roomTypes: day.roomTypes.map((r) => ({ ...r, quantity: 0 })) }));
    await rootRef.update({ roomTypeDays: restricted }); await rejected(reviewRoomingListHandler(request(member, input), services), "failed-precondition");
    await reviewRoomingListHandler(request(member, { ...input, requestId: nextId(), decision: "reject", rejectionReason: "Private staffing note" }), services);
    const publicResult = await getRoomingListHandler({ data: { token } }, services); assert.equal(JSON.stringify(publicResult).includes("Private staffing note"), false);
    const internal = await getRoomingListHandler(request(member, { token, internal: true }), services); assert.equal(internal.changeRequests[0].rejectionReason, "Private staffing note");
  });
  it("enforces limits, supports canceling drafts and disables links without changing official history", async () => {
    await submitInitial(); await mutate("start-change"); await mutate("cancel-change");
    const ref = db.doc("roomingListLinks/" + token), root = (await ref.get()).data(); assert.equal(root.activeRequestId, null);
    await ref.update({ mutationTotal: 2000 }); await rejected(mutate("start-change"), "resource-exhausted");
    await setRoomingListAccessHandler(request(member, { token, expectedRevision: root.revision, enabled: false, expiresAtMillis: Date.now() + 86400000 }), services);
    await rejected(getRoomingListHandler({ data: { token } }, services), "not-found"); assert.equal((await ref.collection("versions").get()).size, 1);
  });
  it("prevents raw root, history and approval writes for anonymous users and platform operators", async () => {
    for (const context of [environment.unauthenticatedContext(), environment.authenticatedContext(operator.uid, operator.token)]) {
      for (const path of ["roomingListLinks/" + token, "roomingListLinks/" + token + "/changeRequests/forged", "roomingListLinks/" + token + "/versions/1"]) {
        await assertFails(getDoc(doc(context.firestore(), path))); await assertFails(setDoc(doc(context.firestore(), path), { status: "Approved", hotelUid: "hotel-b" }));
      }
    }
  });
});
describe("operator file migration with real Storage objects", () => {
  it("copies real legacy bytes but blocks activation when the Storage emulator retains revoked tokens", async () => {
    const oldPath = "hotels/hotel-a/contracts/legacy/fixture.pdf", orphan = "hotels/deleted-hotel/contracts/removed/orphan.pdf";
    await bucket.file(oldPath).save(Buffer.from("legacy fixture"), { resumable: false, metadata: { metadata: { firebaseStorageDownloadTokens: "fictional-legacy-token" } } });
    await bucket.file(orphan).save(Buffer.from("orphan fixture"), { resumable: false, metadata: { metadata: { firebaseStorageDownloadTokens: "fictional-orphan-token" } } });
    await db.doc("hotels/hotel-a/contracts/legacy").set({ name: "Legacy", contractFile: { fileName: "fixture.pdf", filePath: oldPath, downloadUrl: "https://example.test/?token=fictional" } });
    await db.doc("roomingListLinks/" + token).update({ publicAccessEnabled: false });
    const inspection = await inspectPrivateWorkflows(db, bucket, { emulator: true });
    assert.equal(inspection.summary.downloadTokens, 2); assert.equal(inspection.summary.legacyFiles, 1); assert.deepEqual(inspection.summary.issues, []);
    assert.equal((await bucket.file(oldPath).getMetadata())[0].metadata.firebaseStorageDownloadTokens, "fictional-legacy-token");
    await db.doc("platformConfiguration/privateWorkflows").update({ enabled: false });
    // firebase-tools 15.32.1 stores tokens separately and ignores their null deletion
    // through the GCS metadata API. Production verification must not be weakened.
    await assert.rejects(migratePrivateWorkflows(db, bucket, inspection, admin.firestore.FieldValue, "fixture-operator"), /still has a download token/);
    const updated = (await db.doc("hotels/hotel-a/contracts/legacy").get()).data();
    assert.equal(updated.contractFile, undefined); assert.equal(updated.contractFiles[0].downloadUrl, undefined);
    assert.equal((await bucket.file(updated.contractFiles[0].filePath).download())[0].toString(), "legacy fixture");
    assert.equal((await bucket.file(updated.contractFiles[0].filePath).getMetadata())[0].metadata?.firebaseStorageDownloadTokens, undefined);
    assert.equal((await db.doc("platformConfiguration/privateWorkflows").get()).data().enabled, false);
    assert.equal((await db.doc("roomingListLinks/" + token).get()).data().publicAccessEnabled, false);
    const after = await inspectPrivateWorkflows(db, bucket, { emulator: true });
    assert.equal(after.summary.legacyFiles, 0); assert.equal(after.summary.legacyUrls, 0); assert.equal(after.summary.downloadTokens, 2);
  });
  it("runs the actual operator helper in local-only mode and enables only a clean reviewed inventory", async () => {
    const run = promisify(execFile);
    const command = (mode) => run(process.execPath, ["scripts/firebase/private-workflows-rollout.mjs", mode, "--emulator"], { env: process.env, timeout: 30000 });
    const preflight = await command("preflight"); assert.match(preflight.stdout, /"legacyFiles": 0/);
    await command("pause"); assert.equal((await db.doc("platformConfiguration/privateWorkflows").get()).data().enabled, false);
    await command("enable"); assert.equal((await db.doc("platformConfiguration/privateWorkflows").get()).data().rulesVersion, "private-workflows-v1");
    assert.equal((await db.doc("hotelSubscriptions/hotel-a").get()).data().status, "active");
    await command("pause"); await db.doc("platformConfiguration/saasProcurement").update({ enabled: false });
    await assert.rejects(command("enable")); assert.equal((await db.doc("platformConfiguration/privateWorkflows").get()).data().enabled, false);
  });
  it("rejects cross-hotel migration paths and missing files before any copy or token revocation", async () => {
    assert.throws(() => attachmentDescriptor({ fileName: "x", filePath: "hotels/hotel-b/contracts/legacy/file.pdf" }, "hotel-a", "legacy"));
    await db.doc("hotels/hotel-a/contracts/missing").set({ contractFiles: [{ fileName: "missing", filePath: "hotels/hotel-a/contracts/missing/file.pdf" }] });
    const inspection = await inspectPrivateWorkflows(db, bucket, { emulator: true }); assert.equal(inspection.summary.issues.length, 1);
    await assert.rejects(migratePrivateWorkflows(db, bucket, inspection, admin.firestore.FieldValue, "fixture-operator"));
    assert.equal((await db.doc("hotels/hotel-a/contracts/missing").get()).data().filesMigratedAt, undefined);
  });
});
