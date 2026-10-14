const test = require("node:test");
const assert = require("node:assert/strict");
const proposal = require("./supplierAiProposal");
const review = require("./supplierAiReview");
const { mutateHotelSupplierProductHandler } = require("./products");
const { SAAS_RULES_VERSION } = require("./saasRollout");
const { createHash } = require("node:crypto");
test("an explicitly unavailable package source cannot become a physical-unit mapping group through originalInput", () => {
  const indexed = review.indexRow({ rowId: "r-000001", reviewRevision: 1, category: "blocked", product: { purchaseUnit: null },
    originalInput: { purchaseUnit: "GR" }, purchaseUnitMapping: { sourceUnit: null, status: "unconfirmed" }, issues: [{ severity: "error" }] });
  assert.equal(indexed.sourceUnit, null); assert.equal(indexed.canApprove, false);
  const legacy = review.indexRow({ rowId: "r-000001", reviewRevision: 1, category: "new", product: { purchaseUnit: "FL" }, originalInput: { purchaseUnit: "FL" } });
  assert.equal(legacy.sourceUnit, "FL");
});

test("confirmed recurring formats allow factual price and unchanged confirmations, while packages and new offers require individual review", () => {
  const existing = offer({ productPolicyVersion: 1 });
  const interpretation = { version: 1, status: "confirmed", requiresFormatReview: false, documentPurpose: "price-list", assortmentMode: "partial", sourceIssuedOn: "2026-10-01",
    providedFields: ["supplierSku", "supplierProductName", "pricePerPurchaseUnit", "pricingModel", "purchaseUnit", "baseUnit", "baseUnitsPerPurchaseUnit", "currency", "priceBasis"], unitPriceEstablished: true };
  const candidate = (patch = {}, previous = existing) => proposal.buildSupplierAiCandidate({ hotelUid, jobId, supplierId, rowIndex: 0, previous, raw: {
    ...raw(patch), sourceInterpretation: interpretation, sourceAnchors: [{ verified: true, sourceExcerpt: "Milk 12", sourceId: "csv-row-2" }] } });
  const price = candidate({ pricePerPurchaseUnit: 15 });
  assert.equal(price.recurringReview.category, "price-change"); assert.equal(review.bulkEligible(price), true);
  assert.equal(candidate().recurringReview.category, "confirmation"); assert.equal(review.bulkEligible(candidate()), true);
  const packageChange = candidate({ baseUnitsPerPurchaseUnit: 4 });
  assert.equal(packageChange.recurringReview.category, "packaging-change"); assert.equal(packageChange.recurringReview.physicalPriceComparison.percentChange, 50);
  assert.equal(review.bulkEligible(packageChange), false); assert.equal(review.bulkEligible(candidate({}, null)), false);
});
function database(initial = {}) {
  const records = new Map(Object.entries(initial));
  const snapshot = (path) => ({ id: path.split("/").at(-1), exists: records.has(path), data: () => structuredClone(records.get(path)) });
  const readField = (value, field) => String(field).split(".").reduce((current, key) => current?.[key], value);
  let serial = Promise.resolve();
  const db = { records, doc: (path) => ({ path, get: async () => snapshot(path) }), collection(path) {
    const query = (filters = [], maximum = Infinity, cursor = null, ordered = false) => ({ isQuery: true,
      where: (field, op, value) => { assert.equal(op, "=="); return query([...filters, [field, value]], maximum, cursor, ordered); },
      orderBy: () => query(filters, maximum, cursor, true), startAfter: (value) => query(filters, maximum, value, ordered), limit: (value) => query(filters, value, cursor, ordered),
      get: async () => {
        let entries = [...records.entries()].filter(([key, value]) => key.startsWith(`${path}/`) && key.slice(path.length + 1).split("/").length === 1
          && (!cursor || key.split("/").at(-1) > cursor) && filters.every(([field, expected]) => readField(value, field) === expected));
        if (ordered) entries = entries.sort(([left], [right]) => left.localeCompare(right));
        const docs = entries.slice(0, maximum).map(([key]) => snapshot(key)); return { docs, empty: docs.length === 0, size: docs.length };
      } });
    return query();
  }, runTransaction(fn) {
    const run = serial.then(async () => {
      const writes = [], tx = { get: async (ref) => { assert.equal(writes.length, 0, "all transaction reads precede writes"); return ref.isQuery ? ref.get() : snapshot(ref.path); },
        set: (ref, value) => writes.push(["set", ref.path, value]), create: (ref, value) => writes.push(["create", ref.path, value]), delete: (ref) => writes.push(["delete", ref.path]) };
      const result = await fn(tx);
      for (const [kind, path, value] of writes) {
        if (kind === "create") assert.equal(records.has(path), false, `${path} is immutable create-only evidence`);
        if (kind === "delete") records.delete(path); else records.set(path, value);
      }
      if (db.afterCommit) await db.afterCommit(writes);
      return result;
    }); serial = run.catch(() => {}); return run;
  } };
  return db;
}
const hotelUid = "hotel-a", jobId = "job-1", uid = "buyer", supplierId = "dairy";
const jobRoot = `hotels/${hotelUid}/supplierAiImportJobs/${jobId}`;
const auth = { getUser: async (actor) => ({ uid: actor, emailVerified: true, disabled: false }) };
const request = (data, actorUid = uid) => ({ auth: { uid: actorUid, token: { email_verified: true, auth_time: 9999 } }, data });
const permissions = ["supplierproducts.read", "supplierproducts.create", "supplierproducts.update", "catalogproducts.read", "suppliers.read"];
function fixture() {
  return database({ [`hotels/${hotelUid}/members/${uid}`]: { permissions },
    [`hotelSubscriptions/${hotelUid}`]: { status: "active", modules: ["procurement"], modulePolicyVersion: 1 },
    "platformConfiguration/saasProcurement": { enabled: true, rulesVersion: SAAS_RULES_VERSION },
    "platformConfiguration/aiSupplierProductImport": { enabled: false, policyVersion: 1, revision: 4 },
    [`hotels/${hotelUid}/suppliers/${supplierId}`]: { name: "Dairy Company", active: true },
    [`hotels/${hotelUid}/catalogproducts/milk`]: { name: "Milk", baseUnit: "l", active: true, inventoryTracked: true, productPolicyVersion: 1, revision: 1 },
    [jobRoot]: { ownerUid: uid, supplierId, status: "processing", leaseId: "lease", configVersion: 3, configPolicyVersion: 1, importReviewVersion: 1, fileName: "offers.csv", purchaseUnitMappingSnapshot: { version: 1, supplierId, sourceFormat: "csv", profileId: "default", revision: 0, mappings: [] }, expiresAtMillis: Date.now() + 1000000 } });
}
const sourceUnits = [{ sourceId: "csv-row-2", anchor: "CSV row 2", text: "MILK6 Milk six pack 6 litres net EUR 12" }];
function raw(patch = {}) {
  return { supplierSku: "MILK6", supplierProductName: "Milk six pack", currency: "EUR", pricingModel: "Per Purchase Unit",
    pricePerBaseUnit: null, pricePerPurchaseUnit: 12, purchaseUnit: "Case", baseUnit: "l", baseUnitsPerPurchaseUnit: 6,
    priceBasis: "net", vatRate: null, gtin: null, priceValidFrom: null, priceValidUntil: null,
    sourceAnchors: [{ sourceId: "csv-row-2", quote: "MILK6" }], ...patch };
}
function offer(patch = {}) {
  const { sourceAnchors, ...product } = raw();
  return { ...product, supplierId, catalogProductId: "milk", active: true, purchaseOptions: [], ...patch };
}
const services = (db, patch = {}) => ({ firestore: db, auth, ...patch });
const rowDoc = (db, index = 1) => db.records.get(`${jobRoot}/rows/r-${String(index).padStart(6, "0")}`);
async function reconcile(db, rows = [raw()]) {
  const checked = proposal.validateRawSupplierAiRows({ rows }, { sourceUnits });
  let result;
  do { result = await proposal.reconcileSupplierAiRows({ db, hotelUid, supplierId, jobId, rows: checked, leaseId: "lease" }); } while (!result.complete);
  db.records.set(jobRoot, { ...db.records.get(jobRoot), status: "review", counts: result.counts, totalRows: result.totalRows }); return result;
}
async function createExisting(db, patch = {}) {
  return mutateHotelSupplierProductHandler(request({ hotelUid, requestId: "existing", action: "create", expectedRevision: 0, product: offer(patch) }), services(db));
}
const confirm = (db, rows = [rowDoc(db)], patch = {}) => proposal.commitHotelSupplierAiImportRowsHandler(request({ hotelUid, jobId, requestId: "confirm", rows: rows.map((row) => ({ rowId: row.rowId, reviewRevision: row.reviewRevision, acknowledged: true })), ...patch }), services(db));
const correct = (db, patch, row = rowDoc(db)) => proposal.correctHotelSupplierAiImportRowHandler(request({ hotelUid, jobId, rowId: row.rowId, expectedReviewRevision: row.reviewRevision, patch }), services(db));
const history = (db) => [...db.records.entries()].filter(([path]) => path.includes("/supplierPriceHistory/"));

