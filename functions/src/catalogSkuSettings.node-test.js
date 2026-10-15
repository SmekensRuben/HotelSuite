const test = require("node:test");
const assert = require("node:assert/strict");
const { memoryDatabase } = require("./inventoryTestHelpers");
const { getHotelCatalogSkuSettingsHandler, saveHotelCatalogSkuSettingsHandler, assignHotelCatalogSkusHandler,
  DEFAULT_SETTINGS, MAX_CATALOG_SKU_NUMBER, MAX_LEGACY_CATALOG_PRODUCTS, canonicalCatalogSku, keyForSku, legacyShardId } = require("./catalogSkuSettings");
const { mutateHotelCatalogProductHandler, importHotelProductsHandler } = require("./products");
const { SAAS_RULES_VERSION } = require("./saasRollout");
const actorUid = "buyer", hotelUid = "hotel-a", base = `hotels/${hotelUid}`;
const permissions = ["catalogsettings.read", "catalogsettings.update", "catalogproducts.read", "catalogproducts.create", "catalogproducts.update", "catalogproducts.delete"];
const auth = { getUser: async () => ({ uid: actorUid, emailVerified: true, disabled: false }) };
const request = (data) => ({ auth: { uid: actorUid, token: { email_verified: true, auth_time: 9999 } }, data: { hotelUid, ...data } });
const services = (db, extra = {}) => ({ firestore: db, auth, ...extra });
function fixture() {
  return memoryDatabase({ [`${base}/members/${actorUid}`]: { permissions },
    [`hotelSubscriptions/${hotelUid}`]: { status: "active", validUntil: null, modules: ["procurement"], modulePolicyVersion: 1 },
    "platformConfiguration/saasProcurement": { enabled: true, rulesVersion: SAAS_RULES_VERSION } });
}
const catalog = (patch = {}) => ({ name: "Flour", baseUnit: "kg", active: true, inventoryTracked: true, allergens: [], ...patch });
const get = (db, data = {}, extra = {}) => getHotelCatalogSkuSettingsHandler(request(data), services(db, extra));
const save = (db, settings, patch = {}, extra = {}) => saveHotelCatalogSkuSettingsHandler(request({ requestId: "settings", expectedRevision: 0, settings: { ...DEFAULT_SETTINGS, ...settings }, ...patch }), services(db, extra));
const create = (db, id = "create", product = catalog(), extra = {}) => mutateHotelCatalogProductHandler(request({ action: "create", requestId: id, expectedRevision: 0, product }), services(db, extra));
const assign = (db, products, patch = {}, extra = {}) => assignHotelCatalogSkusHandler(request({ requestId: "assign", expectedSettingsRevision: 0, products, ...patch }), services(db, extra));
const configuration = (db) => db.records.get(`${base}/catalogSkuConfiguration/settings`);

test("numbering defaults are a scoped read-only projection and do not require a first save", async () => {
  const db = fixture(), before = structuredClone([...db.records]);
  assert.deepEqual(await get(db), { hotelUid, ...DEFAULT_SETTINGS, revision: 0, policyVersion: 1 });
  assert.deepEqual([...db.records], before);
});

test("new blank catalog SKUs are allocated atomically and exact creation replay never consumes another number", async () => {
  const db = fixture(), first = await create(db);
  assert.equal(first.internalSku, "CAT-000001"); assert.equal(configuration(db).nextNumber, 2); assert.equal(configuration(db).revision, 1);
  assert.equal(db.records.get(`${base}/catalogproducts/${first.productId}`).internalSkuCanonical, "CAT-000001");
  const second = await create(db, "second"); assert.equal(second.internalSku, "CAT-000002");
  assert.deepEqual(await create(db), first); assert.equal(configuration(db).nextNumber, 3);
  const keys = [...db.records.keys()].filter((path) => path.includes("/catalogSkuKeys/")); assert.equal(keys.length, 2);
});

test("concurrent protected product creation serializes the hotel counter and produces distinct numbers", async () => {
  const db = fixture();
  const results = await Promise.all(Array.from({ length: 12 }, (_, index) => create(db, `concurrent-${index}`)));
  assert.equal(new Set(results.map((result) => result.internalSku)).size, 12);
  assert.equal(configuration(db).nextNumber, 13); assert.equal(configuration(db).revision, 12);
});

