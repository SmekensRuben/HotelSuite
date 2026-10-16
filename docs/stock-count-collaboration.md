# Stock count collaboration

## Editing and saving

Counters can work on different physical locations in the same count. Each location has its own revision. Saving or finishing a location compares the revision originally loaded by that editor, then updates the child and parent summaries in one transaction. The parent remains a consistent summary with a monotonic revision; unrelated saves are transparently retried by Firestore. Existing actor and timestamp evidence is retained.

Two edits to the same location are never merged automatically. The first accepted save advances the location revision. The other editor keeps the local draft and receives a conflict. The interface shows the latest saved quantities beside the draft and requires an explicit choice before saving against the new revision. Another intervening save can still conflict safely. Finished locations and finished counts remain immutable.

## Draft recovery

Each local edit is automatically stored on the current device; **Save Counts** explicitly saves it to the hotel. The distinction is visible in the editor. This avoids sending incomplete quantities to other employees while retaining interrupted work. Device drafts contain the original location revision, quantities, optional estimates and included rows. They remain separate by authenticated user, hotel, count, location and editor tab, so another tab cannot overwrite an existing draft.

Opening the location again offers available drafts with an explicit recovery choice. Recovery retains the original revision: loading a newer server snapshot does not grant a stale draft permission to overwrite it. A successful save clears the current editor's draft. Dismissing a recovered snapshot does not delete newer edits from its original tab.

Drafts remain on the same browser/device; they are not a server backup or a cross-device synchronization feature. If local storage fails, the editor reports it, offers a storage retry and warns before leaving with input that is neither stored locally nor saved to the hotel. Failed local writes also remain recoverable during navigation within the open application, with a warning that closing or reloading the tab would lose that temporary copy. Confirmed saves and explicit dismissals release that temporary copy even while browser storage remains unavailable. Hotel/user switches hide other scopes' drafts. Clearing browser storage removes local recovery data.

## Interrupted requests and completion

Before sending a mutation, the adapter stores the exact command and its request identity locally. If the response is lost, **Retry saved change** replays that command. The server's transaction receipt returns its original result without writing the same save or checkpoint again. A pending location request does not block another location's request. Parent completion has a separate pending scope and can be recovered even when the count is already shown as finished.

An explicit transaction rejection after checking that no receipt exists proves the request made no writes. The adapter then releases the pending command so the draft can be corrected or reviewed. Authentication/authorization failure, a request-ID collision, malformed responses and transport failures do not prove that an earlier attempt was uncommitted; those pending commands remain available. Account changes and unmounted editors cannot apply a late response to another user's interface or clear that user's recovery data.

All included products still require explicit quantities before a location can finish; zero remains valid and different from uncounted. Location finishing, immutable checkpoints and parent summaries share the same transaction. Finishing the count still requires every child to be finished. Current hotel access, action permissions, optional template-update permission, subscription checks, tenant scoping and financial validation remain enforced on the server, including request replay.

## Compatibility and rollout

Deploy the updated callable before the updated client. Old clients continue using the original parent revision guard and remain safe; they benefit from independent location edits after upgrading. Historical snapshots are not rewritten, and a missing revision is interpreted as zero. No data migration or backfill is required.

The command receipt namespace is nested beneath each existing count. Existing Rules deny direct client writes, and import-target protection already covers the entire `stockCounts` collection. Preserve receipts in backups and restore workflows together with their count; deleting a receipt can remove proof needed to reconcile an interrupted operation.

Regression coverage includes concurrent saves to different and identical locations, atomic completion/checkpoints, exact replay after later saves or completion, changed-request rejection, current authorization on replay, scoped browser command recovery, user switches, component unmounts and local draft recovery/storage failures. Emulator tests verify the transaction behavior and protected write boundaries against real Firestore semantics.
