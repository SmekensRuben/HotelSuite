import assert from "node:assert/strict";
import test from "node:test";
import {
  STAGING_PROJECT, STAGING_BUCKET, RULES_PROPAGATION_MS, requireStagingTarget, parseStagingActivationArgs,
  requireReleaseEvidence, requireRulesPropagation, verifyStagingRules, verifyStagingIndexes, inspectStagingAccess, changeStagingActivation,
} from "./staging-activation.mjs";

const SHA = "a".repeat(40), OTHER_SHA = "b".repeat(40), NUMBER = "123456789012";
const RULESETS = ["projects/hotel-toolkit-staging/rulesets/firestore", "projects/hotel-toolkit-staging/rulesets/storage"];
const EVIDENCE = { projectId: STAGING_PROJECT, sha: SHA, backendSha: SHA, frontendSha: SHA,
  functionsVerified: true, appHostingVerified: true, frontendMarkerVerified: true };
const stamp = millis => ({ toMillis: () => millis });
const validTarget = { projectId: STAGING_PROJECT, projectNumber: NUMBER, expectedProjectNumber: NUMBER, sha: SHA, env: {} };

function database(records = {}) {
  const state = new Map(Object.entries(records)), writes = [];
  let id = 0;
  const snapshot = path => ({ id: path.split("/").at(-1), exists: state.has(path), data: () => state.get(path) });
  const db = {
    state, writes, projectId: STAGING_PROJECT,
    doc: path => ({ path, get: async () => snapshot(path) }),
    collection: path => ({ doc: () => db.doc(`${path}/audit-${++id}`), limit: count => ({ get: async () => {
      const docs = [...state.keys()].filter(key => key.startsWith(`${path}/`) && key.split("/").length === path.split("/").length + 1).slice(0, count).map(snapshot);
      return { docs, size: docs.length };
    } }) }),
    runTransaction: async callback => {
      const pending = [];
      const result = await callback({ getAll: async (...refs) => refs.map(ref => snapshot(ref.path)),
        set: (ref, data, options) => pending.push({ path: ref.path, data, merge: options?.merge }),
        create: (ref, data) => { assert.equal(state.has(ref.path), false); pending.push({ path: ref.path, data }); },
      });
      pending.forEach(write => { state.set(write.path, write.merge ? { ...state.get(write.path), ...write.data } : write.data); writes.push(write); });
      return result;
    },
  };
  return db;
}

const paused = (patch = {}) => ({
  "_staging/release": { state: "deploying", sha: SHA },
  "platformConfiguration/saasProcurement": { enabled: false, releaseSha: SHA, rulesReleaseSha: SHA, publishedRulesets: RULESETS, rulesPublishedAt: stamp(0) },
  "platformConfiguration/privateWorkflows": { enabled: false, releaseSha: SHA }, ...patch,
});
const options = (db, patch = {}) => ({ db, phase: "ready", sha: SHA, apply: true, operator: "operator@example.invalid",
  fieldValue: { serverTimestamp: () => stamp(RULES_PROPAGATION_MS) }, rulesVersion: "saas-platform-v6", rulesets: RULESETS,
  evidence: EVIDENCE, now: () => RULES_PROPAGATION_MS, ...patch });

test("project identity rejects production, aliases, mismatched numbers, emulator hosts and ambiguous ambient targets", () => {
  requireStagingTarget(validTarget);
  for (const patch of [{ projectId: "hotel-toolkit" }, { projectId: "staging" }, { projectNumber: "999999999999" },
    { expectedProjectNumber: "358734544002", projectNumber: "358734544002" }, { expectedProjectNumber: "" }, { sha: "main" },
    { env: { FIRESTORE_EMULATOR_HOST: "localhost:8080" } }, { env: { GOOGLE_CLOUD_PROJECT: "hotel-toolkit" } }]) {
    assert.throws(() => requireStagingTarget({ ...validTarget, ...patch }));
  }
});

test("CLI is read-only by default and requires exact project, phase, SHA and ready evidence", () => {
  const args = ["--project", STAGING_PROJECT, "--sha", SHA, "--phase", "deploying"];
  assert.equal(parseStagingActivationArgs(args).apply, false);
  assert.equal(parseStagingActivationArgs([...args, "--apply"]).apply, true);
  for (const input of [args.slice(2), [...args, "--project", STAGING_PROJECT], [...args, "--force"],
    ["--project", STAGING_PROJECT, "--sha", SHA, "--phase", "preflight", "--apply"],
    ["--project", STAGING_PROJECT, "--sha", SHA, "--phase", "ready"]]) assert.throws(() => parseStagingActivationArgs(input));
});

