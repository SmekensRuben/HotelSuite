const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { HttpsError, onCall } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");

const MODEL_VERSION = "stay-pattern-v1";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULTS = Object.freeze({ maxModeledLos: 14, absoluteToleranceRooms: 2, relativeTolerance: 0.03, minimumMatchingDateShare: 0.90, maximumWape: 0.05, minimumModeledRoomArrivalCoverage: 0.98 });
const RAW_REPORT_PATH = "staydatepattern";
const HISTORY_REPORT_PATH = "historyquotes";
const MODEL_REPORT_PATH = "stayPatternModel";

function isoDate(value) {
  if (value && typeof value.toDate === "function") value = value.toDate();
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  const text = String(value || "").trim().slice(0, 10);
  return DATE_RE.test(text) && !Number.isNaN(Date.parse(`${text}T00:00:00Z`)) ? text : null;
}
function daysBetween(start, end) { return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000); }
function addDays(value, amount) { const parsed = new Date(`${value}T00:00:00Z`); parsed.setUTCDate(parsed.getUTCDate() + amount); return parsed.toISOString().slice(0, 10); }
function season(value) { const month = Number(value.slice(5, 7)); if (month <= 2) return "WINTER_LOW"; if (month <= 6) return "SPRING_BUSINESS"; if (month <= 8) return "SUMMER"; if (month <= 11) return "AUTUMN_BUSINESS"; return "FESTIVE"; }
function classifyRateCode(value) { if (typeof value !== "string" || !value.trim()) return "UNCLASSIFIED"; const code = value.trim().toUpperCase(); if (code === "NORATE") return "EXCLUDED_POSTMASTER"; return /^[0-9]{2}/.test(code) ? "TRANSIENT" : "GROUP"; }
function normalizeStatus(value) { const status = String(value || "").trim().toUpperCase().replace(/[\s-]+/g, "_"); if (["CHECKED_OUT", "CHECKEDOUT", "DEPARTED", "CKOT"].includes(status)) return "REALIZED"; if (["CANCELLED", "CANCELED", "CXL"].includes(status)) return "CANCELLED"; if (["NO_SHOW", "NOSHOW", "NOSH"].includes(status)) return "NO_SHOW"; return "UNKNOWN"; }
function possibleShare(raw) { return Number(raw.shareAmount) > 0 || Number(raw.shareAmountPerStay) > 0; }
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

function normalizeReservation(raw) {
  const arrivalDate = isoDate(raw.arrivalDate ?? raw.ARRIVAL_DATE), departureDate = isoDate(raw.departureDate ?? raw.DEPARTURE_DATE);
  const statedNights = Number(raw.nights ?? raw.NIGHTS), rooms = Number(raw.numberOfRooms ?? raw.NUMBER_OF_ROOMS);
  const businessType = classifyRateCode(raw.rateCode ?? raw.RATE_CODE), status = normalizeStatus(raw.reservationStatus ?? raw.shortReservationStatus ?? raw.shortResevationStatus ?? raw.RESERVATION_STATUS);
  const los = arrivalDate && departureDate ? daysBetween(arrivalDate, departureDate) : null;
  let exclusionReason = null;
  if (businessType === "EXCLUDED_POSTMASTER") exclusionReason = "EXCLUDED_POSTMASTER";
  else if (businessType === "UNCLASSIFIED") exclusionReason = "UNCLASSIFIED_RATE_CODE";
  else if (status !== "REALIZED") exclusionReason = status;
  else if (!arrivalDate || !departureDate || !Number.isFinite(statedNights) || statedNights <= 0 || !Number.isFinite(rooms) || rooms <= 0 || !Number.isFinite(los) || los <= 0) exclusionReason = "INVALID_STAY";
  else if (los !== statedNights) exclusionReason = "NIGHTS_DATE_MISMATCH";
  return { arrivalDate, departureDate, statedNights, rooms, businessType, status, los, exclusionReason, possibleShare: possibleShare(raw) };
}

