# Purchase Requests

Purchase Requests add internal purchasing decisions to Purchasing & Inventory. Each purchase line selects its own supplier, so one request can cover several suppliers. The combined request reserves one monthly category budget and follows named, ordered approval steps. Final approval records a commitment; it does not send supplier orders, receive goods, change inventory or recognize an invoice cost.

## Hotel setup

1. Grant the relevant team members the **Purchase Requester**, **Purchase Approver** or **Budget Manager** permissions within the active Purchasing & Inventory module. Approver permission alone does not grant unlimited financial authority.
2. Open **Module settings → Purchase Requests** (`/settings/procurement?section=purchase-requests`). Choose the hotel's single budget currency and over-budget policy.
3. Configure **Cost centres**, which identify the responsible department/accounting centre, separately from **Budget categories**, which identify the type of expense. A Front Office purchase can, for example, use the Maintenance budget category. These lists use stable IDs; they are independent of physical inventory outlets and locations. Labels may change without rewriting old requests.
4. Add the required approval steps in order. **Required from** is a minimum amount that activates a control; **Request limit** on a person is the maximum full request amount that person may review. For example, a Finance control required from EUR 1,000 and a person with a EUR 5,000 limit covers requests from EUR 1,000 through EUR 5,000. A threshold of `0.00` makes the step apply to every submitted request. A threshold of `1,000.00` adds the step for requests totalling at least that amount. Configure at least one applicable step for every intended request amount. Top-to-bottom order also defines the next higher step for the requester-only escalation described below.
5. Add eligible hotel members as approval authorities. Select their authorized steps and set a net amount limit covering the entire request, rather than only its increment. The optional additional budget authority permits the extra over-budget approval; it does not bypass the normal steps or limit.
6. Set **Department approval assignments**, optional designated substitutes and any controls that must remain independent after self-approval. Review the configuration warnings.
7. Open **Purchase budgets** (`/purchase-budgets`) and enter the allocations for each category and month. Add opening consumption for money already spent before adopting the workflow.

Every financial value is **net, excluding VAT**. The initial implementation supports EUR, USD, GBP, CHF, CAD and AUD, all using two decimal currency places. It does not convert currencies. Currency becomes locked when the first budget or request is saved.

**Purchase budgets** opens in **By month** view: choose a year and month to see all budget categories together, their allocations, opening consumption, pending requests, approved commitments and remaining amounts. The summary totals cover that month across categories. Switch to **By category** for the selected category's twelve-month view and annual totals. Both views edit the same draft; switching the view, month or category preserves unsaved changes. On small screens the allocation rows display as labelled cards.

Totals clearly identify their scope and reflect draft allocations/opening amounts together with saved request reservations and commitments. When allocations are missing or invalid, the known allocation subtotal is labelled and complete remaining funds stay unavailable. A blank allocation means **not configured** and differs from an explicit `0.00` allocation. Missing budgets prevent submission. Existing allocations cannot be cleared to make them disappear; use an explicit zero if appropriate.

**Copy allocations** applies one month's allocation to selected months, or copies the same category's allocations from another year. These operations change a draft. Review and save before they take effect. Opening consumption, pending amounts and approved commitments are never copied. Changing the year is paused while there are unsaved changes or an uncertain save.

Save up to 240 changed monthly allocations together. The page shows the count across categories and offers a category-specific discard action when a draft needs to be reduced before saving.

Saved category and cost-centre IDs already referenced by requests cannot be removed. Create new entries for genuinely different accounting concepts instead of renaming an existing entry to mean something else.

## Daily workflow

1. Open **Purchase Requests**, create a draft and select the cost centre, budget category and explicit budget month. Enter a title and business reason; use **Additional description** for optional request-wide specifications. Existing descriptions remain available when editing.
2. Select a **Supplier** and **Purchase unit** directly on each purchase line. Use **Choose supplier product** to find that supplier's products and purchase options, or enter services, repairs and uncatalogued goods as free lines. Different lines can select different suppliers. Review each quoted net unit price and quantity. A supplier price in another currency must not be treated as the hotel's budget currency.
3. Expand **Attachments** after saving the draft to add quotes or other supporting documents. Save again to attach uploaded documents to the request revision. Up to ten documents of 10 MiB each are supported: PDF, PNG, JPEG, DOCX, XLSX, TXT and CSV. Documents download as private attachments rather than executable previews.
4. Review the budget impact and the entire server-checked approval route. The selected cost centre determines the department approvers. One eligible person is selected automatically; several eligible people require a choice. Submission reserves the request total as pending. The chosen budget month stays fixed even when approvals happen later.
5. The current approver reviews the frozen request and its budget impact. They approve, reject or return it with a decision note. When another step is required, its sole eligible approver is selected automatically; otherwise they choose from people who keep the remaining route possible. The server checks membership, current permission, financial limit, step authority and the remaining sequence again at the action boundary.
6. Final approval moves pending budget into approved commitments. Rejection, withdrawal and cancellation release the associated amount. Returned requests keep their reservation while the requester makes corrections; resubmission adjusts that reservation to the newly submitted amount.

