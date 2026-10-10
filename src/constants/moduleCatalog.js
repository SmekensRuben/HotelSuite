import catalog from "../../functions/src/moduleCatalog.json";

export const MODULE_CATALOG = catalog.modules;
export const MODULE_POLICY_VERSION = catalog.policyVersion;
export const CORE_FEATURES = catalog.coreFeatures;
export const FEATURE_MODULE = Object.fromEntries(Object.entries(MODULE_CATALOG)
  .flatMap(([id, module]) => module.features.map((feature) => [feature, id])));

export function modulesAreValid(subscription) {
  const ids = Object.keys(MODULE_CATALOG);
  return subscription?.modulePolicyVersion === MODULE_POLICY_VERSION && Array.isArray(subscription.modules)
    && subscription.modules.length <= ids.length && subscription.modules.every((id) => ids.includes(id))
    && new Set(subscription.modules).size === subscription.modules.length;
}
export function featureIsLicensed(subscription, feature) {
  const key = String(feature || "").trim().toLowerCase();
  return modulesAreValid(subscription) && (CORE_FEATURES.includes(key) || subscription.modules.includes(FEATURE_MODULE[key]));
}
