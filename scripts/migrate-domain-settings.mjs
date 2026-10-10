// Operator-only Admin migration. Importing this module never initializes Firebase.
import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const MAX_WRITES = 400;
const BOOTSTRAP_KEYS = ["hotelName", "language", "currency", "posProvider", "orderMode", "lightspeedShiftRolloverHour"];
const LEGACY_SPLIT_KEYS = [...BOOTSTRAP_KEYS, "hotelRooms", "catalogCategories", "catalogSubcategories", "contractCategories", "contractSubcategories", "operaUserMappings"];
const UPSELL_SPLIT_KEYS = ["dailyExpectedOccupancy", "revenueTargetRules", "dailyRevenueTargets"];
const TARGET_AMOUNT_KEYS = ["minimumTargetRevenuePerOccupiedRoom", "reachTargetRevenuePerOccupiedRoom", "stretchTargetRevenuePerOccupiedRoom"];

function fail(message) { throw new Error(message); }
function isMap(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function map(value, label) {
  if (!isMap(value)) fail(`${label} must be a map; no data was coerced.`);
  return value;
}
function keysOnly(value, allowed, label) {
  map(value, label);
  if (Object.keys(value).some((key) => !allowed.includes(key))) fail(`${label} contains unexpected fields.`);
}
function textValue(value, max, label) {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) fail(`${label} must be nonempty text of at most ${max} characters without control characters.`);
  return value;
}
export function validDocumentId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && value === value.trim()
    && !value.includes("/") && ![".", ".."].includes(value) && !/^__.*__$/u.test(value)
    && !/[\u0000-\u001f\u007f]/u.test(value);
}
function documentId(value, label) {
  if (!validDocumentId(value)) fail(`${label} must be a valid Firestore document ID of at most 128 characters.`);
  return value;
}
function numberValue(value, max, label, integer = false) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > max || (integer && !Number.isSafeInteger(value))) fail(`${label} must be ${integer ? "an integer" : "a finite number"} between 0 and ${max}.`);
  return value;
}
function dateValue(value, label) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) fail(`${label} must be a valid YYYY-MM-DD date.`);
  return value;
}
function timestamp(value, label) {
  if (!value || typeof value.toMillis !== "function" || !Number.isFinite(value.toMillis())) fail(`${label} must be a Firestore timestamp.`);
}
function canonical(value) {
  if (value === undefined) return null;
  if (value && typeof value.toJSON === "function") return canonical(value.toJSON());
  if (Array.isArray(value)) return value.map(canonical);
  if (isMap(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
function same(left, right) { return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right)); }
function snapshotVersion(snapshot) { return snapshot.exists ? canonical(snapshot.updateTime) : null; }

function normalizeLanguage(value) {
  const language = textValue(value, 40, "language").trim().toLowerCase();
  for (const [code, aliases] of Object.entries({ en: ["english", "engels"], fr: ["french", "frans"], nl: ["dutch", "nederlands"] })) {
    if (language === code || aliases.includes(language) || new RegExp(`^${code}[-_][a-z0-9-]{1,20}$`, "u").test(language)) return code;
  }
  fail("language is not a supported nl/en/fr value or a known language alias.");
}
function validateBootstrap(data) {
  keysOnly(data, [...BOOTSTRAP_KEYS, "updatedAt"], "bootstrap destination");
  for (const [key, value] of Object.entries(data)) {
    if (key === "hotelName") textValue(value, 200, key);
    else if (key === "language" && !["nl", "en", "fr"].includes(value)) fail("bootstrap language must be nl/en/fr.");
    else if (key === "currency" && (typeof value !== "string" || !/^[A-Z]{3}$/u.test(value))) fail("bootstrap currency must be three uppercase letters.");
    else if (["posProvider", "orderMode"].includes(key)) textValue(value, 40, key);
    else if (key === "lightspeedShiftRolloverHour") numberValue(value, 23, key, true);
    else if (key === "updatedAt") timestamp(value, "bootstrap updatedAt");
  }
}
function validateDestination(kind, data) {
  if (kind === "bootstrap") return validateBootstrap(data);
  if (kind === "property") {
    keysOnly(data, ["hotelRooms", "updatedAt"], "propertySettings destination");
    if (Object.hasOwn(data, "hotelRooms")) numberValue(data.hotelRooms, 100000, "hotelRooms", true);
    if (Object.hasOwn(data, "updatedAt")) timestamp(data.updatedAt, "propertySettings updatedAt");
  } else if (kind === "category" || kind === "subcategory") {
    keysOnly(data, kind === "category" ? ["name"] : ["name", "categoryId"], `${kind} destination`);
    textValue(data.name, 200, `${kind} name`);
    if (kind === "subcategory") documentId(data.categoryId, "subcategory categoryId");
  } else if (kind === "opera") {
    keysOnly(data, ["operaUser", "employeeName"], "Opera mapping destination");
    documentId(data.operaUser, "Opera username");
    textValue(data.employeeName, 200, "Opera employee name");
  } else if (kind === "occupancy") {
    keysOnly(data, ["date", "expectedOccupancy", "updatedAt"], "occupancy destination");
    dateValue(data.date, "occupancy date");
    numberValue(data.expectedOccupancy, 100000, "expectedOccupancy");
    timestamp(data.updatedAt, "occupancy updatedAt");
  } else if (kind === "revenue") {
    keysOnly(data, ["id", "startDate", "endDate", ...TARGET_AMOUNT_KEYS, "updatedAt"], "revenue target destination");
    validateRevenueRule(data, true);
    timestamp(data.updatedAt, "revenue target updatedAt");
  }
}
function validateRevenueRule(rule, destination = false) {
  keysOnly(rule, ["id", "startDate", "endDate", ...TARGET_AMOUNT_KEYS, ...(destination ? ["updatedAt"] : [])], "revenue target rule");
  if (Object.hasOwn(rule, "id")) documentId(rule.id, "revenue rule ID");
  dateValue(rule.startDate, "revenue rule startDate");
  dateValue(rule.endDate, "revenue rule endDate");
  if (rule.startDate > rule.endDate) fail("Revenue target startDate must not follow endDate.");
  for (const key of TARGET_AMOUNT_KEYS) if (Object.hasOwn(rule, key)) numberValue(rule[key], 1000000, key);
}

export function buildMigrationDocuments(hotelUid, legacy = {}, upsells = {}) {
  documentId(hotelUid, "hotel");
  if (["bootstrap", "propertySettings", "catalog", "contracts", "opera", "upsells"].includes(hotelUid)) fail("Hotel ID collides with a reserved settings document ID; operator review is required to preserve the legacy source.");
  map(legacy, "legacy settings source");
  map(upsells, "legacy upsells source");
  const base = `hotels/${hotelUid}/settings`;
  const documents = [];
  const normalizedFields = [];
  const add = (path, kind, data, freshTimestamp = false) => documents.push({ path, kind, data, freshTimestamp });
  const bootstrap = {};
  for (const key of BOOTSTRAP_KEYS) {
    if (!Object.hasOwn(legacy, key)) continue;
    let value = legacy[key];
    if (key === "language") value = normalizeLanguage(value);
    if (key === "currency") value = textValue(value, 3, key).trim().toUpperCase();
    if (!same(value, legacy[key])) normalizedFields.push(key);
    bootstrap[key] = value;
  }
  validateBootstrap(bootstrap);
  if (Object.keys(bootstrap).length) add(`${base}/bootstrap`, "bootstrap", bootstrap);
  if (Object.hasOwn(legacy, "hotelRooms")) add(`${base}/propertySettings`, "property", { hotelRooms: numberValue(legacy.hotelRooms, 100000, "hotelRooms", true) });
  for (const domain of ["catalog", "contract"]) {
    const categoriesKey = `${domain}Categories`, subcategoriesKey = `${domain}Subcategories`;
    const categories = Object.hasOwn(legacy, categoriesKey) ? map(legacy[categoriesKey], categoriesKey) : {};
    const subcategories = Object.hasOwn(legacy, subcategoriesKey) ? map(legacy[subcategoriesKey], subcategoriesKey) : {};
    if (Object.keys(categories).length > 1000 || Object.keys(subcategories).length > 1000) fail(`${domain} taxonomy exceeds the reviewed 1000-document bound per collection.`);
    const path = `${base}/${domain === "contract" ? "contracts" : domain}`;
    for (const [id, value] of Object.entries(categories)) {
      documentId(id, `${categoriesKey} ID`);
      validateDestination("category", value);
      add(`${path}/categories/${id}`, "category", { ...value });
    }
    for (const [id, value] of Object.entries(subcategories)) {
      documentId(id, `${subcategoriesKey} ID`);
      validateDestination("subcategory", value);
      if (!Object.hasOwn(categories, value.categoryId)) fail(`${subcategoriesKey}/${id} references a missing legacy category; operator review is required.`);
      add(`${path}/subcategories/${id}`, "subcategory", { ...value });
    }
  }
  if (Object.hasOwn(legacy, "operaUserMappings")) {
    const mappings = map(legacy.operaUserMappings, "operaUserMappings");
    if (Object.keys(mappings).length > 1000) fail("Opera mappings exceed the reviewed 1000-document bound.");
    for (const [operaUser, employeeName] of Object.entries(mappings)) {
      documentId(operaUser, "Opera username; unsupported legacy identities require operator review");
      textValue(employeeName, 200, "Opera employee name");
      add(`${base}/opera/userMappings/${operaUser}`, "opera", { operaUser, employeeName });
    }
  }
  const dailyLegacy = Object.hasOwn(upsells, "dailyRevenueTargets") ? map(upsells.dailyRevenueTargets, "dailyRevenueTargets") : {};
  if (Object.keys(dailyLegacy).length > 1000) fail("dailyRevenueTargets exceeds the reviewed 1000-date bound.");
  for (const [date, value] of Object.entries(dailyLegacy)) {
    dateValue(date, "dailyRevenueTargets date");
    keysOnly(value, ["expectedOccupancy", "minimumRevenuePerOccupiedRoom", "reachRevenuePerOccupiedRoom", "stretchRevenuePerOccupiedRoom"], "dailyRevenueTargets entry");
    if (Object.hasOwn(value, "expectedOccupancy")) numberValue(value.expectedOccupancy, 100000, "legacy expectedOccupancy");
    for (const key of ["minimumRevenuePerOccupiedRoom", "reachRevenuePerOccupiedRoom", "stretchRevenuePerOccupiedRoom"]) if (Object.hasOwn(value, key)) numberValue(value[key], 1000000, key);
  }
  const occupancy = Object.hasOwn(upsells, "dailyExpectedOccupancy")
    ? map(upsells.dailyExpectedOccupancy, "dailyExpectedOccupancy")
    : Object.fromEntries(Object.entries(dailyLegacy).map(([date, value]) => [date, value.expectedOccupancy ?? 0]));
  if (Object.keys(occupancy).length > 1000) fail("Occupancy exceeds the reviewed 1000-date bound.");
  for (const [date, value] of Object.entries(occupancy)) add(`${base}/upsells/occupancy/${dateValue(date, "occupancy date")}`, "occupancy", { date, expectedOccupancy: numberValue(value, 100000, "expectedOccupancy") }, true);
  const rules = Object.hasOwn(upsells, "revenueTargetRules") ? upsells.revenueTargetRules
    : Object.entries(dailyLegacy).map(([date, value]) => ({ startDate: date, endDate: date,
      minimumTargetRevenuePerOccupiedRoom: value.minimumRevenuePerOccupiedRoom ?? 0,
      reachTargetRevenuePerOccupiedRoom: value.reachRevenuePerOccupiedRoom ?? 0,
      stretchTargetRevenuePerOccupiedRoom: value.stretchRevenuePerOccupiedRoom ?? 0 }));
  if (!Array.isArray(rules) || rules.length > 250) fail("Revenue target rules must be an array with at most 250 entries.");
  const ids = new Set();
  rules.forEach((rule, index) => {
    validateRevenueRule(rule);
    const id = Object.hasOwn(rule, "id") ? rule.id : `${rule.startDate}-${rule.endDate}-${index}`;
    documentId(id, "revenue rule ID");
    if (ids.has(id)) fail("Duplicate revenue target rule IDs require operator review.");
    ids.add(id);
    const data = { id, startDate: rule.startDate, endDate: rule.endDate };
    for (const key of TARGET_AMOUNT_KEYS) data[key] = rule[key] ?? 0;
    add(`${base}/upsells/revenueTargets/${id}`, "revenue", data, true);
  });
  return { documents: documents.sort((a, b) => a.path.localeCompare(b.path)), normalizedFields,
    preservedLegacyFields: Object.keys(legacy).filter((key) => !LEGACY_SPLIT_KEYS.includes(key)).sort(),
    preservedUpsellFields: Object.keys(upsells).filter((key) => !UPSELL_SPLIT_KEYS.includes(key)).sort() };
}

export async function inspectMigration(db, { projectId, hotelUid }) {
  const sourcePaths = [`hotels/${hotelUid}`, `hotels/${hotelUid}/settings/${hotelUid}`, `hotels/${hotelUid}/settings/upsells`];
  const sources = await db.getAll(...sourcePaths.map((path) => db.doc(path)));
  if (!sources[0].exists) fail(`Hotel does not exist: ${hotelUid}`);
  if (!sources[1].exists && !sources[2].exists) fail("Neither legacy settings source exists; no migration is needed.");
  const built = buildMigrationDocuments(hotelUid, sources[1].exists ? sources[1].data() : {}, sources[2].exists ? sources[2].data() : {});
  const targets = built.documents.length ? await db.getAll(...built.documents.map((entry) => db.doc(entry.path))) : [];
  const operations = built.documents.map((entry, index) => {
    const current = targets[index];
    if (!current.exists) return { ...entry, action: "create", beforeVersion: null };
    const data = current.data();
    validateDestination(entry.kind, data);
    for (const [key, value] of Object.entries(entry.data)) {
      if (Object.hasOwn(data, key) && !same(data[key], value)) fail(`Destination conflict at ${entry.path}, field ${key}; no destination was overwritten.`);
    }
    const missingFields = Object.keys(entry.data).filter((key) => !Object.hasOwn(data, key));
    return { ...entry, action: missingFields.length ? "merge" : "keep", beforeVersion: snapshotVersion(current), beforeData: data };
  });
  const sourceVersions = sources.map(snapshotVersion);
  const planId = createHash("sha256").update(JSON.stringify(canonical({ projectId, hotelUid, sourcePaths, sourceVersions,
    operations: operations.map(({ path, kind, data, action, beforeVersion, beforeData }) => ({ path, kind, data, action, beforeVersion, beforeData })) }))).digest("hex");
  return { projectId, hotelUid, sourcePaths, sourceVersions, planId, ...built, operations };
}

export async function applyMigration(db, inspection, { expectedPlan, serverTimestamp }) {
  if (expectedPlan !== inspection.planId) fail("The reviewed plan fingerprint differs. Run a fresh dry run and review it before applying.");
  const writes = inspection.operations.filter((operation) => operation.action !== "keep");
  let completed = 0;
  // All targets are inspected before the first write. Every batch rereads source
  // versions and its targets; a concurrent change aborts that batch safely.
  for (let offset = 0; offset < writes.length; offset += MAX_WRITES) {
    const chunk = writes.slice(offset, offset + MAX_WRITES);
    await db.runTransaction(async (transaction) => {
      const snapshots = await transaction.getAll(...[...inspection.sourcePaths, ...chunk.map((entry) => entry.path)].map((path) => db.doc(path)));
      inspection.sourceVersions.forEach((version, index) => {
        if (!same(version, snapshotVersion(snapshots[index]))) fail("A hotel or legacy source changed during migration. Stop rollout and review a fresh dry run.");
      });
      chunk.forEach((entry, index) => {
        const current = snapshots[inspection.sourcePaths.length + index];
        if (!same(entry.beforeVersion, snapshotVersion(current))) fail(`Destination changed during migration at ${entry.path}. Stop rollout and review a fresh dry run.`);
      });
      chunk.forEach((entry) => {
        const data = { ...(entry.beforeData || {}), ...entry.data, ...(entry.freshTimestamp ? { updatedAt: serverTimestamp() } : {}) };
        const ref = db.doc(entry.path);
        if (entry.action === "create") transaction.create(ref, data);
        else transaction.set(ref, data);
      });
    });
    completed += chunk.length;
  }
  return { written: completed, kept: inspection.operations.length - completed, transactions: Math.ceil(completed / MAX_WRITES) };
}

export function parseArguments(args) {
  const result = {};
  const values = { "--project": "projectId", "--hotel": "hotelUid", "--credentials": "credentials", "--expected-plan": "expectedPlan" };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    const key = values[argument] || ({ "--apply": "apply", "--emulator": "emulator", "--help": "help" })[argument];
    if (!key || Object.hasOwn(result, key)) fail(`Unknown or duplicate argument: ${argument}`);
    if (values[argument]) {
      const value = args[++index];
      if (!value || value.startsWith("--")) fail(`Missing value for ${argument}.`);
      result[key] = value;
    } else result[key] = true;
  }
  if (result.help) return result;
  if (typeof result.projectId !== "string" || !/^[a-z][a-z0-9-]{4,62}$/u.test(result.projectId)) fail("An explicit valid --project is required.");
  documentId(result.hotelUid, "explicit --hotel");
  if (result.apply && !/^[a-f0-9]{64}$/u.test(result.expectedPlan || "")) fail("--apply requires --expected-plan from the reviewed dry run.");
  if (!result.apply && result.expectedPlan) fail("--expected-plan is only accepted with --apply.");
  return result;
}

