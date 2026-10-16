import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Plus } from "lucide-react";
import HeaderBar from "../layout/HeaderBar";
import ProcurementPage from "../layout/ProcurementPage";
import { Combobox } from "../ui/combobox";
import { Card } from "../layout/Card";
import Modal from "../shared/Modal";
import DataListTable from "../shared/DataListTable";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import {
  finishStockCountLocation,
  getStockCountById,
  updateStockCountLocationCounts,
} from "../../services/firebaseStockCounts";
import { getSupplierProducts } from "../../services/firebaseProducts";
import { getOutlets } from "../../services/firebaseSettings";
import { matchesSearchTokensAcross } from "../../utils/search";
import { usePermission } from "../../hooks/usePermission";
import { useScopedAsync } from "../../hooks/useScopedAsync";
import { confirmStockCountNavigation, useStockCountDraft } from "../../hooks/useStockCountDraft";
import CatalogStockCountLocationPanel from "../inventory/CatalogStockCountLocationPanel";
import PendingStockCountMutation from "../inventory/PendingStockCountMutation";
import { collectPaginatedProducts } from "../../services/paginatedExport";

function buildItemKey(item) {
  return `${String(item?.supplierProductId || "").trim()}::${String(item?.outletId || "").trim()}`;
}

function formatCurrency(value) {
  return `${new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value || 0))} · legacy currency unknown`;
}

function buildContent(item) {
  return item.content || `${item.baseUnitsPerPurchaseUnit || "-"} ${item.baseUnit || "-"} / ${item.purchaseUnit || "-"}`;
}

function buildSupplierProductSnapshot(product = {}, outlet = {}) {
  const baseUnitsPerPurchaseUnit = product.baseUnitsPerPurchaseUnit ?? "";
  const baseUnit = product.baseUnit || "";
  const purchaseUnit = product.purchaseUnit || "";

  return {
    supplierProductId: String(product.id || product.supplierProductId || "").trim(),
    outletId: String(outlet.id || "").trim(),
    supplierProductName: product.supplierProductName || product.name || "",
    supplierName: product.supplierName || "",
    baseUnitsPerPurchaseUnit,
    baseUnit,
    purchaseUnit,
    content: `${baseUnitsPerPurchaseUnit || "-"} ${baseUnit || "-"} / ${purchaseUnit || "-"}`,
    pricePerPurchaseUnit: Number(product.pricePerPurchaseUnit || 0),
    outletName: outlet.name || outlet.id || "",
  };
}

