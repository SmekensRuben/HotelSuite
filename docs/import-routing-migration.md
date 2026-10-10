# Receiving identity and import receipt rollout

This runbook implements audit F01–F03. No live migration or provider delivery was executed during remediation. Keep a receiving-provider delivery pause in place through preflight, backup, Functions/Rules activation, migration verification and two-hotel staging acceptance. Never restore the legacy webhook/index consumers as a rollback: pause inbound delivery and repair the new registry instead.

## Ownership and compatibility

The operator-owned registry is `importReceivingIdentities/{sha256(JSON(["resend", normalizedReceiver]))}`. Each record has `schemaVersion: 1`, `provider: "resend"`, the normalized `receiver`, one immutable `hotelUid`, explicit `enabled`, and reviewed ownership evidence. Client access, including platform-admin client SDK writes, is denied by Rules. Only an appropriately authorized server operator provisions it. The tool refuses to transfer an existing identity to another hotel, including a disabled identity. Provision a new dedicated address for a new owner.

The signed Resend `email.received` event's documented `data.to` field is the receiving identity input. Every email must resolve to exactly one enabled registry identity. Unknown-only and multi-identity recipients fail closed. Tenant sender/subject/file-type settings are read only below the bound hotel's canonical `fileImportSettings`. Two matching enabled settings fail closed before downloading bytes. `data.deliveredTo`, `data.recipient`, CC/BCC fields and tenant-editable `hotelUid` fields are not alternate receiving authority. Test actual provider recipient semantics with separate dedicated tenant inboxes before enabling production delivery. Resend's documented received-event example is at https://resend.com/features/webhooks.

Existing canonical route documents keep their configured sender, subject and file type. Their legacy `toEmail` continues working when it equals the explicitly provisioned receiving identity of their own hotel; no new `receiverId` field is required. No identity is inferred from a tenant's claim. Preflight lists every enabled legacy setting without an owned receiving identity and blocks application. If hotels previously shared an address, provision separate addresses and use explicit `settingMoves` below; the tool changes only the reviewed receiving fields and retains the rest of each route. Tenant edits during a move cause a precondition failure, not overwrites.

The two global projection collections now use `sha256(JSON([hotelUid, localId]))`, `projectionVersion: 2`, and an authoritative `sourcePath`. Triggers transactionally reread canonical sources and guard existing projection ownership before writes/deletes. A delayed event reflects current canonical state. Webhook routing and parser selection do not read either global index, including legacy IDs. Parser configuration comes from exactly one enabled canonical type within the object hotel's collection. This allows migration without a projection backfill availability gap. Qualified projections remain server-only administrative mirrors.

## Explicit manifest and dry run

Create a private operator manifest with the exact project and evidence from the receiving provider's domain/inbox configuration. The following is fictional staging input:

```json
{
  "schemaVersion": 1,
  "projectId": "demo-hotel-imports",
  "bindings": [
    { "receiver": "reports-a@example.test", "hotelUid": "hotel-a", "enabled": true, "ownershipEvidence": "Operator reviewed the dedicated Hotel A receiving address" },
    { "receiver": "reports-b@example.test", "hotelUid": "hotel-b", "enabled": true, "ownershipEvidence": "Operator reviewed the dedicated Hotel B receiving address" }
  ],
  "settingMoves": [
    { "sourcePath": "hotels/hotel-b/fileImportSettings/existing-local-id", "fromReceiver": "legacy-shared@example.test", "toReceiver": "reports-b@example.test" }
  ]
}
```

Omit `settingMoves` when the existing receiver is already dedicated and owned. Set `enabled: false` only when the associated canonical routes are also disabled or deliberately moved; enabled routes bound to a disabled receiver block preflight. The manifest must cover every enabled canonical route, not just a sample hotel. Exact duplicate sender/subject settings and duplicate enabled parser file types are blockers. Review overlapping subject substrings separately, because a future email may match two different patterns even if those patterns are not equal; runtime rejects such ambiguous matches.

Dependencies are resolved from the repository's installed `functions` dependencies. Emulator use requires a `demo-` project and a local Firestore emulator:

```bash
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node scripts/firebase/import-routing-migration.mjs preflight /private/import-manifest.json --project demo-hotel-imports --emulator
```

An authorized live operator uses the same preflight with an explicitly reviewed real project and without `--emulator`; no project is selected implicitly from `.firebaserc`. Do not execute live commands as part of local remediation. Preflight is read-only, bounded and fails rather than silently skipping records when there are more than 500 hotels, 2,000 source documents per hotel/collection or 10,000 projections per index. A larger installation needs a staged inventory design before rollout.

## Apply and verify under a delivery pause

