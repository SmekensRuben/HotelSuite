# Purchase Requests

Purchase Requests add internal purchasing decisions to Purchasing & Inventory. A request reserves a monthly category budget and follows named, ordered approval steps. Final approval records a commitment; it does not send a supplier order, receive goods, change inventory or recognize an invoice cost.

## Hotel setup

1. Grant the relevant team members the **Purchase Requester**, **Purchase Approver** or **Budget Manager** permissions within the active Purchasing & Inventory module. Approver permission alone does not grant unlimited financial authority.
2. Open **Module settings → Purchase Requests** (`/settings/procurement?section=purchase-requests`). Choose the hotel's single budget currency and over-budget policy.
3. Configure **Cost centres**, which identify the responsible department/accounting centre, separately from **Budget categories**, which identify the type of expense. A Front Office purchase can, for example, use the Maintenance budget category. These lists use stable IDs; they are independent of physical inventory outlets and locations. Labels may change without rewriting old requests.
4. Add the required approval steps in order. A threshold of `0.00` makes the step apply to every submitted request. A threshold of `1,000.00` adds the step for requests totalling at least that amount. Configure at least one applicable step for every intended request amount. Top-to-bottom order also defines the next higher step for the requester-only escalation described below.
5. Add eligible hotel members as approval authorities. Select their authorized steps and set a net amount limit covering the entire request, rather than only its increment. The optional additional budget authority permits the extra over-budget approval; it does not bypass the normal steps or limit.
6. Open **Purchase budgets** (`/purchase-budgets`) and enter the allocations for each category and month. Add opening consumption for money already spent before adopting the workflow.

Every financial value is **net, excluding VAT**. The initial implementation supports EUR, USD, GBP, CHF, CAD and AUD, all using two decimal currency places. It does not convert currencies. Currency becomes locked when the first budget or request is saved.

**Purchase budgets** opens in **By month** view: choose a year and month to see all budget categories together, their allocations, opening consumption, pending requests, approved commitments and remaining amounts. The summary totals cover that month across categories. Switch to **By category** for the selected category's twelve-month view and annual totals. Both views edit the same draft; switching the view, month or category preserves unsaved changes. On small screens the allocation rows display as labelled cards.

Totals clearly identify their scope and reflect draft allocations/opening amounts together with saved request reservations and commitments. When allocations are missing or invalid, the known allocation subtotal is labelled and complete remaining funds stay unavailable. A blank allocation means **not configured** and differs from an explicit `0.00` allocation. Missing budgets prevent submission. Existing allocations cannot be cleared to make them disappear; use an explicit zero if appropriate.

**Copy allocations** applies one month's allocation to selected months, or copies the same category's allocations from another year. These operations change a draft. Review and save before they take effect. Opening consumption, pending amounts and approved commitments are never copied. Changing the year is paused while there are unsaved changes or an uncertain save.

Save up to 240 changed monthly allocations together. The page shows the count across categories and offers a category-specific discard action when a draft needs to be reduced before saving.

Saved category and cost-centre IDs already referenced by requests cannot be removed. Create new entries for genuinely different accounting concepts instead of renaming an existing entry to mean something else.

## Daily workflow

1. Open **Purchase Requests**, create a draft and select the supplier, cost centre, budget category and explicit budget month. Enter a title, description and business reason.
2. Add supplier products and their purchase options, or free lines for services, repairs and uncatalogued goods. Review each quoted net unit price and quantity. A supplier price in another currency must not be treated as the hotel's budget currency.
3. Save the draft before adding quotes or other supporting documents. Save again to attach uploaded documents to the request revision. Up to ten documents of 10 MiB each are supported: PDF, PNG, JPEG, DOCX, XLSX, TXT and CSV. Documents download as private attachments rather than executable previews.
4. Review the budget impact and choose a first eligible approver. Submission reserves the request total as pending. The chosen budget month stays fixed even when approvals happen later.
5. The current approver reviews the frozen request and its budget impact. They approve, reject or return it with a decision note. When another step is required, they choose an eligible next approver. The server checks membership, current permission, financial limit, step authority and the remaining sequence again at the action boundary.
6. Final approval moves pending budget into approved commitments. Rejection, withdrawal and cancellation release the associated amount. Returned requests keep their reservation while the requester makes corrections; resubmission adjusts that reservation to the newly submitted amount.

