import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Card } from "../layout/Card";
import AsyncError from "../shared/AsyncError";
import { useScopedAsync } from "../../hooks/useScopedAsync";
import { usePermission } from "../../hooks/usePermission";
import { getSupplierPriceComparison, getSupplierPriceHistory } from "../../services/firebaseSupplierInsights";
import { compareSupplierOffers, formatSupplierPrice, supplierPriceChanges, supplierPriceUnavailableLabel } from "../../utils/supplierPriceComparison";
import { auth } from "../../firebaseConfig";

const date = (value) => value ? new Date(value).toLocaleString() : "Unknown observation date";
const inputClass = "w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm";
const validity = (record) => record?.contractualValidityNeedsReview ? "Contract validity dates need review" : !record?.contractualValidFrom && !record?.contractualValidUntil ? "Contractual validity unknown"
  : `Contract bounds: ${record.contractualValidFrom || "unknown start"} to ${record.contractualValidUntil || "unknown end"}`;
function usePriceAccess() {
  const catalog = usePermission("catalogproducts", "read"), products = usePermission("supplierproducts", "read"), suppliers = usePermission("suppliers", "read");
  return catalog && products && suppliers;
}
function AccessNotice() {
  return <p className="text-sm text-gray-600">Catalog Products, Supplier Products and Suppliers read permissions are required to view supplier price insights.</p>;
}
function PriceScopeNotice() {
  return <p className="text-sm text-gray-600">Net entered goods prices per catalog unit; VAT is removed once from gross prices. Currencies are compared separately without exchange rates. Freight, deposits, minimum order quantities and other unentered terms are excluded. The lowest goods price is not an automatic supplier recommendation.</p>;
}

