const test = require("node:test");
const assert = require("node:assert/strict");
const { stageHotelProductProposalsHandler: stage, readHotelProductProposalBatchHandler: read,
  listHotelProductProposalBatchesHandler: list, reviewHotelProductProposalsHandler: review } = require("./hotelMcpProposals");
const { mutateHotelSupplierProductHandler: mutateSupplier } = require("./products");
const { SAAS_RULES_VERSION } = require("./saasRollout");

const hotelUid = "hotel-a", uid = "buyer", root = `hotels/${hotelUid}`;
const permissions = ["catalogproducts.read", "catalogproducts.create", "catalogproducts.update", "supplierproducts.read", "supplierproducts.create", "supplierproducts.update", "suppliers.read"];
const request = (data, actor = uid) => ({ auth: { uid: actor, token: { email_verified: true, auth_time: 9999 } }, data });
const auth = { getUser: async (actor) => ({ uid: actor, disabled: false, emailVerified: true }) };
const now = () => Date.parse("2026-10-15T12:00:00Z");
function memoryDatabase(initial = {}) {
  const records = new Map(Object.entries(initial)); let serial = Promise.resolve();
  const snapshot = (path) => ({ id: path.split("/").at(-1), exists: records.has(path), data: () => structuredClone(records.get(path)) });
  const db = { records, doc(path) { return { path, get: async () => snapshot(path) }; }, collection(path) {
    const query = (filters = [], maximum = Infinity, selected = null, cursor = null, sorts = []) => ({ isQuery: true,
      where: (field, operator, value) => { assert.equal(operator, "=="); return query([...filters, [field, value]], maximum, selected, cursor, sorts); },
      orderBy: (field, direction = "asc") => query(filters, maximum, selected, cursor, [...sorts, [typeof field === "string" ? field : "__name__", direction]]), startAfter: (...values) => query(filters, maximum, selected, values, sorts),
      limit: (value) => query(filters, value, selected, cursor, sorts), select: (...fields) => query(filters, maximum, fields, cursor, sorts),
      get: async () => {
        const sortValue = ([key, value], field) => field === "__name__" ? key.split("/").at(-1) : value[field];
        const compareValues = (left, right) => typeof left === "string" ? left.localeCompare(right) : left - right;
        const order = sorts.length ? sorts : [["__name__", "asc"]];
        const docs = [...records.entries()].filter(([key, value]) => key.startsWith(`${path}/`) && key.slice(path.length + 1).split("/").length === 1 && filters.every(([field, expected]) => value[field] === expected))
          .filter((entry) => !cursor || order.reduce((compared, [field, direction], index) => compared || compareValues(sortValue(entry, field), cursor[index]) * (direction === "desc" ? -1 : 1), 0) > 0)
          .sort((left, right) => order.reduce((compared, [field, direction]) => compared || compareValues(sortValue(left, field), sortValue(right, field)) * (direction === "desc" ? -1 : 1), 0)).slice(0, maximum).map(([key]) => {
            const source = snapshot(key); return selected ? { ...source, data: () => Object.fromEntries(selected.filter((field) => Object.hasOwn(source.data(), field)).map((field) => [field, source.data()[field]])) } : source;
          }); return { docs, size: docs.length, empty: !docs.length };
      } });
    return query();
  }, runTransaction(fn) {
    const run = serial.then(async () => {
      const writes = [], tx = { get: async (ref) => { assert.equal(writes.length, 0, "Firestore reads must precede every transaction write"); return ref.isQuery ? ref.get() : snapshot(ref.path); },
        set: (ref, value) => writes.push(["set", ref.path, value]), create: (ref, value) => writes.push(["create", ref.path, value]), delete: (ref) => writes.push(["delete", ref.path]) };
      const result = await fn(tx);
      for (const [kind, path, value] of writes) {
        if (kind === "create") assert.equal(records.has(path), false, `Duplicate immutable record ${path}`);
        if (kind === "delete") records.delete(path); else records.set(path, value);
      }
      return result;
    }); serial = run.catch(() => {}); return run;
  } }; return db;
}
function fixture() {
  const firestore = memoryDatabase({
    [`${root}/members/${uid}`]: { permissions }, [`${root}/members/other`]: { permissions },
    [`hotelSubscriptions/${hotelUid}`]: { status: "active", validUntil: null, modules: ["procurement"], modulePolicyVersion: 1 },
    "platformConfiguration/saasProcurement": { enabled: true, rulesVersion: SAAS_RULES_VERSION },
    [root]: { name: "First Hotel", timeZone: "Europe/Brussels" },
    [`${root}/suppliers/dairy`]: { name: "Dairy Company", active: true, credentials: "never expose" },
    [`${root}/settings/catalog/categories/food`]: { name: "Food" }, [`${root}/settings/catalog/categories/drinks`]: { name: "Drinks" },
    [`${root}/settings/catalog/subcategories/dairy`]: { name: "Dairy", categoryId: "food" },
    [`${root}/settings/catalog/subcategories/water`]: { name: "Water", categoryId: "drinks" },
  }); return { firestore, auth, now };
}
const catalog = (patch = {}) => ({ name: "Milk", brand: "Campina", category: "Food", subcategory: "Dairy", baseUnit: "l", active: true, inventoryTracked: true, ...patch });
const offer = (patch = {}) => ({ supplierId: "dairy", supplierSku: "MILK6", supplierProductName: "Milk six pack", currency: "EUR", pricingModel: "Per Purchase Unit", pricePerPurchaseUnit: 12,
  baseUnit: "l", purchaseUnit: "Case", baseUnitsPerPurchaseUnit: 6, active: true, priceBasis: "net", ...patch });
