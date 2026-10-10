# Firebase App Hosting and subscription setup

## Verified project state

On 2026-10-08 the Firebase console for `hotel-toolkit` showed:

- App Hosting backend `hotel-toolkit` in `europe-west4`, connected to `SmekensRuben/HotelSuite` branch `main`, with no successful release yet.
- Build `b8c9983b-9927-4ef5-8abd-eccf690c0d9e` stopped in `validate-client-environment.mjs`: every required Vite client variable and `EXPECTED_FIREBASE_PROJECT_ID` was missing. Vercel configuration does not configure App Hosting.
- No App Hosting console environment overrides.
- Functions dashboard: **Waiting for your first deploy**. `setHotelSubscription` was not deployed.
- Published Firestore Rules dated 2026-10-06 with platform/membership authorization, but no `hotelSubscriptions` match or active-subscription checks.
- Hotel document `hotels/testhotel`, with `name: "Test Hotel"`; no subscription collection was shown.

This is a frontend/backend rollout mismatch, not evidence of an unpaid invoice. A successful frontend build does not deploy Functions, provision subscriptions or publish Firestore Rules.

## App Hosting frontend

On 2026-10-09 the live Firebase backend confirmed **Release succeeded** for main commit `5fc6be6`. App Hosting now successfully builds and serves the frontend. The owner completed Google setup in Cloud Shell. Functions run `37956475706` (attempt 3) succeeded for main `adf7fb6`, including inventory verification of all 23 then-exported Functions. Subsequent verified main merges deploy Functions automatically; see [functions-continuous-deployment.md](functions-continuous-deployment.md). The agent browser could not access Cloud Shell or Google Cloud IAM; operator commands were executed by the owner.

`apphosting.yaml` explicitly selects production data in `hotel-toolkit`. Its MFA setting matches the inspected existing Vercel value (`false`); update both hosting configurations if the project's enrollment policy changes.

`npm run apphosting:build` reads Firebase's injected `FIREBASE_WEBAPP_CONFIG`, requires its project to match `EXPECTED_FIREBASE_PROJECT_ID`, and maps the complete web-app configuration into `VITE_FIREBASE_*` for the regular validated Vite build. `build:apphosting` remains a compatibility alias. Missing values, conflicting console overrides, project mismatches and invalid deployment/MFA policies still fail. No credentials or web-app keys are copied into this repository. Vercel and local builds continue to use their explicit Vite environment settings.

If Firebase does not supply `FIREBASE_WEBAPP_CONFIG`, link the intended Firebase web app to the backend before retrying. Do not supply a different project's configuration to bypass validation.

The Node runtime serves only `dist`, listens on Cloud Run's `PORT`, supports React Router HTML deep links, and returns 404 for missing assets. Fingerprinted assets are cached; HTML is revalidated. It does not implement hotel APIs: those remain in Firebase Functions. App Hosting is an additional frontend deployment alongside Vercel; neither frontend rollout publishes database rules or Functions.

