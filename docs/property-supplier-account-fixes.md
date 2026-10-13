# Property settings and supplier account fixes

Base: current main `730da510ac7e0540c9882b372bcadb6bd3dcdf07` (PR #236 merged).
Branch: `codex/property-supplier-account-settings-20261013`.

| Finding | Code evidence | Acceptance | Code | Local | Deployed |
|---|---|---|---|---|---|
| Checklist link remains on the same page | `HotelSetupChecklist.jsx` links to its current hotel URL without an anchor | Link scrolls to Property and contact and focuses its time-zone selection, including repeated activation and direct hash entry | Resolved | Verified | Not run |
| Time-zone field writes administrative metadata only | `platformConsole.js` writes `platformDetails.timeZone`; setup and inventory read `hotel.timeZone` | Search/select a named time zone; save updates the operational field and compatibility metadata; the checklist reads the saved operational settings | Resolved | Verified | Not run |
| Currency cannot be configured in platform UI | Platform hotel DTO/form omit bootstrap currency | Search/select currency; atomically align root/bootstrap settings, preserve other bootstrap fields and all historic snapshots; concurrent settings changes abort; changing a known currency requires explicit acknowledgement | Resolved | Verified | Not run |
| Supplier outlet account numbers cannot be edited | Account table has no edit action; existing upsert has no revision guard | A permitted module manager edits an existing stable account assignment without supplier/outlet directory rights; reader/admin-without-operational-rights cannot edit; stale writers cannot overwrite changes; sent orders retain account snapshots | Resolved | Verified | Not run |

No production edits, merge or deployment are authorized. Prepare coherent commits and a PR. Reuse SaaS Rules v5; no new per-hotel activation. Tests must include genuine platform and ordinary-hotel identities in local emulators, independent historical-preservation assertions, UI focus/search/permission tests and a production-safe fixture build.


## Verification evidence (13 October 2026)

- Frontend suite: `npm test -- --run --maxWorkers=2`: 135 files / 1,183 tests passed. Final account-service identity/acknowledgement checks and separate same-UID Auth replacement check: 11 tests passed in the two account files after the final review refinements. Exact-head CI will verify the complete final tree.
- Functions: `npm --prefix functions test`: 359 tests passed.
- Real Auth/Firestore/Storage emulators: `npm run test:security`: 214 tests passed, including four operational-property cases and six account cases. Tests use fictional `demo-hotel-suite-a00` only. Both the platform operator with no hotel membership and ordinary compiled procurement module-manager identities are exercised through the exported callable wrappers.
- The property tests assert the original checklist is pending and becomes ready after saving canonical fields. Independent order/count/movement/report fixtures retain their original amounts, currencies and snapshots after changing the hotel currency. A bootstrap change outside platformRevision invalidates the reviewed settings fingerprint.
- Account tests prove preservation of legacy IDs, ordinary read/write boundaries, live Auth and subscription checks on receipt replay, explicit duplicate rejection, one winner among simultaneous writers, and preservation of independently seeded sent-order and dispatch snapshots. Generic imports cannot forge account operation receipts.
- `npm run test:restore`: two-hotel Firestore/Auth/Storage export/import recovery passed, including existing immutable inventory, supplier response and approved-price evidence.
- Lint, incremental type checking and dependency policy passed; no dependency was added. Test build and App Hosting build passed using explicit fictional Firebase configuration. The existing large-bundle advisory remains.
- Browser verification uses the real changed React components/CSS with synthetic local services at 1,440 and 390 pixels: working anchor/focus, named time-zone/currency selection, account modal/save, reader restrictions, no document overflow and no page exceptions. Emulators provide the separate authorization/persistence proof. This is not production browser evidence.

## Review decisions

Keep hotel administration separate from operational permissions. Account editing requires `suppliers.update` in an active procurement subscription; hotel-administrator or platform-administrator status alone does not grant it. Editing an existing account needs no outlet-directory permission or browser credential access. The pair stays fixed; an archived outlet or duplicate pair must first be reviewed.

Preserve unknown values. The property form initially shows blank for missing currency or time zone; legacy metadata is offered for explicit saving. Choices carry readable names and canonical IANA/ISO values. Changing an established currency requires acknowledgement and aligns root/bootstrap settings atomically without conversion of supplier prices or historical records.

Account commands have expected revisions and private idempotency receipts. The service checks the acknowledged stable ID and revision, retains uncertain requests for exact retry within the Auth session, and never accepts a late result from another Auth object. A new-account command cannot silently overwrite an existing assignment. Older create clients remain supported with this safer duplicate behavior. The existing callable name is reused; no new SaaS Rules version, activation flag or per-hotel Cloud Shell procedure is needed.

## Remaining release checks

No merge, production data write or deployment was performed. Confirm Functions and App Hosting for the merged release have completed before testing the UI. No Rules or index deployment is added by this change.

1. In **Platform → Hotels → selected hotel**, activate **Manage hotel details**. Confirm it scrolls to **Property and contact** and focuses the time-zone choice. For a Belgian hotel choose **Belgium — Brussels** and **EUR — Euro**, then **Save hotel details**. Confirm the property checklist check becomes ready; new inventory work uses the saved settings. Review any currency conflict/acknowledgement explicitly.
2. As a normal hotel procurement module manager, open **Suppliers → selected supplier → Supplier Outlet Accounts → Edit**. Change a test account number and reload. Confirm readers do not get an edit action. Two concurrent sessions must get a conflict rather than a lost update.
3. Sent orders retain their account snapshots. A Created order whose account changed must be edited/reviewed before confirmation under the existing order policy. Existing currency snapshots are preserved; old evidence in another currency remains subject to the existing unavailable-cost checks, without automatic conversion.

Resume point: publish the tested branch as a PR, inspect exact-head CI and keep all deployed statuses **Not run** until authorized release checks are performed.