const workspace = (db, patch = {}) => review.readHotelSupplierAiImportWorkspaceHandler(request({ hotelUid, jobId, ...patch }), services(db));
const decide = (db, action = "approve", rows = [rowDoc(db)], patch = {}) => review.decideHotelSupplierAiImportRowsHandler(request({ hotelUid, jobId, requestId: `decision-${action}`, rows: rows.map((row) => ({ rowId: row.rowId, reviewRevision: row.reviewRevision, action, acknowledged: true })), ...patch }), services(db));
const finish = (db, patch = {}) => review.completeHotelSupplierAiImportReviewHandler(request({ hotelUid, jobId, requestId: "finish", ...patch }), services(db));
const apply = (db, rows, patch = {}) => review.applyHotelSupplierAiImportMappingHandler(request({ hotelUid, jobId, requestId: "mapping-apply", sourceUnit: "ZK", purchaseUnit: "Bag", expectedMappingRevision: null, rows: rows.map((row) => ({ rowId: row.rowId, reviewRevision: row.reviewRevision })), ...patch }), services(db));

async function formatFixture(count = 1, existing = false) {
  const db = fixture(), mappings = require("./supplierImportMappings"), formats = require("./supplierImportFormat");
  if (existing) await createExisting(db);
  const header = ["SKU", "Name", "Package", "Content", "Base unit", "Purchase price"];
  const source = { format: "csv", sourceSha256: createHash("sha256").update("uploaded source").digest("hex"), units: [
    { sourceId: "csv-header", anchor: "CSV row 1 (possible header)", text: JSON.stringify(header) },
    ...Array.from({ length: count }, (_, index) => ({ sourceId: `csv-row-${index + 2}`, anchor: `CSV row ${index + 2}`,
      text: JSON.stringify([index === 0 ? "MILK6" : `MILK-${index}`, "Milk six pack", "Case", 6, "l", 15]) })),
  ] };
  const scope = { supplierId, sourceFormat: "csv", profileId: "default" };
  const interpretation = { version: 1, header, sheetName: null,
    columns: { supplierSku: 0, supplierProductName: 1, purchaseUnit: 2, baseUnitsPerPurchaseUnit: 3, baseUnit: 4, pricePerPurchaseUnit: 5 },
    defaults: { currency: "EUR", priceBasis: "net" }, assortmentMode: "partial", documentPurpose: "price-list", decimalSeparator: ".", dateFormat: "YYYY-MM-DD" };
  const profile = { version: 1, ...scope, revision: 1, mappings: [], interpretation,
    interpretationFingerprint: mappings.interpretationFingerprint(interpretation, "csv") };
  db.records.set(mappings.mappingProfileRef(db, hotelUid, scope).path, profile);
  const checked = formats.interpretSupplierSourceRows(source, profile).rows.map((row) => ({ ...row,
    sourceInterpretation: { ...row.sourceInterpretation, status: "unconfirmed", requiresFormatReview: true } }));
  const serialized = Buffer.from(JSON.stringify(source));
  const sourceFormatObject = { path: `private/supplier-ai-imports/${hotelUid}/${jobId}/source-format.json`, generation: "1",
    sha256: createHash("sha256").update(serialized).digest("hex"), size: serialized.length, contentType: "application/json" };
  db.records.set(jobRoot, { ...db.records.get(jobRoot), source: { sha256: source.sourceSha256 }, sourceFormatObject,
    sourceFormatCandidate: formats.interpretationForSources(source, { version: 1, ...scope, revision: 0, mappings: [] }).sourceFormatCandidate });
  let result;
  do { result = await proposal.reconcileSupplierAiRows({ db, hotelUid, supplierId, jobId, rows: checked, leaseId: "lease" }); } while (!result.complete);
  db.records.set(jobRoot, { ...db.records.get(jobRoot), status: "review", counts: result.counts, totalRows: result.totalRows });
  let reads = 0;
  const bucket = { file(path, options) {
    assert.equal(path, sourceFormatObject.path); assert.equal(options.generation, "1");
    return { getMetadata: async () => [{ generation: "1", size: serialized.length, contentType: "application/json", metadata: { sha256: sourceFormatObject.sha256 } }],
      download: async () => { reads++; return [serialized]; } };
  } };
  return { db, bucket, profile, readCount: () => reads };
}
const applyFormat = (fixture, patch = {}, actorUid = uid) => review.applyHotelSupplierImportFormatHandler(request({ hotelUid, jobId, requestId: "confirm-format", expectedMappingRevision: 1, ...patch }, actorUid), services(fixture.db, { bucket: fixture.bucket }));

