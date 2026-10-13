const test = require("node:test"), assert = require("node:assert/strict");
const { ImportTestDb } = require("../testSupport/imports");
const { DEFAULT_AI_CONFIGURATION } = require("./supplierAiPolicy");
const { getPlatformSupplierAiImportSettingsHandler: get, savePlatformSupplierAiImportSettingsHandler: save,
  listPlatformSupplierAiUsageHandler: list, usageView } = require("./supplierAiPlatform");
const platform = { uid: "operator", token: { email_verified: true, platformAdmin: true } };
const auth = { getUser: async () => ({ uid: "operator", emailVerified: true, customClaims: { platformAdmin: true } }) };
const request = (data) => ({ auth: platform, data });
const snapshot = (data) => ({ exists: data !== undefined, data: () => data });
const usage = { month: "2026-10", policyVersion: 1, importsStarted: 2, attemptedCalls: 3, succeededCalls: 2,
  unknownCalls: 1, countingCalls: 3, inputTokens: 300, outputTokens: 50, knownCostMicros: 55, reservedCostMicros: 99 };
test("AI configuration is disabled by default and returns no secret values", async () => {
  const result = await get(request(), { firestore: new ImportTestDb(), auth });
  assert.equal(result.configuration.enabled, false); assert.equal(result.configuration.fallbackEnabled, false);
  assert.equal(result.secretVerification, "not_verified"); assert.equal(result.revision, 0); assert.equal(result.configured, false);
  assert.deepEqual(result.capabilities.models, ["gpt-6-luna"]);
});
test("hotel administrators and stale platform claims cannot read or save configuration", async () => {
  const db = new ImportTestDb();
  for (const fn of [get, save, list]) {
    await assert.rejects(fn({ auth: { uid: "hotel", token: { email_verified: true, hotelAdmin: true } } }, { firestore: db, auth }), { code: "permission-denied" });
    await assert.rejects(fn(request(), { firestore: db, auth: { getUser: async () => ({ emailVerified: true, customClaims: {} }) } }), { code: "permission-denied" });
  }
  assert.equal(db.readPaths.length, 0);
});
test("AI settings save, receipt and audit are atomic; lost-response replay is idempotent", async () => {
  const db = new ImportTestDb(), data = { configuration: { ...DEFAULT_AI_CONFIGURATION, enabled: true }, expectedRevision: 0, requestId: "settings-one" };
  db.failAfter = () => { db.failAfter = null; return true; };
  await assert.rejects(save(request(data), { firestore: db, auth }), /after atomic commit/);
  const result = await save(request(data), { firestore: db, auth });
  assert.equal(result.revision, 1); assert.equal(result.replayed, true);
  assert.equal([...db.records.keys()].filter((key) => key.startsWith("platformAudit/")).length, 1);
  await assert.rejects(save(request({ ...data, requestId: "settings-two" }), { firestore: db, auth }), { code: "aborted" });
  await assert.rejects(save(request({ ...data, configuration: { ...data.configuration, enabled: false } }), { firestore: db, auth }), { code: "already-exists" });
});
test("fallback and unsupported models fail before configuration writes", async () => {
  const db = new ImportTestDb();
  for (const change of [{ model: "gpt-6-sol" }, { fallbackEnabled: true, fallbackModel: "gpt-6-sol" }, { maxCostPerImportUsd: 1 }]) {
    await assert.rejects(save(request({ configuration: { ...DEFAULT_AI_CONFIGURATION, ...change }, expectedRevision: 0, requestId: "bad" }), { firestore: db, auth }), { code: "failed-precondition" });
  }
  assert.equal(db.records.size, 0);
});
test("authority revoked during settings I/O prevents writes and disclosures", async () => {
  let reads = 0; const revoked = { getUser: async () => ({ emailVerified: true, customClaims: { platformAdmin: ++reads === 1 } }) };
  const db = new ImportTestDb();
  await assert.rejects(get(request(), { firestore: db, auth: revoked }), { code: "permission-denied" });
  reads = 0;
  await assert.rejects(save(request({ configuration: DEFAULT_AI_CONFIGURATION, expectedRevision: 0, requestId: "revoked" }), { firestore: db, auth: revoked }), { code: "permission-denied" });
  assert.equal(db.records.size, 0);
});
test("usage shows known spend and unresolved reservations without claiming zero total", () => {
  const value = usageView(snapshot(usage), "2026-10");
  assert.equal(value.actualCostUsd, null); assert.equal(value.knownCostUsd, 0.000055); assert.equal(value.reservedCostUsd, 0.000099);
  assert.equal(usageView(snapshot({ ...usage, unknownCalls: 0 }), "2026-10").actualCostUsd, null);
  assert.equal(usageView(snapshot({ ...usage, unknownCalls: 0, reservedCostMicros: 0 }), "2026-10").actualCostUsd, 0.000055);
  assert.equal(usageView(snapshot(), "2026-10").state, "none");
  for (const corrupted of [{ ...usage, knownCostMicros: undefined }, { ...usage, importsStarted: -1 }, { ...usage, month: "2026-09" }, { ...usage, importsCommitted: "1" }]) assert.equal(usageView(snapshot(corrupted), "2026-10").state, "unavailable");
});
test("hotel usage pages are bounded and exclude private source/job payloads", async () => {
  const reads = []; let limit, cursor;
  const hotels = Array.from({ length: 26 }, (_, i) => ({ id: `h${i}`, data: () => ({ name: `Hotel ${i}`, secret: "private" }) }));
  const query = { orderBy() { return this; }, startAfter(id) { cursor = id; return this; }, limit(n) { limit = n; return this; }, async get() { return { docs: hotels }; } };
  const db = { collection(path) { assert.equal(path, "hotels"); return query; }, doc(path) { return { path }; }, async getAll(...refs) { reads.push(...refs.map((ref) => ref.path)); return refs.map(() => snapshot(usage)); } };
  const result = await list(request({ month: "2026-10", cursor: "previous" }), { firestore: db, auth });
  assert.equal(limit, 26); assert.equal(cursor, "previous"); assert.equal(result.hotels.length, 25); assert.equal(result.nextCursor, "h24");
  assert.equal(reads.length, 25); assert.ok(reads.every((path) => path.endsWith("/aiUsageMonths/2026-10")));
  assert.equal(JSON.stringify(result).includes("private"), false);
  await assert.rejects(list(request({ month: "2026-13" }), { firestore: db, auth }), { code: "invalid-argument" });
});
