# Group Quote / Displacement / Contribution Analysis — AS-BUILT Audit

**Audit basis:** repository at commit `230d57a` (`work` branch), inspected 2026-09-14.  
**Scope:** the current Create Quote analysis path and its supporting loaders, forecasts, contribution engine, VAT helpers, persistence, display, tests, and retained legacy helpers.  
**Status vocabulary:** **IMPLEMENTED** means directly executed or exposed by current code; **ASSUMED** means a semantic interpretation encoded by the implementation but not independently guaranteed by source metadata; **NOT IMPLEMENTED** means no production code was found. Where the evidence cannot settle a point, this report says **UNCLEAR FROM CURRENT IMPLEMENTATION**.

> **Implemented update — Future Group Value V2:** The repository has subsequently replaced the V1 pipeline-first future-group value proxy described in §§16, 19, 23, 32, 35, 37, and 39 below. The V2 behavior in the following subsection is authoritative wherever it conflicts with the original audit snapshot. Group demand volume, capacity, Economic Floor structure, and VAT formulas remain unchanged.

### Future Group Value V2 (authoritative current implementation)

For each target night, Group Forecast continues to select one authoritative comparable set for room-volume forecasting. Each selected comparable now retains the exact historical field `groupRevenueDeductible`. Future Group Value inspects **those same selected dates**; it does not rerun tier selection.

A selected comparable supplies one historical ADR observation only when `groupRooms > 0`, `groupRevenueDeductible > 0`, both are finite, sellable inventory is positive, group rooms do not exceed inventory, and the date is earlier than the target. Selected-year and temporal rules are therefore inherited from Group Forecast. Zero-room dates remain valid demand observations but supply no rate evidence.

```text
rawHistoricalGroupAdrExVat_i = groupRevenueDeductible_i / groupRooms_i
inflationAdjustedGroupAdrExVat_i = rawHistoricalGroupAdrExVat_i
  × (1 + inflationPercentage/100)^(max(0,targetYear-historicalYear_i))

historicalComparableGroupAdrExVat = median(one adjusted ADR per valid date)
```

Current deductible existing-group ADR remains an authoritative value-only signal:

```text
currentExistingGroupAdrExVat = groupRevenueDeductible / currentGroupOtb
```

The current deductible revenue source prefers `groupRevenueDeductible`; `groupRevenue` is supported only as `LEGACY_GROUP_REVENUE`. Neither current revenue nor pipeline context alters forecast group demand or committed capacity.

```text
futureGroupAdrEvidenceExVat = [
  each valid inflationAdjustedGroupAdrExVat once,
  optional currentExistingGroupAdrExVat once
]
expectedFutureGroupRoomRateExVat = median(futureGroupAdrEvidenceExVat)
```

`groupRevenueNonDeductible / groupRoomsNonDeductible` is retained separately as `pipelineCommercialRate` with basis `UNKNOWN_COMMERCIAL_PACKAGE`. It may include VAT and breakfast/package components, is informational only, and never enters the authoritative ADR median, confidence, contribution, allocation, or Economic Floor. Evidence metadata is limited to `HISTORICAL_ONLY`, `HISTORICAL_AND_EXISTING`, `EXISTING_ONLY`, and `UNAVAILABLE`.

Independent Future Group Value confidence uses only deductible evidence:

* **HIGH:** at least five valid historical ADR observations plus current deductible existing-group ADR;
* **MEDIUM:** at least three historical observations, or at least two plus current deductible existing-group ADR;
* **LOW:** one or two historical observations, or current deductible existing-group ADR only;
* `null`: no authoritative deductible evidence. Pipeline commercial context alone produces no value or confidence.

V2 separates commissions:

* `quote.groupCommissionPercentage` applies to the proposed group, simulator, and proposed-group Economic Floor gross-up only.
* `settings.expectedFutureGroupCommissionPercentage` applies only to hypothetical displaced future group value. It is stored as whole percentage points. If absent, `defaultGroupCommissionPercentage` is used and warning code `FUTURE_GROUP_COMMISSION_DEFAULT_FALLBACK` is emitted; the quote commission is never the fallback.

```text
futureGroupContributionPerRoom = expectedFutureGroupRoomRateExVat
  × (1 - expectedFutureGroupCommissionPercentage/100)
  - variableRoomCost
```

The same nightly ADR/contribution is used for Low/Base/High; only group room volume changes. Missing value invalidates the adjusted floor only if positive future group displacement must be valued. V2 warnings additionally use `FUTURE_GROUP_VALUE_LOW_EVIDENCE`, `FUTURE_GROUP_VALUE_CURRENT_ONLY`, and `FUTURE_GROUP_VALUE_UNAVAILABLE`. All rates remain excl. VAT internally; the existing room VAT helper produces `expectedFutureGroupRoomRateInclVat` for display.

> This is an as-built report, not a target design. It does not treat prior prose, tests, or business requirements as proof when production code differs. File/line references below identify the implementation inspected.

## 1. Executive overview

```text
INPUTS (GroupQuoteFormFields + selected historical years)
  ↓
DATA LOADING
  ├─ all historyquotes/consideredDates + groupQuotes settings (initial load)
  └─ latest PMS snapshot + latest Lighthouse snapshot + two event collections
  ↓
FORECASTS, once per requested stay date in memory
  ├─ Transient: selected historical final ratios → median → current inventory
  │             → Lighthouse demand modifier → current transient OTB floor
  └─ Group V1: selected historical final group shares → calendar/DOW tier
                → P25/P50/P75 normalized rooms → current group OTB floor
  ↓
CAPACITY / DISPLACEMENT
  hard committed = transient OTB + deductible group OTB + 0 other
  future demand = final forecasts minus their already-committed OTB
  compare future sales with versus without the requested group
  ↓
CONTRIBUTION
  allocate displaced future rooms to lowest-value demand first;
  value transient room+breakfast and future group room contribution
  ↓
ECONOMIC FLOOR (Low / Base / High and transient-only)
  lost contribution + new-group costs − BQT contribution, commission gross-up
  ↓
COMMERCIAL VAT DISPLAY
  internal room economics excl. VAT → displayed rate incl. VAT
  ↓
QUOTE SIMULATOR
  test incl.-VAT rate → excl.-VAT revenue → incremental contribution
  ↓
CREATE-PAGE UI; save raw quote plus forecast arrays (not contribution result)
```

**IMPLEMENTED architecture.** `GroupQuoteCreatePage` owns orchestration. It first loads historical actuals/settings, later performs four logical loader operations (the event loader itself makes two reads), calculates both forecasts for every inclusive stay date, merges them, and calls `calculateGroupContribution`. The simulator is a memoized derived calculation. There is no separate analysis page and no server-side calculation.

**Important persistence boundary.** Saving writes the input quote, `analysisYears`, `displacementForecast`, and `groupDemandForecast`. It does **not** save contribution totals, floors, simulator rate, or simulator result. The detail page does not reconstruct or render the saved analysis.

## 2. Code map

| File | Main exports/components | As-built responsibility |
|---|---|---|
| `src/components/pages/GroupQuoteCreatePage.jsx` | `GroupQuoteCreatePage` | **Authoritative production orchestrator and analysis UI**: loaders, selected-year state, per-date forecast loops, forecast merge, contribution call, simulator state, warnings, demand/capacity and nightly tables, save payload. Significant business wiring is embedded directly in this React component (lines 40–100). |
| `src/components/pages/GroupQuoteFormFields.jsx` | `GroupQuoteFormFields` | Quote input state, inclusive date generation, HTML validation, numeric conversion, create/edit payload. |
| `src/components/pages/HistoricalYearsDropdown.jsx` | `HistoricalYearsDropdown` | Advanced/model-setting year selection UI only. |
| `src/utils/displacementForecast.js` | `calculateDisplacementDay`, `mapCurrentOtb`, `prepareHistoricalObservations`, `selectHistoricalObservations`, `calculateLighthouseModifier`, `calculateDisplacementScenario`, utilities/config | Transient final-demand forecast, Lighthouse demand adjustment, current PMS mapping, old transient-only displacement diagnostics. |
| `src/utils/groupDemandForecast.js` | `calculateGroupDemandForecast`, `calendarFeatures`, `prepareGroupHistory`, `selectGroupComparables`, `backtestGroupDemandForecast` | Group Forecast V1 and development backtest. |
| `src/utils/contributionAnalysis.js` | `calculateGroupContribution`, `simulateGroupQuote`, `calculateDemandCapacitySummary`, `normalizeContributionSettings`, `aggregateAnalysisWarnings` | Integrated capacity, displacement allocation, contribution valuation, all economic-floor scenarios, simulator, warning aggregation. This is the authoritative floor engine. |
| `src/utils/roomRateVat.js` | `RATE_BASIS`, `normalizeRoomVatPercentage`, `toRoomRateInclVat`, `toRoomRateExVat` | Central commercial room-rate VAT conversion. |
| `src/utils/quoteAnalysis.js` | `applyInflationAdjustment`; legacy `calculateDisplacementMetrics`, `calculateAnalysisSummary`, `buildHistoricalDateAnalysis` | Inflation helper remains active. The remainder is an older historical displacement/“profitable price” engine not imported by production Group Quote pages. |
| `src/services/firebaseQuotes.js` | quote CRUD/subscription; history/current/Lighthouse/settings loaders | Firestore paths and latest-snapshot selection. |
| `src/services/firebaseDemandCalendar.js` | `getDemandCalendarEvents` and calendar CRUD/subscriptions | Production forecast loads and merges canonical and legacy event collections. Category documents are not loaded by analysis. |
| `src/services/firebaseLighthouse.js` | `saveLighthouseData` | Settings-page Lighthouse snapshot import persistence; not an analysis reader. |
| `src/utils/lighthouseImport.js` | `parseLighthouseRows`, `LIGHTHOUSE_FIELDS` | Parses demand, My OTB, own-hotel and compset price columns as strings. |
| `src/constants/demandCalendar.js` | `SYSTEM_TYPES`, `DEMAND_EFFECTS`, form defaults/validation | Calendar UI vocabulary; the group engine independently hardcodes its material system-type set. |
| `src/components/pages/GroupQuoteSettingsPage.jsx` | `GroupQuoteSettingsPage` | Loads/saves 12 settings and imports Lighthouse spreadsheets. |
| `src/components/pages/GroupQuoteDetailPage.jsx` | `GroupQuoteDetailPage` | Displays only basic saved inputs/daily rooms/BQT; saved forecast arrays are not shown. |
| `src/components/pages/GroupQuoteEditPage.jsx` | `GroupQuoteEditPage` | Edits basic quote fields only; does not rerun or update saved analyses. |
| `src/components/pages/GroupQuotesPage.jsx` | `GroupQuotesPage` | Quote list/subscription; no analysis. |
| `src/utils/*.test.js` relevant files | Vitest suites | Executable behavioral evidence, including the April 2027 capacity example and synthetic integrated examples; not production inputs. |
| `docs/displacement-firestore-map.md` | documentation only | Earlier data map. Useful provenance, but this audit follows code where wording differs. |

