# Purchasing monitoring: environment configuration and release

**A merge is not sufficient for the first activation of WP3B in production.** The code release and the environment's monitoring activation are separate. No production deployment, configuration write, IAM change, scheduled invocation or alert-policy change was performed while implementing this work.

The [central release-mode policy](release-modes.md) supersedes independent frontend publication. In `development`, the coordinated production workflow deliberately pauses this additional monitoring; in `controlled`, each release reuses the installed configuration and verifies live readiness. This guide owns the one-time preparation and activation, not a repeated activation after every commit.

The repository can establish the delivery behavior below. Live Google Cloud configuration and the current GitHub deployment-enable variable could not be inspected in this task: the environment has no ready cloud identity, and the GitHub Actions/variables API refused access. A historical successful deployment is not evidence that this release has deployed.

| Component | What happens after a merge to `main` | Additional activation and verification |
| --- | --- | --- |
| Frontend | After one-time platform setup disables independent App Hosting automatic rollouts, the production workflow creates a rollout from the verified current `main` SHA. `apphosting.yaml` retains the production project/environment. | Require the actual **Publish and verify exact App Hosting release** step and its exact-commit build/rollout/100% traffic proof. Before platform setup, legacy external App Hosting success is accepted by the operator readiness check only alongside actual Functions deployment and CI. |
| Functions | `.github/workflows/deploy-functions.yml` waits for successful **Verify HotelSuite** on the exact current `main` SHA. Deployment also requires `FIREBASE_FUNCTIONS_DEPLOY_ENABLED=true`, the configured Workload Identity provider/account, real runtime secrets and valid parameters. Skipped steps do not count as a deployment. | Require successful **Deploy Functions to hotel-toolkit** and **Record deployed Functions inventory** steps for that SHA. This deploys code only. |
| Scheduled evaluations | The Functions release updates the existing Gen 2 `checkPlatformImportHealth` and its Firebase-managed Scheduler job in `us-central1`, every 15 minutes. The same worker evaluates purchasing when the environment marker is enabled and the deployed release mode allows it. Development mode suppresses only the new purchasing evaluation. | Verify the actual enabled Scheduler target, OIDC account and private Cloud Run Invoker access. The staging guard explicitly permits this internal evaluator; provider workers remain disabled there. |
| Firestore Rules | Functions/App Hosting deployments do not publish Rules. WP3B uses the existing server-only metadata boundaries. | The helper compares the published `cloud.firestore` source with `firebase/firestore.rules`. If they already match, no Rules publication is required. Any mismatch must be resolved through the reviewed Rules rollout before activation. |
| Firestore indexes | Functions/App Hosting deployments do not publish indexes. WP3B adds no composite index requirement; bounded hotel-local collectors use existing single-field/document-name indexes. | The helper checks the reviewed shared manifest and additively creates missing composite indexes during `prepare --apply`; it never deletes unrelated indexes or modifies field overrides. All reviewed indexes must be `READY` before activation. |
| IAM | A Functions deployment does not apply project IAM changes from this feature. Existing runtime/Scheduler setup is reused. | `prepare --apply` additively supplies only `roles/datastore.user` and `roles/logging.logWriter` to this project's existing default Compute runtime account if absent. Existing grants and IAM etags are preserved. Scheduler service-agent and private service invocation grants are checked; repair those with the existing project bootstrap if necessary. |
| Environment marker | Code deployment does not activate `platformConfiguration/purchasingMonitoring`. The development workflow pauses its `enabled` flag while retaining the configuration and history. Missing configuration keeps the new purchasing evaluation and client telemetry disabled. | Activate the reviewed environment JSON with the exact release SHA using the helper below. A staging marker cannot validate in production. |
| Independent Cloud Monitoring | The production workflow does not create the new log metrics or evaluator alert policies. Development pauses only the two owned purchasing evaluator policies; controlled releases read and verify them. | `prepare --apply` creates/updates two project-local log metrics and two internal alert policies; `activate --apply` enables them. Policies have no notification channels, email, webhook or external routing. |

