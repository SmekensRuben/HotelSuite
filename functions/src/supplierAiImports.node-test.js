const test = require("node:test");
const assert = require("node:assert/strict");
const { SAAS_RULES_VERSION } = require("./saasRollout");
const { DEFAULT_AI_CONFIGURATION } = require("./supplierAiPolicy");
const { uploadSupplierAiImport, readSupplierAiImport, runSupplierAiImportJob, normalizeMonth, supplierProductAiImportHandler, cleanupSupplierAiSourcesHandler, publicJob, publicImportError } = require("./supplierAiImports");
function memoryDatabase(initial = {}) {
  const records = new Map(Object.entries(initial)); let serial = Promise.resolve();
  const snapshot = (path) => ({ id: path.split("/").at(-1), exists: records.has(path), data: () => records.get(path), ref: db.doc(path) });
  const apply = (path, values, replace = false) => {
    const data = replace ? {} : { ...records.get(path) };
    for (const [key, value] of Object.entries(values)) { if (value?.constructor.name === "DeleteTransform") delete data[key]; else data[key] = value; }
    records.set(path, data);
  };
  const query = (path, group = false, conditions = [], maximum = Infinity, after = null) => ({
    where: (field, op, value) => query(path, group, [...conditions, [field, op, value]], maximum, after),
    limit: (n) => query(path, group, conditions, n, after), orderBy: () => query(path, group, conditions, maximum, after),
    startAfter: (id) => query(path, group, conditions, maximum, typeof id === "string" ? id : id.id),
    get: async () => ({ docs: [...records.keys()].filter((key) => group ? key.split("/").at(-2) === path : key.startsWith(path + "/") && key.split("/").length === path.split("/").length + 1)
      .sort().filter((key) => after == null || key.split("/").at(-1) > after).filter((key) => conditions.every(([field, op, value]) => {
        const stored = records.get(key)[field]; if (op === "==") return stored === value;
        return stored != null && (stored.toMillis?.() ?? stored) <= (value.toMillis?.() ?? value);
      })).slice(0, maximum).map(snapshot) }) });
  const db = { records, doc: (path) => ({ path, id: path.split("/").at(-1), get: async () => snapshot(path),
    set: async (data, options) => apply(path, data, !options?.merge), delete: async () => records.delete(path) }),
    collection: (path) => query(path), collectionGroup: (path) => query(path, true),
    batch: () => { const writes = []; return { delete: (ref) => writes.push(ref.path), commit: async () => writes.forEach((path) => records.delete(path)) }; },
    runTransaction(fn) {
      const run = serial.then(async () => {
        const writes = [];
        const tx = { get: async (ref) => { assert.equal(writes.length, 0, "Firestore reads must precede writes"); return snapshot(ref.path); },
          create: (ref, data) => { assert.equal(records.has(ref.path), false); writes.push([ref.path, data, true]); },
          update: (ref, data) => { assert.equal(records.has(ref.path), true); writes.push([ref.path, data, false]); },
          set: (ref, data) => writes.push([ref.path, data, true]) };
        const result = await fn(tx); for (const [path, data, replace] of writes) apply(path, data, replace); return result;
      }); serial = run.catch(() => {}); return run;
    } };
  return db;
}
function memoryBucket() {
  const objects = new Map(); let generation = 8000000000000000000n;
  const bucket = { name: "fictional.appspot.com", objects, failSave: false, file(path, options = {}) {
    const current = () => { const value = objects.get(path); if (!value || options.generation && options.generation !== value.metadata.generation) throw Object.assign(Error("missing"), { code: 404 }); return value; };
    return { name: path, save: async (bytes, saveOptions) => {
      if (bucket.failSave) { bucket.failSave = false; throw Error("save unavailable"); }
      assert.equal(saveOptions.preconditionOpts.ifGenerationMatch, 0);
      if (objects.has(path)) throw Object.assign(Error("existing"), { code: 412 });
      objects.set(path, { bytes: Buffer.from(bytes), metadata: { ...saveOptions.metadata, size: String(bytes.length), generation: String(++generation) } });
    }, getMetadata: async () => [current().metadata], download: async () => [Buffer.from(current().bytes)],
    delete: async (opts) => { if (opts.ifGenerationMatch !== current().metadata.generation) throw Error("generation mismatch"); objects.delete(path); } };
  }, getFiles: async ({ prefix, maxResults }) => [[...objects.keys()].filter((key) => key.startsWith(prefix)).slice(0, maxResults).map((key) => bucket.file(key))] };
  return bucket;
}
const request = () => ({ auth: { uid: "buyer", token: { email_verified: true, auth_time: 9999 } } });
const data = (patch = {}) => ({ hotelUid: "hotel-a", supplierId: "dairy", requestId: "import-one", fileName: "supplier.csv", mimeType: "text/csv", ...patch });
const bytes = Buffer.from("SKU,Name\n001,Milk\n");
const response = (patch = {}) => ({ id: "fictional-response", model: "gpt-6-luna", status: "completed",
  usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30, output_tokens_details: { reasoning_tokens: 5 } },
  output: [{ type: "message", content: [{ type: "output_text", text: '{"rows":[{"supplierSku":"001","supplierProductName":"Milk"}]}' }] }], ...patch });