function publicSummary(inspection, applying) {
  const counts = {};
  for (const entry of inspection.operations) {
    const count = counts[entry.kind] ||= { create: 0, merge: 0, keep: 0 };
    count[entry.action]++;
  }
  return { mode: applying ? "APPLY" : "DRY RUN", project: inspection.projectId, hotel: inspection.hotelUid,
    expectedPlan: inspection.planId, counts, normalizedFields: inspection.normalizedFields,
    preservedLegacyFields: inspection.preservedLegacyFields, preservedUpsellFields: inspection.preservedUpsellFields,
    sourceDocumentsPreserved: true, maximumWritesPerTransaction: MAX_WRITES };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node scripts/migrate-domain-settings.mjs --project PROJECT --hotel HOTEL [--credentials ADC_FILE] [--apply --expected-plan SHA256]\nDefault: read-only dry run. Credentials must be supplied with --credentials or GOOGLE_APPLICATION_CREDENTIALS.\nLocal emulators: add --emulator, set FIRESTORE_EMULATOR_HOST and use a demo-* project.");
    return;
  }
  if (Number(process.versions.node.split(".")[0]) < 22) fail("Node 22 or later is required.");
  if (options.emulator) {
    if (!process.env.FIRESTORE_EMULATOR_HOST || !options.projectId.startsWith("demo-")) fail("--emulator requires FIRESTORE_EMULATOR_HOST and a demo-* project.");
  } else {
    if (process.env.FIRESTORE_EMULATOR_HOST) fail("FIRESTORE_EMULATOR_HOST is set; remove it or explicitly use --emulator.");
    const credentials = options.credentials || process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (!credentials) fail("Supply operator Admin credentials using --credentials or GOOGLE_APPLICATION_CREDENTIALS.");
    await access(credentials);
    process.env.GOOGLE_APPLICATION_CREDENTIALS = credentials;
  }
  const [{ initializeApp, deleteApp, applicationDefault }, { getFirestore, FieldValue }] = await Promise.all([
    import("firebase-admin/app"), import("firebase-admin/firestore"),
  ]);
  const app = initializeApp({ projectId: options.projectId, ...(options.emulator ? {} : { credential: applicationDefault() }) }, "domain-settings-migration");
  try {
    const db = getFirestore(app);
    const inspection = await inspectMigration(db, options);
    console.log(JSON.stringify(publicSummary(inspection, options.apply), null, 2));
    if (options.apply) {
      const result = await applyMigration(db, inspection, { expectedPlan: options.expectedPlan, serverTimestamp: () => FieldValue.serverTimestamp() });
      console.log(JSON.stringify({ status: "copied", ...result, sourceDocumentsPreserved: true }));
      const verified = await inspectMigration(db, options);
      if (verified.operations.some((entry) => entry.action !== "keep")) fail("Post-copy verification found missing fields. Stop rollout and review a fresh dry run.");
      console.log(JSON.stringify({ status: "verified", destinationDocuments: verified.operations.length }));
    }
  } finally { await deleteApp(app); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(`Settings migration stopped: ${error.message}`); process.exitCode = 1; });
}
