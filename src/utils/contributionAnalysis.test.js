import { describe, expect, it } from "vitest";
import { aggregateAnalysisWarnings, calculateDemandCapacitySummary, calculateGroupContribution, normalizeContributionSettings, simulateGroupQuote } from "./contributionAnalysis";
import { calculateDisplacementDay, calculateDisplacementScenario } from "./displacementForecast";

const settings = (overrides = {}) => ({ variableRoomCost: 20, breakfastCostPerPerson: 5, bqtContributionMarginPercentage: 30, defaultGroupCommissionPercentage: 10, transientAverageBreakfastPax: 1.5, transientAverageBreakfastRevenuePerPax: 12, transientDistributionCostPercentage: 8, inflationPercentage: 5, roomVatPercentage: 0, ...overrides });
const quote = (overrides = {}) => ({ breakfastPax: 20, roomsByDate: [{ date: "2027-09-08", rooms: 10, bqtRevenue: 1000 }], ...overrides });
const forecast = (overrides = {}) => ({ "2027-09-08": { displacedRooms: 4, nonDisplacingGroupRooms: 6, expectedTransientRoomRate: 100, ...overrides } });
const result = (quoteOverrides, settingOverrides, forecastOverrides) => calculateGroupContribution({ quote: quote(quoteOverrides), settings: settings(settingOverrides), forecastByDate: forecast(forecastOverrides) });

