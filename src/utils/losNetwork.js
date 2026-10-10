import { getBusinessSeason } from "./displacementForecast";
import { toRoomRateInclVat } from "./roomRateVat";
import { optimizeIntervalPortfolio, PORTFOLIO_POLICY } from "./intervalPortfolio";
import { buildYear, classifyRateCode as canonicalClassifyRateCode, normalizeStatus, normalizeReservation, RESERVATION_STATUS as canonicalStatuses, reconcileStayPattern as canonicalReconcile } from "../../functions/src/stayPatternPreparation.mjs";

export const STAY_PATTERN_MODEL_VERSION = "stay-pattern-v1";
export const LOS_DISPLACEMENT_MODEL_VERSION = "los-network-v2-optimal-portfolio";
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
const date = (value) => {
  if (!iso.test(String(value || ""))) return null;
  const result = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(result.getTime()) && result.toISOString().slice(0, 10) === value ? result : null;
};
export const addDays = (value, days) => {
  const parsed = date(value);
  if (!parsed || !Number.isFinite(days)) return null;
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
};
const datesBetween = (start, endExclusive) => {
  const output = [];
  for (let cursor = start; cursor && cursor < endExclusive; cursor = addDays(cursor, 1)) output.push(cursor);
  return output;
};

export const classifyRateCode = canonicalClassifyRateCode;

export const RESERVATION_STATUS = canonicalStatuses;

export const normalizeReservationStatus = normalizeStatus;
export function normalizeHistoricalReservation(raw = {}) {
  const row = normalizeReservation(raw);
  return { ...row, reservationId: raw.reservationNameId ?? raw.RESV_NAME_ID ?? null, lengthOfStay: row.los, numberOfRooms: row.rooms, exclusionReason: row.exclusionReason === "UNKNOWN" ? "UNKNOWN_STATUS" : row.exclusionReason };
}

export function buildStayPatternYear({ year, reservations = [], authoritativeByDate = {}, settings = {} }) {
  return buildYear(year, reservations, authoritativeByDate, settings);
}

export function reconcileStayPattern(reconstructed = {}, authoritativeByDate = {}, settings = {}) {
  return canonicalReconcile(reconstructed, authoritativeByDate, { ...LOS_NETWORK_DEFAULTS, ...settings });
}

