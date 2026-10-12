# Hotel onboarding and goods receiving execution record

Base: current main `22cece52372e9a3a868106ef54014430753f75d3`, verified 2026-10-12.
Branch: `codex/hotel-onboarding-receiving-20261012`.
Target: existing `hotel-toolkit` `(default)` Standard/Native Firestore contract.
Development and verification use fictional local demo resources only. No merge,
production data changes, Rules publication or deployment is authorized.

## Scope and decisions

- Extend existing hotel creation, invitations, team roles and platform pages.
  Readiness is a dated, read-only report, not an activation flag or permission.
- Check Auth identities, hotel memberships and assigned profiles together. Report
  missing/mismatched records without deleting them, granting rights or changing
  credentials. Only the current platform administrator can see the report.
- A primary and backup enabled/verified administrator are recommended for setup.
  Existing last-admin protections and seat policies remain authoritative.
- Include subscription/module state, property time zone/currency, usable procurement
  source records, operational role assignment and monitoring of enabled imports.
  No enabled import source means monitoring is not applicable. Missing evidence,
  incomplete identity/import inspection and read failures never mean ready.
  Basic source existence can be proven from a usable bounded sample without claiming
  an exhaustive catalog/content audit; counts and limits are explicitly labeled.
- Receiving uses frozen supplier-product purchase units from the submitted order.
  Store accepted and rejected quantities separately, at most three decimals, using
  integer thousandths for arithmetic. Damaged/rejected goods do not fulfill demand.
- Only confirmed Ordered/Received orders can be received. Partial deliveries remain
  Ordered; complete accepted quantities become Received. Finalized orders are frozen.
  Overdelivery/rejections require reasons. A separate supervisor action acknowledges
  discrepancies/shortfalls before finalization.
- Receipts are immutable, dated events. Reversal is a supervisor event with a reason,
  never an edit/deletion of history. Order revisions, request receipts and unique
  delivery references prevent stale/concurrent and repeated submissions.
- Add explicit Receiver and Receiving Supervisor roles and `orders.receive` /
  `orders.finalize` permissions. Existing roles/memberships gain no silent new rights.
- Inventory remains periodical stock counts. Receiving history does not pretend to
  be perpetual on-hand stock, alter finished counts, change catalog prices, approve
  invoices, generate credits or resend supplier orders. Existing legacy article-based
  stock adapters are not fed unconverted supplier purchase quantities.
- Legacy Received/Finalized orders lacking a verifiable receipt baseline stay
  historical; no synthetic opening quantities or silent migration.
- New reports/history/mutations are authorized callables. New receipt collections
  remain browser-denied. Existing Rules version remains applicable because no new
  client data path is opened; generated licensed permission lists stay in sync.

## Work items

| Item | Dependencies | Acceptance | Code | Local verification | Production |
| --- | --- | --- | --- | --- | --- |
| O1 Scoped readiness report | Existing Auth/platform/subscription boundaries | `hotelSetup.node-test.js`, real Auth/Firestore report/denial/sanitization regressions in `onboarding-receiving.test.mjs` | Complete | Passed | Not deployed/checked |
| O2 Guided setup UI | O1 | `HotelSetupChecklist.test.jsx`, onboarding and service tests: dated/error/unknown states, creation/invitation refresh, old-hotel response fencing | Complete | Passed | Not deployed/checked |
| R1 Receiving domain and commands | Existing order/dispatch snapshots | `orderReceiving.node-test.js` and real emulator partial/full/duplicate/concurrent/reversal/closure/legacy regressions | Complete | Passed | Not deployed/checked |
| R2 Receiving rights/history/UI | R1 | Ordinary receiver/supervisor and denial paths, exact-grant tests, `OrderReceivingPanel.test.jsx`, scoped service validation and restore/replay | Complete | Passed | Not deployed/checked |
| V1 Critical review and release evidence | O1–R2 | Scoped security review JSON; focused/full checks below; commits and PR tracked separately | Complete | Passed locally; CI/PR pending | Not deployed/checked |

## Verification and resume point

Implementation and local verification complete. Verify code separately from live rollout. The owner has
confirmed orphan-membership cleanup; the final SaaS activation and ordinary-user
Hotel Team acceptance have not yet been reported in this conversation.

| Check | Local result |
| --- | --- |
| Frontend | 744/744, complete `vitest run src` JSON report, success true |
| Functions | 186/186 on Node 22.23.3 |
| Auth/Firestore/Storage security | 145/145; complete existing and new suites |
| Final focused Auth/Firestore rerun | 18/18 after readiness refinements |
| Restore | Two-hotel Auth/Firestore/Storage export/import; receiving events/reference and original-operation replay after finalization verified |
| Lint and boundary types | Passed |
| Generated Rules and diff checks | Passed |
| Test and fixture App Hosting builds | Passed; inherited large-chunk warnings remain |
| Runtime dependency policy | Zero advisories/exceptions in root, Functions and operator scopes |
| Dependency versions | Installed root/Functions package versions match their lockfiles; no dependency change |

Critical review corrections: legacy wildcard cannot silently grant receiving;
paused gate cannot discard an earlier uncertain outcome; no verified zero baseline
when an aggregate/history is lost; explicit unknown units/revisions/numeric types;
platform-only legacy links do not falsely require an employee membership; existing
unlicensed-role error ordering preserved; stock workflows need read as well as create;
catalog sample counts and uninspected imports/identities remain distinct. Supplier
dispatch markers/prices and finished stock counts are preserved.

The [scoped review](onboarding-receiving-security-review.json) is by the implementing
agent, with adversarial tests, not an independent human attestation. Actual desktop/
mobile browser, invitation-provider and production acceptance remain open. No code
depends on a new business decision: periodic counts, explicit receiving roles, manual
billing and versioned immutable events are the chosen contracts.

Exact release resume point: inspect the PR/current-head CI, finish the previously
requested one-time SaaS activation if still pending, deploy the matching reviewed
release, assign Receiver/Receiving Supervisor roles through Hotel Team and exercise
the normal-user checks in [the guide](hotel-setup-and-receiving.md). No per-hotel CLI
script or historical receiving migration is introduced. Do not merge/deploy from
this task; code/local/CI/deployed acceptance remain separate states.
