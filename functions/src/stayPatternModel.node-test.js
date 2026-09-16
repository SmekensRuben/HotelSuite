const test = require("node:test");
const assert = require("node:assert/strict");
const { buildYear, classifyRateCode, combineMetrics, normalizeStatus } = require("./stayPatternModel");

const reservation = (overrides = {}) => ({ reservationNameId: "1", arrivalDate: "2025-03-03", departureDate: "2025-03-05", nights: 2, numberOfRooms: 2, reservationStatus: "CHECKED OUT", rateCode: "12ABC", ...overrides });

test("buildYear filters raw reservations, reconciles, and retains additive metric components", () => {
  const result = buildYear(2025, [reservation(), reservation({ reservationNameId: "2", rateCode: "GRP", numberOfRooms: 1 }), reservation({ reservationNameId: "3", reservationStatus: "CANCELLED" }), reservation({ reservationNameId: "4", rateCode: "NORATE" }), reservation({ reservationNameId: "5", rateCode: "" })], { "2025-03-03": { individualRooms: 2, groupRooms: 1 }, "2025-03-04": { individualRooms: 2, groupRooms: 1 } });
  assert.equal(result.status, "VALID");
  assert.deepEqual(result.reconciliation.transient, { ...result.reconciliation.transient, comparedDates: 2, authoritativeRooms: 4, reconstructedRooms: 4, sumAbsoluteError: 0, signedErrorRooms: 0, matchingDates: 2, wape: 0, matchingDateShare: 1, passes: true });
  assert.equal(result.quality.realizedReservationsUsed, 2);
  assert.equal(result.quality.cancelledNoShowExclusions, 1);
  assert.equal(result.quality.norateExclusions, 1);
  assert.equal(result.quality.unclassifiedRateCodeCount, 1);
});

test("combined WAPE is calculated from additive room totals rather than annual percentages", () => {
  const annual = [
    { reconciliation: { transient: { comparedDates: 1, authoritativeRooms: 100, reconstructedRooms: 110, sumAbsoluteError: 10, signedErrorRooms: 10, matchingDates: 0, absoluteErrors: [10] } } },
    { reconciliation: { transient: { comparedDates: 1, authoritativeRooms: 10, reconstructedRooms: 10, sumAbsoluteError: 0, signedErrorRooms: 0, matchingDates: 1, absoluteErrors: [0] } } },
  ];
  const combined = combineMetrics(annual, "transient");
  assert.equal(combined.wape, 10 / 110);
  assert.equal(combined.meanAbsoluteError, 5);
  assert.equal(combined.medianAbsoluteError, 5);
});

test("classification and status normalization are centralized and conservative", () => {
  assert.equal(classifyRateCode(" 34sych "), "TRANSIENT");
  assert.equal(classifyRateCode("NORATE"), "EXCLUDED_POSTMASTER");
  assert.equal(classifyRateCode("GRP"), "GROUP");
  assert.equal(normalizeStatus("no show"), "NO_SHOW");
  assert.equal(normalizeStatus("unknown"), "UNKNOWN");
});