test("format application rebuilds pinned source columns, preserves human correction and invalidates approvals without product writes", async () => {
  const fixture = await formatFixture(1, true), { db } = fixture;
  assert.equal(rowDoc(db).category, "blocked"); await assert.rejects(decide(db), /blocking/);
  await correct(db, { supplierProductName: "Hotel's preferred description" });
  const before = rowDoc(db).reviewRevision, historyBefore = history(db).length;
  const result = await applyFormat(fixture);
  assert.deepEqual(result, { hotelUid, jobId, rebuiltRows: 1, skippedRows: 0, completed: true });
  assert.equal(rowDoc(db).reviewRevision, before + 1); assert.equal(rowDoc(db).review.status, "pending");
  assert.equal(rowDoc(db).product.supplierProductName, "Hotel's preferred description"); assert.equal(rowDoc(db).product.pricePerPurchaseUnit, 15);
  assert.equal(rowDoc(db).sourceInterpretation.status, "confirmed"); assert.equal(rowDoc(db).category, "changed");
  assert.equal(history(db).length, historyBefore); assert.equal((await workspace(db)).reviewCounts.pending, 1);
  const readsBefore = fixture.readCount(); assert.deepEqual(await applyFormat(fixture), result); assert.equal(fixture.readCount(), readsBefore, "Completed replay does not redownload or reinterpret the source");
  await assert.rejects(applyFormat(fixture, { expectedMappingRevision: 2 }), (error) => error.code === "already-exists");
  await assert.rejects(applyFormat(fixture, {}, "outsider"), (error) => error.code === "permission-denied");
  db.records.set(`hotels/${hotelUid}/members/${uid}`, { permissions: permissions.filter((permission) => permission !== "supplierproducts.update") });
  await assert.rejects(applyFormat(fixture), (error) => error.code === "permission-denied");
});

test("format application resumes after a lost saved batch and keeps skipped rows explicit", async () => {
  const fixture = await formatFixture(30), { db } = fixture;
  await decide(db, "skip", [rowDoc(db, 30)]);
  let interrupted = false;
  db.afterCommit = async (writes) => {
    if (!interrupted && writes.some(([, path, value]) => path.includes("/reviewOperations/t-") && value.processed === 25)) {
      interrupted = true; throw new Error("Response lost after a saved format batch");
    }
  };
  await assert.rejects(applyFormat(fixture), /Response lost/);
  assert.equal(db.records.get(jobRoot).formatApplication.processed, 25);
  await assert.rejects(correct(db, { supplierProductName: "Concurrent edit" }), /Finish applying/);
  await assert.rejects(decide(db), /Finish applying/);
  const mappings = require("./supplierImportMappings"), profileRef = mappings.mappingProfileRef(db, hotelUid, { supplierId, sourceFormat: "csv", profileId: "default" });
  const profile = db.records.get(profileRef.path), changedInterpretation = { ...profile.interpretation, defaults: { ...profile.interpretation.defaults, currency: "USD" } };
  db.records.set(profileRef.path, { ...profile, revision: 2, interpretation: changedInterpretation,
    interpretationFingerprint: mappings.interpretationFingerprint(changedInterpretation, "csv") });
  db.afterCommit = null;
  const result = await applyFormat(fixture);
  assert.equal(result.rebuiltRows, 29); assert.equal(result.skippedRows, 1); assert.equal(result.completed, true);
  assert.equal(rowDoc(db, 1).reviewRevision, 2); assert.equal(rowDoc(db, 26).reviewRevision, 2); assert.equal(rowDoc(db, 30).reviewRevision, 1);
  assert.equal(rowDoc(db, 26).product.currency, "EUR", "Continuation retains the already accepted format instead of a concurrently changed supplier profile");
  assert.equal(db.records.get(jobRoot).purchaseUnitMappingSnapshot.revision, 1); assert.equal(db.records.get(profileRef.path).revision, 2);
  assert.equal((await workspace(db)).reviewCounts.skipped, 1); assert.equal((await workspace(db)).reviewCounts.pending, 29);
});

test("format application rejects stale profiles, changed source hashes and other-import artifact paths before modifying review", async () => {
  const stale = await formatFixture();
  await assert.rejects(applyFormat(stale, { expectedMappingRevision: 0 }), (error) => error.code === "aborted");
  const changed = await formatFixture(); changed.db.records.set(jobRoot, { ...changed.db.records.get(jobRoot), source: { sha256: "a".repeat(64) } });
  await assert.rejects(applyFormat(changed), /does not match/); assert.equal(rowDoc(changed.db).reviewRevision, 1);
  const foreign = await formatFixture(); foreign.db.records.set(jobRoot, { ...foreign.db.records.get(jobRoot), sourceFormatObject: {
    ...foreign.db.records.get(jobRoot).sourceFormatObject, path: "private/supplier-ai-imports/hotel-b/other/source-format.json" } });
  await assert.rejects(applyFormat(foreign), /no pinned structured source/); assert.equal(foreign.readCount(), 0);
});

test("format application follows source article references across reordered model rows and refuses ambiguous coverage", async () => {
  const fixture = await formatFixture(2), { db } = fixture;
  const first = rowDoc(db, 1), second = rowDoc(db, 2);
  db.records.set(`${jobRoot}/rows/${first.rowId}`, { ...second, rowId: first.rowId, rowIndex: 0, productId: first.productId });
  db.records.set(`${jobRoot}/rows/${second.rowId}`, { ...first, rowId: second.rowId, rowIndex: 1, productId: second.productId });
  db.records.set(`${jobRoot}/reviewIndex/${first.rowId}`, review.indexRow(rowDoc(db, 1)));
  db.records.set(`${jobRoot}/reviewIndex/${second.rowId}`, review.indexRow(rowDoc(db, 2)));
  await correct(db, { supplierProductName: "Keep this local correction with the second source article" }, rowDoc(db, 1));
  await applyFormat(fixture);
  assert.equal(rowDoc(db, 1).product.supplierSku, "MILK-1");
  assert.equal(rowDoc(db, 1).product.supplierProductName, "Keep this local correction with the second source article");
  assert.equal(rowDoc(db, 2).product.supplierSku, "MILK6");
  const ambiguous = await formatFixture(2);
  const row = rowDoc(ambiguous.db, 2);
  ambiguous.db.records.set(`${jobRoot}/rows/${row.rowId}`, { ...row, sourceAnchors: rowDoc(ambiguous.db, 1).sourceAnchors });
  await assert.rejects(applyFormat(ambiguous), /do not cover every source article/);
  assert.equal(rowDoc(ambiguous.db, 1).reviewRevision, 1);
});