const source = { label: "Supplier price list", documentDate: "2026-10-15" };
const catalogRow = (patch = {}) => ({ rowId: "catalog-milk", kind: "catalog", action: "create", product: catalog(), ...patch });
const supplierRow = (patch = {}) => ({ rowId: "offer-one", kind: "supplier", action: "create", product: offer(), catalogRowId: "catalog-milk", ...patch });
const propose = (services, rows = [catalogRow(), supplierRow()], patch = {}) => stage(request({ hotelUid, requestId: "stage-1", source, rows, ...patch }), services);
const act = (services, batch, patch = {}) => review(request({ hotelUid, batchId: batch.batchId, requestId: "approve-1", expectedRevision: batch.revision, action: "approve", ...patch }), services);
const products = (services, collection) => [...services.firestore.records.entries()].filter(([path]) => path.startsWith(`${root}/${collection}/`));

test("staging is durable and owner-private, validates existing taxonomy names, and never activates products", async () => {
  const services = fixture(), batch = await propose(services);
  const { schemas } = require("./hotelMcpTools");
  assert.deepEqual(schemas.batch.parse(batch), batch);
  assert.equal(batch.summary.ready, 2); assert.equal(batch.revision, 1);
  assert.equal(products(services, "catalogproducts").length, 0); assert.equal(products(services, "supplierproducts").length, 0);
  assert.deepEqual(await read(request({ hotelUid, batchId: batch.batchId }), services), batch);
  assert.deepEqual(await propose(services), batch);
  await assert.rejects(propose(services, [catalogRow({ product: catalog({ name: "Changed" }) })]), { code: "already-exists" });
  await assert.rejects(read(request({ hotelUid, batchId: batch.batchId }, "other"), services), { code: "permission-denied" });
  assert.equal(JSON.stringify(batch).includes("never expose"), false);
  assert.equal(JSON.stringify(batch).includes("originalFingerprint"), false);
  assert.equal(JSON.stringify(batch).includes("basePolicyVersion"), false);
});

test("existing name-only taxonomy permits valid categories and blocks unknown names and invalid child relationships", async () => {
  const services = fixture(), batch = await propose(services, [catalogRow({ product: catalog({ category: "Unknown", subcategory: "Dairy" }) }),
    catalogRow({ rowId: "wrong-child", product: catalog({ subcategory: "Water" }) }), catalogRow({ rowId: "unknown", product: catalog({ category: "", subcategory: "" }) })]);
  assert.equal(batch.rows[0].status, "invalid"); assert.equal(batch.rows[1].status, "invalid"); assert.equal(batch.rows[2].status, "ready");
  assert.equal(batch.rows[0].issues.some((entry) => entry.code === "category-unavailable"), true);
  assert.equal(batch.rows[1].issues.some((entry) => entry.code === "subcategory-unavailable"), true);
  assert.equal(batch.rows[2].issues.some((entry) => entry.code === "classification-unknown" && entry.severity === "warning"), true);
});

