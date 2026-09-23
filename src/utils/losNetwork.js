import { getBusinessSeason } from "./displacementForecast";
import { toRoomRateInclVat } from "./roomRateVat";

export const STAY_PATTERN_MODEL_VERSION = "stay-pattern-v1";
export const LOS_DISPLACEMENT_MODEL_VERSION = "los-network-v1";
export const LOS_NETWORK_DEFAULTS = Object.freeze({
  maxModeledLos: 14,
  absoluteToleranceRooms: 2,
  relativeTolerance: 0.03,
  minimumMatchingDateShare: 0.90,
  maximumWape: 0.05,
  minimumModeledRoomArrivalCoverage: 0.98,
  minimumRoomArrivalSample: 30,
  minimumDistinctArrivalDates: 5,
  maximumNetworkOccupancyWape: 0.05,
  numericTolerance: 1e-9,
  largestMismatchLimit: 10,
});

const iso = /^\d{4}-\d{2}-\d{2}$/;
const date = (value) => iso.test(String(value || "")) ? new Date(`${value}T00:00:00Z`) : null;
export const addDays = (value, days) => {
  const parsed = date(value);
  if (!parsed) return null;
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
};
const daysBetween = (start, end) => {
  const left = date(start); const right = date(end);
  return left && right ? Math.round((right - left) / 86400000) : null;
};
const datesBetween = (start, endExclusive) => {
  const output = [];
  for (let cursor = start; cursor && cursor < endExclusive; cursor = addDays(cursor, 1)) output.push(cursor);
  return output;
};
const finitePositive = (value) => Number.isFinite(Number(value)) && Number(value) > 0;

export function classifyRateCode(rateCode) {
  if (typeof rateCode !== "string" || !rateCode.trim()) return "UNCLASSIFIED";
  const normalized = rateCode.trim().toUpperCase();
  if (normalized === "NORATE") return "EXCLUDED_POSTMASTER";
  return /^[0-9]{2}/.test(normalized) ? "TRANSIENT" : "GROUP";
}

// Source values confirmed by the Opera extracts represented by this importer contract.
export const RESERVATION_STATUS = Object.freeze({
  CHECKED_OUT: "REALIZED",
  CHECKEDOUT: "REALIZED",
  DEPARTED: "REALIZED",
  CKOT: "REALIZED",
  CANCELLED: "CANCELLED",
  CANCELED: "CANCELLED",
  CXL: "CANCELLED",
  NO_SHOW: "NO_SHOW",
  NOSHOW: "NO_SHOW",
  NOSH: "NO_SHOW",
});

export function normalizeReservationStatus(value) {
  if (typeof value !== "string" || !value.trim()) return "UNKNOWN";
  const normalized = value.trim().toUpperCase().replace(/[\s-]+/g, "_");
  return RESERVATION_STATUS[normalized] || "UNKNOWN";
}

export function normalizeHistoricalReservation(raw = {}) {
  const arrivalDate = raw.arrivalDate || raw.ARRIVAL_DATE;
  const departureDate = raw.departureDate || raw.DEPARTURE_DATE;
  const statedNights = Number(raw.nights ?? raw.NIGHTS);
  const lengthOfStay = daysBetween(arrivalDate, departureDate);
  const numberOfRooms = Number(raw.numberOfRooms ?? raw.NUMBER_OF_ROOMS);
  const businessType = classifyRateCode(raw.rateCode ?? raw.RATE_CODE);
  const status = normalizeReservationStatus(raw.reservationStatus ?? raw.shortReservationStatus ?? raw.shortResevationStatus ?? raw.RESERVATION_STATUS);
  let exclusionReason = null;
  if (businessType === "EXCLUDED_POSTMASTER") exclusionReason = "EXCLUDED_POSTMASTER";
  else if (businessType === "UNCLASSIFIED") exclusionReason = "UNCLASSIFIED_RATE_CODE";
  else if (status !== "REALIZED") exclusionReason = status === "UNKNOWN" ? "UNKNOWN_STATUS" : status;
  else if (!date(arrivalDate) || !date(departureDate) || !finitePositive(statedNights) || !finitePositive(numberOfRooms) || lengthOfStay <= 0) exclusionReason = "INVALID_STAY";
  else if (lengthOfStay !== statedNights) exclusionReason = "NIGHTS_DATE_MISMATCH";
  return {
    reservationId: raw.reservationNameId ?? raw.RESV_NAME_ID ?? null,
    arrivalDate, departureDate, lengthOfStay, statedNights, numberOfRooms,
    businessType, status, exclusionReason,
    possibleShare: finitePositive(raw.shareAmount) || finitePositive(raw.shareAmountPerStay),
  };
}

