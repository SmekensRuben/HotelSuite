#!/usr/bin/env bash
# Upload this single file to Cloud Shell. No Git clone is required.
set -euo pipefail
umask 077

apply=false
grant_storage=false
release_sha=""
while (( $# )); do
  case "$1" in
    --apply) apply=true; shift ;;
    --grant-storage-rules-access) grant_storage=true; shift ;;
    --release-sha) release_sha="${2:?Provide the exact reviewed main SHA}"; shift 2 ;;
    *) echo "Use --release-sha <40-character SHA> [--apply] [--grant-storage-rules-access]." >&2; exit 1 ;;
  esac
done
if [[ ! "$release_sha" =~ ^[a-f0-9]{40}$ ]]; then
  echo "An exact reviewed release SHA is required." >&2; exit 1
fi
if [[ "$grant_storage" == true && "$apply" != true ]]; then
  echo "IAM grants require the explicit --apply option." >&2; exit 1
fi
for tool in node npm gcloud curl python3; do
  command -v "$tool" >/dev/null || { echo "Cloud Shell needs $tool." >&2; exit 1; }
done
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) throw new Error("Use Node 22 or newer.")'
operator=$(gcloud auth list --filter=status:ACTIVE --format='value(account)')
project_number=$(gcloud projects describe hotel-toolkit --format='value(projectNumber)')
if [[ "$operator" != bestsmekens@gmail.com || "$project_number" != 358734544002 ]]; then
  echo "Use bestsmekens@gmail.com with the reviewed hotel-toolkit project. Nothing was changed." >&2; exit 1
fi

rollout_dir=$(mktemp -d "${HOME}/hotelsuite-rollout-XXXXXX")
echo "Reviewed release: $release_sha"
echo "Operator-local workspace and Rules backup: $rollout_dir"
source_url="https://raw.githubusercontent.com/SmekensRuben/HotelSuite/${release_sha}"
files=(scripts/firebase/operator-runtime/package.json scripts/firebase/operator-runtime/package-lock.json
  scripts/firebase/install-operator-runtime.sh functions/src/permissionCatalog.json firebase/firestore.rules firebase/storage.rules
  scripts/firebase/saas-rollout.mjs scripts/firebase/saas-rules-release.mjs scripts/firebase/saas-release-check.mjs)
for file in "${files[@]}"; do
  mkdir -p "$rollout_dir/$(dirname "$file")"
  curl --fail --silent --show-error --proto '=https' --tlsv1.2 "$source_url/$file" --output "$rollout_dir/$file"
done
cd "$rollout_dir"
export SAAS_RELEASE_SHA="$release_sha"
node scripts/firebase/saas-release-check.mjs
source scripts/firebase/install-operator-runtime.sh
install_operator_runtime
node scripts/firebase/saas-rollout.mjs preflight

storage_agent="service-358734544002@gcp-sa-firebasestorage.iam.gserviceaccount.com"
storage_role="roles/firebaserules.firestoreServiceAgent"
gcloud projects get-iam-policy hotel-toolkit --format=json > "$rollout_dir/project-iam.json"
storage_access=$(python3 - "$rollout_dir/project-iam.json" "$storage_agent" "$storage_role" <<'PY'
import json, sys
policy = json.load(open(sys.argv[1]))
print(str(any(b.get('role') == sys.argv[3] and not b.get('condition') and
  'serviceAccount:' + sys.argv[2] in b.get('members', []) for b in policy.get('bindings', []))).lower())
PY
)
if [[ "$apply" != true ]]; then
  echo "Read-only preflight completed. Storage cross-service Rules role present: $storage_access"
  echo "Use --apply for the reviewed Rules release, credential relocation and pilot activation."
  exit 0
fi
if [[ "$storage_access" != true ]]; then
  if [[ "$grant_storage" != true ]]; then
    echo "The Google Firebase Storage service agent needs $storage_role (Firestore document reads only)." >&2
    echo "Review this exact grant and rerun with --grant-storage-rules-access. No Rules or data were changed." >&2
    exit 1
  fi
  # Grant against our project policy, as the Firebase CLI does. Inspecting this
  # Google-managed account requires unrelated iam.serviceAccounts.get access.
  # A failed policy update stops the rollout before any Rules or data changes.
  gcloud projects add-iam-policy-binding hotel-toolkit --member="serviceAccount:$storage_agent" --role="$storage_role" --condition=None >/dev/null
fi
# Recheck current main immediately before changes. No CI/runtime account receives Rules admin access.
node scripts/firebase/saas-release-check.mjs
node scripts/firebase/saas-rollout.mjs pause
# Catch a delivery admitted immediately before the pause. Leave the pilot paused on failure.
node scripts/firebase/saas-rollout.mjs preflight
export SAAS_RULES_BACKUP_FILE="$rollout_dir/previous-rules.json"
node scripts/firebase/saas-rollout.mjs deploy-rules
node scripts/firebase/saas-rollout.mjs migrate --rules-verified
echo "Waiting ten minutes for Rules propagation. SaaS writes remain paused."
for minute in {1..10}; do
  sleep 30
  sleep 30
  echo "Rules propagation: $minute/10 minutes."
done
node scripts/firebase/saas-release-check.mjs
node scripts/firebase/saas-rollout.mjs enable --rules-verified
echo "SaaS procurement pilot enabled. Keep $rollout_dir/previous-rules.json for operator review."
