import { before, beforeEach, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { initializeTestEnvironment, assertFails } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, updateDoc, deleteDoc, collection, getDocs } from "firebase/firestore";
import { ref, getBytes, getMetadata, getDownloadURL, uploadBytes, deleteObject, listAll } from "firebase/storage";

for (const key of ["FIRESTORE_EMULATOR_HOST", "FIREBASE_AUTH_EMULATOR_HOST", "FIREBASE_STORAGE_EMULATOR_HOST"]) {
  if (!/^(127\.0\.0\.1|localhost):\d+$/.test(process.env[key] || "")) throw new Error("Only real local Auth, Firestore and Storage emulators are allowed.");
}
const projectId = "demo-hotel-suite-a00";
process.env.FIREBASE_CONFIG = JSON.stringify({ projectId, storageBucket: `${projectId}.appspot.com` });
const require = createRequire(import.meta.url);
const requireFunctions = createRequire(new URL("../../functions/package.json", import.meta.url));
const { Client } = requireFunctions("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = requireFunctions("@modelcontextprotocol/sdk/client/streamableHttp.js");
const { admin } = require("../../functions/src/config");
const sharp = require("../../functions/node_modules/sharp");
const { SAAS_RULES_VERSION } = require("../../functions/src/saasRollout");
const { requireHotelImportTarget } = require("../../functions/src/fileImportTypes");
const { mutateHotelSupplierProductHandler } = require("../../functions/src/products");
const { uploadSupplierProductImage, readSupplierProductImage } = require("../../functions/src/supplierProductImages");
const { createHotelMcpApp } = require("../../functions/src/hotelMcpServer");
const proposals = () => require("../../functions/src/hotelMcpProposals");
const images = () => require("../../functions/src/hotelMcpProposalImages");
const db = admin.firestore(), auth = admin.auth(), bucket = admin.storage().bucket();
const permissions = ["catalogproducts.read", "catalogproducts.create", "catalogproducts.update", "supplierproducts.read", "supplierproducts.create", "supplierproducts.update", "suppliers.read"];
const identities = Object.fromEntries(["owner", "colleague", "reader", "foreign", "operator", "creator"].map((uid) => [uid, {
  uid, token: { email_verified: true, auth_time: Math.floor(Date.now() / 1000), ...(uid === "operator" ? { platformAdmin: true } : {}) },
}]));
const request = (data = {}, actor = "owner", mcp = false) => ({ auth: { ...identities[actor], token: { ...identities[actor].token } }, data,
  ...(mcp ? { mcpAuth: { scopes: ["hotel-toolkit:read", "hotel-toolkit:propose"], assertActive: async () => {} } } : {}) });
const rejected = (promise, code = "permission-denied") => assert.rejects(promise, { code });
let sequence = 0, clock, png, replacementPng, environment, downloads;
const next = () => `proposal-image-security-${++sequence}`;
const services = { firestore: db, auth, bucket, now: () => clock,
  downloadImage: async (url) => { downloads.push(url); return { bytes: png, mimeType: "image/png", sourceUrl: url }; } };
const offer = (patch = {}) => ({ supplierId: "supplier", supplierSku: "EXISTING", supplierProductName: "Existing water case", baseUnit: "l", purchaseUnit: "Case",
  baseUnitsPerPurchaseUnit: 6, pricingModel: "Per Purchase Unit", pricePerPurchaseUnit: 12, currency: "EUR", priceBasis: "net", active: true,
  catalogProductId: "water", ...patch });
const batch = async ({ actor = "owner", update = false, newCatalog = false } = {}) => proposals().stageHotelProductProposalsHandler(request({ hotelUid: "hotel-a", requestId: next(),
  source: { label: "Fictional supplier product image", sourceFormat: "web" }, rows: [{ rowId: "offer", kind: "supplier", action: update ? "update" : "create",
    ...(update ? { productId: "existing", expectedRevision: 1 } : {}), ...(newCatalog ? { catalogRowId: "catalog" } : {}),
    product: update ? { brand: "Reviewed brand" } : offer({ supplierSku: next(), ...(newCatalog ? { catalogProductId: null } : {}) }) },
    ...(newCatalog ? [{ rowId: "catalog", kind: "catalog", action: "create", product: { name: "Image proposal water", baseUnit: "l", active: true, inventoryTracked: true } }] : [])] }, actor), services);
const prepare = (proposal, fields = {}, actor = "owner", overrides = services, mcp = true) => images().prepareHotelMcpProposalImageHandler(request({ hotelUid: "hotel-a", batchId: proposal.batchId,
  rowId: "offer", requestId: next(), imageUrl: "https://supplier-images.example.test/water.png", ...fields }, actor, mcp), overrides);
const getBatch = (proposal, actor = "owner", overrides = services) => proposals().readHotelProductProposalBatchHandler(request({ hotelUid: "hotel-a", batchId: proposal.batchId }, actor), overrides);
const decide = (proposal, image, fields = {}, actor = "owner", overrides = services, mcp = false) => images().decideHotelMcpProposalImageHandler(request({ hotelUid: "hotel-a", batchId: proposal.batchId,
  rowId: "offer", assetId: image.assetId, requestId: next(), expectedBatchRevision: proposal.revision ?? proposal.batchRevision, action: "select", ...fields }, actor, mcp), overrides);
const approve = (proposal, actor = "owner", overrides = services) => proposals().reviewHotelProductProposalsHandler(request({ hotelUid: "hotel-a", batchId: proposal.batchId,
  requestId: next(), expectedRevision: proposal.revision ?? proposal.batchRevision, action: "approve", rowIds: proposal.rows?.map((row) => row.rowId) || ["offer"] }, actor), overrides);
const preview = (proposal, assetId, actor = "owner", fields = {}, overrides = services) => images().readHotelMcpProposalImage(request({}, actor), {
  hotelUid: "hotel-a", batchId: proposal.batchId, rowId: "offer", assetId, variant: "thumbnail", ...fields,
}, overrides);
const snapshot = async (paths) => Object.fromEntries(await Promise.all(paths.map(async (path) => [path, (await db.doc(path).get()).data()])));
async function connectMcp(t) {
  let app, client;
  const http = createServer((incoming, response) => app(incoming, response));
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    try { await client?.close(); }
    finally { await new Promise((resolve) => { http.closeAllConnections(); http.close(resolve); }); }
  });
  const origin = `http://127.0.0.1:${http.address().port}`, redirectUri = "http://127.0.0.1:4321/callback";
  const created = createHotelMcpApp({ db, auth, services, config: { enabled: true, issuerUrl: origin, resourceUrl: `${origin}/mcp`, appUrl: "https://hotel.example.test",
    clients: [{ client_id: "proposal-image-integration", client_name: "Image integration client", redirect_uris: [redirectUri] }] } });
  app = created.app;
  const oauthClient = created.provider.config.clients[0], verifier = "p".repeat(64);
  let consentUrl;
  await created.provider.authorize(oauthClient, { redirectUri, codeChallenge: createHash("sha256").update(verifier).digest("base64url"),
    resource: new URL(`${origin}/mcp`), scopes: ["hotel-toolkit:read", "hotel-toolkit:propose"], state: "image-integration-state" }, { redirect: (url) => { consentUrl = url; } });
  const consent = await created.provider.handlers.completeConsent(request({ requestId: new URL(consentUrl).searchParams.get("requestId"), approve: true }));
  const tokens = await created.provider.exchangeAuthorizationCode(oauthClient, new URL(consent.redirectUrl).searchParams.get("code"), undefined, redirectUri, new URL(`${origin}/mcp`));
  client = new Client({ name: "hotel-toolkit-image-integration", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } } }));
  await client.listTools();
  return async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, JSON.stringify(result.content)); assert.ok(result.structuredContent);
    return result.structuredContent;
  };
}

