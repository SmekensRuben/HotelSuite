# Staging and safe releases

Status: 2026-10-16. This work prepares an isolated staging release path in the
existing `SmekensRuben/HotelSuite` repository. The implementation session had no
authenticated Google Cloud/Firebase operator, so **no staging project, billing
link, IAM policy, live deployment, test account or live URL was created or
verified**. Run the bootstrap and acceptance steps below to complete activation.
Local tests prove the tested guards and fixtures, not cloud provisioning.
For day-to-day operations, use the [quick start](staging-quickstart.md).

## Environment contract

| Item | Staging | Production |
| --- | --- | --- |
| Firebase project | `hotel-toolkit-staging` | `hotel-toolkit` |
| Browser policy | `VITE_DEPLOYMENT_ENV=staging`, `RELEASE_TARGET=staging` at build | Existing explicit production policy |
| Functions policy | `DEPLOYMENT_ENV=staging` plus the actual staging project | Existing production project check |
| Auth, Firestore, Storage | Separate project resources; fictional users/data only | Existing customer resources |
| App Hosting | `hotel-toolkit-staging`, `europe-west4`, environment `staging`, local source uploads | Existing production backend |
| Deployment identity | `github-staging-deploy@hotel-toolkit-staging.iam.gserviceaccount.com` | Existing production identity |
| GitHub workflow | Manual `Deploy HotelSuite staging`, protected `staging` Environment | Existing verified-main Functions release and production frontend procedure |
| Provider credentials | None required; outbound services are blocked or simulated | Existing production secrets |

Expected staging origin, **not yet verified live**:
`https://hotel-toolkit-staging--hotel-toolkit-staging.europe-west4.hosted.app`.
The frontend displays its staging identity/version and serves `/release.json`.
Never infer the active data project from a URL or `.firebaserc`: the browser
config, Functions project, WIF project number and release evidence must agree.
The historical `test-breakfast` CLI alias is not evidence of a suitable, empty
or reachable staging project.

## One-time Cloud Shell setup

1. Open Cloud Shell using the account authorized to create/manage the staging
   project and use the selected billing account. Check out the reviewed branch
   or merged release in this repository. Use Node 22.13 or later within Node 22,
   npm from `package.json`, `npm ci` and `npm --prefix functions ci`.
2. Authenticate the operator with `gcloud auth login` if Cloud Shell has no
   active account and `npx -y firebase-tools@latest login --no-localhost` for the
   Firebase CLI. Do not export a production service-account key or legacy
   `FIREBASE_TOKEN`. Bootstrap deliberately rejects both `FIREBASE_TOKEN` and
   `GOOGLE_APPLICATION_CREDENTIALS` overrides.
3. Review the offline plan, then inspect accessible projects without mutations:

   ```bash
   bash scripts/firebase/bootstrap-staging.sh --dry-run
   bash scripts/firebase/bootstrap-staging.sh --preflight
   gcloud billing accounts list
   gcloud organizations list
   ```

   The preflight lists accessible Firebase projects and GCP test candidates
   before any creation, including `test-breakfast` if accessible. Review its
   owners, data, integrations and purpose in the Console. Do not reuse an
   existing environment merely because its name contains “test”. The prepared
   route intentionally accepts only `hotel-toolkit-staging`; using a different
   existing project requires a reviewed update to all staging allowlists.
4. Choose the billing account, project parent and immutable Firestore location.
   `europe-west4` colocates Firestore with App Hosting; verify the location meets
   the owner's policy. **Default Storage must use `us-west1`** because the shared
   application already places its Storage-triggered Functions there. Firebase
   rejects incompatible trigger/bucket locations; an EU default bucket cannot
   be fixed by changing a build variable. This preserves the reviewed production
   function regions and retry policy. Firestore Standard/native mode preserves the
   current application's database/rules model. App Hosting and Functions require
   billing/Blaze; budget alerts do not impose a spending cap. Set a staging
   budget/alerts in the selected billing account before sustained use.