## Configuration contract

`config/purchasing-monitoring.production.json` is bound to `hotel-toolkit`; `config/purchasing-monitoring.staging.json` is bound to `hotel-toolkit-staging`. Both committed templates explicitly start disabled. The release helper adds the checked release SHA and writes a normalized marker only in `activate --apply`. Runtime validation rejects mismatched project/environment, unsupported schema, invalid SHA, missing thresholds and unsafe work bounds.

| Setting | Reviewed default | Meaning |
| --- | --- | --- |
| `thresholds.pendingMinutes` | 15 | Pending queue/work age before review |
| `thresholds.processingMinutes` | 30 | Processing age before a stalled signal |
| `thresholds.supplierConfirmationHours` | 24 | Supplier-confirmation age before review |
| `thresholds.reviewHours` | 48 | Recent workflow-error observation horizon; explicit AI human-review states require attention immediately |
| `thresholds.backlogCount` | 20 | Bounded observed queue backlog threshold |
| `thresholds.retryCount` | 3 | Repeated-attempt threshold |
| `thresholds.limitWarningRatio` | 0.8 | AI usage warning relative to its real configured limit |
| `thresholds.staleScanMinutes` | 60 | Hotel evidence freshness and bounded source-rotation deadline |
| `thresholds.scheduledWorkerHours` | 30 | Maximum interval between confirmed scheduled contract reminder scans; deliveries have separate receipts |
| `maxHotelsPerRun` | 25, maximum 25 | Hotels per 15-minute cursor page |
| `maxDocumentsPerSource` | 50, maximum 50 | Records sampled per hotel-local source; truncation remains explicit |
| `evaluatorStaleMinutes` | 45 | Evaluator heartbeat and independent absence-policy threshold |

The evaluator stores sanitized hotel health at `hotels/{hotelUid}/platformHealth/purchasing`, incidents at `platformIncidents/{stableId}`, bounded client telemetry at `hotels/{hotelUid}/workflowTelemetry/{stableId}` and daily admission counters at `hotels/{hotelUid}/workflowTelemetryLimits/{stableId}`, and cursor/heartbeat evidence at `platformConfiguration/importMonitoringWorker`. These metadata records do not change procurement state, retry deliveries, execute AI, or send notifications. Open incidents remain until explicit healthy source evidence resolves them; resolved incidents are retained for 90 days, while client telemetry and admission counters expire after 7 days. Browser errors are unverified client observations; they do not prove that a business action failed. A sample or empty collection never proves that all purchases were delivered.

## Operator prerequisites and preflight

Use Node 22.13 or later, a clean checkout of the reviewed commit in `SmekensRuben/HotelSuite`, and the existing authenticated release operator `bestsmekens@gmail.com`. The tool uses short-lived `gcloud` OAuth in memory; it creates no key, persistent token, or dependency installation. The production project number is pinned to `358734544002`; staging requires its independently obtained number and refuses that production number. The tool rejects emulator variables, conflicting ambient projects, an unexpected origin, a dirty checkout or a different SHA. Remote production operations except recovery pause also require successful exact-SHA CI, App Hosting and actual Functions deployment via the existing read-only release check.

The operator needs existing access to read project IAM, Functions, Cloud Scheduler, Cloud Run IAM, published Rules, Firestore data/index metadata, Logging metrics and Monitoring policies/time series. Applying preparation additionally needs `resourcemanager.projects.setIamPolicy` for the two named runtime roles, `datastore.indexes.create`, `logging.logMetrics.create/update` and `monitoring.alertPolicies.create/update`. Activation/pause require the marker write and alert-policy update permissions. These are operator permissions; no Rules/IAM/Monitoring administration role is granted to the runtime or CI account.

Ensure Cloud Logging and Cloud Monitoring APIs are enabled in the selected project. If preflight reports an unavailable API, inspect **Google Cloud → APIs & Services → Enabled APIs** and enable `logging.googleapis.com` and `monitoring.googleapis.com` for that exact project before retrying. Existing Firebase bootstrap owns the Functions, Scheduler, Run, Rules and Firestore APIs and service agents. Do not repair a failed check by granting Owner/Editor or by opening the evaluator to public invocation.