describe("Contribution Displacement Engine V1", () => {
  it("normalizes whole percentage points without mutating their storage representation", () => {
    const source = settings({ bqtContributionMarginPercentage: 30, defaultGroupCommissionPercentage: 10, transientDistributionCostPercentage: 8 });
    expect(normalizeContributionSettings(source)).toMatchObject({ bqtContributionMargin: .3, defaultGroupCommission: .1, transientDistributionCost: .08 });
    expect(source).toMatchObject({ bqtContributionMarginPercentage: 30, defaultGroupCommissionPercentage: 10, transientDistributionCostPercentage: 8 });
  });
  it("normalizes and validates the separate future-group commission", () => {
    expect(normalizeContributionSettings(settings({ expectedFutureGroupCommissionPercentage: 8 })).expectedFutureGroupCommission).toBe(.08);
    expect(() => normalizeContributionSettings(settings({ expectedFutureGroupCommissionPercentage: 100 }))).toThrow(/expectedFutureGroupCommissionPercentage/);
    expect(() => normalizeContributionSettings(settings({ expectedFutureGroupCommissionPercentage: -1 }))).toThrow(/expectedFutureGroupCommissionPercentage/);
  });
  it("rejects invalid room VAT configuration", () => expect(() => result({}, { roomVatPercentage: -1 })).toThrow(/roomVatPercentage/));
  it("returns zero lost contribution for zero displaced rooms, even without ADR", () => expect(result({}, {}, { displacedRooms: 0, nonDisplacingGroupRooms: 10, expectedTransientRoomRate: null }).totalLostTransientContribution).toBe(0));
  it("calculates transient room and breakfast contribution separately", () => {
    const night = result().nightly[0];
    expect(night.transientDistributionCostPerRoom).toBe(8);
    expect(night.transientRoomContributionPerRoom).toBe(72);
    expect(night.transientBreakfastContributionPerRoom).toBe(10.5);
    expect(night.transientContributionPerDisplacedRoom).toBe(82.5);
    expect(night.lostTransientContribution).toBe(330);
  });
  it("preserves negative breakfast contribution", () => expect(result({}, { breakfastCostPerPerson: 15 }).nightly[0].transientBreakfastContributionPerRoom).toBe(-4.5));
  it("applies distribution cost only to ADR", () => expect(result({}, { transientAverageBreakfastRevenuePerPax: 100 }).nightly[0].transientDistributionCostPerRoom).toBe(8));
  it("sums multiple-night lost contribution", () => {
    const two = calculateGroupContribution({ settings: settings(), quote: quote({ roomsByDate: [{ date: "a", rooms: 10, bqtRevenue: 0 }, { date: "b", rooms: 10, bqtRevenue: 0 }] }), forecastByDate: { a: { displacedRooms: 2, nonDisplacingGroupRooms: 8, expectedTransientRoomRate: 100 }, b: { displacedRooms: 3, nonDisplacingGroupRooms: 7, expectedTransientRoomRate: 100 } } });
    expect(two.totalLostTransientContribution).toBe(412.5);
  });
  it("uses 30% BQT contribution and calculates group variable and breakfast costs", () => expect(result()).toMatchObject({ bqtContribution: 300, groupVariableRoomCosts: 200, groupBreakfastCosts: 100 }));
  it("uses default commission when override is absent and lets the quote override win", () => {
    expect(result().groupCommission).toBe(.1);
    expect(result({ groupCommissionPercentage: 5 }).groupCommission).toBe(.05);
  });
  it("falls back future-group commission to the default, never the quote commission", () => {
    const output = result({ groupCommissionPercentage: 25 });
    expect(output.groupCommission).toBe(.25);
    expect(output.expectedFutureGroupCommission).toBe(.1);
    expect(output.futureGroupCommissionDefaultFallback).toBe(true);
    expect(output.warningDetails.map((warning) => warning.code)).toContain("FUTURE_GROUP_COMMISSION_DEFAULT_FALLBACK");
  });
  it("calculates floors with zero and ten percent commission", () => {
    expect(result({ groupCommissionPercentage: 0 }).economicFloorRate).toBe(33);
    expect(result().economicFloorRate).toBeCloseTo(36.666666666666664);
  });
  it("moves the floor in the expected directions", () => {
    expect(result({ roomsByDate: [{ date: "2027-09-08", rooms: 10, bqtRevenue: 2000 }] }).economicFloorRate).toBeLessThan(result().economicFloorRate);
    expect(result({ breakfastPax: 30 }).economicFloorRate).toBeGreaterThan(result().economicFloorRate);
    expect(result({}, {}, { displacedRooms: 5, nonDisplacingGroupRooms: 5 }).economicFloorRate).toBeGreaterThan(result().economicFloorRate);
  });
  it("changes the floor only through the corrected displaced-room input", () => {
    const capacity = calculateDisplacementScenario({ sellableInventory: 150, existingGroupOtb: 17, hardOtherCommittedRooms: 0, requestedGroupRooms: 50, transientDemandForecast: 107 });
    const quoteInput = quote({ breakfastPax: 0, roomsByDate: [{ date: "2027-09-08", rooms: 50, bqtRevenue: 0 }] });
    const corrected = calculateGroupContribution({ quote: quoteInput, settings: settings(), forecastByDate: forecast({ displacedRooms: capacity.displacedTransientRooms, nonDisplacingGroupRooms: capacity.notDisplacingTransientDemand }) });
    const formerResidualResult = calculateGroupContribution({ quote: quoteInput, settings: settings(), forecastByDate: forecast({ displacedRooms: 33, nonDisplacingGroupRooms: 17 }) });
    expect(capacity.displacedTransientRooms).toBe(24);
    expect(corrected.transientContributionPerDisplacedRoom).toBe(formerResidualResult.transientContributionPerDisplacedRoom);
    expect(corrected.groupVariableRoomCosts).toBe(formerResidualResult.groupVariableRoomCosts);
    expect(corrected.economicFloorRate).toBeLessThan(formerResidualResult.economicFloorRate);
  });
  it("clamps required net revenue and floor at zero when BQT is sufficient", () => expect(result({ roomsByDate: [{ date: "2027-09-08", rooms: 10, bqtRevenue: 10000 }] }, {}, { displacedRooms: 0, nonDisplacingGroupRooms: 10 }).requiredNetGroupRoomRevenue).toBe(0));
  it("makes the floor null and warns when displaced rooms have no ADR", () => {
    const missing = result({}, {}, { expectedTransientRoomRate: null });
    expect(missing.totalLostTransientContribution).toBeNull(); expect(missing.economicFloorRate).toBeNull(); expect(missing.warningDetails.some((warning) => warning.code === "TRANSIENT_VALUE_UNAVAILABLE")).toBe(true);
  });
  it("does not block the floor for missing ADR when displacement is zero", () => expect(result({}, {}, { displacedRooms: 0, nonDisplacingGroupRooms: 10, expectedTransientRoomRate: null }).economicFloorRate).not.toBeNull());
  it("rejects invalid commission and settings", () => {
    expect(() => result({ groupCommissionPercentage: 100 })).toThrow(/commission/i);
    expect(() => result({}, { transientDistributionCostPercentage: 100 })).toThrow(/transientDistributionCostPercentage/);
  });
  it("returns a null floor and warning for zero room nights", () => {
    const empty = result({ roomsByDate: [] }); expect(empty.economicFloorRate).toBeNull(); expect(empty.warnings.join(" ")).toMatch(/zero/);
  });
  it("simulates exact, above, and below-floor rates without rounding", () => {
    const contribution = result(); const exact = simulateGroupQuote(contribution, contribution.economicFloorRateInclVat);
    expect(exact.netIncrementalContribution).toBeCloseTo(0, 10);
    expect(simulateGroupQuote(contribution, contribution.economicFloorRateInclVat + .123456).netIncrementalContribution).toBeGreaterThan(0);
    expect(simulateGroupQuote(contribution, contribution.economicFloorRateInclVat - .123456).netIncrementalContribution).toBeLessThan(0);
    expect(exact.economicFloorRate).not.toBe(Number(exact.economicFloorRate.toFixed(2)));
  });
});

