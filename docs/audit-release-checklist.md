# Audit remediation release acceptance

This branch is reviewable code, not a production release. Do not merge it until the migration/release sequence is agreed and the checks below are satisfied. `main` can activate automatic Functions/frontend rollouts; Rules and data migrations are separate operations.

## Repository verification

Run on Node 22.13+ and Java 21 with fictional emulator projects only:

```sh
npm ci
npm --prefix functions ci
npm run lint
npm run typecheck
npm test -- --run
npm --prefix functions test
node --test scripts/migrate-domain-settings.test.mjs
npm run test:security
npm run test:restore
npm run audit:policy
npm run build:test
```

CI additionally verifies the locked operator runtime, deployment-script syntax and App Hosting with the non-production configuration. `checkJs` is incremental, covering environment/number input boundaries; lint checks live JavaScript correctness across frontend, Functions and operator scripts. Neither substitutes for scenario tests or browser acceptance.

Runtime audits permit **zero exceptions** in all three scopes. SheetJS is pinned to its official 0.20.3 distribution with lockfile integrity; the npm registry's old 0.18.5 package is not an acceptable substitute. gRPC is overridden to 1.14.6, and ExcelJS's UUID to CJS-compatible 11.1.1. Tests exercise real spreadsheet round-trips and ExcelJS extended formatting. Review/update overrides when upgrading their parent packages.

## GitHub merge control

The connected GitHub tools expose no branch-protection/ruleset administration. Code cannot configure this account-level control. In repository Settings, protect `main` with a pull-request requirement, required `verify` status from **Verify HotelSuite**, required conversation resolution and no force pushes/deletion. Enable administration enforcement/restricted bypass according to the owner's access policy. Verify the rule with an attempted noncompliant branch update or GitHub's ruleset evaluation before considering F22 operationally complete. This draft PR does not enable auto-merge.

## Sequenced migrations and deployment

1. Capture a recoverable private backup and inventory of actual Rules, Functions, claims, subscription state, import objects/receipts and legacy settings. Export Auth users/claims and private Storage bytes/metadata separately using the approved operator process.
2. Dry-run and review [settings migration](settings-configuration-migration.md). Canonical target conflicts abort; legacy/unknown source data stays available to the operator. Do not deploy clients that depend on new domains before their configuration exists.
3. Dry-run and review [import receiving-identity/index migration](import-routing-migration.md). Confirm physical mailbox ownership and provider recipient semantics; create owned registries before activating the new receiver. Inventory historical already-processed objects: absent receipts are not evidence that replay is safe.
4. Migrate scheduled recipients to explicit per-hotel user IDs using the scheduled-worker runbook. Do not restore old raw-email broadcast behavior. Confirm provider acknowledgments/idempotency retention and manually reconcile any ambiguous sends.
5. Deploy matching protected Functions, Firestore/Storage Rules and frontend in a controlled sequence. Inventory/rollback scripts and external hosting behavior must match the exact reviewed SHA. Functions alone do not activate the client authorization contract.
6. Rebuild/validate Stay Pattern publication V2 before enabling LOS. Missing/stale/mismatched metadata must show explicit per-night fallback. Existing saved quote analyses retain their original versions and values.
7. On previously used shared reception computers, clear legacy site IndexedDB/cache data and sign in again. New releases use memory-only Firestore caching; switching cache mode does not erase old disk data.

## Staging and production acceptance

- As ordinary users in two hotels, exercise domain settings/category deletion, compset atomic save, unavailable quote drafts, stock create/save/finish, catalog export and staff names. Revoke permissions, suspend a subscription, disable a user and change hotels during pending requests; verify enforcement and recovery.
- Replay a signed provider event concurrently and after controlled interruption. Inspect raw object tenant ownership, Storage generation preconditions and canonical record/checkpoint counts. Confirm manual/SFTP ingress still works.
- Confirm reminder/research recipients are current users of the intended hotel. Review minimum outbound provider data, source freshness, resumed empty replacements, hourly cleanup and <=24-hour deletion under normal operation. A scheduled cleanup outage needs monitoring/recovery; TTL alone is not a deadline guarantee.
- Inspect exported workbook/PDF appearance and route/chunk loading in the actual browser environment.
- Restore a real sanitized representative backup to an isolated project and validate actual permissions/files/provider-free workflows. The local two-hotel test proves emulator export/import of canonical Firestore relationships, historical quote evidence, Auth claims/state and Storage bytes/metadata; it does not prove production backup IAM, encryption, retention or disaster recovery.
- Verify live IAM/App Check/MFA, secrets, private-file migrations, indexes, monitoring and deployed parity. Record the result separately from **code resolved** and **locally verified**.

No production resource, real provider delivery, repository protection rule or deployment was changed by the audit implementation task.
