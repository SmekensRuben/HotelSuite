const test = require("node:test");
const assert = require("node:assert/strict");
const { SAAS_RULES_VERSION } = require("./saasRollout");
const { mappingScope, mappingSnapshot, mappingProfileRef, normalizeMappings, readHotelSupplierPurchaseUnitMappingsHandler: read,
  saveHotelSupplierPurchaseUnitMappingHandler: save } = require("./supplierImportMappings");
function fixture() {
  const records = new Map(Object.entries({
    "platformConfiguration/saasProcurement": { enabled: true, rulesVersion: SAAS_RULES_VERSION },
    "hotels/hotel-a/members/buyer": { permissions: ["supplierproducts.read", "supplierproducts.create", "supplierproducts.update", "suppliers.read"] },
    "hotelSubscriptions/hotel-a": { status: "active", modules: ["procurement"], modulePolicyVersion: 1 },
    "hotels/hotel-a/suppliers/sligro": { supplierName: "Sligro", active: true },
    "hotels/hotel-a/suppliers/other": { supplierName: "Other supplier", active: true },
  }));
  let serial = Promise.resolve();
  const snapshot = (ref) => ({ exists: records.has(ref.path), data: () => records.get(ref.path) });
  const firestore = { records, doc: (path) => ({ path }), runTransaction(callback) {
    const run = serial.then(async () => {
      const writes = [], tx = { get: async (ref) => { assert.equal(writes.length, 0, "authorization and all reads precede writes"); return snapshot(ref); },
        set: (ref, value) => writes.push([ref.path, value]), create: (ref, value) => { assert.equal(records.has(ref.path), false); writes.push([ref.path, value]); } };
      const result = await callback(tx); for (const [path, value] of writes) records.set(path, value); return result;
    }); serial = run.catch(() => {}); return run;
  } };
  const identity = { uid: "buyer", emailVerified: true, disabled: false };
  return { firestore, identity, auth: { getUser: async () => identity } };
}
const scope = (patch = {}) => ({ hotelUid: "hotel-a", supplierId: "sligro", sourceFormat: "xlsx", profileId: "default", ...patch });
const request = (data) => ({ auth: { uid: "buyer", token: { email_verified: true, auth_time: 9999 } }, data });
const command = (patch = {}) => ({ ...scope(), requestId: "mapping-one", expectedRevision: 0,
  mappings: [{ sourceUnit: "FL", purchaseUnit: "Bottle" }], ...patch });
const interpretation = (patch = {}) => ({ version: 1, header: ["SKU", "Name", "Package", "Content", "Price"], sheetName: "Offers",
  columns: { supplierSku: 0, supplierProductName: 1, purchaseUnit: 2, baseUnitsPerPurchaseUnit: 3, pricePerPurchaseUnit: 4 },
  defaults: { baseUnit: "l", currency: "EUR", priceBasis: "net" }, assortmentMode: "partial", documentPurpose: "price-list",
  decimalSeparator: ",", dateFormat: "YYYY-MM-DD", ...patch });