The commands below are an operator release procedure to execute after merge under the normal production change process. They were not run against production during this task. Replace the SHA with the real reviewed 40-character main commit; keep captured reports outside the checkout so it stays clean.

```bash
monitoring_release_sha=<reviewed-40-character-main-SHA>
node scripts/firebase/purchasing-monitoring-release.mjs plan --project hotel-toolkit --sha "$monitoring_release_sha"
node scripts/firebase/purchasing-monitoring-release.mjs preflight --project hotel-toolkit --sha "$monitoring_release_sha"
node scripts/firebase/purchasing-monitoring-release.mjs prepare --project hotel-toolkit --sha "$monitoring_release_sha" --dry-run
```

`plan` is fully local and needs no credentials. It is not deployment evidence. Every other command performs live reads and checks the explicit target; default mode and `--dry-run` perform no mutations. A preflight failure happens before preparation changes. Resolve all reported project, release, deployed Rules, Scheduler, service-agent and invocation mismatches first.

If published Rules differ, use the established [SaaS procurement rollout](saas-procurement-pilot.md), which backs up and verifies Rules and controls application writes. Do not publish Rules with a Functions-only command or use this monitoring helper as a substitute for the broader migration. After Rules propagation and verification, rerun the monitoring preflight. There is no WP3B Storage Rules or Storage data migration.

## Preparation, activation and verification order

1. Wait for the exact production frontend and Functions code release to succeed. Run the live read-only preflight above.
2. Review the printed environment configuration, IAM additions, missing indexes and the two internal evaluator policies. Apply preparation:

   ```bash
   node scripts/firebase/purchasing-monitoring-release.mjs prepare --project hotel-toolkit --sha "$monitoring_release_sha" --apply --confirm-project hotel-toolkit
   node scripts/firebase/purchasing-monitoring-release.mjs preflight --project hotel-toolkit --sha "$monitoring_release_sha"
   ```

   Preparation is additive and repeatable. It creates missing indexes without waiting in a long blocking process; rerun preflight until every required index is `READY`. Policies start disabled on creation; existing owned policies retain their activation state. A name/ownership or notification-channel conflict stops the release for operator review. Existing application data, subscriptions, memberships, order state, secrets and unrelated alert policies remain untouched.
3. Review activation dry-run, then activate this environment:

   ```bash
   node scripts/firebase/purchasing-monitoring-release.mjs activate --project hotel-toolkit --sha "$monitoring_release_sha" --dry-run
   node scripts/firebase/purchasing-monitoring-release.mjs activate --project hotel-toolkit --sha "$monitoring_release_sha" --apply --confirm-project hotel-toolkit
   ```

   Activation requires prepared resources and `READY` indexes. It enables independent policies before writing the enabled marker with an optimistic document precondition. Rerunning the same active release retains its original activation time. A concurrent marker update stops the write; rerun preflight and inspect before retrying.
4. Wait for real scheduled execution and a complete hotel rotation. With `N` hotels and a page size of 25, a rotation normally takes up to `ceil(N / 25) * 15` minutes, plus Scheduler/Logging ingestion latency. Activation halfway through an existing rotation requires the next complete rotation to start after activation. Do not fabricate a success heartbeat or use a refresh click as proof of Scheduler execution.

   ```bash
   node scripts/firebase/purchasing-monitoring-release.mjs verify --project hotel-toolkit --sha "$monitoring_release_sha"
   ```

   Verification is read-only. It requires matching enabled configuration/policies, a fresh successful page, a fully successful nonempty hotel rotation started after activation, no failed hotels, and a real ingested success log-metric point after activation. Retry after normal ingestion delay; a failed command is not release success.