const emptyType = () => ({ observations: [], modeledRoomArrivals: 0, modeledRoomNights: 0, longStayCount: 0, longStayRoomArrivals: 0, longStayRoomNights: 0 });

export function buildStayPatternYear({ year, reservations = [], authoritativeByDate = {}, settings = {} }) {
  const config = { ...LOS_NETWORK_DEFAULTS, ...settings };
  const types = { TRANSIENT: emptyType(), GROUP: emptyType() };
  const reconstructed = {};
  const exclusions = {};
  const sourceStatuses = {};
  let possibleShareRecords = 0;
  reservations.forEach((raw) => {
    const row = normalizeHistoricalReservation(raw);
    sourceStatuses[String(raw.reservationStatus ?? raw.shortReservationStatus ?? "").trim() || "(empty)"] = (sourceStatuses[String(raw.reservationStatus ?? raw.shortReservationStatus ?? "").trim() || "(empty)"] || 0) + 1;
    if (row.possibleShare) possibleShareRecords += 1;
    if (row.exclusionReason) { exclusions[row.exclusionReason] = (exclusions[row.exclusionReason] || 0) + 1; return; }
    const target = types[row.businessType];
    datesBetween(row.arrivalDate, row.departureDate).forEach((stayDate) => {
      reconstructed[stayDate] ||= { TRANSIENT: 0, GROUP: 0 };
      reconstructed[stayDate][row.businessType] += row.numberOfRooms;
    });
    if (row.lengthOfStay > config.maxModeledLos) {
      target.longStayCount += 1; target.longStayRoomArrivals += row.numberOfRooms; target.longStayRoomNights += row.numberOfRooms * row.lengthOfStay;
      return;
    }
    target.modeledRoomArrivals += row.numberOfRooms;
    target.modeledRoomNights += row.numberOfRooms * row.lengthOfStay;
    const observation = { arrivalDate: row.arrivalDate, dayOfWeek: date(row.arrivalDate).getUTCDay(), month: date(row.arrivalDate).getUTCMonth() + 1, businessSeason: getBusinessSeason(row.arrivalDate), lengthOfStay: row.lengthOfStay, roomArrivals: row.numberOfRooms };
    const existingObservation = target.observations.find((item) => item.arrivalDate === observation.arrivalDate && item.lengthOfStay === observation.lengthOfStay);
    if (existingObservation) existingObservation.roomArrivals += observation.roomArrivals;
    else target.observations.push(observation);
  });
  const reconciliation = reconcileStayPattern(reconstructed, authoritativeByDate, config);
  const coverage = Object.fromEntries(Object.entries(types).map(([key, value]) => {
    const total = value.modeledRoomArrivals + value.longStayRoomArrivals;
    return [key, total ? value.modeledRoomArrivals / total : 1];
  }));
  return { modelVersion: STAY_PATTERN_MODEL_VERSION, year: Number(year), types, reconciliation, quality: { sourceReservationCount: reservations.length, sourceStatuses, exclusions, unclassifiedRateCodeCount: exclusions.UNCLASSIFIED_RATE_CODE || 0, possibleShareRecords, modeledRoomArrivalCoverage: coverage } };
}

function metrics(rows, field, config) {
  const differences = rows.map((row) => row[`reconstructed${field}`] - row[`authoritative${field}`]);
  const absolutes = differences.map(Math.abs).sort((a, b) => a - b);
  const authoritative = rows.reduce((sum, row) => sum + row[`authoritative${field}`], 0);
  const matching = rows.filter((row) => Math.abs(row[`difference${field}`]) <= Math.max(config.absoluteToleranceRooms, row[`authoritative${field}`] * config.relativeTolerance)).length;
  const medianAbsoluteError = !absolutes.length ? null : absolutes.length % 2 ? absolutes[(absolutes.length - 1) / 2] : (absolutes[absolutes.length / 2 - 1] + absolutes[absolutes.length / 2]) / 2;
  const sumAbsoluteError = absolutes.reduce((a, b) => a + b, 0);
  const reconstructedRooms = rows.reduce((sum, row) => sum + row[`reconstructed${field}`], 0);
  const signedErrorRooms = differences.reduce((a, b) => a + b, 0);
  const result = { comparedDates: rows.length, authoritativeRooms: authoritative, reconstructedRooms, sumAbsoluteError, signedErrorRooms, matchingDates: matching, absoluteErrors: absolutes, meanAbsoluteError: rows.length ? sumAbsoluteError / rows.length : null, medianAbsoluteError, wape: authoritative > 0 ? sumAbsoluteError / authoritative : null, signedAggregateBias: signedErrorRooms, matchingDateShare: rows.length ? matching / rows.length : null };
  result.passes = result.comparedDates > 0 && result.matchingDateShare >= config.minimumMatchingDateShare && result.wape !== null && result.wape <= config.maximumWape;
  return result;
}