test("full and partial assortments flag missing offers while preserving their identities, prices, options and orderability", async () => {
  for (const mode of ["full", "partial"]) {
    const fixture = await formatFixture(), { db } = fixture;
    db.records.set(`hotels/${hotelUid}/supplierproducts/omitted`, offer({ supplierSku: "OLD-MILK", revision: 3,
      purchaseOptions: [{ id: "single", purchaseUnit: "Bottle", baseUnitsPerPurchaseUnit: 1, pricePerPurchaseUnit: 2 }] }));
    const before = structuredClone(db.records.get(`hotels/${hotelUid}/supplierproducts/omitted`));
    const mappings = require("./supplierImportMappings"), profileRef = mappings.mappingProfileRef(db, hotelUid, { supplierId, sourceFormat: "csv", profileId: "default" });
    const profile = db.records.get(profileRef.path);
    db.records.set(profileRef.path, { ...profile, interpretation: { ...profile.interpretation, assortmentMode: mode },
      interpretationFingerprint: mappings.interpretationFingerprint({ ...profile.interpretation, assortmentMode: mode }, "csv") });
    await applyFormat(fixture);
    const overview = await workspace(db);
    assert.equal(overview.assortmentSummary.mode, mode); assert.equal(overview.assortmentSummary.missingOfferCount, 1);
    assert.equal(overview.assortmentSummary.policy, "preserve-existing"); assert.equal(overview.assortmentSummary.missingOffers[0].productId, "omitted");
    await decide(db); await confirm(db);
    assert.deepEqual(db.records.get(`hotels/${hotelUid}/supplierproducts/omitted`), before);
  }
});

test("statistics without current unit prices preserve local terms and never manufacture a price confirmation", async () => {
  const db = fixture(), existing = await createExisting(db, { purchaseOptions: [{ id: "single", purchaseUnit: "Bottle", baseUnitsPerPurchaseUnit: 1, pricePerPurchaseUnit: 2 }] });
  const path = `hotels/${hotelUid}/supplierproducts/${existing.productId}`, before = db.records.get(path);
  const checked = proposal.validateRawSupplierAiRows({ rows: [raw({ pricePerPurchaseUnit: null, purchaseUnit: "Box", baseUnitsPerPurchaseUnit: 3, priceValidFrom: "2027-01-01" })] }, { sourceUnits })
    .map((row) => ({ ...row, sourceInterpretation: { status: "confirmed", requiresFormatReview: false, documentPurpose: "statistics", assortmentMode: "partial",
      sourceIssuedOn: "2026-10-01", unitPriceEstablished: false, providedFields: ["supplierSku", "supplierProductName", "purchaseUnit", "baseUnitsPerPurchaseUnit", "priceValidFrom"] } }));
  const result = await proposal.reconcileSupplierAiRows({ db, hotelUid, supplierId, jobId, rows: checked, leaseId: "lease" });
  db.records.set(jobRoot, { ...db.records.get(jobRoot), status: "review", counts: result.counts, totalRows: 1 });
  assert.equal(rowDoc(db).product.purchaseUnit, "Case"); assert.equal(rowDoc(db).product.baseUnitsPerPurchaseUnit, 6); assert.equal(rowDoc(db).product.priceValidFrom, null);
  assert.equal(rowDoc(db).recurringReview.confirmsUnitPrice, false); assert.equal(rowDoc(db).category, "unchanged");
  assert.equal(review.bulkEligible(rowDoc(db)), false); await decide(db); assert.equal((await confirm(db)).outcomes[0].status, "unchanged");
  assert.deepEqual(db.records.get(path), before); assert.equal(history(db).length, 1);
});

test("missing approved period evidence blocks the affected offer without losing other source articles", async () => {
  const fixture = await formatFixture(2, true), { db } = fixture;
  const productId = rowDoc(db).productId, existing = db.records.get(`hotels/${hotelUid}/supplierproducts/${productId}`);
  db.records.delete(`hotels/${hotelUid}/supplierPriceVersions/${productId}/entries/${existing.latestApprovedPriceVersionId}`);
  db.records.set(jobRoot, { ...db.records.get(jobRoot), importSettings: { priceValidFrom: "2027-01-01" } });
  const result = await applyFormat(fixture);
  assert.equal(result.rebuiltRows, 2); assert.equal(rowDoc(db).category, "blocked");
  assert.ok(rowDoc(db).issues.some((issue) => issue.code === "approved-price-agreement-missing"));
  assert.equal(rowDoc(db, 2).category, "new"); assert.equal((await workspace(db)).reviewCounts.pending, 2);
  assert.equal(db.records.get(`hotels/${hotelUid}/supplierproducts/${productId}`).pricePerPurchaseUnit, 12);
});