function median(values) { const sorted = values.slice().sort((a, b) => a - b); if (!sorted.length) return null; const middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2; }
function reconciliationMetrics(rows, type, settings) {
  const authoritativeKey = type === "transient" ? "authoritativeTransient" : "authoritativeGroup", reconstructedKey = type === "transient" ? "reconstructedTransient" : "reconstructedGroup";
  const differences = rows.map((row) => row[reconstructedKey] - row[authoritativeKey]), absoluteErrors = differences.map(Math.abs).sort((a, b) => a - b);
  const authoritativeRooms = rows.reduce((sum, row) => sum + row[authoritativeKey], 0), reconstructedRooms = rows.reduce((sum, row) => sum + row[reconstructedKey], 0), sumAbsoluteError = absoluteErrors.reduce((sum, value) => sum + value, 0), signedErrorRooms = differences.reduce((sum, value) => sum + value, 0);
  const matchingDates = rows.filter((row) => Math.abs(row[reconstructedKey] - row[authoritativeKey]) <= Math.max(settings.absoluteToleranceRooms, row[authoritativeKey] * settings.relativeTolerance)).length;
  const wape = authoritativeRooms > 0 ? sumAbsoluteError / authoritativeRooms : null, matchingDateShare = rows.length ? matchingDates / rows.length : null;
  return { comparedDates: rows.length, authoritativeRooms, reconstructedRooms, sumAbsoluteError, signedErrorRooms, signedAggregateBias: signedErrorRooms, matchingDates, absoluteErrors, meanAbsoluteError: rows.length ? sumAbsoluteError / rows.length : null, medianAbsoluteError: median(absoluteErrors), wape, matchingDateShare, passes: rows.length > 0 && wape !== null && wape <= settings.maximumWape && matchingDateShare >= settings.minimumMatchingDateShare };
}