test("approval uses protected SKU reservations and actual catalog IDs for multiple supplier dependencies in source-independent order", async () => {
  const services = fixture(), batch = await propose(services, [supplierRow(), supplierRow({ rowId: "offer-two", product: offer({ supplierSku: "MILK12", baseUnitsPerPurchaseUnit: 12 }) }), catalogRow()]);
  const applied = await act(services, batch);
  assert.equal(applied.status, "completed"); assert.equal(applied.summary.applied, 3);
  const createdCatalog = applied.rows.find((row) => row.kind === "catalog");
  assert.equal(createdCatalog.result.internalSku, "CAT-000001");
  assert.equal(products(services, "catalogproducts").length, 1); assert.equal(products(services, "supplierproducts").length, 2);
  for (const [, supplier] of products(services, "supplierproducts")) assert.equal(supplier.catalogProductId, createdCatalog.result.productId);
  const before = JSON.stringify([...services.firestore.records]);
  assert.deepEqual(await act(services, batch), applied);
  assert.equal(JSON.stringify([...services.firestore.records]), before);
  await assert.rejects(act(services, batch, { rowIds: ["offer-one"] }), { code: "already-exists" });
});

test("partial rows, exact retry and a fresh-browser pending command resume without duplicate product or SKU writes", async () => {
  const services = fixture(), batch = await propose(services);
  let interrupted = false;
  const rowIds = ["offer-one", "catalog-milk"];
  await assert.rejects(act({ ...services, afterRow: async (id) => { if (id === "catalog-milk" && !interrupted) { interrupted = true; throw new Error("Interrupted after committed catalog"); } } }, batch, { rowIds }), /Interrupted/);
  const pending = await read(request({ hotelUid, batchId: batch.batchId }), services);
  assert.equal(pending.processing, true); assert.equal(pending.summary.applied, 1); assert.equal(pending.pendingReview.requestId, "approve-1");
  assert.deepEqual(pending.pendingReview.rowIds, ["offer-one", "catalog-milk"]);
  assert.deepEqual(require("./hotelMcpTools").schemas.batch.parse(pending), pending);
  const result = await review(request(pending.pendingReview), services);
  assert.equal(result.processing, false); assert.equal(result.pendingReview, null); assert.equal(result.summary.applied, 2);
  assert.equal(products(services, "catalogproducts").length, 1); assert.equal(products(services, "supplierproducts").length, 1);
  assert.equal(products(services, "catalogSkuKeys").length, 1);
});

test("current identity, hotel permissions and subscription are rechecked on stage, apply and exact replay", async () => {
  const services = fixture(), batch = await propose(services);
  await assert.rejects(propose(services, [catalogRow()], { hotelUid: "hotel-b" }), { code: "permission-denied" });
  services.firestore.records.set(`${root}/members/${uid}`, { permissions: ["catalogproducts.read", "supplierproducts.read", "suppliers.read"] });
  await assert.rejects(act(services, batch), { code: "permission-denied" });
  await assert.rejects(propose(services), { code: "permission-denied" });
  services.firestore.records.set(`${root}/members/${uid}`, { permissions });
  await assert.rejects(act({ ...services, auth: { getUser: async () => ({ uid, disabled: true, emailVerified: true }) } }, batch), { code: "permission-denied" });
  services.firestore.records.set(`hotelSubscriptions/${hotelUid}`, { status: "active", modules: ["frontoffice"], modulePolicyVersion: 1 });
  await assert.rejects(act(services, batch), { code: "permission-denied" });
  services.firestore.records.set(`hotelSubscriptions/${hotelUid}`, { status: "active", modules: ["procurement"], modulePolicyVersion: 1 });
  await act(services, batch);
  services.firestore.records.delete(`${root}/members/${uid}`);
  await assert.rejects(act(services, batch), { code: "permission-denied" });
});

test("mid-batch account revocation blocks later rows and exact authorized recovery resumes after access is restored", async () => {
  const services = fixture(), batch = await propose(services); let disabled = false;
  const dynamic = { ...services, auth: { getUser: async () => ({ uid, disabled, emailVerified: true }) }, afterRow: async () => { disabled = true; } };
  await assert.rejects(act(dynamic, batch), { code: "permission-denied" });
  assert.equal(products(services, "catalogproducts").length, 1); assert.equal(products(services, "supplierproducts").length, 0);
  const recovered = await act(services, batch); assert.equal(recovered.summary.applied, 2);
});

test("supplier-only users can stage, list and approve unlinked offers without unrelated catalog access", async () => {
  const services = fixture();
  services.firestore.records.set(`${root}/members/${uid}`, { permissions: ["supplierproducts.read", "supplierproducts.create", "suppliers.read"] });
  const batch = await propose(services, [supplierRow({ catalogRowId: undefined })]);
  const listed = await list(request({ hotelUid }), services); assert.equal(listed.batches.length, 1);
  assert.equal((await read(request({ hotelUid, batchId: batch.batchId }), services)).batchId, batch.batchId);
  assert.equal((await act(services, batch)).summary.applied, 1);
});

