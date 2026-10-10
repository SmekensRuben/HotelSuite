# Hotel modules and delegated administration

Implementation date: 2026-10-10. This is a code and local-verification record;
no production migration, deployment or customer billing has been performed.
The change is stacked on audit PR #221. That secure baseline is a dependency.
See [the execution record](module-subscriptions-plan.md) for exact checks.

## Product structure

| Area | Included functionality | Access model |
| --- | --- | --- |
| Core | Hotel identity, property settings, integrations, imports, notifications, hotel team | Included with an active, explicitly configured subscription; action permissions still apply |
| Purchasing & Inventory (`procurement`) | Catalog products, supplier products, suppliers, orders, stock counts, outlets, locations, catalog taxonomy | First module with role presets |
| Contracts (`contracts`) | Contract records, taxonomy, private attachments and reminders | Separate entitlement; located under Administration |
| Front Office (`frontoffice`) | Reservations, arrivals and upsell audits | Separate entitlement; existing action permissions |
| Groups & Events (`groups`) | Groups and rooming lists | Separate entitlement; existing action permissions |
| Revenue (`revenue`) | Group quotes, demand calendar and commercial intelligence | Separate entitlement; existing action permissions |

Administration is a navigation category, not a license that grants every
administrative or contract action. Core inclusion does not grant all Core
permissions. An ordinary hotel administrator initially gets dashboard access
and hotel-member administration only; operational roles are assigned separately.

Subscriptions are per hotel. Billing is manual. `planId` is a commercial label
and never derives access, prices or payment status. Operators explicitly select
modules after managing the hotel's agreement/invoice outside this application.
There is no payment processor, invoice generation or automatic payment collection.

## Roles and hotel onboarding

| Procurement role | Grants |
| --- | --- |
| Viewer | Read procurement records and configuration |
| Buyer | Read catalog/supplier products/suppliers/outlets/catalog settings; create and edit Created orders |
| Approver | Read orders and purchasing context; approve/confirm orders, also subject to outlet-approver assignment |
| Stock Controller | Read stock context; create/edit/finish stock-count workflows with their existing state checks |
| Module Manager | Explicit procurement CRUD/configuration and supplier credential-management actions; order approval must be added separately |

Roles can be combined, for example Buyer + Approver. Grants are explicit action
keys in `functions/src/moduleCatalog.json`, not wildcards that silently acquire
future actions. Users with advanced custom permissions can keep them. The team
editor groups advanced permissions by module and excludes user/platform
administration, which is controlled by the Hotel administrator checkbox.

The Stock Controller preset covers stock counts. The existing application does
not have an ordinary supplier-order receiving/finalization workflow; this
delivery does not invent one or grant an uncontrolled status transition.
Only Created orders remain editable/deletable and ordering remains the existing
protected confirm/send workflow.

Recommended onboarding:

1. The platform operator creates the hotel and explicitly chooses initial
   modules; the form starts with Purchasing & Inventory selected.
2. Invite a primary and backup named hotel administrator. Existing accounts
   keep their password and their other hotel memberships. Hotel administrators
   are never granted the platform administrator Auth claim.
3. Each administrator opens Administration → Hotel team to invite colleagues,
   assign licensed module roles and optionally configure advanced permissions.
4. Assign operational roles to administrators who also perform hotel work.
   Assign an order approver to the appropriate outlet before confirming orders.

The last hotel-administrator membership cannot be removed or demoted. A shared
transaction guard serializes this check with all membership-changing endpoints,
including the older platform user editor. A platform operator can appoint a
replacement first. This protects membership counts, not the availability of
an independently disabled/deleted Auth identity; retain an operator recovery
procedure. At most twenty hotel administrators can be assigned per hotel.

Member edits are hotel-local. Local names override global profile names in hotel
staff displays. Legacy memberships can use a narrow identity fallback for their
own members. Removing hotel access deletes only that membership/assignment and
does not disable/delete a shared Auth account or change another hotel's roles.

## Entitlements, seats and revocation

Each `hotelSubscriptions/{hotelUid}` has:

| Field | Contract |
| --- | --- |
| `status`, `validUntil` | Existing active/trialing, suspension/cancellation and expiry contract |
| `modules` | Unique explicit IDs from the catalog; `[]` means Core only |
| `modulePolicyVersion` | `1`; absent, malformed or unsupported versions deny operational access |
| `seatLimit` | `null` initially means unlimited; optionally an integer from 1 to 10000 |
| `revision` | Expected-revision lease for transactional operator edits |

Seats count assigned named hotel memberships, including invited accounts, not
recent logins. Lowering the limit preserves current access and blocks only new
assignments. Concurrent invitations cannot take the same final available seat.
An Auth account may have been created before an assignment fails at the final
transaction check. It receives no membership or invitation mail from the failed
assignment and can be reused safely on retry; no shared identity is deleted as
compensation for a failed hotel invitation.

