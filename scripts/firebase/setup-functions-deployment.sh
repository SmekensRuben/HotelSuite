#!/usr/bin/env bash
# One-time, keyless GitHub deployment setup. No application data or Rules writes.
set -euo pipefail

apply=false
configure_github=false
for option in "$@"; do
  case "$option" in
    --apply) apply=true ;;
    --configure-github) configure_github=true ;;
    *) echo "Usage: bash scripts/firebase/setup-functions-deployment.sh [--apply] [--configure-github]" >&2; exit 2 ;;
  esac
done

project_id=hotel-toolkit
project_number=358734544002
repository=SmekensRuben/HotelSuite
pool_id=hotelsuite-github
provider_id=main-deploy
deploy_account="github-functions-deploy@${project_id}.iam.gserviceaccount.com"
runtime_account="${project_number}-compute@developer.gserviceaccount.com"
provider="projects/${project_number}/locations/global/workloadIdentityPools/${pool_id}/providers/${provider_id}"
mapping='google.subject=assertion.sub,attribute.repository_id=assertion.repository_id,attribute.repository_owner_id=assertion.repository_owner_id,attribute.ref=assertion.ref,attribute.workflow_ref=assertion.workflow_ref'
condition="assertion.repository_id == '1161047380' && assertion.repository_owner_id == '134758375' && assertion.ref == 'refs/heads/main' && assertion.workflow_ref == 'SmekensRuben/HotelSuite/.github/workflows/deploy-functions.yml@refs/heads/main' && assertion.event_name in ['workflow_run', 'workflow_dispatch']"

cat <<PLAN
Project: ${project_id} (${project_number})
Repository: ${repository}, main branch only, deploy-functions.yml only
Deployment service account: ${deploy_account}
Runtime service account: ${runtime_account}
Workload Identity provider: ${provider}
Trust condition: ${condition}
Creates/updates the dedicated OIDC provider and scoped service-account bindings.
Enables deployment APIs and grants Functions deployment, Scheduler, secret metadata
and Firebase discovery permissions. Grants runtime data/Auth/Storage permissions,
build permissions and existing runtime-secret access. No service-account key,
application data, subscriptions, Rules, indexes or frontend deployment is created.
PLAN
if [[ "$apply" != true ]]; then
  echo "Dry-run only. Add --apply to configure Google Cloud. Add --configure-github to enable the configured workflow using an already authenticated gh CLI."
  exit 0
fi

command -v gcloud >/dev/null || { echo "Run this script in Google Cloud Shell with gcloud available." >&2; exit 1; }
actual_number=$(gcloud projects describe "$project_id" --format='value(projectNumber)')
[[ "$actual_number" == "$project_number" ]] || { echo "Project number mismatch; refusing IAM changes." >&2; exit 1; }
operator=$(gcloud auth list --filter=status:ACTIVE --format='value(account)')
[[ -n "$operator" ]] || { echo "No authenticated Cloud Shell operator." >&2; exit 1; }
echo "Release operator: $operator"
if [[ "$configure_github" == true ]]; then
  command -v gh >/dev/null || { echo "Install the GitHub CLI or configure the repository variables in GitHub settings." >&2; exit 1; }
  gh auth status --hostname github.com >/dev/null
  [[ $(gh api "repos/$repository" --jq .id) == 1161047380 ]] || { echo "GitHub repository ID mismatch." >&2; exit 1; }
  # Disable unattended deployment before changing credentials or runtime setup.
  gh variable set FIREBASE_FUNCTIONS_DEPLOY_ENABLED --repo "$repository" --body false
fi

gcloud services enable iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com \
  cloudresourcemanager.googleapis.com serviceusage.googleapis.com firebase.googleapis.com \
  cloudfunctions.googleapis.com cloudbuild.googleapis.com run.googleapis.com \
  artifactregistry.googleapis.com eventarc.googleapis.com pubsub.googleapis.com \
  cloudscheduler.googleapis.com secretmanager.googleapis.com compute.googleapis.com \
  firestore.googleapis.com storage.googleapis.com --project="$project_id" --quiet

if ! gcloud iam service-accounts describe "$deploy_account" --project="$project_id" >/dev/null 2>&1; then
  gcloud iam service-accounts create github-functions-deploy --project="$project_id" \
    --display-name="HotelSuite GitHub Functions deployment" --quiet
fi
if ! gcloud iam workload-identity-pools describe "$pool_id" --location=global --project="$project_id" >/dev/null 2>&1; then
  gcloud iam workload-identity-pools create "$pool_id" --location=global --project="$project_id" \
    --display-name="HotelSuite GitHub deployments" --quiet
fi
if gcloud iam workload-identity-pools providers describe "$provider_id" --workload-identity-pool="$pool_id" \
  --location=global --project="$project_id" >/dev/null 2>&1; then
  gcloud iam workload-identity-pools providers update-oidc "$provider_id" --workload-identity-pool="$pool_id" \
    --location=global --project="$project_id" --issuer-uri=https://token.actions.githubusercontent.com \
    --attribute-mapping="$mapping" --attribute-condition="$condition" --quiet
