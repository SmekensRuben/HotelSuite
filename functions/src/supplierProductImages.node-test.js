const test = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");
const { SAAS_RULES_VERSION } = require("./saasRollout");
const { MAX_IMAGE_BYTES, createImageVariants } = require("./supplierProductImagesPolicy");
const { uploadSupplierProductImage, readSupplierProductImage, supplierProductImageHandler, processSupplierProductImageHandler, sourcePath, variantPath } = require("./supplierProductImages");

const fixtureImage = () => sharp({ create: { width: 400, height: 200, channels: 3, background: "#2468a0" } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
function memoryDatabase(initial = {}) {
  const records = new Map(Object.entries(initial));
  const snap = (path) => ({ exists: records.has(path), data: () => records.get(path), ref: db.doc(path) });
  const apply = (path, data) => {
    const target = { ...(records.get(path) || {}) };
    for (const [key, value] of Object.entries(data)) {
      if (value?.constructor.name === "DeleteTransform") delete target[key]; else target[key] = value;
    }
    records.set(path, target);
  };
  let serial = Promise.resolve();
  const db = { records, doc: (path) => ({ path, get: async () => snap(path) }), runTransaction(fn) {
    const run = serial.then(async () => {
      const writes = [];
      const tx = { get: async (ref) => { assert.equal(writes.length, 0, "read before write"); return snap(ref.path); },
        update: (ref, data) => { assert.equal(records.has(ref.path), true); writes.push([ref.path, data]); },
        create: (ref, data) => { assert.equal(records.has(ref.path), false); writes.push([ref.path, data]); } };
      const result = await fn(tx);
      for (const [path, data] of writes) apply(path, data);
      return result;
    }); serial = run.catch(() => {}); return run;
  } };
  return db;
}
function memoryBucket() {
  const objects = new Map(); let generation = 9007199254740993000n;
  const bucket = { name: "hotel-suite-test.appspot.com", objects, afterSave: null, failDownload: false, file(path, options = {}) {
    const current = () => {
      const object = objects.get(path);
      if (!object || options.generation && options.generation !== object.metadata.generation) throw Object.assign(new Error("Object not found"), { code: 404 });
      return object;
    };
    return { save: async (bytes, options) => {
      assert.equal(options.preconditionOpts.ifGenerationMatch, 0);
      if (objects.has(path)) throw Object.assign(new Error("Precondition"), { code: 412 });
      objects.set(path, { bytes: Buffer.from(bytes), metadata: { ...options.metadata, size: String(bytes.length), generation: String(++generation) } });
      await bucket.afterSave?.(path);
    }, getMetadata: async () => [current().metadata], download: async (options) => {
      assert.equal(options.decompress, false);
      if (bucket.failDownload) { bucket.failDownload = false; throw Object.assign(new Error("Unavailable"), { code: 503 }); }
      return [Buffer.from(current().bytes)];
    } };
  } };
  return bucket;
}
function fixture() {
  const firestore = memoryDatabase({
    "platformConfiguration/saasProcurement": { enabled: true, rulesVersion: SAAS_RULES_VERSION },
    "hotels/hotel-a/members/buyer": { permissions: ["supplierproducts.read", "supplierproducts.update"] },
    "hotelSubscriptions/hotel-a": { status: "active", modules: ["procurement"], modulePolicyVersion: 1 },
    "hotels/hotel-a/supplierproducts/milk": { supplierProductName: "Milk", revision: 99, pricePerPurchaseUnit: 10, priceHistory: [{ price: 9 }], createdBy: "buyer" },
  });
  const identity = { uid: "buyer", disabled: false, emailVerified: true };
  return { firestore, bucket: memoryBucket(), identity, auth: { getUser: async () => identity, verifyIdToken: async () => ({ uid: "buyer", email_verified: true, auth_time: 9999 }) } };
}
const request = () => ({ auth: { uid: "buyer", token: { email_verified: true, auth_time: 9999 } } });
const uploadData = (patch = {}) => ({ hotelUid: "hotel-a", productId: "milk", requestId: "image-1", expectedImageRevision: "0", mimeType: "image/jpeg", ...patch });
const productOf = (services) => services.firestore.records.get("hotels/hotel-a/supplierproducts/milk");
const assetOf = (services, result) => services.firestore.records.get(`hotels/hotel-a/supplierProductImages/${result.assetId}`);
const eventFor = (services, result) => ({ data: { name: sourcePath("hotel-a", "milk", result.assetId), bucket: services.bucket.name,
  generation: services.bucket.objects.get(sourcePath("hotel-a", "milk", result.assetId)).metadata.generation } });

test("raster variants apply EXIF orientation, strip private metadata and respect display/thumbnail bounds", async () => {
  const variants = await createImageVariants(await fixtureImage(), "image/jpeg");
  const thumb = await sharp(variants.thumbnail.bytes).metadata(), display = await sharp(variants.display.bytes).metadata();
  assert.deepEqual([thumb.width, thumb.height], [80, 160]);
  assert.deepEqual([display.width, display.height], [200, 400]);
  assert.equal(thumb.format, "webp"); assert.equal(display.format, "webp");
  assert.equal(thumb.exif, undefined); assert.equal(display.exif, undefined);
});
test("invalid, mislabeled, oversized, vector and animated formats cannot enter the managed pipeline", async () => {
  const jpeg = await fixtureImage();
  for (const [bytes, mime] of [[Buffer.alloc(0), "image/jpeg"], [Buffer.alloc(MAX_IMAGE_BYTES + 1), "image/png"], [jpeg, "image/png"], [Buffer.from("<svg width='1' height='1'/>"), "image/jpeg"], [Buffer.from("GIF89a"), "image/gif"], [jpeg.subarray(0, 100), "image/jpeg"]]) {
    await assert.rejects(createImageVariants(bytes, mime), (error) => error.code === "invalid-argument");
  }
  const pixels = await sharp({ create: { width: 4001, height: 4000, channels: 3, background: "white" } }).png().toBuffer();
  await assert.rejects(createImageVariants(pixels, "image/png"), /16 megapixels/);
});
test("ordinary licensed buyer uploads a private image without changing product/price history; exact replay is idempotent", async () => {
  const services = fixture(), bytes = await fixtureImage();
  const result = await uploadSupplierProductImage(request(), uploadData(), bytes, services);
  assert.equal(result.status, "ready"); assert.equal(result.imageRevision, 1);
  assert.equal(productOf(services).revision, 99); assert.equal(productOf(services).pricePerPurchaseUnit, 10);
  assert.deepEqual(productOf(services).priceHistory, [{ price: 9 }]);
  assert.equal(services.bucket.objects.size, 3); assert.equal(assetOf(services, result).attempts, 1);
  const replay = await uploadSupplierProductImage(request(), uploadData(), bytes, services);
  assert.deepEqual(replay, result); assert.equal(assetOf(services, result).attempts, 1);
  for (const object of services.bucket.objects.values()) {
    assert.equal(object.metadata.cacheControl, "private, no-store"); assert.equal(object.metadata.metadata.firebaseStorageDownloadTokens, undefined);
  }
  const file = await readSupplierProductImage(request(), { hotelUid: "hotel-a", productId: "milk", assetId: result.assetId, variant: "thumbnail" }, services);
  assert.equal((await sharp(file.bytes).metadata()).format, "webp");
});
test("malformed raster uploads fail explicitly inside one bounded processing attempt and create no derivatives", async () => {
  const services = fixture(), bytes = Buffer.from("<svg width='10' height='10'/>");
  const result = await uploadSupplierProductImage(request(), uploadData(), bytes, services);
  assert.equal(result.status, "failed"); assert.equal(result.error.code, "invalid-image");
  assert.equal(services.bucket.objects.size, 1); assert.equal(productOf(services).image.status, "failed");
  assert.equal(assetOf(services, result).attempts, 1); assert.equal(productOf(services).revision, 99);
  const replay = await uploadSupplierProductImage(request(), uploadData(), bytes, services);
  assert.equal(replay.status, "failed"); assert.equal(assetOf(services, result).attempts, 1);
});
test("changed replay input and stale image revisions fail; older jobs and images cannot replace/read the latest asset", async () => {
  const services = fixture(), bytes = await fixtureImage();
  const first = await uploadSupplierProductImage(request(), uploadData(), bytes, services);
  await assert.rejects(uploadSupplierProductImage(request(), uploadData({ expectedImageRevision: "1" }), bytes, services), (error) => error.code === "already-exists");
  await assert.rejects(uploadSupplierProductImage(request(), uploadData({ requestId: "image-2" }), bytes, services), (error) => error.code === "aborted");
  const second = await uploadSupplierProductImage(request(), uploadData({ requestId: "image-2", expectedImageRevision: "1" }), bytes, services);
  assert.equal(second.imageRevision, 2);
  assert.deepEqual(await processSupplierProductImageHandler(eventFor(services, first), services), { ignored: true });
  await assert.rejects(uploadSupplierProductImage(request(), uploadData(), bytes, services), (error) => error.code === "aborted");
  await assert.rejects(readSupplierProductImage(request(), { hotelUid: "hotel-a", productId: "milk", assetId: first.assetId, variant: "thumbnail" }, services), (error) => error.code === "not-found");
  assert.equal(productOf(services).image.assetId, second.assetId);
});
test("current Auth, membership, permission, rollout and procurement subscription are checked for upload, read and replay", async () => {
  const bytes = await fixtureImage();
  for (const alter of [
    (s) => { s.identity.disabled = true; },
    (s) => { s.identity.emailVerified = false; },
    (s) => { s.identity.tokensValidAfterTime = new Date(9999001).toISOString(); },
    (s) => { s.firestore.records.delete("hotels/hotel-a/members/buyer"); },
    (s) => { s.firestore.records.set("hotels/hotel-a/members/buyer", { permissions: ["supplierproducts.create"] }); },
    (s) => { s.firestore.records.set("hotelSubscriptions/hotel-a", { status: "suspended", modules: ["procurement"], modulePolicyVersion: 1 }); },
    (s) => { s.firestore.records.set("hotelSubscriptions/hotel-a", { status: "active", modules: ["frontoffice"], modulePolicyVersion: 1 }); },
    (s) => { s.firestore.records.set("platformConfiguration/saasProcurement", { enabled: false }); },
  ]) {
    const services = fixture(); alter(services);
    await assert.rejects(uploadSupplierProductImage(request(), uploadData(), bytes, services), (error) => ["permission-denied", "failed-precondition"].includes(error.code));
    assert.equal(services.bucket.objects.size, 0);
  }
  const services = fixture(), saved = await uploadSupplierProductImage(request(), uploadData(), bytes, services);
  await assert.rejects(readSupplierProductImage(request(), { hotelUid: "hotel-b", productId: "milk", assetId: saved.assetId, variant: "thumbnail" }, services), (error) => error.code === "permission-denied");
  services.identity.disabled = true;
  await assert.rejects(uploadSupplierProductImage(request(), uploadData(), bytes, services), (error) => error.code === "permission-denied");
  await assert.rejects(readSupplierProductImage(request(), { hotelUid: "hotel-a", productId: "milk", assetId: saved.assetId, variant: "thumbnail" }, services), (error) => error.code === "permission-denied");
});
test("account revocation during source upload prevents publishing and is rechecked by trigger", async () => {
  const services = fixture(); services.bucket.afterSave = async (path) => { if (path.endsWith("/source")) services.identity.disabled = true; };
  await assert.rejects(uploadSupplierProductImage(request(), uploadData(), await fixtureImage(), services), (error) => error.code === "permission-denied");
  assert.equal(productOf(services).image.status, "pending"); assert.equal(services.bucket.objects.size, 1);
  const result = { assetId: productOf(services).image.assetId };
  assert.equal((await processSupplierProductImageHandler(eventFor(services, result), services)).ignored, true);
  assert.equal(services.bucket.objects.size, 1);
});
test("Storage trigger ignores derivative events, wrong bucket, unknown reservation and mismatched generations", async () => {
  const services = fixture(), saved = await uploadSupplierProductImage(request(), uploadData(), await fixtureImage(), services);
  const event = eventFor(services, saved);
  assert.deepEqual(await processSupplierProductImageHandler({ data: { ...event.data, name: variantPath("hotel-a", "milk", saved.assetId, "thumbnail") } }, services), { ignored: true });
  assert.deepEqual(await processSupplierProductImageHandler({ data: { ...event.data, bucket: "foreign.appspot.com" } }, services), { ignored: true });
  assert.deepEqual(await processSupplierProductImageHandler({ data: { ...event.data, generation: "1" } }, services), { ignored: true });
  assert.deepEqual(await processSupplierProductImageHandler({ data: { ...event.data, name: sourcePath("hotel-a", "milk", "a".repeat(64)) } }, services), { ignored: true });
});
test("read pins object generation, rejects public token metadata and checks authority again after bytes download", async () => {
  const services = fixture(), saved = await uploadSupplierProductImage(request(), uploadData(), await fixtureImage(), services);
  const data = { hotelUid: "hotel-a", productId: "milk", assetId: saved.assetId, variant: "thumbnail" };
  const path = variantPath("hotel-a", "milk", saved.assetId, "thumbnail");
  const object = services.bucket.objects.get(path); object.metadata.metadata.firebaseStorageDownloadTokens = "never-expose";
  await assert.rejects(readSupplierProductImage(request(), data, services), (error) => error.code === "failed-precondition");
  delete object.metadata.metadata.firebaseStorageDownloadTokens;
  const original = services.bucket.file;
  services.bucket.file = (...args) => {
    const file = original(...args); return { ...file, download: async (options) => { const value = await file.download(options); services.identity.disabled = true; return value; } };
  };
  await assert.rejects(readSupplierProductImage(request(), data, services), (error) => error.code === "permission-denied");
});
test("active processing lease deduplicates inline/finalized workers and exhausted attempts become an explicit failure", async () => {
  const services = fixture(), saved = await uploadSupplierProductImage(request(), uploadData(), await fixtureImage(), services);
  const asset = assetOf(services, saved); asset.status = "pending"; asset.attempts = 2; asset.leaseUntil = Date.now() + 180000; asset.leaseId = "busy";
  productOf(services).image = { assetId: saved.assetId, status: "pending" };
  await assert.rejects(processSupplierProductImageHandler(eventFor(services, saved), services), (error) => error.code === "unavailable");
  assert.equal(assetOf(services, saved).attempts, 2);
  asset.leaseUntil = 0; asset.attempts = 3;
  const exhausted = await processSupplierProductImageHandler(eventFor(services, saved), services);
  assert.equal(exhausted.status, "failed"); assert.equal(productOf(services).image.status, "failed");
  assert.equal(assetOf(services, saved).attempts, 3);
});
test("transient derivative processing failure retries with a bounded attempt counter; deterministic invalid bytes are terminal", async () => {
  const services = fixture(), saved = await uploadSupplierProductImage(request(), uploadData(), await fixtureImage(), services);
  const asset = assetOf(services, saved); asset.status = "pending"; asset.attempts = 0;
  productOf(services).image = { assetId: saved.assetId, status: "pending" };
  services.bucket.failDownload = true;
  await assert.rejects(processSupplierProductImageHandler(eventFor(services, saved), services), (error) => error.code === "unavailable");
  assert.equal(assetOf(services, saved).status, "failed"); assert.equal(assetOf(services, saved).attempts, 1);
  const recovered = await processSupplierProductImageHandler(eventFor(services, saved), services);
  assert.equal(recovered.status, "ready"); assert.equal(assetOf(services, saved).attempts, 2);

  const source = services.bucket.objects.get(sourcePath("hotel-a", "milk", saved.assetId));
  source.bytes = Buffer.from("Not a valid JPEG"); source.metadata.size = String(source.bytes.length);
  const hash = require("node:crypto").createHash("sha256").update(source.bytes).digest("hex");
  source.metadata.metadata.sha256 = hash;
  Object.assign(assetOf(services, saved), { status: "pending", attempts: 0, hash, size: source.bytes.length });
  productOf(services).image = { assetId: saved.assetId, status: "pending" };
  const invalid = await processSupplierProductImageHandler(eventFor(services, saved), services);
  assert.equal(invalid.status, "failed"); assert.equal(invalid.error.code, "invalid-image");
  assert.equal(assetOf(services, saved).attempts, 1);
  await processSupplierProductImageHandler(eventFor(services, saved), services);
  assert.equal(assetOf(services, saved).attempts, 1);
});
test("a newer upload during derivative Storage I/O wins; the late worker cannot publish its former asset", async () => {
  const services = fixture(), bytes = await fixtureImage(); let second;
  services.bucket.afterSave = async (path) => {
    if (!second && path.endsWith("/thumbnail.webp")) {
      second = "started";
      second = await uploadSupplierProductImage(request(), uploadData({ requestId: "replacement", expectedImageRevision: "1" }), bytes, services);
    }
  };
  await assert.rejects(uploadSupplierProductImage(request(), uploadData(), bytes, services), (error) => error.code === "aborted");
  assert.equal(second.status, "ready"); assert.equal(productOf(services).image.assetId, second.assetId);
  assert.equal(productOf(services).imageRevision, 2); assert.equal(productOf(services).revision, 99);
});
test("source metadata failure does not steal an acquired finalized-worker lease", async () => {
  const services = fixture(); let release, worker;
  const paused = new Promise((resolve) => { release = resolve; });
  const original = services.bucket.file;
  services.bucket.file = (path, options = {}) => {
    const file = original(path, options);
    return { ...file, getMetadata: async () => {
      if (path.endsWith("/source") && !options.generation) throw Object.assign(new Error("Source metadata temporarily unavailable"), { code: 503 });
      return file.getMetadata();
    }, download: async (params) => { if (path.endsWith("/source")) await paused; return file.download(params); } };
  };
  services.bucket.afterSave = async (path) => {
    if (!path.endsWith("/source")) return;
    const assetId = productOf(services).image.assetId;
    worker = processSupplierProductImageHandler(eventFor(services, { assetId }), services);
    while (!assetOf(services, { assetId }).leaseId) await new Promise(setImmediate);
  };
  const response = await uploadSupplierProductImage(request(), uploadData(), await fixtureImage(), services);
  assert.equal(response.status, "pending"); assert.ok(assetOf(services, response).leaseId);
  release(); const processed = await worker;
  assert.equal(processed.status, "ready"); assert.equal(productOf(services).image.status, "ready");
  assert.equal(assetOf(services, response).attempts, 1);
});
test("archived supplier products reject new image uploads before Storage writes", async () => {
  const services = fixture(); productOf(services).archived = true;
  await assert.rejects(uploadSupplierProductImage(request(), uploadData(), await fixtureImage(), services), (error) => error.code === "failed-precondition");
  assert.equal(services.bucket.objects.size, 0);
});
test("HTTP boundary requires revoked-token verification and binary Content-Type; errors contain no private payload", async () => {
  const services = fixture(); let checkedRevocation = false;
  services.auth.verifyIdToken = async (_, revoked) => { checkedRevocation = revoked; throw new Error("Secret token detail"); };
  const response = { headers: {}, set(name, value) { this.headers[name] = value; }, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; }, send(bytes) { this.bytes = bytes; return this; } };
  await supplierProductImageHandler({ method: "POST", headers: { authorization: "Bearer token", "content-type": "application/octet-stream" }, query: uploadData(), rawBody: await fixtureImage() }, response, services);
  assert.equal(checkedRevocation, true); assert.equal(response.code, 401); assert.equal(response.body.error.code, "unauthenticated");
  assert.equal(JSON.stringify(response.body).includes("Secret"), false); assert.equal(response.headers["Cache-Control"], "private, no-store");
});
