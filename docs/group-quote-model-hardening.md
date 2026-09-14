# Group Quote Model Hardening Notes

This note records the controlled hardening applied after the AS-BUILT snapshot in `group-quote-analysis-as-built.md`. Future Group Value V2 subsequently supersedes the future-group rate proxy described here; the Economic Floor structure and VAT formulas remain unchanged.

## Forecast selection

Group comparable selection now preserves contextual specificity:

1. first Tier 1–4 set with at least five rows (`NORMAL`);
2. otherwise first Tier 1–4 set with at least three rows (`LIMITED`);
3. otherwise first non-empty Tier 1–4 set (`EMERGENCY`);
4. only when no contextual tier has data, Tier 5 is used.

`LIMITED`, `EMERGENCY`, and every Tier 5 result are `LOW` confidence. Tier 1 with at least eight rows can be `HIGH`; Tier 1–4 normal samples can be `MEDIUM`. Missing Group OTB or sellable inventory forces `LOW`.

Transient normal tiers still require six rows. If those fail, the first narrow unconstrained tier with at least three rows is used, then the first with one or two rows. Censored lower-bound rows are used only when no unconstrained evidence exists. A one/two-row unconstrained sample is `LOW` and emits `TRANSIENT_SAMPLE_LIMITED`.

Both engines exclude comparable stay dates that are not strictly earlier than the target, even if their years were selected. The development backtest also builds every target only from earlier stay-date rows and accepts an optional `selectedHistoricalYears` window.

## Calendar integrity

Derived `systemType:groupDemandEffect` regime entries are unique and sorted; underlying overlapping event IDs/names remain available. `SUPPRESS`, `NEUTRAL`, and `BOOST` remain contextual labels, never numeric multipliers.

For the selected/historical years, calendar coverage is the fraction of years overlapped by at least one active relevant event (`SCHOOL_HOLIDAY`, `PUBLIC_HOLIDAY`, `BRIDGE_DAY`, `BUSINESS_EVENT`, `CITYWIDE_COMPRESSION`, or `FESTIVE_PERIOD`). The threshold is **0.80**. When the target is interpreted as normal business and coverage is below 0.80, `HIGH` is capped at `MEDIUM` and `CALENDAR_COVERAGE_INCOMPLETE` is emitted. This is a coverage signal, not proof that every event was entered.

## Firestore paths

New event create/update/import operations use the canonical operational collection:

```text
hotels/{hotelUid}/demandCalendarEvents/{eventId}
```

Reads and subscriptions temporarily merge that collection with legacy:

```text
hotels/{hotelUid}/reports/demandCalendar/events/{eventId}
```

Canonical wins duplicate IDs. No automatic migration/deletion occurs. Category CRUD is deliberately unchanged at:

```text
hotels/{hotelUid}/settings/demandCalendarCategories/categories/{categoryId}
```

## Preparation and fetching

One local calculation run prepares historical transient observations, normalized Lighthouse Market demand, historical group observations, and a per-date calendar-feature map once, then reuses them for every requested stay date. PMS/Lighthouse/events are fetched once when Start Analysis receives a new submitted quote. Changing selected years or local comparable settings recalculates from the loaded source data and does not refetch those sources.

## Saved analysis validity

New quotes save:

```text
analysisStatus: "CURRENT"
analysisModelVersion: "group-contribution-v2-group-value"
integratedDisplacement: [{ stayDate, scenario: "BASE", ... }]
```

The old `displacementForecast` array remains for compatibility. Its transient-only `displacedRooms` is not reinterpreted; `legacyTransientOnlyDisplacement` explicitly identifies that diagnostic. `integratedDisplacement` is the authoritative newly saved Base result.

Editing stay dates, daily rooms/BQT, Breakfast Pax, commission, or analysis years marks `analysisStatus: "STALE"` with `analysisStaleReason: "QUOTE_INPUTS_CHANGED"`. A name-only edit does not. The detail page shows `SAVED_ANALYSIS_STALE` and does not present old forecast arrays as current.

## Data-quality and warning codes

Negative historical transient rooms are excluded. Historical group rooms above sellable inventory are excluded and reported. Missing Group OTB is distinguishable from genuine zero, uses zero only as a safe fallback, warns, and prevents `HIGH` confidence. Stable hardening codes are:

* `GROUP_SAMPLE_LIMITED`
* `GROUP_SAMPLE_VERY_LIMITED`
* `CALENDAR_COVERAGE_INCOMPLETE`
* `TRANSIENT_SAMPLE_LIMITED`
* `CURRENT_GROUP_OTB_MISSING`
* `INVALID_HISTORICAL_GROUP_SHARE`
* `SAVED_ANALYSIS_STALE`

## Explicit non-changes

No Market Pricing, Lighthouse/compset price use, group pace, STLY, wash, conversion probability, future ancillary forecast, or machine learning was added. `hardOtherCommittedRooms` remains zero; non-deductible group remains pipeline context/value proxy only. Economic Floor scenario structure and room-rate VAT normalization are unchanged.
