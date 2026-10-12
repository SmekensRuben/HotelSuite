import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Download } from "lucide-react";
import HeaderBar from "../layout/HeaderBar";
import ProcurementPage from "../layout/ProcurementPage";
import { Card } from "../layout/Card";
import DataListTable from "../shared/DataListTable";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { finishStockCount, getStockCountById } from "../../services/firebaseStockCounts";
import { useScopedAsync } from "../../hooks/useScopedAsync";
import { formatInventoryValue } from "../inventory/inventoryFormatting";
import { useStaffDisplayNames } from "../../hooks/useStaffDisplayNames";
import { usePermission } from "../../hooks/usePermission";

function formatCurrency(value) {
  return `${new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value || 0))} · legacy currency unknown`;
}

function buildItemKey(item) {
  if (item?.catalogProductId) return `catalog:${item.catalogProductId}`;
  return `${String(item?.supplierProductId || "").trim()}::${String(item?.outletId || "").trim()}`;
}

function getUniqueItemCount(templateItems = [], countedItems = []) {
  return new Set(
    [...templateItems, ...countedItems]
      .map(buildItemKey)
      .filter((key) => key !== "::")
  ).size;
}

function getLocationStatus(location, countedCount) {
  if (location?.status === "Finished") return "Finished";
  if (countedCount === 0) return "Not Started";
  return location?.status && location.status !== "Not Started" ? location.status : "In Progress";
}

function sanitizeFileName(value) {
  return String(value || "stock-count")
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .toLowerCase() || "stock-count";
}

function formatExportDate(value) {
  if (!value) return "";
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toLocaleString();
  if (typeof value?.toDate === "function") return value.toDate().toLocaleString();
  return String(value);
}