A standard approver cannot approve their own request, skip a required step or approve multiple steps of the same request. Direct self-approval is a separate explicitly granted action described below. Select separate authorized people for successive steps. An over-budget request in **Require additional budget authority** mode adds a final required budget-approval step; **Block submission** mode refuses the excess instead.

An unfinished draft can leave a line's supplier unselected; submission requires
a supplier for every line. The product picker is scoped to the selected line and
supplier. Changing a line's supplier clears its linked product, purchase option
and quoted price, so the previous supplier's values are not silently reused.
Descriptions and quantities, and all other lines, remain available. Choose the
new product or enter a fresh quotation before saving the completed line.

The list and request summary identify multiple suppliers, and current/frozen
line details show their saved supplier names. Existing requests retain their
original supplier and price evidence; editing an older draft initially shows its
previous shared supplier on the corresponding lines. Approval thresholds and
financial authority apply to the **combined request total**, not separate
supplier subtotals. The budget month, category, cost centre and currency remain
request-level choices.

The list supports status, month, cost centre and **Awaiting my approval** filters. The details show the submitted information, attachments, current approver, budget state and decision/change timeline. Email links open this authenticated workflow and do not grant approval rights themselves.

The draft form has a bounded desktop width while keeping the navigation visible. General request details use two columns on desktop, with a compact month field. Each purchase line shows its description, supplier, quantity, purchase unit, net unit price and total together in one desktop row. On smaller screens these fields stack with visible labels; supplier and unit are always directly editable. Quotation and currency warnings stay visible. The request total and budget impact appear together. A missing price displays an unavailable total rather than zero, and the save actions remain in the normal page flow so they do not cover editable fields. Saving still leads to the request details for review; it never submits the request automatically.

### When the requester is the only first-step approver

Submission checks the first applicable step against current hotel membership,
approval permissions, verified active accounts and authority for the entire net
request amount. If the requester is its only eligible approver, the request is
escalated to the **immediately following configured step**. The higher step is
required even when the amount is below its normal threshold. If another eligible
first-step approver exists, the ordinary route remains required.

For example, configure **Department approval** from EUR 0, **Finance approval**
from EUR 1,000 and **General Manager approval** from EUR 5,000. A department head
who is the only eligible Department approver submits EUR 400 to an independent
Finance approver. For EUR 7,500, Finance approval is followed by a different
General Manager approver. Department approval is recorded as escalated, never as
self-approved; Finance does not appear twice in the route.

The exception does not skip further unavailable steps or grant financial
authority. If there is no next configured step or no independent eligible person
for it, submission stays blocked with an explanation. Configure another approver
or an appropriate higher step. Actual approval steps still require different
people, and any additional over-budget approval remains separate and mandatory.

The submission dialog previews the server-calculated route and escalation before
the requester chooses the first approver. Submission recalculates current
authority and rejects a stale reviewed route. A successful submission freezes the
escalation reason, original and promoted step names/IDs and settings revision in
its request history. Existing pending and historical routes are not rewritten;
returning, revising or resubmitting a request requires a fresh routing decision.

## Department assignments and complete routes

Under **Department approval assignments**, choose **Department-specific approvers** for each cost centre. Its heads must hold authority for the first configured step; set that step's **Required from** to `0.00`. Add named department substitutes when needed. New cost centres start with an empty department-specific assignment, which requires configuration. Existing cost centres retain their **All first-step approvers** setting until an administrator changes it; a configuration notice calls this out.

Each step can also have **designated substitutes** and one **higher approval level** selected from later steps. These explicit alternatives perform the original control. They need current hotel membership, verified active accounts, explicit `purchaserequests.approve`, read permission and a Request limit covering the entire net request. Designation as a substitute supplies authority for that control; it does not grant an action permission or increase a financial limit. A higher-level alternative needs authority for the referenced higher step. Neither alternative removes another required control. The same person cannot perform both the replacement control and a separately required later control.

Before any reservation, the server checks whether different eligible people can complete **all** required controls. It excludes the requester from every standard step, including later steps. Matching also filters out an early choice that would consume the only person available for a later step. For example, if Alex can approve Department and Finance while Robin can only approve Department, a request requiring both controls starts with Robin, leaving Alex for Finance.

The detail page shows the checked sequence and the eligible people, including substitute and higher-level labels. A sole viable person is assigned automatically when their step starts. Multiple viable people require a choice at that hand-off. Future candidates are a feasibility check, not an advance approval or guaranteed availability reservation. The server checks current accounts, permissions, limits and the complete remaining sequence again before each approval. Unknown account lookup failures block the transition. A change after submission can require an administrator to restore authority or configure a substitute; the requester can also withdraw or open a revision. A required control is never silently dropped to recover a blocked route.