test("catalog CSV batches share one allocation and aborted batches leave no products, reservations or number gaps", async () => {
  const db = fixture();
  const batch = (products, requestId) => importHotelProductsHandler(request({ collection: "catalogproducts", requestId, onExisting: "skip", products }), services(db));
  const before = structuredClone([...db.records]);
  await assert.rejects(batch([{ expectedRevision: 0, product: catalog() }, { expectedRevision: 0, product: catalog({ baseUnit: "unknown" }) }], "invalid"));
  assert.deepEqual([...db.records], before);
  const products = Array.from({ length: 25 }, (_, index) => ({ expectedRevision: 0, product: catalog({ name: `Article ${index}` }) }));
  const applied = await batch(products, "batch");
  assert.equal(applied.imported, 25); assert.equal(applied.products[0].internalSku, "CAT-000001"); assert.equal(applied.products.at(-1).internalSku, "CAT-000025");
  assert.equal(configuration(db).nextNumber, 26); assert.equal(configuration(db).revision, 1, "one transaction advances the configuration revision once");
  assert.deepEqual(await batch(products, "batch"), applied); assert.equal(configuration(db).nextNumber, 26);
});

test("settings are revisioned, operator changes keep their exact receipt, and stale forms cannot reset the counter", async () => {
  const db = fixture();
  const first = await save(db, { prefix: "HT-", padding: 3, nextNumber: 42 });
  assert.equal(first.revision, 1); assert.equal(first.requestId, "settings");
  const article = await create(db); assert.equal(article.internalSku, "HT-042");
  assert.equal(configuration(db).nextNumber, 43); assert.equal(configuration(db).revision, 2);
  assert.deepEqual(await save(db, { prefix: "HT-", padding: 3, nextNumber: 42 }), first);
  await assert.rejects(save(db, { prefix: "NEW-", nextNumber: 43 }, { requestId: "stale", expectedRevision: 1 }), (error) => error.code === "aborted" && error.details.catalogSkuRequestUncommitted);
  await assert.rejects(save(db, { nextNumber: 1 }, { requestId: "backward", expectedRevision: 2 }), (error) => error.code === "failed-precondition" && error.details.catalogSkuRequestUncommitted);
  assert.equal(configuration(db).nextNumber, 43);
});

test("disabled automatic numbering permits deliberate blank and explicit SKUs without assigning existing blanks", async () => {
  const db = fixture(); await save(db, { enabled: false });
  const blank = await create(db); assert.equal(blank.internalSku, "");
  const manual = await create(db, "manual", catalog({ internalSku: "  Local-42  " })); assert.equal(manual.internalSku, "Local-42");
  assert.equal(configuration(db).nextNumber, 1);
  await assert.rejects(assign(db, [{ productId: blank.productId, expectedRevision: 1 }], { expectedSettingsRevision: configuration(db).revision }), (error) => error.code === "failed-precondition" && error.details.catalogSkuRequestUncommitted);
});

test("legacy clients preserve an assigned SKU on edit and an existing blank stays blank until explicit adoption", async () => {
  const db = fixture();
  db.records.set(`${base}/catalogproducts/assigned`, { ...catalog({ internalSku: "LOCAL-42" }), productPolicyVersion: 1, revision: 7 });
  db.records.set(`${base}/catalogproducts/blank`, { ...catalog(), internalSku: "", productPolicyVersion: 1, revision: 2 });
  const edit = (id, expected) => mutateHotelCatalogProductHandler(request({ action: "update", requestId: `edit-${id}`, productId: id, expectedRevision: expected, product: catalog({ name: "Reviewed name" }) }), services(db));
  assert.equal((await edit("assigned", 7)).internalSku, "LOCAL-42");
  assert.equal((await edit("blank", 2)).internalSku, "");
  assert.equal(configuration(db).nextNumber, 1, "metadata edits do not advance numbering");
});

test("explicit and legacy SKUs use case-insensitive canonical uniqueness including archived identities", async () => {
  const db = fixture();
  db.records.set(`${base}/catalogproducts/legacy`, { ...catalog({ internalSku: "MiXeD-42" }), archived: true });
  await assert.rejects(create(db, "duplicate-legacy", catalog({ internalSku: " mixed-42 " })), (error) => error.code === "already-exists" && error.details.productRequestUncommitted);
  const unique = await create(db, "manual", catalog({ internalSku: "LOCAL-7" }));
  await assert.rejects(create(db, "duplicate-manual", catalog({ internalSku: "local-7" })), { code: "already-exists" });
  assert.equal(db.records.get(`${base}/catalogproducts/${unique.productId}`).internalSku, "LOCAL-7");
  assert.equal(canonicalCatalogSku("ＳＫＵ-ß"), "SKU-SS", "normalization also handles equivalent Unicode SKU representations");
});

