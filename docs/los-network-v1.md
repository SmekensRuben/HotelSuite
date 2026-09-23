# LOS / Shoulder-Night Network Displacement V1

## Data contract and preparation

The file-import service resolves its configured `basePath` + `targetPath` dynamically. The Stay Pattern lifecycle deliberately reuses every arrival-date group below the existing report root:

```text
hotels/{hotelUid}/reports/staydatepattern/...
```

It supports the importer’s grouped-document/list representation and grouped reservation subcollections without migrating or deleting raw data. `reservationId` is the Opera `RESV_NAME_ID` / `reservationNameId`. `insertDate`, arrival date, company and group name are not identity fields and `insertDate` has no role in V1 demand. Raw records are retained unchanged. Model preparation writes anonymous annual aggregates to:

```text
hotels/{hotelUid}/reports/stayPatternModel/years/{year}
```

Quote analysis reads only the selected annual aggregate documents. It never scans raw five-year reservations. Annual observations remain composable when users change selected historical years and contain only context, LOS and room volume—no guest, company or reservation identifiers.

### Build lifecycle

The callable Cloud Function `rebuildStayPatternModel` provides the initial/manual build from already imported history. Revenue Management → Group Quote Settings exposes **Rebuild Stay Pattern Model**, with either all discovered years or one optional year. No Opera upload is required.

After `processImportedFileToFirestore` has committed an entire successful staydatepattern import, it derives affected years from mapped arrival dates and resolved arrival-date paths and invokes the builder once for those years. It never rebuilds after individual reservation writes. Quote creation has no build call and reads only published `years/{year}` documents.

Each run sets `hotels/{hotelUid}/reports/stayPatternModel` to `BUILDING`, writes complete candidates below `builds/{runId}/years/{year}`, and atomically publishes prepared annual replacements in a transaction. The root then records `VALID` or `VALIDATION_FAILED`, `builtAt`, `sourceThroughDate`, `affectedYears`, trigger, and combined Transient/Group evidence. Annual documents record their own status, evidence, settings, exclusions, coverage, `builtAt`, and build run. A preparation exception leaves published annual documents untouched and restores a prior global `VALID` state (or marks it `STALE` when no valid model exists), with failure metadata for audit.

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

The horizon runs from arrival minus `2 × maxModeledLos` through checkout plus `2 × maxModeledLos` (exclusive). Existing PMS, forecast, calendar and contribution maps are prepared once for the horizon. Missing required shoulder-date PMS or contribution data makes the network unavailable; values are not replaced by zero.

Existing forecasts remain authoritative. For each type/scenario, future occupancy is still `max(0, final forecast - current OTB)`. Chronological deconvolution subtracts carryover from earlier synthetic itineraries and distributes only the remaining arrivals by LOS share. Historical volume is never added. Synthetic occupancy is reconciled with the source occupancy; carryover excess is recorded and the default network-fit gate is 5% WAPE.

## Capacity, displacement and contribution

Current OTB is hard committed. Available capacity is sellable inventory minus hard committed rooms. The requested group is subtracted only on its requested stay dates. The same deterministic itinerary ordering is used without and with the group:

1. highest average contribution per RN;
2. Transient before Group within numeric tolerance;
3. earlier arrival;
4. shorter LOS;
5. stable itinerary key.

This is deterministic network allocation, not optimal revenue management or bid-price optimization. Fractional expected rooms are preserved. An itinerary is accepted only up to the minimum remaining capacity across its **complete** path, and that accepted volume consumes every night.

The difference between without-group and with-group acceptance is valued over the complete itinerary using the existing nightly Transient Value or Future Group Value. Nights in `[groupArrival, groupCheckout)` are core; all other lost nights are shoulder. Network RN can exceed requested RN. Low/P25, Base/P50 and High/P75 group scenarios are independently reconstructed and simulated.

When all reconciliation, coverage, network-fit, capacity, sample and contribution gates pass, LOS lost contribution **replaces** legacy stay-date opportunity cost in the unchanged Economic Floor structure. It is never added to legacy contribution. Variable room cost, breakfast cost, BQT contribution, commission, VAT and commercial floor normalization are unchanged. On any failure `LOS_NETWORK_FALLBACK_TO_STAY_DATE` retains numerically identical legacy behavior and records the factual reason.

Snapshots persist both `legacyStayDateDisplacement` and the compact `losNetworkDisplacement`; synthetic itinerary rows are not persisted. Versions are `stay-pattern-v1`, `los-network-v1`, and `group-contribution-v5-los-network`; Pricing Guidance remains `pricing-guidance-v1`.

## V1 boundaries

Future Group LOS represents expected inventory paths. It does not model reducing rooms on one night, shifting dates, partially accepting a commercial group, or alternative-date negotiation. V1 also does not implement cancellation/wash or booking-pace modelling, insert-date inference, overbooking, BAR/bid-price/LP optimization, competitor group-price prediction, conversion probability, ML/OpenAI pricing, meeting/function-space constraints, or BQT displacement.
