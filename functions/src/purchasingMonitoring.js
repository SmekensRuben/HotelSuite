const { admin } = require("./config");
const { digest } = require("./validation");
const { runtimePolicy } = require("./environmentPolicy");
const { readPurchasingMonitoringConfiguration } = require("./purchasingMonitoringConfig");
const { collectPurchasingSignals } = require("./purchasingMonitoringSignals");

const ISSUE_STATUSES = new Set(["failed", "stalled", "needs-review", "unknown"]);
const WORKER_PATH = "platformConfiguration/importMonitoringWorker";
const RETENTION_DAYS = 90;

// This projection accepts only metadata produced by the signal classifiers. No
// source payload, provider error, mail body or file path belongs in an incident.
async function reconcilePurchasingIncident(db, hotelUid, observation, now, environment) {
  const { process, sourceId, status } = observation;
  if (!process || !sourceId || ![...ISSUE_STATUSES, "healthy", "processing", "paused", "simulated"].includes(status)) return;
  const id = digest("purchasing-v1", environment, hotelUid, process, sourceId);
  const ref = db.doc(`platformIncidents/${id}`);
  await db.runTransaction(async (tx) => {
    const snapshot = await tx.get(ref), previous = snapshot.data();
    const evidenceAt = Number.isFinite(observation.evidenceAtMillis) ? observation.evidenceAtMillis : null;
    const previousEvidenceAt = previous?.evidenceAtMillis || null;
    if (previous?.state === "resolved" && previous.resolutionMode === "operator-review"
      && (!evidenceAt || previousEvidenceAt && evidenceAt <= previousEvidenceAt)) return;
    // Source evidence orders concurrent snapshots more reliably than evaluator
    // start time. A newer-started refresh may still hold an older source result.
    if (evidenceAt && previousEvidenceAt && evidenceAt < previousEvidenceAt) return;
    if ((!evidenceAt || !previousEvidenceAt || evidenceAt === previousEvidenceAt)
      && (previous?.lastDetectedAtMillis || 0) > now) return;
    if (status === "healthy" && !evidenceAt) return;
    const detectedAt = Math.max(now, previous?.lastDetectedAtMillis || 0);
    if (ISSUE_STATUSES.has(status)) {
      const recurring = previous?.state === "resolved";
      tx.set(ref, { schemaVersion: 2, environment, hotelUid, process, sourceId,
        code: observation.code, severity: observation.severity || "warning", status,
        summary: observation.summary, nextStep: observation.nextStep,
        correlationId: observation.correlationId || null,
        metadata: observation.metadata || {},
        evidenceAtMillis: evidenceAt || previousEvidenceAt,
        state: "open", episode: (previous?.episode || 0) + (!previous || recurring ? 1 : 0),
        firstEverDetectedAtMillis: previous?.firstEverDetectedAtMillis || previous?.firstDetectedAtMillis || now,
        firstDetectedAtMillis: !previous || recurring ? now : previous.firstDetectedAtMillis,
        lastDetectedAtMillis: detectedAt, resolvedAtMillis: null,
        acknowledgedAtMillis: recurring ? null : previous?.acknowledgedAtMillis ?? null,
        acknowledgedBy: recurring ? null : previous?.acknowledgedBy ?? null,
        acknowledgedReason: recurring ? null : previous?.acknowledgedReason ?? null });
    } else if (status === "healthy" && previous?.state === "open") {
      tx.update(ref, { state: "resolved", status, resolvedAtMillis: detectedAt, lastDetectedAtMillis: detectedAt,
        evidenceAtMillis: observation.evidenceAtMillis || null,
        expiresAt: admin.firestore.Timestamp.fromMillis(now + RETENTION_DAYS * 86400000) });
    }
    // Absence, an incomplete scan, staging simulation and a pause cannot prove
    // that an earlier real failure recovered. Only explicit healthy evidence can.
  });
}

