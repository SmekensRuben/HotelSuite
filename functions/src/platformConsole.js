const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { admin } = require("./config");
const { requirePlatformAdministrator, requireDocumentId, subscriptionOverview, subscriptionIsActive } = require("./subscriptions");
const { text, email, revision } = require("./validation");
const { writePlatformAudit } = require("./platformAudit");
const { modulesAreValid } = require("./modulePolicy");
const { runView, evaluateMonitor } = require("./importMonitoringPolicy");

const stamp = () => admin.firestore.FieldValue.serverTimestamp();
const millis = (value) => value?.toMillis?.() ?? null;
const pageAfter = (value) => value == null ? null : requireDocumentId(value, "cursor");
async function hotelExists(db, hotelUid) {
  const hotel = await db.doc(`hotels/${hotelUid}`).get();
  if (!hotel.exists) throw new HttpsError("not-found", "Hotel not found.");
  return hotel;
}
function safePolicy(id, data) {
  const keys = ["label", "fileType", "timeZone", "expectedBy", "graceMinutes", "weekdays", "businessDateOffsetDays", "startsOn", "paused", "enabled", "acceptEmpty", "revision"];
  return { id, ...Object.fromEntries(keys.map((key) => [key, data[key] ?? null])) };
}
async function readHotelMonitoring(db, hotelUid, now = Date.now()) {
  const [types, policies, runs, telemetry, subscription, recovery] = await Promise.all([
    db.collection(`hotels/${hotelUid}/fileImportTypes`).limit(101).get(),
    db.collection(`hotels/${hotelUid}/importMonitors`).limit(101).get(),
    db.collection(`hotels/${hotelUid}/importRuns`).orderBy("updatedAt", "desc").limit(101).get(),
    db.collection(`hotels/${hotelUid}/importTelemetry`).orderBy("updatedAtMillis", "desc").limit(101).get(),
    db.doc(`hotelSubscriptions/${hotelUid}`).get(),
    db.collection(`hotels/${hotelUid}/importRecovery`).orderBy("startedAtMillis", "desc").limit(21).get(),
  ]);
  const projected = new Map(telemetry.docs.slice(0, 100).map((row) => [row.id, row.data()]));
  for (const row of runs.docs.slice(0, 100)) {
    const run = row.data();
    if (run.descriptor?.hotelUid !== hotelUid || !String(run.descriptor?.name || "").startsWith(`imports/${hotelUid}/`)) continue;
    projected.set(row.id, runView(row.id, run, projected.get(row.id)));
  }
  const observations = [...projected.values()].map((data) => ({
    runId: data.runId, fileType: data.fileType, status: data.status, businessDate: data.businessDate ?? null,
    receivedAtMillis: data.receivedAtMillis ?? null, updatedAtMillis: data.updatedAtMillis ?? null,
    completedAtMillis: data.completedAtMillis ?? null, leaseUntilMillis: data.leaseUntilMillis ?? null,
    writtenCount: data.writtenCount ?? null, errorCode: data.errorCode ?? null,
    downstreamStatus: data.downstreamStatus ?? null, retryable: data.retryable === true,
    legacyTelemetry: data.legacyTelemetry === true,
  })).sort((a, b) => (b.updatedAtMillis || 0) - (a.updatedAtMillis || 0)).slice(0, 100);
  const active = subscriptionIsActive(subscription.data(), now) && modulesAreValid(subscription.data());
  const map = new Map(policies.docs.slice(0, 100).map((policy) => [policy.id, policy.data()]));
  const historyTruncated = runs.size > 100 || telemetry.size > 100 || projected.size > 100;
  const monitors = types.docs.slice(0, 100).map((type) => {
    const data = type.data();
    const policy = map.get(type.id);
    return { id: type.id, label: String(data.name || data.fileType || type.id).slice(0, 120),
      fileType: String(data.fileType || "").slice(0, 128), sourceEnabled: data.enabled !== false,
      policy: policy ? safePolicy(type.id, policy) : null,
      health: evaluateMonitor(policy && data.enabled === false ? { ...policy, enabled: false } : policy, observations, { now, active, historyTruncated }) };
  });
  return { monitors, observations, historyTruncated, configurationTruncated: types.size > 100 || policies.size > 100,
    recoveries: recovery.docs.slice(0, 20).map((row) => ({ id: row.id, runId: row.data().runId,
      state: row.data().state, startedAtMillis: row.data().startedAtMillis, completedAtMillis: row.data().completedAtMillis ?? null,
      errorCode: row.data().errorCode ?? null })), recoveryHistoryTruncated: recovery.size > 20,
    computedAtMillis: now, subscriptionActive: active };
}
async function listPlatformHotelsHandler(request, services = {}) {
  await requirePlatformAdministrator(request, services.auth);
  const db = services.firestore || admin.firestore();
  const after = pageAfter(request.data?.afterHotelUid);
  let query = db.collection("hotels").orderBy(admin.firestore.FieldPath.documentId());
  if (after) query = query.startAfter(after);
  const result = await query.limit(26).get();
  const page = result.docs.slice(0, 25);
  const rows = await Promise.all(page.map(async (hotel) => {
    const [subscription, health] = await db.getAll(db.doc(`hotelSubscriptions/${hotel.id}`), db.doc(`hotels/${hotel.id}/platformHealth/imports`));
    const summary = health.data();
    const age = Date.now() - (summary?.computedAtMillis || 0);
    return { hotelUid: hotel.id, name: String(hotel.data().hotelName || hotel.data().name || hotel.id).slice(0, 200),
      subscription: subscription.exists ? subscriptionOverview(subscription.data()) : null,
      health: summary && age >= 0 && age <= 3600000 ? { status: summary.status, monitoredCount: summary.monitoredCount,
        issueCount: summary.issueCount, computedAtMillis: summary.computedAtMillis } : null };
  }));
  return { hotels: rows, nextCursor: result.size > 25 ? page.at(-1).id : null };
}
async function getPlatformHotelHandler(request, services = {}) {
  await requirePlatformAdministrator(request, services.auth);
  const db = services.firestore || admin.firestore();
  const hotelUid = requireDocumentId(request.data?.hotelUid, "hotelUid");
  const hotel = await hotelExists(db, hotelUid);
  const [subscription, members, administrators] = await Promise.all([
    db.doc(`hotelSubscriptions/${hotelUid}`).get(),
    db.collection(`hotels/${hotelUid}/members`).count().get(),
    db.collection(`hotels/${hotelUid}/members`).where("hotelAdmin", "==", true).limit(21).get(),
  ]);
  const data = hotel.data();
  return { hotelUid, name: String(data.hotelName || data.name || hotelUid).slice(0, 200),
    revision: data.platformRevision ?? 0, timeZone: data.platformDetails?.timeZone ?? null,
    contactName: String(data.platformDetails?.contactName || "").slice(0, 120), contactEmail: String(data.platformDetails?.contactEmail || "").slice(0, 254),
    subscription: subscription.exists ? subscriptionOverview(subscription.data()) : null,
    memberCount: members.data().count, administrators: administrators.docs.slice(0, 20).map((member) => ({ uid: member.id,
      name: [member.data().firstName, member.data().lastName].filter((value) => typeof value === "string").join(" ").slice(0, 160),
      email: String(member.data().email || "").slice(0, 254) })), administratorsTruncated: administrators.size > 20 };
}
async function updatePlatformHotelHandler(request, services = {}) {
  await requirePlatformAdministrator(request, services.auth);
  const input = request.data || {};
  const hotelUid = requireDocumentId(input.hotelUid, "hotelUid");
  const expected = revision(input.expectedRevision);
  const name = text(input.name, "Hotel name", 200, true);
  const contactName = text(input.contactName || "", "Contact name", 120);
  const contactEmail = input.contactEmail ? email(input.contactEmail) : "";
  const timeZone = text(input.timeZone, "Time zone", 80, true);
  try { new Intl.DateTimeFormat("en", { timeZone }).format(new Date()); }
  catch { throw new HttpsError("invalid-argument", "Choose a valid IANA time zone."); }
  const db = services.firestore || admin.firestore();
  const ref = db.doc(`hotels/${hotelUid}`), key = db.collection("platformAudit").doc().id;
  return db.runTransaction(async (tx) => {
    const hotel = await tx.get(ref);
    if (!hotel.exists) throw new HttpsError("not-found", "Hotel not found.");
    if ((hotel.data().platformRevision || 0) !== expected) throw new HttpsError("aborted", "Hotel details changed. Reload before saving.");
    tx.update(ref, { name, hotelName: name, platformDetails: { timeZone, contactName, contactEmail }, platformRevision: expected + 1, platformUpdatedAt: stamp() });
    writePlatformAudit(tx, db, { key, hotelUid, actorUid: request.auth.uid, action: "hotel-details-updated", revision: expected + 1 });
    return { hotelUid, revision: expected + 1 };
  });
}
async function getPlatformMonitoringHandler(request, services = {}) {
  await requirePlatformAdministrator(request, services.auth);
  const db = services.firestore || admin.firestore();
  const hotelUid = requireDocumentId(request.data?.hotelUid, "hotelUid");
  await hotelExists(db, hotelUid);
  return { hotelUid, ...await readHotelMonitoring(db, hotelUid, services.now?.() ?? Date.now()) };
}
async function listPlatformAuditHandler(request, services = {}) {
  await requirePlatformAdministrator(request, services.auth);
  const db = services.firestore || admin.firestore();
  const after = pageAfter(request.data?.afterId);
  const hotelUid = request.data?.hotelUid ? requireDocumentId(request.data.hotelUid, "hotelUid") : null;
  const collection = db.collection(hotelUid ? `hotels/${hotelUid}/platformAudit` : "platformAudit");
  let query = collection.orderBy("createdAt", "desc");
  if (after) {
    const snapshot = await collection.doc(after).get();
    if (!snapshot.exists) throw new HttpsError("invalid-argument", "This audit cursor no longer exists. Refresh the list.");
    query = query.startAfter(snapshot);
  }
  const result = await query.limit(51).get();
  return { hotelUid, events: result.docs.slice(0, 50).map((row) => ({ id: row.id, hotelUid: row.data().hotelUid, actorUid: row.data().actorUid,
    action: row.data().action, targetId: row.data().targetId ?? null, revision: row.data().revision ?? null, createdAtMillis: millis(row.data().createdAt) })),
    nextCursor: result.size > 50 ? result.docs[49].id : null };
}

const handlers = { listPlatformHotelsHandler, getPlatformHotelHandler, updatePlatformHotelHandler, getPlatformMonitoringHandler, listPlatformAuditHandler };
module.exports = { ...handlers, readHotelMonitoring, hotelExists };
for (const [name, handler] of Object.entries(handlers)) module.exports[name.replace(/Handler$/, "")] = onCall({ region: "us-central1", cors: true }, handler);
