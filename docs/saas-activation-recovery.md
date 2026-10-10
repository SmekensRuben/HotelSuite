# Recover hotel onboarding after the module release

## Confirmed production observations

Inspected on 2026-10-10 against main
`59218877b90eec2f8cd97d8dc1b1fec2d21e08e0`:

- CI, App Hosting and the actual Functions deployment, including its inventory
  step, succeeded for that exact commit. A successful application deployment
  does not perform the separate Rules/data release.
- `platformConfiguration/saasProcurement` had `enabled: true` and
  `rulesVersion: "saas-procurement-v1"`. The current onboarding callable requires
  `saas-modules-v2`, so it correctly returns `enabled: false`.
- `hotelSubscriptions/testhotel` was active, manually billed, revision 1 and had
  no expiry. It lacked `modules`, `modulePolicyVersion` and `seatLimit`. The owner
  selected only **Purchasing & Inventory** (`procurement`) for this hotel.
- Saving that selection through the live subscription page failed. The exported
  `setHotelSubscription` callable was wrapped in the same rollout gate, creating
  a circular requirement: preflight needs explicit module subscriptions, but
  preparing them requires the completed preflight/release.
- Cloud Shell rendered **Site Unavailable** in the agent browser. No production
  subscription, Rules, membership, activation marker or invitation was changed
  during this investigation.

## Scoped code repair

Subscription administration is a platform recovery operation. Its callable now
invokes the existing handler without the hotel-workflow rollout gate. It still
requires both a verified platform-admin token and current enabled, verified Auth
authority with the live platform-admin claim. It validates explicit modules and
seat limits and atomically commits the subscription revision and audit record.
It grants no user role or claim and does not alter the activation marker.

Hotel creation, invitations, procurement mutations and private workflows retain
their release gates. Preparing a subscription is not proof of a secure release.

The emulator regressions call the actual exported callable's `run` entry point;
testing the internal handler alone would miss this defect. They cover missing,
old and paused activation markers; explicit module preparation; stale edits;
unchanged memberships, claims and marker; and continued denial of hotel creation
and invitations. They also reject anonymous callers, hotel managers, forged or
revoked platform authority, disabled accounts and unverified email. These tests
failed against the original wrapper before the repair.

## Verification status for this repair

- **Code repaired:** only the platform subscription callable is separated from
  the hotel-workflow release gate. No deployed Rules or activation flag was edited.
- **Locally verified:** 148 Functions tests and 108 Auth/Firestore/Storage security
  emulator tests pass, together with lint, boundary type checking and the test
  build. The two new exported-callable regressions failed before the code repair
  and pass after it. Normal hotel managers and stale platform authority remain
  denied. Checks used Node 22, npm 10.9.9 and Java 21 for the emulators.
- **Deployed callable verified:** pending the reviewed merge, successful automatic
  Functions deployment and an actual subscription save in the live application.
- **Rules/data activation verified:** pending the owner's reviewed Cloud Shell
  release. A normal-user production acceptance check remains required afterward.

The first full local security run encountered the Firebase CLI's proxy routing of
loopback Storage-to-Firestore requests, which made permitted uploads fail. The
unchanged suite passed with proxy variables removed only from the fictional local
demo emulator command and usage reporting disabled. No production networking or
Rules were weakened. GitHub CI runs the same tests in its normal environment.

## Remaining production procedure

1. Merge the reviewed repair and wait for successful CI, App Hosting and the
   actual Functions deployment of the exact resulting main commit. The repair
   does not publish Rules or run a data migration automatically.
2. Sign in as the existing verified platform operator. In **Settings → Hotel
   subscriptions**, select **Test Hotel** and save only **Purchasing & Inventory**.
   Preserve **Active**, `standard`, manual billing and the empty expiry. Keep the
   assigned-user limit empty for the existing unlimited-user policy. Confirm the
   save succeeds and a refreshed overview retains the module selection. This
   writes the versioned module fields and an audit record through the backend;
   do not add them by hand in the Firestore console.
3. In the owner's Cloud Shell, use the [reviewed rollout procedure](saas-procurement-pilot.md#one-time-cloud-shell-rollout).
   Download the launcher from the exact reviewed merged commit. First run its
   read-only preflight, then apply that same release after it passes. The launcher
   checks current main, CI, App Hosting, Functions inventory, subscriptions,
   memberships, in-flight deliveries and Storage Rules access. Any newly found
   inconsistency must be resolved before continuing.

   ```bash
   HOTELSUITE_RELEASE_SHA="REPLACE_WITH_REVIEWED_MERGED_MAIN_SHA"
   curl --fail --silent --show-error --proto '=https' --tlsv1.2 \
     "https://raw.githubusercontent.com/SmekensRuben/HotelSuite/${HOTELSUITE_RELEASE_SHA}/scripts/firebase/rollout-saas-pilot.sh" \
     --output /tmp/hotelsuite-saas-rollout.sh
   bash /tmp/hotelsuite-saas-rollout.sh --release-sha "$HOTELSUITE_RELEASE_SHA"
   # Only after the read-only preflight succeeds:
   bash /tmp/hotelsuite-saas-rollout.sh --release-sha "$HOTELSUITE_RELEASE_SHA" --apply
   ```

   If the checked Storage service-agent binding is missing, review the exact
   principal/role in the rollout guide before adding
   `--grant-storage-rules-access`. Do not grant broader IAM permissions. Retain
   the printed persistent workspace and `previous-rules.json` backup.
4. The launcher compiles both Rules sources, publishes and verifies their exact
   content, migrates legacy credentials and permission casing, waits ten minutes
   for propagation, rechecks the release and writes `saas-modules-v2`. Do not
   manually replace the marker string to hide an incomplete release.
5. Open **Settings → Hotel onboarding** and click **Check activation again**.
   Confirm the warning disappears and the create/invite controls are enabled.
   Actual new hotels, invitations and external order delivery require the intended
   property/recipient/provider details; they are not synthetic production tests.
   Verify normal hotel-user allowed/denied paths after the release as documented
   in [module subscriptions](module-subscriptions.md#reviewed-migration-and-release).

Status must be recorded separately: **code repaired**, **locally verified**,
**deployed callable verified**, and **Rules/data activation verified**. A green CI
run alone is not proof of the latter two.
