# Domain settings migration

The domain settings release replaces the shared browser-readable document with permission-scoped documents. Run `scripts/migrate-domain-settings.mjs` as an operator before activating the new client and Firestore Rules for an existing property. This script uses the Admin SDK, bypasses Rules, and is never called by the browser, onboarding, CI, or a scheduled function. No application adapter falls back to the legacy settings documents.

Every command selects exactly one project and one hotel. Dry run is the default. Applying requires the fingerprint printed by a reviewed dry run and credentials supplied by the operator. The script never deletes source documents, removes destination documents, changes permissions, deploys Rules, or invokes operational workflows.

## Source and destination mapping

`H` is the explicitly supplied hotel ID. Source `hotels/H/settings/H` remains unchanged, including unknown fields. Source `hotels/H/settings/upsells` also remains unchanged; its old configuration and root marker are unavailable to browsers after the new Rules are deployed.

| Source | Destination | Persisted fields |
| --- | --- | --- |
| `settings/H`: `hotelName`, `language`, `currency`, `posProvider`, `orderMode`, `lightspeedShiftRolloverHour` | `hotels/H/settings/bootstrap` | Only the six listed initialization fields that exist in the source |
| `settings/H`: `hotelRooms` | `hotels/H/settings/propertySettings` | `hotelRooms`; an existing valid `updatedAt` is preserved |
| `settings/H`: `catalogCategories[id]` | `hotels/H/settings/catalog/categories/id` | `name` |
| `settings/H`: `catalogSubcategories[id]` | `hotels/H/settings/catalog/subcategories/id` | `name`, `categoryId` |
| `settings/H`: `contractCategories[id]` | `hotels/H/settings/contracts/categories/id` | `name` |
| `settings/H`: `contractSubcategories[id]` | `hotels/H/settings/contracts/subcategories/id` | `name`, `categoryId` |
| `settings/H`: `operaUserMappings[username]` | `hotels/H/settings/opera/userMappings/username` | `operaUser`, `employeeName`; raw username equals the document ID |
| `settings/upsells`: `dailyExpectedOccupancy[date]` | `hotels/H/settings/upsells/occupancy/date` | `date`, `expectedOccupancy`, `updatedAt` |
| `settings/upsells`: `revenueTargetRules[]` | `hotels/H/settings/upsells/revenueTargets/id` | `id`, `startDate`, `endDate`, the three target amounts, `updatedAt` |

The existing `settings/propertySettings/roomTypes`, `rateCodes`, and `marketSegments` subcollections, upsells `packagecodes`, `settings/groupQuotes`, and `settings/compset` are already separate domains and are not copied or changed. Parent documents are not needed to create the new taxonomy or Opera subcollections.

| Canonical domain | Browser reads | Browser mutations |
| --- | --- | --- |
| `bootstrap` | Verified hotel member, including a suspended subscription's identity screen | `propertysettings.update`, bounded initialization fields |
| `propertySettings` | `propertysettings.read` | `propertysettings.update` for the root; matching create/update/delete actions for its three record collections |
| Catalog taxonomy | Catalog settings actions, or catalog product read/create/update | Matching `catalogsettings.create`, `.update`, or `.delete` action |
| Contract taxonomy | Contract read/create/update/settings | `contracts.settings` |
| Opera mappings | Integration actions, reservation read, or upsell audit read/settings | Matching `integrations.create`, `.update`, or `.delete` action; username equals the document ID |
| Group quote configuration | Group quote read/create/update | `groupquotes.update` |
| Compset root and competitors | Group quote read/create/update, or commercial intelligence read/update | `commercialintelligence.update` as one configuration operation |
| Upsell package codes, occupancy, and revenue targets | `auditupsells.read` or `.settings` | `auditupsells.settings` |

All private domain access requires a verified current membership and active subscription, with the existing platform authority exception. The retired shared settings and upsells root documents remain browser-denied, including through the platform wildcard. A writer's implicit same-domain read only supports that domain's editor; it does not grant private access to other configuration.

The bootstrap document contains only the typed initialization fields listed above. It never receives catalog taxonomy, contract taxonomy, employee mappings, occupancy data, revenue targets, room count, or arbitrary legacy fields. Other legacy keys, including old `categories`, `productCategories`, `suppliers`, `outlets`, sales/promo lists, `categoryMappings`, `staff`, and `staffContractTypes`, are reported by name under `preservedLegacyFields` and remain solely in the original document. Unknown keys are handled the same way. This migration does not move their contents into another domain or grant browser access to them.

