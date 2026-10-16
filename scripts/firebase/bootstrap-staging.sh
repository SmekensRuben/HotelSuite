#!/usr/bin/env bash
# Operator-only infrastructure bootstrap. The default is an offline plan.
set -euo pipefail
umask 077

project_id=hotel-toolkit-staging
backend_id=hotel-toolkit-staging
region=europe-west4
repository=SmekensRuben/HotelSuite
pool_id=hotelsuite-staging-github
provider_id=staging-deploy
mode=plan
create_project=false
billing_account=
firestore_location=
storage_location=
parent_kind=
parent_id=
confirmed_project=

usage() {
  cat <<'HELP'
Usage: bash scripts/firebase/bootstrap-staging.sh [options]
  --dry-run                    Offline plan; default, no credentials or writes
  --preflight                  Read accessible projects and staging state only
  --apply                      Apply the reviewed infrastructure plan
  --confirm-project ID         Must be hotel-toolkit-staging for --apply
  --create-project             Explicitly allow creation if the target is absent
  --billing-account ID         Explicit billing account, required for --apply
  --firestore-location REGION   Explicit immutable Standard database location
  --storage-location us-west1   Required by the existing Storage trigger region
  --organization ID            Parent for a new project (choose one parent)
  --folder ID                  Parent for a new project
  --no-organization            Explicitly create outside an organization
  --help

No target-project override is supported. Existing projects are listed before
creation. No deployments, application data, accounts, secrets or production
resources are written. GitHub deployment stays disabled until manual activation.
HELP
}
fail() { printf 'Staging bootstrap stopped: %s\n' "$*" >&2; exit 1; }
value() { [[ $# -ge 2 && -n "$2" && "$2" != --* ]] || fail "Missing value for $1"; }
select_mode() { [[ "$mode" == plan ]] || fail 'Choose only one execution mode.'; mode=$1; }
select_parent() { [[ -z "$parent_kind" ]] || fail 'Choose only one project parent.'; parent_kind=$1; parent_id=${2:-}; }
while (( $# )); do
  case "$1" in
    --dry-run) select_mode dry-run; shift ;;
    --preflight) select_mode preflight; shift ;;
    --apply) select_mode apply; shift ;;
    --create-project) create_project=true; shift ;;
    --confirm-project) value "$@"; confirmed_project=$2; shift 2 ;;
    --billing-account) value "$@"; billing_account=$2; shift 2 ;;
    --firestore-location) value "$@"; firestore_location=$2; shift 2 ;;
    --storage-location) value "$@"; storage_location=$2; shift 2 ;;
    --organization) value "$@"; select_parent organization "$2"; shift 2 ;;
    --folder) value "$@"; select_parent folder "$2"; shift 2 ;;
    --no-organization) select_parent none; shift ;;
    --help) usage; exit 0 ;;
    *) usage >&2; fail "Unknown argument: $1" ;;
  esac
done
[[ -z "$confirmed_project" || "$confirmed_project" == "$project_id" ]] || fail 'Production and alternate target projects are forbidden.'
[[ -z "$billing_account" || "$billing_account" =~ ^[A-Z0-9]{6}-[A-Z0-9]{6}-[A-Z0-9]{6}$ ]] || fail 'Invalid billing account ID.'
[[ -z "$parent_id" || "$parent_id" =~ ^[0-9]+$ ]] || fail 'Organization/folder ID must be numeric.'
for location in "$firestore_location" "$storage_location"; do
  [[ -z "$location" || "$location" =~ ^[a-z][a-z0-9-]+$ ]] || fail 'Invalid resource location.'
done
[[ -z "$storage_location" || "$storage_location" == us-west1 ]] || fail 'Default Storage must use us-west1, matching the existing Storage Functions and retry policy.'

cat <<PLAN
HotelSuite staging infrastructure plan
  Target: $project_id (fixed; production hotel-toolkit is never a write target)
  App Hosting: $backend_id, $region, local source deployment, no Git connection
  Billing: ${billing_account:-NOT SELECTED}; project parent: ${parent_kind:-NOT SELECTED} ${parent_id}
  Firestore: (default), Standard, ${firestore_location:-NOT SELECTED}
  Default Firebase Storage location: ${storage_location:-NOT SELECTED (must be us-west1)}
  GitHub trust: $repository, main, deploy-staging.yml, environment staging
  Identity: github-staging-deploy@$project_id.iam.gserviceaccount.com
  Sequence: inventory -> explicit creation/billing -> APIs -> Web app/Auth ->
    Firestore -> source backend/bucket -> staging IAM/WIF -> operator checklist
  Preserves existing data and resources; no release, seed/reset, keys or secrets.
  A missing default Firebase Storage bucket requires the Console step below.