test("renamed and archived SKUs stay reserved and supplier SKUs are never modified", async () => {
  const db = fixture(); db.records.set(`${base}/supplierproducts/source`, { supplierSku: "SUPPLIER-42", catalogProductId: null });
  const article = await create(db, "manual", catalog({ internalSku: "OLD-42" }));
  await mutateHotelCatalogProductHandler(request({ action: "update", requestId: "rename-sku", productId: article.productId, expectedRevision: 1, product: catalog({ internalSku: "NEW-42" }) }), services(db));
  await mutateHotelCatalogProductHandler(request({ action: "archive", requestId: "archive", productId: article.productId, expectedRevision: 2 }), services(db));
  for (const sku of ["old-42", "new-42"]) await assert.rejects(create(db, `reuse-${sku}`, catalog({ internalSku: sku })), { code: "already-exists" });
  assert.deepEqual(db.records.get(`${base}/supplierproducts/source`), { supplierSku: "SUPPLIER-42", catalogProductId: null });
});

test("explicit adoption numbers only selected missing SKUs and preserves complete legacy records and historical references", async () => {
  const db = fixture();
  const legacy = { name: "Legacy juice", baseUnit: "unreviewed-unit", sourceQuantity: "supplier source spelling", originalImport: { supplierSku: "VENDOR-9", row: 42 },
    currency: "old-currency", active: false, unknownLocalCorrection: "Retain this", revision: 4, createdAt: { seconds: 100 } };
  db.records.set(`${base}/catalogproducts/legacy`, legacy);
  db.records.set(`${base}/catalogproducts/unselected`, { name: "Keep blank", revision: 0 });
  db.records.set(`${base}/orders/historical`, { lines: [{ catalogProductId: "legacy", internalSku: "", price: 14 }] });
  const historical = structuredClone(db.records.get(`${base}/orders/historical`));
  const result = await assign(db, [{ productId: "legacy", expectedRevision: 4 }]);
  assert.deepEqual(result.assigned, [{ productId: "legacy", revision: 5, internalSku: "CAT-000001" }]); assert.equal(result.settingsRevision, 1);
  const stored = db.records.get(`${base}/catalogproducts/legacy`);
  for (const [key, value] of Object.entries(legacy)) if (key !== "revision") assert.deepEqual(stored[key], value, key);
  assert.equal(stored.revision, 5); assert.equal(db.records.get(`${base}/catalogproducts/unselected`).internalSku, undefined);
  assert.deepEqual(db.records.get(`${base}/orders/historical`), historical);
  assert.deepEqual(await assign(db, [{ productId: "legacy", expectedRevision: 4 }]), result);
});

test("adoption is atomic, rejects numbered or changed rows and revisions, and consumes no number on failure", async () => {
  const db = fixture();
  db.records.set(`${base}/catalogproducts/blank`, { name: "Missing SKU", internalSku: "", revision: 2 });
  db.records.set(`${base}/catalogproducts/numbered`, { name: "Manual SKU", internalSku: "MANUAL", revision: 1 });
  const before = structuredClone([...db.records]);
  await assert.rejects(assign(db, [{ productId: "blank", expectedRevision: 2 }, { productId: "numbered", expectedRevision: 1 }]), (error) => error.code === "failed-precondition" && error.details.catalogSkuRequestUncommitted);
  assert.deepEqual([...db.records], before);
  await assert.rejects(assign(db, [{ productId: "blank", expectedRevision: 1 }], { requestId: "stale-product" }), (error) => error.code === "aborted" && error.details.catalogSkuRequestUncommitted);
  const good = await assign(db, [{ productId: "blank", expectedRevision: 2 }], { requestId: "good" });
  assert.equal(good.assigned[0].internalSku, "CAT-000001");
});

test("settings and adoption replay recheck current permissions, Auth revocation and the selected hotel", async () => {
  const db = fixture();
  const saved = await save(db, {}); assert.equal(saved.revision, 1);
  db.records.set(`${base}/members/${actorUid}`, { permissions: ["catalogsettings.read", "catalogsettings.create"] });
  await assert.rejects(save(db, {}), (error) => error.code === "permission-denied" && !error.details?.catalogSkuRequestUncommitted);
  db.records.set(`${base}/members/${actorUid}`, { permissions });
  db.records.set(`${base}/catalogproducts/blank`, { revision: 0 });
  await assign(db, [{ productId: "blank", expectedRevision: 0 }], { expectedSettingsRevision: 1 });
  db.records.set(`${base}/members/${actorUid}`, { permissions: permissions.filter((value) => value !== "catalogproducts.update") });
  await assert.rejects(assign(db, [{ productId: "blank", expectedRevision: 0 }], { expectedSettingsRevision: 1 }), (error) => error.code === "permission-denied" && !error.details?.catalogSkuRequestUncommitted);
  await assert.rejects(get(db, {}, { auth: { getUser: async () => ({ disabled: true, emailVerified: true }) } }), { code: "permission-denied" });
  await assert.rejects(get(db, { hotelUid: "foreign" }), { code: "permission-denied" });
  await assert.rejects(assign(db, [{ productId: "blank", expectedRevision: 0 }], { hotelUid: "foreign" }), { code: "permission-denied" });
});

