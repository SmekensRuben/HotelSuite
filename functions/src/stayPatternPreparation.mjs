// Canonical pure preparation shared by the production lifecycle and browser diagnostics.
const MODEL_VERSION = "stay-pattern-v1";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULTS = Object.freeze({ maxModeledLos: 14, absoluteToleranceRooms: 2, relativeTolerance: 0.03, minimumMatchingDateShare: 0.90, maximumWape: 0.05, minimumModeledRoomArrivalCoverage: 0.98 });

function isoDate(value) {
  if (value && typeof value.toDate === "function") value = value.toDate();
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  const text = String(value || "").trim().slice(0, 10);
  const parsed = new Date(`${text}T00:00:00Z`);
  return DATE_RE.test(text) && Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text ? text : null;
}
function daysBetween(start, end) { return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000); }
function addDays(value, amount) { const parsed = new Date(`${value}T00:00:00Z`); parsed.setUTCDate(parsed.getUTCDate() + amount); return parsed.toISOString().slice(0, 10); }
function season(value) { const month = Number(value.slice(5, 7)); if (month <= 2) return "WINTER_LOW"; if (month <= 6) return "SPRING_BUSINESS"; if (month <= 8) return "SUMMER"; if (month <= 11) return "AUTUMN_BUSINESS"; return "FESTIVE"; }
function classifyRateCode(value) { if (typeof value !== "string" || !value.trim()) return "UNCLASSIFIED"; const code = value.trim().toUpperCase(); if (code === "NORATE") return "EXCLUDED_POSTMASTER"; return /^[0-9]{2}/.test(code) ? "TRANSIENT" : "GROUP"; }
const RESERVATION_STATUS = Object.freeze({ CHECKED_OUT: "REALIZED", CHECKEDOUT: "REALIZED", DEPARTED: "REALIZED", CKOT: "REALIZED", CANCELLED: "CANCELLED", CANCELED: "CANCELLED", CXL: "CANCELLED", NO_SHOW: "NO_SHOW", NOSHOW: "NO_SHOW", NOSH: "NO_SHOW" });
function normalizeStatus(value) { const status = String(value || "").trim().toUpperCase().replace(/[\s-]+/g, "_"); return RESERVATION_STATUS[status] || "UNKNOWN"; }
function possibleShare(raw) { return Number(raw.shareAmount) > 0 || Number(raw.shareAmountPerStay) > 0; }
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
function reconciliationMetrics(rows, type, settings, invalidDateCount = 0) {
  const authoritativeKey = type === "transient" ? "authoritativeTransient" : "authoritativeGroup", reconstructedKey = type === "transient" ? "reconstructedTransient" : "reconstructedGroup";
  const differences = rows.map((row) => row[reconstructedKey] - row[authoritativeKey]), absoluteErrors = differences.map(Math.abs).sort((a, b) => a - b);
  const authoritativeRooms = rows.reduce((sum, row) => sum + row[authoritativeKey], 0), reconstructedRooms = rows.reduce((sum, row) => sum + row[reconstructedKey], 0), sumAbsoluteError = absoluteErrors.reduce((sum, value) => sum + value, 0), signedErrorRooms = differences.reduce((sum, value) => sum + value, 0);
  const matchingDates = rows.filter((row) => Math.abs(row[reconstructedKey] - row[authoritativeKey]) <= Math.max(settings.absoluteToleranceRooms, row[authoritativeKey] * settings.relativeTolerance)).length;
  const wape = authoritativeRooms > 0 ? sumAbsoluteError / authoritativeRooms : null, matchingDateShare = rows.length ? matchingDates / rows.length : null;
  return { comparedDates: rows.length, invalidDateCount, authoritativeRooms, reconstructedRooms, sumAbsoluteError, signedErrorRooms, signedAggregateBias: signedErrorRooms, matchingDates, absoluteErrors, meanAbsoluteError: rows.length ? sumAbsoluteError / rows.length : null, medianAbsoluteError: median(absoluteErrors), wape, matchingDateShare, passes: invalidDateCount === 0 && rows.length > 0 && wape !== null && wape <= settings.maximumWape && matchingDateShare >= settings.minimumMatchingDateShare };
}

