const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { HttpsError, onCall } = require("firebase-functions/v2/https");
const { requireHotelPermission } = require("./authorization");
const logger = require("firebase-functions/logger");

const { MODEL_VERSION, DATE_RE, DEFAULTS, isoDate, classifyRateCode, normalizeStatus, normalizeReservation, buildYear, combineMetrics } = require("./stayPatternPreparation.mjs");
const RAW_REPORT_PATH = "staydatepattern";
const HISTORY_REPORT_PATH = "historyquotes";
const MODEL_REPORT_PATH = "stayPatternModel";
const PUBLICATION_VERSION = "stay-pattern-publication-v2";

function reservationArray(data) {
  for (const key of ["reservations", "reservationDetails", "records", "rows", "data", "items"]) if (Array.isArray(data?.[key])) return data[key];
  return data && typeof data === "object" && (data.reservationNameId || data.RESV_NAME_ID || data.arrivalDate || data.ARRIVAL_DATE) ? [data] : [];
}
async function mapLimit(items, concurrency, mapper) { const output = new Array(items.length); let cursor = 0; await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => { while (cursor < items.length) { const index = cursor; cursor += 1; output[index] = await mapper(items[index], index); } })); return output; }

async function recordsBelowDateDocument(dateDocument) {
  const direct = reservationArray(dateDocument.data() || {});
  const childCollections = await dateDocument.ref.listCollections();
  const nested = await Promise.all(childCollections.map(async (collection) => (await collection.get()).docs.flatMap((doc) => reservationArray(doc.data() || {}))));
  return [...direct, ...nested.flat()];
}

async function readRawReservations(db, hotelUid) {
  const report = db.doc(`hotels/${hotelUid}/reports/${RAW_REPORT_PATH}`);
  const rootCollections = await report.listCollections();
  const groupedCollections = rootCollections.filter((collection) => !DATE_RE.test(collection.id));
  const groupedDocuments = await mapLimit(groupedCollections, 10, async (collection) => (await collection.get()).docs);
  const fromGroupedDocuments = await mapLimit(groupedDocuments.flat(), 25, recordsBelowDateDocument);
  const dateCollections = rootCollections.filter((collection) => DATE_RE.test(collection.id));
  const fromDateCollections = await mapLimit(dateCollections, 25, async (collection) => (await collection.get()).docs.flatMap((doc) => reservationArray(doc.data() || {})));
  const records = [...fromGroupedDocuments.flat(), ...fromDateCollections.flat()];
  const seen = new Set();
  return records.filter((record) => { const reservationId = String(record.reservationNameId ?? record.RESV_NAME_ID ?? "").trim(); if (reservationId && seen.has(reservationId)) return false; if (reservationId) seen.add(reservationId); return true; });
}

async function readHistoryByYear(db, hotelUid, years) {
  const snapshot = await db.collection(`hotels/${hotelUid}/reports/${HISTORY_REPORT_PATH}/consideredDates`).get();
  const selected = years?.length ? new Set(years.map(Number)) : null;
  return Object.fromEntries(snapshot.docs.filter((doc) => DATE_RE.test(doc.id) && (!selected || selected.has(Number(doc.id.slice(0, 4))))).map((doc) => [doc.id, doc.data() || {}]));
}

