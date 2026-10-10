# Hotel Toolkit hospitality redesign

Base: main `eb6e6d8ba5aaf06c40f86e840e26026a42983308`, 2026-10-11.
Branch: `codex/hospitality-design-system-20261011`.

## Scope and acceptance

The approved direction combines warm ivory, forest green and restrained brass
with a legible product-first presentation. It covers the public landing and
login, hotel operations, settings, platform administration, access/error states
and token-based rooming lists. Monetary prices discussed during design are not
approved prices. This change does not introduce billing or self-service signup.

| Part | Code | Local verification | Production |
| --- | --- | --- | --- |
| Tokens, brand and shared components | Complete | Passed | Not deployed |
| Hotel/platform navigation and mobile drawer | Complete | Passed | Not deployed |
| Landing, login and public/access states | Complete | Passed; live MFA pending | Not deployed |
| Presentation across all page families | Complete | Static inventory plus representative browser checks passed | Not deployed |
| Permission-aware dashboard shortcuts | Complete | Component and limited-user browser checks passed | Not deployed |
| Review and repository checks | Complete | Passed; exact-head CI recorded in PR | Not deployed |

No merge, production deployment or Firebase Rules release is part of this task.

## Design contract

- `tailwind.config.js` owns forest, brass and warm neutral palettes. Semantic red,
  amber, success and informational colors retain their meaning. The muted text
  color meets AA contrast on the ivory canvas in the checked surfaces.
- `src/index.css` owns reusable `ht-*` components, focus treatment, responsive
  page widths, print layout and reduced-motion treatment. Serif headings use
  local fonts; operational text uses a system sans stack. No remote font request
  or new dependency is required.
- `Brand` and `public/favicon.svg` share the original geometric mark.
- `WorkspaceChrome` owns desktop navigation and a Headless UI mobile dialog.
  `HeaderBar` assembles hotel links using existing action-permission checks;
  `PlatformLayout` assembles platform links under the existing platform guard.
- Keep the hotel selector accessible on mobile. Keep action rows wrap-capable,
  grid children shrinkable and file controls bounded. Wide operational tables
  scroll within their own container rather than widening the entire page.
- `PageContainer` provides the content landmark and desktop-sidebar offset.
  Nested platform consumers use `as="div"`; the platform layout owns the main
  landmark. Additional order recovery content has its own section ID.
- Shared `Modal` uses a focus-contained dialog with a title, Close control,
  Escape/outside dismissal and focus restoration through Headless UI. Existing
  busy-state dismissal guards still belong to callers. Order refresh errors
  remain visible inside the dispatch dialog while the background is inert.
- Use forest for primary actions, neutral for secondary/off states and red for
  destructive actions or failures. Do not recolor a failure to match branding.
- New copy is English. Existing localized copy and saved language choices remain
  available; new browsers default to English.

## Page-family inventory

The source inventory contains 85 `*Page.jsx` components in
`src/components/pages` and seven in `src/components/platform`. Their shared
shells, fields, tables, panels and page-specific brand utilities were inspected
and migrated. Reusable forms and analysis components are included as well.

| Family | Included surfaces | Presentation boundary |
| --- | --- | --- |
| Public | Landing, product preview, login/email verification/MFA, rooming lists | Brand, public layout, panels, form controls and dialogs |
| Workspace | Dashboard, no-hotel access, subscription access and error state | Permission-aware shortcuts, PageShell and shared states |
| Purchasing & Inventory | Catalog/supplier products, suppliers, orders/cart, stock counts and their create/edit/detail forms | HeaderBar, PageContainer, cards, tables and action rows |
| Contract Management | Contract list, create/edit/detail, reminders and settings | Shared shell, records, fields and semantic destructive states |
| Front Office & Upselling | Arrivals, made reservations, upsell overview/audits/detail/settings | Shared shell, dense tables, filters and action controls |
| Groups & Events | Groups, room blocks, rooming lists and change-request review | Shared shell, forest summary panels and capacity tables |
| Revenue & Forecasting | Quotes, contribution/LOS analysis, demand calendar and commercial intelligence | Shared shell, decision cards and preserved warning states |
| Administration | Property/team/users/subscriptions; catalog, outlets, locations, imports, Opera and notification settings | Shared shell, role forms and configuration tables |
| Platform console | Overview, hotels/onboarding/detail, subscriptions, imports, incidents, audit activity and users | WorkspaceChrome, PlatformLayout and PlatformShared |

## Landing content and demo contact

Marketing module IDs and labels follow the existing module catalog.
`marketingModules.js` contains presentation copy only; it grants no entitlement.
`ProductPreview` uses fictional, local records, explicitly labels them **Demo data**, and never reads hotel data or executes a quote calculation.

