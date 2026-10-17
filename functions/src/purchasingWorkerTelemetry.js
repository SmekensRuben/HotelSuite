const { admin, logger } = require("./config");
const { runtimePolicy } = require("./environmentPolicy");
const { readPurchasingMonitoringConfiguration } = require("./purchasingMonitoringConfig");

// Observation is best effort on both sides of the existing handler. A failed
// telemetry write must neither repeat nor change the result of a business task.
function withPurchasingWorkerTelemetry(name, handler, services = {}) {
  if (name !== "contract-reminders") throw new Error("Unsupported purchasing worker.");
  return async (...args) => {
    const runtime = services.runtimePolicy || runtimePolicy(), clock = services.now || Date.now;
    const bounded = async (operation) => {
      let timer;
      try { return await Promise.race([operation, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Purchasing observation deadline exceeded.")), services.timeoutMillis || 1000);
      })]); }
      finally { clearTimeout(timer); }
    };
    let ref;
    const write = async (value) => {
      if (!ref) return;
      try { await bounded(ref.set({ ...value, environment: runtime.environment, updatedAtMillis: clock() }, { merge: true })); }
      catch { (services.logger || logger).error("Purchasing worker observation could not be stored.", { code: "purchasing-worker-telemetry-unavailable", worker: name }); }
    };
    try {
      const db = services.firestore || admin.firestore(), configuration = await bounded(readPurchasingMonitoringConfiguration(db, { projectId: runtime.projectId }));
      if (configuration.enabled && configuration.environment === runtime.environment) ref = db.doc(`platformWorkerHealth/${name}`);
    } catch { (services.logger || logger).error("Purchasing worker observation is unavailable.", { code: "purchasing-worker-telemetry-unavailable", worker: name }); }
    await write({ status: "processing", lastAttemptAtMillis: clock() });
    try {
      const result = await handler(...args);
      await write({ status: "completed", lastSuccessfulAtMillis: clock() });
      return result;
    } catch (error) {
      await write({ status: "failed", lastFailureAtMillis: clock() });
      throw error;
    }
  };
}

module.exports = { withPurchasingWorkerTelemetry };
