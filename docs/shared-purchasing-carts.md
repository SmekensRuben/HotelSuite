# Shared purchasing carts

The hotel keeps its existing shared cart. Authorized buyers can review all outlet
lines together, add packages for a selected outlet, change quantities and notes,
and move part of a line to another outlet with **Split by outlet**. Leaving the
outlet unassigned remains supported; every line needs an active outlet before
orders can be created. The person creating orders reviews and submits the whole
shared cart. Submission creates draft orders grouped by supplier and outlet;
existing approval, confirmation, price, currency and receiving controls remain
unchanged.

## Line identity and collaboration

Cart rows have a stable `lineId` and integer `lineRevision`. Their business
identity includes supplier product, purchase option and outlet. Adding more of a
package increments only the matching outlet line. An unassigned addition never
inherits an existing assigned line's outlet. Quantity, note, outlet, removal and
split commands check the selected line's revision, so updates to other rows do
not block a save. Changes to the same row require refreshing and reviewing the
saved values before retrying; a stale quantity or note is never silently applied
to a newer row. Notes and quantities stay attached to the stable line identity.

Splitting atomically subtracts the entered quantity from the original row and
creates a separate destination row, copying its note. Both rows retain their
own editable notes. Moving or splitting into an already existing matching outlet
line is rejected with instructions to edit that line separately. This avoids
silently discarding either note or combining responsibilities. Newly added rows
record their creator, and every row mutation records its last editor. These
labels identify contributions; they do not lock other authorized staff out.

The cart revision continues to advance on every change. Adds use this revision
because they are additive intents; stale adds must be refreshed and deliberately
retried. Price review and submission also require the exact cart revision. A
concurrent edit either reaches the cart before submission and invalidates the
review, or occurs after consumption and fails because its line no longer exists.
The cart consumption, draft orders and idempotency receipt commit atomically.

## Interrupted requests

Cart mutations retain their existing actor/hotel/cart-scoped exact request
recovery. Order creation now retains its complete input and request ID in browser
local storage, scoped by the authenticated user, hotel and cart. Its review
fingerprint, delivery date and cart revision cannot change while the outcome is
uncertain. Reloading or reopening the cart displays **Retry saved order creation**,
which reconciles the original request. Permission, authentication, transport and
malformed-response failures retain recovery state. Only a validated success or
an authorized server transaction proving non-commit releases it. Changes from
another browser tab do not allow one request's completion to delete a different
saved request. Closing the browser retains this recovery record; clearing site
data removes it.

Separate actors or request IDs cannot submit the same cart revision twice.
Replaying the original successful request returns its existing order IDs, even
if the shared cart already contains later work. Current authorization is checked
before returning a stored result. Creating a draft does not dispatch an order.

## Compatibility and rollout

No bulk migration, new collection, new permission or new Firestore index is
required. Existing cart rows receive deterministic legacy line identities in the
read model and persist them on the first successful mutation. All remaining
legacy identities are persisted together, so removing one row cannot rename
another. Product/package-only clients still require the cart revision and may
edit only an unambiguous row; after a product has multiple outlet lines, they
must refresh into the new interface. Existing carts and historical orders are
not rewritten. Earlier committed mutation and order request receipts remain
replayable.

Deploy the updated callable functions before publishing the frontend, then
refresh older open clients. The previous frontend stored only anonymous
session request IDs for submission, without the original actor or full input;
these cannot be safely auto-attributed during upgrade. Resolve uncertain
submissions in the original open client before rollout, or review the current
cart and existing draft orders after refreshing. The server cart revision still
prevents a second consumption of an already submitted cart.

## Verification

Focused function tests cover independent outlet edits, same-row conflicts,
atomic splitting into two and three packages, separate outlet-bound orders,
legacy identity stability, exact replay, duplicate destinations, permissions,
archived outlets and submission races. Client tests cover stable row targeting,
note conflict review, split input, scoped durable submission recovery, malformed
acknowledgements, authentication changes and a different pending request from
another browser tab. Emulator collaboration tests exercise real transaction
contention between distinct employees and submission versus editing.
