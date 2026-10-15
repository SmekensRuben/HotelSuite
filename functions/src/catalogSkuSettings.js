const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { admin } = require("./config");
const { requireHotelPermission } = require("./authorization");
const { requireDocumentId } = require("./subscriptions");
const { digest, text, revision } = require("./validation");
const { gated, requireSaasRollout } = require("./saasRollout");

const CATALOG_SKU_POLICY_VERSION = 1;
const MAX_LEGACY_CATALOG_PRODUCTS = 20000;
const MAX_LEGACY_SHARD_BYTES = 750000;
const MAX_COLLISION_ATTEMPTS = 100;
const MAX_CATALOG_SKU_NUMBER = Number.MAX_SAFE_INTEGER - 1;
const DEFAULT_SETTINGS = { enabled: true, prefix: "CAT-", padding: 6, nextNumber: 1 };
const stamp = () => admin.firestore.FieldValue.serverTimestamp();
const configurationPath = (hotelUid) => `hotels/${hotelUid}/catalogSkuConfiguration/settings`;
const canonicalCatalogSku = (value) => text(value, "Internal SKU", 100).normalize("NFKC").toUpperCase();
const keyForSku = (canonical) => digest(canonical);
const legacyShardId = (key) => (parseInt(key.slice(0, 2), 16) % 64).toString(16).padStart(2, "0");
function supported(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !fields.includes(key))) {
    throw new HttpsError("invalid-argument", `Unsupported ${label} field.`);
  }
}
function normalizeSettings(value) {
  supported(value, ["enabled", "prefix", "padding", "nextNumber"], "catalog SKU setting");
  if (typeof value.enabled !== "boolean") throw new HttpsError("invalid-argument", "Choose whether automatic catalog SKUs are enabled.");
  if (typeof value.prefix !== "string" || !/^[A-Z0-9_-]{0,20}$/.test(value.prefix)) throw new HttpsError("invalid-argument", "SKU prefix must contain at most 20 uppercase letters, digits, underscores or hyphens.");
  if (!Number.isSafeInteger(value.padding) || value.padding < 1 || value.padding > 12) throw new HttpsError("invalid-argument", "SKU padding must be a whole number from 1 to 12.");
  if (!Number.isSafeInteger(value.nextNumber) || value.nextNumber < 1) throw new HttpsError("invalid-argument", "The next SKU number must be a positive safe whole number.");
  return { enabled: value.enabled, prefix: value.prefix, padding: value.padding, nextNumber: value.nextNumber };
}
function storedSettings(snapshot) {
  if (!snapshot.exists) return { ...DEFAULT_SETTINGS, revision: 0, policyVersion: CATALOG_SKU_POLICY_VERSION };
  const raw = snapshot.data();
  try {
    const normalized = normalizeSettings(Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map((key) => [key, raw[key]])));
    if (raw.policyVersion !== CATALOG_SKU_POLICY_VERSION || !Number.isSafeInteger(raw.revision) || raw.revision < 0 || raw.revision >= Number.MAX_SAFE_INTEGER) throw new Error("revision");
    if (raw.legacyIndexPolicyVersion === undefined && raw.legacyIndexShards !== undefined) throw new Error("index");
    if (raw.legacyIndexPolicyVersion !== undefined && (raw.legacyIndexPolicyVersion !== CATALOG_SKU_POLICY_VERSION || !Array.isArray(raw.legacyIndexShards)
      || raw.legacyIndexShards.length > 64 || new Set(raw.legacyIndexShards).size !== raw.legacyIndexShards.length || raw.legacyIndexShards.some((id) => !/^[0-3][0-9a-f]$/.test(id)))) throw new Error("index");
    return { ...raw, ...normalized };
  } catch { throw new HttpsError("failed-precondition", "Catalog SKU settings or legacy index need reconciliation."); }
}
function projectSettings(hotelUid, settings) {
  return { hotelUid, ...Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map((key) => [key, settings[key]])), revision: settings.revision, policyVersion: CATALOG_SKU_POLICY_VERSION };
}
function createAllocationContext() {
  return { hotelUid: null, db: null, settings: null, configurationRef: null, initialConfiguration: null,
    planned: new Map(), legacyShards: new Map(), legacyWrites: new Map(), nextNumber: null, changed: false, written: false };
}
async function loadAllocationContext(tx, db, hotelUid, context) {
  if (context.hotelUid && (context.hotelUid !== hotelUid || context.db !== db)) throw new HttpsError("failed-precondition", "A catalog SKU allocation cannot span hotels.");
  if (context.written) throw new HttpsError("failed-precondition", "Prepare every catalog SKU before writing the allocation.");
  if (!context.settings) {
    context.hotelUid = hotelUid; context.db = db; context.configurationRef = db.doc(configurationPath(hotelUid));
    const snapshot = await tx.get(context.configurationRef);
    context.initialConfiguration = snapshot.exists ? snapshot.data() : null;
    context.settings = storedSettings(snapshot); context.nextNumber = context.settings.nextNumber;
  }
  return context;
}
function shardChecksum(keys) {
  return digest(Object.entries(keys).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, entry.canonicalSku, [...entry.productIds].sort()]));
}
function validateShard(shard, id) {
  if (shard.policyVersion !== CATALOG_SKU_POLICY_VERSION || !shard.keys || typeof shard.keys !== "object" || Array.isArray(shard.keys)
    || shard.entryCount !== Object.keys(shard.keys).length) throw new HttpsError("failed-precondition", "Catalog SKU legacy index evidence needs reconciliation.");
  for (const [key, entry] of Object.entries(shard.keys)) {
    if (!entry || typeof entry.canonicalSku !== "string" || keyForSku(entry.canonicalSku) !== key || legacyShardId(key) !== id
      || !Array.isArray(entry.productIds) || entry.productIds.length < 1 || entry.productIds.length > 2 || new Set(entry.productIds).size !== entry.productIds.length
      || entry.productIds.some((value) => typeof value !== "string" || !value || value.includes("/"))) throw new HttpsError("failed-precondition", "Catalog SKU legacy reservation needs reconciliation.");
  }
  if (shard.checksum !== shardChecksum(shard.keys)) throw new HttpsError("failed-precondition", "Catalog SKU legacy index checksum needs reconciliation.");
  return shard;
}