1. Review every preflight issue and resolve ownership using provider/operator evidence. Inventory existing queued/replayed received events and previously imported generations so old events are not mistaken for new work. Export the canonical routes/types and existing imported objects under the site's backup process.
2. Activate reviewed Rules denying browser access to receiving identities, ingress receipts, import runs/chunks and global mirrors. Deploy the reviewed webhook, projection triggers and import finalize worker together. Confirm the provider remains paused and the storage trigger retry policy is active. Old workers must drain/stop before replaying imports.
3. Rerun preflight. Apply requires an unused private backup filename and a matching `--confirm-project`. The backup includes the manifest, every canonical source, previous receiving records and all projection snapshots; mode `0600` and exclusive creation prevent accidental overwrite. Use `--prune-legacy` explicitly to remove backed-up legacy index IDs after qualified projections are rebuilt. Newly qualified or concurrently changed records are never pruned.

```bash
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node scripts/firebase/import-routing-migration.mjs apply /private/import-manifest.json --project demo-hotel-imports --emulator --backup /private/import-backup.json --confirm-project demo-hotel-imports --prune-legacy
```

4. Application is resumable: receiver ownership is immutable, already-applied moves are recognized, projections are reread transactionally, and pruning checks exact backed-up snapshots. The post-apply preflight must report no issues, zero legacy projections when pruning is requested, and zero orphan qualified projections. A partial failure keeps delivery paused; obtain a fresh backup/preflight before retrying.
5. In staging, send representative reports to the two separate inboxes, including identical local setting/type IDs in both hotels. Verify each raw object and each parsed record belongs to its intended hotel. Test unknown receiver, two owned recipients, overlapping settings, unchanged replay and concurrent replay. After a simulated process crash, verify that the same object generation resumes without duplicate append rows or unkeyed list entries. Confirm B cannot read A's bytes with B's session. Do not enable live delivery until these checks and deployed Rules/Functions parity pass.

## Durable processing and operational recovery

Ingress receipt identity is the provider `email_id` plus attachment ID. Changing the Svix delivery ID cannot bypass it. `importIngressReceipts/{receiptId}` records a fixed routing descriptor, leased owner and completed result. An in-flight concurrent request receives retryable HTTP 503. After a worker crash the five-minute lease expires; ordinary handled failures release it immediately. Stored paths are deterministic and Storage writes use `ifGenerationMatch: 0`; a retry after the object was already created validates matching receipt/route metadata and does not create another finalize generation. A different routing descriptor for an already claimed provider attachment is a conflict requiring operator review, not a second tenant write.

Every Storage source, including manual uploads and SFTP-created imports, is handled by its bucket/name/generation identity; no email receipt is required for non-email sources. The worker pins reads to the event's generation. `hotels/{hotelUid}/importRuns/{runId}` freezes the parser configuration and relative target date on first claim. Enabled subscription and path/metadata tenant checks remain in force. Completed runs return without reparsing. Resume uses the frozen configuration even if an operator later edits the canonical type; finish/replay that queued generation or investigate it rather than deleting checkpoints. A new generation creates a new run.

Each group of at most 50 mapped source rows atomically commits its business writes and `chunks/{chunkIndex}` checkpoint. Append document IDs are deterministic for run/row; explicit document merges and unkeyed list additions are applied once per chunk. The transaction reads current targets, enforces chunk order, checks the leased run owner and refreshes the lease. A lost commit acknowledgment cannot duplicate already committed work. A changed parser result for a committed chunk fails closed for operator review. Import targets cannot write server-owned receipt/configuration collections. The target depth/atomic-write bounds are explicit; excessive configurations fail visibly.

Do not TTL/delete receipt or chunk documents while a provider replay or object retry remains possible: deleting deduplication evidence reopens processing. Align retention with provider replay policy and existing raw-source retention before adding cleanup. This remediation deliberately does not execute bulk historical-object reprocessing or repair already duplicated records. A historical object first delivered to the new worker has no old checkpoint and may append data again; inventory historical generations and explicitly seed reviewed completed run identities or exclude them under an operator-controlled recovery plan before replay. Existing business semantics of replacement versus accumulation remain unchanged.

Stay Pattern model rebuilding remains a post-import step with its existing logged failure/staleness behavior. Raw import completion is durable before that rebuild; a process death in that interval requires the existing model-rebuild recovery path. It must not repeat business writes to rebuild the model.

## Remaining live acceptance

Provider address/domain ownership and actual `data.to` envelope behavior; Rules/Functions deployment parity; operator manifest, migration backup and index verification; existing raw-object access/retention policy; historical-event replay policy; IAM/secret access; real two-hotel raw-byte/parsed-record acceptance; operational observation of lease retry and generation-pinned Storage reads. None is established by the local Node tests alone.
