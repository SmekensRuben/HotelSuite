import assert from "node:assert/strict";
import test from "node:test";
import { applyMigration, buildMigrationDocuments, inspectMigration, parseArguments } from "./migrate-domain-settings.mjs";

const hotelUid = "hotel-one", projectId = "demo-hotel-suite";
const base = `hotels/${hotelUid}/settings`;
class Timestamp {
  constructor(value) { this.value = value; }
  toMillis() { return this.value; }
  toJSON() { return { seconds: Math.floor(this.value / 1000), nanoseconds: (this.value % 1000) * 1000000 }; }
}
function fakeDatabase(seed = {}) {
  let clock = 1;
  const rows = new Map(Object.entries(seed).map(([path, data]) => [path, { data, version: new Timestamp(clock++) }]));
  const snapshot = (ref) => {
    const row = rows.get(ref.path);
    return { exists: Boolean(row), ref, updateTime: row?.version, data: () => row?.data };
  };
  const db = { rows, transactions: [], beforeTransaction: null,
    doc: (path) => ({ path }),
    getAll: async (...refs) => refs.map(snapshot),
    runTransaction: async (callback) => {
      if (db.beforeTransaction) await db.beforeTransaction();
      const writes = [];
      await callback({ getAll: async (...refs) => refs.map(snapshot),
        create: (ref, data) => { assert.equal(rows.has(ref.path), false); writes.push({ ref, data }); },
        set: (ref, data) => writes.push({ ref, data }) });
      db.transactions.push(writes);
      for (const { ref, data } of writes) rows.set(ref.path, { data, version: new Timestamp(clock++) });
    },
    mutate: (path, data) => rows.set(path, { data, version: new Timestamp(clock++) }),
  };
  return db;
}
function database(legacy = {}, upsells) {
  return fakeDatabase({ [`hotels/${hotelUid}`]: { name: "Hotel" }, [`${base}/${hotelUid}`]: legacy,
    ...(upsells === undefined ? {} : { [`${base}/upsells`]: upsells }) });
}
const serverTimestamp = () => new Timestamp(1234);

test("dry-run planning splits only approved fields and preserves unknown source data", async () => {
  const legacy = { hotelName: "Hotel", language: "English", currency: "eur", hotelRooms: 150, posProvider: "lightspeed", orderMode: "ingredient", lightspeedShiftRolloverHour: 4,
    catalogCategories: { "food.category": { name: "Food" } }, catalogSubcategories: { fresh: { name: "Fresh", categoryId: "food.category" } },
    contractCategories: { service: { name: "Service" } }, contractSubcategories: { cleaning: { name: "Cleaning", categoryId: "service" } },
    operaUserMappings: { "front.desk": "Desk employee" }, unknownLegacySecret: { opaque: true } };
  const db = database(legacy);
  const inspection = await inspectMigration(db, { projectId, hotelUid });
  assert.equal(db.transactions.length, 0);
  assert.deepEqual(inspection.preservedLegacyFields, ["unknownLegacySecret"]);
  assert.deepEqual(inspection.normalizedFields, ["language", "currency"]);
  assert.deepEqual(inspection.operations.find((entry) => entry.kind === "property").data, { hotelRooms: 150 });
  assert.deepEqual(inspection.operations.find((entry) => entry.kind === "bootstrap").data,
    { hotelName: "Hotel", language: "en", currency: "EUR", posProvider: "lightspeed", orderMode: "ingredient", lightspeedShiftRolloverHour: 4 });
  assert.equal(inspection.operations.find((entry) => entry.kind === "opera").path, `${base}/opera/userMappings/front.desk`);
  assert.deepEqual(db.rows.get(`${base}/${hotelUid}`).data, legacy);
});

test("existing configuration conflicts stop the entire plan before writes", async () => {
  const db = database({ hotelName: "Legacy", catalogCategories: { category: { name: "Legacy" } } });
  db.mutate(`${base}/catalog/categories/category`, { name: "Changed" });
  await assert.rejects(inspectMigration(db, { projectId, hotelUid }), /Destination conflict/);
  assert.equal(db.transactions.length, 0);
  assert.equal(db.rows.has(`${base}/bootstrap`), false);
});

