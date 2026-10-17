const { DEFAULT_PURCHASING_THRESHOLDS } = require("./purchasingMonitoringPolicy");

const CONFIGURATION_PATH = "platformConfiguration/purchasingMonitoring";
const POLICY_VERSION = 1;
const PROJECT_ENVIRONMENTS = Object.freeze({ "hotel-toolkit": "production", "hotel-toolkit-staging": "staging" });
const THRESHOLD_BOUNDS = Object.freeze({ pendingMinutes: [1, 1440], processingMinutes: [1, 1440],
  supplierConfirmationHours: [1, 720], reviewHours: [1, 720], backlogCount: [1, 1000], retryCount: [1, 100],
  limitWarningRatio: [0.1, 1], staleScanMinutes: [15, 1440], scheduledWorkerHours: [1, 168] });

function validatePurchasingMonitoringConfiguration(value, { projectId, requireEnabled = false } = {}) {
  const environment = PROJECT_ENVIRONMENTS[projectId];
  if (!environment || !value || typeof value !== "object" || Array.isArray(value)
    || value.schemaVersion !== POLICY_VERSION || value.projectId !== projectId || value.environment !== environment
    || typeof value.enabled !== "boolean" || !/^[a-f0-9]{40}$/.test(value.releaseSha || "")) {
    throw new Error("Purchasing monitoring requires a versioned configuration for this exact project and environment.");
  }
  if (requireEnabled && !value.enabled) throw new Error("Purchasing monitoring is disabled for this project.");
  if (!value.thresholds || typeof value.thresholds !== "object" || Array.isArray(value.thresholds)
    || Object.keys(value.thresholds).length !== Object.keys(THRESHOLD_BOUNDS).length) {
    throw new Error("Purchasing monitoring requires explicit reviewed thresholds.");
  }
  const thresholds = {};
  for (const [key, [minimum, maximum]] of Object.entries(THRESHOLD_BOUNDS)) {
    const number = value.thresholds[key];
    if (!Number.isFinite(number) || number < minimum || number > maximum || key !== "limitWarningRatio" && !Number.isSafeInteger(number)) {
      throw new Error(`Purchasing monitoring threshold ${key} is outside its reviewed bounds.`);
    }
    thresholds[key] = number;
  }
  for (const [key, minimum, maximum] of [["maxHotelsPerRun", 1, 25], ["maxDocumentsPerSource", 1, 50], ["evaluatorStaleMinutes", 30, 120]]) {
    if (!Number.isSafeInteger(value[key]) || value[key] < minimum || value[key] > maximum) {
      throw new Error(`Purchasing monitoring ${key} is outside its reviewed bounds.`);
    }
  }
  return { schemaVersion: POLICY_VERSION, projectId, environment, enabled: value.enabled, releaseSha: value.releaseSha,
    thresholds, maxHotelsPerRun: value.maxHotelsPerRun, maxDocumentsPerSource: value.maxDocumentsPerSource,
    evaluatorStaleMinutes: value.evaluatorStaleMinutes };
}

async function readPurchasingMonitoringConfiguration(db, { projectId } = {}) {
  const snapshot = await db.doc(CONFIGURATION_PATH).get();
  if (!snapshot.exists) return { enabled: false, reason: "not-configured", projectId, environment: PROJECT_ENVIRONMENTS[projectId] || "blocked" };
  return validatePurchasingMonitoringConfiguration(snapshot.data(), { projectId });
}

module.exports = { CONFIGURATION_PATH, POLICY_VERSION, PROJECT_ENVIRONMENTS, DEFAULT_PURCHASING_THRESHOLDS,
  validatePurchasingMonitoringConfiguration, readPurchasingMonitoringConfiguration };
