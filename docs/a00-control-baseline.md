# A00 — Control baseline

Baseline date: **2026-10-05 UTC**

Starting commit: `5c41372` (`work`)

Baseline owner: platform team

This document separates observations that were verified from this checkout from cloud state that still requires an authenticated operator. It is not evidence that the local rules in `firebase/` are deployed.

## 1. Safety boundary

- All automated A00 tests use the reserved demo project ID `demo-hotel-suite-a00` and the local Firebase emulators. They contain only fictional hotels `hotel-a` and `hotel-b`.
- No production or audit-cloud data is required by the security or restore tests.
- No cloud deploy, data write, export or configuration mutation was performed during this baseline.
- **Migration gate:** do not run a production data migration until an authenticated operator has completed the cloud inventory, exported Firestore and Storage, recorded object counts/checksums and completed a restore into a separate project.

## 2. Project and environment inventory

| Resource | Verified observation | Confidence / missing evidence |
| --- | --- | --- |
| Repository default Firebase alias | `.firebaserc` maps `default` to `test-breakfast`. | Verified locally; not proof of deployment target. |
| Previously tracked frontend config | The local `.env` points to project `lobby-logic`, auth domain `lobby-logic.firebaseapp.com`, bucket `lobby-logic.firebasestorage.app` and `https://search.hoteltoolkit.eu`. | Verified without recording secret values. This conflicts with `.firebaserc`. `.env` is removed from Git by A00; history remains and keys must be reviewed/rotated. |
| Public website | `https://hoteltoolkit.eu` returned the Hotel Toolkit SPA on 2026-10-05; DNS resolved to `92.205.8.207`. | Verified over public HTTP/DNS. The workflow indicates GoDaddy FTPS, but the account/server identity is only in GitHub secrets. |
| Firebase Hosting candidates | GET requests to `https://lobby-logic.web.app` and `https://test-breakfast.web.app` returned 404. | Reachability does not prove that Hosting is unused or that other sites do not exist. Authenticated `hosting:sites:list` is required. |
| Search service | `https://search.hoteltoolkit.eu/health` returned `available`; DNS resolved to `157.180.21.52`. The version endpoint required bearer auth. | Service is active. Index names in code are `catalogproducts` and `supplierproducts`; index settings, document counts, snapshots and key scopes are unverified. |
| Functions declared by this checkout | 19 exports: Meilisearch synchronizers, Resend webhook/mail queue, contract/order mail workflows, file import, scheduled occupancy/block/upsell/guest tasks, arrival callables and stay-pattern rebuild. | Source inventory only. Deployed names, regions, revisions, invoker policy and environment/secrets require authenticated listing. |
| Incoming webhook | A Resend HTTP function exists in source. | Deployed URL, signature secret/configuration, delivery history and rate limiting are unverified. |
| Databases and buckets | Code expects default Firestore and one Firebase Storage bucket. | Database IDs/regions, bucket list, lifecycle policies and CORS are unverified. |
| Authentication | Code requires verified email and enrolled MFA for protected UI routes. | Enabled providers, password policy, authorized domains, MFA enforcement outside the UI, App Check and tenant settings are unverified. |
| Monitoring | Functions emit Cloud Logging entries. | Alert policies, error reporting, uptime checks, budgets, log retention and notification channels are unverified. |
| Backup | No backup/export schedule was found in the repository. | Cloud schedules, retention and prior restore evidence are unverified. |

### Authentication result

Firebase CLI 15.32.1 is installed as a pinned development dependency, but this environment has no authenticated Firebase user or Application Default Credentials. `firebase projects:list --json --non-interactive` fails with “Failed to authenticate”. Therefore deployed rules, indexes and resource lists could not safely be downloaded in this run.

## 3. Rules and indexes baseline

Before A00, `firebase.json` referenced neither Firestore nor Storage rules or indexes. A00 adds:

- `firebase/firestore.rules`: proposed fail-closed tenant and permission baseline;
- `firebase/storage.rules`: proposed tenant-aware contract/import boundary using a server-issued per-hotel `hotelPermissions` custom-claim map (claims provisioning is required before deployment);
- `firebase/firestore.indexes.json`: an explicitly empty **local** composite-index baseline;
- emulator configuration and security tests.

These files must not be described as the deployed baseline until the comparison below is completed. An empty index file means “no index could be retrieved”, not “production has no indexes”.

The subsequent permission audit and complete route/action mapping are maintained in `docs/permission-matrix.md`. That policy uses per-hotel membership documents and therefore has explicit migration prerequisites before rules publication.

### Required authenticated capture

Run from a clean, authorized workstation and store command output in the restricted audit evidence location (not in Git when it contains customer identifiers):

```bash
firebase login
firebase projects:list
firebase use <AUDIT_PROJECT_ID>
firebase firestore:databases:list
firebase functions:list
firebase hosting:sites:list
firebase firestore:indexes > /tmp/deployed-firestore-indexes.txt
```

List Storage buckets and their lifecycle/CORS configuration with authenticated Google Cloud tooling or the Cloud Console; Firebase CLI 15 does not expose a bucket-list command.

The Firebase CLI does not provide a dependable universal “download currently deployed rules” command for every ruleset/version. Use the Google Cloud/Firebase Rules API or console export with an authenticated account, preserve the ruleset/release IDs and checksums, and then compare:

```bash
diff -u audit-evidence/deployed-firestore.rules firebase/firestore.rules
diff -u audit-evidence/deployed-storage.rules firebase/storage.rules
diff -u audit-evidence/deployed-firestore.indexes.json firebase/firestore.indexes.json
```

