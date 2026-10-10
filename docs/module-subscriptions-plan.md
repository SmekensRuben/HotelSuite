# Module subscriptions: implementation and release record

## Scope and baseline

First commercial module: **Purchasing & Inventory**. Contracts belong under
Administration and have a separate entitlement. Core identity, hotel settings,
team administration and subscription discovery are included. Billing remains
manual; no prices, invoices, payment collection, merge or production deployment
are authorized by this implementation.

Branch: `codex/procurement-subscriptions-20261010`, stacked on audit PR #221
(`9fe8c64ae62b45d0f1cfe020b27ce02f75922055`). Current main remains
`06d5711b4f565d22c75ad86485a522a9bb225bb8`; preserve the audited boundaries.

## Policy decisions

- Explicit, versioned hotel entitlements: procurement, contracts, frontoffice,
  groups, revenue. Missing/invalid module entitlements fail closed.
- Subscription state/expiry and module entitlement are separate from action
  permissions; check all three in browser, Rules, callables and workers.
- Initial seat limit is unlimited (`null`). An optional future limit counts
  assigned hotel members, including invited members, not recent logins or shared
  credentials. A reduced limit only blocks new assignments; existing access stays.
- Hotel administrators have explicit delegation authority over licensed module
  roles. Administrative status alone conveys no operational module permission.
- Procurement roles: viewer, buyer, approver, stock-controller, module-manager.
  Role permissions are explicit and versioned; new catalog actions do not become
  grants automatically. Multiple roles may be combined. Advanced permissions are
  bounded by the licensed modules and exclude platform/user-administration grants.
- Invitations and role changes are scoped to one hotel; never expose another
  hotel's membership or mutate a shared Auth account's credentials/disabled state.
- Last hotel-administrator membership removal/demotion is transactionally blocked.
  A platform operator can recover access by appointing a replacement first.
- Removing a module blocks its operational work without deleting data or rewriting
  memberships/history. Existing tasks already in flight cannot be recalled. No
  blocked mail is replayed automatically. Export/retention access after cancellation
  requires a separately agreed policy; this version retains data and gates access.
- Existing subscriptions require an explicit reviewed module migration. Do not
  infer paid rights from a plan label. Existing custom permissions are not silently
  replaced with role presets.

## Work items and acceptance

| Item | Dependencies | Acceptance evidence | Code | Local verification | Deployed verification |
| --- | --- | --- | --- | --- | --- |
| Catalog/entitlements | audited baseline | `modulePolicy.node-test.js`; generated Rules drift check | complete | passed | not deployed |
| Firebase/function/worker gates | catalog | 106 Auth/Firestore/Storage tests, including licensed positive paths and import/dispatch revocation | complete | passed | not deployed |
| Hotel team management | entitlements | ordinary hotel-admin two-hotel scenarios; concurrent last-admin/seat races; legacy identity hydration | complete | passed | not deployed |
| Procurement roles and navigation | team API | HotelTeamPage workflow tests; combined roles, preserved advanced rights, stale hotel switch | complete | passed | not deployed |
| Onboarding/subscription editor | catalog/team | explicit procurement-only onboarding; admin vs operational roles; subscription editor regressions | complete | passed | not deployed |
| Migration/release/review | all | real emulator CLI dry-run/apply/idempotence/revision/whole-manifest preflight; restore; release guide | complete | passed; ready for PR review | not deployed |

## Required checks

Frontend and Functions regressions; real Auth/Firestore/Storage emulator workflows
with ordinary hotel administrators and procurement roles; both hotel isolation
paths; subscription expiry/suspension and module removal; wildcard permissions
cannot unlock modules; unauthorized grants and direct membership/subscription
writes; stale/concurrent saves; last-admin and seat races; invite resend after
access revocation; worker dispatch/import module gates; lint, types, environment
fixture build and restore smoke. Capture exact results before marking local work
verified. Browser/production smoke, reviewed migrations, matching Rules/Functions/
frontend deployment and subscription activation remain separate release actions.

## Local verification record

2026-10-10, Node 24.19.0/npm 11, Java 21; production/CI targets Node 22.

| Check | Result |
| --- | --- |
| `npm test -- --run` | 650/650, 73 files |
| `npm --prefix functions test` | 148/148 |
| `npm run test:security` | 106/106, 14 suites; real local Auth/Firestore/Storage |
| Settings migration safeguards | 10/10 |
| `npm run test:restore` | Passed; two-hotel entitlements, roles, guard/audit, historical data, Auth and private Storage restored |
| Lint / incremental boundary types | Passed |
| Generated module Rules / operator script syntax | Passed |
| Runtime dependency gate | Zero findings in root, Functions and operator scopes |
| `npm run build:test` / fixture `build:apphosting` | Passed; existing large-chunk warnings remain |

The local Firebase CLI ignores NO_PROXY for its cross-service emulator requests.
Tests were executed with HTTP/HTTPS/ALL proxy variables unset for that process
and `NODE_USE_ENV_PROXY=0`, using fictional local demo services. Initial Storage
failures were diagnosed as closed proxy sockets, not accepted as permission-test
evidence. No production/provider requests were made.

## Critical review and remaining scope

Manual boundary/diff review resolved these implementation findings before
completion:

- Full quote creation exceeded the Rules expression budget after entitlement
  checks. Removed redundant authorization evaluation and used value-based quote
  schema helpers without relaxing any existing quote bounds/lifecycle checks.
  The existing full-population and invalid/stale/outcome regressions now pass.
- Dormant role retention must preserve existing rights, not generate new rights
  for an unlicensed module; dedicated policy/emulator tests verify this.
- Pending team mutation completion must not overwrite a newly selected hotel's
  editor. Sequence/scope guards and a delayed-completion test verify this.
- Legacy members lacking hotel-local names/email must remain editable. The
  backend now hydrates a narrow projection of this hotel's member IDs only.
- Both Cloud Shell rollout launchers must include the new shared module catalog.
  The missing download dependency was added and syntax/workflow checks pass.

[Scoped Rules assessment](module-security-review.json) records the six security
checklist items and one inherited, non-blocking typed-configuration improvement.
No other module gained new role presets. Supplier-order receiving remains a
separate future workflow; it is not implied by the stock-count preset.

Three focused commit groups form the draft branch; every published Git tree is
checked against the locally tested tree. The PR targets
`codex/audit-remediation-20261010`; GitHub check status is recorded on the PR.

Exact release resume point: review the draft PR and its Node 22 CI, complete
the PR #221 dependency, then retarget the module PR to the reviewed main branch.
Before production: review actual
module/admin manifests, paid terms/export/retention policy, coordinated rollout,
provider delivery and ordinary-user browser acceptance. Merge/deploy are not
authorized.
