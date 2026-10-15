const test = require("node:test");
const assert = require("node:assert/strict");
const { memoryDatabase } = require("./inventoryTestHelpers");
const { SAAS_RULES_VERSION } = require("./saasRollout");
const { MAX_ATTACHMENT_BYTES, validateAttachmentBytes, inspectOfficeArchive, validatePurchaseRequestAttachments,
  uploadPurchaseRequestAttachment, readPurchaseRequestAttachment, purchaseRequestDocumentHandler } = require("./purchaseRequestFiles");

const hotelUid = "hotel-a", id = "request-a", fileId = "a".repeat(32), base = `hotels/${hotelUid}/purchaseRequests/${id}`;
const pdf = Buffer.from("%PDF-1.7\nFictional quote\n%%EOF");
const input = (patch = {}) => ({ hotelUid, purchaseRequestId: id, fileId, fileName: "quote.pdf", expectedRevision: "1", ...patch });
const actor = (uid = "requester") => ({ auth: { uid, token: { email_verified: true, auth_time: 100 } } });
function fixture(extra = {}) {
  const db = memoryDatabase({ "platformConfiguration/saasProcurement": { enabled: true, rulesVersion: SAAS_RULES_VERSION },
    [`hotelSubscriptions/${hotelUid}`]: { status: "active", modules: ["procurement"], modulePolicyVersion: 1 },
    [`hotels/${hotelUid}/members/requester`]: { permissions: ["purchaserequests.read", "purchaserequests.update"] },
    [base]: { requesterUid: "requester", revision: 1, status: "draft", attachments: [] }, ...extra });
  const objects = new Map(); let generation = 0;
  const bucket = { beforeSave: null, beforeDownload: null, file(path, options = {}) {
    const object = () => objects.get(path);
    return { save: async (bytes, settings) => {
      if (bucket.beforeSave) await bucket.beforeSave(path, bytes);
      if (objects.has(path) && settings.preconditionOpts.ifGenerationMatch === 0) { const error = new Error("exists"); error.code = 412; throw error; }
      objects.set(path, { bytes: Buffer.from(bytes), metadata: { ...settings.metadata, generation: String(++generation), size: String(bytes.length) } });
    }, getMetadata: async () => {
      assert.ok(object(), "object exists");
      if (options.generation) assert.equal(object().metadata.generation, options.generation);
      return [structuredClone(object().metadata)];
    }, download: async () => { if (bucket.beforeDownload) await bucket.beforeDownload(path); return [Buffer.from(object().bytes)]; } };
  } };
  const users = { requester: { uid: "requester", emailVerified: true, disabled: false } };
  const auth = { getUser: async (uid) => { if (!users[uid]) throw new Error("missing user"); return users[uid]; } };
  return { db, bucket, users, objects, services: { firestore: db, bucket, auth } };
}
const upload = (f, data = input(), request = actor(), bytes = pdf) => uploadPurchaseRequestAttachment(request, data, bytes, f.services);
const download = (f, data = input(), request = actor()) => readPurchaseRequestAttachment(request, data, f.services);

function officeZip(kind, unsafeName) {
  const entries = ["[Content_Types].xml", kind === "docx" ? "word/document.xml" : "xl/workbook.xml", ...(unsafeName ? [unsafeName] : [])];
  const locals = [], directory = []; let offset = 0;
  for (const name of entries) {
    const encoded = Buffer.from(name), local = Buffer.alloc(30), central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(encoded.length, 26);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(encoded.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, encoded); directory.push(central, encoded); offset += local.length + encoded.length;
  }
  const central = Buffer.concat(directory), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}