async function reconcileHotelPurchasingMonitoring(db, hotelUid, configuration, now = Date.now()) {
  if (!configuration.enabled) return { hotelUid, status: "paused" };
  const evidence = await collectPurchasingSignals(db, hotelUid, configuration, now);
  const unique = new Map();
  for (const observation of evidence.observations) {
    const key = digest(observation.process, observation.sourceId), previous = unique.get(key);
    if (!previous || ISSUE_STATUSES.has(observation.status) || !ISSUE_STATUSES.has(previous.status)) unique.set(key, observation);
  }
  const observations = [...unique.values()];
  for (let index = 0; index < observations.length; index += 5) {
    await Promise.all(observations.slice(index, index + 5).map((observation) =>
      reconcilePurchasingIncident(db, hotelUid, observation, now, configuration.environment)));
  }
  const issues = evidence.observations.filter((row) => ISSUE_STATUSES.has(row.status));
  const status = evidence.coverage.length && evidence.coverage.every((row) => row.status === "paused") ? "paused"
    : issues.length ? "attention" : evidence.coverage.some((row) => row.status === "unknown" || row.truncated)
    ? "unknown" : evidence.observations.some((row) => row.status === "processing") ? "processing"
      : evidence.observations.length && evidence.observations.every((row) => ["paused", "simulated"].includes(row.status))
        ? "paused" : "observed";
  const health = { schemaVersion: 1, environment: configuration.environment, computedAtMillis: now,
    status, issueCount: issues.length, coverage: evidence.coverage };
  await db.runTransaction(async (tx) => {
    const ref = db.doc(`hotels/${hotelUid}/platformHealth/purchasing`), previous = await tx.get(ref);
    if ((previous.data()?.computedAtMillis || 0) <= now) tx.set(ref, health);
  });
  return { hotelUid, ...health, failed: evidence.coverage.some((row) => row.readError)
    || evidence.observations.some((row) => row.code === "source-read-unavailable") };
}

async function purchasingMonitoringStatus(db, now = Date.now(), projectId = runtimePolicy().projectId) {
  let configuration;
  try { configuration = await readPurchasingMonitoringConfiguration(db, { projectId }); }
  catch { return { enabled: false, environment: runtimePolicy().environment, status: "invalid-configuration",
    lastAttemptAtMillis: null, lastSuccessfulAtMillis: null }; }
  const snapshot = await db.doc(WORKER_PATH).get(), worker = snapshot.data() || {};
  const lastSuccessfulAtMillis = worker.lastSuccessfulAtMillis || null;
  return { environment: configuration.environment, enabled: configuration.enabled,
    status: !configuration.enabled ? configuration.reason || "paused"
      : !lastSuccessfulAtMillis ? "unknown"
        : now - lastSuccessfulAtMillis > configuration.evaluatorStaleMinutes * 60000 ? "stale"
          : worker.failedHotels > 0 || worker.cycleFailedHotels > 0 || worker.lastCycleFailedHotels > 0
            || worker.lastFailureAtMillis > lastSuccessfulAtMillis ? "failed" : "observed",
    lastAttemptAtMillis: worker.lastAttemptAtMillis || null, lastSuccessfulAtMillis,
    lastCompletedAtMillis: worker.lastCompletedAtMillis || null, failedHotels: worker.failedHotels ?? null,
    lastCompletedCycleAtMillis: worker.lastCompletedCycleAtMillis || null,
    lastSuccessfulCycleAtMillis: worker.lastSuccessfulCycleAtMillis || null,
    cycleFailedHotels: worker.cycleFailedHotels ?? null, lastCycleFailedHotels: worker.lastCycleFailedHotels ?? null,
    afterHotelUid: worker.afterHotelUid || null, evaluatorStaleMinutes: configuration.evaluatorStaleMinutes || null,
    staleScanMinutes: configuration.thresholds?.staleScanMinutes || null,
    releaseSha: configuration.releaseSha || null };
}

module.exports = { ISSUE_STATUSES, WORKER_PATH, reconcilePurchasingIncident,
  reconcileHotelPurchasingMonitoring, purchasingMonitoringStatus };