else
  gcloud iam workload-identity-pools providers create-oidc "$provider_id" --workload-identity-pool="$pool_id" \
    --location=global --project="$project_id" --issuer-uri=https://token.actions.githubusercontent.com \
    --attribute-mapping="$mapping" --attribute-condition="$condition" --quiet
fi
gcloud iam service-accounts add-iam-policy-binding "$deploy_account" --project="$project_id" \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/${project_number}/locations/global/workloadIdentityPools/${pool_id}/attribute.repository_id/1161047380" \
  --condition=None --quiet

grant_project_role() {
  gcloud projects add-iam-policy-binding "$project_id" --member="serviceAccount:$1" \
    --role="$2" --condition=None --quiet >/dev/null
  echo "Granted $2 to $1"
}
for role in roles/cloudfunctions.admin roles/cloudscheduler.admin roles/firebase.viewer \
  roles/serviceusage.serviceUsageConsumer roles/secretmanager.viewer; do
  grant_project_role "$deploy_account" "$role"
done
for account in "$runtime_account" "${project_id}@appspot.gserviceaccount.com"; do
  gcloud iam service-accounts describe "$account" --project="$project_id" >/dev/null
  gcloud iam service-accounts add-iam-policy-binding "$account" --project="$project_id" \
    --member="serviceAccount:$deploy_account" --role=roles/iam.serviceAccountUser --condition=None --quiet >/dev/null
done
# These are application runtime permissions, not permissions for the CI identity.
for role in roles/datastore.user roles/firebaseauth.admin roles/storage.objectAdmin \
  roles/eventarc.eventReceiver roles/run.invoker roles/logging.logWriter; do
  grant_project_role "$runtime_account" "$role"
done
declare -A configured_build_accounts=()
for region in us-central1 us-west1; do
  build_account=$(gcloud builds get-default-service-account --project="$project_id" --region="$region")
  build_account=${build_account##*/}
  [[ "$build_account" == *@*.gserviceaccount.com ]] || { echo "Cannot identify the build service account." >&2; exit 1; }
  if [[ -z "${configured_build_accounts[$build_account]:-}" ]]; then
    grant_project_role "$build_account" roles/cloudbuild.builds.builder
    gcloud iam service-accounts add-iam-policy-binding "$build_account" --project="$project_id" \
      --member="serviceAccount:$deploy_account" --role=roles/iam.serviceAccountUser --condition=None --quiet >/dev/null
    configured_build_accounts[$build_account]=true
  fi
done
gcloud beta services identity create --service=pubsub.googleapis.com --project="$project_id" --quiet >/dev/null
grant_project_role "service-${project_number}@gcp-sa-pubsub.iam.gserviceaccount.com" roles/iam.serviceAccountTokenCreator
# Ensure the agent exists, but do not use human-formatted CLI output as an IAM member.
# Eventarc documents this address using the project number verified above.
gcloud storage service-agent --project="$project_id" >/dev/null
storage_agent="service-${project_number}@gs-project-accounts.iam.gserviceaccount.com"
grant_project_role "$storage_agent" roles/pubsub.publisher

missing=()
for secret in MEILI_HOST MEILI_INDEX MEILI_API_KEY RESEND_API_KEY RESEND_FROM RESEND_WEBHOOK_SECRET; do
  if ! state=$(gcloud secrets versions describe latest --secret="$secret" --project="$project_id" --format='value(state)' 2>/dev/null) || [[ "$state" != ENABLED ]]; then
    missing+=("$secret")
    continue
  fi
  gcloud secrets add-iam-policy-binding "$secret" --project="$project_id" \
    --member="serviceAccount:$runtime_account" --role=roles/secretmanager.secretAccessor --condition=None --quiet >/dev/null
done

if [[ "$configure_github" == true ]]; then
  gh variable set FIREBASE_WORKLOAD_IDENTITY_PROVIDER --repo "$repository" --body "$provider"
  gh variable set FIREBASE_DEPLOY_SERVICE_ACCOUNT --repo "$repository" --body "$deploy_account"
  gh variable set FUNCTIONS_APP_BASE_URL --repo "$repository" --body https://hotel-suite-neon.vercel.app
fi
if (( ${#missing[@]} )); then
  printf 'IAM setup completed; deployment remains disabled. Provision real Secret Manager values for: %s\n' "${missing[*]}" >&2
  echo "Rerun this script after provisioning. Secret values are never read or copied to GitHub." >&2
  exit 1
fi
if [[ "$configure_github" == true ]]; then
  gh variable set FIREBASE_FUNCTIONS_DEPLOY_ENABLED --repo "$repository" --body true
  echo "Automatic Functions deployment is enabled. Start Deploy Firebase Functions on main to deploy the current verified release."
else
  cat <<VARIABLES
Google Cloud setup completed. Configure these GitHub Actions variables:
FIREBASE_WORKLOAD_IDENTITY_PROVIDER=$provider
FIREBASE_DEPLOY_SERVICE_ACCOUNT=$deploy_account
FUNCTIONS_APP_BASE_URL=https://hotel-suite-neon.vercel.app
FIREBASE_FUNCTIONS_DEPLOY_ENABLED=true
Then start Deploy Firebase Functions on main.
VARIABLES
fi
