# Test-hotel-2 purchasing and inventory demo

## Load from the platform interface

1. Deploy the reviewed change through the normal release process. The existing
   `saas-platform-v4` Rules rollout and procurement subscription must be ready.
   This change does not merge, deploy or automatically seed any database.
2. Sign in as a platform administrator and open **Platform → Hotels →
   test-hotel-2** (`/platform/hotels/test-hotel-2`). The permanent hotel ID must be
   exactly `test-hotel-2`; no other hotel is accepted by the server.
3. In **Test-hotel-2 demo dataset**, review the read-only preview and acknowledge
   that these are fictional records. Click **Load demo dataset** once.
4. Sign in with your existing hotel test account, select test-hotel-2 and use the
   normal purchasing and inventory pages. Platform administration itself grants
   no employee role or hotel access.

No Cloud Shell seed script is needed. A failed/uncertain browser response can be
checked with **Refresh demo status**. Repeating the same dataset never resets,
overwrites or duplicates it, including after editing or deleting demo records.

## Included examples

| Area | Records | What to test |
| --- | ---: | --- |
| Catalog products | 12 | g/kg/ml/l/each, allergens, tracked goods and an untracked delivery service |
| Supplier products | 15 | Two suppliers for milk, ml/l and g/kg conversion, case/single options, gross VAT pricing, a free sample, a missing price and an unlinked offer |
| Suppliers | 3 | Fictional Fresh Foods, Pantry Supplies and Drinks & Essentials |
| Outlets | 3 | Kitchen, Lobby Bar and Housekeeping; supplier account mappings |
| Physical locations/templates | 3 / 3 | Kitchen, bar and housekeeping catalog-based counts |
| Orders | 7 | Three drafts, awaiting delivery, a complete milk receipt, a partial/reversed water receipt and a canceled example |
| Stock counts | 3 | Opening and closing snapshots plus an unfinished count |
| Receiving events/movements | 4 / 4 | Three simulated receipts and one reversal, with matching references and audit evidence |

All human-readable article/supplier/location/count names have a `DEMO` prefix.
Deterministic document IDs use `demo-v1-`; SKU reservations use the normal hashed
identity. Every fixture document records its dataset ID and synthetic provenance.
Business dates use the configured hotel time zone, or an explicit UTC demo date
when none is configured. That choice is displayed and stored with the seed receipt;
it never rewrites hotel settings. The historical example spans the ten days before
loading. This is synthetic history, not evidence that actual deliveries occurred.

Enabled, verified existing hotel administrators who already have `orders.approve`
are added as designated approvers of the new demo outlets. No Auth users, profiles,
memberships, permissions, invitations or subscription settings are created/changed.
If none qualify, the UI explicitly tells the operator to configure an approver.

## Recommended manual checks

- Place a new order using a single milk bottle versus a case; choose the alternate
  milk supplier and verify that physical catalog identity stays the same.
- Open a demo draft, edit quantities and confirm as a designated outlet approver.
  The confirmation must explicitly say **simulation**. Receive it using the usual
  receiving permission and a physical destination; try a partial receipt/reversal.
- Open the unfinished count, enter all catalog quantities (including explicit
  zero) and finish every location before finishing the parent count. Also create
  a new count from a demo template. Unknown opening cost must remain unknown.
- Before adding new postings, open **Inventory periods**, select **DEMO Kitchen
  store** and the **DEMO opening/closing counts**. Milk should show opening 100 l
  + received 30 l − closing 80 l = **50 l inferred usage**, with period-weighted
  net unit cost `(100 × 2 + 90) / 130`. Other kitchen articles have separate rows.
- The bar example has one remaining case of water after reversing another receipt.
  Its net recorded water receipt is 12 bottles. Juice has an intentionally unknown
  opening cost; the report must not show a valid complete monetary total.
- If you post a backdated receipt after the seeded closing count, the existing
  period must expose late evidence instead of silently rewriting its snapshots.
  Use new physical counts for subsequent test periods.
- Try a reader-only account and an account assigned to another hotel: seeding and
  hotel writes must be denied; another hotel's data must remain inaccessible.

## Delivery and data boundaries

The three reserved demo supplier IDs are bound to a private, completed
`hotels/test-hotel-2/demoDataSeeds/procurement-demo-v1` receipt. Their orders always
use simulation, even when public email/SFTP settings are changed. The protected
confirmation workflow still checks current Auth, membership, action permissions,
subscription, approver assignment, revision, prices and packaging. It marks the
business order Ordered without sending and creates a dispatch with status
`simulated`; the UI and PDF identify the simulation. The delivery worker also
checks the claimed supplier, preventing malformed pending demo delivery from
reaching email/SFTP. Missing demo authority fails closed. Suppliers created outside
these reserved identities retain their normal delivery behavior.

The seed callable accepts only preview/apply, this exact hotel and reviewed dataset
version. It rechecks current platform authority, release and subscription inside
every transaction attempt. It creates the entire bounded dataset, receipt and
platform audit atomically with create-only writes. Existing demo-ID collisions
without a seed receipt block the whole operation. The seed receipt is inaccessible
to browser clients and generic imports cannot write its namespace.

This dataset covers the purchasing/catalog and periodic-inventory workflows being
built now. Recipes, POS deductions, live on-hand claims, external integrations and
real customer/guest data are not populated. Counts and receipt values remain
synthetic operational estimates, not financial records. No reset/delete operation
is provided; a future reset would need a separately reviewed dependency-aware plan.
