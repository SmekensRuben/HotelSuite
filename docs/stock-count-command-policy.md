# Stock counts and actor lifecycle

Audit remediation F06 replaces direct stock writes with `createHotelStockCount` and `mutateHotelStockCount`. Both live callables require the reviewed SaaS rollout gate. Security Rules deny all direct writes to count parents and location children, including platform administrators.

`listHotelStockCountSources` uses the same current-actor/subscription checks with `stockcounts.create`, and returns only same-hotel location and template IDs/names. It pages 50 locations per request and bounds templates at 250 per location. The creation page no longer needs broad catalog/location configuration reads to choose a template. Existing snapshot counting works with only `stockcounts.read/update`; optional product additions query the complete paginated catalog only with independent supplier-product and outlet/order read access.

## Commands and invariants

- Creation requires `stockcounts.create`, a current enabled Auth account with verified email, selected-hotel membership and an active subscription. The server reads hotel-owned locations/templates, `supplierproducts` and outlets. It snapshots catalog prices and names; browser prices, totals, template snapshots and actor fields are never accepted.
- Creation uses a stable request ID and a deterministic count ID. A replay returns the original count; the same request with different creation details fails. The adapter retains the request ID after an ambiguous response.
- `save-location`, `finish-location`, `set-location-status` and `finish-count` require `stockcounts.update`. Parent revisions serialize concurrent changes and reject stale edits. Stock pages send the revision loaded with the count rather than hiding a stale form behind a fresh read.
- Finalizing a location and updating its parent summaries/value is one transaction. Finalizing the parent reads every listed child and requires every location to be Finished. Finished parents and locations cannot reopen, even through a privileged command.
- Quantities are finite non-negative purchase-unit quantities, bounded to 1,000,000 with three decimals. The server recomputes each line as quantity × snapshotted purchase-unit price (four decimal places), then sums those canonical line values. Unknown/invalid prices fail explicitly. Catalog changes do not revalue an existing template snapshot.
- Additional non-template items use current same-hotel catalog snapshots. Adding them to the source template additionally requires `locations.update`. The transaction reads and merges the live template, preserving changes since the count was created. Users with only stock authority can finish without modifying the template.
- Bounds: 50 locations, 250 items per location/template, 1,000 template items per created count, 750,000 UTF-8 bytes per written document, and a maximum canonical total of 1,000,000,000,000. Larger counts must be split; errors are surfaced.

## Current identity and minimal display names

`requireHotelPermission` and privileged platform handlers now re-read current Auth. Disabled/unverified/deleted accounts and revoked platform-admin claims fail even when the presented token is stale. Revocation time is checked when the token contains `auth_time`. A private server Symbol caches the validated Auth record only within one handler request; callable JSON cannot forge it. Membership/subscription reads remain transactional where the workflow mutates data.

Queued order dispatch and retry check the current enabled/verified actor, hotel membership, `orders.approve`, outlet designation and subscription again at execution. The mail worker separately rechecks its actor and recipients. Failure blocks delivery for review, without sending.

`getHotelUserDisplayName` returns only a display name for a target member of the selected hotel. It requires current Auth, subscription and operational membership; it never returns email, hotel assignments or a global profile. Unknown or historical actor labels are returned as labels without a global email search. Existing global user-profile privacy remains unchanged.

Access updates write permission deltas (`before`, `after`, `added`, `removed`) per affected hotel in the same transaction as profile and membership changes. New hotels receive `settings/bootstrap` and `settings/propertySettings`; room capacity remains unknown until configured.

## Verification and rollout

Focused Node and adapter regressions cover normal hotel users, spoofed actors/totals/prices, required values, replay/conflict handling, immutable completion, simultaneous finishes, source-template merging, current account revocation and scoped display names. `tests/security/stock-workflows.test.mjs` executes handlers against real Auth/Firestore emulators and checks normal-user command success plus direct/admin write denials.

Historical documents are not silently rewritten. Missing revisions are treated as initial revision zero; invalid stored state or prices fail for operator review. Existing Finished counts remain immutable. Before production release: deploy the callable exports and deny rules together with the reviewed client, verify the Functions manifest and rollout gate, inspect representative historical counts, then execute a two-hotel ordinary-user workflow. Local tests do not establish that production has been deployed or migrated.