export function reconcileStayPattern(reconstructed = {}, authoritativeByDate = {}, settings = {}) {
  const config = { ...LOS_NETWORK_DEFAULTS, ...settings };
  const rows = Object.entries(authoritativeByDate).filter(([stayDate, row]) => date(stayDate) && Number.isFinite(Number(row.individualRooms)) && Number.isFinite(Number(row.groupRooms))).map(([stayDate, row]) => ({ stayDate, authoritativeTransient: Number(row.individualRooms), reconstructedTransient: reconstructed[stayDate]?.TRANSIENT || 0, differenceTransient: (reconstructed[stayDate]?.TRANSIENT || 0) - Number(row.individualRooms), authoritativeGroup: Number(row.groupRooms), reconstructedGroup: reconstructed[stayDate]?.GROUP || 0, differenceGroup: (reconstructed[stayDate]?.GROUP || 0) - Number(row.groupRooms) }));
  const largestMismatches = rows.slice().sort((a, b) => (Math.abs(b.differenceTransient) + Math.abs(b.differenceGroup)) - (Math.abs(a.differenceTransient) + Math.abs(a.differenceGroup))).slice(0, config.largestMismatchLimit);
  return { transient: metrics(rows, "Transient", config), group: metrics(rows, "Group", config), largestMismatches };
}

export function combineStayPatternYears(yearModels = [], selectedYears = []) {
  const chosen = yearModels.filter((model) => !selectedYears.length || selectedYears.includes(Number(model.year)));
  const selectedYearsComplete = selectedYears.length > 0 && selectedYears.every((year) => chosen.some((model) => Number(model.year) === Number(year)));
  const observations = { TRANSIENT: [], GROUP: [] };
  chosen.forEach((model) => Object.keys(observations).forEach((type) => observations[type].push(...(model.types?.[type]?.observations || []))));
  const reconciliation = Object.fromEntries(["transient", "group"].map((type) => {
    const parts = chosen.map((model) => model.reconciliation?.[type]).filter(Boolean);
    const sum = (field) => parts.reduce((total, row) => total + Number(row[field] || 0), 0);
    const comparedDates = sum("comparedDates"), authoritativeRooms = sum("authoritativeRooms"), reconstructedRooms = sum("reconstructedRooms"), sumAbsoluteError = sum("sumAbsoluteError"), signedErrorRooms = sum("signedErrorRooms"), matchingDates = sum("matchingDates");
    const absoluteErrors = parts.flatMap((row) => row.absoluteErrors || []).sort((a, b) => a - b);
    const medianAbsoluteError = !absoluteErrors.length ? null : absoluteErrors.length % 2 ? absoluteErrors[(absoluteErrors.length - 1) / 2] : (absoluteErrors[absoluteErrors.length / 2 - 1] + absoluteErrors[absoluteErrors.length / 2]) / 2;
    const matchingDateShare = comparedDates ? matchingDates / comparedDates : null, wape = authoritativeRooms ? sumAbsoluteError / authoritativeRooms : null;
    return [type, { comparedDates, authoritativeRooms, reconstructedRooms, sumAbsoluteError, signedErrorRooms, signedAggregateBias: signedErrorRooms, matchingDates, absoluteErrors, meanAbsoluteError: comparedDates ? sumAbsoluteError / comparedDates : null, medianAbsoluteError, wape, matchingDateShare, passes: selectedYearsComplete && comparedDates > 0 && matchingDateShare >= LOS_NETWORK_DEFAULTS.minimumMatchingDateShare && wape !== null && wape <= LOS_NETWORK_DEFAULTS.maximumWape }];
  }));
  const coverage = Object.fromEntries(["TRANSIENT", "GROUP"].map((type) => { const modeled = chosen.reduce((s, m) => s + Number(m.types?.[type]?.modeledRoomArrivals || 0), 0); const long = chosen.reduce((s, m) => s + Number(m.types?.[type]?.longStayRoomArrivals || 0), 0); return [type, modeled + long ? modeled / (modeled + long) : 0]; }));
  return { modelVersion: STAY_PATTERN_MODEL_VERSION, years: chosen.map((model) => model.year), selectedYearsComplete, observations, reconciliation, coverage, quality: { possibleShareRecords: chosen.reduce((s, m) => s + Number(m.quality?.possibleShareRecords || 0), 0), unclassifiedRateCodeCount: chosen.reduce((s, m) => s + Number(m.quality?.unclassifiedRateCodeCount || 0), 0) } };
}

