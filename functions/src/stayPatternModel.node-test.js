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

test("canonical preparation excludes other arrival years and malformed calendar dates", () => {
  const result = buildYear(2025, [reservation(), reservation({ arrivalDate: "2024-03-03", departureDate: "2024-03-05" }), reservation({ arrivalDate: "2025-02-30", departureDate: "2025-03-04" })], { "2025-03-03": { individualRooms: 2, groupRooms: 0 }, "2025-03-04": { individualRooms: 2, groupRooms: 0 }, "2024-03-03": { individualRooms: 900, groupRooms: 900 } });
  assert.equal(result.quality.sourceReservations, 1);
  assert.equal(result.types.TRANSIENT.modeledRoomArrivals, 2);
  assert.equal(result.reconciliation.transient.comparedDates, 2);
  assert.equal(result.quality.possibleShareRecords, result.quality.possibleShareCount);
});

test("stay-year occupancy includes previous December arrivals without moving their training year", () => {
  const rows = [reservation({ arrivalDate: "2024-12-31", departureDate: "2025-01-02", rateCode: "12ABC" }), reservation({ arrivalDate: "2025-01-01", departureDate: "2025-01-02", nights: 1, rateCode: "GRP", numberOfRooms: 1 })];
  const result = buildYear(2025, rows, { "2025-01-01": { individualRooms: 2, groupRooms: 1 } });
  assert.equal(result.status, "VALID"); assert.equal(result.reconciliation.transient.wape, 0);
  assert.equal(result.types.TRANSIENT.modeledRoomArrivals, 0);
  assert.equal(result.types.GROUP.modeledRoomArrivals, 1);
  assert.equal(result.quality.sourceReservations, 1);
});

test("unknown, malformed and negative authoritative counts invalidate the entire annual reconciliation with evidence", () => {
  const validRows = [reservation({ departureDate: "2025-03-04", nights: 1, numberOfRooms: 100 }), reservation({ departureDate: "2025-03-04", nights: 1, numberOfRooms: 100, rateCode: "GRP" })];
  const invalidCounts = [null, "", "  ", false, true, -1, "-1", undefined, NaN, Infinity, [], {}, "0x0", "0o0", "0b0"];
  for (const field of ["individualRooms", "groupRooms"]) for (const value of invalidCounts) {
    const result = buildYear(2025, validRows, {
      "2025-03-03": { individualRooms: 100, groupRooms: 100 },
      "2025-03-04": { individualRooms: 0, groupRooms: 0, [field]: value },
    });
    assert.equal(result.status, "VALIDATION_FAILED", `${field}: ${String(value)}`);
    assert.equal(result.reconciliation.transient.wape, 0);
    assert.equal(result.reconciliation.group.wape, 0);
    assert.equal(result.reconciliation.transient.passes, false);
    assert.equal(result.reconciliation.group.passes, false);
    assert.equal(result.reconciliation.transient.invalidDateCount, 1);
    assert.deepEqual(result.reconciliation.invalidDates, [{
      stayDate: "2025-03-04",
      reasons: [field === "individualRooms" ? "INVALID_INDIVIDUAL_ROOM_COUNT" : "INVALID_GROUP_ROOM_COUNT"],
      authoritativeTransient: field === "individualRooms" ? null : 0,
      authoritativeGroup: field === "groupRooms" ? null : 0,
      reconstructedTransient: 0,
      reconstructedGroup: 0,
    }]);
    assert.equal(combineMetrics([result], "transient").passes, false);
    assert.equal(combineMetrics([result], "group").invalidDateCount, 1);
  }
});

test("explicit zero and finite numeric import strings remain authoritative counts", () => {
  const result = buildYear(2025, [reservation({ departureDate: "2025-03-04", nights: 1, numberOfRooms: 100 }), reservation({ departureDate: "2025-03-04", nights: 1, numberOfRooms: 100, rateCode: "GRP" })], {
    "2025-03-03": { individualRooms: " 100.0 ", groupRooms: "100" },
    "2025-03-04": { individualRooms: 0, groupRooms: "0" },
  });
  assert.equal(result.status, "VALID");
  assert.equal(result.reconciliation.transient.comparedDates, 2);
  assert.deepEqual(result.reconciliation.invalidDates, []);
});

test("an occupied checkout-exclusive horizon date without authoritative counts cannot disappear from reconciliation", () => {
  const result = buildYear(2025, [reservation({ numberOfRooms: 100 }), reservation({ numberOfRooms: 100, rateCode: "GRP" })], {
    "2025-03-03": { individualRooms: 100, groupRooms: 100 },
  });
  assert.equal(result.status, "VALIDATION_FAILED");
  assert.equal(result.reconciliation.transient.comparedDates, 1);
  assert.deepEqual(result.reconciliation.invalidDates, [{ stayDate: "2025-03-04", reasons: ["MISSING_AUTHORITATIVE_DATE", "INVALID_INDIVIDUAL_ROOM_COUNT", "INVALID_GROUP_ROOM_COUNT"], authoritativeTransient: null, authoritativeGroup: null, reconstructedTransient: 100, reconstructedGroup: 100 }]);
  assert.equal(result.reconciliation.invalidDates.some((row) => row.stayDate === "2025-03-05"), false, "checkout is not an occupied date");
});

test("missing January carry-in authority invalidates the year while preserving December arrival-year training", () => {
  const rows = [reservation({ arrivalDate: "2024-12-31", departureDate: "2025-01-03", nights: 3, numberOfRooms: 100 }), reservation({ arrivalDate: "2025-01-01", departureDate: "2025-01-02", nights: 1, rateCode: "GRP", numberOfRooms: 100 })];
  const result = buildYear(2025, rows, { "2025-01-01": { individualRooms: 100, groupRooms: 100 } });
  assert.equal(result.status, "VALIDATION_FAILED");
  assert.equal(result.types.TRANSIENT.modeledRoomArrivals, 0);
  assert.equal(result.types.GROUP.modeledRoomArrivals, 100);
  assert.equal(result.quality.sourceReservations, 1);
  assert.deepEqual(result.reconciliation.invalidDates.map((row) => ({ stayDate: row.stayDate, reconstructedTransient: row.reconstructedTransient })), [{ stayDate: "2025-01-02", reconstructedTransient: 100 }]);
});

test("malformed authoritative calendar dates retain failure evidence instead of being filtered out", () => {
  const result = buildYear(2025, [reservation(), reservation({ rateCode: "GRP" })], {
    "2025-03-03": { individualRooms: 2, groupRooms: 2 },
    "2025-03-04": { individualRooms: 2, groupRooms: 2 },
    "2025-02-30": { individualRooms: 0, groupRooms: 0 },
  });
  assert.equal(result.status, "VALIDATION_FAILED");
  assert.deepEqual(result.reconciliation.invalidDates[0].reasons, ["INVALID_STAY_DATE"]);
  assert.equal(result.reconciliation.invalidDates[0].stayDate, "2025-02-30");
});
