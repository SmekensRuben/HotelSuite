# Contribution portfolio contract

Policy: `PROTECT_COMMITTED_MAXIMIZE_FUTURE_NET_CONTRIBUTION`.
Contribution version: `group-contribution-v5-optimal-portfolio`.
LOS version: `los-network-v2-optimal-portfolio`.
Solver version: `interval-min-cost-circulation-v1`.

Current commitments consume capacity in both portfolios. Forecast demand and valuation assumptions are identical before and after accepting the full requested group. Net future contribution incorporates the existing room cost, transient distribution/breakfast contribution and expected future-group commission contracts. Pipeline package ADR remains informational. Nonprofitable optional demand is declined. The proposed group's commission and costs are accounted for once in its own contribution/floor, not in future demand.

## Per-night objective

For each type, accept between zero and its future demand, with total accepted rooms at most remaining capacity. Sort positive net contribution descending, use a stable business-type tie and fill each bucket up to its demand. The exchange argument proves optimality: replacing a lower-value accepted room with an available higher-value room cannot decrease contribution. This calculation runs independently before and after the new group. Opportunity cost is the difference of portfolio values, not a valuation of demand that was already rejected. Unknown values on positive future demand make the portfolio unavailable; zero demand does not require a value.

## LOS objective and proof

For itinerary `j`, fractional accepted room arrivals `x[j]` satisfy `0 <= x[j] <= demand[j]`. Each occupied night contributes one unit to its nightly constraint: `sum(x[j] for paths occupying date d) <= availableCapacity[d]`. Maximize `sum(netCompletePathContribution[j] * x[j])`. There is no rounding to bookings or acceptance of partial paths.

The time-line graph has one node at each date boundary. Forward arcs connect adjacent boundaries, with capacity equal to that night's available rooms and zero cost. Each complete itinerary adds a backward arc from departure to arrival, with capacity equal to its forecast room arrivals and cost equal to negative net full-path contribution. An itinerary flow returns along the forward time-line arcs over every occupied night. Flow conservation therefore equates each forward flow with the sum of accepted overlapping paths. Feasible circulations and feasible interval portfolios correspond in both directions, with circulation cost equal to negative portfolio contribution.

A deterministic feasible warm start reduces work. Residual negative cycles are then found by Bellman-Ford and augmented by their complete residual bottleneck. Reverse residual arcs permit replacing previously accepted business, which is why average-per-RN ordering alone is insufficient. A feasible circulation with no residual negative cycle is a minimum-cost circulation.

The independent certificate checks that graph arcs correspond to the original interval/demand/capacity model, accepted volumes obey every demand/nightly bound, original arc flows conserve flow, and accepted value equals negative circulation cost. For node potentials `p`, reduced arc cost is `r = cost + p[from] - p[to]`. Every feasible circulation has cost at least `sum(capacity * min(0, r))`, because potential terms cancel under flow conservation. The certificate compares achieved primal cost with this dual lower bound. It accepts only a finite gap within the configured numerical tolerance. This certifies the returned portfolio against a valid upper bound, including all competing complete paths.

Tests also compare 80 small, independently enumerated fractional portfolios. Their half-unit capacities/demand can be scaled to integers; interval incidence has consecutive ones, so its vertices are integral in that scale. The exhaustive oracle covers the full optimum, rather than copying the solver. Fixtures include the greedy counterexample: A uses both nights for €300, B uses night one for €200 and C uses night two for €50. The optimum is €300.

## Bounds, fallback and portfolio difference

The solver is bounded to 180 nights, 6,000 itineraries, 20,000 augmentations and 10,000,000 residual relaxations. Callers may lower these limits, never raise them. Default numeric tolerance is `1e-9`; the certificate reports its scale-dependent allowed gap. A model, iteration, work, malformed-path or numerical failure returns an explicit unavailable reason. It never publishes an uncertified greedy approximation. LOS then falls back to the validated per-night calculation and persists `LOS_NETWORK_FALLBACK_TO_STAY_DATE` plus the reason.

