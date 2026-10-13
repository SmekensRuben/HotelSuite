# Supplier responses and the first integration pilot

## What the hotel can use

Open **Purchasing & Inventory → Orders**. The **Supplier response** column is separate from the order lifecycle. **Only orders needing supplier attention** includes sent orders with no recorded response, unresolved proposals and supplier follow-up. Closed receiving orders retain their response history without remaining in the actionable queue.

Open an order to see **Supplier confirmation** above **Goods receiving**. An authorized coordinator records the supplier's full response, reference, business date and evidence channel. Matching acceptance means the supplier accepted all submitted terms. A proposal captures each line's confirmed quantity, date, package price and optional replacement description/SKU/unit. A rejection has a required explanation. Unknown price/date is explicit; a genuine zero is supported.

The screen describes these as records entered by the hotel team. It does not claim that a supplier signed in, that an email was parsed or that an automated connector delivered the message. A corrected response may use the same supplier reference; exact duplicates are rejected. Response dates cannot be in the future or older than the latest recorded response. Within a business day the coordinator is responsible for recording the latest supplier response; there is no invented provider sequence.

The order's submitted products, quoted total, original date, currency and VAT/price basis remain unchanged. Receiving quantities measure physical goods. A supplier confirming eight of ten cases does not make the missing two received or cancel them. The receiving supervisor must explicitly close a shortfall. New responses do not resend the order.

## Hotel review and receipt prices

| Response | Accepted goods | Hotel action |
|---|---|---|
| No recorded supplier response | Existing receiving remains available | Historical or direct-delivery workflows are not assigned a fictitious acknowledgement. |
| Matching acceptance | Available under the submitted terms | Record physical goods, including any discrepancy. |
| Proposed quantity/date/package-price changes | Blocked until an explicit review accepts the proposed terms | Review the complete proposal and record a reason. |
| Rejected order, unresolved changes or requested follow-up | Accepted goods blocked; rejected-only evidence, reversal and explicit shortfall closure remain available | Obtain a corrected supplier response or close the outstanding order through the supervisor workflow. |
| Proposed replacement | Original-product receiving blocked; the proposal cannot be accepted as original stock | Resolve with the supplier and establish a separately verified purchase snapshot for the actual replacement. This first phase does not create an amended replacement order automatically. |

Only a separately granted terms approver may accept proposed terms. This is explicit, hotel-wide commercial authority. It does not confer supplier credential management, ordinary order approval/dispatch authority, outlet administration or inventory supervisor powers.

Reviewed package-price changes affect subsequent accepted receipts in the **original** currency, price basis and VAT contract. For example, a gross package price of EUR 21.20 at 6% VAT gives EUR 20 net; receiving two six-litre cases records 12 litres and EUR 40 net. Existing receipt values are unchanged. The receipt freezes the response/review IDs, price mode, source digest and price contract. The weighted-cost service verifies that historic evidence against the immutable supplier response and review, in bounded batches, even when the latest supplier decision has changed.

A price marked unknown remains unknown. Missing VAT, unknown price basis, inconsistent currency or unrepresentable precision cannot create a known net cost. A replacement cannot borrow the original SKU's catalog identity, package conversion or stock price. These recorded prices are source estimates, **not an invoice, verified actual paid cost or live on-hand value**.

When physical accepted quantities exceed the current supplier promise, a discrepancy reason is required even if the submitted order had more units. **Fill outstanding quantities** uses the outstanding confirmed promise when available. The original order's remaining quantity and explicit shortfall-finalization rules remain visible.

## Permissions and rollout

Assign roles through **Hotel Team** using the existing administration workflow:

| Role / permission | Scope |
|---|---|
| Supplier Coordinator | `orders.read`, `orders.recordconfirmation`: register supplier evidence. |
| Supplier Terms Approver | Above plus `orders.reviewconfirmation`: accept revised terms or request follow-up. |
| Existing Receiver / Receiving Supervisor | Existing physical receiving, reversal and explicit finalization powers. |

Advanced grants may separate these actions further. Existing `orders.*`, buyers, managers, approvers and hotel administrator roles do not silently gain the new explicit actions. Every callable verifies current Auth, verified email, membership in the requested hotel and the active procurement subscription.

