# Audit remediation verification record

Baseline: `06d5711b4f565d22c75ad86485a522a9bb225bb8`, current `main` reconfirmed unchanged before PR preparation on 2026-10-10. Branch: `codex/audit-remediation-20261010`. This is repository and local-emulator evidence; nothing was merged, migrated or deployed.

## Final local gates

| Check | Result |
| --- | --- |
| `npm test -- --run` | 72 files, 641 tests passed |
| `npm --prefix functions test` | 139 tests passed |
| `npm run test:security` | 13 suites, 88 tests passed with Auth/Firestore/Storage emulators |
| `node --test scripts/migrate-domain-settings.test.mjs` | 10 tests passed |
| `npm run test:restore` | Canonical two-hotel Auth/Firestore/Storage export/import passed |
| `npm run lint` | Live frontend, Functions and scripts passed |
| `npm run typecheck` | Strict incremental environment/number boundary scope passed |
| `npm run audit:policy` | Zero runtime findings/exceptions in root, Functions and operator scopes |
| `npm run build:test` | Passed; fixture entry 1,170.48 kB / 305.50 kB gzip |
| `npm run build:apphosting` with fictional Web App configuration | Passed; fixture entry 1,404.93 kB / 362.75 kB gzip |
| Deployment shell syntax and locked operator module imports | Passed, without running deployment/migration |
| `git diff --check` | Passed |

Local runtime was Node 24.19.0/npm 11.9.0 and Java 21. CI and production Functions use Node 22; PR CI must independently validate that runtime and clean installs. Vite still reports chunks above 500 kB. Fixture build sizes are not a production browser performance measurement. Type checking covers two named boundaries, not the whole JavaScript application.

## Evidence by repaired boundary

| Findings | Code and regression evidence |
| --- | --- |
| F01–F03 ingress/index/replay | `functions/src/importRouting.js`, `importIdentity.js`, `importProcessing.js`, `webhook.js`, `fileImportTypes.js`, `meili.js`; `importRouting.node-test.js` and parser tests. Unique receiving identities, recipient resolution before downloading, tenant-qualified index IDs, current source transactions, generation-pinned objects and fenced atomic checkpoints. Migration manifest/tool retains source ownership and has explicit dry-run review. |
| F04/F05/F07/F08 settings | `firebase/firestore.rules`, `storage.rules`, `firebaseSettings.js`, `firebaseQuotes.js`, `HotelContext.jsx`; `settings.rules.test.mjs`, settings/service/context/mounted tests, migration tests. Exact domain/action authority, private read denial, safe bootstrap, atomic compset saves, actual map-key deletion and conflict/version-aware migration. |
| F06 stock and linked actor controls | `stockCounts.js`, `staffDisplay.js`, `authorization.js`, `userAccess.js`, stock adapters/pages; focused Node, mounted, and real Auth/Firestore stock workflow tests. Canonical server totals/actors, revision conflicts, Finished immutability, strict current Auth and minimal source/display projections. Optional catalog failure cannot block counting existing snapshots. |
| F09–F14 quote economics/evidence | `contributionAnalysis.js`, `intervalPortfolio.js`, `losNetwork.js`, `physicalCapacity.js`, `pricingGuidance.js`, shared `stayPatternPreparation.mjs`, model lifecycle, Create/Detail/Outcome and `quoteAnalysisEvidence.js`; pure, lifecycle, mounted and Rules regressions. Exact per-night objective; bounded, certified complete-itinerary optimization; physical/unknown guards; explicit fallback; source revision/publication fencing; preserved historical versions and full frozen contribution snapshots. |
| F15–F18 scheduled workers | `scheduledMailDelivery.js`, contract/occupancy/block/guest handlers and `guestIntelligence.js`; 39 focused worker tests and independent adversarial probes. Current hotel recipients, strict provider acknowledgments, durable ambiguity blocking, source/expiry validation, minimal outbound data, bounded cleanup/resume, late completion delivery and per-hotel error isolation. |
| F19–F21 frontend architecture/recovery | `paginatedExport.js`, catalog/order/stock/quote pages, `useScopedAsync.js`, `useStaffDisplayNames.js`, `PageShell.jsx`, lazy `AppRouter.jsx`; independent 80-test frontend review and six extra mounted probes. Full exports, independent taxonomy, role-safe optional queries, failure/retry, reversed reads, parsed import reset, unmount and late action suppression. Live/legacy boundary documented. |
| F22 maintenance/release | Package locks, audit policy, lint/checkJS/CI, real spreadsheet tests, memory-cache initialization and canonical restore fixture. Independent maintenance review also ran seven adversarial dependency-gate probes. No runtime audit exceptions remain. Main-protection instructions and sequenced rollout are prepared, not applied. |

