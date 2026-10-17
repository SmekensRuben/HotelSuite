const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { admin, logger } = require("./config");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { requirePlatformAdministrator, requireDocumentId } = require("./subscriptions");
const { text, revision, digest } = require("./validation");
const { validateMonitor, evaluateMonitor } = require("./importMonitoringPolicy");
const { readHotelMonitoring, hotelExists } = require("./platformConsole");
const { writePlatformAudit } = require("./platformAudit");
const { runtimePolicy } = require("./environmentPolicy");
const { readPurchasingMonitoringConfiguration } = require("./purchasingMonitoringConfig");
const { WORKER_PATH, reconcilePurchasingIncident, reconcileHotelPurchasingMonitoring, purchasingMonitoringStatus } = require("./purchasingMonitoring");

const ISSUES = new Set(["overdue", "failed", "empty", "stalled", "unknown", "partial"]);
const stamp = () => admin.firestore.FieldValue.serverTimestamp();
async function savePlatformImportMonitorHandler(request, services = {}) {
  await requirePlatformAdministrator(request, services.auth);
  const input = request.data || {};
  const hotelUid = requireDocumentId(input.hotelUid, "hotelUid");
  const typeId = requireDocumentId(input.typeId, "typeId");
  const expected = revision(input.expectedRevision);
  const policy = validateMonitor(input.policy);
  const db = services.firestore || admin.firestore();
  const ref = db.doc(`hotels/${hotelUid}/importMonitors/${typeId}`);
  const key = db.collection("platformAudit").doc().id;
  return db.runTransaction(async (tx) => {
    const [hotel, type, current] = await Promise.all([tx.get(db.doc(`hotels/${hotelUid}`)), tx.get(db.doc(`hotels/${hotelUid}/fileImportTypes/${typeId}`)), tx.get(ref)]);
    if (!hotel.exists || !type.exists) throw new HttpsError("not-found", "The hotel's import type does not exist.");
    if ((current.data()?.revision || 0) !== expected) throw new HttpsError("aborted", "Monitoring changed. Reload before saving.");
    const fileType = type.data().fileType;
    if (typeof fileType !== "string" || !fileType.trim() || fileType.length > 128) throw new HttpsError("failed-precondition", "Review the canonical import type before configuring monitoring.");
    tx.set(ref, { ...policy, fileType, revision: expected + 1, updatedAt: stamp(), updatedBy: request.auth.uid });
    writePlatformAudit(tx, db, { key, hotelUid, actorUid: request.auth.uid, action: "import-monitor-updated", targetId: typeId, revision: expected + 1 });
    return { hotelUid, typeId, revision: expected + 1 };
  });
}
async function reconcileIncident(db, hotelUid, monitor, health, now) {
  if (!health.occurrenceDate) return;
  const id = digest(hotelUid, monitor.id, health.occurrenceDate, monitor.policy?.revision || 0);
  const ref = db.doc(`platformIncidents/${id}`);
  await db.runTransaction(async (tx) => {
    const previous = await tx.get(ref);
    if ((previous.data()?.lastDetectedAtMillis || 0) > now) return;
    if (ISSUES.has(health.status)) {
      tx.set(ref, { schemaVersion: 1, hotelUid, monitorId: monitor.id, occurrenceDate: health.occurrenceDate,
        monitorPolicy: monitor.policy, monitorRevision: monitor.policy?.revision || 0,
        expectedBusinessDate: health.expectedBusinessDate, code: health.status, state: "open",
        firstDetectedAtMillis: previous.data()?.firstDetectedAtMillis ?? now, lastDetectedAtMillis: now,
        acknowledgedAtMillis: previous.data()?.acknowledgedAtMillis ?? null,
        acknowledgedBy: previous.data()?.acknowledgedBy ?? null,
        acknowledgedReason: previous.data()?.acknowledgedReason ?? null, resolvedAtMillis: null });
    } else if (health.status === "healthy" && previous.exists && previous.data().state !== "resolved") {
      tx.update(ref, { state: "resolved", resolvedAtMillis: now, lastDetectedAtMillis: now,
        expiresAt: admin.firestore.Timestamp.fromMillis(now + 90 * 86400000) });
    }
  });
}
async function reconcileHotelMonitoring(db, hotelUid, now = Date.now()) {
  const data = await readHotelMonitoring(db, hotelUid, now);
  for (const monitor of data.monitors) {
    await reconcileIncident(db, hotelUid, monitor, monitor.health, now);
    // A late, successful source can resolve an earlier occurrence. Never close a
    // missing-data incident simply because today's schedule has moved forward.
    if (monitor.policy && monitor.health.occurrenceDate) {
      const past = new Set(data.observations.filter((run) => run.fileType === monitor.fileType && run.businessDate)
        .map((run) => require("./importMonitoringPolicy").shiftDate(run.businessDate, -monitor.policy.businessDateOffsetDays)));
      for (const date of [...past].slice(0, 14)) {
        if (date === monitor.health.occurrenceDate) continue;
        const health = evaluateMonitor(monitor.policy, data.observations, { now, active: data.subscriptionActive, occurrenceDate: date, historyTruncated: data.historyTruncated });
        if (health.status === "healthy") await reconcileIncident(db, hotelUid, monitor, health, now);
      }
    }
  }
  // Resolve retained occurrences against their original expectation. Editing a
  // monitor must never rewrite which source date an earlier incident required.
  const retained = await db.collection("platformIncidents").where("hotelUid", "==", hotelUid).limit(101).get();
  for (const row of retained.docs.slice(0, 100)) {
    const previous = row.data();
    if (previous.state !== "open" || !previous.monitorPolicy) continue;
    const health = evaluateMonitor(previous.monitorPolicy, data.observations, { now, active: data.subscriptionActive,
      occurrenceDate: previous.occurrenceDate, historyTruncated: data.historyTruncated });
    if (health.status === "healthy") await reconcileIncident(db, hotelUid, { id: previous.monitorId, policy: previous.monitorPolicy }, health, now);
  }
  const monitored = data.monitors.filter((monitor) => monitor.policy && monitor.sourceEnabled);
  const issueCount = monitored.filter((monitor) => ISSUES.has(monitor.health.status)).length;
  const status = !monitored.length ? "not-configured" : issueCount ? "attention"
    : data.configurationTruncated || data.monitors.some((monitor) => monitor.sourceEnabled && !monitor.policy) ? "unknown"
      : monitored.every((monitor) => ["inactive", "disabled", "paused"].includes(monitor.health.status)) ? "paused"
        : monitored.every((monitor) => monitor.health.status === "healthy") ? "healthy" : "awaiting";
  const summaryRef = db.doc(`hotels/${hotelUid}/platformHealth/imports`);
  await db.runTransaction(async (tx) => {
    const previous = await tx.get(summaryRef);
    if ((previous.data()?.computedAtMillis || 0) > now) return;
    tx.set(summaryRef, { schemaVersion: 1, computedAtMillis: now, status, monitoredCount: monitored.length, issueCount,
      historicalIncidentViewTruncated: retained.size > 100 });
  });
  return { hotelUid, status, monitoredCount: monitored.length, issueCount, computedAtMillis: now };
}
async function refreshPlatformMonitoringHandler(request, services = {}) {
  await requirePlatformAdministrator(request, services.auth);
  const hotelUid = requireDocumentId(request.data?.hotelUid, "hotelUid");
  const db = services.firestore || admin.firestore();
  await hotelExists(db, hotelUid);
  const now = services.now?.() ?? Date.now();
  const result = await reconcileHotelMonitoring(db, hotelUid, now);
  const configuration = await readPurchasingMonitoringConfiguration(db, { projectId: runtimePolicy().projectId });
  if (configuration.enabled) await reconcileHotelPurchasingMonitoring(db, hotelUid, configuration, now);
  return result;
}
async function getPlatformPurchasingMonitoringHandler(request, services = {}) {
  await requirePlatformAdministrator(request, services.auth);
  const hotelUid = requireDocumentId(request.data?.hotelUid, "hotelUid");
  const db = services.firestore || admin.firestore(), now = services.now?.() ?? Date.now();
  await hotelExists(db, hotelUid);
  const [monitoring, snapshot] = await Promise.all([purchasingMonitoringStatus(db, now), db.doc(`hotels/${hotelUid}/platformHealth/purchasing`).get()]);
  const data = snapshot.data();
  return { hotelUid, monitoring, health: data ? { status: !monitoring.enabled || !data.computedAtMillis
      || now - data.computedAtMillis > (monitoring.staleScanMinutes || 60) * 60000 ? "unknown" : data.status,
    computedAtMillis: data.computedAtMillis, environment: data.environment, issueCount: data.issueCount,
    coverage: data.coverage || [] } : null };
}
async function listPlatformIncidentsHandler(request, services = {}) {
  await requirePlatformAdministrator(request, services.auth);
  const db = services.firestore || admin.firestore();
  let query = db.collection("platformIncidents").orderBy("lastDetectedAtMillis", "desc");
  if (request.data?.afterId) {
    const ref = await db.doc(`platformIncidents/${requireDocumentId(request.data.afterId, "cursor")}`).get();
    if (!ref.exists) throw new HttpsError("invalid-argument", "Refresh the incident list before continuing.");
    query = query.startAfter(ref);
  }
  const result = await query.limit(51).get();
  return { monitoring: await purchasingMonitoringStatus(db, services.now?.() ?? Date.now()),
    incidents: result.docs.slice(0, 50).map((row) => ({ id: row.id, hotelUid: row.data().hotelUid, monitorId: row.data().monitorId,
    environment: row.data().environment || runtimePolicy().environment, process: row.data().process || "imports",
    severity: row.data().severity || "warning", summary: row.data().summary || "An expected import needs review.",
    nextStep: row.data().nextStep || "Inspect the expected business date and sanitized import run evidence before requesting recovery.",
    sourceId: row.data().sourceId || row.data().monitorId || null, correlationId: row.data().correlationId || null,
    evidenceAtMillis: row.data().evidenceAtMillis || null, episode: row.data().episode || 1, metadata: row.data().metadata || {},
    resolutionMode: row.data().resolutionMode || null,
    occurrenceDate: row.data().occurrenceDate, expectedBusinessDate: row.data().expectedBusinessDate, code: row.data().code,
    state: row.data().state, firstDetectedAtMillis: row.data().firstDetectedAtMillis, lastDetectedAtMillis: row.data().lastDetectedAtMillis,
    acknowledgedAtMillis: row.data().acknowledgedAtMillis, resolvedAtMillis: row.data().resolvedAtMillis ?? null })),
    nextCursor: result.size > 50 ? result.docs[49].id : null };
}
async function acknowledgePlatformIncidentHandler(request, services = {}) {
  await requirePlatformAdministrator(request, services.auth);
  const id = requireDocumentId(request.data?.incidentId, "incidentId");
  const reason = text(request.data?.reason, "Review note", 300, true);
  const db = services.firestore || admin.firestore();
  return db.runTransaction(async (tx) => {
    const ref = db.doc(`platformIncidents/${id}`), snapshot = await tx.get(ref);
    if (!snapshot.exists) throw new HttpsError("not-found", "Incident not found.");
    if (snapshot.data().acknowledgedAtMillis) return { acknowledged: true };
    tx.update(ref, { acknowledgedAtMillis: services.now?.() ?? Date.now(), acknowledgedBy: request.auth.uid, acknowledgedReason: reason });
    writePlatformAudit(tx, db, { key: `${id}:${snapshot.data().episode || 1}`, hotelUid: snapshot.data().hotelUid,
      actorUid: request.auth.uid, action: "incident-acknowledged", targetId: id });
    return { acknowledged: true };
  });
}
async function runPlatformMonitoringWorker(services = {}) {
  const db = services.firestore || admin.firestore(), now = services.now?.() ?? Date.now();
  const cursorRef = db.doc(WORKER_PATH), runId = db.collection("platformAudit").doc().id;
  const previous = await db.runTransaction(async (tx) => {
    const snapshot = await tx.get(cursorRef), value = snapshot.data() || {};
    if (value.leaseUntilMillis > now) return null;
    tx.set(cursorRef, { runId, leaseUntilMillis: now + 10 * 60000, lastAttemptAtMillis: now }, { merge: true });
    return value;
  });
  if (!previous) return { skipped: true, reason: "evaluation-already-running" };
  let configuration, failures = 0, checkedHotels = 0;
  const projectId = runtimePolicy().projectId;
  const log = (outcome) => logger[outcome === "success" ? "info" : "error"](
    outcome === "success" ? "Purchasing monitoring evaluation completed." : "Purchasing monitoring evaluation failed.",
    { event: "purchasing-monitoring-evaluation", projectId, environment: configuration?.environment || runtimePolicy().environment,
      outcome, checkedHotels, failedHotels: failures });
  try {
    configuration = services.configuration || await readPurchasingMonitoringConfiguration(db, { projectId });
    const limit = configuration.enabled ? configuration.maxHotelsPerRun : 25;
    let query = db.collection("hotels").orderBy(admin.firestore.FieldPath.documentId());
    if (previous.afterHotelUid) query = query.startAfter(previous.afterHotelUid);
    const hotels = await query.limit(limit + 1).get(), page = hotels.docs.slice(0, limit);
    for (const hotel of page) {
      let failed = false;
      try { await reconcileHotelMonitoring(db, hotel.id, now); }
      catch {
        failed = true;
        await db.doc(`hotels/${hotel.id}/platformHealth/imports`).set({ schemaVersion: 1, computedAtMillis: now,
          status: "unknown", monitoredCount: null, issueCount: null }).catch(() => {});
      }
      if (configuration.enabled) {
        try { if ((await reconcileHotelPurchasingMonitoring(db, hotel.id, configuration, now)).failed) failed = true; }
        catch {
          failed = true;
          await db.doc(`hotels/${hotel.id}/platformHealth/purchasing`).set({ schemaVersion: 1, computedAtMillis: now,
            environment: configuration.environment, status: "unknown", issueCount: null, coverage: [] }).catch(() => {});
        }
      }
      try { await cleanupHotelMonitoring(db, hotel.id, now); }
      catch { failed = true; }
      if (failed) {
        failures++;
        logger.error("Platform monitoring failed for hotel.", { hotelUid: hotel.id, code: "monitoring-hotel-failed" });
      }
      checkedHotels++;
    }
    // Retention touches only server-owned metadata, never source imports or mail.
    for (const name of ["platformAudit", "platformSupportSessions", "platformIncidents"]) {
      const expired = await db.collection(name).where(name === "platformSupportSessions" ? "retainUntil" : "expiresAt", "<", admin.firestore.Timestamp.fromMillis(now)).limit(100).get();
      if (!expired.empty) {
        const batch = db.batch();
        for (const row of expired.docs) {
          if (name === "platformIncidents" && row.data().state !== "resolved") continue;
          batch.delete(row.ref, { lastUpdateTime: row.updateTime });
          if (name === "platformAudit" && row.data().hotelUid) batch.delete(db.doc(`hotels/${row.data().hotelUid}/platformAudit/${row.id}`));
        }
        await batch.commit();
      }
    }
    await db.runTransaction(async (tx) => {
      const current = await tx.get(cursorRef);
      if (current.data()?.runId !== runId) throw new Error("Monitoring lease was superseded.");
      const continuing = Boolean(previous.afterHotelUid), complete = hotels.size <= limit;
      const cycleFailedHotels = (continuing ? previous.cycleFailedHotels || 0 : 0) + failures;
      const cycleCheckedHotels = (continuing ? previous.cycleCheckedHotels || 0 : 0) + checkedHotels;
      tx.set(cursorRef, { afterHotelUid: hotels.size > limit ? page.at(-1).id : null, checkedAtMillis: now,
        lastCompletedAtMillis: now, failedHotels: failures, leaseUntilMillis: 0,
        cycleStartedAtMillis: continuing ? previous.cycleStartedAtMillis || now : now, cycleFailedHotels, cycleCheckedHotels,
        ...(complete ? { lastCompletedCycleAtMillis: now, lastCycleFailedHotels: cycleFailedHotels,
          lastCycleCheckedHotels: cycleCheckedHotels } : {}),
        ...(configuration.enabled && complete && !cycleFailedHotels ? { lastSuccessfulCycleAtMillis: now } : {}),
        ...(configuration.enabled && !failures ? { lastSuccessfulAtMillis: now } : {}),
        ...(failures ? { lastFailureAtMillis: now } : {}) }, { merge: true });
    });
    if (configuration.enabled) log(failures ? "failure" : "success");
    return { checkedHotels, failedHotels: failures, purchasingEnabled: configuration.enabled };
  } catch {
    failures++;
    await db.runTransaction(async (tx) => {
      const current = await tx.get(cursorRef);
      if (current.data()?.runId === runId) tx.set(cursorRef, { lastFailureAtMillis: now, failedHotels: failures, leaseUntilMillis: 0 }, { merge: true });
    }).catch(() => {});
    log("failure");
    // A rejected scheduled invocation remains visible to Cloud Scheduler too.
    throw new Error("Purchasing monitoring evaluation failed; inspect sanitized evaluator logs.");
  }
}
async function cleanupHotelMonitoring(db, hotelUid, now) {
  for (const [name, field, cutoff] of [["importTelemetry", "updatedAtMillis", now - 90 * 86400000],
    ["importRecovery", "expiresAt", admin.firestore.Timestamp.fromMillis(now)],
    ["workflowTelemetry", "expiresAt", admin.firestore.Timestamp.fromMillis(now)],
    ["workflowTelemetryLimits", "expiresAt", admin.firestore.Timestamp.fromMillis(now)]]) {
    const expired = await db.collection(`hotels/${hotelUid}/${name}`).where(field, "<", cutoff).limit(100).get();
    if (expired.empty) continue;
    const batch = db.batch();
    expired.docs.forEach((row) => { if (name !== "importRecovery" || row.data().state !== "running") batch.delete(row.ref, { lastUpdateTime: row.updateTime }); });
    await batch.commit();
  }
}
const handlers = { savePlatformImportMonitorHandler, refreshPlatformMonitoringHandler, getPlatformPurchasingMonitoringHandler,
  listPlatformIncidentsHandler, acknowledgePlatformIncidentHandler };
module.exports = { ...handlers, reconcileHotelMonitoring, reconcilePurchasingIncident, reconcileHotelPurchasingMonitoring, runPlatformMonitoringWorker };
for (const [name, handler] of Object.entries(handlers)) module.exports[name.replace(/Handler$/, "")] = onCall({ region: "us-central1", cors: true }, handler);
// Internal observation performs no external delivery. Other scheduled workers
// retain the existing staging guard in config.js.
module.exports.checkPlatformImportHealth = onSchedule({ schedule: "every 15 minutes", region: "us-central1", timeoutSeconds: 540 }, () => {
  if (!["production", "staging"].includes(runtimePolicy().environment)) return { skipped: true, reason: "monitoring-environment-blocked" };
  return runPlatformMonitoringWorker();
});