5. Run the concrete bootstrap after replacing the billing and parent values:

   ```bash
   bash scripts/firebase/bootstrap-staging.sh \
     --apply --confirm-project hotel-toolkit-staging \
     --create-project --organization YOUR_NUMERIC_ORGANIZATION_ID \
     --billing-account YOUR_BILLING_ACCOUNT_ID \
     --firestore-location europe-west4 --storage-location us-west1
   ```

   Choose `--folder YOUR_NUMERIC_FOLDER_ID` or `--no-organization` instead of
   `--organization` when appropriate. Omit `--create-project` and the parent
   option when the exact staging project already exists. The script refuses
   implicit creation and billing reassignment. Failed listing/permission checks
   do not mean a resource is absent. On a partial failure, fix the reported
   prerequisite and rerun the same command; there is no destructive rollback.

The operator needs project creation on the selected parent, billing-association
permission on the selected billing account/project, and staging API, Firebase,
Auth, database, bucket, service-account, WIF, custom-role and IAM configuration
permissions. The read-only `testIamPermissions` check verifies a core subset for
an existing project. It cannot prove organizational policy, quota, parent or
billing permissions. Bootstrap authority belongs to the human operator, not CI.

The script enables required APIs, registers Firebase and a staging Web app,
enables email/password Auth, creates a protected Standard `(default)` database,
creates the App Hosting backend without a Git connection or initial rollout,
sets its environment to `staging`, verifies automatic rollouts are disabled,
prepares its upload bucket, and creates the isolated deployment identity/WIF.
It never reads/copies production secrets, creates account keys, deploys code,
seeds users, or enables GitHub deployment.

### Required Console settings after bootstrap

These settings cannot be assumed from a successful shell exit. Confirm each in
the **staging** project:

| Location | Required setting |
| --- | --- |
| Firebase → Storage → Get started | Create default bucket `hotel-toolkit-staging.firebasestorage.app` in **`us-west1`**, **production/locked mode**. Rerun bootstrap to grant only staging runtime object access and release inspection access. |
| Firebase → Authentication → Sign-in method | Email/password enabled. Keep other providers disabled unless explicitly tested. Do not import production users. |
| Authentication → Settings → Authorized domains | Add `hotel-toolkit-staging--hotel-toolkit-staging.europe-west4.hosted.app` (hostname only), retain staging Firebase domains. The CLI's Auth provider deployment does not prove domain configuration. |
| Authentication → MFA policy | Match `VITE_AUTH_REQUIRE_MFA=false` in staging configuration. Fixture users are email-verified fictional accounts; they do not enroll MFA. |
| App Hosting → staging backend → Settings → Environment | Confirm bootstrap set environment name to `staging`, selecting `apphosting.staging.yaml` overrides, and linked the intended staging Web app. |
| App Hosting → Settings → Deployment | Confirm no connected Git repository and disabled automatic rollouts (`traffic.rolloutPolicy.disabled=true`). Bootstrap and the release controller verify these values. |
| App Hosting → Settings → Automatic base image updates | Node 22, automatic updates enabled. Keep npm aligned with `package.json`; do not add a YAML build-command override. |
| App Hosting → Environment overrides | Remove conflicting Vite/project/deployment values. Firebase supplies the Web app config; do not paste production config. |

The bootstrap's `bootstrap-staging-apphosting.mjs` helper uses the authenticated
operator's in-memory token with the App Hosting v1beta API. It validates the
project, Web app and absence of a Git connection before PATCHing the backend's
`environment` to `staging` and its traffic's `rolloutPolicy.disabled` to `true`,
then reads both values back. It starts no release. If App Hosting Terms of
Service acceptance is requested, accept them in the staging Firebase Console
and rerun bootstrap. Existing incompatible backend settings stop the script
for operator review.

### GitHub Environment and deploy permissions