## Required numerical acceptance

| Example / invariant | Independent or persistent evidence |
| --- | --- |
| 100 free rooms; 90 transient at €200, 100 future groups at €100; request20 | Contribution and mounted evidence tests assert baseline 90T+10G, after80T, opportunity cost €3,000, floor €150 and −€500 at a €125 offer |
| Future groups can be more valuable | Reverse net-value allocation tests; no unconditional business-type priority |
| No/partial/full scarcity and physical oversubscription | Contribution, physical capacity, pricing and active-LOS UI guards; infeasible products have no floor/target/stretch/positive simulation |
| €400 lost path with €100 replacement | LOS signed portfolio difference is €300; replacement contribution is retained |
| A both nights €300 versus B first €200 + C second €50 | Exact optimizer accepts A; exhaustive oracle catches average-per-night greedy failure |
| Capacity/demand bounds, fractional determinism and monotonicity | 80 persistent exhaustive fractional fixtures, certificate tampering checks and independent 1,500-portfolio reviewer oracle |
| Unknown values, zero RN and horizon boundaries | Strict authoritative count/occupied-date validation, January carry-in, missing shoulder valuations, malformed revisions, source change during build and root/annual publication mismatch regressions |
| VAT/meal/breakfast/commission/BQT | Existing source/price contracts retained and extended; both commissions, VAT-inclusive offered rates, explicit nightly pax, incremental BQT and no double-counted pipeline evidence tested |
| Repeated analysis and historical preservation | Mounted VALID→STALE→VALID same-input refresh, horizon/read error fallback, complete versioned snapshot, stale/outcome controls and unchanged saved historical version tests |

## Independent review outcomes

Each workstream had a separate reviewer. Review uncovered and repaired defects beyond the original green suites: protected import targets and UTF-8 chunk replay, actual Firestore array timestamp serialization, minimum-role stock source access, optional enrichment failures, stale/unmounted mutations, cross-hotel parsed imports, historical carry-in/unknown counts, publication freshness, hidden LOS exceptions, partial quote outcome writes, malformed provider acknowledgments, research error privacy, send-time source changes, missing expiry, abandoned run retention, late guest completion and one hotel aborting another hotel's reports.

All confirmed code blockers raised by those reviews were repaired and rechecked. The settings auditor's final scoped assessment is 4/5 with no unresolved findings; client numerical authenticity and deployed verification remain explicit limits. Good committed-capacity logic, private workflows, permission catalog, optimistic revisions, idempotent operation receipts and earlier regressions remain in place.

## Release obligations and exact next step

No commercial calculation choice remains open: contribution optimization is the approved policy. Data/source contract configuration still needs the actual hotel's validated economics before its advice can be trusted. Forecast-dependent advice is not guaranteed profit.

Proceed only through [audit-release-checklist.md](audit-release-checklist.md), after authorization for a release: reviewed backups/manifests, canonical settings and ingress/recipient migration, matched backend/Rules/frontend deployment, publication V2 rebuild, two-hotel normal-user browser acceptance, provider behavior/retention and scheduler alert/deletion timing. Historical objects without receipts need an inventory before replay. Clear old shared-device IndexedDB data explicitly; the memory-cache change cannot erase it.

The exposed GitHub connector cannot administer branch protection. An administrator must apply/test the `main` rule described in the checklist. Auth/App Check/MFA/IAM, production backup recovery and deployed parity remain unverified. Rules protect access/lifecycle and bound client evidence; they do not independently certify economic calculations for settlement. These are separately recorded operational/trust limits, not silently marked deployed or solved by local tests.
