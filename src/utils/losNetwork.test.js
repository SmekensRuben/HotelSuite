import { describe, expect, it } from "vitest";
import {
  allocateItineraries,
  applyLosNetworkOpportunityCost,
  buildStayPatternYear,
  buildLosNetworkSnapshot,
  calculateNetworkDisplacement,
  classifyRateCode,
  combineStayPatternYears,
  normalizeHistoricalReservation,
  reconstructItineraries,
  selectLosDistribution,
  createLosNetworkHorizon,
} from "./losNetwork";

const reservation = (overrides = {}) => ({ reservationNameId: "1", arrivalDate: "2026-03-01", departureDate: "2026-03-04", nights: 3, numberOfRooms: 2, reservationStatus: "CHECKED OUT", rateCode: "12RMOC", ...overrides });

describe("stay pattern training", () => {
  it.each([["12RMOC", "TRANSIENT"], ["34SYCH", "TRANSIENT"], ["9ABC", "GROUP"], ["CORP", "GROUP"], ["GRP123", "GROUP"], ["NORATE", "EXCLUDED_POSTMASTER"], ["", "UNCLASSIFIED"]])("classifies %j solely from rate code", (input, expected) => expect(classifyRateCode(input)).toBe(expected));

  it("accepts only centralized realized statuses and validates dates against nights", () => {
    expect(normalizeHistoricalReservation(reservation()).exclusionReason).toBeNull();
    expect(normalizeHistoricalReservation(reservation({ reservationStatus: "CANCELLED" })).exclusionReason).toBe("CANCELLED");
    expect(normalizeHistoricalReservation(reservation({ reservationStatus: "mystery" })).exclusionReason).toBe("UNKNOWN_STATUS");
    expect(normalizeHistoricalReservation(reservation({ nights: 4 })).exclusionReason).toBe("NIGHTS_DATE_MISMATCH");
  });

  it("excludes cancelled and NORATE records and expands checkout-exclusive room volume", () => {
    const model = buildStayPatternYear({ year: 2026, reservations: [reservation(), reservation({ reservationNameId: "2", reservationStatus: "CANCELLED" }), reservation({ reservationNameId: "3", rateCode: "NORATE", nights: 10, departureDate: "2026-03-11" })], authoritativeByDate: { "2026-03-01": { individualRooms: 2, groupRooms: 0 }, "2026-03-02": { individualRooms: 2, groupRooms: 0 }, "2026-03-03": { individualRooms: 2, groupRooms: 0 }, "2026-03-04": { individualRooms: 0, groupRooms: 0 } } });
    expect(model.types.TRANSIENT.modeledRoomArrivals).toBe(2);
    expect(model.quality.exclusions).toMatchObject({ CANCELLED: 1, EXCLUDED_POSTMASTER: 1 });
    expect(model.reconciliation.transient).toMatchObject({ wape: 0, matchingDateShare: 1, passes: true });
  });

  it("reconciles transient and group room counts exactly", () => {
    const model = buildStayPatternYear({ year: 2026, reservations: [reservation({ numberOfRooms: 20, nights: 1, departureDate: "2026-03-02" }), reservation({ reservationNameId: "2", rateCode: "GRP", numberOfRooms: 10, nights: 1, departureDate: "2026-03-02" })], authoritativeByDate: { "2026-03-01": { individualRooms: 20, groupRooms: 10 } } });
    expect(model.reconciliation.transient.passes).toBe(true);
    expect(model.reconciliation.group.passes).toBe(true);
  });

  it("weights LOS shares by rooms rather than reservations", () => {
    const year = buildStayPatternYear({ year: 2026, reservations: [reservation({ numberOfRooms: 1, nights: 2, departureDate: "2026-03-03" }), reservation({ reservationNameId: "2", numberOfRooms: 5 })] });
    const distribution = selectLosDistribution(combineStayPatternYears([year], [2026]), "TRANSIENT", "2027-03-01", { minimumRoomArrivalSample: 1, minimumDistinctArrivalDates: 1 });
    expect(distribution.shares).toEqual({ 2: 1 / 6, 3: 5 / 6 });
  });

  it("fails activation reconciliation thresholds factually", () => {
    const model = buildStayPatternYear({ year: 2026, reservations: [reservation({ numberOfRooms: 1 })], authoritativeByDate: { "2026-03-01": { individualRooms: 20, groupRooms: 10 } } });
    expect(model.reconciliation.transient.passes).toBe(false);
    expect(model.reconciliation.group.passes).toBe(false);
  });

  it("combines reconciliation from additive totals and fails when a selected annual model is missing", () => {
    const first = buildStayPatternYear({ year: 2025, reservations: [reservation({ arrivalDate: "2025-03-01", departureDate: "2025-03-04" })], authoritativeByDate: { "2025-03-01": { individualRooms: 2, groupRooms: 0 }, "2025-03-02": { individualRooms: 2, groupRooms: 0 }, "2025-03-03": { individualRooms: 2, groupRooms: 0 } } });
    const combined = combineStayPatternYears([first], [2025, 2024]);
    expect(combined.selectedYearsComplete).toBe(false);
    expect(combined.reconciliation.transient).toMatchObject({ authoritativeRooms: 6, reconstructedRooms: 6, sumAbsoluteError: 0, passes: false });
  });
});