export default function StockCountDetailPage() {
  const canUpdateStockCounts = usePermission("stockcounts", "update");
  const { stockCountId } = useParams();
  const navigate = useNavigate();
  const { hotelUid } = useHotelContext();
  const scopeKey = `${hotelUid}:${stockCountId}`;
  const activeScope = useRef({ key: scopeKey });
  if (activeScope.current.key !== scopeKey) activeScope.current = { key: scopeKey };
  const loadStockCount = useCallback(() => getStockCountById(hotelUid, stockCountId), [hotelUid, stockCountId]);
  const { data: stockCount, loading, error: loadError, retry, setData: setStockCount } = useScopedAsync({
    scopeKey, enabled: Boolean(hotelUid && stockCountId), load: loadStockCount,
  });
  const { createdByName, updatedByName } = useStaffDisplayNames({ hotelUid, scopeKey, record: stockCount });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

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
    await signOut(auth);
    sessionStorage.clear();
    window.location.href = "/login";
  };

  useEffect(() => {
    activeScope.current = { key: scopeKey };
    setSaving(false); setError("");
    return () => { activeScope.current = { key: null }; };
  }, [scopeKey]);

  const rows = useMemo(
    () =>
      (stockCount?.locations || []).map((location) => {
        const countedItems = Array.isArray(location.countedItems) ? location.countedItems : [];
        const countedCount = new Set(
          countedItems
            .filter((item) => item?.isCounted !== false)
            .map(buildItemKey)
            .filter((key) => key !== "::")
        ).size;
        const countedValue = stockCount.inventoryPolicyVersion === 1
          ? location.countedValue ?? null
          : countedItems.reduce((sum, item) => sum + Number(item?.totalValue || 0), 0);
        const templateItems = Array.isArray(location.stockTemplate?.items) ? location.stockTemplate.items : [];
        const totalCountableItems = getUniqueItemCount(templateItems, countedItems);

        return {
          id: location.locationId,
          locationId: location.locationId,
          locationName: location.locationName || "-",
          countedCount,
          countedCountLabel: `${countedCount} / ${totalCountableItems}`,
          countedValue,
          countedValueLabel: stockCount.inventoryPolicyVersion === 1 ? formatInventoryValue(countedValue, stockCount.currency) : formatCurrency(countedValue),
          status: getLocationStatus(location, countedCount),
        };
      }),
    [stockCount]
  );

  const countedSupplierProductRows = useMemo(
    () =>
      (stockCount?.locations || []).flatMap((location) =>
        (Array.isArray(location.countedItems) ? location.countedItems : [])
          .filter((item) => item?.isCounted !== false)
          .map((item) => ({
            Location: location.locationName || location.locationId || "-",
            "Location ID": location.locationId || "",
            "Catalog Product": item.catalogProductName || item.catalogProductId || "",
            "Catalog Product ID": item.catalogProductId || "",
            "Base Unit": item.baseUnit || "",
            Currency: item.currency || stockCount.currency || "",
            "Estimated Net Unit Cost": item.unitCost ?? "",
            Outlet: item.outletName || item.outletId || "-",
            "Supplier Product": item.supplierProductName || item.supplierProductId || "-",
            Supplier: item.supplierName || "-",
            Content: item.content || "-",
            "Supplier Product ID": item.supplierProductId || "",
            "Outlet ID": item.outletId || "",
            Quantity: item.catalogProductId ? item.quantity ?? "" : Number(item.quantity || 0),
            "Price per Purchase Unit": item.catalogProductId ? "" : Number(item.pricePerPurchaseUnit || 0),
            "Total Value": item.catalogProductId ? item.totalValue ?? "" : Number(item.totalValue || 0),
            "Counted At": formatExportDate(item.countedAt),
            "Counted By": item.countedBy || "",
            Source: item.isTemplateItem === false ? "Added" : "Template",
          }))
      ),
    [stockCount]
  );

  const handleExportCountedSupplierProducts = async () => {
    const XLSX = await import("xlsx");
    const worksheet = XLSX.utils.json_to_sheet(countedSupplierProductRows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Counted Products");
    XLSX.writeFile(workbook, `${sanitizeFileName(stockCount?.name || stockCountId)}-counted-products.xlsx`);
  };

  const totalCountedValue = stockCount?.inventoryPolicyVersion === 1 && rows.some((row) => row.countedValue == null) ? null : rows.reduce((sum, row) => sum + Number(row.countedValue || 0), 0);
  const allLocationsFinished = rows.length > 0 && rows.every((row) => row.status === "Finished");
  const isStockCountFinished = stockCount?.status === "Finished";
  const canFinishStockCount = Boolean(stockCount) && allLocationsFinished && !isStockCountFinished;

  const handleFinishStockCount = async () => {
    if (!canUpdateStockCounts) return;
    if (!hotelUid || !stockCountId || !canFinishStockCount) return;
    const requestedScope = activeScope.current;
    setSaving(true);
    setError("");

    try {
      await finishStockCount(hotelUid, stockCountId, auth.currentUser?.uid || "unknown", stockCount.revision);
      if (activeScope.current !== requestedScope) return;
      const nextStockCount = await getStockCountById(hotelUid, stockCountId);
      if (activeScope.current === requestedScope) setStockCount(nextStockCount);
    } catch (finishError) {
      if (activeScope.current === requestedScope) setError(finishError?.message || "Unable to finish stock count.");
    } finally {
      if (activeScope.current === requestedScope) setSaving(false);
    }
  };

  return (
    <div className="min-h-screen bg-canvas text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <ProcurementPage className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm text-gray-500 uppercase tracking-wide">Catalog</p>
            <h1 className="text-3xl font-semibold">Stock Count Detail</h1>
            <p className="text-gray-600 mt-1">
              {stockCount?.name || "Review the selected stock count locations."}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleExportCountedSupplierProducts}
              disabled={!countedSupplierProductRows.length}
              className="inline-flex items-center gap-2 rounded border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-60"
              title={countedSupplierProductRows.length ? "Export counted products" : "No counted products to export"}
            >
              <Download className="h-4 w-4" /> Export Excel
            </button>
            <button
              type="button"
              onClick={() => navigate("/catalog/stock-counts")}
              className="inline-flex items-center justify-center rounded border border-gray-300 p-2 text-gray-700 hover:bg-gray-100"
              title="Back"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
          </div>
        </div>

        {loadError && <div role="alert"><p>{loadError.message || "Unable to load stock count."}</p><button type="button" onClick={retry}>Retry</button></div>}
        {loading ? (
          <p className="text-gray-600">Loading stock count...</p>
        ) : !stockCount ? (
          <Card>
            <p className="text-gray-600">Stock count not found.</p>
          </Card>
        ) : (
          <>
            <Card className="grid gap-4 md:grid-cols-4">
              <div>
                <p className="text-sm text-gray-500">Type</p>
                <p className="font-semibold">{stockCount.type}</p>
              </div>
              <div>
                <p className="text-sm text-gray-500">Status</p>
                <p className="font-semibold">{stockCount.status}</p>
              </div>
              <div>
                <p className="text-sm text-gray-500">Locations</p>
                <p className="font-semibold">{stockCount.locationSummary}</p>
              </div>
              <div>
                <p className="text-sm text-gray-500">Counted Value</p>
                <p className="font-semibold">{stockCount.inventoryPolicyVersion === 1 ? formatInventoryValue(totalCountedValue, stockCount.currency) : formatCurrency(totalCountedValue)}</p>
              </div>
            </Card>

            <div className="flex flex-wrap gap-x-6 gap-y-2 text-xs text-slate-500"><p>Created by <span className="font-medium text-slate-700">{createdByName}</span></p><p>Updated by <span className="font-medium text-slate-700">{updatedByName}</span></p></div>
            <Card className="space-y-4">
              <p className="text-sm text-gray-600">{stockCount.inventoryPolicyVersion === 1 ? `Catalog quantities by physical location · ${stockCount.businessDate || "business date unavailable"}. Values are operator cost estimates; missing costs stay unavailable. This is not live stock.` : "Historical supplier-based count. Original packaging and price snapshots are retained; currency was not captured by the legacy policy."}</p>
              <DataListTable
                columns={[
                  { key: "locationName", label: "Location" },
                  { key: "countedCountLabel", label: stockCount.inventoryPolicyVersion === 1 ? "Counted Catalog Products" : "Counted Supplier Products", sortValue: (row) => row.countedCount },
                  { key: "countedValueLabel", label: "Counted Value", sortValue: (row) => row.countedValue },
                  { key: "status", label: "Status" },
                ]}
                rows={rows}
                emptyMessage="No stock count locations found."
                onRowClick={(row) => navigate(`/catalog/stock-counts/${stockCountId}/locations/${row.locationId}`)}
              />

              {error && <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}

              <div className="flex flex-col items-end gap-2">
                <button
                  type="button"
                  onClick={handleFinishStockCount}
                  disabled={!canUpdateStockCounts || saving || !canFinishStockCount}
                  className="rounded-lg bg-brand-800 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-950 disabled:cursor-not-allowed disabled:opacity-60"
                  title={
                    isStockCountFinished
                      ? "This Stock Count is already Finished"
                      : allLocationsFinished
                        ? "Finish Stock Count"
                        : "All Stock Count Locations must be Finished first"
                  }
                >
                  {saving ? "Finishing..." : "Finish Stock Count"}
                </button>
                {!allLocationsFinished && !isStockCountFinished && (
                  <p className="text-sm text-gray-500">All Stock Count Locations must be Finished before this button is clickable.</p>
                )}
              </div>
            </Card>
          </>
        )}
      </ProcurementPage>
    </div>
  );
}