test("Sligro profile offers human-confirmed English suggestions without silently saving them", async () => {
  const services = fixture(), before = services.firestore.records.size;
  const result = await read(request(scope()), services);
  assert.equal(result.revision, 0); assert.deepEqual(result.mappings, []); assert.equal(services.firestore.records.size, before);
  assert.deepEqual(Object.fromEntries(result.suggestions.map((entry) => [entry.sourceUnit, entry.purchaseUnit])),
    { FL: "Bottle", ZK: "Bag", EM: "Bucket", BK: "Box", TR: "Tray", PT: "Jar", ST: "Piece", DS: "Box", PK: "Pack" });
  assert.ok(result.suggestions.every((entry) => entry.needsConfirmation === true));
});
test("mapping save is revision checked, audited, bounded and idempotent with canonical labels", async () => {
  const services = fixture(), input = command({ mappings: [{ sourceUnit: " fl ", purchaseUnit: "bottle" }, { sourceUnit: "zk", purchaseUnit: "Bag" }] });
  const result = await save(request(input), services); assert.equal(result.revision, 1);
  assert.deepEqual(result.mappings, [{ sourceUnit: "FL", purchaseUnit: "Bottle" }, { sourceUnit: "ZK", purchaseUnit: "Bag" }]);
  assert.deepEqual(await save(request(input), services), result);
  assert.equal([...services.firestore.records.keys()].filter((key) => key.includes("/supplierImportMappingAudit/")).length, 1);
  await assert.rejects(save(request(command({ requestId: "stale", expectedRevision: 0 })), services), { code: "aborted" });
  await assert.rejects(save(request({ ...input, mappings: [{ sourceUnit: "FL", purchaseUnit: "Jar" }] }), services), { code: "already-exists" });
});
test("a confirmed supplier KG code can map to the canonical kilogram purchase measure", async () => {
  const services = fixture();
  const result = await save(request(command({ mappings: [{ sourceUnit: "KG", purchaseUnit: "KG" }] })), services);
  assert.deepEqual(result.mappings, [{ sourceUnit: "KG", purchaseUnit: "kg" }]);
  const profile = await read(request(scope()), services); assert.deepEqual(profile.mappings, result.mappings);
});
test("profiles remain scoped to hotel, supplier, source format and named source profile", async () => {
  const services = fixture(); await save(request(command()), services);
  for (const patch of [{ supplierId: "other" }, { sourceFormat: "csv" }, { profileId: "volume-list" }]) {
    assert.deepEqual((await read(request(scope(patch)), services)).mappings, []);
  }
  await assert.rejects(read(request(scope({ hotelUid: "hotel-b" })), services), { code: "permission-denied" });
  assert.notEqual(mappingProfileRef(services.firestore, "hotel-a", mappingScope(scope())).path,
    mappingProfileRef(services.firestore, "hotel-b", mappingScope(scope())).path);
});
test("read requires supplier visibility and save requires import creation rights", async () => {
  for (const missing of ["supplierproducts.read", "suppliers.read", "supplierproducts.create"]) {
    const services = fixture(), member = services.firestore.records.get("hotels/hotel-a/members/buyer");
    member.permissions = member.permissions.filter((permission) => permission !== missing);
    if (missing !== "supplierproducts.create") await assert.rejects(read(request(scope()), services), { code: "permission-denied" });
    await assert.rejects(save(request(command()), services), { code: "permission-denied" });
    assert.equal([...services.firestore.records.keys()].some((key) => key.includes("/supplierImportMappingProfiles/")), false);
  }
});
test("replacing a shared mapping requires current update authority even during receipt replay", async () => {
  const services = fixture(); await save(request(command()), services);
  const overwrite = command({ requestId: "replace", expectedRevision: 1, mappings: [{ sourceUnit: "FL", purchaseUnit: "Jar" }] });
  const member = services.firestore.records.get("hotels/hotel-a/members/buyer"); member.permissions = member.permissions.filter((permission) => permission !== "supplierproducts.update");
  await assert.rejects(save(request(overwrite), services), { code: "permission-denied" });
  const added = await save(request(command({ requestId: "add", expectedRevision: 1, mappings: [{ sourceUnit: "ZK", purchaseUnit: "Bag" }] })), services);
  assert.equal(added.revision, 2);
  member.permissions.push("supplierproducts.update"); overwrite.expectedRevision = 2;
  const changed = await save(request(overwrite), services); assert.equal(changed.revision, 3);
  member.permissions = member.permissions.filter((permission) => permission !== "supplierproducts.update");
  await assert.rejects(save(request(overwrite), services), { code: "permission-denied" });
});
test("live Auth, subscription and rollout boundaries apply to reads and immutable command replays", async () => {
  for (const failure of ["disabled", "revoked", "subscription", "rollout"]) {
    const services = fixture(); await save(request(command()), services);
    if (failure === "disabled") services.identity.disabled = true;
    if (failure === "revoked") services.identity.tokensValidAfterTime = new Date(10000 * 1000).toISOString();
    if (failure === "subscription") services.firestore.records.get("hotelSubscriptions/hotel-a").status = "inactive";
    if (failure === "rollout") services.firestore.records.get("platformConfiguration/saasProcurement").enabled = false;
    await assert.rejects(read(request(scope()), services)); await assert.rejects(save(request(command()), services));
  }
});
test("mapping input rejects guessed labels, duplicate canonical codes, wrong scope and oversized profiles", async () => {
  const services = fixture();
  for (const mappings of [[{ sourceUnit: "FL", purchaseUnit: "Fles" }], [{ sourceUnit: "FL", purchaseUnit: "Bottle" }, { sourceUnit: "fl", purchaseUnit: "Bottle" }],
    [{ sourceUnit: "FL", purchaseUnit: "Bottle", confidence: 1 }], Array.from({ length: 101 }, (_, index) => ({ sourceUnit: `C${index}`, purchaseUnit: "Box" }))]) {
    await assert.rejects(save(request(command({ mappings })), services), { code: "invalid-argument" });
  }
  assert.throws(() => mappingScope(scope({ profileId: "../other" })), { code: "invalid-argument" });
  assert.throws(() => mappingScope(scope({ sourceFormat: "html" })), { code: "invalid-argument" });
  const acceptedScope = mappingScope(scope());
  assert.throws(() => mappingSnapshot({ version: 1, ...acceptedScope, supplierId: "other", revision: 1, mappings: [] }, acceptedScope), { code: "failed-precondition" });
  assert.deepEqual(normalizeMappings([{ sourceUnit: "TR", purchaseUnit: "tray" }]), [{ sourceUnit: "TR", purchaseUnit: "Tray" }]);
});
test("confirmed recurring interpretation is revisioned with canonical fingerprints while unit-only edits preserve it", async () => {
  const services = fixture(), original = command({ mappings: [], interpretation: interpretation() });
  const saved = await save(request(original), services);
  assert.equal(saved.revision, 1); assert.equal(saved.interpretation.columns.pricePerPurchaseUnit, 4);
  assert.match(saved.interpretationFingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(await save(request(original), services), saved);
  const updated = await save(request(command({ requestId: "units", expectedRevision: 1 })), services);
  assert.deepEqual(updated.interpretation, saved.interpretation); assert.equal(updated.interpretationFingerprint, saved.interpretationFingerprint);
  const frozen = mappingSnapshot(saved, mappingScope(scope()));
  await save(request(command({ requestId: "format", expectedRevision: 2, mappings: [], interpretation: interpretation({ decimalSeparator: "." }) })), services);
  assert.equal(frozen.interpretation.decimalSeparator, ",");
});
test("a changed confirmed format requires live update rights including immutable operation replay", async () => {
  const services = fixture(), first = command({ mappings: [], interpretation: interpretation() }); await save(request(first), services);
  const second = command({ requestId: "changed-format", expectedRevision: 1, mappings: [], interpretation: interpretation({ decimalSeparator: "." }) });
  const member = services.firestore.records.get("hotels/hotel-a/members/buyer"); member.permissions = member.permissions.filter((permission) => permission !== "supplierproducts.update");
  await assert.rejects(save(request(second), services), { code: "permission-denied" });
  member.permissions.push("supplierproducts.update"); const saved = await save(request(second), services); assert.equal(saved.revision, 2);
  member.permissions = member.permissions.filter((permission) => permission !== "supplierproducts.update"); await assert.rejects(save(request(second), services), { code: "permission-denied" });
});
test("format review rejects duplicate channels, ambiguous columns, statistics prices and recurring one-off dates", async () => {
  const services = fixture();
  for (const patch of [
    { defaults: { priceValidFrom: "2027-01-01" } },
    { columns: { supplierSku: 0, supplierProductName: 0 } },
    { columns: { supplierSku: 0, pricePerBaseUnit: 3, pricePerPurchaseUnit: 4 } },
    { documentPurpose: "statistics" },
    { defaults: { currency: "eur" } },
    { dateFormat: "MM/DD/YYYY" },
  ]) await assert.rejects(save(request(command({ mappings: [], interpretation: interpretation(patch) })), services), { code: "invalid-argument" });
  await assert.rejects(save(request(command({ sourceFormat: "pdf", mappings: [], interpretation: interpretation() })), services), { code: "invalid-argument" });
});
