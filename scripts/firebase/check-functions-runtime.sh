#!/usr/bin/env bash
set -euo pipefail

if [[ "${FIREBASE_PROJECT_ID:-}" != "hotel-toolkit" ]]; then
  echo "Functions runtime checks require explicit FIREBASE_PROJECT_ID=hotel-toolkit." >&2
  exit 1
fi
runtime_secrets=(MEILI_HOST MEILI_INDEX MEILI_API_KEY RESEND_API_KEY RESEND_FROM RESEND_WEBHOOK_SECRET OPENAI_API_KEY)
missing=()
for secret in "${runtime_secrets[@]}"; do
  # Metadata only. Never print or export secret values into GitHub.
  if ! state=$(gcloud secrets versions describe latest --secret="$secret" --project=hotel-toolkit --format='value(state)' 2>/dev/null) || [[ "$state" != "ENABLED" ]]; then
    missing+=("$secret")
  fi
done
if (( ${#missing[@]} )); then
  printf 'Functions deployment stopped. Missing, inaccessible or disabled latest secret versions: %s\n' "${missing[*]}" >&2
  echo "Provision real values in Google Secret Manager and grant the runtime account access before retrying." >&2
  exit 1
fi
# A newly bound secret needs one resource-scoped runtime grant. CI can inspect
# metadata but must not broaden its own IAM authority or read the key value.
if ! gcloud secrets get-iam-policy OPENAI_API_KEY --project=hotel-toolkit --format=json 2>/dev/null | node --input-type=module -e '
  let data = ""; for await (const chunk of process.stdin) data += chunk;
  try {
    const policy = JSON.parse(data);
    const member = "serviceAccount:358734544002-compute@developer.gserviceaccount.com";
    if (!policy.bindings?.some(binding => binding.role === "roles/secretmanager.secretAccessor"
      && !binding.condition && binding.members?.includes(member))) process.exit(1);
  } catch { process.exit(1); }
'; then
  echo "Functions deployment stopped. OPENAI_API_KEY needs an unconditional, secret-scoped Secret Accessor grant for 358734544002-compute@developer.gserviceaccount.com. Configure this once on this secret in Google Cloud; key values are never read by CI." >&2
  exit 1
fi
node scripts/firebase/mcp-deployment-config.mjs