PLAN
if [[ "$mode" == plan || "$mode" == dry-run ]]; then
  cat <<'PLAN'
Dry-run complete. No commands contacted Google Cloud or GitHub.
Next: run --preflight in authenticated Cloud Shell and review available projects,
including test-breakfast, before deciding whether a new project is necessary.
Then use --apply --confirm-project hotel-toolkit-staging with explicit billing,
resource locations and (only for creation) --create-project plus a parent choice.
See docs/staging-safe-releases.md for the remaining Console/GitHub settings.
PLAN
  exit 0
fi

if [[ "$mode" == apply ]]; then
  [[ "$confirmed_project" == "$project_id" ]] || fail '--apply requires --confirm-project hotel-toolkit-staging.'
  [[ -n "$billing_account" && -n "$firestore_location" && -n "$storage_location" ]] || fail '--apply requires billing, Firestore and Storage locations.'
  [[ "$create_project" != true || -n "$parent_kind" ]] || fail 'New projects need an explicit organization, folder or --no-organization.'
fi
for tool in gcloud jq node npx; do command -v "$tool" >/dev/null || fail "Install $tool or use Google Cloud Shell."; done
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major === 22 && minor >= 13 ? 0 : 1)' || fail 'Use Node 22.13 or later within Node 22, matching the repository.'
[[ -z "${FIREBASE_TOKEN:-}" && -z "${GOOGLE_APPLICATION_CREDENTIALS:-}" ]] || fail 'Unset legacy FIREBASE_TOKEN and GOOGLE_APPLICATION_CREDENTIALS; use the authenticated Cloud Shell operator.'
operator=$(gcloud auth list --filter=status:ACTIVE --format='value(account)')
[[ -n "$operator" && "$operator" != *$'\n'* ]] || fail 'Sign in with exactly one active gcloud operator.'
printf 'Cloud Shell operator: %s\n' "$operator"
firebase_cli() { npx -y firebase-tools@latest "$@"; }
firebase_cli --version
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
# A failed listing is never interpreted as an absent project.
gcloud projects list --format=json > "$scratch/projects.json"
firebase_cli projects:list --non-interactive --json > "$scratch/firebase-projects.json"
jq -e '.status == "success" and (.result | type == "array")' "$scratch/firebase-projects.json" >/dev/null || fail 'Could not inventory Firebase projects.'
printf '\nAccessible Firebase projects (inspect existing test candidates first):\n'
jq -r '.result[] | [.projectId, .displayName, .projectNumber] | @tsv' "$scratch/firebase-projects.json"
printf '\nAccessible GCP test/staging candidates:\n'
jq -r '.[] | select((.projectId + " " + .name) | test("test|stag|sandbox|demo"; "i")) | [.projectId, .name, .projectNumber] | @tsv' "$scratch/projects.json"
exists=$(jq --arg id "$project_id" '[.[] | select(.projectId == $id and .lifecycleState == "ACTIVE")] | length' "$scratch/projects.json")
[[ "$exists" == 0 || "$exists" == 1 ]] || fail 'Ambiguous project inventory.'
if [[ "$exists" == 1 ]]; then
  gcloud projects describe "$project_id" --format=json > "$scratch/project.json"
  jq -e --arg id "$project_id" '.projectId == $id and .lifecycleState == "ACTIVE"' "$scratch/project.json" >/dev/null || fail 'Target identity/state mismatch.'
  gcloud billing projects describe "$project_id" --format=json > "$scratch/billing.json"
  gcloud services list --enabled --project="$project_id" --format='value(config.name)' > "$scratch/services.txt"
  printf '\nExisting staging project number: %s\n' "$(jq -r .projectNumber "$scratch/project.json")"
  printf 'Current billing enabled: %s\n' "$(jq -r .billingEnabled "$scratch/billing.json")"
  if [[ -n "$billing_account" ]]; then
    linked_account=$(jq -r '.billingAccountName // ""' "$scratch/billing.json")
    [[ -z "$linked_account" || "$linked_account" == "billingAccounts/$billing_account" ]] || fail 'Existing billing account differs; this script never silently relinks it.'
  fi
  # This is a read-only permission test, not a speculative infrastructure write.
  node "$(dirname "$0")/bootstrap-staging-permissions.mjs" "$project_id"