## 3. Firestore data sources

### 3.1 Historical actuals

| Attribute | As built |
|---|---|
| Path | `hotels/{hotelUid}/reports/historyquotes/consideredDates/{stayDate}` |
| Load | One unfiltered collection read by `getHistoryQuoteDates`; document IDs failing `YYYY-MM-DD` are dropped, IDs become `id` and `date`, and rows sort ascending. |
| Actually read | `date`/fallback `consideredDate`/fallback `id`; `historyFutureType`; `calculatedInventoryRooms`; `individualRooms`; `groupRooms`; `calculatedOccRooms`; `averageRoomRate`. |
| Required for transient sample | Valid date, positive `calculatedInventoryRooms`, numeric `individualRooms`, and absent or exactly `"History"` type. |
| Required for group sample | Valid date, positive `calculatedInventoryRooms`, numeric nonnegative `groupRooms`, and absent or exactly `"History"` type. |
| Interpretation | Historical final actuals; transient rooms, group rooms, occupied rooms, sellable inventory, and ADR respectively. |
| VAT | `averageRoomRate` is **ASSUMED/treated as EXCL VAT**; no source flag or conversion verifies this. |
| Ignored named fields | `inventoryRooms`, `individualRoomsNonDeductible`, `groupRoomsNonDeductible`, both group revenue fields, and room-category fields do not enter historical forecasts. |

There is no latest-snapshot choice for this collection. Every valid date document is downloaded before selected-year filtering.

### 3.2 Current OTB / forecast snapshot

| Attribute | As built |
|---|---|
| Snapshot collection | `hotels/{hotelUid}/reports/historyforecast/snapshotDates` |
| Stay-date path | `hotels/{hotelUid}/reports/historyforecast/snapshotDates/{snapshotDate}/stayDates/{stayDate}` |
| Latest selection | Query snapshot document ID descending, `limit(1)`. It does not inspect a `snapshotDate` field/timestamp. Then read the entire latest `stayDates` collection into `byDate`. |
| Actually read | `individualRooms`, `groupRooms`, `groupRoomsNonDeductible`, `groupRevenueNonDeductible`, `groupRevenue`, `individualRoomsNonDeductible`, `calculatedInventoryRooms`. |
| Interpretation | `individualRooms` = committed transient OTB; `groupRooms` = committed/deductible group OTB; non-deductible group rooms/revenue = prospect pipeline/value proxy; calculated inventory = current sellable capacity. |
| Fallbacks | Missing/nonnumeric room/revenue fields map to zero. Inventory has **no** fallback to `inventoryRooms`; it maps to zero. `currentOtbExists` is true if `individualRooms` parses, even if zero. Missing stay-date document generates the missing OTB/inventory forecast warnings. |
| VAT | Both group revenue fields are **ASSUMED/treated as EXCL VAT** because their ADR ratios are used directly in internal contribution. No metadata confirms it. |

The mapper explicitly fixes `hardOtherCommittedRooms = 0`. It does not use `calculatedOccRooms` or `numberOfRooms` to derive a residual.

### 3.3 Lighthouse latest snapshot

| Attribute | As built |
|---|---|
| Snapshot collection | `hotels/{hotelUid}/reports/lightHouseData/snapshotDates` |
| Stay-date path | `hotels/{hotelUid}/reports/lightHouseData/snapshotDates/{snapshotDate}/stayDates/{stayDate}` |
| Latest selection | Same document-ID-descending/`limit(1)` helper as PMS; all stay dates are then read once. |
| Used field | Exact case-sensitive key `Market demand`. |
| Loaded but unused | `My OTB`, `Gent Marriott Hotel`, `Pillows Grand Boutique Hotel Reylof Ghent`, `NH Collection Gent`, `Yalo Urban Boutique Hotel Gent`, `Novotel Gent Centrum`. |
| Interpretation | External market-demand percentage only. |
| VAT | Demand is not a price. Price columns’ VAT basis is **UNCLEAR FROM CURRENT IMPLEMENTATION**, and no price is used. |

### 3.4 Group Quote settings

Path: `hotels/{hotelUid}/settings/groupQuotes`. A single `getDoc` returns `{}` if absent. There is no versioning or snapshot. See §4 for fields and missing-value behavior.

### 3.5 Demand Calendar

The user-suggested paths do not fully match production code:

* **Canonical analysis read:** `hotels/{hotelUid}/demandCalendarEvents/{eventId}`.
* **Legacy analysis read and current UI write:** `hotels/{hotelUid}/reports/demandCalendar/events/{eventId}`.
* **Actual category path:** `hotels/{hotelUid}/settings/demandCalendarCategories/categories/{categoryId}` — note the additional `categories` collection segment.
* `getDemandCalendarEvents` reads both event collections concurrently and merges by ID, canonical winning because it is inserted second.
* Analysis does **not** read categories, resolve category defaults, or test category `active`; it consumes event fields already materialized on events.

Used event fields are `id`, `name`, `active`, `startDate`, `endDate`, `systemType`, and `groupDemandEffect`. They are configuration/context, not demand observations.

### 3.6 Quote persistence

Path: `hotels/{hotelUid}/quotes/{autoId}`. Create writes input fields plus `analysisYears`, arrays `displacementForecast` and `groupDemandForecast`, and server timestamps `createdAt`/`updatedAt`. Update writes only the edit form payload plus `updatedAt`, leaving old forecast fields in the document because `updateDoc` merges fields. This can produce **stale saved analysis arrays after editing**. The test simulator rate and all contribution/floor outputs are never saved.

## 4. Group Quote settings

All percentages below are stored as whole percentage points and divided by 100 where active.

| Exact field | Status and semantic use | Missing/default behavior |
|---|---|---|
| `inflationPercentage` | **ACTIVE.** Annual compound escalation of each selected historical `averageRoomRate`; not demand inflation. | `applyInflationAdjustment` coerces missing to 0%. |
| `maxHistoricalGroupSharePercentage` | **ACTIVE.** Divided by 100 by the page, then used as a preference filter in transient comparable tiers; not a hard exclusion. | Page passes 1 (100%) if `Number(...)` is non-finite. Beware `Number("") === 0`, so an absent settings object yields a finite zero on the page, effectively 0%. |
| `variableRoomCost` | **ACTIVE.** Cost for every requested new-group RN and every displaced transient/future-group room valuation. | Required by normalization; missing becomes `NaN` and blocks analysis with settings error. |
| `breakfastCostPerPerson` | **ACTIVE.** New-group total breakfast cost and transient per-room breakfast contribution cost. | Required/nonnegative; otherwise settings error. |
| `bqtContributionMarginPercentage` | **ACTIVE.** BQT revenue × fraction offsets required room revenue. | Required 0–100; otherwise settings error. |
| `transientDistributionCostPercentage` | **ACTIVE.** Applied only to transient room ADR. | Required 0–<100; otherwise settings error. |
| `defaultGroupCommissionPercentage` | **ACTIVE.** Form default and engine fallback only when override is null/undefined/empty. | Required 0–<100. In normal create, the required form sends a numeric override. |
| `expectedFutureGroupCommissionPercentage` | **ACTIVE in Future Group Value V2.** Expected commission/distribution cost for hypothetical future group room revenue; independent from the proposed quote commission. | Whole percentage points, required 0–<100 when configured; missing hotels fall back to `defaultGroupCommissionPercentage` with `FUTURE_GROUP_COMMISSION_DEFAULT_FALLBACK`. |
| `transientAverageBreakfastPax` | **ACTIVE.** Average breakfast people per displaced transient room. | Required/nonnegative. |
| `transientAverageBreakfastRevenuePerPax` | **ACTIVE.** Transient breakfast revenue per person. | Required/nonnegative. |
| `roomVatPercentage` | **ACTIVE.** Commercial floor/display and simulator conversions only. | Strictly required by `normalizeRoomVatPercentage`; missing throws before error-array handling. |
| `displacementThresholdPercentage` | **LEGACY BUT STILL CONFIGURABLE.** Saved/loaded in settings UI and used only by dead legacy `calculateDisplacementMetrics`; it does not affect current Create Quote analysis. |
| `breakfastAllocation` | **LEGACY BUT STILL CONFIGURABLE.** Used only by dead legacy `calculateAnalysisSummary`; it does not affect the current floor or display. |

No defaults are hardcoded for required current contribution settings. Settings UI marks every field required, but a missing document blocks the current contribution analysis.

## 5. Create Quote inputs

| Input | Stored format/scope | Validation/default | Calculation use |
|---|---|---|---|
| `name` | Trimmed string, quote-level | HTML `required` | Identification only. |
| `requestDate` | `YYYY-MM-DD`, quote-level | required date | Metadata only. |
| `startDate`, `endDate` | `YYYY-MM-DD`, quote-level | required; end has `min=start`; JS rejects no inclusive dates | Define inclusive stay-date rows. End date is treated as a stay night, not departure-exclusive. |
| `roomsByDate[].date` | ISO string, nightly | generated | Join key for forecasts. |
| `roomsByDate[].rooms` | Number, nightly | required integer input, min 0; blank converted to 0 | New group demand/capacity and cost denominator. |
| `roomsByDate[].bqtRevenue` | Number, nightly | required, min 0, cents; blank→0 | Summed across nights, multiplied by BQT margin. **VAT basis is UNCLEAR FROM CURRENT IMPLEMENTATION**; engine treats it as internal contribution-base revenue without conversion. |
| `breakfastPax` | Number, quote-level total | required integer min 0; blank→0 | Total new-group breakfast cost, not multiplied by nights or rooms. |
| `groupCommissionPercentage` | Whole percentage, quote-level | required, 0–99.99; initially settings default | Commissions new group simulator revenue and future group proxy value; floor gross-up. |
| selected years | UI array of integer years; saved as `analysisYears` | initially **all years present** in loaded historical docs; user toggles any/all | Passed to both forecast engines and thereby transient ADR selection. |
| Test Average Group Rate | transient UI string/number, incl. VAT | min 0, cents; not part of quote form | Simulator only; not saved. |

The sole “Advanced / Model Settings” input on the create page is historical year selection. Forecast constants, beta, caps, seasons, and sample sizes are not editable there.

## 6. `selectedHistoricalYears`

1. The source is `selectedYears` state in `GroupQuoteCreatePage`.
2. After initial history load it defaults to every distinct year present, newest first—not “last five”.
3. Transient selection receives it. Presence of an array, including `[]`, suppresses the default five-year age rule and admits only exact member years.
4. Group Forecast receives it and filters prepared history before comparable selection.
5. Expected transient ADR is the median of ADRs on the already-selected transient comparables, so it respects the years.
6. No historical group ADR fallback exists; therefore there is no separate group ADR year issue.
7. Production group demand and transient engines cannot silently pull an excluded year once this array is passed. The development backtest calls Group Forecast without selected years, but it is not called in production.

**Inconsistency/flag:** the constant `historicalYears: 5` governs transient only when no selected-year array is supplied. Normal page execution always supplies an array defaulted to all available years, so dates older than five years can be used. Group Forecast has no age limit at all beyond selection.

