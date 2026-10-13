import React, { useCallback, useEffect, useRef, useState } from "react";
import { Combobox } from "../ui/combobox";
import { getCatalogProducts } from "../../services/firebaseProducts";
import { useScopedAsync } from "../../hooks/useScopedAsync";
import { usePermission } from "../../hooks/usePermission";
import { currencyChoices } from "../../utils/propertySettingChoices";
import { PRODUCT_BASE_UNITS } from "../../utils/productPurchaseOptions";
import { productUnitLabel } from "../../utils/productUnitDisplay";
import { saveSupplierAiImportReview } from "../../services/firebaseSupplierAiImports";

const display = (value) => value == null || value === "" ? "Unknown" : typeof value === "object" ? JSON.stringify(value) : String(value);
const fields = [
  ["supplierSku", "Supplier SKU"], ["supplierProductName", "Product name"], ["purchaseUnit", "Purchase package"],
  ["baseUnitsPerPurchaseUnit", "Package content", "number"], ["pricePerPurchaseUnit", "Package price", "number"],
  ["pricePerBaseUnit", "Base-unit price", "number"], ["vatRate", "VAT rate (%)", "percent"],
  ["gtin", "Package GTIN"], ["priceValidFrom", "Price valid from", "date"], ["priceValidUntil", "Price valid until", "date"],
];
const fieldLabel = (field) => fields.find(([key]) => key === field)?.[1] || ({ currency: "Currency", priceBasis: "Price basis", baseUnit: "Content unit", catalogProductId: "Catalog product", purchaseOptions: "Purchase packages", active: "Active offer" })[field] || field;
export default function SupplierAiImportRow({ hotelUid, jobId, row, selected, onSelect, onCorrected, locked = false, current = () => true }) {
  const [expanded, setExpanded] = useState(false), [draft, setDraft] = useState(row.product || {}), [busy, setBusy] = useState(false), [error, setError] = useState(null);
  const [catalogTerm, setCatalogTerm] = useState(""), [debouncedCatalogTerm, setDebouncedCatalogTerm] = useState(""), [options, setOptions] = useState(row.product?.purchaseOptions || []);
  const canReadCatalog = usePermission("catalogproducts", "read");
  const latestRow = useRef(row); latestRow.current = row;
  const [dirty, setDirty] = useState(false);
  const canCreate = usePermission("supplierproducts", "create"), canUpdate = usePermission("supplierproducts", "update");
  const existing = Boolean(row.previousProduct);
  const authorized = existing ? canUpdate : canCreate;
  const editable = authorized && !row.committed;
  const eligible = editable && !dirty && ["new", "changed", "unchanged"].includes(row.category) && !(row.issues || []).some((issue) => issue.severity === "error") && !row.committed;
  useEffect(() => { setDraft(row.product || {}); setDirty(false); setOptions(row.product?.purchaseOptions || []); }, [row]);
  useEffect(() => { const timer = setTimeout(() => setDebouncedCatalogTerm(catalogTerm), 250); return () => clearTimeout(timer); }, [catalogTerm]);
  const loadCatalog = useCallback(() => getCatalogProducts(hotelUid, { pageSize: 50, searchTerm: debouncedCatalogTerm }), [hotelUid, debouncedCatalogTerm]);
  const catalog = useScopedAsync({ scopeKey: `${hotelUid}:${debouncedCatalogTerm}:${expanded}`, enabled: Boolean(expanded && canReadCatalog), initialData: null, load: loadCatalog });
  const catalogOptions = (catalog.data?.products || []).filter((item) => item.active !== false && item.archived !== true);
  const selectedCatalog = catalogOptions.find((item) => item.id === draft.catalogProductId) || (draft.catalogProductId ? { id: draft.catalogProductId, name: row.previousProduct?.catalogProductName || "Existing catalog link", baseUnit: row.previousProduct?.baseUnit || "" } : null);
  const established = existing;
  const change = (field, value) => { setDirty(true); setDraft((prior) => ({ ...prior, [field]: value })); onSelect(row.rowId, false); };
  const submit = async (event) => {
    event.preventDefault(); if (!current() || locked || busy || !editable) return;
    setBusy(true); setError(null);
    const captured = { rowId: row.rowId, reviewRevision: row.reviewRevision };
    try {
      const purchaseOptions = options;
      const publicFields = ["supplierSku", "supplierProductName", "currency", "pricingModel", "pricePerBaseUnit", "pricePerPurchaseUnit", "purchaseUnit", "baseUnit", "baseUnitsPerPurchaseUnit", "catalogProductId", "active", "priceBasis", "vatRate", "priceValidFrom", "priceValidUntil", "gtin"];
      const patch = Object.fromEntries(publicFields.filter((field) => Object.hasOwn(draft, field)).map((field) => [field, draft[field]])); patch.purchaseOptions = purchaseOptions;
      const result = await saveSupplierAiImportReview(hotelUid, { jobId, rowId: row.rowId, expectedReviewRevision: row.reviewRevision, patch });
      if (current() && latestRow.current.rowId === captured.rowId && latestRow.current.reviewRevision === captured.reviewRevision) { onCorrected(result.row); setExpanded(false); }
    } catch (failure) { if (current()) setError(failure); }
    finally { if (current()) setBusy(false); }
  };
  return <article className="min-w-0 space-y-3 rounded-xl border border-stone-200 bg-white p-3 [overflow-wrap:anywhere]" aria-label={`Import row ${row.rowId}`}>
    <div className="flex items-start justify-between gap-2"><div className="min-w-0"><p className="text-xs font-semibold uppercase text-stone-500">{row.category}{row.committed ? " · already processed" : ""}</p><h3 className="font-semibold text-brand-950">{row.product?.supplierProductName || "Product name missing"}</h3><p className="text-xs text-stone-500">SKU: {display(row.product?.supplierSku)}</p><p className="mt-1 text-xs text-stone-600">{display(row.product?.baseUnitsPerPurchaseUnit)} {row.product?.baseUnit ? productUnitLabel(row.product.baseUnit) : "unknown unit"} per {row.product?.purchaseUnit || "unknown package"} · {display(row.product?.pricePerPurchaseUnit)} {row.product?.currency || "unknown currency"} · {row.product?.priceBasis || "unknown price basis"}</p></div><button type="button" className="shrink-0 text-sm text-brand-800 underline" onClick={() => setExpanded((value) => !value)} disabled={locked || busy}>{expanded ? "Hide details" : "Review details"}</button></div>
    {(row.changes || []).length > 0 && <dl className="space-y-2 text-xs">{row.changes.map((change, index) => <div key={`${change.field}:${index}`} className="rounded-lg bg-stone-50 p-2"><dt className="font-semibold">{fieldLabel(change.field)}</dt><dd><span className="text-stone-500">Before:</span> {display(change.before)}</dd><dd><span className="text-brand-800">Proposed:</span> {display(change.after)}</dd></div>)}</dl>}
    {(row.issues || []).map((issue, index) => <p key={`${issue.field}:${index}`} className={`text-xs ${issue.severity === "error" ? "text-red-700" : "text-amber-800"}`}>{issue.field ? `${fieldLabel(issue.field)}: ` : ""}{issue.message}</p>)}
    {row.category === "new" && row.product?.active === false && <p className="text-xs text-stone-600">New offers start inactive. Enable only after reviewing package contents and price terms.</p>}
    {expanded && <>
      <details open className="text-xs"><summary className="font-semibold">Source evidence</summary>{(row.sourceAnchors || []).length ? row.sourceAnchors.map((source, index) => <blockquote key={index} className="mt-2 border-l-2 border-stone-300 pl-2"><p className="font-medium">{source.anchor || source.sourceId || "Document source"}{source.verified === false ? " · unverified reference" : ""}</p><p className="mt-1 whitespace-pre-wrap"><span className="font-medium">AI reference quote: </span><span>{source.quote || "No quote available."}</span></p>{source.sourceExcerpt ? <><p className="mt-2 font-medium">Extracted source row:</p><p className="whitespace-pre-wrap rounded bg-stone-50 p-2">{source.sourceExcerpt}</p>{source.excerptTruncated && <p className="mt-1 text-amber-800">The source excerpt is truncated. Check the original document.</p>}</> : <p className="mt-2 text-amber-800">No extracted source text is available. Verify this reference in the original document, especially package quantities, tax and price terms.</p>}</blockquote>) : <p className="mt-2">No source reference available. Check the original document.</p>}</details>
      <form onSubmit={submit} className="space-y-3 border-t pt-3">
        <p className="text-xs text-stone-600">Correct extracted values, then save for server validation. Blank values stay unknown. Existing supplier/catalog identities and base units are preserved during AI imports. Review legacy units on the supplier product itself.</p>
        <fieldset disabled={locked || busy || !editable} className="grid min-w-0 gap-3 sm:grid-cols-2">
          {fields.filter(([field]) => field !== "pricePerBaseUnit" || draft.pricingModel === "Per Base Unit").map(([field, label, type = "text"]) => <label key={field} className="min-w-0 text-xs font-semibold">{label}<input type={type === "percent" ? "number" : type} step={type === "number" || type === "percent" ? "any" : undefined} disabled={(field === "supplierSku" && existing) || (field === "pricePerPurchaseUnit" && draft.pricingModel === "Per Base Unit")} min={type === "percent" ? 0 : undefined} max={type === "percent" ? 100 : undefined} value={draft[field] == null ? "" : type === "percent" ? draft[field] * 100 : draft[field]} onChange={(event) => change(field, event.target.value === "" ? null : type === "percent" ? Number(event.target.value) / 100 : type === "number" ? Number(event.target.value) : event.target.value)} className="mt-1 w-full min-w-0 rounded-lg border px-2 py-2 text-sm disabled:bg-stone-50" /></label>)}
          <label className="text-xs font-semibold">Content unit<select value={draft.baseUnit || ""} disabled={established} onChange={(event) => change("baseUnit", event.target.value || null)} className="mt-1 w-full rounded-lg border p-2 text-sm"><option value="">Unknown</option>{PRODUCT_BASE_UNITS.map((unit) => <option key={unit} value={unit}>{productUnitLabel(unit)}</option>)}</select></label>
          <label className="text-xs font-semibold">Pricing model<select value={draft.pricingModel || ""} onChange={(event) => change("pricingModel", event.target.value || null)} className="mt-1 w-full rounded-lg border p-2 text-sm"><option value="">Unknown</option><option>Per Purchase Unit</option><option>Per Base Unit</option></select></label>
          <label className="text-xs font-semibold">Price basis<select value={draft.priceBasis || "unknown"} onChange={(event) => change("priceBasis", event.target.value)} className="mt-1 w-full rounded-lg border p-2 text-sm"><option value="unknown">Unknown</option><option value="net">Net — excluding VAT</option><option value="gross">Gross — including VAT</option></select></label>
          <label className="text-xs font-semibold">Currency<Combobox aria-label={`Currency for ${row.rowId}`} value={currencyChoices().find((option) => option.id === draft.currency) || null} options={currencyChoices()} displayValue={(option) => option.label} getOptionValue={(option) => option.id} onChange={(option) => change("currency", option?.id || null)} placeholder="Select currency" allowClear /></label>
          {canReadCatalog && <label className="text-xs font-semibold sm:col-span-2">Catalog product<Combobox aria-label={`Catalog product for ${row.rowId}`} disabled={Boolean(row.previousProduct?.catalogProductId)} value={selectedCatalog} options={catalogOptions} displayValue={(item) => `${item.name} (${item.baseUnit || "unknown unit"})`} getOptionValue={(item) => item.id} onChange={(item) => change("catalogProductId", item?.id || null)} onQueryChange={setCatalogTerm} filterOptions={false} placeholder="Search hotel catalog" allowClear loading={catalog.loading} description="Choose an existing ingredient, or leave unlinked for procurement only." />{catalog.error && <p role="alert" className="mt-1 text-red-700">{catalog.error.message}</p>}</label>}
          <div className="space-y-3 rounded-lg border p-3 sm:col-span-2"><h4 className="text-sm font-semibold">Additional purchase packages</h4><p className="text-xs text-stone-500">Review each package's contents and price. Existing package identities are retained.</p>
            {options.map((option, index) => <div key={option.id} className="grid gap-2 border-t pt-3 sm:grid-cols-2">
              {[["purchaseUnit", "Package name", "text"], ["baseUnitsPerPurchaseUnit", "Package content", "number"], ["pricePerPurchaseUnit", "Package price", "number"], ["gtin", "Package GTIN", "text"]].map(([field, label, type]) => <label key={field} className="text-xs font-semibold">{label} {index + 1}<input type={type} step={type === "number" ? "any" : undefined} value={option[field] ?? ""} onChange={(event) => { setDirty(true); onSelect(row.rowId, false); setOptions((prior) => prior.map((candidate) => candidate.id === option.id ? { ...candidate, [field]: event.target.value === "" ? null : type === "number" ? Number(event.target.value) : event.target.value } : candidate)); }} className="mt-1 w-full rounded-lg border p-2 text-sm" /></label>)}
              <button type="button" className="text-left text-xs text-red-700" onClick={() => { setDirty(true); onSelect(row.rowId, false); setOptions((prior) => prior.filter((candidate) => candidate.id !== option.id)); }}>Remove package {index + 1}</button>
            </div>)}
            <button type="button" disabled={options.length >= 20} className="ht-button-secondary" onClick={() => { setDirty(true); onSelect(row.rowId, false); setOptions((prior) => [...prior, { id: crypto.randomUUID(), purchaseUnit: "", baseUnitsPerPurchaseUnit: null, pricePerPurchaseUnit: null, gtin: null }]); }}>Add purchase package</button>
          </div>
          <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" checked={draft.active === true} onChange={(event) => change("active", event.target.checked)} /> Active supplier offer</label>
        </fieldset>
        {error && <p role="alert" className="text-sm text-red-700">{error.message}</p>}
        <button type="submit" disabled={locked || busy || !editable} className="ht-button-secondary">{busy ? "Validating correction…" : "Save correction"}</button>
      </form>
    </>}
    <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={selected} disabled={locked || busy || !eligible} onChange={(event) => onSelect(row.rowId, event.target.checked, row.reviewRevision)} className="mt-1" /><span>I reviewed this row and its source; include it in the import.</span></label>
    {row.committed && <p className="text-xs text-stone-600">This row is already confirmed. Further changes belong on the supplier product itself.</p>}
    {dirty && <p className="text-xs text-amber-800">Save and validate your corrections before selecting this row.</p>}
    {!authorized && <p className="text-xs text-stone-600">{existing ? "Update" : "Create"} permission is required for this row.</p>}
  </article>;
}
