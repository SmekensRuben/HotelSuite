# Firebase environment audit

Status: 2026-10-08. Vercel inspection confirmed that its Git integration deploys `main` automatically. The user selected shared Firebase project `hotel-toolkit` for previews and production; `VITE_DEPLOYMENT_ENV` is therefore `production` for both. Firebase resources, Rules, Auth settings and Functions were not deployed in this correction.

## Initialization inventory

| Runtime | Initialization | Project selection |
| --- | --- | --- |
| Browser | Single Firebase Web SDK initialization in `src/firebaseConfig.js`; Auth, Firestore, Storage and callable Functions all derive from that app. | Six required `VITE_FIREBASE_*` values, validated before build and again before browser initialization. |
| Cloud Functions | Single guarded Admin SDK initialization in `functions/src/config.js`. | The Firebase/GCP project into which Functions are deployed; it does not consume browser variables. |
| Restore smoke test | Isolated Admin SDK app in `scripts/firebase/emulator-backup-smoke.mjs`. | Fixed demo project plus `FIRESTORE_EMULATOR_HOST`; it cannot contact a real Firebase project. |

`.firebaserc` selects `test-breakfast` only for Firebase CLI commands. Vercel and Vite do not read `.firebaserc`; a preview is bound solely by its Vercel environment variables. GitHub Actions currently performs verification only and builds against the fictional `.env.test` fixture; it has no production deployment or production-secret references. See `docs/deployment-freeze.md`.

## External configuration inventory

- Browser product search calls `searchHotelProducts` in the selected Firebase project. Meilisearch host/key/index are server-only secrets. The callable validates membership, permission and subscription, forces the tenant filter, and hydrates results from that hotel’s canonical Firestore documents. Unavailable search can fall back to authorized Firestore reads; permission errors never trigger fallback.
- Cloud Functions use project-scoped Firebase secrets for Meilisearch, Resend and the Resend webhook. OpenAI is also server-side; its public API hostname is a vendor endpoint rather than an environment-specific HotelSuite URL.
- Email links formerly hard-coded `https://hoteltoolkit.eu`. They now use the required Functions parameter `APP_BASE_URL`, independently configured in the test and production Firebase projects.
- No hard-coded Firebase web project, bucket, Auth domain or Functions URL remains in application code. Vendor API URLs for OpenAI and Resend remain intentionally fixed.

## Guardrails

- `VITE_DEPLOYMENT_ENV` has no default and accepts only `test` or `production`.
- `VITE_AUTH_REQUIRE_MFA` has no default and must explicitly match the Authentication policy of that Firebase project. Test environments may set `false`; environments that mandate enrollment set `true`.
- `EXPECTED_FIREBASE_PROJECT_ID` must exactly match the selected client project.
- Vercel Preview may use either an explicitly declared test Firebase project or the intentionally shared production Firebase project. `VERCEL_ENV` identifies the hosting target, not the Firebase data environment.
- A main-branch or Vercel production release build refuses any environment other than `production`. The explicit `NODE_ENV=test` verification build uses the fictional test fixture and does not publish an artifact to a cloud environment.
- Test builds always reject the known production project `hotel-toolkit`, and also reject a separately configured `PRODUCTION_FIREBASE_PROJECT_ID`.
- These checks prevent accidental fallback; they do not inspect remote Vercel settings. Verify the configured scopes in Vercel before approving the PR preview.
- The Firebase Web SDK does not provide a supported client-side read of the project MFA enforcement setting, so repository code cannot infer it safely. Vercel and GitHub configuration are the explicit environment-to-project policy mapping.

## Callable troubleshooting

Callable Functions and the browser Firebase app must use the same project. An endpoint such as `https://us-central1-hotel-toolkit.cloudfunctions.net/updateUserAccess` proves that the frontend was built for project `hotel-toolkit`; it is not a CORS configuration for the `test-breakfast` audit project. That project is now intentionally allowed in previews when `VITE_DEPLOYMENT_ENV=production` and the expected project matches.

`updateUserAccess` is an `onCall` Function in `us-central1` with callable CORS handling explicitly enabled. A preflight response without `Access-Control-Allow-Origin` usually means the requested Function is absent, not publicly invokable at the transport layer, or deployed to another project/region. For the preview flow:

1. set Vercel Preview `VITE_FIREBASE_PROJECT_ID` and `EXPECTED_FIREBASE_PROJECT_ID` to the chosen Firebase project (`hotel-toolkit` for the current shared-backend setup), with `VITE_DEPLOYMENT_ENV=production`;
2. deploy the matching `functions:updateUserAccess` release to that selected project before opening User Detail;
3. verify the deployed Function is in `us-central1` and permits unauthenticated invocation at the Cloud Run transport layer—the callable itself still requires an authenticated `platformAdmin` token;
4. redeploy the Vercel Preview so its bundled Firebase config changes.

Keep callable authentication and authorization intact. A successful preview build does not prove that the new Functions or Rules have been deployed.
