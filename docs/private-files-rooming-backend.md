# Private contract documents and organizer rooming lists

This release adds server-managed contract records/documents and a complete organizer submission/change-review backend. The existing operator-led, manually invoiced procurement pilot remains the commercial boundary. It does not add payments, automatic renewals or customer charges. All new product copy and implementation are English.

## Contract documents

- Contract reads use `listHotelContracts`, returning a bounded explicit projection without legacy download URLs. Creates/updates use `saveHotelContract`, canonical Auth followers, current per-hotel actions, validated dates/prices/reminders, revision checks and durable operation receipts. `listContractFollowers` reads only the selected hotel's bounded verified member directory.
- The frontend sends binary documents to `contractDocument` with an Authorization bearer header. Credentials are never placed in URLs. The endpoint verifies token revocation and current account state, membership/action and subscription. Downloads also recheck current authorization and attachment membership after reading the pinned object generation.
- New objects live below `private/contracts/{hotelUid}/{contractId}/{fileId}`. Browser Storage access, including metadata access and token minting, is denied for new and legacy contract paths even to platform administrators. No download token or signed URL is issued.
- Each save preauthorizes at most 20 upload IDs; each file is nonempty and at most 20 MiB. Files are uploaded sequentially; the backend limits concurrent memory use. Gen-2 non-streaming responses allow the existing 20 MiB document limit; streaming responses are limited to 10 MiB.
- Upload retries reuse the save and file IDs. Storage creates use generation preconditions and a private hash/actor marker; attaching files is transactional. Removing attachments requires `contracts.delete` and records a tombstone so an old upload retry cannot attach the removed file again. Detached private bytes are retained for operator recovery; retention cleanup is a separate controlled task. They cannot be downloaded through the app after detachment.
- Every new private operation checks current Auth account state. Disabled accounts, removed platform claims, unverified email, revoked membership, expired trials and suspended subscriptions cannot use stale identity claims to recover private access. Platform operators also need an active subscription for operational files.

## Organizer capability and hotel review

The public link is a **group organizer capability**, not an individual guest identity. Anyone with the exact link can view this group's guest details and edit its draft until expiry. Share it only with the intended organizer. Responses omit staff actors, private rejection notes, internal audit data, hotel/group IDs and historical guest versions.

- `createRoomingList` validates the canonical group, snapshots room allocations, creates a cryptographically random token and sets a bounded expiry: at most 90 days or seven days after checkout, whichever is earlier. Repeated creation returns the same canonical link.
- `getRoomingList` checks current subscription, enabled access, expiry and the linked group's ownership. No anonymous Firestore root/history queries are allowed. An explicit `internal` read requires verified current staff identity and `roominglists.read`; it returns the latest ten versions and ten requests to authorized hotel staff.
- `mutateRoomingList` supports add/update/delete, initial submission and draft/change submission/cancellation. Inputs are strictly bounded, unknown authority fields are rejected and permanent reservation IDs survive edits. UTF-8 snapshots are limited to 200 kB of room allocation and 500 kB of guest details to stay below Firestore document/response limits. A list supports 200 reservations, 50 historical requests/versions, 30 mutations/minute, 300/hour and 2000 mutations per link lifetime; explicit retries do not consume the limit again. Hotel review/access controls do not consume the public mutation quota.
- Dates are real UTC calendar dates with checkout-exclusive nights. Every requested night must fit the immutable room-type allocation. Root revision/active-request checks, capacity, official versions, group status, audit and operation receipt are committed atomically. Simultaneous last-room requests cannot both succeed.
- Initial submission creates official version 1. Later changes go into a Draft, then Pending Approval. The official reservations do not change while a request is pending. Only `reviewRoomingList` with current `roominglists.approve` may accept or reject it; approval rechecks capacity and the current base version. Rejection requires a private reason. Reviews are idempotent and revision checked.
- **Group details → Organizer link access** lets a user with `roominglists.update` explicitly enable/extend access (at most 90 days) or disable the link. Disabled or expired legacy links are not automatically opened during migration.
- Backend availability is authoritative. After changes the page reloads the saved version. Uncertain requests and failed follow-up refreshes retain their operation IDs in memory to prevent another reservation from being created by retrying the same form.

