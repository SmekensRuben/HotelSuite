const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule, admin, logger } = require("./config");
const { requirePlatformAdministrator, requireDocumentId } = require("./subscriptions");
const { text, revision, digest } = require("./validation");
const { validateMonitor, evaluateMonitor } = require("./importMonitoringPolicy");
const { readHotelMonitoring, hotelExists } = require("./platformConsole");
const { writePlatformAudit } = require("./platformAudit");

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
  return reconcileHotelMonitoring(db, hotelUid, services.now?.() ?? Date.now());
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
  return { incidents: result.docs.slice(0, 50).map((row) => ({ id: row.id, hotelUid: row.data().hotelUid, monitorId: row.data().monitorId,
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
    writePlatformAudit(tx, db, { key: id, hotelUid: snapshot.data().hotelUid, actorUid: request.auth.uid, action: "incident-acknowledged", targetId: id });
    return { acknowledged: true };
  });
}
async function runPlatformMonitoringWorker(services = {}) {
  const db = services.firestore || admin.firestore(), now = services.now?.() ?? Date.now();
  const cursorRef = db.doc("platformConfiguration/importMonitoringWorker");
  const previous = await cursorRef.get();
  let query = db.collection("hotels").orderBy(admin.firestore.FieldPath.documentId());
  if (previous.data()?.afterHotelUid) query = query.startAfter(previous.data().afterHotelUid);
  const hotels = await query.limit(26).get();
  const page = hotels.docs.slice(0, 25);
  let failures = 0;
  for (const hotel of page) {
    try {
      await reconcileHotelMonitoring(db, hotel.id, now);
      const expired = await db.collection(`hotels/${hotel.id}/importTelemetry`).where("updatedAtMillis", "<", now - 90 * 86400000).limit(100).get();
      if (!expired.empty) {
        const batch = db.batch(); expired.docs.forEach((row) => batch.delete(row.ref)); await batch.commit();
      }
      const recoveries = await db.collection(`hotels/${hotel.id}/importRecovery`).where("expiresAt", "<", admin.firestore.Timestamp.fromMillis(now)).limit(100).get();
      if (!recoveries.empty) {
        const batch = db.batch(); recoveries.docs.forEach((row) => { if (row.data().state !== "running") batch.delete(row.ref); }); await batch.commit();
      }
    }
    catch {
      failures++;
      logger.error("Platform monitoring failed for hotel.", { hotelUid: hotel.id });
      await db.doc(`hotels/${hotel.id}/platformHealth/imports`).set({ schemaVersion: 1, computedAtMillis: now, status: "unknown", monitoredCount: null, issueCount: null });
    }
  }
  await cursorRef.set({ afterHotelUid: hotels.size > 25 ? page.at(-1).id : null, checkedAtMillis: now, failedHotels: failures });
  // Retention touches only server-owned platform metadata, never source imports.
  for (const name of ["platformAudit", "platformSupportSessions", "platformIncidents"]) {
    const expired = await db.collection(name).where(name === "platformSupportSessions" ? "retainUntil" : "expiresAt", "<", admin.firestore.Timestamp.fromMillis(now)).limit(100).get();
    if (!expired.empty) {
      const batch = db.batch();
      for (const row of expired.docs) {
        batch.delete(row.ref);
        if (name === "platformAudit" && row.data().hotelUid) batch.delete(db.doc(`hotels/${row.data().hotelUid}/platformAudit/${row.id}`));
      }
      await batch.commit();
    }
  }
  return { checkedHotels: page.length, failedHotels: failures };
}
const handlers = { savePlatformImportMonitorHandler, refreshPlatformMonitoringHandler, listPlatformIncidentsHandler, acknowledgePlatformIncidentHandler };
module.exports = { ...handlers, reconcileHotelMonitoring, runPlatformMonitoringWorker };
for (const [name, handler] of Object.entries(handlers)) module.exports[name.replace(/Handler$/, "")] = onCall({ region: "us-central1", cors: true }, handler);
module.exports.checkPlatformImportHealth = onSchedule({ schedule: "every 15 minutes", region: "us-central1", timeoutSeconds: 540 }, () => runPlatformMonitoringWorker());
