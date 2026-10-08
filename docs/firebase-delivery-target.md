# Proposed Firebase delivery model

Status: proposal only. Nothing in this document enables a deployment or changes a Firebase project.

The per-hotel/manual-invoicing foundation is now implemented. Its migration and tested release order in `subscription-readiness.md` supersede the generic order below: subscriptions must exist before backend/rules enforcement is enabled. No cloud deployment was performed. External preview acceptance remains pending; a successful GitHub verification does not imply Vercel acceptance or disable an external production rollout.

## Recommendation

Keep the current verification workflow as the mandatory quality gate and separate it from delivery. Use one Firebase project per environment and make every deployment name its project explicitly.

HotelSuite is currently a client-rendered Vite SPA. For that architecture, Firebase Hosting is the lowest-complexity production target: it serves the generated `dist/` directory and the existing SPA rewrite in `firebase.json` already describes that model. Firebase App Hosting should only replace it after a proof of concept confirms that its GitHub rollout, Vite build, environment variables, custom domain, Auth redirects and operating cost work for HotelSuite. App Hosting is most valuable if the frontend later needs server rendering or a framework backend; adopting it merely to obtain GitHub-triggered builds adds a second server runtime without a current application requirement.

The desired separation is:

| Concern | Test/preview | Production |
| --- | --- | --- |
| Frontend | Vercel Preview for the current transition, or a dedicated Firebase test Hosting/App Hosting backend after the proof of concept | Firebase Hosting now; App Hosting only after the proof of concept is approved |
| Functions | Explicit Firebase CLI deployment to the test project | Explicit Firebase CLI deployment to the production project after approval |
| Rules and indexes | Separate reviewed command after emulator tests | Separate reviewed command with backup, rollout order and rollback notes |
| CI | GitHub `verify.yml`, no cloud credentials | The same required check; never a deployment credential holder |

## Important distinction: App Hosting and Functions

Connecting a GitHub branch to Firebase App Hosting deploys the App Hosting backend. It does not deploy the functions declared in `functions/`, nor Firestore Rules, Storage Rules or indexes.

Cloud Shell is an authenticated terminal, not an automatic deployment system. Running Firebase CLI commands there is a useful temporary, operator-approved release process because GitHub no longer needs cloud credentials, but it remains a manual deployment. Record the commit SHA, project ID, commands and result for every release.

## Proposed release procedure during hardening

1. Merge only after the `Verify HotelSuite` check and preview acceptance succeed.
2. Open Cloud Shell from the intended Firebase project and check out the reviewed commit SHA or release tag.
3. Run `npm ci`, `npm --prefix functions ci`, the complete verification suite, and an explicit environment validation.
4. Confirm the active identity and run `firebase use`/`firebase projects:list`; do not rely on the repository default alias.
5. Deploy Functions first with `firebase deploy --only functions --project <project-id>`.
6. Smoke-test callable, scheduled and HTTP functions, including CORS and authorization, against that project.
7. Deploy rules/indexes only as a distinct approved change after emulator tests and a current backup.
8. Build the frontend with environment-scoped values, then deploy Hosting or approve the App Hosting rollout.
9. Record the deployed SHA, Firebase release identifiers, smoke-test outcome and rollback command.

For production, require a second person to verify the project ID and release SHA before steps 5, 7 and 8. This is the manual equivalent of a protected deployment environment while GitHub deployments are frozen.

## Prerequisites before enabling App Hosting rollouts

- Create separate App Hosting backends for test and production; never point a preview branch at the production Firebase project.
- Prove the Vite SPA build and client-side route fallback. Do not remove the current Hosting configuration until the custom domain has been cut over and rollback has been tested.
- Configure all `VITE_*` values per backend. Browser Firebase configuration may be public, but production and test identifiers must not be mixed. Keep server secrets in Secret Manager, not in `VITE_*` variables.
- Verify authorized Auth domains, password-reset/action-code URLs, MFA policy and email links on the generated App Hosting domain and the custom domain.
- Confirm that callable Functions resolve to the matching Firebase project and region. Exercise CORS from the actual preview and production origins.
- Define retention, budget alerts, Cloud Logging alerts and Cloud Run/App Hosting cost limits before production traffic.
- Decide who may approve rollouts and rollbacks, and document how to stop automatic rollouts without disabling verification.

## Other changes recommended before subscription sales

1. **Environment inventory:** replace the single ambiguous default in `.firebaserc` with documented `test` and `production` aliases only after both real project IDs have been verified. Commands must still pass `--project` explicitly.
2. **Release manifest:** add a versioned manifest or release note containing frontend SHA, Functions SHA, rules SHA and required configuration versions. This prevents frontend/Functions permission contracts from drifting.
3. **Observable releases:** add structured error reporting, uptime checks for login and one authorized callable, alert ownership, and per-environment budget alerts before restoring unattended rollouts.
4. **Secrets ownership:** inventory Functions parameters and Secret Manager values by environment, add rotation owners and expiry dates, and ensure build-time browser variables are not treated as server secrets.
5. **Rollback drills:** test rollback of Hosting/App Hosting and Functions independently. Firestore Rules and schema/data changes require their own forward-fix and restore procedure.

## Decisions still required

- The Firebase test and production project IDs and regions.
- Whether Vercel Preview remains in use or is replaced by a test App Hosting backend.
- Whether there is an actual SSR/backend requirement that justifies App Hosting over Firebase Hosting.
- Which branch or release tag may create a production rollout, and who approves it.
- Whether Functions remain manually deployed from Cloud Shell or later move to a protected workload-identity deployment workflow.