test("hotel counters and reservations remain isolated even when hotels choose identical numbers", async () => {
  const db = fixture();
  db.records.set("hotels/hotel-b/members/buyer", { permissions });
  db.records.set("hotelSubscriptions/hotel-b", { status: "active", validUntil: null, modules: ["procurement"], modulePolicyVersion: 1 });
  const first = await create(db);
  const second = await mutateHotelCatalogProductHandler(request({ hotelUid: "hotel-b", action: "create", requestId: "create", expectedRevision: 0, product: catalog() }), services(db));
  assert.equal(first.internalSku, "CAT-000001"); assert.equal(second.internalSku, "CAT-000001");
  assert.equal(db.records.get("hotels/hotel-b/catalogSkuConfiguration/settings").nextNumber, 2); assert.equal(configuration(db).nextNumber, 2);
});

test("the first-use legacy index supports more than 1,000 products, copies only SKUs, and later allocation needs no catalog scan", async () => {
  const db = fixture();
  for (let index = 0; index < 1100; index++) db.records.set(`${base}/catalogproducts/legacy-${index}`, { internalSku: `LEGACY-${index}`, price: "PRIVATE-PRICE", originalSupplier: "PRIVATE-SUPPLIER" });
  let scans = 0;
  const original = db.collection;
  db.collection = (...args) => { const query = original(...args); if (args[0] === `${base}/catalogproducts`) { const select = query.select; query.select = (...fields) => { assert.deepEqual(fields, ["internalSku"]); scans++; return select(...fields); }; } return query; };
  await create(db);
  assert.equal(scans, 1); assert.ok(configuration(db).legacyIndexShards.length <= 64);
  const index = [...db.records].filter(([path]) => path.includes("/catalogSkuLegacyIndex/"));
  assert.equal(JSON.stringify(index).includes("PRIVATE-PRICE"), false); assert.equal(JSON.stringify(index).includes("PRIVATE-SUPPLIER"), false);
  await create(db, "second"); assert.equal(scans, 1);
  await assert.rejects(create(db, "duplicate-old", catalog({ internalSku: "legacy-1099" })), { code: "already-exists" });
});

test("initial automatic numbering continues after matching historical numbers while expired identities remain held", async () => {
  const db = fixture();
  db.records.set(`${base}/catalogproducts/archived`, { internalSku: "cat-000120", archived: true });
  assert.equal((await create(db)).internalSku, "CAT-000121");
  assert.equal(configuration(db).nextNumber, 122);
});

test("missing or corrupt private index and reservation evidence fails closed without consuming a number", async () => {
  for (const corruption of ["missing-shard", "checksum", "certificate", "reservation"]) {
    const db = fixture(); db.records.set(`${base}/catalogproducts/legacy`, { internalSku: "LEGACY-42" });
    await create(db);
    const key = keyForSku("LEGACY-42"), shardPath = `${base}/catalogSkuLegacyIndex/${legacyShardId(key)}`;
    if (corruption === "missing-shard") db.records.delete(shardPath);
    if (corruption === "checksum") db.records.set(shardPath, { ...db.records.get(shardPath), keys: {} });
    if (corruption === "certificate") { const value = { ...configuration(db) }; delete value.legacyIndexPolicyVersion; delete value.legacyIndexShards; db.records.set(`${base}/catalogSkuConfiguration/settings`, value); }
    if (corruption === "reservation") db.records.set(`${base}/catalogSkuKeys/${key}`, { policyVersion: 99, canonicalSku: "LEGACY-42", productId: "foreign" });
    const before = configuration(db).nextNumber;
    await assert.rejects(create(db, `corrupt-${corruption}`, catalog({ internalSku: "LEGACY-42" })), { code: "failed-precondition" });
    assert.equal(configuration(db).nextNumber, before);
  }
});

