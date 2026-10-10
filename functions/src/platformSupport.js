const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { admin } = require("./config");
const { requirePlatformAdministrator, requireDocumentId, requireHotelSubscription } = require("./subscriptions");
const { text, digest } = require("./validation");
const { requireSaasRollout } = require("./saasRollout");
const { getPlatformHotelHandler, readHotelMonitoring } = require("./platformConsole");
const { writePlatformAudit } = require("./platformAudit");
const { importRunId } = require("./importProcessing");

async function startPlatformSupportHandler(request, services = {}) {
  await requirePlatformAdministrator(request, services.auth);
  const hotelUid = requireDocumentId(request.data?.hotelUid, "hotelUid");
  const requestId = requireDocumentId(request.data?.requestId, "requestId");
  const reason = text(request.data?.reason, "Support reason", 300, true);
  const db = services.firestore || admin.firestore();
  const id = digest(request.auth.uid, requestId), now = services.now?.() ?? Date.now();
  const ref = db.doc(`platformSupportSessions/${id}`);
  return db.runTransaction(async (tx) => {
    const [hotel, session] = await Promise.all([tx.get(db.doc(`hotels/${hotelUid}`)), tx.get(ref)]);
    if (!hotel.exists) throw new HttpsError("not-found", "Hotel not found.");
    if (session.exists) {
      if (session.data().hotelUid !== hotelUid || session.data().reason !== reason) throw new HttpsError("already-exists", "This support request was used with different details.");
      return { sessionId: id, hotelUid, expiresAtMillis: session.data().expiresAt.toMillis() };
    }
    const expiresAt = admin.firestore.Timestamp.fromMillis(now + 30 * 60000);
    tx.create(ref, { schemaVersion: 1, actorUid: request.auth.uid, hotelUid, reason, state: "active", startedAtMillis: now,
      expiresAt, retainUntil: admin.firestore.Timestamp.fromMillis(now + 90 * 86400000) });
    writePlatformAudit(tx, db, { key: id, hotelUid, actorUid: request.auth.uid, action: "support-started", targetId: id });
    return { sessionId: id, hotelUid, expiresAtMillis: expiresAt.toMillis() };
  });
}
async function requireSupportSession(request, services) {
  await requirePlatformAdministrator(request, services.auth);
  const db = services.firestore || admin.firestore();
  const id = requireDocumentId(request.data?.sessionId, "sessionId");
  const hotelUid = requireDocumentId(request.data?.hotelUid, "hotelUid");
  const session = await db.doc(`platformSupportSessions/${id}`).get();
  if (!session.exists || session.data().actorUid !== request.auth.uid || session.data().hotelUid !== hotelUid
    || session.data().state !== "active" || !(session.data().expiresAt?.toMillis?.() > (services.now?.() ?? Date.now()))) {
    throw new HttpsError("permission-denied", "This read-only support session has ended or does not belong to you and this hotel.");
  }
  return { db, session, hotelUid };
}
async function getPlatformSupportHandler(request, services = {}) {
  const { db, session, hotelUid } = await requireSupportSession(request, services);
  const [hotel, monitoring, mail, deliveries] = await Promise.all([
    getPlatformHotelHandler({ ...request, data: { hotelUid } }, services), readHotelMonitoring(db, hotelUid, services.now?.() ?? Date.now()),
    db.collection(`hotels/${hotelUid}/mailQueue`).limit(51).get(), db.collection(`hotels/${hotelUid}/scheduledMailReceipts`).limit(51).get(),
  ]);
  const counts = (records) => ({ inspected: Math.min(records.size, 50), truncated: records.size > 50,
    statuses: records.docs.slice(0, 50).reduce((result, record) => {
      const status = ["queued", "processing", "sent", "failed", "blocked", "needs-review"].includes(record.data().status) ? record.data().status : "unknown";
      result[status] = (result[status] || 0) + 1; return result;
    }, {}) });
  return { hotelUid, hotel, monitoring, mail: counts(mail), scheduledDeliveries: counts(deliveries),
    session: { id: session.id, reason: session.data().reason, expiresAtMillis: session.data().expiresAt.toMillis(), readOnly: true } };
}
async function endPlatformSupportHandler(request, services = {}) {
  await requirePlatformAdministrator(request, services.auth);
  const db = services.firestore || admin.firestore();
  const id = requireDocumentId(request.data?.sessionId, "sessionId");
  return db.runTransaction(async (tx) => {
    const ref = db.doc(`platformSupportSessions/${id}`), session = await tx.get(ref);
    if (!session.exists || session.data().actorUid !== request.auth.uid) throw new HttpsError("permission-denied", "This support session does not belong to you.");
    if (session.data().state === "ended") return { ended: true };
    tx.update(ref, { state: "ended", endedAtMillis: services.now?.() ?? Date.now() });
    writePlatformAudit(tx, db, { key: id, hotelUid: session.data().hotelUid, actorUid: request.auth.uid, action: "support-ended", targetId: id });
    return { ended: true };
  });
}
async function retryPlatformImportHandler(request, services = {}) {
  await requirePlatformAdministrator(request, services.auth);
  const input = request.data || {};
  const hotelUid = requireDocumentId(input.hotelUid, "hotelUid"), runId = requireDocumentId(input.runId, "runId");
  const requestId = requireDocumentId(input.requestId, "requestId"), reason = text(input.reason, "Recovery reason", 300, true);
  const db = services.firestore || admin.firestore();
  const source = db.doc(`hotels/${hotelUid}/importRuns/${runId}`);
  const key = digest(request.auth.uid, requestId), ref = db.doc(`hotels/${hotelUid}/importRecovery/${key}`);
  const now = services.now?.() ?? Date.now();
  const descriptor = await db.runTransaction(async (tx) => {
    await requireSaasRollout(db, tx);
    await requireHotelSubscription(db, hotelUid, tx);
    const [run, operation] = await Promise.all([tx.get(source), tx.get(ref)]);
    if (operation.exists) {
      if (operation.data().runId !== runId || operation.data().reason !== reason) throw new HttpsError("already-exists", "This recovery request was used with different details.");
      return null;
    }
    if (!run.exists) throw new HttpsError("not-found", "Import run not found.");
    const data = run.data(), pointer = data.descriptor;
    if (data.state === "complete" || data.leaseUntil > now || !["failed", "processing"].includes(data.state)) throw new HttpsError("failed-precondition", "Only failed or stalled imports can be resumed. Completed imports keep their checkpoints.");
    if (!pointer || typeof pointer.bucket !== "string" || typeof pointer.name !== "string" || typeof pointer.generation !== "string" || !pointer.generation
      || pointer.hotelUid !== hotelUid || !pointer.name.startsWith(`imports/${hotelUid}/`)
      || importRunId(pointer) !== runId || pointer.bucket !== (services.bucketName || admin.storage().bucket().name)) throw new HttpsError("failed-precondition", "Review the pinned source identity before recovery.");
    tx.create(ref, { schemaVersion: 1, runId, actorUid: request.auth.uid, reason, state: "running", startedAtMillis: now });
    writePlatformAudit(tx, db, { key, hotelUid, actorUid: request.auth.uid, action: "import-recovery-requested", targetId: runId });
    return pointer;
  });
  if (descriptor) {
    try {
      const load = services.loadSource || (async (pointer) => {
        const [metadata] = await admin.storage().bucket(pointer.bucket).file(pointer.name, { generation: pointer.generation }).getMetadata();
        return metadata;
      });
      const object = await load(descriptor);
      if (object.bucket !== descriptor.bucket || object.name !== descriptor.name || String(object.generation) !== descriptor.generation
        || object.metadata?.hotelUid !== hotelUid || object.metadata?.fileType !== descriptor.fileType) throw new Error("Pinned source no longer matches.");
      // Recheck live authority after storage I/O with a fresh request-scoped cache.
      await requirePlatformAdministrator({ auth: request.auth }, services.auth);
      const execute = services.executeImport || (async (object) => require("./fileImportTypes").processImportedFileToFirestore.run({ data: object }));
      await execute(object);
      const completed = await source.get();
      if (completed.data()?.state !== "complete") throw new Error("Import recovery did not complete.");
      await ref.update({ state: "complete", completedAtMillis: services.now?.() ?? Date.now(),
        expiresAt: admin.firestore.Timestamp.fromMillis((services.now?.() ?? Date.now()) + 90 * 86400000) });
    } catch {
      await ref.update({ state: "failed", completedAtMillis: services.now?.() ?? Date.now(), errorCode: "import-recovery-incomplete",
        expiresAt: admin.firestore.Timestamp.fromMillis((services.now?.() ?? Date.now()) + 90 * 86400000) });
    }
  }
  const operation = await ref.get();
  return { hotelUid, recoveryId: key, runId, state: operation.data().state, errorCode: operation.data().errorCode ?? null };
}

const handlers = { startPlatformSupportHandler, getPlatformSupportHandler, endPlatformSupportHandler, retryPlatformImportHandler };
module.exports = { ...handlers, requireSupportSession };
for (const [name, handler] of Object.entries(handlers)) module.exports[name.replace(/Handler$/, "")] = onCall({ region: "us-central1", cors: true,
  timeoutSeconds: name === "retryPlatformImportHandler" ? 540 : 60, memory: name === "retryPlatformImportHandler" ? "1GiB" : "256MiB" }, handler);
