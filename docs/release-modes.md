# Production release modes

Set the repository Actions variable `RELEASE_MODE` explicitly to `development` or `controlled`. The setting changes the release procedure for the production project `hotel-toolkit`; it does not select a different Firebase environment. Both modes keep production Firebase configuration, authentication, tenant isolation, permissions and existing business-worker safeguards.

The production workflow reads the variable without a default. An absent, misspelled or unsupported value blocks the release. This change prepares the procedure only: no repository variable, cloud setting, IAM grant, rollout or production monitoring state was changed during implementation.

| Behavior | `development` | `controlled` |
| --- | --- | --- |
| Source and CI | Current verified `main` commit | Current verified `main` commit |
| Staging acceptance | Optional for this release procedure | Successful protected staging deployment and manual acceptance of the same application tree |
| Production approval | No additional production Environment review | Required native review of this exact run in the protected `production` GitHub Environment, before cloud authentication |
| Code delivery | Functions, then frontend from the pinned commit | Functions, then frontend from the pinned commit, plus live monitoring verification |
| Additional purchasing monitoring | Pause its marker and its two owned internal alert policies | Require prepared, active resources before deployment; verify fresh scheduled execution, a complete hotel rotation and a real success metric afterward |
| Existing shared workers, import monitoring and history | Retained | Retained |

The absence of active customers does not relax any security boundary. `development` still deploys real production code; it never supplies staging Firebase settings or treats simulated provider results as real delivery.

## One production deployment path

[The production workflow](../.github/workflows/deploy-functions.yml) owns both Functions and frontend delivery after successful CI for the selected `main` SHA. It rechecks that the release is current, deploys Functions with explicit `DEPLOYMENT_ENV=production`, `RELEASE_MODE` and `RELEASE_SHA`, and creates an App Hosting rollout from that exact Git commit. Frontend success requires the expected build to be ready and serving all traffic. A queued rollout or a green workflow that skipped deployment is insufficient.

Independent Git deployments must be disabled in both modes. An observed App Hosting deployment for commit `6fe5…` published before its CI completed, so a CI gate on Functions alone did not gate the frontend. A Vercel production Git deployment path was also observed; `vercel.json` disables its automatic `main` deployments. Existing Vercel dashboard settings and other external deployment hooks still need operator verification. GitHub workflow protection cannot gate a separate cloud deployment path.

Complete the [one-time App Hosting release setup](production-apphosting-release-setup.md), including its offline plan, read-only preflight, explicit operator apply and read-back verification. It disables App Hosting automatic rollouts and grants the existing CI identity the narrow permissions needed by the coordinated release. The live GCP rollout-policy setting could not be read during this task because no cloud identity was available. Treat it as unverified until preflight succeeds; changing `RELEASE_MODE` alone does not disable it.

The mode can be edited in **Repository Settings → Secrets and variables → Actions → Variables**. The workflow pins its selection and compares it with the mode supplied to the deployment job. Treat repository variables as a snapshot for that workflow run. It does not continuously poll GitHub variables: changing a variable cannot revoke an already running job or alter running Functions. Finish an in-flight release before switching modes, or cancel a waiting run before it starts cloud mutations, then start a new run. An inconsistent mode supplied to the deployment job blocks that run; do not use an in-flight variable edit as a release stop.

## Development releases

After the one-time deployment-path setup, set `RELEASE_MODE=development`. Each successful verification of current `main` can release Functions and the pinned frontend through the production workflow. The existing deployment-enable and Workload Identity prerequisites still apply.

Before releasing, the workflow pauses only `platformConfiguration/purchasingMonitoring` and its two owned internal evaluator alert policies. The deployed development-mode runtime also suppresses this additional monitoring and its workflow-error ingestion. It does not stop the shared scheduled evaluator, existing import monitoring, business workers, or delete incidents and audit history. A pause failure blocks the release instead of silently leaving the additional monitoring active.