test("apply needs the reviewed fingerprint and an unchanged legacy source", async () => {
  const db = database({ hotelName: "Hotel" });
  const inspection = await inspectMigration(db, { projectId, hotelUid });
  await assert.rejects(applyMigration(db, inspection, { expectedPlan: "wrong", serverTimestamp }), /fingerprint differs/);
  db.beforeTransaction = () => db.mutate(`${base}/${hotelUid}`, { hotelName: "Changed" });
  await assert.rejects(applyMigration(db, inspection, { expectedPlan: inspection.planId, serverTimestamp }), /source changed/);
  assert.equal(db.transactions.length, 0);
  assert.equal(db.rows.has(`${base}/bootstrap`), false);
});

test("concurrent destination creation is never overwritten", async () => {
  const db = database({ hotelName: "Hotel" });
  const inspection = await inspectMigration(db, { projectId, hotelUid });
  db.beforeTransaction = () => db.mutate(`${base}/bootstrap`, { hotelName: "Other" });
  await assert.rejects(applyMigration(db, inspection, { expectedPlan: inspection.planId, serverTimestamp }), /Destination changed/);
  assert.equal(db.transactions.length, 0);
  assert.deepEqual(db.rows.get(`${base}/bootstrap`).data, { hotelName: "Other" });
});

test("apply is idempotent, retains source roots and keeps unrelated approved destination fields", async () => {
  const legacy = { hotelName: "Hotel", hotelRooms: 30 };
  const upsells = { dailyExpectedOccupancy: { "2026-10-10": 20 }, revenueTargetRules: [{ id: "autumn", startDate: "2026-10-01", endDate: "2026-10-31", minimumTargetRevenuePerOccupiedRoom: 1, reachTargetRevenuePerOccupiedRoom: 2, stretchTargetRevenuePerOccupiedRoom: 3 }], historicalField: true };
  const db = database(legacy, upsells);
  db.mutate(`${base}/bootstrap`, { language: "nl", updatedAt: new Timestamp(500) });
  db.mutate(`${base}/propertySettings`, { updatedAt: new Timestamp(500) });
  db.mutate(`${base}/catalog/categories/unrelated`, { name: "Already configured" });
  const inspection = await inspectMigration(db, { projectId, hotelUid });
  const result = await applyMigration(db, inspection, { expectedPlan: inspection.planId, serverTimestamp });
  assert.equal(result.written, 4);
  assert.deepEqual(db.rows.get(`${base}/bootstrap`).data, { language: "nl", updatedAt: new Timestamp(500), hotelName: "Hotel" });
  assert.deepEqual(db.rows.get(`${base}/${hotelUid}`).data, legacy);
  assert.deepEqual(db.rows.get(`${base}/upsells`).data, upsells);
  assert.deepEqual(db.rows.get(`${base}/catalog/categories/unrelated`).data, { name: "Already configured" });
  assert.deepEqual(db.rows.get(`${base}/upsells/occupancy/2026-10-10`).data,
    { date: "2026-10-10", expectedOccupancy: 20, updatedAt: new Timestamp(1234) });
  const second = await inspectMigration(db, { projectId, hotelUid });
  assert.ok(second.operations.every((entry) => entry.action === "keep"));
  const repeated = await applyMigration(db, second, { expectedPlan: second.planId, serverTimestamp });
  assert.equal(repeated.written, 0);
  assert.equal(db.transactions.length, 1);
});

test("legacy dailyRevenueTargets uses deterministic dates, IDs and absent-value defaults", () => {
  const built = buildMigrationDocuments(hotelUid, {}, { dailyRevenueTargets: { "2026-10-10": { expectedOccupancy: 15, minimumRevenuePerOccupiedRoom: 1, reachRevenuePerOccupiedRoom: 2 } } });
  assert.deepEqual(built.documents.find((entry) => entry.kind === "occupancy").data, { date: "2026-10-10", expectedOccupancy: 15 });
  assert.deepEqual(built.documents.find((entry) => entry.kind === "revenue").data,
    { id: "2026-10-10-2026-10-10-0", startDate: "2026-10-10", endDate: "2026-10-10", minimumTargetRevenuePerOccupiedRoom: 1, reachTargetRevenuePerOccupiedRoom: 2, stretchTargetRevenuePerOccupiedRoom: 0 });
});