5. In the platform incident view, inspect fresh purchasing coverage for the intended hotels and confirm that unavailable/paused/simulated states remain explicit. Verify that normal hotel accounts cannot access platform-wide incidents or write monitoring metadata. Keep the released SHA, frontend rollout, Functions run, preflight/verify results and observed worker timestamps with the release record.

The independent log metrics are `hotelsuite_purchasing_monitoring_evaluations` and `hotelsuite_purchasing_monitoring_failures`. They match structured evaluator logs with the exact `projectId`, environment, event `purchasing-monitoring-evaluation`, and success/failure outcome. Failure raises an internal Cloud Monitoring incident; success absence raises one after the configured 45 minutes. Both policies aggregate Cloud Run revisions, so retiring an old revision does not create a false absence alert. Inspect their real time series and policies under **Google Cloud → Monitoring → Alerting**. No outgoing test notification is part of this release.

The helper's `verify` proves the success metric baseline needed by the absence policy. Failure and missing-execution scenarios should be exercised in staging only: use a deliberately denied staging source read and temporarily pause the staging Scheduler, respectively; restore source access/Scheduler and verify recovery before recording acceptance. Record the exact staging project, timestamps, induced fault, internal incident and recovery. Never perform these fault injections on production or count a unit test as a cloud alert firing.

## Staging and simulation

Complete the existing protected [staging release](staging-safe-releases.md) for the selected SHA first. It must have `_staging/release.state=ready`; the deployed evaluator must identify the same `RELEASE_SHA` and `DEPLOYMENT_ENV=staging`. Then use the same helper with **every** command naming the staging project and its verified number:

```bash
monitoring_staging_number=<verified-staging-project-number>
monitoring_staging_sha=<reviewed-40-character-staging-SHA>
node scripts/firebase/purchasing-monitoring-release.mjs plan --project hotel-toolkit-staging --project-number "$monitoring_staging_number" --sha "$monitoring_staging_sha"
node scripts/firebase/purchasing-monitoring-release.mjs preflight --project hotel-toolkit-staging --project-number "$monitoring_staging_number" --sha "$monitoring_staging_sha"
node scripts/firebase/purchasing-monitoring-release.mjs prepare --project hotel-toolkit-staging --project-number "$monitoring_staging_number" --sha "$monitoring_staging_sha" --apply --confirm-project hotel-toolkit-staging
node scripts/firebase/purchasing-monitoring-release.mjs activate --project hotel-toolkit-staging --project-number "$monitoring_staging_number" --sha "$monitoring_staging_sha" --apply --confirm-project hotel-toolkit-staging
node scripts/firebase/purchasing-monitoring-release.mjs verify --project hotel-toolkit-staging --project-number "$monitoring_staging_number" --sha "$monitoring_staging_sha"
```

For controlled status scenarios, first seed the existing owned fictional staging hotels using the staging-data runbook. The project-bound helper below refuses production, unowned hotels, an incomplete staging release or disabled/mismatched monitoring configuration. It creates only five synthetic import-run metadata records under the first owned fictional hotel; it creates no import file, queue/outbox work, or provider request.

```bash
node scripts/firebase/purchasing-monitoring-scenarios.mjs seed --project hotel-toolkit-staging
node scripts/firebase/purchasing-monitoring-scenarios.mjs seed --project hotel-toolkit-staging --apply --confirm-project hotel-toolkit-staging
```

After the evaluator visits that hotel, inspect `failed`, `stalled`, `unknown`, `paused` and `simulated` source evidence. Only issue states create internal incidents; paused/simulated evidence cannot claim real delivery. Acknowledge an issue with a review note in the platform incident view and verify that reevaluation neither duplicates it nor resolves it without healthy evidence. Then apply explicit synthetic recovery and wait for the next scheduled visit:

```bash
node scripts/firebase/purchasing-monitoring-scenarios.mjs recover --project hotel-toolkit-staging
node scripts/firebase/purchasing-monitoring-scenarios.mjs recover --project hotel-toolkit-staging --apply --confirm-project hotel-toolkit-staging
node scripts/firebase/purchasing-monitoring-scenarios.mjs cleanup --project hotel-toolkit-staging
node scripts/firebase/purchasing-monitoring-scenarios.mjs cleanup --project hotel-toolkit-staging --apply --confirm-project hotel-toolkit-staging
```

