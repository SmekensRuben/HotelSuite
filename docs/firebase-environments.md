# Firebase environments

Status: 2026-10-16. Work package 3A prepares isolated staging. No cloud provisioning, remote preview removal or staging release was performed from the development environment. See [Staging and safe releases](staging-safe-releases.md) for bootstrap, accounts, deployment and acceptance steps.

## Explicit targets

| Runtime | Production | Staging |
| --- | --- | --- |
| Firebase project | `hotel-toolkit` | `hotel-toolkit-staging` |
| Browser policy | `VITE_DEPLOYMENT_ENV=production` | `VITE_DEPLOYMENT_ENV=staging`, `RELEASE_TARGET=staging`, full `VITE_RELEASE_SHA` |
| App Hosting configuration | `apphosting.yaml` | Backend environment `staging`, `apphosting.staging.yaml` overlay |
| Browser Firebase config | Production linked web app | Staging linked web app; Auth domain and bucket must also belong to staging |
| Backend runtime | Production Functions project | Staging Functions project plus `DEPLOYMENT_ENV=staging` |
| Deployment identity | Existing reviewed production identity | Separate staging-only identity and GitHub Environment |
| Source version | Existing verified-main release procedure | Manually selected same-repository branch/PR, resolved once to a complete SHA |

`.firebaserc` retains the historical `default: test-breakfast` alias, and adds explicit `production` and `staging` aliases. Release, bootstrap and data tools always name the exact project; they never rely on the default alias. The historical alias alone does not establish that `test-breakfast` is a usable, isolated test environment. The bootstrap inventory must inspect available projects before provisioning.

The single Web SDK initialization in `src/firebaseConfig.js` supplies Auth, Firestore, Storage and callable Functions. Browser validation rejects non-production labels on `hotel-toolkit`; staging also validates its exact project, Auth domain and Storage bucket. Build validation requires the expected-project match. The staging controller obtains the linked web app from the target project rather than copying production browser configuration.

## Preview correction

The 2026-10-08 configuration intentionally shared `hotel-toolkit` between Vercel previews and production. Work package 3A supersedes that policy. New Vercel Preview builds reject `VITE_DEPLOYMENT_ENV=production`; `test` also rejects the known or separately configured production project. Explicit staging builds require the reviewed staging target and source identity. Main still requires production unless the explicit staging route is selected; Vercel Production always requires production.

Already published preview bundles remain bound to their embedded Firebase project. Repository changes cannot revoke them. Before sharing staging, disable/remove the old production-backed previews, remove production variables from Vercel Preview scope, and verify the replacement build. Prefer the controlled App Hosting staging workflow: a frontend-only preview cannot deploy or prove matching Functions, Rules, indexes or activation state.

## Isolation and integration limits

- Auth users, Firestore, Storage, Functions, indexes, activation documents and deployment permissions belong to the separate project. No customer export or production secret is part of the bootstrap or seed.
- Staging has no Resend, Meilisearch, SFTP or AI credentials bound to Functions. The shared runtime policy simulates supplier/email delivery and records that outcome, suppresses scheduled external work and rejects inbound external webhooks and paid AI.
- Product search uses a bounded staging Firestore fallback with the existing membership, permission and module checks. This does not verify a live search service.
- The frontend displays its source SHA and listens to public, read-only `_staging/release` version metadata. It blocks usage during deployment, on failed metadata reads and when the frontend/backend SHA differs. Existing server activation gates remain the authorization boundary.
- Public `dist/release.json` identifies the App Hosting frontend. The release controller must verify it before activating the matching backend. Neither the version banner nor source build success proves external integrations.
- MFA is an explicit project policy (`VITE_AUTH_REQUIRE_MFA`). It must match actual Authentication settings; the browser cannot infer project-wide enforcement. Existing enrolled factors are always challenged by Firebase.

## Production remains separate

The existing `deploy-functions.yml`, `functions-release-policy.mjs` and verified-main production identity checks remain in place. Staging does not promote itself. Merge a reviewed, tested change through the existing production release procedure, including its separate Rules/index/activation steps when required. Never copy staging datasets, users, environment files or activation evidence into production.
