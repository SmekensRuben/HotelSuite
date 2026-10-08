# Production deployment freeze

Status: repository deployment jobs removed from 2026-10-08 while SaaS work is incomplete. This is not proof that external hosting auto-rollouts are disabled.

## Current behavior

- The Vercel integration reports preview checks outside GitHub Actions; the current preview check fails. Inspection subsequently confirmed an automatic production deployment of main commit `0650572` with status Ready. The preview correction intentionally shares Firebase project `hotel-toolkit`; see `firebase-environments.md`.
- Pull requests and pushes to `main` run `.github/workflows/verify.yml`.
- Verification installs dependencies, runs frontend/Functions/security/restore/dependency checks and builds with `.env.test`.
- No GitHub Actions workflow deploys the frontend, Functions, Firebase Rules, indexes, Storage Rules or data.
- Repository workflows do not reference production Firebase, Meilisearch or FTPS secrets.

Removing unused production secrets from GitHub repository settings is recommended after confirming there are no external/reusable workflows that consume them. Removing a secret is defense in depth; the repository safety control is that no workflow contains a deployment job. Inspect Vercel/App Hosting separately: external integrations can still deploy after a merge to `main`.

## Restoring production deployment

Do not add deployment back to the verification workflow. Create a separate production workflow only after the pilot blockers are resolved. It should:

1. use `workflow_dispatch` only, not `push`;
2. target a protected GitHub `production` environment with required reviewers;
3. pin the reviewed commit SHA or release tag;
4. run the same verification suite before deployment;
5. validate the production Firebase project ID and MFA policy;
6. deploy backend dependencies before the frontend;
7. run post-deploy smoke checks and document rollback;
8. receive only the minimum environment-scoped secrets required for that deployment.

Re-enabling automatic deployment on every merge to `main` should be a separate, explicit product/operations decision after deployment rollback, monitoring and customer-data migration procedures have been proven.

The proposed Firebase Hosting/App Hosting and Cloud Shell release model, including the distinction between frontend rollouts and Functions deployments, is documented in `docs/firebase-delivery-target.md`.
