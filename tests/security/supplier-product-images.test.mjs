import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc } from "firebase/firestore";
import { ref, getBytes, getDownloadURL, uploadBytes } from "firebase/storage";

const projectId = "demo-hotel-suite-a00";
for (const key of ["FIRESTORE_EMULATOR_HOST", "FIREBASE_AUTH_EMULATOR_HOST", "FIREBASE_STORAGE_EMULATOR_HOST"]) {
  if (!/^(127\.0\.0\.1|localhost):\d+$/.test(process.env[key] || "")) throw new Error("Only local Auth, Firestore and Storage emulators are allowed.");
}
process.env.FIREBASE_CONFIG = JSON.stringify({ projectId, storageBucket: `${projectId}.appspot.com` });
const require = createRequire(import.meta.url);
const { admin } = require("../../functions/src/config");
const sharp = require("../../functions/node_modules/sharp");
const { compileMemberAccess } = require("../../functions/src/modulePolicy");
const { SAAS_RULES_VERSION } = require("../../functions/src/saasRollout");
const { mutateHotelSupplierProductHandler, importHotelProductsHandler } = require("../../functions/src/products");
const { requireHotelImportTarget } = require("../../functions/src/fileImportTypes");
const {
  uploadSupplierProductImage, readSupplierProductImage, supplierProductImageHandler,
  processSupplierProductImageHandler, sourcePath, variantPath,
} = require("../../functions/src/supplierProductImages");
const { MAX_IMAGE_BYTES } = require("../../functions/src/supplierProductImagesPolicy");
const db = admin.firestore(), auth = admin.auth(), bucket = admin.storage().bucket();
const services = { firestore: db, auth, bucket };
const subscription = { modules: ["procurement"], modulePolicyVersion: 1, status: "active", validUntil: null };
const managerAccess = compileMemberAccess({ hotelAdmin: false, moduleRoles: { procurement: ["module-manager"] } }, subscription);
const identities = Object.fromEntries(["manager", "other-manager", "reader", "hotel-b-manager", "operator"].map((uid) => [uid, {
  uid, token: { email_verified: true, auth_time: Math.floor(Date.now() / 1000), ...(uid === "operator" ? { platformAdmin: true } : {}) },
}]));
const request = (actor = "manager") => ({ auth: identities[actor] });
const rejected = (promise, code) => assert.rejects(promise, (error) => error.code === code);
const productRef = () => db.doc("hotels/hotel-a/supplierproducts/milk-offer");
const offer = (patch = {}) => ({ supplierId: "dairy", supplierSku: "MILK6", supplierProductName: "Milk six pack", currency: "EUR",
  pricingModel: "Per Purchase Unit", pricePerBaseUnit: null, pricePerPurchaseUnit: 12, baseUnit: "l", purchaseUnit: "Case", baseUnitsPerPurchaseUnit: 6,
  catalogProductId: "milk", imageUrl: "", active: true, priceBasis: "net", vatRate: null, purchaseOptions: [], ...patch });
