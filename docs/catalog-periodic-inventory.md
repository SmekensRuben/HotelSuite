# Catalog products, purchasing and periodic inventory

## Scope and policies

This release implements product/unit policy v1 and periodic inventory policy v1.
The current Rules contract is `saas-platform-v6` (outlet stock-point configuration is server-owned). It does not implement recipes, POS
integrations or a continuously calculated on-hand inventory. No physical stock
is increased by ordering goods. The Inventory periods page reports evidence
between two completed physical counts, not guaranteed sales consumption.

The counting and supplier-price extensions keep product/checkpoint policy v1.
Manual adjustment policy v1 adds immutable physical transfers, waste, breakage
and supplier returns. Explicit report policy v2 classifies those movements in a
separate saved analysis; existing receipt-only v1 analyses remain unchanged.

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

## Recurring supplier lists

See [Recurring supplier lists and approved price periods](recurring-supplier-prices.md)
for reusable file interpretation, focused change review, effective price selection
and separate price confirmation evidence. New orders use approved purchasing terms
for the supplier's order-date or delivery-date agreement; historical evidence stays
frozen.

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
2. Configure outlets and optional physical locations. Outlets may be central
   stores supplying other outlets. A template is an optional starting checklist;
   counters may start empty and add catalog articles while counting. See
   [Outlet inventory workflows](outlet-inventory-workflows.md). New rows are catalog
   identities. Existing supplier/outlet template identities remain visible and
   can be removed deliberately; count creation resolves valid links and combines
   multiple offers/outlets for the same physical catalog article. Unresolvable
   entries fail explicitly rather than disappearing. Empty/archived templates
   are not usable for new counts. Template changes use protected commands.
3. Start a physical count per outlet or optional location. No name is required;
   Ad Hoc offers an optional reason and Month-End selects a month and year.
   Choose its business date for other count types. Quantity inputs are in
   catalog base units (six decimals), so one bottle can be entered as one each
   instead of a rounded fraction of a supplier case. Enter the physical base
   quantity directly or apply a validated package/loose-content total. The helper
   uses current reviewed package contents with the frozen count unit, loads only
   the selected article's choices and never imports prices into the count. Apply
   changes the quantity explicitly; Save Counts persists it. Search and supported
   barcode scanning identify articles without automatically recording quantities.
   Explicit zero and uncounted are different. Every included item must be counted before a location can finish,
   including unfinished historical counts. Completed counts stay immutable.
4. Place orders using a selected supplier package. Cart and order line identities
   include purchase-option identity and outlet. The shared cart supports independent
   outlet lines and atomic quantity splits; see [Shared purchasing carts](shared-purchasing-carts.md). Creation groups by supplier/outlet and rejects
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
inventoryMovements, inventoryReversals, inventoryPeriodReports,
procurementResourceOperations and procurementResourceAudit. They are not
descendants of the former recursive location write grant.

## Supplier price insights and manual physical movements

Catalog Product details show bounded supplier-package comparisons; Supplier
Product details show immutable observed price-content revisions. These need
Catalog Products, Supplier Products and Suppliers read access. Comparisons
normalize VAT and physical units once, rank within the same explicit currency
and keep unknown contracts unavailable. Complete pagination is required before
calling a loaded price the lowest entered goods price. Goods prices exclude
unentered delivery costs, deposits, rebates and minimum-order constraints.

Optional `priceValidFrom` and `priceValidUntil` are manually entered date-only
contract bounds, validated in order and preserved with pricing snapshots. Current
comparison eligibility uses the hotel's valid time zone and date; expired or
future known bounds do not rank as current prices. Missing bounds remain unknown.
Observation time does not prove effective contractual validity. Existing order
and receiving snapshots are not revalued or rewritten by these insights.

The private history is `supplierPriceHistory/{supplierProductId}/entries`.
Protected product commands append only when purchasing terms, content, catalog
link or validity bounds change. Exact command replay and metadata-only edits do
not append duplicate price events. Earlier legacy terms are observed by the
first changed transaction with their prior effective date explicitly unknown.

Purchasing & Inventory → Inventory movements (`/catalog/inventory-movements`)
uses `inventorymovements.read/create/reverse`. Stock Controller may record new
events after its access is reviewed and saved; Inventory Supervisor supplies the
separate explicit reversal grant. Existing users are not migrated automatically.
The `inventorymovements.*` wildcard does not grant reversal.