Settings include warnings about missing department assignments, controls without sufficient authority, missing additional budget authority and insufficient distinct people. These draft diagnostics supplement the authoritative request check; account changes, the actual request amount and the requester can still make a specific route unavailable.

## Direct self-approval: Approve & register

1. A hotel administrator grants **Purchase Requests → Self-approve** (`purchaserequests.selfapprove`) in the member's advanced permissions. It is not inherited from `purchaserequests.*`, ordinary Approve permission, or existing module roles.
2. A settings manager enables a separate **Self-approval limit** for that person in **Approval authorities**. Saving a limit verifies the explicit permission and active verified account. A settings grant cannot itself grant the permission. The ordinary Request limit remains separate.
3. The requester saves and reviews their draft, selects **Approve & register**, and enters a required decision reason. The server verifies ownership, permission, the full net amount against that limit, attachments, currency and the current budget in the same transaction.

Direct self-approval covers the applicable ordinary controls. A control marked **Always require an independent person, including after direct self-approval** still needs another person when its amount threshold applies. Additional over-budget approval always remains independent, even if the requester also has additional budget authority. Independent reviewers must be distinct from each other and the requester. Missing budgets and **Block submission** overruns still prevent registration.

With no remaining independent control, the transaction records an approved commitment directly. With independent controls, it records the self-approval and reserves the full amount as pending, notifying the first independent reviewer. Only the last independent approval transfers pending to committed. No temporary double debit is introduced.

The immutable history records a `selfapprove` or `selfapproved` event, actor, time, reason, settings revision, self-approval limit and the ordinary controls covered. Subsequent independent decisions retain their own actors and authority sources. Returns and revisions clear active self-approval evidence and require a fresh decision while keeping earlier snapshots. Exact command retries return the original receipt, including after reload or restore, without another commitment or notification.

## Budget accounting

For a category/month:

```text
available = allocation − opening consumption − pending requests − approved commitments
```

With a €500 allocation, €300 approved and €150 pending, €50 remains. Approving the €150 changes the split to €450 approved and €0 pending, leaving the same €50 available.

| Request state/action | Budget effect |
| --- | --- |
| Draft | No reservation |
| Direct self-approval without independent controls | Commit directly, adjusting any held returned reservation once |
| Self-approval with independent controls | Reserve as pending until the final independent decision |
| Submit | Reserve the submitted amount as pending |
| Intermediate approval | Keep the pending reservation |
| Final approval | Transfer the same amount from pending to approved commitments |
| Return for changes | Keep the pending reservation |
| Resubmit returned request | Adjust the held reservation to the new amount and restart applicable approvals |
| Reject, withdraw or cancel | Release the reservation or commitment |
| Revise an approved request | Preserve the prior decision evidence and require a fresh applicable approval cycle |

Budgets and request transitions use server transactions. Concurrent submissions cannot each reserve the same last available funds; budget managers also submit the revision they reviewed before changing an allocation or opening amount. A concurrent change fails visibly instead of overwriting the newer ledger.

An insufficient allocation is an approval policy question, not an invoice accounting event. Approved commitments remain separate from opening consumption so a later order/invoice integration can reconcile or transfer a commitment instead of subtracting it a second time. No such automatic reconciliation is introduced here.

## Prices, changes and recovery

Submission freezes the request's lines, each line's supplier identity/name and selected package information, quantities, net prices, budget month and decision requirements. Subsequent catalog imports, supplier renames and supplier price updates do not rewrite submitted evidence. An explicit revision follows the approval process again and retains earlier revisions and attachment evidence.

The browser retains the exact command reference and input when a save has an uncertain result. **Verify original save** retries that operation before another edit is allowed. A timeout is not evidence that an operation failed. Replaying an acknowledged command returns the same result, without reserving budget or sending decision notifications twice.

Hotel or signed-in user changes reset local forms and ignore late responses from the previous scope. Settings authority lists are exposed only to settings users; budget readers receive the category labels needed for the budget view without that configuration access.

## Notifications and deployment configuration

Purchase Request decisions reuse the hotel-scoped mail queue and existing Resend transport. Submission and hand-off notify the current approver, including configured substitutes and higher authorities. Self-approval with independent controls notifies the independent reviewer; direct registration notifies the requester and identifies it as self-approved. Final approval, rejection and return notify the requester. Mail is queued with the database transition, then checked against the current request revision, recipient membership and approval authority before provider delivery. Superseded notifications are blocked.

The environment must already provide:

