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
const INTERPRETATION_VERSION = 1;
const INTERPRETATION_COLUMNS = Object.freeze(["supplierSku", "supplierProductName", "purchaseUnit", "baseUnitsPerPurchaseUnit", "baseUnit", "packCount", "contentQuantity", "contentUnit",
  "pricePerPurchaseUnit", "pricePerBaseUnit", "currency", "priceBasis", "vatRate", "priceValidFrom", "priceValidUntil", "sourceIssuedOn", "gtin"]);
function normalizeInterpretation(value, sourceFormat) {
  const keys = ["version", "header", "sheetName", "columns", "defaults", "assortmentMode", "documentPurpose", "decimalSeparator", "dateFormat"];
  if (!["csv", "xlsx"].includes(sourceFormat) || !value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))
    || value.version !== INTERPRETATION_VERSION || !Array.isArray(value.header) || !value.header.length || value.header.length > 128
    || JSON.stringify(value.header).length > 32768
    || value.header.some((label) => typeof label !== "string" || label.length > 8192 || /[\u0000]/u.test(label))
    || value.sheetName !== null && (typeof value.sheetName !== "string" || !value.sheetName || value.sheetName.length > 100)
    || sourceFormat === "csv" && value.sheetName !== null || !["full", "partial", "unknown"].includes(value.assortmentMode)
    || !["price-list", "product-list", "statistics"].includes(value.documentPurpose) || ![".", ","].includes(value.decimalSeparator)
    || !["YYYY-MM-DD", "DD/MM/YYYY"].includes(value.dateFormat)) throw new HttpsError("invalid-argument", "Confirm a supported table header, source purpose and decimal/date format.");
  const columns = value.columns;
  if (!columns || typeof columns !== "object" || Array.isArray(columns) || Object.keys(columns).some((key) => !INTERPRETATION_COLUMNS.includes(key))
    || !Number.isInteger(columns.supplierSku) || Object.values(columns).some((index) => !Number.isInteger(index) || index < 0 || index >= value.header.length)
    || new Set(Object.values(columns)).size !== Object.keys(columns).length || columns.pricePerPurchaseUnit !== undefined && columns.pricePerBaseUnit !== undefined)
    throw new HttpsError("invalid-argument", "Map each supplier field to one distinct source column, including the article number and one price channel.");
  if (columns.pricePerPurchaseUnit !== undefined && /(?:\bper\s*|\/\s*)(?:kg|g|ml|l|each)\b/i.test(value.header[columns.pricePerPurchaseUnit]))
    throw new HttpsError("invalid-argument", "An explicit physical-unit price header must map to the base-unit price channel.");
  const defaults = value.defaults ?? {}, allowedDefaults = ["baseUnit", "currency", "priceBasis", "pricingModel", "vatRate"];
  if (typeof defaults !== "object" || !defaults || Array.isArray(defaults) || Object.keys(defaults).some((key) => !allowedDefaults.includes(key))
    || defaults.baseUnit !== undefined && !["g", "kg", "ml", "l", "each"].includes(defaults.baseUnit)
    || defaults.currency !== undefined && (!/^[A-Z]{3}$/.test(defaults.currency) || !Intl.supportedValuesOf("currency").includes(defaults.currency))
    || defaults.priceBasis !== undefined && !["net", "gross", "unknown"].includes(defaults.priceBasis)
    || defaults.pricingModel !== undefined && !["Per Purchase Unit", "Per Base Unit"].includes(defaults.pricingModel)
    || defaults.vatRate !== undefined && (typeof defaults.vatRate !== "number" || !Number.isFinite(defaults.vatRate) || defaults.vatRate < 0 || defaults.vatRate > 1 || !Number.isSafeInteger(defaults.vatRate * 1000000)))
    throw new HttpsError("invalid-argument", "Choose supported, explicitly confirmed format defaults. Recurring formats cannot store one-off validity dates.");
  if (value.documentPurpose === "statistics" && (columns.pricePerPurchaseUnit !== undefined || columns.pricePerBaseUnit !== undefined))
    throw new HttpsError("invalid-argument", "Statistics cannot establish current supplier unit prices.");
  return { version: INTERPRETATION_VERSION, header: value.header.map((label) => label.normalize("NFC")), sheetName: value.sheetName,
    columns: Object.fromEntries(Object.keys(columns).sort().map((key) => [key, columns[key]])), defaults: Object.fromEntries(Object.keys(defaults).sort().map((key) => [key, defaults[key]])),
    assortmentMode: value.assortmentMode, documentPurpose: value.documentPurpose, decimalSeparator: value.decimalSeparator, dateFormat: value.dateFormat };
}
const interpretationFingerprint = (value, sourceFormat) => digest("supplier-table-format-v1", sourceFormat, normalizeInterpretation(value, sourceFormat));
const tableFingerprint = (header, sheetName, sourceFormat) => digest("supplier-table-header-v1", sourceFormat, sheetName, header);
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
    || value.revision === 0 && (!Array.isArray(value.mappings) || value.mappings.length || value.interpretation !== undefined)) throw new HttpsError("failed-precondition", "The supplier purchase-unit profile needs review.");
  let mappings;
  try { mappings = normalizeMappings(value.mappings); } catch { throw new HttpsError("failed-precondition", "The supplier purchase-unit profile needs review."); }
  let interpretation;
  try {
    if (value.interpretation !== undefined) {
      interpretation = normalizeInterpretation(value.interpretation, scope.sourceFormat);
      if (value.interpretationFingerprint !== undefined && value.interpretationFingerprint !== interpretationFingerprint(interpretation, scope.sourceFormat)) throw new Error("Format fingerprint mismatch");
    }
  }
  catch { throw new HttpsError("failed-precondition", "The supplier file-format profile needs review."); }
  return { version: MAPPING_VERSION, ...scope, revision: value.revision, mappings, ...(interpretation ? { interpretation,
    interpretationFingerprint: interpretationFingerprint(interpretation, scope.sourceFormat) } : {}) };
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
  exactFields(input, ["hotelUid", "supplierId", "sourceFormat", "profileId", "requestId", "expectedRevision", "mappings", "interpretation"]);
  const interpretation = input.interpretation === undefined ? undefined : normalizeInterpretation(input.interpretation, scope.sourceFormat);
  const requestId = requireDocumentId(input.requestId, "requestId"), expectedRevision = revision(input.expectedRevision), mappings = normalizeMappings(input.mappings, { allowEmpty: Boolean(interpretation) });
  const db = services.firestore || admin.firestore(), profileRef = mappingProfileRef(db, hotelUid, scope);
  const commandId = `m-${digest(request.auth?.uid, requestId).slice(0, 48)}`, operationRef = db.doc(`hotels/${hotelUid}/supplierImportMappingOperations/${commandId}`);
  const fingerprint = interpretation ? digest("supplier-purchase-units", scope, expectedRevision, mappings, interpretation) : digest("supplier-purchase-units", scope, expectedRevision, mappings);
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
    const requiresUpdate = mappings.some((entry) => merged.has(entry.sourceUnit) && merged.get(entry.sourceUnit) !== entry.purchaseUnit)
      || Boolean(interpretation && previous.interpretation && interpretationFingerprint(interpretation, scope.sourceFormat) !== previous.interpretationFingerprint);
    if (requiresUpdate) await requireHotelPermission(db, { auth: request.auth }, hotelUid, "supplierproducts", "update", tx, services.auth);
    for (const entry of mappings) merged.set(entry.sourceUnit, entry.purchaseUnit);
    if (merged.size > MAX_MAPPINGS) throw new HttpsError("resource-exhausted", "A supplier format profile supports at most 100 purchase-unit mappings.");
    const next = { version: MAPPING_VERSION, ...scope, revision: previous.revision + 1,
      mappings: normalizeMappings([...merged].map(([sourceUnit, purchaseUnit]) => ({ sourceUnit, purchaseUnit }))),
      ...(interpretation || previous.interpretation ? { interpretation: interpretation || previous.interpretation,
        interpretationFingerprint: interpretationFingerprint(interpretation || previous.interpretation, scope.sourceFormat) } : {}) };
    const result = { hotelUid, requestId, ...publicMappingProfile(next, supplier.data()) };
    tx.set(profileRef, { ...next, createdAt: stored.exists ? stored.data().createdAt ?? stamp() : stamp(), createdBy: stored.exists ? stored.data().createdBy ?? request.auth.uid : request.auth.uid,
      updatedAt: stamp(), updatedBy: request.auth.uid });
    tx.create(operationRef, { actorUid: request.auth.uid, fingerprint, requiresUpdate, supplierId: scope.supplierId, result, createdAt: stamp() });
    tx.create(db.doc(`hotels/${hotelUid}/supplierImportMappingAudit/${commandId}`), { actorUid: request.auth.uid, ...scope,
      previousRevision: previous.revision, revision: next.revision, mappings, ...(interpretation ? { interpretation, interpretationFingerprint: next.interpretationFingerprint } : {}), createdAt: stamp() });
    return result;
  });
}
const options = { region: "us-central1", cors: true, timeoutSeconds: 120 };
const readHotelSupplierPurchaseUnitMappings = onCall(options, gated(readHotelSupplierPurchaseUnitMappingsHandler));
const saveHotelSupplierPurchaseUnitMapping = onCall(options, gated(saveHotelSupplierPurchaseUnitMappingHandler));
module.exports = { MAPPING_VERSION, MAX_MAPPINGS, SOURCE_FORMATS, PURCHASE_UNITS, UNIT_SUGGESTIONS, INTERPRETATION_VERSION, INTERPRETATION_COLUMNS, normalizeInterpretation, interpretationFingerprint, tableFingerprint, sourceUnitKey, canonicalPurchaseUnit,
  mappingScope, mappingProfileRef, mappingSnapshot, normalizeMappings, readHotelSupplierPurchaseUnitMappingsHandler,
  saveHotelSupplierPurchaseUnitMappingHandler, readHotelSupplierPurchaseUnitMappings, saveHotelSupplierPurchaseUnitMapping };