test("scheduled approved supplier prices preserve current purchasing projection and dated older sources cannot regain approval", async () => {
  const fixture = await formatFixture(1, true), { db } = fixture;
  await applyFormat(fixture);
  const row = rowDoc(db), sourceInterpretation = { ...row.sourceInterpretation, sourceIssuedOn: "2026-10-14", providedFields: [...row.sourceInterpretation.providedFields, "priceValidFrom"] };
  const next = proposal.buildSupplierAiCandidate({ hotelUid, jobId, supplierId, rowIndex: 0, raw: {
    ...row.sourceInput, priceValidFrom: "2027-01-01", sourceInterpretation, sourceAnchors: row.sourceAnchors,
  }, previous: db.records.get(`hotels/${hotelUid}/supplierproducts/${row.productId}`), productId: row.productId, reviewRevision: row.reviewRevision + 1,
  userPatch: { purchaseOptions: [{ id: "single", purchaseUnit: "Bottle", baseUnitsPerPurchaseUnit: 1, pricePerPurchaseUnit: 4 }] } });
  next.review = { status: "pending", reviewRevision: next.reviewRevision };
  db.records.set(`${jobRoot}/rows/${row.rowId}`, next); db.records.set(`${jobRoot}/reviewIndex/${row.rowId}`, review.indexRow(next));
  await decide(db); const result = await confirm(db);
  assert.equal(result.outcomes[0].status, "updated");
  const saved = db.records.get(`hotels/${hotelUid}/supplierproducts/${row.productId}`);
  assert.equal(saved.pricePerPurchaseUnit, 12); assert.equal(saved.priceValidFrom, null); assert.equal(saved.latestPriceSourceIssuedOn, "2026-10-14");
  const versions = [...db.records.entries()].filter(([path]) => path.includes("/supplierPriceVersions/"));
  assert.equal(versions.at(-1)[1].productTerms.pricePerPurchaseUnit, 15); assert.equal(versions.at(-1)[1].productTerms.priceValidFrom, "2027-01-01");
  const repeatJobId = "repeat-future-list", repeatRoot = `hotels/${hotelUid}/supplierAiImportJobs/${repeatJobId}`;
  db.records.set(repeatRoot, { ...db.records.get(jobRoot), status: "processing", leaseId: "repeat-lease", reconciliation: undefined,
    reviewState: undefined, counts: undefined, summary: undefined, formatApplication: undefined });
  const repeated = await proposal.reconcileSupplierAiRows({ db, hotelUid, supplierId, jobId: repeatJobId, leaseId: "repeat-lease", rows: [{
    ...row.sourceInput, priceValidFrom: "2027-01-01", sourceInterpretation: { ...sourceInterpretation, sourceIssuedOn: "2026-10-15" }, sourceAnchors: row.sourceAnchors,
  }] });
  db.records.set(repeatRoot, { ...db.records.get(repeatRoot), status: "review", totalRows: 1, counts: repeated.counts });
  const repeatedRow = db.records.get(`${repeatRoot}/rows/r-000001`);
  assert.equal(repeatedRow.category, "unchanged"); assert.equal(repeatedRow.recurringReview.category, "confirmation");
  assert.equal(repeatedRow.recurringReview.physicalPriceComparison.before, 2.5); assert.equal(repeatedRow.recurringReview.physicalPriceComparison.after, 2.5);
  assert.equal(repeatedRow.previousProduct.pricePerPurchaseUnit, 12); assert.equal(repeatedRow.previousPriceAgreement.product.pricePerPurchaseUnit, 15);
  assert.equal(repeatedRow.product.purchaseOptions[0].pricePerPurchaseUnit, 4, "An omitted option keeps its already approved future terms");
  await review.decideHotelSupplierAiImportRowsHandler(request({ hotelUid, jobId: repeatJobId, requestId: "approve-repeat", bulk: true,
    rows: [{ rowId: repeatedRow.rowId, reviewRevision: repeatedRow.reviewRevision, action: "approve", acknowledged: true }] }), services(db));
  const repeatedResult = await proposal.commitHotelSupplierAiImportRowsHandler(request({ hotelUid, jobId: repeatJobId, requestId: "apply-repeat",
    rows: [{ rowId: repeatedRow.rowId, reviewRevision: repeatedRow.reviewRevision, acknowledged: true }] }), services(db));
  assert.equal(repeatedResult.outcomes[0].status, "unchanged");
  assert.equal(db.records.get(`hotels/${hotelUid}/supplierproducts/${row.productId}`).pricePerPurchaseUnit, 12);
  assert.deepEqual(db.records.get(`hotels/${hotelUid}/supplierproducts/${row.productId}`).purchaseOptions, []);
  assert.equal([...db.records.keys()].filter((path) => path.includes("/supplierPriceVersions/")).length, versions.length);
  const old = proposal.buildSupplierAiCandidate({ hotelUid, jobId: "old-source", supplierId, rowIndex: 0, previous: saved, raw: {
    ...row.sourceInput, pricePerPurchaseUnit: 9, sourceInterpretation: { ...sourceInterpretation, sourceIssuedOn: "2026-09-01" }, sourceAnchors: row.sourceAnchors,
  } });
  assert.equal(old.category, "blocked"); assert.ok(old.issues.some((issue) => issue.code === "older-price-source")); assert.equal(review.canApprove(old), false);
  const unknown = proposal.buildSupplierAiCandidate({ hotelUid, jobId: "undated", supplierId, rowIndex: 0, previous: saved, raw: {
    ...row.sourceInput, sourceInterpretation: { ...sourceInterpretation, sourceIssuedOn: null }, sourceAnchors: row.sourceAnchors,
  } });
  assert.equal(review.canApprove(unknown), true); assert.equal(review.bulkEligible(unknown), false);
  assert.ok(unknown.issues.some((issue) => issue.code === "price-source-date-unknown"));
});

test("guided review separates durable approval from product writes and exposes actual outcomes only after final application", async () => {
  const db = fixture(); await reconcile(db);
  const initial = await workspace(db);
  assert.deepEqual(initial.reviewCounts, { pending: 1, approved: 0, skipped: 0, applied: 0, failed: 0 });
  assert.deepEqual(initial.outcomeCounts, { created: 0, updated: 0, unchanged: 0 });
  assert.equal(initial.rows[0].review.status, "pending"); assert.equal(initial.rows[0].bulkEligible, true);
  const unapproved = await confirm(db, [rowDoc(db)], { requestId: "not-approved" });
  assert.equal(unapproved.outcomes[0].status, "blocked"); assert.match(unapproved.outcomes[0].error.message, /Approve/);
  assert.equal(history(db).length, 0);
  await correct(db, {});
  await decide(db); assert.equal(history(db).length, 0);
  assert.equal((await workspace(db)).reviewCounts.approved, 1);
  const applied = await confirm(db, [rowDoc(db)], { requestId: "apply-approved" });
  assert.equal(applied.outcomes[0].status, "created"); assert.equal(history(db).length, 1);
  assert.equal((await workspace(db)).outcomeCounts.created, 1);
  assert.equal((await finish(db)).completed, true);
  assert.equal((await workspace(db)).status, "completed");
  assert.deepEqual(await confirm(db, [rowDoc(db)], { requestId: "apply-approved" }), applied);
  assert.equal(history(db).length, 1);
  await assert.rejects(confirm(db, [rowDoc(db)], { requestId: "brand-new-after-completion" }), /completed/);
});

test("approval receipts replay without changing counts and live correction invalidates exactly the approved revision", async () => {
  const db = fixture(); await reconcile(db); const original = rowDoc(db);
  const result = await decide(db); const state = structuredClone(db.records.get(jobRoot).reviewState);
  assert.deepEqual(await decide(db), result); assert.deepEqual(db.records.get(jobRoot).reviewState, state);
  await correct(db, { supplierProductName: "Reviewed milk" });
  assert.equal(rowDoc(db).review.status, "pending"); assert.equal(rowDoc(db).reviewRevision, 2);
  assert.equal((await workspace(db)).reviewCounts.pending, 1);
  await assert.rejects(decide(db, "approve", [original], { requestId: "stale-approve" }), (error) => error.code === "aborted");
  assert.equal((await confirm(db, [rowDoc(db)], { requestId: "correction-unapproved" })).outcomes[0].status, "blocked");
  await assert.rejects(decide(db, "skip", [rowDoc(db)], { requestId: "decision-approve" }), (error) => error.code === "already-exists");
  await correct(db, {});
  await decide(db, "approve", [rowDoc(db)], { requestId: "approve-current" });
  assert.equal((await confirm(db, [rowDoc(db)], { requestId: "apply-current" })).outcomes[0].status, "created");
});

