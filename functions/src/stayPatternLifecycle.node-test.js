const test = require("node:test");
const assert = require("node:assert/strict");
const { rebuildStayPatternModel, PUBLICATION_VERSION, buildYear } = require("./stayPatternModel");

const modelPath = "hotels/hotel-a/reports/stayPatternModel";

function fixture(failure = null) {
  const oldYear = { year: 2025, status: "VALID", buildRunId: "old-build", marker: "frozen annual evidence" };
  const documents = new Map([[modelPath, { status: "VALID", sourceRevision: 0, publishedSourceRevision: 0, buildRunId: "old-build", latestCompletedBuildRunId: "old-build", publishedYearBuildRunIds: { 2025: "old-build" } }], [`${modelPath}/years/2025`, oldYear], ["hotels/hotel-a/reports/historyquotes/consideredDates/2025-03-03", { individualRooms: 2, groupRooms: 1 }]]);
  for (const [id, rateCode, numberOfRooms] of [["t", "12ABC", 2], ["g", "GRP", 1]]) documents.set(`hotels/hotel-a/reports/staydatepattern/2025-03-03/${id}`, { arrivalDate: "2025-03-03", departureDate: "2025-03-04", nights: 1, numberOfRooms, rateCode, reservationStatus: "CHECKED OUT" });
  let usedFailure = false;
  const throwOnce = (point) => { if (failure === point && !usedFailure) { usedFailure = true; throw new Error(`injected ${point} failure`); } };
  const snapshot = (path) => ({ id: path.split("/").at(-1), exists: documents.has(path), data: () => documents.get(path), ref: doc(path) });
  const apply = (path, value, options) => documents.set(path, options?.merge ? { ...(documents.get(path) || {}), ...value } : value);
  function collection(path) {
    return { id: path.split("/").at(-1), doc: (id) => doc(`${path}/${id}`), get: async () => {
      if (path.endsWith("consideredDates")) throwOnce("history-read");
      return { docs: [...documents.keys()].filter((p) => p.startsWith(`${path}/`) && p.slice(path.length + 1).split("/").length === 1).map(snapshot) };
    } };
  }
  function doc(path) {
    return { path, collection: (name) => collection(`${path}/${name}`), get: async () => { if (path === modelPath) throwOnce("root-read"); return snapshot(path); }, set: async (value, options) => apply(path, value, options), listCollections: async () => {
      if (path.endsWith("staydatepattern")) { throwOnce("raw-collection-read"); return [collection(`${path}/2025-03-03`)]; }
      return [];
    } };
  }
  const db = {
    doc, collection,
    bulkWriter: () => { const pending = []; return { set: (ref, value) => pending.push([ref.path, value]), close: async () => {
      throwOnce("stage-close"); pending.forEach(([path, value]) => apply(path, value));
      if (["source-change", "source-counter-change"].includes(failure)) {
        const current = documents.get(modelPath);
        documents.set(modelPath, { ...current, status: "STALE", sourceRevision: current.sourceRevision + 1, ...(failure === "source-change" ? { buildRunId: null } : {}) });
      }
    } }; },
    runTransaction: async (callback) => {
      const pending = [];
      await callback({ get: async (ref) => snapshot(ref.path), set: (ref, value, options) => pending.push([ref.path, value, options]) });
      if (pending.some(([path]) => path.startsWith(`${modelPath}/years/`))) throwOnce("publication");
      pending.forEach(([path, value, options]) => apply(path, value, options));
    },
  };
  return { db, documents, oldYear };
}

test("real rebuild publishes root and annual build identities atomically", async () => {
  const { db, documents } = fixture();
  const result = await rebuildStayPatternModel({ hotelUid: "hotel-a", db });
  assert.equal(result.status, "VALID");
  const root = documents.get(modelPath), year = documents.get(`${modelPath}/years/2025`);
  assert.equal(root.publicationVersion, PUBLICATION_VERSION);
  assert.equal(root.sourceRevision, 0); assert.equal(root.publishedSourceRevision, 0); assert.equal(root.buildSourceRevision, 0);
  assert.equal(root.buildRunId, result.runId); assert.equal(root.latestCompletedBuildRunId, result.runId);
  assert.equal(root.publishedYearBuildRunIds[2025], year.buildRunId);
  assert.equal(documents.get(`${modelPath}/builds/${result.runId}`).status, "COMPLETED");
  assert.equal(year.reconciliation.transient.wape, 0);
});

