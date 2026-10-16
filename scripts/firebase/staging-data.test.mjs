import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, stat, chmod, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { parseArguments, privateCredentials, stagingCredentialsFingerprint, assertStagingTarget, assertFixtureScope, seedStagingData, resetStagingData, setSubscriptionScenario, withStagingDataOperation } from "./staging-data.mjs";
import { STAGING_PROJECT, EMULATOR_PROJECT, buildStagingData, fixtureUsers, HOTEL_IDS, ownsFixture } from "./staging-data-fixtures.mjs";

const remote = ["seed", "--project", STAGING_PROJECT];
test("the staging CLI rejects production, arbitrary targets, ambient conflicts and mixed emulator routing before credentials", () => {
  for (const project of ["hotel-toolkit", "test-breakfast", "staging-copy", ""]) assert.throws(() => parseArguments(["seed", "--project", project], {}));
  assert.equal(parseArguments(remote, {}).apply, false);
  assert.throws(() => parseArguments([...remote, "--apply"], {}), /confirm/);
  assert.throws(() => parseArguments([...remote, "--apply", "--confirm-project", STAGING_PROJECT], {}), /credentials-file/);
  for (const env of [{ GCLOUD_PROJECT: "hotel-toolkit" }, { FIREBASE_CONFIG: '{"projectId":"hotel-toolkit"}' }, { FIRESTORE_EMULATOR_HOST: "localhost:8080" }]) assert.throws(() => parseArguments(remote, env));
  assert.throws(() => parseArguments([...remote, "--project", STAGING_PROJECT], {}), /Duplicate/);
  assert.throws(() => parseArguments([...remote, "--business-date", "2026-02-30"], {}), /valid/);
  const emulator = ["seed", "--project", EMULATOR_PROJECT, "--emulator"];
  assert.throws(() => parseArguments(emulator, {}), /loopback/);
  assert.throws(() => parseArguments(emulator, { FIRESTORE_EMULATOR_HOST: "cloud.example:8080", FIREBASE_AUTH_EMULATOR_HOST: "localhost:9099" }), /loopback/);
  assert.equal(parseArguments(emulator, { FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080", FIREBASE_AUTH_EMULATOR_HOST: "localhost:9099" }).emulator, true);
  assert.throws(() => parseArguments(["scenario", "--project", STAGING_PROJECT, "--subscription", "canceled"], {}));
});

test("imported mutation helpers reject production and mismatched SDK projects before any read or write", async () => {
  const production = { projectId: "hotel-toolkit" };
  await assert.rejects(seedStagingData({ db: production }), /exact staging/);
  await assert.rejects(resetStagingData({ db: production }), /exact staging/);
  await assert.rejects(setSubscriptionScenario({ db: production, subscription: "active" }), /exact staging/);
  await assert.rejects(withStagingDataOperation(production, "reset", async () => {}), /exact staging/);
  assert.throws(() => assertStagingTarget({ projectId: STAGING_PROJECT }, { app: { options: { projectId: "hotel-toolkit" } } }, {}), /same explicit/);
  assert.throws(() => assertStagingTarget({ projectId: EMULATOR_PROJECT }, undefined, {}), /loopback/);
  assert.throws(() => assertStagingTarget({ projectId: STAGING_PROJECT }, undefined, { FIREBASE_AUTH_EMULATOR_HOST: "localhost:9099" }), /mixed/);
  assert.equal(assertStagingTarget({ projectId: "demo-hotel-suite-a00" }, undefined, { FIRESTORE_EMULATOR_HOST: "localhost:8080", FIREBASE_AUTH_EMULATOR_HOST: "localhost:9099", GCLOUD_PROJECT: "demo-hotel-suite-a00" }), "demo-hotel-suite-a00");
});

test("test passwords are generated once in a private file and unsafe reuse/symlinks are rejected", async () => {
  const directory = await mkdtemp(join(tmpdir(), "staging-seed-test-")), path = join(directory, "credentials.json");
  try {
    const first = await privateCredentials(path, STAGING_PROJECT), second = await privateCredentials(path, STAGING_PROJECT);
    assert.deepEqual(first, second); assert.equal((await stat(path)).mode & 0o777, 0o600);
    const fingerprint = stagingCredentialsFingerprint(first);
    assert.match(fingerprint, /^[a-f0-9]{64}$/);
    assert.equal(stagingCredentialsFingerprint({ ...second, users: [...second.users].reverse() }), fingerprint);
    assert.notEqual(stagingCredentialsFingerprint({ ...first, users: first.users.map((user, index) => index ? user : { ...user, password: `${user.password}-different` }) }), fingerprint);
    assert.throws(() => stagingCredentialsFingerprint({ users: [...first.users.slice(1), first.users[1]] }), /invalid staging identity/);
    assert.equal(new Set(first.users.map((user) => user.password)).size, fixtureUsers().length);
    assert(first.users.every((user) => user.password.length >= 32 && user.email.endsWith("@example.invalid")));
    await assert.rejects(privateCredentials(path, EMULATOR_PROJECT), /does not match/);
    const link = join(directory, "link.json"); await symlink(path, link); await assert.rejects(privateCredentials(link, STAGING_PROJECT), /regular private/);
    await chmod(path, 0o644); await assert.rejects(privateCredentials(path, STAGING_PROJECT), /private/);
    assert.equal(JSON.parse(await readFile(path, "utf8")).users.length, 10);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("fictional fixtures use real model validators, isolated tenant references and balanced immutable request evidence", () => {
  process.env.FIREBASE_CONFIG = JSON.stringify({ projectId: EMULATOR_PROJECT });
  const fixture = buildStagingData({ businessDate: "2026-10-16" }), require = createRequire(import.meta.url);
  const { purchaseRequestInternals } = require("../../functions/src/purchaseRequests");
  const { permissionAllows } = require("../../functions/src/authorization");
  const docs = new Map(fixture.docs.map((item) => [item.path, item.data]));
  assert.equal(docs.size, fixture.docs.length); assert(fixture.docs.length < 490);
  assertFixtureScope(fixture);
  assert.throws(() => assertFixtureScope({ ...fixture, docs: [...fixture.docs, { path: "hotels/unrelated/catalogproducts/injected", data: fixture.docs[0].data }] }), /out-of-scope/);
  assert.throws(() => assertFixtureScope({ ...fixture, users: fixture.users.map((user, index) => index ? user : { ...user, email: "someone@customer.example" }) }), /unexpected Auth/);
  assert.equal(docs.has("platformConfiguration/saasProcurement"), false, "seeding cannot enable the runtime release gate");
  assert.equal(docs.has("_staging/release"), false);
  for (const { path, data } of fixture.docs) {
    assert(ownsFixture(data), path);
    if (path.startsWith("hotels/")) assert(HOTEL_IDS.includes(path.split("/")[1]));
    assert.equal(JSON.stringify(data).includes("test-hotel-2"), false, path);
    assert(!/mailQueue|supplierSecrets|dispatches/.test(path), path);
  }
  for (const hotelUid of HOTEL_IDS) {
    const settings = docs.get(`hotels/${hotelUid}/settings/purchaseRequests`);
    purchaseRequestInternals.storedSettings({ exists: true, data: () => settings });
    let reserved = 0;
    for (const status of ["draft", "pending"]) {
      const id = `staging-request-${status}`, data = docs.get(`hotels/${hotelUid}/purchaseRequests/${id}`);
      const value = purchaseRequestInternals.storedRequest({ exists: true, id, data: () => data }, hotelUid);
      assert.equal(value.totalMinor, 15000); reserved += value.reservation.amountMinor;
      const history = docs.get(`hotels/${hotelUid}/purchaseRequests/${id}/history/000001`);
      assert.equal(history.snapshotFingerprint, data.snapshotFingerprint);
      assert.equal(purchaseRequestInternals.canonicalDigest(history.snapshot), data.snapshotFingerprint);
    }
    assert.equal(docs.get(`hotels/${hotelUid}/purchaseBudgets/2026-10__maintenance`).pendingMinor, reserved);
    assert.equal(docs.get(`hotels/${hotelUid}/members/${hotelUid}-revoked`), undefined);
    const counter = docs.get(`hotels/${hotelUid}/members/${hotelUid}-counter`);
    assert.equal(permissionAllows(counter.permissions, "stockcounts", "update"), true);
    assert.equal(permissionAllows(counter.permissions, "orders", "approve"), false);
    assert.equal(permissionAllows(counter.permissions, "purchaserequests", "approve"), false);
  }
});
