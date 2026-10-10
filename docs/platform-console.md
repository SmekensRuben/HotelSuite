# Platform administration and import monitoring

A verified platform administrator can use `/platform` without any hotel assignment.
The same sign-in serves two distinct workspaces. Platform authority is checked from
current Firebase Auth on every administrative callable. Hotel work requires a
canonical membership, active licensed module and action permission, including for
a platform operator. Creating a hotel does not assign its creator as an employee.
Legacy profile links are retained; only links with a canonical membership appear
in the operator's hotel workspace selector.

| Platform area | Behavior |
| --- | --- |
| Overview / Hotels | Paged property list, subscription/module state, dated import summaries |
| Hotel details | Name, contact and explicit IANA time zone; optimistic revision checks; hotel team and subscription links |
| Subscriptions | Existing manually billed access periods, modules and assigned-user limits; no automatic charges |
| Users | Backend-only paged account metadata and explicit per-hotel access; sign-in email comes from Auth |
| Imports & integrations | Canonical import types, explicit delivery schedules, sanitized run evidence and guarded recovery |
| Notifications | Persistent in-app incidents; acknowledgment records review and leaves unhealthy imports open |
| Activity & audit | Immutable server-written changes for hotels, subscriptions, team/access, monitoring and support |
| Support | Actor/hotel-bound diagnostic session, expires after 30 minutes; no guest records, impersonation, employee role or mail resend |

Ordinary hotel administrators manage their own teams through the existing hotel
workspace. Appoint a primary and backup administrator for a new hotel. Assign
operational module roles deliberately; a platform claim never supplies those roles.
Legacy `/settings/hotels`, `/settings/subscriptions` and `/settings/users` links
redirect to platform administration.

## What import health proves

Configure an expectation for each relevant canonical import type. Nothing creates
an expectation automatically. The editor requires the IANA time zone, delivery
weekdays, local deadline, grace period, first monitored date and business-date
offset. For example, offset -1 expects yesterday's business data on today's
scheduled delivery. Empty sources are unhealthy unless explicitly allowed.

| Status | Meaning |
| --- | --- |
| Not configured / unknown | No validated expectation or insufficient trusted evidence; never proof of success |
| Awaiting | The applicable local deadline including grace has not elapsed |
| Overdue | No matching business-date observation after the deadline within the inspected history |
| Processing | An active import lease or a recently pending required model |
| Stalled | An expired lease or an unprocessed received source after the deadline |
| Failed | Recorded parser/preflight failure |
| Empty | A completed import wrote zero records and the policy does not accept an empty source |
| Partial | Raw import completed but its required model failed or remained pending beyond 15 minutes |
| Healthy | Matching known business date, receipt/completion evidence, acceptable count and required follow-up completion |
| Inactive / disabled / paused | Subscription or explicit source/monitor policy is inactive; no healthy inference |

Success describes processing evidence, not validation of every guest or business
value. Historical imports missing receipt timestamps, relevant dates or record
counts remain unknown. Imported source contents, credentials, guest records and
source object paths are excluded from all platform DTOs.

Deadlines use the hotel's configured time zone, including daylight-saving changes.
An ambiguous local clock time uses the later occurrence; a skipped clock minute
moves to the first valid minute. Date-only business dates remain YYYY-MM-DD.

The scheduled checker processes at most 25 hotels every 15 minutes with a persistent
cursor. A full rotation takes about `ceil(hotelCount / 25) * 15 minutes`, plus actual
processing time. Hotel overview summaries older than one hour display as unknown.
The console also offers an explicit refresh. These bounds need review before the
customer base grows enough to require a faster rotation.

Each occurrence and monitoring revision has its own incident and snapshotted
expectation. A new day or edited schedule does not erase a missing older source.
Late success can resolve the original occurrence using its original policy.
Current import health and retained historical incidents are distinct: check the
notifications page even when today's import is healthy. Reconciliation inspects
at most 100 retained hotel incidents; older records stay open, not silently resolved.
No external notification channel or automatic message delivery is added.

## Support and recovery

A support reason is required. The server pins the session to its creator and
hotel, checks current platform authority and expiration on every diagnostic read,
and audits start/end. Mail diagnostics expose bounded status counts only. Ending
or expiration removes diagnostic access. A restored expired session stays expired.

Import recovery is a separate, explicit platform action outside the read-only
support screen. Supply a reason for a failed or stalled run. The server validates
active access, the release gate and the exact hotel/bucket/name/generation source.
It rechecks live authority after fetching storage metadata, then invokes the existing
import handler. Frozen parsing configuration and committed chunk hashes are kept;
append-mode rows are not duplicated. Completed or leased runs are rejected.

A completed raw import with a failed model is not replayed. A hotel user with the
licensed Revenue module and `groupquotes.update` can use the existing model rebuild.

