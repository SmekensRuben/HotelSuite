# HotelSuite

A React + Vite application backed by Firebase. The repository also contains Cloud Functions used for email notifications.

All new development, interface copy, documentation and pull request descriptions must be in English. See `AGENTS.md` for the project conventions.

For Firebase App Hosting configuration, verified rollout issues and manual hotel subscription activation, see [Firebase App Hosting and subscription setup](docs/firebase-app-hosting.md).

For the Purchasing & Inventory module, explicit per-hotel entitlements, combined module roles, hotel-admin team management and reviewed existing-hotel migration, see [Hotel modules and delegated administration](docs/module-subscriptions.md).

For platform administration without a hotel assignment, per-hotel import monitoring, notifications and controlled support, see [Platform console and release procedure](docs/platform-console.md). The changed access boundary requires the reviewed one-time `saas-platform-v3` Rules rollout.

For the central `RELEASE_MODE` setting, automatic development releases and the controlled transition before the first customer, see [Production release modes](docs/release-modes.md). The existing [Functions continuous deployment guide](docs/functions-continuous-deployment.md) documents the keyless identity and runtime prerequisites.

## Local setup
1. Install [Node.js](https://nodejs.org/) 22 and npm 10.9.9, matching the root `package.json` engines used by GitHub and App Hosting.
2. Install project dependencies:
   ```bash
   npm ci
   npm --prefix functions ci
   ```
3. Copy `.env.example` to `.env` and fill in the Firebase configuration for a non-production development project.
4. Install the Firebase CLI if you want to run or deploy functions:
   ```bash
   npm install -g firebase-tools
   ```
5. Authenticate with Firebase:
   ```bash
   firebase login
   ```

## Environment variables
The application expects the following variables in a `.env` file:

```bash
VITE_DEPLOYMENT_ENV=test
VITE_AUTH_REQUIRE_MFA=false
VITE_FIREBASE_API_KEY=
VITE_FIREBASE_AUTH_DOMAIN=
VITE_FIREBASE_PROJECT_ID=
VITE_FIREBASE_STORAGE_BUCKET=
VITE_FIREBASE_MESSAGING_SENDER_ID=
VITE_FIREBASE_APP_ID=
EXPECTED_FIREBASE_PROJECT_ID=
PRODUCTION_FIREBASE_PROJECT_ID=
```

Use the tracked `.env.example` as the variable-name template. `.env` is intentionally ignored and must never be committed. The browser Firebase configuration is not a server secret, but it still binds a build to a project; Meilisearch credentials are server-only Firebase secrets and must never be bundled in the browser. `npm run build` fails when a required variable is absent or when `VITE_FIREBASE_PROJECT_ID` differs from `EXPECTED_FIREBASE_PROJECT_ID`; there is no production fallback.

## Vercel previews and Firebase project selection

Production uses `hotel-toolkit`. Staging uses the separate `hotel-toolkit-staging` project, with the same source repository and security logic. Follow [Staging quick start](docs/staging-quickstart.md) and [Staging and safe releases](docs/staging-safe-releases.md) for provisioning, selected-commit deployments, fictional accounts and the test checklist.

New Vercel Preview builds **reject production backends**, even when labeled `production`. The previous shared-backend preview configuration is superseded. Disable old previews and remove production values from Vercel's Preview scope; a repository change cannot change already deployed bundles. Use the controlled App Hosting staging workflow for full-stack testing. A Vercel preview can use an isolated test project, or the staging project only with matching web-app values, `VITE_DEPLOYMENT_ENV=staging`, `RELEASE_TARGET=staging` and the complete `VITE_RELEASE_SHA`. A staging frontend only opens when the release document confirms the same deployed backend and frontend SHA.

Production retains `VITE_DEPLOYMENT_ENV=production` and `EXPECTED_FIREBASE_PROJECT_ID=hotel-toolkit`. Staging requires `EXPECTED_FIREBASE_PROJECT_ID=hotel-toolkit-staging`, its own Auth domain and bucket, and an explicit MFA policy. App Hosting obtains all six Firebase web-app fields from its own linked app. Never copy production credentials into staging.

Callables must be deployed to the same Firebase project as the selected browser configuration. Adding an Auth authorized domain is a separate project setting; build success alone does not configure sign-in redirects. See `docs/firebase-environments.md`.

GitHub verification remains separate from deployment. After the one-time [release-path setup](docs/production-apphosting-release-setup.md), the existing production workflow owns both Functions and exact-commit App Hosting publication, explicitly targeting `hotel-toolkit` with temporary Workload Identity credentials. Set `RELEASE_MODE` explicitly; an absent or invalid value blocks release. Disable independent App Hosting automatic rollouts and verify alternate deployment integrations before relying on either mode. The repository disables Vercel Git deployments of `main`. These prepared controls have not been applied to production during implementation.

`.github/workflows/verify.yml` runs on pull requests and `main`, uses the tracked fictional `.env.test` fixture, and has no production-secret or deployment step. `.github/workflows/deploy-functions.yml` waits for successful push verification, skips stale releases, applies the selected release policy and keeps runtime secrets in Google Secret Manager. See [the activation and recovery guide](docs/functions-continuous-deployment.md).

The Firebase Hosting and Cloud Shell release procedure is documented in `docs/firebase-delivery-target.md`. The implemented per-hotel subscription foundation, migration order and remaining sales blockers are in [docs/subscription-readiness.md](docs/subscription-readiness.md). Functions automation does not publish Rules, provision subscriptions or migrate memberships.

Cloud Functions use the Firebase project selected at deployment and therefore do not use the browser `VITE_*` variables. Set the public Functions parameter `APP_BASE_URL` independently in each Firebase project: the deployment workflow versions the canonical HTTPS origin, currently `https://hotel-toolkit--hotel-toolkit.europe-west4.hosted.app`. Update `.github/workflows/deploy-functions.yml` when the canonical domain changes. Keep `MEILI_HOST`, `MEILI_INDEX`, `MEILI_API_KEY`, `RESEND_API_KEY`, `RESEND_FROM`, and `RESEND_WEBHOOK_SECRET` isolated per Firebase project.

Firebase's browser SDK does not expose the project's MFA enforcement policy to this application. Keep `VITE_AUTH_REQUIRE_MFA` aligned with each Firebase project's Authentication setting: `false` for the MFA-free test project and `true` only where every verified user must enroll a second factor. Firebase can still return `auth/multi-factor-auth-required` for an account that already has a factor; that challenge is always handled regardless of this enrollment policy.

## Firebase configuration
The private [Hotel Toolkit MCP product connection](docs/hotel-toolkit-mcp.md) uses
personal Firebase identity, OAuth consent and human-reviewed product proposals.
It is disabled by default; the guide covers test hosting, private ChatGPT/Codex
registration, revocation and the external checks still required.

Firebase settings are stored in `.firebaserc` and `firebase.json`. The default project alias is `test-breakfast`. Cloud Functions are located in the `functions` directory and run on Node 22.

## Common npm scripts

### Root project
- `npm run dev` – start the Vite development server.
- `npm run build` – create a production build of the app.
- `npm run preview` – preview the production build locally.
- `npm test` – run unit tests with Vitest.
- `npm run test:security` – run tenant-isolation tests against local Firestore and Storage emulators.
- `npm run test:restore` – export and restore fictional emulator data as a recovery smoke test.
- `npm run audit:policy` – reject dependency findings above the temporary reviewed baseline.

### Cloud Functions (`functions` directory)
- `npm run serve` – start the Firebase emulator for functions.
- `npm run shell` – open an interactive functions shell.
- `npm run deploy` – deploy functions to Firebase.
- `npm run logs` – view recent function logs.

## Running the development server
Start the frontend in development mode:

```bash
npm run dev
```
The application will be available at `http://localhost:5173` by default.

## Deploying functions
Use the reviewed release SHA and an explicitly verified project from Cloud Shell:

```bash
npx firebase deploy --only functions --project "$HOTELSUITE_PROJECT_ID"
```

Before deploying this subscription release, provision subscriptions for the reviewed existing hotels and complete the rollout prerequisites in `docs/subscription-readiness.md`. Do not rely on the current default project alias.

## SaaS procurement pilot

Hotel onboarding, role invitations, subscriptions and authoritative procurement are documented in [the SaaS pilot guide](docs/saas-procurement-pilot.md). The one-time Rules and credential rollout uses a single uploadable Cloud Shell script, without a Git clone. New writes remain paused until the operator verifies and activates the release.