test("foreign supplier/catalog IDs, incompatible dimensions and nonexistent same-batch dependencies remain invalid", async () => {
  const services = fixture(); services.firestore.records.set("hotels/hotel-b/suppliers/foreign", { name: "Foreign" });
  services.firestore.records.set("hotels/hotel-b/catalogproducts/foreign", catalog());
  const batch = await propose(services, [supplierRow({ catalogRowId: null, product: offer({ supplierId: "foreign" }) }),
    supplierRow({ rowId: "foreign-catalog", catalogRowId: null, product: offer({ catalogProductId: "foreign", supplierSku: "foreign" }) }),
    supplierRow({ rowId: "missing-parent", catalogRowId: "not-a-row", product: offer({ supplierSku: "missing" }) }),
    supplierRow({ rowId: "bad-unit", product: offer({ baseUnit: "kg", supplierSku: "mass" }) }), catalogRow()]);
  assert.equal(batch.summary.invalid, 4);
  const applied = await act(services, batch); assert.equal(applied.summary.applied, 1); assert.equal(products(services, "supplierproducts").length, 0);
});

test("corrections replace the patch, retain immutable originals/source, and skip blocks dependent offers", async () => {
  const services = fixture(), batch = await propose(services);
  const sourceBefore = structuredClone(batch.source);
  const corrected = await act(services, batch, { requestId: "correct-1", action: "correct", corrections: [{ rowId: "catalog-milk", product: catalog({ name: "Milk for hotel" }) }] });
  assert.equal(corrected.rows[0].proposed.name, "Milk for hotel"); assert.deepEqual(corrected.source, sourceBefore); assert.equal(corrected.rows[0].original, null);
  const stored = services.firestore.records.get(`${root}/hotelMcpProposalBatches/${batch.batchId}`);
  assert.equal(stored.originalRows[0].patch.name, "Milk");
  const skipped = await act(services, corrected, { requestId: "skip", action: "skip", rowIds: ["catalog-milk"] });
  assert.equal(skipped.rows[0].status, "skipped"); assert.equal(skipped.rows[1].status, "invalid");
  assert.equal((await act(services, skipped, { requestId: "approve-dependent", rowIds: ["offer-one"] })).rows[1].result, null);
});

test("update omission preserves optional package and price data; explicit clearing is visible and historical records remain untouched", async () => {
  const services = fixture();
  const created = await mutateSupplier(request({ hotelUid, requestId: "initial", expectedRevision: 0, action: "create", product: offer({ brand: "Campina", catalogProductId: null,
    gtin: "4006381333931", priceValidFrom: "2026-01-01", purchaseOptions: [{ id: "small", purchaseUnit: "Bottle", baseUnitsPerPurchaseUnit: 1, pricePerPurchaseUnit: 2, gtin: "4006381333931" }] }) }), services);
  services.firestore.records.set(`${root}/orders/historical`, { items: [{ supplierProductId: created.productId, pricePerPurchaseUnit: 12 }] });
  services.firestore.records.set(`${root}/stockCounts/frozen`, { items: [{ supplierProductId: created.productId, quantity: 4, pricePerPurchaseUnit: 12 }] });
  const batch = await propose(services, [supplierRow({ catalogRowId: null, action: "update", productId: created.productId, expectedRevision: 1, product: { supplierProductName: "New description", brand: "" } })]);
  assert.equal(batch.rows[0].original.brand, "Campina"); assert.equal(batch.rows[0].proposed.brand, "");
  const applied = await act(services, batch); assert.equal(applied.summary.applied, 1);
  const current = services.firestore.records.get(`${root}/supplierproducts/${created.productId}`);
  assert.equal(current.brand, ""); assert.equal(current.pricePerPurchaseUnit, 12); assert.equal(current.gtin, "4006381333931");
  assert.equal(current.priceValidFrom, "2026-01-01"); assert.equal(current.purchaseOptions[0].id, "small");
  assert.equal(services.firestore.records.get(`${root}/orders/historical`).items[0].pricePerPurchaseUnit, 12);
  assert.equal(services.firestore.records.get(`${root}/stockCounts/frozen`).items[0].quantity, 4);
  const confirmations = [...services.firestore.records.keys()].filter((key) => key.includes("/supplierPriceConfirmations/")); assert.equal(confirmations.length, 1, "name-only source does not confirm old prices");
});

