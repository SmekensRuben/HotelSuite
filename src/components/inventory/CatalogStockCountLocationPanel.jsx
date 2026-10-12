import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Card } from "../layout/Card";
import { auth } from "../../firebaseConfig";
import { usePermission } from "../../hooks/usePermission";
import { useScopedAsync } from "../../hooks/useScopedAsync";
import { getCatalogProducts } from "../../services/firebaseProducts";
import { collectPaginatedProducts } from "../../services/paginatedExport";
import { finishStockCountLocation, updateStockCountLocationCounts } from "../../services/firebaseStockCounts";
import { formatInventoryValue, parseInventoryDecimal } from "./inventoryFormatting";

export default function CatalogStockCountLocationPanel({ hotelUid, stockCount, location }) {
  const navigate = useNavigate();
  const canUpdate = usePermission("stockcounts", "update");
  const canReadCatalog = usePermission("catalogproducts", "read");
  const [additional, setAdditional] = useState([]), [quantities, setQuantities] = useState({}), [costs, setCosts] = useState({});
  const [saving, setSaving] = useState(false), [error, setError] = useState(""), [selectedId, setSelectedId] = useState("");
  const scopeKey = `${hotelUid}:${stockCount.id}:${location.locationId}`;
  const active = useRef({ key: scopeKey });
  if (active.current.key !== scopeKey) active.current = { key: scopeKey };
  const finished = location.status === "Finished" || stockCount.status === "Finished";
  const loadProducts = useCallback(() => collectPaginatedProducts((options) => getCatalogProducts(hotelUid, options)), [hotelUid]);
  const products = useScopedAsync({ scopeKey, enabled: Boolean(canReadCatalog && !finished), load: loadProducts });
  useEffect(() => {
    active.current = { key: scopeKey };
    const saved = location.countedItems || [];
    const included = new Set((location.stockTemplate?.items || []).map((item) => item.catalogProductId));
    setAdditional(saved.filter((item) => !included.has(item.catalogProductId)));
    setQuantities(Object.fromEntries(saved.map((item) => [item.catalogProductId, item.isCounted === false ? "" : String(item.quantity ?? "")])));
    setCosts(Object.fromEntries(saved.map((item) => [item.catalogProductId, item.unitCost == null ? "" : String(item.unitCost)])));
    setSaving(false); setError(""); setSelectedId("");
    return () => { active.current = { key: null }; };
  }, [scopeKey, location]);
  const rows = useMemo(() => {
    const byId = new Map();
    [...(location.stockTemplate?.items || []), ...additional].forEach((item) => byId.set(item.catalogProductId, item));
    return [...byId.values()];
  }, [location.stockTemplate, additional]);
  const eligible = (products.data || []).filter((product) => product.inventoryTracked === true && product.active !== false && product.archived !== true && !product.archivedAt && !rows.some((item) => item.catalogProductId === product.id));
  const counted = rows.filter((item) => (quantities[item.catalogProductId] ?? "") !== "").length;
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
      <p className="text-sm text-gray-600">Count the physical quantity in each catalog base unit. Blank means uncounted; enter 0 when none is present.</p>
      <p className="text-sm text-gray-600">Optional net unit cost ({stockCount.currency || "currency unknown"}) is an operator estimate per base unit. Unknown cost stays unavailable. This count is a dated snapshot, not live stock. Apply one physical delivery cutoff: receipts posted while counting may require a recount and will be flagged in period reports.</p>
      <p className="font-medium">{counted} / {rows.length} counted · {stockCount.businessDate || "Business date unavailable"}</p></div>
    {rows.length === 0 && <p role="alert">No valid catalog count items are available. Review the location template.</p>}
    <div className="space-y-3">{rows.map((item) => {
      const id = item.catalogProductId, quantity = quantities[id] ?? "", cost = costs[id] ?? "";
      const value = quantity !== "" && cost !== "" && !invalid ? Number(quantity) * Number(cost) : null;
      return <article key={id} className="grid gap-3 rounded-xl border border-gray-200 p-4 md:grid-cols-4">
        <div><h3 className="font-semibold">{item.catalogProductName || item.name || id}</h3><p className="text-sm text-gray-500">Base unit: {item.baseUnit || "Unknown"}</p></div>
        <label className="text-sm">Count ({item.baseUnit})<input aria-label={`Count ${item.catalogProductName || item.name || id}`} type="number" min="0" max="1000000" step="0.000001" value={quantity} disabled={!canUpdate || finished || saving} onChange={(event) => setQuantities((current) => ({ ...current, [id]: event.target.value }))} className="mt-1 w-full rounded border px-3 py-2" /></label>
        <label className="text-sm">Estimated net cost / {item.baseUnit}<input aria-label={`Unit cost ${item.catalogProductName || item.name || id}`} type="number" min="0" max="1000000" step="0.000001" placeholder="Unknown" value={cost} disabled={!canUpdate || finished || saving} onChange={(event) => setCosts((current) => ({ ...current, [id]: event.target.value }))} className="mt-1 w-full rounded border px-3 py-2" /></label>
        <div><p className="text-sm text-gray-500">Estimated counted value</p><p>{formatInventoryValue(value, stockCount.currency)}</p></div>
      </article>;
    })}</div>
    {products.error && <div role="alert"><p>{products.error.message}</p><p>Counting the frozen template remains available.</p><button onClick={products.retry}>Retry catalog choices</button></div>}
    {canReadCatalog && !finished && <div className="flex flex-wrap gap-2"><label className="text-sm">Additional catalog product<select aria-label="Additional catalog product" value={selectedId} onChange={(event) => setSelectedId(event.target.value)} disabled={products.loading || Boolean(products.error) || saving} className="ml-2 rounded border px-3 py-2"><option value="">Select tracked product</option>{eligible.map((product) => <option key={product.id} value={product.id}>{product.catalogProductName || product.name || product.id} ({product.baseUnit})</option>)}</select></label><button disabled={!canUpdate || !selectedId || saving || rows.length >= 250} onClick={() => { const product = eligible.find((entry) => entry.id === selectedId); if (product) setAdditional((current) => [...current, { catalogProductId: product.id, catalogProductName: product.catalogProductName || product.name, baseUnit: product.baseUnit }]); setSelectedId(""); }}>Add catalog product</button></div>}
    {invalid && <p role="alert">Quantities and costs must be non-negative numbers with at most six decimal places and no greater than 1,000,000.</p>}
    {error && <p role="alert" className="text-red-700">{error}</p>}
    <div className="flex justify-end gap-3"><button className="rounded border px-4 py-2" disabled={!canUpdate || finished || saving || invalid} onClick={() => submit(false)}>Save Counts</button><button className="rounded bg-brand-800 px-4 py-2 text-white disabled:opacity-50" disabled={!canUpdate || finished || saving || invalid || !complete} onClick={() => submit(true)}>Finish Location</button></div>
    {!complete && !finished && <p className="text-sm text-gray-500">Every included product needs an explicit quantity before this location can be finished.</p>}
  </Card>;
}