else
  printf '\nTarget is absent from accessible projects. No existing project is assumed empty or suitable.\n'
  [[ "$mode" != apply || "$create_project" == true ]] || fail 'Review the inventory; --create-project is required to create a new target.'
fi
if [[ -n "$billing_account" ]]; then
  gcloud billing accounts describe "$billing_account" --format=json > "$scratch/billing-account.json"
  jq -e '.open == true' "$scratch/billing-account.json" >/dev/null || fail 'Billing account must be open and readable by this operator.'
fi
if [[ "$mode" == preflight ]]; then
  cat <<'CHECKED'
Read-only preflight complete. This proves project inventory/read access and, for
an existing target, the tested infrastructure permissions. It does not prove
parent project-creation permission, billing-association permission, organization
policies, quota, live application behavior or a successful deployment.
CHECKED
  exit 0
fi

if [[ "$exists" == 0 ]]; then
  parent_args=()
  [[ "$parent_kind" != organization ]] || parent_args+=("--organization=$parent_id")
  [[ "$parent_kind" != folder ]] || parent_args+=("--folder=$parent_id")
  gcloud projects create "$project_id" --name='Hotel Toolkit Staging' "${parent_args[@]}" --quiet
  gcloud projects describe "$project_id" --format=json > "$scratch/project.json"
  node "$(dirname "$0")/bootstrap-staging-permissions.mjs" "$project_id"
fi
project_number=$(jq -r .projectNumber "$scratch/project.json")
[[ "$project_number" =~ ^[0-9]+$ && "$project_number" != 358734544002 ]] || fail 'Invalid or production project number.'
gcloud billing projects link "$project_id" --billing-account="$billing_account" --quiet
gcloud services enable firebase.googleapis.com firebaseapphosting.googleapis.com \
  firebaseextensions.googleapis.com firebaserules.googleapis.com firebasestorage.googleapis.com \
  iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com \
  cloudresourcemanager.googleapis.com serviceusage.googleapis.com cloudbilling.googleapis.com \
  identitytoolkit.googleapis.com firestore.googleapis.com storage.googleapis.com \
  cloudfunctions.googleapis.com cloudbuild.googleapis.com run.googleapis.com compute.googleapis.com \
  artifactregistry.googleapis.com eventarc.googleapis.com pubsub.googleapis.com \
  cloudscheduler.googleapis.com secretmanager.googleapis.com developerconnect.googleapis.com \
  --project="$project_id" --quiet
if ! jq -e --arg id "$project_id" '.result[] | select(.projectId == $id)' "$scratch/firebase-projects.json" >/dev/null; then
  firebase_cli projects:addfirebase "$project_id" --non-interactive
fi
firebase_cli apps:list WEB --project "$project_id" --non-interactive --json > "$scratch/apps.json"
app_id=$(jq -r '[.result[] | select(.displayName == "Hotel Toolkit Staging")][0].appId // ""' "$scratch/apps.json")
if [[ -z "$app_id" ]]; then
  firebase_cli apps:create WEB 'Hotel Toolkit Staging' --project "$project_id" --non-interactive --json > "$scratch/new-app.json"
  app_id=$(jq -r '.result.appId // ""' "$scratch/new-app.json")
fi
[[ "$app_id" == "1:$project_number:web:"* ]] || fail 'Web app does not belong to the staging project.'
printf '{"auth":{"providers":{"emailPassword":true}}}\n' > "$scratch/auth.json"
firebase_cli deploy --only auth --config "$scratch/auth.json" --project "$project_id" --non-interactive
firebase_cli firestore:databases:list --project "$project_id" --non-interactive --json > "$scratch/databases.json"
database=$(jq -c '.result[] | select(.name | endswith("/databases/(default)"))' "$scratch/databases.json")
if [[ -z "$database" ]]; then
  firebase_cli firestore:databases:create '(default)' --edition standard --location "$firestore_location" \
    --delete-protection ENABLED --project "$project_id" --non-interactive