for (const failure of ["source-change", "source-counter-change"]) test(`source revision changing after raw reads fences publication (${failure})`, async () => {
  const { db, documents, oldYear } = fixture(failure);
  await assert.rejects(rebuildStayPatternModel({ hotelUid: "hotel-a", db }), /superseded|sources changed/);
  const root = documents.get(modelPath);
  assert.equal(root.status, "STALE"); assert.equal(root.sourceRevision, 1); assert.equal(root.publishedSourceRevision, 0);
  assert.equal(root.latestCompletedBuildRunId, "old-build"); assert.equal(documents.get(`${modelPath}/years/2025`), oldYear);
  const receipt = [...documents.entries()].find(([path, value]) => path.startsWith(`${modelPath}/builds/`) && !path.slice(`${modelPath}/builds/`.length).includes("/") && value.status === "FAILED");
  assert.ok(receipt); assert.match(receipt[1].failureMessage, /superseded|sources changed/);
});

test("unknown source revision fails closed without replacing annual evidence", async () => {
  const { db, documents, oldYear } = fixture();
  documents.set(modelPath, { ...documents.get(modelPath), sourceRevision: null });
  await assert.rejects(rebuildStayPatternModel({ hotelUid: "hotel-a", db }), /source revision is unavailable/);
  assert.equal(documents.get(modelPath).status, "STALE"); assert.equal(documents.get(`${modelPath}/years/2025`), oldYear);
});

test("failed initial reads cannot invalidate a newer completed publication", async () => {
  const { Timestamp } = require("firebase-admin/firestore");
  const { db, documents } = fixture("root-read");
  const newer = { ...documents.get(modelPath), buildRunId: "newer-build", latestCompletedBuildRunId: "newer-build", buildStartedAt: Timestamp.fromMillis(Date.now() + 1000), builtAt: Timestamp.fromMillis(Date.now() + 1001) };
  documents.set(modelPath, newer);
  await assert.rejects(rebuildStayPatternModel({ hotelUid: "hotel-a", db }), /injected root-read/);
  assert.equal(documents.get(modelPath), newer);
  assert.equal([...documents.values()].filter((value) => value.status === "FAILED").length, 1);
});

for (const dirty of [false, true]) test(`manual annual refresh ${dirty ? "rebuilds every retained year after source change" : "preserves other annuals at the same source revision"}`, async () => {
  const { db, documents } = fixture();
  const historicalYear = { ...buildYear(2024, [], {}), status: "VALID", buildRunId: "old-build", marker: "old year" };
  documents.set(`${modelPath}/years/2024`, historicalYear);
  documents.set(modelPath, { ...documents.get(modelPath), ...(dirty ? { sourceRevision: 1, status: "STALE" } : {}) });
  const result = await rebuildStayPatternModel({ hotelUid: "hotel-a", years: [2025], db });
  const root = documents.get(modelPath), year = documents.get(`${modelPath}/years/2024`);
  assert.deepEqual(result.affectedYears, dirty ? [2024, 2025] : [2025]);
  assert.equal(root.publishedSourceRevision, dirty ? 1 : 0);
  if (dirty) { assert.notEqual(year, historicalYear); assert.equal(year.buildRunId, result.runId); assert.equal(root.status, "VALIDATION_FAILED"); }
  else { assert.equal(year, historicalYear); assert.equal(root.publishedYearBuildRunIds[2024], "old-build"); }
});

for (const failure of ["root-read", "raw-collection-read", "history-read", "stage-close", "publication"]) test(`failed rebuild at ${failure} invalidates prior VALID root and preserves historical annual publication`, async () => {
  const { db, documents, oldYear } = fixture(failure);
  await assert.rejects(rebuildStayPatternModel({ hotelUid: "hotel-a", db }), new RegExp(`injected ${failure}`));
  const root = documents.get(modelPath);
  assert.equal(root.status, "STALE"); assert.equal(root.publicationVersion, PUBLICATION_VERSION);
  assert.equal(root.latestCompletedBuildRunId, "old-build"); assert.match(root.failureMessage, /injected/);
  assert.equal(documents.get(`${modelPath}/years/2025`), oldYear);
  assert.equal(documents.get(`${modelPath}/builds/${root.failedBuildRunId}`).status, "FAILED");
});
