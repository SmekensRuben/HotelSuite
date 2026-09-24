# MARSHA Balance

## Purpose and access

MARSHA Balance is a read-only Front Office control. It compares MARSHA availability with Opera availability and never writes availability back to either system.

Access is hotel-specific:

- `marshaBalance.read` grants access to the overview and detail pages.
- `marshaBalance.update` allows a user to maintain comparison rules.

Rules are stored in Firestore at:

```text
hotels/{hotelUid}/settings/marshaBalance
```

The document contains a `rules` array. A rule only participates in an assessment when both `enabled` is `true` and its optional activation condition is met.

## Data selection

For each source, the page reads snapshot documents from:

```text
hotels/{hotelUid}/reports/marshaavailability/snapshotDates/{snapshotDate}
hotels/{hotelUid}/reports/operaavailability/snapshotDates/{snapshotDate}
```

It selects the newest available snapshot date on or before the current date in `Europe/Brussels`. It then reads every requested stay date from the selected snapshot:

```text
.../snapshotDates/{snapshotDate}/stayDates/{stayDate}
```

The snapshot date is therefore deliberately independent from the stay date. A future stay date is looked up inside the current nightly snapshot rather than under a snapshot with the future stay date.

The overview defaults to today through 30 calendar days later, inclusive (31 dates), using Brussels calendar boundaries.

A source is shown as:

- **Available and current**: the stay-date document exists in today's snapshot and the snapshot metadata is not explicitly failed, errored, or incomplete.
- **Outdated**: the stay-date document exists, but the selected snapshot is older than today.
- **Expected**: today's selected snapshot does not yet contain the requested stay-date document, or the selected snapshot is future-dated.
- **Missing**: an older snapshot does not contain the requested stay-date document, no snapshot exists, or its metadata explicitly reports a failed, error, or incomplete import.

The existence of the snapshot document alone is never enough: the required `stayDates/{stayDate}` document must also exist.

## When a date can be assessed

A stay date can only be evaluated when:

1. both the MARSHA and Opera stay-date documents exist;
2. both sources use the same snapshot date; and
3. active, applicable rules can be evaluated from the available room types.

Otherwise the result is **Cannot assess**. If there are no enabled rules, the result is **No rules configured**. If rules are enabled but all their activation conditions are false, the result is **No applicable rules**.

The overview row is green only when both sources are **Available and current** and the balance result has an `ok` status. Every other overview row is red. The detail page shows each mapping's own result independently, so a passing mapping is green even when another mapping makes the overall date fail.

## Room values

`roomsByType` is normalized without converting values to strings or booleans:

- a missing key remains missing;
- `0` remains present and is different from a missing key;
- negative values remain available for display;
- a field named `Total` (case-insensitive) is excluded and is never treated as a physical room type.

For an individual room-type mapping, negative MARSHA and Opera values are compared as `0`. The detail page still displays the original negative values and explains the normalized values used by the calculation.

For example, MARSHA `-1` and Opera `0` are displayed as `-1` and `0`, but are compared as `0` and `0`, so that difference does not make the mapping fail.

## Calculation used by a rule

For a room-type mapping:

```text
MARSHA value = max(0, configured MARSHA room-type value)
Opera value  = sum(max(0, each configured Opera room-type value))
adjusted Opera value = Opera value - reserved rooms
difference = adjusted Opera value - MARSHA value
```

A required configured room-type key that is absent is not treated as zero. It makes the date **Cannot assess**.

The same Opera room type cannot be used in more than one enabled room-mapping rule. Settings validation rejects such overlaps so the same physical inventory cannot be counted fully more than once.

## Rule types

### Room type mapping

Maps one MARSHA room type to one or more Opera room types. For example, `GENR` can be compared with the combined values of `QNK` and `ANK`. Codes are never matched automatically; only configured mappings are used.

### All room totals

Compares the sum of all physical MARSHA room types with the sum of all physical Opera room types. The imported `Total` field is ignored rather than trusted or counted as a room type. A total rule is shown separately from room mappings on the detail page.

## Comparison modes

The calculation uses `difference = adjusted Opera - MARSHA`.

### Exact match

The rule passes when:

```text
absolute difference <= allowed difference
```

With an allowed difference of `0`, the adjusted Opera and MARSHA values must be equal.

### Maximum only

Opera may not exceed MARSHA. The rule passes when:

```text
difference <= allowed difference
```

A large negative difference is valid for this rule. For example, MARSHA `26` and Opera `2` pass a Maximum-only rule with zero tolerance because Opera does not exceed MARSHA.

### Minimum only

MARSHA may not exceed adjusted Opera. The rule passes when:

```text
difference >= -allowed difference
```

### Allowed range

The rule has separate **Allowed below** and **Allowed above** values. It passes when the difference is within those lower and upper bounds.

## Reserved rooms and allowed differences

**Reserved rooms** are deducted from the combined Opera value before comparing it with MARSHA. They are not deducted from the MARSHA value.

The allowed difference acts as tolerance for Exact, Maximum, and Minimum rules. Range rules instead use their separate below and above values.

## Conditional activation by remaining rooms

Each rule can be configured to apply:

- **Always**;
- when there are **More than X rooms remaining**; or
- when there are **Fewer than X rooms remaining**.

The administrator chooses whether the activation total comes from MARSHA or Opera. The remaining-room total is calculated from all physical room-type values, ignores the imported `Total` field, and counts negative values as zero.

The comparisons are strict: `More than X` uses `> X`, while `Fewer than X` uses `< X`. A total exactly equal to X satisfies neither conditional option.

A rule whose condition is not met is neutral. It is displayed as **Not applicable** on the detail page and does not contribute to the date's severity.

## Overall result and severity

Only enabled and applicable rules contribute to the result:

- **Balanced**: every applicable rule passes.
- **Review**: at least one rule fails, but the largest amount outside its permitted boundary is at most 2 rooms.
- **Critical**: at least one rule is more than 2 rooms outside its permitted boundary.
- **No rules configured**: no rule is enabled.
- **No applicable rules**: rules are enabled, but none meet their activation condition.
- **Cannot assess**: required source documents, comparable snapshots, or mapped room-type values are missing, or enabled rules reuse the same Opera room type.

Severity is based on the actual boundary violation, not the raw absolute difference. A passing directional rule can therefore never inflate another rule from Review to Critical.

## Detail page

Clicking an overview row opens its stay-date detail page. It contains:

1. the overall result;
2. total controls in a compact summary;
3. room mappings in the shared list/table layout, including raw values, normalized comparison information, difference, rule, and per-rule result;
4. MARSHA and Opera room types that are not included in an enabled room mapping; and
5. collapsible snapshot information with snapshot dates and available import metadata.
