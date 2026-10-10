export const PORTFOLIO_POLICY = "PROTECT_COMMITTED_MAXIMIZE_FUTURE_NET_CONTRIBUTION";
export const INTERVAL_SOLVER_VERSION = "interval-min-cost-circulation-v1";
export const INTERVAL_SOLVER_LIMITS = Object.freeze({ maxNights: 180, maxItineraries: 6000, maxAugmentations: 20000, maxResidualRelaxations: 10000000, numericTolerance: 1e-9 });

const valid = (value) => typeof value === "number" && Number.isFinite(value);
const fail = (reason) => ({ status: "UNAVAILABLE", reason, solverVersion: INTERVAL_SOLVER_VERSION });
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const realDate = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

/** Independent primal/dual certificate: a feasible circulation attains its dual bound. */
export function certifyIntervalPortfolio({ itineraries, capacityByDate, accepted, arcs, potentials, tolerance = 1e-9 }) {
  if (!Array.isArray(itineraries) || !record(capacityByDate) || !record(accepted) || !Array.isArray(arcs) || !Array.isArray(potentials) || !valid(tolerance) || tolerance <= 0) return { valid: false, reason: "MODEL_CERTIFICATE" };
  const dates = Object.keys(capacityByDate).sort(), indices = new Map(dates.map((d, i) => [d, i]));
  if (arcs.some((a) => !record(a)) || dates.some((d, i) => !realDate(d) || !valid(capacityByDate[d]) || capacityByDate[d] < 0 || (i && Date.parse(`${d}T00:00:00Z`) - Date.parse(`${dates[i - 1]}T00:00:00Z`) !== 86400000)) || itineraries.some((r) => !record(r)) || new Set(itineraries.map((r) => r.key)).size !== itineraries.length) return { valid: false, reason: "MODEL_CERTIFICATE" };
  if (arcs.length !== dates.length + itineraries.length || potentials.length !== dates.length + 1 || potentials.some((p) => !valid(p))) return { valid: false, reason: "MODEL_CERTIFICATE" };
  for (let i = 0; i < dates.length; i += 1) {
    const arc = arcs[i];
    if (arc.from !== i || arc.to !== i + 1 || arc.capacity !== capacityByDate[dates[i]] || arc.cost !== 0) return { valid: false, reason: "MODEL_CERTIFICATE" };
  }
  const byKey = new Map(arcs.slice(dates.length).map((a) => [a.key, a]));
  for (const row of itineraries) {
    if (!record(row) || typeof row.key !== "string" || !Array.isArray(row.occupiedDates) || !row.occupiedDates.length) return { valid: false, reason: "MODEL_CERTIFICATE" };
    const arc = byKey.get(row.key), start = indices.get(row.occupiedDates[0]);
    if (!arc || row.occupiedDates.some((d, i) => indices.get(d) !== start + i) || arc.to !== start || arc.from !== start + row.occupiedDates.length || arc.capacity !== row.expectedRooms || arc.cost !== -row.itineraryContributionPerRoom || accepted[row.key] !== arc.flow) return { valid: false, reason: "MODEL_CERTIFICATE" };
  }
  const occupancy = Object.fromEntries(Object.keys(capacityByDate).map((d) => [d, 0]));
  let value = 0;
  for (const row of itineraries) {
    const rooms = accepted[row.key];
    if (!valid(rooms) || rooms < -tolerance || rooms > row.expectedRooms + tolerance) return { valid: false, reason: "DEMAND_BOUND" };
    value += rooms * row.itineraryContributionPerRoom;
    for (const d of row.occupiedDates) occupancy[d] += rooms;
  }
  if (Object.entries(occupancy).some(([d, rooms]) => !valid(rooms) || rooms > capacityByDate[d] + tolerance || rooms < -tolerance)) return { valid: false, reason: "NIGHTLY_CAPACITY" };
  const balance = Array(potentials.length).fill(0);
  const capacityScale = Math.max(1, ...arcs.map((a) => a.capacity));
  let cost = 0, dualCostBound = 0, scale = 1;
  for (const arc of arcs) {
    if (!valid(arc.flow) || arc.flow < -tolerance || arc.flow > arc.capacity + tolerance) return { valid: false, reason: "ARC_BOUND" };
    balance[arc.from] -= arc.flow; balance[arc.to] += arc.flow;
    cost += arc.flow * arc.cost;
    const reduced = arc.cost + potentials[arc.from] - potentials[arc.to];
    dualCostBound += Math.min(0, reduced) * arc.capacity;
    scale += Math.abs(arc.flow * arc.cost) + Math.abs(reduced * arc.capacity);
  }
  const allowedGap = tolerance * scale;
  const objectiveGap = cost - dualCostBound;
  if (balance.some((b) => !valid(b) || Math.abs(b) > tolerance * capacityScale)) return { valid: false, reason: "FLOW_CONSERVATION" };
  if (!valid(value) || !valid(objectiveGap) || Math.abs(value + cost) > allowedGap || objectiveGap < -allowedGap || objectiveGap > allowedGap) return { valid: false, reason: "OBJECTIVE_CERTIFICATE" };
  return { valid: true, value, occupancy, primalValue: value, dualValueUpperBound: -dualCostBound, objectiveGap, allowedGap };
}