else
  jq -e --arg location "$firestore_location" '.locationId == $location and .type == "FIRESTORE_NATIVE" and (.databaseEdition // "STANDARD") == "STANDARD"' <<< "$database" >/dev/null || fail 'Existing database edition/location differs; no migration is attempted.'
fi

deploy_account="github-staging-deploy@$project_id.iam.gserviceaccount.com"
runtime_account="$project_number-compute@developer.gserviceaccount.com"
apphosting_account="firebase-app-hosting-compute@$project_id.iam.gserviceaccount.com"
provider="projects/$project_number/locations/global/workloadIdentityPools/$pool_id/providers/$provider_id"
grant_project_role() {
  gcloud projects add-iam-policy-binding "$project_id" --member="serviceAccount:$1" --role="$2" --condition=None --quiet >/dev/null
}
gcloud iam service-accounts list --project="$project_id" --format='value(email)' > "$scratch/accounts.txt"
if ! grep -Fxq "$deploy_account" "$scratch/accounts.txt"; then
  gcloud iam service-accounts create github-staging-deploy --project="$project_id" --display-name='HotelSuite staging releases' --quiet
fi
gcloud iam workload-identity-pools list --location=global --project="$project_id" --format='value(name)' > "$scratch/pools.txt"
if ! grep -Fxq "projects/$project_number/locations/global/workloadIdentityPools/$pool_id" "$scratch/pools.txt"; then
  gcloud iam workload-identity-pools create "$pool_id" --location=global --project="$project_id" --display-name='HotelSuite staging GitHub' --quiet
fi
mapping='google.subject=assertion.sub,attribute.repository_id=assertion.repository_id'
condition="assertion.repository_id == '1161047380' && assertion.repository_owner_id == '134758375' && assertion.repository == '$repository' && assertion.ref == 'refs/heads/main' && assertion.workflow_ref == '$repository/.github/workflows/deploy-staging.yml@refs/heads/main' && assertion.sub == 'repo:$repository:environment:staging' && assertion.event_name == 'workflow_dispatch'"
gcloud iam workload-identity-pools providers list --workload-identity-pool="$pool_id" --location=global --project="$project_id" --format='value(name)' > "$scratch/providers.txt"
provider_action=create-oidc
if grep -Fxq "$provider" "$scratch/providers.txt"; then provider_action=update-oidc; fi
gcloud iam workload-identity-pools providers "$provider_action" "$provider_id" --workload-identity-pool="$pool_id" \
  --location=global --project="$project_id" --issuer-uri=https://token.actions.githubusercontent.com \
  --attribute-mapping="$mapping" --attribute-condition="$condition" --quiet
gcloud iam service-accounts add-iam-policy-binding "$deploy_account" --project="$project_id" \
  --member="principalSet://iam.googleapis.com/projects/$project_number/locations/global/workloadIdentityPools/$pool_id/attribute.repository_id/1161047380" \
  --role=roles/iam.workloadIdentityUser --condition=None --quiet >/dev/null

# Select only release and read permissions from Google's current role catalog.
gcloud iam roles describe roles/firebaseapphosting.admin --format=json > "$scratch/apphosting-role.json"
jq '{title:"HotelSuite staging source releaser",stage:"GA",description:"Source rollouts and staging resource metadata only",includedPermissions:([.includedPermissions[] | select(startswith("firebaseapphosting.") and (endswith(".get") or endswith(".list") or . == "firebaseapphosting.builds.create" or . == "firebaseapphosting.rollouts.create"))] + ["storage.buckets.list","storage.buckets.get","storage.buckets.getIamPolicy","resourcemanager.projects.getIamPolicy"])}' "$scratch/apphosting-role.json" > "$scratch/release-role.json"
jq -e '(.includedPermissions | index("firebaseapphosting.builds.create")) != null and (.includedPermissions | index("firebaseapphosting.rollouts.create")) != null' "$scratch/release-role.json" >/dev/null || fail 'App Hosting permission catalog changed; review before granting CI permissions.'
gcloud iam roles list --project="$project_id" --format='value(name)' > "$scratch/roles.txt"
role_action=create
if grep -Fxq "projects/$project_id/roles/hotelsuiteStagingRelease" "$scratch/roles.txt"; then role_action=update; fi
gcloud iam roles "$role_action" hotelsuiteStagingRelease --project="$project_id" --file="$scratch/release-role.json" --quiet
for role in roles/cloudfunctions.admin roles/cloudscheduler.admin roles/firebase.viewer \
  roles/serviceusage.serviceUsageConsumer roles/firebaserules.admin roles/datastore.indexAdmin \
  roles/datastore.user roles/firebaseauth.viewer "projects/$project_id/roles/hotelsuiteStagingRelease"; do
  grant_project_role "$deploy_account" "$role"
