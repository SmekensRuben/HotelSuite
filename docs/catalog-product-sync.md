# Catalog product sync and internal SKUs

Catalog sync connects supplier purchase offers to stable hotel-owned physical
articles. It reuses protected product commands, purchase options, unit policy and
procurement permissions. A proposal changes no product; existing links are kept.

## Daily workflow

1. Open **Catalog sync** from Catalog Products, Supplier Products or the purchasing
   navigation. Supplier Products carries its supplier filter through. After a
   supplier import, **Continue to catalog sync** opens that supplier's offers.
2. Compare an unlinked offer with suggested existing articles, or search the
   selected hotel's catalog. Review reasons, physical differences and exact
   package-to-catalog conversions. A purchase box is not the physical article.
3. Choose an existing article or review a new definition. Proposals retain the
   source name and suggest a compatible unit; brand, allergens, GTIN and taxonomy
   are not invented. Equivalent offers can share one new article. Editing its
   shared definition invalidates affected reviewed choices. A separate-article
   option keeps deliberately distinct offers apart.
4. Confirm interchangeability for each offer, then **Add reviewed choice**.
   Confirm the selected batch to apply up to 25 links atomically. Skipping keeps
   an offer unchanged. Unreviewed physical contracts require editing the supplier
   offer and starting a fresh review.
5. Results link to catalog articles and show newly allocated internal SKUs.
   Future imports retain stable links. Historical orders, receipts, counts,
   movements and valuations retain their snapshots.

## Exchangeability and units

Mass, volume and item counts never convert into one another. Compatible g/kg and
ml/l conversions use the existing exact six-decimal quantity policy. Default and
additional purchase options must convert. Approved package periods are checked
so that later activation cannot invalidate a new catalog link.

Different outer case quantities can represent the same article. For `each`,
different individual bottle or item sizes remain separate. Matching GTINs or
case labels do not prove that one counted item is the same. No density or item
weight is guessed.

Known differences in product kind, preparation, grade, composition, allergens,
dietary requirements, milk source, fat, flavour, carbonation and individual size
block a link. Unknown facts remain human-review warnings. Lexical similarity
is not proof; different wording or language alone is not proof of a conflict.

An explicitly branded catalog definition retains its brand requirement. Generic
unbranded articles can accommodate different brands through explicit human
review; other known conflicts still block them. The server checks other offers
already assigned to the article and all offers in the batch. A generic title
cannot hide whole/skimmed milk or different item sizes within one identity.

## Optional AI comparison

**Ask AI to compare** uses the existing configured supplier AI service. It can
interpret different names and propose an article from the frozen, hotel-scoped
catalog pool. Product text is untrusted input. Server checks reject foreign
candidate IDs, stale revisions, incompatible quantities and known conflicts.
AI reasoning stays advisory; it never selects or approves a link automatically.

The existing model configuration, input preflight, monthly budget, daily rate
and concurrency limits are shared with supplier imports. Exact recovery never
repeats a paid call. Unknown outcomes retain their reservation and pause new
requests for that operation; verified late responses can settle the original
evidence. Authorization is rechecked after external IO. Supplier prices,
credentials and private billing details are not matching inputs or browser
projections. Standard matching and manual review work with AI disabled.

## Internal SKU settings

Open **Module settings → Internal SKUs** with Catalog Settings read permission.
Changing the policy needs Catalog Settings update permission. Each hotel can
set automatic numbering, an uppercase prefix of up to 20 letters/digits/hyphens
or underscores, minimum digits from 1 to 12, and the next positive sequence
number. New products default to automatic numbering with `CAT-`, six digits
and a starting number of 1. The sequence moves forward across prefix changes.

For a new Catalog Product without an entered SKU, allocation commits in the
same transaction as creation. Manual creation, protected CSV imports and sync
use one allocator. Entered SKUs stay explicit. Updates do not automatically
renumber existing products. Supplier article numbers remain separate.

**Review products without SKUs** loads one catalog page when requested. Select
missing-SKU products explicitly and assign up to 25 together. Only SKU, canonical
reservation, revision and audit fields change. Legacy units and other fields
remain intact. Product read/update rights are required; archived or already
numbered products cannot receive a new automatic number.

Uniqueness uses Unicode normalization and case-insensitive reservations. Archive
and rename operations retain old reservations. Counter increments, product
writes and reservations commit together; retries return the original receipt
and aborted operations consume no numbers. Concurrent allocation serializes on
the hotel counter. Settings revisions stop stale forms from resetting it.

First use builds a private legacy index from SKU-only projections. It leaves
existing catalog records intact and avoids a complete scan on each subsequent
allocation. Later allocations use bounded indexed reads, reservations and one
legacy shard. Missing or corrupt evidence requires reconciliation. A partial
reservation restore cannot silently duplicate a SKU on a current product.

## Authorization, recovery and storage

Sync requires Catalog Products, Supplier Products and Suppliers read rights;
application additionally requires Supplier Products update. New articles require
Catalog Products create. Current Auth, hotel membership, subscriptions, the
release gate and original action permissions apply to receipt replays too.
Hotel and platform administration do not bypass these checks.

Private reviews are owner-bound and expire after 24 hours. Source and target
revisions are frozen. Uncertain application retains its actor, hotel, job,
choices and request ID across remount. A verified original receipt can be
recovered after expiry. Expired AI reviews permit accounting recovery without
exposing expired suggestions. Stale or expired uncommitted proposals cannot
create links; manual review can continue using a fresh source review.

Private hotel namespaces are `catalogSyncJobs`, `catalogSyncOperations`,
`catalogSyncAudit`, `catalogSkuConfiguration`, `catalogSkuKeys`,
`catalogSkuLegacyIndex`, `catalogSkuOperations` and `catalogSkuAudit`. Browser
reads/writes are denied, including for administrators; generic imports cannot
target them. Matching pools and AI attempts are private review descendants.
Linking preserves supplier prices, packages, immutable approved versions and
confirmation metadata.

## Limits and release

- One review applies at most 25 offers from a scan of at most 250 source records.
  Source scanning is bounded and paginated;
  one page never establishes complete hotel coverage.
- Suggestions use at most 500 scoped catalog records. An incomplete pool is
  labelled; manual search can select other articles. Absence from suggestions
  never establishes that an article is new.
- Adding a link reconciles at most 25 existing offers for one article. Larger
  groups stop for a reviewed paged identity extension.
- Approved physical-package reconciliation supports 100 versions per offer and
  250 versions per application. Reduce a batch when it exceeds that window;
  evidence is never silently truncated into a valid conversion.
- First-use SKU indexing supports 20,000 records, 64 size-checked shards and at
  most 100 candidate-number collisions per allocation. Larger or inconsistent
  directories require a reviewed migration.
- Review expiry blocks new use; it does not physically purge audit receipts or
  expired private reviews. Retention remains a separate operator policy.

Release UI, Functions and Rules together. New callables are
`readHotelCatalogSyncWorkspace`, `applyHotelCatalogSync`,
`refineHotelCatalogSyncSuggestions`, `getHotelCatalogSkuSettings`,
`saveHotelCatalogSkuSettings` and `assignHotelCatalogSkus`. Product, sync and SKU
callables explicitly bound memory, concurrency and instances for index bootstrap.
No database provisioning, production mutation, deployment or automatic merge
runs here. Live naming quality, hotel browser acceptance and deployed latency
remain rollout checks.
