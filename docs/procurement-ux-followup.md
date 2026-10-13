# Procurement usability follow-up

Base: `f36b6ea006cef5298320b496e02b735c772cef6b` (main after PR #234).
Branch: `codex/procurement-orders-settings-20261013`.

## Confirmed findings and acceptance

| Finding | Evidence on the base | Acceptance | Code | Local verification | Deployed verification |
| --- | --- | --- | --- | --- | --- |
| First Add click can silently do nothing | `OrderCreatePage` loads products separately while cart readiness waits for an optional supplier directory request; the Add handler returns if no cart ID exists. | Explicit cart preparation/retry; Add enabled only when its cart is ready; the first enabled click performs one add, even when supplier enrichment is delayed. | Complete | Passed | Not run |
| Outlet selection disappears while saving | `ShoppingCartPage` keeps only the old confirmed outlet and reloads the entire table after a mutation. | Show the selected outlet immediately as pending; keep the row visible, prevent concurrent revisions, and distinguish saving/readback failure from confirmed state. Exact saved-request recovery remains available. | Complete | Passed | Not run |
| Cart summary is large and repetitive | Each currency/basis total repeats a full sentence in a large card. | Compact aligned totals with separate currencies and gross/net/unknown price bases; unavailable pricing remains visible and cannot become a fabricated total. | Complete | Passed | Not run |
| Movement source label is technical | `InventoryMovementsPage` hides its form behind “Load movement sources”. | Automatically load bounded, permission-scoped article/location choices; show understandable loading/retry controls. | Complete | Passed | Not run |
| Movement cost has no explanation | Name/base-unit choice projections contain no stock valuation. A catalog identity can have multiple purchase prices. | Clearly mark the manual net estimate optional and explain why it is not auto-filled. Article changes preserve unknown cost as null; no arbitrary supplier price or zero is inferred. | Complete | Passed | Not run |
| Three separate settings pages fragment the module | Separate catalog/outlet/location navigation and full-page shells. | One Purchasing & Inventory settings page with permitted categories, outlets and locations sections; only the active permitted section loads. Keep create/edit/detail/template URLs and each action's existing rights. | Complete | Passed | Not run |

## Boundaries

Retain SaaS Rules v5, immutable movement evidence, unknown costs, historical price/report snapshots, cart revisions and saved request identity. Do not grant module-wide settings access or change backend authorization. No new Rules activation, index or per-hotel migration is intended. Do not merge, deploy or mutate production data during this task.

## Completed verification

- Node 22.23.3 / npm 10.9.9: **1,108 frontend tests in 126 files passed**, including 43 new regressions. The final full run limited worker concurrency to two; tests and assertions were not weakened.
- Full JavaScript lint, incremental boundary types, Vite test build and App Hosting build using the explicit non-production demo fixture passed.
- Independent source and regression review found no unresolved P1/P2 issues. No backend functions, Security Rules or subscription/access policy were modified; the PR CI additionally checks the existing backend, emulator security and export/restore suites.
- Actual JSX/CSS Playwright checks at 1920×1080 and 390×844 passed delayed cart preparation, first enabled Add, pending outlet save/readback, separated totals, automatic movement choices with unknown costs, single settings header, active-only loading and denied deep links. No page errors, body overflow or nonlocal HTTP requests occurred. Services/Auth were synthetic; this is not a production latency or backend authorization measurement.
- Four coherent commits separate movement copy, module settings, cart behavior and this evidence record. The pull request description records exact-head GitHub CI status.

## Remaining production controls

No merge, deployment or production data mutation was performed. After owner merge and successful deployment, verify ordinary hotel-user add/outlet/save recovery, module settings rights/deep links and physical movements. Confirm actual production loading times separately. Existing v5 activation remains required if it was never completed; this change does not introduce another activation or a per-hotel script.

Manual movement costs deliberately remain explicit estimates. Automatic stock-cost proposals require a separate valuation policy and trustworthy stock evidence; a catalog article's identity does not provide a unique purchase or stock cost.
