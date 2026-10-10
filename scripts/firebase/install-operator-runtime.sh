#!/usr/bin/env bash
# Source from the pinned rollout workspace. Keep recoverable dependencies and
# npm's package cache on Cloud Shell's temporary disk, never beside backups.
install_operator_runtime() {
  local available_kib available_inodes
  available_kib=$(df -Pk /tmp | awk 'NR == 2 {print $4}')
  available_inodes=$(df -Pi /tmp | awk 'NR == 2 {print $4}')
  if [[ ! "$available_kib" =~ ^[0-9]+$ || "$available_kib" -lt 1048576 || ! "$available_inodes" =~ ^[0-9]+$ || "$available_inodes" -lt 10000 ]]; then
    echo "The temporary disk needs at least 1 GiB and 10000 free inodes. No Rules or data were changed." >&2
    return 1
  fi
  operator_runtime_dir=$(mktemp -d /tmp/hotelsuite-operator-XXXXXX)
  trap cleanup_operator_runtime EXIT
  cp scripts/firebase/operator-runtime/package.json scripts/firebase/operator-runtime/package-lock.json "$operator_runtime_dir/"
  npm ci --prefix "$operator_runtime_dir" --cache "$operator_runtime_dir/npm-cache" --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null
  (cd "$operator_runtime_dir" && node -e 'Promise.all(["firebase-admin/app", "firebase-admin/auth", "firebase-admin/firestore", "firebase-admin/security-rules", "@google-cloud/firestore", "@google-cloud/storage", "google-auth-library"].map((name) => import(name))).catch((error) => { console.error(error); process.exitCode = 1; })')
  ln -s "$operator_runtime_dir/node_modules" "$rollout_dir/node_modules"
}

cleanup_operator_runtime() {
  if [[ -L "$rollout_dir/node_modules" && "$(readlink "$rollout_dir/node_modules")" == "$operator_runtime_dir/node_modules" ]]; then
    rm -- "$rollout_dir/node_modules"
  fi
  # Only the unique directory created above is disposable. Rules, records and
  # recovery backups remain in the operator's persistent rollout workspace.
  rm -rf -- "$operator_runtime_dir"
}
