const test = require("node:test");
const assert = require("node:assert/strict");
const sync = require("./catalogSync");
const policy = require("./productPolicy");
const { SAAS_RULES_VERSION } = require("./saasRollout");

function database(initial = {}) {
  const records = new Map(Object.entries(initial)), snapshot = (path) => ({ id: path.split("/").at(-1), exists: records.has(path), data: () => structuredClone(records.get(path)) });
  let serial = Promise.resolve();
  const db = { records, doc: (path) => ({ path, get: async () => snapshot(path) }), collection(path) {
    const query = (filters = [], maximum = Infinity, cursor = null, selected = null) => ({ isQuery: true,
      where: (field, op, expected) => { assert.equal(op, "=="); return query([...filters, [field, expected]], maximum, cursor, selected); },
      orderBy: () => query(filters, maximum, cursor, selected), startAfter: (value) => query(filters, maximum, value, selected),
      limit: (value) => query(filters, value, cursor, selected), select: (...fields) => query(filters, maximum, cursor, fields),
      get: async () => {
        const entries = [...records.entries()].filter(([key, value]) => key.startsWith(path + "/") && key.slice(path.length + 1).split("/").length === 1
          && (!cursor || key.split("/").at(-1) > cursor) && filters.every(([field, expected]) => value[field] === expected)).sort(([left], [right]) => left.localeCompare(right)).slice(0, maximum);
        const docs = entries.map(([key, value]) => ({ ...snapshot(key), data: () => {
          if (!selected) return structuredClone(value);
          const result = {};
          for (const field of selected) {
            const parts = field.split("."), found = parts.reduce((current, part) => current?.[part], value);
            if (found === undefined) continue;
            let output = result;
            for (const part of parts.slice(0, -1)) output = output[part] || (output[part] = {});
            output[parts.at(-1)] = found;
          }
          return structuredClone(result);
        } }));
        return { docs, size: docs.length, empty: !docs.length };
      } });
    return query();
  }, runTransaction(fn) {
    const next = serial.then(async () => {
      const writes = [], tx = { get: async (ref) => { assert.equal(writes.length, 0, "Every transactional read must precede product writes"); return ref.isQuery ? ref.get() : snapshot(ref.path); },
        set: (ref, value) => writes.push(["set", ref.path, value]), create: (ref, value) => writes.push(["create", ref.path, value]), update: (ref, value) => writes.push(["update", ref.path, value]) };
      const result = await fn(tx);
      for (const [kind, path, value] of writes) {
        if (kind === "create") assert.equal(records.has(path), false, `${path} is immutable evidence`);
        if (kind === "update") assert.equal(records.has(path), true);
        records.set(path, kind === "update" ? { ...records.get(path), ...value } : value);
      }
      if (db.afterCommit) await db.afterCommit(writes);
      return result;
    }); serial = next.catch(() => {}); return next;
  } };
  return db;
}
const hotelUid = "hotel-a", uid = "buyer", supplierId = "dairy";
const permissions = ["supplierproducts.read", "supplierproducts.update", "catalogproducts.read", "catalogproducts.create", "suppliers.read"];
const auth = { getUser: async (actor) => ({ uid: actor, emailVerified: true, disabled: false }) };
const request = (data, actorUid = uid) => ({ auth: { uid: actorUid, token: { email_verified: true, auth_time: 100000 } }, data });
const services = (db, override = {}) => ({ firestore: db, auth, ...override });
function offer(patch = {}) {
  return { ...policy.normalizeSupplierProduct({ supplierId, supplierSku: "MILK6", supplierProductName: "Milk six pack", currency: "EUR", pricingModel: "Per Purchase Unit",
    pricePerPurchaseUnit: 12, purchaseUnit: "Case", baseUnit: "l", baseUnitsPerPurchaseUnit: 6, priceBasis: "net", vatRate: null,
    active: true, catalogProductId: null, purchaseOptions: [{ id: "single", purchaseUnit: "Bottle", baseUnitsPerPurchaseUnit: 1, pricePerPurchaseUnit: 2 }], ...patch }),
    revision: 3, priceConfirmedOn: "original-confirmation", priceUpdatedOn: "original-price-change", latestApprovedPriceVersionId: "0000000000000003",
    currentPriceVersionId: "0000000000000003", priceOptionReliability: { default: { sourceReference: "Original source" } },
    image: { status: "ready", assetId: "original-image" }, localAdjustment: { invoiceReference: "keep-this-local-field" } };
}
function catalog(patch = {}) {
  return { ...policy.normalizeCatalogProduct({ name: "Milk", baseUnit: "l", active: true, inventoryTracked: true, allergens: [], ...patch }), revision: 2 };
}
function fixture(patch = {}) {
  const db = database({ [`hotels/${hotelUid}/members/${uid}`]: { permissions }, [`hotelSubscriptions/${hotelUid}`]: { status: "active", modules: ["procurement"], modulePolicyVersion: 1 },
    "platformConfiguration/saasProcurement": { enabled: true, rulesVersion: SAAS_RULES_VERSION }, [`hotels/${hotelUid}/suppliers/${supplierId}`]: { name: "Dairy", active: true },
    [`hotels/${hotelUid}/supplierproducts/milk-6`]: offer(), [`hotels/${hotelUid}/catalogproducts/milk`]: catalog(),
    [`hotels/${hotelUid}/supplierPriceHistory/milk-6/entries/0000000000000003`]: { frozenPrice: 12 },
    [`hotels/${hotelUid}/orders/historic`]: { line: { supplierProductId: "milk-6", catalogProductId: null, price: 12 } },
    [`hotels/${hotelUid}/inventoryMovements/historic`]: { quantity: 6, cost: 12, catalogProductId: null }, ...patch });
  for (const [path, source] of db.records) {
    if (!path.startsWith(`hotels/${hotelUid}/supplierproducts/`) || !source.latestApprovedPriceVersionId) continue;
    const productId = path.split("/").at(-1), versionPath = `hotels/${hotelUid}/supplierPriceVersions/${productId}/entries/${source.latestApprovedPriceVersionId}`;
    if (!db.records.has(versionPath)) db.records.set(versionPath, { supplierPriceVersionPolicyVersion: 1, supplierProductId: productId, supplierId: source.supplierId,
      productTerms: { baseUnit: source.baseUnit, purchaseUnit: source.purchaseUnit, baseUnitsPerPurchaseUnit: source.baseUnitsPerPurchaseUnit, purchaseOptions: source.purchaseOptions,
        pricePerPurchaseUnit: source.pricePerPurchaseUnit }, frozenAgreement: true });
  }
  return db;
}
const preview = (db, patch = {}, actorUid = uid) => sync.readHotelCatalogSyncWorkspaceHandler(request({ hotelUid, requestId: "preview", ...patch }, actorUid), services(db));
const read = (db, jobId, actorUid = uid) => sync.readHotelCatalogSyncWorkspaceHandler(request({ hotelUid, jobId }, actorUid), services(db));
const existingChoice = (row, patch = {}) => ({ rowId: row.rowId, reviewRevision: row.reviewRevision, expectedSupplierRevision: row.expectedSupplierRevision,
  target: { kind: "existing", catalogProductId: "milk", expectedCatalogRevision: 2 }, acknowledged: true, ...patch });
