# Staging quick start

Staging is prepared in code; it has not yet been provisioned or deployed.
Complete the [one-time setup](staging-safe-releases.md#one-time-cloud-shell-setup)
first. It needs a staging-capable Google Cloud account, billing, a default Storage
bucket in `us-west1`, App Hosting/Auth settings and a protected GitHub Environment.
Begin with the offline plan:

```bash
bash scripts/firebase/bootstrap-staging.sh --dry-run
```

## Publish a version

In **Actions → Deploy HotelSuite staging → Run workflow**, keep workflow branch
`main`. Choose `source_kind=branch` or `pull-request`, supply the branch name or PR
number in `source_target`, and select `deploy=true`. The controller must already
be merged into protected `main`. Review and approve the displayed SHA for staging
access; deployment tooling executes the selected application code.

Wait for all verification, Rules/indexes, Functions, App Hosting and activation
steps to finish. Open the URL in the workflow summary. The staging banner and
`/release.json` must show the selected SHA. An incomplete or mismatched release
keeps the staging interface closed. The expected URL is
`https://hotel-toolkit-staging--hotel-toolkit-staging.europe-west4.hosted.app`;
it has not been verified live.

## Create and use test accounts

With staging operator credentials in Cloud Shell:

```bash
node scripts/firebase/staging-data.mjs seed --project hotel-toolkit-staging
node scripts/firebase/staging-data.mjs seed --project hotel-toolkit-staging \
  --apply --confirm-project hotel-toolkit-staging \
  --credentials-file work/staging-credentials.json
```

Use `staging-hotel-a-ROLE@example.invalid`, replacing `ROLE` with `admin`,
`purchaser`, `approver`, `counter` or `revoked`. Replace `a` with `b` for Hotel B.
Passwords are generated in the private credentials file; no email is sent.
The revoked role can authenticate but has no hotel access. Use separate browser
profiles to compare roles.

## Check Purchasing & Inventory

1. As purchaser, create/submit a request. As approver, review it and confirm the
   order. Check the budget and the visible simulated-delivery status.
2. As purchaser, receive partly, finish receiving and review the immutable
   receipt evidence. No supplier is contacted.
3. As counter, complete a count, including an explicit zero. Missing counts must
   block completion; review movement/valuation exceptions.
4. Verify Hotel A cannot access B, a purchaser cannot approve, and the revoked
   user has no access. Test suspended/expired subscriptions with the
   [acceptance checklist](staging-safe-releases.md#acceptance-checks).

## Rebuild fictional data

Stop testing and wait for any deployment to finish. Preview the reset, then apply:

```bash
node scripts/firebase/staging-data.mjs reset --project hotel-toolkit-staging
node scripts/firebase/staging-data.mjs reset --project hotel-toolkit-staging \
  --apply --confirm-project hotel-toolkit-staging
```

Repeat the seed command with a **new** private credentials filename. Reset only
removes the two owned fixture hotel trees and their accounts/subscriptions.
Uploaded Storage objects require separate scoped cleanup. No production target
is accepted.

## Release to production

Record the staging SHA and acceptance results on the PR. Use the existing
reviewed merge/production release procedure; Rules/index/migration operations
remain separate where required. Stage again if merging changes the tested
content. Never copy staging data, credentials or activation records to production.
Live email/SFTP, webhooks, external search and paid AI remain unproven because
staging deliberately simulates or blocks those providers.