const uploadData = (patch = {}) => ({ hotelUid: "hotel-a", productId: "milk-offer", requestId: "image-upload", expectedImageRevision: 0, mimeType: "image/png", ...patch });
const upload = (patch = {}, actor = "manager", bytes = png, overrides = services) => uploadSupplierProductImage(request(actor), uploadData(patch), bytes, overrides);
const read = (assetId, actor = "manager", patch = {}, overrides = services) => readSupplierProductImage(request(actor), {
  hotelUid: "hotel-a", productId: "milk-offer", assetId, variant: "thumbnail", ...patch,
}, overrides);
let environment, png;
before(async () => {
  environment = await initializeTestEnvironment({ projectId,
    firestore: { host: "127.0.0.1", port: Number(process.env.FIRESTORE_EMULATOR_HOST.split(":").at(-1)), rules: await readFile("firebase/firestore.rules", "utf8") },
    storage: { host: "127.0.0.1", port: Number(process.env.FIREBASE_STORAGE_EMULATOR_HOST.split(":").at(-1)), rules: await readFile("firebase/storage.rules", "utf8") },
  });
  png = await sharp({ create: { width: 1200, height: 900, channels: 3, background: "#c9733d" } }).withMetadata().png().toBuffer();
});
beforeEach(async () => {
  await environment.clearFirestore(); await environment.clearStorage();
  // The Storage Rules test API and Admin GCS API address distinct emulator
  // bucket aliases. Clear this fixture's private Admin objects explicitly.
  await bucket.deleteFiles({ prefix: "private/supplier-product-images/" });
  const users = await auth.listUsers(); if (users.users.length) await auth.deleteUsers(users.users.map((user) => user.uid));
  for (const actor of Object.values(identities)) {
    await auth.createUser({ uid: actor.uid, email: `${actor.uid}@example.test`, password: "Emulator-only-123!", emailVerified: true });
    if (actor.uid === "operator") await auth.setCustomUserClaims(actor.uid, { platformAdmin: true });
    actor.token.auth_time = Math.floor(Date.now() / 1000);
  }
  await db.doc("platformConfiguration/saasProcurement").set({ enabled: true, rulesVersion: SAAS_RULES_VERSION });
  for (const hotel of ["hotel-a", "hotel-b"]) {
    await db.doc(`hotels/${hotel}`).set({ name: hotel, currency: "EUR", timeZone: "Europe/Brussels" });
    await db.doc(`hotelSubscriptions/${hotel}`).set(subscription);
    await db.doc(`hotels/${hotel}/suppliers/dairy`).set({ name: "Dairy supplier" });
    await db.doc(`hotels/${hotel}/catalogproducts/milk`).set({ name: "Milk", baseUnit: "l", active: true, inventoryTracked: true, productPolicyVersion: 1, revision: 1 });
  }
  for (const uid of ["manager", "other-manager"]) await db.doc(`hotels/hotel-a/members/${uid}`).set(managerAccess);
  await db.doc("hotels/hotel-a/members/reader").set({ hotelAdmin: false, permissions: ["supplierproducts.read"] });
  await db.doc("hotels/hotel-b/members/hotel-b-manager").set(managerAccess);
  await mutateHotelSupplierProductHandler({ ...request(), data: { hotelUid: "hotel-a", productId: "milk-offer", action: "create",
    requestId: "create-offer", expectedRevision: 0, product: offer() } }, services);
});
after(async () => environment.cleanup());