## Validation and conflict handling

The complete source selection and every planned destination are inspected before the first write. The script rejects malformed known fields rather than coercing values, skipping broken rows, or silently truncating a collection.

- Names and Opera employee values must be nonempty strings of at most 200 characters without control characters. Taxonomy and rule IDs must be valid Firestore document IDs of at most 128 characters. Subcategories must reference a nonempty category ID present in the corresponding legacy category map; an unlinked or dangling subcategory requires operator review.
- Opera document IDs use the raw username, which must be 1–128 characters with no slash, control characters, or surrounding whitespace and cannot be `.`/`..` or a reserved `__...__` ID. A period within a username remains valid. Raw IDs let Rules enforce the document ID's equality to `operaUser` and prevent a create-only caller from adding the same identity under another ID. Unsupported legacy usernames require an explicit identity/schema review; the script preserves their source and stops without rewriting or encoding them.
- Bootstrap language must normalize to `nl`, `en`, or `fr`. The script accepts the known English/Dutch/French names and locale aliases such as `en-US` or `nl_BE`. Currency is normalized to three uppercase letters. These two normalizations are reported under `normalizedFields`; missing bootstrap fields are not populated with defaults. `posProvider` and `orderMode` are nonempty strings of at most 40 characters. The rollover hour is an integer from 0 through 23.
- `hotelRooms` is an integer from 0 through 100000. Occupancy is a finite number from 0 through 100000. Each revenue amount is a finite number from 0 through 1000000. Numeric strings, negative values, `NaN`, and infinity are rejected.
- Dates must be real `YYYY-MM-DD` dates. Revenue start dates must not follow end dates. Each taxonomy collection and Opera mapping collection is bounded at 1000 source entries; occupancy is bounded at 1000 dates and revenue rules at 250 entries. Duplicate revenue rule IDs and unexpected fields inside a taxonomy, mapping, or revenue record are rejected. A hotel ID that overlaps a reserved settings document ID also requires operator review.

Legacy upsells `dailyRevenueTargets` is supported as a read-only fallback source: its `expectedOccupancy` becomes an occupancy document when `dailyExpectedOccupancy` is absent, and its `minimumRevenuePerOccupiedRoom`, `reachRevenuePerOccupiedRoom`, and `stretchRevenuePerOccupiedRoom` become single-date revenue rules when `revenueTargetRules` is absent. Explicit newer fields take precedence, including empty maps or arrays. Absent legacy amount values become zero, matching the old adapter's documented shape; present malformed values are rejected. Revenue rules without an ID get the deterministic ID `startDate-endDate-originalArrayIndex`. New occupancy and revenue documents receive an Admin server timestamp. Existing equal documents retain their existing timestamps.

Existing destinations are kept when every copied field already matches. Missing fields in a valid bootstrap or property document can be added while retaining its other approved fields. A different value, unexpected destination fields, or an invalid destination timestamp stops planning; there is no overwrite switch. Destination documents absent from the legacy maps remain untouched. Resolve any deliberate newer configuration as a separate reviewed operator action instead of using this migration to replace it.

## Operator rollout

1. Record the exact project and hotel selection, operator identity, current client/Functions/Rules release, and source backup location in the release record. Follow the repository's Firebase environment and recovery procedures. Take a verified Firestore backup containing the two source documents, planned destination documents, and their hotel parent. Retained legacy documents provide copy recovery but do not replace a full backup.
2. Stop edits to the affected settings while copying and switching the release. Ensure the new client and Rules are tested together in a non-production environment. Verify feature permissions for property, catalog, contract, Opera, occupancy, and revenue-target readers and writers, plus the denied legacy/root paths. Inspect already separate group quote, compset, package-code, and property record documents against the new Rules schemas as a separate release preflight; this copy script intentionally does not rewrite them. Compset editors support at most 100 competitors and 10 numeric placeholder rates per competitor. Resolve any unsupported existing fields or values through a reviewed operator migration while retaining their backup; do not add a permissive client fallback.
3. Use Node 22 or later and the installed repository dependencies (`npm ci` for this checkout). Supply an operator ADC credential file outside the repository with permission to read and write the selected project's Firestore data. The project is always selected by `--project`; the script does not read `.firebaserc` or select a project from the credential file. Do not commit credentials or put their contents in command arguments or logs.
4. Run the dry run for one hotel and review its printed field names, normalization list, per-domain create/merge/keep counts, and fingerprint. Dry run initializes the Admin client only to read; it performs no writes. Fix malformed copied shapes or destination conflicts through a separate authorized change, then obtain and review a fresh dry run.

   ```bash
   node scripts/migrate-domain-settings.mjs \
     --project PROJECT_ID \
     --hotel HOTEL_ID \
     --credentials /secure/operator-adc.json
   ```

   Alternatively, set `GOOGLE_APPLICATION_CREDENTIALS` to that file and omit `--credentials`. Ambient credentials without an explicitly supplied file are not accepted.