export default function StockCountLocationPage() {
  const canUpdateStockCounts = usePermission("stockcounts", "update");
  const canUpdateTemplates = usePermission("locations", "update");
  const canReadProducts = usePermission("supplierproducts", "read");
  const canReadOutlets = usePermission("outlets", "read");
  const canReadOrders = usePermission("orders", "read");
  const canAddProducts = canUpdateStockCounts && canReadProducts && (canReadOutlets || canReadOrders);
  const { stockCountId, locationId } = useParams();
  const navigate = useNavigate();
  const { hotelUid } = useHotelContext();
  const actorUid = auth.currentUser?.uid;
  const scopeKey = `${actorUid}:${hotelUid}:${stockCountId}:${locationId}`;
  const activeScope = useRef({ key: scopeKey, actor: auth.currentUser });
  if (activeScope.current.key !== scopeKey) activeScope.current = { key: scopeKey, actor: auth.currentUser };
  const [stockCount, setStockCount] = useState(null);
  const [stockCountLocation, setStockCountLocation] = useState(null);
  const [template, setTemplate] = useState(null);
  const [additionalItems, setAdditionalItems] = useState([]);
  const [quantitiesByKey, setQuantitiesByKey] = useState({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [showAddModal, setShowAddModal] = useState(false);
  const [addSearch, setAddSearch] = useState("");
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [selectedOutletId, setSelectedOutletId] = useState("");
  const [showFinishModal, setShowFinishModal] = useState(false);
  const [selectedTemplateAdditions, setSelectedTemplateAdditions] = useState({});
  const [baseRevision, setBaseRevision] = useState(0);
  const [conflict, setConflict] = useState(null);
  const [conflictChoices, setConflictChoices] = useState({});
  const [pending, setPending] = useState(null);
  const draft = useStockCountDraft({ hotelUid, stockCountId, locationId, actorUid,
    enabled: Boolean(stockCount && stockCount.inventoryPolicyVersion !== 1) });

  const today = useMemo(
    () =>
      new Date().toLocaleDateString(undefined, {
        weekday: "long",
        month: "long",
        day: "numeric",
      }),
    []
  );

  const handleLogout = async () => {
    if (!confirmStockCountNavigation()) return;
    await signOut(auth);
    sessionStorage.clear();
    window.location.href = "/login";
  };

  const loadLocation = useCallback(async () => ({ nextStockCount: await getStockCountById(hotelUid, stockCountId) }),
    [hotelUid, stockCountId]);
  const { data: loaded, loading, error: loadError, retry } = useScopedAsync({
    scopeKey, enabled: Boolean(hotelUid && stockCountId && locationId), load: loadLocation,
  });
  const loadProductSources = useCallback(async () => {
    const [products, outlets] = await Promise.all([
      collectPaginatedProducts((options) => getSupplierProducts(hotelUid, options)), getOutlets(hotelUid),
    ]);
    return { products, outlets };
  }, [hotelUid]);
  const productSources = useScopedAsync({
    scopeKey: `${scopeKey}:add-products`, enabled: Boolean(hotelUid && stockCountId && locationId && canAddProducts && loaded?.nextStockCount && loaded.nextStockCount.inventoryPolicyVersion !== 1),
    load: loadProductSources,
  });
  const supplierProducts = productSources.data?.products || [];
  const outlets = productSources.data?.outlets || [];
  const additionsAvailable = canAddProducts && Boolean(productSources.data) && !productSources.loading && !productSources.error;
  useEffect(() => {
    if (!additionsAvailable) {
      setShowAddModal(false); setSelectedProduct(null); setSelectedOutletId("");
    }
  }, [additionsAvailable]);
  useEffect(() => {
    const nextStockCount = loaded?.nextStockCount || null;
    const nextLocation = (nextStockCount?.locations || []).find((location) => location.locationId === locationId);
    const nextTemplate = nextLocation?.stockTemplate?.id ? nextLocation.stockTemplate : null;
    const templateKeys = new Set((nextTemplate?.items || []).map(buildItemKey));
    const nextQuantities = {}, nextAdditionalItems = [];
    (nextLocation?.countedItems || []).forEach((item) => {
      const key = buildItemKey(item);
      nextQuantities[key] = item.isCounted === false ? "" : String(item.quantity ?? "");
      if (item.isTemplateItem === false || !templateKeys.has(key)) nextAdditionalItems.push({ ...item, key, isTemplateItem: false });
    });
    setStockCount(nextStockCount); setStockCountLocation(nextLocation || null); setTemplate(nextTemplate);
    setAdditionalItems(nextAdditionalItems); setQuantitiesByKey(nextQuantities); setError("");
    setBaseRevision(nextLocation?.revision ?? 0); setConflict(null); setConflictChoices({});
    if (!loaded) {
      setShowAddModal(false); setShowFinishModal(false); setSelectedProduct(null); setSelectedOutletId("");
      setSelectedTemplateAdditions({});
    }
  }, [loaded, locationId]);

  useEffect(() => {
    activeScope.current = { key: scopeKey, actor: auth.currentUser };
    setSaving(false); setError("");
    return () => { activeScope.current = { key: null, actor: null }; };
  }, [scopeKey]);


  const outletsById = useMemo(
    () => Object.fromEntries(outlets.map((outlet) => [String(outlet.id || "").trim(), outlet])),
    [outlets]
  );

  const templateKeys = useMemo(
    () => new Set((template?.items || []).map(buildItemKey)),
    [template]
  );

  const rows = useMemo(() => {
    const additionalItemKeys = new Set(additionalItems.map(buildItemKey));
    const templateRows = (template?.items || [])
      .filter((item) => !additionalItemKeys.has(buildItemKey(item)))
      .map((item) => ({ ...item, isTemplateItem: true }));
    return [...templateRows, ...additionalItems].map((item) => {
      const key = buildItemKey(item);
      const pricePerPurchaseUnit = Number(item.pricePerPurchaseUnit || 0);
      const quantityValue = quantitiesByKey[key] ?? "";
      const numericQuantity = quantityValue === "" ? 0 : Number(quantityValue);
      const totalValue = Number.isFinite(numericQuantity) ? numericQuantity * pricePerPurchaseUnit : 0;
      const content = buildContent(item);

      return {
        id: key,
        ...item,
        key,
        isTemplateItem: item.isTemplateItem !== false,
        supplierProductName: item.supplierProductName || item.name || "-",
        supplierName: item.supplierName || "-",
        content,
        outletName: item.outletName || outletsById[item.outletId]?.name || item.outletId || "-",
        pricePerPurchaseUnit,
        pricePerPurchaseUnitLabel: formatCurrency(pricePerPurchaseUnit),
        quantity: quantityValue,
        totalValue,
        totalValueLabel: formatCurrency(totalValue),
        sourceLabel: item.isTemplateItem === false ? "Added" : "Template",
      };
    });
  }, [additionalItems, outletsById, quantitiesByKey, template]);

  const filteredRows = useMemo(
    () =>
      rows.filter((row) =>
        matchesSearchTokensAcross(
          [
            row.supplierProductName,
            row.supplierName,
            row.content,
            row.outletName,
            row.supplierProductId,
            row.sourceLabel,
          ],
          searchQuery
        )
      ),
    [rows, searchQuery]
  );

  const addedRows = useMemo(
    () => rows.filter((row) => row.isTemplateItem === false),
    [rows]
  );

  const countedCount = rows.filter((row) => row.quantity !== "").length;
  const countedValue = rows.reduce((sum, row) => (row.quantity === "" ? sum : sum + row.totalValue), 0);
  const filteredProducts = supplierProducts.filter((product) =>
    matchesSearchTokensAcross(
      [product.supplierProductName, product.name, product.supplierName, product.supplierSku, product.id],
      addSearch
    )
  );

  const buildCountedItems = () =>
    rows
      .filter((row) => row.quantity !== "" || row.isTemplateItem === false)
      .map((row) => ({
        supplierProductId: row.supplierProductId,
        outletId: row.outletId,
        quantity: Number(row.quantity || 0),
        pricePerPurchaseUnit: row.pricePerPurchaseUnit,
        totalValue: row.totalValue,
        countedAt: new Date(),
        countedBy: auth.currentUser?.uid || "unknown",
        isCounted: row.quantity !== "",
        isTemplateItem: row.isTemplateItem !== false && templateKeys.has(buildItemKey(row)),
        supplierProductName: row.supplierProductName,
        supplierName: row.supplierName,
        baseUnitsPerPurchaseUnit: row.baseUnitsPerPurchaseUnit ?? "",
        baseUnit: row.baseUnit || "",
        purchaseUnit: row.purchaseUnit || "",
        content: row.content,
        outletName: row.outletName,
      }));

  const isFinished = stockCount?.status === "Finished" || stockCountLocation?.status === "Finished";
  const editBlocked = isFinished || saving || Boolean(pending || conflict) || !canUpdateStockCounts;
  const leaveLocation = () => { if (confirmStockCountNavigation()) navigate(`/catalog/stock-counts/${stockCountId}`); };

  const keepDraft = (nextQuantities = quantitiesByKey, nextItems = additionalItems, revision = baseRevision) => {
    if (activeScope.current.actor !== auth.currentUser) return;
    draft.update({ quantitiesByKey: nextQuantities, additionalItems: nextItems }, revision);
  };

  const reviewLatest = async () => {
    if (activeScope.current.actor !== auth.currentUser) return;
    const requestedScope = activeScope.current;
    setSaving(true);
    try {
      const latest = await getStockCountById(hotelUid, stockCountId);
      const latestLocation = latest?.locations?.find((entry) => entry.locationId === locationId);
      if (activeScope.current !== requestedScope || requestedScope.actor !== auth.currentUser) return;
      if (!latestLocation) throw new Error("This stock count location is no longer available. Your local draft has been kept.");
      const saved = new Map((latestLocation.stockTemplate?.items || []).map((item) => [buildItemKey(item), { ...item, quantity: "" }]));
      for (const item of latestLocation.countedItems || []) saved.set(buildItemKey(item), { ...item, quantity: item.isCounted === false ? "" : String(item.quantity ?? "") });
      const mine = new Map(rows.map((row) => [row.key, row]));
      const reviewedRows = [...new Set([...saved.keys(), ...mine.keys()])].map((key) => {
        const savedValue = saved.get(key)?.quantity ?? "";
        const myValue = mine.has(key) ? mine.get(key).quantity : savedValue;
        return { ...(saved.get(key) || mine.get(key)), key, savedValue, myValue,
          differs: savedValue === "" || myValue === "" ? savedValue !== myValue : Number(savedValue) !== Number(myValue) };
      });
      setConflict({ stockCount: latest, location: latestLocation, rows: reviewedRows }); setConflictChoices({});
      setError("");
    } catch (reviewError) {
      if (activeScope.current === requestedScope) setError(reviewError.message || "Unable to load the latest saved counts. Your draft has been kept.");
    } finally { if (activeScope.current === requestedScope) setSaving(false); }
  };

  const applyReview = () => {
    if (activeScope.current.actor !== auth.currentUser) return;
    if (!conflict || conflict.rows.some((row) => row.differs && !conflictChoices[row.key])) return;
    if (conflict.stockCount.status === "Finished" || conflict.location.status === "Finished") return;
    const nextTemplate = conflict.location.stockTemplate;
    const nextTemplateKeys = new Set((nextTemplate?.items || []).map(buildItemKey));
    const nextQuantities = Object.fromEntries(conflict.rows.map((row) => [row.key,
      row.differs && conflictChoices[row.key] === "saved" ? row.savedValue : row.myValue]));
    const nextItems = conflict.rows.filter((row) => !nextTemplateKeys.has(row.key)).map(({ savedValue: _saved, myValue: _mine, differs: _differs, ...row }) => ({ ...row, isTemplateItem: false }));
    const nextRevision = conflict.location.revision ?? 0;
    setStockCount(conflict.stockCount); setStockCountLocation(conflict.location); setTemplate(nextTemplate);
    setAdditionalItems(nextItems); setQuantitiesByKey(nextQuantities); setBaseRevision(nextRevision);
    keepDraft(nextQuantities, nextItems, nextRevision); setConflict(null); setError("");
  };

  const recoverDraft = (recovery) => {
    if (saving || pending || conflict || draft.dirty || activeScope.current.actor !== auth.currentUser) return;
    if (!recovery.value || !Array.isArray(recovery.value.additionalItems) || typeof recovery.value.quantitiesByKey !== "object") {
      setError("This draft uses an unsupported format. Keep it for review and continue with the saved counts."); return;
    }
    const restored = draft.recover(recovery);
    if (!restored) return;
    setQuantitiesByKey(restored.value.quantitiesByKey); setAdditionalItems(restored.value.additionalItems); setBaseRevision(restored.baseRevision);
    setError("");
  };

  const handleQuantityChange = (key) => (event) => {
    if (editBlocked || activeScope.current.actor !== auth.currentUser) return;
    const next = { ...quantitiesByKey, [key]: event.target.value };
    setQuantitiesByKey(next); keepDraft(next);
  };

  const handleAddSupplierProduct = () => {
    if (editBlocked || !additionsAvailable || activeScope.current.actor !== auth.currentUser) return;
    if (!selectedProduct || !selectedOutletId) return;
    const outlet = outletsById[selectedOutletId] || { id: selectedOutletId };
    const nextItem = { ...buildSupplierProductSnapshot(selectedProduct, outlet), isTemplateItem: false };
    const key = buildItemKey(nextItem);

    if (rows.some((row) => row.key === key)) {
      setError("This supplier product and outlet is already on this stock count location.");
      return;
    }

    const nextItems = [...additionalItems, { ...nextItem, key }];
    const nextQuantities = { ...quantitiesByKey, [key]: quantitiesByKey[key] ?? "" };
    setAdditionalItems(nextItems); setQuantitiesByKey(nextQuantities); keepDraft(nextQuantities, nextItems);
    setSelectedProduct(null);
    setSelectedOutletId("");
    setAddSearch("");
    setShowAddModal(false);
    setError("");
  };

  const handleSave = async () => {
    if (editBlocked || activeScope.current.actor !== auth.currentUser) return;
    if (!hotelUid || !stockCountId || !locationId || !stockCount || !stockCountLocation || isFinished) return;
    const requestedScope = activeScope.current;
    setSaving(true);
    setError("");
    keepDraft();

    try {
      await updateStockCountLocationCounts(
        hotelUid,
        stockCountId,
        locationId,
        buildCountedItems(),
        auth.currentUser?.uid || "unknown",
        baseRevision
      );
      if (activeScope.current === requestedScope && requestedScope.actor === auth.currentUser) { draft.clear(); navigate(`/catalog/stock-counts/${stockCountId}`); }
    } catch (saveError) {
      if (activeScope.current === requestedScope && requestedScope.actor === auth.currentUser) {
        setError(saveError?.message || "Unable to save stock count location. Your draft has been kept.");
        if (saveError?.code === "functions/aborted" || saveError?.code === "aborted") await reviewLatest();
      }
    } finally {
      if (activeScope.current === requestedScope) setSaving(false);
    }
  };

  const handleFinishClick = () => {
    if (editBlocked || activeScope.current.actor !== auth.currentUser) return;
    if (isFinished) return;
    setSelectedTemplateAdditions(Object.fromEntries(addedRows.map((row) => [row.key, canUpdateTemplates])));
    setShowFinishModal(true);
  };

  const handleFinish = async (templateRowsToAdd = []) => {
    if (editBlocked || activeScope.current.actor !== auth.currentUser) return;
    if (!hotelUid || !stockCountId || !locationId || !stockCount || !stockCountLocation || isFinished) return;
    const requestedScope = activeScope.current;
    setSaving(true);
    setError("");
    keepDraft();

    try {
      await finishStockCountLocation(
        hotelUid,
        stockCountId,
        locationId,
        buildCountedItems(),
        templateRowsToAdd.map((row) => ({ supplierProductId: row.supplierProductId, outletId: row.outletId })),
        auth.currentUser?.uid || "unknown",
        baseRevision
      );
      if (activeScope.current === requestedScope && requestedScope.actor === auth.currentUser) { draft.clear(); navigate(`/catalog/stock-counts/${stockCountId}`); }
    } catch (finishError) {
      if (activeScope.current === requestedScope && requestedScope.actor === auth.currentUser) {
        setError(finishError?.message || "Unable to finish stock count location. Your draft has been kept.");
        if (finishError?.code === "functions/aborted" || finishError?.code === "aborted") await reviewLatest();
      }
    } finally {
      if (activeScope.current === requestedScope) { setSaving(false); setShowFinishModal(false); }
    }
  };

  const selectedRowsToAddToTemplate = canUpdateTemplates
    ? addedRows.filter((row) => selectedTemplateAdditions[row.key] !== false) : [];

  return (
    <div className="min-h-screen bg-canvas text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <ProcurementPage className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm text-gray-500 uppercase tracking-wide">Stock Count</p>
            <h1 className="text-3xl font-semibold">Stock Count Location</h1>
            <p className="text-gray-600 mt-1">
              {stockCountLocation?.locationName || "Count supplier products for this location."}
            </p>
          </div>
          <button
            type="button"
            onClick={leaveLocation}
            className="inline-flex items-center justify-center rounded border border-gray-300 p-2 text-gray-700 hover:bg-gray-100"
            title="Back"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
        </div>

        {loadError && <div role="alert"><p>{loadError.message || "Unable to load stock count location."}</p><button type="button" onClick={retry}>Retry</button></div>}
        {productSources.error && <div role="alert"><p>{productSources.error.message || "Unable to load add-product sources."}</p><p>Counting existing snapshot items remains available.</p><button type="button" onClick={productSources.retry}>Retry add-product sources</button></div>}
        {loading ? (
          <p className="text-gray-600">Loading stock count location...</p>
        ) : !stockCount || !stockCountLocation ? (
          <Card>
            <p className="text-gray-600">Stock count location not found.</p>
          </Card>
        ) : stockCount.inventoryPolicyVersion === 1 ? (
          <CatalogStockCountLocationPanel key={scopeKey} hotelUid={hotelUid} stockCount={stockCount} location={stockCountLocation} />
        ) : !template ? (
          <Card>
            <p className="text-gray-600">Stock count template not found.</p>
          </Card>
        ) : (
          <>
            <PendingStockCountMutation hotelUid={hotelUid} stockCountId={stockCountId} locationId={locationId}
              disabled={saving || !canUpdateStockCounts} onPendingChange={setPending}
              onComplete={async () => { if (draft.dirty) await reviewLatest(); else retry(); }} />
            <div className="space-y-2 rounded-lg border border-gray-200 bg-white p-4 text-sm">
              <p role="status">{draft.dirty ? (draft.savedLocally
                ? "Draft saved on this device. Save Counts to share it with your colleagues."
                : "Changes are not saved. Keep this page open.") : "Showing saved counts."}</p>
              {draft.storageError && <div role="alert"><p>{draft.storageError}</p><button type="button" onClick={draft.retryStorage}>Retry local storage</button></div>}
              {draft.recoveries.map((recovery) => <div key={recovery.key} className="flex flex-wrap items-center gap-2">
                <p>A draft from {new Date(recovery.updatedAt).toLocaleString()} is available on this device.</p>
                {recovery.memoryOnly && <p className="text-amber-800">This draft is only in memory. Restore it and save before reloading or closing this tab.</p>}
                <button type="button" className="rounded border px-3 py-1" disabled={saving || pending || conflict || draft.dirty} onClick={() => recoverDraft(recovery)}>{isFinished ? "Review draft" : "Restore draft"}</button>
                <button type="button" className="rounded border px-3 py-1" onClick={() => draft.discard(recovery)}>Discard draft</button>
              </div>)}
              {isFinished && draft.recoveries.length > 0 && <p>This location is finished. Its saved counts cannot be changed.</p>}
            </div>
            {conflict && <section aria-label="Review count changes" className="space-y-3 rounded-lg border border-amber-300 bg-amber-50 p-4">
              <h2 className="font-semibold">Review changes to this location</h2>
              <p>Your draft has been kept. Compare it with the latest saved counts and choose each differing value.</p>
              {conflict.rows.filter((row) => row.differs).map((row) => <div key={row.key} className="rounded border border-amber-200 p-3">
                <p className="font-medium">{row.supplierProductName || row.name || row.supplierProductId} · {row.outletName || row.outletId}</p>
                <label className="mr-4"><input type="radio" name={`conflict-${row.key}`} checked={conflictChoices[row.key] === "mine"}
                  onChange={() => setConflictChoices((previous) => ({ ...previous, [row.key]: "mine" }))} /> My draft: {row.myValue === "" ? "Not counted" : row.myValue}</label>
                <label><input type="radio" name={`conflict-${row.key}`} checked={conflictChoices[row.key] === "saved"}
                  onChange={() => setConflictChoices((previous) => ({ ...previous, [row.key]: "saved" }))} /> Saved: {row.savedValue === "" ? "Not counted" : row.savedValue}</label>
              </div>)}
              {conflict.stockCount.status === "Finished" || conflict.location.status === "Finished"
                ? <p>This location or count is already finished. Your draft remains on this device for review; saved counts cannot be changed.</p>
                : <button type="button" onClick={applyReview} disabled={saving || conflict.rows.some((row) => row.differs && !conflictChoices[row.key])}
                  className="rounded border border-amber-500 bg-white px-3 py-2 disabled:opacity-50">Apply reviewed choices</button>}
            </section>}
            <Card className="grid gap-4 md:grid-cols-4">
              <div>
                <p className="text-sm text-gray-500">Stock Count</p>
                <p className="font-semibold">{stockCount.name}</p>
              </div>
              <div>
                <p className="text-sm text-gray-500">Template</p>
                <p className="font-semibold">{template.name}</p>
              </div>
              <div>
                <p className="text-sm text-gray-500">Status</p>
                <p className="font-semibold">{stockCountLocation.status || "Not Started"}</p>
              </div>
              <div>
                <p className="text-sm text-gray-500">Progress</p>
                <p className="font-semibold">{countedCount} / {rows.length} · {formatCurrency(countedValue)}</p>
              </div>
            </Card>

            <Card className="space-y-4">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
                <div>
                  <label htmlFor="stock-count-product-search" className="block text-sm font-medium text-gray-700 mb-1">
                    Search supplier product
                  </label>
                  <input
                    id="stock-count-product-search"
                    type="search"
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    placeholder="Search by supplier product, supplier, outlet or ID"
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm sm:w-96"
                  />
                </div>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <p className="text-sm text-gray-500">
                    Showing {filteredRows.length} of {rows.length} supplier products
                  </p>
                  <button
                    type="button"
                    onClick={() => setShowAddModal(true)}
                    disabled={editBlocked || !additionsAvailable}
                    className="inline-flex items-center justify-center gap-2 rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <Plus className="h-4 w-4" /> Add Supplier Product
                  </button>
                </div>
              </div>

              <div className="md:hidden">
                {filteredRows.length === 0 ? (
                  <div className="rounded-xl border border-gray-200 bg-white px-4 py-6 text-sm text-gray-500 shadow-sm">
                    {searchQuery ? "No supplier products match your search." : "No stock template items yet."}
                  </div>
                ) : (
                  <div className="space-y-3">
                    {filteredRows.map((row) => (
                      <article key={row.id} className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
                        <div className="space-y-3">
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div className="min-w-0">
                              <h3 className="break-words text-base font-semibold text-gray-900">
                                {row.supplierProductName}
                              </h3>
                              <p className="mt-1 text-sm text-gray-500">{row.supplierName}</p>
                            </div>
                            <span className="shrink-0 rounded-full bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-700">
                              {row.sourceLabel}
                            </span>
                          </div>

                          <dl className="grid grid-cols-2 gap-3 text-sm">
                            <div>
                              <dt className="text-xs font-medium uppercase tracking-wide text-gray-500">Content</dt>
                              <dd className="mt-0.5 break-words text-gray-900">{row.content}</dd>
                            </div>
                            <div>
                              <dt className="text-xs font-medium uppercase tracking-wide text-gray-500">Outlet</dt>
                              <dd className="mt-0.5 break-words text-gray-900">{row.outletName}</dd>
                            </div>
                            <div>
                              <dt className="text-xs font-medium uppercase tracking-wide text-gray-500">Price</dt>
                              <dd className="mt-0.5 text-gray-900">{row.pricePerPurchaseUnitLabel}</dd>
                            </div>
                            <div>
                              <dt className="text-xs font-medium uppercase tracking-wide text-gray-500">Value</dt>
                              <dd className="mt-0.5 font-semibold text-gray-900">{row.totalValueLabel}</dd>
                            </div>
                          </dl>

                          <label className="block text-sm font-medium text-gray-700">
                            Count
                            <input
                              type="number"
                              min="0"
                              step="any"
                              inputMode="decimal"
                              value={row.quantity}
                              onChange={handleQuantityChange(row.key)}
                              disabled={editBlocked}
                              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-3 text-base disabled:bg-gray-100 disabled:text-gray-600"
                            />
                          </label>
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </div>

              <div className="hidden md:block">
                <DataListTable
                  columns={[
                    { key: "supplierProductName", label: "Supplier Product", sortable: false },
                    { key: "supplierName", label: "Supplier", sortable: false },
                    { key: "content", label: "Content", sortable: false },
                    { key: "outletName", label: "Outlet", sortable: false },
                    { key: "sourceLabel", label: "Source", sortable: false },
                    { key: "pricePerPurchaseUnitLabel", label: "Price", sortable: false },
                    {
                      key: "quantity",
                      label: "Count",
                      sortable: false,
                      render: (row) => (
                        <input
                          type="number"
                          min="0"
                          step="any"
                          value={row.quantity}
                          onClick={(event) => event.stopPropagation()}
                          onChange={handleQuantityChange(row.key)}
                          disabled={editBlocked}
                          className="w-28 rounded border border-gray-300 px-2 py-1 text-sm disabled:bg-gray-100 disabled:text-gray-600"
                        />
                      ),
                    },
                    { key: "totalValueLabel", label: "Value", sortable: false },
                  ]}
                  rows={filteredRows}
                  emptyMessage={searchQuery ? "No supplier products match your search." : "No stock template items yet."}
                />
              </div>

              {error && <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}
              {error && !pending && !saving && draft.dirty && <button type="button" className="rounded border px-3 py-2" onClick={reviewLatest}>Review latest saved counts</button>}

              <div className="flex flex-wrap justify-end gap-2">
                <button
                  type="button"
                  onClick={leaveLocation}
                  className="px-4 py-2 rounded-lg border border-gray-300 text-sm font-medium hover:bg-gray-100"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={editBlocked}
                  className="px-4 py-2 rounded-lg border border-brand-800 text-brand-800 text-sm font-semibold hover:bg-brand-50 disabled:opacity-60"
                >
                  {saving ? "Saving..." : "Save Counts"}
                </button>
                <button
                  type="button"
                  onClick={handleFinishClick}
                  disabled={editBlocked || rows.length === 0 || countedCount !== rows.length}
                  className="px-4 py-2 rounded-lg bg-brand-800 text-white text-sm font-semibold hover:bg-brand-950 disabled:opacity-60"
                >
                  {saving ? "Finishing..." : "Set Finished"}
                </button>
                {countedCount !== rows.length && <p className="text-sm text-gray-500">Enter a quantity for every included item, including explicit zero, before finishing.</p>}
              </div>
            </Card>
          </>
        )}
      </ProcurementPage>

      <Modal open={showAddModal && !isFinished && additionsAvailable} onClose={() => setShowAddModal(false)} title="Add Supplier Product">
        <div className="space-y-3">
          <input
            type="search"
            value={addSearch}
            onChange={(event) => setAddSearch(event.target.value)}
            placeholder="Search supplier product"
            className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
          />
          <div className="max-h-56 overflow-y-auto rounded border border-gray-200">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 text-left">
                  <th className="px-2 py-2">Supplier Product</th>
                  <th className="px-2 py-2">Supplier</th>
                  <th className="px-2 py-2">Content</th>
                </tr>
              </thead>
              <tbody>
                {filteredProducts.slice(0, 25).map((product) => {
                  const content = buildContent(product);
                  const isSelected = selectedProduct?.id === product.id;
                  return (
                    <tr
                      key={product.id}
                      className={`cursor-pointer ${isSelected ? "bg-blue-50" : "hover:bg-gray-50"}`}
                      onClick={() => setSelectedProduct(product)}
                    >
                      <td className="px-2 py-2">{product.supplierProductName || product.name || "-"}</td>
                      <td className="px-2 py-2">{product.supplierName || "-"}</td>
                      <td className="px-2 py-2">{content}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <label className="block text-sm font-medium">Outlet
            <Combobox aria-label="Additional product outlet" options={outlets} value={outlets.find((outlet) => outlet.id === selectedOutletId) || null} onChange={(outlet) => setSelectedOutletId(outlet?.id || "")} displayValue={(outlet) => outlet.name || "Unnamed outlet"} getOptionValue={(outlet) => outlet.id} placeholder="Search outlets" className="ht-field mt-1" />
          </label>
          <div className="flex justify-end gap-2">
            <button type="button" className="rounded border border-gray-300 px-3 py-2 text-sm" onClick={() => setShowAddModal(false)}>Cancel</button>
            <button
              type="button"
              className="rounded bg-brand-800 px-3 py-2 text-sm text-white disabled:opacity-60"
              disabled={!selectedProduct || !selectedOutletId}
              onClick={handleAddSupplierProduct}
            >
              Add
            </button>
          </div>
        </div>
      </Modal>

      <Modal open={showFinishModal} onClose={() => setShowFinishModal(false)} title="Confirm finished location">
        <div className="space-y-4">
          <p className="text-sm text-gray-700">
            Are you sure everything that had to be counted within this location has been counted?
          </p>
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
            Once this Stock Count Location is marked as Finished, counts can no longer be changed and supplier products can no longer be added from this page.
          </p>
          {canUpdateTemplates && addedRows.length > 0 && (
            <div className="space-y-2">
              <p className="text-sm text-gray-700">
                {addedRows.length} supplier product{addedRows.length === 1 ? " was" : "s were"} added to this Stock Count Location that {addedRows.length === 1 ? "is" : "are"} not in the original template.
                Select which supplier products should also be added to the template for future counts.
              </p>
              <div className="max-h-64 space-y-2 overflow-y-auto rounded border border-gray-200 p-2">
                {addedRows.map((row) => (
                  <label key={row.key} className="flex items-start gap-2 rounded px-2 py-1 text-sm hover:bg-gray-50">
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={selectedTemplateAdditions[row.key] !== false}
                      onChange={(event) =>
                        setSelectedTemplateAdditions((prev) => ({ ...prev, [row.key]: event.target.checked }))
                      }
                      disabled={saving}
                    />
                    <span>
                      <span className="font-medium">{row.supplierProductName}</span>
                      <span className="text-gray-500"> · {row.supplierName} · {row.outletName}</span>
                    </span>
                  </label>
                ))}
              </div>
            </div>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              className="rounded border border-gray-300 px-3 py-2 text-sm"
              onClick={() => setShowFinishModal(false)}
              disabled={saving}
            >
              Cancel
            </button>
            {canUpdateTemplates && addedRows.length > 0 && (
              <button
                type="button"
                className="rounded border border-gray-300 px-3 py-2 text-sm disabled:opacity-60"
                onClick={() => handleFinish([])}
                disabled={saving}
              >
                {saving ? "Finishing..." : "Finish without adding"}
              </button>
            )}
            <button
              type="button"
              className="rounded bg-brand-800 px-3 py-2 text-sm font-semibold text-white disabled:opacity-60"
              onClick={() => handleFinish(selectedRowsToAddToTemplate)}
              disabled={saving}
            >
              {saving ? "Finishing..." : addedRows.length > 0 ? "Finish and add selected" : "Yes, set finished"}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
