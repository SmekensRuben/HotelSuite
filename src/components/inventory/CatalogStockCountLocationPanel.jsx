import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import StockCountPackageEntry from "./StockCountPackageEntry";
import StockCountBarcodeScanner from "./StockCountBarcodeScanner";
import InventoryCostProposal from "./InventoryCostProposal";
import StockCountExceptionReview from "./StockCountExceptionReview";
import { Card } from "../layout/Card";
import { auth } from "../../firebaseConfig";
import { usePermission } from "../../hooks/usePermission";
import { useScopedAsync } from "../../hooks/useScopedAsync";
import { productUnitLabel } from "../../utils/productUnitDisplay";
import { matchesSearchTokensAcross } from "../../utils/search";
import { finishStockCountLocation, getStockCountProductChoices, updateStockCountLocationCounts } from "../../services/firebaseStockCounts";
import { formatInventoryValue, parseInventoryDecimal } from "./inventoryFormatting";
import { procurementReadScope } from "../../services/procurementReadPool";

const productName = (item) => item.catalogProductName || item.name || "Unnamed catalog product";
function quantityStatus(value) {
  if (value === "") return "uncounted";
  try { return parseInventoryDecimal(value) === 0 ? "zero" : "counted"; } catch { return "invalid"; }
}
function validateProductPage(page, seen = new Set()) {
  if (!Array.isArray(page?.products) || page.nextCursor != null && (typeof page.nextCursor !== "string" || !page.nextCursor || seen.has(page.nextCursor))) {
    throw new Error("Product choices returned incomplete or repeated pagination. Retry before adding a product.");
  }
  return page;
}

