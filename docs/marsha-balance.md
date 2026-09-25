# MARSHA Balance

## Purpose

MARSHA Balance is a read-only operational control. It answers one question: **can every room currently offered in a MARSHA sales category be placed in a suitable physical Opera room, after confirmed placement policy, protected inventory, existing room-type deficits, and approved overbooking are applied?**

A deliberate commercial choice is not an error. Closing a premium MARSHA category while Opera still has premium rooms is reported as **Intentional sales choice**. The page never changes availability in MARSHA or Opera.

Access remains hotel-specific through `marshaBalance.read` and `marshaBalance.update`. Settings are stored in:

```text
hotels/{hotelUid}/settings/marshaBalance
```

## Source selection and data quality

The page retains the existing nightly snapshot paths and selects the newest snapshot on or before the current `Europe/Brussels` date. A requested `stayDate` is read from inside that snapshot; snapshot date and stay date are not interchangeable.

An assessment requires both stay-date documents, the same snapshot date for both sources, and current/complete source states. Snapshot existence alone is insufficient. Missing, stale, failed, incomplete, or non-comparable data produces **Cannot assess** and cannot be hidden by a date exception.

`roomsByType` retains missing keys, zero, and negative values as different source states. `Total` is never automatically classified as a physical room.

## Configuration model

### Opera room types

Every detected Opera code must be classified as one of:

- physical room;
- virtual;
- administrative;
- total; or
- not confirmed.

Only confirmed physical types provide placement capacity. Each physical type can have protected rooms:

- **Hard protection:** protected rooms cannot host a lower MARSHA category.
- **Soft protection:** the rooms can be used, but the conclusion becomes **Review**.

Protected rooms remain usable by their own category when that Opera type is first in its preference list.

### MARSHA sales categories

Each MARSHA code needs an explicitly confirmed, directed placement mapping. The administrator answers “May this booking be placed in this Opera type?” and orders the selected physical Opera types by preference. The first type represents the own or lowest suitable type. No relationship is inferred from code names, price, or list position elsewhere.

Mappings are directional. Allowing a suite to host an EXEC booking does not allow EXEC to host a suite booking.

Release policy is configured per category:

- **Strict:** use higher suitable types only after lower suitable inventory is exhausted.
- **Early release allowed:** expose up to the configured number of higher rooms as potentially releasable before lower types are exhausted.

The assessment always reports higher rooms actually used and higher rooms potentially available under the selected release policy.

### Approved overbooking

Overbooking defaults to zero and unconfirmed. It can be confirmed separately at hotel level and per sales category. Category allowance is consumed before the shared hotel allowance. No limit is inferred from current negative availability.

A verified hotel-wide sales limit can also be recorded. Until its meaning and value are confirmed, shared capacity between categories causes **Review**, not a certain green or red conclusion.

### Date exceptions

An exception contains a category, start and end stay date, reason, responsible person, and temporary additional overbooking allowance. It only applies inside its date period. It cannot suppress source-data or import problems.

### Preview

Settings include a preview based on a real loaded stay date. It evaluates unsaved settings so an administrator can inspect category results, uncovered rooms, and higher-room use before saving.

## Placement calculation

The engine builds one shared pool for every configured physical Opera type. It never creates a separate copy of the same suite inventory for every eligible MARSHA category.

### Existing negative Opera values

A negative physical Opera value represents an existing type deficit and is not silently discarded. The engine first finds the confirmed category whose first preferred type is that Opera code. It then consumes that category's confirmed higher suitable room pools to cover the deficit. Those rooms are removed before new MARSHA availability is placed.

If ownership or placement meaning cannot be established from confirmed configuration, the result is **Cannot reliably assess** and explains what is missing.

### New MARSHA availability

For each confirmed category, the engine:

1. reads the raw MARSHA offered value;
2. uses the first preferred Opera type;
3. continues through allowed higher types in preference order;
4. respects hard protection and flags use of soft protection;
5. applies a valid date exception;
6. applies category and then hotel approved overbooking;
7. reports offered, placed, upgraded, overbooked, and uncovered rooms.

A missing required key is never converted to zero. A MARSHA value of zero is a valid closed sales choice. Multiple categories can reference the same higher type, but allocation uses a shared pool. If simultaneous shared sales cannot be proven safe without a verified hotel-wide limit, the result is **Review**.

## Results

There is no generic tolerance and no fixed “more than two rooms is critical” rule.

- **Within rules:** complete assessment, all offered rooms placed without higher types, protected inventory, or unapproved overbooking.
- **Covered via upgrade:** one or more confirmed higher suitable room types are required and policy permits it.
- **Intentional sales choice:** the MARSHA category is closed even though suitable Opera inventory may remain.
- **Review:** shared capacity, soft protection, or missing hotel-wide limit information prevents a certain conclusion.
- **Action required:** MARSHA demonstrably offers rooms that cannot be placed, outside approved overbooking.
- **Cannot assess / Cannot reliably assess:** source data or confirmed placement meaning is insufficient.
- **Not configured:** one or more MARSHA categories or necessary Opera classifications are not confirmed.

Near arrivals receive an urgency marker, but proximity never changes the arithmetic result.

## Detail page

The detail page separates data problems from sales risk and shows, per MARSHA category:

- raw MARSHA rooms offered;
- raw availability in the first preferred Opera type;
- concrete room placements in preference order;
- higher rooms used and potentially available;
- protected rooms used;
- approved overbooking;
- uncovered rooms;
- shared capacity and applicable exception information;
- the category conclusion.

It separately lists existing Opera deficits covered before new sales, raw source maps, and collapsible snapshot metadata.

## Information that still requires source-system confirmation

A fully certain hotel-wide simultaneous-sales assessment requires confirmation of:

1. whether each Opera `roomsByType` value is independent physical availability or already overlaps another type;
2. the exact business meaning of negative Opera values and whether they always represent a room-type deficit requiring upgrade placement;
3. a verified hotel-wide remaining-sales limit for the stay date, rather than a sum inferred from room-type values;
4. whether hotel and category overbooking limits are additive, and their unit and effective dates;
5. whether existing reservations already include room-type upgrades that are also reflected in another room-type value;
6. whether MARSHA category availability values can overlap each other rather than represent simultaneous sellable rooms;
7. the authoritative source and lifecycle for protected inventory and temporary exceptions.

Until these are confirmed in configuration or source metadata, the engine deliberately returns **Review**, **Cannot reliably assess**, or **Not configured** instead of **Within rules**.