describe("Future Group Demand contribution integration", () => {
  const integrated = (forecastOverrides = {}, quoteOverrides = {}, settingOverrides = {}) => calculateGroupContribution({
    quote: quote({ breakfastPax: 0, groupCommissionPercentage: 10, roomsByDate: [{ date: "2027-09-08", rooms: 50, bqtRevenue: 0 }], ...quoteOverrides }),
    settings: settings({ transientAverageBreakfastPax: 0, ...settingOverrides }),
    forecastByDate: { "2027-09-08": {
      sellableInventory: 150, currentTransientOtb: 16, existingGroupOtb: 17, hardOtherCommittedRooms: 0,
      transientDemandForecast: 107, expectedTransientRoomRate: 200,
      groupProspectPipelineRooms: 100, groupProspectPipelineRevenue: 22900, currentDeductibleGroupRevenue: 3893,
      groupForecast: { forecastLow: 22, forecastBase: 27, forecastHigh: 37, confidence: "MEDIUM" },
      ...forecastOverrides,
    } },
  });

  it("separates future transient and group demand from committed OTB", () => {
    const night = integrated().nightly[0];
    expect(night.futureTransientDemand).toBe(91);
    expect(night.futureGroupDemandBase).toBe(10);
    expect(night.hardCommittedRooms).toBe(33);
  });
  it("never makes future group demand negative", () => expect(integrated({ groupForecast: { forecastLow: 1, forecastBase: 2, forecastHigh: 3 } }).nightly[0].futureGroupDemandBase).toBe(0));
  it("shows the €229 pipeline commercial rate without using it as evidence", () => {
    const night = integrated().nightly[0];
    expect(night.pipelineCommercialRate).toBe(229);
    expect(night.pipelineCommercialRateBasis).toBe("UNKNOWN_COMMERCIAL_PACKAGE");
    expect(night.expectedFutureGroupRoomRate).toBe(229);
    expect(night.futureGroupRateSource).toBe("EXISTING_ONLY");
  });
  it("keeps pipeline rooms out of demand and hard capacity", () => {
    const small = integrated({ groupProspectPipelineRooms: 1, groupProspectPipelineRevenue: 229 });
    const large = integrated({ groupProspectPipelineRooms: 1000, groupProspectPipelineRevenue: 229000 });
    expect(large.nightly[0]).toMatchObject({ futureGroupDemandLow: small.nightly[0].futureGroupDemandLow, futureGroupDemandBase: small.nightly[0].futureGroupDemandBase, futureGroupDemandHigh: small.nightly[0].futureGroupDemandHigh, hardCommittedRooms: small.nightly[0].hardCommittedRooms });
  });
  it("separates proposed-group commission from future-group commission", () => {
    const zero = integrated({}, { groupCommissionPercentage: 0 }, { expectedFutureGroupCommissionPercentage: 8 });
    const fifteen = integrated({}, { groupCommissionPercentage: 15 }, { expectedFutureGroupCommissionPercentage: 8 });
    expect(zero.nightly[0].futureGroupContributionPerRoom).toBe(fifteen.nightly[0].futureGroupContributionPerRoom);
    expect(zero.economicFloorRate).not.toBe(fifteen.economicFloorRate);
    expect(zero.groupCommission).toBe(0); expect(fifteen.groupCommission).toBe(.15);
    expect(zero.expectedFutureGroupCommission).toBe(.08);
  });
  it("uses the configured future-group commission in future value only", () => {
    const lowCommission = integrated({}, {}, { expectedFutureGroupCommissionPercentage: 5 });
    const highCommission = integrated({}, {}, { expectedFutureGroupCommissionPercentage: 20 });
    expect(lowCommission.groupCommission).toBe(highCommission.groupCommission);
    expect(lowCommission.nightly[0].futureGroupContributionPerRoom).toBeGreaterThan(highCommission.nightly[0].futureGroupContributionPerRoom);
  });
  it("falls back to existing deductible group ADR", () => {
    const night = integrated({ groupProspectPipelineRooms: 0, groupProspectPipelineRevenue: 0, existingGroupRevenue: 3400, currentDeductibleGroupRevenue: null }).nightly[0];
    expect(night.expectedFutureGroupRoomRate).toBe(200);
    expect(night.futureGroupRateSource).toBe("EXISTING_ONLY");
  });
  it("protects committed rooms and calculates 34 displaced and 16 incremental rooms", () => {
    const night = integrated().nightly[0];
    expect(night.remainingCapacityBeforeNewGroup).toBe(117);
    expect(night.scenarios.base.totalDisplacedFutureRooms).toBe(34);
    expect(night.scenarios.base.nonDisplacingGroupRooms).toBe(16);
  });
  it("returns full displacement when future demand fills remaining capacity", () => expect(integrated({ transientDemandForecast: 200 }).nightly[0].scenarios.base.totalDisplacedFutureRooms).toBe(50));
  it("displaces lower-value future group first and never beyond its demand", () => {
    const base = integrated({ currentDeductibleGroupRevenue: 1700 }).nightly[0].scenarios.base;
    expect(base.displacedFutureGroupRooms).toBe(10);
    expect(base.displacedFutureTransientRooms).toBe(24);
  });
  it("displaces lower-value transient demand first", () => {
    const base = integrated().nightly[0].scenarios.base;
    expect(base.displacedFutureTransientRooms).toBe(34);
    expect(base.displacedFutureGroupRooms).toBe(0);
    expect(base.displacedFutureTransientRooms + base.displacedFutureGroupRooms).toBe(base.totalDisplacedFutureRooms);
  });
  it("pipeline commercial value changes neither allocation nor Economic Floor", () => {
    const lower = integrated({ groupProspectPipelineRooms: 100, groupProspectPipelineRevenue: 10000 });
    const higher = integrated({ groupProspectPipelineRooms: 50, groupProspectPipelineRevenue: 30000 });
    expect(lower.nightly[0].scenarios.base).toEqual(higher.nightly[0].scenarios.base);
    expect(lower.economicFloorRate).toBe(higher.economicFloorRate);
  });
  it("marks adjusted floor unavailable when displaced group demand has no value", () => {
    const output = integrated({ groupProspectPipelineRooms: 500, groupProspectPipelineRevenue: 125000, existingGroupRevenue: 0, currentDeductibleGroupRevenue: 0 });
    expect(output.economicFloorRate).toBeNull();
    expect(output.economicFloorUnavailableReason).toBe("ECONOMIC_FLOOR_UNAVAILABLE_CONTRIBUTION_VALUE");
    expect(output.transientOnlyEconomicFloor).not.toBeNull();
    expect(output.warnings.join(" ")).toMatch(/no reliable group-rate evidence/i);
  });
  it("makes adjusted and transient-only floors equal when future group demand is zero", () => {
    const output = integrated({ groupForecast: { forecastLow: 17, forecastBase: 17, forecastHigh: 17 } });
    expect(output.economicFloorRate).toBe(output.transientOnlyEconomicFloor);
  });
  it("does not reduce displacement for the higher group-demand scenario", () => {
    const output = integrated(); const night = output.nightly[0];
    expect(night.scenarios.high.totalDisplacedFutureRooms).toBeGreaterThanOrEqual(night.scenarios.base.totalDisplacedFutureRooms);
    expect(output.economicFloorHigh).toBeGreaterThanOrEqual(output.economicFloorBase);
  });
  it("marks the full floor unavailable on a committed-capacity conflict", () => {
    const output = integrated({ currentTransientOtb: 100, existingGroupOtb: 30 });
    expect(output.nightly[0].capacityConflictRooms).toBe(30);
    expect(output.economicFloorRate).toBeNull();
    expect(output.economicFloorUnavailableReason).toBe("ECONOMIC_FLOOR_UNAVAILABLE_PHYSICAL_CAPACITY");
    expect(output.warnings.join(" ")).toMatch(/physical capacity/i);
  });
  it("preserves exact arithmetic and group commission gross-up", () => {
    const output = integrated({ existingGroupOtb: 3, currentDeductibleGroupRevenue: 1000 });
    expect(output.nightly[0].expectedFutureGroupRoomRate).toBe(1000 / 3);
    expect(output.requiredGrossGroupRoomRevenue).toBeCloseTo(output.requiredNetGroupRoomRevenue / .9, 12);
  });
  it("BQT lowers and breakfast cost raises the adjusted floor", () => {
    const baseline = integrated().economicFloorRate;
    expect(integrated({}, { roomsByDate: [{ date: "2027-09-08", rooms: 50, bqtRevenue: 1000 }] }).economicFloorRate).toBeLessThan(baseline);
    expect(integrated({}, { breakfastPax: 10 }, { breakfastCostPerPerson: 20 }).economicFloorRate).toBeGreaterThan(baseline);
  });
  it("deduplicates warning codes while retaining all affected stay dates", () => {
    const details = aggregateAnalysisWarnings([{ stayDate: "a", contributionWarnings: ["Group Forecast V1 does not yet use historical booking pace."] }, { stayDate: "b", contributionWarnings: ["Group Forecast V1 does not yet use historical booking pace."] }]);
    expect(details).toEqual([{ code: "GROUP_PACE_UNAVAILABLE", message: "Group Forecast V1 does not yet use historical booking pace.", stayDates: ["a", "b"] }]);
  });
  it("keeps opportunity cost separate and reconciles the existing floor components", () => {
    const output = integrated({}, { breakfastPax: 2, roomsByDate: [{ date: "2027-09-08", rooms: 50, bqtRevenue: 100 }] });
    expect(output.totalLostContribution).toBe(output.totalLostFutureTransientContribution + output.totalLostFutureGroupContribution);
    expect(output.requiredNetGroupRoomRevenue).toBe(Math.max(0, output.totalLostContribution + output.groupVariableRoomCosts + output.groupBreakfastCosts - output.bqtContribution));
    expect(output.requiredGrossGroupRoomRevenue).toBe(output.requiredNetGroupRoomRevenue / (1 - output.groupCommission));
    expect(output.economicFloorRate).toBe(output.requiredGrossGroupRoomRevenue / output.totalRequestedGroupRoomNights);
  });
  it("summarizes demand without double-counting committed OTB or prospect rooms", () => {
    const summary = calculateDemandCapacitySummary({ sellableInventory: 150, transientDemandForecast: 107, currentTransientOtb: 16, existingGroupOtb: 17, groupProspectPipelineRooms: 500, hardOtherCommittedRooms: 2 }, { forecastBase: 27 });
    expect(summary.expectedTotalDemand).toBe(136);
    expect(summary.expectedSlack).toBe(14);
  });
  it("converts all floor scenarios for commercial display without changing ex-VAT economics", () => {
    const exVat = integrated({}, {}, { roomVatPercentage: 0 });
    const vat = integrated({}, {}, { roomVatPercentage: 12 });
    expect(vat.economicFloorRateExVat).toBe(exVat.economicFloorRateExVat);
    expect(vat.economicFloorBaseInclVat).toBe(vat.economicFloorBaseExVat * 1.12);
    expect(vat.economicFloorLowInclVat).toBe(vat.economicFloorLowExVat * 1.12);
    expect(vat.economicFloorHighInclVat).toBe(vat.economicFloorHighExVat * 1.12);
    expect(vat.transientOnlyEconomicFloorInclVat).toBe(vat.transientOnlyEconomicFloorExVat * 1.12);
    expect(vat.groupBreakfastCosts).toBe(exVat.groupBreakfastCosts);
    expect(vat.bqtContribution).toBe(exVat.bqtContribution);
  });
  it("treats a €199 simulator input as VAT-inclusive and commissions ex-VAT revenue", () => {
    const contribution = integrated({}, { roomsByDate: [{ date: "2027-09-08", rooms: 100, bqtRevenue: 0 }] }, { roomVatPercentage: 12 });
    const simulation = simulateGroupQuote(contribution, 199);
    expect(simulation.testGroupRateExVat).toBeCloseTo(177.67857142857142, 12);
    expect(simulation.testGroupRoomRevenueExVat).toBeCloseTo(17767.85714285714, 10);
    expect(simulation.testGroupRoomRevenueExVat).not.toBe(19900);
    expect(simulation.testGroupCommissionCost).toBeCloseTo(simulation.testGroupRoomRevenueExVat * .1, 12);
    expect(simulation.rateAboveFloor).toBe(199 - contribution.economicFloorRateInclVat);
    expect(simulation.rateAboveFloorPercentage).toBe(199 / contribution.economicFloorRateInclVat - 1);
  });
  it("keeps authoritative group ADR ex-VAT without normalizing pipeline context", () => {
    const output = integrated({}, {}, { roomVatPercentage: 12 });
    expect(output.nightly[0].expectedTransientRoomRate).toBe(200);
    expect(output.nightly[0].expectedFutureGroupRoomRateExVat).toBe(229);
    expect(output.nightly[0].expectedFutureGroupRoomRateInclVat).toBe(229 * 1.12);
    expect(output.nightly[0].pipelineCommercialRate).toBe(229);
    expect(output.nightly[0].pipelineCommercialRateBasis).toBe("UNKNOWN_COMMERCIAL_PACKAGE");
  });
});