Create repository **Settings → Environments → staging**, add a required reviewer,
prevent self-review where supported, and restrict deployment branches to `main`.
With a single operator who both starts releases and is the only reviewer, this
self-review rule blocks every deployment. The owner explicitly approved allowing
self-review for this fictional staging environment on 2026-10-16. Required
review, the `main`-only deployment rule and protected `main` remain enabled.
The workflow file always runs from protected `main`; its input selects the
application branch/PR. Reviewers approve the selected SHA and its code for staging
access: Firebase deployment discovers/executes that source with staging credentials,
and App Hosting builds/runs it. This is not a sandbox for untrusted code. Production
credentials are absent and the identity has no production grants. Fork PRs cannot deploy.
Branch protection should require the existing verification checks before changes
to the trusted workflow/controller reach `main`.

Copy the values printed by bootstrap into **staging Environment variables**:

| Variable | Value |
| --- | --- |
| `STAGING_PROJECT_NUMBER` | Actual number printed by bootstrap; never `358734544002` |
| `STAGING_WORKLOAD_IDENTITY_PROVIDER` | `projects/NUMBER/locations/global/workloadIdentityPools/hotelsuite-staging-github/providers/staging-deploy` |
| `STAGING_DEPLOY_SERVICE_ACCOUNT` | `github-staging-deploy@hotel-toolkit-staging.iam.gserviceaccount.com` |
| `STAGING_APPHOSTING_BACKEND_ID` | `hotel-toolkit-staging` |
| `STAGING_APPHOSTING_REGION` | `europe-west4` |
| `STAGING_APP_BASE_URL` | Expected staging origin above |
| `STAGING_DEPLOY_ENABLED` | Initially `false`; set `true` only after all setup and seed steps |

There are no staging provider/API-key secrets or Google service-account key
secrets to copy. WIF requires repository ID `1161047380`, owner ID `134758375`,
the exact trusted workflow on `main`, `workflow_dispatch`, and the `staging`
Environment OIDC subject. Another branch cannot obtain these credentials merely
by copying the workflow. CI's service roles are restricted to the staging
project. The custom App Hosting role permits build/rollout creation and reads,
without backend settings/deletion or project IAM writes. Source-object writes
are scoped to the upload bucket. Default-bucket reads and Firestore/Auth reads
support activation checks; Firestore writes support release/module activation.
Functions run with separate runtime data/Auth permissions. No production IAM
binding is added or changed. The Google-managed **staging Pub/Sub service agent**
receives project-scoped Token Creator because Firebase's initial Functions
deployment checks that specific binding; CI itself receives no Token Creator
or project IAM write permission. Storage's Google-managed rules agent receives
the Firestore Rules service-agent role needed for cross-service authorization.

## Fictional data and role accounts

Seed after infrastructure setup and before the first release. Use authenticated
operator ADC in Cloud Shell (`gcloud auth application-default login` if needed),
with Auth admin and Firestore write access **in staging only**. Keep provider
credentials and production environment variables out of this session.

```bash
node scripts/firebase/staging-data.mjs seed --project hotel-toolkit-staging
node scripts/firebase/staging-data.mjs seed --project hotel-toolkit-staging \
  --apply --confirm-project hotel-toolkit-staging \
  --credentials-file work/staging-credentials.json
```

The first command is an offline plan. The second creates two marked fictional
hotels, active procurement subscriptions, canonical memberships and accounts
with verified fictional emails. Passwords are random and are saved only to the
local mode-0600 credentials file; share them with authorized testers through a
private channel. No invitation email is sent. Do not commit or upload that file
as a workflow artifact. A seed preserves existing fixture accounts/passwords;
use the original credentials file or reset and seed for a fresh set.

