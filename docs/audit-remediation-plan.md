# HotelSuite audit remediation

## Baseline and scope

- Audit and current `main`: `06d5711b4f565d22c75ad86485a522a9bb225bb8` (reconfirmed 2026-10-10).
- Working branch: `codex/audit-remediation-20261010`.
- Source: HotelSuite audit dated 2026-10-10, 22 findings F01-F22. The PDF is a baseline, not proof of deployed state.
- Authorization: implement all actionable findings, add missing regression coverage, independently review changes, prepare commits and a draft pull request. **Do not merge or deploy.** No production reads/writes or real external messages.
- Retain authoritative hotel memberships, subscription checks, server-only procurement/private workflows, optimistic revisions and durable operation receipts.
- All new repository documentation, code comments, tests and UI copy are English.

## Status definitions

`confirmed` = baseline problem reproduced or traced; `implementing` = changes in progress; `local-verified` = focused tests/required checks passed; `reviewed` = independent review addressed; `deployed-unverified` = release/migration/operator acceptance remains. A green pre-existing suite alone does not resolve a finding.

## Workstreams and exclusive ownership

1. Import ingress/indexing: webhook, import index projections/consumers, receipt routing tests and migration tooling.
2. Rules/settings: Firestore/Storage rules, settings services and settings pages; coordinate rule changes requested by other streams. Own `firebaseQuotes.js` to serialize compset and snapshot/outcome changes.
3. Pricing engines: pure contribution/LOS/value utilities, optimizer, model contracts and pure regressions.
4. Frontend workflows: quote/create/detail/outcome pages, catalog/supplier/order pages, query state, route splitting. Request service changes from the relevant owner.
5. Scheduled workers: contract reminders, mail acknowledgment, guest intelligence freshness/retention and recipient boundaries.
6. Stock and actor lifecycle: protected stock mutations, stock service, current-user authorization, staff display projection and access audit deltas.
7. Root integration: shared Functions exports, package/lock changes, verification/release controls, durable status and cross-stream review/commits.

Only the owner edits a shared file; communicate required changes to that owner. Agents do not deploy, merge, push or commit. Root creates reviewable commits after verification.

## Agreed quote policy

Protect existing committed capacity. Optimize future net contribution within remaining capacity under the same forecast/valuation assumptions before and after taking the complete new group block. Opportunity cost is the difference of portfolio values, including replacement business. Per-night allocation is exact descending nonnegative contribution, limited by demand/capacity. Valid LOS uses bounded complete-itinerary optimization with nightly constraints and fractional expected volumes. Do not equate average-contribution greedy sorting with optimization.

Hard physical feasibility overrides every engine and pricing/simulation output. Required unknown data stays unknown. Base is central; Low/High are sensitivities, not guaranteed probabilities. Economic floor and market-based commercial advice remain distinct. Use documented VAT, meal basis, commission and incremental BQT contracts without double counting. Fallback to the validated per-night model is explicit, with LOS failure reasons. Save unavailable analysis only as an explicitly unavailable draft; never mark it current/valid. Version models and retain historical snapshots.

## Finding register

