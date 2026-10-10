# LOS / Shoulder-Night Network Displacement

The current allocation policy is V2, `los-network-v2-optimal-portfolio`, introduced by the 2026-10-10 audit remediation. The historical training/source contract remains `stay-pattern-v1`. Saved V1 analyses remain historical snapshots and are never silently recalculated. See [contribution optimization](contribution-optimization.md) for the solver proof, numerical bounds and regression oracle.

## Data contract and preparation

The file-import service resolves its configured `basePath` + `targetPath` dynamically. The Stay Pattern lifecycle deliberately reuses every arrival-date group below the existing report root:

```text
hotels/{hotelUid}/reports/staydatepattern/...
```

It supports the importer’s grouped-document/list representation and grouped reservation subcollections without migrating or deleting raw data. `reservationId` is the Opera `RESV_NAME_ID` / `reservationNameId`. `insertDate`, arrival date, company and group name are not identity fields and `insertDate` has no role in V1 demand. Raw records are retained unchanged. Model preparation writes anonymous annual aggregates to:

```text
hotels/{hotelUid}/reports/stayPatternModel/years/{year}
```

Quote analysis reads only the selected annual aggregate documents. It never scans raw five-year reservations. Annual observations remain composable when users change selected historical years and contain only context, LOS and room volume—no guest, company or reservation identifiers. Quote source reads include both root metadata and annual documents. Current activation requires root `VALID`, publication version `stay-pattern-publication-v2`, matching active/completed root build identities and selected annual build identities matching `publishedYearBuildRunIds`. Root `STALE`, `BUILDING`, validation failure, missing publication proof or incompatible aggregate versions force explicit stay-date fallback even if old annual documents still look valid. Legacy published roots need a successful rebuild before current LOS activation; historical saved quote snapshots remain untouched.

### Build lifecycle

The callable Cloud Function `rebuildStayPatternModel` provides the initial/manual build from already imported history. Revenue Management → Group Quote Settings exposes **Rebuild Stay Pattern Model**, with either all discovered years or one optional year. No Opera upload is required.

After `processImportedFileToFirestore` has committed an entire successful staydatepattern import, it derives affected years from mapped arrival dates and resolved arrival-date paths and invokes the builder once for those years. It never rebuilds after individual reservation writes. Quote creation has no build call and reads only published `years/{year}` documents.

Each run sets `hotels/{hotelUid}/reports/stayPatternModel` to `BUILDING`, writes complete candidates below `builds/{runId}/years/{year}`, and atomically publishes prepared annual replacements in a transaction. The root then records `VALID` or `VALIDATION_FAILED`, `builtAt`, `sourceThroughDate`, `affectedYears`, trigger, combined Transient/Group evidence and the captured `publishedSourceRevision`. Annual documents record their own status, evidence, settings, exclusions, coverage, `builtAt`, and build run. A read, preparation, staging or publication exception leaves published annual documents untouched and marks the current root `STALE`, including when the previous root was `VALID`. The root is marked `BUILDING` before raw/history collection. Durable build receipts record completion or failure. Publication checks both the active build identity and unchanged source revision transactionally, so a superseded run or concurrent source import cannot overwrite a newer publication or clear its state. Dirty source revisions force a full rebuild even when a single year was requested; retained annuals with removed source evidence are rebuilt and must pass validation again. Consumers require `sourceRevision === publishedSourceRevision`; unknown revisions require fallback. If failure metadata itself cannot be persisted, the original failure is returned and that persistence failure is logged; this requires operator recovery rather than a claim of successful invalidation.

### Current-hotel read-only validation run

`docs/stay-pattern-current-hotel-validation.json` captures the factual reconciliation run performed on 2026-09-16 without guest identifiers. The discovered raw structure is `hotels/{hotelUid}/reports/staydatepattern/{arrivalDate}/{reservationDocument}`. Although `historyquotes` spans 2022–2026, the currently readable raw Stay Pattern import contains arrivals only from 2022-01-01 through 2022-01-31 (1,466 records). Consequently every year fails and LOS Network must remain on `LOS_NETWORK_FALLBACK_TO_STAY_DATE`. The manual/automatic server lifecycle persists that evidence as `VALIDATION_FAILED`; it never manufactures absent raw history.

## Training rules

Rate code is normalized with trim and uppercase and is the **only** business-type input:

* `rateCode == NORATE` → excluded Postmaster;
* `rateCode` starts with two digits (`^[0-9]{2}`) → Transient;
* every other valid, non-empty rate code → Group;
* empty, null or unusable values → Unclassified and excluded.

`groupName` and `companyName` are explicitly not classification inputs. `NORATE`, cancelled, no-show, unknown-status, unclassified and invalid records remain in raw Firebase but contribute nothing to training or reconstructed occupancy.

The current imported source contains full statuses `CHECKED OUT`, `CANCELLED`, and `NO SHOW`, plus short values `CKOT`, `CXL`, and `NOSH` (the source field is also seen with its existing `shortResevationStatus` spelling). The centralized normalizer additionally accepts underscore/spacing and known `CHECKEDOUT`, `DEPARTED`, and US-spelling variants. Unknown statuses are never silently considered realized. Valid stays require valid checkout-exclusive arrival/departure dates, positive stated nights and rooms, departure after arrival, and exact agreement between date difference and `nights`.

Each valid reservation contributes `numberOfRooms` on every `arrivalDate <= stayDate < departureDate`. LOS samples are room-arrival weighted and separate for Transient and Group. Share indicators (`shareAmount`, `shareAmountPerStay`) are counted for diagnostics but V1 does not invent a share-room deduplication rule; reconciliation exposes material double counting.

