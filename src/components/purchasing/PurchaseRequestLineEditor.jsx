import React, { useCallback, useState } from "react";
import { ChevronDown, PackageSearch, Trash2 } from "lucide-react";
import { useScopedAsync } from "../../hooks/useScopedAsync";
import { getPurchaseRequestContext } from "../../services/firebasePurchaseRequests";
import { purchaseRequestMoney, purchaseRequestPriceReviewReason, purchaseRequestPriceValidity, purchaseRequestUnitPrice, requestLineTotalMinor } from "../../utils/purchaseRequests";
import { requestFieldClass as field, RequestError } from "./PurchaseRequestShared";

function PriceReview({ product, currency }) {
  if (!product) return null;
  return <>
    {(product.requiresQuote || product.priceNeedsReview || product.priceValidity === "unknown") && <p className="mt-2 text-xs text-amber-900">{product.requiresQuote ? `An explicit net quotation in ${currency} is required.` : "Review this supplier price before using it."}{product.priceReviewReasons?.length ? ` ${product.priceReviewReasons.map(purchaseRequestPriceReviewReason).join(" ")}` : ""}</p>}
    {product.priceValidity && <p className="mt-2 text-xs text-stone-500">Price validity: {purchaseRequestPriceValidity(product.priceValidity)}</p>}
    {product.currency && product.currency !== currency && <p className="mt-2 text-xs text-amber-900">The source uses {product.currency}. Enter an explicit net quotation in {currency}; no currency conversion is assumed.</p>}
  </>;
}
function SupplierProductPicker({ hotelUid, scopeKey, lineId, supplierId, currency, locked, onChoose, onCancel }) {
  const [search, setSearch] = useState(""), [cursor, setCursor] = useState(null), [previous, setPrevious] = useState([]);
  const load = useCallback(async () => {
    await new Promise((resolve) => setTimeout(resolve, 220));
    return getPurchaseRequestContext(hotelUid, { supplierId, ...(search ? { query: search } : {}), ...(cursor ? { cursor } : {}) });
  }, [hotelUid, supplierId, search, cursor]);
  const { data, loading, error, retry } = useScopedAsync({ scopeKey: `${scopeKey}:${lineId}:${supplierId}:${search}:${cursor || ""}`, enabled: Boolean(hotelUid && supplierId && !locked), load });
  return <section className="mt-3 rounded-xl bg-stone-50 p-4" aria-label="Choose a supplier product">
    <div className="flex flex-wrap items-start justify-between gap-2"><p className="text-sm font-medium">Choose a product and purchase pack for this line</p><button type="button" className="ht-button-secondary text-xs" onClick={onCancel} disabled={locked}>Cancel product selection</button></div>
    <label className="mt-3 block text-sm font-medium">Find supplier products<input type="search" className={field} value={search} onChange={(event) => { setSearch(event.target.value); setCursor(null); setPrevious([]); }} placeholder="Search description or supplier article number" disabled={locked} onKeyDown={(event) => { if (event.key === "Enter") event.preventDefault(); }} /></label>
    <RequestError error={error} onRetry={retry} />
    {loading && <p role="status" className="mt-3 text-xs">Searching supplier products…</p>}
    <ul className="mt-3 max-h-80 space-y-2 overflow-y-auto">{(data?.supplierProducts || []).map((product) => <li key={product.id} className="rounded-lg border bg-white p-3">
      <p className="text-sm font-medium">{product.supplierProductName || product.name}</p><p className="mt-1 text-xs text-stone-600">{[product.supplierSku, product.brand].filter(Boolean).join(" · ")}</p>
      <div className="mt-2 flex flex-wrap gap-2"><button type="button" className="ht-button-secondary text-xs" disabled={locked} onClick={() => onChoose(product)}>Use {product.purchaseUnit || "standard pack"}{product.pricePerPurchaseUnit != null ? ` · ${purchaseRequestUnitPrice(product.pricePerPurchaseUnit, product.currency || currency)}` : " · Enter quoted price"}</button>{(product.purchaseOptions || []).filter((option) => option.active !== false).map((option) => <button key={option.id} type="button" className="ht-button-secondary text-xs" disabled={locked} onClick={() => onChoose(product, option)}>Use {option.label || option.purchaseUnit || option.id}{option.pricePerPurchaseUnit != null ? ` · ${purchaseRequestUnitPrice(option.pricePerPurchaseUnit, product.currency || currency)}` : " · Enter quoted price"}</button>)}</div>
      <PriceReview product={product} currency={currency} />
    </li>)}</ul>
    {data && !data.supplierProducts?.length && <p className="mt-3 text-sm text-stone-600">No supplier products found in this page. Continue to the next page when available, or enter a free line.</p>}
    {(previous.length > 0 || data?.nextProductCursor) && <nav className="mt-3 flex flex-wrap justify-between gap-2" aria-label="Supplier product pages"><button type="button" className="ht-button-secondary text-xs" disabled={locked || loading || !previous.length} onClick={() => { setCursor(previous[previous.length - 1]); setPrevious((values) => values.slice(0, -1)); }}>Previous products</button><button type="button" className="ht-button-secondary text-xs" disabled={locked || loading || !data?.nextProductCursor} onClick={() => { setPrevious((values) => [...values, cursor]); setCursor(data.nextProductCursor); }}>More supplier products</button></nav>}
  </section>;
}
export default function PurchaseRequestLineEditor({ line, index, suppliers, hotelUid, scopeKey, currency, locked, onChange, onSupplierChange, onChooseProduct, onRemove }) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const selectedSupplier = suppliers.find((supplier) => supplier.id === line.supplierId && supplier.active !== false);
  const unavailableSupplier = Boolean(line.supplierId && !selectedSupplier);
  const [detailsOpen, setDetailsOpen] = useState(() => !line.supplierId || !line.description?.trim() || !line.unit?.trim() || unavailableSupplier);
  const lineTotalMinor = requestLineTotalMinor([line]);
  return <article aria-label={`Purchase line ${index + 1}`} className="relative py-3">
    <div className="grid grid-cols-2 gap-x-3 gap-y-2 min-[900px]:grid-cols-[minmax(0,1fr)_5.5rem_8rem_7rem_2.75rem] min-[900px]:items-start">
      <label className="col-span-2 min-w-0 pr-12 text-sm font-medium min-[900px]:col-span-1 min-[900px]:pr-0"><span className="min-[900px]:sr-only">Line {index + 1} description</span><input className={`${field} min-[900px]:mt-0`} value={line.description} maxLength={500} disabled={locked} placeholder="Product or service description" onChange={(event) => onChange({ description: event.target.value })} /></label>
      <label className="min-w-0 text-sm font-medium"><span className="min-[900px]:sr-only">Quantity</span><input type="number" min="0.000001" max="1000000" step="0.000001" className={`${field} min-[900px]:mt-0`} value={line.quantity} disabled={locked} onChange={(event) => onChange({ quantity: event.target.value })} /></label>
      <label className="min-w-0 text-sm font-medium"><span className="min-[900px]:sr-only">Net unit price ({currency})</span><input type="number" min="0" max="1000000" step="0.000001" className={`${field} min-[900px]:mt-0`} value={line.unitPrice} disabled={locked} onChange={(event) => onChange({ unitPrice: event.target.value })} /></label>
      <div className="col-span-2 flex min-h-[44px] min-w-0 items-center justify-between gap-2 text-sm min-[900px]:col-span-1 min-[900px]:justify-end"><span className="text-stone-500 min-[900px]:sr-only">Line total</span><span className="min-w-0 break-words text-right font-semibold tabular-nums">{lineTotalMinor == null ? "—" : purchaseRequestMoney(lineTotalMinor, currency)}</span></div>
      <button type="button" className="absolute right-0 top-3 inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-stone-500 hover:bg-red-50 hover:text-red-800 disabled:opacity-50 min-[900px]:static" aria-label={`Remove line ${index + 1}`} disabled={locked} onClick={onRemove}><Trash2 size={17} /></button>
      <div className="col-span-2 flex flex-wrap items-start gap-x-4 gap-y-1 min-[900px]:col-span-5">
        <details className="group min-w-0 flex-1 basis-48" open={detailsOpen} onToggle={(event) => setDetailsOpen(event.currentTarget.open)}>
          <summary className="flex min-h-[44px] cursor-pointer list-none items-center gap-2 text-xs text-stone-600 min-[900px]:min-h-[32px] [&::-webkit-details-marker]:hidden" aria-label={`Line ${index + 1} details`}>
            <span className="min-w-0 flex-1 break-words">{selectedSupplier?.name || line.supplierName || (line.supplierId ? "Supplier unavailable" : "Select supplier")}{line.unit ? ` · ${line.unit}` : ""}</span><span className="font-medium text-stone-700">Details</span><ChevronDown size={14} className="shrink-0 transition-transform group-open:rotate-180" />
          </summary>
          <div className="mb-1 mt-2 grid gap-3 rounded-lg bg-stone-50 p-3 sm:grid-cols-[minmax(0,1fr)_9rem]">
            <label className="min-w-0 text-sm font-medium">Line {index + 1} supplier<select className={field} value={line.supplierId} disabled={locked} onChange={(event) => { setPickerOpen(false); onSupplierChange(event.target.value); }}><option value="">Choose a supplier</option>{unavailableSupplier && <option value={line.supplierId}>{line.supplierName || line.supplierId} · Unavailable</option>}{suppliers.filter((supplier) => supplier.active !== false).map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}</select></label>
            <label className="min-w-0 text-sm font-medium">Unit<input className={field} value={line.unit} disabled={locked} onChange={(event) => onChange({ unit: event.target.value })} maxLength={50} /></label>
          </div>
        </details>
        <button type="button" className="inline-flex min-h-[44px] items-center gap-1.5 rounded-md px-1 text-xs font-medium text-brand-800 hover:bg-brand-50 disabled:cursor-not-allowed disabled:text-stone-400 min-[900px]:min-h-[32px]" disabled={locked || !selectedSupplier} aria-expanded={pickerOpen} onClick={() => setPickerOpen((value) => !value)}><PackageSearch size={15} />Choose supplier product</button>
      </div>
    </div>
    {unavailableSupplier && <p className="mt-2 text-xs text-amber-900">This saved supplier is no longer available. Choose an active supplier before saving this line.</p>}
    {line.supplierChanged && <p role="status" className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-950">Supplier changed. Choose a product or enter a new net quotation and unit for this line.</p>}
    {pickerOpen && selectedSupplier && <SupplierProductPicker key={`${scopeKey}:${line.id}:${line.supplierId}`} hotelUid={hotelUid} scopeKey={scopeKey} lineId={line.id} supplierId={line.supplierId} currency={currency} locked={locked} onChoose={(product, option) => { onChooseProduct(product, option); setPickerOpen(false); setDetailsOpen(false); }} onCancel={() => setPickerOpen(false)} />}
    <PriceReview product={line.priceReview} currency={currency} />
  </article>;
}
