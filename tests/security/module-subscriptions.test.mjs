import { before, beforeEach, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, collection, getDocs } from "firebase/firestore";
import { ref, uploadBytes, getBytes } from "firebase/storage";

if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST || !process.env.FIREBASE_STORAGE_EMULATOR_HOST) throw new Error("Local Auth, Firestore and Storage emulators are required.");
const projectId = "demo-hotel-suite-a00";
process.env.FIREBASE_CONFIG = JSON.stringify({ projectId, storageBucket: `${projectId}.appspot.com` });
const require = createRequire(import.meta.url);
const { admin } = require("../../functions/src/config");
const { createHotelHandler, inviteHotelUserHandler } = require("../../functions/src/onboarding");
const { listHotelTeamHandler, updateHotelMemberHandler, removeHotelMemberHandler } = require("../../functions/src/hotelTeam");
const { updateUserAccessHandler } = require("../../functions/src/userAccess");
const { requireHotelPermission } = require("../../functions/src/authorization");
const { processMailQueueHandler } = require("../../functions/src/mailQueue");
const { resolveAuthorizedRecipients } = require("../../functions/src/scheduledMailDelivery");
const { claimDispatch } = require("../../functions/src/deliveryState");
const { commitImportChunk } = require("../../functions/src/importProcessing");
const { SAAS_RULES_VERSION } = require("../../functions/src/saasRollout");
const runFile = promisify(execFile);
const db = admin.firestore();
const auth = admin.auth();
const services = { firestore: db, auth, appBaseUrl: "https://modules.example.test" };
const operator = { uid: "modules-operator", token: { platformAdmin: true, email_verified: true } };
const req = (actor, data) => ({ auth: actor, data });
const rejected = (promise, code) => assert.rejects(promise, (error) => error.code === code);
let environment, adminA, backupA, adminB, buyer;
let sequence = 0;
const next = () => `modules-request-${++sequence}`;
async function invite(hotelUid, details, actor = operator) {
  const email = details.email || `${next()}@example.test`;
  const result = await inviteHotelUserHandler(req(actor, { hotelUid, email, requestId: next(), ...details }), services);
  await auth.updateUser(result.uid, { emailVerified: true });
  return { uid: result.uid, token: { email, email_verified: true } };
}
const client = (actor) => environment.authenticatedContext(actor.uid, actor.token).firestore();
const member = (actor, hotel = "hotel-a") => db.doc(`hotels/${hotel}/members/${actor.uid}`);
const update = (target, changes, actor = adminA, hotelUid = "hotel-a") => updateHotelMemberHandler(req(actor,
  { hotelUid, userId: target.uid, firstName: "Member", lastName: "", hotelAdmin: false, moduleRoles: {}, additionalPermissions: [], expectedRevision: 1, ...changes }), services);
const remove = (target, actor = adminA, hotelUid = "hotel-a") => removeHotelMemberHandler(req(actor, { hotelUid, userId: target.uid, expectedRevision: 1, requestId: next() }), services);

before(async () => {
  environment = await initializeTestEnvironment({ projectId,
    firestore: { host: "127.0.0.1", port: 8080, rules: await readFile("firebase/firestore.rules", "utf8") },
    storage: { host: "127.0.0.1", port: 9199, rules: await readFile("firebase/storage.rules", "utf8") } });
});
beforeEach(async () => {
  await environment.clearFirestore();
  const users = await auth.listUsers();
  if (users.users.length) await auth.deleteUsers(users.users.map((user) => user.uid));
  await auth.createUser({ uid: operator.uid, email: "modules-operator@example.test", emailVerified: true });
  await auth.setCustomUserClaims(operator.uid, { platformAdmin: true });
  for (const hotelUid of ["hotel-a", "hotel-b"]) await createHotelHandler(req(operator,
    { hotelUid, name: hotelUid, status: "active", modules: ["procurement"], requestId: next() }), services);
  await db.doc("platformConfiguration/saasProcurement").set({ enabled: true, rulesVersion: SAAS_RULES_VERSION });
  adminA = await invite("hotel-a", { hotelAdmin: true });
  backupA = await invite("hotel-a", { hotelAdmin: true });
  adminB = await invite("hotel-b", { hotelAdmin: true });
  buyer = await invite("hotel-a", { moduleRoles: { procurement: ["buyer"] } }, adminA);
});
after(async () => environment.cleanup());