function availableYears(reservations) { return [...new Set(reservations.map((row) => Number(isoDate(row.arrivalDate ?? row.ARRIVAL_DATE)?.slice(0, 4))).filter((year) => Number.isInteger(year) && year > 1900))].sort(); }
async function publishBuild(db, hotelUid, runId, annualResults, metadata) {
  const modelRef = db.doc(`hotels/${hotelUid}/reports/${MODEL_REPORT_PATH}`);
  await db.runTransaction(async (transaction) => {
    const current = await transaction.get(modelRef);
    if (current.data()?.buildRunId !== runId) throw new Error("Stay Pattern build was superseded by a newer run.");
    const currentRevision = current.data()?.sourceRevision;
    if ((currentRevision === undefined ? 0 : currentRevision) !== metadata.publishedSourceRevision) throw new Error("Stay Pattern sources changed during the build.");
    const stagedResults = await Promise.all(annualResults.map((result) => transaction.get(modelRef.collection("builds").doc(runId).collection("years").doc(String(result.year)))));
    annualResults.forEach((result, index) => {
      const staged = stagedResults[index]; if (!staged.exists) throw new Error(`Missing staged year ${result.year}`);
      transaction.set(modelRef.collection("years").doc(String(result.year)), { ...staged.data(), builtAt: FieldValue.serverTimestamp(), buildRunId: runId });
    });
    transaction.set(modelRef.collection("builds").doc(runId), { status: "COMPLETED", completedAt: FieldValue.serverTimestamp(), affectedYears: annualResults.map((result) => result.year) }, { merge: true });
    transaction.set(modelRef, { ...metadata, builtAt: FieldValue.serverTimestamp() }, { merge: true });
  });
}

async function rebuildStayPatternModel({ hotelUid, years = null, trigger = "MANUAL", db = getFirestore() }) {
  const attemptStartedAt = Date.now();
  const modelRef = db.doc(`hotels/${hotelUid}/reports/${MODEL_REPORT_PATH}`), runId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  let affectedYears = years?.length ? [...new Set(years.map(Number))].sort() : [], started = false;
  try {
    const prior = await modelRef.get();
    const sourceRevision = prior.data()?.sourceRevision === undefined ? 0 : prior.data().sourceRevision;
    if (!Number.isSafeInteger(sourceRevision) || sourceRevision < 0) throw new Error("Stay Pattern source revision is unavailable.");
    await modelRef.set({ modelVersion: MODEL_VERSION, publicationVersion: PUBLICATION_VERSION, status: "BUILDING", buildRunId: runId, buildSourceRevision: sourceRevision, buildStartedAt: FieldValue.serverTimestamp(), affectedYears, trigger, previousStatus: prior.data()?.status || null }, { merge: true });
    started = true;
    await modelRef.collection("builds").doc(runId).set({ status: "BUILDING", sourceRevision, startedAt: FieldValue.serverTimestamp(), requestedYears: years || [], trigger });
    const [reservations, allHistory, published] = await Promise.all([readRawReservations(db, hotelUid), readHistoryByYear(db, hotelUid, null), modelRef.collection("years").get()]);
    const sourceChanged = prior.data()?.publishedSourceRevision !== sourceRevision;
    const allYears = [...new Set([...availableYears(reservations), ...Object.keys(allHistory).map((stayDate) => Number(stayDate.slice(0, 4))), ...published.docs.map((doc) => Number(doc.id))])].filter((year) => Number.isInteger(year)).sort();
    affectedYears = years?.length && !sourceChanged ? [...new Set(years.map(Number))].filter((year) => allYears.includes(year)).sort() : allYears;
    if (!affectedYears.length) throw new Error("No staydatepattern reservation years were found to build.");
    const annualResults = affectedYears.map((year) => buildYear(year, reservations, allHistory));
    const writer = db.bulkWriter(); annualResults.forEach((result) => writer.set(modelRef.collection("builds").doc(runId).collection("years").doc(String(result.year)), result)); await writer.close();
    const replacements = new Map(annualResults.map((result) => [result.year, result]));
    const completeResults = [...published.docs.map((doc) => replacements.get(Number(doc.id)) || doc.data()), ...annualResults.filter((result) => !published.docs.some((doc) => Number(doc.id) === result.year))].sort((a, b) => a.year - b.year);
    const allValid = completeResults.every((result) => result.status === "VALID"), sourceThroughDate = completeResults.map((result) => result.sourceThroughDate).filter(Boolean).sort().at(-1) || null;
    const combined = { transient: combineMetrics(completeResults, "transient"), group: combineMetrics(completeResults, "group") };
    const changedYears = new Set(affectedYears);
    const publishedYearBuildRunIds = Object.fromEntries(completeResults.map((result) => [String(result.year), changedYears.has(result.year) ? runId : result.buildRunId || null]));
    await publishBuild(db, hotelUid, runId, annualResults, { modelVersion: MODEL_VERSION, publicationVersion: PUBLICATION_VERSION, publishedYearBuildRunIds, sourceRevision, publishedSourceRevision: sourceRevision, status: allValid ? "VALID" : "VALIDATION_FAILED", sourceThroughDate, affectedYears, availableYears: completeResults.map((result) => result.year), trigger, latestCompletedBuildRunId: runId, transientReconciliation: combined.transient, groupReconciliation: combined.group });
    return { modelVersion: MODEL_VERSION, status: allValid ? "VALID" : "VALIDATION_FAILED", runId, affectedYears, sourceThroughDate, annualResults, combined, topMismatches: completeResults.flatMap((result) => result.reconciliation.largestMismatches).sort((a, b) => Math.abs(b.differenceTransient) + Math.abs(b.differenceGroup) - Math.abs(a.differenceTransient) - Math.abs(a.differenceGroup)).slice(0, 20) };
  } catch (error) {
    try {
      await db.runTransaction(async (transaction) => {
        const current = await transaction.get(modelRef);
        transaction.set(modelRef.collection("builds").doc(runId), { status: "FAILED", failedAt: FieldValue.serverTimestamp(), failureMessage: error.message, affectedYears, trigger }, { merge: true });
        const currentData = current.data() || {};
        const newerLifecycle = [currentData.buildStartedAt, currentData.builtAt].some((timestamp) => typeof timestamp?.toMillis === "function" && timestamp.toMillis() >= attemptStartedAt);
        if ((!started && !newerLifecycle) || currentData.buildRunId === runId) transaction.set(modelRef, { modelVersion: MODEL_VERSION, publicationVersion: PUBLICATION_VERSION, status: "STALE", failedBuildRunId: runId, failedAt: FieldValue.serverTimestamp(), failureMessage: error.message, affectedYears, trigger }, { merge: true });
      });
    } catch (statusError) { logger.error("Stay Pattern failure status could not be persisted", { hotelUid, runId, error: statusError.message }); }
    throw error;
  }
}

