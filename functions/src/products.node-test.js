const test = require("node:test");
const assert = require("node:assert/strict");
const { mutateHotelCatalogProductHandler, mutateHotelSupplierProductHandler, importHotelProductsHandler } = require("./products");
const { SAAS_RULES_VERSION } = require("./saasRollout");

function memoryDatabase(initial = {}) {
  const records = new Map(Object.entries(initial));
  const snapshot = (path) => ({ exists: records.has(path), id: path.split("/").at(-1), data: () => structuredClone(records.get(path)) });
  let serial = Promise.resolve();
  const db = { records, doc: (path) => ({ path }), collection(path) {
    const query = (filters = [], maximum = Infinity) => ({ isQuery: true,
      where: (field, op, value) => { assert.equal(op, "=="); return query([...filters, [field, value]], maximum); },
      limit: (value) => query(filters, value),
      get: async () => { const docs = [...records.entries()].filter(([key, value]) => key.startsWith(`${path}/`) && key.slice(path.length + 1).split("/").length === 1 && filters.every(([field, expected]) => value[field] === expected))
        .slice(0, maximum).map(([key]) => snapshot(key)); return { docs, size: docs.length, empty: docs.length === 0 }; } });
    return query();
  }, runTransaction(fn) {
    const run = serial.then(async () => {
      const writes = [];
      const tx = { get: async (ref) => { assert.equal(writes.length, 0, "transactions read everything before writing"); return ref.isQuery ? ref.get() : snapshot(ref.path); },
        set: (ref, data) => writes.push(["set", ref.path, data]),
        create: (ref, data) => writes.push(["create", ref.path, data]), delete: (ref) => writes.push(["delete", ref.path]) };
      const result = await fn(tx);
      for (const [kind, path, data] of writes) {
        if (kind === "create") assert.equal(records.has(path), false);
        if (kind === "delete") records.delete(path); else records.set(path, data);
      }
      return result;
    }); serial = run.catch(() => {}); return run;
  } };
  return db;
}
const hotelUid = "hotel-a", userUid = "buyer";
const auth = { getUser: async (uid) => ({ uid, emailVerified: true, disabled: false }) };
const request = (data) => ({ auth: { uid: userUid, token: { email_verified: true, auth_time: 9999 } }, data });
const permissions = ["catalogproducts.create", "catalogproducts.update", "catalogproducts.delete", "supplierproducts.create", "supplierproducts.update", "supplierproducts.delete"];
function fixture() {
  return memoryDatabase({ [`hotels/${hotelUid}/members/${userUid}`]: { permissions },
    [`hotelSubscriptions/${hotelUid}`]: { status: "active", validUntil: null, modules: ["procurement"], modulePolicyVersion: 1 },
    "platformConfiguration/saasProcurement": { enabled: true, rulesVersion: SAAS_RULES_VERSION },
    [`hotels/${hotelUid}/suppliers/dairy`]: { name: "Dairy Company" }, [`hotels/${hotelUid}/suppliers/other`]: { name: "Other Company" },
    [`hotels/${hotelUid}/catalogproducts/milk`]: { name: "Milk", baseUnit: "l", inventoryTracked: true, active: true, productPolicyVersion: 1, revision: 1 } });
}
const catalog = (patch = {}) => ({ name: "Flour", baseUnit: "kg", active: true, inventoryTracked: true, allergens: [], ...patch });
const offer = (patch = {}) => ({ supplierId: "dairy", supplierSku: "MILK6", supplierProductName: "Milk six pack", currency: "EUR", pricingModel: "Per Purchase Unit",
  pricePerBaseUnit: null, pricePerPurchaseUnit: 12, baseUnit: "l", purchaseUnit: "Case", baseUnitsPerPurchaseUnit: 6, catalogProductId: "milk", imageUrl: "", active: true,
  priceBasis: "net", vatRate: null, purchaseOptions: [], ...patch });
const createCatalog = (db, patch = {}) => mutateHotelCatalogProductHandler(request({ hotelUid, requestId: "catalog-create", action: "create", expectedRevision: 0, product: catalog(), ...patch }), { firestore: db, auth });
const createOffer = (db, patch = {}) => mutateHotelSupplierProductHandler(request({ hotelUid, requestId: "offer-create", action: "create", expectedRevision: 0, product: offer(), ...patch }), { firestore: db, auth });