## 7. Transient Demand Forecast — complete logic

Production entry: `calculateDisplacementDay` in `src/utils/displacementForecast.js`.

### 7.1 Candidate preparation

For each valid historical row:

```text
inventory        = calculatedInventoryRooms
groupRooms       = max(0, groupRooms or 0)
occupiedRooms    = max(0, calculatedOccRooms or 0)
otherActualRooms = max(0, occupiedRooms - individualRooms - groupRooms)
transientCapacity = max(0, inventory - groupRooms - otherActualRooms)
utilization = transientCapacity > 0
            ? individualRooms / transientCapacity
            : null
groupShare = groupRooms / inventory
transientOccupancyRatio = individualRooms / inventory
capacityConstrained = transientCapacity <= 0 OR utilization >= 0.95
```

`individualRooms` is not clamped nonnegative for historical preparation. Consequently negative historical values, if present, can survive and influence ratios; group/occupied values are clamped.

### 7.2 Eligibility and tier selection

Candidates must be same UTC day-of-week. With selected years they need an exact year membership; without, age must be 1–5 years before target. Future/same-year rows are excluded only in the latter mode.

Definitions:

* `sameMonth`: same zero-based calendar month.
* `sameSeason`: Jan–Feb `WINTER_LOW`; Mar–Jun `SPRING_BUSINESS`; Jul–Aug `SUMMER`; Sep–Nov `AUTUMN_BUSINESS`; Dec `FESTIVE`.
* `unconstrained`: not censored.
* `preferred`: unconstrained **and** `groupShare <= maxHistoricalGroupShare`.

First tier with at least 6 rows wins:

1. `same-month-preferred`
2. `same-month-unconstrained` (relaxes group-share preference)
3. `same-season-preferred`
4. `same-season-unconstrained`

If none is selected: use same-season unconstrained with ≥3 (`same-season-low-sample`); else use all same-month censored if any, otherwise same-season censored (`censored-lower-bound`); else unavailable. The fallback does **not** use 1–2 unconstrained observations, even though those may exist.

### 7.3 Baseline, Lighthouse, OTB floor

```text
historicalMedianTransientOccupancy = median(selected transientOccupancyRatio)
historicalBaselineRooms = medianRatio × target sellableInventory

adjustedHistoricalDemand = historicalBaselineRooms × lighthouseMarketModifier

transientDemandForecast = max(currentTransientOtb,
                              adjustedHistoricalDemand if available else 0)
```

The median is the ordinary sorted midpoint (average of two middle values). No weighting, recency weighting, rounding, inventory cap, explicit lower-zero clamp, or demand inflation is applied. Since the baseline uses raw historical ratios, a negative median could produce negative adjusted demand, but the OTB/zero max effectively floors the final result at ≥0.

Expected transient room rate uses the same selected rows but excludes missing, invalid, zero, or negative `averageRoomRate`:

```text
inflatedAdr_i = averageRoomRate_i × (1 + inflationPercentage/100)^(targetYear-historyYear)
expectedTransientRoomRate = median(inflatedAdr_i)
```

With explicitly selected future years, negative year differences are clamped to zero for ADR inflation. Demand itself is not inflated.

### 7.4 Confidence

Default `low` (lowercase):

* `high`: a tier name beginning `same-month`, ≥8 selected rows, current transient OTB field exists, and Lighthouse modifier is valid.
* `medium`: OTB exists and either same-month ≥6, or exact `same-season-preferred`/`same-season-unconstrained` ≥6. Lighthouse need not be valid.
* otherwise `low`.

This differs in case from Group Forecast (`HIGH/MEDIUM/LOW`). There is no combined quote-level confidence.

### 7.5 Forecast warnings

Nightly transient detail can show:

* `Historical transient demand is capacity constrained; baseline is a lower-bound estimate.`
* `Historical transient baseline is unavailable.`
* `Lighthouse Market Demand is missing or invalid; no market adjustment was applied.`
* `Current transient OTB is missing.`
* `Current sellable inventory is missing or invalid.`

These warnings are displayed inside each Transient Forecast detail only; they are not copied into the main contribution warning aggregator.

## 8. Lighthouse logic

`calculateLighthouseModifier` parses target `Market demand` and scans the same latest snapshot’s in-memory map. Comparable values must:

* be a valid different ISO date;
* have the same UTC DOW;
* be within absolute 28 days (both past and future);
* contain a valid normalized Market demand.

Normalization accepts `"93%"`, `93`, `.93`, decimal commas and whitespace, producing `.93`; negatives and values above 100% after normalization are invalid. Comparable statistic is the median.

```text
marketIndex = targetDemand / comparableMedianDemand
uncappedModifier = 1 + 0.5 × (marketIndex - 1)
modifier = clamp(uncappedModifier, 0.85, 1.15)
```

If target/comparable is missing or comparable ≤0: modifier = 1, `valid=false`, warning. The comparable scan is not restricted by selected historical years or month, only ±28 days/same DOW.

**Lighthouse Demand: IMPLEMENTED.** It scales transient baseline rooms.  
**Lighthouse Pricing: NOT IMPLEMENTED.** `My OTB`, own-hotel rate, and compset rates are merely imported/stored. No pricing recommendation uses them. The page explicitly says “Pricing recommendation not yet applied.” Price VAT basis is unknown. Demand has no VAT basis.

## 9. Demand Calendar logic

The event loader executes once per analysis refresh, fetching canonical and legacy collections. `calendarFeatures(date, events)` includes only events where `active === true` and lexical inclusive overlap holds (`startDate <= date <= endDate`). Missing/false `active` is excluded.

Hardcoded “important” group-regime types are:

```text
SCHOOL_HOLIDAY, PUBLIC_HOLIDAY, BRIDGE_DAY, BUSINESS_EVENT,
CITYWIDE_COMPRESSION, FESTIVE_PERIOD
```

`LEISURE_EVENT` is exposed as a feature but not included in `calendarRegime`; `OTHER` is also not material. For every important overlapping event, regime contains sorted strings `systemType:groupDemandEffect`, defaulting missing effect to `NEUTRAL`. Multiple overlaps all participate; duplicate strings are **not** deduplicated in regime. Comparable regime equality is an exact joined-string match.

`isNormalGroupBusiness` is true only when there are no important regime events. The separately calculated `material` list makes the expression look effect-aware, but the final condition also requires zero `regimeEvents`; therefore even an important `NEUTRAL` event makes normal false.

`SUPPRESS`, `NEUTRAL`, and `BOOST` are **contextual categorical labels only**. They alter regime matching but never multiply demand numerically. Event impact, attendance, other demand effects, region, confidence, category active/default fields are ignored by analysis.

If several calendar-specific tiers lack enough data, the engine broadens to DOW/month or DOW/season and eventually season-only, discarding calendar equivalence.

## 10. Group Demand Forecast V1 — complete logic

**What it forecasts:** **IMPLEMENTED — expected final realized group room demand**, not inquiries, unconstrained potential, or bookings-to-come alone.

### 10.1 History and normalization

Eligible historical final demand is `groupRooms` from historyquotes. `groupRoomsNonDeductible` is ignored. For each row:

```text
finalGroupRooms = groupRooms
sellableInventory = calculatedInventoryRooms
groupShare = finalGroupRooms / sellableInventory
normalizedGroupRooms = groupShare × current calculatedInventoryRooms
```

Rows require positive historical inventory and nonnegative group rooms. Current inventory must be >0 or the normalized comparable list is empty, even though a match tier may have selected history.

### 10.2 Comparable tiers

Target is compared with all prepared rows except the exact target date. Unlike transient default mode, there is no automatic past-only or five-year rule. Normal production year selection filters it.

First tier with ≥5 matches wins; if none reaches five, the **broadest nonempty tier wins** because matches are searched in reverse:

1. `TIER_1_SAME_DOW_MONTH_CALENDAR`
2. `TIER_2_SAME_DOW_SEASON_CALENDAR`
3. `TIER_3_SAME_DOW_MONTH`
4. `TIER_4_SAME_DOW_SEASON`
5. `TIER_5_SEASON_FALLBACK` (no DOW constraint)

This means with low samples Tier 5 wins whenever any same-season row exists, even if a more precise tier has rows.

### 10.3 Percentiles and floors

P25/P50/P75 use linear interpolation at position `(n-1) × fraction` over sorted normalized rooms.

```text
historical P25/P50/P75 rooms = percentile(normalizedGroupRooms, .25/.50/.75)
forecastLow  = max(currentGroupOtb, P25) or null if P25 unavailable
forecastBase = max(currentGroupOtb, P50) or null
forecastHigh = max(currentGroupOtb, P75) or null
remainingPotentialScenario = max(0, forecastScenario - currentGroupOtb)
```

No inventory cap is applied. Current OTB is a hard floor, and if above P75 all scenarios can collapse to the same OTB value.

### 10.4 Confidence and warnings

* `HIGH`: exact Tier 1 plus ≥8 comparables.
* `MEDIUM`: any tier except Tier 5 plus ≥5 comparables.
* `LOW`: otherwise.

Always emitted:

* `Group pace adjustment is not available yet; forecast is based on historical final group demand.`
* `Forecast represents expected realized group demand, not unconstrained inquiry demand.`

Conditional warnings: limited sample (<5); selected years limit sample (<5 with an array); broader seasonal sample (Tier 3–5); no target event IDs; current OTB above historical P75.

**NOT IMPLEMENTED:** booking pace, STLY, lead-time adjustment, inquiry conversion, wash/cancellation model, demand/calendar numeric uplift. `groupRoomsNonDeductible` does not affect forecast demand. Selected years are respected in production.

## 11. PMS field semantics

| Field | Current treatment |
|---|---|
| `individualRooms` | Current: hard committed transient OTB and final-forecast floor. History: final transient actual numerator. |
| `individualRoomsNonDeductible` | Preserved by `mapCurrentOtb` as `individualNonDeductibleRooms`, but **ignored downstream**. |
| `groupRooms` | Current: hard committed/deductible group OTB and forecast floor. History: final realized group demand. |
| `groupRoomsNonDeductible` | Current: prospect/pipeline context; excluded from capacity and demand forecast; may supply ADR proxy denominator. |
| `groupRevenue` | Current: existing committed group ADR proxy numerator if pipeline proxy unavailable. |
| `groupRevenueNonDeductible` | Current: first-priority prospect/pipeline ADR proxy numerator. |
| `calculatedOccRooms` | Historical only, to estimate `otherActualRooms` and censor transient observations. **Not used as a current residual committed-room calculation.** |
| `numberOfRooms` | Ignored. |
| `calculatedInventoryRooms` | Sole historical/current sellable inventory. |
| `inventoryRooms` | Ignored; no fallback. |
| `complimentaryRooms`, `houseUseRooms`, `ownerRooms`, `ffRooms`, `oooRooms`, `noShowRooms`, `dayUseRoom` | Ignored individually. Historical occupancy residual may implicitly include categories already present in `calculatedOccRooms`. Current OOO is assumed already reflected in calculated inventory. |