const newChoice = (row, group = "milk", patch = {}) => ({ ...existingChoice(row), target: { kind: "new", createGroupId: group,
  product: { ...row.proposedNewProduct, name: "Milk" } }, ...patch });
const apply = (db, workspace, choices = workspace.rows.map(existingChoice), patch = {}) => sync.applyHotelCatalogSyncHandler(request({ hotelUid, jobId: workspace.jobId, requestId: "apply", choices, ...patch }), services(db));

test("preview freezes a scoped, owner-bound proposal without financial data or product mutations", async () => {
  const db = fixture(), before = JSON.stringify(db.records.get(`hotels/${hotelUid}/supplierproducts/milk-6`));
  db.records.set("hotels/hotel-b/catalogproducts/foreign", catalog({ name: "Foreign milk" }));
  const workspace = await preview(db);
  assert.equal(workspace.rows.length, 1); assert.equal(workspace.rows[0].supplierProductId, "milk-6"); assert.equal(workspace.rows[0].expectedSupplierRevision, 3);
  assert.equal(workspace.rows[0].existingMatches[0].catalogProductId, "milk"); assert.equal(workspace.rows[0].existingMatches[0].expectedCatalogRevision, 2);
  assert.equal(JSON.stringify(workspace).includes("priceConfirmedOn"), false); assert.equal(JSON.stringify(workspace).includes("invoiceReference"), false);
  assert.equal(JSON.stringify(db.records.get(`hotels/${hotelUid}/supplierproducts/milk-6`)), before);
  assert.deepEqual(await preview(db), workspace); assert.deepEqual(await read(db, workspace.jobId), workspace);
  await assert.rejects(preview(db, { supplierId: "other" }), (error) => error.code === "already-exists");
  await assert.rejects(read(db, workspace.jobId, "outsider"), (error) => error.code === "permission-denied");
});