Do not deploy the proposed files merely to discover differences: that would destroy the evidence being collected.

## 4. Isolated test environment

`npm run test:security` starts Firestore and Storage emulators and creates these fictional actors/data in test setup:

| Actor | Scope | Expected behavior |
| --- | --- | --- |
| Platform administrator | Hotels A and B, `platformAdmin` claim | May inspect both fictional hotels. |
| Hotel A administrator | Hotel A, catalog/groups/settings wildcard permissions | May administer allowed Hotel A areas; cannot cross to Hotel B or alter global users. |
| Hotel A employee | Hotel A, `catalogproducts.read` | May read Hotel A catalog only; cannot write or read Hotel B. |
| Hotel B employee | Hotel B, `catalogproducts.read` | Used as the cross-tenant denial target. |
| External rooming-list visitor | Unauthenticated, high-entropy token | May read only an active, unexpired root summary. Public writes and version/change-request reads are deliberately denied. |

The last behavior is a temporary containment measure. It intentionally makes the existing external edit/submit flow incomplete until that flow is moved behind a server-side capability boundary.

## 5. Temporary measures for unresolved exposure

Until deployed rules are captured, reviewed and tested:

1. **Rooming-list route:** do not issue new public rooming-list links and revoke/disable existing links at the operational level. When the A00 rules are deployed after review, only explicitly enabled, expiring root links remain publicly readable; public mutation remains disabled.
2. **User management:** restrict `/settings/users` operationally to platform administrators. The proposed rules reject global list/update for hotel administrators, so the existing client screen will fail closed rather than expose other hotels.
3. **Supplier credentials:** rotate any webshop/SFTP passwords ever stored in supplier documents and stop adding new credentials there until server-only secret storage exists. Firestore rules cannot hide selected fields in an otherwise readable document.

## 6. Backup and restore route

### Early local restore proof

`npm run test:restore` performs a complete, non-cloud smoke test:

1. start a clean Firestore emulator;
2. write a fictional marker for hotels A and B;
3. export the emulator;
4. stop it;
5. start a new emulator from the export;
6. verify the exact marker.

This restore proof passed on 2026-10-05 UTC.

### Production/audit project procedure

Before any migration:

1. Record project ID, database ID, bucket names, regions and migration ticket.
2. Trigger/verify a Firestore managed export to a versioned, access-restricted bucket.
3. Copy/version Storage objects or confirm bucket object versioning and retention lock.
4. Record export operation ID, start/end time, object/document counts and manifest checksum.
5. Restore into a separate non-production Firebase/GCP project.
6. Verify tenant A/B sample counts and application smoke checks without using production credentials.
7. Record RPO/RTO achieved, discrepancies and approver; only then authorize migration.

No production backup was created in this run because no cloud credentials were available. This remains a hard migration blocker.

## 7. Dependency and bundle baseline

### Runtime dependency inventory

- Root lockfile: 69 known production findings at capture time — 6 critical, 42 high, 16 moderate and 5 low.
- Functions lockfile: 27 known production findings — 3 critical, 10 high, 13 moderate and 1 low.
- Direct packages requiring remediation are named in `config/dependency-audit-policy.json`.
- The policy is a temporary, expiring ceiling, not risk acceptance. It fails CI if counts increase, a new vulnerable direct dependency appears or the review date passes.

### Bundle baseline

`npm run build` on the starting code produced:

| Asset | Minified | Gzip |
| --- | ---: | ---: |
| Main JavaScript bundle | 2,957.04 kB | 812.82 kB |
| Main CSS bundle | 59.06 kB | 10.58 kB |

The Vite 500 kB chunk warning is the initial performance regression signal.

## 8. Query and cost baseline

The repository has no billing export or query telemetry, so actual cost per hotel cannot be measured from this environment. Initial code-derived query risks to measure in the audit project are:

| Flow | Current query shape | Measurement to capture |
| --- | --- | --- |
| User Management | Full global `users` collection read, then client-side filtering. | Reads per load and denied-query count after tenant rules. |
| Products/Supplier Products | Meilisearch when configured; Firestore fallback with pagination plus some full-collection export/index paths. | Search calls, Firestore fallback frequency, reads per result page/export. |
| Group Quote analysis | Multiple report/snapshot collection reads; existing design documentation notes eight logical Firestore operations but billed document reads depend on collection size. | Documents read, latency and analysis count per hotel. |
| Rooming list | Root plus complete versions and change-request collections, then linked group read. | Reads and writes per external session; currently blocked publicly by temporary rules. |

Enable Firestore usage/billing export or Cloud Monitoring metrics in the audit project, run the four flows with fixed fixture sizes, and record per-hotel daily read/write/storage estimates here before broader sale.

## 9. Completion status

| A00 exit criterion | Status |
| --- | --- |
| Actual deployed rules known | **Blocked:** authenticated cloud capture required. |
| Two isolated fictional hotels and actor matrix | **Complete locally:** emulator security suite. |
| Failed security/test/dependency change blocks deploy | **Complete in CI configuration.** |
| Production data unnecessary for development tests | **Complete for added security and restore suites.** |
| First restore proof | **Complete locally on 2026-10-05; cloud restore remains blocked.** |
| Unresolved exposure has temporary action | **Documented above; operational execution requires the owner.** |

A00 as a whole remains **open** until authenticated inventory, deployed-rules comparison, production/audit backup and separate-project restore evidence are attached.