describe("LOS itinerary network", () => {
  const itinerary = { key: "T:1", businessType: "TRANSIENT", scenario: "BASE", arrivalDate: "2026-03-01", departureDate: "2026-03-05", lengthOfStay: 4, expectedRooms: 10, occupiedDates: ["2026-03-01", "2026-03-02", "2026-03-03", "2026-03-04"], averageContributionPerRN: 105, itineraryContributionPerRoom: 420 };

  it("requires capacity across a complete path", () => {
    const result = allocateItineraries([itinerary], { "2026-03-01": 10, "2026-03-02": 4, "2026-03-03": 10, "2026-03-04": 10 });
    expect(result.accepted["T:1"]).toBe(4);
    expect(result.remaining["2026-03-01"]).toBe(6);
  });

  it("splits displaced complete paths into core and shoulder nights and values the full path", () => {
    const result = calculateNetworkDisplacement({ itineraries: [itinerary], capacityWithoutGroup: Object.fromEntries(itinerary.occupiedDates.map((d) => [d, 10])), requestedRoomsByDate: { "2026-03-02": 10, "2026-03-03": 10 }, groupArrivalDate: "2026-03-02", groupCheckOutDate: "2026-03-04" });
    expect(result).toMatchObject({ transientCoreDisplacedRN: 20, transientShoulderDisplacedRN: 20, totalNetworkDisplacedRN: 40, lostTransientContribution: 4200 });
  });

  it("calculates full-path contribution for fractional displaced rooms", () => {
    const twoRooms = { ...itinerary, expectedRooms: 2, itineraryContributionPerRoom: 100 + 110 + 120 + 90 };
    const result = calculateNetworkDisplacement({ itineraries: [twoRooms], capacityWithoutGroup: Object.fromEntries(itinerary.occupiedDates.map((d) => [d, 2])), requestedRoomsByDate: { "2026-03-02": 2 }, groupArrivalDate: "2026-03-02", groupCheckOutDate: "2026-03-03" });
    expect(result.lostTransientContribution).toBe(840);
  });

  it("deconvolves only supplied forecast demand without adding historical sample volume", () => {
    const stayPattern = { observations: { TRANSIENT: [{ arrivalDate: "2025-03-03", dayOfWeek: 1, month: 3, businessSeason: "SPRING_BUSINESS", lengthOfStay: 1, roomArrivals: 1000 }], GROUP: [] } };
    const result = reconstructItineraries({ businessType: "TRANSIENT", scenario: "BASE", demandByDate: { "2026-03-02": 20, "2026-03-03": 20, "2026-03-04": 10 }, stayPattern, contributionByDate: { "2026-03-02": 1, "2026-03-03": 1, "2026-03-04": 1 }, settings: { minimumRoomArrivalSample: 1, minimumDistinctArrivalDates: 1 } });
    expect(result.itineraries.reduce((sum, row) => sum + row.expectedRooms, 0)).toBe(50);
    expect(result.syntheticOccupancy).toEqual({ "2026-03-02": 20, "2026-03-03": 20, "2026-03-04": 10 });
  });

  it("supports independent future group shoulder displacement", () => {
    const group = { ...itinerary, key: "G:1", businessType: "GROUP", expectedRooms: 20, lengthOfStay: 3, departureDate: "2026-03-04", occupiedDates: ["2026-03-01", "2026-03-02", "2026-03-03"], itineraryContributionPerRoom: 300, averageContributionPerRN: 100 };
    const result = calculateNetworkDisplacement({ itineraries: [group], capacityWithoutGroup: { "2026-03-01": 20, "2026-03-02": 20, "2026-03-03": 20 }, requestedRoomsByDate: { "2026-03-02": 20 }, groupArrivalDate: "2026-03-02", groupCheckOutDate: "2026-03-03" });
    expect(result).toMatchObject({ groupCoreDisplacedRN: 20, groupShoulderDisplacedRN: 40 });
  });

  it("replaces rather than adds legacy opportunity cost, and preserves fallback", () => {
    const legacy = { scenarioTotals: { low: { totalLostContribution: 100 }, base: { totalLostContribution: 100 }, high: { totalLostContribution: 100 } }, totalLostContribution: 100, totalRequestedGroupRoomNights: 10, groupVariableRoomCosts: 0, groupBreakfastCosts: 0, bqtContribution: 0, groupCommission: 0, roomVatPercentage: 0 };
    expect(applyLosNetworkOpportunityCost(legacy, { active: false }).totalLostContribution).toBe(100);
    const network = { active: true, lowScenario: { totalNetworkDisplacedRN: 2, transientTotalDisplacedRN: 2, groupTotalDisplacedRN: 0, lostTransientContribution: 30, lostFutureGroupContribution: 0 }, baseScenario: { totalNetworkDisplacedRN: 3, transientTotalDisplacedRN: 2, groupTotalDisplacedRN: 1, lostTransientContribution: 30, lostFutureGroupContribution: 20 }, highScenario: { totalNetworkDisplacedRN: 4, transientTotalDisplacedRN: 2, groupTotalDisplacedRN: 2, lostTransientContribution: 30, lostFutureGroupContribution: 40 } };
    const active = applyLosNetworkOpportunityCost(legacy, network);
    expect(active.totalLostContribution).toBe(50);
    expect(active.economicFloorRateExVat).toBe(5);
  });

  it("includes replacement gains in signed portfolio opportunity cost", () => {
    const a = { ...itinerary, key: "A", expectedRooms: 1, lengthOfStay: 2, occupiedDates: ["2026-03-01", "2026-03-02"], itineraryContributionPerRoom: 400 };
    const b = { ...a, key: "B", businessType: "GROUP", lengthOfStay: 1, occupiedDates: ["2026-03-02"], itineraryContributionPerRoom: 100 };
    const result = calculateNetworkDisplacement({ itineraries: [a, b], capacityWithoutGroup: { "2026-03-01": 1, "2026-03-02": 1 }, requestedRoomsByDate: { "2026-03-01": 1 }, groupArrivalDate: "2026-03-01", groupCheckOutDate: "2026-03-02" });
    expect(result).toMatchObject({ totalLostContribution: 300, grossLostContribution: 400, replacementContribution: 100, lostTransientContribution: 400, lostFutureGroupContribution: -100 });
    expect(result.portfolioWithGroup.portfolioValue).toBe(100);
  });
});

