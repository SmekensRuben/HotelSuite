#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="demo-hotel-suite-a00"
EXPORT_ROOT="$(mktemp -d)"
EXPORT_DIR="$EXPORT_ROOT/emulator-export"
trap 'rm -rf "$EXPORT_ROOT"' EXIT

npx firebase emulators:exec --project "$PROJECT_ID" --only auth,firestore,storage \
  --export-on-exit "$EXPORT_DIR" \
  "node scripts/firebase/emulator-backup-smoke.mjs seed"

npx firebase emulators:exec --project "$PROJECT_ID" --only auth,firestore,storage \
  --import "$EXPORT_DIR" \
  "node scripts/firebase/emulator-backup-smoke.mjs verify"