Thus `groupRoomsNonDeductible` is excluded from hard capacity, retained as pipeline context, and currently used only for the future-group ADR/value proxy (not future group demand). “Only for future group ADR/value” is accurate downstream, although its room/revenue values also remain in transient forecast diagnostics.

## 12. Capacity model

Per night in the integrated contribution engine:

```text
currentTransientOtb = max(0, mapped individualRooms)
currentGroupOtb = max(0, mapped groupRooms)
hardOtherCommittedRooms = 0
hardCommittedRooms = currentTransientOtb + currentGroupOtb + hardOtherCommittedRooms

finalTransientDemandForecast = max(currentTransientOtb, transientDemandForecast)
futureTransientDemand = max(0, finalTransientDemandForecast - currentTransientOtb)

futureGroupDemandLow  = max(0, forecastLow  - currentGroupOtb)
futureGroupDemandBase = max(0, forecastBase - currentGroupOtb)
futureGroupDemandHigh = max(0, forecastHigh - currentGroupOtb)

remainingCapacityBeforeNewGroup = max(0, sellableInventory - hardCommittedRooms)
remainingCapacityAfterNewGroup = max(0,
  remainingCapacityBeforeNewGroup - requestedGroupRooms)

futureDemandWithoutNewGroup = futureTransientDemand + futureGroupDemandScenario
futureSalesWithoutNewGroup = min(futureDemandWithoutNewGroup,
                                  remainingCapacityBeforeNewGroup)
futureSalesWithNewGroup = min(futureDemandWithoutNewGroup,
                               remainingCapacityAfterNewGroup)

totalDisplacedFutureRooms = min(requestedGroupRooms,
  max(0, futureSalesWithoutNewGroup - futureSalesWithNewGroup))
nonDisplacingGroupRooms = requestedGroupRooms - totalDisplacedFutureRooms
```

`capacityConflictRooms = max(0, requested - remainingCapacityBeforeNewGroup)` only when a group forecast object exists. Any conflict makes **every quote-level floor null** rather than pricing the conflict.

Terminology: current OTB is hard committed; forecasts are expected final demand from which current OTB is subtracted to form future demand; requested rooms are a third, new bucket.

## 13. Double-counting verification

| Check | Result |
|---|---|
| Current transient OTB + final transient demand | **No double count in integrated engine.** Current OTB consumes hard capacity; only `max(final, OTB)-OTB` enters future demand. The older `calculateDisplacementScenario` treats final transient demand as one total and excludes transient OTB from its capacity subtraction; it also avoids addition, but uses a different formulation. |
| Current group OTB + final group forecast | **No double count.** Current group OTB consumes hard capacity; `forecastScenario-currentGroupOtb` is future group demand. |
| `groupRoomsNonDeductible` + future group forecast | **No room-demand double count.** Pipeline rooms do not enter capacity/demand; only their ADR ratio values future displaced group rooms. |

**POTENTIAL BUSINESS LOGIC ISSUE (valuation, not rooms):** a pipeline ADR can value all statistically forecast future group demand even though that same pipeline is explicitly excluded as demand. This is a proxy assumption, not arithmetic room double counting.

## 14. Displacement allocation

Total displacement is determined by capacity first, independently of values. It is allocated among available future group and transient demand by ascending per-room contribution:

```text
buckets = [
  {type: GROUP, available: futureGroupDemand, value: groupContribution},
  {type: TRANSIENT, available: futureTransientDemand, value: transientContribution}
]
sort ascending value
  null sorts before known value
  exact numeric tie preserves GROUP first (stable sort + original order)

remaining = totalDisplacedFutureRooms
for bucket in buckets:
    displaced[bucket] = min(bucket.available, remaining)
    remaining -= displaced[bucket]
```

Allocation is lowest-contribution-first, capped by each unrounded demand bucket and total displacement. JS floating-point precision is retained; rooms/forecasts are not rounded until UI display. If a null-valued bucket receives positive displacement, its lost contribution and total opportunity cost become null. A null bucket is deliberately sorted first, so missing valuation can make the floor unavailable even when a known-value allocation alternative exists.

## 15. Transient contribution per room

Historical `averageRoomRate` is **treated as EXCL VAT** and inflation-adjusted before use.

```text
distributionCostPerRoom = expectedTransientRoomRate × distributionCostRate
roomContribution = expectedTransientRoomRate
                 - distributionCostPerRoom
                 - variableRoomCost

transientBreakfastContribution = transientAverageBreakfastPax
                               × (transientAverageBreakfastRevenuePerPax
                                  - breakfastCostPerPerson)

transientContributionPerDisplacedRoom = roomContribution
                                      + transientBreakfastContribution
```

Distribution applies only to room revenue. Breakfast contribution can be negative and is not clamped. Missing/nonpositive expected ADR produces null contribution, but causes no floor problem if zero transient rooms are displaced.

## 16. Future group value / contribution (legacy audit snapshot; superseded above)

The following hierarchy documents retired behavior and is not executed by the current model:

Exact fallback hierarchy:

1. If `groupRoomsNonDeductible > 0` **and** `groupRevenueNonDeductible > 0`: `expectedFutureGroupRoomRate = revenue / rooms`; source `PROSPECT_PIPELINE_ADR`; warning emitted.
2. Else, if `currentGroupOtb > 0` **and** `groupRevenue > 0`: rate = revenue/currentGroupOtb; source `EXISTING_GROUP_ADR`; no specific proxy warning.
3. Else null; there is **no historical group ADR fallback**.

Both rates are assumed/taken as excl. VAT; a display conversion is exposed. Negative inputs clamp to zero before eligibility.

```text
futureGroupContributionPerRoom = expectedFutureGroupRoomRate × (1-groupCommission)
                               - variableRoomCost
```

No future-group breakfast revenue/cost or BQT contribution is included. When future group demand high >0, an omission warning is always added—even if no group rooms are displaced. If positive group displacement has no group value, floor is unavailable.

## 17. BQT logic

`bqtRevenue` is entered nightly and summed quote-wide. It is treated as revenue on the contribution basis, but its VAT basis is **UNCLEAR FROM CURRENT IMPLEMENTATION** because no conversion/tag exists.

```text
totalBqtRevenue = Σ max(0, nightly bqtRevenue)
bqtContribution = totalBqtRevenue × (bqtContributionMarginPercentage/100)
```

BQT contribution is subtracted from required new-group room revenue and added in the simulator’s group contribution. It can reduce required net revenue only to zero (never produce a negative floor). Future displaced group BQT is **NOT IMPLEMENTED**.

## 18. Breakfast logic

### New group

```text
groupBreakfastCosts = max(0, quote.breakfastPax) × breakfastCostPerPerson
```

`breakfastPax` is quote-total. There is no breakfast revenue/allocation for the new group; costs raise the floor. `breakfastAllocation` is not used. VAT handling is absent; cost is treated as internal net economics.

### Transient

```text
pax per displaced room = transientAverageBreakfastPax
revenue per pax = transientAverageBreakfastRevenuePerPax
cost per pax = breakfastCostPerPerson
contribution per room = pax × (revenue - cost)
```

This contribution is added to displaced transient room contribution. No VAT conversion applies to breakfast values; their configured basis is untagged.

## 19. Commission logic

The form initializes a required quote-level override from `defaultGroupCommissionPercentage`. Engine fallback applies only for null/undefined/empty override; `0` is a valid override. Both are whole percentage points divided by 100 and must be ≥0 and <1 after normalization.

Commission applies to room revenue excl. VAT:

```text
futureGroupContribution = futureGroupAdrExVat × (1-commission) - roomCost
requiredCommissionableRevenue = requiredRevenueAfterCosts / (1-commission)
simulatorCommissionCost = simulatorRoomRevenueExVat × commission
```

It does not apply to BQT or breakfast. The same quote commission assumption is used to value unknown future group business.

## 20. Economic Floor — complete reconciliation

The requested staged structure matches implementation, with one extra clamp and one availability gate.

```text
STAGE 1 — Opportunity cost, scenario S
lostTransient_S = displacedFutureTransientRooms_S × transientContributionPerRoom
lostGroup_S = displacedFutureGroupRooms_S × futureGroupContributionPerRoom
totalLost_S = lostTransient_S + lostGroup_S

STAGE 2 — New group costs/offset
rawRequiredNet_S = totalLost_S
                 + requestedRoomNights × variableRoomCost
                 + breakfastPax × breakfastCostPerPerson
                 - totalBqtRevenue × bqtMargin
requiredRevenueAfterCosts_S = max(0, rawRequiredNet_S)

STAGE 3 — Commission gross-up
requiredCommissionableRoomRevenueExVat_S =
    requiredRevenueAfterCosts_S / (1-groupCommission)

STAGE 4 — Per-RN internal floor
economicFloorRateExVat_S = requiredCommissionableRoomRevenueExVat_S
                         / totalRequestedGroupRoomNights

STAGE 5 — Commercial VAT display
economicFloorRateInclVat_S = economicFloorRateExVat_S
                           × (1+roomVatPercentage/100)
```

Floor is null if requested RNs are zero, scenario lost contribution is null, or **any** night has a physical capacity conflict. Values retain full floating precision internally.

## 21. Low / Base / High floors

Low, Base, High use Group Forecast P25/P50/P75 after OTB flooring, respectively. For each scenario the engine recalculates future group remaining demand, total capacity displacement, contribution-priority allocation, transient/group lost contribution, required revenues, commission gross-up, and floor. Transient forecast and per-room values remain constant. Thus more group demand can change not only total displacement but which demand type is displaced.

UI headline and nightly analysis use **Base/P50**. Low/high are displayed as sensitivity references.

## 22. Transient-only floor

The transient-only scenario calls the same integrated capacity/allocation calculation with `futureGroupDemand=0`; it still subtracts current transient and group OTB from remaining capacity and includes all new-group variable/breakfast costs, BQT, commission, VAT. It ignores statistically forecast future group demand and its opportunity cost.

It remains displayed under the headline floor as explanatory/reference. Base is the decision value. It is also used for backward compatibility when saved/legacy forecast input lacks `groupForecast`, in which case all scenarios are replaced by legacy transient-only displacement.

## 23. VAT normalization

Central helpers require a nonnegative whole-percent `roomVatPercentage`:

```text
toRoomRateInclVat(excl, p) = excl × (1+p/100)
toRoomRateExVat(incl, p)   = incl / (1+p/100)
```

| Value | As-built basis |
|---|---|
| Historical `averageRoomRate` | **ASSUMED EXCL VAT**; used directly internally. |
| Prospect/existing future group rate proxy | **ASSUMED EXCL VAT**; used directly, plus explicit incl.-VAT display field. |
| Economic Floor internal | EXCL VAT. |
| Economic Floor UI | Headline/scenario cards incl. VAT; reconciliation also shows excl. VAT. |
| Test Average Group Rate | INCL VAT by label and conversion. |
| Simulator room revenue/commission | EXCL VAT after conversion. |
| Saved quote rate | **NOT IMPLEMENTED:** no quoted room-rate field is saved; simulator is unsaved. |
| BQT/breakfast inputs | **UNCLEAR FROM CURRENT IMPLEMENTATION**; no VAT helpers used. |
| Lighthouse demand | Percentage; VAT not applicable. |
| Lighthouse price columns | Unused; VAT basis unknown. |