/** Maximize sum(value * accepted) subject to complete interval demand and nightly capacities. */
export function optimizeIntervalPortfolio(itineraries = [], capacityByDate = {}, inputLimits = {}) {
  if (!Array.isArray(itineraries) || !record(capacityByDate) || !record(inputLimits)) return fail("SOLVER_INVALID_MODEL");
  const limits = { ...INTERVAL_SOLVER_LIMITS, ...inputLimits };
  const dates = Object.keys(capacityByDate).sort();
  if (!valid(limits.numericTolerance) || limits.numericTolerance <= 0 || limits.numericTolerance > 1e-7) return fail("SOLVER_INVALID_LIMITS");
  for (const key of ["maxNights", "maxItineraries", "maxAugmentations", "maxResidualRelaxations"]) if (!Number.isInteger(limits[key]) || limits[key] < 0 || limits[key] > INTERVAL_SOLVER_LIMITS[key]) return fail("SOLVER_INVALID_LIMITS");
  if (dates.length > Math.min(limits.maxNights, INTERVAL_SOLVER_LIMITS.maxNights) || itineraries.length > Math.min(limits.maxItineraries, INTERVAL_SOLVER_LIMITS.maxItineraries)) return fail("SOLVER_MODEL_LIMIT");
  if (dates.some((d, i) => !realDate(d) || !valid(capacityByDate[d]) || capacityByDate[d] < 0 || (i && Date.parse(`${d}T00:00:00Z`) - Date.parse(`${dates[i - 1]}T00:00:00Z`) !== 86400000))) return fail("SOLVER_INVALID_CAPACITY");
  if (itineraries.some((row) => !record(row) || typeof row.key !== "string" || !row.key)) return fail("SOLVER_INVALID_ITINERARY");
  const ordered = itineraries.slice().sort((a, b) => String(a.key).localeCompare(String(b.key)));
  const seen = new Set(), indices = new Map(dates.map((d, i) => [d, i]));
  for (const row of ordered) {
    if (!row.key || seen.has(row.key) || !valid(row.expectedRooms) || row.expectedRooms < 0 || !valid(row.itineraryContributionPerRoom) || !Array.isArray(row.occupiedDates) || !row.occupiedDates.length) return fail("SOLVER_INVALID_ITINERARY");
    seen.add(row.key);
    const start = indices.get(row.occupiedDates[0]);
    if (start === undefined || row.occupiedDates.some((d, i) => indices.get(d) !== start + i)) return fail("SOLVER_INCOMPLETE_PATH");
  }
  const arcs = dates.map((d, i) => ({ from: i, to: i + 1, capacity: capacityByDate[d], cost: 0, flow: 0 }));
  for (const row of ordered) arcs.push({ from: indices.get(row.occupiedDates.at(-1)) + 1, to: indices.get(row.occupiedDates[0]), capacity: row.expectedRooms, cost: -row.itineraryContributionPerRoom, flow: 0, key: row.key });
  // A feasible warm start reduces work. Only the independently certified
  // circulation optimum below is ever returned as an economic result.
  const warmOrder = ordered.slice().sort((a, b) => b.itineraryContributionPerRoom / b.occupiedDates.length - a.itineraryContributionPerRoom / a.occupiedDates.length || a.key.localeCompare(b.key));
  const itineraryArcs = new Map(arcs.filter((a) => a.key).map((a) => [a.key, a]));
  for (const row of warmOrder) {
    if (row.itineraryContributionPerRoom <= 0) continue;
    const amount = Math.max(0, Math.min(row.expectedRooms, ...row.occupiedDates.map((d) => arcs[indices.get(d)].capacity - arcs[indices.get(d)].flow)));
    itineraryArcs.get(row.key).flow = amount;
    row.occupiedDates.forEach((d) => { arcs[indices.get(d)].flow += amount; });
  }
  const nodes = dates.length + 1, tolerance = limits.numericTolerance;
  let augmentations = 0, residualRelaxations = 0, potentials = Array(nodes).fill(0);
  while (true) {
    const residual = [];
    arcs.forEach((arc, index) => {
      if (arc.capacity - arc.flow > tolerance) residual.push({ from: arc.from, to: arc.to, capacity: arc.capacity - arc.flow, cost: arc.cost, index, direction: 1 });
      if (arc.flow > tolerance) residual.push({ from: arc.to, to: arc.from, capacity: arc.flow, cost: -arc.cost, index, direction: -1 });
    });
    const distance = Array(nodes).fill(0), predecessor = Array(nodes).fill(null);
    let changed = -1;
    for (let iteration = 0; iteration < nodes; iteration += 1) {
      changed = -1;
      for (const edge of residual) {
        residualRelaxations += 1;
        if (residualRelaxations > limits.maxResidualRelaxations) return fail("SOLVER_WORK_LIMIT");
        if (distance[edge.to] > distance[edge.from] + edge.cost + tolerance) {
          distance[edge.to] = distance[edge.from] + edge.cost; predecessor[edge.to] = edge; changed = edge.to;
        }
      }
      if (changed === -1) break;
    }
    if (changed === -1) { potentials = distance; break; }
    if (augmentations >= limits.maxAugmentations) return fail("SOLVER_ITERATION_LIMIT");
    let cursor = changed;
    for (let i = 0; i < nodes; i += 1) { if (!predecessor[cursor]) return fail("SOLVER_RESIDUAL_FAILURE"); cursor = predecessor[cursor].from; }
    const start = cursor, cycle = [];
    do { const edge = predecessor[cursor]; if (!edge || cycle.length > nodes) return fail("SOLVER_RESIDUAL_FAILURE"); cycle.push(edge); cursor = edge.from; } while (cursor !== start);
    const cost = cycle.reduce((sum, e) => sum + e.cost, 0), amount = Math.min(...cycle.map((e) => e.capacity));
    if (!(cost < -tolerance) || !valid(amount) || amount <= tolerance) return fail("SOLVER_NUMERIC_FAILURE");
    for (const edge of cycle) arcs[edge.index].flow += edge.direction * amount;
    augmentations += 1;
  }
  const accepted = Object.fromEntries(ordered.map((r) => [r.key, itineraryArcs.get(r.key).flow]));
  const certificate = certifyIntervalPortfolio({ itineraries: ordered, capacityByDate, accepted, arcs, potentials, tolerance });
  if (!certificate.valid) return fail(`SOLVER_${certificate.reason}`);
  const remaining = Object.fromEntries(dates.map((d) => [d, Math.max(0, capacityByDate[d] - certificate.occupancy[d])]));
  return { status: "OPTIMAL", solverVersion: INTERVAL_SOLVER_VERSION, policy: PORTFOLIO_POLICY, accepted, remaining, portfolioValue: certificate.value, orderedKeys: ordered.map((r) => r.key), diagnostics: { augmentations, residualRelaxations, nights: dates.length, itineraries: ordered.length, certificate: { primalValue: certificate.primalValue, dualValueUpperBound: certificate.dualValueUpperBound, objectiveGap: certificate.objectiveGap, allowedGap: certificate.allowedGap } } };
}