The response/review and duplicate-reference subcollections below each hotel order are server-only; existing default-deny Rules already cover them. The generated module licensing list includes the new permission keys. The **SaaS Rules v5 activation is reused**: no new per-hotel script, migration, backfill, new composite index or historical revaluation is required. Deploy the three new confirmation callables and updated receiving/cost functions together through normal reviewed Functions delivery. The frontend rejects a receiving backend without the new pricing-policy marker, and new receipt commands carry that marker so an older function rejects them during a partial rollout.

Exact commands are preserved in session storage before sending. An uncertain network result is recovered by retrying the same actor, request ID, payload and revision. Only a server-proven uncommitted failure releases it. Invalid saved commands block entry until their history is reviewed. Reloading, permission/hotel changes and replacement Auth identities cannot reuse a prior actor's data or draft.

## Reusable connector contract

`functions/src/supplierConnectorContract.js` provides a pure, versioned order/response contract for the first pilot. It preserves stable line and purchase-option IDs, the frozen hotel/supplier/customer account, package units, currency/price basis/VAT and submitted digest. Incoming responses must match all correlation fields and pass the same complete-response policy. The tests reject a cross-hotel/order/connection/customer/supplier/digest response and malformed or spoofed fields.

This is **adapter preparation**, not a live API/SFTP/Peppol integration, webhook authenticator, provider format parser or outbound dispatch replacement. There is no new production credential or network call. The chosen provider's format and authentication must be implemented and independently tested against this boundary before enabling automatic ingestion.

## First supplier pilot — information and acceptance

Choose one supplier used frequently by the first real hotel. Record the supplier-approved capability and commercial agreement before implementing an adapter:

| Required information | What it determines |
|---|---|
| Hotel, supplier and customer account(s) per outlet | Tenant/account correlation and customer-specific catalogs/prices. |
| Official interface documentation and test account | Supported transport, authentication, provider sandbox and payload limits. |
| Stable product/package IDs, prices, tax basis and price-validity contract | Exact line/package mapping and defensible receipt values. |
| Cutoffs, minimum order and delivery-day/time rules | Pre-send validations and honest delivery promises. |
| Order submission, acknowledgement and business-response semantics | Separate provider receipt and supplier acceptance/change/rejection. |
| Provider message IDs, sequence/version and retry guarantees | Duplicate, delayed and out-of-order inbound handling. |
| Despatch note, backorder, substitution and correction behavior | Complete responses versus increments and safe replacement snapshots. |
| Credential ownership, rotation and termination | Per-hotel isolated secrets and revocable access. |

The adapter must pass recorded fixtures for complete acceptance, partial supply, rejection, changed package price/date, delayed/duplicate messages, mismatched tenant/customer, unavailable provider, uncertain outbound result, backorders and replacement proposals. Demonstrate that a retry never creates another supplier order and that only verified business responses update the confirmation history. No global supplier/customer scans or shared hotel credentials.

Run a supervised pilot with that hotel before making a commercial integration claim. Record steps/time per order, manual corrections, response coverage, delivery discrepancies and supplier acceptance failures. Supplier selection, provider access and an actual end-to-end pilot remain external dependencies; no supplier has been contacted by this change.

## Later order–receipt–invoice matching

The next phase needs authoritative invoice/credit-note ingestion and agreed matching rules. Preserve invoice identity, tax lines, price basis, currency, rounding, allowances, returns and corrections. Match invoice lines to submitted order and actual accepted receipts; do not match only by product name or current catalog price.

Acceptance examples should include ten ordered/eight accepted/ten invoiced, an approved price change affecting only later receipts, a rejected delivery, partial invoices, credits/returns, a package-unit mismatch and mixed/unknown currencies or tax contracts. Differences need an explicit exception queue and accounting review; they must not rewrite inventory or history automatically. Peppol billing availability alone is not treated as evidence that a supplier supports the ordering/response workflow.

## Release verification

After owner merge and successful Functions/App Hosting delivery, use an ordinary test-hotel user with the newly assigned roles: check no-response versus sent, record a proposal, review it as another authorized user, receive goods, inspect frozen price evidence, exercise shortfall closure and recover a failed request. Check read-only, revoked/other-hotel accounts and both mobile/desktop screens. Confirm actual deployed latency and the deployed pricing-policy marker. Production checks and the supplier pilot are not completed by local/emulator tests.
