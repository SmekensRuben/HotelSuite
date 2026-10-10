process.env.FIREBASE_CONFIG ||= JSON.stringify({ projectId: "hotel-suite-test", storageBucket: "hotel-suite-test.appspot.com" });
process.env.RESEND_WEBHOOK_SECRET = `whsec_${Buffer.from("import-routing-test-secret").toString("base64")}`;
const test = require("node:test");
const assert = require("node:assert/strict");
const { Webhook } = require("svix");
const { createResendEmailReceivedHandler } = require("./webhook");
const { receiverId, importProjectionId, syncImportProjection, claimReceipt, releaseReceipt, finishReceipt } = require("./importRouting");
const { importRunId } = require("./importProcessing");
const { processMappedDocumentStream, processImportedFileToFirestore, processXmlDocumentsStream } = require("./fileImportTypes");
const { ImportTestDb, ImportTestBucket } = require("../testSupport/imports");
const { admin } = require("./config");
const silent = { info() {}, warn() {}, error() {} };
const receiver = "reports-a@example.test";
function fixture(extra = {}) {
  return new ImportTestDb({
    [`importReceivingIdentities/${receiverId(receiver)}`]: { schemaVersion: 1, provider: "resend", receiver, hotelUid: "hotel-a", enabled: true },
    "hotels/hotel-a/fileImportSettings/shared": { fromEmail: "pms@example.test", toEmail: receiver, subjectContains: "arrivals", fileType: "arrivals" },
    ...extra,
  });
}
function request(patch = {}) {
  const payload = { type: "email.received", data: { email_id: "email-a", from: "PMS <pms@example.test>",
    to: [receiver], subject: "Daily arrivals", attachments: [{ id: "attachment-a", filename: "arrivals.csv" }], ...patch } };
  const rawBody = Buffer.from(JSON.stringify(payload));
  const id = "svix-delivery-a", timestamp = new Date();
  const headers = { "svix-id": id, "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
    "svix-signature": new Webhook(process.env.RESEND_WEBHOOK_SECRET).sign(id, timestamp, rawBody.toString()) };
  return { method: "POST", rawBody, get: (name) => headers[name] };
}
async function deliver(handler, req = request()) {
  const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  await handler(req, response); return response;
}
function handler(db, bucket, fetchAttachment = async () => Buffer.from("id\n1")) {
  return createResendEmailReceivedHandler({ db, bucket, fetchAttachment, activeSubscription: async () => true, log: silent });
}

test("signed source routing binds recipient before editable settings; another hotel cannot claim the mailbox", async () => {
  const db = fixture({ "hotels/hotel-b/fileImportSettings/0000": { fromEmail: "pms@example.test", toEmail: receiver, subjectContains: "arrivals", fileType: "stolen" },
    "fileImportSettingsIndex/0000": { hotelUid: "hotel-b", fromEmail: "pms@example.test", toEmail: receiver, subjectContains: "arrivals" } });
  const bucket = new ImportTestBucket();
  const response = await deliver(handler(db, bucket));
  assert.equal(response.statusCode, 200); assert.equal(response.body.hotelUid, "hotel-a");
  assert.equal(bucket.saves, 1);
  assert.equal(db.readPaths.some((path) => path.startsWith("hotels/hotel-b") || path.startsWith("fileImportSettingsIndex")), false);
  db.records.delete("hotels/hotel-a/fileImportSettings/shared");
  assert.equal((await deliver(handler(db, bucket), request({ email_id: "email-b" }))).statusCode, 404);
  assert.equal(bucket.saves, 1);
});

