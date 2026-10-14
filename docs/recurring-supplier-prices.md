# Recurring supplier lists and approved price periods

Purchasing & Inventory reuses the supplier import workspace, protected product
commands, purchase-unit mappings and immutable price history. Reviewing a source,
confirming its interpretation, approving products and applying the approved import
are separate actions. No connector, automatic approval or invoice processing is
introduced.

## Daily workflow

1. Choose the supplier and source file. Identify a full assortment or a partial
   update, its purpose, optional source issue date and optional common price
   validity. A full list describes coverage; omission never archives an offer or
   silently makes it unorderable. Statistics cannot establish current unit prices.
2. For CSV/XLSX, confirm the reusable table interpretation: article-number/name
   columns, purchase package, physical content (including split multipacks), one
   unit-price channel, tax basis/currency/VAT and date columns. Review decimal/date
   conventions and known purchase-unit abbreviations. Recurring profiles never
   retain a one-off issue or validity date as a fixed default.
3. The next exact header/sheet match uses the frozen confirmed profile without a
   provider call, even when AI is disabled. First, changed or uncertain formats
   require confirmation. Unstructured documents continue through bounded AI
   extraction and explicit review. Source text remains evidence, not instructions.
4. Review price changes, packaging changes, new articles and exceptions first.
   Old/new values and comparable net prices per kg, litre or each show physical
   differences. A box priced at EUR12 with 6 litres costs EUR2/l; shrinking it to
   3 litres at EUR12 means EUR4/l, a 100% physical-unit price increase.
5. Select explicitly eligible ordinary price changes or unchanged source-backed
   confirmations and approve them together. Packaging/contract ambiguity,
   changed formats, chronology conflicts and inferred values require individual
   review. Approval alone writes no product. Apply the approved rows through the
   existing idempotent final import, then retain the source reference.

Unknown or partial source fields preserve existing stable product identities,
SKU reservations, catalog links, purchase options and local corrections. An
existing approved future period is the comparison baseline when a recurring
source targets that same period; repeating it confirms its price instead of
showing the current-day price difference as another new increase. New articles
remain reviewed drafts until their purchasing and catalog contracts are usable.

## Interpretation and recovery

A confirmed profile belongs to one hotel, supplier, source type and named profile.
It is revisioned and audited. Uploads freeze the accepted mapping snapshot and
source/header fingerprints. Updating a saved profile does not reinterpret an
in-flight or historical job. Explicitly applying a confirmed format rebuilds
uncommitted proposals only and invalidates affected decisions; it does not repeat
an AI call or approve products.

Reprocessing binds each row to its original verified source reference so an AI
reordering cannot move a human correction to another article. Ambiguous source
association or changed row coverage requires a fresh import. Applied/skipped rows
and unrelated deliberate corrections are retained. Reprocessing progresses in
25-row transactions; its original request, accepted profile and source generation
are retained. A remounted workspace resumes that exact operation and blocks other
review writes until it completes. Live permissions and source integrity are
rechecked after external source reads.

Fresh recurring imports require the new server capabilities and explicit
`recurringImportVersion:1`. Pre-upgrade queued jobs and uncertain upload commands
retain their original fingerprints and interpretation. Recovery cannot allocate a
new upload merely because an acknowledgment was lost.

## Price versions and reliability

Approved purchasing terms are immutable entries under the private
`supplierPriceVersions/{supplierProductId}/entries` namespace. A dated version
freezes prices, currency/tax basis, physical package content and option identities.
Future versions are recorded immediately, while today's applicable terms remain
available. Legacy prior terms can be retained as a baseline with unknown approval
and source dates; no historical approval is invented. Live catalog identities,
SKU, labels and barcode metadata are not rolled back when a future price activates.

Separate immutable `supplierPriceConfirmations` record genuine established unit
prices, including unchanged prices. Last economic price change and last matching
price confirmation are distinct. Reconfirming identical terms or renewing
identical-price validity does not invent another price change. Default-package
confirmation does not reconfirm preserved optional packages the source did not
price. A manual correction can invalidate a previous confirmation without
silently erasing its historical evidence. Statistics, cached formula values and
sources without current unit prices never refresh confirmation dates.

A source reference and source-issued business date accompany supported evidence.
Known older sources are rejected against newer recorded agreements. Unknown
chronology is visible and excludes routine bulk replacement of a dated agreement.
The reviewer must resolve unknown validity, source chronology and unconfirmed
purchase options explicitly.

A later effective start supersedes earlier open-ended terms. Expired periods and
explicit gaps do not silently revive an older agreement. For undated approvals,
the approved hotel business date supplies ordering precedence, while contractual
validity stays explicitly unknown. Approval time, source issue date and price
validity are separate facts.

## New orders

Record the supplier's **Price agreement date** as order date or delivery date. New
orders use the hotel-local server business date or the actual delivery day after
supplier delivery-calendar adjustment. Legacy missing agreements remain visible
as unknown; no delivery agreement is inferred.

Catalog/cart values are indicative. The order preview resolves the approved
version for the chosen date, including dated package choices, and shows price,
source and confirmation evidence. Unknown validity remains visible; future-only,
expired or gap prices cannot be used outside their applicability. The reviewed
quote fingerprint prevents a changed applicable price from slipping between
preview and creation. Uncertain creation replays its original request and quote.

Created draft edits re-resolve applicable terms. Confirmation checks the selected
version and contract and requires renewed review when they changed. Confirmed
orders, receiving evidence, counts, inventory costs and saved valuations retain
existing snapshots. No background process rewrites these records when prices
change.

Supplier comparison/history resolves approved prices dynamically. Raw stored
supplier-product fields are convenience projections and can lag activation until
a later product save; screens qualify them as indicative. Purchasing always uses
the authoritative preview and server resolver.

## Limits and verification

- Sources retain existing 10 MiB/1,000-product limits. Deterministic reusable
  interpretation currently supports one identifiable CSV/XLSX table, with the
  existing first-nonempty header convention. Multiple worksheets must be split;
  unexpected tables are never silently ignored. PDF/DOCX/mail/text keep their
  bounded AI proposal and manual-evidence review.
- Each supplier product has an explicit 100-version and 1,000-confirmation
  reconciliation window. Exceeding it stops with an operator-review requirement;
  history is never silently truncated into a valid quote. Larger deployments
  need a reviewed paged reconciliation/retention extension.
- Price/source evidence is hotel-scoped and server-owned. Browser administrators
  and generic imports cannot rewrite versions, confirmations or format receipts.
  Existing action permissions, subscriptions, release gates and revisions apply.
- Focused fixtures and real two-hotel emulators verify structured parsing,
  zero-call reuse, bulk restrictions, temporal pricing, frozen evidence, revoked
  access and exact retry/restore. Live supplier extraction accuracy and real hotel
  browser acceptance remain separate rollout checks. No production mutation,
  deployment or automatic merge is performed by this task.
