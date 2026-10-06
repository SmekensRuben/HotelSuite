# Permission matrix

Status date: 2026-10-06. This matrix describes the policy implemented in this branch; it is not evidence that the rules are deployed. The exact tested rules are `firebase/firestore.rules` and `firebase/storage.rules`, both referenced by `firebase.json`.

## Policy model

- Platform administration is a Firebase custom claim: `platformAdmin == true`. It is not a Firestore field a user can edit.
- Hotel access is authoritative only through `hotels/{hotelUid}/members/{uid}`. Each membership contains its own `permissions` list, so one user can have different rights in hotels A and B. A missing membership or missing permissions fail closed in the UI and backend.
- The legacy `users/{uid}.hotelUid` list remains temporarily useful for hotel discovery in the UI, but neither it nor its legacy permissions authorize Firestore, Storage, routes or callable access.
- Permission keys are `feature.action`; `feature.*` grants all actions for one feature. Platform-wide access uses only the `platformAdmin` Firebase custom claim; `super.admin` is not a supported permission. There is no `users.manage` alias.
- A hidden menu or button is only UX. Routes, Firestore, Storage and callable functions independently enforce access.

## Route and page matrix

“Rules” means direct data access is covered by the named rule family. “UI” means menu/route/action controls use the same key. A status of **blocked** is intentional until a safe replacement exists.

