# SaaS procurement pilot

This milestone supports an operator-led pilot: create a hotel, assign a bounded trial or manual active subscription, invite its team, prepare orders, obtain outlet approval and submit one durable supplier delivery. It is not a public self-service billing release. Invoicing remains manual; no payment provider, customer charge or automatic subscription renewal is introduced.

## Operator workflow

1. Complete the one-time reviewed Rules rollout below. Until activation, **Settings → Hotel onboarding** explains why creation and invitations are paused. Existing subscription administration remains available.
2. Create a property with a permanent hotel ID. Choose a 1–90 day trial or active access with manual invoicing. The hotel, settings, subscription and audit records are committed together. Repeating the same request resumes its original result.
3. Invite the first manager, then purchasers, approvers and viewers. New accounts receive password setup and verification links to Firebase's managed action pages, followed by a separate sign-in link to the canonical App Hosting site. Existing accounts keep their password and other hotel memberships. Resending an invitation preserves the current role. An invitation acknowledgement means queued, not delivered.
4. Use **Settings → Hotel subscriptions** to suspend, cancel, extend or reactivate access. Operational access requires an active or unexpired trial subscription plus a current canonical membership. Platform administrator screens remain accessible for recovery and administration.
5. Create a supplier and its products, create an outlet and assign verified approvers. Store the supplier/outlet account number where required. An approver needs both `orders.approve` and a designation for that outlet. `outlets.update` alone cannot grant that designation; `outlets.approvers` is required.
6. Add products to the shared hotel cart and choose outlets. Submit the reviewed cart revision. The backend reloads catalog prices, currency, supplier, outlet and account details, adjusts supplier delivery weekdays and creates the orders atomically. Only unsubmitted `Created` orders can be edited or deleted.
7. Confirm an order as its designated approver. Confirmation freezes a reviewed snapshot and creates a private dispatch receipt. Catalog pricing, supplier account or delivery-day changes require another edit and review. `Ordered` is recorded only after a provider acknowledgement or an audited operator receipt.

| Preset | Scope |
| --- | --- |
| Hotel manager | All catalogued hotel actions, including supplier credential management and outlet approver assignment. No platform administrator claim. |
| Purchaser | Procurement reads, cart updates, order creation and editing. No approval or credential changes. |
| Order approver | Procurement reads and order approval; outlet designation is additionally required. |
| Viewer | Procurement reads only. |

Role grants are made by verified platform operators. The authoritative permission catalog is `functions/src/permissionCatalog.json`, imported by the frontend. Permission keys are normalized to lowercase. User Management displays wildcard grants explicitly and can remove all permissions for a selected hotel. The sign-in email comes from Firebase Authentication rather than an editable profile field.

## Security and delivery boundaries

- Raw supplier documents and supplier secrets are denied to all browser clients, including platform administrators. Authorized callables return an explicit business-data projection. Connection management can return configuration metadata, but never passwords. Blank password inputs preserve existing credentials.
- Memberships, subscriptions, approver designations, carts, orders, account assignments, delivery receipts and mail queues are server-managed. Import destinations cannot target these protected collections. Verified email is required for operational calls and Rules access.
- Current membership and subscription records are checked when admitting a mutation and before external delivery. Tokens with old hotel permissions do not override revoked membership. A rollout pause is rechecked inside mutation transactions, preventing an already admitted request from writing after the pause.
- At-least-once Firestore events claim a durable dispatch or outbox record before sending. Repeated events do not send again. Resend also receives a stable idempotency key. No browser timeout cancels or retries a delivery.
- SFTP requires the supplier's independently verified SHA256 host key, public IPv4 resolution, a pinned connection address and an absolute folder. A stable per-order filename is staged before rename. An identical existing file is accepted; conflicting files require review. An uploaded/renamed file is not proof the supplier imported or accepted the order.
- An unconfirmed external result becomes `needs-review`. The platform operator can record verified provider evidence without sending again. Only an explicitly recorded preparation failure with `externalAttempt: false` may be restarted. Recovery decisions use revisions and an audit record.
- Storage uploads are limited to nonempty files of at most 20 MiB. Public rooming-list access is limited to a known, unexpired token and an active hotel subscription; anonymous collection discovery and tenant reassignment are denied.