function buildYear(year, reservations, historyByDate, inputSettings = {}) {
  const settings = { ...DEFAULTS, ...inputSettings }, observations = { TRANSIENT: new Map(), GROUP: new Map() }, reconstructed = {}, counts = { sourceReservations: 0, realizedReservationsUsed: 0, cancelledNoShowExclusions: 0, norateExclusions: 0, unclassifiedRateCodeCount: 0, possibleShareCount: 0, invalidStayCount: 0 }, volume = { TRANSIENT: { modeledRoomArrivals: 0, modeledRoomNights: 0, longStayCount: 0, longStayRoomArrivals: 0, longStayRoomNights: 0 }, GROUP: { modeledRoomArrivals: 0, modeledRoomNights: 0, longStayCount: 0, longStayRoomArrivals: 0, longStayRoomNights: 0 } };
  reservations.forEach((raw) => {
    const row = normalizeReservation(raw); if (Number(row.arrivalDate?.slice(0, 4)) !== Number(year)) return; counts.sourceReservations += 1; if (row.possibleShare) counts.possibleShareCount += 1;
    if (row.exclusionReason) { if (["CANCELLED", "NO_SHOW"].includes(row.exclusionReason)) counts.cancelledNoShowExclusions += 1; else if (row.exclusionReason === "EXCLUDED_POSTMASTER") counts.norateExclusions += 1; else if (row.exclusionReason === "UNCLASSIFIED_RATE_CODE") counts.unclassifiedRateCodeCount += 1; else counts.invalidStayCount += 1; return; }
    counts.realizedReservationsUsed += 1; const target = volume[row.businessType];
    for (let stayDate = row.arrivalDate; stayDate < row.departureDate; stayDate = addDays(stayDate, 1)) { reconstructed[stayDate] ||= { TRANSIENT: 0, GROUP: 0 }; reconstructed[stayDate][row.businessType] += row.rooms; }
    if (row.los > settings.maxModeledLos) { target.longStayCount += 1; target.longStayRoomArrivals += row.rooms; target.longStayRoomNights += row.rooms * row.los; return; }
    target.modeledRoomArrivals += row.rooms; target.modeledRoomNights += row.rooms * row.los;
    const key = `${row.arrivalDate}:${row.los}`, arrival = new Date(`${row.arrivalDate}T00:00:00Z`); const existing = observations[row.businessType].get(key);
    if (existing) existing.roomArrivals += row.rooms; else observations[row.businessType].set(key, { arrivalDate: row.arrivalDate, dayOfWeek: arrival.getUTCDay(), month: arrival.getUTCMonth() + 1, businessSeason: season(row.arrivalDate), lengthOfStay: row.los, roomArrivals: row.rooms });
  });
  const rows = Object.entries(historyByDate).filter(([stayDate, history]) => Number(stayDate.slice(0, 4)) === Number(year) && Number.isFinite(Number(history.individualRooms)) && Number.isFinite(Number(history.groupRooms))).map(([stayDate, history]) => ({ stayDate, weekday: new Date(`${stayDate}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" }), authoritativeTransient: Number(history.individualRooms), reconstructedTransient: reconstructed[stayDate]?.TRANSIENT || 0, differenceTransient: (reconstructed[stayDate]?.TRANSIENT || 0) - Number(history.individualRooms), authoritativeGroup: Number(history.groupRooms), reconstructedGroup: reconstructed[stayDate]?.GROUP || 0, differenceGroup: (reconstructed[stayDate]?.GROUP || 0) - Number(history.groupRooms) }));
  const reconciliation = { transient: reconciliationMetrics(rows, "transient", settings), group: reconciliationMetrics(rows, "group", settings), largestMismatches: rows.slice().sort((a, b) => Math.abs(b.differenceTransient) + Math.abs(b.differenceGroup) - Math.abs(a.differenceTransient) - Math.abs(a.differenceGroup)).slice(0, 20) };
  const types = Object.fromEntries(["TRANSIENT", "GROUP"].map((type) => { const total = volume[type].modeledRoomArrivals + volume[type].longStayRoomArrivals; return [type, { ...volume[type], observations: [...observations[type].values()], modeledRoomArrivalCoverage: total ? volume[type].modeledRoomArrivals / total : 1, longStayRoomArrivalShare: total ? volume[type].longStayRoomArrivals / total : 0 }]; }));
  const passes = reconciliation.transient.passes && reconciliation.group.passes && types.TRANSIENT.modeledRoomArrivalCoverage >= settings.minimumModeledRoomArrivalCoverage && types.GROUP.modeledRoomArrivalCoverage >= settings.minimumModeledRoomArrivalCoverage;
  const sourceThroughDate = reservations.map((row) => isoDate(row.arrivalDate ?? row.ARRIVAL_DATE)).filter((arrivalDate) => Number(arrivalDate?.slice(0, 4)) === Number(year)).sort().at(-1) || null;
  return { modelVersion: MODEL_VERSION, year: Number(year), status: passes ? "VALID" : "VALIDATION_FAILED", sourceThroughDate, settings, types, reconciliation, quality: { ...counts, modeledRoomArrivalCoverage: { TRANSIENT: types.TRANSIENT.modeledRoomArrivalCoverage, GROUP: types.GROUP.modeledRoomArrivalCoverage } } };
}

function availableYears(reservations) { return [...new Set(reservations.map((row) => Number(isoDate(row.arrivalDate ?? row.ARRIVAL_DATE)?.slice(0, 4))).filter((year) => Number.isInteger(year) && year > 1900))].sort(); }
async function publishBuild(db, hotelUid, runId, annualResults, metadata) {
  const modelRef = db.doc(`hotels/${hotelUid}/reports/${MODEL_REPORT_PATH}`);
  await db.runTransaction(async (transaction) => {
    const stagedResults = await Promise.all(annualResults.map((result) => transaction.get(modelRef.collection("builds").doc(runId).collection("years").doc(String(result.year)))));
    annualResults.forEach((result, index) => {
      const staged = stagedResults[index]; if (!staged.exists) throw new Error(`Missing staged year ${result.year}`);
      transaction.set(modelRef.collection("years").doc(String(result.year)), { ...staged.data(), builtAt: FieldValue.serverTimestamp(), buildRunId: runId });
    });
    transaction.set(modelRef, { ...metadata, builtAt: FieldValue.serverTimestamp() }, { merge: true });
  });
}

async function rebuildStayPatternModel({ hotelUid, years = null, trigger = "MANUAL", db = getFirestore() }) {
  const modelRef = db.doc(`hotels/${hotelUid}/reports/${MODEL_REPORT_PATH}`), runId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const [reservations, allHistory] = await Promise.all([readRawReservations(db, hotelUid), readHistoryByYear(db, hotelUid, null)]);
  const allYears = [...new Set([...availableYears(reservations), ...Object.keys(allHistory).map((stayDate) => Number(stayDate.slice(0, 4)))])].filter((year) => Number.isInteger(year)).sort();
  const affectedYears = years?.length ? [...new Set(years.map(Number))].filter((year) => allYears.includes(year)).sort() : allYears;
  if (!affectedYears.length) throw new Error("No staydatepattern reservation years were found to build.");
  const prior = await modelRef.get();
  await modelRef.set({ modelVersion: MODEL_VERSION, status: "BUILDING", buildRunId: runId, buildStartedAt: FieldValue.serverTimestamp(), affectedYears, trigger, previousStatus: prior.data()?.status || null }, { merge: true });
  try {
    const annualResults = affectedYears.map((year) => buildYear(year, reservations, allHistory));
    const writer = db.bulkWriter(); annualResults.forEach((result) => writer.set(modelRef.collection("builds").doc(runId).collection("years").doc(String(result.year)), result)); await writer.close();
    const published = await modelRef.collection("years").get(), replacements = new Map(annualResults.map((result) => [result.year, result]));
    const completeResults = [...published.docs.map((doc) => replacements.get(Number(doc.id)) || doc.data()), ...annualResults.filter((result) => !published.docs.some((doc) => Number(doc.id) === result.year))].sort((a, b) => a.year - b.year);
    const allValid = completeResults.every((result) => result.status === "VALID"), sourceThroughDate = completeResults.map((result) => result.sourceThroughDate).filter(Boolean).sort().at(-1) || null;
    const combined = { transient: combineMetrics(completeResults, "transient"), group: combineMetrics(completeResults, "group") };
    await publishBuild(db, hotelUid, runId, annualResults, { modelVersion: MODEL_VERSION, status: allValid ? "VALID" : "VALIDATION_FAILED", sourceThroughDate, affectedYears, availableYears: completeResults.map((result) => result.year), trigger, latestCompletedBuildRunId: runId, transientReconciliation: combined.transient, groupReconciliation: combined.group });
    return { modelVersion: MODEL_VERSION, status: allValid ? "VALID" : "VALIDATION_FAILED", runId, affectedYears, sourceThroughDate, annualResults, combined, topMismatches: completeResults.flatMap((result) => result.reconciliation.largestMismatches).sort((a, b) => Math.abs(b.differenceTransient) + Math.abs(b.differenceGroup) - Math.abs(a.differenceTransient) - Math.abs(a.differenceGroup)).slice(0, 20) };
  } catch (error) {
    await modelRef.set({ modelVersion: MODEL_VERSION, status: prior.data()?.status === "VALID" ? "VALID" : "STALE", failedBuildRunId: runId, failedAt: FieldValue.serverTimestamp(), failureMessage: error.message, affectedYears, trigger }, { merge: true });
    throw error;
  }
}

function combineMetrics(results, type) {
  const parts = results.map((result) => result.reconciliation[type]), sum = (key) => parts.reduce((total, row) => total + Number(row[key] || 0), 0), absoluteErrors = parts.flatMap((row) => row.absoluteErrors || []).sort((a, b) => a - b);
  const comparedDates = sum("comparedDates"), authoritativeRooms = sum("authoritativeRooms"), reconstructedRooms = sum("reconstructedRooms"), sumAbsoluteError = sum("sumAbsoluteError"), signedErrorRooms = sum("signedErrorRooms"), matchingDates = sum("matchingDates"), wape = authoritativeRooms ? sumAbsoluteError / authoritativeRooms : null, matchingDateShare = comparedDates ? matchingDates / comparedDates : null;
  return { comparedDates, authoritativeRooms, reconstructedRooms, sumAbsoluteError, signedErrorRooms, signedAggregateBias: signedErrorRooms, matchingDates, meanAbsoluteError: comparedDates ? sumAbsoluteError / comparedDates : null, medianAbsoluteError: median(absoluteErrors), wape, matchingDateShare, passes: comparedDates > 0 && wape !== null && wape <= DEFAULTS.maximumWape && matchingDateShare >= DEFAULTS.minimumMatchingDateShare };
}

async function userCanRebuildHotel(db, userUid, hotelUid) {
  const user = await db.doc(`users/${userUid}`).get(), data = user.data() || {};
  const hotelAccess = user.exists && Array.isArray(data.hotelUid) && data.hotelUid.includes(hotelUid);
  const permissions = Array.isArray(data.permissions) ? data.permissions.map((permission) => String(permission).trim().toLowerCase()) : [];
  return hotelAccess && (permissions.includes("groupquotes.update") || permissions.includes("groupquotes.*"));
}
const rebuildStayPatternModelCallable = onCall({ region: "us-west1", timeoutSeconds: 540, memory: "1GiB" }, async (request) => {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "Authentication is required.");
  const hotelUid = String(request.data?.hotelUid || "").trim(), requestedYear = request.data?.year == null ? null : Number(request.data.year), db = getFirestore();
  if (!hotelUid) throw new HttpsError("invalid-argument", "hotelUid is required.");
  if (requestedYear !== null && (!Number.isInteger(requestedYear) || requestedYear < 1900 || requestedYear > 2200)) throw new HttpsError("invalid-argument", "year must be a four-digit year.");
  if (!(await userCanRebuildHotel(db, request.auth.uid, hotelUid))) throw new HttpsError("permission-denied", "Group Quote administration permission is required for this hotel.");
  try {
    const result = await rebuildStayPatternModel({ hotelUid, years: requestedYear === null ? null : [requestedYear], trigger: "MANUAL", db });
    return { ...result, annualResults: result.annualResults.map((annual) => ({ year: annual.year, status: annual.status, sourceThroughDate: annual.sourceThroughDate, reconciliation: annual.reconciliation, quality: annual.quality, losCoverage: { TRANSIENT: annual.types.TRANSIENT.modeledRoomArrivalCoverage, GROUP: annual.types.GROUP.modeledRoomArrivalCoverage }, longStayRoomArrivalShare: { TRANSIENT: annual.types.TRANSIENT.longStayRoomArrivalShare, GROUP: annual.types.GROUP.longStayRoomArrivalShare } })) };
  } catch (error) { logger.error("Stay Pattern rebuild failed", { hotelUid, year: requestedYear, error: error.message }); throw new HttpsError("internal", error.message); }
});

module.exports = { MODEL_VERSION, DEFAULTS, RAW_REPORT_PATH, classifyRateCode, normalizeStatus, normalizeReservation, buildYear, combineMetrics, readRawReservations, rebuildStayPatternModel, rebuildStayPatternModelCallable };