test("attachment validation bounds bytes and rejects executable, mismatched, encrypted or unsafe Office documents", () => {
  assert.equal(validateAttachmentBytes(pdf, "quote.pdf", "application/pdf").contentType, "application/pdf");
  assert.equal(validateAttachmentBytes(Buffer.from("Unit,Price\nRepair,20\n"), "prices.csv").contentType, "text/csv");
  for (const kind of ["docx", "xlsx"]) {
    assert.ok(inspectOfficeArchive(officeZip(kind), kind));
    assert.ok(!inspectOfficeArchive(officeZip(kind, "../escape"), kind));
    assert.ok(!inspectOfficeArchive(officeZip(kind, "word/vbaProject.bin"), kind));
    assert.throws(() => validateAttachmentBytes(officeZip(kind, "payload.js"), `quote.${kind}`));
    const encrypted = officeZip(kind); encrypted.writeUInt16LE(1, encrypted.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 8);
    assert.throws(() => validateAttachmentBytes(encrypted, `quote.${kind}`));
  }
  for (const [bytes, name, type] of [[Buffer.alloc(0), "empty.txt"], [Buffer.alloc(MAX_ATTACHMENT_BYTES + 1), "large.txt"], [pdf, "quote.exe"], [pdf, "../quote.pdf"], [pdf, "quote\r\n.pdf"], [Buffer.from("<html>"), "quote.pdf"], [Buffer.from([0, 1]), "quote.txt"], [pdf, "quote.pdf", "text/html"]]) assert.throws(() => validateAttachmentBytes(bytes, name, type));
});

test("upload persists its intent before private bytes and an exact retry reuses immutable generation and hash", async () => {
  const f = fixture();
  f.bucket.beforeSave = () => assert.equal(f.db.records.get(`${base}/attachments/${fileId}`).status, "uploading");
  const first = await upload(f), second = await upload(f);
  assert.deepEqual(second, first); assert.equal(f.objects.size, 1); assert.equal(first.revision, 1);
  assert.equal(first.attachment.filePath, `private/purchase-requests/${hotelUid}/${id}/${fileId}`);
  assert.match(first.attachment.sha256, /^[a-f0-9]{64}$/); assert.equal(first.attachment.generation, "1");
  assert.ok(!JSON.stringify(first).includes("token"));
  const frozen = await f.db.runTransaction((tx) => validatePurchaseRequestAttachments(tx, f.db, hotelUid, id, [fileId]));
  assert.deepEqual(frozen, [first.attachment]);
  await assert.rejects(upload(f, input(), actor(), Buffer.from("%PDF-1.7\nChanged source\n%%EOF")), (error) => error.code === "already-exists");
  assert.deepEqual(f.db.records.get(base).attachments, [], "files are selected by the protected request save, not by upload");
});

test("files are editable only by current requester on matching draft/returned revision and active tenant membership", async () => {
  for (const change of ["pending", "approved", "rejected", "withdrawn", "canceled"]) {
    const f = fixture(); f.db.records.get(base).status = change;
    await assert.rejects(upload(f), (error) => error.code === "permission-denied"); assert.equal(f.objects.size, 0);
  }
  const f = fixture();
  await assert.rejects(upload(f, input({ hotelUid: "hotel-b" })), (error) => error.code === "permission-denied");
  await assert.rejects(upload(f, input({ expectedRevision: "0" })), (error) => error.code === "aborted");
  f.users.other = { uid: "other", emailVerified: true }; f.db.records.set(`hotels/${hotelUid}/members/other`, { permissions: ["purchaserequests.read", "purchaserequests.update"] });
  await assert.rejects(upload(f, input(), actor("other")), (error) => error.code === "permission-denied");
  f.db.records.get(`hotelSubscriptions/${hotelUid}`).status = "suspended";
  await assert.rejects(upload(f), (error) => error.code === "permission-denied");
});

test("an account revoked during byte upload cannot finalize evidence and the persisted intent can be recovered", async () => {
  const f = fixture(); f.bucket.beforeSave = () => { f.users.requester.disabled = true; };
  await assert.rejects(upload(f), (error) => error.code === "permission-denied");
  assert.equal(f.db.records.get(`${base}/attachments/${fileId}`).status, "uploading");
  f.users.requester.disabled = false; f.bucket.beforeSave = null;
  assert.equal((await upload(f)).attachment.generation, "1");
  assert.equal(f.objects.size, 1);
});