test("unowned, disabled and ambiguous receivers/settings reject before attachment fetch", async () => {
  let downloads = 0;
  const bucket = new ImportTestBucket();
  const db = fixture();
  const run = handler(db, bucket, async () => { downloads += 1; return Buffer.from("data"); });
  assert.equal((await deliver(run, request({ to: ["unknown@example.test"] }))).statusCode, 404);
  db.records.set("hotels/hotel-a/fileImportSettings/second", { ...db.records.get("hotels/hotel-a/fileImportSettings/shared") });
  assert.equal((await deliver(run)).statusCode, 409);
  db.records.delete("hotels/hotel-a/fileImportSettings/second");
  const second = "reports-b@example.test";
  db.records.set(`importReceivingIdentities/${receiverId(second)}`, { schemaVersion: 1, provider: "resend", receiver: second, hotelUid: "hotel-b", enabled: true });
  assert.equal((await deliver(run, request({ to: [receiver, second] }))).statusCode, 409);
  db.records.get(`importReceivingIdentities/${receiverId(receiver)}`).enabled = false;
  assert.equal((await deliver(run)).statusCode, 404); assert.equal(downloads, 0); assert.equal(bucket.saves, 0);
});

test("concurrent and repeated authenticated deliveries share one durable object and receipt", async () => {
  const db = fixture(), bucket = new ImportTestBucket();
  let finishDownload;
  const download = new Promise((resolve) => { finishDownload = resolve; });
  const run = handler(db, bucket, async () => download);
  const first = deliver(run);
  // Claiming happens before the fetch; wait until the receipt is visible.
  while (![...db.records.keys()].some((path) => path.startsWith("importIngressReceipts/"))) await new Promise((resolve) => setImmediate(resolve));
  const concurrent = await deliver(run);
  assert.equal(concurrent.statusCode, 503);
  finishDownload(Buffer.from("id\n1"));
  const completed = await first;
  const replay = await deliver(run);
  assert.equal(completed.statusCode, 200); assert.equal(replay.statusCode, 200); assert.equal(replay.body.duplicate, true);
  assert.equal(replay.body.storagePath, completed.body.storagePath); assert.equal(bucket.saves, 1);
});

test("crash after object creation resumes via generation precondition without another finalize object", async () => {
  const db = fixture(), bucket = new ImportTestBucket(); bucket.failAfterSave = true;
  const run = handler(db, bucket);
  assert.equal((await deliver(run)).statusCode, 500);
  assert.equal((await deliver(run)).statusCode, 200);
  assert.equal(bucket.saves, 1); assert.equal(bucket.createAttempts, 2);
  const receipt = [...db.records.entries()].find(([path]) => path.startsWith("importIngressReceipts/"))[1];
  assert.equal(receipt.state, "complete");
});

test("receipt fences expired owners, rejects identity changes and resumes released attempts", async () => {
  const db = new ImportTestDb(), ref = db.doc("importIngressReceipts/test"), descriptor = { email: "a" };
  const first = await claimReceipt(db, ref, descriptor, { now: 100, leaseMs: 10 });
  assert.equal((await claimReceipt(db, ref, descriptor, { now: 105 })).state, "busy");
  const second = await claimReceipt(db, ref, descriptor, { now: 111 });
  await assert.rejects(() => finishReceipt(db, ref, first.owner, {}), /lease lost/);
  await assert.rejects(() => claimReceipt(db, ref, { email: "b" }), /identity conflict/);
  await releaseReceipt(db, ref, second.owner);
  assert.equal((await claimReceipt(db, ref, descriptor)).state, "claimed");
});

test("qualified projections preserve equal local IDs, own deletes and canonical reordered events", async () => {
  const db = new ImportTestDb({ "hotels/hotel-a/fileImportSettings/shared": { subjectContains: "new-a" },
    "hotels/hotel-b/fileImportSettings/shared": { subjectContains: "new-b" } });
  const project = (hotelUid) => syncImportProjection(db, { hotelUid, localId: "shared", sourceCollection: "fileImportSettings", indexCollection: "fileImportSettingsIndex" });
  await Promise.all([project("hotel-a"), project("hotel-b")]);
  const a = `fileImportSettingsIndex/${importProjectionId("hotel-a", "shared")}`, b = `fileImportSettingsIndex/${importProjectionId("hotel-b", "shared")}`;
  assert.notEqual(a, b); assert.equal(db.records.get(a).subjectContains, "new-a"); assert.equal(db.records.get(b).subjectContains, "new-b");
  db.records.delete("hotels/hotel-a/fileImportSettings/shared"); await project("hotel-a");
  assert.equal(db.records.has(a), false); assert.equal(db.records.has(b), true);
  // A delayed create must not resurrect the deleted source.
  await project("hotel-a"); assert.equal(db.records.has(a), false);
  db.records.set("hotels/hotel-a/fileImportSettings/shared", { subjectContains: "recreated" });
  // A delayed delete must reflect the recreated canonical source.
  await project("hotel-a"); assert.equal(db.records.get(a).subjectContains, "recreated");
  db.records.set(a, { hotelUid: "hotel-b", sourcePath: "hotels/hotel-b/fileImportSettings/shared" });
  await assert.rejects(() => project("hotel-a"), /ownership mismatch/);
  assert.equal(db.records.get(a).hotelUid, "hotel-b");
  for (const hotelUid of ["hotel-a", "hotel-b"]) {
    db.records.set(`hotels/${hotelUid}/fileImportTypes/shared`, { fileType: "arrivals" });
    await syncImportProjection(db, { hotelUid, localId: "shared", sourceCollection: "fileImportTypes", indexCollection: "fileImportTypesIndex" });
  }
  assert.equal([...db.records.keys()].filter((path) => path.startsWith("fileImportTypesIndex/")).length, 2);
});

