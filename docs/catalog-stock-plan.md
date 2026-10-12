# Catalog and periodic inventory implementation

Base: current main `1ac7e42036622d86cf4e1ca72c32cde60c6daaf6` (PR #228 included).
Scope authorized: product/unit model, procurement fixes, catalog-based physical
counts, immutable receipt movements and comparisons between finished counts.
Recipes, POS integrations, live on-hand claims, production writes, merge and
deployment are outside this release.

## Working contract

- Product policy version 1. Catalog products keep stable IDs, supported `baseUnit`
  (`g`, `kg`, `ml`, `l`, `each`) and `inventoryTracked` boolean. Conversions are
  dimension checked and use bounded decimal arithmetic. Historical units are
  explicitly mapped when an operator saves a product; snapshots are not rewritten.
- Supplier products retain stable IDs when supplier SKU changes. `catalogProductId`
  refers only to this hotel's catalog. Unlinked legacy offers may remain available
  for procurement but cannot silently become tracked inventory. `purchaseOptions`
  has at most 20 bounded entries `{id, purchaseUnit, baseUnitsPerPurchaseUnit,
  pricePerPurchaseUnit}`. These quantities are expressed in the supplier product's
  `baseUnit`; the linked catalog unit must be dimension compatible. Existing flat
  fields represent the default option; ambiguous legacy variants require review.
- Price fields are actual finite numbers (explicit zero is distinct from unknown).
  `priceBasis` is `net`, `gross` or `unknown`; `vatRate` is explicit when gross.
  No implicit VAT, exchange rate, free price or unit conversion. Net operational
  receipt cost may be derived only when the price contract establishes it.
- All product mutations use hotel-scoped callables with current Auth, membership,
  procurement entitlement and existing action permissions. Imports use the same
  validators, bounded batches and stable exact-input request IDs. New protected
  product paths deny browser writes. Historic documents remain readable.
- Orders snapshot the selected purchase option, linked catalog ID/name/unit,
  converted catalog quantity per purchase unit and price contract. Legacy orders
  remain immutable; uncertain inventory metadata is shown as unavailable. Orders
  group by supplier/outlet and lines must distinguish purchase option IDs.
- New counts (`inventoryPolicyVersion: 1`) measure catalog product quantities per
  physical location, not per supplier/outlet. Old templates are resolved through
  valid supplier links and deduplicated by catalog ID. Any unresolvable item is
  surfaced, never dropped. New templates can use catalog IDs. Counting may use
  base quantities or explicitly validated packaging helpers. A finished count
  requires every included catalog item counted, including explicit zero.
- Cost on an opening count is optional, explicit operator-entered `unitCost`
  (net hotel currency per catalog base unit), labeled as an opening estimate.
  Unknown costs stay null and quantity counting remains possible. Values never
  sum across currencies. Historic totals keep their original snapshot semantics.
- Receipt/reversal movements are immutable and atomic with the receiving event,
  with explicit same-hotel `inventoryLocationId`. Accepted quantities increase
  recorded receipts; rejected quantities do not. Reversal offsets the original
  quantities/cost. Orders alone create no physical movement. Missing links,
  opening costs or price contracts remain explicit coverage gaps.
- Period comparisons use immutable completed catalog counts and receipt/reversal
  movements bounded by location posting sequence. Location state serializes receipt
  and count checkpoints. Source business date and posting time remain separate;
  late/backdated entries are explicitly flagged and must not rewrite closed reports.
  Report inferred usage = opening count + net receipts - closing count. It cannot
  classify sales/waste/theft. Only complete priced evidence yields a period-weighted
  cost estimate; this is not a perpetual moving average or a financial ledger.
- No page describes latest counted quantities plus receipts as live stock. Show
  last count, recorded receipts, coverage, inferred period difference and dates.

## Workstreams and acceptance

All scoped workstreams are code resolved and locally verified: product policy and
protected commands; product/package/order UI; catalog counts and period reports;
count/period UI; orders/receiving integration; and security/recovery wiring.
Independent review is complete; its final price-basis followup has passed
independent regression checks. No workstream is deployed or production verified.

## Finding register

| ID | Confirmed problem and resolution | Dependencies | Acceptance evidence |
| --- | --- | --- | --- |
| C01 | Supplier offers lacked reliable physical catalog identity. Protected commands now validate same-hotel links and archive stable identities. | Product policy, release v4 | Product command and emulator tests: cross-hotel link rejection, archive and SKU races |
| C02 | Supplier packaging was unsuitable for physical counts, including a bottle in a case. Supported dimension-checked units and exact six-decimal conversion separate physical quantity from purchase packaging. | C01 | Product policy, inventory and UI tests: each, kg/g, l/ml and incompatible units |
| C03 | Purchase variants could lose line identity. Explicit options retain independent cart/order/receipt identities and frozen price/conversion contracts. | C01, C02 | Independent order, cart and receiving tests; confirmation rejects changed packaging |
| C04 | Missing prices could appear free; mixed price bases could create misleading totals. Typed inputs and nullable displays distinguish unknown/zero; orders require one price basis and display it explicitly. | C02, C03 | Policy/pricing/order tests cover null, strings, zero, VAT, mixed bases and package-value precision |
| C05 | Currency assumptions could create misleading totals. Counts snapshot bootstrap hotel currency; reports refuse unknown/mixed-currency valuation. | C04 | Stock/inventory tests, actual onboarding-schema emulator fixture, EUR/GBP restore fixtures |
| C06 | Supplier-based and incomplete counts could misstate stock. New counts deduplicate catalog articles per location and require every included row, including zero, before completion. | C01, C02 | Backend/UI and ordinary-user emulator tests; unresolved templates fail explicitly |
| C07 | SKU edits could break references. Document IDs stay stable and transactional uniqueness reservations protect active supplier SKUs. | C01 | Product tests and independent simultaneous SKU-creation emulator case |
| C08 | Receiving lacked physical destination evidence. Accepted goods atomically record immutable movements; reversals offset frozen originals; rejected goods do not add quantities. | C03, C05, C06 | Independent receiving tests, duplicate/reversal/destination emulator cases and receipt/count race |
| C09 | Differences between counts lacked reconciled coverage/cost. Reports now use immutable checkpoints and sequences, explicit gaps/cutoffs/late entries, and optional weighted net cost. | C05, C06, C08, four indexes | Inventory/emulator/restore: 100 + 30 - 80 = 50; cost 290/130; immutable report replay |
| C10 | Direct writes, retries and stale forms could bypass policy or duplicate work. Protected commands, revisions, exact saved intents, private evidence and current Auth checks on transaction retries enforce boundaries. | All command boundaries, release v4 | Ordinary identities, two hotels, five real revoked-Auth transaction retries and frontend recovery tests |

## Verification state

- Code resolved: C01–C10 and all scoped workstreams.
- Locally verified: all checks below passed, including final mixed-price-basis followup.
- Deployed and checked: not performed.
- Live edition inspection had no authenticated Firebase session. The additive
  operator helper verifies actual Standard/Native metadata before index mutation;
  no database is provisioned or changed by this work.

Completed checks on Node 22.23.3/npm 10.9.9 (final followup recorded below):

| Check | Result | Scope |
| --- | --- | --- |
| `npm test -- --run` | 833/833 tests, 208 suites | Frontend; standard fetch/HTTP(S) constrained to loopback, not a general socket/process sandbox |
| `npm --prefix functions test` | 239/239 tests after final review | Backend, including independent product/order/inventory regressions |
| `npm run test:security` | 166/166 tests, 20 suites | Auth/Firestore/Storage emulators, ordinary identities, two hotels and real transaction races |
| `npm run test:restore` | Passed | Two-hotel Firestore/Auth/Storage export/import; immutable report replay and cost evidence |
| `npm run lint`, `npm run typecheck` | Passed | Live-code lint and existing documented incremental type scope |
| `node scripts/render-module-rules.mjs --check` | Passed | Generated module Rules alignment |
| `npm run audit:policy` | Passed | Root, Functions and operator dependency policy |
| `npm run build:test` | Passed | Non-production build |
| App Hosting production build with fictional environment fixture | Passed | Validated build contract, not deployment |
| `git diff --check` | Passed | Patch whitespace |

The original frontend run was interrupted by automatic review over a possible
external Function call. It supplies no completed result. The passing run above
uses the reviewed test-only HTTP guard. Reproducible commands/scenarios are
committed here; exact-head PR CI provides independent evidence. Local outputs are
in the task's `audit-notes/catalog-stock-*` logs. Existing bundle-size warnings
remain; no browser-latency measurement is claimed.

Final review followup also passed: 50 focused frontend tests across four suites;
41 focused emulator tests plus one historical-basis case; 10 independent order
regressions; repeated full backend tests, lint and build. No unresolved scoped
review blockers remain. The frontend/security full-suite counts above describe
the pre-followup runs; exact final-head CI reruns the integrated suites.

## Remaining release controls

- Review the entire draft PR and exact-head CI; no production rollout is authorized.
- After a separately reviewed merge, use the exact merged-main SHA for one global
  v4 Rules/index rollout. The helper checks Standard/Native metadata and waits for
  four reviewed indexes to be READY before enabling the release. No per-hotel
  migration script is required.
- Coordinate the Functions/client/Rules window: v4 Functions fail closed while
  the marker is v3. Verify normal buyer, receiver and counter browser flows,
  historical snapshots, real product links/units, price contracts and recovery.
- Existing generic product-feed imports are deliberately blocked by the protected
  namespace contract. Review affected integrations and use protected product CSV
  import until a typed supplier-feed adapter is separately implemented.
- More than 1,000 relevant period records needs a reviewed paged reconciliation
  extension. Manual transfers/waste, recipes and POS remain future scope.

## Required regression scenarios

Two suppliers/pack sizes for one catalog product; kg/g and l/ml conversions;
incompatible dimensions; one bottle from a case of 24; unknown vs zero prices;
explicit package selection; stable SKU edits and linked-product archival;
incomplete counts and explicit zero; multiple currencies; accepted/rejected/partial
receipts and reversal; duplicate/retry and two-hotel authorization; unchanged
historical snapshots; period 100 opening +30 receipts -80 closing =50 inferred
usage; late entries, missing source coverage and unknown costs. No tests hard-code
production outcomes or alter prior expectations without explaining changed policy.

## Resume checkpoint

Branch `codex/catalog-stock-foundation-20261012`, based on the SHA above. All agents
have handed back implementation ownership; all scoped review fixes are verified.
Publish the integrated tree as coherent commits and inspect the resulting draft
PR's exact-head CI. Once published, the review/release controls above are the
resume point. Do not run production scripts or infer
deployment from local checks. If CI fails, inspect that job and continue on this
branch. See the as-built guide and scoped `catalog-stock-security-review.json`.