async function prepareLegacyIndex(tx, context) {
  if (context.settings.legacyIndexPolicyVersion === CATALOG_SKU_POLICY_VERSION) return;
  const orphaned = await tx.get(context.db.collection(`hotels/${context.hotelUid}/catalogSkuLegacyIndex`).limit(1));
  if (orphaned.docs.length) throw new HttpsError("failed-precondition", "Catalog SKU legacy index certificate is missing. Reconcile the index before assigning SKUs.");
  // Bootstrap only the SKU identity projection. Supplier information, prices,
  // descriptions and other hotel data are never copied into the private index.
  const found = await tx.get(context.db.collection(`hotels/${context.hotelUid}/catalogproducts`).select("internalSku").limit(MAX_LEGACY_CATALOG_PRODUCTS + 1));
  if (found.docs.length > MAX_LEGACY_CATALOG_PRODUCTS) throw new HttpsError("failed-precondition", "Catalog SKU indexing exceeds the 20,000-product bootstrap window. An operator must prepare a reviewed paged index migration before assigning SKUs.");
  let initialMaximum = 0;
  for (const document of found.docs) {
    const value = document.data().internalSku;
    if (value === null || value === undefined || value === "") continue;
    let canonical;
    try { canonical = canonicalCatalogSku(value); }
    catch { throw new HttpsError("failed-precondition", "An existing catalog SKU needs review before the legacy index can be prepared."); }
    if (!canonical) continue;
    const key = keyForSku(canonical), id = legacyShardId(key);
    const shard = context.legacyWrites.get(id) ?? { policyVersion: CATALOG_SKU_POLICY_VERSION, keys: {} };
    const existing = shard.keys[key];
    if (existing && existing.canonicalSku !== canonical) throw new HttpsError("failed-precondition", "Catalog SKU index evidence needs reconciliation.");
    const productIds = [...new Set([...(existing?.productIds ?? []), document.id])].slice(0, 2);
    shard.keys[key] = { canonicalSku: canonical, productIds };
    context.legacyWrites.set(id, shard); context.legacyShards.set(id, shard);
    if (!context.initialConfiguration && canonical.startsWith(context.settings.prefix)) {
      const suffix = canonical.slice(context.settings.prefix.length);
      if (/^[0-9]+$/.test(suffix)) {
        const number = BigInt(suffix);
        initialMaximum = Math.max(initialMaximum, number >= BigInt(MAX_CATALOG_SKU_NUMBER) ? MAX_CATALOG_SKU_NUMBER : Number(number));
      }
    }
  }
  for (const shard of context.legacyWrites.values()) {
    shard.entryCount = Object.keys(shard.keys).length; shard.checksum = shardChecksum(shard.keys);
    if (Buffer.byteLength(JSON.stringify(shard), "utf8") > MAX_LEGACY_SHARD_BYTES) {
      throw new HttpsError("failed-precondition", "Catalog SKU index size exceeds the bootstrap limit. An operator must prepare a reviewed index migration.");
    }
  }
  context.settings = { ...context.settings, legacyIndexPolicyVersion: CATALOG_SKU_POLICY_VERSION, legacyIndexShards: [...context.legacyWrites.keys()].sort() };
  if (!context.initialConfiguration) context.nextNumber = Math.max(context.nextNumber, initialMaximum + 1);
  context.changed = true;
}
async function legacyOwners(tx, context, key, canonical) {
  await prepareLegacyIndex(tx, context);
  const id = legacyShardId(key);
  if (!context.legacyShards.has(id)) {
    const snapshot = await tx.get(context.db.doc(`hotels/${context.hotelUid}/catalogSkuLegacyIndex/${id}`));
    if (snapshot.exists && !context.settings.legacyIndexShards.includes(id)) throw new HttpsError("failed-precondition", "Catalog SKU legacy index certificate needs reconciliation.");
    if (!snapshot.exists && context.settings.legacyIndexShards.includes(id)) throw new HttpsError("failed-precondition", "Catalog SKU legacy index evidence is missing. Reconcile the index before assigning a SKU.");
    const shard = snapshot.exists ? validateShard(snapshot.data(), id) : { policyVersion: CATALOG_SKU_POLICY_VERSION, keys: {} };
    context.legacyShards.set(id, shard);
  }
  const entry = context.legacyShards.get(id).keys[key];
  if (!entry) return [];
  if (entry.canonicalSku !== canonical || !Array.isArray(entry.productIds) || entry.productIds.length < 1 || entry.productIds.length > 2
    || entry.productIds.some((id) => typeof id !== "string" || !id || id.includes("/"))) throw new HttpsError("failed-precondition", "Catalog SKU legacy reservation needs reconciliation.");
  return entry.productIds;
}
async function inspectReservation(tx, context, sku, productId) {
  const canonical = canonicalCatalogSku(sku), key = keyForSku(canonical);
  const ref = context.db.doc(`hotels/${context.hotelUid}/catalogSkuKeys/${key}`);
  const reserved = await tx.get(ref);
  if (reserved.exists && (reserved.data().policyVersion !== CATALOG_SKU_POLICY_VERSION || reserved.data().canonicalSku !== canonical || typeof reserved.data().productId !== "string")) throw new HttpsError("failed-precondition", "Catalog SKU reservation evidence needs reconciliation.");
  const owners = await legacyOwners(tx, context, key, canonical);
  // Indexed public identities detect a partially restored reservation without
  // rescanning the hotel catalog or releasing a previously assigned SKU.
  const indexed = await tx.get(context.db.collection(`hotels/${context.hotelUid}/catalogproducts`)
    .where("internalSkuCanonical", "==", canonical).select("internalSku").limit(2));
  for (const document of indexed.docs) {
    let actual;
    try { actual = canonicalCatalogSku(document.data().internalSku); }
    catch { throw new HttpsError("failed-precondition", "An indexed catalog SKU needs reconciliation."); }
    if (actual !== canonical) throw new HttpsError("failed-precondition", "An indexed catalog SKU needs reconciliation.");
  }
  const conflict = reserved.exists && reserved.data().productId !== productId || owners.some((id) => id !== productId)
    || context.planned.has(canonical) && context.planned.get(canonical) !== productId || indexed.docs.some((document) => document.id !== productId);
  return { ref, canonical, conflict };
}
async function prepareCatalogSku(tx, db, hotelUid, plan, context = createAllocationContext()) {
  await loadAllocationContext(tx, db, hotelUid, context);
  let sku = plan.next.internalSku;
  const automatic = plan.action === "create" && !sku && context.settings.enabled;
  if (automatic) {
    await prepareLegacyIndex(tx, context);
    let available = null;
    for (let attempt = 0; attempt < MAX_COLLISION_ATTEMPTS; attempt++) {
      if (context.nextNumber > MAX_CATALOG_SKU_NUMBER) throw new HttpsError("failed-precondition", "The catalog SKU number sequence is exhausted. Review a new numbering policy before creating more automatic SKUs.");
      const candidate = `${context.settings.prefix}${String(context.nextNumber).padStart(context.settings.padding, "0")}`;
      context.nextNumber += 1; context.changed = true;
      const reservation = await inspectReservation(tx, context, candidate, plan.productId);
      if (!reservation.conflict) { sku = candidate; available = reservation; break; }
    }
    if (!available) throw new HttpsError("failed-precondition", "The next catalog SKU numbers are already reserved. Review the next number in catalog settings before retrying.");
    plan.catalogSkuRef = available.ref; plan.catalogSkuCanonical = available.canonical;
  } else if (sku) {
    const reservation = await inspectReservation(tx, context, sku, plan.productId);
    if (reservation.conflict) throw new HttpsError("already-exists", "This internal catalog SKU is already reserved for another product.");
    plan.catalogSkuRef = reservation.ref; plan.catalogSkuCanonical = reservation.canonical;
  }
  plan.next.internalSku = sku;
  if (sku) {
    plan.next.internalSkuCanonical = plan.catalogSkuCanonical;
    context.planned.set(plan.catalogSkuCanonical, plan.productId);
  }
  plan.catalogAllocationContext = context;
  return plan;
}
function writeCatalogSkuReservation(tx, plan, actorUid, now) {
  if (plan.catalogSkuRef) tx.set(plan.catalogSkuRef, { policyVersion: CATALOG_SKU_POLICY_VERSION, canonicalSku: plan.catalogSkuCanonical,
    productId: plan.productId, internalSku: plan.next.internalSku, updatedAt: now, updatedBy: actorUid });
}
function writeAllocation(tx, context, actorUid) {
  if (!context || !context.settings || context.written) return;
  context.written = true;
  if (!context.changed) return;
  if (context.settings.revision >= Number.MAX_SAFE_INTEGER - 1) throw new HttpsError("failed-precondition", "The catalog SKU settings revision is exhausted. Reconcile the numbering policy before assigning more SKUs.");
  const now = stamp();
  for (const [id, shard] of context.legacyWrites) tx.create(context.db.doc(`hotels/${context.hotelUid}/catalogSkuLegacyIndex/${id}`), { ...shard, createdAt: now, createdBy: actorUid });
  tx.set(context.configurationRef, { ...context.settings, nextNumber: context.nextNumber, revision: context.settings.revision + 1,
    updatedAt: now, updatedBy: actorUid });
}
function uncommitted(error) {
  if (error instanceof HttpsError) return new HttpsError(error.code, error.message, { ...error.details, catalogSkuRequestUncommitted: true });
  return error;
}
async function getHotelCatalogSkuSettingsHandler(request, services = {}) {
  supported(request.data, ["hotelUid"], "catalog SKU settings request");
  const hotelUid = requireDocumentId(request.data.hotelUid, "hotelUid"), db = services.firestore || admin.firestore();
  return db.runTransaction(async (tx) => {
    const actor = { ...request };
    await requireHotelPermission(db, actor, hotelUid, "catalogsettings", "read", tx, services.auth);
    await requireSaasRollout(db, tx);
    return projectSettings(hotelUid, storedSettings(await tx.get(db.doc(configurationPath(hotelUid)))));
  }, { readOnly: true });
}
async function saveHotelCatalogSkuSettingsHandler(request, services = {}) {
  const input = request.data || {}, hotelUid = requireDocumentId(input.hotelUid, "hotelUid"), requestId = requireDocumentId(input.requestId, "requestId");
  const db = services.firestore || admin.firestore(), id = `cs-${digest(request.auth?.uid, requestId).slice(0, 48)}`;
  const operationRef = db.doc(`hotels/${hotelUid}/catalogSkuOperations/${id}`), fingerprint = digest(input);
  return db.runTransaction(async (tx) => {
    const actor = { ...request };
    await requireHotelPermission(db, actor, hotelUid, "catalogsettings", "update", tx, services.auth);
    await requireSaasRollout(db, tx);
    const operation = await tx.get(operationRef);
    if (operation.exists) {
      if (operation.data().fingerprint !== fingerprint) throw new HttpsError("already-exists", "This catalog SKU request was used with different settings.");
      return operation.data().result;
    }
    try {
      supported(input, ["hotelUid", "requestId", "expectedRevision", "settings"], "catalog SKU settings request");
      const expected = revision(input.expectedRevision), settings = normalizeSettings(input.settings), ref = db.doc(configurationPath(hotelUid));
      const previous = storedSettings(await tx.get(ref));
      if (previous.revision >= Number.MAX_SAFE_INTEGER - 1) throw new HttpsError("failed-precondition", "The catalog SKU settings revision needs reconciliation.");
      if (previous.revision !== expected) throw new HttpsError("aborted", "Catalog SKU settings or the next number changed. Refresh before saving.");
      if (settings.nextNumber < previous.nextNumber) throw new HttpsError("failed-precondition", "The next catalog SKU number cannot move backwards. Assigned and archived SKUs remain reserved.");
      const next = { ...previous, ...settings, revision: previous.revision + 1, policyVersion: CATALOG_SKU_POLICY_VERSION, updatedAt: stamp(), updatedBy: request.auth.uid };
      const result = { ...projectSettings(hotelUid, next), requestId };
      tx.set(ref, next); tx.create(operationRef, { actorUid: request.auth.uid, fingerprint, result, createdAt: stamp() });
      tx.create(db.doc(`hotels/${hotelUid}/catalogSkuAudit/${id}`), { actorUid: request.auth.uid, action: "settings-updated", revision: next.revision, createdAt: stamp() });
      return result;
    } catch (error) { throw uncommitted(error); }
  });
}
async function assignHotelCatalogSkusHandler(request, services = {}) {
  const input = request.data || {}, hotelUid = requireDocumentId(input.hotelUid, "hotelUid"), requestId = requireDocumentId(input.requestId, "requestId");
  const db = services.firestore || admin.firestore(), id = `cs-${digest(request.auth?.uid, requestId).slice(0, 48)}`;
  const operationRef = db.doc(`hotels/${hotelUid}/catalogSkuOperations/${id}`), fingerprint = digest("assign", input);
  return db.runTransaction(async (tx) => {
    const actor = { ...request };
    await requireHotelPermission(db, actor, hotelUid, "catalogproducts", "read", tx, services.auth);
    await requireHotelPermission(db, actor, hotelUid, "catalogproducts", "update", tx, services.auth);
    await requireSaasRollout(db, tx);
    const operation = await tx.get(operationRef);
    if (operation.exists) {
      if (operation.data().fingerprint !== fingerprint) throw new HttpsError("already-exists", "This catalog SKU request was used with different products.");
      return operation.data().result;
    }
    try {
      supported(input, ["hotelUid", "requestId", "expectedSettingsRevision", "products"], "catalog SKU assignment request");
      const expectedSettings = revision(input.expectedSettingsRevision);
      if (!Array.isArray(input.products) || input.products.length < 1 || input.products.length > 25) throw new HttpsError("invalid-argument", "Choose between 1 and 25 catalog products for SKU assignment.");
      const context = createAllocationContext();
      await loadAllocationContext(tx, db, hotelUid, context);
      if (context.settings.revision !== expectedSettings) throw new HttpsError("aborted", "The numbering settings or next number changed. Review the current settings before assigning SKUs.");
      if (!context.settings.enabled) throw new HttpsError("failed-precondition", "Automatic catalog SKUs are disabled. Enable the reviewed numbering policy before assigning SKUs.");
      const plans = [], ids = new Set();
      for (const row of input.products) {
        supported(row, ["productId", "expectedRevision"], "catalog SKU assignment row");
        const productId = requireDocumentId(row.productId, "productId"), expected = revision(row.expectedRevision);
        if (ids.has(productId)) throw new HttpsError("invalid-argument", "Choose each catalog product once.");
        ids.add(productId);
        const ref = db.doc(`hotels/${hotelUid}/catalogproducts/${productId}`), current = await tx.get(ref);
        if (!current.exists) throw new HttpsError("not-found", "A selected catalog product no longer exists in this hotel.");
        const previous = current.data(), storedRevision = previous.revision === undefined ? 0 : previous.revision;
        if (previous.archived === true || previous.archivedAt) throw new HttpsError("failed-precondition", "Archived catalog products cannot receive a new automatic SKU.");
        if (!Number.isSafeInteger(storedRevision) || storedRevision < 0 || storedRevision >= Number.MAX_SAFE_INTEGER) throw new HttpsError("failed-precondition", "A selected catalog product revision needs reconciliation.");
        if (storedRevision !== expected) throw new HttpsError("aborted", "A selected catalog product changed. Refresh the review before assigning its SKU.");
        if (previous.internalSku !== undefined && previous.internalSku !== null && (typeof previous.internalSku !== "string" || previous.internalSku.trim())) throw new HttpsError("failed-precondition", "Only catalog products with a missing internal SKU can receive an automatic number.");
        const plan = { ref, previous, next: { ...previous, internalSku: "" }, expected, action: "create", productId };
        await prepareCatalogSku(tx, db, hotelUid, plan, context);
        plans.push(plan);
      }
      const assigned = plans.map((plan) => ({ productId: plan.productId, revision: plan.expected + 1, internalSku: plan.next.internalSku }));
      const result = { hotelUid, requestId, assigned, settingsRevision: context.settings.revision + 1 };
      const now = stamp();
      for (const plan of plans) {
        tx.update(plan.ref, { internalSku: plan.next.internalSku, internalSkuCanonical: plan.catalogSkuCanonical,
          revision: plan.expected + 1, updatedAt: now, updatedBy: request.auth.uid });
        writeCatalogSkuReservation(tx, plan, request.auth.uid, now);
      }
      writeAllocation(tx, context, request.auth.uid);
      tx.create(operationRef, { actorUid: request.auth.uid, action: "assign", fingerprint, result, createdAt: now });
      tx.create(db.doc(`hotels/${hotelUid}/catalogSkuAudit/${id}`), { actorUid: request.auth.uid, action: "missing-skus-assigned", products: assigned, settingsRevision: result.settingsRevision, createdAt: now });
      return result;
    } catch (error) { throw uncommitted(error); }
  });
}

const options = { region: "us-central1", cors: true, timeoutSeconds: 120, memory: "512MiB", concurrency: 4, maxInstances: 5 };
module.exports = { CATALOG_SKU_POLICY_VERSION, DEFAULT_SETTINGS, MAX_CATALOG_SKU_NUMBER, MAX_LEGACY_CATALOG_PRODUCTS,
  canonicalCatalogSku, keyForSku, legacyShardId, shardChecksum, normalizeSettings, createAllocationContext, prepareCatalogSku,
  writeCatalogSkuReservation, writeAllocation, getHotelCatalogSkuSettingsHandler, saveHotelCatalogSkuSettingsHandler, assignHotelCatalogSkusHandler,
  getHotelCatalogSkuSettings: onCall(options, gated(getHotelCatalogSkuSettingsHandler)), saveHotelCatalogSkuSettings: onCall(options, gated(saveHotelCatalogSkuSettingsHandler)), assignHotelCatalogSkus: onCall(options, gated(assignHotelCatalogSkusHandler)) };