test("actual projection trigger ignores stale event payload and deleted source", async () => {
  const db = fixture(), previous = admin.firestore; admin.firestore = () => db;
  try {
    const { syncFileImportSettingsIndex } = require("./meili");
    await syncFileImportSettingsIndex.run({ params: { hotelUid: "hotel-a", fileImportSettingId: "shared" }, data: { after: { exists: false } } });
    assert.equal(db.records.get(`fileImportSettingsIndex/${importProjectionId("hotel-a", "shared")}`).subjectContains, "arrivals");
    db.records.delete("hotels/hotel-a/fileImportSettings/shared");
    await syncFileImportSettingsIndex.run({ params: { hotelUid: "hotel-a", fileImportSettingId: "shared" }, data: { after: { exists: true, data: () => ({ subjectContains: "stale" }) } } });
    assert.equal(db.records.has(`fileImportSettingsIndex/${importProjectionId("hotel-a", "shared")}`), false);
  } finally { admin.firestore = previous; }
});

const object = { bucket: "fixture.appspot.com", name: "imports/hotel-a/manual/source.csv", generation: "7" };
const config = { id: "type-a", basePath: "hotels/{hotelUid}", targetPath: "reports/summary", writeMode: "merge",
  columnMappings: [{ databaseField: "items", targetType: "list", childMappings: [] }] };
function streamRows(count) { return Array.from({ length: count }, (_, rowIndex) => ({ rowIndex, mappedDocument: { items: [{ rowIndex }] } })); }
async function importRows(db, runRef, owner, rows, fileImportType = config) {
  return processMappedDocumentStream({ db, runRef, owner, fileImportType, hotelUid: "hotel-a", fileType: "arrivals", object,
    onEachMappedDocument: async (onRow) => { for (const row of rows) await onRow(row); } });
}

test("imports cannot bypass stock finalization or scheduled-worker authority", async () => {
  for (const targetPath of ["stockCounts/finalized", "stockCounts/finalized/locations/bar", "scheduledMailReceipts/send", "guestIntelligence/current", "guestIntelligenceRuns/run", "guestIntelligenceVersions/version", "reports/stayPatternModel", "reports/stayPatternModel/years/2026", "reports/stayPatternModel/builds/run/years/2026"]) {
    const path = `hotels/hotel-a/${targetPath}`;
    const original = { status: "Finished", countedValue: 123, owner: "server" };
    const db = new ImportTestDb({ [path]: original });
    const runRef = db.doc(`hotels/hotel-a/importRuns/${importRunId(object)}`);
    const claimed = await claimReceipt(db, runRef, object);
    await assert.rejects(() => importRows(db, runRef, claimed.owner,
      [{ rowIndex: 0, mappedDocument: { status: "Started", countedValue: 0 } }],
      { ...config, targetPath }), /authorized hotel/);
    assert.deepEqual(db.records.get(path), original, targetPath);
    assert.equal([...db.records.keys()].some((key) => key.includes("/chunks/")), false);
  }
});

