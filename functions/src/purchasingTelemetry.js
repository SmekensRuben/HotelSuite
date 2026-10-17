const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { admin } = require("./config");
const { requireHotelPermission } = require("./authorization");
const { requireDocumentId, requirePlatformAdministrator } = require("./subscriptions");
const { digest, text } = require("./validation");
const { writePlatformAudit } = require("./platformAudit");
const { requireSaasRollout } = require("./saasRollout");
const { runtimePolicy } = require("./environmentPolicy");
const { CONFIGURATION_PATH, validatePurchasingMonitoringConfiguration } = require("./purchasingMonitoringConfig");

const PROCESSES = Object.freeze({ "purchase-requests": "purchaserequests", orders: "orders", "stock-counts": "stockcounts",
  contracts: "contracts", "supplier-imports": "supplierproducts", "catalog-sync": "catalogproducts" });
const CODES = new Set(["internal", "unavailable", "deadline-exceeded", "unknown", "render-failed"]);
const EXPECTED_CODES = new Set(["cancelled", "invalid-argument", "not-found", "already-exists", "permission-denied", "resource-exhausted", "failed-precondition", "aborted", "out-of-range", "unauthenticated"]);
const RETENTION_DAYS = 7;
const MAX_REPORTS_PER_ACTOR_DAY = 60;

function unexpectedErrorCode(error) {
  const code = typeof error?.code === "string" ? error.code.replace(/^functions\//, "") : "unknown";
  if (EXPECTED_CODES.has(code)) return null;
  return CODES.has(code) && code !== "render-failed" ? code : "unknown";
}

async function recordPurchasingError(request, { hotelUid, process, code, origin }, services = {}) {
  const db = services.firestore || admin.firestore();
  const runtime = services.runtimePolicy || runtimePolicy();
  hotelUid = requireDocumentId(hotelUid, "hotelUid");
  if (!Object.hasOwn(PROCESSES, process) || !CODES.has(code) || !["frontend", "backend"].includes(origin)) {
    throw new HttpsError("invalid-argument", "Use an allowed purchasing workflow and error code.");
  }
  const now = services.now?.() ?? Date.now(), day = new Date(now).toISOString().slice(0, 10);
  return db.runTransaction(async (tx) => {
    await requireSaasRollout(db, tx);
    await requireHotelPermission(db, request, hotelUid, PROCESSES[process], "read", tx, services.auth);
    const marker = await tx.get(db.doc(CONFIGURATION_PATH));
    if (!marker.exists) return { hotelUid, accepted: false, reason: "monitoring-disabled" };
    let configuration;
    try { configuration = validatePurchasingMonitoringConfiguration(marker.data(), { projectId: runtime.projectId }); }
    catch { return { hotelUid, accepted: false, reason: "monitoring-disabled" }; }
    if (!configuration.enabled || configuration.environment !== runtime.environment) return { hotelUid, accepted: false, reason: "monitoring-disabled" };
    // Stable across days so repeated failures remain one incident until recovery.
    const aggregateId = digest(configuration.environment, process, origin, code);
    const ref = db.doc(`hotels/${hotelUid}/workflowTelemetry/${aggregateId}`);
    // The rate-limit key cannot expose the actor UID or become arbitrary input.
    const limitRef = db.doc(`hotels/${hotelUid}/workflowTelemetryLimits/${digest(request.auth.uid, day)}`);
    const [previous, limit] = await Promise.all([tx.get(ref), tx.get(limitRef)]);
    const count = limit.data()?.count || 0;
    const reviewed = previous.exists && Number.isSafeInteger(previous.data().reviewedThroughMillis)
      && previous.data().lastOccurredAtMillis <= previous.data().reviewedThroughMillis;
    if (count >= MAX_REPORTS_PER_ACTOR_DAY || (previous.exists && !reviewed && now - previous.data().lastOccurredAtMillis < 60000)) {
      return { hotelUid, accepted: false, reason: "rate-limited" };
    }
    const expiresAt = admin.firestore.Timestamp.fromMillis(now + RETENTION_DAYS * 86400000);
    tx.set(ref, { schemaVersion: 1, environment: configuration.environment, process, origin, code,
      count: Math.min(1000000, (previous.data()?.count || 0) + 1),
      firstOccurredAtMillis: previous.data()?.firstOccurredAtMillis ?? now, lastOccurredAtMillis: now,
      ...(Number.isSafeInteger(previous.data()?.reviewedThroughMillis) ? { reviewedThroughMillis: previous.data().reviewedThroughMillis,
        reviewedAtMillis: previous.data().reviewedAtMillis || null } : {}),
      correlationId: aggregateId, expiresAt });
    tx.set(limitRef, { count: count + 1, expiresAt });
    return { hotelUid, accepted: true };
  });
}

async function reportHotelPurchasingErrorHandler(request, services = {}) {
  const input = request.data;
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).sort().join(",") !== "code,hotelUid,process") {
    throw new HttpsError("invalid-argument", "Only hotelUid, process and code are accepted.");
  }
  return recordPurchasingError(request, { ...input, origin: "frontend" }, services);
}