LOS net opportunity cost is `portfolioWithoutGroup.value - portfolioWithGroup.value`. Positive lost RN and gross lost contribution remain diagnostics; replacement contribution reduces net cost. A €400 rejected path replaced by a €100 accepted path costs €300, not €400. Signed type contributions may be negative when that type supplies replacement business. Low/Base/High are distinct sensitivity portfolios, not probability bounds.

The core horizon defines synthetic arrival generation and occupancy fit. Its complete `maxModeledLos - 1` capacity/value tail supplies the final generated arrivals without creating another layer of tail arrivals. Genuine occupied shoulder dates require known source capacity and contribution. Empty unused edge dates are irrelevant. The optimized population is the documented bounded core-arrival population, not an infinite hotel booking network; no demand beyond it is invented.

Physical infeasibility, unknown required inputs and zero requested room nights override LOS, all floors, Target/Stretch and the simulator. V2/V3 nightly Breakfast Pax and BQT revenue require explicit known values; a blank or null value is not an invented zero cost or contribution. Optimizer success cannot make an infeasible full group saleable. Saved snapshots retain their original model versions and frozen evidence; historical detail/outcome reads never trigger recalculation. New unavailable analyses must be explicit unavailable drafts.

## Unmodeled decisions

This optimizes deterministic forecast contribution under existing assumptions. It does not forecast conversion, wash or pace, optimize room prices, meeting-space/BQT displacement, integer indivisible group acceptance, overbooking or alternate dates. Fractional volumes represent expected room arrivals. It does not certify the forecasts as real demand or the configured Opera source economics as accounting truth.


## Prepared-source publication freshness

Current LOS reads `getStayPatternModelEvidence`, which returns root metadata with the selected anonymous annual documents. `combineStayPatternYears(annualModels, selectedYears, rootMetadata)` checks current aggregate versions, root `VALID`, publication version `stay-pattern-publication-v2`, active/completed root build identity, the per-year publication map and equality of the nonnegative integer `sourceRevision` and `publishedSourceRevision`. A failed rebuild cannot hide behind old valid annual documents. Missing legacy publication proof requires a successful rebuild, with explicit per-night fallback until then. Build failures preserve published historical aggregates while setting the current root `STALE`; failed runs have durable receipts. Each rebuild captures the source revision before reading raw inputs; publication checks that revision and the active run transactionally before replacing annuals and the root. An import during a build therefore prevents that build from publishing fresh evidence. A requested single-year rebuild expands to all retained annuals when sources changed, so untouched annuals cannot inherit a new revision. Annual room-arrival training remains arrival-year based, while stay-year reconciliation includes prior-year carry-in.

## Unknown source counts and saved calculation evidence

Annual reconciliation checks the union of authoritative dates and reconstructed occupied nights. Explicit nonnegative finite numeric counts (including zero) are required; null, blanks, booleans, negative/nonfinite counts and missing occupied dates invalidate the model. Invalid dates and reasons survive aggregate combination and LOS fallback. January reconciliation requires prior-December carry-in authority without moving arrival-year training observations.

Raw/reconciliation imports invalidate the root and increment its source revision atomically with the data write and chunk checkpoint. They rebuild every affected retained year; checkpoint replay does not increment twice. Corrupt explicit revisions fail closed. A failed initial read cannot mark a newer completed publication stale. Every browser analysis run refetches history, settings, compset, live sources and publication evidence, including repeated identical inputs. Loading failures remain explicit; a validated per-night analysis can still be used when LOS evidence is unavailable.

New contribution snapshots use `group-quote-contribution-snapshot-v2`. They retain frozen per-night before/after optimized portfolios, scenario assumptions/totals, costs, commission, VAT and the floor calculation. LOS snapshots separately retain their solver/publication evidence and explicit error reasons. Historical saved versions are rendered as saved. Optional competitor observations are explicitly selected by users with both intelligence create/update permissions and commit atomically with the outcome; quote-only users can save an outcome without that side effect.