test("changed product conflicts require explicit current revision acknowledgement and preserve the original snapshot", async () => {
  const services = fixture(); services.firestore.records.set(`${root}/catalogproducts/milk`, { ...catalog(), revision: 1, productPolicyVersion: 1 });
  const batch = await propose(services, [catalogRow({ action: "update", productId: "milk", expectedRevision: 1, product: { name: "Proposed name" } })]);
  services.firestore.records.set(`${root}/catalogproducts/milk`, { ...catalog({ name: "Concurrent name", notes: "Concurrent correction" }), revision: 2, productPolicyVersion: 1 });
  const conflict = await act(services, batch); assert.equal(conflict.rows[0].status, "conflict"); assert.equal(conflict.rows[0].currentRevision, 2);
  await assert.rejects(act(services, conflict, { requestId: "bad-rebase", action: "correct", corrections: [{ rowId: "catalog-milk", product: { name: "Reviewed name" }, expectedRevision: 2 }] }), (error) => error.code === "aborted" && error.details.productProposalRequestUncommitted === true);
  const corrected = await act(services, conflict, { requestId: "rebase", action: "correct", corrections: [{ rowId: "catalog-milk", product: { name: "Reviewed name" }, expectedRevision: 2, acknowledgeCurrent: true }] });
  assert.equal(corrected.rows[0].original.name, "Milk"); assert.equal(corrected.rows[0].proposed.notes, "Concurrent correction");
  const applied = await act(services, corrected, { requestId: "reviewed-apply" }); assert.equal(applied.rows[0].result.revision, 3);
  assert.equal(services.firestore.records.get(`${root}/catalogproducts/milk`).name, "Reviewed name");
});

test("MCP cannot approve itself and injected backend fields or media URLs cannot enter proposals", async () => {
  const services = fixture(), batch = await propose(services);
  const approval = request({ hotelUid, batchId: batch.batchId, requestId: "ai-approve", expectedRevision: 1, action: "approve" });
  approval.mcpAuth = { scopes: ["hotel-toolkit:read", "hotel-toolkit:propose"], assertActive: async () => {} };
  await assert.rejects(review(approval, services), { code: "permission-denied" });
  for (const field of ["internalSku", "createdBy", "revision", "imageUrl"]) await assert.rejects(propose(services, [catalogRow({ product: catalog({ [field]: "injected" }) })], { requestId: `inject-${field}` }), { code: "invalid-argument" });
  assert.equal(products(services, "catalogproducts").length, 0);
});

test("bounded batches and owner-filtered pagination cannot mix hotel or requester data", async () => {
  const services = fixture();
  await propose(services, [catalogRow()], { requestId: "one" }); await propose(services, [catalogRow()], { requestId: "two" });
  await stage(request({ hotelUid, requestId: "other-private", source, rows: [catalogRow()] }, "other"), services);
  const first = await list(request({ hotelUid, limit: 1 }), services); assert.equal(first.batches.length, 1); assert.ok(first.nextCursor);
  const second = await list(request({ hotelUid, limit: 1, cursor: first.nextCursor }), services); assert.equal(second.batches.length, 1); assert.equal(second.nextCursor, null);
  assert.notEqual(first.batches[0].batchId, second.batches[0].batchId);
  await assert.rejects(propose(services, Array.from({ length: 26 }, (_, index) => catalogRow({ rowId: `r-${index}` }))), /25 products/);
  await assert.rejects(list(request({ hotelUid: "hotel-b" }), services), { code: "permission-denied" });
});

test("proposal listing reports missing indexes only after access checks and preserves batches for recovery", async () => {
  const services = fixture(), batch = await propose(services, [catalogRow()]);
  const before = JSON.stringify([...services.firestore.records]);
  const runTransaction = services.firestore.runTransaction.bind(services.firestore);
  let queryFailure = Object.assign(new Error("9 FAILED_PRECONDITION: The query requires an index. https://console.firebase.google.com/private-hotel"), { code: 9 }), queries = 0;
  services.firestore.runTransaction = (callback) => runTransaction((transaction) => {
    const get = transaction.get;
    transaction.get = async (reference) => {
      if (reference.isQuery) { queries += 1; if (queryFailure) throw queryFailure; }
      return get(reference);
    };
    return callback(transaction);
  });
  await assert.rejects(list(request({ hotelUid, limit: 1 }), services), (error) => {
    assert.equal(error.code, "failed-precondition");
    assert.deepEqual(error.details, { reason: "mcp-index-required", area: "proposals", indexKey: "hotelMcpProposalBatches" });
    assert.equal(error.message.includes("private-hotel"), false);
    return true;
  });
  assert.equal(queries, 1); assert.equal(JSON.stringify([...services.firestore.records]), before);
  await assert.rejects(list(request({ hotelUid: "hotel-b" }), services), { code: "permission-denied" });
  assert.equal(queries, 1);
  queryFailure = null;
  const recovered = await list(request({ hotelUid, limit: 1 }), services);
  assert.deepEqual(recovered.batches.map((item) => item.batchId), [batch.batchId]);
  assert.equal(recovered.nextCursor, null); assert.equal(JSON.stringify([...services.firestore.records]), before);
  queryFailure = Object.assign(new Error("The database is not in the required state."), { code: 9 });
  await assert.rejects(list(request({ hotelUid }), services), (error) => error === queryFailure);
  queryFailure = Object.assign(new Error("Permission denied."), { code: 7 });
  await assert.rejects(list(request({ hotelUid }), services), (error) => error === queryFailure);
});