Record incident IDs and detection/acknowledgement/resolution timestamps before cleanup. Recovery supplies fictional healthy metadata to demonstrate the incident lifecycle; it is not an actual import or delivery. Cleanup deletes only owned synthetic source records and retains incidents/audit evidence. These staging commands were prepared and tested locally; no live staging acceptance is claimed by this PR.

Review each mutation's dry-run first and wait for `READY` indexes before activation. Staging uses its own JSON, marker, metrics, policies, metadata and identity. Its provider actions remain simulated/disabled according to `environmentPolicy.js`. A staging simulated email, SFTP action, callback, or AI result is never a real external delivery or production acceptance. No command copies a staging marker, heartbeat or source fixture into production.

## Pause and recovery

To stop purchasing evaluation/client telemetry deliberately, inspect a pause dry-run and apply it to the same explicitly named project:

```bash
node scripts/firebase/purchasing-monitoring-release.mjs pause --project hotel-toolkit --sha "$monitoring_release_sha" --dry-run
node scripts/firebase/purchasing-monitoring-release.mjs pause --project hotel-toolkit --sha "$monitoring_release_sha" --apply --confirm-project hotel-toolkit
```

Pause first disables the marker, then disables only the two owned internal evaluator policies to avoid an expected absence alert during an intentional pause. It retains incidents and historical evidence. Recovery pause still checks the clean SHA, repository, project number and release operator, but does not depend on a healthy deployment, Scheduler, indexes or Rules. If policy updates fail after the marker write, purchasing remains paused; repair Monitoring access and rerun pause to finish disabling policies. Existing 15-minute import monitoring remains under its existing worker behavior.

For a failed activation, inspect which phase completed; rerun preflight and the same preparation/activation after resolving the fault. Do not delete unrelated metrics/indexes/IAM bindings. For a code regression, revert through the reviewed main workflow; keep purchasing paused until the verified replacement SHA is prepared and activated. Rules rollback remains the separate backed-up Rules procedure.

## Production release checklist for the PR

- [ ] Record the final reviewed production main SHA and independent staging acceptance SHA. Describe any difference; do not promote staging config or simulated delivery claims.
- [ ] Confirm the external App Hosting connection/current production rollout and successful exact-SHA frontend check. Source configuration alone is insufficient.
- [ ] Confirm deployment-enable variable, Workload Identity/secrets/runtime checks and successful exact-SHA Functions deployment plus recorded inventory. A skipped green workflow is insufficient.
- [ ] Verify deployed Firestore Rules match the reviewed source; use the backed-up Rules rollout only if a change is required. Confirm no WP3B Storage migration is needed.
- [ ] Run production monitoring `plan`, live `preflight` and `prepare --dry-run`; review project `hotel-toolkit`, number `358734544002`, defaults, bounded reads, exact runtime roles and internal-only policies.
- [ ] Run `prepare --apply --confirm-project hotel-toolkit`; rerun preflight until every required shared index is `READY` and all IAM/Scheduler/OIDC/private invocation checks pass.
- [ ] Run activation dry-run, then `activate --apply --confirm-project hotel-toolkit`; verify the enabled production marker and both enabled internal evaluator policies.
- [ ] Wait for a complete, nonempty, successful post-activation hotel rotation and metric ingestion; require `verify` success and inspect fresh hotel coverage/incidents.
- [ ] Record staging-only failure and missing-execution cloud-monitoring tests separately from local unit/emulator tests; do not claim live checks that were not executed.
- [ ] Keep release evidence and the concrete pause/recovery command with the operator record. Confirm no external channels, production fault injections or automatic procurement retries were added.

**Release status at PR creation: implementation and local checks only. Merge may deliver frontend/Functions code under existing external settings and workflow gates. Production monitoring still requires the explicit preparation, activation and live verification above.**