`RATE_BASIS` constants exist but data objects are not tagged with them. Legacy `calculateAnalysisSummary` duplicates an incl.-VAT multiplication and then adds breakfast allocation after VAT, but it is outside production analysis.

## 24. Quote Simulator

Input `testGroupRateInclVat` is not rounded by calculation:

```text
testGroupRateExVat = testGroupRateInclVat / (1+VAT/100)
groupRoomRevenueExVat = testGroupRateExVat × requestedRoomNights
commissionCost = groupRoomRevenueExVat × groupCommission
groupContribution = groupRoomRevenueExVat - commissionCost
                  - groupVariableRoomCosts - groupBreakfastCosts
                  + bqtContribution
netIncrementalContribution = groupContribution - base totalLostContribution
rateAboveFloor = testGroupRateInclVat - baseFloorInclVat
rateAboveFloorPercentage = testGroupRateInclVat/baseFloorInclVat - 1
```

It returns null if base floor/lost contribution is unavailable or rate is invalid/negative. Positive incremental contribution is economically above the modeled floor; zero is neutral; negative is below. UI classifies within €0.01 of the floor as “At Floor/Economically neutral” based on rate difference, even though full-precision net contribution may be slightly nonzero.

## 25. Warning system

There are three distinct systems:

1. Transient forecast warnings: per-night, rendered only inside transient details.
2. Group forecast warnings: per-night, rendered only inside group details.
3. Contribution warnings: per-night, aggregated by `aggregateAnalysisWarnings`, rendered once near pricing.

Known stable contribution codes:

| Code | Message |
|---|---|
| `FUTURE_GROUP_PIPELINE_ADR` | **Retired:** pipeline commercial context is no longer contribution evidence and this warning is not emitted. |
| `FUTURE_GROUP_ECONOMICS_EXCLUDED` | Future group contribution currently excludes unknown future BQT and breakfast economics. |
| `GROUP_PACE_UNAVAILABLE` | Group Forecast V1 does not yet use historical booking pace. |
| `FUTURE_GROUP_LOW_CONFIDENCE` | High uncertainty in future group-demand forecast. |

Dynamic contribution messages cover capacity conflict, missing historical ADR, and missing future-group value. Their codes normalize dates/numbers to `#`, so equivalent messages group across nights. Aggregation deduplicates stay dates. UI shows “Applies to N stay dates” only when N>1; it does not list those dates there.

Quote-level floor-unavailable/zero-room warnings are appended later and receive generated codes with empty stay-date lists. Forecast warnings such as missing Lighthouse do not propagate to the headline warning box. The pace limitation is generated both by Group Forecast (different wording) and contribution engine, so users see it in two sections rather than cross-engine deduplication.

## 26. Confidence systems

Transient confidence uses lowercase `high/medium/low` and the exact rules in §7.4. Group confidence uses uppercase `HIGH/MEDIUM/LOW` and §10.4. UI nightly “Confidence” is group confidence only. No calculation combines the two, and no final quote-level confidence score exists.

Potential semantic concern: a transient same-month `-unconstrained` sample that ignored the max-group-share preference can still be `high` if sample/OTB/Lighthouse conditions hold. Group `MEDIUM` is possible for Tier 3/4 without calendar match.

## 27. Demand & Capacity summary

```text
expectedTotalDemand = transientForecast.transientDemandForecast
                    + groupForecast.forecastBase
                    + hardOtherCommittedRooms
expectedSlack = sellableInventory - expectedTotalDemand
```

Because both forecast figures represent final demand and are OTB-floored, current transient/group OTB are not added again. Pipeline rooms are absent. Negative slack is labelled Compression; nonnegative shows `+N rooms` (including `+-0` is possible through formatting edge cases).

This helper is purely informational UI. Integrated contribution independently decomposes final forecasts into hard OTB plus future demand.

## 28. Nightly Analysis columns

All displacement/contribution fields use Base/P50 scenario.

| Column | Source/formula |
|---|---|
| Date | `night.stayDate`. |
| Requested Group RN | clamped numeric `roomsByDate[].rooms`. |
| Transient Forecast | final OTB-floored `night.finalTransientDemandForecast`. |
| Final Group Forecast | `group.forecastBase` (expected final group demand). |
| Future Group Potential | `max(0, forecastBase-currentGroupOtb)`. |
| Total Displaced RN | `night.scenarios.base.totalDisplacedFutureRooms`. |
| Displaced Transient RN | base contribution-priority allocation. |
| Displaced Future Group RN | base contribution-priority allocation. |
| Incremental RN | base `requested-totalDisplaced`. UI label omits “non-displacing”. |
| Lost Contribution | base lost transient + future-group contribution. |
| Confidence | Group Forecast confidence only. |

Room values display with `Math.round`, while money uses two decimals. Totals are calculated from unrounded values, so manual sums of displayed nightly rooms can differ from displayed aggregate rounding.

## 29. UI source of truth

| Concept | Authoritative current section |
|---|---|
| Transient Forecast | `calculateDisplacementDay` results and Transient Demand Forecast detail. Its embedded `displacedRooms` is legacy/transient-only diagnostic, not total current displacement. |
| Group Forecast | Group Demand Forecast V1 detail (`forecastBase` headline). |
| Total Displacement | `calculateGroupContribution` Base scenario, Group Impact/Nightly Analysis. |
| Economic Floor | contribution Base floor, incl.-VAT Economic Decision headline. |
| Quote Simulator | `simulateGroupQuote` on unsaved current contribution. |

Old `calculateDisplacementScenario` values remain spread into transient forecast objects and are saved under `displacementForecast`; consumers could confuse `displacedRooms` there with integrated total displacement. Current create UI uses integrated totals. Saved quote detail shows neither.

## 30. Performance / data loading

Normal create path:

* Initial render: 2 reads in parallel—entire historical consideredDates collection and one settings document.
* After “Start Analysis” (and whenever dependencies retrigger):
  * PMS: 1 query for latest snapshot + 1 full latest stayDates read.
  * Lighthouse: 1 query for latest snapshot + 1 full latest stayDates read.
  * Demand events: 2 full collection reads (canonical + legacy).
* Total logical Firestore operations on a normal successful analysis: **8** (2 initial + 6 analysis-phase), regardless of requested night count. Firestore bills document reads within collection queries, so document volume can be large.

No per-stay-date Firestore queries occur. History, Lighthouse, current snapshot, and events load once per effect execution; calculations then loop requested dates. However the effect dependency includes the whole `analysisQuote`, selected years, considered dates, and `maxHistoricalGroupSharePercentage`. Resubmitting or toggling years reloads PMS/Lighthouse/events even though those sources did not change. Other setting changes are not effect dependencies, though contribution recomputes from settings state.

There is no explicit application cache. Firestore SDK offline persistence is globally enabled; that is not deterministic analysis memoization. Contribution, simulator, available years are `useMemo`; per-date forecasts are not.

CPU behavior: each requested date reparses/filter-scans all historical rows twice (transient and group); group preparation recalculates calendar features over all events for every historical row, per requested date; Lighthouse scans all latest-snapshot stay dates per target. Approximate complexity is O(stay nights × (history rows × events + Lighthouse rows)).

**Verified: `backtestGroupDemandForecast` is NOT imported or executed by any production component.** It is imported only by tests. There is no every-analysis backtest performance issue.

## 31. Group Forecast backtest

`backtestGroupDemandForecast` lives in `src/utils/groupDemandForecast.js`. It has no UI trigger; tests invoke it directly. It prepares every valid historical row as a target and invokes Group Forecast with current group OTB=0 and target inventory. Exact target date is excluded by comparable selection, but other targets/future rows can be comparables because there is no temporal cutoff. Selected historical years are not supplied.

Metrics:

* sample count/error count;
* MAE;
* median absolute error using the same interpolated percentile;
* bias = mean `(forecastP50-actual)`;
* RMSE;
* P25–P75 inclusive interval coverage;
* observations and breakdowns by month, UTC DOW, business season, and stringified calendar regime.

It does not persist “current metrics,” and no dataset output is checked into this repository. It has zero effect on production forecasts.

## 32. Legacy / unused logic

| Item | Classification | Evidence/current risk |
|---|---|---|
| `applyInflationAdjustment` | **ACTIVE** | Used for transient expected ADR. |
| `calculateDisplacementScenario` in transient engine | **LEGACY BUT STILL REFERENCED** | Called by `calculateDisplacementDay`; diagnostics are displayed/saved, but integrated contribution recalculates displacement with future group demand. |
| `calculateDisplacementMetrics` | **DEAD / UNUSED in production** | Old threshold/ceil occupancy displacement; tests only. |
| `calculateAnalysisSummary` / `profitablePrice` | **DEAD / UNUSED in production** | Old average historical displacement revenue plus VAT/breakfast allocation. |
| `buildHistoricalDateAnalysis` | **DEAD / UNUSED in production** | Old nearest-same-weekday/year and manual week-offset selection. |
| `displacementThresholdPercentage` | **LEGACY BUT STILL CONFIGURABLE** | Settings CRUD plus dead helper only. |
| `breakfastAllocation` | **LEGACY BUT STILL CONFIGURABLE** | Settings CRUD plus dead helper only. |
| Old “Profitable from” / Historical Performance Reference UI | **DEAD / NOT PRESENT in current GroupQuoteCreatePage** | Concepts remain only in helper/tests/docs searches. |
| `hardOtherCommittedRooms` | **ACTIVE, constant zero** | Field remains in formulas/explainability but current mapper never derives residual other committed rooms. |
| Legacy saved forecast compatibility | **ACTIVE** | Missing `groupForecast` causes all scenarios to reuse saved transient `displacedRooms`; current Create path always supplies group forecast. |
| VAT multiplication in legacy summary | **DEAD duplication** | Central helpers are authoritative in current path. |
| `RATE_BASIS` enum | **ACTIVE export, otherwise unused** | No analyzed source is actually tagged. |
| Saved `displacementForecast[].displacedRooms` | **LEGACY BUT STILL SAVED** | Represents transient-only old capacity scenario, not integrated Base displacement. |

## 33. Worked example — integrated current engine

### Data availability statement

No authenticated Firestore export, hotel UID, credentials, or reproducible saved quote dataset is present in the repository. Therefore a claim that a full example is a **real current Firestore quote** would violate the strict audit rule. The repository contains a 2027-04-03 regression fixture only for transient-only capacity (`inventory=150`, group OTB=17, request=50, final transient demand=107 → 24 displaced); it lacks group forecast, rates, settings and quote economics.

The following is the fullest reproducible as-built example: the production functions’ integrated fixture in `src/utils/contributionAnalysis.test.js` (2027-09-08). It is synthetic but executes the exact current engine.

### Inputs

