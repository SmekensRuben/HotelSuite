# Purchasing & Inventory exception recovery

Work package 2 extends the existing request, order and inventory workflows. It
retains work package 1's exact pending commands, scoped drafts, optimistic
revisions and immutable historical evidence. All new actions are in English.

## Hotel responsibilities

| Role or explicit grant | Available recovery |
| --- | --- |
| Purchase Recovery Manager (`purchaserequests.read` + `purchaserequests.recover`) | Reassign the pending approval step to a currently eligible replacement; cancel a pending or returned request and release its held reservation. A reason is required. |
| Order Delivery Recovery Manager (`orders.read` + `orders.recover`) | Review dispatch evidence, record findings, or resolve a verified receipt. Source, evidence and reason are required. |
| Delivery recovery manager with `orders.approve` and current outlet approver designation | Retry preparation only when durable evidence proves no external send was attempted. |
| Stock count reader (`stockcounts.read`) | Inspect concrete counting and period exceptions, source events and unresolved evidence. |
| Existing counting, receiving and inventory roles | Create a follow-up count, review a receipt, or record a compensating movement through the existing permission-checked workflow. Receipt and movement reversals retain their separate supervisor grants. |

Hotel administration, wildcard permissions and ordinary approval roles do not
automatically grant either recovery permission. A recovery role supplies no
self-approval, budget-editing or general order-approval authority.

Purchase Request details and role setup are documented in
[Purchase Requests](purchase-requests.md). Delivery states and evidence are
documented in [Order delivery recovery](order-delivery-recovery.md). Inventory evidence and correction
policies are documented in [Catalog and periodic inventory](catalog-periodic-inventory.md).

## Safety boundaries

- Reassignment preserves completed approvals and every required control. Current
  account, membership, department, amount limit, separation and remaining route
  feasibility are checked again by the server. Request recovery cannot approve
  the request, bypass an overrun or cancel an approved commitment.
- A possible email or SFTP attempt is recorded durably before the external side
  effect. Unknown delivery never permits an automatic retry. Recording a receipt
  does not send anything, and transport or supplier receipt is distinct from
  commercial supplier acceptance.
- Recovery actions use the reviewed revision and an exact command receipt. A
  lost response is recovered with the same command. Concurrent decisions and
  delayed workers cannot overwrite a completed recovery or create another send.
- Inventory exception review is read-only. Viewing an event cannot clear an
  uncertain cutoff. Corrections append compensating evidence and follow-up
  counts establish future baselines; completed counts and saved period numbers
  are not rewritten.

## Release procedure

No historical data backfill or migration is required. Existing permissions are
not expanded automatically. Missing legacy dispatch or cutoff evidence remains
explicitly unavailable and requires review.

1. Run the normal repository verification and reviewed release process. Publish
   the updated Functions and generated Firestore Rules before exposing the new frontend. New
   callable exports are `getHotelOrderDelivery` and `getHotelStockCountExceptions`.
   Include the changed order dispatch/mail workers, request/notification handlers
   and inventory handlers in the Functions release.
2. Create the additive `orderAudit` composite index from
   `firebase/firestore.indexes.json`: collection scope, `orderId ASCENDING`, then
   `revision DESCENDING`. Wait for it to be READY before exposing delivery
   history. The inventory-only index preparation helper accepts this exact
   shared-manifest definition but deliberately does not deploy it; publish it
   through the reviewed index release process. Preserve existing indexes.
3. Allow invocations of the old mail/SFTP workers to drain before enabling
   recovery users; running old code does not have the durable attempt fence.
   Explicitly assign the intended recovery roles using the existing hotel user
   management workflow. Add order approval and outlet designation separately
   only for recovery managers who may retry preparation. Retain the existing
   module subscription and SaaS release gate.
4. Verify an ordinary hotel user's reassignment and abandoned-request
   cancellation, an unknown dispatch with no resend, and a count with a late
   receipt. Verify denial from a second hotel and inspect the recorded reasons,
   assignments, budget effect and retained evidence.

Local verification does not deploy production, change live grants, or establish
real supplier acceptance. Purchase Request-to-Order linkage, new reporting,
monitoring expansion and capacity work remain outside this package.

## Verification

The completed work package passed the repository checks with Node 22.23.3 and
npm 10.9.9:

- Frontend: 198 test files, 2,056 tests.
- Functions: 1,043 tests.
- Firebase emulator security: 372 tests, including explicit recovery grants,
  hotel isolation, immutable evidence, concurrent actions and exact retries.
- Two-hotel Firestore/Auth/Storage backup, export, import and restore smoke test.
- Lint, incremental type checking, non-production build, generated Rules check,
  migration safeguards and dependency policy audit.

Focused recovery tests cover a departed approver's replacement, cancellation
after both requester and approver leave, approval/reassignment conflicts,
uncertain delivery after an external attempt, and movements during or after a
count. No production deployment or live role assignment was performed.