Exact LOS is modelled through `maxModeledLos` (default 14). Longer stays are reported as `LONG_STAY_OUTSIDE_MODEL` volume rather than truncated. Both business types require at least 98% modelled room-arrival coverage.

## Historical reconciliation and settings

Reconstructed Transient and Group rooms are compared independently with `individualRooms` and `groupRooms` at `hotels/{hotelUid}/reports/historyquotes/consideredDates/{stayDate}`. Each result contains compared dates, mean/median absolute error, WAPE, signed aggregate bias, matching-date share, and the ten largest combined mismatches.

Defaults are: two rooms absolute tolerance, 3% relative tolerance, 90% matching dates, and 5% maximum WAPE. **Both** business types must pass. Otherwise the stable reason is `LOS_NETWORK_VALIDATION_FAILED` and stay-date displacement remains authoritative.

## LOS selection and demand transformation

For each future arrival and business type, comparables are attempted in this fixed order:

1. same day of week + month;
2. same day of week + existing business season;
3. same day of week;
4. same business season;
5. all selected history.

The first tier with 30 room arrivals and five distinct arrival dates is used. If none qualifies, the first contextually relevant non-empty tier remains usable with LOW confidence; the order is never reversed merely to enlarge the sample. Shares retain exact LOS and sum to one.

The core synthetic-arrival and occupancy-fit horizon runs from arrival minus `2 × maxModeledLos` through checkout plus `2 × maxModeledLos` (exclusive). `createLosNetworkHorizon` also supplies a capacity/valuation tail through the final core arrival plus its complete maximum LOS. Prepare PMS, forecast, calendar and contribution maps once over `valuationDates`, but generate arrivals and fit occupancy only over `horizonDates`. Tail dates never generate more synthetic arrivals. Only occupied itinerary dates require tail data; absent irrelevant empty edges do not invalidate a network. Missing genuine shoulder-night capacity or value keeps LOS unavailable, and values are never replaced by zero.

Existing forecasts remain authoritative. For each type/scenario, future occupancy is still `max(0, final forecast - current OTB)`. Chronological deconvolution subtracts carryover from earlier synthetic itineraries and distributes only the remaining arrivals by LOS share. Historical volume is never added. Synthetic occupancy is reconciled with the source occupancy; carryover excess is recorded and the default network-fit gate is 5% WAPE.

## Capacity, displacement and contribution

Current OTB is hard committed. Available capacity is sellable inventory minus hard committed rooms. The requested complete group is subtracted only on its requested stay dates. Both portfolios use exactly the same forecast demand and net values. Each optimizes complete interval paths jointly with nightly capacity and demand bounds; fractional expected room arrivals are retained. The implementation uses bounded minimum-cost circulation, verifies an independent primal/dual certificate and fails explicitly on numerical or work limits. It does not use average contribution per RN as its final allocation policy.

Opportunity cost is the signed difference between optimized portfolio contributions before and after the group. Replacement paths reduce opportunity cost. Positive lost-room-night diagnostics are reported separately; they are not a proxy for the net contribution difference. Full itinerary values use the existing nightly Transient Value or Future Group Value. Nights in `[groupArrival, groupCheckout)` are core; all other lost nights are shoulder. Network RN can exceed requested RN. Low/P25, Base/P50 and High/P75 group scenarios are independently reconstructed and simulated.

When all reconciliation, coverage, network-fit, capacity, sample and contribution gates pass, LOS net portfolio opportunity cost **replaces** the validated per-night portfolio opportunity cost in the unchanged Economic Floor structure. It is never added to legacy contribution. Variable room cost, breakfast cost, BQT contribution, commission, VAT and commercial floor normalization are unchanged. On any failure `LOS_NETWORK_FALLBACK_TO_STAY_DATE` retains the validated per-night portfolio result and records the factual reason. Physical shortfalls, unknown required inputs and zero requested room nights remain blocking in the replacement layer, Pricing Guidance and simulator.

Snapshots persist both `legacyStayDateDisplacement` and the compact `losNetworkDisplacement`; synthetic itinerary rows are not persisted. Versions are `stay-pattern-v1`, `los-network-v2-optimal-portfolio`, and `group-contribution-v5-optimal-portfolio`; Pricing Guidance remains `pricing-guidance-v1`. Physical feasibility is `physical-feasibility-v2-required-inputs`. Portfolio snapshots include before/after values, gross lost and replacement contributions, policy, bounded solver diagnostics and certificate gaps. Accepted synthetic paths are not persisted.

## Model boundaries

Future Group LOS represents expected inventory paths. It does not model reducing rooms on one night, shifting dates, partially accepting a commercial group, or alternative-date negotiation. V1 also does not implement cancellation/wash or booking-pace modelling, insert-date inference, overbooking, BAR or bid-price optimization, competitor group-price prediction, conversion probability, ML/OpenAI pricing, meeting/function-space constraints, or BQT displacement.

## Canonical preparation

`functions/src/stayPatternPreparation.mjs` is the sole pure annual reservation normalization, classification, occupancy reconstruction and reconciliation builder. The server lifecycle and browser diagnostic adapter call the same builder. Server imports/publication remain in `stayPatternModel.js`; browser analysis continues to read published anonymous annual aggregates only. Node 22.12 or later is required for the synchronous CommonJS-to-ES-module bridge. Strict date validation excludes impossible calendar dates instead of rolling them into another month. Training observations and room-arrival volume remain grouped by arrival year; annual occupancy reconciliation includes all realized reservations overlapping the selected stay year, including December arrivals occupying January.