Effective access requires verified identity, hotel membership, a current
subscription, the feature's licensed module and the specific action permission.
Hotel delegation additionally requires the server-owned `hotelAdmin` flag and a
fresh enabled/verified Auth identity. UI controls are supplemented by callable,
Firestore and Storage enforcement. New operational workers and import chunks
check the current license; import targets determine their module, not a supplied
module label. Search hydration uses the same backend feature authorization.

Revocation retains data, historical snapshots and dormant member permissions.
Dormant role grants are preserved rather than recompiled into new unlicensed
rights. Subscription/module changes update the browser live; member changes
also clear revoked permissions immediately. Work already in flight cannot be
recalled. Blocked deliveries are not automatically replayed on reactivation.
Other modules have entitlement enforcement now, but no new role presets yet;
develop each commercial module separately on this shared foundation.

## Reviewed migration and release

This section describes future operator actions; none were executed in production.
Existing plan names never imply modules. Complete a reviewed migration before
activating the matching new application/Functions/Rules release. Account for
main-triggered App Hosting, Vercel and Functions deployments in the maintenance
plan. The rollout marker is now `saas-modules-v2`; an old marker blocks new
gated writes until the matching Rules release is verified.

1. Review/complete the audit baseline dependency. Inventory the actual Firebase
   project, secure Rules, Functions, hosting releases, IAM and production indexes.
   Capture subscription/member/profile backups and prove a separate-project
   restore. The emulator restore is a local tooling test only.
2. Review a manifest against current subscription revisions and enabled, verified
   named hotel accounts. Prefer two administrators. If subscriptions are missing,
   the create-only bootstrap now grants Core only and preserves existing records,
   including suspended/canceled subscriptions.
3. Run the migration dry-run with appropriate Application Default Credentials.
   The operator label is audit metadata, not proof of IAM identity. Preserve Cloud
   Audit Logs alongside the reviewed manifest and output. Keep manifests private.
4. Apply the same reviewed manifest explicitly. Every selected hotel is assessed
   before mutations; each hotel then has its own revision-checked transaction,
   shared member guard and receipt. Status, expiry, plan and existing permissions
   are preserved. This is not one transaction across all hotels: on interruption
   or a concurrent edit, review the exact error and resume the same manifest.
   Reapplying unchanged entries verifies receipts without incrementing revisions.
5. Release matching Rules/Functions/frontend under the existing reviewed rollout
   procedures. Both rollout launchers download the module catalog. Confirm the
   new team callables exist, Rules match the reviewed sources, Storage has its
   cross-service Firestore IAM role, and the `saas-modules-v2` marker is enabled
   only after the existing rollout checks succeed. Preserve the audited private
   workflow checks and propagation wait; do not publish the empty local index
   file as a production baseline.
6. Check real normal-user paths: Core-only hotel administrator; Buyer; Buyer +
   Approver with outlet assignment; Stock Controller; independent second hotel;
   stale edits; seat limit; last-admin protection; module removal/reactivation;
   revoked membership; one allowed/denied file/API/import path. Test actual
   invitation delivery with the approved mail/provider configuration. Record
   matching release IDs and roll back to the prior secure coordinated release
   if these fail.

Example manifest; substitute reviewed IDs/revisions and purchased modules:

```json
[
  {
    "hotelUid": "reviewed-hotel",
    "expectedRevision": 3,
    "modules": ["procurement"],
    "seatLimit": null,
    "hotelAdminUids": ["reviewed-primary-uid", "reviewed-backup-uid"]
  }
]
```

From a checkout of the reviewed release with the operator dependencies installed:

```bash
HOTELSUITE_MODULE_PROJECT_ID="REPLACE_WITH_VERIFIED_PROJECT_ID"
node scripts/firebase/module-access-migration.mjs \
  --project "$HOTELSUITE_MODULE_PROJECT_ID" \
  --manifest /tmp/reviewed-module-access.json \
  --operator "REPLACE_WITH_RELEASE_OPERATOR"
# After inspecting that dry-run and completing the release review:
node scripts/firebase/module-access-migration.mjs \
  --project "$HOTELSUITE_MODULE_PROJECT_ID" \
  --manifest /tmp/reviewed-module-access.json \
  --operator "REPLACE_WITH_RELEASE_OPERATOR" --apply
```

Production must not have emulator environment variables. `--emulator` is restricted
to the fictional local demo project. No command in this guide authorizes a release
from this development task.

Before paid onboarding, decide the actual module prices, trial/renewal agreements,
any later seat packaging and data export/retention rights after cancellation.
The initial implementation uses unlimited users and manual billing. These
commercial decisions do not block local implementation; they remain release and
sales decisions.
