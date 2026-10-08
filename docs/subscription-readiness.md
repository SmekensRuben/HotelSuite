# Per-hotel subscription foundation

Status: 2026-10-08. Frontend is deployed through Vercel; the inspected `hotel-toolkit` backend has no deployed Functions and its older Rules do not allow subscription reads. The subscription backend rollout is incomplete and not certified ready for paid customers. See [the live inspection and setup guide](firebase-app-hosting.md). Commercial choices: subscription per hotel, manual invoicing initially. The system controls access after an operator handles invoicing; it does not generate invoices, collect payments or automatically reconcile them. The owner can activate internal hotels manually without a payment.

## Implemented behavior

`/settings/subscriptions` is platform-only. `setHotelSubscription` validates the administrator, hotel, plan, status, expiry and expected revision, then updates the subscription and appends an audit record in one transaction. Concurrent edits fail instead of silently overwriting each other. Clients cannot write subscription records or audit events directly.

| Field | Meaning |
| --- | --- |
| Document | `hotelSubscriptions/{hotelUid}` |
| `status` | `trialing`, `active`, `suspended`, `canceled` |
| `planId` | Operator-defined label, initially `standard`; no plan-specific seat or feature entitlements yet |
| `billingMode` | `manual` |
| `validUntil` | Firestore Timestamp; trial requires a future expiry, active may use `null` |
| `revision` | Monotonically increasing integer, required for safe edits |
| `updatedBy`, `updatedAt` | Actor and server timestamp |

Membership and an active subscription are required by operational Firestore/Storage Rules and hotel callables. Platform administrators can manage paused hotels. Minimal hotel/profile/settings discovery remains readable to assigned users so they can sign in and select another hotel; subscription suspension is not account deletion. The UI refreshes subscription status live and checks expiry periodically; backend checks use server time.

Scheduled reports, guest intelligence, upsell processing, contract reminders, order approval/dispatch/mail queues and import processing check current subscription state before beginning customer work. Blocked mail is marked for operator review; reactivating a hotel does not automatically replay skipped events. Cancellation cannot recall an email already sent or abort a task already in flight. Meilisearch synchronization may still update indexes for data retention consistency.

Product searches now pass through `searchHotelProducts`: authentication, hotel membership, action permission, subscription, bounded pagination, forced tenant filters and canonical Firestore hydration. Search secrets never enter the frontend bundle. Index IDs include the hotel ID to prevent equal product IDs from overwriting another hotel's entries. Legacy indexes require a deliberate rebuild; no global index is automatically deleted.

User membership saves are transaction-based, use server-owned previous assignments and a revision check. Storage no longer depends on stale per-hotel Auth claims. Imports must live under `imports/{hotelUid}/...`; object paths and tenant metadata must match before processing. Mapped file values cannot override the tenant context, and import destinations must stay inside that hotel’s operational data; memberships, settings, queues and subscription audit are blocked. Review existing import templates before rollout, since legacy global/cross-hotel destinations will now fail.

## Cloud Shell rollout

Do this in a separate test Firebase project first. The repository default `test-breakfast`, historical project references and the known production reference `hotel-toolkit` do not establish which project is the intended target. Capture the actual deployed Rules, indexes, Functions, buckets, hosting/domain mappings and Auth policy, then compare them with the repository. The local index file is empty because no deployed inventory was available; do not publish it as the production index baseline.