test("activation requires independently observed frontend and backend SHAs and all release checks", () => {
  requireReleaseEvidence(EVIDENCE, SHA);
  for (const patch of [{ projectId: "hotel-toolkit" }, { sha: OTHER_SHA }, { backendSha: OTHER_SHA }, { frontendSha: OTHER_SHA },
    { functionsVerified: false }, { appHostingVerified: false }, { frontendMarkerVerified: false }]) {
    assert.throws(() => requireReleaseEvidence({ ...EVIDENCE, ...patch }, SHA));
  }
});

test("Rules verification reads only the staging bucket and rejects unreviewed published bytes", async () => {
  let bucket;
  const rules = { getFirestoreRuleset: async () => ({ name: RULESETS[0], source: [{ content: "firestore" }] }),
    getStorageRuleset: async value => { bucket = value; return { name: RULESETS[1], source: [{ content: "storage" }] }; } };
  assert.deepEqual(await verifyStagingRules(rules, ["firestore", "storage"]), RULESETS);
  assert.equal(bucket, STAGING_BUCKET);
  await assert.rejects(verifyStagingRules(rules, ["unreviewed", "storage"]), /differ/);
});

test("every manifest index must be READY in the staging project; implicit name fields are accepted", async () => {
  const expected = { collectionGroup: "inventoryMovements", queryScope: "COLLECTION", fields: [{ fieldPath: "locationId", order: "ASCENDING" }, { fieldPath: "sequence", order: "ASCENDING" }] };
  const manifest = { indexes: [expected], fieldOverrides: [] };
  const index = { ...expected, fields: [...expected.fields, { fieldPath: "__name__", order: "ASCENDING" }], state: "READY",
    name: `projects/${STAGING_PROJECT}/databases/(default)/collectionGroups/inventoryMovements/indexes/one` };
  assert.equal(await verifyStagingIndexes(async path => { assert.ok(path.startsWith(`projects/${STAGING_PROJECT}/`)); return { indexes: [index] }; }, manifest), 1);
  for (const patch of [{ state: "CREATING" }, { name: index.name.replace(STAGING_PROJECT, "hotel-toolkit") },
    { fields: [...expected.fields, { fieldPath: "__name__", order: "DESCENDING" }] },
    { fields: [{ fieldPath: "hotelUid", order: "ASCENDING" }] }]) {
    await assert.rejects(verifyStagingIndexes(async () => ({ indexes: [{ ...index, ...patch }] }), manifest), /missing or not READY/);
  }
  await assert.rejects(verifyStagingIndexes(async () => ({ indexes: [], nextPageToken: "repeat" }), manifest), /bounds/);
});

test("Rules propagation gate is tied to selected SHA, current release IDs and server timestamp", () => {
  const procurement = paused()["platformConfiguration/saasProcurement"];
  requireRulesPropagation(procurement, SHA, RULESETS, RULES_PROPAGATION_MS);
  assert.throws(() => requireRulesPropagation(procurement, SHA, RULESETS, RULES_PROPAGATION_MS - 1), { code: "STAGING_RULES_PROPAGATING" });
  for (const patch of [{ rulesReleaseSha: OTHER_SHA }, { publishedRulesets: ["other", "other"] }, { rulesPublishedAt: null }]) {
    assert.throws(() => requireRulesPropagation({ ...procurement, ...patch }, SHA, RULESETS, RULES_PROPAGATION_MS));
  }
});

test("deploying atomically pauses all gates, clears previous verification and preserves subscription data", async () => {
  const db = database({ "hotelSubscriptions/hotel-a": { status: "suspended" },
    "platformConfiguration/saasProcurement": { enabled: true, rulesReleaseSha: SHA, rulesPublishedAt: stamp(0), publishedRulesets: RULESETS } });
  await changeStagingActivation(options(db, { phase: "deploying" }));
  assert.equal(db.state.get("_staging/release").state, "deploying");
  assert.equal(db.state.get("_staging/release").backendSha, null);
  assert.equal(JSON.stringify(db.state.get("_staging/release")).includes("operator@example.invalid"), false);
  assert.ok(Object.keys(db.state.get("_staging/release")).every(key => ["state", "sha", "backendSha", "frontendSha", "projectId", "startedAt", "readyAt"].includes(key)));
  for (const name of ["saasProcurement", "privateWorkflows"]) {
    assert.equal(db.state.get(`platformConfiguration/${name}`).enabled, false);
    assert.equal(db.state.get(`platformConfiguration/${name}`).releaseSha, SHA);
  }
  assert.equal(db.state.get("platformConfiguration/saasProcurement").rulesPublishedAt, null);
  assert.deepEqual(db.state.get("hotelSubscriptions/hotel-a"), { status: "suspended" });
  assert.equal(db.writes.filter(write => write.path.startsWith("stagingReleaseAudit/")).length, 1);
});