Record a positive catalog quantity, explicit hotel business date, reference and
reason. Internal transfers atomically post a negative source leg and positive
destination leg. Waste, breakage and physical returns are separate categories.
These records do not calculate live on-hand stock or prove transfer availability.
Optional manually entered net costs retain their explicit hotel currency; unknown
values stay unavailable. A physical supplier return records goods leaving a
location; it does not reverse receipt evidence or create an invoice credit.

Immutable command/evidence collections are `inventoryAdjustments`,
`inventoryAdjustmentOperations` and `inventoryAdjustmentReversals`. Supervisor
corrections post exact compensating legs from the original snapshots, including
archived destinations. Actor-bound saved requests and acknowledged actor/request
IDs protect retries, account changes and uncertain responses. Normal submission
shows progress; ambiguous results preserve the original request for recovery.

Explicit period v2 uses a different saved-report ID and quantity equation:
opening + net receipts + transfers in - transfers out - waste - breakage -
physical returns - closing. Monetary residual needs complete explicit opening,
movement and closing source values in one currency; it never invents a weighted
cost. Both transfer legs and reversals require complete frozen source evidence.
All existing posting sequences, cutoff, late-source and missing-evidence checks
remain active. Saved v1 results remain unchanged, while a new v1 calculation
containing manual evidence fails explicitly and requires selecting v2.

All new private namespaces are client-denied and blocked from generic imports.
The pre-existing v5 default-deny boundary already protects them. This compatible
extension does not require a fresh SaaS version activation solely because another
PR was merged. See `procurement-extensions-plan.md` for acceptance and remaining
production checks.

## Resource archival, display names and loading

Locations and outlets use protected archive commands (resource policy v1),
authorized with the existing delete permission. Archival retains IDs, stock
templates, approvers, account assignments and historic orders/counts/evidence.
Archived resources leave new-source selectors and cannot be used for new counts,
receipt destinations, order contracts, cart assignment or template/approver/account
mutations. Existing frozen counts can finish; historical reversals keep their
original destination. No hard-delete or reactivation workflow is exposed.
Browser writes and generic imports cannot bypass the lifecycle boundary.

Template display names are a bounded same-hotel projection, independent from
optional catalog search. A label does not prove counting eligibility: missing
links, incompatible units, inactive/untracked products and archived resources stay
explicitly unavailable. Audit display names use a name-only hotel projection.
A completed private same-hotel demo receipt can prove its nonmember operator;
unprovable or missing names remain unknown instead of exposing a UID as a name.

Supplier package-content units and catalog stock-count units are displayed
separately. Compatible conversions such as 6,000 ml to 6 l are exact; no catalog
identity or historical quantity is changed by presentation. Optional source lists
load when requested, search pages obey the 100-row backend bound, and additional
pages are explicit. Unfiltered supplier pages use authorized Firestore reads;
search hydration and staff-name lookups are batched.

Concurrent read pooling is partitioned by authenticated session and hotel and is
invalidated on mutations and access changes. Operational records are not retained
as a settled cache. The touched direct procurement reads reject known offline SDK
cache fallback rather than presenting stale data as current. This is not a claim
that all legacy application reads have been migrated or that production latency
has been measured. See `procurement-usability-plan.md` for verification and rollout.

I've set up prototype Security Rules to keep the data in Firestore safe. They
are designed to be secure for hotel isolation, protected product commands and
immutable inventory evidence. However, you should review and verify them before
broadly sharing your app. If you'd like, I can help you harden these rules.

The independent scoped assessment is in `catalog-stock-security-review.json`;
it does not certify the entire application or a production deployment.

## Coordinated release

Do not merge or deploy this implementation automatically. Main activates production
delivery. Review the complete PR and schedule a coordinated release window.
The current Functions runtime intentionally blocks gated procurement while the global
marker still describes an older policy, including any index-build window after deployment.
Publishing only the client or Functions does not complete the release.

Use the existing operator rollout from the exact reviewed merged-main SHA. Its
read-only preflight verifies release/CI/App Hosting/Functions, existing identity
consistency and the required indexes. `--apply` creates only missing reviewed
indexes and waits for READY before pausing/releasing Rules, then verifies indexes
again before enabling the current policy. Unrelated indexes are preserved. The helper inspects
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
read to 20 pages and 2,000 indexes in the database inventory rather than assuming each
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