An approver cannot approve their own request, skip a required step or approve multiple steps of the same request. Select separate authorized people for successive steps. An over-budget request in **Require additional budget authority** mode adds a final required budget-approval step; **Block submission** mode refuses the excess instead.

The list supports status, month, cost centre and **Awaiting my approval** filters. The details show the submitted information, attachments, current approver, budget state and decision/change timeline. Email links open this authenticated workflow and do not grant approval rights themselves.

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

## Budget accounting

For a category/month:

```text
available = allocation − opening consumption − pending requests − approved commitments
```

With a €500 allocation, €300 approved and €150 pending, €50 remains. Approving the €150 changes the split to €450 approved and €0 pending, leaving the same €50 available.

| Request state/action | Budget effect |
| --- | --- |
| Draft | No reservation |
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

Submission freezes the request's lines, selected supplier/package information, quantities, net prices, budget month and decision requirements. Subsequent catalog imports and supplier price updates do not rewrite submitted evidence. An explicit revision follows the approval process again and retains earlier revisions and attachment evidence.

The browser retains the exact command reference and input when a save has an uncertain result. **Verify original save** retries that operation before another edit is allowed. A timeout is not evidence that an operation failed. Replaying an acknowledged command returns the same result, without reserving budget or sending decision notifications twice.

Hotel or signed-in user changes reset local forms and ignore late responses from the previous scope. Settings authority lists are exposed only to settings users; budget readers receive the category labels needed for the budget view without that configuration access.

## Notifications and deployment configuration

Purchase Request decisions reuse the hotel-scoped mail queue and existing Resend transport. Submission and hand-off notify the current approver. Final approval, rejection and return notify the requester. Mail is queued with the database transition, then checked against the current request revision, recipient membership and approval authority before provider delivery. Superseded notifications are blocked.

The environment must already provide:

- `RESEND_API_KEY`, with a valid Resend account and permission to send from the configured sender.
- `RESEND_FROM`, on a verified sender domain.
- `APP_BASE_URL`, set to the application's explicit HTTPS address so request links point to the correct environment.
- The existing mail-queue trigger, new request/document endpoints, reviewed Firestore/Storage rules and a subscription granting the Purchasing & Inventory module.

Failed notifications with no provider attempt can be explicitly recovered through the notification workflow. An ambiguous provider result requires operator review before another send. Email transport acceptance is distinct from final delivery to a person's inbox.

New request and budget data is hotel-scoped. The canonical records are `hotels/{hotelUid}/settings/purchaseRequests`, `purchaseBudgets/{YYYY-MM}__{categoryId}`, `purchaseRequests/{requestId}` and `purchaseRequestOperations/{operationId}`. Request revision evidence is stored below the request's `history` collection. Browser clients cannot directly mutate the request ledger, settings, immutable revision evidence, command receipts or private attachment objects. Every server entry point rechecks the hotel membership, active module/subscription and exact action permission. Attachment downloads verify both the requested revision and the retained object generation/hash.

Deployment and actual Resend delivery require the normal environment release process; local tests do not configure production credentials or certify external inbox delivery.

## Current limits and future integrations

- Up to eight ordered approval steps; each step needs a different authorized person. This is a deliberate simple sequence with optional amount thresholds rather than a general workflow builder.
- One net budget currency per hotel; no FX conversion, recoverable-VAT calculation or invoice posting.
- Budgets are monthly per expense category; cost centres are classification and filtering dimensions, not an additional budget allocation axis.
- Quotes and request prices are explicit reviewed inputs. Supplier synchronization, purchase orders, invoice matching and actual-cost reconciliation can consume the immutable request/version references later, but do not run automatically.
- Document bytes are validated and served privately; this is not an antivirus scanning or document-conversion service.

## Verification

The extension includes focused checks for exact decimal-to-minor conversions, missing/zero allocations, opening-consumption changes, copy controls, stable settings IDs, required step ordering, permission-specific reads, late hotel responses and original-command recovery. Backend, Rules and restore suites cover the request lifecycle, reservation transfers, concurrent actions, immutable evidence and hotel separation. The pull request records the checks executed for its final revision.