A request ID is retained after an uncertain client response. Retrying that request
returns its recorded operation instead of executing the import again. Recovery
history exposes the latest 20 requests. A running request requires inspection;
neither a timeout nor an unconfirmed mail/provider response authorizes an automatic
resend. Source-object generation behavior still needs real GCS acceptance because
an emulator is not proof of all production versioning semantics.

## Server metadata and retention

Browser access to new platform collections is denied. Data is accessible only
through current-authority callables with explicit hotel IDs and narrow projections.
Hotel pages are bounded to 25, user/audit/incident pages to 50, run observations and
canonical monitoring configuration to 100. Continuation and truncation are explicit;
page totals are not global totals.

Audit events have global and per-hotel metadata copies committed atomically with
the mutation. They contain actor/action/target/revision/time, not request payloads,
credentials, guest contents or permission arrays. Audit metadata and ended/expired
support sessions are retained for 90 days. Resolved incidents and finished recovery
requests expire after 90 days. Open incidents and ambiguous running recoveries stay
available for review. Telemetry projections older than 90 days can be removed;
original import runs and checkpoints are unchanged. Cleanup is bounded and best
effort on worker rotations, not an exact deletion-time guarantee.

No new dependencies, global customer-data index, production credentials or billing
provider are introduced. Tenant source data retains its existing retention policy.

## Review and release

I've set up prototype Security Rules to keep the data in Firestore safe. They are
designed to be secure for canonical membership, licensed actions and backend-only
platform metadata. However, you should review and verify them before broadly
sharing your app. If you'd like, I can help you harden these rules.

The code and local regressions are hardened in this PR; the prototype statement
means deployed enforcement and production acceptance are still unverified. See
`platform-security-review.json` for the scoped review and remaining inherited debt.
The old rules allow broad platform operational bypasses, so a Functions deployment
alone does not activate the new boundary.

1. Review the PR and exact resulting main commit before choosing to merge. Main
   may trigger App Hosting and Functions deployment; neither is performed by this task.
2. Wait for CI, App Hosting and the actual Functions deployment/inventory for that
   exact main SHA. Platform reads/subscription preparation require current operator
   authority but no hotel assignment. Hotel onboarding and sensitive hotel writes
   correctly stay gated until the reviewed Rules release completes.
3. Perform the existing exact-SHA one-time Rules rollout for `saas-platform-v3`.
   `functions/src/platformReleasePolicy.json` is shared by backend and both rollout
   launchers. Download the launcher from the reviewed merged SHA, run its read-only
   preflight, and then apply that same release after it passes:

   ```bash
   HOTELSUITE_RELEASE_SHA="REPLACE_WITH_REVIEWED_MERGED_MAIN_SHA"
   curl --fail --silent --show-error --proto '=https' --tlsv1.2 \
     "https://raw.githubusercontent.com/SmekensRuben/HotelSuite/${HOTELSUITE_RELEASE_SHA}/scripts/firebase/rollout-saas-pilot.sh" \
     --output /tmp/hotelsuite-platform-rollout.sh
   bash /tmp/hotelsuite-platform-rollout.sh --release-sha "$HOTELSUITE_RELEASE_SHA"
   # After the read-only preflight passes:
   bash /tmp/hotelsuite-platform-rollout.sh --release-sha "$HOTELSUITE_RELEASE_SHA" --apply
   ```

   Preserve the printed Rules backup and existing private-workflow activation.
   Do not manually set the activation marker or deploy old Rules to bypass a failure.
   This is a release operation once for the changed boundary, not a script per hotel.
   The existing launcher checks the reviewed operator/project, active deliveries,
   source records, release inventory, exact Rules and propagation before activation.
4. Verify an operator with zero hotel memberships lands on `/platform`. Verify a
   normal hotel user cannot enter it, and an operator without membership cannot read
   operational Firestore/Storage data. Verify live claim revocation and disabled
   operators lose callable access. Check these with real production identities.
5. Create a reviewed hotel via the console, assign its subscription, appoint named
   administrators, and verify the operator receives no employee membership. Verify
   real invite delivery and ordinary-user workflows without sending test customer mail.
6. Configure each hotel's explicit import expectations. Check actual source receipt,
   business date, count, required model, missing/empty/stalled states, incident
   acknowledgment and a subsequent successful delivery. Confirm the scheduled job
   runs and its rotation/freshness fit the connected hotel count.
7. Verify support actor/hotel scoping and expiration, and perform only an explicitly
   reviewed real import recovery. Check the exact object generation and checkpoint
   preservation. Perform desktop/mobile browser acceptance and review backup retention.

Production deployment, Rules activation, real provider delivery, GCS behavior and
browser acceptance remain separate from passing local tests. No production settings,
source rows, memberships, subscriptions, merge or deployment were changed here.