describe("expected transient ADR", () => {
  const historicalRows = [100, 200, 1000].map((averageRoomRate, index) => ({ date: `2026-09-${String([2, 9, 16][index]).padStart(2, "0")}`, historyFutureType: "History", calculatedInventoryRooms: 100, calculatedOccRooms: 50, individualRooms: 40, groupRooms: 10, averageRoomRate, individualRevenueDeductible: averageRoomRate * 40 }));
  it("uses the median of the forecast's selected comparables with existing inflation adjustment", () => {
    const output = calculateDisplacementDay({ stayDate: "2027-09-08", requestedGroupRooms: 10, currentOtb: { calculatedInventoryRooms: 100, individualRooms: 95 }, historicalRows, selectedHistoricalYears: [2024, 2025, 2026], inflationPercentage: 10 });
    expect(output.expectedTransientRoomRate).toBeCloseTo(220);
  });
  it("ignores invalid, missing, and non-positive ADR", () => {
    const output = calculateDisplacementDay({ stayDate: "2027-09-08", requestedGroupRooms: 10, currentOtb: { calculatedInventoryRooms: 100 }, historicalRows: historicalRows.map((row, i) => ({ ...row, individualRevenueDeductible: [0, "bad", 4000][i] })), selectedHistoricalYears: [2024, 2025, 2026], inflationPercentage: 10 });
    expect(output.expectedTransientRoomRate).toBeCloseTo(110);
  });
});

