# Functions deployment after a main merge

## Current setup

The owner authorized automatic Functions deployments on 2026-10-09. This decision supersedes the previous Functions deployment freeze; it does not enable automatic Rules, index, Storage Rules or data migrations.

`.github/workflows/deploy-functions.yml` waits for **Verify HotelSuite** to complete successfully for a push to `main`. It deploys the exact verified commit to Firebase project **hotel-toolkit**. A manual **Run workflow** on `main` can retry the current release, but also requires a successful verification run for that exact commit. PR verification cannot authorize a deployment.

Deployments are serialized without cancelling an in-flight Firebase release. The workflow checks the current `main` SHA before setup and immediately before deployment; queued stale releases are skipped. Firebase CLI is installed from the repository lockfile, runs non-interactively and deploys only Functions. Function removal is not forced. A successful release lists the deployed functions and records its SHA in the job summary.

On 2026-10-09 the owner completed the Google setup in Cloud Shell, enabled deployment, bootstrapped Eventarc and configured preview-only artifact retention in all three deployment regions. Run `37956475706` (attempt 3) completed successfully for verified main `adf7fb6`: authentication, runtime checks, Functions deployment and inventory verification all passed. The inventory contained all 23 then-exported Functions. The agent browser could not access Cloud Shell or Google Cloud IAM; operator commands were executed by the owner. Subsequent verified main merges deploy Functions automatically. Artifact retention remains in dry-run, so it does not yet delete images or reduce accumulated artifact storage.

## Authentication and configuration

GitHub obtains temporary Application Default Credentials through the official Google authentication action and a dedicated service account. No JSON service-account key or legacy `FIREBASE_TOKEN` is created. The provider trusts only repository ID `1161047380`, owner ID `134758375`, `refs/heads/main`, the deployment workflow, and its two allowed event types. A fork, PR or another workflow cannot impersonate the deployment account.

| GitHub repository variable | Value |
| --- | --- |
| `FIREBASE_WORKLOAD_IDENTITY_PROVIDER` | `projects/358734544002/locations/global/workloadIdentityPools/hotelsuite-github/providers/main-deploy` |
| `FIREBASE_DEPLOY_SERVICE_ACCOUNT` | `github-functions-deploy@hotel-toolkit.iam.gserviceaccount.com` |
| `FUNCTIONS_APP_BASE_URL` | `https://hotel-suite-neon.vercel.app` |
| `FIREBASE_FUNCTIONS_DEPLOY_ENABLED` | `false` until Google setup and real runtime configuration are ready, then `true` |

The project is fixed explicitly in the workflow; `.firebaserc` is not used to select the deployment target. `APP_BASE_URL` is a public HTTPS origin written into an ignored `functions/.env.hotel-toolkit` during deployment. Update it when the canonical application domain changes.

Runtime secrets remain in Google Secret Manager: `MEILI_HOST`, `MEILI_INDEX`, `MEILI_API_KEY`, `RESEND_API_KEY`, `RESEND_FROM`, `RESEND_WEBHOOK_SECRET`. The runtime check inspects latest-version metadata, never secret values. Missing, disabled or inaccessible versions stop deployment. Do not create dummy values to pass that check.

## One-time Cloud Shell setup

Open Cloud Shell with the existing project operator. The setup script is standalone: uploading only `setup-functions-deployment.sh` into the home directory is sufficient; no checkout or package install is needed. The script names the verified project ID and number and refuses a mismatch before changing IAM.

```bash
bash ~/setup-functions-deployment.sh
bash ~/setup-functions-deployment.sh --apply
```

The first script command prints a plan without executing `gcloud`. The `--apply` command enables the required APIs; creates or updates the dedicated pool/provider and deployment account; grants deployment and exact service-account impersonation permissions; and configures the existing runtime/build/service-agent roles. Project permissions for the deployment account are Cloud Functions Admin, Cloud Scheduler Admin, Firebase Viewer, Service Usage Consumer and Secret Manager Viewer. Runtime data/Auth/Storage and secret access belong to the existing runtime account, not the CI account. No Owner/Editor grant or service-account key is added.

The script never creates subscriptions, canonical memberships, application data, secrets, database rules, indexes or frontend releases. It requires the existing default runtime/App Engine accounts and checks the selected build accounts. Existing IAM members are preserved. Preserve Cloud Audit Logs and use the release order in [subscription-readiness.md](subscription-readiness.md) for the separate subscription migration.

The operator setup enables Cloud Billing and Firebase Extensions API prerequisites, provisions the Google-managed Eventarc service agent and grants `roles/eventarc.serviceAgent` only to that agent. It prepares `gcf-artifacts` repositories in `us-central1`, `us-west1` and `europe-west1`. Repositories without a retention policy or opt-out receive a **dry-run** policy for images older than 30 days with the five latest versions kept. Existing policies and opt-outs are preserved. This satisfies the Firebase CLI's policy prerequisite without granting CI Artifact Registry administration or using `firebase deploy --force`. Dry-run does not delete images or reduce storage usage; review its results before separately activating cleanup. IAM propagation can delay first event-trigger creation by a few minutes.

If a real required secret is missing, the script lists its name and exits without enabling deployment. Provision its real value in Secret Manager using its normal owner-controlled configuration process, then rerun the setup; values must not be pasted into chat or repository files. The script grants the runtime account access only to the six named secrets.

After the script succeeds, set `FIREBASE_FUNCTIONS_DEPLOY_ENABLED=true` under GitHub **Settings → Secrets and variables → Actions → Variables**. The other three variables are already prepared. Then open **Actions → Deploy Firebase Functions → Run workflow**, select `main`, and inspect the authentication, runtime check, deployment and inventory steps. Subsequent merges deploy after verification automatically.

If an authenticated GitHub CLI is available in Cloud Shell, the setup can update the variables and enable deployment itself:

```bash
# Authenticate gh through its secure interactive flow first, if needed.
bash ~/setup-functions-deployment.sh --apply --configure-github
```

This option validates the numeric repository ID and disables deployment while changing setup. It enables deployment only after all required secret versions are present and runtime access was granted. No GitHub secret is read or copied.

## Verification and recovery

Confirm a successful Firebase deploy step and inspect **Functions** in the Firebase console; a successful setup-only/skipped job is not a release. Exercise an authenticated allowed and denied callable from the actual application origin. Keep Cloud Build/Functions logs and the released SHA with the result.

To pause deployments, set `FIREBASE_FUNCTIONS_DEPLOY_ENABLED=false`. To recover a code release, revert the problematic commit through a reviewed PR; the verified revert on `main` uses the same deployment path. A Rules/data migration requires its own rollback procedure and is not reversed by this workflow.

References: [Firebase CLI CI authentication](https://firebase.google.com/docs/cli#cli-ci-systems), [GitHub Workload Identity Federation](https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines), [Functions IAM permissions](https://firebase.google.com/docs/projects/iam/permissions#cloud-functions-for-firebase-permissions).