## One-time reviewed rollout

Code-only merges still deploy Functions and App Hosting automatically. The Functions identity receives no additional IAM or Rules administration access. The new mutation endpoints remain blocked by `platformConfiguration/privateWorkflows` until this separate rollout is verified.

Upload only `scripts/firebase/rollout-private-workflows.sh` through Cloud Shell's **Upload file** control. A Git clone is not required. Use Node 22 or newer as the existing reviewed operator:

The script now installs only its locked operator dependencies and npm cache on `/tmp`, removes them on exit, and keeps reviewed sources and recovery backups on the persistent home disk. For an older script's ENOSPC failure, follow [the scoped disk recovery instructions](cloud-shell-rollout-runtime.md) and replace the uploaded wrapper before retrying.

```bash
bash ~/rollout-private-workflows.sh --release-sha <reviewed-current-main-sha>
```

This default is read-only. It checks exact current main, CI, App Hosting and actual Functions deployment; validates existing procurement data; inventories bounded contract records, Storage metadata including abandoned uploads/deleted hotels and retained generations, and rooming-list ownership/history. Public bucket IAM/default ACLs, missing/cross-hotel files, oversized documents, multiple active requests and unrecognized data stop the rollout for review. It creates no hotel membership, subscription, platform claim or new IAM binding.

After the preflight passes, apply the reviewed migration:

```bash
bash ~/rollout-private-workflows.sh --release-sha <reviewed-current-main-sha> --apply
```

Apply pauses both workflows, backs up and publishes both reviewed Rules sources, waits ten minutes for old browser permissions to expire, then rechecks the release and data. It backs up the original contract/rooming records in a private operator-local `previous-private-records.json`, makes checksum-verified private copies, updates contract attachment references and revokes every legacy download token (including abandoned uploads and retained generations). Existing bytes are retained, not deleted. Existing public access is preserved without extension; missing access stays disabled. Existing subscription states, user claims, passwords and hotel memberships are unchanged.

The final inventory must contain **zero legacy references, URLs or download tokens** before the private backend gate is enabled. An error leaves private mutations blocked. The script also verifies the procurement gate before activating private workflows. Preserve the printed workspace and its two private backups; they contain customer data and must not be committed or shared. For a partial migration, resolve the reported issue and rerun the pinned script to take a new backup and safely resume. Do not restore permissive contract Storage access or anonymous Firestore writes.

Success ends with **Private workflows enabled**. Refresh the app afterward. For an existing disabled/expired rooming link, use the explicit organizer-access control on the group; migration does not make that decision for you.

## Validation and limits

Required CI includes frontend/adapters, Functions, real Auth/Firestore/Storage security emulators, uploadable-wrapper failure tests, recovery smoke tests, dependency policy and both fixture builds. Adversarial cases cover cross-hotel paths, raw platform-client bypasses, metadata/token minting, stale identities, duplicate uploads/removals, lost responses, concurrent capacity, forged approval fields, public enumeration and private review notes.

The Storage emulator (firebase-tools 15.32.1) stores download tokens separately and does not implement their deletion through the Google Cloud Storage metadata PATCH API. A real-object test demonstrates private copying and **failed-closed activation** when tokens remain. Separate provider-contract tests verify null deletion, metageneration preconditions, every retained generation and idempotent retries. Production rollout checks actual Google API metadata after each revocation and scans again before activation; emulator results do not certify production token revocation or bucket IAM.

No real guest invitation, supplier order or payment is sent by the test suite. Limits outside these workflows, legacy reminder-recipient review and non-procurement domain validation remain separate commercial-readiness work. Revoking links cannot revoke a document that a previously authorized user already downloaded.
