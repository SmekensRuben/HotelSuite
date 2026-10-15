const test = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");
const { HttpsError } = require("firebase-functions/v2/https");
const { SAAS_RULES_VERSION } = require("./saasRollout");
const { readSupplierProductImage } = require("./supplierProductImages");
const { prepareHotelMcpProposalImageHandler: prepare, decideHotelMcpProposalImageHandler: decide, uploadHotelMcpProposalImage: upload,
  readHotelMcpProposalImage: preview, attachSelectedProposalImages: attach, cleanupHotelMcpProposalImagesHandler: cleanup,
  hotelMcpProposalImageHandler: http, IMAGE_LIFETIME_MS, TEMP_PREFIX, assetPath } = require("./hotelMcpProposalImages");

const hotelUid = "hotel-a", batchId = "batch", rowId = "milk", uid = "buyer", batchPath = `hotels/${hotelUid}/hotelMcpProposalBatches/${batchId}`;
const request = (data = {}, actor = uid) => ({ auth: { uid: actor, token: { email_verified: true, auth_time: 9999 } }, data });
const ids = { hotelUid, batchId, rowId }, originalUrl = "https://images.example.com/milk.jpg?signature=private-token#fragment";
const prepareData = (patch = {}) => ({ ...ids, requestId: "prepare", imageUrl: originalUrl, sourcePageUrl: "https://supplier.example.com/milk?token=private-page", ...patch });
const imageBytes = () => sharp({ create: { width: 400, height: 200, channels: 3, background: "#739dc4" } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
function memoryDatabase(initial = {}) {
  const records = new Map(Object.entries(initial)); let serial = Promise.resolve();
  const snap = (path) => ({ exists: records.has(path), id: path.split("/").at(-1), data: () => structuredClone(records.get(path)) });
  const db = { records, doc: (path) => ({ path, get: async () => snap(path) }), runTransaction(fn) {
    const run = serial.then(async () => {
      const writes = [], tx = { get: async (ref) => { assert.equal(writes.length, 0, "all reads precede writes"); return snap(ref.path); },
        create: (ref, data) => writes.push(["create", ref.path, data]), set: (ref, data) => writes.push(["set", ref.path, data]) };
      const result = await fn(tx);
      for (const [kind, path, data] of writes) { if (kind === "create") assert.equal(records.has(path), false, `duplicate immutable identity ${path}`); records.set(path, data); }
      return result;
    }); serial = run.catch(() => {}); return run;
  } }; return db;
}
function memoryBucket() {
  const objects = new Map(); let generation = 9007199254740993000n;
  const bucket = { name: "hotel-suite-test.appspot.com", objects, afterSave: null, failSave: null, failDelete: null,
    async getFiles(options) {
      assert.equal(options.autoPaginate, false); assert.ok(options.maxResults <= 100);
      return [[...objects.keys()].filter((path) => path.startsWith(options.prefix) && path < options.endOffset).sort().slice(0, options.maxResults).map((name) => ({ name }))];
    }, file(path, options = {}) {
      const current = () => { const item = objects.get(path); if (!item || options.generation && options.generation !== item.metadata.generation) throw Object.assign(new Error("missing"), { code: 404 }); return item; };
      return { save: async (bytes, saveOptions) => {
        assert.equal(saveOptions.preconditionOpts.ifGenerationMatch, 0);
        if (bucket.failSave?.(path)) throw Object.assign(new Error("provider-token-must-not-leak"), { code: 503 });
        if (objects.has(path)) throw Object.assign(new Error("exists"), { code: 412 });
        objects.set(path, { bytes: Buffer.from(bytes), metadata: { ...saveOptions.metadata, size: String(bytes.length), generation: String(++generation) } });
        await bucket.afterSave?.(path);
      }, getMetadata: async () => [current().metadata], download: async (downloadOptions) => { assert.equal(downloadOptions.decompress, false); return [Buffer.from(current().bytes)]; },
      delete: async () => {
        if (bucket.failDelete?.(path)) throw Object.assign(new Error("delete unavailable"), { code: 503 });
        const item = current(); assert.equal(options.preconditionOpts.ifGenerationMatch, item.metadata.generation); objects.delete(path);
      } };
    } };
  return bucket;
}
async function fixture({ action = "create", existingImage = false, createOnly = false } = {}) {
  const productId = action === "update" ? "existing" : "new-milk", product = { supplierProductName: "Milk", revision: 8, pricePerPurchaseUnit: 12, notes: "Preserve local data", priceHistory: [{ price: 11 }] };
  if (existingImage) { product.image = { assetId: "a".repeat(64), status: "ready", policyVersion: 1 }; product.imageRevision = 3; }
  const firestore = memoryDatabase({
    "platformConfiguration/saasProcurement": { enabled: true, rulesVersion: SAAS_RULES_VERSION },
    [`hotels/${hotelUid}/members/${uid}`]: { permissions: ["supplierproducts.read", "supplierproducts.create", ...(!createOnly ? ["supplierproducts.update"] : [])] },
    [`hotels/${hotelUid}/members/other`]: { permissions: ["supplierproducts.read", "supplierproducts.create", "supplierproducts.update"] },
    [`hotelSubscriptions/${hotelUid}`]: { status: "active", modules: ["procurement"], modulePolicyVersion: 1 },
    [batchPath]: { batchId, hotelUid, ownerUid: uid, version: 1, revision: 1, status: "review", activeReviewId: null, rows: [{ rowId, kind: "supplier", action, productId, status: "ready", image: null, result: null, issues: [] }] },
    ...(action === "update" ? { [`hotels/${hotelUid}/supplierproducts/${productId}`]: product } : {}),
  });
  const identity = { uid, emailVerified: true, disabled: false }, bytes = await imageBytes();
  const services = { firestore, identity, bucket: memoryBucket(), now: () => services.clock, clock: Date.parse("2026-10-15T12:00:00Z"),
    auth: { getUser: async (actor) => ({ ...identity, uid: actor }), verifyIdToken: async () => ({ uid, email_verified: true, auth_time: 9999 }) },
    calls: [], downloadImage: async (url) => { services.calls.push(url); return { bytes, mimeType: "image/jpeg", sourceUrl: url }; } };
  services.applyData = () => {
    const batch = firestore.records.get(batchPath), row = batch.rows[0]; row.status = "applied"; row.result = { productId, revision: 9 }; batch.status = "completed";
    if (!firestore.records.has(`hotels/${hotelUid}/supplierproducts/${productId}`)) firestore.records.set(`hotels/${hotelUid}/supplierproducts/${productId}`, product);
  };
  services.productPath = `hotels/${hotelUid}/supplierproducts/${productId}`;
  return services;
}
const assetOf = (s, ack) => s.firestore.records.get(assetPath(hotelUid, ack.image.assetId));
const rowOf = (s) => s.firestore.records.get(batchPath).rows[0];
const choose = (s, ack, patch = {}) => decide(request({ ...ids, assetId: ack.image.assetId, requestId: "select", expectedBatchRevision: s.firestore.records.get(batchPath).revision, action: "select", ...patch }), s);
const attachChosen = (s, ack, patch = {}) => attach(request(), { hotelUid, batchId, rowIds: [rowId], selectionSnapshot: [{ rowId, assetId: ack.image.assetId, decisionRevision: ack.image.decisionRevision }], ...patch }, s);

test("URL preparation creates private optimized candidates only, redacts signed URLs, and exact retry never downloads twice", async () => {
  const s = await fixture(), ack = await prepare(request(prepareData()), s);
  assert.deepEqual(require("./hotelMcpTools").schemas.proposalImage.parse(ack.image), ack.image);
  assert.equal(ack.image.status, "ready"); assert.equal(ack.image.selection, "unselected"); assert.equal(ack.image.currentImage.status, "none");
  assert.deepEqual([ack.image.width, ack.image.height], [200, 400]);
  assert.equal(ack.image.sourceUrl, "https://images.example.com/milk.jpg"); assert.equal(ack.image.sourcePageUrl, "https://supplier.example.com/milk");
  assert.equal(JSON.stringify(ack).includes("private-token"), false); assert.equal(JSON.stringify(ack).includes("private-page"), false);
  assert.equal(assetOf(s, ack).originalSourceUrl.includes("private-token"), true);
  assert.equal(s.bucket.objects.size, 2); assert.equal(rowOf(s).status, "ready"); assert.equal(s.firestore.records.has(s.productPath), false);
  assert.deepEqual(await prepare(request(prepareData()), s), ack); assert.equal(s.calls.length, 1);
  for (const [path, object] of s.bucket.objects) {
    assert.equal(path.startsWith(`${TEMP_PREFIX}/`), true); assert.equal(object.metadata.cacheControl, "private, no-store");
    assert.equal(object.metadata.metadata.firebaseStorageDownloadTokens, undefined);
    const meta = await sharp(object.bytes).metadata(); assert.equal(meta.format, "webp"); assert.equal(meta.exif, undefined);
  }
  const bytes = await preview(request(), { ...ids, assetId: ack.image.assetId, variant: "thumbnail" }, s);
  assert.equal((await sharp(bytes.bytes).metadata()).format, "webp");
});

test("owner, hotel, current permissions and subscription are checked before remote download and every replay", async () => {
  for (const alter of [
    (s) => { s.identity.disabled = true; }, (s) => { s.identity.emailVerified = false; },
    (s) => { s.firestore.records.delete(`hotels/${hotelUid}/members/${uid}`); },
    (s) => { s.firestore.records.set(`hotels/${hotelUid}/members/${uid}`, { permissions: ["supplierproducts.read"] }); },
    (s) => { s.firestore.records.set(`hotelSubscriptions/${hotelUid}`, { status: "active", modules: ["frontoffice"], modulePolicyVersion: 1 }); },
  ]) {
    const s = await fixture(); alter(s); await assert.rejects(prepare(request(prepareData()), s), { code: "permission-denied" }); assert.equal(s.calls.length, 0); assert.equal(s.bucket.objects.size, 0);
  }
  const s = await fixture(), ack = await prepare(request(prepareData()), s);
  await assert.rejects(prepare(request(prepareData(), "other"), s), { code: "permission-denied" });
  await assert.rejects(prepare(request(prepareData({ hotelUid: "hotel-b" })), s), { code: "permission-denied" });
  s.identity.disabled = true;
  await assert.rejects(prepare(request(prepareData()), s), { code: "permission-denied" });
  await assert.rejects(preview(request(), { ...ids, assetId: ack.image.assetId, variant: "display" }, s), { code: "permission-denied" });
});

test("invalid images and Storage failures preserve product data and existing images with independent failure state", async () => {
  const s = await fixture({ action: "update", existingImage: true }), before = structuredClone(s.firestore.records.get(s.productPath));
  s.downloadImage = async () => ({ bytes: Buffer.from("<svg>not a raster</svg>"), mimeType: "image/jpeg", sourceUrl: originalUrl });
  const bad = await prepare(request(prepareData()), s);
  assert.equal(bad.image.status, "failed"); assert.equal(bad.image.error.code, "invalid-image"); assert.equal(rowOf(s).status, "ready");
  assert.deepEqual(s.firestore.records.get(s.productPath), before);
  const storage = await fixture({ action: "update", existingImage: true }), baseline = structuredClone(storage.firestore.records.get(storage.productPath));
  storage.bucket.failSave = (path) => path.endsWith("display.webp");
  const failed = await prepare(request(prepareData()), storage);
  assert.equal(failed.image.status, "failed"); assert.equal(failed.image.error.code, "processing-failed");
  assert.equal(JSON.stringify(failed).includes("provider-token"), false); assert.deepEqual(storage.firestore.records.get(storage.productPath), baseline);
});

test("native retry retains the private source and retries transient preparation within a bounded attempt window", async () => {
  const s = await fixture(), download = s.downloadImage; let unavailable = true;
  s.downloadImage = async (url) => { if (unavailable) throw new HttpsError("unavailable", "Do not echo the signed URL"); return download(url); };
  const failed = await prepare(request(prepareData()), s); assert.equal(failed.image.error.code, "source-unavailable");
  unavailable = false;
  const data = { ...ids, assetId: failed.image.assetId, requestId: "retry", expectedBatchRevision: s.firestore.records.get(batchPath).revision, action: "retry" };
  const retried = await decide(request(data), s);
  assert.equal(retried.image.status, "ready"); assert.equal(assetOf(s, retried).attempts, 2); assert.equal(s.calls[0].includes("private-token"), true);
  assert.deepEqual(await decide(request(data), s), retried); assert.equal(s.calls.length, 1);
});

test("native retry recovers an expired preparation lease after reload while an active lease never repeats I/O", async () => {
  const s = await fixture(), initial = await prepare(request(prepareData()), s), asset = assetOf(s, initial);
  asset.status = "preparing"; asset.attempts = 1; asset.leaseId = "interrupted-worker"; asset.leaseUntil = s.clock + 10000;
  rowOf(s).image.status = "preparing";
  const data = { ...ids, assetId: initial.image.assetId, requestId: "recover-after-reload", expectedBatchRevision: s.firestore.records.get(batchPath).revision, action: "retry" };
  const busy = await decide(request(data), s); assert.equal(busy.image.status, "preparing"); assert.equal(s.calls.length, 1);
  s.clock += 10001;
  const recovered = await decide(request(data), s); assert.equal(recovered.image.status, "ready"); assert.equal(assetOf(s, recovered).attempts, 2); assert.equal(s.calls.length, 2);

  const terminal = assetOf(s, recovered); terminal.status = "preparing"; terminal.attempts = 3; terminal.leaseUntil = 0; rowOf(s).image.status = "preparing";
  const finished = await prepare(request(prepareData()), s); assert.equal(finished.image.status, "failed"); assert.equal(s.calls.length, 2);
});

test("expired URL retries allocate a fresh unselected asset and prefix after old temporary bytes were cleaned", async () => {
  const s = await fixture(), first = await prepare(request(prepareData()), s); await choose(s, first);
  s.clock += IMAGE_LIFETIME_MS + 1;
  assert.equal((await cleanup({}, s)).deleted, 2); assert.equal(s.bucket.objects.size, 0);
  const data = { ...ids, assetId: first.image.assetId, requestId: "renew", expectedBatchRevision: s.firestore.records.get(batchPath).revision, action: "retry" };
  const renewed = await decide(request(data), s);
  assert.notEqual(renewed.image.assetId, first.image.assetId); assert.equal(renewed.image.selection, "unselected"); assert.equal(renewed.image.decisionRevision, 0);
  assert.equal(renewed.image.expiresAtMillis, s.clock + IMAGE_LIFETIME_MS); assert.equal(s.bucket.objects.size, 2);
  const before = [...s.bucket.objects.keys()]; assert.equal((await cleanup({}, s)).deleted, 0); assert.deepEqual([...s.bucket.objects.keys()], before);
  assert.deepEqual(await decide(request(data), s), renewed);
});

test("explicit selection attaches after data approval using create permission without rewriting price or product revisions", async () => {
  const s = await fixture({ createOnly: true }), prepared = await prepare(request(prepareData()), s), selected = await choose(s, prepared);
  assert.equal(selected.image.selection, "selected"); assert.equal(s.firestore.records.has(s.productPath), false);
  s.applyData(); const before = structuredClone(s.firestore.records.get(s.productPath));
  const [attached] = await attachChosen(s, selected);
  assert.equal(attached.image.attachment.status, "attached"); assert.equal(attached.image.attachment.imageRevision, 1);
  const product = s.firestore.records.get(s.productPath);
  assert.equal(product.image.status, "ready"); assert.equal(product.revision, before.revision); assert.equal(product.pricePerPurchaseUnit, before.pricePerPurchaseUnit); assert.deepEqual(product.priceHistory, before.priceHistory);
  assert.equal(s.bucket.objects.size, 4);
  const counts = s.bucket.objects.size; assert.deepEqual(await attachChosen(s, selected), [attached]); assert.equal(s.bucket.objects.size, counts);
  const active = await readSupplierProductImage(request(), { hotelUid, productId: attached.image.attachment.productId, assetId: product.image.assetId, variant: "display" }, s);
  assert.equal((await sharp(active.bytes).metadata()).format, "webp");
  const newer = await prepare(request(prepareData({ requestId: "new-image" })), s);
  await assert.rejects(choose(s, newer, { requestId: "replace-without-update", replaceExisting: true, expectedImageRevision: 1 }), { code: "permission-denied" });
});

test("existing image replacements require explicit human confirmation and the current backend image revision", async () => {
  const s = await fixture({ action: "update", existingImage: true }), oldImage = structuredClone(s.firestore.records.get(s.productPath).image);
  const prepared = await prepare(request(prepareData()), s);
  await assert.rejects(choose(s, prepared), { code: "aborted" });
  await assert.rejects(choose(s, prepared, { requestId: "wrong-cas", replaceExisting: true, expectedImageRevision: 2 }), { code: "aborted" });
  const selected = await choose(s, prepared, { requestId: "replace", replaceExisting: true, expectedImageRevision: 3 });
  assert.deepEqual(s.firestore.records.get(s.productPath).image, oldImage);
  s.applyData(); const [attached] = await attachChosen(s, selected);
  assert.equal(attached.image.attachment.imageRevision, 4); assert.notDeepEqual(s.firestore.records.get(s.productPath).image, oldImage);
});

test("concurrent image changes during derivative copies fail independently and preserve the newer active image", async () => {
  const s = await fixture({ action: "update", existingImage: true }), prepared = await prepare(request(prepareData()), s), selected = await choose(s, prepared, { replaceExisting: true, expectedImageRevision: 3 });
  s.applyData(); let changed = false;
  s.bucket.afterSave = async (path) => { if (path.startsWith("private/supplier-product-images/") && !changed) {
    changed = true; const product = s.firestore.records.get(s.productPath); product.image = { assetId: "b".repeat(64), status: "ready", policyVersion: 1 }; product.imageRevision = 4;
  } };
  const [failed] = await attachChosen(s, selected);
  assert.equal(failed.image.attachment.status, "failed"); assert.equal(failed.image.attachment.error.code, "image-conflict"); assert.equal(failed.image.currentImage.imageRevision, 4);
  assert.equal(s.firestore.records.get(s.productPath).image.assetId, "b".repeat(64)); assert.equal(rowOf(s).status, "applied");
  const reselection = await choose(s, failed, { requestId: "confirm-new-current", replaceExisting: true, expectedImageRevision: 4 });
  assert.equal((await attachChosen(s, reselection))[0].image.attachment.imageRevision, 5);
});

test("stale selection snapshots and omitted candidates cannot attach or remove an active image", async () => {
  const s = await fixture({ action: "update", existingImage: true }), prepared = await prepare(request(prepareData()), s), selected = await choose(s, prepared, { replaceExisting: true, expectedImageRevision: 3 });
  s.applyData(); const old = structuredClone(s.firestore.records.get(s.productPath));
  const omitted = await decide(request({ ...ids, assetId: selected.image.assetId, requestId: "omit", expectedBatchRevision: s.firestore.records.get(batchPath).revision, action: "omit" }), s);
  assert.equal(omitted.image.selection, "omitted");
  assert.equal((await attachChosen(s, selected))[0].image.attachment.status, "none"); assert.deepEqual(s.firestore.records.get(s.productPath), old);
  const newer = await prepare(request(prepareData({ requestId: "new-candidate" })), s);
  await attachChosen(s, selected); assert.equal(rowOf(s).image.assetId, newer.image.assetId); assert.deepEqual(s.firestore.records.get(s.productPath), old);
});

test("account revocation during copying prevents promotion and leaves already approved product data intact", async () => {
  const s = await fixture(), prepared = await prepare(request(prepareData()), s), selected = await choose(s, prepared); s.applyData();
  s.bucket.afterSave = async (path) => { if (path.startsWith("private/supplier-product-images/")) s.identity.disabled = true; };
  await assert.rejects(attachChosen(s, selected), { code: "permission-denied" });
  assert.equal(s.firestore.records.get(s.productPath).image, undefined); assert.equal(rowOf(s).status, "applied");
});

test("cleanup removes expired private candidates and failed managed copies while retaining once-published derivatives", async () => {
  const s = await fixture(), prepared = await prepare(request(prepareData()), s), selected = await choose(s, prepared); s.applyData();
  s.bucket.failSave = (path) => path.startsWith("private/supplier-product-images/") && path.endsWith("display.webp");
  assert.equal((await attachChosen(s, selected))[0].image.attachment.status, "failed");
  assert.equal([...s.bucket.objects.keys()].filter((path) => path.startsWith("private/supplier-product-images/")).length, 1);
  s.clock += IMAGE_LIFETIME_MS + 1;
  assert.equal((await cleanup({}, s)).deleted, 2); assert.equal(s.bucket.objects.size, 0);
  assert.equal((await cleanup({}, s)).deleted, 0);

  const retained = await fixture(), initial = await prepare(request(prepareData()), retained), chosen = await choose(retained, initial); retained.applyData();
  const [attached] = await attachChosen(retained, chosen); assert.equal(attached.image.attachment.status, "attached");
  retained.clock += IMAGE_LIFETIME_MS + 1;
  assert.equal((await cleanup({}, retained)).deleted, 2); assert.equal(retained.bucket.objects.size, 2);
  assert.equal([...retained.bucket.objects.keys()].every((path) => path.startsWith("private/supplier-product-images/")), true);
});

test("cleanup preserves expiry lookup blobs after managed deletion failure and skips active image leases", async () => {
  const s = await fixture(), prepared = await prepare(request(prepareData()), s), selected = await choose(s, prepared); s.applyData();
  s.bucket.failSave = (path) => path.startsWith("private/supplier-product-images/") && path.endsWith("display.webp"); await attachChosen(s, selected);
  s.clock += IMAGE_LIFETIME_MS + 1; s.bucket.failDelete = (path) => path.startsWith("private/supplier-product-images/");
  assert.equal((await cleanup({}, s)).failed, 2); assert.equal([...s.bucket.objects.keys()].filter((path) => path.startsWith(`${TEMP_PREFIX}/`)).length, 2);
  s.bucket.failDelete = null; assert.equal((await cleanup({}, s)).deleted, 2); assert.equal(s.bucket.objects.size, 0);
  const busy = await fixture(), ack = await prepare(request(prepareData()), busy); busy.clock += IMAGE_LIFETIME_MS + 1;
  const asset = assetOf(busy, ack); asset.attachLeaseUntil = busy.clock + 10000;
  assert.equal((await cleanup({}, busy)).skipped, 2); assert.equal(busy.bucket.objects.size, 2);
});

test("native HTTP upload and preview require verified Firebase bearer identity and never admit MCP self-selection", async () => {
  const s = await fixture(), native = await upload(request(), { ...ids, requestId: "file", mimeType: "image/jpeg" }, await imageBytes(), s);
  assert.equal(native.image.status, "ready"); assert.equal(native.image.sourceUrl, null);
  const mcpRequest = request(); mcpRequest.mcpAuth = { scopes: ["hotel-toolkit:read", "hotel-toolkit:propose"], assertActive: async () => {} };
  await assert.rejects(upload(mcpRequest, { ...ids, requestId: "ai-file", mimeType: "image/jpeg" }, await imageBytes(), s), { code: "permission-denied" });
  await assert.rejects(decide({ ...mcpRequest, data: { ...ids, assetId: native.image.assetId, requestId: "ai-select", expectedBatchRevision: native.batchRevision, action: "select" } }, s), { code: "permission-denied" });
  await assert.rejects(preview(mcpRequest, { ...ids, assetId: native.image.assetId, variant: "display" }, s), { code: "permission-denied" });
  const response = () => ({ code: 200, headers: {}, set(name, value) { this.headers[name] = value; }, status(value) { this.code = value; return this; }, json(value) { this.body = value; return this; }, send(value) { this.body = value; return this; } });
  const denied = response(); await http({ method: "GET", headers: {}, query: { ...ids, assetId: native.image.assetId, variant: "display" } }, denied, s); assert.equal(denied.code, 401);
  const allowed = response(); await http({ method: "GET", headers: { authorization: "Bearer verified-session" }, query: { ...ids, assetId: native.image.assetId, variant: "display" } }, allowed, s);
  assert.equal(allowed.code, 200); assert.equal(allowed.headers["Cache-Control"], "private, no-store"); assert.equal(allowed.headers["X-Content-Type-Options"], "nosniff"); assert.equal(Buffer.isBuffer(allowed.body), true);
});
