#!/usr/bin/env bash
set -euo pipefail

if [[ "${FIREBASE_PROJECT_ID:-}" != "hotel-toolkit" ]]; then
  echo "Functions runtime checks require explicit FIREBASE_PROJECT_ID=hotel-toolkit." >&2
  exit 1
fi
runtime_secrets=(MEILI_HOST MEILI_INDEX MEILI_API_KEY RESEND_API_KEY RESEND_FROM RESEND_WEBHOOK_SECRET)
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
node --input-type=module <<'NODE'
import { writeFileSync } from 'node:fs';
import { requireFunctionsConfiguration } from './scripts/firebase/functions-release-policy.mjs';
const origin = requireFunctionsConfiguration(process.env);
writeFileSync('functions/.env.hotel-toolkit', `APP_BASE_URL=${origin}\n`, { mode: 0o600 });
console.log('Prepared the public APP_BASE_URL parameter for hotel-toolkit.');
NODE