export function SupplierPriceComparison({ hotelUid, catalogProductId }) {
  return <Comparison key={`${auth.currentUser?.uid}:${hotelUid}:${catalogProductId}`} hotelUid={hotelUid} catalogProductId={catalogProductId} />;
}
function Comparison({ hotelUid, catalogProductId }) {
  const canRead = usePriceAccess();
  const [cursor, setCursor] = useState(null), [products, setProducts] = useState([]), [queryText, setQueryText] = useState("");
  const [catalog, setCatalog] = useState(null);
  const [assessment, setAssessment] = useState(null), [paginationNotice, setPaginationNotice] = useState("");
  const firstAssessment = useRef(null);
  const [currency, setCurrency] = useState(""), [showUnavailable, setShowUnavailable] = useState(true);
  const load = useCallback(() => getSupplierPriceComparison(hotelUid, catalogProductId, { afterProductId: cursor }), [hotelUid, catalogProductId, cursor]);
  const query = useScopedAsync({ scopeKey: `${hotelUid}:${catalogProductId}:${cursor}:${canRead}`, enabled: Boolean(canRead && hotelUid && catalogProductId), load });
  useEffect(() => {
    if (!query.data) return;
    const metadata = JSON.stringify([query.data.catalog.baseUnit, query.data.assessmentDate ?? null, query.data.timeZone ?? null]);
    if (cursor !== null && firstAssessment.current !== metadata) {
      firstAssessment.current = null; setProducts([]); setCatalog(null); setAssessment(null); setCursor(null);
      setPaginationNotice("The hotel assessment date, time zone or catalog unit changed. The comparison restarted from the first page.");
      return;
    }
    firstAssessment.current = metadata;
    setCatalog(query.data.catalog);
    setAssessment({ date: query.data.assessmentDate, timeZone: query.data.timeZone });
    setProducts((previous) => cursor === null ? query.data.products : [...previous.filter((product) => !query.data.products.some((next) => next.id === product.id)), ...query.data.products]);
  }, [query.data, cursor]);
  useEffect(() => { if (!canRead) { setProducts([]); setCursor(null); setCatalog(null); setAssessment(null); firstAssessment.current = null; } }, [canRead]);
  const rows = useMemo(() => compareSupplierOffers(products, { query: queryText, currency, includeUnavailable: showUnavailable }), [products, queryText, currency, showUnavailable]);
  const currencies = useMemo(() => [...new Set(products.map((product) => product.currency).filter((value) => /^[A-Z]{3}$/.test(value || "")))].sort(), [products]);
  const incomplete = query.loading || Boolean(query.error) || Boolean(query.data?.nextProductId);
  const inactive = products.filter((product) => !product.active).length;
  return <Card className="space-y-4">
    <div><h2 className="text-lg font-semibold">Compare supplier goods prices</h2><p className="mt-1 text-sm text-gray-600">Purchase packages linked to this exact catalog article.</p></div>
    {!canRead ? <AccessNotice /> : <>
      <PriceScopeNotice />
      <button type="button" className="rounded-lg border px-4 py-2 text-sm font-semibold" disabled={query.loading} onClick={() => {
        setProducts([]); setCatalog(null); setAssessment(null); setPaginationNotice(""); firstAssessment.current = null;
        if (cursor !== null) setCursor(null); else query.retry();
      }}>Refresh current prices</button>
      {assessment?.date && <p className="text-xs text-gray-500">Known contract bounds checked for hotel date {assessment.date} ({assessment.timeZone}). Future or expired prices are excluded from current rankings; unspecified contract bounds remain unknown.</p>}
      {paginationNotice && <p role="status" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{paginationNotice}</p>}
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_160px]">
        <label className="text-sm">Filter loaded suppliers, SKUs or packages<input className={inputClass} value={queryText} onChange={(event) => setQueryText(event.target.value)} placeholder="Search loaded offers" /></label>
        <label className="text-sm">Currency<select className={inputClass} value={currency} onChange={(event) => setCurrency(event.target.value)}><option value="">All currencies</option>{currencies.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
      </div>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={showUnavailable} onChange={(event) => setShowUnavailable(event.target.checked)} />Show offers needing price review</label>
      <AsyncError error={query.error} onRetry={query.retry} label="Could not load supplier price insights." />
      {query.loading && <p role="status" className="text-sm text-gray-600">Loading supplier price insights…</p>}
      {incomplete && products.length > 0 && <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">Comparison is incomplete. Prices are ranked only among loaded offers; load all pages before assessing the entered goods-price range.</p>}
      {!query.loading && !query.error && !rows.length && <p className="text-sm text-gray-600">No active matching offers in the loaded records.</p>}
      {rows.length > 0 && <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="border-b"><th className="p-3">Supplier / article</th><th className="p-3">Package</th><th className="p-3">Net goods price / {catalog?.baseUnit || "catalog unit"}</th><th className="p-3">Price observation</th></tr></thead><tbody>{rows.map((row, index) => <tr key={`${row.supplierProductId}:${row.id}:${index}`} className="border-b align-top">
        <td className="p-3"><p className="font-medium">{row.supplierName || "Supplier name unavailable"}</p><Link className="text-brand-700 underline" to={`/catalog/supplier-products/${row.supplierProductId}`}>{row.name || "Supplier article"}</Link><p className="text-xs text-gray-500">SKU {row.supplierSku || "unknown"}</p></td>
        <td className="p-3"><p>{row.purchaseUnit || "Package unavailable"}</p><p className="text-xs text-gray-500">{row.catalogUnitsPerPurchaseUnit !== null ? `${row.catalogUnitsPerPurchaseUnit} ${catalog?.baseUnit || "catalog units"}` : "Content conversion unavailable"}</p><p className="text-xs text-gray-500">{formatSupplierPrice(row.pricePerPurchaseUnit, row.currency)} entered ({row.priceBasis || "unknown basis"})</p></td>
        <td className="p-3">{row.comparable ? <><p className="font-semibold">{formatSupplierPrice(row.netPricePerCatalogUnit, row.currency)}</p>{row.lowestLoadedPrice && <span className="text-xs text-emerald-700">{incomplete ? "Lowest loaded goods price" : "Lowest entered goods price"}</span>}</> : <p className="text-amber-800">{supplierPriceUnavailableLabel(row.reason)}</p>}</td>
        <td className="p-3"><p>{date(row.sourcePriceRecordedAt)}</p><p className="text-xs text-gray-500">{validity(row)}</p>{row.priceValidity === "current" && <p className="text-xs text-gray-500">Within the recorded bounds on {assessment?.date || "the assessment date"}</p>}</td>
      </tr>)}</tbody></table></div>}
      {inactive > 0 && <p className="text-xs text-gray-500">{inactive} inactive, archived or unresolved supplier offer{inactive === 1 ? " is" : "s are"} excluded from current purchasing comparisons.</p>}
      {query.data?.nextProductId && <button type="button" className="rounded-lg border px-4 py-2 text-sm font-semibold" disabled={query.loading} onClick={() => setCursor(query.data.nextProductId)}>Load more supplier offers</button>}
      <p className="text-xs text-gray-500">Prices use six-decimal bounded monetary precision. Missing or incompatible terms remain unavailable. Current source observation dates do not prove contractual validity.</p>
    </>}
  </Card>;
}

export function SupplierPriceHistory({ hotelUid, supplierProductId }) {
  return <History key={`${auth.currentUser?.uid}:${hotelUid}:${supplierProductId}`} hotelUid={hotelUid} supplierProductId={supplierProductId} />;
}
function History({ hotelUid, supplierProductId }) {
  const canRead = usePriceAccess();
  const [cursor, setCursor] = useState(null), [entries, setEntries] = useState([]), [threshold, setThreshold] = useState("10");
  const load = useCallback(() => getSupplierPriceHistory(hotelUid, supplierProductId, { beforeRevision: cursor }), [hotelUid, supplierProductId, cursor]);
  const query = useScopedAsync({ scopeKey: `${hotelUid}:${supplierProductId}:${cursor}:${canRead}`, enabled: Boolean(canRead && hotelUid && supplierProductId), load });
  useEffect(() => { if (query.data) setEntries((previous) => cursor === null ? query.data.entries : [...previous.filter((entry) => !query.data.entries.some((next) => next.revision === entry.revision)), ...query.data.entries]); }, [query.data, cursor]);
  useEffect(() => { if (!canRead) { setEntries([]); setCursor(null); } }, [canRead]);
  const limit = threshold.trim() === "" ? null : Number(threshold);
  const thresholdValid = limit !== null && Number.isFinite(limit) && limit >= 0 && limit <= 10000;
  return <Card className="space-y-4">
    <h2 className="text-lg font-semibold">Supplier price history</h2>
    {!canRead ? <AccessNotice /> : <>
      <p className="text-sm text-gray-600">Immutable observations start with this feature. Earlier price changes are not reconstructed. Each event freezes its package, catalog unit, currency and VAT basis; existing orders and receipts retain their original terms.</p>
      <button type="button" className="rounded-lg border px-4 py-2 text-sm font-semibold" disabled={query.loading} onClick={() => {
        setEntries([]); if (cursor !== null) setCursor(null); else query.retry();
      }}>Refresh price history</button>
      <label className="block max-w-xs text-sm">Highlight price increases of at least (%)<input type="number" min="0" max="10000" step="0.1" className={inputClass} value={threshold} onChange={(event) => setThreshold(event.target.value)} /></label>
      {!thresholdValid && <p className="text-sm text-amber-800">Enter a threshold from 0 to 10,000%. Highlights are unavailable until the threshold is valid.</p>}
      <AsyncError error={query.error} onRetry={query.retry} label="Could not load supplier price history." />
      {query.loading && <p role="status" className="text-sm text-gray-600">Loading price history…</p>}
      {!query.loading && !query.error && !entries.length && <p className="rounded-lg bg-gray-50 p-3 text-sm text-gray-700">No recorded price-content events yet. Current prices are available in the product details; no historical dates or changes have been invented.</p>}
      <div className="space-y-4">{entries.map((entry) => <article className="rounded-xl border p-4" key={entry.revision}>
        <div className="flex flex-wrap justify-between gap-2"><h3 className="font-semibold">{entry.observation === "initial-create" ? "Initial product terms" : "Price / package terms observed"}</h3><p className="text-sm text-gray-600">{date(entry.observedAt)} · revision {entry.revision}</p></div>
        <div className="mt-3 grid gap-3 md:grid-cols-2">{supplierPriceChanges(entry).map((change, index) => <div key={`${change.id}:${index}`} className="rounded-lg bg-gray-50 p-3 text-sm">
          <p className="font-medium">{change.purchaseUnit || "Unknown purchase option"}</p>
          <p>New: {change.available ? `${formatSupplierPrice(change.netPricePerCatalogUnit, entry.currency)} / ${entry.catalogBaseUnit}` : supplierPriceUnavailableLabel(change.reason)}</p>
          {change.previous && <p>Previous: {change.previous.available ? `${formatSupplierPrice(change.previous.netPricePerCatalogUnit, entry.previous.currency)} / ${entry.previous.catalogBaseUnit}` : supplierPriceUnavailableLabel(change.previous.reason)}</p>}
          {change.comparable ? <p className={thresholdValid && change.percentage !== null && change.percentage >= limit && change.delta > 0 ? "mt-2 font-semibold text-amber-800" : "mt-2 text-gray-600"}>{change.delta > 0 ? "+" : ""}{change.delta} {entry.currency} / {entry.catalogBaseUnit}{change.percentage === null ? " · percentage unavailable from a zero baseline" : ` · ${change.percentage > 0 ? "+" : ""}${change.percentage.toFixed(2)}%`}{thresholdValid && change.percentage !== null && change.percentage >= limit && change.delta > 0 ? " · above selected increase threshold" : ""}</p>
            : entry.previous && <p className="mt-2 text-amber-800">Change comparison unavailable for missing prices, changed currency, catalog identity or unit.</p>}
        </div>)}</div>
        {entry.previous && <p className="mt-3 text-xs text-gray-500">Previous terms were observed immediately before this save; their earlier effective date is unknown.</p>}
        <p className="mt-2 text-xs text-gray-500">{validity(entry)}. Package names/content may change in this event; the entered goods price excludes unentered charges.</p>
      </article>)}</div>
      {query.data?.nextRevision && <button type="button" className="rounded-lg border px-4 py-2 text-sm font-semibold" disabled={query.loading} onClick={() => setCursor(query.data.nextRevision)}>Load older price events</button>}
    </>}
  </Card>;
}