test("existing links preserve every price, confirmation, package, image, local field and historical snapshot", async () => {
  const db = fixture(), before = structuredClone(db.records.get(`hotels/${hotelUid}/supplierproducts/milk-6`));
  const historical = JSON.stringify([...db.records.entries()].filter(([path]) => /supplierPrice|historic/.test(path)));
  const workspace = await preview(db), result = await apply(db, workspace);
  assert.equal(result.outcomes[0].status, "linked"); assert.equal(result.outcomes[0].supplierRevision, 4); assert.equal(result.createdCatalogs.length, 0);
  const current = db.records.get(`hotels/${hotelUid}/supplierproducts/milk-6`);
  const allowed = new Set(["catalogProductId", "revision", "updatedAt", "updatedBy"]);
  for (const field of Object.keys(before)) if (!allowed.has(field)) assert.deepEqual(current[field], before[field], field);
  assert.equal(current.catalogProductId, "milk"); assert.equal(JSON.stringify([...db.records.entries()].filter(([path]) => /supplierPrice|historic/.test(path))), historical);
  assert.deepEqual(await apply(db, workspace), result); assert.equal((await read(db, workspace.jobId)).status, "completed");
});

test("new grouped articles are created and linked atomically with one allocated SKU, including exact response recovery", async () => {
  const db = fixture({ [`hotels/${hotelUid}/supplierproducts/milk-3`]: offer({ supplierSku: "MILK3", supplierProductName: "Milk three pack", baseUnitsPerPurchaseUnit: 3 }) });
  const workspace = await preview(db), choices = workspace.rows.map((row) => newChoice(row));
  let lost = false;
  db.afterCommit = (writes) => { if (!lost && writes.some(([, path]) => path.includes("/catalogSyncOperations/"))) { lost = true; throw new Error("Response lost after commit"); } };
  await assert.rejects(apply(db, workspace, choices), /Response lost/); db.afterCommit = null;
  const recovered = await apply(db, workspace, choices); assert.equal(recovered.createdCatalogs.length, 1);
  assert.equal(recovered.createdCatalogs[0].internalSku, "CAT-000001"); assert.equal(recovered.outcomes[0].catalogProductId, recovered.outcomes[1].catalogProductId);
  assert.equal([...db.records.keys()].filter((path) => path.includes("/catalogSyncOperations/")).length, 1);
  assert.equal([...db.records.keys()].filter((path) => path.includes("/catalogSyncAudit/")).length, 1);
  assert.equal(db.records.get(`hotels/${hotelUid}/catalogSkuConfiguration/settings`).nextNumber, 2);
});

test("distinct article groups share an allocation context and cannot duplicate the automatic counter", async () => {
  const db = fixture({ [`hotels/${hotelUid}/supplierproducts/butter`]: offer({ supplierSku: "BUTTER", supplierProductName: "Butter", baseUnit: "kg", baseUnitsPerPurchaseUnit: 1,
    purchaseOptions: [] }) });
  const workspace = await preview(db), choices = workspace.rows.map((row) => ({ ...newChoice(row, row.rowId), target: { kind: "new", createGroupId: row.rowId, product: row.proposedNewProduct } }));
  const result = await apply(db, workspace, choices);
  assert.equal(result.createdCatalogs.length, 2); assert.deepEqual(result.createdCatalogs.map((record) => record.internalSku), ["CAT-000001", "CAT-000002"]);
  assert.equal(db.records.get(`hotels/${hotelUid}/catalogSkuConfiguration/settings`).nextNumber, 3);
});

test("a reviewed group can link remaining offers in later batches without creating another article", async () => {
  const db = fixture({ [`hotels/${hotelUid}/supplierproducts/milk-3`]: offer({ supplierSku: "MILK3", supplierProductName: "Milk three pack", baseUnitsPerPurchaseUnit: 3 }) });
  const workspace = await preview(db), first = await apply(db, workspace, [newChoice(workspace.rows[0])]);
  assert.equal(first.completed, false);
  const second = await apply(db, workspace, [newChoice(workspace.rows[1])], { requestId: "second-group-batch" });
  assert.equal(second.createdCatalogs.length, 0); assert.equal(second.outcomes[0].catalogProductId, first.outcomes[0].catalogProductId);
  assert.equal(second.outcomes[0].status, "linked"); assert.equal(second.completed, true);
});