test("skip and reset are durable while finish never silently resolves pending or approved products", async () => {
  const db = fixture(); await reconcile(db, [raw({ supplierSku: "ONE" }), raw({ supplierSku: "TWO" })]);
  await decide(db, "skip", [rowDoc(db)]); assert.equal((await finish(db)).completed, false);
  await decide(db, "reset", [rowDoc(db)]); assert.equal((await workspace(db)).reviewCounts.pending, 2);
  await decide(db, "approve", [rowDoc(db)]); assert.equal((await finish(db)).completed, false);
  await decide(db, "skip", [rowDoc(db), rowDoc(db, 2)], { requestId: "skip-all" });
  assert.equal((await finish(db)).completed, true); assert.equal(history(db).length, 0);
  assert.deepEqual((await workspace(db)).reviewCounts, { pending: 0, approved: 0, skipped: 2, applied: 0, failed: 0 });
  await assert.rejects(decide(db, "reset", [rowDoc(db)], { requestId: "reset-completed" }), /completed/);
});

test("blocking evidence and incomplete contracts never gain approval and warning rows cannot use bulk-safe approval", async () => {
  const db = fixture(); await reconcile(db, [raw({ sourceAnchors: [{ sourceId: "csv-row-2", quote: "invented" }] })]);
  await assert.rejects(decide(db), /blocking/);
  await correct(db, { supplierProductName: "Milk" }); await assert.rejects(decide(db), /blocking/);
  const missing = fixture(); await reconcile(missing, [raw({ pricePerPurchaseUnit: null })]);
  assert.equal(rowDoc(missing).category, "new");
  await assert.rejects(decide(missing, "approve", [rowDoc(missing)], { bulk: true }), /individual review/);
  await decide(missing); assert.equal((await confirm(missing)).outcomes[0].status, "created");
});

test("workspace counts and exception-first index cover all 125 rows independently of the displayed page", async () => {
  const db = fixture(); const rows = Array.from({ length: 125 }, (_, index) => raw({ supplierSku: `SKU-${index}`, pricePerPurchaseUnit: index === 100 ? null : 12 }));
  await reconcile(db, rows);
  const first = await workspace(db, { limit: 25 });
  assert.equal(first.rows.length, 25); assert.equal(first.index.length, 125); assert.equal(first.reviewCounts.pending, 125);
  const attention = await workspace(db, { filter: "attention" }); assert.deepEqual(attention.rows.map((row) => row.rowId), ["r-000101"]);
  const focus = await workspace(db, { focusRowId: "r-000125", limit: 1, includeIndex: false });
  assert.equal(focus.rows[0].rowId, "r-000125"); assert.equal(Object.hasOwn(focus, "index"), false);
  await decide(db, "approve", first.rows, { bulk: true });
  const current = await workspace(db); assert.equal(current.reviewCounts.approved, 25); assert.equal(current.reviewCounts.pending, 100);
  db.records.delete(`${jobRoot}/reviewIndex/r-000125`);
  await assert.rejects(workspace(db), /complete import review index/);
});

test("legacy adaptation retains source/proposals/paid receipts and committed outcomes while adding resumable review metadata only", async () => {
  const db = fixture(); const legacyJob = db.records.get(jobRoot);
  delete legacyJob.importReviewVersion; delete legacyJob.purchaseUnitMappingSnapshot; db.records.set(jobRoot, legacyJob);
  await reconcile(db, [raw(), raw({ supplierSku: "SECOND" })]);
  await confirm(db, [rowDoc(db)], { requestId: "legacy-applied" });
  const before = structuredClone(rowDoc(db, 2)), cached = { paid: true, requestFingerprint: "original-paid-schema", resultPath: "private/result" };
  db.records.set(`${jobRoot}/paidAttempts/attempt`, cached);
  const result = await workspace(db);
  assert.equal(result.importReviewVersion, 1); assert.equal(result.reviewCounts.applied, 1); assert.equal(result.reviewCounts.pending, 1);
  for (const field of ["product", "inputPatch", "sourceAnchors", "reviewRevision", "sourceRowFingerprint"]) assert.deepEqual(rowDoc(db, 2)[field], before[field]);
  assert.deepEqual(db.records.get(`${jobRoot}/paidAttempts/attempt`), cached);
  assert.equal((await confirm(db, [rowDoc(db, 2)], { requestId: "legacy-now-guided" })).outcomes[0].status, "blocked");
  await decide(db, "skip", [rowDoc(db, 2)]); assert.equal((await finish(db)).completed, true);
});

test("review and replay preserve hotel owner action subscription and current live identity boundaries", async () => {
  const db = fixture(); await reconcile(db); await decide(db);
  db.records.set(`hotels/${hotelUid}/members/other`, { permissions });
  await assert.rejects(review.decideHotelSupplierAiImportRowsHandler(request({ hotelUid, jobId, requestId: "other", rows: [{ rowId: rowDoc(db).rowId, reviewRevision: 1, action: "skip", acknowledged: true }] }, "other"), services(db)), (error) => error.code === "permission-denied");
  db.records.set(`hotels/${hotelUid}/members/${uid}`, { permissions: ["supplierproducts.read"] });
  await assert.rejects(decide(db), (error) => error.code === "permission-denied");
  db.records.set(`hotels/${hotelUid}/members/${uid}`, { permissions });
  await assert.rejects(review.readHotelSupplierAiImportWorkspaceHandler(request({ hotelUid, jobId }), services(db, { auth: { getUser: async () => ({ uid, emailVerified: true, disabled: true }) } })), (error) => error.code === "permission-denied");
  db.records.set(`hotelSubscriptions/${hotelUid}`, { status: "suspended", modules: ["procurement"], modulePolicyVersion: 1 });
  await assert.rejects(decide(db), (error) => error.code === "permission-denied");
});

test("mapping application changes only explicit matching packages, preserves human fields, and invalidates approval", async () => {
  const db = fixture(); await reconcile(db, [raw({ supplierSku: "ONE" }), raw({ supplierSku: "TWO" }), raw({ supplierSku: "THREE" })]);
  for (let index = 1; index <= 3; index++) {
    const row = rowDoc(db, index); const next = { ...row, originalInput: { ...raw(), purchaseUnit: "ZK" },
      purchaseUnitMapping: { sourceUnit: "ZK", status: "unconfirmed", suggestedUnit: "Bag", sourceFormat: "csv", profileId: "default", revision: 0 } };
    db.records.set(`${jobRoot}/rows/${row.rowId}`, next); db.records.set(`${jobRoot}/reviewIndex/${row.rowId}`, review.indexRow(next));
  }
  await correct(db, { supplierProductName: "Human name", purchaseUnit: "Tub" }, rowDoc(db, 2));
  await decide(db, "approve", [rowDoc(db), rowDoc(db, 3)]);
  const before = structuredClone(rowDoc(db)), human = structuredClone(rowDoc(db, 2));
  const result = await apply(db, [rowDoc(db), rowDoc(db, 2)]);
  assert.deepEqual(result.outcomes.map((entry) => entry.status), ["mapped", "skipped"]);
  assert.equal(rowDoc(db).product.purchaseUnit, "Bag"); assert.equal(rowDoc(db).review.status, "pending");
  assert.equal(rowDoc(db).product.baseUnitsPerPurchaseUnit, before.product.baseUnitsPerPurchaseUnit);
  assert.equal(rowDoc(db).product.pricePerPurchaseUnit, before.product.pricePerPurchaseUnit);
  assert.deepEqual(structuredClone(rowDoc(db, 2)), human); assert.equal(rowDoc(db, 3).review.status, "approved");
  assert.deepEqual(await apply(db, [before, human]), result);
  assert.equal(history(db).length, 0);
});