References: [App Hosting configuration](https://firebase.google.com/docs/app-hosting/configure) and [Node/static framework support](https://firebase.blog/posts/2025/06/app-hosting-frameworks/).

### Keep the build toolchain aligned

The root `package.json` selects Node 22 (`engines.node`) and npm 10.9.9
(`engines.npm`). Both GitHub workflows read the Node version from this file and
install the selected npm version before `npm ci`. App Hosting supports the same
`engines.npm` setting. Its backend runtime must separately be set to **Node 22**
under Settings > Automatic base image updates; changing `engines.node` alone does
not change a versioned backend runtime. Keep automatic base image updates enabled.

Build `build-2026-10-10-004` for main `7dae815` failed during `npm ci` with
`Missing: @grpc/grpc-js@1.9.16 from lock file`, before the frontend build. That
backend selected Node 24.19.0, while the successful GitHub verification used
Node 22.23.3 and npm 10.9.9. Firestore declares gRPC `~1.9.0`, but the reviewed
root override and lockfile select gRPC 1.14.6. Switching only the backend to Node
22 produced the same installation error in build `build-2026-10-10-005`.

The Google buildpack's `OverrideAppHostingBuildScript` rewrites `package.json`
when `apphosting.yaml` contains `scripts.buildCommand`. Its `PackageJSON` struct
omits `overrides`, so that rewrite drops the gRPC pin before `npm ci` runs. An
isolated install with the original manifest succeeds; applying that field loss
reproduces the missing-gRPC lockfile failure. The build command now lives in the
supported `apphosting:build` package script, with no YAML build override, avoiding
the rewrite. The runtime command remains in YAML. See the upstream
[manifest and rewrite code](https://github.com/GoogleCloudPlatform/buildpacks/blob/main/pkg/nodejs/nodejs.go)
and [npm buildpack](https://github.com/GoogleCloudPlatform/buildpacks/blob/main/cmd/nodejs/npm/lib/lib.go).

Keep the override when validating or regenerating the lockfile; adding the older
package to silence installation errors would undo the dependency repair.

When updating the toolchain, update the package metadata and backend runtime
together, run a clean `npm ci` with the selected npm, and check the actual Cloud
Build logs and rollout status. A successful local dry run or GitHub build alone
does not prove that the Firebase rollout succeeded. See
[Firebase runtimes and package managers](https://firebase.google.com/docs/app-hosting/frameworks-tooling).

## Assigning a subscription

There is no payment processor or required paid account for the operator. The access record belongs to a hotel, not a user. A platform administrator can manage hotels without an active subscription; a regular hotel administrator still needs active hotel access and cannot activate subscriptions.

After the backend rollout is complete:

1. Sign in with the existing account that has the verified `platformAdmin` claim.
2. Open **Settings → Subscriptions** (`/settings/subscriptions`).
3. Select **Test Hotel** (reference `testhotel`).
4. Set **Status** to **Active**, **Plan** to `standard`, and leave **First day without access** empty for ongoing access. A trial instead requires a future end date.
5. Click **Save subscription**. This invokes the authenticated `setHotelSubscription` callable, updates `hotelSubscriptions/testhotel` and appends an audit entry atomically. It does not collect money.

The administrator overview now reads hotels and their subscriptions through `listHotelSubscriptions`, a platform-admin-only callable with bounded pages and selected response fields. It no longer depends on client access to the subscription collection, so it can operate while the deployed Rules await migration. A failed page rejects the overview instead of enabling edits with unknown revisions. Regular users still read their own hotel's live status through Firestore and require the matching subscription Rules; they see an access-verification error rather than a false expiry notice when those reads fail.

## Required backend rollout

Use the complete reviewed rollout in [subscription-readiness.md](subscription-readiness.md), including backups, canonical memberships and initial subscriptions **before** publishing rules that gate hotel operations. Do not publish the empty index file or grant platform roles from a browser client.

The inspected test hotel can be included in the create-only subscription bootstrap after confirming that it should have initial access. In Firebase Cloud Shell, from the repository root:

```bash
git pull --ff-only origin main
npm ci
npm --prefix functions ci
printf '["testhotel"]\n' > /tmp/hotelsuite-initial-hotels.json
node scripts/firebase/bootstrap-hotel-subscriptions.mjs \
  --project hotel-toolkit --hotel-file /tmp/hotelsuite-initial-hotels.json \
  --operator "REPLACE_WITH_RELEASE_OPERATOR"
# Inspect the dry-run before applying the same command with --apply.
```

For the activation endpoint specifically, the deploy command is:

```bash
npx firebase deploy --only functions:setHotelSubscription --project hotel-toolkit
```

That single endpoint deployment is not the full backend migration. Both `listHotelSubscriptions` and `setHotelSubscription` are required for platform management. The matching Firestore Rules must allow regular users to read their assigned hotel's subscription; the full release requires canonical user memberships and matching gated callables. Use the complete rollout sequence rather than copying an isolated permissive rule into production. Refresh the overview after deployment, and sign in again if the administrator claim was changed.
