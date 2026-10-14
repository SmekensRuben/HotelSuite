import React, { useCallback, useEffect, useRef, useState } from "react";
import { Combobox } from "../ui/combobox";
import { usePermission } from "../../hooks/usePermission";
import { useScopedAsync } from "../../hooks/useScopedAsync";
import { getCatalogProducts } from "../../services/firebaseProducts";
import { saveSupplierAiImportReview, supplierAiImportVatFraction } from "../../services/firebaseSupplierAiImports";
import { currencyChoices } from "../../utils/propertySettingChoices";
import { PRODUCT_BASE_UNITS } from "../../utils/productPurchaseOptions";
import { productUnitLabel, previewCatalogPackageQuantity } from "../../utils/productUnitDisplay";
import { PURCHASE_UNITS } from "../../utils/supplierImportWorkspace";

const labels = {
  supplierSku: "Supplier SKU", supplierProductName: "Product name", purchaseUnit: "Purchase unit",
  baseUnitsPerPurchaseUnit: "Package content", baseUnit: "Content unit", pricePerPurchaseUnit: "Package price",
  pricePerBaseUnit: "Base-unit price", currency: "Currency", pricingModel: "Pricing model", priceBasis: "Price basis",
  vatRate: "VAT rate", gtin: "Package GTIN", catalogProductId: "Catalog product", active: "Active offer",
  priceValidFrom: "Price valid from", priceValidUntil: "Price valid until", purchaseOptions: "Additional purchase packages",
  sourceAnchors: "Source evidence", packInference: "Package contents",
};
const publicFields = Object.keys(labels).filter((field) => !["sourceAnchors", "packInference"].includes(field));
const priceKnown = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const display = (value, field) => {
  if (value === null || value === undefined || value === "") return "Unknown";
  if (field === "vatRate" && typeof value === "number") return `${Number((value * 100).toFixed(4))}%`;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.length ? `${value.length} purchase package${value.length === 1 ? "" : "s"}` : "None";
  return typeof value === "object" ? "See package details" : String(value);
};
const rowKey = (hotelUid, jobId, row) => JSON.stringify([hotelUid, jobId, row.rowId, row.reviewRevision]);
const inputClass = "mt-1 w-full min-w-0 rounded-lg border border-stone-300 bg-white px-3 py-2.5 text-sm disabled:bg-stone-50 disabled:text-stone-500";
const labelClass = "min-w-0 text-xs font-semibold text-stone-700";
const categoryLabel = { new: "New product", changed: "Proposed update", unchanged: "Unchanged product", blocked: "Needs attention" };

function inferredContents(product, inference) {
  if (!inference || !Number.isSafeInteger(inference.piecesPerPurchaseUnit) || inference.piecesPerPurchaseUnit < 1 || inference.piecesPerPurchaseUnit > 1000000 || typeof inference.pieceQuantity !== "number" || !Number.isFinite(inference.pieceQuantity) || inference.pieceQuantity <= 0) return null;
  // Bound decimal display arithmetic to the physical-unit contract; avoid a
  // floating-point rounding discrepancy or an unreviewed cross-dimension count.
  const [mantissa, exponent = "0"] = String(inference.pieceQuantity).toLowerCase().split("e");
  const [whole, fraction = ""] = mantissa.split(".");
  const places = fraction.length - Number(exponent), digits = BigInt(whole + fraction);
  let scaled;
  if (places <= 6) scaled = digits * (10n ** BigInt(6 - places));
  else {
    const divisor = 10n ** BigInt(places - 6);
    if (digits % divisor !== 0n) return null;
    scaled = digits / divisor;
  }
  const total = scaled * BigInt(inference.piecesPerPurchaseUnit);
  if (total <= 0n || total > 1000000000000n) return null;
  const converted = previewCatalogPackageQuantity(Number(total) / 1000000, inference.pieceUnit, product.baseUnit);
  if (converted === null || converted !== product.baseUnitsPerPurchaseUnit) return null;
  return `${inference.piecesPerPurchaseUnit} pieces × ${inference.pieceQuantity} ${inference.pieceUnit} = ${converted} ${product.baseUnit} per ${product.purchaseUnit || "purchase package"}.`;
}

