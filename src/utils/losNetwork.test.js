import { describe, expect, it } from "vitest";
import {
  allocateItineraries,
  applyLosNetworkOpportunityCost,
  buildStayPatternYear,
  calculateNetworkDisplacement,
  classifyRateCode,
  combineStayPatternYears,
  normalizeHistoricalReservation,
  reconstructItineraries,
  selectLosDistribution,
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
});