export function selectLosDistribution(model, businessType, arrivalDate, settings = {}) {
  const config = { ...LOS_NETWORK_DEFAULTS, ...settings };
  const target = date(arrivalDate); const all = model?.observations?.[businessType] || [];
  if (!target || !all.length) return { shares: {}, sampleRoomArrivals: 0, distinctArrivalDates: 0, tier: null, confidence: "UNAVAILABLE", warnings: ["LOS_SAMPLE_UNAVAILABLE"] };
  const dow = target.getUTCDay(), month = target.getUTCMonth() + 1, season = getBusinessSeason(arrivalDate);
  const tiers = [["TIER_1_SAME_DOW_MONTH", (r) => r.dayOfWeek === dow && r.month === month], ["TIER_2_SAME_DOW_SEASON", (r) => r.dayOfWeek === dow && r.businessSeason === season], ["TIER_3_SAME_DOW", (r) => r.dayOfWeek === dow], ["TIER_4_SAME_SEASON", (r) => r.businessSeason === season], ["TIER_5_ALL_SELECTED_HISTORY", () => true]];
  let selection = null; let fallback = null;
  for (const [tier, predicate] of tiers) {
    const rows = all.filter(predicate); const volume = rows.reduce((s, r) => s + r.roomArrivals, 0); const distinct = new Set(rows.map((r) => r.arrivalDate)).size;
    if (!fallback && volume > 0) fallback = { tier, rows, volume, distinct };
    if (volume >= config.minimumRoomArrivalSample && distinct >= config.minimumDistinctArrivalDates) { selection = { tier, rows, volume, distinct }; break; }
  }
  selection ||= fallback;
  if (!selection) return { shares: {}, sampleRoomArrivals: 0, distinctArrivalDates: 0, tier: null, confidence: "UNAVAILABLE", warnings: ["LOS_SAMPLE_UNAVAILABLE"] };
  const volumes = {}; selection.rows.forEach((row) => { volumes[row.lengthOfStay] = (volumes[row.lengthOfStay] || 0) + row.roomArrivals; });
  const shares = Object.fromEntries(Object.entries(volumes).map(([los, volume]) => [los, volume / selection.volume]));
  const sufficient = selection.volume >= config.minimumRoomArrivalSample && selection.distinct >= config.minimumDistinctArrivalDates;
  return { shares, sampleRoomArrivals: selection.volume, distinctArrivalDates: selection.distinct, tier: selection.tier, confidence: sufficient ? (selection.tier.startsWith("TIER_1") || selection.tier.startsWith("TIER_2") ? "HIGH" : "MEDIUM") : "LOW", warnings: sufficient ? [] : ["LOS_SAMPLE_BELOW_NORMAL_THRESHOLDS"] };
}

