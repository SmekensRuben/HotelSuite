# Procurement counting, supplier prices and manual movements

Base: current main `23afecfc9e12203020376834136051a45f5f1019` (merged PR #233).
Branch: `codex/procurement-count-prices-movements-20261012`.
No automatic merge, deployment, production data rewrite or permission migration.

## Execution and acceptance

| Item | Implementation | Acceptance and evidence | Code | Local checks | Production |
| --- | --- | --- | --- | --- | --- |
| PE-01 Count ergonomics | Lazy scoped package helpers for an included frozen catalog article; mobile-friendly explicit Apply to canonical quantity. | Two 6-litre cases plus 0.5 loose litres equals 12.5 litres. Exact six-decimal conversion; incompatible/missing content unavailable; prices irrelevant; explicit zero vs uncounted and optional costs preserved. Ordinary stock users need no catalog/supplier directory permission. | Complete | Full frontend/backend/Rules passed | Not run |
| PE-02 Supplier comparison | Active same-article purchase options compared on net canonical-unit price within explicit currency; bounded pages and unknown contracts visible. | VAT once; l/ml and kg/g exact; zero valid, unknown never zero, no FX; shipping/minimum order terms not invented. No automatic winner before all pages are loaded. | Complete | Full frontend/backend/Rules passed | Not run |
| PE-03 Price history | Immutable, revision-addressed supplier terms appended by protected product save transactions when pricing/content/link terms change. | No duplicate on replay or unchanged terms; no invented history date for legacy prior terms; observe previous/current contracts explicitly. Historical orders/receipts untouched. Scope, privileges and pagination independently checked. | Complete | Full frontend/backend/Rules passed | Not run |
| PE-04 Physical movements | Protected atomic transfer legs, registered waste/breakage and physical supplier returns; immutable command evidence and compensating supervisor reversal. | Same-hotel distinct active transfer destinations, bounded positive canonical quantity, explicit source date/reference/reason, no inferred live balance. Whole transfers/reversals commit or fail together. Current authority checked on retries. Unknown operator-entered net estimate stays unknown. | Complete | Full frontend/backend/Rules passed | Not run |
| PE-05 Period report v2 | Separate explicit report policy and snapshot ID, including categorized manual movements. | Residual quantity = opening + net receipts + transfers in - transfers out - waste - breakage - physical returns - closing. Saved v1 remains unchanged; uncomputed v1 rejects manual evidence. Monetary residual needs complete explicit values/currency/cutoff evidence; no fabricated weighted cost. Late and missing sequence evidence remains explicit. | Complete | Full frontend/backend/Rules passed | Not run |
| PE-06 Template progress | Distinguish locally in-flight add/remove/reorder from saved commands with uncertain outcomes. | Normal deferred request shows progress, no reconciliation warning. Errors, remount, corrupt saved intent and original-request replay remain protected. Actor/hotel/navigation and duplicate-submit regressions. | Complete | Full frontend/backend/Rules passed | Not run |
| PE-07 Integration/security | New `inventorymovements.read/create/reverse`, procurement module and role presets; private namespace/import protection and route visibility. | Reversal requires explicit supervisor permission; no wildcard escalation, automatic member migration or arbitrary profile access. Existing v5 catchall already denies new private namespaces. | Complete | Full frontend/backend/Rules passed | Not run |

## Product and compatibility decisions

- Package helpers change only physical quantity explicitly applied by the counter. Barcode recognition remains the separately proposed later stage.
- Supplier comparison estimates goods prices only. Actual delivery costs, minimum-order constraints and exchange rates remain unknown. Optional supplier-provided contract validity dates can be entered explicitly; absence stays unknown.
- Manual movements are records between physical counts, not a perpetual stock balance. They cannot prove stock available for a transfer or attribute residual usage to sales.
- Physical returns represent goods leaving a location, separately from reversing erroneous receipt evidence or posting an invoice credit.
- New grants are available through reviewed role/access assignment. Existing users are not silently given new movement or reversal rights.
- Saved receipt-only v1 analyses remain immutable. V2 is explicitly selected and saved separately; it cannot silently revalue past counts or earlier analyses.
- The SaaS Rules contract remains **saas-platform-v5**: its existing default-deny boundary already protects these new server-only namespaces. Adding documented deny rules and module labels is compatible. Independent review and emulator denial tests must confirm this; no new version bump is justified solely by another PR.

## Owners and review

Counting, supplier pricing, manual-movement backend, movement/report frontend and template progress have separate file owners. Root owns shared permissions, generated Rules, imports, routes, release integration and this plan. An independent reviewer checks exact conversion, immutable history, atomic posting, current hotel rights and ambiguous-request recovery. Browser QA follows integration. All interface/code/docs are English.

## Remaining checks and resume point

All implementations and independent review are complete, with no outstanding P1/P2 findings. Review corrections include Auth revalidation on transaction retries, actor/request binding for mutation acknowledgment, complete balanced transfer/reversal evidence, access-restoration and hotel-date pagination resets, and preservation of omitted known price dates for older clients/imports.

Local Node 22 verification: 1,065 frontend tests (122 files), 314 backend tests, 189 Rules/emulator tests, lint, incremental types, zero-vulnerability dependency policy and both non-production builds passed. Actual-component browser QA at 1920×1080 and 390×844 passed package Apply/save, comparison/history pages and filters, validity dates, transfer/reversal controls, V1/V2 report selection, normal template progress, long-name stress and unavailable-package fallback. Browser services were synthetic; actual backend authorization was exercised separately in emulators.

The extended two-hotel export/restore smoke passed for actual protected EUR/GBP price changes, balanced manual transfers/reversals and separately saved V2 analyses. Source payloads/timestamps survived restore; exact command and report replay preserved original update times and created no extra evidence. Existing V1 numerical expectations also passed unchanged. Publish coherent commits and the PR, then record exact-head CI in the PR. No merge/deploy was performed. After owner merge, wait for successful main CI/Functions/App Hosting delivery. The already-active v5 rollout remains compatible; another Cloud Shell activation is not required by these changes. Review/save Stock Controller or Inventory Supervisor access explicitly to grant the new actions. Verify authenticated production flows and first/repeat-load latency separately.