| ID | Finding / acceptance criteria | Status | Verification / remaining work |
| --- | --- | --- | --- |
| F01 | Server-owned unique receiving identity; two hotels cannot claim the same mailbox/route or read misrouted bytes | confirmed | Source VM reproduction; real-provider/staging acceptance remains |
| F02 | Global projection IDs include hotel; source-owned update/delete; safe reindex/migration tool | confirmed | Same local ID across hotels and reordered trigger regressions required |
| F03 | Durable event/attachment receipt and deterministic storage identity; concurrent replay does not duplicate work | confirmed | Crash/retry/concurrency regression required |
| F04 | Domain/field-specific settings authority, action-consistent categories, bounded typed mutation schemas | confirmed | Rules emulator allow/deny role matrix required |
| F05 | Actual compset paths work for ordinary revenue users; coupled saves atomic | confirmed | Non-admin reads/writes and partial-write regression required |
| F06 | Finished stock counts/locations immutable to direct clients; authorized transactional finish with canonical actor/totals | confirmed | Parent/location tampering, concurrent finish, malformed input tests |
| F07 | Split bootstrap and private settings reads; no zero-permission/unverified/suspended read of private config | confirmed | Emulator positive/negative tests and explicit legacy migration plan |
| F08 | Removing category/subcategory/Opera map key persists after fresh read without erasing unrelated fields | confirmed | Map deletion and concurrent-change service regression |
| F09 | Contribution-optimal before/after per-night allocation | confirmed | 90T/100G/100 capacity/20 request => loss 3000, floor150, -500 at125; reverse value priority |
| F10 | Physical/no-RN/unknown guards survive active LOS and suppress floor/target/stretch/simulation | confirmed | Requested20/capacity10 active model regression |
| F11 | LOS computes signed net portfolio difference, including replacement gains | confirmed | 400 lost/100 gained => net300 |
| F12 | Core horizon plus complete capacity/valuation tail; no irrelevant artificial edge invalidation | confirmed | Boundary and genuine missing shoulder data regressions |
| F13 | Missing-data quote saves as explicit draft/unavailable with safe error states | confirmed | Mounted UI/service save with absent nightly/source data |
| F14 | Unknown competitor rate remains null; no zero-price observation from blank input | confirmed | Blank/null/explicit0 adapter cases |
| F15 | Contract recipients revalidated at send-time; removed/disabled users skipped and current address used | confirmed | Fake transport with membership removal/disable/email change |
| F16 | Shared mail acknowledgment/failure semantics and safe idempotency for older scheduled flows | confirmed | Resolved error/missing ID/ambiguous send/repeated run cases |
| F17 | Source-fingerprinted fresh guest runs, checkpointing, full replacement/empty results; intended run mailed | confirmed | Unchanged/removed/empty/interrupted/concurrent source cases |
| F18 | Minimal outbound guest identity, explicit <=24h retention/cleanup, tenant-scoped recipients | confirmed | Request body and expiry/cleanup tests; provider and TTL deployment unverified |
| F19 | Complete paginated catalog export and independently loaded taxonomy | confirmed | >50 items, filters and later-page category coverage |
| F20 | Shared scoped async state with recovery and stale response protection | confirmed | Rejected and reversed request tests across affected live pages |
| F21 | Clear live/legacy boundary, smaller domain contracts, shared shell, canonical stay-pattern builder | confirmed | Preserve domain fixtures; lint/incremental type checks; inventory/documentation |
| F22 | Remove actionable vulnerable dependency baseline, meaningful allowed-path Storage tests and fuller restore fixture; prepare branch-protection guidance | confirmed | Package gates/CI; GitHub administration unavailable unless exposed; deployment state remains unverified |

## Additional linked audit observations

- Current enabled/verified actor and current platform-admin checks should match private workflows for privileged operations; preserve current membership rechecks and document queued-operation policy.
- Access audit records permission deltas. Staff display names use a minimal hotel projection without weakening global profile privacy.
- Global multi-hotel scheduled mail recipients require explicit scope; do not infer access from raw email.
- Shared-device persistent cache behavior needs an explicit policy and tests. Existing preview/production shared-backend agreement is retained; all acceptance work uses fictional emulator projects.
- Resource schemas, reminder throttles/idempotency and MIME bounds are strengthened where within the affected workflows; do not invent a paid quota policy.

## Verification gates

Baseline executed in the audit: frontend431 + Functions62 + emulator63 =556 passing tests; both non-production fixture builds passed; restore marker smoke passed; dependency policy passed only against temporary exceptions.

After changes run affected regressions, then integrated frontend/Functions/security suites, restore fixture, dependency gate and builds. Local Node24 versus CI/Functions Node22 is recorded; Java21 is available in scratch. Emulator child processes must omit this environment's proxy variables for localhost traffic. No production resources or real mail/SFTP.

Mandatory optimizer checks: zero/partial/full scarcity; reverse group/transient contribution; malformed/missing values and zero RN; full LOS paths; complete-vs-greedy portfolio counterexample (A both nights300, B night1=200, C night2=50); replacement gain; deterministic fractional outputs, feasibility, demand bounds and capacity monotonicity; VAT/meal basis/commission/BQT fixtures.

## Checkpoints and outcomes

- 2026-10-10: user authorized implementation and chose contribution optimization. Current main matches the audit baseline. No unrelated source changes present. Dedicated branch created.

## Deployment and policy checklist (not completed by local code work)

Rules/Functions deployment parity; controlled import index/route migration; retired source settings migration; live IAM/tokens/private-file migrations; Auth/App Check/MFA settings; external providers and data retention; complete backup restore including Auth/Storage; normal two-hotel browser acceptance. Prepare commands/runbooks and record unverified items rather than claim deployment.
