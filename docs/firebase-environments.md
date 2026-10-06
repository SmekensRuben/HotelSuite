# Firebase environment audit

Status: 2026-10-05. This document describes repository configuration only; no Vercel, Firebase or production setting was changed while preparing it.

## Initialization inventory

| Runtime | Initialization | Project selection |
| --- | --- | --- |
| Browser | Single Firebase Web SDK initialization in `src/firebaseConfig.js`; Auth, Firestore, Storage and callable Functions all derive from that app. | Six required `VITE_FIREBASE_*` values, validated before build and again before browser initialization. |
| Cloud Functions | Single guarded Admin SDK initialization in `functions/src/config.js`. | The Firebase/GCP project into which Functions are deployed; it does not consume browser variables. |
| Restore smoke test | Isolated Admin SDK app in `scripts/firebase/emulator-backup-smoke.mjs`. | Fixed demo project plus `FIRESTORE_EMULATOR_HOST`; it cannot contact a real Firebase project. |

`.firebaserc` selects `test-breakfast` only for Firebase CLI commands. Vercel and Vite do not read `.firebaserc`; a preview is bound solely by its Vercel environment variables. The GitHub production job previously ran `vite build` without Firebase variables in the workflow. It now receives explicit production repository secrets at the build step and fails closed if they are absent or inconsistent.

## External configuration inventory

- Browser search uses only `VITE_MEILI_HOST` and `VITE_MEILI_SEARCH_KEY`. Both may be empty together to use the existing Firestore fallback; never give the browser an admin Meilisearch key.
- Cloud Functions use project-scoped Firebase secrets for Meilisearch, Resend and the Resend webhook. OpenAI is also server-side; its public API hostname is a vendor endpoint rather than an environment-specific HotelSuite URL.
- Email links formerly hard-coded `https://hoteltoolkit.eu`. They now use the required Functions parameter `APP_BASE_URL`, independently configured in the test and production Firebase projects.
- No hard-coded Firebase web project, bucket, Auth domain or Functions URL remains in application code. Vendor API URLs for OpenAI and Resend remain intentionally fixed.

## Guardrails

- `VITE_DEPLOYMENT_ENV` has no default and accepts only `test` or `production`.
- `EXPECTED_FIREBASE_PROJECT_ID` must exactly match the selected client project.
- Vercel Preview refuses `VITE_DEPLOYMENT_ENV=production`.
- A main-branch GitHub build refuses any environment other than `production`.
- When `PRODUCTION_FIREBASE_PROJECT_ID` is supplied, a test build refuses that project ID.
- These checks prevent accidental fallback; they do not inspect remote Vercel settings. Verify the configured scopes in Vercel before approving the PR preview.
