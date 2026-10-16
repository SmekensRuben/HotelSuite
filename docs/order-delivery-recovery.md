# Order delivery exceptions and recovery

Delivery review is part of the existing order detail page. The platform support
screen points operators to the same workflow. Supplier confirmation remains a
separate workflow: provider acceptance, an SFTP file transfer, and a supplier's
acknowledgement of receipt do not establish commercial acceptance.

## States and safe actions

| Evidence state | Meaning | Available recovery |
| --- | --- | --- |
| Preparation failed | A terminal failed/blocked dispatch explicitly records `externalAttempt: false`. Any existing mail queue entry must independently prove the same before retry. | Record configuration findings; retry preparation after correcting configuration/access. |
| Transport accepted | An email provider acknowledged the message, an SFTP transfer completed, or a reviewer verified that transport receipt. | Read evidence/history; record supplier responses separately. |
| Supplier receipt verified | An authorized reviewer recorded positive evidence that the supplier received the original order. | Continue using the original order; record acceptance or proposed changes separately. |
| Outcome unknown | The transport may have received the order, a stale worker needs review, or legacy evidence does not prove no send occurred. | Record findings without resolving uncertainty, or record a verified transport/supplier receipt. Never automatically resend. |
| In progress | The current worker has not completed or passed the ten-minute review window. | Wait and refresh. |

The user-facing review displays the original order/dispatch references, reported
problem, transport receipt when available, and recovery history. Every recovery
requires an explicit source, evidence reference or findings, and reason. Supplier
contact used as a verified receipt should identify the contact, time, and original
order reference confirmed as received. Negative or inconclusive findings remain
unresolved; they never authorize a resend. Read-only users see which permission is
needed and the safe next step.

## Permissions and safeguards

`orders.read` grants scoped evidence/history access. The additive **Order Delivery
Recovery Manager** role grants `orders.read` and the explicit `orders.recover`
permission. The wildcard `orders.*` does not grant recovery. A hotel member with
recovery permission may register evidence; a preparation retry additionally
requires current `orders.approve` permission and designation as an approver for
the original order's outlet. The replacement dispatch records this current actor
and preserves the original order/supplier snapshot. Platform administrators retain
the existing operator boundary; their retry requires the original designated
approver still to be eligible. All hotel actions require a current verified account,
hotel membership, active procurement subscription, and rollout eligibility.

Email and SFTP workers persist an external-attempt fence before a possible side
effect. A recovered or replaced worker cannot cross that fence. A lost fence
response remains uncertain; a later failure cannot downgrade it to safe preparation
failure. Mail queue and dispatch recovery state changes are committed together.
Late worker success/failure cannot overwrite a recorded recovery decision. SFTP
continues using the stable original order filename and verifies an existing file
rather than uploading another copy.

Recovery command IDs bind the actor, hotel, order and exact reviewed payload.
Repeated commands return their original receipt; conflicting payloads fail.
Concurrent reviewers use the order revision and dispatch transaction to produce
one decision. The browser saves the entire request before calling, retains it after
an uncertain response and retries that same command across remounts. It releases a
rejected command only when a fresh authorized server read proves the operation has
no audit receipt. Findings alone preserve a known preparation failure and its safe
retry eligibility; findings about an uncertain stale worker retire that worker and
keep the outcome unknown.

## Deployment and verification

No order or audit backfill is required. Existing audit events remain available;
legacy fields are labeled as legacy instead of being invented. Unknown legacy
attempts never become retryable automatically. Deploy the `orderAudit` composite
index (`orderId ASC`, `revision DESC`) and backend changes before the frontend.
Include `getHotelOrderDelivery`, `reviewHotelOrderDelivery`, the order confirmation
function, SFTP dispatch worker and mail queue worker in the coordinated release.
Allow invocations of the old worker code to drain before enabling recovery users;
those invocations do not have the new durable fence. Assign the new recovery role
explicitly. Nothing grants approval or outlet designation automatically.

Focused Node regressions exercise SFTP and email timeouts after possible delivery,
request replay, conflicting review decisions, preparation retry by a current
replacement approver, lost fence acknowledgement, receipt registration during a
running mail call, supplier receipt evidence without acceptance, and tenant/role
checks. UI tests cover actionable guidance, evidence/history, transport versus
supplier acceptance, and preserved uncertain commands. Emulator tests validate
real Firestore/Auth authorization, protected evidence paths, concurrency and the
durable fence.
