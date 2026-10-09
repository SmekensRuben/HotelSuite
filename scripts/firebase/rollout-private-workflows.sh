#!/usr/bin/env bash
# Upload this single file to Cloud Shell. Sources are pinned; no Git clone is required.
set -euo pipefail
umask 077
apply=false
release_sha=""
while (( $# )); do
  case "$1" in
    --apply) apply=true; shift ;;
    --release-sha) release_sha="${2:?Provide the reviewed main SHA}"; shift 2 ;;
    *) echo "Use --release-sha <40-character SHA> [--apply]." >&2; exit 1 ;;
  esac
done
[[ "$release_sha" =~ ^[a-f0-9]{40}$ ]] || { echo "An exact reviewed release SHA is required." >&2; exit 1; }
for tool in node npm gcloud curl; do command -v "$tool" >/dev/null || { echo "Cloud Shell needs $tool." >&2; exit 1; }; done
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) throw new Error("Use Node 22 or newer.")'
operator=$(gcloud auth list --filter=status:ACTIVE --format='value(account)')
project_number=$(gcloud projects describe hotel-toolkit --format='value(projectNumber)')
[[ "$operator" == bestsmekens@gmail.com && "$project_number" == 358734544002 ]] || { echo "Use the reviewed hotel-toolkit release operator." >&2; exit 1; }
rollout_dir=$(mktemp -d "${HOME}/hotelsuite-private-rollout-XXXXXX")
echo "Reviewed release: $release_sha"
echo "Operator-local workspace and private backups: $rollout_dir"
source_url="https://raw.githubusercontent.com/SmekensRuben/HotelSuite/${release_sha}"
files=(package.json package-lock.json functions/src/permissionCatalog.json firebase/firestore.rules firebase/storage.rules
  scripts/firebase/saas-rollout.mjs scripts/firebase/saas-rules-release.mjs scripts/firebase/saas-release-check.mjs
  scripts/firebase/private-workflows-rollout.mjs scripts/firebase/private-workflows-migration.mjs)
for file in "${files[@]}"; do
  mkdir -p "$rollout_dir/$(dirname "$file")"
  curl --fail --silent --show-error --proto '=https' --tlsv1.2 "$source_url/$file" --output "$rollout_dir/$file"
done
cd "$rollout_dir"
export SAAS_RELEASE_SHA="$release_sha"
node scripts/firebase/saas-release-check.mjs
npm ci --ignore-scripts --no-audit --no-fund >/dev/null
node scripts/firebase/saas-rollout.mjs preflight
node scripts/firebase/private-workflows-rollout.mjs preflight
if [[ "$apply" != true ]]; then
  echo "Read-only preflight completed. --apply publishes reviewed Rules, copies private documents, revokes legacy download links and enables the backend after propagation."
  exit 0
fi
node scripts/firebase/saas-release-check.mjs
node scripts/firebase/private-workflows-rollout.mjs pause
node scripts/firebase/saas-rollout.mjs pause
node scripts/firebase/saas-rollout.mjs preflight
node scripts/firebase/private-workflows-rollout.mjs preflight
export SAAS_RULES_BACKUP_FILE="$rollout_dir/previous-rules.json"
export PRIVATE_WORKFLOWS_BACKUP_FILE="$rollout_dir/previous-private-records.json"
node scripts/firebase/saas-rollout.mjs deploy-rules
echo "Waiting ten minutes for Rules propagation. Procurement and private workflow writes remain paused."
for minute in {1..10}; do sleep 30; sleep 30; echo "Rules propagation: $minute/10 minutes."; done
node scripts/firebase/saas-release-check.mjs
node scripts/firebase/saas-rollout.mjs preflight
node scripts/firebase/private-workflows-rollout.mjs preflight
node scripts/firebase/saas-rollout.mjs migrate --rules-verified
node scripts/firebase/private-workflows-rollout.mjs migrate
node scripts/firebase/saas-release-check.mjs
node scripts/firebase/saas-rollout.mjs enable --rules-verified
node scripts/firebase/private-workflows-rollout.mjs enable
echo "Private workflows enabled. Keep both private backups in $rollout_dir. Existing subscriptions and memberships were preserved."
