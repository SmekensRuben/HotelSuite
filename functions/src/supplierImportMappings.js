const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { admin } = require("./config");
const { requireHotelPermission } = require("./authorization");
const { requireDocumentId } = require("./subscriptions");
const { digest, revision } = require("./validation");
const { gated, requireSaasRollout } = require("./saasRollout");

const MAPPING_VERSION = 1, MAX_MAPPINGS = 100;
const SOURCE_FORMATS = Object.freeze(["csv", "xlsx", "pdf", "docx", "eml", "txt"]);
const PURCHASE_UNITS = Object.freeze(require("./supplierPurchaseUnits.json"));
const UNIT_SUGGESTIONS = Object.freeze({ FL: "Bottle", ZK: "Bag", EM: "Bucket", BK: "Box", TR: "Tray", PT: "Jar", ST: "Piece", DS: "Box", PK: "Pack" });
const stamp = () => admin.firestore.FieldValue.serverTimestamp();
function plain(value) { return typeof value === "string" ? value.normalize("NFC").replace(/\s+/gu, " ").trim() : ""; }
function sourceUnitKey(value) {
  const result = plain(value).toUpperCase();
  if (!result || result.length > 80 || /[\u0000-\u001f\u007f/\\]/u.test(result)) throw new HttpsError("invalid-argument", "Use a purchase-unit code or label of at most 80 characters.");
  return result;
}
function canonicalPurchaseUnit(value) {
  if (/^(?:kg|kilo|kilograms?)$/i.test(plain(value))) return "kg";
  const result = PURCHASE_UNITS.find((unit) => unit.toLowerCase() === plain(value).toLowerCase());
  if (!result) throw new HttpsError("invalid-argument", "Choose a supported English purchase-package label.");
  return result;
}
function mappingScope(input) {
  const supplierId = requireDocumentId(input?.supplierId, "supplierId"), sourceFormat = input?.sourceFormat;
  if (!SOURCE_FORMATS.includes(sourceFormat)) throw new HttpsError("invalid-argument", "Choose a supported supplier source format.");
  const profileId = input.profileId ?? "default";
  if (typeof profileId !== "string" || !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(profileId)) throw new HttpsError("invalid-argument", "Use a supplier format profile identifier of at most 80 characters.");
  return { supplierId, sourceFormat, profileId };
}
function normalizeMappings(value, { allowEmpty = true } = {}) {
  if (!Array.isArray(value) || value.length > MAX_MAPPINGS || !allowEmpty && !value.length) throw new HttpsError("invalid-argument", "Confirm between one and 100 purchase-unit mappings.");
  const seen = new Set();
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || Object.keys(entry).length !== 2
      || !Object.hasOwn(entry, "sourceUnit") || !Object.hasOwn(entry, "purchaseUnit")) throw new HttpsError("invalid-argument", "A mapping contains only its source unit and English purchase unit.");
    const sourceUnit = sourceUnitKey(entry.sourceUnit), purchaseUnit = canonicalPurchaseUnit(entry.purchaseUnit);
    if (seen.has(sourceUnit)) throw new HttpsError("invalid-argument", "A mapping request repeats a source purchase unit.");
    seen.add(sourceUnit); return { sourceUnit, purchaseUnit };
  }).sort((left, right) => left.sourceUnit.localeCompare(right.sourceUnit, "en"));
}
function mappingProfileRef(db, hotelUid, scope) {
  return db.doc(`hotels/${requireDocumentId(hotelUid, "hotelUid")}/supplierImportMappingProfiles/${digest(scope.supplierId, scope.sourceFormat, scope.profileId)}`);
}
function mappingSnapshot(value, scope) {
  if (!value) return { version: MAPPING_VERSION, ...scope, revision: 0, mappings: [] };
  if (value.version !== MAPPING_VERSION || value.supplierId !== scope.supplierId || value.sourceFormat !== scope.sourceFormat || value.profileId !== scope.profileId
    || !Number.isSafeInteger(value.revision) || value.revision < 0 || value.revision >= Number.MAX_SAFE_INTEGER
    || value.revision === 0 && (!Array.isArray(value.mappings) || value.mappings.length)) throw new HttpsError("failed-precondition", "The supplier purchase-unit profile needs review.");
  let mappings;
  try { mappings = normalizeMappings(value.mappings); } catch { throw new HttpsError("failed-precondition", "The supplier purchase-unit profile needs review."); }
  return { version: MAPPING_VERSION, ...scope, revision: value.revision, mappings };
}
function publicMappingProfile(snapshot, supplier) {
  const sligro = /\bsligro\b/i.test(plain(supplier?.supplierName ?? supplier?.name));
  const suggestions = Object.entries(UNIT_SUGGESTIONS).filter(([code]) => sligro || ["DS", "PK", "FL", "ST"].includes(code))
    .filter(([code]) => !snapshot.mappings.some((entry) => entry.sourceUnit === code))
    .map(([sourceUnit, purchaseUnit]) => ({ sourceUnit, purchaseUnit, needsConfirmation: true }));
  return { ...snapshot, mappings: snapshot.mappings.map((entry) => ({ ...entry })), suggestions, purchaseUnits: [...PURCHASE_UNITS] };
}
async function authorizeMappings(db, request, hotelUid, transaction, services, write) {
  await requireSaasRollout(db, transaction);
  const actor = { auth: request.auth };
  await requireHotelPermission(db, actor, hotelUid, "supplierproducts", "read", transaction, services.auth);
  await requireHotelPermission(db, actor, hotelUid, "suppliers", "read", transaction, services.auth);
  if (write) await requireHotelPermission(db, actor, hotelUid, "supplierproducts", "create", transaction, services.auth);
}
function exactFields(input, fields) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((field) => !fields.includes(field))) throw new HttpsError("invalid-argument", "Unsupported supplier mapping field.");
}
async function readHotelSupplierPurchaseUnitMappingsHandler(request, services = {}) {
  const input = request.data || {}, hotelUid = requireDocumentId(input.hotelUid, "hotelUid"), scope = mappingScope(input);
  exactFields(input, ["hotelUid", "supplierId", "sourceFormat", "profileId"]);
  const db = services.firestore || admin.firestore();
  return db.runTransaction(async (tx) => {
    await authorizeMappings(db, request, hotelUid, tx, services, false);
    const [supplier, stored] = await Promise.all([tx.get(db.doc(`hotels/${hotelUid}/suppliers/${scope.supplierId}`)), tx.get(mappingProfileRef(db, hotelUid, scope))]);
    if (!supplier.exists || supplier.data().archived === true) throw new HttpsError("failed-precondition", "Choose an active supplier in this hotel.");
    return { hotelUid, ...publicMappingProfile(mappingSnapshot(stored.exists ? stored.data() : null, scope), supplier.data()) };
  });
}
async function saveHotelSupplierPurchaseUnitMappingHandler(request, services = {}) {
  const input = request.data || {}, hotelUid = requireDocumentId(input.hotelUid, "hotelUid"), scope = mappingScope(input);
  exactFields(input, ["hotelUid", "supplierId", "sourceFormat", "profileId", "requestId", "expectedRevision", "mappings"]);
  const requestId = requireDocumentId(input.requestId, "requestId"), expectedRevision = revision(input.expectedRevision), mappings = normalizeMappings(input.mappings, { allowEmpty: false });
  const db = services.firestore || admin.firestore(), profileRef = mappingProfileRef(db, hotelUid, scope);
  const commandId = `m-${digest(request.auth?.uid, requestId).slice(0, 48)}`, operationRef = db.doc(`hotels/${hotelUid}/supplierImportMappingOperations/${commandId}`);
  const fingerprint = digest("supplier-purchase-units", scope, expectedRevision, mappings);
  return db.runTransaction(async (tx) => {
    await authorizeMappings(db, request, hotelUid, tx, services, true);
    const [prior, supplier, stored] = await Promise.all([tx.get(operationRef), tx.get(db.doc(`hotels/${hotelUid}/suppliers/${scope.supplierId}`)), tx.get(profileRef)]);
    if (!supplier.exists || supplier.data().archived === true) throw new HttpsError("failed-precondition", "Choose an active supplier in this hotel.");
    if (prior.exists) {
      if (prior.data().fingerprint !== fingerprint) throw new HttpsError("already-exists", "This mapping request was already used with different details.");
      if (prior.data().requiresUpdate) await requireHotelPermission(db, { auth: request.auth }, hotelUid, "supplierproducts", "update", tx, services.auth);
      return prior.data().result;
    }
    const previous = mappingSnapshot(stored.exists ? stored.data() : null, scope);
    if (previous.revision !== expectedRevision) throw new HttpsError("aborted", "The supplier mapping profile changed. Refresh before saving.");
    const merged = new Map(previous.mappings.map((entry) => [entry.sourceUnit, entry.purchaseUnit]));
    const requiresUpdate = mappings.some((entry) => merged.has(entry.sourceUnit) && merged.get(entry.sourceUnit) !== entry.purchaseUnit);
    if (requiresUpdate) await requireHotelPermission(db, { auth: request.auth }, hotelUid, "supplierproducts", "update", tx, services.auth);
    for (const entry of mappings) merged.set(entry.sourceUnit, entry.purchaseUnit);
    if (merged.size > MAX_MAPPINGS) throw new HttpsError("resource-exhausted", "A supplier format profile supports at most 100 purchase-unit mappings.");
    const next = { version: MAPPING_VERSION, ...scope, revision: previous.revision + 1,
      mappings: normalizeMappings([...merged].map(([sourceUnit, purchaseUnit]) => ({ sourceUnit, purchaseUnit }))) };
    const result = { hotelUid, requestId, ...publicMappingProfile(next, supplier.data()) };
    tx.set(profileRef, { ...next, createdAt: stored.exists ? stored.data().createdAt ?? stamp() : stamp(), createdBy: stored.exists ? stored.data().createdBy ?? request.auth.uid : request.auth.uid,
      updatedAt: stamp(), updatedBy: request.auth.uid });
    tx.create(operationRef, { actorUid: request.auth.uid, fingerprint, requiresUpdate, supplierId: scope.supplierId, result, createdAt: stamp() });
    tx.create(db.doc(`hotels/${hotelUid}/supplierImportMappingAudit/${commandId}`), { actorUid: request.auth.uid, ...scope,
      previousRevision: previous.revision, revision: next.revision, mappings, createdAt: stamp() });
    return result;
  });
}
const options = { region: "us-central1", cors: true, timeoutSeconds: 120 };
const readHotelSupplierPurchaseUnitMappings = onCall(options, gated(readHotelSupplierPurchaseUnitMappingsHandler));
const saveHotelSupplierPurchaseUnitMapping = onCall(options, gated(saveHotelSupplierPurchaseUnitMappingHandler));
module.exports = { MAPPING_VERSION, MAX_MAPPINGS, SOURCE_FORMATS, PURCHASE_UNITS, UNIT_SUGGESTIONS, sourceUnitKey, canonicalPurchaseUnit,
  mappingScope, mappingProfileRef, mappingSnapshot, normalizeMappings, readHotelSupplierPurchaseUnitMappingsHandler,
  saveHotelSupplierPurchaseUnitMappingHandler, readHotelSupplierPurchaseUnitMappings, saveHotelSupplierPurchaseUnitMapping };
