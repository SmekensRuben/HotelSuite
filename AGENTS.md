# HotelSuite repository guidance

## Product and structure

- HotelSuite (the UI currently brands itself as **Hotel Toolkit**) is a multi-property hotel operations application. Its implemented areas include procurement/catalog (catalog and supplier products, suppliers, orders, stock counts and contracts), front office (arrivals, made reservations and upsell audits), meetings/events (groups, rooming lists and demand calendar), revenue (group quotes and commercial intelligence), imports/integrations and property/user settings.
- `src/` is the React frontend: page components live in `src/components/pages`, reusable UI in `src/components`, Firestore/Storage access in `src/services`, pure domain calculations in `src/utils`, and hotel/auth context in `src/contexts`.
- `functions/` contains Firebase Cloud Functions for imports, indexing, scheduled/report workflows, notifications and protected server-side model work. See `docs/` before changing the group-quote, displacement, stay-pattern or LOS calculations.

## Technology and checks

- Frontend: React 18, Vite 4, React Router, Tailwind CSS, Firebase Web SDK, i18next and Vitest. Backend: Firebase Functions v2 on Node 22, Admin SDK and Node's test runner.
- Use Node 22 or later. Install with `npm ci` and `npm --prefix functions ci`.
- Run `npm test -- --run` for frontend tests, `npm --prefix functions test` for function tests, `npm run test:security` for emulator rules tests, `npm run test:restore` for the recovery smoke test, `npm run audit:policy` for the dependency gate, `npm run build:test` for a non-production CI build, and `npm run build` only with an explicit target environment. There is currently no configured lint or type-check command.
- Firebase resources use the project selected in `.firebaserc`; never deploy, mutate production data or commit credentials as part of a routine task. Frontend configuration belongs in an untracked `.env` using the variable names documented in `README.md`.

## Code and naming conventions

- Follow the existing JavaScript/JSX style: ES modules in `src`, CommonJS in `functions`, PascalCase React component files, `firebase<Entity>.js` service modules, and `*.test.js(x)` / `*.node-test.js` tests.
- Keep Firestore access in service modules and keep calculation-heavy domain logic in pure utilities with focused tests. Reuse layout components and permission hooks instead of duplicating them in pages.
- Persist date-only hotel business dates as `YYYY-MM-DD`; do not parse them through an implicit browser timezone when calendar-day semantics matter. Use `serverTimestamp()` for Firestore audit timestamps where the surrounding model does so.
- All new development for HotelSuite must be in English: interface copy, validation messages, comments, documentation, tests and pull request descriptions. This is the owner's explicit product decision. Use i18next in already-localized surfaces; preserve existing translations unless a translation change is requested. Conversations with the owner may remain in Dutch.

## Tenant isolation and authorization

- Operational hotel data belongs below `hotels/{hotelUid}/...`. Obtain the selected hotel from `HotelContext`; never hard-code a hotel ID or accept a route/payload hotel ID without checking that the authenticated user is assigned to it.
- UI hiding and `ProtectedRoute` are usability controls, not security boundaries. Every Firestore and Storage read/write must also be enforced by deployed Security Rules, and every callable/HTTP function must validate authentication, hotel membership and the required action permission server-side. Admin SDK code bypasses Security Rules, so these checks are mandatory in functions.
- Do not add global collection scans or cross-hotel indexes containing customer data unless access, retention and tenant filtering are explicitly designed. User-management queries and mutations must be scoped so a hotel administrator cannot view or modify users of another hotel.
- Permissions use `feature.action` keys with `read`, `create`, `update`, `delete` and the explicitly catalogued special actions. Add new permissions to `src/constants/permissionCatalog.js` and enforce the same permission at every backend boundary.

## Confirmed domain rules

- Login requires a verified email address. A Firebase second factor is additionally required only when the environment's `VITE_AUTH_REQUIRE_MFA` policy is `true`; keep that value aligned with the selected Firebase project's Authentication policy.
- Orders use `Created`, `Ordered`, `Received`, `Finalized` and `Canceled`; only `Created` orders may be edited or deleted, and moving to `Ordered` must use the confirm/send workflow.
- Contract cancellation dates are the end date minus the non-negative whole termination period in days; reminder days are unique non-negative whole days.
- Hotel stays use checkout-exclusive nights (`arrival <= stay date < departure`). Rooming-list reservations must fit the snapshotted room-type capacity for every occupied night.
- Group quotes use the statuses and reason codes exported by `src/services/firebaseQuotes.js`; changing analysis-affecting inputs makes a saved analysis stale. Keep calculation/model changes aligned with the as-built and hardening documents under `docs/`.

## Working agreement

Na iedere reguliere taak meld je maximaal drie concrete aanvullende verbeterkansen die je tijdens het werk hebt gevonden. Vermeld per suggestie de locatie, het probleem, de impact en een voorgestelde oplossing. Geef alleen onderbouwde suggesties; minder dan drie of geen suggesties is prima. Voer verbeteringen buiten de gevraagde opdracht niet automatisch uit. Deze limiet geldt voor aanvullende suggesties na reguliere taken, niet voor een expliciet aangevraagde audit.