test("stale supplier, reviewed proposal and catalog revisions reject the entire command with an explicit no-commit proof", async () => {
  for (const kind of ["supplier", "catalog", "proposal"]) {
    const db = fixture(), workspace = await preview(db);
    const path = kind === "supplier" ? `hotels/${hotelUid}/supplierproducts/milk-6` : kind === "catalog" ? `hotels/${hotelUid}/catalogproducts/milk`
      : `hotels/${hotelUid}/catalogSyncJobs/${workspace.jobId}/rows/${workspace.rows[0].rowId}`;
    db.records.set(path, { ...db.records.get(path), ...(kind === "proposal" ? { reviewRevision: 2 } : { revision: 4 }) });
    await assert.rejects(apply(db, workspace), (error) => error.code === "aborted" && error.details.catalogSyncRequestUncommitted === true);
    assert.equal(db.records.get(`hotels/${hotelUid}/supplierproducts/milk-6`).catalogProductId, null);
    assert.equal([...db.records.keys()].some((record) => record.includes("/catalogSyncOperations/")), false);
  }
});

test("current permissions and active subscriptions are rechecked on successful operation replay", async () => {
  const db = fixture(), workspace = await preview(db), choices = [newChoice(workspace.rows[0])];
  await apply(db, workspace, choices);
  for (const permission of ["supplierproducts.read", "supplierproducts.update", "catalogproducts.read", "catalogproducts.create", "suppliers.read"]) {
    db.records.set(`hotels/${hotelUid}/members/${uid}`, { permissions: permissions.filter((value) => value !== permission) });
    await assert.rejects(apply(db, workspace, choices), (error) => error.code === "permission-denied");
  }
  db.records.set(`hotels/${hotelUid}/members/${uid}`, { permissions });
  db.records.set(`hotelSubscriptions/${hotelUid}`, { status: "suspended", modules: ["procurement"], modulePolicyVersion: 1 });
  await assert.rejects(apply(db, workspace, choices), (error) => error.code === "permission-denied");
});

test("existing-target linking requires no catalog creation permission and never permits a foreign hotel target", async () => {
  const db = fixture(), workspace = await preview(db);
  db.records.set(`hotels/${hotelUid}/members/${uid}`, { permissions: permissions.filter((value) => value !== "catalogproducts.create") });
  db.records.set("hotels/hotel-b/catalogproducts/foreign", catalog());
  await assert.rejects(apply(db, workspace, [existingChoice(workspace.rows[0], { target: { kind: "existing", catalogProductId: "foreign", expectedCatalogRevision: 2 } })]),
    (error) => error.code === "not-found" && error.details.catalogSyncRequestUncommitted === true);
  assert.equal((await apply(db, workspace)).outcomes[0].status, "linked");
});

test("committed applications remain recoverable after preview expiry or removal without allocating another SKU", async () => {
  const db = fixture(), workspace = await preview(db), choices = [newChoice(workspace.rows[0])], result = await apply(db, workspace, choices);
  const jobPath = `hotels/${hotelUid}/catalogSyncJobs/${workspace.jobId}`, job = db.records.get(jobPath);
  db.records.set(jobPath, { ...job, expiresAtMillis: Date.now() - 1 });
  assert.deepEqual(await apply(db, workspace, choices), result); db.records.delete(jobPath);
  assert.deepEqual(await apply(db, workspace, choices), result);
  assert.equal(db.records.get(`hotels/${hotelUid}/catalogSkuConfiguration/settings`).nextNumber, 2);
  const fresh = fixture(), expired = await preview(fresh);
  fresh.records.set(`hotels/${hotelUid}/catalogSyncJobs/${expired.jobId}`, { ...fresh.records.get(`hotels/${hotelUid}/catalogSyncJobs/${expired.jobId}`), expiresAtMillis: Date.now() - 1 });
  await assert.rejects(apply(fresh, expired), (error) => error.code === "failed-precondition" && error.details.catalogSyncRequestUncommitted);
  assert.equal(fresh.records.get(`hotels/${hotelUid}/supplierproducts/milk-6`).catalogProductId, null);
});