| Module | Routes / actions | Data and backend boundary | Required permission | Previous gap | Coverage |
| --- | --- | --- | --- | --- | --- |
| Public | `/`, `/login` | Firebase Auth only | Public | None | Public by design |
| Dashboard | `/dashboard` | No operational query | Authenticated hotel member | No feature key | Route authenticated; hotel membership required by context |
| Property settings | `/settings/general`, `/settings/property`, room types, rate codes, market segments; CRUD | `settings/propertySettings/**` | `propertysettings.read/create/update/delete` | Broad `settings.*`; write buttons not consistently hidden | Route + Firestore; remaining button cleanup listed below |
| Catalog settings | `/settings/catalog`; category CRUD | mixed hotel settings document | `catalogsettings.read/create/update/delete` | Broad `settings.*` | Route + UI hooks + mixed-settings rule limitation |
| Outlets | `/settings/outlets/**`; approvers | `outlets/**` | `outlets.read/create/update/delete` | Broad `settings.*` | Menu + route + UI hooks + Firestore |
| Locations | `/settings/locations/**`; stock templates | `locations/**` | `locations.read/create/update/delete` | Existing and mostly consistent | Menu + route + Firestore |
| Imports | `/settings/file-import/**`, `/settings/file-import-types/**`; JSON import/export and upload execution | `fileImportSettings/**`, `fileImportTypes/**`, Storage `imports/{hotelUid}/**`, import Storage trigger | `imports.read/create/update/delete`; `imports.execute` for uploading source files | Broad `settings.*`; Admin trigger trusted metadata | Menu + routes + Firestore + Storage; `execute` rollout requires upload UI migration |
| Integrations | `/settings/opera`; mapping CRUD | mixed settings document | `integrations.read/create/update/delete` | Broad `settings.*` | Menu + route + UI hooks; mixed-settings limitation |
| Notifications | `/settings/notification-lists`; list CRUD | `notificationLists/**` | `notifications.read/create/update/delete` | Broad `settings.read`; read users could mutate in UI | Route + action buttons + Firestore |
| Platform users | `/settings/users`, `/settings/users/:userId`; global profile update | `users/**`, future memberships | `users.read/update` **plus platform admin** | Global collection read; hotel admin could potentially cross tenants | Menu + platform-only routes + Firestore default deny; existing UI deliberately unavailable to hotel admins |
| Arrivals | `/front-office/arrivals` | reports `arrivalsdetailed`, `ratecodeheader`; `listArrivalDates` callable | `reservations.read` | Route required only authentication; callable checked hotel list but no feature | Menu + route + reports rules + callable membership/permission |
| Made reservations | `/front-office/made-reservations` | reports `arrivalsmadeyesterday`, settings/segments | `reservations.read` | Route required only authentication | Menu + route + reports rules |
| Upsell audit | `/front-office/upselling/**`; validate/create/settings | `upselling/**`, `settings/upsells/**`, reservation reports | `auditUpsells.read` or special `auditUpsells.settings` | Special action already existed; report dependencies were broad | Menu + routes + Firestore; report allowlist must be checked against live data paths |
| Catalog products | `/catalog/products/**`; import/export/image upload/CRUD | `catalogproducts/**`, product image Storage, Meilisearch read | `catalogproducts.read/create/update/delete` | Mostly existing | Menu + routes + buttons + Firestore + Storage |
| Supplier products | `/catalog/supplier-products/**`; import/export/image upload/CRUD | `supplierproducts/**`, image Storage, suppliers read | `supplierproducts.read/create/update/delete` plus `suppliers.read` for selection | Mostly existing | Menu + routes + buttons + Firestore + Storage |
| Suppliers | `/catalog/suppliers/**`; outlet accounts, credential display | `suppliers/**`, `supplierOutletAccounts/**` | `suppliers.read/create/update/delete`; legacy `suppliers.password` only affects masking | Password field cannot be field-hidden by rules | Menu + routes + Firestore; supplier secrets remain a known blocker |
| Orders | `/orders/**`; cart, edit/delete, confirm/dispatch, PDF | `orders/**`, `shoppingCarts/**`, suppliers/outlets; Firestore triggers for mail/SFTP | `orders.read/create/update/delete`; `orders.approve` for dispatch request fields | Approver list was only client-side; any updater could start dispatch | Routes + action button + field-diff rule for approve; background trigger is server-trusted |
| Contracts | `/contracts/**`; files, settings, manual reminders | `contracts/**`, Storage contracts, `contractReminderRuns/**` | CRUD; `contracts.settings`; `contracts.notify` | Reminder action available to every reader; settings used broad settings permission | Menu + routes + actions + Firestore + Storage |
| Stock counts | `/catalog/stock-counts/**`; save/finish/export | `stockCounts/**`, supplier products/outlets reads | `stockcounts.read/create/update/delete` | Detail/location routes required only read while save/finish buttons mutated | Routes + save/finish actions + Firestore |
| Groups | `/me/groups/**`; group CRUD | `groups/**`, group settings/segments, notifications read | `groups.read/create/update/delete` | Existing; rooming-list actions reused group update | Menu + routes + Firestore; group auxiliary collection rules included in rollout checklist |
| Rooming lists internal | group create-link and `/rooming-list-change-request/**`; history/review | global `roomingListLinks/**`, linked groups | `roominglists.read/create/update/approve` | Shared public/internal client API; approval route needed only groups.read | Create/review UI + route + rules |
| Rooming lists public | `/rooming-list/:token` | root token, versions/change requests, linked group | Public capability | Existing page reads and writes more data than can safely be exposed | **Blocked:** only active, expiring root summary may be read; no public write/history/internal group access |
| Demand calendar | `/me/demand-calendar/**`; events/categories/import | `demandCalendarEvents/**`, legacy `localEvents/**`, demand categories settings | `demandcalendar.read/create/update/delete/import` | Reused `groups.*`; detail delete/edit buttons not action-gated | Menu + routes + event/category/import actions + Firestore |
| Group quotes | `/revenue/group-quotes/**`; CRUD, outcomes, settings, Lighthouse upload, model rebuild | `quotes/**`, group-quote reports/settings, Lighthouse Storage/Firestore, callable | `groupquotes.read/create/update/delete`; update for settings/rebuild/outcome | Commercial Intelligence reused this feature | Menu + routes + Firestore + callable; mixed-settings limitation |
| Commercial Intelligence | `/revenue/commercial-intelligence`; competitor observations | `competitorGroupQuotes/**`, `compset/**`, quotes read | `commercialintelligence.read/create/update/delete` | Reused `groupquotes.read` despite separate writes | Menu + route + Firestore |
| Unrouted legacy inventory | checklist, articles, ingredients, recipes, returns, schedules, revenue snapshots, sales promo, receipts | corresponding hotel collections and checklist Storage | No active route permission assigned | Legacy hooks/services exist without current router entries | Platform-only default deny until a module/owner is restored |