| Role | Hotel A email | What to test |
| --- | --- | --- |
| Hotel administrator | `staging-hotel-a-admin@example.invalid` | Hotel settings and all procurement actions; no platform-admin claim |
| Purchaser | `staging-hotel-a-purchaser@example.invalid` | Requests, catalog/order creation, receiving; no approval privilege |
| Approver | `staging-hotel-a-approver@example.invalid` | Approvals, budgets and recovery; no self-approval bypass |
| Stock counter | `staging-hotel-a-counter@example.invalid` | Counts/stock operations; no purchasing approval |
| Revoked | `staging-hotel-a-revoked@example.invalid` | Can authenticate but has no hotel membership/access |

Replace `staging-hotel-a` with `staging-hotel-b` for Hotel B accounts. Use separate
browser profiles when comparing roles. Each hotel has three outlets/locations,
three suppliers, twelve catalog products, fifteen supplier offers, a budget,
draft/pending Purchase Requests, seven orders, four receipts and three stock
counts. Existing Purchasing & Inventory fixtures include incomplete receipt,
delivery ambiguity and count exceptions. These are snapshots for exercising
real application workflows, not production exports.

To rebuild, stop active testing and wait for any release to finish, then:

```bash
node scripts/firebase/staging-data.mjs reset --project hotel-toolkit-staging
node scripts/firebase/staging-data.mjs reset --project hotel-toolkit-staging \
  --apply --confirm-project hotel-toolkit-staging
node scripts/firebase/staging-data.mjs seed --project hotel-toolkit-staging \
  --apply --confirm-project hotel-toolkit-staging \
  --credentials-file work/staging-credentials-new.json
```

Reset is restricted to marked synthetic hotel trees and their exact fixture
users/profiles/subscriptions. It includes changes made while testing those
hotels. It does not wipe unrelated data or Storage objects; uploaded test files
need separate, explicitly scoped operator cleanup. Never use the reset while a
release or another tester is active. The data tool refuses writes during a
release and uses `_staging/dataOperation` as a shared lock. A crashed operation
can leave that lock blocked: confirm the process stopped and inspect its state
before an authorized operator clears it; do not bypass a live operation.

## Deploy a branch or PR

1. Push the selected application version to this repository and open its PR.
   Ensure the reviewed staging infrastructure/controller changes are already
   on protected `main`; that is the trusted entry point.
2. In **Actions → Deploy HotelSuite staging → Run workflow**, leave workflow
   branch `main`, set `source_kind` to `branch` or `pull-request`, and enter the
   repository branch name or PR number in `source_target`. Leave `deploy=false`
   for verification only; set `deploy=true` to publish. Review the resolved
   immutable SHA and approve the `staging` Environment deployment.
3. The workflow resolves the source once, runs the required checks/build before
   authentication, and deploys the same checkout's Functions, Firestore/Storage
   Rules, indexes and App Hosting source archive. Staging activation verifies
   canonical membership/subscription/private-workflow readiness, deployed Rules
   source, index readiness, Functions project/SHA/no-secret bindings and frontend
   release evidence. It pauses activation while the release is incomplete and
   waits for Rules propagation before marking it ready.
4. Open the workflow's release summary and the staging URL. Check the displayed
   SHA and `/release.json`; both must identify the selected release. Complete
   the acceptance checks below. A green unit-test job alone is not a live proof.

If deployment fails, staging stays unavailable/paused rather than being marked
ready with mixed versions. Inspect the failing step and rerun the same reviewed
version after fixing the prerequisite. Database indexes can take time to become
ready. Roll back by selecting a complete, previously merged commit SHA through
the same workflow (`commit` source kind); this repeats verification and all
deployment/activation steps. Code rollback does not undo data/schema changes;
reset the synthetic fixture only when appropriate.

## Acceptance checks

Record the workflow URL, selected SHA, date, tester and observed result for each
row. Browser/API denials must be checked at Firebase boundaries, not only by
looking for hidden navigation controls.

