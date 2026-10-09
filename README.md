# HotelSuite

A React + Vite application backed by Firebase. The repository also contains Cloud Functions used for email notifications.

All new development, interface copy, documentation and pull request descriptions must be in English. See `AGENTS.md` for the project conventions.

For Firebase App Hosting configuration, verified rollout issues and manual hotel subscription activation, see [Firebase App Hosting and subscription setup](docs/firebase-app-hosting.md).

For automatic Functions deployment after successful main-branch verification and the one-time keyless Cloud Shell setup, see [Functions continuous deployment](docs/functions-continuous-deployment.md).

## Local setup
1. Install [Node.js](https://nodejs.org/) (version 22 or later) and npm.
2. Install project dependencies:
   ```bash
   npm install
   cd functions && npm install
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

Vercel's hosting environment and the Firebase data environment are separate choices. The current intended setup uses Firebase project `hotel-toolkit` for both Vercel Preview and Production. Set `VITE_DEPLOYMENT_ENV=production` for both: a preview URL does not make its Firebase data a test environment. Changes made through either frontend use the same backend and data.

Configure the matching Firebase web-app values for the Vercel scopes that should use that project:

| Variable | Shared Firebase value |
| --- | --- |
| `VITE_DEPLOYMENT_ENV` | `production` |
| `VITE_AUTH_REQUIRE_MFA` | Match the actual Authentication policy of `hotel-toolkit` |
| `VITE_FIREBASE_API_KEY` | Firebase web-app API key |
| `VITE_FIREBASE_AUTH_DOMAIN` | Firebase web-app Auth domain |
| `VITE_FIREBASE_PROJECT_ID` | `hotel-toolkit` |
| `VITE_FIREBASE_STORAGE_BUCKET` | Exact bucket from the same web-app configuration |
| `VITE_FIREBASE_MESSAGING_SENDER_ID` | Sender ID from the same web-app configuration |
| `VITE_FIREBASE_APP_ID` | App ID from the same web-app configuration |
| `EXPECTED_FIREBASE_PROJECT_ID` | `hotel-toolkit` |
| `PRODUCTION_FIREBASE_PROJECT_ID` | `hotel-toolkit`; build-only test-environment guard |

A preview may alternatively use a separate Firebase test project with `VITE_DEPLOYMENT_ENV=test` and all matching test web-app values. Test builds still reject the known production project and any configured production project. Every build requires complete Firebase values and an exact expected-project match.

Callables must be deployed to the same Firebase project as the selected browser configuration. Adding an Auth authorized domain is a separate project setting; build success alone does not configure sign-in redirects. See `docs/firebase-environments.md`.

GitHub verification remains separate from deployment. The owner authorized a dedicated Functions workflow for verified merges to `main`, explicitly targeting `hotel-toolkit` with temporary Workload Identity credentials. One-time Google setup and the activation variable must be completed before it can deploy. Vercel and Firebase App Hosting independently deploy the frontend; App Hosting released `5fc6be6` successfully. External frontend rollouts do not deploy Functions or Rules.

`.github/workflows/verify.yml` runs on pull requests and `main`, uses the tracked fictional `.env.test` fixture, and has no production-secret or deployment step. `.github/workflows/deploy-functions.yml` waits for successful push verification, skips stale releases and keeps runtime secrets in Google Secret Manager. See [the activation and recovery guide](docs/functions-continuous-deployment.md).

The Firebase Hosting and Cloud Shell release procedure is documented in `docs/firebase-delivery-target.md`. The implemented per-hotel subscription foundation, migration order and remaining sales blockers are in [docs/subscription-readiness.md](docs/subscription-readiness.md). Functions automation does not publish Rules, provision subscriptions or migrate memberships.

Cloud Functions use the Firebase project selected at deployment and therefore do not use the browser `VITE_*` variables. Set the public Functions parameter `APP_BASE_URL` independently in each Firebase project: the deployment workflow versions the canonical HTTPS origin, currently `https://hotel-toolkit--hotel-toolkit.europe-west4.hosted.app`. Update `.github/workflows/deploy-functions.yml` when the canonical domain changes. Keep `MEILI_HOST`, `MEILI_INDEX`, `MEILI_API_KEY`, `RESEND_API_KEY`, `RESEND_FROM`, and `RESEND_WEBHOOK_SECRET` isolated per Firebase project.

Firebase's browser SDK does not expose the project's MFA enforcement policy to this application. Keep `VITE_AUTH_REQUIRE_MFA` aligned with each Firebase project's Authentication setting: `false` for the MFA-free test project and `true` only where every verified user must enroll a second factor. Firebase can still return `auth/multi-factor-auth-required` for an account that already has a factor; that challenge is always handled regardless of this enrollment policy.

## Firebase configuration
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