/** One protected draft row. Decisions remain durable parent-managed commands. */
export default function SupplierImportProductReview({ hotelUid, jobId, row, position, total, locked = false,
  current = () => true, onCorrected, onApprove, onSkip, onLater, mappingPanel = null }) {
  const key = rowKey(hotelUid, jobId, row);
  const [draft, setDraft] = useState(row.product || {}), [dirty, setDirty] = useState(false);
  const [vatPercent, setVatPercent] = useState(row.product?.vatRate == null ? "" : String(Number((row.product.vatRate * 100).toFixed(4))));
  const [acknowledged, setAcknowledged] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(null);
  const [validatedRevision, setValidatedRevision] = useState(row.reviewRevision);
  const [catalogTerm, setCatalogTerm] = useState(""), [debouncedCatalogTerm, setDebouncedCatalogTerm] = useState("");
  const mounted = useRef(true), operation = useRef(false), latest = useRef(null);
  const canCreate = usePermission("supplierproducts", "create"), canUpdate = usePermission("supplierproducts", "update");
  const canReadCatalog = usePermission("catalogproducts", "read"), existing = Boolean(row.previousProduct);
  const authorized = existing ? canUpdate : canCreate;
  latest.current = { key, hotelUid, jobId, row, authorized, locked, current };
  const enabled = authorized && !locked && !busy && !row.committed && current();
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    setDraft(row.product || {}); setDirty(false); setAcknowledged(false); setError(null);
    setValidatedRevision(row.reviewRevision);
    setVatPercent(row.product?.vatRate == null ? "" : String(Number((row.product.vatRate * 100).toFixed(4))));
    setCatalogTerm(""); setDebouncedCatalogTerm("");
    // A row object may be recreated by status polling. Its revision is the
    // immutable edit boundary, so polling must not discard unsaved edits.
  }, [key]);
  useEffect(() => { const timer = setTimeout(() => setDebouncedCatalogTerm(catalogTerm), 250); return () => clearTimeout(timer); }, [catalogTerm]);
  const loadCatalog = useCallback(() => getCatalogProducts(hotelUid, { pageSize: 50, searchTerm: debouncedCatalogTerm }), [hotelUid, debouncedCatalogTerm]);
  const catalog = useScopedAsync({ scopeKey: `${hotelUid}:${jobId}:${row.rowId}:${debouncedCatalogTerm}`, enabled: Boolean(canReadCatalog && hotelUid && current()), initialData: null, load: loadCatalog });
  const catalogOptions = (catalog.data?.products || []).filter((product) => product.active !== false && product.archived !== true);
  const selectedCatalog = catalogOptions.find((product) => product.id === draft.catalogProductId) || (draft.catalogProductId ? { id: draft.catalogProductId, name: row.previousProduct?.catalogProductName || "Existing catalog link", baseUnit: row.previousProduct?.baseUnit || "" } : null);
  const currencies = currencyChoices();
  const issues = Array.isArray(row.issues) ? row.issues : [];
  const blocking = issues.filter((issue) => issue.severity === "error");
  const priceField = row.product?.pricingModel === "Per Base Unit" ? "pricePerBaseUnit" : "pricePerPurchaseUnit";
  const missingPrice = !priceKnown(row.product?.[priceField]);
  const failedAttempt = row.lastOutcome?.status === "blocked";
  const findings = (row.normalizationFindings || []).filter((finding) => finding.severity === "warning" || finding.severity === "error" || ["inference", "source-name", "approved-name-expansion"].includes(finding.provenance));
  const assumptions = findings.filter((finding) => finding.severity !== "error" && !["price-source-missing"].includes(finding.code));
  const warnings = issues.filter((issue) => issue.severity !== "error" && !(missingPrice && ["pricePerPurchaseUnit", "pricePerBaseUnit"].includes(issue.field) && /missing|unknown|unavailable/i.test(`${issue.code} ${issue.message}`)));
  const inference = inferredContents(row.product || {}, row.packInference);
  const needsAcknowledgment = missingPrice || warnings.length > 0 || assumptions.length > 0 || Boolean(row.packInference);
  const canApprove = enabled && !dirty && !failedAttempt && validatedRevision === row.reviewRevision && row.canApprove !== false && ["new", "changed", "unchanged"].includes(row.category) && !blocking.length && (!needsAcknowledgment || acknowledged);
  const differences = (row.changes || []).filter((change) => JSON.stringify(change.before) !== JSON.stringify(change.after));
  const change = (field, value) => { if (!enabled) return; setDirty(true); setAcknowledged(false); setDraft((prior) => ({ ...prior, [field]: value })); };
  const validOperation = (captured, sameRevision = true) => mounted.current && latest.current.hotelUid === captured.hotelUid && latest.current.jobId === captured.jobId && latest.current.row.rowId === captured.row.rowId && (!sameRevision || latest.current.key === captured.key) && latest.current.authorized && !latest.current.locked && latest.current.current();
  const begin = () => { if (operation.current || !enabled) return null; operation.current = true; setBusy(true); setError(null); return latest.current; };
  const finish = () => { operation.current = false; if (mounted.current) setBusy(false); };
  const save = async (later = false, revalidate = false) => {
    const captured = begin(); if (!captured) return;
    try {
      let updated = captured.row;
      if (dirty || revalidate) {
        const edited = { ...Object.fromEntries(publicFields.filter((field) => Object.hasOwn(draft, field)).map((field) => [field, draft[field]])), vatRate: vatPercent === "" ? null : supplierAiImportVatFraction(vatPercent) };
        // Untouched fields must not become human overrides: changing a name
        // cannot freeze a source package or dismiss an unrelated source error.
        const patch = Object.fromEntries(Object.entries(edited).filter(([field, value]) => JSON.stringify(value ?? null) !== JSON.stringify(captured.row.product?.[field] ?? null)));
        const result = Object.keys(patch).length || revalidate ? await saveSupplierAiImportReview(hotelUid, { jobId, rowId: row.rowId, expectedReviewRevision: row.reviewRevision, patch }) : { row: captured.row };
        if (!validOperation(captured)) return;
        updated = result.row;
        setValidatedRevision(updated.reviewRevision);
        await onCorrected?.(updated);
        if (!validOperation(captured, false)) return;
        setDraft(updated.product || {}); setDirty(false); setAcknowledged(false);
        setVatPercent(updated.product?.vatRate == null ? "" : String(Number((updated.product.vatRate * 100).toFixed(4))));
      }
      if (later && validOperation(captured, false)) await onLater?.(updated);
    } catch (failure) { if (validOperation(captured, false)) setError(failure); }
    finally { finish(); }
  };
  const decide = async (action) => {
    if (action === "approve" && !canApprove) return;
    const captured = begin(); if (!captured) return;
    try { await (action === "approve" ? onApprove : onSkip)?.(captured.row); }
    catch (failure) { if (validOperation(captured)) setError(failure); }
    finally { finish(); }
  };
  const numeric = (field, event) => change(field, event.target.value === "" ? null : Number(event.target.value));
  const options = Array.isArray(draft.purchaseOptions) ? draft.purchaseOptions : [];
  return <article className="mx-auto w-full min-w-0 max-w-4xl space-y-5 rounded-2xl border border-stone-200 bg-white p-4 [overflow-wrap:anywhere] sm:p-6" aria-label="Supplier product review">
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0"><p className="text-xs font-semibold uppercase tracking-wide text-stone-500">{categoryLabel[row.category] || "Product review"}{row.committed ? " · already imported" : ""}</p><h2 className="mt-1 text-xl font-semibold text-brand-950">{row.product?.supplierProductName || "Product name missing"}</h2><p className="mt-1 text-sm text-stone-500">Supplier SKU: {display(row.product?.supplierSku)}</p></div>
      {Number.isSafeInteger(position) && Number.isSafeInteger(total) && <p className="rounded-full bg-stone-100 px-3 py-1 text-xs text-stone-600">Product {position} of {total}</p>}
    </header>

    {existing && differences.length > 0 && <section aria-label="Proposed changes" className="rounded-xl border border-brand-100 bg-brand-50 p-4"><h3 className="text-sm font-semibold text-brand-950">What will change</h3><dl className="mt-3 space-y-3">{differences.map((difference, index) => <div key={`${difference.field}:${index}`} className="grid gap-1 text-sm sm:grid-cols-[9rem_1fr]"><dt className="font-medium">{labels[difference.field] || "Product detail"}</dt><dd><span className="text-stone-600">{display(difference.before, difference.field)}</span><span aria-hidden="true" className="mx-2 text-stone-400">→</span><span className="font-medium text-brand-950">{display(difference.after, difference.field)}</span></dd></div>)}</dl>{existing && <p className="mt-3 text-xs text-stone-600">Only the reviewed changes are proposed. Existing product identity and inventory units are protected.</p>}</section>}

    {failedAttempt && <section aria-label="Previous import attempt" className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950"><p className="font-semibold">The previous attempt could not apply this product</p><p className="mt-1 text-xs">Revalidate the proposal against the current product before approving it again. Your reviewed values remain available for comparison.</p><button type="button" className="ht-button-secondary mt-3" disabled={!enabled} onClick={() => save(false, true)}>Revalidate proposal</button></section>}

    {blocking.length > 0 && <section aria-label="Required corrections" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-900"><h3 className="font-semibold">Resolve before importing</h3><ul className="mt-2 list-disc space-y-1 pl-5">{blocking.map((issue, index) => <li key={`${issue.field}:${index}`}>{issue.field && labels[issue.field] ? `${labels[issue.field]}: ` : ""}{issue.message}</li>)}</ul></section>}
    {missingPrice && <div className="rounded-xl bg-amber-50 p-4 text-sm text-amber-950"><p className="font-semibold">Purchase price is missing</p><p className="mt-1 text-xs">You can save this as an inactive concept when its required product details are valid. Purchase costs and price comparisons remain unavailable until a reliable price is supplied.</p></div>}
    {!missingPrice && existing && findings.some((finding) => finding.code === "price-source-missing") && <p className="rounded-xl bg-stone-50 p-3 text-xs text-stone-600">No new purchase price was supplied. The existing price contract is preserved.</p>}
    {warnings.length > 0 && <section aria-label="Checks to review" className="rounded-xl bg-amber-50 p-4 text-sm text-amber-950"><h3 className="font-semibold">Check these details</h3><ul className="mt-2 list-disc space-y-1 pl-5">{warnings.map((issue, index) => <li key={`${issue.field}:${index}`}>{issue.message}</li>)}</ul></section>}
    {mappingPanel}

    <form onSubmit={(event) => { event.preventDefault(); save(); }} className="space-y-4">
      <fieldset disabled={!enabled} className="grid min-w-0 gap-4 sm:grid-cols-2">
        <label className={`${labelClass} sm:col-span-2`}>Product name<input className={inputClass} value={draft.supplierProductName ?? ""} onChange={(event) => change("supplierProductName", event.target.value || null)} /></label>
        <label className={labelClass}>Supplier SKU<input className={inputClass} disabled={existing} value={draft.supplierSku ?? ""} onChange={(event) => change("supplierSku", event.target.value || null)} /></label>
        <label className={labelClass}>Purchase unit<Combobox aria-label="Purchase unit" disabled={!enabled} value={PURCHASE_UNITS.includes(draft.purchaseUnit) ? draft.purchaseUnit : null} options={PURCHASE_UNITS} displayValue={(unit) => unit} getOptionValue={(unit) => unit} onChange={(unit) => change("purchaseUnit", unit || null)} placeholder="Search purchase units" allowClear />{draft.purchaseUnit && !PURCHASE_UNITS.includes(draft.purchaseUnit) && <p className="mt-1 text-xs font-normal text-amber-800">Unrecognized source unit: {draft.purchaseUnit}. Choose a supported English purchase unit.</p>}</label>
        <label className={labelClass}>Package content<input aria-label="Package content" type="number" step="any" className={inputClass} value={draft.baseUnitsPerPurchaseUnit ?? ""} onChange={(event) => numeric("baseUnitsPerPurchaseUnit", event)} /><span className="mt-1 block text-xs font-normal text-stone-500">The total physical content of one purchase package.</span></label>
        <label className={labelClass}>Content unit<select className={inputClass} value={draft.baseUnit || ""} disabled={existing} onChange={(event) => change("baseUnit", event.target.value || null)}><option value="">Unknown</option>{PRODUCT_BASE_UNITS.map((unit) => <option key={unit} value={unit}>{productUnitLabel(unit)}</option>)}</select></label>
        <label className={labelClass}>Pricing model<select className={inputClass} value={draft.pricingModel || ""} onChange={(event) => change("pricingModel", event.target.value || null)}><option value="">Unknown</option><option>Per Purchase Unit</option><option>Per Base Unit</option></select></label>
        <label className={labelClass}>{draft.pricingModel === "Per Base Unit" ? "Base-unit price" : "Package price"}<input aria-label={draft.pricingModel === "Per Base Unit" ? "Base-unit price" : "Package price"} type="number" step="any" min="0" className={inputClass} value={draft[draft.pricingModel === "Per Base Unit" ? "pricePerBaseUnit" : "pricePerPurchaseUnit"] ?? ""} onChange={(event) => numeric(draft.pricingModel === "Per Base Unit" ? "pricePerBaseUnit" : "pricePerPurchaseUnit", event)} /><span className="mt-1 block text-xs font-normal text-stone-500">Leave blank when the purchase price is unknown. Zero is an explicit price.</span></label>
        <label className={labelClass}>Price basis<select className={inputClass} value={draft.priceBasis || "unknown"} onChange={(event) => change("priceBasis", event.target.value)}><option value="unknown">Unknown</option><option value="net">Net — excluding VAT</option><option value="gross">Gross — including VAT</option></select></label>
        <label className={labelClass}>Currency<Combobox aria-label="Currency" disabled={!enabled} value={currencies.find((choice) => choice.id === draft.currency) || null} options={currencies} displayValue={(choice) => choice.label} getOptionValue={(choice) => choice.id} onChange={(choice) => change("currency", choice?.id || null)} placeholder="Search currencies" allowClear /></label>
        <label className={labelClass}>VAT rate (%)<input type="number" step="any" min="0" max="100" className={inputClass} value={vatPercent} onChange={(event) => { if (!enabled) return; setVatPercent(event.target.value); setDirty(true); setAcknowledged(false); }} /></label>
        <label className="flex items-start gap-2 text-sm text-stone-700 sm:col-span-2"><input type="checkbox" className="mt-1" checked={draft.active === true} onChange={(event) => change("active", event.target.checked)} /><span>Active supplier offer<span className="mt-1 block text-xs text-stone-500">Inactive concepts are retained for completion. They are not ready to order.</span></span></label>
        {canReadCatalog && <label className={`${labelClass} sm:col-span-2`}>Catalog product<Combobox aria-label="Catalog product" disabled={!enabled || Boolean(row.previousProduct?.catalogProductId)} value={selectedCatalog} options={catalogOptions} displayValue={(product) => `${product.name} (${product.baseUnit || "unknown unit"})`} getOptionValue={(product) => product.id} onChange={(product) => change("catalogProductId", product?.id || null)} onQueryChange={setCatalogTerm} filterOptions={false} placeholder="Search hotel catalog" allowClear loading={catalog.loading} description="Link an existing ingredient, or leave unlinked for procurement only." />{catalog.error && <p role="alert" className="mt-1 font-normal text-red-700">{catalog.error.message}</p>}</label>}
      </fieldset>
      <details className="rounded-xl border border-stone-200 p-4"><summary className="cursor-pointer text-sm font-medium">Additional product details</summary><fieldset disabled={!enabled} className="mt-4 grid min-w-0 gap-4 sm:grid-cols-2">
        {[['gtin', 'Package GTIN', 'text'], ['priceValidFrom', 'Price valid from', 'date'], ['priceValidUntil', 'Price valid until', 'date']].map(([field, label, type]) => <label key={field} className={labelClass}>{label}<input className={inputClass} type={type} value={draft[field] ?? ""} onChange={(event) => change(field, event.target.value || null)} /></label>)}
        <div className="space-y-3 sm:col-span-2"><h3 className="text-sm font-medium">Additional purchase packages</h3>{options.map((option, index) => <div key={option.id} className="grid gap-3 rounded-lg border p-3 sm:grid-cols-2">{[["purchaseUnit", "Package name", "text"], ["baseUnitsPerPurchaseUnit", "Package content", "number"], ["pricePerPurchaseUnit", "Package price", "number"], ["gtin", "Package GTIN", "text"]].map(([field, label, type]) => <label className={labelClass} key={field}>{label} {index + 1}<input type={type} step={type === "number" ? "any" : undefined} value={option[field] ?? ""} className={inputClass} onChange={(event) => change("purchaseOptions", options.map((candidate) => candidate.id === option.id ? { ...candidate, [field]: event.target.value === "" ? null : type === "number" ? Number(event.target.value) : event.target.value } : candidate))} /></label>)}<button type="button" className="text-left text-xs text-red-700" onClick={() => change("purchaseOptions", options.filter((candidate) => candidate.id !== option.id))}>Remove package {index + 1}</button></div>)}<button type="button" className="ht-button-secondary" disabled={options.length >= 20} onClick={() => change("purchaseOptions", [...options, { id: crypto.randomUUID(), purchaseUnit: "", baseUnitsPerPurchaseUnit: null, pricePerPurchaseUnit: null, gtin: null }])}>Add purchase package</button></div>
      </fieldset></details>
      {dirty && <p role="status" className="text-xs text-amber-800">Unsaved corrections. Save and validate them before approving this product.</p>}
      <button type="submit" className="ht-button-secondary" disabled={!enabled || !dirty}>{busy ? "Saving…" : "Save corrections"}</button>
    </form>

    {(assumptions.length > 0 || row.packInference) && <details className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-xs text-amber-950"><summary className="cursor-pointer font-semibold">Assumptions to verify ({assumptions.length + (row.packInference ? 1 : 0)})</summary><ul className="mt-3 list-disc space-y-2 pl-5">{assumptions.map((finding, index) => <li key={`${finding.code}:${index}`}>{finding.message || `${labels[finding.field] || "Product detail"}: ${display(finding.before, finding.field)} → ${display(finding.after, finding.field)}`}</li>)}{row.packInference && <li>{inference || "The inferred piece count cannot be reconciled with the reviewed package content. Check the source."}<span className="mt-1 block">This describes the contents only. It does not create a separately purchasable piece option.</span></li>}</ul></details>}
    <details className="rounded-xl border border-stone-200 p-4 text-xs"><summary className="cursor-pointer font-semibold text-stone-700">View source</summary><div className="mt-3 space-y-4">{(row.sourceAnchors || []).length ? row.sourceAnchors.map((source, index) => <blockquote key={index} className="space-y-2 border-l-2 border-stone-300 pl-3"><p className="font-medium">{source.anchor || source.sourceId || "Document reference"}{source.verified === false ? " · unverified reference" : ""}</p><p className="whitespace-pre-wrap">{source.quote || "No source quote available."}</p>{source.sourceExcerpt ? <p className="whitespace-pre-wrap rounded-lg bg-stone-50 p-3">{source.sourceExcerpt}</p> : <p className="text-amber-800">No extracted source text is available. Check the original document.</p>}{source.excerptTruncated && <p className="text-amber-800">This excerpt is truncated. Check the original document.</p>}</blockquote>) : <p className="text-amber-800">No source reference is available. Check the original document.</p>}</div></details>

    {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-800">{error.message || "This action could not be completed. Your draft is retained."}</p>}
    {!authorized && <p className="text-xs text-stone-600">{existing ? "Update" : "Create"} permission is required for this product.</p>}
    {row.committed && <p className="text-xs text-stone-600">This product has already been imported. Further changes belong on the supplier product page.</p>}
    {needsAcknowledgment && <label className="flex items-start gap-2 text-sm text-stone-700"><input type="checkbox" className="mt-1" disabled={!enabled || dirty} checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} /><span>I reviewed the missing information, source and disclosed assumptions.</span></label>}
    <footer className="flex flex-wrap gap-2 border-t border-stone-200 pt-4"><button type="button" className="ht-button-primary" disabled={!canApprove} onClick={() => decide("approve")}>Approve &amp; next</button><button type="button" className="ht-button-secondary" disabled={!enabled} onClick={() => decide("skip")}>Skip</button><button type="button" className="ht-button-secondary" disabled={!enabled} onClick={() => save(true)}>Save for later</button></footer>
  </article>;
}