export function reconstructItineraries({ businessType, scenario, demandByDate, stayPattern, contributionByDate, settings = {} }) {
  const config = { ...LOS_NETWORK_DEFAULTS, ...settings }; const itineraries = []; const synthetic = {}; const mismatches = [];
  Object.keys(demandByDate).sort().forEach((arrivalDate) => {
    const demand = Math.max(0, Number(demandByDate[arrivalDate]) || 0); const carryover = synthetic[arrivalDate] || 0;
    if (carryover > demand + config.numericTolerance) mismatches.push({ stayDate: arrivalDate, carryover, demand, excess: carryover - demand });
    const arrivals = Math.max(0, demand - carryover); const distribution = selectLosDistribution(stayPattern, businessType, arrivalDate, config);
    Object.entries(distribution.shares).forEach(([losValue, share]) => {
      const lengthOfStay = Number(losValue), expectedRooms = arrivals * share;
      if (expectedRooms <= config.numericTolerance) return;
      const occupiedDates = datesBetween(arrivalDate, addDays(arrivalDate, lengthOfStay));
      const contributions = occupiedDates.map((d) => contributionByDate[d]);
      const itineraryContributionPerRoom = contributions.every(Number.isFinite) ? contributions.reduce((a, b) => a + b, 0) : null;
      const key = `${businessType}:${scenario}:${arrivalDate}:${lengthOfStay}`;
      itineraries.push({ key, businessType, scenario, arrivalDate, lengthOfStay, departureDate: addDays(arrivalDate, lengthOfStay), expectedRooms, occupiedDates, losTier: distribution.tier, losConfidence: distribution.confidence, itineraryContributionPerRoom, averageContributionPerRN: itineraryContributionPerRoom === null ? null : itineraryContributionPerRoom / lengthOfStay });
      occupiedDates.forEach((d) => { synthetic[d] = (synthetic[d] || 0) + expectedRooms; });
    });
  });
  const comparisonDates = Object.keys(demandByDate); const denominator = comparisonDates.reduce((s, d) => s + Math.max(0, Number(demandByDate[d]) || 0), 0); const absoluteError = comparisonDates.reduce((s, d) => s + Math.abs((synthetic[d] || 0) - Math.max(0, Number(demandByDate[d]) || 0)), 0);
  const wape = denominator ? absoluteError / denominator : 0;
  return { itineraries, syntheticOccupancy: synthetic, fit: { wape, passes: wape <= config.maximumNetworkOccupancyWape, carryoverMismatchCount: mismatches.length, mismatches } };
}

export function allocateItineraries(itineraries, capacityByDate, settings = {}) {
  const tolerance = ({ ...LOS_NETWORK_DEFAULTS, ...settings }).numericTolerance; const remaining = { ...capacityByDate }; const accepted = {};
  const ordered = itineraries.slice().sort((a, b) => {
    const av = a.averageContributionPerRN ?? -Infinity, bv = b.averageContributionPerRN ?? -Infinity;
    if (Math.abs(av - bv) > tolerance) return bv - av;
    if (a.businessType !== b.businessType) return a.businessType === "TRANSIENT" ? -1 : 1;
    return a.arrivalDate.localeCompare(b.arrivalDate) || a.lengthOfStay - b.lengthOfStay || a.key.localeCompare(b.key);
  });
  ordered.forEach((itinerary) => {
    const pathCapacity = Math.max(0, Math.min(...itinerary.occupiedDates.map((d) => Number(remaining[d]) || 0)));
    const rooms = Math.min(itinerary.expectedRooms, pathCapacity); accepted[itinerary.key] = rooms;
    itinerary.occupiedDates.forEach((d) => { remaining[d] = Math.max(0, (Number(remaining[d]) || 0) - rooms); });
  });
  return { accepted, remaining, orderedKeys: ordered.map((row) => row.key) };
}

