import React, { useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Plus } from "lucide-react";
import HeaderBar from "../layout/HeaderBar";
import ProcurementPage from "../layout/ProcurementPage";
import DataListTable from "../shared/DataListTable";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { usePermission } from "../../hooks/usePermission";
import { useScopedAsync } from "../../hooks/useScopedAsync";
import { formatInventoryValue } from "../inventory/inventoryFormatting";
import { getStockCounts } from "../../services/firebaseStockCounts";

function formatCurrency(value) {
  return `${new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value || 0))} · legacy currency unknown`;
}

export default function StockCountsPage() {
  const navigate = useNavigate();
  const { hotelUid } = useHotelContext();
  const canCreateStockCounts = usePermission("stockcounts", "create");
  const loadCounts = useCallback(() => getStockCounts(hotelUid), [hotelUid]);
  const { data, loading, error, retry } = useScopedAsync({ scopeKey: hotelUid, enabled: Boolean(hotelUid), load: loadCounts });
  const stockCounts = data || [];

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

  const rows = useMemo(
    () =>
      stockCounts.map((stockCount) => ({
        ...stockCount,
        countedValueLabel: stockCount.inventoryPolicyVersion === 1 ? formatInventoryValue(stockCount.countedValue, stockCount.currency) : formatCurrency(stockCount.countedValue),
      })),
    [stockCounts]
  );

  const columns = [
    { key: "name", label: "Name" },
    { key: "type", label: "Type" },
    { key: "status", label: "Status" },
    { key: "locationSummary", label: "Locations", sortValue: (row) => row.locationCount },
    { key: "countedValueLabel", label: "Counted Value", sortValue: (row) => row.countedValue },
    { key: "createdAtLabel", label: "Created", sortValue: (row) => row.createdAt?.getTime?.() || 0 },
  ];

  return (
    <div className="min-h-screen bg-canvas text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <ProcurementPage className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-sm text-gray-500 uppercase tracking-wide">Purchasing & inventory</p>
            <h1 className="text-3xl font-semibold">Stock Counts</h1>
            <p className="max-w-2xl text-sm text-gray-600 mt-1">Count catalog quantities per physical location. Historical supplier-based counts remain available.</p>
          </div>
          <button
            onClick={() => navigate("/catalog/stock-counts/new")}
            disabled={!canCreateStockCounts}
            className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold shadow ${
              canCreateStockCounts
                ? "bg-brand-800 text-white hover:bg-brand-950"
                : "bg-gray-300 text-gray-500 cursor-not-allowed"
            }`}
            title="Add stock count"
          >
            <Plus className="h-4 w-4" /> New stock count
          </button>
        </div>

        {error && <div role="alert"><p>{error.message || "Unable to load stock counts."}</p><button onClick={retry}>Retry</button></div>}
        {loading ? (
          <p className="text-gray-600">Loading stock counts...</p>
        ) : (
          <DataListTable
            columns={columns}
            rows={rows}
            emptyMessage="No stock counts found."
            onRowClick={(row) => navigate(`/catalog/stock-counts/${row.id}`)}
          />
        )}
      </ProcurementPage>
    </div>
  );
}
