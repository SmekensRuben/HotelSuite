# MARSHA Balance

MARSHA Balance is a hotel-scoped, read-only Front Office control. It preserves the existing explicit-total comparison, premium shortage checks, snapshot-quality checks, preview, and detail findings. It never writes availability to MARSHA or Opera.

Settings are stored at `hotels/{hotelUid}/settings/marshaBalance` and now contain only:

- `availabilityRules`: configurable MARSHA room-type minimum and Opera counting rules;
- `premiumCategories`: the existing premium shortage mappings.

Legacy `minimumGenr` and `weekendDbdbProtection` settings are migrated on read. A legacy enabled weekend rule becomes a GENR rule where DBDB counts by default but is excluded on Friday and Saturday. Saving replaces the document with the new model, so legacy settings have no hidden effect.

## Data quality and totals

The content controls run only when both stay-date documents exist, use the same current snapshot date, and are complete. Otherwise the result is **Cannot assess**.

Both sources use their explicitly mapped total. The total is never reconstructed by adding room types. `Total` is not a room type. Missing, non-numeric, or negative totals produce **Cannot assess**. Missing and negative relevant room-type values produce **Cannot reliably assess**.

## Availability rule per MARSHA room type

A rule contains:

- `marshaCode`;
- `normalMinimum`, a non-negative integer;
- optional `visibilityMinimum`, a positive integer;
- `distributionStopsAtZeroConfirmed`;
- one or more Opera counting rules.

Normally:

```text
effectiveMinimum = min(normalMinimum, MARSHA total)
```

When the hotel total is positive and below `visibilityMinimum`, the effective minimum becomes the visibility minimum. Availability above the hotel total is only presented without a review when at least one included Opera type has positive availability and the distribution stop-at-zero behavior is confirmed.

At hotel total 0, the visibility minimum never applies. Any positive availability in the configured MARSHA type produces **Action required**.

## Opera counting rules and precedence

For every Opera type linked to a MARSHA availability rule, settings define:

- whether it counts by default;
- optional per-weekday overrides based on the local calendar weekday of `stayDate`;
- inclusive temporary date overrides;
- whether the Opera code is confirmed as independent, non-overlapping physical inventory.

Precedence is:

1. matching temporary date override;
2. weekday override;
3. default choice.

Overlapping inclusive date periods for the same MARSHA/Opera rule are rejected by settings validation.

The detail page and preview show whether each Opera type counted or was excluded, whether the decision came from a date, weekday, or default rule, and the matching date period or weekday.

## Excluded and protected inventory

Excluded Opera inventory is subtracted from the explicit Opera total only when its value is a reliable non-negative number and the administrator confirmed that it is independent physical inventory. The result is:

```text
suitableInventory = explicit Opera total - confirmed excluded Opera inventory
```

If excluded inventory is missing, negative, overlapping, or not confirmed as independent, the page returns **Cannot reliably assess** instead of claiming a safe boundary.

The suitable-inventory boundary is checked before any low-total visibility exception. If DBDB is excluded for GENR and GENR exceeds the demonstrably suitable remainder, the result is **Action required**, even when a visibility minimum would otherwise permit availability above the hotel total.

This replaces the former hardcoded Friday/Saturday implementation. The migrated default still excludes DBDB for GENR on Friday and Saturday, but administrators can now configure default, weekday, and temporary date behavior.

## Premium shortages

Premium checks remain unchanged: MARSHA premium availability is compared with its corresponding Opera type. Explicitly allowed higher Opera types may cover the numerical shortage. Full higher-type coverage produces an upgrade warning; partial coverage produces **Action required** with the exact uncovered count. Missing or negative relevant values produce **Cannot reliably assess**.

## Multiple findings and details

The overview shows the most severe status. The detail page keeps total mismatches, availability minimums, suitable-inventory boundaries, premium shortages, and source-data problems as separate findings.

For each MARSHA availability rule, details show:

- explicit hotel totals;
- MARSHA availability;
- normal and effective minimum;
- excluded Opera types and values;
- calculated suitable inventory;
- the exact default, weekday, or date rule applied to every Opera type.

The Settings preview evaluates unsaved rules against a real stay date and immediately shows the same applied-rule sources and calculated boundaries.
