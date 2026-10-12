# Guided hotel setup and goods receiving

## Hotel setup

Open **Platform → Hotels → Set up a hotel** (`/platform/hotels/new`). Enter the
property's name, permanent ID, IANA time zone and explicit modules/access period.
Creation does not make the platform operator an employee or declare the hotel ready.
Invite a primary and backup hotel administrator. Give operational roles separately.
Hotel administrators continue managing their own team from **Hotel Team**.

The setup checklist is also on each platform hotel detail page. Refresh it after
account verification, role assignment or configuration changes. It reports:

- The project-wide release gate and the current subscription/module assignment.
- Auth/profile/member consistency for the selected hotel only; invalid records are
  listed for review. The check never repairs access, deletes identities or credentials.
- Two consistent enabled/verified administrators and pending email verification.
- Property time zone and currency; purchasing source records and stock-template
  presence; enabled/verified users covering the operational workflows.
- Validated active delivery schedules for every inspected enabled import source.
  Import health and source/template content validation are separate checks.

Only the current platform administrator can obtain this report. Ordinary hotel
administrators cannot inspect other accounts through the platform endpoint. Legacy
profile links for platform-only operators do not imply employee memberships.
Auth/IAM/provider failures are errors, never account-not-found or empty success.

Inspection is bounded: 500 members and assigned profiles, 25 outlets, 100 each of
suppliers/products/locations/import types/monitors, 20 approvers per inspected outlet
and the latest 10 invitations. Missing identities/profiles are read by member ID;
Auth batches contain at most 100 IDs. Incomplete identity/import inspection is unknown.
Usable basic purchasing configuration can be proven from a bounded sample; the UI
labels sample counts rather than presenting them as global totals. Absence cannot
be inferred from an incomplete sample. The report is dated advice, not a grant,
activation flag or certification of all catalog/stock-template/business values.

## Receiving roles

Assign these explicitly in **Hotel Team → Module roles** for a hotel licensed for
**Purchasing & Inventory**:

| Role | Authority |
| --- | --- |
| Receiver | Order read and goods receipt recording (`orders.receive`) |
| Receiving Supervisor | Receiver authority, receipt reversal and receiving closure (`orders.finalize`) |

Existing Buyer, Approver, Stock Controller and Module Manager presets are preserved.
The two receiving actions require exact grants: historical `orders.*` does not confer
new receiving authority. Other historical wildcard actions retain their semantics.
An administrator can combine roles; no existing membership is automatically rewritten.

## Receive, correct and close an order

1. Use the existing approval/dispatch workflow. Receiving begins only for a
   confirmed Ordered order with a known frozen product/unit/quantity snapshot.
2. Open the order and its **Goods receiving** panel. Enter the receipt business date,
   a unique delivery reference and accepted/rejected quantities in the ordered purchase
   units. Up to three decimals are supported. The calendar defaults to today only when
   the hotel's time zone is known; otherwise the business date must be entered.
3. Record partial deliveries independently. Accepted quantities fulfill the order;
   rejected goods do not. Rejections and accepted overdelivery require line reasons.
   Outstanding/excess quantities and discrepancies stay visible. Complete accepted
   quantities move the order to Received; partial delivery remains Ordered.
4. A supervisor can reverse an incorrect receipt with a reason. The original event
   remains immutable and is marked reversed through a separate compensating event.
   Use a new correction reference for the replacement receipt. References remain
   reserved after reversal to prevent accidental replay of the physical delivery.
5. A supervisor reviews and finalizes receiving. Closing outstanding quantities
   requires an explicit acknowledgement and explanation; overdelivery/rejections also
   require an explanation. Finalized orders preserve the discrepancies and prohibit
   further receiving/reversal. Finalizing receiving does not approve or pay an invoice.

If a result is uncertain, the browser retains the exact request ID, input and reviewed
revision in actor/hotel/order-scoped session storage. Retry that saved request. A replay
returns its original receipt rather than adding quantities again. Permission/gate
failures do not prove an earlier attempt uncommitted. Only a server-confirmed failure
after the request's absence has been established unlocks an editable replacement draft.
Session storage is local to the browser session; inspect history before recreating an
uncertain operation after logout/session loss. Unique physical references remain
enforced on the server. History pages contain 25 events with explicit continuation.

Inventory remains periodic physical stock counts. Receipts do not mutate finished
counts, imply perpetual on-hand stock, change source prices or resend supplier orders.
Legacy article-based stock adapters do not consume unconverted purchase quantities.

Historical Received/Finalized orders without a verified receiving baseline show an
explicit review-required state. Missing/corrupt aggregates, units, revisions or source
quantities do not become zero. There is no silent historical migration/recalculation.

## Data and release contract

Receiving policy version is `1`. An order stores a bounded canonical aggregate;
`orders/{orderId}/receipts` stores immutable receipt/reversal/finalization events,
`receiptReferences` reserves normalized references, and `receiptReversals` reserves
one reversal per original receipt. All paths live below the selected hotel's order.
Transactions update the order revision, event/operation result and hotel audit together.
Values use integer thousandths internally, with quantities capped at 100000 and
100 lines per order/event. An order has at most 1000 receiving events.

New collections remain browser-denied. Authorized callables supply whitelisted,
paged history/report data; mutations recheck current Auth, membership, exact action,
subscription, module, release state and order revision. Imports already prohibit the
entire orders namespace. Existing Rules version `saas-platform-v3` remains applicable:
no new client path or write grant is opened. The generated licensed permission list
is updated for catalog consistency. No additional production data migration or
per-hotel Cloud Shell script is introduced by these features.

I've set up prototype Security Rules to keep the data in Firestore safe. They are
designed to be secure for tenant-scoped licensed reads while new receiving records
remain browser-denied and validated through authorized server callables. However,
you should review and verify them before broadly sharing your app. If you'd like,
I can help you harden these rules.

Before production acceptance, complete the existing one-time project activation,
deploy matching Functions/frontend through the reviewed release, then test a new
hotel and two ordinary receiving roles. Verify actual invitation delivery, the
hotel's schedules/source data, partial/full receipt, duplicate/retry, reversal,
shortage closure, another-hotel denial and subscription/membership revocation.
Code/local/CI verification is distinct from deployment and live acceptance.
