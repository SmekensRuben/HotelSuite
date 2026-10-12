# Catalog products, purchasing and periodic inventory

## Scope and policies

This release implements product/unit policy v1 and periodic inventory policy v1.
The Rules contract is `saas-platform-v4`. It does not implement recipes, POS
integrations or a continuously calculated on-hand inventory. No physical stock
is increased by ordering goods. The Inventory periods page reports evidence
between two completed physical counts, not guaranteed sales consumption.

Catalog products are stable physical article identities. Each tracked article
has one supported base unit: g, kg, ml, l or each. Two supplier offers may share
an article only when they represent interchangeable goods. Different qualities,
allergens or otherwise distinct goods should remain separate articles. Reviewed
catalog base units cannot silently change; archive and create a new identity if
the physical article or unit contract needs replacement.

Supplier products describe the supplier SKU and purchasing terms. The default
package plus up to twenty separately identified purchase options specify a
purchase unit, its content and purchase price. Units are dimension checked;
kg/g and l/ml convert exactly within six-decimal physical quantity precision.
Mass/volume/count conversions are not guessed. Supplier SKU edits keep the
document ID stable and use a transactional uniqueness reservation. Archival
retains historical references; product hard deletes are not exposed.

## Prices and unknown values

Known prices are finite numeric values. An explicit zero price is valid; missing,
null, empty or numeric-string prices are not converted to zero. Each offer's
price basis is net, gross or unknown. Gross prices need an explicit fractional
VAT rate, e.g. 0.21 for 21%; VAT is removed once for the net goods estimate.
Currency is explicit. No exchange rate or hotel currency is invented.

Order totals are purchase quotes in one recorded currency and price basis. The
interface labels net, gross or unknown basis without guessing historical tax. Receipt
valuation uses the frozen net package price and accepted package quantity,
independently of a rounded per-base-unit display price. Monetary receipt values
use six-decimal precision and bounded arithmetic. A positive value below supported
precision remains unavailable rather than becoming free. Freight, packaging
deposits or other invoice charges are not inferred; these estimates cover the
entered goods price, including only adjustments already reflected in that price.
They are not invoice approval, payment or financial-accounting entries.

Opening-count unit costs are optional operator-entered net estimates in the
snapshotted hotel currency, per catalog base unit. They are labeled estimates.
Omitting a cost still permits physical quantity counting; the related value
remains unavailable. A later period's opening cost uses that opening count's
explicit estimate; earlier derived report values are not silently injected into
historical counts. Historic order and stock snapshots are never rewritten or
retroactively recalculated. Missing historical currency is shown as unknown.

## Hotel workflows

1. Review Catalog Products: choose a supported unit and explicit inventory
   tracking. Link the appropriate Supplier Products to the same hotel catalog.
   Review purchase packages, prices, currency and price basis. Old ambiguous
   `hasVariants` records require reviewed explicit options before ordering.
2. Configure physical locations and their stock templates. New rows are catalog
   identities. Existing supplier/outlet template identities remain visible and
   can be removed deliberately; count creation resolves valid links and combines
   multiple offers/outlets for the same physical catalog article. Unresolvable
   entries fail explicitly rather than disappearing. Empty/archived templates
   are not usable for new counts. Template changes use protected commands.
3. Create a physical count and choose its business date. Quantity inputs are in
   catalog base units (six decimals), so one bottle can be entered as one each
   instead of a rounded fraction of a supplier case. Enter the physical base
   quantity directly; package-entry helpers can be added later. Explicit zero and uncounted are
   different. Every included item must be counted before a location can finish,
   including unfinished historical counts. Completed counts stay immutable.
4. Place orders using a selected supplier package. Cart and order line identities
   include purchase-option identity. Creation groups by supplier/outlet and rejects
   mixed currencies or mixed net/gross/unknown price bases within each order;
   confirmation refuses changed prices, packaging or inventory conversion until
   the draft is edited and reviewed. Source terms are frozen for receiving.
5. Record goods receiving on the order. Accepted goods require a same-hotel
   physical destination. Partial receipts create immutable destination-specific
   receipt evidence; rejected goods do not add physical quantities. Unknown
   catalog conversions/cost contracts create explicit coverage gaps. A supervisor
   reversal offsets the original movement, using its frozen location, quantity
   and value. Historic accepted receipts without verified movement evidence
   cannot be silently reversed into the new inventory model; they need operator
   reconciliation. Rejected-only historical reversals remain possible.
6. Finish a second count and open Purchasing & Inventory → Inventory periods
   (`/catalog/inventory`). Choose a location and two completed catalog counts.
   The page shows opening quantities, recorded net receipts and closing quantities.
   Inferred usage/difference is opening + net receipts − closing. It cannot
   distinguish sales, waste, theft or unregistered transfers.

Example: opening 100 units, net receipts 30 and closing count 80 imply 50 units
of usage/difference. With opening estimate €2/unit and receipts totaling €90,
period-weighted estimated unit cost is `(100 × 2 + 90) / 130`. It is not a
perpetual moving average: automatic outbound consumption is not implemented.
Unknown cost or currency evidence never yields a valid combined monetary total.

## Cutoffs, coverage and concurrency