done
for role in roles/datastore.user roles/firebaseauth.admin roles/eventarc.eventReceiver roles/run.invoker roles/logging.logWriter; do
  grant_project_role "$runtime_account" "$role"
done

firebase_cli apphosting:backends:list --project "$project_id" --non-interactive --json > "$scratch/backends.json"
if ! jq -e --arg suffix "/backends/$backend_id" '.result[] | select(.name | endswith($suffix))' "$scratch/backends.json" >/dev/null; then
  # Non-interactive creation has no Git connection and does not start a rollout.
  firebase_cli apphosting:backends:create --backend "$backend_id" --primary-region "$region" \
    --app "$app_id" --root-dir / --project "$project_id" --non-interactive
fi
node "$(dirname "$0")/bootstrap-staging-apphosting.mjs" --apply --project "$project_id" --app-id "$app_id"
for account in "$runtime_account" "$apphosting_account"; do
  gcloud iam service-accounts describe "$account" --project="$project_id" >/dev/null
  gcloud iam service-accounts add-iam-policy-binding "$account" --project="$project_id" \
    --member="serviceAccount:$deploy_account" --role=roles/iam.serviceAccountUser --condition=None --quiet >/dev/null
done
# The CLI also checks the legacy default identity when it exists, even for v2.
# Do not create an App Engine application merely to manufacture this account.
gcloud iam service-accounts list --project="$project_id" --format='value(email)' > "$scratch/accounts.txt"
if grep -Fxq "$project_id@appspot.gserviceaccount.com" "$scratch/accounts.txt"; then
  gcloud iam service-accounts add-iam-policy-binding "$project_id@appspot.gserviceaccount.com" --project="$project_id" \
    --member="serviceAccount:$deploy_account" --role=roles/iam.serviceAccountUser --condition=None --quiet >/dev/null
