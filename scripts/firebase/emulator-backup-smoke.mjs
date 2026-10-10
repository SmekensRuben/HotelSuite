import assert from "node:assert/strict";
import { deleteApp, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { createRequire } from "node:module";

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
const documents = {
  "users/restore-platform": { firstName: "Fictional operator", hotelUid: [], accessRevision: 0 },
  "platformSupportSessions/restore-session": { actorUid: "restore-platform", hotelUid: "restore-hotel-a", state: "active", reason: "Fictional diagnosis", expiresAt: revisionTime },
  "platformAudit/restore-audit": { hotelUid: "restore-hotel-a", actorUid: "restore-platform", action: "support-started", createdAt: revisionTime },
  "hotels/restore-hotel-a/platformAudit/restore-audit": { hotelUid: "restore-hotel-a", actorUid: "restore-platform", action: "support-started", createdAt: revisionTime },
  "platformIncidents/restore-incident": { hotelUid: "restore-hotel-a", state: "open", code: "overdue", acknowledgedBy: "restore-platform", lastDetectedAtMillis: revisionTime.toMillis() },
  "hotels/restore-hotel-a/importTelemetry/restore-run": { runId: "restore-run", fileType: "arrivals", status: "failed", writtenCount: null, receivedAtMillis: revisionTime.toMillis(), updatedAtMillis: revisionTime.toMillis() },
  "hotels/restore-hotel-a/importRecovery/restore-recovery": { runId: "restore-run", actorUid: "restore-platform", state: "failed", startedAtMillis: revisionTime.toMillis() },
  "users/restore-a": { firstName: "Fictional", lastName: "A", hotelUid: ["restore-hotel-a"], accessRevision: 2 },
  "users/restore-b": { firstName: "Fictional", lastName: "B", hotelUid: ["restore-hotel-b"], accessRevision: 1 },
  "hotels/restore-hotel-a/members/restore-a": { permissions: ["orders.read", "users.read", "users.create", "users.update", "users.delete"], hotelAdmin: true, moduleRoles: {}, additionalPermissions: ["orders.read"], rolePolicyVersion: 1, revision: 2 },
  "hotels/restore-hotel-a/memberAdministration/state": { revision: 4, updatedAt: revisionTime, updatedBy: "restore-a" },
  "hotels/restore-hotel-a/accessAudit/member-a": { action: "update-member", uid: "restore-a", actorUid: "restore-a", hotelAdmin: true, revision: 2, createdAt: revisionTime },
  "hotels/restore-hotel-a/settings/bootstrap": { hotelName: "Fictional hotel A", currency: "EUR" },
  "hotels/restore-hotel-a/settings/propertySettings": { hotelRooms: 100 },
  "hotels/restore-hotel-b/members/restore-b": { permissions: ["orders.read"], enabled: true },
  "hotelSubscriptions/restore-hotel-a": { status: "active", validUntil: subscriptionExpiry, modules: ["procurement", "groups", "contracts", "revenue"], modulePolicyVersion: 1, seatLimit: null, revision: 3 },
  "hotelSubscriptions/restore-hotel-b": { status: "trialing", validUntil: subscriptionExpiry, modules: ["procurement", "contracts"], modulePolicyVersion: 1, seatLimit: 10, revision: 1 },
  "hotels/restore-hotel-a/orders/order-a": { status: "Finalized", revision: 4, total: 42.5, updatedAt: revisionTime },
  "hotels/restore-hotel-a/orderAudit/audit-a": { orderId: "order-a", actorUid: "restore-a", action: "finalize", revision: 4, createdAt: revisionTime },
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

try {
  if (process.argv[2] === "seed") {
    await Promise.all([
      auth.createUser({ uid: "restore-platform", email: "restore-platform@example.test", emailVerified: true }),
      auth.createUser({ uid: "restore-a", email: "restore-a@example.test", emailVerified: true, password: "Fictional-Restore-Only-42" }),
      auth.createUser({ uid: "restore-b", email: "restore-b@example.test", emailVerified: true, disabled: true }),
    ]);
    await auth.setCustomUserClaims("restore-a", { hotelUids: ["restore-hotel-a"], platformAdmin: false });
    await auth.setCustomUserClaims("restore-platform", { platformAdmin: true });
    const batch = database.batch();
    for (const [path, value] of Object.entries(documents)) batch.set(database.doc(path), value);
    await batch.commit();
    for (const [path, bytes] of Object.entries(objects)) {
      await bucket.file(path).save(bytes, { metadata: { contentType: "application/pdf", metadata: { fixture: "restore-only" } } });
    }
    console.log("Seeded fictional two-hotel Firestore relationships, Auth users/claims and private Storage bytes.");
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
    assert.deepEqual((await auth.getUser("restore-platform")).customClaims, { platformAdmin: true });
    assert.deepEqual((await database.doc("users/restore-platform").get()).data().hotelUid, []);
    const { requireSupportSession } = createRequire(import.meta.url)("../../functions/src/platformSupport");
    await assert.rejects(requireSupportSession({ auth: { uid: "restore-platform", token: { email_verified: true, platformAdmin: true } },
      data: { hotelUid: "restore-hotel-a", sessionId: "restore-session" } }, { firestore: database, auth }), (error) => error.code === "permission-denied");
    for (const [path, bytes] of Object.entries(objects)) {
      const file = bucket.file(path);
      assert.deepEqual((await file.download())[0], bytes, `Restored bytes differ: ${path}`);
      const [metadata] = await file.getMetadata();
      assert.equal(metadata.contentType, "application/pdf");
      assert.equal(metadata.metadata.fixture, "restore-only");
    }
    console.log("Verified two-hotel data, entitlements, roles, domain history, platform monitoring/audit, zero-hotel operator, expired support denial, Auth state and private Storage bytes/metadata.");
  } else throw new Error("Expected seed or verify mode.");
} finally {
  await deleteApp(app);
}