| Check | Expected result |
| --- | --- |
| Environment identity | Browser config/network destinations name only `hotel-toolkit-staging`; `/release.json` and Functions inventory match the workflow SHA. |
| Hotel isolation | Hotel A users cannot list/read/write Hotel B documents, private files or invoke Hotel B callables, even with a copied B ID/path; repeat B → A. |
| Roles | Purchaser can submit but cannot approve; approver can approve eligible requests; counter can count without approval rights; hotel admin is not platform admin. |
| Revoked access | Revoked account cannot open either hotel's data/callables/files; stale tabs do not regain access. |
| Subscription | Apply `scenario --project hotel-toolkit-staging --subscription suspended --apply --confirm-project hotel-toolkit-staging`; B loses procurement access, A remains active. Repeat `expired`, then restore `active`. |
| Requests/budget | Open the draft/pending request, submit/approve with distinct users, check budget reservation/commitment and an over-budget refusal. Retry actions without duplicate reservations. |
| Order delivery | Create/confirm an order, inspect the explicit simulation status and private dispatch log; no supplier is contacted. Exercise ambiguous/failed-delivery recovery from the fixture. |
| Receiving | Receive partly, resolve a discrepancy/return, verify receipt history and safe repeated submission. |
| Stock count | Complete explicit counts including zero, inspect valuation/movement evidence and incomplete-count refusal. |
| Private files | Upload/read a fictional permitted attachment as the correct role; verify another hotel/revoked user is denied. |
| External boundary | Mail/dispatch is marked simulated, webhook calls are rejected, scheduled work is skipped and paid AI is unavailable in staging. |

`scenario` without `--apply` previews the subscription change. It affects only
the fictional Hotel B subscription, preserving Hotel A as a control. Restore
`active` before the next release's readiness checks.

## External integrations and previews

Staging always simulates order dispatch and queued email, even if a supplier's
settings suggest a real destination. It marks orders `Ordered` with simulation
metadata and records that no external attempt occurred. It blocks inbound
provider webhooks, scheduled workers, paid AI processing, external image fetches
and provider search/index writes. Search uses bounded reads of staging
Firestore, with an explicit failure above 1,000 documents per collection.
No production Meilisearch index, Resend account, FTP/SFTP login, OpenAI key or
webhook secret is provisioned. Do not add them to bypass a simulated workflow.

Real supplier transport, mailbox delivery, provider webhooks, cron timing,
provider search relevance/scale, AI cost/output and third-party credentials are
therefore **not proven by staging acceptance**. Test those later with separate
provider sandbox accounts and a reviewed environment policy.

Historical Vercel Preview deployments used the production Firebase backend.
The new build policy rejects production-backed previews; update Vercel **Preview**
variables to the staging Web app config, explicit staging project/environment,
`RELEASE_TARGET=staging` and the complete `VITE_RELEASE_SHA`, or disable Preview deployment. Keep Production
scope on the existing production values. Redeploying changes future bundles;
disable/delete old production-backed preview deployments in Vercel because
already-published JavaScript keeps its old Firebase config. Vercel previews
cannot establish backend/frontend SHA equality; use the managed staging workflow
for acceptance. No Vercel project settings were changed in this session.

## Promote a tested change

Record the successful staging SHA and acceptance evidence on the PR. Merge the
reviewed change through the existing protected-main procedure. The existing
production Functions workflow still requires verified current `main` and its
separate production WIF configuration; the production frontend keeps its own
App Hosting settings. A staging deployment never grants production permission
or automatically promotes a branch. Production Rules/indexes/data migrations
remain separately reviewed operations under the existing rollout runbooks.

A merge/squash can produce a different SHA from the tested branch. Confirm the
merged content and rerun required verification; stage the merged version when
integration changes affect behavior. Use [functions-continuous-deployment.md](functions-continuous-deployment.md),
[subscription-readiness.md](subscription-readiness.md) and the relevant migration
runbook for the production change. Never run the staging seed/reset or copy its
activation records into production.