Private location posting sequences serialize receipt movements and completed
count checkpoints. Period evidence uses the interval between checkpoint sequences.
Source business dates and posting times are separate. Postings while a count is
in progress mark its cutoff as uncertain. Late/backdated entries and reversals
are explicitly exposed. An already saved period is immutable; newly discovered
post-closure evidence invalidates current completeness without rewriting its
saved numbers. Checkpoint/movement sequence reconciliation detects missing or
duplicate evidence. A source-date or posting window exceeding 1,000 records fails
explicitly instead of silently truncating; larger installations need a reviewed
paged reconciliation extension.

Products, imports, carts, templates and count creation preserve exact pending
requests across uncertain responses. Recovery controls replay the original actor,
hotel, resource, input, revision and ID after remount. Completed import batches
retain their generated IDs; a corrected failed suffix cannot duplicate an earlier
committed prefix. Only a server-proven uncommitted request releases a pending
intent. Permission/gate errors and transport errors do not prove non-commit.
Current Auth is rechecked on actual Firestore transaction retries. Optimistic
revisions prevent stale cart/order/template/count forms from overwriting new work.

## Storage and authorization

All data belongs to the selected hotel. Existing procurement entitlements and
action permissions are reused. Receiver/Receiving Supervisor grants remain
explicit. Ordinary stock users can count frozen snapshots without general catalog
configuration access. Protected commands validate current Auth, hotel membership,
permission, subscription and the reviewed release gate. Browser product/template
writes are denied, including for platform administrators. Private evidence is
available only through scoped server projections. Generic file imports cannot
write the product, SKU reservation, command receipt or inventory namespaces.
Existing generic product-feed targets therefore need review; use protected product
CSV import for now. A typed supplier-feed adapter is future work.

Private hotel collections are productOperations, productSkuKeys, productAudit,
stockTemplateOperations, inventoryLocationStates, inventoryCheckpoints,
inventoryMovements, inventoryReversals and inventoryPeriodReports. They are not
descendants of the former recursive location write grant.

I've set up prototype Security Rules to keep the data in Firestore safe. They
are designed to be secure for hotel isolation, protected product commands and
immutable inventory evidence. However, you should review and verify them before
broadly sharing your app. If you'd like, I can help you harden these rules.

The independent scoped assessment is in `catalog-stock-security-review.json`;
it does not certify the entire application or a production deployment.

## Coordinated release

Do not merge or deploy this implementation automatically. Main activates production
delivery. Review the complete PR and schedule a coordinated release window.
The v4 Functions runtime intentionally blocks gated procurement while the global
marker still describes v3, including any index-build window after deployment.
Publishing only the client or Functions does not complete the release.

Use the existing operator rollout from the exact reviewed merged-main SHA. Its
read-only preflight verifies release/CI/App Hosting/Functions, existing identity
consistency and the required indexes. `--apply` creates only missing reviewed
indexes and waits for READY before pausing/releasing Rules, then verifies indexes
again before enabling v4. Unrelated indexes are preserved. The helper inspects
the actual database edition/type and stops if it differs from the reviewed
Standard/Native default-database contract; it never provisions a database.
Failures retain an exact reviewed resume point and never enable an unverified
release. This is a single global Rules/index rollout, not a script per hotel.
No bulk product conversion or historical revaluation runs automatically.

### Recovery from the index-list HTTP 400

The operator helper in release `b7f2ca88fb892b1196e95a0a3291f7440bc867f1`
requested `pageSize=100`. The Standard/Native index service rejected that request
with `INVALID_ARGUMENT: Invalid page size. Only 0 is supported.` The corrected
helper omits `pageSize` and follows any returned page tokens. It bounds the entire
read to 20 pages and 2,000 indexes per collection group rather than assuming each
default-size response contains at most 100 entries. An incomplete or oversized
read fails before any index creation; it is never interpreted as missing indexes.

This failure during the initial index preflight occurs before SaaS pause, Rules
publication, migration or activation. After merging the repair and verifying its
main CI, App Hosting and Functions deployment, use the **new reviewed merged-main
SHA** and download the wrapper again. Retrying the older pinned SHA downloads the
older helper and reproduces the problem. Replace the placeholder below before
running:

```bash
HOTELSUITE_RELEASE_SHA="REPLACE_WITH_REVIEWED_MERGED_MAIN_SHA"

curl --fail --silent --show-error \
  "https://raw.githubusercontent.com/SmekensRuben/HotelSuite/${HOTELSUITE_RELEASE_SHA}/scripts/firebase/rollout-saas-pilot.sh" \
  --output /tmp/hotelsuite-platform-rollout.sh &&
bash /tmp/hotelsuite-platform-rollout.sh \
  --release-sha "$HOTELSUITE_RELEASE_SHA" \
  --apply
```

The wrapper rechecks release evidence and preserves the READY-before-activation
gate. It can wait for index builds and Rules propagation. Do not work around a
failure by manually setting the activation marker. A successful global rollout
allows the platform administrator to preview/load the demo dataset for
`test-hotel-2`; it does not require a separate rollout for each hotel.

Production acceptance remains required: inspect real legacy product links/units,
price contracts, database/index readiness and historical snapshots; execute buyer,
receiver and stock-counter browser workflows; verify two-hotel isolation and
pending-request recovery. Review operator-entered opening estimates before relying
on monetary reports. Recipe production, manual transfers/waste classification and
POS deduction remain future modules on the same catalog identities.
