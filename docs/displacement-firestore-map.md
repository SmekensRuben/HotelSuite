# Displacement Analysis – Firestore Data Map

This file is the source of truth for the Group Displacement Analysis V1.

## Root

All hotel data lives under:

```text
hotels/{hotelUid}/reports/...
```

Never hardcode a specific hotel UID. Use the hotel context already used by the application.

---

## 1. Historical actuals

### Path

```text
hotels/{hotelUid}/reports/historyquotes/consideredDates/{stayDate}
```

`{stayDate}` is an ISO date document ID in `YYYY-MM-DD` format.

### Relevant fields

```text
consideredDate
historyFutureType
calculatedInventoryRooms
inventoryRooms
calculatedOccRooms
individualRooms
groupRooms
averageRoomRate
complimentaryRooms
houseUseRooms
ownerRooms
ffRooms
oooRooms
noShowRooms
```

### Meaning for this feature

Use:

```text
historical transient actual rooms = individualRooms
historical group actual rooms     = groupRooms
historical total occupied rooms   = calculatedOccRooms
historical sellable inventory     = calculatedInventoryRooms
historical ADR                    = averageRoomRate
```

Do NOT use `inventoryRooms` as sellable inventory when
`calculatedInventoryRooms` exists.

Example seen in Firestore:

```text
inventoryRooms: 150
oooRooms: 6
calculatedInventoryRooms: 144
```

For displacement forecasting, `calculatedInventoryRooms` is the correct
capacity field.

Historical documents should normally have:

```text
historyFutureType = "History"
```

---

## 2. Current OTB / forecast snapshot

### Snapshot path

```text
hotels/{hotelUid}/reports/historyforecast/snapshotDates/{snapshotDate}
```

### Stay-date path

```text
hotels/{hotelUid}/reports/historyforecast/snapshotDates/{snapshotDate}/stayDates/{stayDate}
```

Both `{snapshotDate}` and `{stayDate}` use `YYYY-MM-DD`.

The latest snapshot must be selected from `snapshotDates`.

Prefer ordering by Firestore document ID descending if no reliable
`snapshotDate` field exists on the snapshot document.

### Relevant stay-date fields

```text
consideredDate
historyFutureType
calculatedInventoryRooms
inventoryRooms
calculatedOccRooms
individualRooms
groupRooms
averageRoomRate
complimentaryRooms
houseUseRooms
ownerRooms
ffRooms
oooRooms
noShowRooms
```

### Meaning for this feature

Use:

```text
current transient OTB       = individualRooms
current existing group OTB  = groupRooms
current total OTB           = calculatedOccRooms
current sellable inventory  = calculatedInventoryRooms
```

Calculate other committed rooms as:

```text
otherCommittedRooms =
max(
  0,
  calculatedOccRooms
  - individualRooms
  - groupRooms
)
```

This prevents the displacement model from having to make assumptions about
how comp, house-use, owner, FF or other occupied-room categories are represented.

Future documents should normally have:

```text
historyFutureType = "Forecast"
```

---

## 3. Lighthouse Market Demand

### Snapshot path

```text
hotels/{hotelUid}/reports/lightHouseData/snapshotDates/{snapshotDate}
```

Snapshot documents contain fields such as:

```text
snapshotDate
importedAt
stayDateCount
```

### Stay-date path

```text
hotels/{hotelUid}/reports/lightHouseData/snapshotDates/{snapshotDate}/stayDates/{stayDate}
```

### Relevant fields for V1

```text
Market demand
My OTB
```

Other rate/compset fields are preserved but are NOT used in V1 transient-demand
forecasting.

Current imported Lighthouse values may be stored as strings, for example:

```text
Market demand: "98%"
My OTB: "91%"
```

The forecast layer must therefore normalize:

```text
"93%" -> 0.93
93    -> 0.93
0.93  -> 0.93
```

Invalid percentage values must return `null` rather than crash the analysis.

Use the application's PMS/historyforecast data as the primary OTB source.
`My OTB` from Lighthouse is only a QA/reference field in V1.

The latest Lighthouse snapshot should be loaded ONCE per displacement analysis,
and all `stayDates` should be put into an in-memory map keyed by `YYYY-MM-DD`.

---

## 4. Existing displacement setting

The application already contains a setting named:

```text
maxHistoricalGroupShare
```

Do NOT create a second setting or a new Firestore path for it.

Codex must inspect the existing displacement implementation and reuse the
existing setting source/path.

For V1 this setting is a PREFERENCE threshold for historical comparable
selection, not an unconditional hard exclusion rule.

Reason: Ghent Marriott is business/group heavy. A historical date can have a
high group share while still leaving sufficient capacity for transient demand
to materialize. A hard exclusion would create selection bias toward summer or
other low-group periods.

---

## 5. V1 model constants

Until dedicated UI/Firebase settings are created, keep these in the existing
displacement configuration layer, not scattered through business logic:

```text
historicalYears = 5
minimumPreferredHistoricalSample = 6
minimumFallbackHistoricalSample = 3

historicalCapacityConstraintThreshold = 0.95

lighthouseComparableWindowDays = 28
lighthouseDemandBeta = 0.50
lighthouseMinModifier = 0.85
lighthouseMaxModifier = 1.15
```

Do not create new Firestore settings documents just for these constants unless
the existing application already has an appropriate settings object.

---

## 6. Business-season buckets for historical fallback

Do NOT automatically widen a September request into July/August comparables.

Use these initial hotel-season buckets for V1:

```text
WINTER_LOW      = January-February
SPRING_BUSINESS = March-June
SUMMER          = July-August
AUTUMN_BUSINESS = September-November
FESTIVE         = December
```

These are fallback buckets, not the first-choice comparison.

Historical selection order is defined in the Codex implementation prompt.

---

## 7. Historical capacity-constrained detection

For each historical actual document:

```text
otherActualRooms =
max(
  0,
  calculatedOccRooms
  - individualRooms
  - groupRooms
)

transientCapacity =
max(
  0,
  calculatedInventoryRooms
  - groupRooms
  - otherActualRooms
)
```

If `transientCapacity <= 0`, the observation is capacity constrained.

Otherwise:

```text
transientCapacityUtilization =
individualRooms / transientCapacity
```

If:

```text
transientCapacityUtilization >= historicalCapacityConstraintThreshold
```

treat the observation as CENSORED for point-estimate purposes.

A censored date tells us only that transient demand was AT LEAST the observed
`individualRooms`; it should not be treated as proof that true transient demand
equalled the observed rooms.

Do not silently replace a censored September observation with an August
observation.

---

## 8. Historical transient baseline

For an accepted historical comparable:

```text
transientOccupancyRatio =
individualRooms / calculatedInventoryRooms
```

The V1 baseline uses the MEDIAN of the selected comparable ratios.

```text
historicalBaselineRooms =
medianTransientOccupancyRatio
* currentSellableInventory
```

Do not use the arithmetic mean.

---

## 9. Lighthouse modifier

For a requested future stay date:

1. Read target `Market demand` from the latest Lighthouse snapshot.
2. In that SAME latest snapshot, find same-day-of-week dates within
   +/- `lighthouseComparableWindowDays`.
3. Exclude the target date itself.
4. Calculate the median normalized Market Demand of those dates.

Then:

```text
marketIndex =
targetMarketDemand / comparableMedianMarketDemand

uncappedMarketModifier =
1 + lighthouseDemandBeta * (marketIndex - 1)

marketModifier =
clamp(
  uncappedMarketModifier,
  lighthouseMinModifier,
  lighthouseMaxModifier
)
```

If Lighthouse data is missing or invalid:

```text
marketModifier = 1
```

and add a warning.

---

## 10. Final transient-demand forecast

```text
adjustedHistoricalDemand =
historicalBaselineRooms * marketModifier

transientDemandForecast =
max(
  currentTransientOtb,
  adjustedHistoricalDemand
)
```

Do NOT cap `transientDemandForecast` at hotel inventory.
It is a demand estimate, not a sold-room estimate.

---

## 11. Displacement calculation

Inputs:

```text
sellableInventory
existingGroupOtb
otherCommittedRooms
requestedGroupRooms
transientDemandForecast
```

Without the new group:

```text
availableTransientWithoutGroup =
max(
  0,
  sellableInventory
  - existingGroupOtb
  - otherCommittedRooms
)

transientSoldWithoutGroup =
min(
  transientDemandForecast,
  availableTransientWithoutGroup
)
```

With the new group:

```text
availableTransientWithGroup =
max(
  0,
  availableTransientWithoutGroup
  - requestedGroupRooms
)

transientSoldWithGroup =
min(
  transientDemandForecast,
  availableTransientWithGroup
)
```

Displacement:

```text
displacedRooms =
max(
  0,
  transientSoldWithoutGroup
  - transientSoldWithGroup
)

displacedRooms =
min(displacedRooms, requestedGroupRooms)

nonDisplacingGroupRooms =
requestedGroupRooms - displacedRooms
```

---

## 12. Required explainability fields

The calculation result for each requested stay date must retain:

```text
historicalSelectionTier
forecastConfidence

historicalCandidateCount
historicalPreferredCount
historicalUsableCount
historicalCensoredCount
historicalSelectedCount

historicalMedianTransientOccupancy
historicalBaselineRooms

targetLighthouseMarketDemand
comparableLighthouseMarketDemand
lighthouseMarketIndex
lighthouseMarketModifier

adjustedHistoricalDemand
currentTransientOtb
transientDemandForecast

sellableInventory
existingGroupOtb
otherCommittedRooms
requestedGroupRooms

availableTransientWithoutGroup
transientSoldWithoutGroup
availableTransientWithGroup
transientSoldWithGroup

displacedRooms
nonDisplacingGroupRooms

warnings
```