Rules and indexes have a separate operator rollout. Neither release mode nor a Functions/App Hosting deployment publishes them. Review schema changes before merging, apply any required backed-up Rules migration and additive indexes through their existing runbooks, and verify readiness. The [purchasing monitoring release guide](purchasing-monitoring-release.md) remains authoritative for monitoring configuration, IAM, Scheduler, Rules/index checks and recovery.

## Switch before the first customer

1. Complete and verify the one-time deployment-path setup above. Finish a compatible production code release containing the monitoring implementation and release scripts. Confirm its actual Functions inventory and frontend build SHA; keep that current release SHA for the operator setup. Avoid another development release during the switch because it deliberately pauses purchasing monitoring again.
2. Configure the GitHub Environment named `production` with required reviewers and a `main` deployment policy. Use the existing protected [staging release procedure](staging-safe-releases.md) to deploy the intended application tree. Complete manual staging acceptance, including incident detection, acknowledgement, recovery, missing-evaluator detection and normal-user isolation. Keep the successful deployment evidence artifact and acceptance record. Synthetic staging results remain staging evidence.
3. Prepare and activate production purchasing monitoring once using the current compatible production release SHA and the [operator release guide](purchasing-monitoring-release.md). Review `plan`, live `preflight` and dry-runs before the explicit `prepare --apply` and `activate --apply` commands. This establishes the environment marker, required IAM/index readiness, metrics and the two internal alert policies. Development-mode Functions still suppress evaluation at this point; live readiness is established after the controlled deployment below.
4. Set the repository variable to `RELEASE_MODE=controlled`. Start a new manual run of the production workflow on `main` after its CI and matching staging release succeed. The controller validates the trusted staging workflow, successful deployment/activation artifact and Git-tree equality with production `main`. A related ancestor, a PR number or a successful staging test job alone is insufficient.
5. Review the pinned production SHA and staging evidence, then approve that run in the protected `production` Environment. Approval records manual acceptance of that application tree. The workflow checks GitHub's actual approval record before obtaining cloud credentials. Missing/unprotected approval evidence blocks deployment. For a controlled retry, start a new workflow run and approve it again; rerunning an old attempt cannot reuse approval history.
6. Require the complete workflow to succeed. It checks the existing production monitoring configuration before changing Functions, deploys the controlled production runtime with the exact candidate SHA, records a verification baseline after deployment completes, and waits for fresh scheduled evidence after that baseline: a successful page, an entirely successful nonempty hotel rotation started after deployment, and an ingested success log-metric point. It also publishes and verifies the pinned frontend. A refresh click, old heartbeat or simulated source cannot satisfy these checks.
7. Record the production SHA, accepted staging tree/run, production approval/run, frontend build/rollout and live monitoring verification. Inspect fresh hotel coverage and platform incidents, and verify access using an ordinary hotel account before onboarding the first customer.

Later controlled releases reuse the installed compatible monitoring configuration. They run read-only readiness checks, including matching deployed Rules and ready committed indexes, and fresh execution verification for each release; they do not repeat IAM preparation or recreate metrics/policies on every commit. The configuration's original setup SHA may differ from the candidate SHA; deployment and live runtime checks independently require the new candidate. Repeat operator preparation only for an actual configuration/resource change or reported drift.

For operator diagnostics, the workflow uses these project-bound, read-only checks:

```bash
node scripts/firebase/production-apphosting.mjs preflight --project hotel-toolkit --sha <release-SHA>
node scripts/firebase/release-monitoring.mjs preflight --project hotel-toolkit --sha <release-SHA>
node scripts/firebase/release-monitoring.mjs verify --project hotel-toolkit --sha <release-SHA> --not-before-millis <Functions-deployment-completion-milliseconds>
```

Use full 40-character SHAs and the recorded post-deployment timestamp. Verification can require multiple 15-minute scheduled pages and normal metric-ingestion delay. A failed or incomplete Functions/frontend/monitoring phase leaves the release failed. Inspect the failed phase and start a new controlled run after correction; use the monitoring guide's explicit pause/recovery procedure when needed.