```text
sellable inventory                     150
current transient OTB                   16
current group OTB                       17
hard other committed                     0
group prospect rooms / revenue          100 / €22,900 excl.-VAT assumption
final transient forecast               107
group forecast Low/Base/High         22 / 27 / 37
requested new group rooms               50
expected transient ADR                 €200 excl. VAT
new-group breakfast pax                  0
BQT revenue                              €0
commission                              10%
variable room cost                      €20
transient distribution                   8%
transient breakfast pax                   0 (fixture override)
room VAT                                  0% (base fixture)
```

### Base/P50 capacity

```text
hard committed = 16 + 17 + 0 = 33
remaining before new group = 150 - 33 = 117
future transient demand = 107 - 16 = 91
future group demand = 27 - 17 = 10
future demand without group = 101
future sales without group = min(101,117) = 101
remaining after group = 117 - 50 = 67
future sales with group = min(101,67) = 67
total displacement = 101 - 67 = 34
non-displacing rooms = 50 - 34 = 16
```

### Values and allocation

```text
transient distribution = 200 × 8% = €16
transient room contribution = 200 - 16 - 20 = €164
transient breakfast contribution = 0
transient value = €164

future group ADR = 22,900 / 100 = €229
future group contribution = 229 × 90% - 20 = €186.10
```

Transient is lower value, so all 34 displaced rooms allocate to transient (cap 91); group displacement is zero.

```text
lost transient contribution = 34 × 164 = €5,576
lost group contribution = 0
total lost contribution = €5,576
group variable costs = 50 × 20 = €1,000
breakfast costs = €0
BQT contribution = €0
required revenue after costs = €6,576
commissionable revenue = 6,576 / .90 = €7,306.6667
floor excl. VAT = 7,306.6667 / 50 = €146.1333
floor incl. VAT at 0% = €146.1333 → UI €146.13
```

### Scenario reconciliation

* Low: future group=5; future total=96; displacement=29, all transient; floor = `(29×164+1000)/.9/50 = €127.91`.
* Base: future group=10; displacement=34; floor = **€146.13**.
* High: future group=20; future total=111; displacement=44, all transient; floor = `(44×164+1000)/.9/50 = €182.58`.
* Transient-only: future total=91; displacement=24; floor = `(24×164+1000)/.9/50 = €109.69`.

The values reconcile with current functions before display rounding. With the test’s alternate `roomVatPercentage=12`, Base commercial floor is `€146.1333×1.12 = €163.67`, while internal economics are unchanged.

### April 3 partial data

For the repository’s 2027-04-03 transient-only regression:

```text
available transient capacity without new group = 150 - 17 = 133
sold without = min(107,133) = 107
available with 50-room group = 83
sold with = min(107,83) = 83
transient displacement = 107 - 83 = 24
non-transient-displacing requested rooms = 50 - 24 = 26
```

This does **not** reconstruct the present integrated UI because future group demand/contribution and settings are unavailable.

## 34. Second example — low displacement

Using the same reproducible engine fixture but reducing final transient forecast to 50 and setting final group forecast Base=27:

```text
future transient = 50-16 = 34
future group = 27-17 = 10
future total = 44
remaining capacity before/after group = 117 / 67
sales without/with = min(44,117) / min(44,67) = 44 / 44
displacement = 0; non-displacing new group rooms = 50
```

At zero breakfast/BQT and €20 variable cost, lost contribution is zero and floor is only cost recovery plus commission: `max(0,0+€1,000)/.9/50 = €22.22 excl./incl. VAT at 0%`. This demonstrates the engine does not assume every requested RN displaces demand. Again this is implementation-derived, not Firestore evidence.

## 35. Assumptions register

| Implemented assumption | Why it exists/evidence | Current effect | Likely future evidence/model improvement |
|---|---|---|---|
| Historical final individual-room share represents target transient final demand. | No transient pace model. | Median comparable utilization scaled to current inventory. | Pace/lead-time and unconstrained-demand observations. |
| Historical final group share represents expected final realized group demand. | Explicit method/warning. | P25/P50/P75 forecast. | Group booking-curve and inquiry conversion evidence. |
| `calculatedInventoryRooms` is sellable inventory. | Sole inventory field selected. | Inventory/OOO handled without separate adjustments. | Source contract/field lineage validation. |
| `individualRooms`/`groupRooms` are hard committed in current snapshot. | Explicit mapper. | Consume capacity exactly once. | PMS status mapping validation. |
| No separately proven “other committed” bucket exists. | Mapper comment and constant zero. | Other current categories do not consume additional capacity. | Establish deductibility semantics by field. |
| Non-deductible group is prospect, not committed. | Mapped as pipeline only. | No capacity/demand use; first ADR proxy. | Conversion-weighted pipeline model. |
| Historical and PMS group ADRs are excl. VAT. | Used without conversion internally/tests describe them that way. | Contribution/floor depends on source tax consistency. | Persist explicit rate-basis metadata. |
| Same DOW/month/season and group calendar regime imply comparability. | Tier predicates. | Determines sample and confidence. | Backtested similarity/weights. |
| Lighthouse relative demand has elasticity beta .5 and ±15% cap. | Hardcoded config. | Dampened transient adjustment. | Calibrated hotel-specific elasticity. |
| Lowest-contribution demand is displaced first. | Allocation sorter. | Protects more valuable demand, not segment chronology. | RM validation/controls. |
| Quote commission also represents future displaced group commission. | Same rate used. | Future group value changes with quote terms. | Segment-specific future commission. |
| Unknown future group BQT/breakfast equals zero. | Explicit warning. | Understates value when ancillaries would contribute. | Historical ancillary-per-group-RN model. |
| Breakfast Pax is total for quote. | Cost formula does not multiply by nights. | Direct total cost. | Explicit per-day/pax-night input if needed. |

## 36. Limitations register

| Impact | Verified limitation |
|---|---|
| **HIGH** | No historical group booking pace/lead-time model; final-demand distribution ignores current observation date except OTB floor. |
| **HIGH** | No inquiry, declined-demand, conversion, cancellation, wash, or unconstrained group-demand model. |
| **HIGH** | Future group ADR has only live prospect then current committed ADR proxy; no historical ADR fallback. Missing value can null the floor. |
| **HIGH** | Revenue VAT basis is not tagged at source; BQT/breakfast basis is unknown. |
| **MEDIUM** | Lighthouse pricing/compset recommendation is not integrated and tax basis is unknown. |
| **MEDIUM** | Demand Calendar effects are categorical matching only, with no numeric SUPPRESS/BOOST and no category reads in analysis. |
| **MEDIUM** | Full collections/snapshots are loaded and repeatedly scanned; forecast recalculation refetches unchanged sources. |
| **MEDIUM** | Saved analysis is incomplete and can become stale after edit; detail view does not expose it. |
| **MEDIUM** | Future group ancillaries are excluded. |
| **LOW** | UI rounds forecast rooms while calculation retains fractions, complicating manual display reconciliation. |
| **LOW** | Confidence systems have inconsistent casing/rules and no overall confidence. |

## 37. Business-logic review flags

| Severity | Location | Current behavior and why it matters |
|---|---|---|
| **CRITICAL** | `contributionAnalysis.js` settings normalization and rate proxies | Internal model assumes historical/PMS rates excl. VAT and untagged BQT/breakfast economics; source basis is not validated. A tax-basis mismatch directly scales contribution/floor. |
| **HIGH** | `GroupQuoteEditPage.jsx`; create save payload | Editing input does not rerun/update `analysisYears` or saved forecasts. Persisted quote may contain analysis arrays for prior dates/rooms, though detail currently hides them. |
| **HIGH** | `contributionAnalysis.js` future group proxy | Quote’s commission rate values all future group rooms. Pipeline ADR is first priority and can be based on a small/unrepresentative pipeline; no historical fallback. |
| **HIGH** | `groupDemandForecast.js` comparable fallback | When no tier reaches five, reverse search selects broad Tier 5 whenever nonempty, even if a narrower tier has almost enough observations. This can materially broaden P25/P50/P75. |
| **HIGH** | `GroupQuoteCreatePage.jsx` selected-year default | Normal production bypasses the transient five-year default and uses all available years; very old history can enter both models. |
| **MEDIUM** | `contributionAnalysis.js` capacity conflict | Any requested room above current uncommitted capacity nulls all floors rather than producing partial economics; operationally safe but eliminates a decision output. |
| **MEDIUM** | `calendarFeatures` | SUPPRESS/BOOST are labels, not numeric modifiers; important neutral events prevent normal regime, while leisure/other events do not affect regime. UI vocabulary can imply stronger effects than model behavior. |
| **MEDIUM** | `selectHistoricalObservations` | 1–2 valid unconstrained season rows are discarded in favor of censored observations if no ≥3 fallback. Lower-bound dates may become the estimate despite usable small sample. |
| **MEDIUM** | `calculateGroupContribution` | Unknown-value bucket sorts first; if displaced, floor becomes null. Sorting missing value as lowest is conservative about allocation order but destroys valuation availability. |
| **MEDIUM** | `mapCurrentOtb` | Missing calculated inventory has no `inventoryRooms` fallback, and all other committed categories are zero. Correctness relies on importer semantics. |
| **LOW** | warning/UI layers | Missing Lighthouse/transient warnings do not aggregate into headline warnings; nightly confidence shows only group confidence. |

No arithmetic double-counting of the three requested room buckets was found.

## 38. Data-quality flags and current handling

| Source issue | Handling |
|---|---|
| Zero/missing/invalid historical inventory | Row excluded from both forecasts. |
| Missing current calculated inventory | Mapped zero; transient warning; group normalized samples empty; capacity conflict likely and floor null for positive request. |
| `inventoryRooms` present but calculated inventory missing | Ignored; no fallback. |
| Zero/invalid/nonpositive historical ADR | Excluded only from rate median, not demand sample. If all invalid and transient displacement >0, lost value/floor null. |
| `groupRooms > inventory` historically | Accepted; share >1 and normalized forecast may exceed capacity. Transient preferred filter may reject by group share, but relaxed tiers can use it. |
| Negative historical `individualRooms` | Accepted as numeric; can lower transient ratio/baseline. |
| Negative historical group rooms | Group row excluded; transient mapper clamps group rooms to 0. Thus engines can use the same corrupt row differently. |
| `calculatedOccRooms` missing | Historical occupied defaults 0, other actual 0; censoring may under-detect constraints. |
| OOO differences | No separate subtraction; relies on calculated inventory. |
| Missing current transient OTB | Zero plus warning; `currentOtbExists=false`. |
| Missing current group OTB | Zero without a dedicated group missing warning. |
| Pipeline revenue >0 with zero pipeline rooms | Proxy skipped. |
| Pipeline rooms >0 with zero revenue | Proxy skipped; no direct data-quality warning unless future group displacement needs value. |
| Current group rooms >0 with zero revenue | Existing ADR skipped. |
| Missing/invalid Lighthouse demand | Modifier 1 plus nightly transient warning. |
| Missing Demand Calendar events | Target “normal” plus Group Forecast warning, but history also becomes normal so Tier 1/2 may match and can still earn HIGH confidence. |
| Duplicate event ID across paths | Canonical overwrites legacy. |
| Duplicate overlapping important events | Duplicate regime strings can affect exact equality. |
| Forecast above inventory | Allowed as demand; capacity simulation caps sales. |
| Fractional forecast rooms | Retained; UI rounds only. |

