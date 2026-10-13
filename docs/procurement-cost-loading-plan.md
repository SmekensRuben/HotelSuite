# Weighted cost proposals and procurement loading

This follow-up extends the still-open PR #235 on main base `f36b6ea006cef5298320b496e02b735c772cef6b`. Existing cart/settings fixes remain included; no merge or production deployment is authorized.

## Accepted proposal policy

Proposal policy v1 is a **weighted recorded-source estimate**, not live on-hand valuation or accounting cost. For one hotel, physical location, catalog article, unit, currency and business-date cutoff:

`estimated unit cost = (opening recorded value + signed frozen source values) / (opening quantity + signed source quantities)`.

Start from the latest eligible finished catalog checkpoint with explicit quantity and known cost (zero quantity needs no cost). Do not substitute an older favorable checkpoint when the eligible one is incomplete. Include reconciled actual receipts and signed manual movements/reversals through the fixed posting/date cutoff; keep VAT treatment and conversions from frozen net source contracts. Do not use current supplier offers, future arrivals or forecasts. Unknown/missing evidence, out-of-order dates, posting gaps, unsupported scan windows, changed units/currencies, nonpositive quantity or negative source value make the proposal explicitly unavailable. Zero net value with positive quantity yields a valid zero estimate.

The callable is read-only. Its separate policy version, source checkpoint, date/cutoff and component quantities/values appear before explicit Apply. Apply creates an operator-reviewed numeric estimate in the existing count/movement draft; existing save commands freeze it without adding a claim of automatic or guaranteed valuation. Never silently overwrite a typed cost or revalue historical counts, movements or reports. A first reliable opening checkpoint still needs an explicit operator estimate.

Monetary proposals require the existing stockcounts.read boundary plus stockcounts.update for a current unfinished count, or inventorymovements.create for a movement draft. Authentication, selected hotel, subscription and v5 rollout checks remain server-side. No wider supplier directory access is granted.

## Work and acceptance

| Work | Acceptance | Code | Local | Deployed |
| --- | --- | --- | --- | --- |
| Bounded protected cost proposal | Independent 10×2 + 20×3 example gives 80/30; count and movement scope; full cutoff/source reconciliation; explicit unknown/bounds; no writes | Complete | Passed | Not run |
| Explicit proposal UI | Per-article lazy request, source explanation, Apply, override, no stale hotel/Auth/date/unit result or silent overwrite | Complete | Passed | Not run |
| Included template names | One coherent protected template/location/name projection; no N+1 reads or eager full catalog export; stable identities and revisions | Complete | Passed | Not run |
| Search and loading feedback | Optional lazy bounded search, paginated/debounced combobox, reduced-motion skeletons, same-scope refresh indicators, explicit stale/error recovery | Complete | Passed | Not run |
| Independent review and release | Targeted + full regressions, normal-user emulator checks, builds and exact-head CI; PR remains unmerged | Complete | Passed | Not run |

Use existing checkpoint/movement indexes and the existing v5 default-deny boundary. Keep private source evidence server-only. Actual production latency and deployment remain separate checks.

## Verification and interpretation

- Node 22: 1,142 frontend tests (129 files) passed; final template/service checks after moving pagination above the open dropdown passed 57 tests. Full backend checks passed 340 tests, including 24 independently reproduced new proposal tests.
- Auth/Firestore/Storage emulator security: 191 tests passed, zero skipped. New actual ordinary-user cases used a fully finished count and a genuinely accepted frozen order receipt, verified 80/30, readonly document/updateTime preservation, monetary/action/tenant/subscription/Auth boundaries, and forged checkpoint-value rejection.
- Full lint and incremental types passed. Non-production Vite and App Hosting builds passed. Exact-head PR CI additionally repeats full frontend/backend/security, migration, export/restore and dependency checks; its result is recorded in the PR description.
- Desktop/mobile actual JSX/CSS browser QA at 1920 and 390 pixels used synthetic services and attempted no nonlocal HTTP. One bundled initial template request replaces separate location/template/name requests and eager catalog export. Optional choices start on focus, page at 25 items, and the Browse more action works while the dropdown remains open. Skeleton animations stop under reduced motion; same-authority refresh holds verified names while edits are locked, and failed verification clears them. Unknown/zero costs, explicit Apply, typed-value preservation, date/article/source/Auth changes and stale applied-cost save guards passed. No visual findings remain.
- Independent review repaired checkpoint/count quantity-cost-unit mismatches, malformed dated source sequences, malformed receipt evidence and multiple supplier SKUs counted as multiple postings. No unresolved P1/P2 findings remain.

The signed net-source pool is deliberately distinct from a pure purchase-price average: opening 10×€2 and receipts 20×€3 give €80/30; recorded waste 2×€3 changes the recorded basis to €74/28. An exact compensating reversal restores €80/30. Unknown outflow values block the suggestion. No unrecorded sales or consumption are inferred, so none of these are guarantees about physical on-hand cost.

Apply saves only the operator-reviewed numeric estimate. The displayed policy/source assessment is read-only and is not a signed price guarantee or an automatically persisted historical valuation claim. Completed historical data is never recomputed.

Code and local verification are complete. No production deployment, data mutation or actual production latency measurement has been performed. Existing v5 Rules and reviewed indexes are reused; no new activation or per-hotel script is introduced. After owner merge and successful Functions/App Hosting delivery, verify normal-user suggestions/fallbacks, source/date changes, included-name loading and error recovery in the deployed app.
