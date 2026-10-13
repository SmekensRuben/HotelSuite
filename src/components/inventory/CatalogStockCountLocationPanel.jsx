import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import StockCountPackageEntry from "./StockCountPackageEntry";
import InventoryCostProposal from "./InventoryCostProposal";
import { Card } from "../layout/Card";
import { auth } from "../../firebaseConfig";
import { usePermission } from "../../hooks/usePermission";
import { useScopedAsync } from "../../hooks/useScopedAsync";
import { getCatalogProducts } from "../../services/firebaseProducts";
import { Combobox } from "../ui/combobox";
import { productUnitLabel } from "../../utils/productUnitDisplay";
import { finishStockCountLocation, updateStockCountLocationCounts } from "../../services/firebaseStockCounts";
import { formatInventoryValue, parseInventoryDecimal } from "./inventoryFormatting";
import { procurementReadScope } from "../../services/procurementReadPool";

function catalogCursorKey(cursor) {
  if (typeof cursor === "string") return cursor;
  return cursor?.ref?.path || (Number.isSafeInteger(cursor?.offset) ? `offset:${cursor.offset}` : cursor?.id || null);
}

export default function CatalogStockCountLocationPanel({ hotelUid, stockCount, location }) {
  const navigate = useNavigate();
  const canUpdate = usePermission("stockcounts", "update");
  const canReadCounts = usePermission("stockcounts", "read");
  const canReadCatalog = usePermission("catalogproducts", "read");
  const [additional, setAdditional] = useState([]), [quantities, setQuantities] = useState({}), [costs, setCosts] = useState({});
  const [appliedEstimates, setAppliedEstimates] = useState({});
  const [saving, setSaving] = useState(false), [error, setError] = useState(""), [selectedId, setSelectedId] = useState("");
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [adding, setAdding] = useState(false), [search, setSearch] = useState(""), [searchTerm, setSearchTerm] = useState("");
  const [olderProducts, setOlderProducts] = useState([]), [cursor, setCursor] = useState(null), [hasMore, setHasMore] = useState(false);
  const [moreLoading, setMoreLoading] = useState(false), [moreError, setMoreError] = useState("");
  const productGeneration = useRef(0), seenProductCursors = useRef(new Set());
  const scopeKey = `${hotelUid}:${stockCount.id}:${location.locationId}`;
  const active = useRef({ key: scopeKey });
  if (active.current.key !== scopeKey) active.current = { key: scopeKey };
  const finished = location.status === "Finished" || stockCount.status === "Finished";
  const productKey = `${scopeKey}:${searchTerm}`;
  const loadProducts = useCallback(async () => {
    const result = await getCatalogProducts(hotelUid, { pageSize: 100, searchTerm });
    if (!Array.isArray(result?.products) || typeof result.hasMore !== "boolean" || result.hasMore && !catalogCursorKey(result.cursor)) throw new Error("Catalog choices returned incomplete pagination. Retry before adding a product.");
    return result;
  }, [hotelUid, searchTerm]);
  const products = useScopedAsync({ scopeKey: productKey, enabled: Boolean(canReadCatalog && adding && !finished), load: loadProducts });
  useEffect(() => { const timer = setTimeout(() => setSearchTerm(search), 300); return () => clearTimeout(timer); }, [search]);
  useEffect(() => { productGeneration.current++; seenProductCursors.current = new Set([catalogCursorKey(products.data?.cursor)].filter(Boolean)); setOlderProducts([]); setCursor(products.data?.cursor || null); setHasMore(Boolean(products.data?.hasMore)); setMoreLoading(false); setMoreError(""); }, [productKey, products.data]);
  useEffect(() => () => { productGeneration.current++; }, []);
  const loadMoreProducts = async () => {
    if (!hasMore || !cursor || moreLoading) return;
    const generation = ++productGeneration.current;
    setMoreLoading(true); setMoreError("");
    try {
      const next = await getCatalogProducts(hotelUid, { pageSize: 100, searchTerm, cursor });
      if (generation !== productGeneration.current) return;
      const nextKey = catalogCursorKey(next?.cursor);
      if (!Array.isArray(next?.products) || typeof next.hasMore !== "boolean" || next.hasMore && (!nextKey || seenProductCursors.current.has(nextKey))) throw new Error("Catalog choices did not advance. Retry the search before continuing.");
      if (nextKey) seenProductCursors.current.add(nextKey);
      setOlderProducts((current) => [...current, ...(next.products || [])]); setCursor(next.cursor || null); setHasMore(Boolean(next.hasMore));
    } catch (failure) { if (generation === productGeneration.current) setMoreError(failure.message || "Could not load more catalog choices."); }
    finally { if (generation === productGeneration.current) setMoreLoading(false); }
  };
  // Hydrate the saved draft before interaction can overwrite or be overwritten by it.
  useLayoutEffect(() => {
    active.current = { key: scopeKey, actor: auth.currentUser };
    const saved = location.countedItems || [];
    const included = new Set((location.stockTemplate?.items || []).map((item) => item.catalogProductId));
    setAdditional(saved.filter((item) => !included.has(item.catalogProductId)));
    setQuantities(Object.fromEntries(saved.map((item) => [item.catalogProductId, item.isCounted === false ? "" : String(item.quantity ?? "")])));
    setCosts(Object.fromEntries(saved.map((item) => [item.catalogProductId, item.unitCost == null ? "" : String(item.unitCost)])));
    setAppliedEstimates({});
    setSaving(false); setError(""); setSelectedId(""); setSelectedProduct(null); setAdding(false); setSearch(""); setSearchTerm("");
    return () => { active.current = { key: null }; };
  }, [scopeKey, location]);
  const rows = useMemo(() => {
    const byId = new Map();
    [...(location.stockTemplate?.items || []), ...additional].forEach((item) => byId.set(item.catalogProductId, item));
    return [...byId.values()];
  }, [location.stockTemplate, additional]);
  const eligible = [...new Map([...(products.data?.products || []), ...olderProducts].map((product) => [product.id, product])).values()].filter((product) => product.inventoryTracked === true && product.active !== false && product.archived !== true && !product.archivedAt && !rows.some((item) => item.catalogProductId === product.id));
  const counted = rows.filter((item) => (quantities[item.catalogProductId] ?? "") !== "").length;
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
  const commands = () => rows.map((item) => ({
    catalogProductId: item.catalogProductId, quantity: (quantities[item.catalogProductId] ?? "") === "" ? 0 : parseInventoryDecimal(quantities[item.catalogProductId]),
    unitCost: parseInventoryDecimal(costs[item.catalogProductId] ?? "", { optional: true }), isCounted: (quantities[item.catalogProductId] ?? "") !== "",
  }));
  const submit = async (finish) => {
    if (!canUpdate || finished || saving || invalid || (finish && !complete)) return;
    if (active.current.actor !== auth.currentUser) { setError("The signed-in user changed. Reload this count before saving."); return; }
    if (rows.some(staleEstimate)) { setError("An applied cost estimate no longer matches the draft or recorded evidence. Refresh it, clear it or explicitly enter a reviewed manual estimate before saving."); return; }
    const scope = active.current;
    setSaving(true); setError("");
    try {
      const values = commands();
      if (finish) await finishStockCountLocation(hotelUid, stockCount.id, location.locationId, values, [], auth.currentUser?.uid, stockCount.revision);
      else await updateStockCountLocationCounts(hotelUid, stockCount.id, location.locationId, values, auth.currentUser?.uid, stockCount.revision);
      if (active.current === scope) navigate(`/catalog/stock-counts/${stockCount.id}`);
    } catch (failure) { if (active.current === scope) setError(failure.message || "Unable to save catalog count."); }
    finally { if (active.current === scope) setSaving(false); }
  };
  return <Card className="space-y-5">
    <div><h2 className="text-xl font-semibold">Catalog count · {location.locationName}</h2>
      <p className="mt-1 text-sm text-gray-600">Count directly in the catalog unit or use validated packages and loose contents. Supplier package units are converted on receiving; for a catalog product measured in litres, count 2 litres rather than 2,000 millilitres. Blank means uncounted; enter 0 when none is present.</p>
      <p className="text-sm text-gray-600">Optional net unit cost ({stockCount.currency || "currency unknown"}) is an operator estimate per base unit. Request a weighted stock-cost suggestion for an article, review its dated recorded evidence and explicitly apply it, or enter a manual estimate. Unknown cost stays unavailable. This count is a dated snapshot, not live stock. Apply one physical delivery cutoff: receipts posted while counting may require a recount and will be flagged in period reports.</p>
      <p className="font-medium">{counted} / {rows.length} counted · {stockCount.businessDate || "Business date unavailable"}</p></div>
    {rows.length === 0 && <p role="alert">No valid catalog count items are available. Review the location template.</p>}
    <div className="space-y-3">{rows.map((item) => {
      const id = item.catalogProductId, quantity = quantities[id] ?? "", cost = costs[id] ?? "";
      const value = quantity !== "" && cost !== "" && !invalid ? Number(quantity) * Number(cost) : null;
      return <article key={id} className="grid items-center gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:grid-cols-2 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <div><h3 className="font-semibold">{item.catalogProductName || item.name || "Unnamed catalog product"}</h3><p className="text-sm text-gray-500">Count unit: {item.baseUnit ? productUnitLabel(item.baseUnit) : "Unknown"}</p></div>
        <label className="text-sm">Count ({item.baseUnit})<input aria-label={`Count ${item.catalogProductName || item.name || id}`} type="number" inputMode="decimal" min="0" max="1000000" step="0.000001" value={quantity} disabled={!canUpdate || finished || saving} onChange={(event) => setQuantities((current) => ({ ...current, [id]: event.target.value }))} className="mt-1 min-h-[44px] w-full rounded border px-3 py-2" /></label>
        <label className="text-sm">Estimated net cost / {item.baseUnit}<input aria-label={`Unit cost ${item.catalogProductName || item.name || id}`} type="number" inputMode="decimal" min="0" max="1000000" step="0.000001" placeholder="Unknown" value={cost} disabled={!canUpdate || finished || saving} onChange={(event) => setManualCost(id, event.target.value)} className="mt-1 min-h-[44px] w-full rounded border px-3 py-2" /></label>
        <div><p className="text-sm text-gray-500">Estimated counted value</p><p>{formatInventoryValue(value, stockCount.currency)}</p></div>
        {!finished && canUpdate && canReadCounts && ((location.stockTemplate?.items || []).some((row) => row.catalogProductId === id) || (location.countedItems || []).some((row) => row.catalogProductId === id)) && <div className="min-w-0 sm:col-span-2 lg:col-span-4">
          <InventoryCostProposal request={{ hotelUid, purpose: "stockcount", stockCountId: stockCount.id, locationId: location.locationId, catalogProductId: id }} baseUnit={item.baseUnit} currency={stockCount.currency} businessDate={stockCount.businessDate} contextVersion={stockCount.revision} articleName={item.catalogProductName || item.name || "catalog article"} disabled={saving}
            onApply={(number) => { setCosts((current) => ({ ...current, [id]: String(number) })); setAppliedEstimates((current) => ({ ...current, [id]: { context: estimateContext(item), scope: procurementReadScope(hotelUid) } })); }} />
          {appliedEstimates[id] && <div role={staleEstimate(item) ? "alert" : "status"} className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-600"><p>{staleEstimate(item) ? "This applied estimate is stale. Refresh and apply a new estimate, clear it or explicitly review a manual value before saving." : "Weighted estimate applied to this draft. Saving freezes it as an operator-reviewed estimate."}</p><button type="button" className="ht-button-secondary" disabled={saving} onClick={() => setManualCost(id, "")}>Clear applied estimate</button></div>}
        </div>}
        {!finished && canUpdate && ((location.stockTemplate?.items || []).some((row) => row.catalogProductId === id) || (location.countedItems || []).some((row) => row.catalogProductId === id)) && <StockCountPackageEntry hotelUid={hotelUid} stockCountId={stockCount.id} locationId={location.locationId} item={item} disabled={saving} onApply={(text) => setQuantities((current) => ({ ...current, [id]: text }))} />}
        {!finished && canUpdate && !(location.stockTemplate?.items || []).some((row) => row.catalogProductId === id) && !(location.countedItems || []).some((row) => row.catalogProductId === id) && <p className="text-sm text-slate-500 sm:col-span-2 lg:col-span-4">Save this additional article before loading its validated package choices. Direct catalog-unit counting is available now.</p>}
      </article>;
    })}</div>
    {canReadCatalog && !finished && <div className="rounded-xl border border-dashed border-slate-300 p-4">
      <button type="button" className="ht-button-secondary" disabled={saving || !canUpdate} onClick={() => { setAdding((current) => !current); setSelectedId(""); setSelectedProduct(null); }}> {adding ? "Hide additional products" : "Add a product outside the template"}</button>
      {adding && <div className="mt-4 space-y-3">
        <p className="text-sm text-slate-600">Choose an inventory-tracked catalog product found physically at this location. It is added to this count only; the location template stays unchanged.</p>
        {products.error && <div role="alert"><p>{products.error.message}</p><p>Counting the frozen template remains available.</p><button type="button" className="ht-button-secondary mt-2" onClick={products.retry}>Retry catalog choices</button></div>}
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
          <label className="text-sm font-medium">Additional catalog product
            <Combobox aria-label="Additional catalog product" options={eligible} value={selectedProduct} onChange={(product) => { setSelectedId(product?.id || ""); setSelectedProduct(product || null); }} displayValue={(product) => `${product.catalogProductName || product.name || "Unnamed catalog product"} (${product.baseUnit || "unknown unit"})`} getOptionValue={(product) => product.id} onQueryChange={setSearch} loading={products.loading} disabled={Boolean(products.error) || saving} placeholder="Search tracked catalog products" emptyMessage={hasMore ? "No matching tracked products on this page. Load more choices or refine your search." : "No tracked products match your search."} className="ht-field mt-1" />
          </label>
          <button type="button" className="ht-button-secondary" disabled={!canUpdate || !selectedId || saving || rows.length >= 250 || products.loading} onClick={() => { const product = selectedProduct; if (product) setAdditional((current) => [...current, { catalogProductId: product.id, catalogProductName: product.catalogProductName || product.name, baseUnit: product.baseUnit }]); setSelectedId(""); setSelectedProduct(null); }}>Add catalog product</button>
        </div>
        {hasMore && <button type="button" className="ht-button-secondary" disabled={products.loading || moreLoading || saving} onClick={loadMoreProducts}>{moreLoading ? "Loading more products..." : "Load more catalog choices"}</button>}
        {moreError && <p role="alert" className="text-sm text-red-700">{moreError}</p>}
      </div>}
    </div>}
    {invalid && <p role="alert">Quantities and costs must be non-negative numbers with at most six decimal places and no greater than 1,000,000.</p>}
    {error && <p role="alert" className="text-red-700">{error}</p>}
    <div className="flex flex-wrap justify-end gap-3"><button className="rounded border px-4 py-2" disabled={!canUpdate || finished || saving || invalid || staleApplied} onClick={() => submit(false)}>Save Counts</button><button className="rounded bg-brand-800 px-4 py-2 text-white disabled:opacity-50" disabled={!canUpdate || finished || saving || invalid || staleApplied || !complete} onClick={() => submit(true)}>Finish Location</button></div>
    {!complete && !finished && <p className="text-sm text-gray-500">Every included product needs an explicit quantity before this location can be finished.</p>}
  </Card>;
}