test("mapping references are verified for this supplier and source format without importing credentials or applying another source's rules", async () => {
  const services = fixture();
  services.firestore.records.set(`${root}/supplierImportMappingProfiles/mapping`, { version: 1, supplierId: "dairy", sourceFormat: "csv", profileId: "default", revision: 1, mappings: [] });
  const batch = await propose(services, [supplierRow({ catalogRowId: null })], { source: { ...source, mappingId: "mapping", sourceFormat: "csv" } });
  assert.equal(batch.summary.ready, 1);
  await assert.rejects(propose(services, [supplierRow({ catalogRowId: null })], { requestId: "mismatch", source: { ...source, mappingId: "mapping", sourceFormat: "xlsx" } }), /does not match/);
});

test("selected review actions do not require write authority for unrelated rows", async () => {
  const services = fixture(); services.firestore.records.set(`${root}/catalogproducts/existing`, { ...catalog(), revision: 1, productPolicyVersion: 1 });
  const batch = await propose(services, [catalogRow(), catalogRow({ rowId: "update", action: "update", productId: "existing", expectedRevision: 1, product: { name: "Changed" } })]);
  services.firestore.records.set(`${root}/members/${uid}`, { permissions: ["catalogproducts.read", "catalogproducts.create"] });
  const applied = await act(services, batch, { rowIds: ["catalog-milk"] });
  assert.equal(applied.summary.applied, 1); assert.equal(applied.rows.find((row) => row.rowId === "update").status, "ready");
  await assert.rejects(act(services, applied, { requestId: "forbidden-update", rowIds: ["update"] }), (error) => error.code === "permission-denied" && !error.details?.productProposalRequestUncommitted);
});

test("newest-first listing skips revoked product visibility while retaining a bounded next cursor", async () => {
  const services = fixture();
  const older = await propose({ ...services, now: () => 100 }, [catalogRow()], { requestId: "older" });
  await propose({ ...services, now: () => 200 }, [supplierRow({ catalogRowId: null })], { requestId: "newest-private-supplier" });
  services.firestore.records.set(`${root}/members/${uid}`, { permissions: ["catalogproducts.read", "catalogproducts.create"] });
  const first = await list(request({ hotelUid, limit: 1 }), services);
  assert.deepEqual(first.batches, []); assert.ok(first.nextCursor);
  const second = await list(request({ hotelUid, limit: 1, cursor: first.nextCursor }), services);
  assert.equal(second.batches[0].batchId, older.batchId); assert.equal(second.nextCursor, null);
  assert.deepEqual(require("./hotelMcpTools").schemas.batchSummary.parse(second.batches[0]), second.batches[0]);
});

test("unchanged explicitly supplied prices create a fresh confirmation while descriptive updates do not", async () => {
  const services = fixture(), initial = await mutateSupplier(request({ hotelUid, requestId: "initial", expectedRevision: 0, action: "create", product: offer({ catalogProductId: null }) }), services);
  const batch = await propose(services, [supplierRow({ catalogRowId: null, action: "update", productId: initial.productId, expectedRevision: 1, product: { pricePerPurchaseUnit: 12 } })]);
  assert.equal(batch.rows[0].status, "unchanged");
  const applied = await act(services, batch); assert.equal(applied.rows[0].result.revision, 2);
  const confirmations = [...services.firestore.records.values()].filter((value) => value.sourceImportId === batch.batchId && value.confirmedOptionIds?.includes("default"));
  assert.ok(confirmations.length > 0);
  const value = services.firestore.records.get(`${root}/supplierproducts/${initial.productId}`); assert.equal(value.pricePerPurchaseUnit, 12);
});