This is a controlled procurement pilot. Other modules still need their own server-side business validation and quotas. The accompanying [Rules assessment](saas-security-assessment.json) records remaining sale-readiness work, including private contract download URLs and public rooming-list submission.

## One-time Cloud Shell rollout

Functions and App Hosting deploy automatically from verified `main`. This script does not redeploy either, alter indexes, replace subscriptions, grant hotel membership or set platform administrator claims.

Download `scripts/firebase/rollout-saas-pilot.sh` from the reviewed merged release and upload that single file through Cloud Shell's **Upload file** control. A Git clone is not required. Run as `bestsmekens@gmail.com`, using Node 22 or newer:

```bash
bash ~/rollout-saas-pilot.sh --release-sha <reviewed-main-sha>
```

The default is read-only. The script checks the exact current main SHA, successful CI and App Hosting checks, and an actual successful Functions deployment including its inventory step. It downloads only the pinned rollout sources, Rules and locked dependencies. It checks existing profiles, canonical memberships, explicit subscriptions, permission keys and in-flight deliveries. Any inconsistency stops the rollout. Resolve missing memberships through User Management after reviewing the intended per-hotel permissions; do not copy global permissions into every hotel.

After a successful preflight:

```bash
bash ~/rollout-saas-pilot.sh --release-sha <reviewed-main-sha> --apply
```

If the read-only preflight reports that cross-service Storage Rules access is missing, the exact additional grant is:

| Principal | Role | Purpose |
| --- | --- | --- |
| `service-358734544002@gcp-sa-firebasestorage.iam.gserviceaccount.com` | `roles/firebaserules.firestoreServiceAgent` | Google Firebase Storage Rules may read Firestore documents to check current memberships and subscriptions. |

This is a service-agent role with `datastore.entities.get`, not a deployment or runtime administrator role. Only after reviewing that exact grant, add `--grant-storage-rules-access` to the apply command. An existing unconditional binding is reused. No service-account key or persistent access token is created.

The exact role and cross-service setup are documented in [Google's IAM role reference](https://docs.cloud.google.com/iam/docs/roles-permissions/firebaserules) and [Firebase's Rules deployment guide](https://firebase.google.com/docs/rules/manage-deploy).

Apply pauses new SaaS writes, checks deliveries again, backs up the currently published Rules to an operator-local `previous-rules.json`, compiles both reviewed sources before publishing either, verifies the published content, relocates legacy supplier secrets without overwriting newer private passwords and normalizes known permission-key casing. Existing claims, passwords, roles, subscription states and order history are preserved. After ten minutes for Rules propagation, it rechecks the release and activates `platformConfiguration/saasProcurement`. Failures leave activation blocked; inspect the reported phase before resuming.

Keep the printed workspace path and Rules backup. A partial Rules release is repaired by rerunning the reviewed script after resolving the error. Do not restore permissive supplier access after credentials have moved. To pause the pilot independently, run the pinned Node helper from that workspace:

```bash
node scripts/firebase/saas-rollout.mjs pause
```

A future Rules change needs emulator tests, a reviewed rollout and a new Rules version when its boundary changes. The Functions deployment identity intentionally has no Rules administrator role. Code-only merges continue to use the existing automatic release workflow.

## Verification

The pilot suite uses real Auth and Firestore emulators and the production Rules sources, with separate hotel A/B memberships. External mail and SFTP use fake providers; no real invitations or supplier orders are sent by tests. Scenarios include onboarding retries, existing-account preservation, role-preserving resend, private credentials, stale revisions, canonical pricing and accounts, duplicate events, ambiguous delivery recovery, approval revocation, suspension, expiry, reactivation and cross-hotel read/write denial. Separate Rules tests cover protected collections, anonymous link discovery and Storage upload limits. Operator migration and activation are exercised only against the demo emulators.

Required checks are `npm test -- --run`, `npm --prefix functions test`, `npm run test:security`, `npm run test:restore`, `npm run audit:policy`, `npm run build:test` and the non-production App Hosting fixture build in CI. Real supplier receipt/import confirmation remains part of an owner-supervised pilot with the intended supplier.