describe("LOS horizon and independent contribution guards", () => {
  const dates = ["2027-03-01", "2027-03-02", "2027-03-03"];
  const model = { reconciliation: { transient: { passes: true }, group: { passes: true } }, coverage: { TRANSIENT: 1, GROUP: 1 }, observations: { TRANSIENT: [{ arrivalDate: "2026-03-01", dayOfWeek: 0, month: 3, businessSeason: "SPRING_BUSINESS", lengthOfStay: 2, roomArrivals: 1 }], GROUP: [] } };
  const night = (demand) => ({ sellableInventory: 10, hardCommittedRooms: 0, futureTransientDemand: demand, futureGroupDemandLow: 0, futureGroupDemandBase: 0, futureGroupDemandHigh: 0, futureTransientContributionPerRoom: 100, futureGroupContributionPerRoom: null });
  const snapshot = (overrides = {}) => buildLosNetworkSnapshot({ stayPattern: model, horizonDates: dates.slice(0, 2), valuationDates: dates, nightlyByDate: { [dates[0]]: night(1), [dates[1]]: night(2), [dates[2]]: night(0) }, requestedRoomsByDate: { [dates[0]]: 1 }, groupArrivalDate: dates[0], groupCheckOutDate: dates[1], settings: { minimumRoomArrivalSample: 1, minimumDistinctArrivalDates: 1 }, ...overrides });

  it("values the final core arrival through its complete tail without generating tail arrivals", () => {
    const result = snapshot();
    expect(result.active).toBe(true); expect(result.baseScenario.requiredValuationDates).toEqual(dates);
    expect(result.baseScenario.transientNetworkFit.wape).toBe(0);
  });

  it("fails genuine missing shoulder values and capacity", () => {
    const result = snapshot({ nightlyByDate: { [dates[0]]: night(1), [dates[1]]: night(2) } });
    expect(result.active).toBe(false); expect(result.fallbackReason).toBe("LOS_NETWORK_REQUIRED_INPUT_UNAVAILABLE");
  });

  it("does not require unused artificial tail dates", () => {
    const result = snapshot({ nightlyByDate: { [dates[0]]: night(1), [dates[1]]: night(1) } });
    expect(result.active).toBe(true); expect(result.baseScenario.requiredValuationDates).toEqual(dates.slice(0, 2));
  });

  it("refuses a request of 20 with only 10 available rooms", () => {
    const result = snapshot({ requestedRoomsByDate: { [dates[0]]: 20 } });
    expect(result.active).toBe(false); expect(result.fallbackReason).toBe("LOS_NETWORK_PHYSICAL_CAPACITY");
  });

  it("fails zero room nights and bounded solver failure explicitly", () => {
    expect(snapshot({ requestedRoomsByDate: { [dates[0]]: 0 } }).fallbackReason).toBe("LOS_NETWORK_NO_REQUESTED_ROOM_NIGHTS");
    expect(snapshot({ settings: { maxResidualRelaxations: 0 } })).toMatchObject({ active: false, fallbackReason: "SOLVER_WORK_LIMIT" });
  });

  it.each(["ECONOMIC_FLOOR_UNAVAILABLE_PHYSICAL_CAPACITY", "ECONOMIC_FLOOR_UNAVAILABLE_NO_REQUESTED_ROOM_NIGHTS", "ECONOMIC_FLOOR_UNAVAILABLE_CONTRIBUTION_VALUE"])("active LOS cannot override %s", (economicFloorUnavailableReason) => {
    const contribution = { economicFloorUnavailableReason, economicFloorRate: null, economicFloorRateInclVat: null, totalRequestedGroupRoomNights: 20, scenarioTotals: {}, totalLostContribution: null };
    const result = applyLosNetworkOpportunityCost(contribution, snapshot());
    expect(result.economicFloorRate).toBeNull(); expect(result.losNetworkDisplacement.active).toBe(false);
  });

  it("constructs a bounded core and max-LOS complete valuation tail", () => {
    const result = createLosNetworkHorizon({ groupArrivalDate: "2027-03-01", groupCheckOutDate: "2027-03-03", maxModeledLos: 2 });
    expect(result.horizonDates).toHaveLength(10); expect(result.valuationDates).toHaveLength(11);
    expect(result.valuationDates.at(-1)).toBe("2027-03-07");
  });

  it("requires matching current root publication evidence for otherwise valid annual models", () => {
    const year = { ...buildStayPatternYear({ year: 2026, reservations: [reservation({ numberOfRooms: 2, nights: 1, departureDate: "2026-03-02" }), reservation({ rateCode: "GRP", numberOfRooms: 1, nights: 1, departureDate: "2026-03-02" })], authoritativeByDate: { "2026-03-01": { individualRooms: 2, groupRooms: 1 } } }), buildRunId: "published-run" };
    const root = { sourceRevision: 1, publishedSourceRevision: 1, modelVersion: "stay-pattern-v1", publicationVersion: "stay-pattern-publication-v2", status: "VALID", buildRunId: "root-run", latestCompletedBuildRunId: "root-run", publishedYearBuildRunIds: { 2026: "published-run" } };
    expect(snapshot({ stayPattern: combineStayPatternYears([year], [2026], root) }).active).toBe(true);
    for (const status of ["STALE", "BUILDING", "VALIDATION_FAILED"]) {
      const combined = combineStayPatternYears([year], [2026], { ...root, status });
      expect(combined.publicationVerified).toBe(false);
      expect(snapshot({ stayPattern: combined })).toMatchObject({ active: false, fallbackReason: `STAY_PATTERN_ROOT_${status}` });
    }
    for (const mismatch of [null, { ...root, sourceRevision: 2 }, { ...root, publishedSourceRevision: null }, { ...root, modelVersion: "future-version" }, { ...root, latestCompletedBuildRunId: "older-run" }, { ...root, publishedYearBuildRunIds: { 2026: "mismatched-run" } }]) expect(combineStayPatternYears([year], [2026], mismatch).publicationVerified).toBe(false);
    expect(combineStayPatternYears([{ ...year, modelVersion: "future-version" }], [2026], root).publicationVerified).toBe(false);
  });

  it("preserves unknown authoritative dates in combined evidence and the explicit LOS fallback snapshot", () => {
    const year = { ...buildStayPatternYear({ year: 2026, reservations: [reservation({ numberOfRooms: 100, nights: 1, departureDate: "2026-03-02" }), reservation({ rateCode: "GRP", numberOfRooms: 100, nights: 1, departureDate: "2026-03-02" })], authoritativeByDate: {
      "2026-03-01": { individualRooms: 100, groupRooms: 100 },
      "2026-03-02": { individualRooms: null, groupRooms: 0 },
    } }), buildRunId: "published-run" };
    const root = { sourceRevision: 1, publishedSourceRevision: 1, modelVersion: "stay-pattern-v1", publicationVersion: "stay-pattern-publication-v2", status: "VALIDATION_FAILED", buildRunId: "root-run", latestCompletedBuildRunId: "root-run", publishedYearBuildRunIds: { 2026: "published-run" } };
    const combined = combineStayPatternYears([year], [2026], root);
    expect(combined.reconciliation.transient).toMatchObject({ wape: 0, invalidDateCount: 1, passes: false });
    expect(combined.reconciliation.invalidDates).toEqual([{ year: 2026, stayDate: "2026-03-02", reasons: ["INVALID_INDIVIDUAL_ROOM_COUNT"], authoritativeTransient: null, authoritativeGroup: 0, reconstructedTransient: 0, reconstructedGroup: 0 }]);
    const result = snapshot({ stayPattern: combined });
    expect(result).toMatchObject({ active: false, fallbackReason: "STAY_PATTERN_ROOT_VALIDATION_FAILED", warningCode: "LOS_NETWORK_FALLBACK_TO_STAY_DATE" });
    expect(result.validation.invalidAuthoritativeDates).toEqual(combined.reconciliation.invalidDates);
    // Even inconsistent VALID labels cannot make invalid additive evidence pass.
    const inconsistent = combineStayPatternYears([{ ...year, status: "VALID" }], [2026], { ...root, status: "VALID" });
    expect(inconsistent.publicationVerified).toBe(true);
    expect(snapshot({ stayPattern: inconsistent })).toMatchObject({ active: false, fallbackReason: "LOS_NETWORK_VALIDATION_FAILED" });
  });
});