test("linked and inactive offers stay untouched while unlinked legacy offers remain visible for physical review", async () => {
  const db = fixture({ [`hotels/${hotelUid}/supplierproducts/linked`]: offer({ catalogProductId: "milk" }),
    [`hotels/${hotelUid}/supplierproducts/inactive`]: { ...offer(), active: false },
    [`hotels/${hotelUid}/supplierproducts/legacy`]: { ...offer(), productPolicyVersion: 0 },
    [`hotels/${hotelUid}/supplierproducts/archived-supplier`]: { ...offer(), supplierId: "old" },
    [`hotels/${hotelUid}/suppliers/old`]: { active: true, archived: true } });
  const workspace = await preview(db); assert.deepEqual(workspace.rows.map((row) => row.supplierProductId), ["legacy", "milk-6"]);
  assert.equal(workspace.rows[0].status, "needs-unit-review"); assert.equal(workspace.rows[0].proposedNewProduct.baseUnit, "");
  db.records.set(`hotels/${hotelUid}/supplierproducts/milk-6`, { ...db.records.get(`hotels/${hotelUid}/supplierproducts/milk-6`), catalogProductId: "another" });
  await assert.rejects(apply(db, workspace, [existingChoice(workspace.rows[1])]), (error) => error.code === "aborted");
});

test("known quality conflicts are denied even with explicit acknowledgement, including generic target articles", async () => {
  const db = fixture({ [`hotels/${hotelUid}/supplierproducts/milk-6`]: offer({ supplierProductName: "Whole milk" }),
    [`hotels/${hotelUid}/supplierproducts/skimmed`]: offer({ supplierSku: "SKIM", supplierProductName: "Skimmed milk" }) });
  const workspace = await preview(db);
  await assert.rejects(apply(db, workspace), (error) => error.code === "failed-precondition" && error.details.catalogSyncRequestUncommitted);
  assert.equal(db.records.get(`hotels/${hotelUid}/supplierproducts/milk-6`).catalogProductId, null);
  const first = workspace.rows.find((row) => row.supplierProductId === "milk-6"), second = workspace.rows.find((row) => row.supplierProductId === "skimmed");
  await apply(db, workspace, [existingChoice(first)], { requestId: "whole-first" });
  await assert.rejects(apply(db, workspace, [existingChoice(second)], { requestId: "skim-second" }), /another offer assigned/);
});

test("generic articles allow explicitly reviewed supplier-brand variation while brand-specific articles remain protected", async () => {
  const db = fixture({ [`hotels/${hotelUid}/supplierproducts/milk-6`]: { ...offer({ supplierProductName: "Campina whole milk" }), brand: "Campina" },
    [`hotels/${hotelUid}/supplierproducts/other-milk`]: { ...offer({ supplierSku: "ARLA", supplierProductName: "Arla whole milk" }), brand: "Arla" },
    [`hotels/${hotelUid}/catalogproducts/milk`]: catalog({ name: "Whole milk" }) });
  const workspace = await preview(db), result = await apply(db, workspace);
  assert.equal(result.outcomes.length, 2);
  const audit = [...db.records.entries()].find(([path]) => path.includes("/catalogSyncAudit/"))[1];
  assert.equal(audit.catalogDefinitions[0].supplierBrandVariationAllowed, true); assert.equal(audit.catalogDefinitions[0].requiredBrand, null);
  const named = fixture({ [`hotels/${hotelUid}/supplierproducts/milk-6`]: { ...offer({ supplierProductName: "Arla whole milk" }), brand: "Arla" },
    [`hotels/${hotelUid}/catalogproducts/milk`]: catalog({ name: "Campina whole milk", brand: "Campina" }) });
  await assert.rejects(apply(named, await preview(named)), (error) => error.code === "failed-precondition" && error.details.catalogSyncRequestUncommitted);
});

test("current and timestamp-only archival flags cannot be bypassed by restored canonical data", async () => {
  for (const kind of ["source", "catalog", "supplier"]) {
    const db = fixture(), workspace = await preview(db), path = kind === "source" ? `hotels/${hotelUid}/supplierproducts/milk-6`
      : kind === "catalog" ? `hotels/${hotelUid}/catalogproducts/milk` : `hotels/${hotelUid}/suppliers/${supplierId}`;
    db.records.set(path, { ...db.records.get(path), archivedAt: "a-restored-archive-time" });
    await assert.rejects(apply(db, workspace), (error) => error.code === "failed-precondition" || error.code === "aborted");
    const next = await preview(db, { requestId: `new-${kind}` });
    if (kind === "catalog") assert.equal(next.rows[0].existingMatches.length, 0); else assert.equal(next.rows.length, 0);
  }
});