fi
for function_region in us-central1 us-west1 europe-west1; do
  build_account=$(gcloud builds get-default-service-account --project="$project_id" --region="$function_region")
  build_account=${build_account##*/}
  [[ "$build_account" == *"$project_number"* || "$build_account" == *"@$project_id.iam.gserviceaccount.com" ]] || fail 'Build identity is not from staging.'
  grant_project_role "$build_account" roles/cloudbuild.builds.builder
  gcloud iam service-accounts add-iam-policy-binding "$build_account" --project="$project_id" \
    --member="serviceAccount:$deploy_account" --role=roles/iam.serviceAccountUser --condition=None --quiet >/dev/null
  gcloud artifacts repositories list --location="$function_region" --project="$project_id" --format='value(name)' > "$scratch/artifacts.txt"
  if ! grep -Fxq "projects/$project_id/locations/$function_region/repositories/gcf-artifacts" "$scratch/artifacts.txt"; then
    gcloud artifacts repositories create gcf-artifacts --repository-format=docker --location="$function_region" --project="$project_id" --quiet
  fi
  existing_policies=$(gcloud artifacts repositories describe gcf-artifacts --location="$function_region" --project="$project_id" --format='value(cleanupPolicies)')
  if [[ -z "$existing_policies" ]]; then
    printf '[{"name":"staging-preview-retention","action":{"type":"Delete"},"condition":{"tagState":"any","olderThan":"30d"}},{"name":"staging-keep-recent","action":{"type":"Keep"},"mostRecentVersions":{"keepCount":5}}]\n' > "$scratch/artifact-policy.json"
    gcloud artifacts repositories set-cleanup-policies gcf-artifacts --location="$function_region" --project="$project_id" \
      --policy="$scratch/artifact-policy.json" --dry-run --quiet
  fi
done
for service in pubsub.googleapis.com eventarc.googleapis.com firebasestorage.googleapis.com firebaseapphosting.googleapis.com; do
  gcloud beta services identity create --service="$service" --project="$project_id" --quiet >/dev/null
done
grant_project_role "service-$project_number@gcp-sa-eventarc.iam.gserviceaccount.com" roles/eventarc.serviceAgent
grant_project_role "service-$project_number@gcp-sa-firebasestorage.iam.gserviceaccount.com" roles/firebaserules.firestoreServiceAgent
# Firebase's first Functions deployment checks this Google-managed Pub/Sub role
# at project scope. A runtime-SA-only grant causes its CI IAM repair to fail.
grant_project_role "service-$project_number@gcp-sa-pubsub.iam.gserviceaccount.com" roles/iam.serviceAccountTokenCreator
gcloud storage service-agent --project="$project_id" >/dev/null
grant_project_role "service-$project_number@gs-project-accounts.iam.gserviceaccount.com" roles/pubsub.publisher

source_bucket="firebaseapphosting-sources-$project_number-$region"
gcloud storage buckets list --project="$project_id" --format=json > "$scratch/buckets.json"
if ! jq -e --arg bucket "$source_bucket" '.[] | select(.name == $bucket or .name == ("gs://" + $bucket))' "$scratch/buckets.json" >/dev/null; then
  gcloud storage buckets create "gs://$source_bucket" --location="$region" --project="$project_id" --uniform-bucket-level-access --public-access-prevention
fi
gcloud storage buckets update "gs://$source_bucket" --update-labels="apphosting-source-$region=true" --project="$project_id"
gcloud storage buckets add-iam-policy-binding "gs://$source_bucket" --member="serviceAccount:$deploy_account" --role=roles/storage.objectAdmin --project="$project_id" >/dev/null
for account in "$apphosting_account" "service-$project_number@gcp-sa-firebaseapphosting.iam.gserviceaccount.com"; do
  gcloud storage buckets add-iam-policy-binding "gs://$source_bucket" --member="serviceAccount:$account" --role=roles/storage.objectViewer --project="$project_id" >/dev/null
done

default_bucket="$project_id.firebasestorage.app"
if jq -e --arg bucket "$default_bucket" '.[] | select(.name == $bucket or .name == ("gs://" + $bucket))' "$scratch/buckets.json" >/dev/null; then
  actual_location=$(gcloud storage buckets describe "gs://$default_bucket" --project="$project_id" --format='value(location)')
  [[ "${actual_location,,}" == "$storage_location" ]] || fail 'Existing default Storage location differs; no bucket is moved.'
  gcloud storage buckets add-iam-policy-binding "gs://$default_bucket" --member="serviceAccount:$runtime_account" --role=roles/storage.objectAdmin --project="$project_id" >/dev/null
  gcloud storage buckets add-iam-policy-binding "gs://$default_bucket" --member="serviceAccount:$deploy_account" --role=roles/storage.objectViewer --project="$project_id" >/dev/null
else
  printf '\nPENDING: Firebase Console > %s > Storage > Get started > production mode > %s.\n' "$project_id" "$storage_location"
  printf 'Create default Firebase bucket %s there, then rerun this exact bootstrap command.\n' "$default_bucket"
fi
cat <<SETTINGS

Infrastructure operations completed; this is NOT evidence of a working release.
Remaining Console/GitHub controls are in docs/staging-safe-releases.md.
Set GitHub Environment staging variables (never repository production credentials):
STAGING_PROJECT_NUMBER=$project_number
STAGING_WORKLOAD_IDENTITY_PROVIDER=$provider
STAGING_DEPLOY_SERVICE_ACCOUNT=$deploy_account
STAGING_APPHOSTING_BACKEND_ID=$backend_id
STAGING_APPHOSTING_REGION=$region
STAGING_APP_BASE_URL=https://$backend_id--$project_id.$region.hosted.app
STAGING_DEPLOY_ENABLED=false
Web app ID: $app_id
Keep deployment disabled until Storage, App Hosting environment/runtime, Auth
authorized domain, GitHub Environment protection and fictional seed are ready.
The printed URL is an expected address, not a verified live staging URL.
SETTINGS
