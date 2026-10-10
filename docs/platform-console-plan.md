# Platform console execution record

Base: `bfc1c8d0182655ab6ca895a72e8db48c1e016fa5` (current main, PR #225).
Firestore target: existing `(default)` Standard edition, Native mode, `hotel-toolkit`.
Scope: the owner's approved platform interface, import monitoring, in-app alerts,
audit history and controlled support. No production writes, merge or deployment.

| Work item | Status | Dependency | Acceptance and evidence |
| --- | --- | --- | --- |
| P1 Platform/hotel separation | Code implemented; locally verified | Existing module subscription baseline | Verified platform operator with zero hotel assignments can sign in and manage platform; ordinary hotel user cannot enter platform; canonical memberships and licenses govern hotel work |
| P2 Hotels and subscriptions | Code implemented; locally verified | P1 | Existing onboarding/subscription administration reused; creating a hotel grants no operational membership/assignment to operator; hotel detail has bounded metadata, contact and membership counts |
| P3 Import telemetry and expectations | Code implemented; locally verified | P1 | Server-only sanitized run projections; per-hotel schedules/time zones; missing, empty, failed, stalled, paused, unknown and inactive states; no guest data or credentials in platform responses |
| P4 Notifications and audit | Code implemented; locally verified | P3 | In-app incidents persist per expected occurrence; acknowledgment never changes health; platform changes have immutable server-written audit events; bounded reads and documented retention |
| P5 Controlled support and recovery | Code implemented; locally verified | P2/P3 | Reasoned, expiring actor/hotel-scoped read-only sessions; no impersonation or hotel membership grant; explicit import retry preserves checkpoints and rejects busy/completed runs; ambiguous external delivery never auto-resends |
| P6 Review and verification | Local checks passed; GitHub CI/review tracked on the PR | P1–P5 | Independent regression expectations, Auth/Firestore/Storage emulator denials/allowed flows, frontend checks and production fixture builds; security review JSON and release instructions |

Implementation decisions:

- One repository, Firebase project and sign-in; separate `/platform` layout and
  default platform landing. Hotel work remains a separate explicit workspace.
- Platform identity is a verified, currently enabled Firebase Auth identity with
  current `platformAdmin` authority. Hotel links are not platform authority.
- No automatic customer data scans or raw import/secret/guest projection.
  Monitoring and support expose bounded whitelisted metadata through callables.
- Initial notifications are inside the console. No emails or other messages are
  sent without a chosen recipient/channel; no placeholder production schedules.
- Schedules are explicitly configured per import; missing business dates and
  telemetry remain unknown. Server projections are not promises of valid domain data.
- Read-only support is a dedicated diagnostic view. It does not impersonate an
  employee or unlock general hotel CRUD. A normal hotel membership is required
  for operational work, even for a platform operator.
- New permission boundaries require a reviewed Rules release. Automatic Functions
  deployment alone does not verify deployed Firestore/Storage enforcement.

Verification states must remain separate: code implemented, locally verified,
GitHub CI verified, deployed and production acceptance checked. Every unfinished
item must retain an exact resume point below.

## Verification record

- Frontend: 693 passing tests across 78 files in the final complete run.
- Functions: 159 passing tests, including monitoring deadlines, DST, missing data,
  empty imports, required downstream completion and action-authority regressions.
- Auth/Firestore/Storage: complete 126-test run passes, including a real Storage,
  parser and Firestore import replay. The final run also covers immutable historical
  monitoring expectations after policy changes.
- Restore: two-hotel export/import passes with platform audit/incidents/telemetry,
  recovery records, a zero-hotel operator and rejection of a restored expired session.
- Lint, boundary type checking, generated module Rules and shell syntax pass.
- Runtime dependency policy: zero advisories for root, Functions and operator.
- Test build and App Hosting build both pass with the fictional demo project.
- Endpoint discovery confirms 15 platform callables, one schedule and one telemetry
  event, all in us-central1; no existing export was removed.
- Browser visual acceptance remains open: Playwright is installed but this runner
  has no Chromium executable. Component workflow assertions pass; responsive visual
  appearance and real browser acceptance are not claimed.
- Security second pass: implementing agent's critical review, documented in
  `platform-security-review.json`; not an independent human reviewer attestation.

## Review corrections

- Platform claims no longer bypass hotel membership, module or action checks.
- A stale hotel/route response cannot populate a newly selected property. An old
  support creation cannot redirect the operator after a hotel change.
- Read failures cannot become successful empty results or blank user-access saves.
- A required downstream model remains pending, failed or unknown until proven complete.
- Source/checkpoint replay is independent of telemetry failures.
- Incident acknowledgments preserve actual health. An edited schedule does not
  rewrite an earlier occurrence's expected business date or policy revision.
- Pinned object generations, hotel ownership, active subscriptions and current
  operator authority are checked before recovery. No mail/dispatch resend exists
  in diagnostic support.

## Pull request and exact resume point

Review-only draft: https://github.com/SmekensRuben/HotelSuite/pull/226
Base main remains `bfc1c8d0182655ab6ca895a72e8db48c1e016fa5`.
Published backend commit: `8cc7b1ad648c089c19b02132804965d870f4681a`.
Published complete implementation commit: `1aef596dbefb3801fca931da3c11e653f771c891`.
Its tree is `e3b503bf5c2d5bde74d6aace3a16ccf6c9765213` and exactly matches
locally verified code. The final documentation commit follows that implementation.
The PR's **Checks** tab is the authoritative current-head GitHub CI status; do not
infer deployment or production acceptance from its result.

P1–P5 code and local verification are complete. P6 local tests/review/builds are
complete. Human review, desktop/mobile visual acceptance and the exact-SHA
production procedure in `platform-console.md` remain open. No business decision
blocks the code: notifications are in-app, subscriptions retain manual billing,
and each hotel explicitly configures its import expectations. Do not merge or deploy
until the owner schedules the coordinated release.