describe("module subscriptions and delegated hotel administration", () => {
  it("onboards a procurement-only hotel and keeps hotel administration separate from operational grants", async () => {
    const subscription = (await db.doc("hotelSubscriptions/hotel-a").get()).data();
    assert.deepEqual(subscription.modules, ["procurement"]);
    assert.equal(subscription.seatLimit, null);
    assert.equal(subscription.modulePolicyVersion, 1);
    assert.deepEqual((await member(adminA).get()).data().permissions, ["dashboard.read", "users.create", "users.delete", "users.read", "users.update"]);
    assert.deepEqual((await auth.getUser(adminA.uid)).customClaims || {}, {});
    await rejected(requireHotelPermission(db, req(adminA), "hotel-a", "orders", "read", undefined, auth), "permission-denied");
    await requireHotelPermission(db, req(buyer), "hotel-a", "orders", "create", undefined, auth);
  });
  it("hotel administrators list only their own members and cannot expose another hotel's users or global profiles", async () => {
    const result = await listHotelTeamHandler(req(adminA, { hotelUid: "hotel-a" }), services);
    assert.equal(result.users.length, 3);
    assert.equal(result.users.some((user) => user.id === adminB.uid), false);
    assert.equal(JSON.stringify(result).includes("hotel-b"), false);
    await rejected(listHotelTeamHandler(req(adminA, { hotelUid: "hotel-b" }), services), "permission-denied");
    await rejected(listHotelTeamHandler(req(adminA, { hotelUid: "hotel-a", userId: adminB.uid }), services), "not-found");
    await assertFails(getDocs(collection(client(adminA), "users")));
    await assertFails(getDoc(doc(client(adminA), `users/${adminB.uid}`)));
    await assertSucceeds(getDoc(doc(client(adminA), `hotels/hotel-a/members/${buyer.uid}`)));
  });
  it("keeps legacy members editable through safe hotel-scoped identity hydration", async () => {
    await member(buyer).update({ firstName: admin.firestore.FieldValue.delete(), lastName: admin.firestore.FieldValue.delete(), email: admin.firestore.FieldValue.delete() });
    await db.doc(`users/${buyer.uid}`).update({ firstName: "Legacy name", lastName: "Member" });
    const result = await listHotelTeamHandler(req(adminA, { hotelUid: "hotel-a" }), services);
    const legacy = result.users.find((user) => user.id === buyer.uid);
    assert.equal(legacy.firstName, "Legacy name");
    assert.equal(legacy.email, buyer.token.email);
    assert.equal(Object.hasOwn(legacy, "hotelUid"), false);
    await update(buyer, { firstName: "Hotel-local name", moduleRoles: { procurement: ["buyer"] } });
    const refreshed = await listHotelTeamHandler(req(adminA, { hotelUid: "hotel-a" }), services);
    assert.equal(refreshed.users.find((user) => user.id === buyer.uid).firstName, "Hotel-local name");
    assert.equal((await db.doc(`users/${buyer.uid}`).get()).data().firstName, "Legacy name");
  });
  it("non-administrators and legacy users.* grants cannot delegate hotel or platform authority", async () => {
    await member(buyer).update({ permissions: ["users.*", "orders.*"] });
    await rejected(invite("hotel-a", { hotelAdmin: true }, buyer), "permission-denied");
    await rejected(update(adminA, { hotelAdmin: false }, buyer), "permission-denied");
    await rejected(inviteHotelUserHandler(req(adminA, { hotelUid: "hotel-a", email: "new@example.test", role: "platformAdmin", requestId: next() }), services), "invalid-argument");
    await rejected(update(buyer, { additionalPermissions: ["users.*"] }), "invalid-argument");
    await assertFails(setDoc(doc(client(adminA), `hotels/hotel-a/members/${buyer.uid}`), { hotelAdmin: true }));
    await assertFails(setDoc(doc(client(adminA), "hotelSubscriptions/hotel-a"), { modules: ["contracts"] }));
    await assertFails(setDoc(doc(client(adminA), "hotels/hotel-a/memberAdministration/state"), { revision: 999 }));
  });
  it("module roles and wildcard action grants never unlock a module absent from the subscription", async () => {
    await member(buyer).update({ permissions: ["orders.*", "contracts.*", "groupquotes.*", "catalogproducts.*"] });
    await db.doc("hotels/hotel-a/quotes/example").set({ name: "Private revenue" });
    await db.doc("hotels/hotel-a/catalogproducts/example").set({ name: "Coffee" });
    await assertSucceeds(getDoc(doc(client(buyer), "hotels/hotel-a/catalogproducts/example")));
    await assertFails(getDoc(doc(client(buyer), "hotels/hotel-a/quotes/example")));
    await rejected(requireHotelPermission(db, req(buyer), "hotel-a", "contracts", "read", undefined, auth), "permission-denied");
    await rejected(update(buyer, { additionalPermissions: ["contracts.read"] }), "permission-denied");
    await rejected(update(buyer, { moduleRoles: { revenue: ["manager"] } }), "permission-denied");
    const storage = environment.authenticatedContext(buyer.uid, buyer.token).storage();
    const image = ref(storage, `hotels/hotel-a/catalogproducts/${next()}.png`);
    await assertSucceeds(uploadBytes(image, new Uint8Array([1, 2]), { contentType: "image/png" }));
    await db.doc("hotelSubscriptions/hotel-a").update({ modules: [] });
    await assertFails(getBytes(image));
    await assertFails(getDoc(doc(client(buyer), "hotels/hotel-a/catalogproducts/example")));
    await rejected(requireHotelPermission(db, req(buyer), "hotel-a", "orders", "read", undefined, auth), "permission-denied");
    assert.ok((await member(buyer).get()).data().permissions.includes("orders.*"));
  });
  it("missing or invalid module policies fail closed and plan labels do not grant access", async () => {
    await db.doc("hotels/hotel-a/catalogproducts/example").set({ name: "Coffee" });
    await member(buyer).update({ permissions: ["catalogproducts.read"] });
    for (const subscription of [{ status: "active", validUntil: null, planId: "everything" },
      { status: "active", validUntil: null, modules: ["procurement"], modulePolicyVersion: 99 },
      { status: "active", validUntil: null, modules: ["procurement", "procurement"], modulePolicyVersion: 1 }]) {
      await db.doc("hotelSubscriptions/hotel-a").set(subscription);
      await assertFails(getDoc(doc(client(buyer), "hotels/hotel-a/catalogproducts/example")));
      await rejected(listHotelTeamHandler(req(adminA, { hotelUid: "hotel-a" }), services), "permission-denied");
    }
  });
  it("combines buyer and approver roles, enforces revisions and preserves independent hotel profiles", async () => {
    const other = await invite("hotel-b", { email: buyer.token.email, moduleRoles: { procurement: ["viewer"] } });
    const otherBefore = (await member(other, "hotel-b").get()).data();
    const rootBefore = (await db.doc(`users/${buyer.uid}`).get()).data();
    await update(buyer, { moduleRoles: { procurement: ["buyer", "approver"] }, firstName: "Local name" });
    const current = (await member(buyer).get()).data();
    assert.ok(current.permissions.includes("orders.create") && current.permissions.includes("orders.approve"));
    assert.equal(current.firstName, "Local name");
    assert.deepEqual((await member(other, "hotel-b").get()).data(), otherBefore);
    assert.equal((await db.doc(`users/${buyer.uid}`).get()).data().firstName, rootBefore.firstName);
    await rejected(update(buyer, { moduleRoles: {} }), "aborted");
    await rejected(update(buyer, { hotelAdmin: true }, adminB), "permission-denied");
  });
  it("retains explicit custom rights and dormant module roles when administrative details change", async () => {
    await db.doc("hotelSubscriptions/hotel-a").update({ modules: [] });
    const before = (await member(buyer).get()).data();
    await update(buyer, { hotelAdmin: false, moduleRoles: before.moduleRoles, additionalPermissions: [] });
    assert.deepEqual((await member(buyer).get()).data().permissions, before.permissions);
    await rejected(update(buyer, { expectedRevision: 2, additionalPermissions: ["contracts.read"] }), "permission-denied");
  });
  it("prevents concurrent removals of the last two administrators and protects the legacy platform endpoint too", async () => {
    const results = await Promise.allSettled([remove(adminA, operator), remove(backupA, operator)]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const admins = await db.collection("hotels/hotel-a/members").where("hotelAdmin", "==", true).get();
    assert.equal(admins.size, 1);
    const survivor = admins.docs[0];
    const root = (await db.doc(`users/${survivor.id}`).get()).data();
    await rejected(updateUserAccessHandler(req(operator, { userId: survivor.id, profile: { hotelUid: [] }, memberships: {}, expectedAccessRevision: root.accessRevision }), services), "failed-precondition");
    await rejected(updateHotelMemberHandler(req(operator, { hotelUid: "hotel-a", userId: survivor.id, hotelAdmin: false, expectedRevision: 1 }), services), "failed-precondition");
  });
  it("serializes concurrent invitation seat checks and retains existing access after lowering the limit", async () => {
    await db.doc("hotelSubscriptions/hotel-a").update({ seatLimit: 4 });
    const results = await Promise.allSettled([invite("hotel-a", { moduleRoles: { procurement: ["viewer"] } }, adminA), invite("hotel-a", { moduleRoles: { procurement: ["viewer"] } }, adminA)]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal((await db.collection("hotels/hotel-a/members").get()).size, 4);
    await db.doc("hotelSubscriptions/hotel-a").update({ seatLimit: 2 });
    await requireHotelPermission(db, req(buyer), "hotel-a", "orders", "create", undefined, auth);
    await rejected(invite("hotel-a", {}, adminA), "resource-exhausted");
    const root = (await db.doc(`users/${adminB.uid}`).get()).data();
    await rejected(updateUserAccessHandler(req(operator, { userId: adminB.uid, profile: { hotelUid: ["hotel-a", "hotel-b"] }, memberships: { "hotel-a": [], "hotel-b": [] }, expectedAccessRevision: root.accessRevision }), services), "resource-exhausted");
  });
  it("removes only one hotel's membership and keeps a shared account, password and other assignment", async () => {
    await invite("hotel-b", { email: buyer.token.email, moduleRoles: { procurement: ["viewer"] } });
    await auth.updateUser(buyer.uid, { password: "Fictional-password-123" });
    const otherBefore = (await member(buyer, "hotel-b").get()).data();
    const details = { hotelUid: "hotel-a", userId: buyer.uid, expectedRevision: 1, requestId: next() };
    await removeHotelMemberHandler(req(adminA, details), services);
    await removeHotelMemberHandler(req(adminA, details), services);
    assert.equal((await member(buyer).get()).exists, false);
    assert.deepEqual((await member(buyer, "hotel-b").get()).data(), otherBefore);
    assert.deepEqual((await db.doc(`users/${buyer.uid}`).get()).data().hotelUid, ["hotel-b"]);
    assert.equal((await auth.getUser(buyer.uid)).disabled, false);
  });
  it("resends without replacing roles and rechecks the hotel invitation actor at delivery", async () => {
    const previous = (await member(buyer).get()).data();
    const id = next();
    await inviteHotelUserHandler(req(adminA, { hotelUid: "hotel-a", email: buyer.token.email, resend: true, requestId: id, moduleRoles: {} }), services);
    assert.deepEqual((await member(buyer).get()).data(), previous);
    const mail = (await db.collection("hotels/hotel-a/mailQueue").get()).docs.find((snapshot) => snapshot.data().uid === buyer.uid && snapshot.data().actorUid === adminA.uid);
    let sends = 0;
    await processMailQueueHandler({ data: mail, params: { hotelUid: "hotel-a", mailId: mail.id } }, { firestore: db, auth, from: "fixture@example.test", send: async () => { sends++; return { data: { id: "fixture-ack" } }; } });
    assert.equal(sends, 1);
    const invitation = await invite("hotel-a", {}, adminA);
    await remove(adminA, operator);
    const pending = (await db.collection("hotels/hotel-a/mailQueue").get()).docs.find((snapshot) => snapshot.data().uid === invitation.uid);
    await processMailQueueHandler({ data: pending, params: { hotelUid: "hotel-a", mailId: pending.id } }, { firestore: db, auth, from: "fixture@example.test", send: async () => { sends++; return { data: { id: "unexpected" } }; } });
    assert.equal(sends, 1);
    assert.equal((await pending.ref.get()).data().status, "blocked");
  });
  it("rejects disabled current hotel administrators before changing membership data", async () => {
    await auth.updateUser(adminA.uid, { disabled: true });
    await rejected(update(buyer, { hotelAdmin: true }), "permission-denied");
    assert.equal((await member(buyer).get()).data().hotelAdmin, false);
  });
  it("gates imports transactionally by their real destination and leaves no partial business write", async () => {
    const runRef = db.doc(`hotels/hotel-a/importRuns/${next()}`);
    await runRef.set({ state: "processing", owner: "worker" });
    const options = { db, runRef, owner: "worker", chunkIndex: 0, rows: [{ docPath: "hotels/hotel-a/reports/historyforecast/2026/day", payload: { rooms: 1 }, writeMode: "merge", module: "procurement" }],
      mergeDocuments: (existing, incoming) => ({ ...existing, ...incoming }), ancestorPaths: () => [] };
    await rejected(commitImportChunk(options), "permission-denied");
    assert.equal((await db.doc(options.rows[0].docPath).get()).exists, false);
    assert.equal((await runRef.collection("chunks").get()).size, 0);
    await db.doc("hotelSubscriptions/hotel-a").update({ modules: ["procurement", "revenue"] });
    await commitImportChunk(options);
    assert.equal((await db.doc(options.rows[0].docPath).get()).data().rooms, 1);
  });
  it("blocks new external dispatch and scheduled recipients when their module is removed", async () => {
    const approver = await invite("hotel-a", { moduleRoles: { procurement: ["approver"] } });
    await member(approver).update({ permissions: ["orders.approve", "contracts.read"] });
    await db.doc(`hotels/hotel-a/outlets/bar/approvers/${approver.uid}`).set({});
    await db.doc("hotels/hotel-a/orders/order").set({ status: "Created", dispatchRequestId: "dispatch", dispatchStatus: "pending" });
    await db.doc("hotels/hotel-a/dispatches/dispatch").set({ status: "pending", orderId: "order", actorUid: approver.uid, order: { outletId: "bar" } });
    await db.doc("hotelSubscriptions/hotel-a").update({ modules: [] });
    assert.equal(await claimDispatch(db, "hotel-a", "order", "dispatch", auth), null);
    assert.equal((await db.doc("hotels/hotel-a/dispatches/dispatch").get()).data().status, "blocked");
    assert.deepEqual(await resolveAuthorizedRecipients({ db, auth, hotelUid: "hotel-a", recipientUids: [approver.uid], feature: "contracts" }), []);
    await db.doc("hotelSubscriptions/hotel-a").update({ modules: ["contracts"] });
    assert.deepEqual(await resolveAuthorizedRecipients({ db, auth, hotelUid: "hotel-a", recipientUids: [approver.uid], feature: "contracts" }), [approver.token.email]);
  });
  it("blocks hotel team changes while paused, preserves assignments and permits reviewed reactivation", async () => {
    await db.doc("hotelSubscriptions/hotel-a").update({ status: "suspended" });
    const previous = (await member(buyer).get()).data();
    await rejected(update(buyer, { hotelAdmin: true }), "permission-denied");
    await rejected(remove(buyer), "permission-denied");
    await rejected(invite("hotel-a", {}, adminA), "permission-denied");
    assert.deepEqual((await member(buyer).get()).data(), previous);
    await assertFails(setDoc(doc(client(adminA), "hotels/hotel-a/memberAdministration/state"), { revision: 0 }));
    await db.doc("hotelSubscriptions/hotel-a").update({ status: "active" });
    await update(buyer, { moduleRoles: { procurement: ["buyer"] } });
    assert.equal((await member(buyer).get()).data().revision, 2);
  });
  it("migrates only reviewed entitlements/admins with a dry-run, revision lease and idempotent receipt", async () => {
    const subscription = db.doc("hotelSubscriptions/hotel-a");
    await subscription.update({ status: "suspended", revision: 3,
      modules: admin.firestore.FieldValue.delete(), modulePolicyVersion: admin.firestore.FieldValue.delete() });
    const beforeMember = (await member(buyer).get()).data();
    const beforeOtherHotel = (await db.doc("hotelSubscriptions/hotel-b").get()).data();
    const directory = await mkdtemp(join(tmpdir(), "hotel-modules-"));
    const manifest = join(directory, "manifest.json");
    const entry = { hotelUid: "hotel-a", expectedRevision: 3, modules: ["procurement"], seatLimit: null, hotelAdminUids: [buyer.uid] };
    const run = (...extra) => runFile(process.execPath, ["scripts/firebase/module-access-migration.mjs", "--project", projectId,
      "--manifest", manifest, "--operator", "fixture-operator", "--emulator", ...extra], { timeout: 20000 });
    try {
      await writeFile(manifest, JSON.stringify([entry]));
      assert.match((await run()).stdout, /DRY RUN/);
      assert.equal((await subscription.get()).data().modules, undefined);
      assert.deepEqual((await member(buyer).get()).data(), beforeMember);
      assert.match((await run("--apply")).stdout, /hotel-a: applied/);
      const applied = (await subscription.get()).data();
      assert.equal(applied.status, "suspended");
      assert.equal(applied.revision, 4);
      assert.deepEqual(applied.modules, ["procurement"]);
      const appointed = (await member(buyer).get()).data();
      assert.equal(appointed.hotelAdmin, true);
      assert.equal(appointed.revision, beforeMember.revision + 1);
      for (const key of beforeMember.permissions) assert.equal(appointed.permissions.includes(key), true);
      assert.equal((await auth.getUser(buyer.uid)).customClaims?.platformAdmin, undefined);
      assert.deepEqual((await db.doc("hotelSubscriptions/hotel-b").get()).data(), beforeOtherHotel);
      assert.match((await run("--apply")).stdout, /already applied and verified/);
      assert.deepEqual((await member(buyer).get()).data(), appointed);
      await writeFile(manifest, JSON.stringify([{ ...entry, expectedRevision: 2 }]));
      await assert.rejects(run("--apply"), /Subscription revision changed/);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it("rejects an invalid migration manifest before changing any selected hotel", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hotel-module-invalid-"));
    const manifest = join(directory, "manifest.json");
    const before = (await db.doc("hotelSubscriptions/hotel-a").get()).data();
    try {
      await writeFile(manifest, JSON.stringify([
        { hotelUid: "hotel-a", expectedRevision: before.revision, modules: ["procurement", "revenue"], seatLimit: null, hotelAdminUids: [buyer.uid] },
        { hotelUid: "hotel-b", expectedRevision: 1, modules: ["procurement"], seatLimit: null, hotelAdminUids: ["nonexistent-user"] },
      ]));
      await assert.rejects(runFile(process.execPath, ["scripts/firebase/module-access-migration.mjs", "--project", projectId,
        "--manifest", manifest, "--operator", "fixture-operator", "--emulator", "--apply"], { timeout: 20000 }), /Review missing or invalid source records/);
      assert.deepEqual((await db.doc("hotelSubscriptions/hotel-a").get()).data(), before);
      assert.equal((await member(buyer).get()).data().hotelAdmin, false);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