test("a corrupt physical supplier contract remains visible for review and cannot link through a canonical flag", async () => {
  for (const patch of [{ baseUnit: "litres" }, { baseUnitsPerPurchaseUnit: null }, { purchaseUnit: "kg", baseUnit: "g", baseUnitsPerPurchaseUnit: 2 },
    { purchaseOptions: [{ id: "same", purchaseUnit: "Bottle", baseUnitsPerPurchaseUnit: 1 }, { id: "same", purchaseUnit: "Bottle", baseUnitsPerPurchaseUnit: 1 }] }]) {
    const db = fixture({ [`hotels/${hotelUid}/supplierproducts/milk-6`]: { ...offer(), ...patch } }), workspace = await preview(db);
    assert.equal(workspace.rows.length, 1); if (patch.baseUnit === "litres" || patch.baseUnitsPerPurchaseUnit === null) assert.equal(workspace.rows[0].status, "needs-unit-review");
    await assert.rejects(apply(db, workspace), (error) => error.code === "failed-precondition" && error.details.catalogSyncRequestUncommitted);
    assert.equal(db.records.get(`hotels/${hotelUid}/supplierproducts/milk-6`).catalogProductId, null);
  }
});

test("approved future packages must also convert exactly; a smaller physical catalog unit remains a valid choice", async () => {
  const powder = offer({ supplierProductName: "Milk powder", supplierSku: "POWDER", baseUnit: "g", baseUnitsPerPurchaseUnit: 1000, purchaseOptions: [] });
  const db = fixture({ [`hotels/${hotelUid}/supplierproducts/milk-6`]: powder,
    [`hotels/${hotelUid}/catalogproducts/milk`]: catalog({ name: "Milk powder", baseUnit: "kg" }),
    [`hotels/${hotelUid}/catalogproducts/powder-grams`]: catalog({ name: "Milk powder", baseUnit: "g" }),
    [`hotels/${hotelUid}/supplierPriceVersions/milk-6/entries/0000000000000004`]: { supplierPriceVersionPolicyVersion: 1, supplierProductId: "milk-6", supplierId,
      productTerms: { baseUnit: "g", purchaseUnit: "Small sachet", baseUnitsPerPurchaseUnit: 0.000001, purchaseOptions: [], priceValidFrom: "2027-01-01", pricePerPurchaseUnit: 999 } } });
  const workspace = await preview(db);
  await assert.rejects(apply(db, workspace, [newChoice(workspace.rows[0])]), (error) => error.code === "failed-precondition" && /scheduled package/.test(error.message));
  assert.equal(db.records.has(`hotels/${hotelUid}/catalogSkuConfiguration/settings`), false);
  const result = await apply(db, workspace, [existingChoice(workspace.rows[0], { target: { kind: "existing", catalogProductId: "powder-grams", expectedCatalogRevision: 2 } })]);
  assert.equal(result.outcomes[0].catalogProductId, "powder-grams");
});

test("frozen matching pools are certificate-checked before model assistance", async () => {
  const db = fixture(), workspace = await preview(db), job = db.records.get(`hotels/${hotelUid}/catalogSyncJobs/${workspace.jobId}`);
  const load = () => db.runTransaction((tx) => sync.catalogSyncInternals.loadMatchingPool(tx, db, hotelUid, workspace.jobId, job));
  assert.equal((await load()).length, 1);
  const path = `hotels/${hotelUid}/catalogSyncJobs/${workspace.jobId}/poolChunks/p-000001`, chunk = db.records.get(path);
  db.records.set(path, { ...chunk, products: [{ ...chunk.products[0], name: "Changed after preview" }] });
  await assert.rejects(load(), /changed after preview/);
});