### Recovery from an unexpected index resource

Release `77971104ff6e7d387890ed5fe0afa0aefaea3831` accepted all four
inventory-index creation requests but stopped on `An index response belongs to
an unexpected resource.` before SaaS pause or Rules publication. A subsequent
operator `gcloud firestore indexes composite list` showed all four indexes READY
under the expected project/database, with valid canonical names.

The previous helper assumed every entry in a list belonged to the group in its
request parent. The recovery uses the official Firebase CLI's database-wide
`collectionGroups/-/indexes` metadata list and derives each entry's group from its
canonical resource name. It still rejects another project/database, malformed
resources, duplicate matching definitions, unsupported serving states and
incomplete/oversized inventories. Other groups' indexes cannot satisfy the four
reviewed definitions and are never created, changed or deleted by this helper.
This lists index metadata only, not hotel documents or customer data.

The corrected helper reuses existing indexes only when scope, serving fields,
API scope and READY status match the reviewed manifest. Names and READY status
alone do not prove the correct serving definition; the rollout reads and checks
the actual definitions. After merging this recovery and verifying the new main
release, rerun the pinned wrapper using the new reviewed merged-main SHA as above.
Do not delete the already-created indexes or reuse the older pinned helper.
Production acceptance of the corrected wrapper is still required.

Production acceptance remains required: inspect real legacy product links/units,
price contracts, database/index readiness and historical snapshots; execute buyer,
receiver and stock-counter browser workflows; verify two-hotel isolation and
pending-request recovery. Review operator-entered opening estimates before relying
on monetary reports. Manual transfers, central-store requisitions, waste and
breakage are recorded physical evidence. Recipe production and POS deduction
remain future modules on the same catalog identities.

## Weighted recorded-source cost suggestions (proposal policy v1)

Unfinished catalog counts and physical movement drafts can request a cost proposal for one article/location/business date. Existing stockcounts.read monetary authority is required, together with stockcounts.update or inventorymovements.create for that draft. The protected readonly provider uses the latest eligible fully finished checkpoint and reconciled frozen receipts/manual movements through its fixed cutoff. It does not scan current supplier offers or guess a missing opening cost.

The quantity-weighted recorded net-source pool includes opening quantity/value and signed receipt, transfer, waste, physical-return and reversal quantities/values. It is not a live moving average or an inferred sales ledger. Source date, unit, currency, paired evidence, completeness and bounded windows must reconcile; otherwise the suggestion stays unavailable. Zero value over positive quantity is valid. Complete unknown costs stay unknown, rather than becoming zero.

Request suggestions lazily with **Suggest unit cost** and inspect the displayed source date, quantities, net values and proposal policy version. **Apply estimate to this draft** explicitly replaces the draft cost with a reviewed numeric estimate; saved/manual values are never silently overwritten. Context changes invalidate old proposals; an applied estimate whose source/date/unit/currency/revision changed needs a fresh review, clearing or an explicit manual replacement before saving. Existing saved counts, movements and period reports remain unchanged.

## Coherent template loading

[Purchase Requests](purchase-requests.md) add a separate internal net-budget and
sequential approval process for goods, services and repairs. Reservations become
approved commitments without a second budget deduction. This process does not
dispatch supplier orders or change physical inventory.

Catalog sync and configurable internal SKU numbering are described in
[Catalog product sync](catalog-product-sync.md). The workflow keeps stable
physical identities and historical operational snapshots intact.

Stock Template Detail reads its template revision, location and ordered included-article names through one bounded locations.read projection. Additional catalog choices load only when opened, in debounced 25-item pages with cursor checks and a 500-item browsing cap. Search narrows larger directories. No settled operational cache or eager complete catalog export is used.

Reduced-motion-aware skeletons cover initial loading. Same-authority refresh keeps verified names visible and locks edits; unsuccessful verification clears stale names and exposes Retry. Hotel, actual Auth identity, subscription or permission changes clear previous data immediately. Location template lists and outlet/location settings lists reuse the loading presentation. Actual deployed cold-start/network latency still requires production measurement.