test("XML preserves split UTF-8 and crash replay accepts identical bytes with different stream boundaries", async () => {
  const { Readable } = require("node:stream");
  const bytes = Buffer.from("<ROOT><G_RESERVATION><NAME>José 😀</NAME></G_RESERVATION></ROOT>");
  const xmlConfig = { ...config, recordNodeName: "G_RESERVATION", columnMappings: [{ sourceField: "NAME", databaseField: "name", targetType: "string" }] };
  const db = new ImportTestDb(), runRef = db.doc(`hotels/hotel-a/importRuns/${importRunId(object)}`);
  const attempt = async (owner, chunks) => processMappedDocumentStream({ db, runRef, owner, fileImportType: xmlConfig,
    hotelUid: "hotel-a", fileType: "arrivals", object,
    onEachMappedDocument: (onRow) => processXmlDocumentsStream(Readable.from(chunks), xmlConfig, onRow) });
  const first = await claimReceipt(db, runRef, object);
  db.failAfter = (writes) => writes.some((write) => write.path.includes("/chunks/"));
  await assert.rejects(() => attempt(first.owner, Array.from(bytes, (byte) => Buffer.from([byte]))), /crash after/);
  assert.equal(db.records.get("hotels/hotel-a/reports/summary").name, "José 😀");
  db.failAfter = null; await releaseReceipt(db, runRef, first.owner);
  const second = await claimReceipt(db, runRef, object);
  await attempt(second.owner, [bytes]);
  assert.equal(db.records.get("hotels/hotel-a/reports/summary").name, "José 😀");
});

test("atomic import checkpoints resume partial progress without duplicate unkeyed list items", async () => {
  const db = new ImportTestDb(), runRef = db.doc(`hotels/hotel-a/importRuns/${importRunId(object)}`), rows = streamRows(55);
  const first = await claimReceipt(db, runRef, object, { initialData: { configuration: config } });
  db.failBefore = (writes) => writes.some((write) => write.path.endsWith("chunks/00000001"));
  await assert.rejects(() => importRows(db, runRef, first.owner, rows), /failure before/);
  assert.equal(db.records.get("hotels/hotel-a/reports/summary").items.length, 50);
  db.failBefore = null; await releaseReceipt(db, runRef, first.owner);
  const second = await claimReceipt(db, runRef, object, { initialData: { configuration: { ...config, targetPath: "reports/wrong" } } });
  assert.equal(second.configuration.targetPath, "reports/summary");
  const summary = await importRows(db, runRef, second.owner, rows, second.configuration);
  assert.equal(summary.writtenCount, 2); assert.equal(db.records.get("hotels/hotel-a/reports/summary").items.length, 55);
  await importRows(db, runRef, second.owner, rows);
  assert.equal(db.records.get("hotels/hotel-a/reports/summary").items.length, 55);
  await finishReceipt(db, runRef, second.owner, summary);
  assert.equal((await claimReceipt(db, runRef, object)).state, "complete");
});

test("lost commit acknowledgement does not repeat append-mode rows after resume", async () => {
  const db = new ImportTestDb(), runRef = db.doc(`hotels/hotel-a/importRuns/${importRunId(object)}`), rows = streamRows(2);
  const appendConfig = { ...config, targetPath: "reports", writeMode: "append" };
  const first = await claimReceipt(db, runRef, object);
  db.failAfter = (writes) => writes.some((write) => write.path.includes("/chunks/"));
  await assert.rejects(() => importRows(db, runRef, first.owner, rows, appendConfig), /crash after/);
  db.failAfter = null; await releaseReceipt(db, runRef, first.owner);
  const second = await claimReceipt(db, runRef, object);
  await importRows(db, runRef, second.owner, rows, appendConfig);
  assert.equal([...db.records.keys()].filter((path) => /^hotels\/hotel-a\/reports\/[^/]+$/.test(path)).length, 2);
});