test("mostly linked source pages find relevant offers within a bounded window and never skip remaining eligible documents", async () => {
  const db = fixture(); db.records.delete(`hotels/${hotelUid}/supplierproducts/milk-6`);
  for (let index = 0; index < 270; index++) db.records.set(`hotels/${hotelUid}/supplierproducts/a-${String(index).padStart(3, "0")}`, offer({ catalogProductId: "milk" }));
  db.records.set(`hotels/${hotelUid}/supplierproducts/a-030`, offer({ supplierSku: "GOOD30" }));
  db.records.set(`hotels/${hotelUid}/supplierproducts/a-031`, { ...offer({ supplierSku: "LEGACY31" }), productPolicyVersion: 0, baseUnit: "litres" });
  const first = await preview(db, { limit: 1 }); assert.equal(first.rows[0].supplierProductId, "a-030"); assert.equal(first.scannedSuppliers, 31); assert.equal(first.nextCursor, "a-030");
  const second = await preview(db, { requestId: "second", cursor: first.nextCursor, limit: 1 }); assert.equal(second.rows[0].supplierProductId, "a-031"); assert.equal(second.rows[0].status, "needs-unit-review");
  const third = await preview(db, { requestId: "third", cursor: second.nextCursor }); assert.equal(third.rows.length, 0); assert.equal(third.scannedSuppliers, 238); assert.equal(third.nextCursor, null);
  const capped = await preview(db, { requestId: "scan-cap", cursor: "a-031" }); assert.equal(capped.scannedSuppliers, 238);
  const large = fixture(); large.records.delete(`hotels/${hotelUid}/supplierproducts/milk-6`);
  for (let index = 0; index < 300; index++) large.records.set(`hotels/${hotelUid}/supplierproducts/a-${String(index).padStart(3, "0")}`, offer({ catalogProductId: "milk" }));
  const empty = await preview(large); assert.equal(empty.rows.length, 0); assert.equal(empty.scannedSuppliers, 250); assert.equal(empty.nextCursor, "a-249");
});

test("invalid supplier references remain editable exceptions without preventing other proposals", async () => {
  const db = fixture({ [`hotels/${hotelUid}/supplierproducts/bad-reference`]: { ...offer(), supplierId: "foreign/hotel/path" } });
  const workspace = await preview(db); assert.equal(workspace.rows.length, 2);
  const invalid = workspace.rows.find((row) => row.supplierProductId === "bad-reference"); assert.equal(invalid.status, "needs-unit-review"); assert.equal(invalid.existingMatches.length, 0);
  assert.ok(invalid.warnings.some((message) => message.includes("supplier reference")));
  assert.equal(workspace.rows.find((row) => row.supplierProductId === "milk-6").status, "review");
});

test("precise conversions validate every purchase option and an invalid row cannot partially create or link a batch", async () => {
  const db = fixture({ [`hotels/${hotelUid}/supplierproducts/tiny`]: offer({ supplierSku: "TINY", supplierProductName: "Milk tiny package", baseUnit: "ml", baseUnitsPerPurchaseUnit: 1,
    purchaseOptions: [{ id: "tiny", purchaseUnit: "Drop", baseUnitsPerPurchaseUnit: 0.000001, pricePerPurchaseUnit: 1 }] }) });
  const workspace = await preview(db);
  await assert.rejects(apply(db, workspace, workspace.rows.map((row) => newChoice(row))), (error) => error.code === "failed-precondition" && error.details.catalogSyncRequestUncommitted);
  assert.equal([...db.records.keys()].some((path) => path.includes("/catalogSkuConfiguration/")), false);
  assert.equal(db.records.get(`hotels/${hotelUid}/supplierproducts/milk-6`).catalogProductId, null);
});

test("supplier pagination and catalog matching remain bounded, with manual selection beyond the candidate window", async () => {
  const db = fixture();
  for (let index = 0; index < 29; index++) db.records.set(`hotels/${hotelUid}/supplierproducts/p-${String(index).padStart(3, "0")}`, offer({ supplierSku: `P-${index}` }));
  for (let index = 0; index < 500; index++) db.records.set(`hotels/${hotelUid}/catalogproducts/a-${String(index).padStart(3, "0")}`, catalog({ name: "Other article" }));
  const first = await preview(db); assert.equal(first.scannedSuppliers, 25); assert.equal(first.rows.length, 25); assert.equal(first.catalogPool.complete, false);
  assert.equal(first.rows[0].existingMatches.length, 0); assert.equal(first.catalogPool.count, 500);
  const second = await preview(db, { requestId: "next-page", cursor: first.nextCursor }); assert.equal(second.rows.length, 5); assert.equal(second.nextCursor, null);
  const result = await apply(db, first, [existingChoice(first.rows[0])]); assert.equal(result.outcomes[0].catalogProductId, "milk");
  await assert.rejects(preview(db, { requestId: "too-many", limit: 26 }), (error) => error.code === "invalid-argument");
});
