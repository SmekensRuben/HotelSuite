# One-time production App Hosting release setup

The production release workflow now owns both Functions and frontend releases. Independent App Hosting automatic rollouts must be disabled **in both `development` and `controlled` mode**. This lets the workflow gate both components and publish the frontend from the exact verified Git commit after Functions succeeds.

The setup below is prepared code, not an applied production change. No production IAM, App Hosting setting, rollout or credential was changed while implementing it. The current external App Hosting configuration cannot be established from this environment because no cloud identity is available. Previously queued or running App Hosting rollouts must also finish before the new release path can operate: disabling automatic rollouts does not cancel them. Preflight rejects every nonterminal or unknown rollout state before Functions or monitoring can change, and publishing repeats that check immediately before starting its pinned rollout. Until an operator completes and verifies setup, production workflow preflight fails closed if independent automatic rollouts remain enabled.

Use the existing operator `bestsmekens@gmail.com`, Node 22.13 or later and a checkout containing the reviewed scripts. The scripts require no dependency installation for plan/setup/preflight; publishing uses the workflow's locked Firebase CLI. Every command fixes project `hotel-toolkit`, number `358734544002`, backend `hotel-toolkit` in `europe-west4`, production origin and existing deployment service account `github-functions-deploy@hotel-toolkit.iam.gserviceaccount.com`. No provider, connection, account or credential is created.

Execute these steps under the normal production change process, after reviewing the PR. They are not part of this implementation task:

```bash
node scripts/firebase/production-apphosting-setup.mjs plan --project hotel-toolkit
node scripts/firebase/production-apphosting-setup.mjs preflight --project hotel-toolkit
node scripts/firebase/production-apphosting-setup.mjs apply --project hotel-toolkit --confirm-project hotel-toolkit
node scripts/firebase/production-apphosting-setup.mjs preflight --project hotel-toolkit
```

`plan` is offline; `preflight` performs only live reads and reports whether setup is needed. `apply` first verifies the project number, active operator, existing production backend/app/origin, HotelSuite Git repository connection and existing enabled deployment account. It then sets `traffic.rolloutPolicy.disabled=true`, waits for the configuration operation to finish, and additively creates or updates the narrow `projects/hotel-toolkit/roles/hotelsuiteProductionRelease` role and its binding to that exact deployment account. It reads configuration and IAM back before reporting success. Existing project grants and IAM etags are preserved. Repeating `apply` makes no change when the desired state is already installed.

The release role contains the current App Hosting metadata read permissions for backends, builds, rollouts, traffic and operations; build/rollout creation; Developer Connect repository-link read and read-token access needed by the existing Firebase Git rollout command; and the exact project, Function, Scheduler, Run IAM, log-metric, alert-policy, time-series, Firestore metadata and deployed Rules/index inventory read permissions used by release monitoring verification/pause. Rules/index permissions are read-only and compare the deployed state with the committed release; CI cannot publish Rules or create indexes. It does not grant backend/traffic administration, Rules/index administration, IAM administration, secret access or entity creation to CI. The helper checks Google's current role catalog before provisioning; an unexpected catalog or existing custom-role identity stops setup for review.

Setup changes no serving traffic split, backend environment, linked Firebase app, Git connection, build source, GitHub release-mode variable or monitoring activation marker, and starts no rollout. If existing production environment, linked app, origin, repository or environment overrides differ from the reviewed contract, preflight stops before any write. Resolve that concrete mismatch through the existing operator configuration process and retry. A failed or unfinished configuration operation is not setup success.

Before merging a release governed by the new policy, record the successful setup preflight proving automatic rollouts are disabled and the narrow CI role is installed. Preserve the separate release-mode and protected-environment procedure in the main release runbook. Setting `RELEASE_MODE` does not itself change Firebase automatic rollout settings.

During each production release, `production-apphosting.mjs preflight --project hotel-toolkit --sha <40-character-SHA>` checks the backend, linked app, production environment/origin, exact Git repository and disabled automatic-rollout policy before Functions can change. After Functions succeeds, its `publish` command runs the existing locked CLI:

```text
firebase apphosting:rollouts:create hotel-toolkit --git-commit <40-character-SHA> --project hotel-toolkit --non-interactive --force
```

Here `--force` only skips the Firebase rollout confirmation. The publisher accepts no branch name, local source archive, changed project or abbreviated SHA. It independently reads the new rollout and build, requires `build.source.codebase.commit` to match the exact release, waits for `READY`/`SUCCEEDED`, and verifies that current traffic serves that build at 100 percent while automatic rollouts remain disabled. CLI output or an API-queued rollout alone does not qualify as a released frontend. Failed, queued, wrong-commit, partial-traffic and timed-out releases fail the workflow.

If Functions succeeds but frontend release fails, the workflow remains failed and records no full-release success. Inspect the failed build/rollout and retry the verified current release through the same workflow; do not restore independent App Hosting automatic rollouts to bypass its gates. Recovery and the previous served build remain visible in App Hosting. No automatic rollback or production data mutation is introduced by these scripts.

Production metadata GETs retry a transport failure at most three times, with a fresh 30-second request timeout and short backoff for each attempt. This covers a dropped evidence connection immediately after the rollout CLI completes. HTTP errors and invalid JSON still fail immediately; cloud writes and rollout creation are never replayed by this retry. A successful CLI rollout still requires the exact-commit build, completed rollout and 100 percent serving-traffic checks.