1. Verify the release SHA, project ID and Cloud Shell identity. Disable or inspect external Vercel/App Hosting production auto-rollouts; GitHub verification alone cannot freeze those services. Export current data/configuration and prove a restore into a separate project. The emulator restore test is only a tooling smoke test.
2. Provision the canonical memberships and `platformAdmin` claims using reviewed assignments. Create subscriptions for existing hotels **before deploying these callable/rules gates**, otherwise existing customers will be denied. A create-only bootstrap script is supplied; it requires Application Default Credentials with the appropriate project permissions, an explicit project ID and a reviewed JSON array of hotel IDs. It defaults to dry-run and never updates existing subscriptions, including paused ones.
3. Configure project-specific `APP_BASE_URL`, Meilisearch and Resend secrets, webhook signature secret and authorized Auth domains. Enable Storage-to-Firestore Rules authorization for the default database in the Firebase console/IAM. Confirm that it remains enabled in the target project; emulator success cannot verify production IAM.
4. Deploy Functions, then the reviewed Firestore/Storage Rules, then the matching frontend in a maintenance window. `updateUserAccess` now requires a revision and the UI requires subscription reads, so independently mixing old and new releases is unsupported. Preserve existing production indexes until their inventory has been reviewed.
5. Exercise login, verified email/MFA policy, manual subscription activation, trial expiry, suspension, cross-hotel denial, user removal, product search, private uploads, signed webhook/import processing and one allowed/denied callable from the actual Hosting origin.
6. Rebuild both product indexes from canonical Firestore using tenant-qualified IDs and `documentId`. Compare counts per hotel, configure filterable attributes, and swap/clean legacy entries only after validation. Firestore fallback supports a missing index but is not a complete legacy-index migration. Revoke any previously exposed browser search keys.
7. Record release SHA, project, operator, deployed Rules release IDs, Functions/Hosting releases, smoke results and rollback instructions. Test rollback with the prior secure backend/rules/frontend together; never restore the supplied unsafe catch-all rules.

Example Cloud Shell commands, after checkout of the reviewed release:

```bash
HOTELSUITE_PROJECT_ID="REPLACE_WITH_VERIFIED_PROJECT_ID"
npm ci
npm --prefix functions ci
firebase projects:list
gcloud auth list
gcloud auth application-default login
# /tmp/reviewed-hotels.json contains only hotel IDs approved for initial access.
node scripts/firebase/bootstrap-hotel-subscriptions.mjs \
  --project "$HOTELSUITE_PROJECT_ID" --hotel-file /tmp/reviewed-hotels.json \
  --operator "REPLACE_WITH_RELEASE_OPERATOR"
# Inspect the dry-run, then repeat with --apply to create missing subscriptions.
npx firebase deploy --only functions --project "$HOTELSUITE_PROJECT_ID"
npx firebase deploy --only firestore:rules,storage --project "$HOTELSUITE_PROJECT_ID"
# Supply the untracked environment file for this exact project before building.
npm run build
npx firebase deploy --only hosting --project "$HOTELSUITE_PROJECT_ID"
```

The bootstrap runs privileged Admin SDK operations, which bypass Rules. Its operator label is audit metadata, not proof of identity; preserve the IAM/Cloud Audit Logs and release review alongside it. Existing subscriptions are never overwritten, and a rerun safely completes a partially processed list.

## Remaining blockers before subscription sales

1. **Cloud operations:** `firebase.json`, `.firebaserc`, `docs/a00-control-baseline.md`. Deployed Rules/indexes and production identity are unverified; customer backups/restores, monitoring, budget alerts, rate limits and an actual tenant acceptance test still need evidence. Establish these before handling paid customer data.
2. **Backend boundaries:** `firebaseSuppliers.js`/`sftpDispatch.js` still use supplier credential fields in readable documents; move credentials to server-only secrets. `firebaseOrders.js`/`sftpDispatch.js` need authoritative outlet-approver validation, valid state transitions and idempotent external dispatch. Public rooming-list submission/capacity needs a transactional backend API. Private files using persistent download tokens need controlled delivery and token rotation.
3. **Dependency remediation:** the reviewed `npm audit --omit=dev` baseline is 5 frontend/root findings (high) and 2 Functions findings (moderate), zero critical. `config/dependency-audit-policy.json` prevents regression and expires on 2026-11-02; it is not a clean security bill. Replace/remediate affected `xlsx`, Firebase and `exceljs` runtime dependency chains, and review the separate build-tool dependencies and retest before sales.

Automatic payments, invoice generation, VAT/legal terms, seat limits, customer self-service and retention/export policies are future product work. An active subscription label alone does not supply those commercial capabilities.