## 39. Formula summary

```text
historicalTransientRatio_i = individualRooms_i / calculatedInventoryRooms_i
historicalBaselineRooms = median(selected ratios) × targetSellableInventory
lighthouseIndex = targetMarketDemand / median(same-DOW ±28-day demands)
lighthouseModifier = clamp(1 + .5×(index-1), .85, 1.15)
finalTransientDemand = max(currentTransientOtb,
                           historicalBaselineRooms×lighthouseModifier)
futureTransientDemand = max(0, finalTransientDemand-currentTransientOtb)

historicalGroupShare_i = groupRooms_i / calculatedInventoryRooms_i
normalizedGroupRooms_i = historicalGroupShare_i × targetSellableInventory
finalGroupLow/Base/High = max(currentGroupOtb,
  P25/P50/P75(normalizedGroupRooms))
futureGroupDemand_S = max(0, finalGroupDemand_S-currentGroupOtb)

hardCommitted = currentTransientOtb + currentGroupOtb + hardOther(=0)
remainingCapacity = max(0, sellableInventory-hardCommitted)
futureDemandWithoutNewGroup_S = futureTransientDemand + futureGroupDemand_S
futureSalesWithout_S = min(futureDemandWithout_S, remainingCapacity)
futureSalesWith_S = min(futureDemandWithout_S,
                         max(0,remainingCapacity-requestedRooms))
totalDisplacement_S = min(requestedRooms,
  max(0,futureSalesWithout_S-futureSalesWith_S))
nonDisplacingRooms_S = requestedRooms-totalDisplacement_S

transientContributionPerRoom = expectedTransientAdr×(1-distributionRate)
                             - variableRoomCost
                             + transientBreakfastPax
                               ×(breakfastRevenuePerPax-breakfastCostPerPax)
futureGroupAdr = first valid of pipelineRevenue/pipelineRooms,
                                  groupRevenue/currentGroupOtb
futureGroupContributionPerRoom = futureGroupAdr×(1-commission)
                               - variableRoomCost

allocate totalDisplacement lowest contribution first, capped by demand bucket
lostContribution_S = displacedTransient_S×transientContribution
                   + displacedFutureGroup_S×futureGroupContribution
groupVariableCosts = requestedRoomNights×variableRoomCost
groupBreakfastCosts = breakfastPax×breakfastCostPerPerson
bqtContribution = Σ nightlyBqtRevenue×bqtMargin
requiredNetRevenue_S = max(0, lostContribution_S + groupVariableCosts
                              + groupBreakfastCosts - bqtContribution)
commissionableRevenueExVat_S = requiredNetRevenue_S/(1-commission)
economicFloorExVat_S = commissionableRevenueExVat_S/requestedRoomNights
economicFloorInclVat_S = economicFloorExVat_S×(1+roomVAT/100)

simulatorRateExVat = testRateInclVat/(1+roomVAT/100)
simulatorContribution = simulatorRateExVat×requestedRoomNights×(1-commission)
                      - groupVariableCosts-groupBreakfastCosts+bqtContribution
simulatorIncrementalContribution = simulatorContribution-baseLostContribution
```

## 40. Final architecture assessment

### A. What the model does well

* Separates current committed rooms, expected future demand, and the new request, avoiding the specified OTB/pipeline double counts.
* Uses sellable rather than physical inventory and models demand above capacity without capping forecast.
* Uses robust medians/percentiles, transparent comparable tiers, OTB floors, and visible diagnostic rows.
* Allocates displacement explicitly by marginal contribution and preserves full precision.
* Separates internal excl.-VAT room economics from commercial incl.-VAT rate UI through central helpers.

### B. What remains approximate

Historical similarity, hardcoded seasons/sample thresholds, Lighthouse elasticity/caps, pipeline/current group ADR proxies, identical commission for future group, and transient breakfast averages are approximations rather than calibrated causal models.

### C. What is not modeled

Group/transient pace, lead time, STLY adjustment, inquiry conversion/declines, wash/cancellation, future group ancillaries, numeric calendar uplift/suppression, compset pricing, pricing recommendation, room-type constraints, length-of-stay interactions, or probabilistic joint capacity.

### D. Outputs to trust most (conditional on source correctness)

Mechanical current-OTB mapping, capacity arithmetic, no-double-count decomposition, per-input cost/BQT/commission reconciliation, VAT conversion, and simulator arithmetic are the most directly auditable outputs.

### E. Outputs to treat cautiously

Group P25/P50/P75 demand, future-group opportunity cost, high/low scenario ranges, confidence labels, and any floor relying on unverified revenue tax basis or a sparse pipeline ADR proxy deserve caution. A displayed floor is model-consistent, not evidence that every source semantic is correct.

### F. Top five review areas next (assessment only; no implementation proposed here)

1. Verify and tag VAT/net basis for every PMS ADR/revenue, BQT, and breakfast source.
2. Revenue Management validation/backtest of group comparable fallback, pace omission, and percentile calibration using strictly prior data.
3. Validate current PMS deductibility and calculated-inventory semantics, especially missing inventory and other committed categories.
4. Review future-group value proxy/commission/ancillary assumptions and null-value allocation behavior.
5. Establish persistence/source-of-truth policy so edited or reopened quotes cannot present stale/incomplete analysis.

---

## Audit traceability and unresolved evidence

Primary production references inspected: `GroupQuoteCreatePage.jsx:40-100,128-193`; `GroupQuoteFormFields.jsx:4-116`; `displacementForecast.js:3-269`; `groupDemandForecast.js:3-120`; `contributionAnalysis.js:4-176`; `roomRateVat.js:1-22`; `firebaseQuotes.js:15-119`; `firebaseDemandCalendar.js:3-43`; `firebaseLighthouse.js:3-25`; `lighthouseImport.js:1-97`; `GroupQuoteSettingsPage.jsx:14-109`; detail/edit pages; demand-calendar constants; relevant Vitest files.

**Could not determine confidently:** actual production Firestore values or a real full quote/UI result; upstream PMS definitions beyond their use in code; tax basis of source ADR/group/BQT/breakfast/Lighthouse prices; whether all hotels have completed Demand Calendar path migration; whether external consumers read saved forecast arrays. These require data contracts, authenticated production evidence, or stakeholder confirmation and are not inferred here.

## Transient Value V2 (model `group-contribution-v3-transient-value`)

Previously, transient opportunity cost used historical `averageRoomRate`, a blended hotel ADR containing transient and group business. New analyses no longer use that field as authoritative value evidence.

Transient Value V2 reuses the exact historical dates selected by the Transient Demand Forecast; it does not run another comparable scan. For each selected date with valid inventory, positive finite `individualRooms`, and positive finite `individualRevenueDeductible`, its excl.-VAT ADR observation is `individualRevenueDeductible / individualRooms`. Each date supplies one equally weighted observation. Observations are compounded to the target year with the central inflation helper and their median is the historical baseline.

A current historyforecast stay date preserves `individualRevenueDeductible`. When current transient OTB rooms and deductible revenue are positive, revenue / rooms supplies one (not room-weighted) current OTB ADR signal. The expected future transient ADR is the median of all inflation-adjusted historical observations plus that optional single current signal. There is no blended-ADR fallback for new analyses.

Value confidence is HIGH for at least five historical observations plus current OTB; MEDIUM for at least three historical observations, or at least two plus current OTB; LOW for lesser non-empty evidence; and unavailable for none. Current-only, low-evidence, and unavailable states have stable warnings. The contribution engine continues to subtract the configured transient distribution percentage and variable room cost, then adds the unchanged transient breakfast contribution. All economics remain excl. VAT; the incl.-VAT ADR is display metadata only. Missing value evidence makes an affected transient displacement and Economic Floor unavailable rather than fabricating a rate.


## Net Group Value correction (model `group-contribution-v4-net-group-value`)

The revenue-field contract is now explicit: `groupRevenueDeductible` is realized, deductible, room-only group revenue on an excl.-VAT basis and is authoritative for historical/current Group ADR. `individualRevenueDeductible` remains the corresponding authoritative transient room-revenue field. `groupRevenueNonDeductible` is non-deductible prospect/block commercial context whose VAT and package composition are not normalized; its calculated `pipelineCommercialRate` is informational only and is not Future Group Value contribution evidence. This corrects the prior Future Group Value V2 treatment, which placed the pipeline quotient into the net ADR median. No VAT or breakfast stripping is attempted.

## Market Pricing Context V1 and competitor group intelligence foundation

Market pricing is a separate informational layer above the unchanged contribution and Economic Floor engine. Lighthouse hotel prices are consumer-facing public rates **including VAT** (`INCL_VAT_CONSUMER`). They are parsed without VAT gross-up and never become transient/group ADR evidence, lost contribution, displacement, or an Economic Floor input. Product context is retained as nullable compset metadata because a public shopping rate must not be described as a competitor group quote.

### Configuration and reads

The compset header is stored at `hotels/{hotelUid}/settings/compset`. It contains `ownHotelLighthouseFieldName`, the fixed `lighthouseRateBasis`, nullable source-context fields, and `updatedAt`. Competitors are stored at `hotels/{hotelUid}/settings/compset/competitors/{competitorId}` with display/field mapping, active/include flags, non-negative `marketRelevanceWeight`, group-intelligence enablement, sort order, optional informational `strategyNotes`, and timestamps. Analysis loads the header once and the complete competitor subcollection once, alongside the already-loaded latest Lighthouse stay-date map; there are no per-date or per-competitor reads.

For each date, only active, included, positive-weight competitors with a numeric mapped public rate participate. Available weights are renormalized and the arithmetic reference is `sum(publicRateInclVat × normalizedEffectiveWeight)`. Missing and nonnumeric values are unavailable, never zero. Coverage is available configured weight divided by all configured active/included positive weight; HIGH is at least 80%, MEDIUM at least 60%, LOW below 60%, and no valid rates is UNAVAILABLE. Median, range, own-versus-reference differences, Market Demand, and My OTB remain descriptive. Overall own, weighted-reference, median, and coverage values are requested-room-night weighted and omit missing values rather than zero-filling them.

### Immutable quote snapshot

A current analysis saves `marketContextSnapshot` with Lighthouse snapshot date, consumer-including-VAT basis, `market-context-v1`, own mapping, nullable shopping context, copied effective competitor settings, per-date rates/configured and effective weights/coverage/demand, and room-night-weighted group summary. It also saves `contributionModelVersion` separately, so Market Context does not imply an Economic Floor model change. Existing edit behavior marks analysis `STALE` when material quote inputs change; detail renders the old market snapshot explicitly as historical rather than current. Rerunning a new analysis reads current source/configuration and creates a new snapshot under the existing quote-analysis lifecycle.

