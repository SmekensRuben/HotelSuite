# Procurement usability and operational loading

Base: current main `598043b62cf1ac521e1895c5c8e7fef08b6c606c`.
Branch: `codex/procurement-usability-20261012`. No merge or production mutation is authorized by this implementation.

## Findings and acceptance

| Item | Confirmed problem / decision | Implementation and acceptance evidence | Code | Local verification | Production |
| --- | --- | --- | --- | --- | --- |
| PU-01 Resource lifecycle | Client deletion could orphan location templates and historic references; there was no protected archival workflow. | Revisioned, idempotent archive commands with `locations.delete` / `outlets.delete`, current membership/subscription/gate checks and immutable receipts. Archived resources cannot be newly used or reactivated through browser writes/imports. Existing frozen counts and reversals remain usable. `procurementResources.node-test.js`, ordinary-user emulator tests. | Complete | Backend, Rules and restore passed | Not run |
| PU-02 Template labels | Optional product source failure discarded names and exposed IDs as labels. | Bounded same-hotel template projection gives human labels and canonical units without granting general product-directory access. Eligibility is checked separately; unavailable rows stay visible. No eager supplier-directory download for catalog templates. `ProcurementSettingsWorkflow.test.jsx`, backend projection regressions. | Complete | Full frontend/backend checks passed | Not run |
| PU-03 Pagination | Helpers requested 200/250 rows, while callable search accepts at most 100. | Normalize to the real 100-row contract; follow bounded pages and validate stable cursors. Explicit Load more handles pages with no eligible tracked product. No silently incomplete option list. Product read/export and stock workflow regressions. | Complete | Full frontend/backend checks passed | Not run |
| PU-04 Audit names | Actor lookup failures fell back to Firebase UIDs; repeated lookups made separate calls. | Batch name-only same-hotel projections, with a completed private same-hotel seed receipt proving the demo operator. Preserve UIDs in stored audit evidence; missing names display an explicit unknown label. No global user scan or invented hotel assignment. Staff projection/client/hook tests. | Complete | Full frontend/backend checks passed | Not run |
| PU-05 Units | Supplier package-content units were presented like catalog stock-count units. Existing l/ml conversion is correct. | Separate the two labels and show exact compatible conversion. Orange juice: 6,000 ml → 6 l; gross €15.90 at 6% VAT → net €15 → €2.50/l. Counts use catalog units; receipts and historic order displays use frozen policy-v1 terms. Unknown/incompatible/untracked links remain explicit. Independent backend and display regressions. | Complete | Full frontend/backend checks passed | Not run |
| PU-06 Layout | Desktop sidebar CSS forced full workspace width even when pages requested a maximum width. | `ProcurementPage` keeps sidebar reservation outside a centered inner content column. Lists use a 1,152px workspace; forms/details use 768px. Catalog Settings uses grouped panels. Actual JSX/CSS passed 42 desktop/mobile renders and five long-name stress cases; tables scroll inside their containers. | Complete | Component and visual checks passed | Not run |
| PU-07 Choices | Long native selects were difficult to search; the old combobox silently selected a result on blur. | Searchable, keyboard-accessible comboboxes for long entity choices; explicit choice/clear, required-selection validation, loading/empty states and bounded visible matches. Portalled menus remain visible outside table clipping and reanchor on scroll. Small fixed unit/status choices stay native. `combobox.test.jsx`, page workflows; actual mouse choice, focused-input reopening and long-name keyboard choice passed at 1920px and 390px. | Complete | Component and browser controls passed | Not run |
| PU-08 Loading | Whole directories loaded eagerly, supplier unfiltered pages used callable search, canonical search hydration used individual reads, and actor lookups were repeated. | Lazy optional sources, direct authorized unfiltered supplier reads, batched canonical hydration and actor projection, concurrent read pooling without a settled operational cache. Scope fences invalidate on auth/hotel/access/expiry/mutation changes; touched reads reject offline SDK cache fallback. Service/context regressions. | Complete | Full frontend/backend checks passed | Latency unmeasured |

## Dependencies and review

- Backend lifecycle and Firestore Rules must be released together under `saas-platform-v5`.
- Template labels depend on the scoped projection; optional product search has its own independent loading/error state.
- Name projection remains optional and never blocks operational records.
- In-flight pooling relies on HotelContext access invalidation; successful mutations also invalidate the affected hotel.
- Page families have separate owners. Backend, services, settings, product/supplier and transaction changes received independent review before full integration.
- Independent review found two actionable issues: template availability was based on labels rather than count eligibility, and cursor identity serialized snapshots. Both were resolved with targeted regressions. No remaining P1/P2 finding was reported in that review.

## Release and remaining checks

1. Review the complete PR and green checks; merge only by the owner. Main activates Functions and App Hosting delivery.
2. Wait for main CI, actual Functions deployment and App Hosting to match the new reviewed main SHA.
3. Download the pinned `scripts/firebase/rollout-saas-pilot.sh` from that SHA and run the existing coordinated `--apply` rollout. The same four inventory indexes are reused; this is one global Rules/gate rollout, not a per-hotel procedure.
4. Verify the marker is enabled with `rulesVersion: saas-platform-v5` and the exact release SHA. Do not manually bypass a failed rollout.
5. As an ordinary hotel user, verify permission-scoped archive controls, template labels without general catalog access, order/receiving destinations and finished counts. Verify cross-hotel access denial and historical read/reversal workflows.
6. In the deployed browser, measure first-load and repeat-load network timing separately. Local request-count reduction is evidence of reduced work, not a measured production latency claim. Test keyboard selection, very long labels, mobile tables and expired/revoked access.

No recipes, POS integration, perpetual inventory, historical revaluation, canonical-unit migration or paid warm-instance configuration is introduced.

## Resume point

Implementation and local verification are complete:

- Node 22.23.3 / npm 10.9.9: 982 frontend tests (112 files), 261 backend tests, 184 ordinary-user/cross-hotel Security Rules tests, lint, incremental types, dependency policy, Vite test build and non-production App Hosting build passed.
- The two-hotel Firestore/Auth/Storage export-and-restore smoke test passed, including canonical counts/receipts and immutable report replay.
- Browser rendering exercised 21 real procurement page components at 1920×1080 and 390×844 with synthetic service data: 42 renders, five long-name stress cases and mouse/keyboard/scroll combobox controls passed. This does not replace deployed authenticated workflows.
- Independent final review found no remaining P1/P2 concern. All three new callable exports were checked against automatic full Functions deployment discovery.
- Local emulator runs unset the workstation's proxy variables for loopback traffic. The Firebase CLI's explicit proxy agent otherwise turned Storage-to-Firestore emulator requests into missing records; no Storage authorization rule was relaxed.

Publish reviewable commits and the PR, then verify exact-head GitHub CI. Production deployment, global v5 Rules rollout, authenticated browser checks and latency measurements remain pending and owner-operated.
