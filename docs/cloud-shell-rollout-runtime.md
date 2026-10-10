# Cloud Shell rollout runtime and disk recovery

The uploadable SaaS and private-workflow rollout scripts use a separate locked operator package containing only Firebase Admin, the Firestore and Storage clients, and Google authentication. They do not install the frontend, Firebase CLI, emulators or development tools.

Dependency installation and npm's cache live in a unique private `/tmp/hotelsuite-operator-*` directory. The installer checks temporary disk space and inodes, imports every required library, and then connects the runtime to the pinned rollout sources. An exit trap removes only that generated runtime and its module link on both success and failure. The operator's rollout directory, reviewed sources, `previous-rules.json` and `previous-private-records.json` remain on the persistent home disk. Keep those backups; temporary dependencies can always be recreated from the reviewed release.

The operator lockfile has its own CI installation/import check and a zero-vulnerability dependency gate. Dependency installation must succeed before any gate pause, Rules publication or migration.

## Recover from an older script's ENOSPC error

The older scripts installed the complete root package in every persistent rollout directory. An `npm ci` ENOSPC error at that point occurs before their cloud mutations. Check both disk bytes and inodes:

```bash
df -h "$HOME" /tmp
df -i "$HOME" /tmp
```

Remove only regenerable dependency folders from generated HotelSuite rollout workspaces and the npm package cache:

```bash
for workspace in "$HOME"/hotelsuite-rollout-* "$HOME"/hotelsuite-private-rollout-*; do
  if [[ -d "$workspace" && ! -L "$workspace" ]]; then
    rm -rf -- "$workspace/node_modules"
  fi
done
rm -rf -- "$HOME/.npm/_cacache"
```

This leaves scripts, logs, credentials, npm configuration and all rollout backups in place. It does not touch other application repositories or their dependencies. Do not delete entire rollout directories to recover space.

Download the updated single-file wrapper to `/tmp` (which avoids the full home disk), then run it with the exact reviewed current-main SHA after CI, App Hosting and the actual Functions deployment succeed. The wrapper downloads its own pinned helper and lockfile; a Git clone or a separate runtime upload is unnecessary. Do not rerun an older uploaded wrapper with only a new SHA, since that wrapper still installs the full root package.

Use the command supplied with the reviewed release. A read-only run is the default; `--apply` performs the existing verified rollout. The release, IAM and migration checks remain unchanged.
