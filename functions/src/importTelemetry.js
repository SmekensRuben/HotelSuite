const { onDocumentWritten, admin, logger } = require("./config");
const { runView, validDate } = require("./importMonitoringPolicy");

async function recordImportReceived(db, hotelUid, runId, object) {
  const ref = db.doc(`hotels/${hotelUid}/importTelemetry/${runId}`);
  const received = Date.parse(object.timeCreated || "");
  await db.runTransaction(async (tx) => {
    const previous = await tx.get(ref);
    if (previous.exists) return;
    tx.create(ref, { schemaVersion: 1, runId, fileType: String(object.metadata.fileType).slice(0, 128), status: "received",
      receivedAtMillis: Number.isFinite(received) && received > 0 ? received : null, firstObservedAtMillis: Date.now(),
      businessDate: validDate(object.metadata.targetDateOverride) ? object.metadata.targetDateOverride : null,
      updatedAtMillis: Date.now(), completedAtMillis: null, writtenCount: null, leaseUntilMillis: null,
      errorCode: null, retryable: false, legacyTelemetry: false, downstreamStatus: null });
  });
}
async function syncImportTelemetry(db, hotelUid, runId) {
  const source = db.doc(`hotels/${hotelUid}/importRuns/${runId}`);
  const target = db.doc(`hotels/${hotelUid}/importTelemetry/${runId}`);
  await db.runTransaction(async (tx) => {
    const [run, previous] = await Promise.all([tx.get(source), tx.get(target)]);
    if (!run.exists) return;
    const descriptor = run.data().descriptor;
    if (!descriptor || descriptor.hotelUid !== hotelUid || typeof descriptor.name !== "string"
      || !descriptor.name.startsWith(`imports/${hotelUid}/`)) throw new Error("Import telemetry ownership mismatch.");
    tx.set(target, runView(runId, run.data(), previous.data() || {}));
  });
}
async function recordPreflightImportFailure(db, hotelUid, runId) {
  const ref = db.doc(`hotels/${hotelUid}/importTelemetry/${runId}`);
  await db.runTransaction(async (tx) => {
    const run = await tx.get(db.doc(`hotels/${hotelUid}/importRuns/${runId}`));
    const telemetry = await tx.get(ref);
    if (!run.exists && telemetry.exists) tx.update(ref, { status: "failed", errorCode: "import-preflight-failed", updatedAtMillis: Date.now() });
  });
}
const syncPlatformImportTelemetry = onDocumentWritten({ document: "hotels/{hotelUid}/importRuns/{runId}", region: "us-central1" }, async (event) => {
  try { await syncImportTelemetry(admin.firestore(), event.params.hotelUid, event.params.runId); }
  catch { logger.error("Import telemetry synchronization failed.", { hotelUid: event.params.hotelUid, runId: event.params.runId }); throw new Error("import-telemetry-failed"); }
});
module.exports = { recordImportReceived, recordPreflightImportFailure, syncImportTelemetry, syncPlatformImportTelemetry };