describe("private supplier-product image workflow with real hotel identities and decoded bytes", () => {
  it("lets an ordinary module manager upload real PNG bytes and serves bounded, metadata-free WebP variants", async () => {
    assert.equal(managerAccess.permissions.includes("supplierproducts.update"), true);
    const before = (await productRef().get()).data(), histories = (await db.collection("hotels/hotel-a/supplierPriceHistory/milk-offer/entries").get()).docs.map((item) => item.data());
    const historical = { supplierProductId: "milk-offer", currency: "EUR", netUnitCost: 2, quantity: 6, revision: 7, status: "Finalized" };
    for (const path of ["orders/finalized", "stockCounts/finished", "inventoryMovements/receipt"]) await db.doc(`hotels/hotel-a/${path}`).set(historical);
    const result = await upload();
    assert.equal(result.status, "ready"); assert.equal(result.imageRevision, 1);
    const after = (await productRef().get()).data();
    for (const field of ["revision", "updatedAt", "updatedBy", "priceUpdatedOn", "pricePerPurchaseUnit", "catalogProductId"]) assert.deepEqual(after[field], before[field], field);
    assert.deepEqual((await db.collection("hotels/hotel-a/supplierPriceHistory/milk-offer/entries").get()).docs.map((item) => item.data()), histories);
    for (const path of ["orders/finalized", "stockCounts/finished", "inventoryMovements/receipt"]) assert.deepEqual((await db.doc(`hotels/hotel-a/${path}`).get()).data(), historical);
    for (const [variant, width, height] of [["thumbnail", 160, 120], ["display", 800, 600]]) {
      const image = await read(result.assetId, "reader", { variant });
      const metadata = await sharp(image.bytes).metadata();
      assert.equal(metadata.format, "webp"); assert.equal(metadata.width, width); assert.equal(metadata.height, height);
      assert.equal(metadata.exif, undefined); assert.equal(metadata.icc, undefined);
      const [object] = await bucket.file(after.image[variant].path).getMetadata();
      assert.equal(object.contentType, "image/webp"); assert.equal(object.cacheControl, "private, no-store");
      assert.equal(object.metadata.firebaseStorageDownloadTokens, undefined);
    }
    const [source] = await bucket.file(sourcePath("hotel-a", "milk-offer", result.assetId)).getMetadata();
    assert.equal(source.metadata.firebaseStorageDownloadTokens, undefined);
  });

  it("denies reader-only uploads, cross-hotel access and platform administrators without hotel membership", async () => {
    for (const actor of ["reader", "hotel-b-manager", "operator"]) await rejected(upload({}, actor), "permission-denied");
    await rejected(upload({ hotelUid: "hotel-b" }), "permission-denied");
    const result = await upload();
    for (const actor of ["hotel-b-manager", "operator"]) await rejected(read(result.assetId, actor), "permission-denied");
    await rejected(read(result.assetId, "manager", { hotelUid: "hotel-b" }), "permission-denied");
    assert.equal((await db.collection("hotels/hotel-a/supplierProductImages").get()).size, 1);
    assert.equal((await db.collection("hotels/hotel-b/supplierProductImages").get()).size, 0);
  });

  it("keeps source, derivatives, image operation receipts and private asset records unavailable to browser clients", async () => {
    const result = await upload(), product = (await productRef().get()).data();
    const contexts = [environment.authenticatedContext("manager", identities.manager.token),
      environment.authenticatedContext("operator", identities.operator.token), environment.unauthenticatedContext()];
    for (const context of contexts) {
      const storage = context.storage(`gs://${bucket.name}`);
      for (const path of [sourcePath("hotel-a", "milk-offer", result.assetId), product.image.thumbnail.path, product.image.display.path]) {
        await assertFails(getBytes(ref(storage, path)));
        await assertFails(getDownloadURL(ref(storage, path)));
        await assertFails(uploadBytes(ref(storage, path), new Uint8Array([1]), { contentType: "image/png" }));
      }
      for (const path of [`hotels/hotel-a/supplierProductImages/${result.assetId}`, "hotels/hotel-a/supplierProductImageOperations/image-upload"]) {
        await assertFails(getDoc(doc(context.firestore(), path)));
        await assertFails(setDoc(doc(context.firestore(), path), { status: "ready", actorUid: "forged" }));
      }
    }
    const manager = environment.authenticatedContext("manager", identities.manager.token);
    await assertSucceeds(getDoc(doc(manager.firestore(), "hotels/hotel-a/supplierproducts/milk-offer")));
    await assertFails(setDoc(doc(manager.firestore(), "hotels/hotel-a/supplierproducts/milk-offer"), { image: { assetId: "forged", status: "ready" } }, { merge: true }));
    for (const collection of ["supplierProductImages", "supplierProductImageOperations", "supplierproducts"]) {
      assert.throws(() => requireHotelImportTarget(`hotels/hotel-a/${collection}/forged`, "hotel-a"));
    }
  });

  it("preserves independent managed-image state during product edits/imports and rejects forged managed fields", async () => {
    const result = await upload(), imageBefore = (await productRef().get()).data().image;
    await mutateHotelSupplierProductHandler({ ...request(), data: { hotelUid: "hotel-a", productId: "milk-offer", action: "update", requestId: "rename-offer",
      expectedRevision: 1, product: offer({ supplierProductName: "Renamed milk" }) } }, services);
    await importHotelProductsHandler({ ...request(), data: { hotelUid: "hotel-a", collection: "supplierproducts", requestId: "import-offer", onExisting: "overwrite",
      products: [{ productId: "milk-offer", expectedRevision: 2, product: offer() }] } }, services);
    const saved = (await productRef().get()).data(); assert.equal(saved.imageRevision, 1); assert.deepEqual(saved.image, imageBefore);
    assert.equal((await read(result.assetId)).bytes.length > 0, true);
    for (const fields of [{ image: { ...imageBefore, assetId: "forged" } }, { imageRevision: 100 }, { imageSource: "managed" }]) {
      await rejected(mutateHotelSupplierProductHandler({ ...request(), data: { hotelUid: "hotel-a", productId: "milk-offer", action: "update", requestId: `forge-${Object.keys(fields)[0]}`,
        expectedRevision: 3, product: offer(fields) } }, services), "invalid-argument");
      await rejected(importHotelProductsHandler({ ...request(), data: { hotelUid: "hotel-a", collection: "supplierproducts", requestId: `forge-import-${Object.keys(fields)[0]}`,
        onExisting: "overwrite", products: [{ productId: "milk-offer", expectedRevision: 3, product: offer(fields) }] } }, services), "invalid-argument");
    }
    assert.deepEqual((await productRef().get()).data(), saved);
  });

  it("serializes image writers independently of business revisions and ignores superseded source triggers", async () => {
    const original = await upload();
    const secondBytes = await sharp({ create: { width: 1100, height: 700, channels: 3, background: "#436743" } }).png().toBuffer();
    const results = await Promise.allSettled([
      upload({ requestId: "image-race-a", expectedImageRevision: 1 }, "manager", secondBytes),
      upload({ requestId: "image-race-b", expectedImageRevision: 1 }, "other-manager", secondBytes),
    ]);
    assert.equal(results.filter((outcome) => outcome.status === "fulfilled").length, 1);
    assert.equal(results.find((outcome) => outcome.status === "rejected").reason.code, "aborted");
    const current = (await productRef().get()).data(); assert.equal(current.imageRevision, 2); assert.equal(current.revision, 1);
    await rejected(upload(), "aborted");
    await rejected(read(original.assetId), "not-found");
    const path = sourcePath("hotel-a", "milk-offer", original.assetId), [source] = await bucket.file(path).getMetadata();
    assert.deepEqual(await processSupplierProductImageHandler({ data: { name: path, bucket: bucket.name, generation: source.generation } }, services), { ignored: true });
    assert.deepEqual((await productRef().get()).data(), current);
  });

  it("rejects unsafe MIME and byte limits before reservations; decode failures remain explicit and cannot serve images", async () => {
    const before = (await productRef().get()).data();
    for (const [bytes, mimeType] of [[Buffer.from("<svg />"), "image/svg+xml"],
      [Buffer.alloc(0), "image/png"], [Buffer.alloc(MAX_IMAGE_BYTES + 1), "image/png"]]) {
      await rejected(upload({ requestId: "invalid-image", mimeType }, "manager", bytes), "invalid-argument");
    }
    assert.deepEqual((await productRef().get()).data(), before);
    assert.equal((await db.collection("hotels/hotel-a/supplierProductImages").get()).size, 0);
    assert.equal((await db.collection("hotels/hotel-a/supplierProductImageOperations").get()).size, 0);
    const oversizedPixels = await sharp({ create: { width: 4097, height: 4096, channels: 3, background: "#eeeeee" } }).png().toBuffer();
    assert.equal(oversizedPixels.length < MAX_IMAGE_BYTES, true);
    let imageRevision = 0;
    for (const [name, bytes, mimeType] of [["corrupt", Buffer.from("not a PNG"), "image/png"], ["mime-mismatch", png, "image/jpeg"],
      ["too-many-pixels", oversizedPixels, "image/png"]]) {
      const result = await upload({ requestId: name, expectedImageRevision: imageRevision, mimeType }, "manager", bytes);
      imageRevision++;
      assert.equal(result.status, "failed"); assert.equal(result.error.code, "invalid-image"); assert.equal(result.imageRevision, imageRevision);
      const product = (await productRef().get()).data();
      assert.equal(product.image.status, "failed"); assert.equal(product.image.errorCode, "invalid-image");
      assert.equal(product.revision, before.revision); assert.equal(product.pricePerPurchaseUnit, before.pricePerPurchaseUnit);
      await rejected(read(result.assetId), "failed-precondition");
      const asset = (await db.doc(`hotels/hotel-a/supplierProductImages/${result.assetId}`).get()).data();
      assert.equal(asset.status, "failed"); assert.equal(asset.retryable, false); assert.equal(asset.thumbnail, undefined); assert.equal(asset.display, undefined);
      const replay = await upload({ requestId: name, expectedImageRevision: imageRevision - 1, mimeType }, "manager", bytes);
      for (const field of ["assetId", "imageRevision", "status", "error"]) assert.deepEqual(replay[field], result[field], field);
    }
    const [objects] = await bucket.getFiles({ prefix: "private/supplier-product-images/" });
    assert.equal(objects.length, 3); assert.equal(objects.every((object) => object.name.endsWith("/source")), true);
  });

  it("rechecks live Auth, membership, action rights and licensed subscriptions on reads and completed-upload replay", async () => {
    const result = await upload();
    assert.deepEqual(await upload(), result);
    for (const revoke of [
      () => auth.updateUser("manager", { disabled: true }),
      () => auth.updateUser("manager", { emailVerified: false }),
      () => db.doc("hotels/hotel-a/members/manager").update({ permissions: [] }),
      () => db.doc("hotelSubscriptions/hotel-a").update({ modules: [] }),
      () => db.doc("hotelSubscriptions/hotel-a").update({ status: "suspended" }),
      () => db.doc("hotels/hotel-a/members/manager").delete(),
    ]) {
      await revoke();
      await rejected(read(result.assetId), "permission-denied"); await rejected(upload(), "permission-denied");
      await auth.updateUser("manager", { disabled: false, emailVerified: true });
      await db.doc("hotels/hotel-a/members/manager").set(managerAccess); await db.doc("hotelSubscriptions/hotel-a").set(subscription);
    }
    await auth.revokeRefreshTokens("manager");
    const oldSession = { auth: { uid: "manager", token: { email_verified: true, auth_time: Math.floor(Date.now() / 1000) - 120 } } };
    await rejected(readSupplierProductImage(oldSession, { hotelUid: "hotel-a", productId: "milk-offer", assetId: result.assetId, variant: "thumbnail" }, services), "permission-denied");
    await rejected(uploadSupplierProductImage(oldSession, uploadData(), png, services), "permission-denied");
  });

  it("withholds downloaded bytes if access is revoked during real Storage I/O", async () => {
    const result = await upload();
    const revokeOnDownload = { name: bucket.name, file(path, options) {
      const actual = bucket.file(path, options);
      return { getMetadata: (...args) => actual.getMetadata(...args), async download(...args) {
        const response = await actual.download(...args);
        await db.doc("hotels/hotel-a/members/manager").delete();
        return response;
      } };
    } };
    await rejected(read(result.assetId, "manager", {}, { ...services, bucket: revokeOnDownload }), "permission-denied");
  });

  it("accepts the known source trigger idempotently and ignores derivative, unknown-asset and other-bucket events", async () => {
    const result = await upload(), product = (await productRef().get()).data();
    const path = sourcePath("hotel-a", "milk-offer", result.assetId), [metadata] = await bucket.file(path).getMetadata();
    const ready = await processSupplierProductImageHandler({ data: { name: path, bucket: bucket.name, generation: metadata.generation } }, services);
    assert.equal(ready.status, "ready"); assert.equal(ready.assetId, result.assetId);
    for (const data of [{ name: variantPath("hotel-a", "milk-offer", result.assetId, "thumbnail"), bucket: bucket.name, generation: "1" },
      { name: path, bucket: "other-bucket.example", generation: metadata.generation },
      { name: sourcePath("hotel-a", "milk-offer", "f".repeat(64)), bucket: bucket.name, generation: "1" }]) {
      assert.deepEqual(await processSupplierProductImageHandler({ data }, services), { ignored: true });
    }
    assert.deepEqual((await productRef().get()).data(), product);
  });

  it("uses a real Auth-emulator ID token at the exported HTTP handler for binary upload and private image delivery", async () => {
    const login = await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=emulator-only`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "manager@example.test", password: "Emulator-only-123!", returnSecureToken: true }),
    });
    assert.equal(login.status, 200); const { idToken } = await login.json(); assert.equal(typeof idToken, "string");
    const response = () => ({ code: null, headers: {}, body: null,
      set(key, value) { this.headers[key] = value; return this; }, status(code) { this.code = code; return this; },
      json(body) { this.body = body; return this; }, send(body) { this.body = body; return this; },
    });
    const posted = response();
    await supplierProductImageHandler({ method: "POST", headers: { authorization: `Bearer ${idToken}`, "content-type": "application/octet-stream" },
      query: uploadData({ requestId: "http-upload", expectedImageRevision: "0" }), rawBody: png }, posted, services);
    assert.equal(posted.code, 200, JSON.stringify(posted.body)); assert.equal(posted.body.status, "ready");
    const received = response();
    await supplierProductImageHandler({ method: "GET", headers: { authorization: `Bearer ${idToken}` },
      query: { hotelUid: "hotel-a", productId: "milk-offer", assetId: posted.body.assetId, variant: "thumbnail" } }, received, services);
    assert.equal(received.code, 200); assert.equal(received.headers["Cache-Control"], "private, no-store");
    assert.equal(received.headers["X-Content-Type-Options"], "nosniff"); assert.equal(received.headers["Content-Type"], "image/webp");
    assert.equal((await sharp(received.body).metadata()).width, 160);
    const anonymous = response();
    await supplierProductImageHandler({ method: "GET", headers: {}, query: {} }, anonymous, services);
    assert.equal(anonymous.code, 401); assert.equal(anonymous.body.error.code, "unauthenticated");
    await auth.updateUser("manager", { disabled: true });
    const disabled = response();
    await supplierProductImageHandler({ method: "GET", headers: { authorization: `Bearer ${idToken}` },
      query: { hotelUid: "hotel-a", productId: "milk-offer", assetId: posted.body.assetId, variant: "thumbnail" } }, disabled, services);
    assert.equal(disabled.code, 401); assert.equal(disabled.body.error.code, "unauthenticated");
  });
});