test("mapping changes block supplier approval until explicit correction and retain original provenance", async () => {
  const services = fixture(), path = `${root}/supplierImportMappingProfiles/mapping`;
  services.firestore.records.set(path, { version: 1, supplierId: "dairy", sourceFormat: "txt", profileId: "default", revision: 1, mappings: [] });
  const batch = await propose(services, [supplierRow(), catalogRow()], { source: { ...source, mappingId: "mapping", sourceFormat: "txt" } });
  services.firestore.records.set(path, { ...services.firestore.records.get(path), revision: 2, mappings: [{ sourceUnit: "CS", purchaseUnit: "Case" }] });
  const partial = await act(services, batch); assert.equal(partial.summary.applied, 1);
  assert.equal(partial.rows.find((row) => row.kind === "supplier").issues.some((entry) => entry.code === "mapping-profile-changed"), true);
  const corrected = await act(services, partial, { requestId: "review-new-mapping", action: "correct", corrections: [{ rowId: "offer-one", product: offer() }] });
  const complete = await act(services, corrected, { requestId: "approve-corrected" }); assert.equal(complete.summary.applied, 2);
  const stored = services.firestore.records.get(`${root}/hotelMcpProposalBatches/${batch.batchId}`); assert.equal(stored.mappingEvidence.revision, 1);
});

test("a linked catalog identity changed after staging requires a fresh explicit selection review", async () => {
  const services = fixture(); services.firestore.records.set(`${root}/catalogproducts/existing`, { ...catalog(), revision: 1, productPolicyVersion: 1 });
  const batch = await propose(services, [supplierRow({ catalogRowId: null, product: offer({ catalogProductId: "existing" }) })]);
  services.firestore.records.set(`${root}/catalogproducts/existing`, { ...catalog({ brand: "Different brand" }), revision: 2, productPolicyVersion: 1 });
  const blocked = await act(services, batch); assert.equal(blocked.summary.applied, 0);
  assert.equal(blocked.rows[0].issues.some((entry) => entry.code === "catalog-reference-conflict"), true);
  const corrected = await act(services, blocked, { requestId: "review-target", action: "correct", corrections: [{ rowId: "offer-one", product: offer({ catalogProductId: "existing" }) }] });
  assert.equal((await act(services, corrected, { requestId: "apply-target" })).summary.applied, 1);
});

test("partial package updates preserve omitted option IDs and prices while explicit empty options deliberately clear all", async () => {
  const services = fixture();
  const originalOptions = [{ id: "bottle", purchaseUnit: "Bottle", baseUnitsPerPurchaseUnit: 1, pricePerPurchaseUnit: 2, gtin: "4006381333931" },
    { id: "large", purchaseUnit: "Case", baseUnitsPerPurchaseUnit: 12, pricePerPurchaseUnit: 22, gtin: null }];
  const initial = await mutateSupplier(request({ hotelUid, requestId: "initial-options", expectedRevision: 0, action: "create", product: offer({ catalogProductId: null, purchaseOptions: originalOptions }) }), services);
  const patch = { purchaseOptions: [{ id: "bottle", purchaseUnit: "Single bottle" }] };
  const batch = await propose(services, [supplierRow({ catalogRowId: null, action: "update", productId: initial.productId, expectedRevision: 1, product: patch })]);
  const updatedOptions = batch.rows[0].proposed.purchaseOptions;
  assert.equal(updatedOptions.length, 2);
  assert.deepEqual(updatedOptions.find((option) => option.id === "bottle"), { ...originalOptions[0], purchaseUnit: "Single bottle" });
  assert.deepEqual(updatedOptions.find((option) => option.id === "large"), originalOptions[1]);
  const applied = await act(services, batch);
  assert.equal(applied.summary.applied, 1);
  const stored = services.firestore.records.get(`${root}/supplierproducts/${initial.productId}`);
  assert.deepEqual(stored.purchaseOptions, updatedOptions);
  assert.equal([...services.firestore.records.keys()].filter((key) => key.includes("/supplierPriceConfirmations/")).length, 1, "omitted package prices are not re-confirmed");
  const provenance = services.firestore.records.get(`${root}/hotelMcpProposalBatches/${batch.batchId}`);
  assert.deepEqual(provenance.originalRows[0].patch, patch);
  assert.deepEqual(provenance.rows[0].original.purchaseOptions, originalOptions);
  await assert.rejects(propose(services, [supplierRow({ catalogRowId: null, action: "update", productId: initial.productId, expectedRevision: 2,
    product: { purchaseOptions: [{ id: "bottle", purchaseUnit: "One" }, { id: "bottle", purchaseUnit: "Two" }] } })], { requestId: "duplicate-option-ids" }), { code: "invalid-argument" });

  const clearing = await propose(services, [supplierRow({ catalogRowId: null, action: "update", productId: initial.productId, expectedRevision: 2, product: { purchaseOptions: [] } })], { requestId: "clear-options" });
  assert.deepEqual(clearing.rows[0].proposed.purchaseOptions, []);
  assert.equal((await act(services, clearing, { requestId: "approve-clear" })).summary.applied, 1);
  assert.deepEqual(services.firestore.records.get(`${root}/supplierproducts/${initial.productId}`).purchaseOptions, []);
});

