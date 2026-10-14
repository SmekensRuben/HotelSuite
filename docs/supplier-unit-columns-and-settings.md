# Supplier purchase-unit columns and mapping settings

Baseline: current main `0e8495ef9f3edd47d103abf6b988de08e6c4394f` (PR #243 merged), 14 October 2026. Branch: `codex/supplier-unit-column-settings-20261014`. English product/code/docs; Dutch owner discussion. No production mutation, secret read, paid provider call, merge or deployment.

## Confirmed problems and changes

The supplied 50-row Excel export has separate `Eenheid verpakking` and `Eenheid` columns. The first holds purchase-package codes; the second holds physical inner-content units. The previous purchase-column selector recognized only the bare `Eenheid`, so it could apply a rule for GR/KG/LT to the package instead of the actual BK/EM/PK code. Mapping management was available only inside an import review.

Explicit package-unit headers now take precedence over bare `Eenheid`. A blank or conflicting explicit package column remains unavailable; it cannot fall back to a physical column or provider guess. The corrected source label is preserved alongside original provider fields and verified source anchors. An explicitly unavailable source also stays unavailable in review indexing and mapping application, preventing a later fallback through `originalInput`.

The split layout `Inhoud verpakking`, `Eenheid verpakking`, `Inhoud`, `Eenheid` identifies the number of inner packages and their individual physical content. The full content is their product: 12 PK × 1 LT is 12 l; 2 ZK × 5 KG is 10 kg. CL content is converted to ml with its factor of 10. Missing/duplicate/conflicting quantities remain unavailable. A KG purchase unit with ST content cannot establish a mass-to-item conversion; neither a saved package-label mapping nor a product-name guess overrides this restriction. Provider instructions describe the same column contracts, while server validation remains authoritative. Historical spend and annual purchase volumes never become current unit prices.

Open **Purchasing & Inventory Settings → Supplier import mappings**. Select a supplier and file format to view its saved profile, add confirmed mappings, use a suggestion only after an explicit save, or edit an existing rule. Suppliers use the existing searchable combobox. File formats remain separate; the UI uses the same default profile as the upload dialog. Review pages link directly to the relevant supplier and format. No import job or product write is needed to manage rules.

Viewing the section requires both `suppliers.read` and `supplierproducts.read`. Saving requires `supplierproducts.create`; replacing an existing rule additionally requires `supplierproducts.update`, matching the existing protected callable. Both UI and server authority remain enforced. Hotel/actor/permission/format changes discard obsolete responses and unsaved fields. Unknown save acknowledgments retain the original operation and revision for replay.

Rules remain hotel/supplier/format/profile-scoped and versioned. Future uploads freeze the selected snapshot. Existing reviews, committed offers and historical receipts are not silently recalculated or relabelled. After deployment, start a new import of a file whose old draft used the incorrect column, or correct that draft explicitly product by product. Do not approve the old physical-unit grouping as if it were the package source.

| Item | Code | Local verification | Deployed verification |
| --- | --- | --- | --- |
| Explicit package-column precedence and unknown-source fences | Complete | CSV/XLSX regressions and real-file replay passed | Pending |
| Full package content and physical-unit separation | Complete | Real-file replay: 44 verified contents; 6 unavailable weight/item conversions | Pending |
| Standalone supplier/format mapping management | Complete | Component, navigation, authority and recovery regressions passed | Pending |
| Final checks and publication | Complete | Frontend/backend, lint, types, dependency policy, real emulators, restore, browser QA and builds passed; exact-head CI required before ready | Pending |

## Evidence and remaining checks

- Actual supplied workbook through the real bounded extractor and normalizer: **50/50** correct package-column selections, **44** independently checked full physical contents, **6** explicitly unavailable weight/item conversions, **0** invented prices, provider calls or writes. Provider proposals deliberately used the wrong physical column to reproduce the reported error. Original bytes were not changed and no customer workbook or identifiers were committed.
- Full frontend: **1,459/1,459** passed across 155 files. Subsequent final settings/navigation/review regression set: **60/60** passed, including an additional create-only acknowledgment recovery test. Final exact-head CI covers the complete final suite.
- Full Functions: **569/569** passed. Subsequent final provider/public-message checks: **101/101** passed. Regressions cover blank/conflicting headers, simple legacy Eenheid exports, CSV/XLSX parsing, package multiplication, price-channel separation and unavailable review-index sources.
- Full lint, incremental boundary types and dependency policy passed (zero production vulnerabilities). The PR records final fixture builds, real Firebase security/restore tests, responsive browser QA and exact-head full CI.
- Real Firebase Auth/Firestore/Storage supplier security tests: **21/21** passed. Two-hotel backup/restore passed, retaining original mapping/approval/source/result/financial/inventory evidence and exact command replay with zero provider calls. Test and App Hosting fixture builds passed.
- Browser QA at **1440px and 390px** used the actual application/settings/panel/client services with synthetic authentication and transport boundaries. It verified supplier/format scoping, explicit suggestion confirmation, saved-rule editing, reload recovery and unsaved-field reset, with zero product writes, external requests, JavaScript errors or page overflow. Screenshots were inspected. This is UI/protocol evidence; production and paid extraction were not invoked.

Resume point: publish two coherent commits and a reviewable PR, then verify the complete exact-head CI before marking ready. The PR records the final head and CI run. No Rules/index/permission-catalog files changed and no additional per-hotel Cloud Shell setup is introduced. Release acceptance requires successful frontend and Functions deployment, then a normal hotel user managing/reusing a mapping in settings and reviewing a fresh import of the actual workbook. Live provider extraction accuracy and deployed behavior remain unverified until that release check.
