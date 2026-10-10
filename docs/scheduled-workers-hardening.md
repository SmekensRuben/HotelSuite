# Scheduled workers: delivery, identity and retention

F15-F18 code changes require a coordinated operator rollout. Local mock tests are evidence of application behavior; they do not establish deployed rules, provider acceptance, IAM or scheduler health. No production messages or research requests were sent during remediation.

## Current-recipient contract

Contract followers retain an immutable UID (`id`, or legacy `uid`) as their authority. At each send the worker checks the hotel's active subscription, current membership, `contracts.read`, current Auth account enabled/verified state and current email. A stored email without a UID does not authorize delivery. Manual notification runs also require the requesting UID to retain `contracts.notify`.

All scheduled reports now send **one hotel's report per message**. The following operator-owned documents require explicit UID mappings:

| Document | Hotel list field | Recipient field | Current member permission |
| --- | --- | --- | --- |
| `scheduledMails/guestIntelligence` | `hotelUid` | `recipientUidsByHotel` | `reservations.read` |
| `scheduledMails/scheduledOccupancyMail` | `hotelUid` | `recipientUidsByHotel` | `demandcalendar.read` |
| `scheduledMails/scheduledBlockPickupMail` | `hotelUids` | `recipientUidsByHotel` | `groups.read` |

Example fictional configuration:

```json
{
  "hotelUid": ["hotel-a", "hotel-b"],
  "recipientUidsByHotel": {
    "hotel-a": ["hotel-a-reader-uid"],
    "hotel-b": ["hotel-b-reader-uid"]
  }
}
```

Historical `sendList`, `mailto` and `mailtoCC` arrays are ignored. Resolve addresses against current Auth and memberships before writing an approved UID mapping; do not grant memberships automatically to reproduce a historical list. Operator access alone does not infer a multi-hotel broadcast audience. A recipient assigned to two hotels may receive two separate messages after passing both hotel checks.

Queued invitation mail rechecks the inviting operator's current enabled, verified account and current platform-admin claim. Old invitations missing `actorUid` are blocked for review. Queued approval mail rechecks the current order, current outlet approver assignment and member permission, and uses current email addresses. Order-confirmation mail rechecks its actor before external delivery.

## Acknowledgment and reconciliation

`scheduledMailDelivery.js` accepts success only when the provider returns a nonempty message ID and no error. Every scheduled logical delivery has a deterministic provider idempotency key and a durable, server-only receipt at `hotels/{hotelUid}/scheduledMailReceipts/{sha256}`. The receipt stores a content fingerprint, logical key, status and provider ID, not the email body or attachment. Occupancy fingerprints use the source report and recipients rather than nondeterministic document creation metadata.

A duplicate confirmed receipt returns the previous acknowledgment without calling the provider again. A concurrent, processing or `needs-review` receipt blocks automatic resend. A resolved provider error, missing ID, timeout or lost local acknowledgment becomes `needs-review`, never `sent`. An existing `sent` receipt with an invalid provider ID also requires reconciliation and never triggers an automatic resend. Transport and research boundary exceptions expose fixed safe codes/messages without raw provider bodies, guest text or exception causes; scheduler failure logs retain only a fixed code and hotel scope. Provider idempotency retention is a second protection, not permission to resend after an unknown outcome. Fingerprints canonicalize object map ordering while retaining meaningful array order.

Operator recovery must inspect the exact logical key and provider idempotency key, check the provider for a delivered message, and record the decision. If delivery is proven, record its provider ID and `sent` status in the existing receipt using an audited operator procedure. If non-delivery is proven and a new attempt is approved, use a distinct recovery logical key and preserve the original receipt. Do not delete a receipt or reset `processing` automatically. The application currently exposes no client write access to this journal. Configure monitoring for processing/needs-review receipts and worker failures before release. Guest, occupancy, block-pickup and contract loops isolate failures per hotel: one ambiguous delivery cannot abort other hotels. They record sanitized per-hotel failures and an aggregate partial-failure status, then surface an aggregate error after unaffected deliveries finish. A retry cannot resend an ambiguous or already-confirmed receipt.