test("submission racing upload leaves only an unselected intent and cannot silently add submitted evidence", async () => {
  const f = fixture(); f.bucket.beforeSave = () => { Object.assign(f.db.records.get(base), { status: "pending", revision: 2 }); };
  await assert.rejects(upload(f), (error) => error.code === "permission-denied");
  await assert.rejects(f.db.runTransaction((tx) => validatePurchaseRequestAttachments(tx, f.db, hotelUid, id, [fileId])), (error) => error.code === "failed-precondition");
  assert.deepEqual(f.db.records.get(base).attachments, []);
});

test("selection accepts at most ten ready request-bound references and no pending or cross-request IDs", async () => {
  const f = fixture(); await upload(f);
  for (const ids of [[fileId, fileId], ["../another"], Array.from({ length: 11 }, (_, index) => index.toString(16).padStart(32, "0"))]) await assert.rejects(f.db.runTransaction((tx) => validatePurchaseRequestAttachments(tx, f.db, hotelUid, id, ids)), (error) => error.code === "invalid-argument");
  await assert.rejects(f.db.runTransaction((tx) => validatePurchaseRequestAttachments(tx, f.db, hotelUid, "other-request", [fileId])), (error) => error.code === "failed-precondition");
  f.db.records.get(`${base}/attachments/${fileId}`).filePath = `private/purchase-requests/hotel-b/${id}/${fileId}`;
  await assert.rejects(f.db.runTransaction((tx) => validatePurchaseRequestAttachments(tx, f.db, hotelUid, id, [fileId])), (error) => error.code === "failed-precondition");
});

test("a request's bounded upload allowance prevents unselected files from growing storage indefinitely", async () => {
  const f = fixture();
  for (let index = 0; index < 50; index += 1) f.db.records.set(`${base}/attachments/${index.toString(16).padStart(32, "0")}`, { status: "uploading" });
  await assert.rejects(upload(f), (error) => error.code === "resource-exhausted");
  assert.equal(f.objects.size, 0);
});

test("historical approved attachments remain readable after edits and mutable source bytes cannot replace evidence", async () => {
  const f = fixture(), result = await upload(f);
  f.db.records.set(`${base}/history/000001`, { snapshot: { attachments: [result.attachment] } });
  Object.assign(f.db.records.get(base), { revision: 2, status: "pending", attachments: [] });
  await assert.rejects(download(f), (error) => error.code === "not-found");
  assert.deepEqual((await download(f, input({ revision: "1" }))).bytes, pdf);
  const object = f.objects.get(result.attachment.filePath); object.bytes[10] ^= 1;
  await assert.rejects(download(f, input({ revision: "1" })), (error) => error.code === "failed-precondition");
});

test("membership or account removal during download rechecks access before returning any bytes", async () => {
  for (const revoke of ["membership", "account"]) {
    const f = fixture(); await upload(f);
    f.bucket.beforeDownload = () => { if (revoke === "membership") f.db.records.delete(`hotels/${hotelUid}/members/requester`); else f.users.requester.disabled = true; };
    await assert.rejects(download(f), (error) => error.code === "permission-denied");
  }
});

test("HTTP document endpoint rejects expired sessions without looking up document paths or leaking provider errors", async () => {
  const f = fixture(); let verified = false, output;
  f.services.auth.verifyIdToken = async (_token, revoked) => { verified = revoked; throw new Error("private provider details"); };
  const res = { set: () => {}, status(code) { this.code = code; return this; }, json(body) { output = body; return this; } };
  await purchaseRequestDocumentHandler({ method: "GET", headers: { authorization: "Bearer fictional" }, query: input() }, res, f.services);
  assert.equal(verified, true); assert.equal(res.code, 401); assert.match(output.error, /session has expired/); assert.ok(!output.error.includes("provider"));
});