The pricing section explains modular subscriptions per hotel and setup scope.
It deliberately contains no provisional monetary price or payment promise.
Existing subscription seat limits, plans and billing behavior are unchanged.

Configure one optional **public** build variable to connect demo/proposal CTAs:

- `VITE_PUBLIC_DEMO_URL`: an HTTPS booking/contact URL without URL credentials.
- `VITE_PUBLIC_CONTACT_EMAIL`: a valid email address, used to compose a message.

A valid URL takes precedence over email. With no usable value, the page links
visitors to the interactive preview and setup explanation. There is no invented
sales address or broken contact action. Email configuration rejects header and
percent-encoded injection. Neither setting is a secret; both are browser-visible.

## Verification evidence

Local checks ran with Node 22.23.3/npm 10.9.9. Security and recovery checks used
Java 21 and the fictional Firebase emulator project `demo-hotel-suite-a00`.
No production record or credential was used for visual review.

| Check | Result |
| --- | --- |
| Frontend Vitest | 82 files, 715 tests passed |
| Functions tests | 159 tests passed |
| Firestore/Storage authorization and normal-user workflows | 126 tests passed |
| Two-hotel Auth/Firestore/Storage restore smoke | Passed |
| Domain-settings migration safeguards | 10 tests passed |
| Correctness lint and incremental boundary typecheck | Passed |
| Deployment-script syntax, generated Rules and locked operator imports | Passed |
| Dependency policy | Zero findings in root, Functions and operator runtime |
| `npm run build:test` | Passed with fictional client configuration |
| `npm run apphosting:build` | Passed with the CI App Hosting fixture |
| Git whitespace check | Passed |

Builds still report large-chunk warnings. This redesign does not replace the
existing route-loading/bundling architecture.

New component/configuration regressions cover mobile navigation dismissal and
route change, active destinations, dashboard access combinations, isolated
preview switching and validated public contact configuration. Existing quote
numerical assertions and order workflow tests remain intact; the former red
quote-border assertion now expects the forest presentation class.

A Chromium 153 review rendered 26 representative surfaces at 1440×1000 and
390×844: 52 renders without page errors or page-level horizontal overflow.
This includes landing/login/dashboard, catalog list/product editor, orders and
order detail, contracts, groups/calendar, the actual quote-analysis component,
front-office reservations/upsells, stock counts, property/team/import settings,
platform overview/hotel/detail/imports/incidents/users/subscriptions/onboarding,
and the public rooming list. Six core surfaces were also checked at 320px and
768px. The extra quote route existed only in the temporary review harness.

Browser interactions verified preview switching, mobile focus containment,
Escape and focus restoration, desktop-resize dismissal, closure after a route change, the
mobile hotel selector, an orders-only user's menu, table sorting and opening/
dismissing the dispatch dialog without sending an order. Axe WCAG A/AA checks
reported zero violations on ten representative surfaces after contrast and
label fixes. These checks are evidence for that scope, not a claim of complete
WCAG certification.

The temporary browser harness loaded the actual routes/components/styles with
fictional service/auth/context fixtures, blocked external requests and was
kept outside the repository. It is not a production auth bypass. Component,
Functions and emulator tests supply separate permission/workflow evidence.
Visual review does not prove a real Firebase MFA or production import run.

A source/AST review confirmed that operational page changes are presentation
changes, apart from the documented content landmarks and visibility of refresh
errors in the modal. Login state, effect and callback declarations are unchanged.
There are no changes to domain utilities, Firestore services, hotel/auth context,
route guards, Firebase Rules, Functions, saved analysis snapshots or dependencies.

## Remaining release checks and resume point

1. Review the PR diff and its Verify HotelSuite result for the exact proposed
   head. The branch is based on the checked main commit above. No deployment
   action is required merely to inspect the proposed design.
2. Choose the public demo/proposal contact when ready. It is optional for the
   landing page to function; no commercial price has been approved by this work.
3. After a separately authorized merge/deploy, verify actual Hosting assets,
   metadata/favicon, login/email verification and the configured SMS/TOTP MFA
   policy on the real domain. Check a normal hotel account and a platform-only
   account, hotel switching, long hotel names, and module/action visibility.
4. Smoke-test live read/write workflows, uploads/exports, order confirmation,
   import monitoring, quote warning states and a revocable rooming-list token.
   Run these with approved test records and verify normal-user access. Check
   Safari/iOS and another browser in addition to local Chromium.
5. Mark **deployed checked** only after that live verification. Local fixtures
   and green CI do not establish production deployment success.

If interrupted, resume from this design branch, verify the associated PR head
and CI, then execute only the outstanding release checks above. Preserve the
approved pricing policy, tenant separation and regression assertions.