describe("Group Quote V2 nightly breakfast input", () => {
  it("sums nightly breakfast pax without changing the cost formula", () => {
    const output = result({ quoteInputSchemaVersion: "group-quote-v2", breakfastPax: 999, roomsByDate: [
      { date: "2027-09-08", rooms: 50, breakfastPax: 50, bqtRevenue: 0 },
      { date: "2027-09-09", rooms: 50, breakfastPax: 50, bqtRevenue: 0 },
    ] }, { breakfastCostPerPerson: 10 }, {});
    expect(output.totalBreakfastPax).toBe(100);
    expect(output.groupBreakfastCosts).toBe(1000);
  });
});

describe("explicit meal basis is non-financial", () => {
  it("keeps breakfast cost and Economic Floor identical when only meal basis changes", () => {
    const make = (mealBasis) => result({ quoteInputSchemaVersion: "group-quote-v3-meal-basis", roomsByDate: [{ date: "2027-09-08", rooms: 50, mealBasis, breakfastPax: 20, bqtRevenue: 0 }] }, { breakfastCostPerPerson: 10 });
    const ro = make("RO");
    const bb = make("BB");
    expect(ro.totalBreakfastPax).toBe(20);
    expect(ro.groupBreakfastCosts).toBe(200);
    expect(bb.groupBreakfastCosts).toBe(ro.groupBreakfastCosts);
    expect(bb.economicFloorRateInclVat).toBe(ro.economicFloorRateInclVat);
  });
});