## Guest source and run contract

Only the current Brussels business date's `arrivalsmadeyesterday` source is accepted. Missing or older source is unavailable, not a zero-guest report. A valid source with no eligible long-stay guests produces a completed empty version. Candidate processing uses strict date-only validation and checkout-exclusive nights, excludes PM/PR records, and bounds source rows (2,000), eligible reservations (400) and unique subjects (120). Exceeding limits fails explicitly; it does not truncate and publish incomplete results.

The source fingerprint includes the research policy, model, report date and sorted relevant reservation fields. Changed/removed candidates create a new generation with a captured unique nonce. Expired-run cleanup cannot cause a fresh generation to reuse an old version or delivery journal. Unchanged, unexpired completed input avoids repeated research. A transactionally fenced lease and per-subject checkpoints allow an interrupted generation to resume. At most eight provider requests run per pass; the 30-minute continuation schedule resumes paused runs. Partial, failed or superseded generations are never selected for mail.

Generated rows reside in `guestIntelligenceVersions/{versionId}/guests`. The date run and safe date pointer publish a complete version atomically after a transactional source-fingerprint recheck. Mail validates the current source, intended completed version, expected row count and every row's finite future expiry. It repeats source/version/row and recipient validation inside the delivery-journal claim transaction after Auth lookup; a changed source aborts before any receipt or provider call. It never falls back to an older date or partial version. Half-hour mail polling begins only at the original 04:30 Brussels delivery window, so a completed continuation is delivered later that day once per version. Version subcollections and checkpoints are server-only; historical date-path guest rows are retired by cleanup.

The external research payload contains only a guest name and an opaque subject token. It excludes hotel identity, arrival/departure dates, nights, internal reservation IDs, email and other imported personal fields. The request sets `store: false`; this does not establish a provider's abuse-monitoring or contractual retention policy. Review the external provider agreement and configured model before enabling the workflow.

## Retention and release checks

Generated profiles and checkpoints expire 23 hours after the generation starts. Resuming cannot extend expiry. Readers and mail reject expired data immediately. The hourly cleanup removes expired version guests/checkpoints/metadata, expired or malformed date-run metadata and all legacy date-path guest rows, including records without an expiry. A run with a valid bounded active lease is preserved until that lease expires; deletion is transactionally rechecked against concurrent renewal. This leaves one hour for deletion within the application's 24-hour retention target. Cleanup bounds or scheduler outages must alert operators; timing and physical deletion cannot be proven by unit tests. Verify actual scheduling and alerting before claiming the deployed retention guarantee. This policy concerns generated guest intelligence, not the independently managed operational arrival reports.

Required release sequence:

1. Pause the old research/mail schedules through an explicit release procedure; migrate recipient UID mappings and canonical property capacity/bootstrap settings.
2. Deploy matching rules and Functions together, including `cleanupExpiredGuestIntelligence` and `resumeGuestIntelligenceRuns`. Do not enable client writes to generated data or receipts.
3. Run and inspect the authorized cleanup on legacy intelligence before re-enabling reads/mail. Check for version bounds and orphaned legacy rows.
4. Confirm 23-hour expiry rejection, hourly deletion, half-hour continuation, provider configuration and alerting on a fictional or controlled staging hotel.
5. Exercise an ordinary hotel user's authorized reminder workflow, removed/disabled follower cases, changed email and a two-hotel report configuration. Use a fake or controlled provider; record actual acceptance separately from local tests.
6. Inspect processing/needs-review journals and confirm the reconciliation procedure before enabling scheduled delivery.

Focused local verification: `FIREBASE_CONFIG='{"projectId":"hotel-suite-test","storageBucket":"hotel-suite-test.appspot.com"}' node --test functions/src/guestIntelligence.node-test.js functions/src/guestIntelligenceMail.node-test.js functions/src/scheduledWorkers.node-test.js`.
