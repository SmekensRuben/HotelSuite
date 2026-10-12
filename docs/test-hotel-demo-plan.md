# Test hotel demo data execution plan

Base: main `2f9e24c09a111494a1e5eb61abcf72cde1b9d72d`, including PR #229.
Branch: `codex/test-hotel-2-demo-data-20261012`.
Scope: an explicit platform-admin action to add a complete purchasing/inventory
fixture only to existing test-hotel-2. No live database writes, merge or deployment.

| Workstream | Code status | Local evidence | Deployment status |
| --- | --- | --- | --- |
| Versioned bounded fixture | Resolved | Canonical unit/price/receiving/period regression checks | Not deployed/loaded |
| Atomic preview/apply and replay | Resolved | Zero-hotel operator, concurrent apply, collisions, edited-record preservation | Not deployed/loaded |
| Hotel and role boundaries | Resolved | Ordinary roles, live revoked/disabled Auth, subscription/release checks, Rules and import denials | Not deployed/loaded |
| Safe demo ordering | Resolved | Normal approval/receipt workflow and claimed-supplier guard; no outbound callbacks | Not deployed/loaded |
| Platform UI and simulated-order copy | Resolved | Preview/acknowledgement/conflicts/uncertain recovery, route scope and PDF simulation | Not deployed/loaded |
| PR verification | Local checks completed; exact-head CI next | Commands and outcomes below | Not deployed/loaded |

Local checks: 244 full backend tests; 9 final demo emulator cases and 18 existing
onboarding/receiving cases; 48 focused platform/service/order frontend checks; lint,
incremental types and test build. The first full frontend run passed 848 tests but
one unchanged mocked-rollout test exceeded its existing five-second timeout; the
isolated rerun passed. No existing expectations or timeouts were weakened. Exact
head CI reruns the full integrated suites, recovery and both builds.

Resume on this branch: publish the reviewed source as a draft PR, inspect exact-head
CI and repair actual failures. Once published, review the PR and perform the normal
release process before using the UI action. Production seeding is deliberately
pending the platform-admin action; do not treat green emulators as populated live
Firestore. The operator guide and test checklist are in `test-hotel-demo-data.md`.
