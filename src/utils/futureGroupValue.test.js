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
  it("reconciles the specified seven-signal median to 205", () => {
    const result = calculate({ groupForecast: { comparables: history }, pipelineRooms: 100, pipelineRevenue: 25000, currentGroupOtb: 10, currentDeductibleGroupRevenue: 2050 });
    expect(result.expectedFutureGroupRoomRateExVat).toBe(205);
    expect(result.futureGroupValueSource).toBe("HISTORICAL_AND_CURRENT_SIGNALS");
    expect(result.futureGroupValueConfidence).toBe("HIGH");
  });
  it.each([
    ["history only", { groupForecast: { comparables: history } }, "HISTORICAL_ONLY", 202],
    ["history and pipeline", { groupForecast: { comparables: history }, pipelineRooms: 100, pipelineRevenue: 25000 }, "HISTORICAL_AND_PIPELINE", 208.5],
    ["history and existing", { groupForecast: { comparables: history }, currentGroupOtb: 10, currentDeductibleGroupRevenue: 2050 }, "HISTORICAL_AND_EXISTING", 203.5],
    ["pipeline only", { pipelineRooms: 100, pipelineRevenue: 25000 }, "PIPELINE_ONLY", 250],
    ["existing only", { currentGroupOtb: 10, currentDeductibleGroupRevenue: 2050 }, "EXISTING_ONLY", 205],
    ["pipeline and existing", { pipelineRooms: 100, pipelineRevenue: 25000, currentGroupOtb: 10, currentDeductibleGroupRevenue: 2050 }, "PIPELINE_AND_EXISTING", 227.5],
    ["unavailable", {}, "UNAVAILABLE", null],
  ])("supports %s evidence", (_label, inputs, source, expected) => {
    const result = calculate(inputs); expect(result.futureGroupValueSource).toBe(source); expect(result.expectedFutureGroupRoomRateExVat).toBe(expected);
  });
  it("does not weight a 100-room pipeline signal 100 times", () => expect(calculate({ groupForecast: { comparables: history }, pipelineRooms: 100, pipelineRevenue: 25000 }).futureGroupAdrEvidence).toHaveLength(6));
});
