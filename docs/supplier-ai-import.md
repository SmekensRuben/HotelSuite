# Supplier AI import execution and operating contract

Baseline: main `48cd1d5e1bb42416dc3d1c7acb86aecf686812fa` (13 October 2026).
Branch: `codex/supplier-ai-import-20261013`. No production data, merge or deployment is authorized by this change.

## Acceptance and progress

| Area | Acceptance criterion | Code | Local evidence | Deployed check |
| --- | --- | --- | --- | --- |
| Source ingestion | CSV, XLSX, PDF, DOCX, EML and text; 10 MiB, 50 PDF pages, 1,000 products; bounded archives, all source chunks accounted for | Complete | 19 extraction regressions; independently reproduced archive/HTML attacks now bounded | Pending |
| Paid processing | Private background jobs, fresh uploader authorization, durable chunk receipts, bounded standard-tier Luna calls, no automatic fallback or uncertain paid replay | Complete | Provider/policy/workflow regressions, confirmed-chunk continuation and lost-response emulator checks | Pending |
| Cost control | Transactional import/month reservations; per-hotel daily/concurrency limits; verified usage separated from unresolved charges | Complete | Concurrent upload quota race, month rollover, unknown/over-bound accounting regressions | Pending |
| Product review | Source anchors, missing values, before/after changes, explicit selection and correction; exact supplier/SKU identity, current revisions, existing product validators/history | Complete | 23 proposal regressions; ordinary hotel-user commit preserves price history and recorded order evidence | Pending |
| Platform console | General settings and paginated hotel usage; platform-only server access, no per-hotel keys or hotel membership for operators | Complete | 7 server tests, 22 UI/service tests, fresh authorization and unknown-cost cases | Pending |
| Privacy and recovery | Seven-day source/proposal expiry; minimal billing and commit receipts retained; restoration cannot silently rebill | Complete | Expiry/cleanup regressions; real emulator export/import preserves pinned source and unresolved billing without provider calls | Pending |
| Independent review | Tenant/owner isolation, cost/crash behavior, parser bounds, UI identity fences; original-problem regressions plus emulators and builds | Complete | Independent scoped review approved; integrated checks below | Pending |

Dependencies: extraction source anchors → provider schema → complete proposals → review/commit; cost policy → work reservations → usage console. Backend, extraction, proposal and UI have distinct file owners; a separate reviewer examines their integration.

## Configuration

Server-only document: `platformConfiguration/aiSupplierProductImport`. The platform AI page initializes and edits it through audited, revision-checked callable functions. The API key stays exclusively in Google Secret Manager as `OPENAI_API_KEY`, bound only to the paid worker. The page does not claim that a secret exists or that its value is valid.

Initial configuration is disabled, `gpt-6-luna`, reasoning `low`, no fallback, USD 0.25 maximum per import and USD 10 monthly per hotel. Supported reasoning is `none` or `low`. V1 rejects every other model and any enabled fallback. Input/output limits are 200,000/32,000 tokens per call; at most 32 paid calls, two concurrent hotel jobs and twenty hotel starts per UTC day by default. Operators may lower limits within the validated policy bounds. Changing configuration cannot silently reprice past receipts.

Recorded prices are versioned conservative standard-tier estimates: input is bounded at USD 0.125 per million tokens (including the documented cache-write premium, even when ordinary input costs less) and output at USD 0.50 per million tokens; no cache discount assumed. Output usage already includes reasoning tokens. These estimates cover model token usage, not Firebase costs or provider invoice reconciliation. Token-count requests are recorded separately without inventing a verified zero fee. Unknown usage is not zero. Known charges and still-reserved liability are shown separately.

## Workflow and security

Template import remains available. AI import uploads one supplier-scoped source to a private server-managed path, then uses a durable work queue. A validated token count and conservative reservation precede each paid request. Confirmed chunks have immutable receipts and private generation/hash-pinned results. Duplicate deliveries do not repeat a paid request. A crash or missing accounting after an attempted request blocks automatic resubmission and preserves its reservation.

Every job belongs to its verified uploader. Read, correction, replay and commit recheck current membership, permission, subscription, policy and ownership. Other hotel users and platform operators cannot read its private source through the import endpoints. Platform reporting exposes only hotel usage metadata. Browser writes to jobs, billing, configuration and sources are denied; generic file import cannot target these collections.

AI output is an untrusted proposal, never an automatic product write. All chunks must be reconciled before review. Missing values remain missing. Existing products match only the selected supplier and exact SKU. Catalog identity, base unit, managed images, packages, GTINs, price history and recorded financial/inventory evidence use existing product validation and transaction boundaries. Small idempotent commit batches use immutable command fingerprints and product revision checks, with per-row outcomes for partial success.

Disabling AI stops new jobs and paid work. Valid, unexpired proposals can still be reviewed and committed without a paid call. EML attachments are explicitly reported and must be uploaded separately. Unsupported, corrupt or oversized sources fail explicitly rather than being silently truncated.

Source access and proposal review expire after seven days. Private source bytes, extracted snippets, proposal rows and provider result objects then become eligible for bounded, repeating maintenance deletion. Minimal job status, immutable billing attempts and product commit receipts remain for accounting and replay protection. Cleanup errors are recorded rather than falsely reported as complete. A backup restoration must preserve both source generations and paid/commit receipts; it must not initiate a fresh paid request automatically. New paths retain existing default-deny Rules, and ordinary collection maintenance queries need no new composite indexes or SaaS Rules rollout.

## Local verification evidence

13 October 2026: 1,306 frontend tests, 457 Functions tests (77 new supplier AI regressions), 236 real Auth/Firestore/Storage security tests, settings migration safeguards, real emulator backup/export/import replay, full lint, incremental boundary types, test build and App Hosting fixture build passed. Runtime dependency policy reports zero vulnerabilities in frontend, Functions and operator scopes. The full local emulator suite was rerun with a four-CPU JVM cap after an environment-level interruption; the completed run passed all 236 checks.

Two independent real-component browser fixtures covered 1440×1050 and 390×844: template/AI chooser, single close control, before/after evidence, missing currency, readable corrections, explicit commit, unknown costs, fixed-model settings and per-hotel usage. No overflow or JavaScript errors. Browser services and paid provider responses were synthetic; Firebase integration used real local emulators. These checks do not establish provider extraction accuracy or production secret access.

Primary provider contracts reviewed on 13 October 2026: [Luna model and pricing](https://developers.openai.com/api/docs/models/gpt-6-luna), [token counting](https://developers.openai.com/api/docs/guides/token-counting), and [count endpoint request schema](https://developers.openai.com/api/reference/resources/responses/subresources/input_tokens/methods/count).

## Remaining release checks

Exact-head CI is required after publication. No merge or deployment has occurred in this implementation task.

Before the first deployment, the secret `OPENAI_API_KEY` needs an unconditional resource-level `roles/secretmanager.secretAccessor` binding for `358734544002-compute@developer.gserviceaccount.com`. Configure it once on this secret's Permissions tab in Google Cloud, if not already granted. The existing one-time deployment setup script also includes this exact grant. CI checks only enabled-version and IAM metadata and stops with an actionable message if it is absent; it never reads the secret or grants itself IAM administration. No per-hotel or ordinary-PR setup is required.

After merge/deployment, the operator must confirm worker secret access and perform one small real supplier import with a normal hotel account; verify review-before-write, reported usage, monthly reservation release and seven-day cleanup. No real OpenAI request, production secret access, deployment or invoice reconciliation is claimed by local tests.