test("native invalid corrections remain readable as validation issues through the strict MCP batch contract", async () => {
  const services = fixture(), batch = await propose(services);
  const corrected = await act(services, batch, { requestId: "invalid-review", action: "correct", corrections: [
    { rowId: "catalog-milk", product: catalog({ baseUnit: "bottle" }) },
    { rowId: "offer-one", product: offer({ pricePerPurchaseUnit: "abc" }) },
  ] });
  assert.equal(corrected.summary.invalid, 2);
  const loaded = await read(request({ hotelUid, batchId: batch.batchId }), services);
  assert.deepEqual(require("./hotelMcpTools").schemas.batch.parse(loaded), loaded);
  assert.equal(loaded.rows[0].patch.baseUnit, "bottle"); assert.equal(loaded.rows[1].proposed.pricePerPurchaseUnit, "abc");
  assert.equal(loaded.rows.every((row) => row.issues.some((entry) => entry.code === "product-invalid")), true);
  assert.equal(products(services, "catalogproducts").length, 0); assert.equal(products(services, "supplierproducts").length, 0);
});

test("source field nesting is bounded before persistence without counting request wrappers against the field limit", async () => {
  const nested = (depth) => { let value = "invalid source value"; for (let index = 0; index < depth; index++) value = { child: value }; return value; };
  const services = fixture();
  const batch = await propose(services, [catalogRow({ product: catalog({ notes: nested(16) }) })]);
  assert.equal(batch.rows[0].status, "invalid");
  assert.deepEqual(require("./hotelMcpTools").schemas.batch.parse(batch), batch);
  const before = JSON.stringify([...services.firestore.records]);
  await assert.rejects(propose(services, [catalogRow({ product: catalog({ notes: nested(17) }) })], { requestId: "too-deep-stage" }), (error) => error.code === "invalid-argument" && /nesting/.test(error.message));
  await assert.rejects(act(services, batch, { requestId: "too-deep-correction", action: "correct", corrections: [{ rowId: "catalog-milk", product: catalog({ notes: nested(17) }) }] }), (error) => error.code === "invalid-argument" && error.details?.productProposalRequestUncommitted === true);
  assert.equal(JSON.stringify([...services.firestore.records]), before);
});

test("public proposal snapshots filter nested package metadata while retaining immutable original evidence", async () => {
  const services = fixture(), id = "existing-offer", storedOption = { id: "bottle", purchaseUnit: "Bottle", baseUnitsPerPurchaseUnit: 1, pricePerPurchaseUnit: 2, gtin: null,
    privateSupplierMetadata: { credential: "never expose nested metadata" } };
  services.firestore.records.set(`${root}/supplierproducts/${id}`, { ...offer({ catalogProductId: null, purchaseOptions: [storedOption] }), revision: 1, productPolicyVersion: 1 });
  const batch = await propose(services, [supplierRow({ catalogRowId: null, action: "update", productId: id, expectedRevision: 1, product: { supplierProductName: "New label" } })]);
  const before = services.firestore.records.get(`${root}/hotelMcpProposalBatches/${batch.batchId}`);
  assert.deepEqual(before.rows[0].original.purchaseOptions[0], storedOption);
  assert.equal(JSON.stringify(batch).includes("never expose nested metadata"), false);
  assert.equal(Object.hasOwn(batch.rows[0].original.purchaseOptions[0], "privateSupplierMetadata"), false);
  assert.deepEqual(require("./hotelMcpTools").schemas.batch.parse(batch), batch);
  services.firestore.records.set(`${root}/supplierproducts/${id}`, { ...services.firestore.records.get(`${root}/supplierproducts/${id}`), brand: "Concurrent change", revision: 2 });
  const conflict = await act(services, batch);
  assert.equal(conflict.rows[0].status, "conflict");
  const loaded = await read(request({ hotelUid, batchId: batch.batchId }), services);
  assert.equal(JSON.stringify(loaded).includes("never expose nested metadata"), false);
  assert.equal(Object.hasOwn(loaded.rows[0].current.purchaseOptions[0], "privateSupplierMetadata"), false);
  assert.deepEqual(require("./hotelMcpTools").schemas.batch.parse(loaded), loaded);
  assert.deepEqual(services.firestore.records.get(`${root}/hotelMcpProposalBatches/${batch.batchId}`).rows[0].original.purchaseOptions[0], storedOption);
});