function fixture(configuration = {}) {
  let now = Date.parse("2026-10-13T19:02:10.000Z");
  const firestore = memoryDatabase({
    "hotels/hotel-a": { hotelName: "Fictional hotel" },
    "platformConfiguration/saasProcurement": { enabled: true, rulesVersion: SAAS_RULES_VERSION },
    "platformConfiguration/aiSupplierProductImport": { ...DEFAULT_AI_CONFIGURATION, enabled: true, ...configuration },
    "hotels/hotel-a/members/buyer": { permissions: ["supplierproducts.read", "supplierproducts.create", "supplierproducts.update"] },
    "hotelSubscriptions/hotel-a": { status: "active", modules: ["procurement"], modulePolicyVersion: 1 },
    "hotels/hotel-a/suppliers/dairy": { supplierName: "Fictional dairy" },
  });
  const identity = { uid: "buyer", disabled: false, emailVerified: true };
  const calls = { count: 0, response: 0, reconcile: 0 };
  const source = { units: [{ sourceId: "row-1", anchor: "Row 1", text: "001 Milk" }], warnings: [{ code: "CHECK_PACKAGE", message: "Check package content" }] };
  const services = { firestore, bucket: memoryBucket(), identity, calls, now: () => now, advance: (milliseconds) => { now += milliseconds; },
    auth: { getUser: async () => identity, verifyIdToken: async () => ({ uid: "buyer", email_verified: true, auth_time: 9999 }) },
    extractSource: async () => source, splitSource: async () => [source],
    schema: { type: "object", properties: { rows: { type: "array", items: { type: "object" } } }, required: ["rows"], additionalProperties: false },
    validateRows: (payload) => payload.rows,
    reconcileRows: async ({ rows }) => { calls.reconcile++; return { counts: { new: rows.length, changed: 0, blocked: 0, unchanged: 0 }, totalRows: rows.length, complete: true }; },
    provider: { countInput: async () => { calls.count++; return 10; }, respond: async () => { calls.response++; return response(); } } };
  return services;
}
const jobOf = (s, id) => s.firestore.records.get(`hotels/hotel-a/supplierAiImportJobs/${id}`);
const monthOf = (s) => s.firestore.records.get("hotels/hotel-a/aiUsageMonths/2026-10");
function assertCustomerPrivacy(value) {
  const serialized = JSON.stringify(value);
  assert.doesNotMatch(serialized, /"(?:usage|configuration|model|fallbackModel|fallbackEnabled|inputTokens|outputTokens|reasoningTokens|priceVersion|actualCostUsd|knownCostUsd|reservedCostUsd|knownCostMicros|reservedCostMicros|limitUsd|maxCostPerImportUsd|maxMonthlyCostPerHotelUsd)"/);
  if (value.error) assert.doesNotMatch(value.error.message, /cost|budget|reserv|paid|bill|usage|accounting|token|model|reasoning|provider|secret|configuration|fallback|USD|\$|gpt|openai/i);
}
test("normal hotel buyer creates an isolated job, receives complete review and safe progress while real usage stays private, with idempotent source and worker replay", async () => {
  const s = fixture(), created = await uploadSupplierAiImport(request(), data(), bytes, s);
  assert.equal(created.status, "queued"); assert.deepEqual(created.progress, { completedChunks: 0, totalChunks: null }); assertCustomerPrivacy(created);
  assert.equal(s.calls.response, 0); assert.equal(s.bucket.objects.size, 1);
  const result = await runSupplierAiImportJob("hotel-a", created.jobId, s);
  assert.equal(result.status, "review"); assert.equal(result.totalRows, 1); assert.equal(result.warnings[0].code, "CHECK_PACKAGE");
  assert.deepEqual(result.progress, { completedChunks: 1, totalChunks: 1 });
  assert.equal(jobOf(s, created.jobId).knownCostMicros, 12); assert.equal(jobOf(s, created.jobId).reservedCostMicros, 0); assertCustomerPrivacy(result);
  assert.deepEqual([s.calls.count, s.calls.response, s.calls.reconcile], [1, 1, 1]);
  assert.equal(monthOf(s).activeJobs, 0); assert.equal(monthOf(s).importsReviewReady, 1);
  assert.equal(s.firestore.records.get("hotels/hotel-a/aiImportAdministration/state").activeJobs, 0);
  assert.equal((await uploadSupplierAiImport(request(), data(), bytes, s)).jobId, created.jobId);
  assert.deepEqual(await runSupplierAiImportJob("hotel-a", created.jobId, s), { ignored: true });
  assert.equal(s.calls.response, 1); assert.equal(monthOf(s).importsStarted, 1);
  assert.equal(s.bucket.objects.size, 2);
});
test("customer availability and job DTOs cannot serialize operator accounting or provider configuration", async () => {
  const s = fixture();
  const availability = await readSupplierAiImport(request(), { hotelUid: "hotel-a" }, s);
  assert.deepEqual(availability, { available: true, reason: null, limits: { maxFileBytes: 10485760, maxPages: 50, maxProducts: 1000 } });
  assertCustomerPrivacy(availability);
  const created = await uploadSupplierAiImport(request(), data(), bytes, s);
  const stored = jobOf(s, created.jobId);
  stored.counts = { new: 1, changed: 0, blocked: 0, unchanged: 0, knownCostMicros: 123 };
  stored.warnings = [{ code: "CHECK_PACKAGE", message: "Check the supplier's purchase price and package content.", model: "gpt-6-luna", reservedCostMicros: 321 },
    { code: "PROVIDER_COST", message: "Reserved cost is USD 0.25", inputTokens: 333 }];
  const dto = publicJob(stored); assertCustomerPrivacy(dto);
  assert.deepEqual(dto.counts, { new: 1, changed: 0, unchanged: 0, blocked: 0 });
  assert.equal(dto.warnings[0].message, "Check the supplier's purchase price and package content.");
  assert.equal(dto.warnings[1].code, "IMPORT_NOTICE"); assert.doesNotMatch(JSON.stringify(dto), /0\.25|333|321|123|gpt-6/);
  assert.equal(stored.configuration.maxCostPerImportUsd, 0.25, "Public projection must not erase the private budget");
  assert.equal(publicJob({ ...stored, counts: { new: 1 }, totalRows: 1 }).counts, null, "Missing counts must not become false zeroes");
  assert.equal(publicJob({ ...stored, counts: { new: 1, changed: 0, unchanged: 0, blocked: 0 }, totalRows: 2 }).counts, null, "Inconsistent counts stay unavailable");
});
test("HTTP errors never reveal private budget, model settings, provider details or arbitrary exception text", async () => {
  const s = fixture();
  const month = normalizeMonth({ exists: false }, "2026-10"); month.knownCostMicros = 10000000;
  s.firestore.records.set("hotels/hotel-a/aiUsageMonths/2026-10", month);
  const response = () => ({ statusCode: 0, body: null, set: () => {}, status(n) { this.statusCode = n; return this; }, json(body) { this.body = body; return this; } });
  const res = response();
  await supplierProductAiImportHandler({ method: "POST", headers: { authorization: "Bearer fictional", "content-type": "application/octet-stream" }, rawBody: bytes, query: data() }, res, s);
  assert.equal(res.statusCode, 429); assertCustomerPrivacy(res.body); assert.match(res.body.error.message, /hotel administrator/);
  assert.equal(monthOf(s).knownCostMicros, 10000000); assert.equal(s.calls.response, 0);
  s.firestore.records.get("platformConfiguration/aiSupplierProductImport").model = "unexpected-private-model";
  const settings = response();
  await supplierProductAiImportHandler({ method: "GET", headers: { authorization: "Bearer fictional" }, query: { hotelUid: "hotel-a" } }, settings, s);
  assert.equal(settings.statusCode, 409); assertCustomerPrivacy(settings.body); assert.doesNotMatch(JSON.stringify(settings.body), /unexpected-private-model|reasoning/);
  assert.equal(publicImportError({ code: "failed-precondition", message: "unrecognized infrastructure detail 777-private" }).message, "This import needs administrator assistance before it can continue.");
  assert.doesNotMatch(JSON.stringify(publicImportError({ code: "invalid-argument", message: "The source sk-fictional-test-credential" })), /sk-fictional/);
  assert.doesNotMatch(JSON.stringify(publicImportError({ code: "failed-precondition", message: "The import source changed. appended-private-payload" })), /appended-private/);
});
test("unknown billed response keeps liability and null total cost, forbids automatic regeneration and never invents zero usage", async () => {
  const s = fixture(); s.provider.respond = async () => { s.calls.response++; throw Error("timeout after send"); };
  const created = await uploadSupplierAiImport(request(), data(), bytes, s);
  const result = await runSupplierAiImportJob("hotel-a", created.jobId, s);
  assert.equal(result.status, "response_unknown"); assertCustomerPrivacy(result);
  const attempt = s.firestore.records.get(`hotels/hotel-a/supplierAiImportJobs/${created.jobId}/attempts/chunk-0000`);
  assert.equal(attempt.costMicros, null); assert.equal(attempt.inputTokens, null); assert.equal(attempt.outputTokens, null);
  assert.ok(jobOf(s, created.jobId).reservedCostMicros > 0); assert.equal(monthOf(s).unknownCalls, 1); assert.equal(monthOf(s).activeJobs, 0);
  await runSupplierAiImportJob("hotel-a", created.jobId, s); await uploadSupplierAiImport(request(), data(), bytes, s);
  assert.equal(s.calls.response, 1); assert.equal(s.calls.reconcile, 0); assert.equal(monthOf(s).knownCostMicros, 0);
});
test("truncated output settles known billed usage and explicitly rejects all partial proposals", async () => {
  const s = fixture(); s.provider.respond = async () => response({ status: "incomplete" });
  const created = await uploadSupplierAiImport(request(), data(), bytes, s);
  const result = await runSupplierAiImportJob("hotel-a", created.jobId, s);
  assert.equal(result.status, "failed"); assert.match(result.error.message, /truncated/); assert.equal(jobOf(s, created.jobId).knownCostMicros, 12);
  assert.equal(jobOf(s, created.jobId).reservedCostMicros, 0); assertCustomerPrivacy(result); assert.equal(s.calls.reconcile, 0); assert.equal(monthOf(s).importsFailed, 1);
});
test("chunk calls share one cumulative cost cap and complete source coverage; no fallback or partial review", async () => {
  const s = fixture({ maxCostPerImportUsd: 0.001, maxOutputTokens: 512 });
  const unit = { units: [{ sourceId: "one", text: "Milk", anchor: "Row 1" }] };
  s.splitSource = async () => [unit, unit, unit, unit];
  s.provider.countInput = async () => { s.calls.count++; return 1000; };
  s.provider.respond = async (body) => { s.calls.response++; assert.equal(body.model, "gpt-6-luna"); return response({ usage: { input_tokens: 1000, output_tokens: 512, total_tokens: 1512 } }); };
  const created = await uploadSupplierAiImport(request(), data(), bytes, s);
  const result = await runSupplierAiImportJob("hotel-a", created.jobId, s);
  assert.equal(result.status, "failed"); assert.match(jobOf(s, created.jobId).errorMessage, /cost limit/); assert.match(result.error.message, /smaller file/);
  assert.equal(s.calls.response, 2); assert.equal(s.calls.count, 3); assert.equal(s.calls.reconcile, 0);
  assert.equal(jobOf(s, created.jobId).knownCostMicros, 762); assert.equal(jobOf(s, created.jobId).reservedCostMicros, 0); assertCustomerPrivacy(result);
});
test("file/token/call budgets, supplier isolation and request fingerprint are enforced before unsafe provider work", async () => {
  const s = fixture(), created = await uploadSupplierAiImport(request(), data(), bytes, s);
  await assert.rejects(uploadSupplierAiImport(request(), data(), Buffer.from("other"), s), { code: "already-exists" });
  await assert.rejects(uploadSupplierAiImport(request(), data({ hotelUid: "hotel-b" }), bytes, s), { code: "permission-denied" });
  await assert.rejects(uploadSupplierAiImport(request(), data({ requestId: "two", supplierId: "foreign" }), bytes, s), { code: "failed-precondition" });
  await assert.rejects(uploadSupplierAiImport(request(), data({ fileName: "bad.exe" }), bytes, s), { code: "invalid-argument" });
  s.provider.countInput = async () => 200001;
  assert.equal((await runSupplierAiImportJob("hotel-a", created.jobId, s)).status, "failed"); assert.equal(s.calls.response, 0);
  assert.equal(s.firestore.records.get("hotels/hotel-a/aiImportAdministration/state").activeJobs, 0);
});
test("concurrent/daily accounting is transactional and hotel concurrency survives a UTC month boundary", async () => {
  const s = fixture(); s.advance(Date.parse("2026-10-31T23:59:00.000Z") - s.now());
  await Promise.all([uploadSupplierAiImport(request(), data({ requestId: "one" }), bytes, s), uploadSupplierAiImport(request(), data({ requestId: "two" }), bytes, s)]);
  s.advance(120000);
  await assert.rejects(uploadSupplierAiImport(request(), data({ requestId: "three" }), bytes, s), { code: "resource-exhausted" });
  assert.equal(s.firestore.records.get("hotels/hotel-a/aiImportAdministration/state").activeJobs, 2);
});
test("upload failure frees concurrency and exact replay can safely retry an unbilled source write", async () => {
  const s = fixture(); s.bucket.failSave = true;
  await assert.rejects(uploadSupplierAiImport(request(), data(), bytes, s), /unavailable/);
  assert.equal(s.firestore.records.get("hotels/hotel-a/aiImportAdministration/state").activeJobs, 0);
  const created = await uploadSupplierAiImport(request(), data(), bytes, s);
  assert.equal(created.status, "queued"); assert.equal(s.firestore.records.get("hotels/hotel-a/aiImportAdministration/state").activeJobs, 1);
  assert.equal(monthOf(s).importsStarted, 1);
});
test("live authority revocation after paid I/O preserves cost evidence but cannot publish source or results", async () => {
  const s = fixture(); s.provider.respond = async () => { s.identity.disabled = true; return response(); };
  const created = await uploadSupplierAiImport(request(), data(), bytes, s);
  const result = await runSupplierAiImportJob("hotel-a", created.jobId, s);
  assert.equal(result.status, "failed"); assert.equal(jobOf(s, created.jobId).knownCostMicros, 12); assertCustomerPrivacy(result); assert.equal(s.calls.reconcile, 0);
  await assert.rejects(readSupplierAiImport(request(), { hotelUid: "hotel-a", jobId: created.jobId }, s), { code: "permission-denied" });
  assert.equal(s.bucket.objects.size, 1);
});
test("expired paid lease marks unknown once while late response cannot settle or replay the charge", async () => {
  const s = fixture(); let release, started;
  const sent = new Promise((resolve) => { started = resolve; });
  s.provider.respond = async () => { s.calls.response++; started(); return new Promise((resolve) => { release = resolve; }); };
  const created = await uploadSupplierAiImport(request(), data(), bytes, s), running = runSupplierAiImportJob("hotel-a", created.jobId, s);
  await sent; s.advance(600001);
  const unknown = await readSupplierAiImport(request(), { hotelUid: "hotel-a", jobId: created.jobId }, s);
  assert.equal(unknown.status, "response_unknown"); assertCustomerPrivacy(unknown);
  assert.ok(jobOf(s, created.jobId).reservedCostMicros > 0);
  release(response()); await running;
  assert.equal(jobOf(s, created.jobId).status, "response_unknown"); assert.equal(monthOf(s).unknownCalls, 1); assert.equal(monthOf(s).knownCostMicros, 0);
  assert.equal(s.calls.response, 1);
});
test("expired worker before a paid call fails explicitly and releases its hotel slot", async () => {
  const s = fixture(), created = await uploadSupplierAiImport(request(), data(), bytes, s);
  s.advance(600001);
  const result = await readSupplierAiImport(request(), { hotelUid: "hotel-a", jobId: created.jobId }, s);
  assert.equal(result.status, "failed"); assert.equal(s.calls.response, 0); assert.equal(monthOf(s).activeJobs, 0);
});
test("malformed existing accounting cannot gain a fresh zero budget and HTTP never accepts unverified sessions", async () => {
  assert.throws(() => normalizeMonth({ exists: true, data: () => ({ month: "2026-10", knownCostMicros: 99999 }) }, "2026-10"), { code: "failed-precondition" });
  const s = fixture(), res = { statusCode: 0, body: null, set: () => {}, status(n) { this.statusCode = n; return this; }, json(body) { this.body = body; return this; } };
  await supplierProductAiImportHandler({ method: "POST", headers: { "content-type": "application/octet-stream" }, rawBody: bytes, query: data() }, res, s);
  assert.equal(res.statusCode, 401); assert.equal(s.bucket.objects.size, 0);
  s.firestore.records.delete("platformConfiguration/aiSupplierProductImport");
  assert.equal((await readSupplierAiImport(request(), { hotelUid: "hotel-a" }, s)).available, false);
});
test("provider calls are billed to the UTC month at send time, while source creation counters stay in the original month", async () => {
  const s = fixture(); s.advance(Date.parse("2026-10-31T23:59:59.000Z") - s.now());
  const created = await uploadSupplierAiImport(request(), data(), bytes, s); s.advance(2000);
  const result = await runSupplierAiImportJob("hotel-a", created.jobId, s);
  assert.equal(result.status, "review");
  const october = s.firestore.records.get("hotels/hotel-a/aiUsageMonths/2026-10"), november = s.firestore.records.get("hotels/hotel-a/aiUsageMonths/2026-11");
  assert.equal(october.importsStarted, 1); assert.equal(october.knownCostMicros, 0); assert.equal(october.activeJobs, 0);
  assert.equal(november.importsStarted, 0); assert.equal(november.knownCostMicros, 12); assert.equal(november.attemptedCalls, 1);
  assert.equal(s.firestore.records.get(`hotels/hotel-a/supplierAiImportJobs/${created.jobId}/attempts/chunk-0000`).billingMonth, "2026-11");
});
test("unknown response liability and month budget attach to the send month across rollover", async () => {
  const s = fixture(); s.advance(Date.parse("2026-10-31T23:59:59.000Z") - s.now());
  const created = await uploadSupplierAiImport(request(), data(), bytes, s); s.advance(2000);
  s.provider.respond = async () => { throw Error("unknown after send"); };
  const result = await runSupplierAiImportJob("hotel-a", created.jobId, s);
  assert.equal(result.status, "response_unknown");
  const october = s.firestore.records.get("hotels/hotel-a/aiUsageMonths/2026-10"), november = s.firestore.records.get("hotels/hotel-a/aiUsageMonths/2026-11");
  assert.equal(october.reservedCostMicros, 0); assert.equal(october.unknownCalls, 0); assert.equal(october.activeJobs, 0); assert.equal(october.importsFailed, 1);
  assert.ok(november.reservedCostMicros > 0); assert.equal(november.unknownCalls, 1);
});
test("maintenance releases orphan/stranded jobs and erases expired source plus proposal data without erasing billing/replay evidence", async () => {
  const s = fixture(), created = await uploadSupplierAiImport(request(), data(), bytes, s);
  await runSupplierAiImportJob("hotel-a", created.jobId, s);
  s.firestore.records.set(`hotels/hotel-a/supplierAiImportJobs/${created.jobId}/rows/row-1`, { raw: "private supplier source", sourceAnchors: [{ quote: "private supplier source" }] });
  s.advance(8 * 86400000);
  const result = await cleanupSupplierAiSourcesHandler({}, s);
  assert.equal(result.checked, 1); assert.equal(result.deleted, 2); assert.equal(s.bucket.objects.size, 0);
  assert.equal(s.firestore.records.has(`hotels/hotel-a/supplierAiImportJobs/${created.jobId}/rows/row-1`), false);
  assert.equal(jobOf(s, created.jobId).source, undefined);
  assert.equal(monthOf(s).knownCostMicros, 12);
  assert.ok(s.firestore.records.has(`hotels/hotel-a/supplierAiImportJobs/${created.jobId}/attempts/chunk-0000`));
  assert.ok(s.firestore.records.has("hotels/hotel-a/supplierAiImportRequests/import-one"));
  assert.equal((await cleanupSupplierAiSourcesHandler({}, s)).checked, 0);
});
test("source preparation limits give actionable safe errors and wholly empty proposals are not accepted", async () => {
  const s = fixture(), created = await uploadSupplierAiImport(request(), data(), bytes, s);
  s.extractSource = async () => { throw Object.assign(Error("The source has more than 1,000 rows. Split the file."), { name: "SupplierAiExtractionError", code: "ROW_LIMIT" }); };
  const result = await runSupplierAiImportJob("hotel-a", created.jobId, s);
  assert.equal(result.status, "failed"); assert.equal(result.error.code, "resource-exhausted"); assert.match(result.error.message, /Split/); assert.equal(s.calls.response, 0);
  const empty = fixture(), next = await uploadSupplierAiImport(request(), data(), bytes, empty);
  empty.provider.respond = async () => response({ output: [{ type: "message", content: [{ type: "output_text", text: '{"rows":[]}' }] }] });
  assert.match((await runSupplierAiImportJob("hotel-a", next.jobId, empty)).error.message, /No supplier product/);
  assert.equal(empty.calls.reconcile, 0);
});
test("a successful concurrent source write reacquires quota released by an identical failed upload", async () => {
  const s = fixture(); let failFirst, secondEntered, firstReleased;
  const failure = new Promise((resolve) => { failFirst = resolve; });
  const entered = new Promise((resolve) => { secondEntered = resolve; });
  const released = new Promise((resolve) => { firstReleased = resolve; });
  const original = s.bucket.file; let saves = 0;
  s.bucket.file = (...args) => {
    const file = original(...args); return { ...file, save: async (...options) => {
      saves++;
      if (saves === 1) { await failure; throw Error("first upload failed"); }
      secondEntered(); await released; return file.save(...options);
    } };
  };
  const first = uploadSupplierAiImport(request(), data(), bytes, s).catch((error) => { firstReleased(); return error; });
  const second = uploadSupplierAiImport(request(), data(), bytes, s);
  await entered; failFirst(); assert.match((await first).message, /first upload failed/);
  const created = await second;
  assert.equal(created.status, "queued"); assert.equal(monthOf(s).activeJobs, 1);
  assert.equal(s.firestore.records.get("hotels/hotel-a/aiImportAdministration/state").activeJobs, 1);
  await runSupplierAiImportJob("hotel-a", created.jobId, s);
  assert.equal(monthOf(s).activeJobs, 0); assert.equal(s.firestore.records.get("hotels/hotel-a/aiImportAdministration/state").activeJobs, 0);
});
test("a stranded upload after authority loss is released by bounded maintenance before source retention expires", async () => {
  const s = fixture(), original = s.bucket.file;
  s.bucket.file = (...args) => {
    const file = original(...args); return { ...file, save: async (...options) => { await file.save(...options); s.identity.disabled = true; } };
  };
  await assert.rejects(uploadSupplierAiImport(request(), data(), bytes, s), { code: "permission-denied" });
  assert.equal(monthOf(s).activeJobs, 1); s.advance(600001);
  const result = await cleanupSupplierAiSourcesHandler({}, s);
  assert.equal(result.recovered, 1); assert.equal(result.checked, 0); assert.equal(monthOf(s).activeJobs, 0);
  assert.equal(s.firestore.records.get("hotels/hotel-a/aiImportAdministration/state").activeJobs, 0);
  assert.equal(s.bucket.objects.size, 1, "Source remains private until its 7-day retention expires");
});
test("new-month provider budget cannot be bypassed by an import created in the previous month", async () => {
  const s = fixture(); s.advance(Date.parse("2026-10-31T23:59:59.000Z") - s.now());
  const created = await uploadSupplierAiImport(request(), data(), bytes, s); s.advance(2000);
  const aggregate = normalizeMonth({ exists: false }, "2026-11"); aggregate.knownCostMicros = 10000000;
  s.firestore.records.set("hotels/hotel-a/aiUsageMonths/2026-11", aggregate);
  const result = await runSupplierAiImportJob("hotel-a", created.jobId, s);
  assert.equal(result.status, "failed"); assert.equal(s.calls.response, 0); assert.equal(jobOf(s, created.jobId).reservedCostMicros, 0); assertCustomerPrivacy(result);
  assert.equal(s.firestore.records.get("hotels/hotel-a/aiUsageMonths/2026-11").knownCostMicros, 10000000);
});
test("verified over-bound provider usage is recorded truthfully and stops processing instead of being hidden as unknown", async () => {
  const s = fixture(); s.provider.respond = async () => response({ usage: { input_tokens: 10000, output_tokens: 40000, total_tokens: 50000 } });
  const created = await uploadSupplierAiImport(request(), data(), bytes, s);
  const result = await runSupplierAiImportJob("hotel-a", created.jobId, s);
  assert.equal(result.status, "failed"); assert.match(jobOf(s, created.jobId).errorMessage, /exceeded the preflight/); assert.match(result.error.message, /administrator assistance/);
  assert.equal(jobOf(s, created.jobId).knownCostMicros, 21250); assert.equal(jobOf(s, created.jobId).reservedCostMicros, 0); assertCustomerPrivacy(result);
  assert.equal(monthOf(s).knownCostMicros, 21250); assert.equal(monthOf(s).unknownCalls, 0); assert.equal(s.calls.reconcile, 0);
});
test("bounded continuation reuses confirmed chunks and never charges their generation again", async () => {
  const s = fixture(), first = { units: [{ sourceId: "row-1", anchor: "Row 1", text: "Milk" }] }, second = { units: [{ sourceId: "row-2", anchor: "Row 2", text: "Bread" }] };
  s.splitSource = async () => [first, second];
  s.provider.respond = async () => { s.calls.response++; if (s.calls.response === 1) s.advance(400000); return response(); };
  const created = await uploadSupplierAiImport(request(), data(), bytes, s);
  assert.deepEqual(await runSupplierAiImportJob("hotel-a", created.jobId, s), { queued: true });
  assert.equal(jobOf(s, created.jobId).completedChunks, 1); assert.equal(s.calls.response, 1); assert.equal(monthOf(s).activeJobs, 1);
  const partial = await readSupplierAiImport(request(), { hotelUid: "hotel-a", jobId: created.jobId }, s);
  assert.deepEqual(partial.progress, { completedChunks: 1, totalChunks: 2 }); assertCustomerPrivacy(partial);
  const result = await runSupplierAiImportJob("hotel-a", created.jobId, s);
  assert.equal(result.status, "review"); assert.equal(result.totalRows, 2); assert.equal(s.calls.response, 2); assert.equal(s.calls.count, 2);
  assert.deepEqual(result.progress, { completedChunks: 2, totalChunks: 2 });
  assert.equal(jobOf(s, created.jobId).knownCostMicros, 24); assertCustomerPrivacy(result); assert.equal(monthOf(s).importsStarted, 1); assert.equal(monthOf(s).activeJobs, 0);
});
test("continuation rejects changed source partitioning instead of publishing misleading progress or billing again", async () => {
  const s = fixture(), unit = { units: [{ sourceId: "row-1", anchor: "Row 1", text: "Milk" }] };
  s.splitSource = async () => [unit, unit];
  s.provider.respond = async () => { s.calls.response++; s.advance(400000); return response(); };
  const created = await uploadSupplierAiImport(request(), data(), bytes, s);
  assert.deepEqual(await runSupplierAiImportJob("hotel-a", created.jobId, s), { queued: true });
  s.splitSource = async () => [unit, unit, unit];
  const failed = await runSupplierAiImportJob("hotel-a", created.jobId, s);
  assert.equal(failed.status, "failed"); assert.match(failed.error.message, /saved progress/);
  assert.deepEqual(failed.progress, { completedChunks: 1, totalChunks: 2 }); assert.equal(s.calls.response, 1); assertCustomerPrivacy(failed);
});
test("background processing continues without a mounted dialog or customer polling", async () => {
  const s = fixture(); let sent, release;
  const started = new Promise((resolve) => { sent = resolve; });
  s.provider.respond = async () => { s.calls.response++; sent(); return new Promise((resolve) => { release = resolve; }); };
  const created = await uploadSupplierAiImport(request(), data(), bytes, s);
  assert.ok(s.firestore.records.has(`hotels/hotel-a/supplierAiImportWork/${created.jobId}`));
  const work = runSupplierAiImportJob("hotel-a", created.jobId, s);
  await started;
  assert.equal(jobOf(s, created.jobId).status, "processing");
  assert.deepEqual(publicJob(jobOf(s, created.jobId)).progress, { completedChunks: 0, totalChunks: 1 });
  release(response());
  const ready = await work;
  assert.equal(ready.status, "review"); assert.equal(s.calls.response, 1); assert.equal(s.calls.reconcile, 1);
  assertCustomerPrivacy(ready);
});
test("bounded product reconciliation resumes behind a new work receipt without another provider request", async () => {
  const s = fixture(); let reconciliations = 0;
  s.provider.respond = async () => {
    s.calls.response++; s.advance(350000);
    return response({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ rows: [{ supplierSku: "001" }, { supplierSku: "002" }, { supplierSku: "003" }] }) }] }] });
  };
  s.reconcileRows = async ({ rows, maxRows, shouldContinue }) => {
    reconciliations++; assert.equal(rows.length, 3); assert.equal(maxRows, 100); assert.equal(shouldContinue(), true);
    if (reconciliations === 1) {
      s.advance(20000); assert.equal(shouldContinue(), false);
      return { counts: { new: 1, changed: 0, unchanged: 0, blocked: 0 }, totalRows: 3, complete: false, nextRowIndex: 1 };
    }
    return { counts: { new: 3, changed: 0, unchanged: 0, blocked: 0 }, totalRows: 3, complete: true, nextRowIndex: 3 };
  };
  const created = await uploadSupplierAiImport(request(), data(), bytes, s);
  assert.deepEqual(await runSupplierAiImportJob("hotel-a", created.jobId, s), { queued: true });
  assert.equal(jobOf(s, created.jobId).status, "queued"); assert.equal(monthOf(s).activeJobs, 1);
  assert.equal([...s.firestore.records.keys()].filter((path) => path.startsWith("hotels/hotel-a/supplierAiImportWork/")).length, 2);
  const paidReceipt = { ...s.firestore.records.get(`hotels/hotel-a/supplierAiImportJobs/${created.jobId}/attempts/chunk-0000`) };
  const ready = await runSupplierAiImportJob("hotel-a", created.jobId, s);
  assert.equal(ready.status, "review"); assert.equal(ready.totalRows, 3); assert.equal(ready.counts.new, 3);
  assert.deepEqual(ready.progress, { completedChunks: 1, totalChunks: 1 }); assertCustomerPrivacy(ready);
  assert.equal(s.calls.response, 1); assert.equal(s.calls.count, 1); assert.equal(reconciliations, 2);
  assert.deepEqual(s.firestore.records.get(`hotels/hotel-a/supplierAiImportJobs/${created.jobId}/attempts/chunk-0000`), paidReceipt);
  assert.equal(monthOf(s).importsStarted, 1); assert.equal(monthOf(s).importsReviewReady, 1); assert.equal(monthOf(s).activeJobs, 0);
});
test("an unconfirmed reconciliation result cannot mark an incomplete proposal reviewable", async () => {
  const s = fixture(); s.reconcileRows = async () => ({ counts: { new: 1, changed: 0, unchanged: 0, blocked: 0 }, totalRows: 1 });
  const created = await uploadSupplierAiImport(request(), data(), bytes, s);
  const result = await runSupplierAiImportJob("hotel-a", created.jobId, s);
  assert.equal(result.status, "failed"); assert.equal(s.calls.response, 1); assert.equal(monthOf(s).importsReviewReady, 0); assertCustomerPrivacy(result);
});