test("bootstrap bounds and exhausted safe counters fail closed and leave the entire operation uncommitted", async () => {
  const tooMany = fixture();
  for (let index = 0; index <= MAX_LEGACY_CATALOG_PRODUCTS; index++) tooMany.records.set(`${base}/catalogproducts/legacy-${index}`, { internalSku: `LEGACY-${index}` });
  await assert.rejects(create(tooMany), /20,000-product bootstrap window/);
  assert.equal(configuration(tooMany), undefined);
  const db = fixture(); await save(db, { nextNumber: MAX_CATALOG_SKU_NUMBER + 1 });
  const before = structuredClone([...db.records]);
  await assert.rejects(create(db), (error) => error.code === "failed-precondition" && /exhausted/.test(error.message) && error.details.productRequestUncommitted);
  assert.deepEqual(structuredClone([...db.records]), before);
});

test("invalid prefix, padding, counters, injection, duplicate adoption IDs and changed request bodies are rejected", async () => {
  const db = fixture();
  for (const settings of [{ prefix: "lower-" }, { prefix: "X".repeat(21) }, { prefix: "CAT /" }, { padding: 0 }, { padding: 13 }, { padding: 1.5 }, { nextNumber: 0 }, { nextNumber: 1.5 }, { nextNumber: Number.MAX_SAFE_INTEGER + 1 }, { enabled: "true" }]) await assert.rejects(save(db, settings), { code: "invalid-argument" });
  await save(db, {});
  await assert.rejects(save(db, { prefix: "DIFFERENT-" }), (error) => error.code === "already-exists" && !error.details?.catalogSkuRequestUncommitted);
  db.records.set(`${base}/catalogproducts/blank`, { revision: 0 });
  await assert.rejects(assign(db, [{ productId: "blank", expectedRevision: 0 }, { productId: "blank", expectedRevision: 0 }], { expectedSettingsRevision: 1 }), { code: "invalid-argument" });
  await assert.rejects(assign(db, [{ productId: "other/path", expectedRevision: 0 }], { expectedSettingsRevision: 1 }), { code: "invalid-argument" });
  await assert.rejects(create(db, "forge", catalog({ internalSkuCanonical: "FORGED" })), { code: "invalid-argument" });
});

test("transaction retries recheck actual Auth and never reuse a former actor's SKU settings authority", async () => {
  const db = fixture(), original = db.runTransaction;
  let disabled = false, calls = 0;
  db.runTransaction = async (callback) => { await original(callback); disabled = true; return original(callback); };
  await assert.rejects(get(db, {}, { auth: { getUser: async () => { calls++; return { uid: actorUid, emailVerified: true, disabled }; } } }), { code: "permission-denied" });
  assert.equal(calls, 2);
});


test("archived missing-SKU identities cannot be adopted or consume a number", async () => {
  const db = fixture();
  db.records.set(`${base}/catalogproducts/archived`, { name: "Historical identity", internalSku: "", archived: true, revision: 3 });
  const before = structuredClone([...db.records]);
  await assert.rejects(assign(db, [{ productId: "archived", expectedRevision: 3 }]), (error) => error.code === "failed-precondition" && error.details.catalogSkuRequestUncommitted);
  assert.deepEqual(structuredClone([...db.records]), before);
});


test("a partially restored generated SKU reservation cannot duplicate an indexed identity and its owner can repair the missing key", async () => {
  const db = fixture();
  const original = await create(db);
  const second = await create(db, "after-bootstrap");
  const key = keyForSku(canonicalCatalogSku(second.internalSku)), reservationPath = `${base}/catalogSkuKeys/${key}`;
  db.records.delete(reservationPath);
  const before = JSON.stringify([...db.records]);
  const equivalent = second.internalSku.toLowerCase().replace("cat", "ｃａｔ");
  await assert.rejects(create(db, "duplicate-restored", catalog({ internalSku: equivalent })), (error) => error.code === "already-exists" && error.details.productRequestUncommitted);
  assert.equal(JSON.stringify([...db.records]), before, "the failed request cannot alter the counter, products or receipts");
  assert.equal(configuration(db).nextNumber, 3);
  const repaired = await mutateHotelCatalogProductHandler(request({ action: "update", requestId: "repair-own-reservation", productId: second.productId,
    expectedRevision: 1, product: catalog({ name: "Reviewed owner", internalSku: second.internalSku }) }), services(db));
  assert.equal(repaired.internalSku, second.internalSku);
  assert.equal(db.records.get(reservationPath).productId, second.productId);
  assert.equal(configuration(db).nextNumber, 3);
  assert.equal(db.records.get(`${base}/catalogproducts/${original.productId}`).internalSku, "CAT-000001");
});
