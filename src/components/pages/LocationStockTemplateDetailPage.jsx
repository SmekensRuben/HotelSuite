import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import PendingStockCommand from "../inventory/PendingStockCommand";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { usePermission } from "../../hooks/usePermission";
import { useScopedAsync } from "../../hooks/useScopedAsync";
import { getCatalogProducts, getSupplierProducts } from "../../services/firebaseProducts";
import { collectPaginatedProducts } from "../../services/paginatedExport";
import { addLocationStockTemplateItem, getLocationById, getLocationStockTemplateById, removeLocationStockTemplateItem, updateLocationStockTemplateItems } from "../../services/firebaseSettings";

export default function LocationStockTemplateDetailPage() {
  const { locationId, templateId } = useParams();
  const { hotelUid } = useHotelContext();
  const navigate = useNavigate();
  const canUpdate = usePermission("locations", "update"), canReadCatalog = usePermission("catalogproducts", "read"), canReadSupplier = usePermission("supplierproducts", "read");
  const scopeKey = `${hotelUid}:${locationId}:${templateId}`;
  const active = useRef({ key: scopeKey }); if (active.current.key !== scopeKey) active.current = { key: scopeKey };
  const [selectedId, setSelectedId] = useState(""), [search, setSearch] = useState(""), [saving, setSaving] = useState(false), [error, setError] = useState("");
  const load = useCallback(async () => {
    const [template, location] = await Promise.all([getLocationStockTemplateById(hotelUid, locationId, templateId), getLocationById(hotelUid, locationId)]);
    return { template, location };
  }, [hotelUid, locationId, templateId]);
  const query = useScopedAsync({ scopeKey, enabled: Boolean(hotelUid && locationId && templateId), load });
  const loadProducts = useCallback(async () => {
    const [catalog, supplier] = await Promise.all([
      canReadCatalog ? collectPaginatedProducts((options) => getCatalogProducts(hotelUid, options)) : [],
      canReadSupplier ? collectPaginatedProducts((options) => getSupplierProducts(hotelUid, options)) : [],
    ]); return { catalog, supplier };
  }, [hotelUid, canReadCatalog, canReadSupplier]);
  const products = useScopedAsync({ scopeKey, enabled: Boolean(hotelUid && (canReadCatalog || canReadSupplier)), load: loadProducts });
  useEffect(() => { active.current = { key: scopeKey }; setSelectedId(""); setSearch(""); setSaving(false); setError(""); return () => { active.current = { key: null }; }; }, [scopeKey]);
  const template = query.data?.template, items = template?.items || [];
  const catalog = products.data?.catalog || [], suppliers = products.data?.supplier || [];
  const catalogById = useMemo(() => Object.fromEntries(catalog.map((item) => [item.id, item])), [catalog]);
  const supplierById = useMemo(() => Object.fromEntries(suppliers.map((item) => [item.id, item])), [suppliers]);
  const eligible = catalog.filter((product) => product.inventoryTracked === true && product.active !== false && product.archived !== true && !product.archivedAt && !items.some((item) => item.catalogProductId === product.id) && `${product.catalogProductName || product.name || ""} ${product.id}`.toLowerCase().includes(search.toLowerCase()));
  const mutate = async (operation) => {
    if (!canUpdate || saving || template?.archived === true) return;
    const requested = active.current; setSaving(true); setError("");
    try { await operation(); if (active.current === requested) { setSelectedId(""); await query.retry(); } }
    catch (failure) { if (active.current === requested) setError(failure.message || "Unable to update template."); }
    finally { if (active.current === requested) setSaving(false); }
  };
  const move = (index, direction) => { const next = [...items], target = index + direction; if (target < 0 || target >= next.length) return; [next[index], next[target]] = [next[target], next[index]]; return mutate(() => updateLocationStockTemplateItems(hotelUid, locationId, templateId, next, template.revision ?? 0)); };
  return <div className="min-h-screen bg-canvas text-gray-900"><HeaderBar today={new Date().toLocaleDateString()} onLogout={async () => { await signOut(auth); sessionStorage.clear(); window.location.href = "/login"; }} /><PageContainer className="space-y-6">
    <div className="flex justify-between"><h1 className="text-3xl font-semibold">Stock Template Detail</h1><button onClick={() => navigate(`/settings/locations/${locationId}`)}>Back to location</button></div>
    <PendingStockCommand kind="template" hotelUid={hotelUid} locationId={locationId} templateId={templateId} disabled={!canUpdate || saving} onComplete={query.retry} />
    {query.loading && <p>Loading stock template...</p>}{query.error && <div role="alert"><p>{query.error.message}</p><button onClick={query.retry}>Retry template</button></div>}
    {!query.loading && !query.error && !template && <Card>Stock template not found.</Card>}
    {template && <><Card><h2 className="text-xl font-semibold">{query.data.location?.name || locationId} · {template.name}</h2><p className="mt-2 text-sm text-gray-600">Catalog products are counted once per physical location, irrespective of supplier or outlet. Legacy supplier entries remain visible and must have valid catalog links before a new count can start. Creating a count validates all sources and deduplicates linked catalog products.</p></Card>
    <Card className="space-y-3">{items.length === 0 && <p>No stock template items yet.</p>}{items.map((item, index) => {
      const supplier = supplierById[item.supplierProductId], product = catalogById[item.catalogProductId || supplier?.catalogProductId];
      const label = product?.catalogProductName || product?.name || item.catalogProductId || supplier?.supplierProductName || item.supplierProductId || "Invalid item";
      const unresolved = (!item.catalogProductId && !item.supplierProductId) || (!item.catalogProductId && products.data && (!supplier?.catalogProductId || !product));
      return <div key={`${item.catalogProductId || item.supplierProductId}:${item.outletId || ""}:${index}`} className="flex flex-wrap items-center justify-between gap-3 rounded border p-3"><div><p className="font-semibold">{label}</p><p className="text-sm text-gray-500">{item.catalogProductId ? `Catalog · ${product?.baseUnit || "unit validated on count creation"}` : `Legacy supplier item · ${item.supplierProductId} · outlet ${item.outletId || "missing"}`}</p>{unresolved && <p role="alert" className="text-sm text-amber-700">Unresolved source. Repair the supplier catalog link or replace this item; it will not be silently omitted.</p>}</div><div className="flex gap-2"><button aria-label={`Move ${label} up`} disabled={!canUpdate || template.archived === true || saving || index === 0} onClick={() => move(index, -1)}>↑</button><button aria-label={`Move ${label} down`} disabled={!canUpdate || template.archived === true || saving || index === items.length - 1} onClick={() => move(index, 1)}>↓</button><button className="text-red-700" disabled={!canUpdate || template.archived === true || saving} onClick={() => mutate(() => removeLocationStockTemplateItem(hotelUid, locationId, templateId, item, undefined, template.revision ?? 0))}>Remove</button></div></div>;
    })}</Card>
    <Card className="space-y-3"><h3 className="font-semibold">Add catalog product</h3>{!canReadCatalog && <p>Catalog read permission is required to choose additional products.</p>}{products.error && <div role="alert"><p>{products.error.message}</p><button onClick={products.retry}>Retry product sources</button></div>}<label className="block text-sm">Search catalog<input aria-label="Search catalog" value={search} onChange={(event) => setSearch(event.target.value)} className="ml-2 rounded border px-3 py-2" /></label><select aria-label="Catalog product" value={selectedId} disabled={!canReadCatalog || products.loading || Boolean(products.error)} onChange={(event) => setSelectedId(event.target.value)} className="rounded border px-3 py-2"><option value="">Select tracked catalog product</option>{eligible.map((product) => <option key={product.id} value={product.id}>{product.catalogProductName || product.name || product.id} ({product.baseUnit})</option>)}</select><button className="ml-2 rounded bg-brand-800 px-4 py-2 text-white disabled:opacity-50" disabled={!canUpdate || template.archived === true || !selectedId || saving || items.length >= 250} onClick={() => mutate(() => addLocationStockTemplateItem(hotelUid, locationId, templateId, { catalogProductId: selectedId }, template.revision ?? 0))}>Add product</button></Card></>}
    {error && <p role="alert" className="text-red-700">{error}</p>}
  </PageContainer></div>;
}