### Canonical observed competitor group quotes

Actual observations are written independently to `hotels/{hotelUid}/competitorGroupQuotes/{observationId}`. Records preserve competitor, observation/source timestamps and controlled source type, optional source quote, stay/room context, quoted rate including VAT, unmodified meal and occupancy basis, optional public rate frozen from the quote snapshot, source confidence, notes, and optional user identity fields. Quote-linked saves use a stable `{sourceQuoteId}_{competitorId}` document ID to prevent duplicate observations. Public rate is optional. The dataset produces counts only: no discount ratio, prediction, product normalization, elasticity, conversion probability, or recommended/target/stretch rate exists in V1.

## Market Pricing Context V1.1 and Pricing Guidance V1

The architecture now has four deliberately separate layers:

1. **Economic Floor** protects contribution and opportunity cost; its engine and formula are unchanged.
2. **Market Context** describes consumer-facing Lighthouse public pricing including VAT and availability status; it is not contribution evidence.
3. **Pricing Guidance V1** creates a deterministic commercial Target/Stretch corridor from the saved Economic Floor, base displacement, and public market context.
4. **Competitor Group Intelligence** remains canonical observed group pricing and is not read by Pricing Guidance.

### Lighthouse status and availability pressure

The central parser returns the original raw value, nullable `rateInclVat`, and one of `AVAILABLE`, `SOLD_OUT`, `LOS_RESTRICTION`, `CLOSED`, or `UNAVAILABLE`. Status parsing is case-insensitive. Only `AVAILABLE` numeric observations enter the weighted reference, median, low, or high. For every stay date:

```text
configuredIncludedWeight = sum(active + included + positive configured weights)
availableRateWeight       = sum(weights with AVAILABLE numeric price)
soldOutWeight             = sum(weights with SOLD_OUT)
restrictedWeight          = sum(weights with LOS_RESTRICTION)
closedWeight              = sum(weights with CLOSED)
rateCoverage              = availableRateWeight / configuredIncludedWeight
soldOutWeightShare        = soldOutWeight / configuredIncludedWeight
restrictedWeightShare     = restrictedWeight / configuredIncludedWeight
```

Available rates retain the V1 renormalization across `availableRateWeight`. Sold out never means zero, and LOS restrictions never count as sold-out pressure. The group-stay rate coverage, sold-out share, restricted share, and Market Demand are requested-room-night weighted. Each date exposes every configured competitor with raw status, configured weight, and an effective weight only when its numeric rate participates.

### Editable deterministic strategy

`settings/compset.pricingStrategy` stores decimal fractions and exposes these defaults in Revenue Management settings: low/high displacement thresholds `0.25/0.65`; Target capture by LOW/MEDIUM/HIGH `0.80/0.90/0.97`; Stretch capture `0.90/0.97/1.00`; high-demand threshold/uplift `0.80/0.02`; sold-out-weight threshold/uplift `0.20/0.02`; and final commercial rounding step `1` euro. Uplifts are percentage-point additions and adjusted capture is capped at `1.00`.

```text
displacementRatio = base total displaced room nights / requested room nights
yieldBand = LOW when ratio <= low upper bound
          = HIGH when ratio >= high lower bound
          = MEDIUM otherwise
marketAnchor = weighted compset reference when coverage >= 60%
            else compset median
            else own public rate
adjustedCapture = min(1, baseCapture + highDemandUplift? + soldOutUplift?)
rawTarget = marketAnchor * adjustedTargetCapture
rawStretch = marketAnchor * adjustedStretchCapture
target = max(Economic Floor, commercially rounded rawTarget)
stretch = max(target, Economic Floor, commercially rounded rawStretch)
```

Intermediate values are not rounded. Floor protection is re-applied after presentation rounding. The quoted product label is `BB` when existing quote-level Breakfast Pax is positive and `RO` otherwise; no breakfast semantics or formulas changed. Every result warns `PUBLIC_MARKET_PRODUCT_NOT_NORMALIZED`. Floor above anchor adds `ECONOMIC_FLOOR_ABOVE_MARKET`; Target or Stretch above own public price adds `RECOMMENDATION_ABOVE_OWN_PUBLIC_RATE`. These are comparison warnings, not product normalization.

New quotes persist `pricingGuidanceModelVersion: "pricing-guidance-v1"` and a `pricingGuidanceSnapshot` containing the floor, anchor/source, displacement ratio/band, weighted demand/sold-out pressure, base/adjusted captures, raw and final rates, meal basis, confidence, and warnings. Existing snapshots are not recalculated, and stale quote analyses do not present old guidance as current.

## Group Quote Commercial Workflow V2

New quotes use `quoteInputSchemaVersion: "group-quote-v2"` and `dateRangeSemantics: "CHECKOUT_EXCLUSIVE"`. `startDate` is Arrival and `endDate` is Check-out; generated room nights satisfy `arrival <= stayDate < checkout`, and same-day/reversed stays are rejected. Unversioned records remain legacy inclusive ranges and are explicitly labelled as such; no migration or silent reinterpretation occurs.

V2 `roomsByDate` records are `{ date, rooms, breakfastPax, bqtRevenue }`. `totalBreakfastPax = sum(roomsByDate[].breakfastPax)` and the unchanged cost equation receives that total: `groupBreakfastCosts = totalBreakfastPax * breakfastCostPerPerson`. Legacy quote-level `breakfastPax` remains supported without inventing a nightly distribution. Meal basis is RO when all nightly pax are zero, BB when all nights are positive, and MIXED otherwise.

Quotes begin with `commercialStatus: PENDING`. Mutable commercial history is stored separately from immutable analysis in `outcome` and append-only `rateHistory[]`. Status is controlled (`PENDING`, `WON`, `LOST`, `DECLINED`, `CANCELLED`), as are client-lost and hotel-declined reasons. `outcome.decisionSnapshot` freezes contribution/market/guidance versions, Floor/Target/Stretch, actual final quote, meal basis, displacement, market anchor/demand/confidence. LOST outcomes with competitor/rate evidence upsert `competitorGroupQuotes/{sourceQuoteId}_{competitorId}` and copy stay/public-rate context from the quote's saved Market Context—never today's Lighthouse data.

Market Context version `market-context-v1.1-rate-quality` adds `PLACEHOLDER_RATE`. A numeric rate is excluded, not clamped, when it exceeds the competitor ceiling (falling back to compset global ceiling) or matches a configured exact placeholder within half a cent. The original/display rate remains visible. A reliable-booking-horizon breach adds `FAR_OUT_RATE_CONTEXT` but does not exclude an otherwise valid rate. Placeholder weight/share is separate from sold-out weight/share and is room-night weighted across the stay. Cleaner inputs may change Market Anchor and therefore Target/Stretch, but they cannot change the independently calculated Economic Floor; `pricing-guidance-v1` formulas remain unchanged.

Commercial persistence shape:

```text
quotes/{quoteId}
  quoteInputSchemaVersion, dateRangeSemantics, requestDate, startDate, endDate
  roomsByDate[{date, rooms, breakfastPax, bqtRevenue}], groupSegment
  quoteInputSnapshot{version, requestDate, arrivalDate, checkOutDate,
                     dateRangeSemantics, groupSegment, roomsByDate[]}
  commercialStatus
  outcome{status, decidedAt, finalQuotedRateInclVat, finalQuotedMealBasis,
          lostReason?, declinedReason?, lostToCompetitorId?,
          competitorQuotedRateInclVat?, competitorMealBasis?,
          competitorOccupancyBasis?, competitorSourceConfidence?, notes,
          decisionSnapshot{model versions and analysis/guidance evidence}}
  rateHistory[{quotedAt, rateInclVat, mealBasis, notes}]

settings/compset
  maxUsablePublicRateInclVat?, pricingStrategy{...}
settings/compset/competitors/{competitorId}
  maxUsablePublicRateInclVat?, placeholderPublicRatesInclVat[]?,
  maxReliableLeadTimeDays?, plus existing mapping/weight/status fields
competitorGroupQuotes/{sourceQuoteId}_{competitorId}
  sourceType=LOST_GROUP, sourceQuoteId, observedAt, requestDate,
  arrivalDate, checkOutDate, roomsByDate, requestedRoomNights, leadTimeDays,
  groupSegment, competitorQuotedRateInclVat, mealBasis, occupancyBasis,
  sourceConfidence, publicRatesByDate[{stayDate, publicRateInclVat}], notes
```

## Revenue Management decision-screen hierarchy

The create-analysis UI now presents the saved calculation outputs through three information levels without changing the calculation or persistence pipeline:

1. **Decision** — the compact quote summary and open Commercial Decision card make Target the primary suggested starting quote, with Stretch as the upper negotiation anchor and Economic Floor as the protection threshold. Critical warnings remain visible; modelling notes and the quote simulator are collapsed.
2. **Operational Detail** — Key Group Impact, Nightly Pricing, and Market Pricing Context remain open. Technical nightly fields and per-date competitor rows are available from collapsed details.
3. **Model Diagnostics** — one collapsed master section contains separately expandable Transient Demand, Group Demand, Transient Value, and Future Group Value audits. Historical comparable and ADR-observation tables are nested and are not rendered visibly until expanded.

After a successful analysis the input form is replaced by a compact summary; **Edit inputs** restores the pre-populated form. Economic Floor reconciliation, Model Diagnostics, quote simulation, historical evidence, and compset detail are closed by default. Commercial Decision, Key Group Impact, Nightly Pricing, and Market Pricing Context are open by default. Native `details`/`summary` controls retain keyboard and expanded-state semantics for the mounted page.

## Explicit Group Quote meal basis (input V3)

New quotes use input schema `group-quote-v3-meal-basis`. Every `roomsByDate[]` row freezes `{ date, rooms, mealBasis, breakfastPax, bqtRevenue }`, where `mealBasis` is the controlled commercial product definition (`RO` or `BB`) and `breakfastPax` is the independent economic breakfast quantity. Quote-level product labels are derived only from explicit nightly products: all RO is `RO`, all BB is `BB`, and a combination is `MIXED`.

These inputs never overwrite one another. For example, **50 rooms / BB / 20 breakfast pax** remains a BB commercial product with 20 breakfasts costed; **50 rooms / RO / 20 breakfast pax** remains Room Only while the same 20 exceptional or complimentary breakfasts are still costed. BB with zero pax and RO with positive pax are permitted and produce informational data-quality notes.

The `defaultGroupMealBasis` setting supplies the initial RO/BB selection for newly generated nights and can be overridden per night. Hotels without the setting default safely to RO. Existing V1 and pre-change V2 records without explicit nightly meal basis remain `LEGACY_UNKNOWN`; no product is inferred from their breakfast quantity and no old record is rewritten.

Economic breakfast cost remains exactly `sum(roomsByDate[].breakfastPax) × breakfastCostPerPerson`. Meal basis adds no cost, revenue, VAT, market normalization, or price adjustment. The Economic Floor structure and Pricing Guidance capture, yield-band, uplift, market-anchor, Target, and Stretch formulas are unchanged.