- `RESEND_API_KEY`, with a valid Resend account and permission to send from the configured sender.
- `RESEND_FROM`, on a verified sender domain.
- `APP_BASE_URL`, set to the application's explicit HTTPS address so request links point to the correct environment.
- The existing mail-queue trigger, new request/document endpoints, reviewed Firestore/Storage rules and a subscription granting the Purchasing & Inventory module.

Failed notifications with no provider attempt can be explicitly recovered through the notification workflow. An ambiguous provider result requires operator review before another send. Email transport acceptance is distinct from final delivery to a person's inbox.

New request and budget data is hotel-scoped. The canonical records are `hotels/{hotelUid}/settings/purchaseRequests`, `purchaseBudgets/{YYYY-MM}__{categoryId}`, `purchaseRequests/{requestId}` and `purchaseRequestOperations/{operationId}`. Request revision evidence is stored below the request's `history` collection. Browser clients cannot directly mutate the request ledger, settings, immutable revision evidence, command receipts or private attachment objects. Every server entry point rechecks the hotel membership, active module/subscription and exact action permission. Attachment downloads verify both the requested revision and the retained object generation/hash.

Deployment and actual Resend delivery require the normal environment release process; local tests do not configure production credentials or certify external inbox delivery.

## Exception recovery

Assign the **Purchase Recovery Manager** hotel role, or explicitly grant
`purchaserequests.read` and `purchaserequests.recover`, to the people responsible
for abandoned or blocked requests. A wildcard, ordinary approver role or budget
settings permission does not grant recovery authority. This role does not grant
approval, self-approval, requester editing or budget-setting rights.

Open a request's **Exception recovery** section. **Reassign approver** is available
for pending steps. Refresh the checked recovery route, select an eligible
replacement and enter the required reason. The replacement can cover an absence
even if the original approver still has access; a lost account or membership does
not need to be restored first. The server checks current hotel membership, active
verified account, read and approval rights, department assignments or explicit
substitutes, and the financial limit for the entire request. It also checks that
different eligible people can still complete all remaining controls. The
requester and anyone who already approved this version cannot be replacements.

Reassignment changes responsibility for the current step. It retains earlier
approvals, the frozen required steps, independent controls following explicit
self-approval and any required additional budget approval. A newly necessary
additional budget control is included. Reassignment never records an approval or
changes the reserved amount. If the current budget policy blocks an overrun, the
replacement still cannot approve until a budget manager resolves it. An
unavailable mandatory control is explained; configure a valid substitute or
cancel the abandoned request instead of skipping the control.

**Cancel for recovery** closes a pending or returned request, including one whose
requester and approver both left the hotel. Enter why the request cannot proceed.
Cancellation releases its actual pending reservation in the same transaction,
including the old submitted amount when an edited returned draft has a different
total. Recovery cannot cancel approved commitments; those retain the existing
requester cancellation workflow.

The summary identifies the current responsible person. The timeline keeps the
original assignment, each transfer, actor, time and required reason, alongside
immutable submitted versions and earlier approvals. Recovery notifications are
queued for the requester, previous and new approver where applicable, and the
recovery manager. Delivery rechecks current membership, verified account and read
access; approval notifications additionally recheck approval authority. Departed
users receive no request details. A newer revision supersedes an old queued
responsibility update. Recovery managers can also retry current notification
failures only when no provider attempt occurred.

Concurrent approvals, cancellations and reassignments compete for the same
request revision. Only one can commit; the other user must refresh. If a response
is lost, **Recover original action** reuses its original command and receipt,
without a second transfer, reservation release or set of notifications.

No data migration is required. Existing pending routes and historic snapshots
are preserved. Release the updated Functions, generated Firestore Rules and
frontend together through the normal release process, then explicitly assign
the recovery role to the intended hotel members. Recovery actions remain hidden
from members without that grant.

## Current limits and future integrations

- Up to eight ordered approval steps; each step needs a different authorized person. This is a deliberate simple sequence with optional amount thresholds rather than a general workflow builder.
- One net budget currency per hotel; no FX conversion, recoverable-VAT calculation or invoice posting.
- Budgets are monthly per expense category; cost centres select department approval and support classification/filtering; they are not an additional budget allocation axis.
- Quotes and request prices are explicit reviewed inputs. Supplier synchronization, purchase orders, invoice matching and actual-cost reconciliation can consume the immutable request/version references later, but do not run automatically.
- Document bytes are validated and served privately; this is not an antivirus scanning or document-conversion service.

## Verification

The extension includes focused checks for exact decimal-to-minor conversions, missing/zero allocations, opening-consumption changes, copy controls, stable settings IDs, required step ordering, permission-specific reads, late hotel responses and original-command recovery. Backend, Rules and restore suites cover the request lifecycle, reservation transfers, concurrent actions, immutable evidence and hotel separation. The pull request records the checks executed for its final revision.