const rebuildStayPatternModelCallable = onCall({ region: "us-west1", timeoutSeconds: 540, memory: "1GiB" }, async (request) => {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "Authentication is required.");
  const hotelUid = String(request.data?.hotelUid || "").trim(), requestedYear = request.data?.year == null ? null : Number(request.data.year), db = getFirestore();
  if (!hotelUid) throw new HttpsError("invalid-argument", "hotelUid is required.");
  if (requestedYear !== null && (!Number.isInteger(requestedYear) || requestedYear < 1900 || requestedYear > 2200)) throw new HttpsError("invalid-argument", "year must be a four-digit year.");
  await requireHotelPermission(db, request, hotelUid, "groupquotes", "update");
  try {
    const result = await rebuildStayPatternModel({ hotelUid, years: requestedYear === null ? null : [requestedYear], trigger: "MANUAL", db });
    return { ...result, annualResults: result.annualResults.map((annual) => ({ year: annual.year, status: annual.status, sourceThroughDate: annual.sourceThroughDate, reconciliation: annual.reconciliation, quality: annual.quality, losCoverage: { TRANSIENT: annual.types.TRANSIENT.modeledRoomArrivalCoverage, GROUP: annual.types.GROUP.modeledRoomArrivalCoverage }, longStayRoomArrivalShare: { TRANSIENT: annual.types.TRANSIENT.longStayRoomArrivalShare, GROUP: annual.types.GROUP.longStayRoomArrivalShare } })) };
  } catch (error) { logger.error("Stay Pattern rebuild failed", { hotelUid, year: requestedYear, error: error.message }); throw new HttpsError("internal", error.message); }
});

module.exports = { MODEL_VERSION, PUBLICATION_VERSION, DEFAULTS, RAW_REPORT_PATH, classifyRateCode, normalizeStatus, normalizeReservation, buildYear, combineMetrics, readRawReservations, rebuildStayPatternModel, rebuildStayPatternModelCallable };
