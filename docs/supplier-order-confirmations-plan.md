# Supplier order confirmations — execution plan

Base: `ae431fed629fb8efcc4c729d332f2f576f0a4955` (current main, PR #235 merged).
Branch: `codex/supplier-order-confirmations-20261013`.

## Scope and commercial policy

Keep the working Email/SFTP dispatch boundary. Successful transport is not supplier acceptance. Add a separately authorized, immutable record of supplier responses, hotel review and deviations. A hotel user registers the response from the supplier's email, portal, telephone or SFTP message; this does not claim that the supplier authenticated to HotelSuite.

Responses accept the submitted terms, propose complete per-line changes, or reject the order. Every response replaces the previous proposal as a whole; it is not an incremental goods receipt. Show unknown prices and dates explicitly. Preserve the submitted products, original price contract, quoted total and delivery date. Quantity/date changes do not silently close an outstanding receipt. Closing a short delivery still uses the existing supervisor workflow.

Proposed changes require a separate hotel review. Explicitly accepted package-price changes may price *subsequent* receipts in the original currency, price basis, VAT contract and package conversion. Freeze the response/review references on the receipt; validate them when suggesting weighted inventory costs. Earlier receipt/checkpoint/report snapshots are never rewritten. A proposed replacement never inherits the original product's identity or conversion: it needs supplier follow-up and a separately verified purchase snapshot. A rejected or unresolved response cannot silently authorize accepted goods.

Introduce explicit `orders.recordconfirmation` and `orders.reviewconfirmation` permissions with dedicated optional roles; existing wildcard/manager/administrator roles do not automatically receive these powers. All operational boundaries require current verified Auth, same-hotel membership and the licensed procurement module.

## Stages and acceptance

| Stage | Dependencies | Code | Local verification | Deployed verification | Acceptance / evidence |
|---|---|---|---|---|---|
| Baseline and policy | None | Complete | Complete | Not run | Main/PR status checked; dispatch and receiving inspected; original immutable contracts identified. |
| Response and review domain | Baseline | Complete | Passed | Not run | `supplierConfirmationPolicy.js`, `supplierConfirmations.js`: bounded canonical snapshots, duplicate/replay protection, revisions, immutable history, unknown/zero handling and explicit permissions. |
| Receipt pricing integration | Domain | Complete | Passed | Not run | `orderReceiving.js`, `inventoryCostProposals.js`: only reviewed terms affect new receipts; rejected/unresolved/replacement responses cannot create misleading stock values; historical evidence survives. |
| Order UI and attention queue | Domain | Complete | Passed | Not run | Order detail/list, protected service and panel tests: separate transport/acceptance/receiving, complete response/review, scoped loading, exact retry and pagination. Browser QA at 1440×1000 / 390×844. |
| Supplier connector foundation | Domain | Complete | Passed | Not run | `supplierConnectorContract.js`: versioned pure stable line/customer contract; strict tenant/supplier/customer/source fixture tests. No live connection or secrets. |
| Verification and publication | All above | Complete; PR prepared | Passed locally; published-head CI recorded in PR | Not run | Frontend/backend/security checks, lint/types/build, critical review and coherent commits. No merge/deploy. |

## Required regression cases

- Transport `sent` never invents supplier acceptance; historical records stay unconfirmed.
- Whole acceptance, rejection, shortages, zero/unknown prices, future delivery dates, multiple purchase options of one SKU, replacement proposals and full-response completeness.
- Price basis/currency/VAT cannot be spoofed. Known gross price uses the existing net conversion exactly once. Unknown remains unknown.
- Tenant/action/subscription/disabled-user and wildcard escalation denials, including no direct client history writes.
- Same request retry returns the original result; changed replay and duplicate supplier response fail; stale reviews and out-of-order response dates cannot overwrite current decisions.
- New confirmations never restart dispatch, rewrite products or prior receipts, or remove the supervisor's shortfall acknowledgement.
- Exact saved browser command survives uncertain responses; corruption and authority changes block mutations; missing/late/cross-order data never appear as valid.
- Bounded history pagination and one initial coherent response request; no optional supplier directory required.

## External dependencies and later phases

The first live supplier connection requires the owner's choice of supplier and hotel/customer account plus the supplier's documented protocols, credentials, catalog/package identifiers, cutoffs, minimums, confirmation semantics and sandbox access. Implement and test the supplier-neutral contract and pilot acceptance checklist now. Do not manufacture a supplier API, contact suppliers, configure production credentials or claim a live pilot is completed.

Order–receipt–invoice matching is the later phase of the agreed sequence. There is no authoritative invoice ingestion or tax/rounding/credit-note contract in this task; do not build a fictitious financial reconciliation from quoted prices. Record the pilot requirements and next-stage boundary in the accompanying design document.

## Verification and critical review

- Full frontend suite: 1,168 tests / 132 files passed; the post-review service/panel/order/receiving regressions passed (50 focused tests, including one additional verified-write/failed-refresh case). Only final read-only permission copy followed those checks.
- Backend suite: 358 tests passed; the final 19 policy/connector tests additionally verify stable hashes across map-key reorderings. Independent arithmetic/contract examples include gross 21.20/1.06 = 20 net and two six-litre cases = 12 litres / 40 net. Unknown, zero, currency mismatch and stale source evidence are distinct.
- Full Auth/Firestore/Storage security suite: 202 tests passed with no skipped checks. Re-verification of the updated receiving/cost and supplier boundaries: 37 tests passed; final supplier-only verification passed 13 tests including concurrent writers and explicit receiving beyond the supplier promise. Published-head CI repeats the complete suite.
- Actual ordinary-hotel identities proved direct private-history read/create/update/delete denial, cross-hotel/platform/wildcard/subscription/disabled-user denial, exact replay, reviewed gross pricing, unchanged prior receipt snapshots, tampered-price cost rejection, exact reversal and explicit shortfall closure.
- The two-hotel Auth/Firestore/Storage export/import smoke test now creates genuine supplier responses, hotel reviews and reviewed-price receipts in both EUR and GBP. Restored document data and frozen timestamps match exported proof; retrying the exact response/review/receipt preserves all update times and creates no extra events or movements. Canonical hashes do not treat map-key serialization order as a price/source change.
- Lint, incremental boundary types, module Rules generation check, non-production Vite build and explicit demo-project App Hosting build passed. The generated licensing list adds only the new action keys; Rules v5 activation is unchanged.
- Actual JSX/CSS browser checks at desktop/mobile passed complete proposals, saving without a recovery-warning flash, explicit review, eight promised units used by receiving, safe retained-data refresh/error clearing/retry, long product labels, reduced motion and the attention filter. No body overflow, page JavaScript errors or nonlocal requests. This does not measure production cold starts.
- Critical review corrected: proof reads batched instead of serial per-receipt requests; unknown/mismatched currency never valued as known; mutable source/review inconsistencies rejected; exact actor-bound persistence; known successful writes distinguished from failed subsequent refresh; stale drafts/review reasons reset; native checkbox/select labels made unambiguous. See `supplier-confirmations-security-review.json` for the scoped Rules audit.

## Resume point / external work

Code and local verification are complete on this branch. The pull request records the exact published commit and CI run. Do not merge or deploy automatically. After owner merge and successful delivery, perform the ordinary-user deployed checks in `supplier-order-confirmations.md` and assign the optional roles through Hotel Team. No new hotel Cloud Shell script is introduced.

The first real supplier pilot remains blocked on a chosen supplier, customer/account mapping, official interface and sandbox/credentials. Invoice matching remains the later phase described in the companion design. No supplier has been contacted, historical snapshot recalculated or production record changed.
