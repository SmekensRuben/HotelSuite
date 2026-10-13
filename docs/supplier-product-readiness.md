# Supplier product readiness and managed images

Base: main `4c2242af78fff3519ca2230dbc7ca0e5bfcac882` (PR #237 merged).
Branch: `codex/supplier-product-readiness-20261013`.

| Finding | Evidence and acceptance | Code | Local | Deployed |
|---|---|---|---|---|
| Hotel creation still expects an IANA string and has no currency choice | `HotelOnboardingPage` now reuses readable/searchable property choices; actual creation stores matching root/bootstrap currency and canonical time zone; legacy clients retain their established EUR policy | Resolved | Verified | Not run |
| Supplier export has two close controls | Supplier list no longer inserts an extra X inside the shared Modal; regression counts exactly one close button | Resolved | Verified | Not run |
| Export/import silently guesses values or omits invalid rows | Dedicated workbook contract preserves zero, unknowns, GTIN text, stable IDs/options, price basis/validity and provenance; invalid or duplicate rows fail explicitly with row numbers | Resolved | Verified | Not run |
| Purchase packages have no barcode metadata | Optional default and per-option GS1 check-digit-validated GTINs; leading zeroes preserved, absent legacy metadata retained by stable option ID, explicit blank clears | Resolved | Verified | Not run |
| External image URL is the only visible image workflow | Saved product details allow protected uploads/replacements, private 160px/800px WebP generation, progress and uncertain-response retry; list loads thumbnails near the viewport | Resolved | Verified | Not run |
| Product saves can erase independently managed media | Backend edits/imports preserve server-owned image/imageRevision, while client commands remove these fields and raw mutation/import forgery is rejected | Resolved | Verified | Not run |
| Supplier import may continue after a session change | Actual Auth/access scope checked around directory/product reads, batch requests and acknowledgements; further batches stop and original uncertain commands remain recoverable | Resolved | Verified | Not run |
| New retry-enabled image trigger would block noninteractive deployment | Deployment helper validates source/deployed exact trigger/region/bucket before scoped activation; full Functions deployment remains unforced | Resolved | Verified | Not run |
| Processing/refresh failures could be misleading or race | Independent review corrected foreign lease invalidation, pre-lease full decode and upload/refresh conflation; bounded decode, explicit failed status, generation fences and separate verified-upload outcome are tested | Resolved | Verified | Not run |

## Model ownership and future modules

| Concern | Owner and current contract | Further work belongs with |
|---|---|---|
| Physical ingredient identity | Catalog product ID, canonical each/g/kg/ml/l unit, brand/description, allergens, storage and notes | Recipe definitions; no supplier-specific ingredient duplication |
| Purchase offer | Supplier ID + stable product ID + supplier SKU; a linked catalog ID; independently identified packages/content quantities | Supplier adapter mappings and provider-specific identifiers |
| Package scanning | Optional GTIN per default/additional package, separate from the physical catalog barcode | Barcode-selection workflows; a valid checksum does not prove GS1 ownership or matching |
| Price and valuation | Currency, net/gross/unknown basis, VAT, explicit unknown prices, source contract dates and price history | Explicit freight/deposit/rebate/order-minimum workflows, rather than fields with no behavior |
| Inventory conversion | Exact compatible-dimensional unit conversion, stable option identity, frozen downstream order/receipt/count terms | Versioned recipe yields, waste and consumption events |
| POS | No POS mapping is claimed by this change | Provider/item-to-dish mapping; versioned recipes and idempotent sales/void/refund consumption evidence |
| Live quantities | Current counts/checkpoints/movements are periodic evidence | A separate reconciled on-hand ledger; this release does not invent a live balance |

Package GTIN is metadata, not a price-content change. It does not rewrite price history or historical orders and is not newly included in supplier dispatch snapshots. Existing supplier/catalog/base-unit identity protection, unknown cost behavior and price contracts are retained.

## Images

Prefer a managed upload for hotel-owned images. An optional supplier-hosted HTTPS URL remains a compatibility fallback and can change independently of HotelSuite. New uploads use the saved product detail page and require `supplierproducts.update`; creating a product does not depend on successfully uploading a file. Supplier offer creation alone grants no media-update right.

The HTTP endpoint `supplierProductImage` uses current verified bearer authentication and canonical hotel/module/action checks. Original and derived objects live in the default-denied `private/supplier-product-images/{hotelUid}/{productId}/{assetId}` namespace. Browser writes, browser reads, anonymous metadata access and token download URLs are not used. GET verifies the currently selected asset, exact own-hotel path, generation, size and MIME, and rechecks authority after Storage I/O. Browser object URLs are temporary and revoked; no bearer credentials enter URLs or persistent browser storage.

Upload is limited to 5 MiB, static JPEG/PNG/WebP and 16 megapixels. Sharp 0.35.5 performs actual raster decode, rotation, metadata removal and WebP rendering inside an acquired processing lease. Thumbnail maximum is 160px, detail maximum is 800px; small images are not enlarged and each derivative is bounded to 1 MiB. Source/derivative generations are pinned. Image revision is separate from product business/price revision.

`processSupplierProductImage` runs on finalized **Storage source objects**, not on every Firestore product write. Successful normal uploads also process inline. The trigger handles recovery, uses authorized upload reservations, ignores derivatives/unknown sources and cannot publish superseded images. A lease prevents concurrent decoding; at most three processing attempts occur per asset, with explicit pending/failed outcomes. Permission, subscription or rollout loss stops publication. It never fetches arbitrary external URLs.

A future import/connector must use the same protected upload contract when it supplies image files. A bare Firestore create/update or an external image URL does not implicitly download remote files or fabricate an upload reservation. Workbook image columns are read-only provenance, not a media migration format. Images are backed up with the private Storage objects and metadata, alongside Firestore asset/operation evidence. Original and superseded files are retained; no automatic production deletion or unreviewed retention policy is introduced.

## Verification

- Frontend: 138 files / 1,242 tests passed. Final media/form presentation refinements: 36 focused tests passed; final legacy-ID and preview controls separately passed 14 media client tests.
- Functions: 379 tests passed, including genuine raster rendering, processing races/limits, package GTIN policy and preservation/forgery checks.
- Auth/Firestore/Storage security emulators: 228 tests passed; the final image-only run passed 11 cases including dotted/spaced legacy IDs. Image tests use real source files, current ordinary hotel users, an actual signed Auth-emulator token at the HTTP handler, private objects and cross-hotel/browser denials.
- Two-hotel export/restore passed with exact source/thumbnail/display bytes, hashes and object generations, authorized private image reads, and intact financial/inventory/command evidence.
- Lint, incremental type checking and dependency policy passed. Sharp's initial vulnerable candidate was upgraded before acceptance; current audits report zero runtime vulnerabilities. Test/App Hosting builds use fictional `demo-hotel-suite-a00` configuration, without production writes. Existing large-bundle advisories remain.
- Independent domain, frontend, processing, security and deployment reviews were performed by specialized agents. All blocking findings were addressed.
- Real changed React components/CSS with local synthetic services passed browser checks at 1,440 and 390 pixels: single export close control, grouped product form, managed image preview/upload, no document overflow and no page exceptions. The local emulators separately prove actual persistence/permissions. Exact-head GitHub CI is recorded in the pull request when completed.

## CI timing regression

The first published CI run exposed an existing stock-count interaction race: an initial click to add a catalog product could occur after DOM commit but before a passive hydration effect reset the editor. A deterministic ancestor-layout interaction reproduces the original closed-panel failure, checks loaded quantity/cost and exercises the original catalog pagination/add flow. Hydration now finishes in a layout effect before first interaction; the cyclic-cursor assertions are unchanged. This is a lifecycle fix, not a relaxed timeout or altered expected output.

## Release controls and remaining work

No merge, deployment, customer data mutation, Rules edit or SaaS release-version change was performed. The automatic release explicitly activates retries only for the reviewed new image trigger, with the full deployment unforced. No per-hotel Cloud Shell activation or bucket-CORS change is needed for this private HTTP design. Confirm both Functions and App Hosting deployment for the merged release before production smoke checks.

Production checks: create a disposable property via the named timezone/currency choices; export/import a reviewed supplier workbook including package GTIN/unknown price cases; upload/replace an image as a normal permitted hotel manager; verify private thumbnail display on list/detail and denial for another hotel/reader-only upload; inspect Functions logs for bounded recovery/failure outcomes. Existing product identities, orders, counts and price history must remain unchanged by media work.

A production GCS recovery that allocates new object generations cannot simply reuse restored generation pins. The new smoke check fails rather than silently rewriting them. Document and rehearse an operator-reviewed recovery before relying on such a backup path. Media retention/cleanup and operational monitoring require an explicit retention policy before adding automated deletion. Recipe, POS and supplier-provider adapters remain distinct later modules.