before(async () => {
  environment = await initializeTestEnvironment({ projectId,
    firestore: { host: "127.0.0.1", port: Number(process.env.FIRESTORE_EMULATOR_HOST.split(":").at(-1)), rules: await readFile("firebase/firestore.rules", "utf8") },
    storage: { host: "127.0.0.1", port: Number(process.env.FIREBASE_STORAGE_EMULATOR_HOST.split(":").at(-1)), rules: await readFile("firebase/storage.rules", "utf8") },
  });
  png = await sharp({ create: { width: 1200, height: 900, channels: 3, background: "#c9733d" } }).withMetadata().png().toBuffer();
  replacementPng = await sharp({ create: { width: 320, height: 240, channels: 3, background: "#235b83" } }).png().toBuffer();
});
beforeEach(async () => {
  clock = Date.now(); downloads = [];
  await environment.clearFirestore(); await environment.clearStorage();
  await bucket.deleteFiles({ prefix: "private/mcp-proposal-images/" });
  await bucket.deleteFiles({ prefix: "private/supplier-product-images/" });
  const users = await auth.listUsers(); if (users.users.length) await auth.deleteUsers(users.users.map((user) => user.uid));
  for (const identity of Object.values(identities)) {
    await auth.createUser({ uid: identity.uid, email: `${identity.uid}@example.test`, emailVerified: true });
    if (identity.uid === "operator") await auth.setCustomUserClaims(identity.uid, { platformAdmin: true });
    identity.token.auth_time = Math.floor(Date.now() / 1000);
  }
  await db.doc("platformConfiguration/saasProcurement").set({ enabled: true, rulesVersion: SAAS_RULES_VERSION });
  for (const hotelUid of ["hotel-a", "hotel-b"]) {
    await db.doc(`hotels/${hotelUid}`).set({ hotelName: hotelUid, currency: "EUR", timeZone: "Europe/Brussels" });
    await db.doc(`hotelSubscriptions/${hotelUid}`).set({ status: "active", validUntil: null, modules: ["procurement"], modulePolicyVersion: 1 });
    await db.doc(`hotels/${hotelUid}/suppliers/supplier`).set({ name: "Fictional supplier", active: true });
    await db.doc(`hotels/${hotelUid}/catalogproducts/water`).set({ name: "Water", baseUnit: "l", active: true, inventoryTracked: true, productPolicyVersion: 1, revision: 1 });
  }
  for (const uid of ["owner", "colleague"]) await db.doc(`hotels/hotel-a/members/${uid}`).set({ permissions });
  await db.doc("hotels/hotel-a/members/reader").set({ permissions: ["supplierproducts.read"] });
  await db.doc("hotels/hotel-b/members/foreign").set({ permissions });
  await db.doc("hotels/hotel-a/members/creator").set({ permissions: permissions.filter((permission) => !permission.endsWith(".update")) });
  await mutateHotelSupplierProductHandler(request({ hotelUid: "hotel-a", requestId: next(), action: "create", productId: "existing", expectedRevision: 0,
    product: offer() }), services);
});
after(async () => environment.cleanup());

