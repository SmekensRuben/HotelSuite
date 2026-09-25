# MARSHA Balance

## Purpose

MARSHA Balance is a read-only Front Office control. It compares current MARSHA and Opera availability through four focused controls plus Friday/Saturday DBDB protection. It never changes availability in either source.

Access remains hotel-specific through `marshaBalance.read` and `marshaBalance.update`. Settings are stored at:

```text
hotels/{hotelUid}/settings/marshaBalance
```

Only the current simplified fields are read and saved:

- `minimumGenr`: non-negative integer X;
- `premiumCategories`: MARSHA premium code, corresponding Opera type, and explicit allowed higher Opera types;
- `weekendDbdbProtection`: stored as `true`; Friday/Saturday DBDB protection is always active.

Legacy hierarchy, protection, release, overbooking, tolerance, and exception fields have no effect. Saving the page replaces the settings document with only the simplified model.

## Source and snapshot requirements

The existing snapshot selection remains unchanged. For each source, the newest snapshot on or before the current `Europe/Brussels` date is selected. The requested `stayDate` is read inside that snapshot.

Content controls run only when:

1. both stay-date documents exist;
2. MARSHA and Opera use the same snapshot date;
3. both snapshots are current and not explicitly failed or incomplete.

Otherwise the result is **Cannot assess**. A snapshot parent with `queryable: true` is not enough; the stay-date document itself is required.

## Explicit mapped totals

Both imports provide an explicit mapped total. The loader reads that total from the actual mapped total field and records its field path. Supported mapped names are `total`, `roomsTotal`, `totalRooms`, `availabilityTotal`, and `totalAvailability`; `roomsByType.Total` is also recognized when present in older/current documents.

The hotel total is never reconstructed by summing room types. `Total` is removed from `roomsByType` before room-type controls run and is never treated as a room type. A missing, non-numeric, or negative explicit total produces **Cannot assess**.

Missing room-type keys, zero, and negative values remain distinct. Relevant negative values produce **Cannot reliably assess** rather than being silently converted to zero.

## Hotel settings

### Desired minimum GENR

`minimumGenr` is X, the desired commercial minimum for MARSHA GENR. Normally:

```text
minimumGENR = min(X, MARSHA total)
```

If MARSHA GENR is below this value, the page shows a warning. This is a commercial warning, not proof of a physical placement failure.

### Premium shortage controls

Each configured premium control contains:

- the MARSHA premium category;
- its corresponding Opera room type;
- an explicit list of allowed higher Opera room types.

No relationship is inferred from room names or ordering. A higher type is usable only when explicitly selected.

### Weekend DBDB protection

Protection always applies to stay dates that are Friday or Saturday in the Brussels calendar. It uses `stayDate`, never `snapshotDate`.

## Controls

### 1. Explicit total comparison

```text
difference = MARSHA total - Opera total
```

Different totals create a **Total mismatch** finding showing both values and the difference.

### 2. Minimum GENR

Outside protected weekend nights:

```text
minimumGENR = min(X, MARSHA total)
```

MARSHA GENR below the effective minimum creates **GENR minimum warning**.

### 3/4. Premium shortage and higher-room coverage

For every configured premium category:

```text
shortage = max(0, MARSHA premium offered - corresponding Opera availability)
higherAvailable = sum(explicitly allowed higher Opera values)
coveredByHigher = min(shortage, higherAvailable)
uncovered = shortage - coveredByHigher
```

- No own-type shortage creates no finding.
- Full higher-type coverage creates **Upgrade may be required**, including the types and quantities.
- Partial or absent higher-type coverage creates **Action required** with the exact uncovered quantity.
- A MARSHA premium value of zero creates no error merely because Opera still has that room type.
- Missing, non-numeric, or negative relevant premium values create **Cannot reliably assess**.

Allowed higher inventory that is configured for multiple categories is reported separately as **Review shared upgrade inventory**. It is not presented as independently guaranteed to every category.

### 5. Friday/Saturday DBDB boundary

On Friday and Saturday stay nights:

```text
weekendMaximumGENR = Opera total - Opera DBDB
minimumGENR = min(X, MARSHA total, weekendMaximumGENR)
```

If MARSHA GENR exceeds the boundary, the page shows **Action required** with Opera total, Opera DBDB, the calculated boundary, MARSHA GENR, and the excess.

This is only a DBDB protection boundary. It does not claim that every other room is suitable for GENR.

No weekend boundary or weekend-adjusted minimum is calculated when totals differ, a total is unreliable, DBDB is missing/negative, GENR is missing/negative, or DBDB exceeds the Opera total. The data issue remains visible instead.

## Results and multiple findings

A date can contain several findings. The overview displays the most severe status while the detail page keeps every reason separate.

Severity order is:

1. **Cannot assess** — required total or source document/snapshot quality is insufficient;
2. **Cannot reliably assess** — a relevant room value is missing, invalid, or negative;
3. **Action required** — total mismatch, uncovered premium offer, or weekend GENR excess;
4. **Review** — shared higher-room inventory is not independently guaranteed;
5. **Warning** — commercial GENR minimum or a fully covered premium upgrade risk;
6. **Within rules** — every applicable configured control completed without a finding.

There is no generic tolerance, room hierarchy, protected inventory, release allocation, overbooking allowance, or date exception in this simplified model.

## Preview and detail page

The Settings preview runs the unsaved simplified configuration against a selected real stay date.

The detail page shows:

- every finding as a separate card;
- explicit MARSHA and Opera totals and their mapped field paths;
- MARSHA GENR, effective minimum, and weekend maximum;
- premium offered values, corresponding Opera availability, each allowed higher value, shortage, covered quantity, and uncovered quantity;
- raw room-type maps;
- collapsible snapshot metadata.