function authoritativeRoomCount(value) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function reconcileStayPattern(reconstructed = {}, historyByDate = {}, inputSettings = {}) {
  const settings = { ...DEFAULTS, ...inputSettings };
  const rows = [], invalidDates = [];
  const stayDates = [...new Set([...Object.keys(historyByDate), ...Object.keys(reconstructed)])].sort();
  stayDates.forEach((stayDate) => {
    const history = historyByDate[stayDate], reasons = [];
    const authoritativeTransient = authoritativeRoomCount(history?.individualRooms), authoritativeGroup = authoritativeRoomCount(history?.groupRooms);
    if (isoDate(stayDate) !== stayDate) reasons.push("INVALID_STAY_DATE");
    if (!Object.hasOwn(historyByDate, stayDate)) reasons.push("MISSING_AUTHORITATIVE_DATE");
    if (authoritativeTransient === null) reasons.push("INVALID_INDIVIDUAL_ROOM_COUNT");
    if (authoritativeGroup === null) reasons.push("INVALID_GROUP_ROOM_COUNT");
    const reconstructedTransient = reconstructed[stayDate]?.TRANSIENT || 0, reconstructedGroup = reconstructed[stayDate]?.GROUP || 0;
    if (reasons.length) {
      invalidDates.push({ stayDate, reasons, authoritativeTransient, authoritativeGroup, reconstructedTransient, reconstructedGroup });
      return;
    }
    rows.push({ stayDate, weekday: new Date(`${stayDate}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" }), authoritativeTransient, reconstructedTransient, differenceTransient: reconstructedTransient - authoritativeTransient, authoritativeGroup, reconstructedGroup, differenceGroup: reconstructedGroup - authoritativeGroup });
  });
  const reconciliation = { transient: reconciliationMetrics(rows, "transient", settings, invalidDates.length), group: reconciliationMetrics(rows, "group", settings, invalidDates.length), invalidDates, largestMismatches: rows.slice().sort((a, b) => Math.abs(b.differenceTransient) + Math.abs(b.differenceGroup) - Math.abs(a.differenceTransient) - Math.abs(a.differenceGroup)).slice(0, settings.largestMismatchLimit || 20) };
  return reconciliation;
}

function buildYear(year, reservations, historyByDate, inputSettings = {}) {
  const settings = { ...DEFAULTS, ...inputSettings }, observations = { TRANSIENT: new Map(), GROUP: new Map() }, reconstructed = {}, counts = { sourceReservations: 0, realizedReservationsUsed: 0, cancelledNoShowExclusions: 0, norateExclusions: 0, unclassifiedRateCodeCount: 0, possibleShareCount: 0, invalidStayCount: 0 }, volume = { TRANSIENT: { modeledRoomArrivals: 0, modeledRoomNights: 0, longStayCount: 0, longStayRoomArrivals: 0, longStayRoomNights: 0 }, GROUP: { modeledRoomArrivals: 0, modeledRoomNights: 0, longStayCount: 0, longStayRoomArrivals: 0, longStayRoomNights: 0 } };
  const exclusions = {}, sourceStatuses = {};
  reservations.forEach((raw) => {
    const row = normalizeReservation(raw);
    // Arrival-year observations remain separate; occupancy includes prior-year
    // arrivals still occupying the selected stay year.
    if (!row.exclusionReason) {
      const yearStart = `${year}-01-01`, yearEnd = `${Number(year) + 1}-01-01`;
      const start = row.arrivalDate > yearStart ? row.arrivalDate : yearStart, end = row.departureDate < yearEnd ? row.departureDate : yearEnd;
      for (let stayDate = start; stayDate < end; stayDate = addDays(stayDate, 1)) { reconstructed[stayDate] ||= { TRANSIENT: 0, GROUP: 0 }; reconstructed[stayDate][row.businessType] += row.rooms; }
    }
    if (Number(row.arrivalDate?.slice(0, 4)) !== Number(year)) return; counts.sourceReservations += 1; const rawStatus = String(raw.reservationStatus ?? raw.shortReservationStatus ?? raw.shortResevationStatus ?? raw.RESERVATION_STATUS ?? "").trim() || "(empty)"; sourceStatuses[rawStatus] = (sourceStatuses[rawStatus] || 0) + 1; if (row.possibleShare) counts.possibleShareCount += 1;
    if (row.exclusionReason) { const reason = row.exclusionReason === "UNKNOWN" ? "UNKNOWN_STATUS" : row.exclusionReason; exclusions[reason] = (exclusions[reason] || 0) + 1; if (["CANCELLED", "NO_SHOW"].includes(row.exclusionReason)) counts.cancelledNoShowExclusions += 1; else if (row.exclusionReason === "EXCLUDED_POSTMASTER") counts.norateExclusions += 1; else if (row.exclusionReason === "UNCLASSIFIED_RATE_CODE") counts.unclassifiedRateCodeCount += 1; else counts.invalidStayCount += 1; return; }
    counts.realizedReservationsUsed += 1; const target = volume[row.businessType];
    if (row.los > settings.maxModeledLos) { target.longStayCount += 1; target.longStayRoomArrivals += row.rooms; target.longStayRoomNights += row.rooms * row.los; return; }
    target.modeledRoomArrivals += row.rooms; target.modeledRoomNights += row.rooms * row.los;
    const key = `${row.arrivalDate}:${row.los}`, arrival = new Date(`${row.arrivalDate}T00:00:00Z`); const existing = observations[row.businessType].get(key);
    if (existing) existing.roomArrivals += row.rooms; else observations[row.businessType].set(key, { arrivalDate: row.arrivalDate, dayOfWeek: arrival.getUTCDay(), month: arrival.getUTCMonth() + 1, businessSeason: season(row.arrivalDate), lengthOfStay: row.los, roomArrivals: row.rooms });
  });
  const historyForYear = Object.fromEntries(Object.entries(historyByDate).filter(([stayDate]) => Number(stayDate.slice(0, 4)) === Number(year)));
  const reconciliation = reconcileStayPattern(reconstructed, historyForYear, settings);
  const types = Object.fromEntries(["TRANSIENT", "GROUP"].map((type) => { const total = volume[type].modeledRoomArrivals + volume[type].longStayRoomArrivals; return [type, { ...volume[type], observations: [...observations[type].values()], modeledRoomArrivalCoverage: total ? volume[type].modeledRoomArrivals / total : 1, longStayRoomArrivalShare: total ? volume[type].longStayRoomArrivals / total : 0 }]; }));
  const passes = reconciliation.transient.passes && reconciliation.group.passes && types.TRANSIENT.modeledRoomArrivalCoverage >= settings.minimumModeledRoomArrivalCoverage && types.GROUP.modeledRoomArrivalCoverage >= settings.minimumModeledRoomArrivalCoverage;
  const sourceThroughDate = reservations.map((row) => isoDate(row.arrivalDate ?? row.ARRIVAL_DATE)).filter((arrivalDate) => Number(arrivalDate?.slice(0, 4)) === Number(year)).sort().at(-1) || null;
  return { modelVersion: MODEL_VERSION, year: Number(year), status: passes ? "VALID" : "VALIDATION_FAILED", sourceThroughDate, settings, types, reconciliation, quality: { ...counts, sourceReservationCount: counts.sourceReservations, possibleShareRecords: counts.possibleShareCount, exclusions, sourceStatuses, modeledRoomArrivalCoverage: { TRANSIENT: types.TRANSIENT.modeledRoomArrivalCoverage, GROUP: types.GROUP.modeledRoomArrivalCoverage } } };
}

function combineMetrics(results, type) {
  const parts = results.map((result) => result.reconciliation[type]), sum = (key) => parts.reduce((total, row) => total + Number(row[key] || 0), 0), absoluteErrors = parts.flatMap((row) => row.absoluteErrors || []).sort((a, b) => a - b);
  const comparedDates = sum("comparedDates"), invalidDateCount = sum("invalidDateCount"), authoritativeRooms = sum("authoritativeRooms"), reconstructedRooms = sum("reconstructedRooms"), sumAbsoluteError = sum("sumAbsoluteError"), signedErrorRooms = sum("signedErrorRooms"), matchingDates = sum("matchingDates"), wape = authoritativeRooms ? sumAbsoluteError / authoritativeRooms : null, matchingDateShare = comparedDates ? matchingDates / comparedDates : null;
  return { comparedDates, invalidDateCount, authoritativeRooms, reconstructedRooms, sumAbsoluteError, signedErrorRooms, signedAggregateBias: signedErrorRooms, matchingDates, meanAbsoluteError: comparedDates ? sumAbsoluteError / comparedDates : null, medianAbsoluteError: median(absoluteErrors), wape, matchingDateShare, passes: invalidDateCount === 0 && comparedDates > 0 && wape !== null && wape <= DEFAULTS.maximumWape && matchingDateShare >= DEFAULTS.minimumMatchingDateShare };
}

export { MODEL_VERSION, DATE_RE, DEFAULTS, RESERVATION_STATUS, isoDate, daysBetween, addDays, classifyRateCode, normalizeStatus, normalizeReservation, buildYear, combineMetrics, reconcileStayPattern };
