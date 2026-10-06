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
VITE_MEILI_HOST=
VITE_MEILI_SEARCH_KEY=
EXPECTED_FIREBASE_PROJECT_ID=
PRODUCTION_FIREBASE_PROJECT_ID=
```

Use the tracked `.env.example` as the variable-name template. `.env` is intentionally ignored and must never be committed. The browser Firebase configuration is not a server secret, but it still binds a build to a project; the Meilisearch key must be search-only and index-scoped. `npm run build` fails when a required variable is absent or when `VITE_FIREBASE_PROJECT_ID` differs from `EXPECTED_FIREBASE_PROJECT_ID`; there is no production fallback.

## Vercel preview and production separation

The normal release flow remains PR → Vercel Preview → approval → merge to `main` → GitHub Actions production deployment. Configure these variables in the Vercel project with scope **Preview only**:

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
| `VITE_MEILI_HOST` | Test search endpoint, or empty to use the Firestore fallback |
| `VITE_MEILI_SEARCH_KEY` | Test, search-only, hotel-filtered key, or empty with the host |

Do not copy production Firebase or search values into Vercel Preview. Add the stable Vercel preview/branch domain used for acceptance to the **test** Firebase project's Auth authorized domains. Firebase Auth does not infer authorization from this repository configuration.

The live site is still built only by `.github/workflows/deploy.yml`. Add these GitHub Actions repository secrets before merging:

| GitHub secret | Value |
| --- | --- |
| `PROD_FIREBASE_API_KEY` | Existing production Firebase web API key |
| `PROD_FIREBASE_AUTH_DOMAIN` | Existing production auth domain |
| `PROD_FIREBASE_PROJECT_ID` | Existing production project ID |
| `PROD_FIREBASE_STORAGE_BUCKET` | Existing production bucket |
| `PROD_FIREBASE_MESSAGING_SENDER_ID` | Existing production sender ID |
| `PROD_FIREBASE_APP_ID` | Existing production web-app ID |
| `PROD_MEILI_HOST` | Existing production search host, if enabled |
| `PROD_MEILI_SEARCH_KEY` | Existing production search-only key, if enabled |

Also add the GitHub Actions repository variable `PROD_AUTH_REQUIRE_MFA` with exactly `true` or `false`, matching the MFA policy configured in the production Firebase project.

The workflow maps these secrets to `VITE_*` only for the build step. Until these secrets are present, the production build intentionally fails instead of producing a frontend with an empty or test Firebase configuration. Existing FTPS secrets (`SERVER_HOST`, `SERVER_USER`, `SERVER_PASS`, `SERVER_PORT`, `SERVER_DIR`) remain unchanged.

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
Deploy your Cloud Functions after logging in with Firebase:

```bash
cd functions
npm run deploy
```