export function calculateNetworkDisplacement({ itineraries, capacityWithoutGroup, requestedRoomsByDate, groupArrivalDate, groupCheckOutDate, legacyStayDateDisplacedRN = 0, settings = {} }) {
  const capacityWithGroup = Object.fromEntries(Object.entries(capacityWithoutGroup).map(([d, capacity]) => [d, Math.max(0, Number(capacity) - (Number(requestedRoomsByDate[d]) || 0))]));
  const without = allocateItineraries(itineraries, capacityWithoutGroup, settings), withGroup = allocateItineraries(itineraries, capacityWithGroup, settings);
  const byType = { TRANSIENT: { core: 0, shoulder: 0, lostContribution: 0 }, GROUP: { core: 0, shoulder: 0, lostContribution: 0 } };
  itineraries.forEach((itinerary) => {
    const displaced = Math.max(0, (without.accepted[itinerary.key] || 0) - (withGroup.accepted[itinerary.key] || 0));
    if (displaced <= ({ ...LOS_NETWORK_DEFAULTS, ...settings }).numericTolerance) return;
    const coreNights = itinerary.occupiedDates.filter((d) => d >= groupArrivalDate && d < groupCheckOutDate).length;
    byType[itinerary.businessType].core += displaced * coreNights;
    byType[itinerary.businessType].shoulder += displaced * (itinerary.lengthOfStay - coreNights);
    byType[itinerary.businessType].lostContribution += displaced * itinerary.itineraryContributionPerRoom;
  });
  const totalCoreDisplacedRN = byType.TRANSIENT.core + byType.GROUP.core, totalShoulderDisplacedRN = byType.TRANSIENT.shoulder + byType.GROUP.shoulder, totalNetworkDisplacedRN = totalCoreDisplacedRN + totalShoulderDisplacedRN;
  return { transientCoreDisplacedRN: byType.TRANSIENT.core, transientShoulderDisplacedRN: byType.TRANSIENT.shoulder, transientTotalDisplacedRN: byType.TRANSIENT.core + byType.TRANSIENT.shoulder, groupCoreDisplacedRN: byType.GROUP.core, groupShoulderDisplacedRN: byType.GROUP.shoulder, groupTotalDisplacedRN: byType.GROUP.core + byType.GROUP.shoulder, totalCoreDisplacedRN, totalShoulderDisplacedRN, totalNetworkDisplacedRN, legacyStayDateDisplacedRN, networkAdjustmentRN: totalNetworkDisplacedRN - legacyStayDateDisplacedRN, lostTransientContribution: byType.TRANSIENT.lostContribution, lostFutureGroupContribution: byType.GROUP.lostContribution };
}

export function buildLosNetworkSnapshot({ stayPattern, horizonDates, nightlyByDate, requestedRoomsByDate, groupArrivalDate, groupCheckOutDate, settings = {} }) {
  const config = { ...LOS_NETWORK_DEFAULTS, ...settings }; const scenarios = {};
  const reconciliationPasses = stayPattern?.reconciliation?.transient?.passes && stayPattern?.reconciliation?.group?.passes;
  const coveragePasses = stayPattern?.coverage?.TRANSIENT >= config.minimumModeledRoomArrivalCoverage && stayPattern?.coverage?.GROUP >= config.minimumModeledRoomArrivalCoverage;
  for (const scenario of ["low", "base", "high"]) {
    const transientDemand = {}, groupDemand = {}, transientValue = {}, groupValue = {}, capacity = {}; let inputsAvailable = true;
    horizonDates.forEach((d) => { const night = nightlyByDate[d]; if (!night || !Number.isFinite(night.sellableInventory) || !Number.isFinite(night.hardCommittedRooms)) inputsAvailable = false; else { transientDemand[d] = night.futureTransientDemand; groupDemand[d] = night[`futureGroupDemand${scenario[0].toUpperCase()}${scenario.slice(1)}`]; transientValue[d] = night.futureTransientContributionPerRoom; groupValue[d] = night.futureGroupContributionPerRoom; capacity[d] = Math.max(0, night.sellableInventory - night.hardCommittedRooms); } });
    const transient = reconstructItineraries({ businessType: "TRANSIENT", scenario: scenario.toUpperCase(), demandByDate: transientDemand, stayPattern, contributionByDate: transientValue, settings: config });
    const group = reconstructItineraries({ businessType: "GROUP", scenario: scenario.toUpperCase(), demandByDate: groupDemand, stayPattern, contributionByDate: groupValue, settings: config });
    const valuesAvailable = [...transient.itineraries, ...group.itineraries].every((row) => row.itineraryContributionPerRoom !== null);
    const legacy = Object.values(nightlyByDate).reduce((sum, n) => sum + Number(n.scenarios?.[scenario]?.totalDisplacedFutureRooms || 0), 0);
    const result = calculateNetworkDisplacement({ itineraries: [...transient.itineraries, ...group.itineraries], capacityWithoutGroup: capacity, requestedRoomsByDate, groupArrivalDate, groupCheckOutDate, legacyStayDateDisplacedRN: legacy, settings: config });
    scenarios[scenario] = { ...result, transientNetworkFit: transient.fit, groupNetworkFit: group.fit, inputsAvailable, valuesAvailable };
  }
  const fitPasses = ["low", "base", "high"].every((key) => scenarios[key].transientNetworkFit.passes && scenarios[key].groupNetworkFit.passes);
  const inputsPass = ["low", "base", "high"].every((key) => scenarios[key].inputsAvailable && scenarios[key].valuesAvailable);
  const active = Boolean(reconciliationPasses && coveragePasses && fitPasses && inputsPass);
  const fallbackReason = active ? null : !reconciliationPasses ? "LOS_NETWORK_VALIDATION_FAILED" : !coveragePasses ? "LOS_NETWORK_LOS_COVERAGE_FAILED" : !fitPasses ? "LOS_NETWORK_FIT_FAILED" : "LOS_NETWORK_REQUIRED_INPUT_UNAVAILABLE";
  return { modelVersion: LOS_DISPLACEMENT_MODEL_VERSION, stayPatternModelVersion: STAY_PATTERN_MODEL_VERSION, active, fallbackReason, warningCode: active ? null : "LOS_NETWORK_FALLBACK_TO_STAY_DATE", validation: { transientReconciliation: stayPattern?.reconciliation?.transient, groupReconciliation: stayPattern?.reconciliation?.group, modeledLosCoverage: stayPattern?.coverage, transientNetworkFit: scenarios.base.transientNetworkFit, groupNetworkFit: scenarios.base.groupNetworkFit }, settings: config, baseScenario: scenarios.base, lowScenario: scenarios.low, highScenario: scenarios.high, evidenceSummary: { selectedYears: stayPattern?.years || [], unclassifiedRateCodeCount: stayPattern?.quality?.unclassifiedRateCodeCount || 0, possibleShareRecords: stayPattern?.quality?.possibleShareRecords || 0 } };
}