export function combineStayPatternYears(yearModels = [], selectedYears = [], rootMetadata = null) {
  const chosen = yearModels.filter((model) => !selectedYears.length || selectedYears.includes(Number(model.year)));
  const selectedYearsComplete = selectedYears.length > 0 && selectedYears.every((year) => chosen.some((model) => Number(model.year) === Number(year)));
  const rootCurrent = rootMetadata?.modelVersion === STAY_PATTERN_MODEL_VERSION && rootMetadata.status === "VALID" && Number.isSafeInteger(rootMetadata.sourceRevision) && rootMetadata.sourceRevision >= 0 && rootMetadata.publishedSourceRevision === rootMetadata.sourceRevision && rootMetadata.publicationVersion === "stay-pattern-publication-v2" && rootMetadata.buildRunId && rootMetadata.latestCompletedBuildRunId === rootMetadata.buildRunId;
  const publicationVerified = Boolean(rootCurrent && selectedYearsComplete && chosen.every((model) => model.modelVersion === STAY_PATTERN_MODEL_VERSION && model.status === "VALID" && model.buildRunId && rootMetadata.publishedYearBuildRunIds?.[String(model.year)] === model.buildRunId));
  const publicationFallbackReason = publicationVerified ? null : !rootMetadata ? "STAY_PATTERN_ROOT_UNAVAILABLE" : rootMetadata.status !== "VALID" ? `STAY_PATTERN_ROOT_${rootMetadata.status || "UNAVAILABLE"}` : "STAY_PATTERN_PUBLICATION_MISMATCH";
  const observations = { TRANSIENT: [], GROUP: [] };
  chosen.forEach((model) => Object.keys(observations).forEach((type) => observations[type].push(...(model.types?.[type]?.observations || []))));
  const reconciliation = Object.fromEntries(["transient", "group"].map((type) => {
    const parts = chosen.map((model) => model.reconciliation?.[type]).filter(Boolean);
    const sum = (field) => parts.reduce((total, row) => total + Number(row[field] || 0), 0);
    const comparedDates = sum("comparedDates"), invalidDateCount = sum("invalidDateCount"), authoritativeRooms = sum("authoritativeRooms"), reconstructedRooms = sum("reconstructedRooms"), sumAbsoluteError = sum("sumAbsoluteError"), signedErrorRooms = sum("signedErrorRooms"), matchingDates = sum("matchingDates");
    const absoluteErrors = parts.flatMap((row) => row.absoluteErrors || []).sort((a, b) => a - b);
    const medianAbsoluteError = !absoluteErrors.length ? null : absoluteErrors.length % 2 ? absoluteErrors[(absoluteErrors.length - 1) / 2] : (absoluteErrors[absoluteErrors.length / 2 - 1] + absoluteErrors[absoluteErrors.length / 2]) / 2;
    const matchingDateShare = comparedDates ? matchingDates / comparedDates : null, wape = authoritativeRooms ? sumAbsoluteError / authoritativeRooms : null;
    return [type, { comparedDates, invalidDateCount, authoritativeRooms, reconstructedRooms, sumAbsoluteError, signedErrorRooms, signedAggregateBias: signedErrorRooms, matchingDates, absoluteErrors, meanAbsoluteError: comparedDates ? sumAbsoluteError / comparedDates : null, medianAbsoluteError, wape, matchingDateShare, passes: publicationVerified && invalidDateCount === 0 && parts.every((part) => part.passes !== false) && comparedDates > 0 && matchingDateShare >= LOS_NETWORK_DEFAULTS.minimumMatchingDateShare && wape !== null && wape <= LOS_NETWORK_DEFAULTS.maximumWape }];
  }));
  reconciliation.invalidDates = chosen.flatMap((model) => (model.reconciliation?.invalidDates || []).map((row) => ({ year: model.year, ...row })));
  const coverage = Object.fromEntries(["TRANSIENT", "GROUP"].map((type) => { const modeled = chosen.reduce((s, m) => s + Number(m.types?.[type]?.modeledRoomArrivals || 0), 0); const long = chosen.reduce((s, m) => s + Number(m.types?.[type]?.longStayRoomArrivals || 0), 0); return [type, modeled + long ? modeled / (modeled + long) : 0]; }));
  return { modelVersion: STAY_PATTERN_MODEL_VERSION, years: chosen.map((model) => model.year), selectedYearsComplete, publicationVerified, publicationFallbackReason, publicationEvidence: { publicationVersion: rootMetadata?.publicationVersion || null, sourceRevision: rootMetadata?.sourceRevision ?? null, publishedSourceRevision: rootMetadata?.publishedSourceRevision ?? null, rootStatus: rootMetadata?.status || null, buildRunId: rootMetadata?.buildRunId || null, latestCompletedBuildRunId: rootMetadata?.latestCompletedBuildRunId || null, selectedYearBuildRunIds: Object.fromEntries(chosen.map((model) => [String(model.year), model.buildRunId || null])) }, observations, reconciliation, coverage, quality: { possibleShareRecords: chosen.reduce((s, m) => s + Number(m.quality?.possibleShareRecords || 0), 0), unclassifiedRateCodeCount: chosen.reduce((s, m) => s + Number(m.quality?.unclassifiedRateCodeCount || 0), 0) } };
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

export function createLosNetworkHorizon({ groupArrivalDate, groupCheckOutDate, maxModeledLos = LOS_NETWORK_DEFAULTS.maxModeledLos }) {
  if (!date(groupArrivalDate) || !date(groupCheckOutDate) || groupArrivalDate >= groupCheckOutDate || !Number.isInteger(maxModeledLos) || maxModeledLos < 1 || maxModeledLos > 14) return { horizonDates: [], valuationDates: [] };
  const start = addDays(groupArrivalDate, -2 * maxModeledLos), end = addDays(groupCheckOutDate, 2 * maxModeledLos);
  return { horizonDates: datesBetween(start, end), valuationDates: datesBetween(start, addDays(end, maxModeledLos - 1)) };
}

export function allocateItineraries(itineraries, capacityByDate, settings = {}) {
  return optimizeIntervalPortfolio(itineraries, capacityByDate, settings);
}

export function calculateNetworkDisplacement({ itineraries, capacityWithoutGroup, requestedRoomsByDate, groupArrivalDate, groupCheckOutDate, legacyStayDateDisplacedRN = 0, settings = {} }) {
  const tolerance = ({ ...LOS_NETWORK_DEFAULTS, ...settings }).numericTolerance;
  if (!Array.isArray(itineraries) || itineraries.some((row) => !["TRANSIENT", "GROUP"].includes(row?.businessType))) return { status: "UNAVAILABLE", reason: "LOS_NETWORK_INVALID_ITINERARY" };
  if (Object.entries(requestedRoomsByDate).some(([d, rooms]) => !Number.isFinite(rooms) || rooms < 0 || !Number.isFinite(capacityWithoutGroup[d]) || rooms > capacityWithoutGroup[d] + tolerance)) return { status: "UNAVAILABLE", reason: "LOS_NETWORK_PHYSICAL_CAPACITY" };
  const capacityWithGroup = Object.fromEntries(Object.entries(capacityWithoutGroup).map(([d, capacity]) => [d, capacity - (requestedRoomsByDate[d] || 0)]));
  const without = allocateItineraries(itineraries, capacityWithoutGroup, settings), withGroup = allocateItineraries(itineraries, capacityWithGroup, settings);
  if (without.status !== "OPTIMAL" || withGroup.status !== "OPTIMAL") return { status: "UNAVAILABLE", reason: without.reason || withGroup.reason, portfolioWithoutGroup: without, portfolioWithGroup: withGroup };
  const byType = { TRANSIENT: { core: 0, shoulder: 0, grossLostContribution: 0, replacementContribution: 0, netLostContribution: 0 }, GROUP: { core: 0, shoulder: 0, grossLostContribution: 0, replacementContribution: 0, netLostContribution: 0 } };
  itineraries.forEach((itinerary) => {
    const difference = without.accepted[itinerary.key] - withGroup.accepted[itinerary.key];
    const displaced = Math.max(0, difference), replacement = Math.max(0, -difference);
    const coreNights = itinerary.occupiedDates.filter((d) => d >= groupArrivalDate && d < groupCheckOutDate).length;
    const type = byType[itinerary.businessType];
    type.core += displaced * coreNights;
    type.shoulder += displaced * (itinerary.occupiedDates.length - coreNights);
    type.grossLostContribution += displaced * itinerary.itineraryContributionPerRoom;
    type.replacementContribution += replacement * itinerary.itineraryContributionPerRoom;
    type.netLostContribution += difference * itinerary.itineraryContributionPerRoom;
  });
  const totalCoreDisplacedRN = byType.TRANSIENT.core + byType.GROUP.core, totalShoulderDisplacedRN = byType.TRANSIENT.shoulder + byType.GROUP.shoulder, totalNetworkDisplacedRN = totalCoreDisplacedRN + totalShoulderDisplacedRN;
  return { status: "OPTIMAL", optimizationPolicy: PORTFOLIO_POLICY, portfolioWithoutGroup: without, portfolioWithGroup: withGroup, totalLostContribution: without.portfolioValue - withGroup.portfolioValue, grossLostContribution: byType.TRANSIENT.grossLostContribution + byType.GROUP.grossLostContribution, replacementContribution: byType.TRANSIENT.replacementContribution + byType.GROUP.replacementContribution, transientCoreDisplacedRN: byType.TRANSIENT.core, transientShoulderDisplacedRN: byType.TRANSIENT.shoulder, transientTotalDisplacedRN: byType.TRANSIENT.core + byType.TRANSIENT.shoulder, groupCoreDisplacedRN: byType.GROUP.core, groupShoulderDisplacedRN: byType.GROUP.shoulder, groupTotalDisplacedRN: byType.GROUP.core + byType.GROUP.shoulder, totalCoreDisplacedRN, totalShoulderDisplacedRN, totalNetworkDisplacedRN, legacyStayDateDisplacedRN, networkAdjustmentRN: totalNetworkDisplacedRN - legacyStayDateDisplacedRN, lostTransientContribution: byType.TRANSIENT.netLostContribution, lostFutureGroupContribution: byType.GROUP.netLostContribution, grossLostTransientContribution: byType.TRANSIENT.grossLostContribution, grossLostFutureGroupContribution: byType.GROUP.grossLostContribution, replacementTransientContribution: byType.TRANSIENT.replacementContribution, replacementFutureGroupContribution: byType.GROUP.replacementContribution };
}

export function buildLosNetworkSnapshot({ stayPattern, horizonDates = [], valuationDates = [], nightlyByDate = {}, requestedRoomsByDate = {}, groupArrivalDate, groupCheckOutDate, settings = {} }) {
  const config = { ...LOS_NETWORK_DEFAULTS, ...settings }; const scenarios = {};
  const reconciliationPasses = stayPattern?.reconciliation?.transient?.passes && stayPattern?.reconciliation?.group?.passes;
  const coveragePasses = stayPattern?.coverage?.TRANSIENT >= config.minimumModeledRoomArrivalCoverage && stayPattern?.coverage?.GROUP >= config.minimumModeledRoomArrivalCoverage;
  const knownNonNegative = (v) => Number.isFinite(v) && v >= 0;
  const request = Object.entries(requestedRoomsByDate);
  const requestedRN = request.reduce((sum, [, rooms]) => sum + (knownNonNegative(rooms) ? rooms : 0), 0);
  const physicalConflict = request.some(([d, rooms]) => {
    const n = nightlyByDate[d];
    return knownNonNegative(rooms) && n && knownNonNegative(n.sellableInventory) && knownNonNegative(n.hardCommittedRooms) && rooms > Math.max(0, n.sellableInventory - n.hardCommittedRooms) + config.numericTolerance;
  });
  for (const scenario of ["low", "base", "high"]) {
    const transientDemand = {}, groupDemand = {}, transientValue = {}, groupValue = {}, capacity = {}; let inputsAvailable = horizonDates.length > 0 && request.every(([d, rooms]) => knownNonNegative(rooms) && horizonDates.includes(d));
    horizonDates.forEach((d) => {
      const night = nightlyByDate[d];
      const group = night?.[`futureGroupDemand${scenario[0].toUpperCase()}${scenario.slice(1)}`];
      if (!night || night.requiredInputsAvailable === false || !knownNonNegative(night.futureTransientDemand) || !knownNonNegative(group)) inputsAvailable = false;
      else { transientDemand[d] = night.futureTransientDemand; groupDemand[d] = group; }
    });
    Object.entries(nightlyByDate).forEach(([d, n]) => { transientValue[d] = n.futureTransientContributionPerRoom; groupValue[d] = n.futureGroupContributionPerRoom; });
    const transient = reconstructItineraries({ businessType: "TRANSIENT", scenario: scenario.toUpperCase(), demandByDate: transientDemand, stayPattern, contributionByDate: transientValue, settings: config });
    const group = reconstructItineraries({ businessType: "GROUP", scenario: scenario.toUpperCase(), demandByDate: groupDemand, stayPattern, contributionByDate: groupValue, settings: config });
    const itineraries = [...transient.itineraries, ...group.itineraries];
    const requiredDates = [...new Set([...horizonDates, ...itineraries.flatMap((row) => row.occupiedDates)])].sort();
    requiredDates.forEach((d) => {
      const n = nightlyByDate[d];
      if (!n || n.requiredInputsAvailable === false || !knownNonNegative(n.sellableInventory) || !knownNonNegative(n.hardCommittedRooms)) inputsAvailable = false;
      else capacity[d] = Math.max(0, n.sellableInventory - n.hardCommittedRooms);
    });
    const valuesAvailable = itineraries.every((row) => Number.isFinite(row.itineraryContributionPerRoom));
    const legacy = Object.entries(nightlyByDate).filter(([d]) => d >= groupArrivalDate && d < groupCheckOutDate).reduce((sum, [, n]) => sum + Number(n.scenarios?.[scenario]?.totalDisplacedFutureRooms || 0), 0);
    const result = inputsAvailable && valuesAvailable ? calculateNetworkDisplacement({ itineraries, capacityWithoutGroup: capacity, requestedRoomsByDate, groupArrivalDate, groupCheckOutDate, legacyStayDateDisplacedRN: legacy, settings: config }) : { status: "UNAVAILABLE", reason: "LOS_NETWORK_REQUIRED_INPUT_UNAVAILABLE" };
    const compactPortfolio = (portfolio) => portfolio ? { status: portfolio.status, reason: portfolio.reason || null, portfolioValue: portfolio.portfolioValue ?? null, solverVersion: portfolio.solverVersion, policy: portfolio.policy || PORTFOLIO_POLICY, diagnostics: portfolio.diagnostics || null } : null;
    scenarios[scenario] = { ...result, portfolioWithoutGroup: compactPortfolio(result.portfolioWithoutGroup), portfolioWithGroup: compactPortfolio(result.portfolioWithGroup), transientNetworkFit: transient.fit, groupNetworkFit: group.fit, inputsAvailable, valuesAvailable, requiredValuationDates: requiredDates };
  }
  const fitPasses = ["low", "base", "high"].every((key) => scenarios[key].transientNetworkFit.passes && scenarios[key].groupNetworkFit.passes);
  const inputsPass = ["low", "base", "high"].every((key) => scenarios[key].inputsAvailable && scenarios[key].valuesAvailable);
  const optimizationPasses = ["low", "base", "high"].every((key) => scenarios[key].status === "OPTIMAL");
  const active = Boolean(requestedRN > 0 && !physicalConflict && reconciliationPasses && coveragePasses && fitPasses && inputsPass && optimizationPasses);
  const fallbackReason = active ? null : physicalConflict ? "LOS_NETWORK_PHYSICAL_CAPACITY" : requestedRN <= 0 ? "LOS_NETWORK_NO_REQUESTED_ROOM_NIGHTS" : stayPattern?.publicationVerified === false ? stayPattern.publicationFallbackReason || "LOS_NETWORK_PUBLICATION_UNAVAILABLE" : !reconciliationPasses ? "LOS_NETWORK_VALIDATION_FAILED" : !coveragePasses ? "LOS_NETWORK_LOS_COVERAGE_FAILED" : !inputsPass ? "LOS_NETWORK_REQUIRED_INPUT_UNAVAILABLE" : !fitPasses ? "LOS_NETWORK_FIT_FAILED" : scenarios.base.reason || scenarios.low.reason || scenarios.high.reason || "LOS_NETWORK_OPTIMIZATION_FAILED";
  return { modelVersion: LOS_DISPLACEMENT_MODEL_VERSION, optimizationPolicy: PORTFOLIO_POLICY, stayPatternModelVersion: STAY_PATTERN_MODEL_VERSION, active, fallbackReason, warningCode: active ? null : "LOS_NETWORK_FALLBACK_TO_STAY_DATE", horizonDates, valuationDates, validation: { transientReconciliation: stayPattern?.reconciliation?.transient, groupReconciliation: stayPattern?.reconciliation?.group, invalidAuthoritativeDates: stayPattern?.reconciliation?.invalidDates || [], modeledLosCoverage: stayPattern?.coverage, transientNetworkFit: scenarios.base.transientNetworkFit, groupNetworkFit: scenarios.base.groupNetworkFit, optimizationPasses }, settings: config, baseScenario: scenarios.base, lowScenario: scenarios.low, highScenario: scenarios.high, evidenceSummary: { publication: stayPattern?.publicationEvidence || null, selectedYears: stayPattern?.years || [], unclassifiedRateCodeCount: stayPattern?.quality?.unclassifiedRateCodeCount || 0, possibleShareRecords: stayPattern?.quality?.possibleShareRecords || 0 } };
}

export function applyLosNetworkOpportunityCost(contribution, snapshot) {
  const unavailable = contribution.economicFloorUnavailableReason || !Number.isFinite(contribution.totalLostContribution) || !(contribution.totalRequestedGroupRoomNights > 0) || contribution.nightly?.some((night) => night.capacityConflictRooms > 0 || night.requiredInputsAvailable === false);
  if (unavailable && snapshot?.active) snapshot = { ...snapshot, active: false, fallbackReason: "LOS_NETWORK_CONTRIBUTION_GUARD", warningCode: "LOS_NETWORK_FALLBACK_TO_STAY_DATE" };
  if (!snapshot?.active) return { ...contribution, legacyStayDateDisplacement: contribution.scenarioTotals, losNetworkDisplacement: snapshot };
  const scenarioLookup = { low: snapshot.lowScenario, base: snapshot.baseScenario, high: snapshot.highScenario };
  const scenarioTotals = Object.fromEntries(Object.entries(scenarioLookup).map(([key, network]) => { const totalLostContribution = network.totalLostContribution ?? (network.lostTransientContribution + network.lostFutureGroupContribution); const requiredNet = Math.max(0, totalLostContribution + contribution.groupVariableRoomCosts + contribution.groupBreakfastCosts - contribution.bqtContribution); const requiredGross = requiredNet / (1 - contribution.groupCommission); const floor = requiredGross / contribution.totalRequestedGroupRoomNights; return [key, { totalDisplacedRooms: network.totalNetworkDisplacedRN, displacedFutureTransientRooms: network.transientTotalDisplacedRN, displacedFutureGroupRooms: network.groupTotalDisplacedRN, lostFutureTransientContribution: network.lostTransientContribution, lostFutureGroupContribution: network.lostFutureGroupContribution, totalLostContribution, economicFloorRate: floor, requiredNet, requiredGross }]; }));
  const base = scenarioTotals.base;
  return { ...contribution, legacyStayDateDisplacement: contribution.scenarioTotals, losNetworkDisplacement: snapshot, scenarioTotals, totalDisplacedRooms: base.totalDisplacedRooms, totalLostContribution: base.totalLostContribution, totalLostFutureTransientContribution: base.lostFutureTransientContribution, totalLostFutureGroupContribution: base.lostFutureGroupContribution, requiredNetGroupRoomRevenue: base.requiredNet, requiredRoomRevenueAfterCostsExVat: base.requiredNet, requiredGrossGroupRoomRevenue: base.requiredGross, requiredCommissionableRoomRevenueExVat: base.requiredGross, economicFloorRate: base.economicFloorRate, economicFloorRateExVat: base.economicFloorRate, economicFloorRateInclVat: toRoomRateInclVat(base.economicFloorRate, contribution.roomVatPercentage), economicFloorLow: scenarioTotals.low.economicFloorRate, economicFloorBase: base.economicFloorRate, economicFloorHigh: scenarioTotals.high.economicFloorRate, economicFloorLowExVat: scenarioTotals.low.economicFloorRate, economicFloorBaseExVat: base.economicFloorRate, economicFloorHighExVat: scenarioTotals.high.economicFloorRate, economicFloorLowInclVat: toRoomRateInclVat(scenarioTotals.low.economicFloorRate, contribution.roomVatPercentage), economicFloorBaseInclVat: toRoomRateInclVat(base.economicFloorRate, contribution.roomVatPercentage), economicFloorHighInclVat: toRoomRateInclVat(scenarioTotals.high.economicFloorRate, contribution.roomVatPercentage) };
}