test("ordinary hotel user creates protected products; exact retry returns the original result after later edits", async () => {
  const db = fixture(); const first = await createCatalog(db);
  assert.equal(first.revision, 1);
  await mutateHotelCatalogProductHandler(request({ hotelUid, requestId: "catalog-edit", action: "update", productId: first.productId, expectedRevision: 1, product: catalog({ name: "Flour renamed" }) }), { firestore: db, auth });
  assert.deepEqual(await createCatalog(db), first);
  await assert.rejects(createCatalog(db, { product: catalog({ name: "Changed payload" }) }), (error) => error.code === "already-exists" && !error.details?.productRequestUncommitted);
  assert.equal([...db.records.keys()].filter((path) => path.includes("/productAudit/")).length, 2);
});
test("supplier SKU edits retain stable identity and existing historical references", async () => {
  const db = fixture(), first = await createOffer(db);
  const path = `hotels/${hotelUid}/supplierproducts/${first.productId}`;
  db.records.set(`hotels/${hotelUid}/orders/history`, { lines: [{ supplierProductId: first.productId, supplierSku: "MILK6", pricePerPurchaseUnit: 12 }] });
  db.records.set(`hotels/${hotelUid}/locations/store/stockTemplates/t`, { items: [{ supplierProductId: first.productId }] });
  const updated = await mutateHotelSupplierProductHandler(request({ hotelUid, requestId: "sku-edit", action: "update", productId: first.productId, expectedRevision: 1, product: offer({ supplierSku: "MILK-NEW", pricePerPurchaseUnit: 15 }) }), { firestore: db, auth });
  assert.equal(updated.productId, first.productId); assert.equal(db.records.get(path).supplierSku, "MILK-NEW");
  assert.deepEqual(db.records.get(`hotels/${hotelUid}/orders/history`).lines, [{ supplierProductId: first.productId, supplierSku: "MILK6", pricePerPurchaseUnit: 12 }]);
  assert.equal(db.records.get(`hotels/${hotelUid}/locations/store/stockTemplates/t`).items[0].supplierProductId, first.productId);
  assert.equal([...db.records.keys()].filter((key) => key.includes("/supplierproducts/")).length, 1);
  assert.equal([...db.records.keys()].filter((key) => key.includes("/productSkuKeys/")).length, 1);
});
test("same supplier SKU has one winner under concurrent create while another supplier may offer the same catalog", async () => {
  const db = fixture();
  const outcomes = await Promise.allSettled([createOffer(db), createOffer(db, { requestId: "competing" })]);
  assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(outcomes.find((result) => result.status === "rejected").reason.code, "already-exists");
  const other = await createOffer(db, { requestId: "other-supplier", product: offer({ supplierId: "other", baseUnit: "ml", baseUnitsPerPurchaseUnit: 6000 }) });
  assert.equal(db.records.get(`hotels/${hotelUid}/supplierproducts/${other.productId}`).catalogProductId, "milk");
});
test("legacy SKU records without an index prevent creation of a duplicate offer", async () => {
  const db = fixture(); db.records.set(`hotels/${hotelUid}/supplierproducts/legacy`, offer());
  await assert.rejects(createOffer(db), (error) => error.code === "already-exists" && error.details.productRequestUncommitted === true);
});
test("same-hotel references and compatible representable dimensions are enforced", async () => {
  const db = fixture();
  db.records.set("hotels/hotel-b/catalogproducts/foreign", { name: "Foreign", baseUnit: "l" });
  db.records.set("hotels/hotel-b/suppliers/foreign", { name: "Foreign" });
  for (const patch of [{ catalogProductId: "foreign" }, { supplierId: "foreign" }, { baseUnit: "kg" }]) {
    await assert.rejects(createOffer(db, { product: offer(patch) }), (error) => error.code === "failed-precondition");
  }
  await assert.rejects(createOffer(db, { product: offer({ baseUnit: "ml", baseUnitsPerPurchaseUnit: 0.000001, pricePerPurchaseUnit: 0 }) }), /six decimal/);
  assert.equal([...db.records.keys()].some((path) => path.includes("/productOperations/")), false);
});
test("unknown prices persist explicitly; malformed booleans and server-controlled fields cannot be injected", async () => {
  const db = fixture(), created = await createOffer(db, { product: offer({ pricePerPurchaseUnit: null, priceBasis: "unknown" }) });
  assert.equal(db.records.get(`hotels/${hotelUid}/supplierproducts/${created.productId}`).pricePerPurchaseUnit, null);
  for (const patch of [{ active: "true" }, { pricePerPurchaseUnit: "12" }, { revision: 100 }, { createdBy: "other-user" }]) {
    await assert.rejects(createOffer(db, { requestId: `invalid-${Object.keys(patch)[0]}`, product: offer(patch) }), (error) => error.code === "invalid-argument" && error.details.productRequestUncommitted === true);
  }
});
test("reviewed catalog units and linked supplier identities cannot silently change", async () => {
  const db = fixture();
  await assert.rejects(mutateHotelCatalogProductHandler(request({ hotelUid, requestId: "unit-edit", action: "update", productId: "milk", expectedRevision: 1, product: catalog({ name: "Milk", baseUnit: "ml" }) }), { firestore: db, auth }), /canonical base unit is immutable/);
  const first = await createOffer(db);
  for (const patch of [{ catalogProductId: null }, { supplierId: "other" }, { baseUnit: "ml", baseUnitsPerPurchaseUnit: 6000 }]) {
    await assert.rejects(mutateHotelSupplierProductHandler(request({ hotelUid, requestId: `identity-${Object.keys(patch)[0]}`, action: "update", productId: first.productId, expectedRevision: 1, product: offer(patch) }), { firestore: db, auth }), /immutable/);
  }
});
test("reviewed unlinked offer may establish its first catalog link with explicit valid conversion", async () => {
  const db = fixture(), first = await createOffer(db, { product: offer({ catalogProductId: null }) });
  await mutateHotelSupplierProductHandler(request({ hotelUid, requestId: "first-link", action: "update", productId: first.productId, expectedRevision: 1, product: offer() }), { firestore: db, auth });
  assert.equal(db.records.get(`hotels/${hotelUid}/supplierproducts/${first.productId}`).catalogProductId, "milk");
});
test("archival preserves linked/history IDs and requires independent delete permission", async () => {
  const db = fixture(), first = await createOffer(db);
  const command = { hotelUid, requestId: "archive", action: "archive", productId: first.productId, expectedRevision: 1 };
  const result = await mutateHotelSupplierProductHandler(request(command), { firestore: db, auth });
  assert.equal(result.archived, true); const saved = db.records.get(`hotels/${hotelUid}/supplierproducts/${first.productId}`);
  assert.equal(saved.active, false); assert.equal(saved.catalogProductId, "milk"); assert.equal(saved.pricePerPurchaseUnit, 12);
  assert.deepEqual(await mutateHotelSupplierProductHandler(request(command), { firestore: db, auth }), result);
  await assert.rejects(mutateHotelSupplierProductHandler(request({ ...command, action: "update", requestId: "reactivate", expectedRevision: 2, product: offer() }), { firestore: db, auth }), /cannot be reactivated/);
  db.records.set(`hotels/${hotelUid}/members/${userUid}`, { permissions: ["supplierproducts.update"] });
  await assert.rejects(mutateHotelSupplierProductHandler(request(command), { firestore: db, auth }), (error) => error.code === "permission-denied");
});
test("archived catalog records retain linked IDs and require offers to be inactive before reviewed save", async () => {
  const db = fixture(), first = await createOffer(db);
  await mutateHotelCatalogProductHandler(request({ hotelUid, requestId: "archive-catalog", action: "archive", productId: "milk", expectedRevision: 1 }), { firestore: db, auth });
  const archived = db.records.get(`hotels/${hotelUid}/catalogproducts/milk`);
  assert.equal(archived.baseUnit, "l"); assert.equal(archived.inventoryTracked, true); assert.equal(archived.archived, true);
  assert.equal(db.records.get(`hotels/${hotelUid}/supplierproducts/${first.productId}`).catalogProductId, "milk");
  const command = { hotelUid, requestId: "edit-archived-link", action: "update", productId: first.productId, expectedRevision: 1, product: offer({ supplierSku: "NEW" }) };
  await assert.rejects(mutateHotelSupplierProductHandler(request(command), { firestore: db, auth }), /active linked catalog product/);
  await mutateHotelSupplierProductHandler(request({ ...command, requestId: "deactivate-linked-offer", product: offer({ active: false }) }), { firestore: db, auth });
  assert.equal(db.records.get(`hotels/${hotelUid}/supplierproducts/${first.productId}`).active, false);
});
test("current identity, tenant/action/module/gate checks apply to every mutation and replay", async () => {
  const db = fixture(), first = await createCatalog(db); assert.equal(first.revision, 1);
  await assert.rejects(createCatalog(db, { hotelUid: "hotel-b" }), (error) => error.code === "permission-denied");
  for (const identity of [{ disabled: true, emailVerified: true }, { emailVerified: false }, { emailVerified: true, tokensValidAfterTime: new Date(9999001).toISOString() }, null]) {
    await assert.rejects(mutateHotelCatalogProductHandler(request({ hotelUid, requestId: "catalog-create", action: "create", expectedRevision: 0, product: catalog() }), {
      firestore: db, auth: { getUser: async () => { if (!identity) throw new Error("removed"); return identity; } } }), (error) => error.code === "permission-denied");
  }
  db.records.set(`hotelSubscriptions/${hotelUid}`, { status: "active", validUntil: null, modules: ["frontoffice"], modulePolicyVersion: 1 });
  await assert.rejects(createCatalog(db), (error) => error.code === "permission-denied");
  const disabled = fixture(); disabled.records.set("platformConfiguration/saasProcurement", { enabled: false, rulesVersion: SAAS_RULES_VERSION });
  await assert.rejects(createCatalog(disabled), (error) => error.code === "failed-precondition" && !error.details?.productRequestUncommitted);
});
test("optimistic product revisions reject stale edits and changed replay revisions", async () => {
  const db = fixture(), first = await createCatalog(db);
  const command = { hotelUid, requestId: "edit", action: "update", productId: first.productId, expectedRevision: 1, product: catalog({ name: "New name" }) };
  await mutateHotelCatalogProductHandler(request(command), { firestore: db, auth });
  await assert.rejects(mutateHotelCatalogProductHandler(request({ ...command, requestId: "different" }), { firestore: db, auth }), (error) => error.code === "aborted" && error.details.productRequestUncommitted === true);
  await assert.rejects(mutateHotelCatalogProductHandler(request({ ...command, expectedRevision: 2 }), { firestore: db, auth }), (error) => error.code === "already-exists" && !error.details?.productRequestUncommitted);
});