test("actual finalize handler uses canonical types, pins generation and deduplicates replay", async () => {
  const db = new ImportTestDb({ "hotelSubscriptions/hotel-a": { status: "active" },
    "hotels/hotel-a/fileImportTypes/shared": { fileType: "arrivals", parserType: "csv", hasHeaderRow: true,
      basePath: "hotels/{hotelUid}", targetPath: "reports", writeMode: "append",
      columnMappings: [{ sourceField: "ID", databaseField: "id", targetType: "string" }] },
    "fileImportTypesIndex/shared": { hotelUid: "hotel-b", fileType: "arrivals", basePath: "hotels/hotel-b" } });
  const bucket = new ImportTestBucket(); bucket.objects.set(object.name, { bytes: Buffer.from("ID\na\nb\n") });
  let pinned;
  const previousDb = admin.firestore, previousStorage = admin.storage;
  admin.firestore = () => db;
  admin.storage = () => ({ bucket: () => ({ file: (path, options) => { pinned = options.generation; return bucket.file(path); } }) });
  try {
    const event = { data: { ...object, metadata: { hotelUid: "hotel-a", fileType: "arrivals" } } };
    await processImportedFileToFirestore.run(event); await processImportedFileToFirestore.run(event);
    assert.equal(pinned, "7");
    assert.equal([...db.records.keys()].filter((path) => /^hotels\/hotel-a\/reports\/[^/]+$/.test(path)).length, 2);
    assert.equal(db.readPaths.some((path) => path.startsWith("fileImportTypesIndex")), false);
    assert.equal(db.records.get(`hotels/hotel-a/importRuns/${importRunId(object)}`).state, "complete");
  } finally { admin.firestore = previousDb; admin.storage = previousStorage; }
});

test("operator migration preserves canonical routes, blocks receiver transfers and reindexes from exact sources", async () => {
  const { validateImportManifest, inspectImportMigration, applyImportMigration } = await import("../../scripts/firebase/import-routing-migration.mjs");
  const manifest = { schemaVersion: 1, projectId: "demo-import-test", bindings: [{ receiver, hotelUid: "hotel-a", enabled: true, ownershipEvidence: "Reviewed fixture mailbox" }] };
  assert.throws(() => validateImportManifest({ ...manifest, bindings: [...manifest.bindings, { ...manifest.bindings[0], hotelUid: "hotel-b" }] }), /exactly one/);
  const db = fixture({ "hotels/hotel-a": {}, "hotels/hotel-b": {},
    "hotels/hotel-a/fileImportTypes/shared": { fileType: "arrivals", columnMappings: [{ sourceField: "ID" }] },
    "hotels/hotel-b/fileImportSettings/shared": { fromEmail: "pms@example.test", toEmail: receiver, subjectContains: "arrivals", fileType: "arrivals" },
    "fileImportSettingsIndex/shared": { hotelUid: "hotel-b", fileType: "arrivals" } });
  let inspection = await inspectImportMigration(db, manifest);
  assert.equal(inspection.summary.issues.length, 1);
  await assert.rejects(() => applyImportMigration(db, inspection), /preflight issue/);
  const destination = "new-b@example.test";
  const explicit = { ...manifest, bindings: [...manifest.bindings, { receiver: destination, hotelUid: "hotel-b", enabled: true, ownershipEvidence: "New dedicated B mailbox" }],
    settingMoves: [{ sourcePath: "hotels/hotel-b/fileImportSettings/shared", fromReceiver: receiver, toReceiver: destination }] };
  inspection = await inspectImportMigration(db, explicit);
  assert.deepEqual(inspection.summary.issues, []); assert.equal(inspection.summary.explicitSettingMoves, 1);
  await applyImportMigration(db, inspection, { pruneLegacy: true });
  assert.equal(db.records.get("hotels/hotel-a/fileImportSettings/shared").toEmail, receiver);
  assert.equal(db.records.get("hotels/hotel-b/fileImportSettings/shared").toEmail, destination);
  assert.equal(db.records.get(`fileImportSettingsIndex/${importProjectionId("hotel-a", "shared")}`).hotelUid, "hotel-a");
  assert.equal(db.records.get(`fileImportSettingsIndex/${importProjectionId("hotel-b", "shared")}`).hotelUid, "hotel-b");
  assert.equal(db.records.has("fileImportSettingsIndex/shared"), false);
  const after = await inspectImportMigration(db, explicit);
  assert.deepEqual(after.summary.issues, []); assert.equal(after.summary.explicitSettingMoves, 0);
  assert.equal(after.summary.legacyProjections, 0);
  db.records.get(`importReceivingIdentities/${receiverId(receiver)}`).hotelUid = "hotel-b";
  assert.equal((await inspectImportMigration(db, explicit)).summary.issues[0].issue.includes("another owner"), true);
});

