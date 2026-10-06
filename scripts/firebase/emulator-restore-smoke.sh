#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="demo-hotel-suite-a00"
EXPORT_ROOT="$(mktemp -d)"
EXPORT_DIR="$EXPORT_ROOT/firestore-export"
trap 'rm -rf "$EXPORT_ROOT"' EXIT

npx firebase emulators:exec --project "$PROJECT_ID" --only firestore \
  "node scripts/firebase/emulator-backup-smoke.mjs seed-and-export '$EXPORT_DIR'"

npx firebase emulators:exec --project "$PROJECT_ID" --only firestore \
  --import "$EXPORT_DIR" \
  "node scripts/firebase/emulator-backup-smoke.mjs verify"