test("saved mappings are fenced by current supplier scope and revision rather than arbitrary caller snapshots", async () => {
  const db = fixture(); await reconcile(db); const row = rowDoc(db);
  row.originalInput = { ...raw(), purchaseUnit: "ZK" }; db.records.set(`${jobRoot}/rows/${row.rowId}`, row); db.records.set(`${jobRoot}/reviewIndex/${row.rowId}`, review.indexRow(row));
  const { mappingProfileRef } = require("./supplierImportMappings");
  const scope = { supplierId, sourceFormat: "csv", profileId: "default" }, ref = mappingProfileRef(db, hotelUid, scope);
  db.records.set(ref.path, { version: 1, ...scope, revision: 2, mappings: [{ sourceUnit: "ZK", purchaseUnit: "Bag" }] });
  await assert.rejects(apply(db, [row], { expectedMappingRevision: 1 }), (error) => error.code === "aborted");
  await assert.rejects(apply(db, [row], { expectedMappingRevision: 2, purchaseUnit: "Box" }), (error) => error.code === "aborted");
  assert.equal((await apply(db, [row], { expectedMappingRevision: 2 })).outcomes[0].status, "mapped");
  const current = db.records.get(ref.path); current.revision = 3; current.mappings[0].purchaseUnit = "Box"; db.records.set(ref.path, current);
  assert.equal((await apply(db, [row], { expectedMappingRevision: 2 })).outcomes[0].status, "mapped", "Immutable successful command receipt can replay after later profile edits");
});

test("guided metadata migration resumes 250 legacy rows after one saved batch response is lost", async () => {
  const db = fixture(), legacy = db.records.get(jobRoot); delete legacy.importReviewVersion; db.records.set(jobRoot, legacy);
  await reconcile(db, Array.from({ length: 250 }, (_, index) => raw({ supplierSku: `M-${index}` })));
  const original = JSON.stringify(rowDoc(db, 250).product); let interrupted = false;
  db.afterCommit = async (writes) => {
    if (!interrupted && writes.some(([, path, data]) => path === jobRoot && data?.reviewMigration?.processed === 100)) {
      interrupted = true; throw new Error("Lost metadata preparation response");
    }
  };
  await assert.rejects(workspace(db), /Lost metadata/);
  assert.equal(db.records.get(jobRoot).reviewMigration.processed, 100);
  assert.equal([...db.records.keys()].filter((path) => path.startsWith(`${jobRoot}/reviewIndex/`)).length, 100);
  const result = await workspace(db); assert.equal(result.index.length, 250); assert.equal(result.reviewCounts.pending, 250);
  assert.equal(JSON.stringify(rowDoc(db, 250).product), original); assert.equal(history(db).length, 0);
});

test("1000-row workspace remains bounded and persists all totals while approval batches are capped at 25", async () => {
  const db = fixture(); await reconcile(db, Array.from({ length: 1000 }, (_, index) => raw({ supplierSku: `S-${index}` })));
  const result = await workspace(db, { cursor: "r-000975" });
  assert.equal(result.rows.length, 25); assert.equal(result.index.length, 1000); assert.equal(result.nextCursor, null);
  assert.equal(result.reviewCounts.pending, 1000);
  await assert.rejects(decide(db, "approve", Array.from({ length: 26 }, (_, index) => rowDoc(db, index + 1))), /25/);
  await decide(db, "approve", result.rows, { bulk: true });
  assert.equal((await workspace(db)).reviewCounts.approved, 25);
});

test("lost decision acknowledgement replays the exact saved receipt after a later correction without restoring the old approval", async () => {
  const db = fixture(); await reconcile(db); const original = rowDoc(db); let lost = false;
  db.afterCommit = async (writes) => {
    if (!lost && writes.some(([, path]) => path.includes("/reviewOperations/d-"))) { lost = true; throw new Error("Lost decision acknowledgement"); }
  };
  await assert.rejects(decide(db, "approve", [original]), /Lost decision/);
  assert.equal(rowDoc(db).review.status, "approved"); await correct(db, { supplierProductName: "Later edit" });
  const replayed = await decide(db, "approve", [original]); assert.equal(replayed.rows[0].review.status, "approved"); assert.equal(replayed.rows[0].reviewRevision, 1);
  assert.equal(rowDoc(db).review.status, "pending"); assert.equal(rowDoc(db).reviewRevision, 2);
  assert.equal(history(db).length, 0); assert.equal((await workspace(db)).reviewCounts.pending, 1);
  const receipt = [...db.records.entries()].find(([path]) => /\/reviewOperations\/d-[^/]+$/.test(path))[1];
  assert.equal(Object.hasOwn(receipt.result, "rows"), false, "One Firestore receipt cannot contain 25 full product/source documents");
});

test("application detects changed existing product revisions and requires a new corrected reviewed decision before retry", async () => {
  const db = fixture(), existing = await createExisting(db); await reconcile(db, [raw({ pricePerPurchaseUnit: 15 })]); await decide(db);
  await mutateHotelSupplierProductHandler(request({ hotelUid, requestId: "manual-later", action: "update", productId: existing.productId, expectedRevision: 1, product: offer({ pricePerPurchaseUnit: 18 }) }), services(db));
  const blocked = await confirm(db, [rowDoc(db)], { requestId: "stale-existing" }); assert.equal(blocked.outcomes[0].status, "blocked");
  const failedWorkspace = await workspace(db);
  assert.equal(failedWorkspace.reviewCounts.failed, 1); assert.equal(failedWorkspace.reviewCounts.pending, 1); assert.equal(failedWorkspace.reviewCounts.approved, 0);
  assert.equal(failedWorkspace.rows[0].canApprove, false); assert.equal(failedWorkspace.rows[0].bulkEligible, false);
  await assert.rejects(decide(db, "approve", [rowDoc(db)], { requestId: "failed-approval" }), /Revalidate/);
  await assert.rejects(decide(db, "approve", [rowDoc(db)], { requestId: "failed-bulk-approval", bulk: true }), /Revalidate/);
  await decide(db, "reset", [rowDoc(db)], { requestId: "reset-failed" });
  await assert.rejects(decide(db, "approve", [rowDoc(db)], { requestId: "reset-cannot-bypass" }), /Revalidate/);
  assert.equal((await finish(db)).completed, false);
  const failedRowRevision = rowDoc(db).reviewRevision;
  await correct(db, {});
  assert.equal(rowDoc(db).reviewRevision, failedRowRevision + 1); assert.equal(rowDoc(db).lastOutcome, null); assert.equal(rowDoc(db).review.status, "pending"); assert.equal(rowDoc(db).expectedRevision, 2);
  await decide(db, "approve", [rowDoc(db)], { requestId: "new-approval" });
  assert.equal((await confirm(db, [rowDoc(db)], { requestId: "fresh-existing" })).outcomes[0].status, "updated");
  assert.equal((await workspace(db)).reviewCounts.failed, 0);
  assert.deepEqual(await confirm(db, [{ ...rowDoc(db), reviewRevision: failedRowRevision }], { requestId: "stale-existing" }), blocked, "Original blocked application receipt remains immutable after correction and successful new command");
  assert.equal((await finish(db)).completed, true);
});

