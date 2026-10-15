const test = require("node:test");
const assert = require("node:assert/strict");
const proposal = require("./supplierAiProposal");
const { mutateHotelSupplierProductHandler } = require("./products");
const { SAAS_RULES_VERSION } = require("./saasRollout");

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
const permissions = ["supplierproducts.read", "supplierproducts.create", "supplierproducts.update", "catalogproducts.read"];
function fixture() {
  return database({ [`hotels/${hotelUid}/members/${uid}`]: { permissions },
    [`hotelSubscriptions/${hotelUid}`]: { status: "active", modules: ["procurement"], modulePolicyVersion: 1 },
    "platformConfiguration/saasProcurement": { enabled: true, rulesVersion: SAAS_RULES_VERSION },
    "platformConfiguration/aiSupplierProductImport": { enabled: false, policyVersion: 1, revision: 4 },
    [`hotels/${hotelUid}/suppliers/${supplierId}`]: { name: "Dairy Company", active: true },
    [`hotels/${hotelUid}/catalogproducts/milk`]: { name: "Milk", baseUnit: "l", active: true, inventoryTracked: true, productPolicyVersion: 1, revision: 1 },
    [jobRoot]: { ownerUid: uid, supplierId, status: "processing", leaseId: "lease", configVersion: 3, configPolicyVersion: 1, expiresAtMillis: Date.now() + 1000000 } });
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
test("source-backed brands are reviewed as article changes; absent brands preserve a local correction", () => {
  const previous = offer({ brand: "Campina", revision: 1 });
  const build = (brand) => proposal.buildSupplierAiCandidate({ hotelUid, jobId, supplierId, rowIndex: 0,
    raw: raw({ brand }), previous });
  assert.equal(build(null).product.brand, "Campina");
  assert.equal(build(undefined).product.brand, "Campina");
  const changed = build("Arla");
  assert.equal(changed.product.brand, "Arla"); assert.equal(changed.recurringReview.category, "product-change");
  assert.deepEqual(changed.changes.filter((change) => change.field === "brand"), [{ field: "brand", before: "Campina", after: "Arla" }]);
  const corrected = proposal.buildSupplierAiCandidate({ hotelUid, jobId, supplierId, rowIndex: 0,
    raw: raw({ brand: null }), previous, userPatch: { brand: "" } });
  assert.equal(corrected.product.brand, "");
});
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

test("strict nullable transport schema rejects forged fields, incorrect types and unbounded anchors", () => {
  assert.equal(proposal.AI_SUPPLIER_SCHEMA.additionalProperties, false);
  const accepted = proposal.validateRawSupplierAiRows({ rows: [raw()] }, { sourceUnits });
  assert.equal(accepted[0].sourceAnchors[0].verified, true);
  for (const row of [raw({ catalogProductId: "guessed" }), raw({ productId: "foreign" }), raw({ currency: undefined }), raw({ pricePerPurchaseUnit: "12" }),
    raw({ sourceAnchors: null }), raw({ sourceAnchors: Array(9).fill({ sourceId: "csv-row-2", quote: "MILK6" }) }),
    raw({ sourceAnchors: [{ sourceId: "csv-row-2", quote: "x".repeat(1001) }] }), raw({ sourceAnchors: [{ sourceId: "x".repeat(161), quote: "MILK6" }] })]) {
    assert.throws(() => proposal.validateRawSupplierAiRows({ rows: [row] }, { sourceUnits }), (error) => error.code === "invalid-argument");
  }
  assert.throws(() => proposal.validateRawSupplierAiRows({ rows: Array(1001).fill(raw()) }, { sourceUnits }), /1000/);
});
test("missing, invented and unknown evidence blocks only its row, preserving all other source proposals", () => {
  const invalidRows = [raw({ sourceAnchors: [] }), raw({ sourceAnchors: [{ sourceId: "unknown", quote: "MILK6" }] }),
    raw({ sourceAnchors: [{ sourceId: "csv-row-2", quote: "invented" }] }), raw({ sourceAnchors: [{ sourceId: "csv-row-2", quote: "" }] })];
  for (const invalid of invalidRows) {
    const rows = proposal.validateRawSupplierAiRows({ rows: [raw(), invalid] }, { sourceUnits });
    assert.deepEqual(rows[0].sourceEvidenceIssues, []);
    assert.ok(rows[1].sourceEvidenceIssues.length);
    assert.ok(rows[1].sourceEvidenceIssues.every((entry) => entry.field === "sourceAnchors" && entry.severity === "error"));
    assert.equal(proposal.buildSupplierAiCandidate({ hotelUid, jobId, supplierId, rowIndex: 1, raw: rows[1] }).category, "blocked");
    assert.ok(rows[1].sourceEvidenceIssues.every((entry) => entry.message.includes("editing product fields cannot verify")));
  }
  const unknown = proposal.validateRawSupplierAiRows({ rows: [invalidRows[1]] }, { sourceUnits })[0].sourceAnchors[0];
  assert.equal(unknown.sourceExcerpt, null); assert.equal(unknown.verified, false); assert.equal(unknown.evidenceKind, "unverified-reference");
});
test("decoded CSV/XLSX cells verify exact escaped quotes and only canonical Unicode or whitespace differences", () => {
  const values = ["001", 'Milk "fresh"\nwhole', "Cafe\u0301\u00a0\tbeans", "12,50 EUR", "6 x 1 l", "① special"];
  for (const sourceId of ["csv-row-82", "xlsx-sheet-1-row-82"]) {
    const unit = { sourceId, anchor: "Source row 82", text: JSON.stringify(values) };
    for (const [quote, method] of [['Milk "fresh"\nwhole', "decoded-cell"], ['Milk "fresh" whole', "normalized-whitespace"], ["Café beans", "normalized-whitespace"]]) {
      const checked = proposal.validateRawSupplierAiRows({ rows: [raw({ sourceAnchors: [{ sourceId: unit.sourceId, quote }] })] }, { sourceUnits: [unit] })[0];
      assert.deepEqual(checked.sourceEvidenceIssues, []); assert.equal(checked.sourceAnchors[0].verified, true);
      assert.equal(checked.sourceAnchors[0].verificationMethod, method); assert.equal(checked.sourceAnchors[0].sourceExcerpt, unit.text);
    }
    // No case folding, punctuation removal, numeric format conversion, NFKC,
    // cell concatenation, order changes or guessed measurement equivalence.
    for (const quote of ["milk fresh", "12.50 EUR", "12,50 USD", "1250 EUR", "1000 ml", "l 1 x 6", "1 special", "001 Milk"]) {
      const checked = proposal.validateRawSupplierAiRows({ rows: [raw({ sourceAnchors: [{ sourceId: unit.sourceId, quote }] })] }, { sourceUnits: [unit] })[0];
      assert.ok(checked.sourceEvidenceIssues.some((entry) => entry.code === "evidence-quote-absent"), quote);
      assert.equal(checked.sourceAnchors[0].verified, false);
    }
  }
});
test("vision PDF anchors are page-bound and explicitly unverified rather than fabricated substring evidence", () => {
  const rows = proposal.validateRawSupplierAiRows({ rows: [raw({ sourceAnchors: [{ sourceId: "pdf-page-1", quote: "Visible milk offer" }] })] },
    { sourceUnits: [{ sourceId: "pdf-page-1", kind: "pdf-page", method: "vision", anchor: "PDF page 1", text: "PDF original page 1" }] });
  assert.equal(rows[0].sourceAnchors[0].verified, false); assert.equal(rows[0].sourceAnchors[0].anchor, "PDF page 1");
  assert.equal(rows[0].sourceAnchors[0].sourceExcerpt, null); assert.equal(rows[0].sourceAnchors[0].evidenceKind, "visual-page");
});
test("review evidence excerpts come from bounded server-parsed text, independently of the model quote", () => {
  const parsedText = `MILK6;Case;6 litres;EUR;12 net;${"x".repeat(2000)}`;
  const rows = proposal.validateRawSupplierAiRows({ rows: [raw()] }, { sourceUnits: [{ ...sourceUnits[0], text: parsedText }] });
  assert.equal(rows[0].sourceAnchors[0].sourceExcerpt, parsedText.slice(0, 1000));
  assert.equal(rows[0].sourceAnchors[0].sourceExcerpt.length, 1000); assert.equal(rows[0].sourceAnchors[0].excerptTruncated, true);
  assert.ok(rows[0].sourceAnchors[0].sourceExcerpt.includes("6 litres;EUR;12 net"));
  const spoof = raw({ sourceAnchors: [{ sourceId: "csv-row-2", quote: "MILK6", sourceExcerpt: "invented cheap offer" }] });
  assert.throws(() => proposal.validateRawSupplierAiRows({ rows: [spoof] }, { sourceUnits }), /Unsupported source anchor/);
});
test("repeated header context can substantiate currency or basis but cannot manufacture header-only products", () => {
  const header = { sourceId: "csv-header", anchor: "CSV record 1", text: "SKU;Name;EUR net", contextOnly: true };
  const row = raw({ sourceAnchors: [{ sourceId: "csv-row-2", quote: "MILK6" }, { sourceId: "csv-header", quote: "EUR net" }] });
  assert.equal(proposal.validateRawSupplierAiRows({ rows: [row] }, { sourceUnits: [...sourceUnits, header] })[0].sourceAnchors.length, 2);
  const manufactured = raw({ sourceAnchors: [{ sourceId: "csv-header", quote: "EUR net" }] });
  const rejected = proposal.validateRawSupplierAiRows({ rows: [manufactured] }, { sourceUnits: [...sourceUnits, header] })[0];
  assert.ok(rejected.sourceEvidenceIssues.some((entry) => entry.code === "evidence-context-only"));
  assert.equal(proposal.buildSupplierAiCandidate({ hotelUid, jobId, supplierId, rowIndex: 0, raw: rejected }).category, "blocked");
  // On the original first chunk, a possible header can actually be the first
  // product in a headerless file. The parser's warning remains reviewable.
  assert.equal(proposal.validateRawSupplierAiRows({ rows: [manufactured] }, { sourceUnits: [{ ...header, contextOnly: false }] }).length, 1);
});
test("81 proposed rows with one invented quote publish 80 reviewable offers and one durable blocked row", async () => {
  const db = fixture();
  const ExcelJS = require("exceljs"), { extractSupplierAiSource } = require("./supplierAiExtraction"), workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Supplier offers");
  sheet.addRow(["SKU", "Name", "Purchase unit", "Content", "Currency", "Net price"]);
  for (let index = 0; index < 81; index++) sheet.addRow([`MILK${index + 1}`, index === 0 ? 'Milk "fresh"\nwhole' : `Milk ${index + 1}`, "Case", "6 litres", "EUR", "12 net"]);
  // A real generated workbook runs through the production bounded extractor.
  // This is an independent fixture, not the customer's unavailable workbook.
  const source = await extractSupplierAiSource({ bytes: Buffer.from(await workbook.xlsx.writeBuffer()), fileName: "supplier-offers.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const units = source.units.slice(1);
  assert.equal(units.length, 81); assert.equal(units[80].sourceId, "xlsx-sheet-1-row-82");
  const input = units.map((unit, index) => raw({ supplierSku: `MILK${index + 1}`, supplierProductName: `Milk ${index + 1}`,
    sourceAnchors: [{ sourceId: unit.sourceId, quote: index === 80 ? "Invented product evidence" : index === 0 ? 'Milk "fresh" whole' : `MILK${index + 1}` }] }));
  const rows = proposal.validateRawSupplierAiRows({ rows: input }, { sourceUnits: units });
  assert.equal(units[0].text.includes(input[0].sourceAnchors[0].quote), false);
  assert.equal(rows[0].sourceAnchors[0].verified, true); assert.equal(rows[0].sourceAnchors[0].verificationMethod, "normalized-whitespace");
  const result = await proposal.reconcileSupplierAiRows({ db, hotelUid, supplierId, jobId, rows, leaseId: "lease" });
  db.records.set(jobRoot, { ...db.records.get(jobRoot), status: "review", ...result });
  assert.deepEqual(result, { totalRows: 81, counts: { new: 80, changed: 0, unchanged: 0, blocked: 1 }, complete: true, nextRowIndex: 81, summary: null });
  const reviewed = await proposal.readHotelSupplierAiImportRowsHandler(request({ hotelUid, jobId }), services(db));
  assert.equal(reviewed.rows.length, 81); assert.equal(reviewed.rows[79].category, "new"); assert.equal(reviewed.rows[80].category, "blocked");
  assert.ok(reviewed.rows[80].issues.some((entry) => entry.code === "evidence-quote-absent"));
  assert.equal(history(db).length, 0);
  const outcomes = (await confirm(db, [rowDoc(db), rowDoc(db, 81)])).outcomes;
  assert.deepEqual(outcomes.map((outcome) => outcome.status), ["created", "blocked"]); assert.equal(history(db).length, 1);
  await correct(db, { pricePerPurchaseUnit: 15 }, rowDoc(db, 81));
  assert.equal(rowDoc(db, 81).category, "blocked"); assert.equal(rowDoc(db, 81).product.pricePerPurchaseUnit, 15);
  assert.ok(rowDoc(db, 81).sourceEvidenceIssues.some((entry) => entry.code === "evidence-quote-absent"));
  assert.deepEqual(db.records.get(jobRoot).counts, result.counts);
  const stillBlocked = await confirm(db, [rowDoc(db, 81)], { requestId: "corrected-fields" });
  assert.equal(stillBlocked.outcomes[0].status, "blocked"); assert.match(stillBlocked.outcomes[0].error.message, /unverified source evidence/);
  assert.equal(history(db).length, 1);
});
test("a valid quote beside an invented reference does not authorize that row or clear after correction", async () => {
  for (const invalid of [{ sourceId: "unknown-source", quote: "MILK6" }, { sourceId: "csv-row-2", quote: "free food" }]) {
    const db = fixture(); await reconcile(db, [raw({ sourceAnchors: [{ sourceId: "csv-row-2", quote: "MILK6" }, invalid] })]);
    assert.equal(rowDoc(db).category, "blocked"); assert.equal(rowDoc(db).sourceAnchors[0].verified, true);
    await correct(db, { active: true, catalogProductId: "milk" }); assert.equal(rowDoc(db).category, "blocked");
    assert.equal((await confirm(db)).outcomes[0].status, "blocked"); assert.equal(history(db).length, 0);
  }
});
test("confirmation independently refuses persisted evidence errors even if the classification is inconsistent", async () => {
  const db = fixture(); await reconcile(db, [raw({ sourceAnchors: [{ sourceId: "csv-row-2", quote: "invented" }] })]);
  const row = rowDoc(db);
  db.records.set(`${jobRoot}/rows/${row.rowId}`, { ...row, category: "new", issues: [] });
  const confirmed = await confirm(db);
  assert.equal(confirmed.outcomes[0].status, "blocked"); assert.match(confirmed.outcomes[0].error.message, /unverified source evidence/);
  assert.equal(history(db).length, 0);
});
test("new offers are proposed only, inactive and unlinked until a human supplies explicit choices", async () => {
  const db = fixture(); await reconcile(db);
  assert.equal(rowDoc(db).category, "new"); assert.equal(rowDoc(db).product.active, false); assert.equal(rowDoc(db).product.catalogProductId, null);
  assert.equal([...db.records.keys()].some((path) => path.includes("/supplierproducts/")), false);
  const corrected = await correct(db, { active: true, catalogProductId: "milk" });
  assert.equal(corrected.row.reviewRevision, 2); assert.equal(corrected.row.sourceAnchors[0].quote, "MILK6");
  const result = await confirm(db);
  assert.equal(result.outcomes[0].status, "created"); assert.equal(history(db).length, 1);
  const saved = db.records.get(`hotels/${hotelUid}/supplierproducts/${result.outcomes[0].productId}`);
  assert.equal(saved.pricePerPurchaseUnit, 12); assert.equal(saved.pricePerBaseUnit, 2); assert.equal(saved.catalogProductId, "milk");
});
test("missing source currency, model and package contents remain null and blocked, while unknown prices remain unavailable", async () => {
  const db = fixture(); await reconcile(db, [raw({ currency: null, pricingModel: null, baseUnitsPerPurchaseUnit: null, priceBasis: null, pricePerPurchaseUnit: null })]);
  const row = rowDoc(db); assert.equal(row.category, "blocked"); assert.equal(row.product.currency, null); assert.equal(row.product.baseUnitsPerPurchaseUnit, null);
  assert.equal(row.product.pricePerPurchaseUnit, null); assert.equal(row.product.priceBasis, "unknown");
  assert.deepEqual(row.issues.filter((entry) => entry.code === "missing").map((entry) => entry.field).sort(), ["baseUnitsPerPurchaseUnit", "currency", "pricingModel"].sort());
  assert.equal((await confirm(db)).outcomes[0].status, "blocked"); assert.equal(history(db).length, 0);
  await correct(db, { currency: "USD", pricingModel: "Per Purchase Unit", baseUnitsPerPurchaseUnit: 6 });
  const created = (await confirm(db, [rowDoc(db)], { requestId: "corrected" })).outcomes[0];
  assert.equal(created.status, "created"); assert.equal(db.records.get(`hotels/${hotelUid}/supplierproducts/${created.productId}`).pricePerPurchaseUnit, null);
});
test("all malformed SKU, GTIN, VAT, units and fractional precision are reported without writing products", async () => {
  const db = fixture(); await reconcile(db, [raw({ supplierSku: "", gtin: "6291041500214", vatRate: 8, baseUnit: "litres", baseUnitsPerPurchaseUnit: 0.0000001 })]);
  const row = rowDoc(db); assert.equal(row.category, "blocked");
  for (const field of ["supplierSku", "gtin", "vatRate", "baseUnit", "baseUnitsPerPurchaseUnit"]) assert.ok(row.issues.some((entry) => entry.field === field));
  assert.equal((await confirm(db)).outcomes[0].status, "blocked");
});
test("existing exact supplier plus SKU preserves stable catalog/packages/GTIN/media and immutable prior terms", async () => {
  const db = fixture(), existing = await createExisting(db, { gtin: "16291041500210", priceValidFrom: "2026-10-01",
    purchaseOptions: [{ id: "single", purchaseUnit: "Bottle", baseUnitsPerPurchaseUnit: 1, pricePerPurchaseUnit: 2, gtin: "6291041500213" }] });
  const path = `hotels/${hotelUid}/supplierproducts/${existing.productId}`, image = { status: "ready", assetId: "a".repeat(64) };
  db.records.set(path, { ...db.records.get(path), image, imageRevision: 5 });
  db.records.set(`hotels/${hotelUid}/orders/old`, { frozenPrice: 12 }); const before = JSON.stringify(history(db));
  await reconcile(db, [raw({ pricePerPurchaseUnit: 15, gtin: null, priceValidFrom: null, baseUnit: null, currency: null })]);
  const row = rowDoc(db); assert.equal(row.productId, existing.productId); assert.equal(row.category, "changed");
  assert.equal(row.product.gtin, "16291041500210"); assert.equal(row.product.priceValidFrom, "2026-10-01"); assert.equal(row.product.purchaseOptions[0].id, "single");
  assert.equal(row.product.purchaseOptions[0].gtin, "6291041500213"); assert.equal(row.product.currency, "EUR");
  const result = await confirm(db); assert.equal(result.outcomes[0].status, "updated"); assert.equal(history(db).length, 2);
  assert.equal(JSON.stringify(history(db).slice(0, 1)), before); assert.deepEqual(db.records.get(path).image, image); assert.equal(db.records.get(path).imageRevision, 5);
  assert.equal(db.records.get(`hotels/${hotelUid}/orders/old`).frozenPrice, 12);
  assert.deepEqual(await confirm(db), result); assert.equal(history(db).length, 2);
});
test("a similar name or differently cased SKU never chooses an existing identity; duplicate exact identities block", async () => {
  const db = fixture(); await createExisting(db);
  await reconcile(db, [raw({ supplierSku: "milk6" })]); assert.equal(rowDoc(db).category, "new");
  const duplicate = fixture(); duplicate.records.set(`hotels/${hotelUid}/supplierproducts/first`, offer({ revision: 1 })); duplicate.records.set(`hotels/${hotelUid}/supplierproducts/second`, offer({ revision: 1 }));
  await reconcile(duplicate); assert.equal(rowDoc(duplicate).category, "blocked"); assert.ok(rowDoc(duplicate).issues.some((entry) => entry.code === "ambiguous-existing-sku"));
  const sourceDuplicate = fixture(); await reconcile(sourceDuplicate, [raw(), raw()]);
  assert.equal(rowDoc(sourceDuplicate).category, "blocked"); assert.equal(rowDoc(sourceDuplicate, 2).category, "blocked");
});
test("existing identities cannot be changed through AI corrections, and unknown package conversion cannot silently be substituted", async () => {
  const db = fixture(); await createExisting(db); await reconcile(db, [raw({ baseUnit: "ml", baseUnitsPerPurchaseUnit: 6000 })]);
  assert.equal(rowDoc(db).category, "blocked"); assert.ok(rowDoc(db).issues.some((entry) => entry.code === "protected-identity"));
  await correct(db, { supplierSku: "OTHER", catalogProductId: null }); assert.equal(rowDoc(db).category, "blocked");
  assert.equal((await confirm(db)).outcomes[0].status, "blocked"); assert.equal(history(db).length, 1);
});
test("user-corrected options preserve omitted GTIN by stable ID, and explicit barcode clearing is metadata only", async () => {
  const db = fixture(); await createExisting(db, { purchaseOptions: [{ id: "single", purchaseUnit: "Bottle", baseUnitsPerPurchaseUnit: 1, pricePerPurchaseUnit: 2, gtin: "6291041500213" }] });
  await reconcile(db); await correct(db, { purchaseOptions: [{ id: "single", purchaseUnit: "Bottle", baseUnitsPerPurchaseUnit: 1, pricePerPurchaseUnit: 2 }] });
  assert.equal(rowDoc(db).product.purchaseOptions[0].gtin, "6291041500213"); assert.equal(rowDoc(db).category, "unchanged");
  await correct(db, { purchaseOptions: [{ id: "single", purchaseUnit: "Bottle", baseUnitsPerPurchaseUnit: 1, pricePerPurchaseUnit: 2, gtin: null }] });
  assert.equal(rowDoc(db).category, "changed"); await confirm(db);
  assert.equal(history(db).length, 2, "The genuine unchanged source price is confirmed independently of the GTIN metadata change");
  assert.equal(history(db).at(-1)[1].observation, "price-confirmed");
  assert.equal([...db.records.keys()].filter((path) => path.includes("/supplierPriceVersions/")).length, 1, "A confirmation does not create another price version");
});
test("legacy unspecified variants stay blocked until an explicit human purchase-option configuration is supplied", async () => {
  const db = fixture(); db.records.set(`hotels/${hotelUid}/supplierproducts/legacy`, offer({ hasVariants: true, revision: 0 }));
  await reconcile(db); assert.ok(rowDoc(db).issues.some((entry) => entry.code === "legacy-variants"));
  await correct(db, { purchaseOptions: [{ id: "single", purchaseUnit: "Bottle", baseUnitsPerPurchaseUnit: 1, pricePerPurchaseUnit: 2 }] });
  assert.equal(rowDoc(db).category, "changed"); const result = await confirm(db);
  assert.equal(result.outcomes[0].status, "updated"); assert.equal(result.outcomes[0].productId, "legacy");
  assert.equal(db.records.get(`hotels/${hotelUid}/supplierproducts/legacy`).purchaseOptions[0].id, "single");
});
test("same correction replay is idempotent, different stale correction is rejected and confirmation needs fresh row acknowledgement", async () => {
  const db = fixture(); await reconcile(db); const initial = rowDoc(db);
  const result = await correct(db, { active: true }, initial); assert.deepEqual(await correct(db, { active: true }, initial), result);
  await assert.rejects(correct(db, { active: false }, initial), (error) => error.code === "aborted");
  const stale = (await confirm(db, [initial])).outcomes[0]; assert.equal(stale.status, "blocked"); assert.equal(stale.error.code, "aborted");
  await assert.rejects(confirm(db, [rowDoc(db)], { requestId: "unreviewed", rows: [{ rowId: rowDoc(db).rowId, reviewRevision: 2, acknowledged: false }] }), /acknowledgement/);
});
test("stale product revisions become durable blocked outcomes and cannot overwrite a later manually saved price", async () => {
  const db = fixture(), existing = await createExisting(db); await reconcile(db, [raw({ pricePerPurchaseUnit: 15 })]);
  await mutateHotelSupplierProductHandler(request({ hotelUid, requestId: "manual-update", action: "update", productId: existing.productId, expectedRevision: 1, product: offer({ pricePerPurchaseUnit: 18 }) }), services(db));
  const blocked = await confirm(db); assert.equal(blocked.outcomes[0].error.code, "aborted"); assert.equal(history(db).length, 2);
  assert.deepEqual(await confirm(db), blocked);
  await correct(db, {}); assert.equal(rowDoc(db).expectedRevision, 2); assert.equal(rowDoc(db).previousProduct.pricePerPurchaseUnit, 18);
  const updated = await confirm(db, [rowDoc(db)], { requestId: "re-reviewed" }); assert.equal(updated.outcomes[0].revision, 3); assert.equal(history(db).length, 3);
});
test("hotel, owner, action, catalogue access, subscription and live identity fences apply including durable replay", async () => {
  const db = fixture(); await reconcile(db); await confirm(db);
  db.records.set(`hotels/${hotelUid}/members/other`, { permissions });
  await assert.rejects(proposal.readHotelSupplierAiImportRowsHandler(request({ hotelUid, jobId }, "other"), services(db)), (error) => error.code === "permission-denied");
  await assert.rejects(proposal.readHotelSupplierAiImportRowsHandler(request({ hotelUid: "hotel-b", jobId }), services(db)), (error) => error.code === "permission-denied");
  db.records.set(`hotels/${hotelUid}/members/${uid}`, { permissions: ["supplierproducts.read"] });
  await assert.rejects(confirm(db), (error) => error.code === "permission-denied");
  db.records.set(`hotels/${hotelUid}/members/${uid}`, { permissions });
  await assert.rejects(proposal.readHotelSupplierAiImportRowsHandler(request({ hotelUid, jobId }), services(db, { auth: { getUser: async () => ({ uid, emailVerified: true, disabled: true }) } })), (error) => error.code === "permission-denied");
  db.records.set(`hotelSubscriptions/${hotelUid}`, { status: "suspended", modules: ["procurement"], modulePolicyVersion: 1 });
  await assert.rejects(confirm(db), (error) => error.code === "permission-denied");
});
test("cross-hotel catalog links and forged media are rejected; update permission loss stops edits and replay", async () => {
  const db = fixture(), existing = await createExisting(db); await reconcile(db, [raw({ pricePerPurchaseUnit: 15 })]);
  await assert.rejects(correct(db, { image: { assetId: "foreign" } }), /Unsupported/);
  db.records.set("hotels/hotel-b/catalogproducts/foreign", { baseUnit: "l" });
  await correct(db, { catalogProductId: "foreign" }); assert.equal(rowDoc(db).category, "blocked");
  await correct(db, { catalogProductId: "milk" }); await confirm(db);
  db.records.set(`hotels/${hotelUid}/members/${uid}`, { permissions: ["supplierproducts.read", "supplierproducts.create", "catalogproducts.read"] });
  await assert.rejects(confirm(db), (error) => error.code === "permission-denied");
  assert.equal(db.records.get(`hotels/${hotelUid}/supplierproducts/${existing.productId}`).revision, 2);
  const noCatalogRead = fixture(); await reconcile(noCatalogRead); noCatalogRead.records.set(`hotels/${hotelUid}/members/${uid}`, { permissions: ["supplierproducts.read", "supplierproducts.create"] });
  await assert.rejects(correct(noCatalogRead, { catalogProductId: "milk" }), (error) => error.code === "permission-denied");
});
test("platform administration grants no operational hotel bypass and an expired policy cannot confirm drafts", async () => {
  const db = fixture(); await reconcile(db);
  const platformRequest = request({ hotelUid, jobId }, "platform-operator"); platformRequest.auth.token.platformAdmin = true;
  const platformAuth = { getUser: async (actor) => ({ uid: actor, emailVerified: true, disabled: false, customClaims: { platformAdmin: true } }) };
  await assert.rejects(proposal.readHotelSupplierAiImportRowsHandler(platformRequest, services(db, { auth: platformAuth })), (error) => error.code === "permission-denied");
  db.records.set(jobRoot, { ...db.records.get(jobRoot), configPolicyVersion: 99 });
  await assert.rejects(confirm(db), /policy needs review/); assert.equal(history(db).length, 0);
});
test("private platform configuration failures never expose model names or budget fields through confirmation", async () => {
  for (const patch of [{ model: "private-expensive-model" }, { maxCostPerImportUsd: "0.25" }, { maxMonthlyCostPerHotelUsd: "10" },
    { fallbackEnabled: true }, { reasoningEffort: "private-effort" }]) {
    const db = fixture(); await reconcile(db);
    db.records.set("platformConfiguration/aiSupplierProductImport", { enabled: false, policyVersion: 1, revision: 4, ...patch });
    await assert.rejects(confirm(db), (error) => error.code === "failed-precondition"
      && error.message === "This import needs administrator assistance before it can be confirmed.");
    assert.equal(history(db).length, 0);
  }
});
test("duplicates are revalidated after explicit supported SKU corrections rather than keeping obsolete blocking flags", async () => {
  const db = fixture(); await reconcile(db, [raw(), raw()]);
  await correct(db, { supplierSku: "MILK7" }, rowDoc(db, 2)); assert.equal(rowDoc(db, 2).category, "new");
  await correct(db, {}, rowDoc(db)); assert.equal(rowDoc(db).category, "new");
  const created = await confirm(db, [rowDoc(db), rowDoc(db, 2)]); assert.deepEqual(created.outcomes.map((outcome) => outcome.status), ["created", "created"]);
});
test("partial response loss replays the original bounded operation and produces exactly one history/audit per row", async () => {
  const db = fixture(); await reconcile(db, [raw(), raw({ supplierSku: "MILK7" })]);
  let lost = false;
  db.afterCommit = async (writes) => {
    if (!lost && writes.some(([, path]) => path.includes("/commitOperations/") && path.endsWith("/rows/r-000001"))) { lost = true; throw new Error("response lost after committed row"); }
  };
  const selected = [rowDoc(db), rowDoc(db, 2)]; await assert.rejects(confirm(db, selected), /response lost/);
  assert.equal(history(db).length, 1);
  const resumed = await confirm(db, selected); assert.deepEqual(resumed.outcomes.map((row) => row.status), ["created", "created"]); assert.equal(history(db).length, 2);
  assert.equal([...db.records.keys()].filter((path) => path.includes("/productAudit/ai-")).length, 2);
  await assert.rejects(confirm(db, [selected[1]]), (error) => error.code === "already-exists");
});
test("revocation between confirmation rows stops later writes while preserving earlier durable outcomes", async () => {
  const db = fixture(); await reconcile(db, [raw(), raw({ supplierSku: "MILK7" })]);
  db.afterCommit = async (writes) => {
    if (writes.some(([, path]) => path.includes("/commitOperations/") && path.endsWith("/rows/r-000001"))) db.records.set(`hotels/${hotelUid}/members/${uid}`, { permissions: [] });
  };
  await assert.rejects(confirm(db, [rowDoc(db), rowDoc(db, 2)]), (error) => error.code === "permission-denied");
  assert.equal(history(db).length, 1); assert.ok(rowDoc(db).committed); assert.equal(rowDoc(db, 2).committed, null);
});
test("1000 separate candidates paginate deterministically; expired jobs and lost worker leases fail explicitly", async () => {
  const db = fixture(); await reconcile(db, Array.from({ length: 1000 }, (_, index) => raw({ supplierSku: `SKU-${index}` })));
  assert.equal(db.records.get(jobRoot).totalRows, 1000);
  const page = await proposal.readHotelSupplierAiImportRowsHandler(request({ hotelUid, jobId, limit: 100 }), services(db));
  assert.equal(page.rows.length, 100); assert.equal(page.nextCursor, "r-000100");
  const next = await proposal.readHotelSupplierAiImportRowsHandler(request({ hotelUid, jobId, cursor: page.nextCursor, limit: 100 }), services(db));
  assert.equal(next.rows[0].rowId, "r-000101"); assert.equal(next.totalRows, 1000);
  db.records.set(jobRoot, { ...db.records.get(jobRoot), expiresAtMillis: 1 });
  await assert.rejects(confirm(db), /expired/);
  const lost = fixture(); await assert.rejects(proposal.reconcileSupplierAiRows({ db: lost, hotelUid, supplierId, jobId, rows: [raw()], leaseId: "foreign" }), /lease/);
  assert.equal([...lost.records.keys()].some((path) => path.includes("/rows/")), false);
});
test("bounded reconciliation resumes atomic rows and counts after a lost response or worker deadline", async () => {
  const db = fixture(), source = { path: "private/hotel-a/source", generation: "100", sha256: "a".repeat(64), size: 123, contentType: "text/csv" };
  db.records.set(jobRoot, { ...db.records.get(jobRoot), source });
  const rows = proposal.validateRawSupplierAiRows({ rows: Array.from({ length: 250 }, (_, index) => raw({ supplierSku: `SKU-${index}` })) }, { sourceUnits });
  const run = (patch = {}) => proposal.reconcileSupplierAiRows({ db, hotelUid, supplierId, jobId, rows, leaseId: "lease", ...patch });
  const first = await run();
  assert.deepEqual(first, { counts: { new: 100, changed: 0, unchanged: 0, blocked: 0 }, totalRows: 250, complete: false, nextRowIndex: 100, summary: null });
  assert.equal([...db.records.keys()].filter((path) => path.startsWith(`${jobRoot}/rows/`)).length, 100);
  const firstRow = JSON.stringify(rowDoc(db));
  let lostResponse = false;
  db.afterCommit = async (writes) => {
    if (!lostResponse && writes.some(([, path]) => path === `${jobRoot}/rows/r-000101`)) {
      lostResponse = true; throw Error("response lost after atomic reconciliation row");
    }
  };
  await assert.rejects(run(), /response lost/);
  assert.equal(db.records.get(jobRoot).reconciliation.nextRowIndex, 101);
  assert.equal(db.records.get(jobRoot).reconciliation.counts.new, 101);
  db.afterCommit = null;
  let remaining = 5;
  const yielded = await run({ shouldContinue: () => remaining-- > 0 });
  assert.equal(yielded.complete, false); assert.equal(yielded.nextRowIndex, 106); assert.equal(yielded.counts.new, 106);
  const paused = await run({ shouldContinue: () => false }); assert.deepEqual(paused, yielded);
  await assert.rejects(run({ maxRows: 101 }), /bounded worker pass/);
  const changedRows = rows.map((row, index) => index === 249 ? { ...row, pricePerPurchaseUnit: 13 } : row);
  await assert.rejects(run({ rows: changedRows }), /source or proposals changed/);
  db.records.set(jobRoot, { ...db.records.get(jobRoot), source: { ...source, generation: "101" } });
  await assert.rejects(run(), /source or proposals changed/);
  db.records.set(jobRoot, { ...db.records.get(jobRoot), source, leaseId: "lease-2" });
  await assert.rejects(run(), /lease is no longer current/);
  let finished;
  do { finished = await run({ leaseId: "lease-2" }); } while (!finished.complete);
  assert.deepEqual(finished, { counts: { new: 250, changed: 0, unchanged: 0, blocked: 0 }, totalRows: 250, complete: true, nextRowIndex: 250, summary: null });
  assert.equal([...db.records.keys()].filter((path) => path.startsWith(`${jobRoot}/rows/`)).length, 250);
  assert.equal(JSON.stringify(rowDoc(db)), firstRow); assert.equal(history(db).length, 0);
  assert.deepEqual(await run({ leaseId: "lease-2" }), finished);
  db.records.set(jobRoot, { ...db.records.get(jobRoot), status: "review", totalRows: finished.totalRows, counts: finished.counts });
  await correct(db, { supplierProductName: "Reviewed milk" }); const corrected = JSON.stringify(rowDoc(db));
  await assert.rejects(run({ leaseId: "lease-2" }), /lease is no longer current/);
  assert.equal(JSON.stringify(rowDoc(db)), corrected);
});
test("corrupt reconciliation receipts cannot skip or reclassify source rows", async () => {
  for (const patch of [{ nextRowIndex: 0.5 }, { nextRowIndex: 2 }, { counts: { new: 2, changed: 0, unchanged: 0, blocked: 0 } },
    { counts: { new: 1, changed: 0, unchanged: 0 } }, { counts: { new: -1, changed: 0, unchanged: 0, blocked: 2 } }]) {
    const db = fixture(), rows = proposal.validateRawSupplierAiRows({ rows: [raw()] }, { sourceUnits });
    await proposal.reconcileSupplierAiRows({ db, hotelUid, supplierId, jobId, rows, leaseId: "lease" });
    const job = db.records.get(jobRoot), before = JSON.stringify(rowDoc(db));
    db.records.set(jobRoot, { ...job, reconciliation: { ...job.reconciliation, ...patch } });
    await assert.rejects(proposal.reconcileSupplierAiRows({ db, hotelUid, supplierId, jobId, rows, leaseId: "lease" }), /reconciliation progress is invalid/);
    assert.equal(JSON.stringify(rowDoc(db)), before);
  }
});
test("corrupt review job totals, source configuration revisions and classification counts never masquerade as empty valid imports", async () => {
  for (const patch of [{ totalRows: undefined }, { totalRows: null }, { totalRows: 0 }, { totalRows: 1001 }, { totalRows: 1.5 }, { totalRows: "1" },
    { configVersion: undefined }, { configVersion: -1 }, { configVersion: 2.5 }, { configPolicyVersion: undefined },
    { counts: undefined }, { counts: { new: 1, changed: 0, unchanged: 0 } }, { counts: { new: 0, changed: 0, unchanged: 0, blocked: 0 } },
    { counts: { new: 1, changed: -1, unchanged: 0, blocked: 1 } }]) {
    const db = fixture(); await reconcile(db); const row = rowDoc(db);
    db.records.set(jobRoot, { ...db.records.get(jobRoot), ...patch });
    await assert.rejects(proposal.readHotelSupplierAiImportRowsHandler(request({ hotelUid, jobId }), services(db)), (error) => error.code === "failed-precondition");
    await assert.rejects(correct(db, {}, row), (error) => error.code === "failed-precondition");
    await assert.rejects(confirm(db, [row]), (error) => error.code === "failed-precondition");
    assert.equal([...db.records.keys()].some((path) => path.includes("/supplierproducts/")), false);
    assert.equal([...db.records.keys()].some((path) => path.includes("/commitOperations/")), false);
  }
});
test("classification overview changes atomically with correction, while exact replay cannot double-adjust counts", async () => {
  const db = fixture(); await reconcile(db, [raw({ currency: null }), raw({ supplierSku: "MILK7" })]);
  const before = db.records.get(jobRoot), original = rowDoc(db);
  assert.deepEqual(before.counts, { new: 1, changed: 0, unchanged: 0, blocked: 1 });
  const corrected = await correct(db, { currency: "EUR" }, original);
  assert.equal(corrected.row.category, "new"); assert.deepEqual(db.records.get(jobRoot).counts, { new: 2, changed: 0, unchanged: 0, blocked: 0 });
  assert.deepEqual(await correct(db, { currency: "EUR" }, original), corrected);
  assert.deepEqual(db.records.get(jobRoot).counts, { new: 2, changed: 0, unchanged: 0, blocked: 0 });
  await correct(db, { currency: null }); assert.equal(rowDoc(db).category, "blocked");
  assert.deepEqual(db.records.get(jobRoot).counts, { new: 1, changed: 0, unchanged: 0, blocked: 1 });
  assert.equal(db.records.get(jobRoot).totalRows, before.totalRows); assert.equal(db.records.get(jobRoot).configVersion, before.configVersion);
  assert.equal(db.records.get(jobRoot).configPolicyVersion, before.configPolicyVersion);
});
test("normalization policy 2 uses a separate canonical schema and cannot be forged through provider output", () => {
  assert.equal(proposal.AI_SUPPLIER_SCHEMA.properties.rows.items.properties.baseUnit.enum, undefined);
  assert.deepEqual(proposal.AI_SUPPLIER_SCHEMA_V2.properties.rows.items.properties.baseUnit.enum, ["g", "kg", "ml", "l", "each", null]);
  assert.deepEqual(proposal.AI_SUPPLIER_SCHEMA_V2.properties.rows.items.properties.pricingModel.enum, ["Per Purchase Unit", "Per Base Unit", null]);
  for (const patch of [{ normalizationVersion: 2 }, { originalInput: {} }, { normalizationFindings: [] }, { packInference: { piecesPerPurchaseUnit: 100 } }]) {
    assert.throws(() => proposal.validateRawSupplierAiRows({ rows: [raw(patch)] }, { sourceUnits }), /Unsupported AI row/);
  }
});
test("import-wide normalization findings include all 125 rows and correct atomically without double counting replay", async () => {
  const { normalizeSupplierAiProposal } = require("./supplierAiNormalization"), db = fixture();
  const sources = [{ sourceId: "csv-header", anchor: "Header", contextOnly: true, text: JSON.stringify(["SKU", "Name", "Package", "Content"]) }];
  const input = Array.from({ length: 125 }, (_, index) => {
    const sku = `SKU-${index}`, sourceId = `csv-row-${index + 2}`, blocked = index >= 120;
    sources.push({ sourceId, anchor: `Row ${index + 2}`, text: JSON.stringify([sku, "MOZZARELLA400G", blocked ? "DS" : "PK", blocked ? "" : "400GR"]) });
    return raw({ supplierSku: sku, supplierProductName: "MOZZARELLA400G", purchaseUnit: blocked ? "DS" : "PK", baseUnit: "GR",
      baseUnitsPerPurchaseUnit: blocked ? null : 400, currency: null, priceBasis: null, pricingModel: null,
      pricePerPurchaseUnit: null, sourceAnchors: [{ sourceId, quote: sku }] });
  });
  const settings = { policyVersion: 2, currency: "EUR", priceBasis: "net", vatRate: null };
  const rows = proposal.validateRawSupplierAiRows({ rows: input }, { sourceUnits: sources }).map((row) => normalizeSupplierAiProposal(row, { importSettings: settings, sourceUnits: sources }));
  const run = () => proposal.reconcileSupplierAiRows({ db, hotelUid, supplierId, jobId, rows, leaseId: "lease" });
  const first = await run(); assert.equal(first.complete, false); assert.equal(first.summary.totalRows, 125); assert.equal(first.summary.normalizedRows, 100);
  const result = await run(); assert.equal(result.complete, true); assert.deepEqual(result.counts, { new: 120, changed: 0, unchanged: 0, blocked: 5 });
  assert.equal(result.summary.normalizedRows, 125); assert.equal(result.summary.assumptionRows, 125); assert.equal(result.summary.unknownPriceRows, 125);
  assert.equal(result.summary.blockedNormalizationRows, 5); assert.equal(result.summary.missingRequiredRows, 5); assert.equal(result.summary.inferredPieceRows, 0);
  assert.ok(result.summary.findings.length <= 20); assert.ok(result.summary.findings.every((entry) => entry.rowIds.length <= 3 && entry.count <= 125));
  assert.equal(result.summary.findings.find((entry) => entry.code === "source-price-missing").count, 125);
  assert.equal(result.summary.findings.find((entry) => entry.code === "package-content-missing").count, 5);
  assert.deepEqual(await run(), result);
  db.records.set(jobRoot, { ...db.records.get(jobRoot), status: "review", counts: result.counts, totalRows: result.totalRows, summary: result.summary });
  const page = await proposal.readHotelSupplierAiImportRowsHandler(request({ hotelUid, jobId, limit: 100 }), services(db));
  assert.equal(page.rows.length, 100); assert.equal(page.rows[0].originalInput.supplierProductName, "MOZZARELLA400G");
  const blockedRow = rowDoc(db, 121), correctionInput = request({ hotelUid, jobId, rowId: blockedRow.rowId, expectedReviewRevision: blockedRow.reviewRevision, patch: { baseUnitsPerPurchaseUnit: 400 } });
  const corrected = await proposal.correctHotelSupplierAiImportRowHandler(correctionInput, services(db));
  assert.equal(corrected.row.category, "new"); assert.equal(db.records.get(jobRoot).summary.blockedNormalizationRows, 4);
  assert.equal(db.records.get(jobRoot).summary.missingRequiredRows, 4); assert.equal(db.records.get(jobRoot).summary.findings.find((entry) => entry.code === "package-content-missing").count, 4);
  assert.deepEqual(await proposal.correctHotelSupplierAiImportRowHandler(correctionInput, services(db)), corrected);
  assert.equal(db.records.get(jobRoot).summary.missingRequiredRows, 4);
  await correct(db, { pricePerPurchaseUnit: 12 }); assert.equal(db.records.get(jobRoot).summary.unknownPriceRows, 124);
  assert.equal(db.records.get(jobRoot).summary.findings.find((entry) => entry.code === "source-price-missing").count, 125);
  assert.equal((await confirm(db)).outcomes[0].status, "created"); assert.equal(db.records.get(jobRoot).summary.totalRows, 125);
  assert.equal(rowDoc(db).originalInput.pricePerPurchaseUnit, null); assert.equal(rowDoc(db).product.pricePerPurchaseUnit, 12);
});
test("legacy review rows retain no fabricated normalization history or import-wide summary", async () => {
  const db = fixture(), result = await reconcile(db);
  assert.equal(result.summary, null);
  const page = await proposal.readHotelSupplierAiImportRowsHandler(request({ hotelUid, jobId }), services(db));
  assert.equal(page.rows[0].normalizationVersion, null); assert.equal(page.rows[0].normalizationFindings, null);
  assert.equal(page.rows[0].originalInput, null); assert.equal(page.rows[0].packInference, null);
});