test("migration prunes only unchanged legacy ownership snapshots and source changes block explicit moves", async () => {
  const { inspectImportMigration, applyImportMigration } = await import("../../scripts/firebase/import-routing-migration.mjs");
  const next = "new-a@example.test";
  const manifest = { schemaVersion: 1, projectId: "demo-import-test", bindings: [{ receiver: next, hotelUid: "hotel-a", enabled: true, ownershipEvidence: "Reviewed new mailbox" }],
    settingMoves: [{ sourcePath: "hotels/hotel-a/fileImportSettings/shared", fromReceiver: receiver, toReceiver: next }] };
  const db = fixture({ "hotels/hotel-a": {}, "fileImportSettingsIndex/shared": { hotelUid: "hotel-a" } });
  const inspection = await inspectImportMigration(db, manifest);
  db.records.get("hotels/hotel-a/fileImportSettings/shared").subjectContains = "changed";
  await assert.rejects(() => applyImportMigration(db, inspection, { pruneLegacy: true }), /Canonical setting changed/);
  assert.equal(db.records.has("fileImportSettingsIndex/shared"), true);
  const current = await inspectImportMigration(db, manifest);
  db.records.set("fileImportSettingsIndex/shared", { hotelUid: "hotel-b" });
  await assert.rejects(() => applyImportMigration(db, current, { pruneLegacy: true }), /Legacy projection changed/);
  assert.equal(db.records.get("fileImportSettingsIndex/shared").hotelUid, "hotel-b");
});

test("finalize run lease prevents a concurrent parser and keeps current target checks on replay", async () => {
  const db = new ImportTestDb({ "hotelSubscriptions/hotel-a": { status: "active" },
    "hotels/hotel-a/fileImportTypes/shared": { fileType: "arrivals", parserType: "csv", basePath: "hotels/{hotelUid}", targetPath: "reports",
      columnMappings: [{ sourceField: "ID", databaseField: "id", targetType: "string" }] } });
  let deliverBytes;
  const { PassThrough } = require("node:stream"), stream = new PassThrough();
  let readCount = 0;
  const previousDb = admin.firestore, previousStorage = admin.storage;
  admin.firestore = () => db;
  admin.storage = () => ({ bucket: () => ({ file: () => ({ createReadStream: () => { readCount += 1; deliverBytes = () => stream.end("ID\na\n"); return stream; } }) }) });
  try {
    const event = { data: { ...object, metadata: { hotelUid: "hotel-a", fileType: "arrivals" } } };
    const first = processImportedFileToFirestore.run(event);
    while (!deliverBytes) await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(() => processImportedFileToFirestore.run(event), /already processing/);
    assert.equal(readCount, 1);
    deliverBytes(); await first;
    await processImportedFileToFirestore.run({ data: { ...object, metadata: { hotelUid: "hotel-b", fileType: "arrivals" } } });
    assert.equal([...db.records.keys()].some((path) => path.startsWith("hotels/hotel-b/")), false);
    assert.equal(readCount, 1);
  } finally { admin.firestore = previousDb; admin.storage = previousStorage; }
});

test("expired parser owner cannot write chunks after a new attempt is claimed", async () => {
  const db = new ImportTestDb(), ref = db.doc(`hotels/hotel-a/importRuns/${importRunId(object)}`);
  const first = await claimReceipt(db, ref, object, { now: 100, leaseMs: 10 });
  const second = await claimReceipt(db, ref, object, { now: 111 });
  await assert.rejects(() => importRows(db, ref, first.owner, streamRows(2)), /lease lost/);
  assert.equal(db.records.has("hotels/hotel-a/reports/summary"), false);
  await importRows(db, ref, second.owner, streamRows(2));
  assert.equal(db.records.get("hotels/hotel-a/reports/summary").items.length, 2);
});