test("malformed migrated shapes and dangling references require review instead of coercion", () => {
  for (const legacy of [
    { hotelRooms: "30" }, { language: "unrecognized" }, { lightspeedShiftRolloverHour: 24 },
    { catalogCategories: [] }, { catalogCategories: { category: { name: "Food", hidden: true } } },
    { catalogSubcategories: { subcategory: { name: "Fresh", categoryId: "missing" } } },
    { operaUserMappings: { ["x".repeat(129)]: "Employee" } }, { operaUserMappings: { "OP/1": "Employee" } },
  ]) assert.throws(() => buildMigrationDocuments(hotelUid, legacy));
  for (const upsells of [
    { dailyExpectedOccupancy: { "2026-02-30": 1 } }, { dailyExpectedOccupancy: { "2026-10-10": "20" } },
    { revenueTargetRules: [{ startDate: "2026-10-11", endDate: "2026-10-10" }] },
    { revenueTargetRules: [{ id: "duplicate", startDate: "2026-10-10", endDate: "2026-10-10" }, { id: "duplicate", startDate: "2026-10-11", endDate: "2026-10-11" }] },
  ]) assert.throws(() => buildMigrationDocuments(hotelUid, {}, upsells));
  assert.throws(() => buildMigrationDocuments("bootstrap", { hotelName: "Hotel" }), /reserved/);
});

test("large reviewed copies use bounded transactions and remain restartable", async () => {
  const occupancy = {};
  for (let index = 0; index < 801; index++) occupancy[new Date(Date.UTC(2026, 0, 1 + index)).toISOString().slice(0, 10)] = index;
  const db = database({}, { dailyExpectedOccupancy: occupancy });
  const inspection = await inspectMigration(db, { projectId, hotelUid });
  const result = await applyMigration(db, inspection, { expectedPlan: inspection.planId, serverTimestamp });
  assert.deepEqual(db.transactions.map((writes) => writes.length), [400, 400, 1]);
  assert.equal(result.written, 801);
  const verified = await inspectMigration(db, { projectId, hotelUid });
  assert.ok(verified.operations.every((entry) => entry.action === "keep"));
});

test("a later-chunk interruption retains prior copies and a fresh review resumes safely", async () => {
  const occupancy = {};
  for (let index = 0; index < 401; index++) occupancy[new Date(Date.UTC(2026, 0, 1 + index)).toISOString().slice(0, 10)] = index;
  const db = database({}, { dailyExpectedOccupancy: occupancy });
  const inspection = await inspectMigration(db, { projectId, hotelUid });
  let attempts = 0;
  db.beforeTransaction = () => {
    if (++attempts === 2) db.mutate(`${base}/upsells`, { dailyExpectedOccupancy: occupancy, unrelatedOperatorNote: "reviewed" });
  };
  await assert.rejects(applyMigration(db, inspection, { expectedPlan: inspection.planId, serverTimestamp }), /source changed/);
  assert.deepEqual(db.transactions.map((writes) => writes.length), [400]);
  db.beforeTransaction = null;
  const fresh = await inspectMigration(db, { projectId, hotelUid });
  assert.notEqual(fresh.planId, inspection.planId);
  assert.equal(fresh.operations.filter((entry) => entry.action === "keep").length, 400);
  const result = await applyMigration(db, fresh, { expectedPlan: fresh.planId, serverTimestamp });
  assert.equal(result.written, 1);
  assert.equal(db.rows.get(`${base}/upsells`).data.unrelatedOperatorNote, "reviewed");
});

test("CLI requires explicit targets, rejects duplicate flags, and defaults to dry run", () => {
  assert.deepEqual(parseArguments(["--project", projectId, "--hotel", hotelUid]), { projectId, hotelUid });
  assert.throws(() => parseArguments(["--hotel", hotelUid]), /--project/);
  assert.throws(() => parseArguments(["--project", projectId, "--hotel", hotelUid, "--apply"]), /expected-plan/);
  assert.throws(() => parseArguments(["--project", projectId, "--hotel", hotelUid, "--hotel", "other"]), /duplicate/);
  assert.throws(() => parseArguments(["--project", projectId, "--hotel", "hotel/other"]), /document ID/);
});