export default function CatalogStockCountLocationPanel({ hotelUid, stockCount, location }) {
  const navigate = useNavigate();
  const canUpdate = usePermission("stockcounts", "update"), canReadCounts = usePermission("stockcounts", "read");
  const [additional, setAdditional] = useState([]), [quantities, setQuantities] = useState({}), [costs, setCosts] = useState({});
  const [appliedEstimates, setAppliedEstimates] = useState({});
  const [saving, setSaving] = useState(false), [error, setError] = useState("");
  const [adding, setAdding] = useState(false), [search, setSearch] = useState(""), [searchTerm, setSearchTerm] = useState("");
  const [barcode, setBarcode] = useState(""), [scannerOpen, setScannerOpen] = useState(false), [scanMessage, setScanMessage] = useState("");
  const [filter, setFilter] = useState("all"), [editingId, setEditingId] = useState(null), [focusId, setFocusId] = useState(null);
  const [olderProducts, setOlderProducts] = useState([]), [cursor, setCursor] = useState(null), [moreLoading, setMoreLoading] = useState(false), [moreError, setMoreError] = useState("");
  const productGeneration = useRef(0), seenProductCursors = useRef(new Set()), quantityInputs = useRef(new Map()), searchInput = useRef(null);
  const draftActor = useRef(auth.currentUser);
  const scopeKey = JSON.stringify([hotelUid, stockCount.id, location.locationId, auth.currentUser?.uid, canUpdate, canReadCounts, procurementReadScope(hotelUid)?.key]);
  const active = useRef({ key: scopeKey });
  if (active.current.key !== scopeKey) active.current = { key: scopeKey };
  const finished = location.status === "Finished" || stockCount.status === "Finished";
  const editable = canUpdate && !finished && !saving;
  const productKey = JSON.stringify([scopeKey, searchTerm, barcode, search.trim()]);
  const loadProducts = useCallback(async () => {
    const actor = auth.currentUser, permissionScope = procurementReadScope(hotelUid), scope = active.current, seen = new Set();
    let page = validateProductPage(await getStockCountProductChoices(hotelUid, stockCount.id, location.locationId, { search: searchTerm, barcode }));
    if (active.current !== scope || auth.currentUser !== actor || !permissionScope?.current()) throw new Error("Your access changed. Retry with the current hotel and account.");
    if (!barcode) return page;
    const found = new Map(page.products.map((product) => [product.id, product]));
    while (page.nextCursor) {
      if (seen.size >= 20) throw new Error("This barcode search exceeds the browsing limit. Search by product name and ask an administrator to review its barcode.");
      if (active.current !== scope || auth.currentUser !== actor || !permissionScope.current()) throw new Error("Your access changed. Retry this barcode with the current hotel and account.");
      seen.add(page.nextCursor);
      page = validateProductPage(await getStockCountProductChoices(hotelUid, stockCount.id, location.locationId, { search: "", barcode, afterProductId: page.nextCursor }), seen);
      page.products.forEach((product) => found.set(product.id, product));
    }
    return { ...page, products: [...found.values()], nextCursor: null };
  }, [hotelUid, stockCount.id, location.locationId, searchTerm, barcode]);
  const choicesOpen = adding || Boolean(search.trim()) || Boolean(barcode);
  const queryReady = Boolean(barcode) || search.trim() === searchTerm;
  const products = useScopedAsync({ scopeKey: productKey, enabled: Boolean(canUpdate && choicesOpen && !finished && queryReady), load: loadProducts });
  useEffect(() => { const timer = setTimeout(() => setSearchTerm(search.trim()), 250); return () => clearTimeout(timer); }, [search]);
  useEffect(() => {
    productGeneration.current++; seenProductCursors.current = new Set([products.data?.nextCursor].filter(Boolean));
    setOlderProducts([]); setCursor(products.data?.nextCursor || null); setMoreLoading(false); setMoreError("");
  }, [productKey, products.data, canUpdate, finished, choicesOpen]);
  useEffect(() => () => { productGeneration.current++; }, []);
  const loadMoreProducts = async () => {
    if (!cursor || moreLoading || !editable) return;
    const generation = ++productGeneration.current, scope = active.current, actor = auth.currentUser, permissionScope = procurementReadScope(hotelUid);
    setMoreLoading(true); setMoreError("");
    try {
      if (seenProductCursors.current.size >= 20) throw new Error("Refine your search to browse more than 500 product choices.");
      const next = validateProductPage(await getStockCountProductChoices(hotelUid, stockCount.id, location.locationId, { search: searchTerm, barcode, afterProductId: cursor }), seenProductCursors.current);
      if (generation !== productGeneration.current || active.current !== scope || auth.currentUser !== actor || !permissionScope.current()) return;
      if (next.nextCursor) seenProductCursors.current.add(next.nextCursor);
      setOlderProducts((current) => [...current, ...next.products]); setCursor(next.nextCursor || null);
    } catch (failure) { if (generation === productGeneration.current && active.current === scope) setMoreError(failure.message || "Could not load more product choices."); }
    finally { if (generation === productGeneration.current && active.current === scope) setMoreLoading(false); }
  };
  // Hydrate saved counts before interaction can overwrite or be overwritten by them.
  useLayoutEffect(() => {
    active.current = { key: scopeKey, actor: auth.currentUser };
    const saved = location.countedItems || [], included = new Set((location.stockTemplate?.items || []).map((item) => item.catalogProductId));
    setAdditional(saved.filter((item) => !included.has(item.catalogProductId)));
    setQuantities(Object.fromEntries(saved.map((item) => [item.catalogProductId, item.isCounted === false ? "" : String(item.quantity ?? "")])));
    setCosts(Object.fromEntries(saved.map((item) => [item.catalogProductId, item.unitCost == null ? "" : String(item.unitCost)])));
    setAppliedEstimates({}); setSaving(false); setError(draftActor.current !== auth.currentUser ? "The signed-in user changed. Reload this count before saving." : "");
    draftActor.current = auth.currentUser;
    setAdding(false); setSearch(""); setSearchTerm("");
    setBarcode(""); setScannerOpen(false); setScanMessage(""); setFilter("all"); setEditingId(null); setFocusId(null);
    return () => { active.current = { key: null }; };
  }, [scopeKey, location]);
  const rows = useMemo(() => [...new Map([...(location.stockTemplate?.items || []), ...additional].map((item) => [item.catalogProductId, item])).values()], [location.stockTemplate, additional]);
  const choices = useMemo(() => [...new Map([...(products.data?.products || []), ...olderProducts].map((product) => [product.id, product])).values()], [products.data, olderProducts]);
  const counted = rows.filter((item) => ["zero", "counted"].includes(quantityStatus(quantities[item.catalogProductId] ?? ""))).length;
  const uncounted = rows.filter((item) => quantityStatus(quantities[item.catalogProductId] ?? "") === "uncounted").length;
  const visibleRows = rows.filter((item) => {
    const status = quantityStatus(quantities[item.catalogProductId] ?? "");
    const matchesFilter = filter === "all" || editingId === item.catalogProductId || (filter === "uncounted" ? ["uncounted", "invalid"].includes(status) : ["zero", "counted"].includes(status));
    return matchesFilter && (Boolean(barcode) || matchesSearchTokensAcross([productName(item), item.sku, ...(item.barcodes || [])], search));
  });
  useLayoutEffect(() => {
    if (!focusId) return;
    const input = quantityInputs.current.get(focusId);
    if (input) { input.focus(); input.select(); input.scrollIntoView?.({ block: "nearest", behavior: "auto" }); setFocusId(null); }
  }, [focusId, visibleRows]);
  const chooseProduct = useCallback((product, scanned = false) => {
    if (!editable || active.current.actor !== auth.currentUser) return;
    const included = rows.some((item) => item.catalogProductId === product.id);
    if (!included && rows.length >= 250) { setError("This count area supports up to 250 products. Split a larger count into separate areas."); return; }
    if (!included) setAdditional((current) => [...current, { catalogProductId: product.id, catalogProductName: productName(product), baseUnit: product.baseUnit, barcodes: product.barcodes || [] }]);
    setSearch(""); setSearchTerm(""); setBarcode(""); setAdding(false); setScannerOpen(false); setFilter("all"); setFocusId(product.id);
    if (scanned) setScanMessage(`Found ${productName(product)}. Enter the quantity in ${product.baseUnit}; scanning does not change its count.`);
  }, [editable, rows]);
  useEffect(() => {
    if (barcode && products.data && !products.loading && !products.error && products.data.products.length === 1 && !products.data.nextCursor) chooseProduct(products.data.products[0], true);
  }, [barcode, products.data, products.loading, products.error, chooseProduct]);
  const estimateContext = (item) => JSON.stringify([hotelUid, stockCount.id, stockCount.revision, location.locationId, item.catalogProductId, item.baseUnit, stockCount.currency, stockCount.businessDate]);
  const staleEstimate = (item) => Boolean(appliedEstimates[item.catalogProductId] && (appliedEstimates[item.catalogProductId].context !== estimateContext(item) || !appliedEstimates[item.catalogProductId].scope?.current()));
  const staleApplied = rows.some(staleEstimate);
  const setManualCost = (id, value) => {
    setCosts((current) => ({ ...current, [id]: value }));
    setAppliedEstimates((current) => { const next = { ...current }; delete next[id]; return next; });
  };
  const complete = rows.length > 0 && counted === rows.length;
  const invalid = rows.some((item) => {
    const quantity = quantities[item.catalogProductId] ?? "", cost = costs[item.catalogProductId] ?? "";
    try { if (quantity !== "") parseInventoryDecimal(quantity); parseInventoryDecimal(cost, { optional: true }); return false; } catch { return true; }
  });
  const commands = () => rows.map((item) => ({ catalogProductId: item.catalogProductId,
    quantity: (quantities[item.catalogProductId] ?? "") === "" ? null : parseInventoryDecimal(quantities[item.catalogProductId]),
    unitCost: parseInventoryDecimal(costs[item.catalogProductId] ?? "", { optional: true }), isCounted: (quantities[item.catalogProductId] ?? "") !== "" }));
  const submit = async (finish) => {
    if (!editable || invalid || finish && !complete) return;
    if (active.current.actor !== auth.currentUser) { setError("The signed-in user changed. Reload this count before saving."); return; }
    if (rows.some(staleEstimate)) { setError("An applied cost estimate no longer matches this draft or its recorded evidence. Refresh it, clear it or enter a reviewed manual estimate before saving."); return; }
    const scope = active.current;
    setSaving(true); setError("");
    try {
      const values = commands();
      if (finish) await finishStockCountLocation(hotelUid, stockCount.id, location.locationId, values, [], auth.currentUser?.uid, stockCount.revision);
      else await updateStockCountLocationCounts(hotelUid, stockCount.id, location.locationId, values, auth.currentUser?.uid, stockCount.revision);
      if (active.current === scope && active.current.actor === auth.currentUser) navigate(`/catalog/stock-counts/${stockCount.id}`);
    } catch (failure) { if (active.current === scope) setError(failure.message || "Unable to save catalog count."); }
    finally { if (active.current === scope) setSaving(false); }
  };
  const nextQuantity = (id) => {
    const remaining = visibleRows.filter((item) => item.catalogProductId !== id && ["uncounted", "invalid"].includes(quantityStatus(quantities[item.catalogProductId] ?? "")));
    const after = remaining.find((item) => visibleRows.indexOf(item) > visibleRows.findIndex((row) => row.catalogProductId === id));
    if (after || remaining[0]) setFocusId((after || remaining[0]).catalogProductId);
    else searchInput.current?.focus();
  };
  const outletCount = location.isOutletDefault === true || location.stockPointType === "outlet";
  return <Card className="space-y-4 pb-4">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-xl font-semibold">Count · {location.locationName || location.outletName || "Count area"}</h2>
      <p className="mt-1 text-sm text-slate-600">Enter quantities in the displayed unit. Leave forgotten articles blank; enter 0 only when you checked and found none.</p></div>
      <p className="rounded-lg bg-slate-100 px-3 py-2 text-sm font-medium" aria-live="polite">{counted} / {rows.length} counted · {uncounted} not counted</p></div>
    <p className="text-xs text-slate-500">{stockCount.businessDate || "Business date unavailable"} · {location.stockTemplate?.id || location.stockTemplateId ? `Template: ${location.stockTemplate?.name || location.stockTemplateName || "Selected template"}` : "No template required"}</p>
    <StockCountExceptionReview hotelUid={hotelUid} stockCountId={stockCount.id} locationId={location.locationId} revision={stockCount.revision} />
    <div className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-3 sm:p-4">
      <div className="flex flex-wrap items-end gap-2"><label className="min-w-0 flex-1 text-sm font-medium">Find products<input ref={searchInput} type="search" aria-label="Find products" placeholder="Search product names" autoComplete="off" maxLength="200" value={search} disabled={saving} className="ht-field mt-1 min-h-[44px] w-full" onChange={(event) => { setSearch(event.target.value); setBarcode(""); setScanMessage(""); }} /></label>
        {canUpdate && !finished && <><button type="button" className="ht-button-secondary min-h-[44px]" disabled={saving} onClick={() => { setAdding((value) => !value); setBarcode(""); }}>Add product</button><button type="button" className="ht-button-secondary min-h-[44px]" disabled={saving} onClick={() => setScannerOpen((value) => !value)}>Scan barcode</button></>}</div>
      {scannerOpen && <StockCountBarcodeScanner scopeKey={scopeKey} disabled={!editable} onClose={() => setScannerOpen(false)} onScan={(value) => { setBarcode(value); setSearch(""); setSearchTerm(""); setAdding(true); setScanMessage(""); }} />}
      {canUpdate && !finished && <p className="text-xs text-slate-500">Find new articles by the start of their name. Use Scan barcode for product barcodes.</p>}
      {scanMessage && <p role="status" className="text-sm text-brand-800">{scanMessage}</p>}
      {canUpdate && !finished && choicesOpen && <div className="space-y-2">
        <p className="text-sm font-medium">{barcode ? `Barcode: ${barcode}` : "Products to count"}</p>
        {(products.loading || !queryReady) && <p role="status" className="text-sm text-slate-600">Finding products…</p>}
        {products.error && <div role="alert" className="text-sm text-red-700"><p>{products.error.message}</p><button type="button" className="ht-button-secondary mt-2 min-h-[44px]" onClick={products.retry}>Retry product choices</button></div>}
        {!products.loading && !products.error && products.data && <>
          {barcode && choices.length > 1 && <p className="text-sm text-amber-800">This barcode matches more than one article. Choose the physical product below.</p>}
          {!choices.length && <p className="text-sm text-slate-600">{barcode ? "No tracked product matches this barcode. Search by name or ask an administrator to review its barcode." : cursor ? "No matching products on this page. Load more choices or refine your search." : "No tracked products match. Try the start of another product name."}</p>}
          <ul className="max-h-64 space-y-1 overflow-y-auto">{choices.map((product) => {
            const included = rows.some((item) => item.catalogProductId === product.id);
            return <li key={product.id}><button type="button" disabled={!editable || !included && rows.length >= 250} onClick={() => chooseProduct(product, Boolean(barcode))} className="flex min-h-[48px] w-full items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2 text-left hover:border-brand-600 disabled:opacity-50"><span><span className="block font-medium">{productName(product)}</span><span className="text-xs text-slate-500">Count in {productUnitLabel(product.baseUnit)}</span></span><span className="shrink-0 text-sm text-brand-800">{included ? "Go to count" : "Add & count"}</span></button></li>;
          })}</ul>
          {cursor && <button type="button" className="ht-button-secondary min-h-[44px]" disabled={moreLoading || saving} onClick={loadMoreProducts}>{moreLoading ? "Loading more products…" : "Load more product choices"}</button>}
        </>}
        {moreError && <p role="alert" className="text-sm text-red-700">{moreError}</p>}
      </div>}
    </div>
    <div role="group" className="flex flex-wrap gap-2" aria-label="Count progress filters">{[["all", `All (${rows.length})`], ["uncounted", `Not counted (${rows.length - counted})`], ["counted", `Counted (${counted})`]].map(([value, label]) => <button key={value} type="button" aria-pressed={filter === value} className={`min-h-[44px] rounded-full border px-4 py-2 text-sm ${filter === value ? "border-brand-800 bg-brand-800 text-white" : "border-slate-300 bg-white"}`} onClick={() => { setFilter(value); setEditingId(null); }}>{label}</button>)}</div>
    {rows.length === 0 && <div className="rounded-xl border border-dashed border-slate-300 p-5 text-center"><p className="font-medium">Start with the products in front of you</p><p className="mt-1 text-sm text-slate-600">Search or scan an article and enter its quantity. A template is optional.</p></div>}
    {rows.length > 0 && visibleRows.length === 0 && <p className="text-sm text-slate-600">No articles match this filter or search.</p>}
    <div className="space-y-3">{visibleRows.map((item) => {
      const id = item.catalogProductId, quantity = quantities[id] ?? "", cost = costs[id] ?? "", status = quantityStatus(quantity);
      const value = quantity !== "" && cost !== "" && !invalid ? Number(quantity) * Number(cost) : null;
      const saved = (location.stockTemplate?.items || []).some((row) => row.catalogProductId === id) || (location.countedItems || []).some((row) => row.catalogProductId === id);
      return <article key={id} aria-label={productName(item)} className={`space-y-3 rounded-xl border bg-white p-3 sm:p-4 ${status === "uncounted" ? "border-amber-300" : status === "invalid" ? "border-red-300" : "border-slate-200"}`}>
        <div className="flex items-start justify-between gap-3"><div><h3 className="font-semibold">{productName(item)}</h3><p className="text-xs text-slate-500">Count unit: {item.baseUnit ? productUnitLabel(item.baseUnit) : "Unknown"}</p></div><span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${status === "uncounted" ? "bg-amber-100 text-amber-900" : status === "invalid" ? "bg-red-100 text-red-800" : "bg-emerald-100 text-emerald-900"}`}>{status === "uncounted" ? "Not counted" : status === "zero" ? "Counted · zero" : status === "invalid" ? "Check quantity" : "Counted"}</span></div>
        <div className="flex flex-wrap items-end gap-2"><label className="min-w-0 flex-1 text-sm font-medium">Quantity ({item.baseUnit})<input ref={(input) => { if (input) quantityInputs.current.set(id, input); else quantityInputs.current.delete(id); }} aria-label={`Count ${productName(item)}`} type="number" inputMode="decimal" min="0" max="1000000" step="0.000001" placeholder="Not counted" value={quantity} disabled={!editable} onFocus={() => setEditingId(id)} onBlur={() => setEditingId(null)} onChange={(event) => setQuantities((current) => ({ ...current, [id]: event.target.value }))} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); nextQuantity(id); } }} className="mt-1 min-h-[52px] w-full rounded-lg border border-slate-300 px-3 py-2 text-xl" /></label>
          {canUpdate && !finished && <><button type="button" aria-label={`Count zero for ${productName(item)}`} className="ht-button-secondary min-h-[48px]" disabled={saving} onClick={() => setQuantities((current) => ({ ...current, [id]: "0" }))}>Count zero</button>{quantity !== "" && <button type="button" aria-label={`Mark ${productName(item)} uncounted`} className="ht-button-secondary min-h-[48px]" disabled={saving} onClick={() => setQuantities((current) => ({ ...current, [id]: "" }))}>Clear</button>}</>}
        </div>
        {!finished && canUpdate && saved && <StockCountPackageEntry hotelUid={hotelUid} stockCountId={stockCount.id} locationId={location.locationId} item={item} disabled={saving} onApply={(text) => setQuantities((current) => ({ ...current, [id]: text }))} />}
        {!finished && canUpdate && !saved && <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs text-slate-500">Save this new article before loading validated package choices. Direct counting is ready.</p><button type="button" className="ht-button-secondary min-h-[44px]" disabled={saving} aria-label={`Remove new article ${productName(item)}`} onClick={() => {
          setAdditional((current) => current.filter((row) => row.catalogProductId !== id));
          setQuantities((current) => { const next = { ...current }; delete next[id]; return next; });
          setManualCost(id, "");
        }}>Remove new article</button></div>}
        <details className="rounded-lg bg-slate-50 p-3"><summary className="min-h-[32px] cursor-pointer text-sm font-medium">Valuation (optional)</summary>
          <p className="my-2 text-xs text-slate-600">Net cost per count unit in {stockCount.currency || "unknown currency"}. Unknown costs stay unavailable; any applied suggestion is a reviewed estimate.</p>
          <div className="grid gap-3 sm:grid-cols-2"><label className="text-sm">Estimated net cost / {item.baseUnit}<input aria-label={`Unit cost ${productName(item)}`} type="number" inputMode="decimal" min="0" max="1000000" step="0.000001" placeholder="Unknown" value={cost} disabled={!editable} onChange={(event) => setManualCost(id, event.target.value)} className="mt-1 min-h-[44px] w-full rounded border px-3 py-2" /></label><div><p className="text-sm text-slate-500">Estimated counted value</p><p>{formatInventoryValue(value, stockCount.currency)}</p></div></div>
          {!finished && canUpdate && canReadCounts && saved && <div className="mt-3"><InventoryCostProposal request={{ hotelUid, purpose: "stockcount", stockCountId: stockCount.id, locationId: location.locationId, catalogProductId: id }} baseUnit={item.baseUnit} currency={stockCount.currency} businessDate={stockCount.businessDate} contextVersion={stockCount.revision} articleName={productName(item)} disabled={saving} onApply={(number) => { setCosts((current) => ({ ...current, [id]: String(number) })); setAppliedEstimates((current) => ({ ...current, [id]: { context: estimateContext(item), scope: procurementReadScope(hotelUid) } })); }} /></div>}
        </details>
        {appliedEstimates[id] && <div role={staleEstimate(item) ? "alert" : "status"} className="flex flex-wrap items-center gap-2 text-xs text-slate-600"><p>{staleEstimate(item) ? "This applied estimate is stale. Refresh and apply a new estimate, clear it or explicitly review a manual value before saving." : "Weighted estimate applied to this draft. Saving freezes it as an operator-reviewed estimate."}</p><button type="button" className="ht-button-secondary min-h-[44px]" disabled={saving} onClick={() => setManualCost(id, "")}>Clear applied estimate</button></div>}
      </article>;
    })}</div>
    {invalid && <p role="alert" className="text-sm text-red-700">Quantities and costs must be non-negative numbers with at most six decimal places and no greater than 1,000,000.</p>}
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    <div className="sticky bottom-0 -mx-3 border-t border-slate-200 bg-white/95 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur sm:mx-0">
      {!complete && !finished && <p className="mb-2 text-sm text-slate-600">{rows.length ? `${rows.length - counted} article${rows.length - counted === 1 ? " still needs" : "s still need"} an explicit quantity. Save to continue later.` : "Add at least one product to finish this count area."}</p>}
      <div className="flex flex-wrap justify-end gap-2"><button type="button" className="ht-button-secondary min-h-[48px]" disabled={!editable || invalid || staleApplied} onClick={() => submit(false)}>{saving ? "Saving…" : "Save Counts"}</button><button type="button" className="ht-button-primary min-h-[48px]" disabled={!editable || invalid || staleApplied || !complete} onClick={() => submit(true)}>{outletCount ? "Finish Outlet" : "Finish Location"}</button></div>
    </div>
    <details className="text-xs text-slate-500"><summary className="cursor-pointer">About this snapshot</summary><p className="mt-2">This count is a dated physical snapshot. Apply one delivery cutoff: receipts posted while counting may require a recount and are flagged in period reports. Package and loose-content totals convert to the displayed count unit; scanning never assumes a package quantity.</p></details>
  </Card>;
}