const importProducts = (db, products, patch = {}) => importHotelProductsHandler(request({ hotelUid, collection: "supplierproducts", requestId: "import", onExisting: "skip", products, ...patch }), { firestore: db, auth });
test("bounded imports use the same validation atomically and replay the original batch results", async () => {
  const db = fixture();
  const products = [{ expectedRevision: 0, product: offer() }, { expectedRevision: 0, product: offer({ supplierId: "other", supplierSku: "OTHER" }) }];
  const first = await importProducts(db, products);
  assert.equal(first.imported, 2); assert.equal(first.skipped, 0);
  assert.deepEqual(await importProducts(db, products), first);
  await assert.rejects(importProducts(db, [{ expectedRevision: 0, product: offer({ supplierSku: "Different" }) }]), (error) => error.code === "already-exists");
  const invalid = fixture();
  await assert.rejects(importProducts(invalid, [products[0], { expectedRevision: 0, product: offer({ supplierSku: "bad", pricePerPurchaseUnit: "1" }) }]), (error) => error.code === "invalid-argument");
  assert.equal([...invalid.records.keys()].some((key) => key.includes("/supplierproducts/")), false);
  await assert.rejects(importProducts(invalid, Array.from({ length: 26 }, () => products[0])), /25 products/);
});
test("import rejects duplicate IDs/SKUs, preserves stable update IDs and requires revisions/update authority", async () => {
  const db = fixture(), first = await createOffer(db);
  const row = { productId: first.productId, expectedRevision: 1, product: offer({ supplierSku: "Changed" }) };
  const imported = await importProducts(db, [row], { onExisting: "overwrite" });
  assert.equal(imported.products[0].productId, first.productId); assert.equal(imported.products[0].revision, 2);
  await assert.rejects(importProducts(db, [{ ...row, expectedRevision: 2 }, { ...row, expectedRevision: 2 }], { requestId: "duplicate", onExisting: "overwrite" }), /duplicate product IDs/);
  await assert.rejects(importProducts(db, [{ expectedRevision: 0, product: offer({ supplierSku: "NEW" }) }, { expectedRevision: 0, product: offer({ supplierSku: "NEW" }) }], { requestId: "duplicate-sku" }), /already belongs/);
  db.records.set(`hotels/${hotelUid}/members/${userUid}`, { permissions: ["supplierproducts.create"] });
  await assert.rejects(importProducts(db, [row], { onExisting: "overwrite" }), (error) => error.code === "permission-denied");
  await assert.rejects(importProducts(db, [{ ...row, expectedRevision: 2 }], { requestId: "new-import", onExisting: "overwrite" }), (error) => error.code === "permission-denied");
});
test("cross-command request IDs cannot replay a different product collection or action", async () => {
  const db = fixture(); await createCatalog(db);
  await assert.rejects(createOffer(db, { requestId: "catalog-create" }), (error) => error.code === "already-exists");
  await assert.rejects(importProducts(db, [{ expectedRevision: 0, product: offer() }], { requestId: "catalog-create" }), (error) => error.code === "already-exists");
});

