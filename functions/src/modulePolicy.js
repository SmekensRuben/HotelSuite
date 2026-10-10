const { HttpsError } = require("firebase-functions/v2/https");
const catalog = require("./moduleCatalog.json");
const permissions = require("./permissionCatalog.json");

const MODULE_IDS = Object.keys(catalog.modules);
const FEATURE_MODULE = Object.fromEntries(MODULE_IDS.flatMap((id) => catalog.modules[id].features.map((feature) => [feature, id])));
const VALID_PERMISSIONS = new Set(Object.entries(permissions).flatMap(([feature, actions]) => [...actions, "*"].map((action) => `${feature}.${action}`.toLowerCase())));
const ADMIN_PERMISSIONS = ["users.read", "users.create", "users.update", "users.delete"];

function modulesAreValid(subscription) {
  return subscription?.modulePolicyVersion === catalog.policyVersion && Array.isArray(subscription.modules)
    && subscription.modules.length <= MODULE_IDS.length && subscription.modules.every((id) => MODULE_IDS.includes(id))
    && new Set(subscription.modules).size === subscription.modules.length;
}
function moduleAllows(subscription, moduleId) {
  return modulesAreValid(subscription) && (moduleId === "core" || subscription.modules.includes(moduleId));
}
function featureModule(feature) {
  const key = String(feature || "").trim().toLowerCase();
  return FEATURE_MODULE[key] || (catalog.coreFeatures.includes(key) ? "core" : null);
}
function featureIsLicensed(subscription, feature) {
  const moduleId = featureModule(feature);
  return moduleId !== null && moduleAllows(subscription, moduleId);
}
function validateModules(modules) {
  if (!modulesAreValid({ modules, modulePolicyVersion: catalog.policyVersion })) {
    throw new HttpsError("invalid-argument", "Choose unique, supported hotel modules explicitly.");
  }
  return modules.slice().sort();
}
function validateSeatLimit(value) {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 1 || value > 10000) {
    throw new HttpsError("invalid-argument", "User limit must be null or a whole number from 1 to 10000.");
  }
  return value;
}
function dataPathModule(path) {
  const parts = String(path || "").split("/");
  if (parts[0] !== "hotels" || !parts[1]) return null;
  const collection = parts[2]?.toLowerCase();
  if (collection === "reports") {
    const report = parts[3]?.toLowerCase();
    if (["historyquotes", "historyforecast", "lighthousedata", "staypatternmodel", "staydatepattern"].includes(report)) return "revenue";
    if (["arrivalsdetailed", "arrivalsmadeyesterday", "ratecodeheader", "reservationdetails", "reservationbills", "detailedfolio"].includes(report)) return "frontoffice";
    // Other imports have no ordinary operational read surface. Their core
    // ingestion entitlement never conveys permission to a licensed feature.
    return "core";
  }
  const aliases = { upselling: "frontoffice", groupsettings: "groups", groupmarketsegments: "groups", subsegments: "groups",
    demandcalendarevents: "revenue", localevents: "revenue", quotes: "revenue", competitorgroupquotes: "revenue" };
  return aliases[collection] || featureModule(collection);
}
function compileMemberAccess({ moduleRoles = {}, additionalPermissions = [], hotelAdmin = false }, subscription, previousPermissions = [], previousRoles = {}) {
  if (!moduleRoles || typeof moduleRoles !== "object" || Array.isArray(moduleRoles)
    || typeof hotelAdmin !== "boolean" || !Array.isArray(additionalPermissions) || additionalPermissions.length > 200) {
    throw new HttpsError("invalid-argument", "Choose valid module roles and permissions.");
  }
  const effective = new Set(["dashboard.read", ...(hotelAdmin ? ADMIN_PERMISSIONS : [])]);
  const previous = previousPermissions.map((key) => String(key).trim().toLowerCase());
  const normalizedRoles = {};
  for (const [id, roles] of Object.entries(moduleRoles)) {
    if (!MODULE_IDS.includes(id) || !Array.isArray(roles) || roles.length > 5 || new Set(roles).size !== roles.length) {
      throw new HttpsError("invalid-argument", "Choose supported module roles.");
    }
    const licensed = moduleAllows(subscription, id);
    if (roles.length && !licensed && JSON.stringify(roles.slice().sort()) !== JSON.stringify((previousRoles[id] || []).slice().sort())) {
      throw new HttpsError("permission-denied", "This hotel has not subscribed to the selected module.");
    }
    normalizedRoles[id] = roles.slice().sort();
    for (const role of roles) {
      const definition = catalog.modules[id].roles[role];
      if (!definition) throw new HttpsError("invalid-argument", "Choose a supported role for this module.");
      if (licensed) definition.permissions.forEach((key) => effective.add(key));
    }
    if (!licensed) previous.filter((key) => featureModule(key.split(".")[0]) === id).forEach((key) => effective.add(key));
  }
  const extras = [...new Set(additionalPermissions.map((key) => typeof key === "string" ? key.trim().toLowerCase() : ""))].sort();
  for (const key of extras) {
    if (!VALID_PERMISSIONS.has(key) || key.startsWith("users.")) throw new HttpsError("invalid-argument", "Advanced permissions cannot grant user or platform administration.");
    if (!featureIsLicensed(subscription, key.split(".")[0]) && !previous.includes(key)) {
      throw new HttpsError("permission-denied", "Advanced permissions require the corresponding hotel module.");
    }
    effective.add(key);
  }
  return { permissions: [...effective].sort(), moduleRoles: normalizedRoles,
    additionalPermissions: extras, hotelAdmin, rolePolicyVersion: catalog.policyVersion };
}

module.exports = { catalog, MODULE_IDS, ADMIN_PERMISSIONS, FEATURE_MODULE, modulesAreValid, moduleAllows,
  featureModule, featureIsLicensed, dataPathModule, validateModules, validateSeatLimit, compileMemberAccess };