## Backend matrix

| Backend entry point | Trigger | Authorization policy | Coverage |
| --- | --- | --- | --- |
| `listArrivalDates` | callable | Authenticated membership plus `reservations.read` for requested hotel | Enforced by shared helper and unit-tested |
| `rebuildStayPatternModel` | callable | Membership plus `groupquotes.update`; platform claim bypass | Enforced by shared helper and unit-tested |
| Resend inbound webhook | HTTP | Svix signature over the raw request body using `RESEND_WEBHOOK_SECRET` | Enforced; secret must exist before function deployment |
| Catalog/import index synchronization | Firestore triggers | Trusted background processing; initiating client write is rule-protected | Server-side Admin SDK only |
| Order mail/SFTP dispatch | Firestore trigger | Trusted background processing; client may change only dispatch request fields with `orders.approve` | Rule field-diff tested; outlet-approver server validation remains required |
| Schedules and report jobs | scheduler | Google-managed scheduler invocation; Admin SDK | No end-user hotel payload accepted |
| Storage import processor | Storage finalize | Trusted trigger, but target-path allowlisting remains a separate import-hardening requirement | Not treated as user authorization |

## Exact tested rules

- Firestore: `firebase/firestore.rules`
- Storage: `firebase/storage.rules`
- Firebase bindings: `firebase.json`
- Supplied unsafe reference fragment: `firebase/reference/firestore.rules.supplied-unsafe.txt`

The supplied fragment is intentionally not deployable. Both deployed rule files end in default deny; no broad hotel or root rule grants normal members implicit read/write access.

## Data migration and rollout order

1. Capture the complete deployed Firestore and Storage rules and compare them with the supplied fragment and these files. Do not overwrite unknown cloud rules to obtain a baseline.
2. Back up Firestore and Storage and complete the separate-project restore proof from A00.
3. Create `hotels/{hotelUid}/members/{uid}` for every current user/hotel relation. Copy only reviewed permissions; translate legacy broad `settings.*` into the explicit keys in this matrix. Keep `users/{uid}.hotelUid` temporarily for hotel discovery.
4. Assign `platformAdmin` custom claims only through an audited Admin SDK process. Never store platform status in a client-writable document.
5. Provision Storage token claims (`hotelPermissions` map) or change Storage to a server-only upload design. Refresh/revoke affected ID tokens.
6. Add `RESEND_WEBHOOK_SECRET` and verify a signed webhook in the audit environment before deploying the HTTP function.
7. Deploy backend callable/webhook code before rules so callers understand membership documents and signatures.
8. Deploy the frontend with per-hotel permission loading and the updated routes/actions.
9. Run emulator tests, audit-project smoke tests for every matrix row used by the pilot, then deploy indexes followed by Storage Rules and Firestore Rules.
10. Monitor denied requests, Functions errors and order/import queues. Roll back to the captured secure ruleset, never to the supplied `allow true` fragment.
11. Verify that every active account has the intended membership; the client intentionally has no legacy global-permission fallback.

## Remaining limitations and blocked verification

- The complete currently deployed rules were not provided; only the unsafe catch-all fragment was supplied. Cloud overlap with other matches cannot be verified without authenticated capture.
- The main hotel settings document combines unrelated fields. Rules can protect the document but cannot reliably give field-level modules different read access. Split settings documents before selling strict module isolation.
- Existing supplier documents contain credential fields. Firestore cannot hide individual fields in an allowed document; move them to server-only secret storage.
- Public rooming-list editing/submission is deliberately blocked. A server-side, expiring capability API with minimal DTOs and transactional capacity checks is required.
- The order dispatch trigger still needs a server-side outlet-approver check; the client check and `orders.approve` permission are not equivalent to outlet assignment.
- Global user administration remains platform-only. Hotel-admin membership management needs a callable backend returning tenant-scoped profiles rather than the existing global users query.
- Several legacy services have no current routes and remain platform-only default deny until their product owner and permission are known.
