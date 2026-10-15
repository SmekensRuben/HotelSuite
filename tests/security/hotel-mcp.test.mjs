import { before, beforeEach, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { initializeTestEnvironment, assertFails } from "@firebase/rules-unit-testing";
import { collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc } from "firebase/firestore";

for (const key of ["FIRESTORE_EMULATOR_HOST", "FIREBASE_AUTH_EMULATOR_HOST"]) {
  if (!/^(127\.0\.0\.1|localhost):\d+$/.test(process.env[key] || "")) throw new Error("Real local Auth and Firestore emulators are required.");
}
const projectId = "demo-hotel-suite-a00";
process.env.FIREBASE_CONFIG = JSON.stringify({ projectId, storageBucket: `${projectId}.appspot.com` });
const require = createRequire(import.meta.url);
const requireFunctions = createRequire(new URL("../../functions/package.json", import.meta.url));
const { Client } = requireFunctions("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = requireFunctions("@modelcontextprotocol/sdk/client/streamableHttp.js");
const { admin } = require("../../functions/src/config");
const { SAAS_RULES_VERSION } = require("../../functions/src/saasRollout");
const { requireHotelImportTarget } = require("../../functions/src/fileImportTypes");
const access = require("../../functions/src/hotelMcpAccess");
const reads = require("../../functions/src/hotelMcpReads");
const proposals = () => require("../../functions/src/hotelMcpProposals");
const { createHotelMcpOAuthProvider } = require("../../functions/src/hotelMcpAuth");
const { createHotelMcpApp } = require("../../functions/src/hotelMcpServer");
const db = admin.firestore(), auth = admin.auth();
const services = { firestore: db, auth, appBaseUrl: "https://hotel.example.test", now: () => Date.parse("2026-10-15T10:00:00Z") };
const permissions = ["catalogproducts.read", "catalogproducts.create", "catalogproducts.update", "supplierproducts.read", "supplierproducts.create", "supplierproducts.update", "suppliers.read", "catalogsettings.read"];
const identities = Object.fromEntries(["buyer", "colleague", "foreign", "platform", "limited"].map((uid) => [uid, {
  uid, token: { email: `${uid}@example.test`, email_verified: true, auth_time: 1, ...(uid === "platform" ? { platformAdmin: true } : {}) },
}]));
const request = (data = {}, actor = "buyer", scopes) => ({ auth: { ...identities[actor], token: { ...identities[actor].token } }, data,
  ...(scopes ? { mcpAuth: { scopes, assertActive: async () => {} } } : {}) });
const rejected = (promise, code = "permission-denied") => assert.rejects(promise, { code });
const catalog = (name) => ({ name, baseUnit: "l", active: true, inventoryTracked: true, revision: 1,
  productPolicyVersion: 1, category: "Beverages", subcategory: "Water", privateCredential: "must-not-leak" });
let environment;
let sequence = 0;
const next = () => `mcp-security-${++sequence}`;
const source = (patch = {}) => ({ label: "Fictional supplier list", documentDate: "2026-10-15", sourceFormat: "text", ...patch });
const supplierFields = (patch = {}) => ({ supplierId: "supplier", supplierSku: "NEW-1", supplierProductName: "New water case", baseUnit: "l", purchaseUnit: "Case",
  baseUnitsPerPurchaseUnit: 6, pricingModel: "Per Purchase Unit", pricePerPurchaseUnit: 12, priceBasis: "net", currency: "EUR", active: true, ...patch });
const stage = (rows, extra = {}, actor = "buyer") => proposals().stageHotelProductProposalsHandler(request({ hotelUid: "hotel-a", requestId: next(), source: source(), rows, ...extra }, actor), services);
const review = (batch, extra = {}, actor = "buyer", overrides = {}) => proposals().reviewHotelProductProposalsHandler(request({ hotelUid: "hotel-a", batchId: batch.batchId,
  requestId: next(), expectedRevision: batch.revision, action: "approve", ...extra }, actor), { ...services, ...overrides });
const getBatch = (batch, actor = "buyer") => proposals().readHotelProductProposalBatchHandler(request({ hotelUid: "hotel-a", batchId: batch.batchId }, actor), services);
const evidence = async (paths) => Object.fromEntries(await Promise.all(paths.map(async (path) => [path, (await db.doc(path).get()).data()])));
const oauthConfig = { enabled: true, issuerUrl: "https://mcp.example.test", resourceUrl: "https://mcp.example.test/mcp", appUrl: "https://hotel.example.test",
  clients: [{ client_id: "private-test", client_name: "Private test client", redirect_uris: ["http://127.0.0.1:4321/callback"] }] };
const makeOAuth = () => createHotelMcpOAuthProvider({ db, auth, config: oauthConfig, now: services.now });
async function oauthCode(provider, actor = "buyer", approve = true) {
  let destination;
  const client = provider.config.clients[0], verifier = "v".repeat(64);
  await provider.authorize(client, { redirectUri: client.redirect_uris[0], codeChallenge: createHash("sha256").update(verifier).digest("base64url"),
    state: "private-state", scopes: [access.READ_SCOPE, access.PROPOSE_SCOPE], resource: new URL(oauthConfig.resourceUrl) }, { redirect: (url) => { destination = url; } });
  const requestId = new URL(destination).searchParams.get("requestId");
  const decision = await provider.handlers.completeConsent(request({ requestId, approve }, actor));
  return { code: new URL(decision.redirectUrl).searchParams.get("code"), requestId, redirectUrl: decision.redirectUrl };
}
async function oauthGrant(provider, actor = "buyer") {
  const { code } = await oauthCode(provider, actor), client = provider.config.clients[0];
  return provider.exchangeAuthorizationCode(client, code, undefined, client.redirect_uris[0], new URL(oauthConfig.resourceUrl));
}

before(async () => {
  environment = await initializeTestEnvironment({ projectId, firestore: {
    host: "127.0.0.1", port: Number(process.env.FIRESTORE_EMULATOR_HOST.split(":").at(-1)),
    rules: await readFile("firebase/firestore.rules", "utf8"),
  } });
});
beforeEach(async () => {
  await environment.clearFirestore();
  const users = await auth.listUsers();
  if (users.users.length) await auth.deleteUsers(users.users.map((user) => user.uid));
  for (const identity of Object.values(identities)) {
    await auth.createUser({ uid: identity.uid, email: identity.token.email, emailVerified: true });
    if (identity.uid === "platform") await auth.setCustomUserClaims(identity.uid, { platformAdmin: true });
    await db.doc(`users/${identity.uid}`).set({ hotelUid: ["hotel-a", "hotel-b"] });
  }
  await db.doc("platformConfiguration/saasProcurement").set({ enabled: true, rulesVersion: SAAS_RULES_VERSION });
  for (const hotelUid of ["hotel-a", "hotel-b"]) {
    await db.doc(`hotels/${hotelUid}`).set({ hotelName: `Private ${hotelUid}`, currency: "EUR", timeZone: "Europe/Brussels", credentials: "never disclose" });
    await db.doc(`hotelSubscriptions/${hotelUid}`).set({ status: "active", validUntil: null, modules: ["procurement"], modulePolicyVersion: 1 });
    await db.doc(`hotels/${hotelUid}/catalogproducts/water`).set(catalog(`${hotelUid} water`));
    await db.doc(`hotels/${hotelUid}/suppliers/supplier`).set({ name: `${hotelUid} supplier`, active: true, priceDateBasis: "delivery-date",
      password: "supplier-password", credentials: { token: "supplier-token" }, orderEmail: "private@example.test", notes: "Private supplier notes" });
    await db.doc(`hotels/${hotelUid}/supplierproducts/water-offer`).set({ supplierId: "supplier", supplierSku: "WATER-1", supplierProductName: `${hotelUid} case`,
      catalogProductId: "water", baseUnit: "l", purchaseUnit: "Case", baseUnitsPerPurchaseUnit: 6,
      pricePerPurchaseUnit: 12, currency: "EUR", priceBasis: "net", vatRate: null, pricingModel: "Per Purchase Unit",
      purchaseOptions: [], revision: 1, active: true, credentials: { token: "private-product-token" }, image: { originalPath: "private-image-path" } });
    await db.doc(`hotels/${hotelUid}/settings/catalog/categories/beverages`).set({ name: "Beverages" });
    await db.doc(`hotels/${hotelUid}/settings/catalog/subcategories/water`).set({ name: "Water", categoryId: "beverages" });
  }
  await db.doc("hotels/hotel-a/catalogproducts/second").set(catalog("Second water"));
  for (const actor of ["buyer", "colleague"]) await db.doc(`hotels/hotel-a/members/${actor}`).set({ permissions });
  await db.doc("hotels/hotel-b/members/foreign").set({ permissions });
  await db.doc("hotels/hotel-a/members/limited").set({ permissions: ["supplierproducts.read"] });
});
after(async () => environment.cleanup());

describe("Hotel Toolkit MCP with real identity and tenant boundaries", () => {
  it("discovers only current operational memberships without a platform administrator bypass", async () => {
    const result = await access.discoverMcpHotelsHandler(request(), services);
    assert.deepEqual(result.hotels.map((hotel) => hotel.hotelUid), ["hotel-a"]);
    assert.equal(result.requiresExplicitHotel, true);
    assert.deepEqual((await access.discoverMcpHotelsHandler(request({}, "platform"), services)).hotels, []);
    assert.equal(JSON.stringify(result).includes("never disclose"), false);
    await db.doc("hotels/hotel-a/members/buyer").delete();
    assert.deepEqual((await access.discoverMcpHotelsHandler(request(), services)).hotels, []);
    await rejected(access.discoverMcpHotelsHandler(request({ uid: "foreign" }), services), "invalid-argument");
  });

  it("denies product reads for another hotel, platform claims and missing action permissions", async () => {
    const data = { hotelUid: "hotel-a", productId: "water" };
    for (const actor of ["foreign", "platform", "limited"]) await rejected(reads.getMcpProductHandler(request(data, actor), services, "catalog"));
    await rejected(reads.getMcpProductHandler(request({ ...data, hotelUid: "hotel-b" }), services, "catalog"));
    await rejected(reads.getMcpProductHandler(request({ productId: "water" }), services, "catalog"), "invalid-argument");
    await rejected(reads.getMcpProductHandler(request({ ...data, uid: "foreign" }), services, "catalog"), "invalid-argument");
  });

  it("rechecks current permissions, subscription and module after a previous successful read", async () => {
    const data = { hotelUid: "hotel-a", productId: "water" };
    await reads.getMcpProductHandler(request(data), services, "catalog");
    await db.doc("hotels/hotel-a/members/buyer").update({ permissions: [] });
    await rejected(reads.getMcpProductHandler(request(data), services, "catalog"));
    await db.doc("hotels/hotel-a/members/buyer").update({ permissions });
    await db.doc("hotelSubscriptions/hotel-a").update({ modules: [] });
    await rejected(reads.getMcpProductHandler(request(data), services, "catalog"));
    await db.doc("hotelSubscriptions/hotel-a").update({ modules: ["procurement"], status: "suspended" });
    await rejected(reads.getMcpProductHandler(request(data), services, "catalog"));
  });

  it("rejects disabled, deleted, unverified and revoked Firebase identities on later calls", async () => {
    const data = { hotelUid: "hotel-a", productId: "water" };
    await reads.getMcpProductHandler(request(data), services, "catalog");
    await auth.updateUser("buyer", { disabled: true });
    await rejected(reads.getMcpProductHandler(request(data), services, "catalog"));
    await auth.updateUser("buyer", { disabled: false, emailVerified: false });
    await rejected(reads.getMcpProductHandler(request(data), services, "catalog"));
    await auth.updateUser("buyer", { emailVerified: true });
    await auth.revokeRefreshTokens("buyer");
    await rejected(reads.getMcpProductHandler(request(data), services, "catalog"));
    await auth.deleteUser("buyer");
    await rejected(reads.getMcpProductHandler(request(data), services, "catalog"));
  });

  it("enforces personal consent scopes and an actively checked connection", async () => {
    const data = { hotelUid: "hotel-a", productId: "water" };
    await rejected(reads.getMcpProductHandler(request(data, "buyer", [access.PROPOSE_SCOPE]), services, "catalog"));
    const revoked = request(data, "buyer", [access.READ_SCOPE]);
    revoked.mcpAuth.assertActive = async () => { const error = new Error("Connection revoked"); error.code = "permission-denied"; throw error; };
    await rejected(reads.getMcpProductHandler(revoked, services, "catalog"));
    const approved = await reads.getMcpProductHandler(request(data, "buyer", [access.READ_SCOPE]), services, "catalog");
    assert.equal(approved.product.name, "hotel-a water");
  });

  it("binds listing cursors to the current user, hotel, product kind and filters", async () => {
    const first = await reads.listMcpProductsHandler(request({ hotelUid: "hotel-a", pageSize: 1 }), services, "catalog");
    assert.ok(first.nextCursor);
    await rejected(reads.listMcpProductsHandler(request({ hotelUid: "hotel-a", cursor: first.nextCursor }, "colleague"), services, "catalog"), "invalid-argument");
    await rejected(reads.listMcpProductsHandler(request({ hotelUid: "hotel-a", category: "Beverages", cursor: first.nextCursor }), services, "catalog"), "invalid-argument");
    await rejected(reads.listMcpProductsHandler(request({ hotelUid: "hotel-a", cursor: first.nextCursor }), services, "supplier"), "invalid-argument");
    const second = await reads.listMcpProductsHandler(request({ hotelUid: "hotel-a", pageSize: 1, cursor: first.nextCursor }), services, "catalog");
    assert.notEqual(second.products[0].id, first.products[0].id);
  });

  it("returns canonical hotel documents from hostile and stale search hits", async () => {
    const result = await reads.searchMcpProductsHandler(request({ hotelUid: "hotel-a", query: "water" }), { ...services,
      search: async (body) => {
        assert.ok(body.filter.includes('hotelUid = "hotel-a"'));
        return { hits: [{ hotelUid: "hotel-b", documentId: "water", name: "Foreign secret" },
          { hotelUid: "hotel-a", documentId: "water", name: "Forged index payload", credentials: "index-secret" },
          { hotelUid: "hotel-a", documentId: "../../hotel-b" }, { hotelUid: "hotel-a", documentId: "missing" }], estimatedTotalHits: 4 };
      },
    }, "catalog");
    assert.deepEqual(result.products.map((product) => product.name), ["hotel-a water"]);
    assert.equal(JSON.stringify(result).includes("secret"), false);
    assert.equal(JSON.stringify(result).includes("must-not-leak"), false);
  });

  it("exposes only minimal product and supplier reference fields with the matching read permission", async () => {
    const supplier = await reads.getMcpProductHandler(request({ hotelUid: "hotel-a", productId: "water-offer" }), services, "supplier");
    assert.equal(supplier.product.pricePerPurchaseUnit, 12);
    assert.equal(supplier.product.credentials, undefined);
    assert.equal(supplier.product.image, undefined);
    const references = await reads.listMcpProductReferencesHandler(request({ hotelUid: "hotel-a", kind: "suppliers" }), services);
    assert.deepEqual(references.references, [{ id: "supplier", name: "hotel-a supplier", active: true, archived: false, priceDateBasis: "delivery-date" }]);
    await rejected(reads.listMcpProductReferencesHandler(request({ hotelUid: "hotel-a", kind: "suppliers" }, "limited"), services));
    await rejected(reads.listMcpProductReferencesHandler(request({ hotelUid: "hotel-a", kind: "categories" }, "limited"), services));
    const categories = await reads.listMcpProductReferencesHandler(request({ hotelUid: "hotel-a", kind: "categories" }), services);
    assert.deepEqual(categories.references, [{ id: "beverages", name: "Beverages" }]);
    const subcategories = await reads.listMcpProductReferencesHandler(request({ hotelUid: "hotel-a", kind: "subcategories", categoryId: "beverages" }), services);
    assert.deepEqual(subcategories.references, [{ id: "water", name: "Water", categoryId: "beverages" }]);
  });
});

describe("private MCP product proposals with real Firestore transactions", () => {
  it("keeps OAuth secrets, proposal state and operation receipts unavailable to direct clients and generic imports", async () => {
    const hotelCollections = ["hotelMcpProposalBatches", "hotelMcpProposalOperations", "hotelMcpProposalAudit"];
    const rootCollections = ["hotelMcpOAuthAuthorizations", "hotelMcpOAuthCodes", "hotelMcpOAuthTokens", "hotelMcpOAuthConnections"];
    const paths = [...hotelCollections.map((name) => `hotels/hotel-a/${name}/record`),
      "hotels/hotel-a/hotelMcpProposalBatches/record/rows/row", ...rootCollections.map((name) => `${name}/record`)];
    for (const path of paths) await db.doc(path).set({ ownerUid: "buyer", secret: "private", status: "approved" });
    for (const actor of ["buyer", "foreign", "platform", null]) {
      const browser = actor ? environment.authenticatedContext(actor, identities[actor].token).firestore() : environment.unauthenticatedContext().firestore();
      for (const path of paths) {
        const reference = doc(browser, path);
        await assertFails(getDoc(reference)); await assertFails(setDoc(reference, { status: "approved" }));
        await assertFails(updateDoc(reference, { ownerUid: actor || "anonymous" })); await assertFails(deleteDoc(reference));
      }
      for (const name of hotelCollections) await assertFails(getDocs(collection(browser, `hotels/hotel-a/${name}`)));
      for (const name of rootCollections) await assertFails(getDocs(collection(browser, name)));
    }
    for (const name of [...hotelCollections, ...rootCollections]) {
      for (const variant of [name, name.toLowerCase(), name.toUpperCase()]) {
        assert.throws(() => requireHotelImportTarget(`hotels/hotel-a/${variant}/record`, "hotel-a"));
        assert.throws(() => requireHotelImportTarget(`hotels/hotel-a/${variant}/record/rows/row`, "hotel-a"));
      }
      assert.throws(() => requireHotelImportTarget(`hotels/hotel-b/${name}/record`, "hotel-a"));
    }
  });

  it("stages private proposals without publishing and isolates batches from another user and hotel", async () => {
    const initial = (await db.collection("hotels/hotel-a/catalogproducts").get()).size;
    const batch = await stage([{ rowId: "catalog", kind: "catalog", action: "create", product: { name: "Still water", baseUnit: "l", active: true, inventoryTracked: true } }]);
    assert.equal((await db.collection("hotels/hotel-a/catalogproducts").get()).size, initial);
    assert.equal(batch.requesterUid, "buyer");
    await rejected(getBatch(batch, "colleague"));
    await rejected(getBatch(batch, "foreign"));
    await rejected(getBatch(batch, "platform"));
    await rejected(proposals().readHotelProductProposalBatchHandler(request({ hotelUid: "hotel-b", batchId: batch.batchId }), services));
    const own = await proposals().listHotelProductProposalBatchesHandler(request({ hotelUid: "hotel-a" }), services);
    const other = await proposals().listHotelProductProposalBatchesHandler(request({ hotelUid: "hotel-a" }, "colleague"), services);
    assert.equal(own.batches.length, 1); assert.equal(other.batches.length, 0);
    const ai = request({ hotelUid: "hotel-a", batchId: batch.batchId, requestId: next(), expectedRevision: batch.revision, action: "approve" }, "buyer", [access.READ_SCOPE, access.PROPOSE_SCOPE]);
    await rejected(proposals().reviewHotelProductProposalsHandler(ai, services));
    assert.equal((await db.collection("hotels/hotel-a/catalogproducts").get()).size, initial);
  });

  it("resolves a new catalog identity before multiple supplier offers and safely replays the entire approval", async () => {
    const initial = (await db.collection("hotels/hotel-a/catalogproducts").get()).size;
    const input = { hotelUid: "hotel-a", requestId: next(), source: source(), rows: [
      { rowId: "offer-one", kind: "supplier", action: "create", catalogRowId: "catalog", product: supplierFields({ supplierSku: "FIRST" }) },
      { rowId: "catalog", kind: "catalog", action: "create", product: { name: "Still water", baseUnit: "l", active: true, inventoryTracked: true, category: "Beverages", subcategory: "Water" } },
      { rowId: "offer-two", kind: "supplier", action: "create", catalogRowId: "catalog", product: supplierFields({ supplierSku: "SECOND", purchaseUnit: "Bottle", baseUnitsPerPurchaseUnit: 1, pricePerPurchaseUnit: 2 }) },
    ] };
    const batch = await proposals().stageHotelProductProposalsHandler(request(input), services);
    assert.deepEqual(await proposals().stageHotelProductProposalsHandler(request(input), services), batch);
    const approval = { hotelUid: "hotel-a", batchId: batch.batchId, requestId: next(), expectedRevision: batch.revision, action: "approve" };
    const applied = await proposals().reviewHotelProductProposalsHandler(request(approval), services);
    assert.equal(applied.summary.applied, 3);
    const catalogResult = applied.rows.find((row) => row.rowId === "catalog").result;
    assert.match(catalogResult.internalSku, /^CAT-/);
    for (const row of applied.rows.filter((row) => row.kind === "supplier")) {
      const saved = (await db.doc(`hotels/hotel-a/supplierproducts/${row.result.productId}`).get()).data();
      assert.equal(saved.catalogProductId, catalogResult.productId);
      assert.equal(saved.supplierId, "supplier");
      assert.equal(saved.createdBy, "buyer");
      assert.equal((await db.collection(`hotels/hotel-a/supplierPriceHistory/${row.result.productId}/entries`).get()).size, 1);
    }
    const before = await evidence([`hotels/hotel-a/catalogproducts/${catalogResult.productId}`, "hotels/hotel-a/catalogSkuConfiguration/settings"]);
    assert.deepEqual(await proposals().reviewHotelProductProposalsHandler(request(approval), services), applied);
    assert.deepEqual(await evidence(Object.keys(before)), before);
    assert.equal((await db.collection("hotels/hotel-a/catalogproducts").get()).size, initial + 1);
    await rejected(proposals().stageHotelProductProposalsHandler(request({ ...input, source: source({ label: "Changed source" }) }), services), "already-exists");
    await db.doc("hotels/hotel-a/members/buyer").update({ permissions: ["catalogproducts.read"] });
    await rejected(proposals().stageHotelProductProposalsHandler(request(input), services));
    await rejected(proposals().reviewHotelProductProposalsHandler(request(approval), services));
  });

  it("keeps incorrect taxonomy, foreign identities and incompatible quantities visible for correction", async () => {
    await db.doc("hotels/hotel-a/settings/catalog/categories/food").set({ name: "Food" });
    await db.doc("hotels/hotel-a/settings/catalog/subcategories/fruit").set({ name: "Fruit", categoryId: "food" });
    await db.doc("hotels/hotel-b/suppliers/foreign-only").set({ name: "Foreign supplier", active: true });
    const batch = await stage([
      { rowId: "unknown-category", kind: "catalog", action: "create", product: { name: "Water", baseUnit: "l", active: true, inventoryTracked: true, category: "Invented category" } },
      { rowId: "wrong-parent", kind: "catalog", action: "create", product: { name: "Water", baseUnit: "l", active: true, inventoryTracked: true, category: "Beverages", subcategory: "Fruit" } },
      { rowId: "foreign-supplier", kind: "supplier", action: "create", product: supplierFields({ supplierId: "foreign-only", catalogProductId: "water" }) },
      { rowId: "wrong-unit", kind: "supplier", action: "create", product: supplierFields({ baseUnit: "kg", catalogProductId: "water" }) },
    ]);
    assert.equal(batch.summary.invalid, 4);
    assert.ok(batch.rows.find((row) => row.rowId === "unknown-category").issues.some((entry) => entry.code === "category-unavailable"));
    assert.ok(batch.rows.find((row) => row.rowId === "wrong-parent").issues.some((entry) => entry.code === "subcategory-unavailable"));
    const attempted = await review(batch);
    assert.equal(attempted.summary.applied, 0);
    assert.equal((await db.collection("hotels/hotel-a/catalogproducts").get()).size, 2);
    assert.equal((await db.collection("hotels/hotel-a/supplierproducts").get()).size, 1);
    for (const forbidden of [{ internalSku: "FORGED" }, { revision: 99 }, { imageUrl: "https://example.test/image.jpg" }]) {
      await rejected(stage([{ rowId: "invalid-field", kind: "catalog", action: "create", product: { name: "Forged", baseUnit: "l", ...forbidden } }]), "invalid-argument");
    }
  });

  it("detects product changes even without a revision bump and preserves the original evidence on reconciliation", async () => {
    const batch = await stage([{ rowId: "water", kind: "catalog", action: "update", productId: "water", expectedRevision: 1, product: { brand: "Proposed brand" } }]);
    await db.doc("hotels/hotel-a/catalogproducts/water").update({ name: "Concurrent corrected name" });
    const attempted = await review(batch);
    assert.equal(attempted.rows[0].status, "conflict");
    assert.equal((await db.doc("hotels/hotel-a/catalogproducts/water").get()).data().brand, undefined);
    const corrected = await review(attempted, { action: "correct", corrections: [{ rowId: "water", product: { brand: "Reviewed brand" }, expectedRevision: 1, acknowledgeCurrent: true }] });
    assert.equal(corrected.rows[0].original.name, "hotel-a water");
    const applied = await review(corrected);
    assert.equal(applied.rows[0].status, "applied");
    const saved = (await db.doc("hotels/hotel-a/catalogproducts/water").get()).data();
    assert.equal(saved.name, "Concurrent corrected name"); assert.equal(saved.brand, "Reviewed brand");
    assert.equal(applied.rows[0].original.name, "hotel-a water");
  });

  it("resumes an interrupted approval without duplicating a previously committed catalog identity or SKU", async () => {
    const batch = await stage([
      { rowId: "catalog", kind: "catalog", action: "create", product: { name: "Interrupted water", baseUnit: "l", active: true, inventoryTracked: true } },
      { rowId: "supplier", kind: "supplier", action: "create", catalogRowId: "catalog", product: supplierFields() },
    ]);
    const approval = { hotelUid: "hotel-a", batchId: batch.batchId, requestId: next(), expectedRevision: batch.revision, action: "approve" };
    await assert.rejects(proposals().reviewHotelProductProposalsHandler(request(approval), { ...services, afterRow: async () => { throw new Error("Simulated interruption"); } }), /Simulated interruption/);
    const partial = await getBatch(batch); assert.equal(partial.processing, true); assert.equal(partial.summary.applied, 1);
    const skuState = (await db.doc("hotels/hotel-a/catalogSkuConfiguration/settings").get()).data();
    await db.doc("hotels/hotel-a/members/buyer").update({ permissions: ["catalogproducts.read", "supplierproducts.read", "suppliers.read"] });
    await rejected(proposals().reviewHotelProductProposalsHandler(request(approval), services));
    assert.equal((await db.collection("hotels/hotel-a/supplierproducts").get()).size, 1);
    await db.doc("hotels/hotel-a/members/buyer").update({ permissions });
    const resumed = await proposals().reviewHotelProductProposalsHandler(request(approval), services);
    assert.equal(resumed.summary.applied, 2); assert.equal(resumed.processing, false);
    assert.deepEqual((await db.doc("hotels/hotel-a/catalogSkuConfiguration/settings").get()).data(), skuState);
    assert.equal((await db.collection("hotels/hotel-a/catalogproducts").get()).size, 3);
    assert.equal((await db.collection("hotels/hotel-a/supplierproducts").get()).size, 2);
  });

  it("stops a native review when the Firebase account is disabled between committed rows", async () => {
    const batch = await stage([
      { rowId: "catalog", kind: "catalog", action: "create", product: { name: "Mid-review account check", baseUnit: "l", active: true, inventoryTracked: true } },
      { rowId: "supplier", kind: "supplier", action: "create", catalogRowId: "catalog", product: supplierFields() },
    ]);
    const approval = { hotelUid: "hotel-a", batchId: batch.batchId, requestId: next(), expectedRevision: batch.revision, action: "approve" };
    let disabled = false;
    await rejected(proposals().reviewHotelProductProposalsHandler(request(approval), { ...services, afterRow: async () => {
      if (!disabled) { disabled = true; await auth.updateUser("buyer", { disabled: true }); }
    } }));
    assert.equal((await db.collection("hotels/hotel-a/catalogproducts").get()).size, 3);
    assert.equal((await db.collection("hotels/hotel-a/supplierproducts").get()).size, 1);
    await auth.updateUser("buyer", { disabled: false });
    const resumed = await proposals().reviewHotelProductProposalsHandler(request(approval), services);
    assert.equal(resumed.summary.applied, 2);
  });

  it("preserves absent product values and historical snapshots, without confirming a price from a name-only source", async () => {
    const { mutateHotelSupplierProductHandler } = require("../../functions/src/products");
    await mutateHotelSupplierProductHandler(request({ hotelUid: "hotel-a", requestId: next(), action: "update", productId: "water-offer", expectedRevision: 1,
      product: supplierFields({ supplierSku: "WATER-1", catalogProductId: "water", brand: "Existing brand", purchaseOptions: [{ id: "bottle", purchaseUnit: "Bottle", baseUnitsPerPurchaseUnit: 1, pricePerPurchaseUnit: 2 }] }) }), services);
    const productBefore = (await db.doc("hotels/hotel-a/supplierproducts/water-offer").get()).data();
    const historical = { supplierProductId: "water-offer", catalogProductId: "water", quantity: 6, pricePerPurchaseUnit: 12, value: 72, currency: "EUR", status: "Finalized" };
    const paths = ["hotels/hotel-a/orders/frozen", "hotels/hotel-a/stockCounts/frozen", "hotels/hotel-a/inventoryMovements/frozen", "hotels/hotel-a/inventoryCheckpoints/frozen"];
    for (const path of paths) await db.doc(path).set(historical);
    const historicBefore = await evidence(paths);
    const priceHistoryBefore = (await db.collection("hotels/hotel-a/supplierPriceHistory/water-offer/entries").get()).docs.map((document) => document.data());
    const batch = await stage([{ rowId: "rename", kind: "supplier", action: "update", productId: "water-offer", expectedRevision: productBefore.revision,
      product: { supplierProductName: "Corrected article name" } }], { source: source({ label: "Article statistics without prices", documentDate: null }) });
    const result = await review(batch); assert.equal(result.summary.applied, 1);
    const after = (await db.doc("hotels/hotel-a/supplierproducts/water-offer").get()).data();
    for (const field of ["brand", "supplierSku", "catalogProductId", "baseUnit", "purchaseOptions", "pricePerPurchaseUnit", "priceUpdatedOn", "priceConfirmedOn"]) assert.deepEqual(after[field], productBefore[field], field);
    assert.equal(after.supplierProductName, "Corrected article name");
    assert.deepEqual((await db.collection("hotels/hotel-a/supplierPriceHistory/water-offer/entries").get()).docs.map((document) => document.data()), priceHistoryBefore);
    assert.deepEqual(await evidence(paths), historicBefore);
  });

  it("updates a purchase option by stable ID while preserving omitted packages and their nested source values", async () => {
    const { mutateHotelSupplierProductHandler } = require("../../functions/src/products");
    await mutateHotelSupplierProductHandler(request({ hotelUid: "hotel-a", requestId: next(), action: "update", productId: "water-offer", expectedRevision: 1,
      product: supplierFields({ supplierSku: "WATER-1", catalogProductId: "water", purchaseOptions: [
        { id: "bottle", purchaseUnit: "Bottle", baseUnitsPerPurchaseUnit: 1, pricePerPurchaseUnit: 2, gtin: "4006381333931" },
        { id: "tray", purchaseUnit: "Tray", baseUnitsPerPurchaseUnit: 12, pricePerPurchaseUnit: 24, gtin: "5901234123457" },
      ] }) }), services);
    const before = (await db.doc("hotels/hotel-a/supplierproducts/water-offer").get()).data();
    const batch = await stage([{ rowId: "package-price", kind: "supplier", action: "update", productId: "water-offer", expectedRevision: before.revision,
      product: { purchaseOptions: [{ id: "bottle", pricePerPurchaseUnit: 3 }] } }]);
    assert.equal(batch.rows[0].status, "ready");
    assert.deepEqual(batch.rows[0].proposed.purchaseOptions.find((option) => option.id === "tray"), before.purchaseOptions.find((option) => option.id === "tray"));
    const result = await review(batch); assert.equal(result.summary.applied, 1);
    const after = (await db.doc("hotels/hotel-a/supplierproducts/water-offer").get()).data();
    assert.equal(after.purchaseOptions.length, 2);
    assert.deepEqual(after.purchaseOptions.find((option) => option.id === "tray"), before.purchaseOptions.find((option) => option.id === "tray"));
    assert.deepEqual(after.purchaseOptions.find((option) => option.id === "bottle"), { ...before.purchaseOptions.find((option) => option.id === "bottle"), pricePerPurchaseUnit: 3 });
    assert.equal(after.pricePerPurchaseUnit, before.pricePerPurchaseUnit);
  });

  it("retains current prices for future agreements and rejects an older source replacing newer reviewed terms", async () => {
    const first = await stage([{ rowId: "current", kind: "supplier", action: "update", productId: "water-offer", expectedRevision: 1,
      product: { pricePerPurchaseUnit: 15 } }]);
    const approved = await review(first); assert.equal(approved.summary.applied, 1);
    const current = (await db.doc("hotels/hotel-a/supplierproducts/water-offer").get()).data();
    assert.equal(current.pricePerPurchaseUnit, 15); assert.equal(current.latestPriceSourceIssuedOn, "2026-10-15");
    const older = await stage([{ rowId: "older", kind: "supplier", action: "update", productId: "water-offer", expectedRevision: current.revision,
      product: { pricePerPurchaseUnit: 9 } }], { source: source({ documentDate: "2026-09-01" }) });
    const rejectedOlder = await review(older); assert.equal(rejectedOlder.summary.applied, 0); assert.equal(rejectedOlder.rows[0].status, "failed");
    assert.equal((await db.doc("hotels/hotel-a/supplierproducts/water-offer").get()).data().pricePerPurchaseUnit, 15);
    const future = await stage([{ rowId: "future", kind: "supplier", action: "update", productId: "water-offer", expectedRevision: current.revision,
      product: { pricePerPurchaseUnit: 18, priceValidFrom: "2026-11-01", priceValidUntil: "2027-01-31" } }]);
    const futureResult = await review(future); assert.equal(futureResult.summary.applied, 1);
    const after = (await db.doc("hotels/hotel-a/supplierproducts/water-offer").get()).data(); assert.equal(after.pricePerPurchaseUnit, 15);
    const versions = (await db.collection("hotels/hotel-a/supplierPriceVersions/water-offer/entries").get()).docs.map((document) => document.data());
    assert.ok(versions.some((version) => version.productTerms.pricePerPurchaseUnit === 18 && version.productTerms.priceValidFrom === "2026-11-01"));
  });

  it("records an explicit unchanged unit price as a new confirmation without rewriting the price change date", async () => {
    const { mutateHotelSupplierProductHandler } = require("../../functions/src/products");
    await mutateHotelSupplierProductHandler(request({ hotelUid: "hotel-a", requestId: next(), action: "update", productId: "water-offer", expectedRevision: 1,
      product: supplierFields({ supplierSku: "WATER-1", catalogProductId: "water" }) }), services);
    const before = (await db.doc("hotels/hotel-a/supplierproducts/water-offer").get()).data();
    const historiesBefore = (await db.collection("hotels/hotel-a/supplierPriceHistory/water-offer/entries").get()).size;
    const batch = await stage([{ rowId: "confirm", kind: "supplier", action: "update", productId: "water-offer", expectedRevision: before.revision,
      product: { pricePerPurchaseUnit: before.pricePerPurchaseUnit } }]);
    assert.equal(batch.rows[0].status, "unchanged");
    const applied = await review(batch); assert.equal(applied.summary.applied, 1);
    const after = (await db.doc("hotels/hotel-a/supplierproducts/water-offer").get()).data();
    assert.equal(after.pricePerPurchaseUnit, before.pricePerPurchaseUnit);
    assert.deepEqual(after.priceUpdatedOn, before.priceUpdatedOn);
    assert.equal(after.latestPriceSourceIssuedOn, "2026-10-15");
    assert.equal(after.priceConfirmationSourceReference, "Fictional supplier list");
    assert.equal((await db.collection("hotels/hotel-a/supplierPriceHistory/water-offer/entries").get()).size, historiesBefore + 1);
  });

  it("accepts an exact existing text mapping for a mixed batch and rejects a corrected supplier mismatch", async () => {
    const mappings = require("../../functions/src/supplierImportMappings");
    await mappings.saveHotelSupplierPurchaseUnitMappingHandler(request({ hotelUid: "hotel-a", supplierId: "supplier", sourceFormat: "txt", profileId: "default",
      requestId: next(), expectedRevision: 0, mappings: [{ sourceUnit: "DS", purchaseUnit: "Case" }] }), services);
    const mappingRef = mappings.mappingProfileRef(db, "hotel-a", { supplierId: "supplier", sourceFormat: "txt", profileId: "default" });
    const references = await reads.listMcpProductReferencesHandler(request({ hotelUid: "hotel-a", kind: "supplier_mappings", supplierId: "supplier", sourceFormat: "txt" }), services);
    assert.equal(references.mapping.id, mappingRef.id);
    const batch = await stage([
      { rowId: "catalog", kind: "catalog", action: "create", product: { name: "Mapped water", baseUnit: "l", active: true, inventoryTracked: true } },
      { rowId: "supplier", kind: "supplier", action: "create", catalogRowId: "catalog", product: supplierFields() },
    ], { source: source({ sourceFormat: "txt", mappingId: mappingRef.id }) });
    assert.equal(batch.summary.ready, 2);
    await db.doc("hotels/hotel-a/suppliers/other").set({ name: "Other supplier", active: true });
    await rejected(review(batch, { action: "correct", corrections: [{ rowId: "supplier", product: supplierFields({ supplierId: "other" }) }] }), "invalid-argument");
    const unchanged = await getBatch(batch); assert.equal(unchanged.revision, batch.revision);
    const result = await review(unchanged); assert.equal(result.summary.applied, 2);
  });

  it("requires another explicit review when a referenced mapping changes after staging", async () => {
    const mappings = require("../../functions/src/supplierImportMappings");
    const mappingInput = { hotelUid: "hotel-a", supplierId: "supplier", sourceFormat: "csv", profileId: "default", requestId: next(), expectedRevision: 0,
      mappings: [{ sourceUnit: "DS", purchaseUnit: "Case" }] };
    await mappings.saveHotelSupplierPurchaseUnitMappingHandler(request(mappingInput), services);
    const mappingRef = mappings.mappingProfileRef(db, "hotel-a", { supplierId: "supplier", sourceFormat: "csv", profileId: "default" });
    const batch = await stage([{ rowId: "supplier", kind: "supplier", action: "create", product: supplierFields({ catalogProductId: "water" }) }],
      { source: source({ sourceFormat: "csv", mappingId: mappingRef.id }) });
    const originalBatch = (await db.doc(`hotels/hotel-a/hotelMcpProposalBatches/${batch.batchId}`).get()).data();
    await mappings.saveHotelSupplierPurchaseUnitMappingHandler(request({ ...mappingInput, requestId: next(), expectedRevision: 1,
      mappings: [{ sourceUnit: "DS", purchaseUnit: "Box" }] }), services);
    const blocked = await review(batch);
    assert.equal(blocked.summary.applied, 0);
    assert.ok(blocked.rows[0].issues.some((entry) => entry.code === "mapping-profile-changed"));
    const corrected = await review(blocked, { action: "correct", corrections: [{ rowId: "supplier", product: supplierFields({ catalogProductId: "water" }) }] });
    const result = await review(corrected); assert.equal(result.summary.applied, 1);
    const product = (await db.doc(`hotels/hotel-a/supplierproducts/${result.rows[0].result.productId}`).get()).data();
    assert.equal(product.purchaseUnit, "Case");
    const storedBatch = (await db.doc(`hotels/hotel-a/hotelMcpProposalBatches/${batch.batchId}`).get()).data();
    assert.deepEqual(storedBatch.originalSource, originalBatch.originalSource);
    assert.deepEqual(storedBatch.originalRows, originalBatch.originalRows);
  });
});

describe("MCP OAuth grants persisted in the real Firestore emulator", () => {
  it("round-trips real product tools through the SDK HTTP client, OAuth and Firebase emulators", async (t) => {
    let app, client;
    const http = createServer((incoming, response) => app(incoming, response));
    await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
    t.after(async () => {
      try { await client?.close(); }
      finally { await new Promise((resolve) => { http.closeAllConnections(); http.close(resolve); }); }
    });
    const origin = `http://127.0.0.1:${http.address().port}`;
    const config = { ...oauthConfig, issuerUrl: origin, resourceUrl: `${origin}/mcp` };
    const created = createHotelMcpApp({ db, auth, config, services }); app = created.app;
    const verifier = "h".repeat(64), clientId = config.clients[0].client_id, redirectUri = config.clients[0].redirect_uris[0];
    const authorizationUrl = new URL("/authorize", origin);
    for (const [key, value] of Object.entries({ client_id: clientId, redirect_uri: redirectUri, response_type: "code", code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"), resource: `${origin}/mcp`, scope: `${access.READ_SCOPE} ${access.PROPOSE_SCOPE}`, state: "integration-state" })) authorizationUrl.searchParams.set(key, value);
    const authorization = await fetch(authorizationUrl, { redirect: "manual" }); assert.equal(authorization.status, 302);
    const requestId = new URL(authorization.headers.get("location")).searchParams.get("requestId");
    const consent = await created.provider.handlers.completeConsent(request({ requestId, approve: true }));
    const code = new URL(consent.redirectUrl).searchParams.get("code");
    const exchange = await fetch(`${origin}/token`, { method: "POST", body: new URLSearchParams({ client_id: clientId, grant_type: "authorization_code", code,
      code_verifier: verifier, redirect_uri: redirectUri, resource: `${origin}/mcp` }) });
    assert.equal(exchange.status, 200); const tokens = await exchange.json();
    client = new Client({ name: "hotel-toolkit-real-firebase-integration", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } } });
    await client.connect(transport);
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "stage_product_proposals"));
    assert.equal(tools.tools.some((tool) => /approve|delete|platform/.test(tool.name)), false);
    const call = async (name, args) => {
      const result = await client.callTool({ name, arguments: args });
      assert.notEqual(result.isError, true, JSON.stringify(result.content));
      assert.ok(result.structuredContent); return result.structuredContent;
    };
    const hotels = await call("discover_hotels", {});
    assert.deepEqual(hotels.hotels.map((hotel) => hotel.hotelUid), ["hotel-a"]);
    const initialCatalogs = (await db.collection("hotels/hotel-a/catalogproducts").get()).size;
    const initialSuppliers = (await db.collection("hotels/hotel-a/supplierproducts").get()).size;
    const batch = await call("stage_product_proposals", { hotelUid: hotels.hotels[0].hotelUid, requestId: next(), source: source(), rows: [
      { rowId: "supplier", kind: "supplier", action: "create", catalogRowId: "catalog", product: supplierFields({ supplierSku: "HTTP-NEW" }) },
      { rowId: "catalog", kind: "catalog", action: "create", product: { name: "HTTP proposed water", baseUnit: "l", active: true, inventoryTracked: true,
        category: "Beverages", subcategory: "Water" } },
    ] });
    assert.equal(batch.summary.ready, 2);
    assert.equal((await db.collection("hotels/hotel-a/catalogproducts").get()).size, initialCatalogs);
    assert.equal((await db.collection("hotels/hotel-a/supplierproducts").get()).size, initialSuppliers);
    const approved = await review(batch); assert.equal(approved.summary.applied, 2);
    const progress = await call("get_product_proposal_batch", { hotelUid: "hotel-a", batchId: batch.batchId });
    assert.equal(progress.status, "completed"); assert.equal(progress.summary.applied, 2);
    const catalogId = progress.rows.find((row) => row.kind === "catalog").result.productId;
    const supplierId = progress.rows.find((row) => row.kind === "supplier").result.productId;
    const savedSupplier = await call("get_supplier_product", { hotelUid: "hotel-a", productId: supplierId });
    assert.equal(savedSupplier.product.catalogProductId, catalogId);
    assert.equal(savedSupplier.product.supplierSku, "HTTP-NEW");
    await db.doc("hotels/hotel-a/members/buyer").update({ permissions: [] });
    const denied = await client.callTool({ name: "get_product_proposal_batch", arguments: { hotelUid: "hotel-a", batchId: batch.batchId } });
    assert.equal(denied.isError, true); assert.equal(JSON.parse(denied.content[0].text).error.code, "permission-denied");
    await db.doc("hotels/hotel-a/members/buyer").update({ permissions });
    const info = await created.provider.verifyAccessToken(tokens.access_token);
    await created.provider.handlers.revokeConnection(request({ connectionId: info.extra.connectionId }));
    await assert.rejects(client.callTool({ name: "discover_hotels", arguments: {} }), { code: 401 });
  });

  it("keeps tokens hashed, consent explicit and connections isolated by the current account", async () => {
    const provider = makeOAuth();
    const denied = await oauthCode(provider, "buyer", false);
    assert.equal(denied.code, null);
    assert.equal(new URL(denied.redirectUrl).searchParams.get("error"), "access_denied");
    await rejected(provider.handlers.completeConsent(request({ requestId: denied.requestId, approve: true })), "failed-precondition");
    const tokens = await oauthGrant(provider);
    const info = await provider.verifyAccessToken(tokens.access_token);
    const actor = await provider.toRequest(info);
    assert.equal(actor.auth.uid, "buyer");
    const stored = JSON.stringify((await db.collection("hotelMcpOAuthTokens").get()).docs.map((document) => ({ id: document.id, ...document.data() })));
    assert.equal(stored.includes(tokens.access_token), false); assert.equal(stored.includes(tokens.refresh_token), false);
    assert.equal((await provider.handlers.listConnections(request())).connections.length, 1);
    assert.equal((await provider.handlers.listConnections(request({}, "colleague"))).connections.length, 0);
    const own = (await provider.handlers.listConnections(request())).connections[0];
    await rejected(provider.handlers.revokeConnection(request({ connectionId: own.id }, "colleague")), "not-found");
    await provider.handlers.revokeConnection(request({ connectionId: own.id }));
    await assert.rejects(provider.verifyAccessToken(tokens.access_token), { errorCode: "invalid_token" });
    await assert.rejects(actor.mcpAuth.assertActive(), { errorCode: "invalid_token" });
  });

  it("serializes concurrent code exchange and refresh replay detection using real transactions", async () => {
    const provider = makeOAuth(), client = provider.config.clients[0], { code } = await oauthCode(provider);
    const attempts = await Promise.allSettled([1, 2].map(() => provider.exchangeAuthorizationCode(client, code, undefined, client.redirect_uris[0], new URL(oauthConfig.resourceUrl))));
    assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
    const tokens = attempts.find((attempt) => attempt.status === "fulfilled").value;
    const refreshed = await provider.exchangeRefreshToken(client, tokens.refresh_token, [access.READ_SCOPE], new URL(oauthConfig.resourceUrl));
    assert.deepEqual((await provider.verifyAccessToken(tokens.access_token)).scopes, [access.READ_SCOPE]);
    await assert.rejects(provider.exchangeRefreshToken(client, tokens.refresh_token, undefined, new URL(oauthConfig.resourceUrl)), { errorCode: "invalid_grant" });
    for (const token of [tokens.access_token, refreshed.access_token]) await assert.rejects(provider.verifyAccessToken(token), { errorCode: "invalid_token" });
  });

  it("invalidates existing OAuth access, refresh and in-flight actions after current Firebase account changes", async () => {
    const provider = makeOAuth();
    const tokens = await oauthGrant(provider), actor = await provider.toRequest(await provider.verifyAccessToken(tokens.access_token));
    await auth.updateUser("buyer", { disabled: true });
    await assert.rejects(provider.verifyAccessToken(tokens.access_token), { errorCode: "invalid_token" });
    await assert.rejects(actor.mcpAuth.assertActive(), { errorCode: "invalid_token" });
    await assert.rejects(provider.exchangeRefreshToken(provider.config.clients[0], tokens.refresh_token, undefined, new URL(oauthConfig.resourceUrl)), { errorCode: "invalid_grant" });
    await auth.updateUser("buyer", { disabled: false });
    await auth.revokeRefreshTokens("buyer");
    await assert.rejects(provider.verifyAccessToken(tokens.access_token), { errorCode: "invalid_token" });
    await auth.deleteUser("buyer");
    await assert.rejects(provider.verifyAccessToken(tokens.access_token), { errorCode: "invalid_token" });
  });
});
