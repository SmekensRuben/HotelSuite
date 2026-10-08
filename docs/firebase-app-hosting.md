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

`apphosting.yaml` explicitly selects production data in `hotel-toolkit`. Its MFA setting matches the inspected existing Vercel value (`false`); update both hosting configurations if the project's enrollment policy changes.

`npm run build:apphosting` reads Firebase's injected `FIREBASE_WEBAPP_CONFIG`, requires its project to match `EXPECTED_FIREBASE_PROJECT_ID`, and maps the complete web-app configuration into `VITE_FIREBASE_*` for the regular validated Vite build. Missing values, conflicting console overrides, project mismatches and invalid deployment/MFA policies still fail. No credentials or web-app keys are copied into this repository. Vercel and local builds continue to use their explicit Vite environment settings.

If Firebase does not supply `FIREBASE_WEBAPP_CONFIG`, link the intended Firebase web app to the backend before retrying. Do not supply a different project's configuration to bypass validation.

The Node runtime serves only `dist`, listens on Cloud Run's `PORT`, supports React Router HTML deep links, and returns 404 for missing assets. Fingerprinted assets are cached; HTML is revalidated. It does not implement hotel APIs: those remain in Firebase Functions. App Hosting is an additional frontend deployment alongside Vercel; neither frontend rollout publishes database rules or Functions.

References: [App Hosting configuration](https://firebase.google.com/docs/app-hosting/configure) and [Node/static framework support](https://firebase.blog/posts/2025/06/app-hosting-frameworks/).

## Assigning a subscription

There is no payment processor or required paid account for the operator. The access record belongs to a hotel, not a user. A platform administrator can manage hotels without an active subscription; a regular hotel administrator still needs active hotel access and cannot activate subscriptions.

After the backend rollout is complete:

1. Sign in with the existing account that has the verified `platformAdmin` claim.
2. Open **Settings → Subscriptions** (`/settings/subscriptions`).
3. Select **Test Hotel** (reference `testhotel`).
4. Set **Status** to **Active**, **Plan** to `standard`, and leave **First day without access** empty for ongoing access. A trial instead requires a future end date.
5. Click **Save subscription**. This invokes the authenticated `setHotelSubscription` callable, updates `hotelSubscriptions/testhotel` and appends an audit entry atomically. It does not collect money.

Hotel discovery and subscription reads are separate. If subscription reads fail, the administrator page can display discovered hotels but disables editing because their current revisions are unknown. Regular users see an access-verification error rather than a false expiry notice and can retry. Subscription changes also update live.

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

That single endpoint deployment is not the full backend migration. The matching Firestore Rules must also allow subscription reads; the full release requires canonical user memberships and matching gated callables. Use the complete rollout sequence rather than copying an isolated permissive rule into production. Refresh the overview after deployment, and sign in again if the administrator claim was changed.