describe("private MCP proposal image lifecycle with real Firebase identities and decoded images", () => {
  it("denies direct SDK access to temporary bytes, metadata, operations and download tokens for every role", async () => {
    const objectPath = `private/mcp-proposal-images/${clock + 604800000}/hotel-a/batch/offer/asset/thumbnail.webp`;
    await bucket.file(objectPath).save(Buffer.from("Private image fixture"), { contentType: "image/webp" });
    const paths = ["hotels/hotel-a/hotelMcpProposalImages/asset", "hotels/hotel-a/hotelMcpProposalImageOperations/operation", "hotels/hotel-a/hotelMcpProposalImages/asset/history/1"];
    for (const path of paths) await db.doc(path).set({ ownerUid: "owner", status: "ready", privateObjectPath: objectPath });
    for (const actor of ["owner", "colleague", "reader", "foreign", "operator", null]) {
      const context = actor ? environment.authenticatedContext(actor, identities[actor].token) : environment.unauthenticatedContext();
      const browserStorage = context.storage(`gs://${bucket.name}`), object = ref(browserStorage, objectPath);
      await assertFails(getBytes(object)); await assertFails(getMetadata(object)); await assertFails(getDownloadURL(object));
      await assertFails(uploadBytes(object, new Uint8Array([1]), { contentType: "image/webp" })); await assertFails(deleteObject(object));
      await assertFails(listAll(ref(browserStorage, "private/mcp-proposal-images")));
      for (const path of paths) {
        const record = doc(context.firestore(), path);
        await assertFails(getDoc(record)); await assertFails(setDoc(record, { status: "attached" }));
        await assertFails(updateDoc(record, { ownerUid: actor || "anonymous" })); await assertFails(deleteDoc(record));
      }
      for (const name of ["hotelMcpProposalImages", "hotelMcpProposalImageOperations"]) await assertFails(getDocs(collection(context.firestore(), `hotels/hotel-a/${name}`)));
    }
    for (const name of ["hotelMcpProposalImages", "hotelMcpProposalImageOperations"]) for (const variant of [name, name.toLowerCase(), name.toUpperCase()]) {
      assert.throws(() => requireHotelImportTarget(`hotels/hotel-a/${variant}/asset`, "hotel-a"));
      assert.throws(() => requireHotelImportTarget(`hotels/hotel-a/${variant}/asset/history/1`, "hotel-a"));
    }
  });

  it("prepares metadata-free private WebP previews without selecting an image or activating a product", async () => {
    const proposal = await batch(), before = (await db.collection("hotels/hotel-a/supplierproducts").get()).size;
    const result = await prepare(proposal);
    assert.equal(result.image.status, "ready"); assert.equal(result.image.selection, "unselected");
    assert.equal(result.image.attachment.status, "none"); assert.equal(result.image.currentImage.imageRevision, 0);
    assert.equal((await db.collection("hotels/hotel-a/supplierproducts").get()).size, before);
    assert.equal(downloads.length, 1);
    const publicBatch = await getBatch(proposal);
    for (const value of [result, publicBatch]) {
      const encoded = JSON.stringify(value);
      assert.equal(encoded.includes("private/mcp-proposal-images/"), false);
      assert.equal(encoded.includes("firebaseStorageDownloadTokens"), false);
      assert.equal(encoded.includes("generation"), false);
    }
    const [objects] = await bucket.getFiles({ prefix: "private/mcp-proposal-images/" });
    assert.equal(objects.length, 2);
    for (const object of objects) {
      const [metadata] = await object.getMetadata();
      assert.equal(metadata.contentType, "image/webp"); assert.equal(metadata.cacheControl, "private, no-store");
      assert.equal(metadata.metadata?.firebaseStorageDownloadTokens, undefined);
      const [bytes] = await object.download(); const decoded = await sharp(bytes).metadata();
      assert.equal(decoded.format, "webp"); assert.equal(decoded.exif, undefined); assert.equal(decoded.icc, undefined);
      assert.ok(decoded.width <= (object.name.endsWith("thumbnail.webp") ? 160 : 800));
    }
    const read = await preview(proposal, result.image.assetId); assert.ok(read.bytes.length);
    assert.equal((await sharp(read.bytes).metadata()).format, "webp");
  });

  it("checks the owner, explicit hotel, current permissions and account around proposal-image actions", async () => {
    const proposal = await batch(), result = await prepare(proposal);
    for (const actor of ["colleague", "reader", "foreign", "operator"]) {
      await rejected(prepare(proposal, {}, actor)); await rejected(preview(proposal, result.image.assetId, actor));
    }
    await rejected(prepare(proposal, { hotelUid: "hotel-b" }));
    await rejected(preview(proposal, result.image.assetId, "owner", { hotelUid: "hotel-b" }));
    await rejected(decide(result, result.image, {}, "owner", services, true));
    await rejected(images().readHotelMcpProposalImage(request({}, "owner", true), { hotelUid: "hotel-a", batchId: proposal.batchId, rowId: "offer", assetId: result.image.assetId, variant: "thumbnail" }, services));
    await rejected(images().uploadHotelMcpProposalImage(request({}, "owner", true), { hotelUid: "hotel-a", batchId: proposal.batchId, rowId: "offer", requestId: next(), mimeType: "image/png" }, png, services));
    const readOnlyClient = request({ hotelUid: "hotel-a", batchId: proposal.batchId, rowId: "offer", requestId: next(), imageUrl: "https://supplier-images.example.test/water.png" }, "owner", true);
    readOnlyClient.mcpAuth.scopes = ["hotel-toolkit:read"];
    await rejected(images().prepareHotelMcpProposalImageHandler(readOnlyClient, services));
    await db.doc("hotels/hotel-a/members/owner").update({ permissions: ["supplierproducts.read"] });
    assert.ok((await preview(proposal, result.image.assetId)).bytes.length);
    await rejected(prepare(proposal));
    await db.doc("hotels/hotel-a/members/owner").update({ permissions: [] });
    await rejected(preview(proposal, result.image.assetId));
    await rejected(prepare(proposal));
    await db.doc("hotels/hotel-a/members/owner").update({ permissions });
    await auth.updateUser("owner", { disabled: true });
    await rejected(preview(proposal, result.image.assetId));
  });

  it("prepares an image through the MCP SDK and attaches it only after native approval, preserving historical snapshots", async (t) => {
    const historical = { supplierProductId: "existing", catalogProductId: "water", pricePerPurchaseUnit: 12, quantity: 6, value: 72, currency: "EUR", status: "Finalized" };
    const paths = ["orders/frozen", "stockCounts/frozen", "inventoryMovements/frozen", "inventoryCheckpoints/frozen"].map((path) => `hotels/hotel-a/${path}`);
    for (const path of paths) await db.doc(path).set(historical);
    const before = await snapshot(paths), proposal = await batch({ newCatalog: true }), call = await connectMcp(t);
    const candidate = await call("prepare_supplier_product_proposal_image", { hotelUid: "hotel-a", batchId: proposal.batchId, rowId: "offer", requestId: next(), imageUrl: "https://supplier-images.example.test/water.png" });
    const selected = await decide(candidate, candidate.image, { expectedImageRevision: 0 });
    assert.equal(selected.image.selection, "selected");
    assert.equal((await db.collection("hotels/hotel-a/supplierproducts").get()).size, 1);
    const result = await approve(await getBatch(proposal)); assert.equal(result.summary.applied, 2);
    const productId = result.rows.find((row) => row.kind === "supplier").result.productId;
    const product = (await db.doc(`hotels/hotel-a/supplierproducts/${productId}`).get()).data();
    assert.equal(product.revision, 1); assert.equal(product.imageRevision, 1); assert.equal(product.image.status, "ready");
    assert.equal(product.catalogProductId, result.rows.find((row) => row.kind === "catalog").result.productId);
    const progress = await call("get_product_proposal_batch", { hotelUid: "hotel-a", batchId: proposal.batchId });
    assert.equal(progress.rows.find((row) => row.rowId === "offer").image.attachment.status, "attached");
    assert.ok(product.image.assetId); assert.notEqual(product.image.assetId, candidate.image.assetId);
    const image = await readSupplierProductImage(request(), { hotelUid: "hotel-a", productId, assetId: product.image.assetId, variant: "thumbnail" }, services);
    assert.ok(image.bytes.length); assert.equal((await sharp(image.bytes).metadata()).format, "webp");
    assert.deepEqual(await snapshot(paths), before);
    const afterImage = await snapshot([`hotels/hotel-a/supplierproducts/${productId}`]);
    await images().attachSelectedProposalImages(request(), { hotelUid: "hotel-a", batchId: proposal.batchId, rowIds: ["offer"], selectionSnapshot: [
      { rowId: "offer", assetId: candidate.image.assetId, decisionRevision: selected.image.decisionRevision },
    ] }, services);
    assert.deepEqual(await snapshot(Object.keys(afterImage)), afterImage);
  });

  it("leaves an omitted image out of approval without clearing an existing managed image", async () => {
    const original = await uploadSupplierProductImage(request(), { hotelUid: "hotel-a", productId: "existing", requestId: next(), expectedImageRevision: 0, mimeType: "image/png" }, replacementPng, services);
    const before = (await db.doc("hotels/hotel-a/supplierproducts/existing").get()).data();
    const proposal = await batch({ update: true }), candidate = await prepare(proposal);
    const omitted = await decide(candidate, candidate.image, { action: "omit" }); assert.equal(omitted.image.selection, "omitted");
    const result = await approve(await getBatch(proposal)); assert.equal(result.summary.applied, 1);
    const after = (await db.doc("hotels/hotel-a/supplierproducts/existing").get()).data();
    assert.equal(after.brand, "Reviewed brand"); assert.equal(after.revision, 2);
    assert.equal(after.image.assetId, original.assetId); assert.equal(after.imageRevision, before.imageRevision); assert.deepEqual(after.image, before.image);
  });

  it("keeps a concurrent managed image and still applies product data when the selected replacement loses its image revision", async () => {
    const original = await uploadSupplierProductImage(request(), { hotelUid: "hotel-a", productId: "existing", requestId: next(), expectedImageRevision: 0, mimeType: "image/png" }, png, services);
    const proposal = await batch({ update: true }), candidate = await prepare(proposal);
    await rejected(decide(candidate, candidate.image, { expectedImageRevision: original.imageRevision }), "aborted");
    const selected = await decide(await getBatch(proposal), candidate.image, { replaceExisting: true, expectedImageRevision: original.imageRevision });
    assert.equal(selected.image.selection, "selected");
    const concurrent = await uploadSupplierProductImage(request(), { hotelUid: "hotel-a", productId: "existing", requestId: next(), expectedImageRevision: original.imageRevision, mimeType: "image/png" }, replacementPng, services);
    const before = (await db.doc("hotels/hotel-a/supplierproducts/existing").get()).data();
    const result = await approve(await getBatch(proposal)); assert.equal(result.summary.applied, 1);
    const after = (await db.doc("hotels/hotel-a/supplierproducts/existing").get()).data();
    assert.equal(after.brand, "Reviewed brand"); assert.equal(after.revision, 2); assert.equal(after.image.assetId, concurrent.assetId);
    assert.equal(after.imageRevision, concurrent.imageRevision); assert.deepEqual(after.image, before.image);
  });

  it("does not turn create permission into replacement authority for a previously created product", async () => {
    const proposal = await batch(), candidate = await prepare(proposal);
    await decide(candidate, candidate.image, { expectedImageRevision: 0 });
    const result = await approve(await getBatch(proposal)), productId = result.rows[0].result.productId;
    const current = (await db.doc(`hotels/hotel-a/supplierproducts/${productId}`).get()).data();
    assert.equal(current.imageRevision, 1);
    const replacement = await prepare(proposal, { imageUrl: "https://supplier-images.example.test/replacement.png" });
    await db.doc("hotels/hotel-a/members/owner").update({ permissions: permissions.filter((permission) => permission !== "supplierproducts.update") });
    await rejected(decide(replacement, replacement.image, { replaceExisting: true, expectedImageRevision: 1 }));
    assert.deepEqual((await db.doc(`hotels/hotel-a/supplierproducts/${productId}`).get()).data().image, current.image);
  });

  it("applies valid product data without an expired selected image and rejects expired previews", async () => {
    const proposal = await batch(), candidate = await prepare(proposal);
    await decide(candidate, candidate.image, { expectedImageRevision: 0 });
    clock += 8 * 24 * 60 * 60 * 1000;
    await rejected(preview(proposal, candidate.image.assetId), "not-found");
    const result = await approve(await getBatch(proposal)); assert.equal(result.summary.applied, 1);
    const product = (await db.doc(`hotels/hotel-a/supplierproducts/${result.rows[0].result.productId}`).get()).data();
    assert.equal(product.image, undefined); assert.equal(product.revision, 1);
  });

  it("allows a creator's first image while reserving later replacements for update permission", async () => {
    const proposal = await batch({ actor: "creator" }), candidate = await prepare(proposal, {}, "creator");
    await decide(candidate, candidate.image, { expectedImageRevision: 0 }, "creator");
    const result = await approve(await getBatch(proposal, "creator"), "creator"); assert.equal(result.summary.applied, 1);
    const product = (await db.doc(`hotels/hotel-a/supplierproducts/${result.rows[0].result.productId}`).get()).data();
    assert.equal(product.image.status, "ready"); assert.equal(product.imageRevision, 1); assert.equal(product.revision, 1);
  });

  it("reuses a prepared request safely and rejects a changed URL or revoked action on replay", async () => {
    const proposal = await batch(), requestId = next();
    const first = await prepare(proposal, { requestId });
    const replay = await prepare(proposal, { requestId });
    assert.deepEqual(replay, first); assert.equal(downloads.length, 1);
    await rejected(prepare(proposal, { requestId, imageUrl: "https://supplier-images.example.test/different.png" }), "already-exists");
    await db.doc("hotels/hotel-a/members/owner").update({ permissions: ["supplierproducts.read"] });
    await rejected(prepare(proposal, { requestId }));
    assert.equal(downloads.length, 1);
  });

  it("does not finish preparation or expose source credentials when access changes or a download fails", async () => {
    const proposal = await batch();
    await rejected(prepare(proposal, {}, "owner", { ...services, downloadImage: async (url) => {
      await db.doc("hotels/hotel-a/members/owner").update({ permissions: [] });
      return { bytes: png, mimeType: "image/png", sourceUrl: url };
    } }));
    assert.equal((await db.collection("hotels/hotel-a/supplierproducts").get()).size, 1);
    await db.doc("hotels/hotel-a/members/owner").update({ permissions });
    const marker = "private-source-query-token";
    const failed = await prepare(proposal, { imageUrl: `https://supplier-images.example.test/failure.png?token=${marker}` }, "owner", {
      ...services, downloadImage: async () => { throw new Error(`Private supplier failure ${marker}`); },
    });
    assert.equal(failed.image.status, "failed");
    assert.equal(JSON.stringify(failed).includes(marker), false);
    assert.equal(failed.image.sourceUrl, "https://supplier-images.example.test/failure.png");
    const rejectedImage = await prepare(proposal, { imageUrl: "https://supplier-images.example.test/invalid.png" }, "owner", {
      ...services, downloadImage: async (url) => ({ bytes: Buffer.from("<svg><script>untrusted</script></svg>"), mimeType: "image/png", sourceUrl: url }),
    });
    assert.equal(rejectedImage.image.status, "failed"); assert.equal(rejectedImage.image.error.code, "invalid-image");
  });

  it("cleans expired temporary derivatives while preserving newer candidates and once-attached managed images", async () => {
    const firstProposal = await batch(), first = await prepare(firstProposal);
    await decide(first, first.image, { expectedImageRevision: 0 });
    const approved = await approve(await getBatch(firstProposal)), productId = approved.rows[0].result.productId;
    const managed = (await db.doc(`hotels/hotel-a/supplierproducts/${productId}`).get()).data().image;
    const superseding = await uploadSupplierProductImage(request(), { hotelUid: "hotel-a", productId, requestId: next(), expectedImageRevision: 1, mimeType: "image/png" }, replacementPng, services);
    await db.doc("hotels/hotel-a/orders/historical-image").set({ productId, image: managed, status: "Finalized" });
    clock += 2 * 24 * 60 * 60 * 1000;
    const newerProposal = await batch(), newer = await prepare(newerProposal);
    clock += 6 * 24 * 60 * 60 * 1000;
    const cleanup = await images().cleanupHotelMcpProposalImagesHandler({}, services);
    assert.ok(cleanup.deleted >= 2); assert.equal(cleanup.failed, 0);
    const [temporary] = await bucket.getFiles({ prefix: "private/mcp-proposal-images/" });
    assert.equal(temporary.some((file) => file.name.includes(first.image.assetId)), false);
    assert.equal(temporary.filter((file) => file.name.includes(newer.image.assetId)).length, 2);
    const read = await readSupplierProductImage(request(), { hotelUid: "hotel-a", productId, assetId: superseding.assetId, variant: "thumbnail" }, services);
    assert.ok(read.bytes.length);
    const [historicBytes] = await bucket.file(managed.thumbnail.path, { generation: managed.thumbnail.generation }).download();
    assert.ok(historicBytes.length); assert.equal((await sharp(historicBytes).metadata()).format, "webp");
    assert.deepEqual((await db.doc("hotels/hotel-a/orders/historical-image").get()).data().image, managed);
    assert.ok((await preview(newerProposal, newer.image.assetId)).bytes.length);
    assert.equal((await db.doc(`hotels/hotel-a/supplierproducts/${productId}`).get()).data().image.assetId, superseding.assetId);
  });

  it("cleans never-published managed copies after a CAS race without deleting the concurrent live image", async () => {
    const original = await uploadSupplierProductImage(request(), { hotelUid: "hotel-a", productId: "existing", requestId: next(), expectedImageRevision: 0, mimeType: "image/png" }, png, services);
    const proposal = await batch({ update: true }), candidate = await prepare(proposal);
    await decide(candidate, candidate.image, { replaceExisting: true, expectedImageRevision: original.imageRevision });
    let concurrent;
    const racingBucket = { file: (path, options) => {
      const file = bucket.file(path, options), save = file.save.bind(file);
      file.save = async (...args) => {
        const result = await save(...args);
        if (!concurrent && path.startsWith("private/supplier-product-images/") && path.endsWith("thumbnail.webp")) {
          concurrent = await uploadSupplierProductImage(request(), { hotelUid: "hotel-a", productId: "existing", requestId: next(), expectedImageRevision: original.imageRevision, mimeType: "image/png" }, replacementPng, services);
        }
        return result;
      };
      return file;
    } };
    const result = await approve(await getBatch(proposal), "owner", { ...services, bucket: racingBucket });
    assert.equal(result.summary.applied, 1); assert.ok(concurrent);
    const asset = (await db.doc(`hotels/hotel-a/hotelMcpProposalImages/${candidate.image.assetId}`).get()).data();
    assert.equal(asset.attachment.status, "failed"); assert.equal(asset.attachment.error.code, "image-conflict");
    const unpublished = Object.keys(asset.managedCandidates); assert.equal(unpublished.length, 1);
    const [before] = await bucket.getFiles({ prefix: "private/supplier-product-images/" });
    assert.equal(before.filter((file) => file.name.includes(unpublished[0])).length, 2);
    clock += 8 * 24 * 60 * 60 * 1000;
    const cleanup = await images().cleanupHotelMcpProposalImagesHandler({}, services); assert.equal(cleanup.failed, 0);
    const [after] = await bucket.getFiles({ prefix: "private/supplier-product-images/" });
    assert.equal(after.some((file) => file.name.includes(unpublished[0])), false);
    const current = (await db.doc("hotels/hotel-a/supplierproducts/existing").get()).data();
    assert.equal(current.image.assetId, concurrent.assetId); assert.equal(current.revision, 2);
    assert.ok((await readSupplierProductImage(request(), { hotelUid: "hotel-a", productId: "existing", assetId: concurrent.assetId, variant: "thumbnail" }, services)).bytes.length);
  });

  it("sends generation guards through the installed SDK and preserves an object when the provider rejects cleanup", async () => {
    const proposal = await batch(), candidate = await prepare(proposal);
    const asset = (await db.doc(`hotels/hotel-a/hotelMcpProposalImages/${candidate.image.assetId}`).get()).data(), target = asset.variants.thumbnail.path;
    clock += 8 * 24 * 60 * 60 * 1000;
    let replaced = false;
    const guards = [];
    const racingBucket = { getFiles: (...args) => bucket.getFiles(...args), file: (path, options) => {
      const file = bucket.file(path, options), get = file.getMetadata.bind(file), send = file.request_.bind(file);
      file.getMetadata = async (...args) => {
        const result = await get(...args);
        if (!replaced && path === target && !options?.generation) {
          replaced = true;
          await bucket.file(path).save(replacementPng, { resumable: false, metadata: { contentType: "image/png", cacheControl: "private, no-store" } });
        }
        return result;
      };
      // The installed Storage emulator ignores generation parameters on its
      // GCS DELETE route. Capture the real SDK request and simulate GCS's 412
      // response at the transport boundary; all objects and overwrites are real.
      file.request_ = (query, callback) => {
        if (path === target && query.method === "DELETE") {
          guards.push({ generation: query.qs?.generation, ifGenerationMatch: query.qs?.ifGenerationMatch });
          callback(Object.assign(new Error("Generation precondition did not match"), { code: 412 }));
          return;
        }
        return send(query, callback);
      };
      return file;
    } };
    const result = await images().cleanupHotelMcpProposalImagesHandler({}, { ...services, bucket: racingBucket }); assert.equal(replaced, true);
    assert.equal(result.failed, 1);
    assert.deepEqual(guards, [{ generation: Number(asset.variants.thumbnail.generation), ifGenerationMatch: asset.variants.thumbnail.generation }]);
    const [bytes] = await bucket.file(target).download(); assert.deepEqual(bytes, replacementPng);
  });
});