async function resolvePlatformWorkflowIncidentHandler(request, services = {}) {
  await requirePlatformAdministrator(request, services.auth);
  const input = request.data;
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).sort().join(",") !== "expectedLastDetectedAtMillis,incidentId,reason") {
    throw new HttpsError("invalid-argument", "Only incidentId, expectedLastDetectedAtMillis and reason are accepted.");
  }
  const id = requireDocumentId(input.incidentId, "incidentId"), reason = text(input.reason, "Review outcome", 300, true);
  if (!Number.isSafeInteger(input.expectedLastDetectedAtMillis) || input.expectedLastDetectedAtMillis < 1) {
    throw new HttpsError("invalid-argument", "Refresh the incident before closing its reviewed workflow alert.");
  }
  const db = services.firestore || admin.firestore(), now = services.now?.() ?? Date.now();
  return db.runTransaction(async (tx) => {
    const ref = db.doc(`platformIncidents/${id}`), snapshot = await tx.get(ref);
    if (!snapshot.exists) throw new HttpsError("not-found", "This workflow alert no longer exists.");
    const incident = snapshot.data();
    if (incident.process !== "workflow" || incident.code !== "unexpected-workflow-error") {
      throw new HttpsError("failed-precondition", "Only unexpected workflow alerts can be closed after explicit operator review.");
    }
    if (incident.lastDetectedAtMillis !== input.expectedLastDetectedAtMillis) throw new HttpsError("aborted", "The alert changed. Refresh and review the latest evidence before closing it.");
    const hotelUid = requireDocumentId(incident.hotelUid, "hotelUid"), sourceId = requireDocumentId(incident.sourceId, "sourceId");
    const sourceRef = db.doc(`hotels/${hotelUid}/workflowTelemetry/${sourceId}`), source = await tx.get(sourceRef);
    const evidence = source.data();
    if (source.exists && (!Number.isSafeInteger(evidence.lastOccurredAtMillis)
      || !Number.isSafeInteger(incident.evidenceAtMillis) || evidence.lastOccurredAtMillis > incident.evidenceAtMillis)) {
      throw new HttpsError("aborted", "New workflow evidence is available. Refresh and review it before closing this alert.");
    }
    if (incident.state === "resolved") return { resolved: true, resolutionMode: "operator-review" };
    if (incident.state !== "open") throw new HttpsError("failed-precondition", "This workflow alert is not open for review.");
    tx.update(ref, { state: "resolved", status: "reviewed", resolutionMode: "operator-review", resolutionReason: reason,
      resolvedBy: request.auth.uid, resolvedAtMillis: now, expiresAt: admin.firestore.Timestamp.fromMillis(now + 90 * 86400000) });
    if (source.exists) tx.update(sourceRef, { reviewedThroughMillis: evidence.lastOccurredAtMillis, reviewedAtMillis: now });
    writePlatformAudit(tx, db, { key: `${id}:${incident.episode || 1}`, hotelUid, actorUid: request.auth.uid,
      action: "workflow-alert-reviewed", targetId: id, revision: incident.episode || 1 });
    return { resolved: true, resolutionMode: "operator-review" };
  });
}

function withPurchasingTelemetry(handler, process) {
  if (!Object.hasOwn(PROCESSES, process)) throw new Error("Unknown purchasing telemetry workflow.");
  return async (request, services = {}) => {
    try { return await handler(request, services); }
    catch (error) {
      const code = unexpectedErrorCode(error);
      if (code) {
        try { await recordPurchasingError(request, { hotelUid: request.data?.hotelUid, process, code, origin: "backend" }, services); }
        catch { /* Preserve the original business outcome and error. Never retry it. */ }
      }
      throw error;
    }
  };
}

module.exports = { PROCESSES, CODES, RETENTION_DAYS, MAX_REPORTS_PER_ACTOR_DAY, unexpectedErrorCode,
  recordPurchasingError, withPurchasingTelemetry, reportHotelPurchasingErrorHandler,
  resolvePlatformWorkflowIncidentHandler,
  resolvePlatformWorkflowIncident: onCall({ region: "us-central1", cors: true }, resolvePlatformWorkflowIncidentHandler),
  reportHotelPurchasingError: onCall({ region: "us-central1", cors: true, maxInstances: 3, concurrency: 8, timeoutSeconds: 30 }, reportHotelPurchasingErrorHandler) };