5. Apply the exact reviewed fingerprint. Reuse the same project, hotel, and credentials. A changed source, hotel parent, or destination produces a new fingerprint and requires a fresh review.

   ```bash
   node scripts/migrate-domain-settings.mjs \
     --project PROJECT_ID \
     --hotel HOTEL_ID \
     --credentials /secure/operator-adc.json \
     --apply \
     --expected-plan REVIEWED_64_CHARACTER_SHA256
   ```

6. Require the script's `verified` result, then run another dry run and confirm every planned destination is `keep`. Independently inspect representative property, catalog, contract, Opera, occupancy, and revenue values. Confirm both legacy source documents are unchanged and that unrelated settings remain intact. Do this for every explicitly selected property; the script never discovers or scans all hotels.
7. Activate the tested Rules and matching client/Functions release through the normal authorized release process. The release must deny shared legacy browser access and the upsells root and must not introduce fallback reads. Keep settings edits paused until permission-scoped read/create/update/delete checks pass against the new paths. Record verification and resume editing only after that checkpoint.

For a local emulator rehearsal, set `FIRESTORE_EMULATOR_HOST`, use an explicit `demo-*` project, and add `--emulator`. Credentials are not needed in this mode. If the emulator environment variable is present without `--emulator`, the script stops to prevent an accidental target mismatch. Do not use emulator rehearsal as a substitute for the separately authorized deployment procedure.

## Interrupted migration and recovery

Writes run in transactions of at most 400 destination documents. Source versions and the current chunk's destination versions are reread in every transaction. An unexpected source or destination change aborts that chunk; existing differing data is never overwritten. A hotel with more than 400 missing documents may have several transactions, so a failure can leave earlier chunks copied. The script does not automatically undo those completed copies.

Keep rollout paused after any error. Inspect the error, the retained sources, and the copied destination state. Run a fresh dry run: equal completed copies become `keep`, and only missing fields/documents remain planned. Review its new fingerprint and rerun with that fingerprint after resolving the cause. This is the recovery path for interruption; deleting successful copies or modifying retained legacy sources is unnecessary.

If the new client or Rules fail verification after copying, keep writes paused and use the approved release/recovery procedure. Do not reopen the shared legacy document to browsers as a recovery shortcut. A later application change may make canonical values newer than the retained legacy source; restoring that old source over canonical documents would lose those edits and is explicitly outside this script. An operator must compare the backup, retained source, and current domain documents before any targeted restore or deletion, then validate tenant isolation and each feature's permissions again.

## Local verification

Run `node --test scripts/migrate-domain-settings.test.mjs`. The focused tests use an in-memory Admin-shaped database and exercise schema splitting, unknown-field preservation, conflict rejection, stale-plan/source and concurrent-destination protection, legacy upsells translation, chunk bounds, and idempotent retries. They never initialize an Admin app or contact a Firebase project.

## Quote evidence boundary

Quote Rules bound the client record schema and require positive physical requested room nights and feasibility evidence for CURRENT creation. UNAVAILABLE creation must be an explicit draft with a nonempty reason and no saved pricing or contribution guidance. Changed analysis or saved-input fields require STALE or UNAVAILABLE; stored snapshots and model versions remain immutable. The browser adapter also sums requested nightly rooms before saving. Rules do not recompute 366 nested nightly rows or certify client-calculated economic/model results; a trusted server save/calculation workflow would be needed for numerical authenticity. These guards protect access, lifecycle and stored evidence rather than providing that calculation certification.