test("expired private drafts reject overview, decisions and immutable receipt replay", async () => {
  const db = fixture(); await reconcile(db); await decide(db);
  db.records.set(jobRoot, { ...db.records.get(jobRoot), expiresAtMillis: 1 });
  await assert.rejects(workspace(db), /expired/); await assert.rejects(decide(db), /expired/); await assert.rejects(finish(db), /expired/);
});

test("an explicit mapping changes an unpriced existing offer's reviewed label without resizing or relabelling its old financial contract", async () => {
  const db = fixture(); await createExisting(db); await reconcile(db, [raw({ purchaseUnit: "ZK", pricePerPurchaseUnit: null })]);
  const old = rowDoc(db), modified = { ...old, normalizationVersion: 2,
    originalInput: { ...raw({ purchaseUnit: "ZK", pricePerPurchaseUnit: null }) }, normalizationFindings: [], packInference: null,
    purchaseUnitMapping: { sourceUnit: "ZK", suggestedUnit: "Bag", status: "unconfirmed", sourceFormat: "csv", profileId: "default", revision: 0 } };
  db.records.set(`${jobRoot}/rows/${old.rowId}`, modified); db.records.set(`${jobRoot}/reviewIndex/${old.rowId}`, review.indexRow(modified));
  const accumulator = proposal.supplierAiProposalInternals.adjustSummaryAccumulator({ version: 2,
    counts: { normalizedRows: 0, assumptionRows: 0, unknownPriceRows: 0, blockedNormalizationRows: 0, inferredPieceRows: 0, missingRequiredRows: 0 }, groups: {} }, modified);
  db.records.set(jobRoot, { ...db.records.get(jobRoot), reconciliation: { ...db.records.get(jobRoot).reconciliation, summaryAccumulator: accumulator } });
  const result = await apply(db, [modified]); assert.equal(result.outcomes[0].status, "mapped");
  const current = rowDoc(db); assert.equal(current.product.purchaseUnit, "Bag"); assert.equal(current.userPatch.purchaseUnit, "Bag");
  assert.equal(current.product.pricePerPurchaseUnit, 12); assert.equal(current.product.pricePerBaseUnit, 2); assert.equal(current.product.baseUnitsPerPurchaseUnit, 6);
  assert.equal(current.product.priceBasis, "net"); assert.equal(current.product.currency, "EUR"); assert.equal(current.review.status, "pending");
  assert.equal(history(db).length, 1, "Mapping review cannot write price history or change the existing offer yet");
});

test("a captured unfinished application command can recover an already applied row after another command completed the import", async () => {
  const db = fixture(); await reconcile(db); await decide(db); let interrupted = false;
  db.afterCommit = async (writes) => {
    if (!interrupted && writes.some(([, path]) => /\/commitOperations\/c-[^/]+$/.test(path))) {
      interrupted = true; throw new Error("Lost application command acknowledgement");
    }
  };
  await assert.rejects(confirm(db, [rowDoc(db)], { requestId: "captured-before-other-device" }), /Lost application/);
  const applied = await confirm(db, [rowDoc(db)], { requestId: "another-device" }); assert.equal(applied.outcomes[0].status, "created");
  await finish(db);
  const recovered = await confirm(db, [rowDoc(db)], { requestId: "captured-before-other-device" });
  assert.deepEqual(recovered.outcomes, applied.outcomes); assert.equal(history(db).length, 1);
});

test("real normalized source rows expose confirmed supplier mappings and known English labels as mapped workspace groups", async () => {
  const { extractSupplierAiSource } = require("./supplierAiExtraction"), { normalizeSupplierAiProposal } = require("./supplierAiNormalization");
  for (const [purchaseUnit, acceptedMappings, expectedStatus] of [["FL", [{ sourceUnit: "FL", purchaseUnit: "Bottle" }], "confirmed"], ["Bottle", [], "known"]]) {
    const db = fixture(), snapshot = { version: 1, supplierId, sourceFormat: "csv", profileId: "default", revision: acceptedMappings.length ? 1 : 0, mappings: acceptedMappings };
    db.records.set(jobRoot, { ...db.records.get(jobRoot), purchaseUnitMappingSnapshot: snapshot });
    const source = await extractSupplierAiSource({ bytes: Buffer.from(`SKU,Name,Eenheid,Package content,Purchase price,Currency,Price basis\nMILK6,Milk six pack,${purchaseUnit},6 l,12,EUR,net\n`), fileName: "offers.csv", mimeType: "text/csv" });
    const checked = proposal.validateRawSupplierAiRows({ rows: [raw({ purchaseUnit })] }, { sourceUnits: source.units });
    const normalized = normalizeSupplierAiProposal(checked[0], { importSettings: { policyVersion: 2, priceBasis: "net", currency: "EUR", vatRate: null }, sourceUnits: source.units, purchaseUnitMappingSnapshot: snapshot });
    assert.equal(normalized.purchaseUnitMapping.status, expectedStatus); assert.equal(normalized.purchaseUnit, "Bottle");
    const result = await proposal.reconcileSupplierAiRows({ db, hotelUid, supplierId, jobId, rows: [normalized], leaseId: "lease" });
    db.records.set(jobRoot, { ...db.records.get(jobRoot), status: "review", counts: result.counts, totalRows: result.totalRows, summary: result.summary });
    const loaded = await workspace(db); assert.equal(loaded.mappingGroups.length, 1);
    assert.equal(loaded.mappingGroups[0].status, "mapped"); assert.equal(loaded.mappingGroups[0].purchaseUnit, "Bottle");
    assert.equal(loaded.mappingGroups[0].suggestedUnit, "Bottle");
  }
});
