import { describe, expect, it } from "vitest";
import { calculateFutureGroupValue } from "./futureGroupValue";

const comparable = (date, groupRooms, adr, overrides = {}) => ({
  stayDate: date,
  finalGroupRooms: groupRooms,
  groupRevenueDeductible: adr === null ? null : groupRooms * adr,
  sellableInventory: 150,
  ...overrides,
});
const calculate = (overrides = {}) => calculateFutureGroupValue({
  stayDate: "2027-04-03",
  groupForecast: { comparables: [] },
  inflationPercentage: 0,
  ...overrides,
});

describe("Future Group Value V2 historical ADR evidence", () => {
  it("calculates realized group ADR from the exact deductible revenue field", () => {
    const result = calculate({ groupForecast: { comparables: [comparable("2026-04-03", 74, null, { groupRevenueDeductible: 18465.178571 })] } });
    expect(result.historicalGroupAdrObservations[0].rawGroupAdrExVat).toBeCloseTo(249.52944014864865, 10);
  });
  it.each([
    ["zero rooms", comparable("2026-04-03", 0, 200)],
    ["zero revenue", comparable("2026-04-03", 10, 0)],
    ["invalid revenue", comparable("2026-04-03", 10, null, { groupRevenueDeductible: "bad" })],
    ["invalid share", comparable("2026-04-03", 151, 200)],
    ["target date", comparable("2027-04-03", 10, 200)],
    ["future date", comparable("2028-04-03", 10, 200)],
  ])("does not create evidence for %s", (_label, row) => expect(calculate({ groupForecast: { comparables: [row] } }).historicalAdrEvidenceCount).toBe(0));
  it("inflation-adjusts each date without intermediate rounding", () => {
    const result = calculate({ inflationPercentage: 10, groupForecast: { comparables: [comparable("2025-04-03", 10, 100)] } });
    expect(result.historicalGroupAdrObservations[0].inflationAdjustedGroupAdrExVat).toBeCloseTo(121, 12);
  });
  it("uses an unweighted full-precision median", () => {
    const result = calculate({ groupForecast: { comparables: [comparable("2024-04-03", 100, 185), comparable("2025-04-03", 1, 198), comparable("2026-04-03", 50, 202)] } });
    expect(result.historicalComparableGroupAdrExVat).toBe(198);
  });
});

describe("Future Group Value V2 combined evidence", () => {
  const history = [185, 198, 202, 215, 220].map((adr, index) => comparable(`${2021 + index}-04-03`, 10, adr));
  it("excludes the pipeline commercial rate from the authoritative median", () => {
    const result = calculate({ groupForecast: { comparables: history }, pipelineRooms: 100, pipelineRevenue: 25000, currentGroupOtb: 10, currentDeductibleGroupRevenue: 2050 });
    expect(result.expectedFutureGroupRoomRateExVat).toBe(203.5);
    expect(result.pipelineCommercialRate).toBe(250);
    expect(result.pipelineCommercialRateBasis).toBe("UNKNOWN_COMMERCIAL_PACKAGE");
    expect(result.futureGroupAdrEvidenceExVat).toHaveLength(6);
    expect(result.futureGroupValueSource).toBe("HISTORICAL_AND_EXISTING");
    expect(result.futureGroupValueConfidence).toBe("HIGH");
  });
  it.each([
    ["history only", { groupForecast: { comparables: history } }, "HISTORICAL_ONLY", 202],
    ["history and pipeline context", { groupForecast: { comparables: history }, pipelineRooms: 100, pipelineRevenue: 25000 }, "HISTORICAL_ONLY", 202],
    ["history and existing", { groupForecast: { comparables: history }, currentGroupOtb: 10, currentDeductibleGroupRevenue: 2050 }, "HISTORICAL_AND_EXISTING", 203.5],
    ["pipeline only", { pipelineRooms: 100, pipelineRevenue: 25000 }, "UNAVAILABLE", null],
    ["existing only", { currentGroupOtb: 10, currentDeductibleGroupRevenue: 2050 }, "EXISTING_ONLY", 205],
    ["pipeline context and existing", { pipelineRooms: 100, pipelineRevenue: 25000, currentGroupOtb: 10, currentDeductibleGroupRevenue: 2050 }, "EXISTING_ONLY", 205],
    ["unavailable", {}, "UNAVAILABLE", null],
  ])("supports %s evidence", (_label, inputs, source, expected) => {
    const result = calculate(inputs); expect(result.futureGroupValueSource).toBe(source); expect(result.expectedFutureGroupRoomRateExVat).toBe(expected);
  });
  it("uses only the six authoritative values in the specified 180–220 example", () => {
    const rows = [180, 190, 200, 210, 220].map((adr, index) => comparable(`${2021 + index}-04-03`, 10, adr));
    const highPipeline = calculate({ groupForecast: { comparables: rows }, currentGroupOtb: 10, currentDeductibleGroupRevenue: 1850, pipelineRooms: 10, pipelineRevenue: 3000 });
    const lowPipeline = calculate({ groupForecast: { comparables: rows }, currentGroupOtb: 10, currentDeductibleGroupRevenue: 1850, pipelineRooms: 10, pipelineRevenue: 1000 });
    expect(highPipeline.expectedFutureGroupRoomRateExVat).toBe(195);
    expect(lowPipeline.expectedFutureGroupRoomRateExVat).toBe(195);
  });
  it("does not count pipeline context as confidence evidence", () => {
    const pipelineOnly = calculate({ pipelineRooms: 100, pipelineRevenue: 25000 });
    expect(pipelineOnly.futureGroupValueConfidence).toBeNull();
    expect(pipelineOnly.warnings).toEqual([]);
  });
  it("is invariant to pipeline revenue and rooms", () => {
    const inputs = { groupForecast: { comparables: history }, currentGroupOtb: 10, currentDeductibleGroupRevenue: 1850 };
    const high = calculate({ ...inputs, pipelineRooms: 10, pipelineRevenue: 3000 });
    const low = calculate({ ...inputs, pipelineRooms: 25, pipelineRevenue: 2500 });
    expect(high.expectedFutureGroupRoomRateExVat).toBe(low.expectedFutureGroupRoomRateExVat);
    expect(high.futureGroupValueConfidence).toBe(low.futureGroupValueConfidence);
    expect(high.pipelineCommercialRate).toBe(300);
    expect(low.pipelineCommercialRate).toBe(100);
  });
});
