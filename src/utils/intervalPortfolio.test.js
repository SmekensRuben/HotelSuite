import { describe, expect, it } from "vitest";
import { certifyIntervalPortfolio, optimizeIntervalPortfolio } from "./intervalPortfolio";

const dates = ["2027-03-01", "2027-03-02", "2027-03-03"];
const row = (key, occupiedDates, value, expectedRooms = 1) => ({ key, occupiedDates, itineraryContributionPerRoom: value, expectedRooms });

// Exhaustive independent oracle. Half-unit RHS is integral after scaling by two;
// the consecutive-ones interval matrix has integral vertices in that scale.
function exhaustiveValue(rows, capacity) {
  let best = 0;
  function visit(index, used, value) {
    if (index === rows.length) { best = Math.max(best, value); return; }
    const r = rows[index];
    for (let units = 0; units <= r.expectedRooms * 2; units += 1) {
      const rooms = units / 2;
      if (r.occupiedDates.some((d) => (used[d] || 0) + rooms > capacity[d])) continue;
      const next = { ...used }; r.occupiedDates.forEach((d) => { next[d] = (next[d] || 0) + rooms; });
      visit(index + 1, next, value + rooms * r.itineraryContributionPerRoom);
    }
  }
  visit(0, {}, 0); return best;
}

describe("certified interval portfolio optimization", () => {
  it("chooses the €300 two-night itinerary over greedy €200 + €50", () => {
    const result = optimizeIntervalPortfolio([row("A", dates.slice(0, 2), 300), row("B", [dates[0]], 200), row("C", [dates[1]], 50)], { [dates[0]]: 1, [dates[1]]: 1 });
    expect(result.status).toBe("OPTIMAL"); expect(result.portfolioValue).toBe(300);
    expect(result.accepted).toEqual({ A: 1, B: 0, C: 0 });
    expect(result.diagnostics.certificate.objectiveGap).toBeCloseTo(0, 9);
  });

  it("matches exhaustive independent portfolios for 80 fractional fixtures", () => {
    for (let seed = 1; seed <= 80; seed += 1) {
      const rows = [row("a", dates.slice(0, 2), (seed * 7) % 31 - 3, (seed % 3 + 1) / 2), row("b", dates.slice(1), (seed * 11) % 31, .5), row("c", [dates[0]], (seed * 13) % 31, 1), row("d", [dates[2]], (seed * 19) % 31, 1)];
      const capacity = Object.fromEntries(dates.map((d, i) => [d, ((seed + i) % 3 + 1) / 2]));
      const result = optimizeIntervalPortfolio(rows, capacity);
      expect(result.status, `fixture ${seed}`).toBe("OPTIMAL");
      expect(result.portfolioValue, `fixture ${seed}`).toBeCloseTo(exhaustiveValue(rows, capacity), 9);
      rows.forEach((r) => { expect(result.accepted[r.key]).toBeGreaterThanOrEqual(0); expect(result.accepted[r.key]).toBeLessThanOrEqual(r.expectedRooms); });
      dates.forEach((d) => expect(rows.reduce((s, r) => s + (r.occupiedDates.includes(d) ? result.accepted[r.key] : 0), 0)).toBeLessThanOrEqual(capacity[d] + 1e-9));
      const expanded = optimizeIntervalPortfolio(rows, Object.fromEntries(dates.map((d) => [d, capacity[d] + .5])));
      expect(expanded.portfolioValue).toBeGreaterThanOrEqual(result.portfolioValue - 1e-9);
      expect(optimizeIntervalPortfolio(rows.slice().reverse(), capacity)).toEqual(result);
    }
  });

  it("declines nonprofitable demand and preserves arbitrary fractional volume", () => {
    const result = optimizeIntervalPortfolio([row("a", dates.slice(0, 2), 10, .123456), row("b", [dates[0]], -1, 100)], { [dates[0]]: .1, [dates[1]]: 3 });
    expect(result.accepted).toEqual({ a: .1, b: 0 }); expect(result.portfolioValue).toBe(1);
  });

  it.each([
    [[row("a", [dates[0], dates[2]], 10)], Object.fromEntries(dates.map((d) => [d, 1])), {}, "SOLVER_INCOMPLETE_PATH"],
    [[row("a", [dates[0]], null)], { [dates[0]]: 1 }, {}, "SOLVER_INVALID_ITINERARY"],
    [[row("a", [dates[0]], 10)], { [dates[0]]: 1 }, { maxResidualRelaxations: 0 }, "SOLVER_WORK_LIMIT"],
    [[row("a", [dates[0]], 10)], { [dates[0]]: 1 }, { maxNights: 0 }, "SOLVER_MODEL_LIMIT"],
  ])("returns explicit unavailable results on invalid or bounded models", (rows, capacity, limits, reason) => expect(optimizeIntervalPortfolio(rows, capacity, limits)).toMatchObject({ status: "UNAVAILABLE", reason }));

  it("independently rejects infeasible and falsely optimal certificates", () => {
    const rows = [row("a", [dates[0]], 10)];
    const capacityByDate = { [dates[0]]: 1 };
    expect(certifyIntervalPortfolio({ itineraries: rows, capacityByDate, accepted: { a: 2 }, arcs: [], potentials: [0, 0] }).valid).toBe(false);
    const arcs = [{ from: 0, to: 1, capacity: 1, flow: 0, cost: 0 }, { from: 1, to: 0, capacity: 1, flow: 0, cost: -10, key: "a" }];
    expect(certifyIntervalPortfolio({ itineraries: rows, capacityByDate, accepted: { a: 0 }, arcs, potentials: [0, 0] })).toMatchObject({ valid: false, reason: "OBJECTIVE_CERTIFICATE" });
    expect(certifyIntervalPortfolio({ itineraries: rows, capacityByDate, accepted: { a: 0 }, arcs: arcs.slice(0, 1), potentials: [0, 0] })).toMatchObject({ valid: false, reason: "MODEL_CERTIFICATE" });
    expect(certifyIntervalPortfolio({ itineraries: rows, capacityByDate, accepted: { a: 1 }, arcs, potentials: [0, 0] })).toMatchObject({ valid: false, reason: "MODEL_CERTIFICATE" });
  });

  it.each([
    [null, {}, "SOLVER_INVALID_MODEL"],
    [[], null, "SOLVER_INVALID_MODEL"],
    [[], [], "SOLVER_INVALID_MODEL"],
    [[null], {}, "SOLVER_INVALID_ITINERARY"],
    [[{ ...row("a", [dates[0]], 10), key: 1 }], { [dates[0]]: 1 }, "SOLVER_INVALID_ITINERARY"],
    [[row("a", [dates[0]], 10), row("a", [dates[0]], 20)], { [dates[0]]: 1 }, "SOLVER_INVALID_ITINERARY"],
    [[], { "2027-02-30": 1 }, "SOLVER_INVALID_CAPACITY"],
  ])("returns safe unavailable for malformed public inputs", (rows, capacity, reason) => expect(optimizeIntervalPortfolio(rows, capacity)).toMatchObject({ status: "UNAVAILABLE", reason }));
});