export function applyLosNetworkOpportunityCost(contribution, snapshot) {
  if (!snapshot?.active) return { ...contribution, legacyStayDateDisplacement: contribution.scenarioTotals, losNetworkDisplacement: snapshot };
  const scenarioLookup = { low: snapshot.lowScenario, base: snapshot.baseScenario, high: snapshot.highScenario };
  const scenarioTotals = Object.fromEntries(Object.entries(scenarioLookup).map(([key, network]) => { const totalLostContribution = network.lostTransientContribution + network.lostFutureGroupContribution; const requiredNet = Math.max(0, totalLostContribution + contribution.groupVariableRoomCosts + contribution.groupBreakfastCosts - contribution.bqtContribution); const requiredGross = requiredNet / (1 - contribution.groupCommission); const floor = requiredGross / contribution.totalRequestedGroupRoomNights; return [key, { totalDisplacedRooms: network.totalNetworkDisplacedRN, displacedFutureTransientRooms: network.transientTotalDisplacedRN, displacedFutureGroupRooms: network.groupTotalDisplacedRN, lostFutureTransientContribution: network.lostTransientContribution, lostFutureGroupContribution: network.lostFutureGroupContribution, totalLostContribution, economicFloorRate: floor, requiredNet, requiredGross }]; }));
  const base = scenarioTotals.base;
  return { ...contribution, legacyStayDateDisplacement: contribution.scenarioTotals, losNetworkDisplacement: snapshot, scenarioTotals, totalDisplacedRooms: base.totalDisplacedRooms, totalLostContribution: base.totalLostContribution, totalLostFutureTransientContribution: base.lostFutureTransientContribution, totalLostFutureGroupContribution: base.lostFutureGroupContribution, requiredNetGroupRoomRevenue: base.requiredNet, requiredRoomRevenueAfterCostsExVat: base.requiredNet, requiredGrossGroupRoomRevenue: base.requiredGross, requiredCommissionableRoomRevenueExVat: base.requiredGross, economicFloorRate: base.economicFloorRate, economicFloorRateExVat: base.economicFloorRate, economicFloorRateInclVat: toRoomRateInclVat(base.economicFloorRate, contribution.roomVatPercentage), economicFloorLow: scenarioTotals.low.economicFloorRate, economicFloorBase: base.economicFloorRate, economicFloorHigh: scenarioTotals.high.economicFloorRate, economicFloorLowExVat: scenarioTotals.low.economicFloorRate, economicFloorBaseExVat: base.economicFloorRate, economicFloorHighExVat: scenarioTotals.high.economicFloorRate, economicFloorLowInclVat: toRoomRateInclVat(scenarioTotals.low.economicFloorRate, contribution.roomVatPercentage), economicFloorBaseInclVat: toRoomRateInclVat(base.economicFloorRate, contribution.roomVatPercentage), economicFloorHighInclVat: toRoomRateInclVat(scenarioTotals.high.economicFloorRate, contribution.roomVatPercentage) };
}