test("release mutation and data seed/reset leases cannot overlap", async () => {
  for (const phase of ["deploying", "rules", "ready"]) {
    const db = database(paused({ "_staging/dataOperation": { status: "running", token: "seed-token" } }));
    await assert.rejects(changeStagingActivation(options(db, { phase })), /seed\/reset/);
    assert.equal(db.writes.length, 0);
  }
});

test("an imported activation cannot write through an accidentally selected production client", async () => {
  const db = database(paused());
  db.projectId = "hotel-toolkit";
  await assert.rejects(changeStagingActivation(options(db, { phase: "deploying" })), /client must target/);
  assert.equal(db.writes.length, 0);
});

test("ready atomically publishes matching UI and backend gates only after the current pause and verification", async () => {
  const db = database(paused());
  await changeStagingActivation(options(db));
  assert.equal(db.state.get("_staging/release").state, "ready");
  assert.equal(db.state.get("_staging/release").backendSha, SHA);
  assert.equal(db.state.get("_staging/release").frontendSha, SHA);
  assert.equal(JSON.stringify(db.state.get("_staging/release")).includes("operator@example.invalid"), false);
  assert.ok(Object.keys(db.state.get("_staging/release")).every(key => ["state", "sha", "backendSha", "frontendSha", "projectId", "startedAt", "readyAt"].includes(key)));
  assert.equal(db.state.get("platformConfiguration/saasProcurement").enabled, true);
  assert.equal(db.state.get("platformConfiguration/privateWorkflows").enabled, true);
  for (const patch of [{ "_staging/release": { state: "deploying", sha: OTHER_SHA } },
    { "platformConfiguration/privateWorkflows": { enabled: true, releaseSha: SHA } },
    { "platformConfiguration/saasProcurement": { ...paused()["platformConfiguration/saasProcurement"], rulesPublishedAt: stamp(1) } }]) {
    const invalid = database(paused(patch));
    await assert.rejects(changeStagingActivation(options(invalid)));
    assert.equal(invalid.writes.length, 0);
  }
});

test("all phases remain mutation-free without --apply", async () => {
  for (const phase of ["deploying", "rules", "ready"]) {
    const db = database(paused());
    assert.equal((await changeStagingActivation(options(db, { phase, apply: false }))).applied, false);
    assert.equal(db.writes.length, 0);
  }
});

test("access preflight validates explicit entitlements and canonical membership without reactivating hotels", async () => {
  const records = { "hotels/hotel-a": {}, "users/user-a": { hotelUid: ["hotel-a"] },
    "hotels/hotel-a/members/user-a": { permissions: ["orders.read"] },
    "hotelSubscriptions/hotel-a": { status: "suspended", modules: ["procurement"], modulePolicyVersion: 1, billingMode: "manual", validUntil: null, seatLimit: 10 } };
  const auth = { getUser: async () => ({ disabled: false }) };
  const catalog = { permissions: { orders: ["read"] }, modules: { policyVersion: 1, modules: { procurement: {} } } };
  const db = database(records);
  assert.deepEqual(await inspectStagingAccess(db, auth, catalog), { hotels: 1, profiles: 1, memberships: 1 });
  assert.equal(db.writes.length, 0);
  for (const patch of [{ "hotelSubscriptions/hotel-a": { ...records["hotelSubscriptions/hotel-a"], modules: ["unknown"] } },
    { "users/user-a": { hotelUid: [] } }, { "hotels/hotel-a/members/user-a": { permissions: ["Orders.Read"] } },
    { "hotels/hotel-a/suppliers/one": { password: "secret-never-printed" } }, { "hotels/hotel-a/orders/one": { dispatchStatus: "pending" } }]) {
    await assert.rejects(inspectStagingAccess(database({ ...records, ...patch }), auth, catalog), error => /preflight failed/.test(error.message) && !error.message.includes("secret-never-printed"));
  }
});
