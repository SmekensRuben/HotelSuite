# HotelSuite

A React + Vite application backed by Firebase. The repository also contains Cloud Functions used for email notifications.

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

## Vercel preview and production separation

GitHub Actions verifies PRs and `main` without deploying. External Vercel/App Hosting integrations are independent: verify or disable their production auto-rollouts in their consoles before relying on a deployment freeze. The current external Vercel preview check is not passing; its environment setup still requires operator validation. Configure these variables in the Vercel project with scope **Preview only**:

| Variable | Preview value |
| --- | --- |
| `VITE_DEPLOYMENT_ENV` | `test` |
| `VITE_AUTH_REQUIRE_MFA` | `false` when MFA is disabled in the Firebase test project |
| `VITE_FIREBASE_API_KEY` | Web API key from the Firebase test web app |
| `VITE_FIREBASE_AUTH_DOMAIN` | Test-project auth domain, normally `<test-project-id>.firebaseapp.com` |
| `VITE_FIREBASE_PROJECT_ID` | Exact Firebase test project ID |
| `VITE_FIREBASE_STORAGE_BUCKET` | Exact test-project bucket from Firebase web-app settings |
| `VITE_FIREBASE_MESSAGING_SENDER_ID` | Test web-app sender ID |
| `VITE_FIREBASE_APP_ID` | Test Firebase web-app ID |
| `EXPECTED_FIREBASE_PROJECT_ID` | Same exact test project ID |
| `PRODUCTION_FIREBASE_PROJECT_ID` | Existing production project ID; build-only guard, not exposed by Vite |

Do not copy production Firebase or search values into Vercel Preview. Add the stable Vercel preview/branch domain used for acceptance to the **test** Firebase project's Auth authorized domains. Firebase Auth does not infer authorization from this repository configuration.

The current production Firebase project ID `hotel-toolkit` is explicitly rejected in Vercel Preview builds. User-management previews also require `functions:updateUserAccess` to be deployed to the selected test project before the frontend preview is built; see `docs/firebase-environments.md` for diagnosis and rollout order.

`.github/workflows/verify.yml` runs on pull requests and `main`, uses the tracked fictional `.env.test` fixture, and has no production-secret or deployment step. Production Firebase and FTPS secrets are no longer referenced by repository workflows and can be removed from GitHub repository settings after checking that no other workflow depends on them. See `docs/deployment-freeze.md` before restoring any production deployment.

The Firebase Hosting and Cloud Shell release procedure is documented in `docs/firebase-delivery-target.md`. The implemented per-hotel subscription foundation, migration order and remaining sales blockers are in [docs/subscription-readiness.md](docs/subscription-readiness.md). No cloud deployment has been performed.

Cloud Functions use the Firebase project selected at deployment and therefore do not use the browser `VITE_*` variables. Set the non-secret Functions parameter `APP_BASE_URL` independently in each Firebase project: use the accepted test/preview base URL in the test project and `https://hoteltoolkit.eu` in production. Keep `MEILI_HOST`, `MEILI_INDEX`, `MEILI_API_KEY`, `RESEND_API_KEY`, `RESEND_FROM`, and `RESEND_WEBHOOK_SECRET` isolated per Firebase project.

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
